// server/banhistory.js
// Permanent log of IP ban and unban events: who acted, on whom (name + IP),
// when, and why.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "ban-history.json");
const MAX = 5000;

let events = [];
let seq = 0;
let saveTimer = null;

// Bans per address, so the block list does not walk the log once per row.
let banCounts = null;

function trim() {
  if (events.length <= MAX) return;
  events = events.slice(-MAX);
  banCounts = null;
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    events = Array.isArray(arr) ? arr : [];
    seq = events.reduce((m, e) => Math.max(m, e.id || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading ban-history.json:", err);
    events = [];
  }
  banCounts = null;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      trim();
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(events), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("ban-history save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    trim();
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(events), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("ban-history flush failed:", e);
  }
}

function record({ ip, name, action, by, byRole, at, reason, duration }) {
  const e = {
    id: ++seq,
    ip: ip || null,
    name: name || null,
    action: action === "unban" ? "unban" : "ban",
    by: by || null,
    byRole: byRole || null,
    at: at || Date.now(),
    reason: reason || null,
    duration: duration || null,
  };
  events.push(e);
  if (banCounts && e.action === "ban" && e.ip)
    banCounts.set(e.ip, (banCounts.get(e.ip) || 0) + 1);
  trim();
  saveSoon();
}

function countBans(ip) {
  if (!ip) return 0;
  if (!banCounts) {
    banCounts = new Map();
    for (const e of events)
      if (e.action === "ban" && e.ip)
        banCounts.set(e.ip, (banCounts.get(e.ip) || 0) + 1);
  }
  return banCounts.get(ip) || 0;
}

function recent(limit) {
  const n = Math.min(Math.max(1, limit || 100), MAX);
  return events.slice(-n).reverse();
}

load();

module.exports = { record, countBans, recent, flushSync };
