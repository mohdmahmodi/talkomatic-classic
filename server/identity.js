// server/identity.js
// Durable per-browser identity + lightweight activity tracking.
//
// The client keeps a random device id (localStorage + cookie + IndexedDB) and
// sends it on connect. This is NOT a secret and never gates a privileged
// action - it only powers "active vs new" checks, where the
// real defense is that faking an *active* identity takes real elapsed calendar
// time and sustained presence, not just minting a new id. Stored compactly,
// pruned, and capped so it never clutters the server.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "identity.json");

// "Active" thresholds - tunable. A device is active once it has been seen on
// at least 2 distinct days, accumulated >= 15 minutes of presence, and shown
// >= 10 activity ticks (typed / participated). Cheap for a real returning user
// to meet; expensive to fake at scale because it needs real calendar time.
const ACTIVE_DAYS = 2;
const ACTIVE_SEC = 15 * 60;
const ACTIVE_ACTS = 10;

const MAX_DEVICES = 50000; // hard cap on stored devices
const MAX_IPS = 8; // ips kept per device
const MAX_DAYS = 90; // distinct-day entries kept per device
const SESSION_CAP_SEC = 2 * 60 * 60; // count at most 2h from one session
const TOTAL_SEC_CAP = 100 * 24 * 60 * 60; // never store more than ~100 days
const PRUNE_AFTER_MS = 45 * 24 * 60 * 60 * 1000; // drop devices unseen 45d

// deviceId -> { first, last, days:[YYYY-MM-DD], sec, acts, ips:{ip:count}, name }
let store = {};
let saveTimer = null;
let dirty = false;

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const obj = JSON.parse(raw);
    store = obj && typeof obj === "object" ? obj : {};
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading identity.json:", err);
    store = {};
  }
}

// Atomic write (tmp + rename), debounced, mirrors the other JSON stores.
function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      prune();
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("identity save failed:", e);
    }
  }, 5000);
}

function validId(id) {
  return typeof id === "string" && /^[a-f0-9-]{8,64}$/i.test(id);
}

function today() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function rec(id) {
  let r = store[id];
  if (!r) {
    const now = Date.now();
    r = store[id] = {
      first: now,
      last: now,
      days: [],
      sec: 0,
      acts: 0,
      ips: {},
      name: null,
      loc: null,
      note: null,
    };
  }
  return r;
}

function addDay(r) {
  const d = today();
  if (!r.days.includes(d)) {
    r.days.push(d);
    if (r.days.length > MAX_DAYS) r.days = r.days.slice(-MAX_DAYS);
  }
}

function addIp(r, ip) {
  if (!ip) return;
  r.ips[ip] = (r.ips[ip] || 0) + 1;
  const keys = Object.keys(r.ips);
  if (keys.length > MAX_IPS) {
    let min = keys[0];
    for (const k of keys) if (r.ips[k] < r.ips[min]) min = k;
    delete r.ips[min];
  }
}

// Record a connection: presence for today + the connecting ip.
function touch(id, ip, name, loc) {
  if (!validId(id)) return;
  const r = rec(id);
  r.last = Date.now();
  addDay(r);
  addIp(r, ip);
  if (name) r.name = String(name).slice(0, 30);
  if (loc) r.loc = String(loc).slice(0, 30);
  saveSoon();
}

// Accumulate engaged time from one session (capped per session and overall).
function addTime(id, ms) {
  if (!validId(id) || !(ms > 0)) return;
  const r = store[id];
  if (!r) return;
  r.sec = Math.min(TOTAL_SEC_CAP, (r.sec || 0) + Math.min(SESSION_CAP_SEC, ms / 1000));
  r.last = Date.now();
  saveSoon();
}

// A participation tick (the caller throttles this, e.g. once per 30s).
function tick(id, name, loc) {
  if (!validId(id)) return;
  const r = rec(id);
  r.last = Date.now();
  r.acts = (r.acts || 0) + 1;
  addDay(r);
  if (name) r.name = String(name).slice(0, 30);
  if (loc) r.loc = String(loc).slice(0, 30);
  saveSoon();
}

// Update just the display name + location (on sign-in or rename) so anything
// that shows this device (staff surfaces, records) stays current.
function setName(id, name, loc) {
  if (!validId(id) || !store[id]) return;
  const r = store[id];
  if (name) r.name = String(name).slice(0, 30);
  if (loc) r.loc = String(loc).slice(0, 30);
  r.last = Date.now();
  saveSoon();
}

function setNote(id, note) {
  if (!validId(id)) return false;
  const r = rec(id);
  const text = typeof note === "string" ? note.trim() : "";
  const next = text ? text.slice(0, 1000) : null;
  if (r.note === next) return false;
  r.note = next;
  r.last = Date.now();
  saveSoon();
  return true;
}

function getNote(id) {
  if (!validId(id)) return null;
  const r = store[id];
  return r && typeof r.note === "string" && r.note ? r.note : null;
}

// Staff can turn a device's profile picture off. Stored here (not on the
// session) so clearing cookies does not bring the picture back.
function setPfpBlocked(id, blocked) {
  if (!validId(id)) return false;
  const r = rec(id);
  const next = !!blocked;
  if (!!r.noPfp === next) return false;
  r.noPfp = next;
  r.last = Date.now();
  saveSoon();
  return true;
}

function isPfpBlocked(id) {
  if (!validId(id)) return false;
  const r = store[id];
  return !!(r && r.noPfp);
}

function isActive(id) {
  const r = store[id];
  if (!r) return false;
  return (
    (r.days ? r.days.length : 0) >= ACTIVE_DAYS &&
    (r.sec || 0) >= ACTIVE_SEC &&
    (r.acts || 0) >= ACTIVE_ACTS
  );
}

// Compact, non-sensitive snapshot for the client (new-vs-active display).
function summary(id) {
  const r = store[id];
  const need = {
    days: ACTIVE_DAYS,
    minutes: Math.round(ACTIVE_SEC / 60),
    acts: ACTIVE_ACTS,
  };
  if (!r)
    return {
      known: false,
      active: false,
      days: 0,
      minutes: 0,
      acts: 0,
      ageDays: 0,
      need,
    };
  return {
    known: true,
    active: isActive(id),
    days: r.days ? r.days.length : 0,
    minutes: Math.round((r.sec || 0) / 60),
    acts: r.acts || 0,
    ageDays: Math.floor((Date.now() - (r.first || Date.now())) / 86400000),
    need,
  };
}

function getRecord(id) {
  return store[id] || null;
}

// Devices whose recorded IPs match a predicate, newest first. Used to show which
// accounts sit behind a banned IP or range. Only devices that carried a deviceId
// are recorded, so a fresh IP with no history returns nothing.
function devicesMatching(pred, limit = 25) {
  const out = [];
  for (const id of Object.keys(store)) {
    const r = store[id];
    if (!r || !r.ips) continue;
    const hit = Object.keys(r.ips).filter((ip) => {
      try {
        return !!pred(ip);
      } catch (_) {
        return false;
      }
    });
    if (hit.length) out.push({ id, name: r.name || null, ips: hit, last: r.last || 0 });
  }
  out.sort((a, b) => b.last - a.last);
  return out.slice(0, limit);
}

// Bucket every device by which blocklist keys cover its addresses, in a single
// pass over the store. The ban list used to call devicesMatching() once per
// block, so a store of a few thousand devices meant rescanning it twenty-odd
// times on every redraw. `covering(ip, prepared)` comes from ipban.
function devicesByKeys(prepared, covering, limit = 25) {
  const out = new Map(); // block key -> [{ id, name, ips, last }]
  if (!prepared) return out;
  for (const id of Object.keys(store)) {
    const r = store[id];
    if (!r || !r.ips) continue;
    let perKey = null;
    for (const ip of Object.keys(r.ips)) {
      const keys = covering(ip, prepared);
      for (let i = 0; i < keys.length; i++) {
        if (!perKey) perKey = new Map();
        const k = keys[i];
        if (!perKey.has(k)) perKey.set(k, []);
        perKey.get(k).push(ip);
      }
    }
    if (!perKey) continue;
    for (const [key, ips] of perKey) {
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ id, name: r.name || null, ips, last: r.last || 0 });
    }
  }
  for (const [key, arr] of out) {
    arr.sort((a, b) => b.last - a.last);
    if (arr.length > limit) out.set(key, arr.slice(0, limit));
  }
  return out;
}

function prune() {
  const now = Date.now();
  for (const id of Object.keys(store))
    if (now - (store[id].last || 0) > PRUNE_AFTER_MS) delete store[id];
  let keys = Object.keys(store);
  if (keys.length > MAX_DEVICES) {
    keys.sort((a, b) => (store[a].last || 0) - (store[b].last || 0));
    const drop = keys.length - MAX_DEVICES;
    for (let i = 0; i < drop; i++) delete store[keys[i]];
  }
}

// Synchronous write for a clean shutdown, so the last few seconds of activity
// and name changes survive a restart even inside the debounce window.
function flushSync() {
  try {
    prune();
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("identity flush failed:", e);
  }
}

load();

module.exports = {
  validId,
  touch,
  addTime,
  tick,
  setName,
  setNote,
  getNote,
  setPfpBlocked,
  isPfpBlocked,
  isActive,
  summary,
  getRecord,
  devicesMatching,
  devicesByKeys,
  flushSync,
  ACTIVE_DAYS,
  ACTIVE_SEC,
  ACTIVE_ACTS,
};
