// server/banhistory.js
// Permanent log of IP ban and unban events: who acted, on whom (name + IP),
// when, and why. Two jobs:
//   1. A "ban history" feed for the dashboard so staff can see who unbanned
//      whom (and who banned whom), even after the active block is gone.
//   2. A per-IP ban count, so a repeat offender shows "banned N times".
//
// The IP is stored for the count and is sent only to developers; full mods see
// names and counts but never the raw address, matching the rest of the board.
//
// Persisted to ban-history.json the same way as the other JSON stores
// (atomic tmp + rename, debounced), capped, and never committed.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "ban-history.json");
const MAX = 5000;

// oldest first: { id, ip, name, action: "ban"|"unban", by, at, reason, duration }
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

// Synchronous write for a clean shutdown (survives the debounce window).
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

// Append one event. `action` is "ban" or "unban"; everything else is metadata.
function record({ ip, name, action, by, byRole, at, reason, duration }) {
  events.push({
    id: ++seq,
    ip: ip || null,
    name: name || null,
    action: action === "unban" ? "unban" : "ban",
    by: by || null,
    // Which half of the team acted, so the board can name a moderator and not
    // a developer without having to guess from the roster of the day.
    byRole: byRole || null,
    at: at || Date.now(),
    reason: reason || null,
    duration: duration || null,
  });
  if (events.length > MAX) events = events.slice(-MAX);
  saveSoon();
}

// How many times this IP has ever been banned (the repeat-offender count).
function countBans(ip) {
  if (!ip) return 0;
  let n = 0;
  for (const e of events) if (e.ip === ip && e.action === "ban") n++;
  return n;
}

// Newest first, capped, for the dashboard history feed.
function recent(limit) {
  const n = Math.min(Math.max(1, limit || 100), MAX);
  return events.slice(-n).reverse();
}

load();

module.exports = { record, countBans, recent, flushSync };
