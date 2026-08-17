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
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (events.length > MAX) events = events.slice(-MAX);
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
    if (events.length > MAX) events = events.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(events), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("ban-history flush failed:", e);
  }
}

function record({ ip, name, action, by, byRole, at, reason, duration }) {
  events.push({
    id: ++seq,
    ip: ip || null,
    name: name || null,
    action: action === "unban" ? "unban" : "ban",
    by: by || null,
    byRole: byRole || null,
    at: at || Date.now(),
    reason: reason || null,
    duration: duration || null,
  });
  if (events.length > MAX) events = events.slice(-MAX);
  saveSoon();
}

function countBans(ip) {
  if (!ip) return 0;
  let n = 0;
  for (const e of events) if (e.ip === ip && e.action === "ban") n++;
  return n;
}

function recent(limit) {
  const n = Math.min(Math.max(1, limit || 100), MAX);
  return events.slice(-n).reverse();
}

load();

module.exports = { record, countBans, recent, flushSync };
