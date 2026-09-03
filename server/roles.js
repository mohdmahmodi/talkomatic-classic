// server/roles.js
// Staff key system: mod-key store, hash validation, and the action audit log.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { CONFIG } = require("./state");

const { DATA_DIR } = require("./datadir");

const MOD_KEYS_PATH = path.join(DATA_DIR, "mod-keys.json");
const MODLOG_PATH = path.join(DATA_DIR, "modlog.txt");
const KEY_ACTIVITY_PATH = path.join(DATA_DIR, "key-activity.json");
const FORMER_MODS_PATH = path.join(DATA_DIR, "former-mods.json");

let modKeys = [];

let formerMods = [];
const FORMER_CAP = 300;

let keyActivity = {};
let keyActivitySaveTimer = null;

function hashKey(key) {
  return crypto
    .createHash("sha256")
    .update(String(key))
    .digest("hex");
}

// Mod levels: 1 = junior, 2 = full, 3 = leader. Anything unknown lands on 1.
function normalizeLevel(v) {
  const n = Math.floor(Number(v));
  if (n >= 3) return 3;
  return n === 2 ? 2 : 1;
}

function loadModKeys() {
  try {
    const raw = fs.readFileSync(MOD_KEYS_PATH, "utf8");
    const arr = JSON.parse(raw);
    modKeys = Array.isArray(arr)
      ? arr
          .filter((k) => k && typeof k.hash === "string")
          .map((k) => ({
            hash: k.hash,
            label: String(k.label || "mod"),
            level: normalizeLevel(k.level),
            grantedBy: k.grantedBy ? String(k.grantedBy) : null,
            grantedAt: typeof k.grantedAt === "number" ? k.grantedAt : null,
          }))
      : [];
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading mod-keys.json:", err);
    modKeys = [];
  }
  return modKeys;
}

async function saveModKeys() {
  const tmp = MOD_KEYS_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(modKeys, null, 2), "utf8");
  await fsp.rename(tmp, MOD_KEYS_PATH);
}

function loadFormerMods() {
  try {
    const arr = JSON.parse(fs.readFileSync(FORMER_MODS_PATH, "utf8"));
    formerMods = Array.isArray(arr)
      ? arr
          .filter((f) => f && typeof f.label === "string")
          .map((f) => ({
            hash: f.hash ? String(f.hash) : null,
            label: String(f.label),
            level: normalizeLevel(f.level),
            grantedBy: f.grantedBy ? String(f.grantedBy) : null,
            grantedAt: typeof f.grantedAt === "number" ? f.grantedAt : null,
            removedAt: typeof f.removedAt === "number" ? f.removedAt : null,
            removedBy: f.removedBy ? String(f.removedBy) : null,
            reason: f.reason ? String(f.reason) : null,
          }))
      : [];
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading former-mods.json:", err);
    formerMods = [];
  }
  return formerMods;
}

async function saveFormerMods() {
  const tmp = FORMER_MODS_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(formerMods, null, 2), "utf8");
  await fsp.rename(tmp, FORMER_MODS_PATH);
}

let devKeys = [];

function parseKeyList(raw, main) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      const hash = (idx === -1 ? part : part.slice(0, idx)).trim().toLowerCase();
      const label = idx === -1 ? "dev" : part.slice(idx + 1).trim() || "dev";
      return main ? { hash, label, main: true } : { hash, label };
    });
}

function loadDevKeys() {
  const first = parseKeyList(CONFIG.DEV.MAIN_KEY_HASH, true);
  const seenHash = new Set(first.map((d) => d.hash));
  const seenLabel = new Set(first.map((d) => d.label));
  devKeys = [
    ...first,
    ...parseKeyList(CONFIG.DEV.KEY_HASH, false).filter(
      (d) => !seenHash.has(d.hash) && !seenLabel.has(d.label),
    ),
  ];
  return devKeys;
}

function getDevKey(key) {
  if (!key) return null;
  const h = hashKey(key);
  return devKeys.find((d) => d.hash === h) || null;
}

function isDevKey(key) {
  return !!getDevKey(key);
}

function isMainDevHash(hash) {
  if (!hash) return false;
  const h = String(hash).toLowerCase();
  return devKeys.some((d) => d.main && d.hash === h);
}

function isMainDevLabel(label) {
  if (!label) return false;
  return devKeys.some((d) => d.main && d.label === label);
}

function isMainDevActor(label, role) {
  if (role && role !== "dev") return false;
  return isMainDevLabel(label);
}

function viewFor(socket) {
  return {
    ip: !!(socket && socket.isMainDev),
    names: !!(socket && socket.isDev),
  };
}

function listDevKeys(all) {
  return devKeys
    .filter((d) => all || !d.main)
    .map((d) => ({ hash: d.hash, label: d.label }));
}

const PUBLIC_STAFF = "the Talkomatic staff";
const PUBLIC_SYSTEM = "the system";

const TEAM_LABEL = "Talkomatic staff";
const SYSTEM_LABEL = "Talkomatic";
const SYSTEM_ENFORCED = "Talkomatic (Automod)";

function isDevLabel(label) {
  return !!label && devKeys.some((d) => d.label === label);
}

function isDevActor(label, role) {
  return role ? role === "dev" : isDevLabel(label);
}

function systemLabel(label, role) {
  return isMainDevActor(label, role) ? SYSTEM_LABEL : label;
}

// view semantics: a non-null view means a STAFF viewer (from viewFor) and gets
// real staff labels; a null view is a public-facing caller and keeps the mask.
// The main dev renders as SYSTEM_LABEL for everyone below main dev either way.
function teamLabel(label, role, view) {
  if (!label) return label;
  if (view && view.ip) return label;
  if (isMainDevActor(label, role)) return SYSTEM_LABEL;
  if (view) return label;
  return isDevActor(label, role) ? label : TEAM_LABEL;
}

function enforcedLabel(label, role, view) {
  if (!label) return label;
  if (view && view.ip) return label;
  if (isMainDevActor(label, role)) return SYSTEM_ENFORCED;
  return teamLabel(label, role, view);
}

function teamReviewer(value, view) {
  const s = String(value || "");
  if (!s) return value;
  const idx = s.indexOf(":");
  const role = idx === -1 ? null : s.slice(0, idx);
  const label = idx === -1 ? s : s.slice(idx + 1);
  if (view && view.ip) return value;
  if (isMainDevActor(label, role)) return SYSTEM_LABEL;
  if (view) return value;
  if (isDevActor(label, role)) return value;
  return (idx === -1 ? "" : s.slice(0, idx + 1)) + TEAM_LABEL;
}

function publicStaffName(label, role) {
  if (!label) return null;
  return isMainDevActor(label, role) ? PUBLIC_SYSTEM : PUBLIC_STAFF;
}

function stripStaffNames(text, view) {
  if (!text || typeof text !== "string") return text;
  if (view && view.ip) return text;
  let out = text;
  const ops = devKeys
    .filter((d) => d.main)
    .map((d) => ({ name: d.label, dev: true }));
  const names = view
    ? ops
    : [
        ...ops,
        ...modKeys.map((k) => ({ name: k.label, dev: false })),
        ...formerMods.map((f) => ({ name: f.label, dev: false })),
      ];
  for (const { name, dev } of names) {
    if (!name || name.length < 2 || !out.includes(name)) continue;
    out = out.split(name).join(dev ? SYSTEM_LABEL : TEAM_LABEL);
  }
  return out;
}

function getModKeyByPlain(key) {
  if (!key) return null;
  const h = hashKey(key);
  return modKeys.find((k) => k.hash === h) || null;
}

function getModKeyByHash(hash) {
  if (!hash) return null;
  return modKeys.find((k) => k.hash === hash) || null;
}

// Current level for a label: the active key wins, then the most recent former
// key with that label. Null when the label is unknown.
function modLevelForLabel(label) {
  if (!label) return null;
  const active = modKeys.find((k) => k.label === label);
  if (active) return normalizeLevel(active.level);
  for (let i = formerMods.length - 1; i >= 0; i--)
    if (formerMods[i].label === label) return normalizeLevel(formerMods[i].level);
  return null;
}

function validateKey(key) {
  const dk = getDevKey(key);
  if (dk) return { role: "dev", label: dk.label, hash: dk.hash };
  const mk = getModKeyByPlain(key);
  if (mk)
    return {
      role: "mod",
      label: mk.label,
      hash: mk.hash,
      level: normalizeLevel(mk.level),
    };
  return { role: null, label: null, hash: null };
}

async function grantModKey(label, level, grantedBy) {
  const key = "mk_" + crypto.randomBytes(24).toString("hex");
  const entry = {
    hash: hashKey(key),
    label: String(label || "mod")
      .trim()
      .slice(0, 40) || "mod",
    level: normalizeLevel(level == null ? 1 : level),
    grantedBy: grantedBy
      ? String(grantedBy).trim().slice(0, 60) || null
      : null,
    grantedAt: Date.now(),
  };
  modKeys.push(entry);
  carryKeyActivity(entry.label, entry.hash);
  await saveModKeys();
  return { key, hash: entry.hash, label: entry.label, level: entry.level };
}

function carryKeyActivity(label, newHash) {
  if (!label || !newHash || keyActivity[newHash]) return;
  let from = null;
  for (let i = formerMods.length - 1; i >= 0; i--) {
    const f = formerMods[i];
    if (f.label !== label || !f.hash) continue;
    if (keyActivity[f.hash]) {
      from = keyActivity[f.hash];
      break;
    }
  }
  if (!from) return;
  const ips = {};
  for (const ip in from.ips || {}) {
    const m = from.ips[ip];
    if (m) ips[ip] = { first: m.first, last: m.last, count: m.count };
  }
  keyActivity[newHash] = { label, role: from.role || "mod", ips };
  saveKeyActivitySoon();
}

async function revokeModKey(hash, opts) {
  const gone = modKeys.find((k) => k.hash === hash);
  if (!gone) return false;
  modKeys = modKeys.filter((k) => k.hash !== hash);
  await saveModKeys();
  formerMods.push({
    hash: gone.hash,
    label: gone.label,
    level: normalizeLevel(gone.level),
    grantedBy: gone.grantedBy || null,
    grantedAt: gone.grantedAt || null,
    removedAt: Date.now(),
    removedBy: opts && opts.by ? String(opts.by).trim().slice(0, 60) : null,
    reason:
      opts && opts.reason
        ? String(opts.reason).trim().slice(0, 300) || null
        : null,
  });
  if (formerMods.length > FORMER_CAP)
    formerMods = formerMods.slice(formerMods.length - FORMER_CAP);
  try {
    await saveFormerMods();
  } catch (e) {
    console.error("former-mods save failed:", e);
  }
  return true;
}

function listFormerMods(view) {
  const showAll = !!(view && view.ip);
  const active = new Set(modKeys.map((k) => k.label));
  return formerMods
    .slice()
    .reverse()
    .map((f) => ({
      hash: f.hash,
      label: f.label,
      level: normalizeLevel(f.level),
      grantedBy: showAll
        ? f.grantedBy || null
        : teamLabel(f.grantedBy || null, null, view),
      grantedAt: f.grantedAt || null,
      removedAt: f.removedAt || null,
      removedBy: showAll
        ? f.removedBy || null
        : teamLabel(f.removedBy || null, null, view),
      reason: f.reason || null,
      lastSeen: f.hash ? lastSeenForHash(f.hash) : null,
      returned: active.has(f.label),
    }));
}

function formerLabels() {
  const active = new Set(modKeys.map((k) => k.label));
  for (const d of devKeys) active.add(d.label);
  const out = new Set();
  for (const f of formerMods) if (!active.has(f.label)) out.add(f.label);
  return out;
}

async function setModLevel(hash, level) {
  const mk = modKeys.find((k) => k.hash === hash);
  if (!mk) return null;
  mk.level = normalizeLevel(level);
  await saveModKeys();
  return mk.level;
}

function lastSeenForHash(hash) {
  const rec = keyActivity[hash];
  if (!rec || !rec.ips) return null;
  let last = 0;
  for (const ip in rec.ips) {
    const m = rec.ips[ip];
    if (m && m.last && m.last > last) last = m.last;
  }
  return last || null;
}

function listModKeys(view) {
  const showAll = !!(view && view.ip);
  return modKeys.map((k) => ({
    hash: k.hash,
    label: k.label,
    level: normalizeLevel(k.level),
    grantedBy: showAll
      ? k.grantedBy || null
      : teamLabel(k.grantedBy || null, null, view),
    grantedAt: k.grantedAt || null,
    lastSeen: lastSeenForHash(k.hash),
  }));
}

function modLog({ label, action, target, room } = {}) {
  const line =
    [
      new Date().toISOString(),
      label || "?",
      action || "?",
      target != null ? String(target) : "-",
      room != null ? String(room) : "-",
    ].join(" | ") + "\n";
  fsp
    .appendFile(MODLOG_PATH, line)
    .catch((e) => console.error("modlog append failed:", e));
}

// ── Key-use tracking (leak detection) ───────────────────────────────────────
function loadKeyActivity() {
  try {
    const obj = JSON.parse(fs.readFileSync(KEY_ACTIVITY_PATH, "utf8"));
    keyActivity = obj && typeof obj === "object" ? obj : {};
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading key-activity.json:", err);
    keyActivity = {};
  }
}

function saveKeyActivitySoon() {
  if (keyActivitySaveTimer) return;
  keyActivitySaveTimer = setTimeout(async () => {
    keyActivitySaveTimer = null;
    try {
      const tmp = KEY_ACTIVITY_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(keyActivity), "utf8");
      await fsp.rename(tmp, KEY_ACTIVITY_PATH);
    } catch (e) {
      console.error("key-activity save failed:", e);
    }
  }, 2000);
}

function keyRecord(hash, label, role) {
  let rec = keyActivity[hash];
  if (!rec) rec = keyActivity[hash] = { label: label || role, role, ips: {} };
  if (label) rec.label = label;
  if (role) rec.role = role;
  if (!rec.devices) rec.devices = {};
  return rec;
}

function bump(map, key, now) {
  const seen = map[key];
  if (seen) {
    seen.last = now;
    seen.count = (seen.count || 0) + 1;
  } else map[key] = { first: now, last: now, count: 1 };
  return !seen;
}

function recordKeyUse(hash, label, role, ip, deviceId) {
  if (!hash || !ip) return { newIp: false };
  const rec = keyRecord(hash, label, role);
  const now = Date.now();
  const newIp = bump(rec.ips, ip, now);
  if (deviceId) bump(rec.devices, deviceId, now);
  saveKeyActivitySoon();
  return { newIp };
}

// The name, location and picture a key last signed in with, so the next
// device it is typed into can fill them in.
function rememberProfile(hash, profile) {
  if (!hash || !profile?.name) return;
  keyRecord(hash).profile = { ...profile, at: Date.now() };
  saveKeyActivitySoon();
}

function getProfile(hash) {
  return (hash && keyActivity[hash]?.profile) || null;
}

function noteKeyEntered(hash) {
  if (!hash) return;
  const rec = keyRecord(hash);
  rec.entered = (rec.entered || 0) + 1;
  rec.enteredLast = Date.now();
  saveKeyActivitySoon();
}

// Stamp "last" for a key+ip without counting a new use. Called when a staff
// socket disconnects, so last-seen covers the whole session, not just connect.
function touchKeyUse(hash, ip) {
  if (!hash || !ip) return;
  const rec = keyActivity[hash];
  if (!rec || !rec.ips || !rec.ips[ip]) return;
  rec.ips[ip].last = Date.now();
  saveKeyActivitySoon();
}

// A revoked key presented at connect: find its former-mods entry so the
// person can be told why they were removed.
function getFormerModByPlain(key) {
  if (!key) return null;
  const h = hashKey(key);
  for (let i = formerMods.length - 1; i >= 0; i--)
    if (formerMods[i].hash === h) return formerMods[i];
  return null;
}

function getKeyActivity() {
  return Object.entries(keyActivity).map(([hash, r]) => ({
    hash,
    label: r.label,
    role: r.role,
    ips: Object.entries(r.ips || {})
      .map(([ip, m]) => ({ ip, first: m.first, last: m.last, count: m.count }))
      .sort((a, b) => (b.last || 0) - (a.last || 0)),
    devices: Object.entries(r.devices || {})
      .map(([id, m]) => ({ id, first: m.first, last: m.last, count: m.count }))
      .sort((a, b) => (b.last || 0) - (a.last || 0)),
    entered: r.entered || 0,
    enteredLast: r.enteredLast || 0,
    profile: r.profile ? { name: r.profile.name, at: r.profile.at } : null,
  }));
}

loadModKeys();
loadDevKeys();
loadKeyActivity();
loadFormerMods();

module.exports = {
  hashKey,
  rememberProfile,
  getProfile,
  noteKeyEntered,
  loadModKeys,
  saveModKeys,
  loadDevKeys,
  getDevKey,
  isDevKey,
  isMainDevHash,
  isMainDevLabel,
  isMainDevActor,
  viewFor,
  listDevKeys,
  publicStaffName,
  isDevLabel,
  systemLabel,
  enforcedLabel,
  teamLabel,
  teamReviewer,
  stripStaffNames,
  getModKeyByPlain,
  getModKeyByHash,
  modLevelForLabel,
  validateKey,
  grantModKey,
  revokeModKey,
  setModLevel,
  listModKeys,
  listFormerMods,
  formerLabels,
  modLog,
  recordKeyUse,
  touchKeyUse,
  getFormerModByPlain,
  getKeyActivity,
};
