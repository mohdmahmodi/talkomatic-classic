// server/lastseen.js
// Last known identity per user id, written on every connection. This is what
// lets staff act on somebody who has gone offline WITHOUT them having been
// reported first - reports only carry a snapshot for people someone flagged.
// Raw addresses live here the same way they do in reports.json and
// identity.json: used server-side to place blocks, masked at read time.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "last-seen.json");

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_USERS = 20000;

let byUser = {};
let saveTimer = null;

function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (obj && typeof obj === "object") byUser = obj;
    prune();
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading last-seen.json:", err);
    byUser = {};
  }
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const k of Object.keys(byUser))
    if (!byUser[k] || byUser[k].at < cutoff) delete byUser[k];
  const keys = Object.keys(byUser);
  if (keys.length > MAX_USERS) {
    keys.sort((a, b) => byUser[a].at - byUser[b].at);
    for (let i = 0; i < keys.length - MAX_USERS; i++) delete byUser[keys[i]];
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      prune();
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(byUser), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("last-seen save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    prune();
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(byUser), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("last-seen flush failed:", e);
  }
}

// Fields already on record survive a sighting that lacks them (a socket seen
// before sign-in has no username yet). Role is the exception: every sighting
// knows it affirmatively, null meaning "not staff", so it always overwrites.
function record({ userId, deviceId, ip, name, role }) {
  if (!userId || typeof userId !== "string") return;
  if (!deviceId && !ip) return;
  const prev = byUser[userId] || {};
  byUser[userId] = {
    deviceId: deviceId || prev.deviceId || null,
    ip: ip || prev.ip || null,
    name: name || prev.name || null,
    role: role || null,
    at: Date.now(),
  };
  saveSoon();
}

function get(userId) {
  const r = byUser[userId];
  if (!r || Date.now() - r.at > KEEP_MS) return null;
  return { ...r };
}

load();

module.exports = { record, get, flushSync };
