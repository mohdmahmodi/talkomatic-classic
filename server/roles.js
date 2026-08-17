// server/roles.js
// Staff key system: mod-key store, hash validation, and the action audit log.
//
// Dev key is a single SHA-256 hash in .env (CONFIG.DEV.KEY_HASH), owner-only,
// restart-to-change. Mod keys live in mod-keys.json as { hash, label } records,
// loaded at boot and mutable at runtime (devs grant/revoke without a restart).
// Every privileged action appends one line to modlog.txt.

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

// In-memory mirror of mod-keys.json: [{ hash, label, level, grantedBy, grantedAt }]
let modKeys = [];

// Everyone whose key has been revoked, newest last. A removed moderator drops
// out of the roster, but the fact that they were one - and why they stopped
// being one - is kept.
let formerMods = [];
const FORMER_CAP = 300;

// Which IPs each staff key has ever connected from, persisted so a leaked key
// being used from a brand-new IP can be flagged even across restarts.
// hash -> { label, role, ips: { ip: { first, last, count } } }
let keyActivity = {};
let keyActivitySaveTimer = null;

function hashKey(key) {
  return crypto
    .createHash("sha256")
    .update(String(key))
    .digest("hex");
}

// Mod keys carry a level: 1 = junior (limited), 2 = full. Keys written before
// levels existed have no field; those are treated as full (2) so no existing
// moderator is silently downgraded. Only an explicit 1 yields a junior key;
// anything else resolves to full.
function normalizeLevel(v) {
  return Math.floor(Number(v)) === 1 ? 1 : 2;
}

// Loaded synchronously at module require time so the socket middleware can
// validate keys on the very first connection.
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
            // Who minted the key and when. Older keys predate this and stay null.
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

// Atomic write (tmp + rename) mirrors how rooms.json is persisted.
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

// Dev keys live in .env as DEV_KEY_HASH - a comma-separated list of
// "<sha256hash>" or "<sha256hash>:Label" entries (owner-only, restart to
// change). This supports multiple devs, each with a name for the audit log.
//
// MAIN_DEV_KEY_HASH is the same format for the key that carries the site
// itself: uptime, error triage, and the raw server-side detail the health
// checks are read against, on top of everything a dev key does. Its entries
// load first, so a key named in both resolves to the higher one.
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
  devKeys = [
    ...parseKeyList(CONFIG.DEV.MAIN_KEY_HASH, true),
    ...parseKeyList(CONFIG.DEV.KEY_HASH, false),
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

// Hashes + labels only - safe for an info panel.
function listDevKeys() {
  return devKeys.map((d) => ({ hash: d.hash, label: d.label }));
}

// How an action reads to the person it landed on. Staff surfaces keep the real
// label, because the team has to be able to hold each other to account; the
// user gets the team, not the individual. A moderator who bans somebody should
// not have to wonder whether that person will come looking for them, and the
// name is the only thing that makes that possible.
const PUBLIC_DEV = "the Talkomatic team";
const PUBLIC_STAFF = "the Talkomatic staff";

function publicStaffName(label, role) {
  if (!label) return null;
  // Older records predate the role being stored with them, so fall back to
  // asking whether that label is on the dev roster today.
  const resolved =
    role || (devKeys.some((d) => d.label === label) ? "dev" : "mod");
  return resolved === "dev" ? PUBLIC_DEV : PUBLIC_STAFF;
}

function getModKeyByPlain(key) {
  if (!key) return null;
  const h = hashKey(key);
  return modKeys.find((k) => k.hash === h) || null;
}

// Resolves a plaintext key to a role. Dev outranks mod.
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

// Generates a new mod key. Only the hash is stored; the plaintext is returned
// once for the dev to hand off and is never persisted.
// New grants default to a junior (level 1) key - least privilege - unless the
// caller asks for a full (level 2) key. (Note this differs from loadModKeys,
// where a *missing* level means an old full key.)
// `grantedBy` is a human label (the granting dev, or the reviewer who approved
// an application) kept so the Moderators panel can show who made each mod.
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

// Somebody being given a key again keeps what is known about them. Their audit
// record follows the label and survives a revoke on its own, but where the key
// has been used from is stored per HASH, and a re-issued key is a new hash. So
// a returning moderator arrived with an empty history: nothing on the key
// activity panel, no last-seen, and a "connected from an address it has never
// been used from before" alert about the address they have always used. The
// old record stays where it is; this copies it onto the new key.
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

// Removing a moderator writes a former-staff record: who they were, when the
// key was minted, who pulled it and why. `reason` is what the panel asks the
// developer for, and it is the only part of the record a human writes.
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

// Former staff, newest first. `returned` marks somebody who has since been
// given a key again - they are back on the live roster, so the panel does not
// list them as gone.
function listFormerMods() {
  const active = new Set(modKeys.map((k) => k.label));
  return formerMods
    .slice()
    .reverse()
    .map((f) => ({
      hash: f.hash,
      label: f.label,
      level: normalizeLevel(f.level),
      grantedBy: f.grantedBy || null,
      grantedAt: f.grantedAt || null,
      removedAt: f.removedAt || null,
      removedBy: f.removedBy || null,
      reason: f.reason || null,
      lastSeen: f.hash ? lastSeenForHash(f.hash) : null,
      returned: active.has(f.label),
    }));
}

// Labels that belong to nobody on staff any more. Team views are a picture of
// the current team, so these come off them - the work stays in the audit log
// and in that person's record, which is what accountability needs.
function formerLabels() {
  const active = new Set(modKeys.map((k) => k.label));
  for (const d of devKeys) active.add(d.label);
  const out = new Set();
  for (const f of formerMods) if (!active.has(f.label)) out.add(f.label);
  return out;
}

// Changes a mod key's level in place (dev-only promote/demote). Returns the new
// level, or null if no key with that hash exists.
async function setModLevel(hash, level) {
  const mk = modKeys.find((k) => k.hash === hash);
  if (!mk) return null;
  mk.level = normalizeLevel(level);
  await saveModKeys();
  return mk.level;
}

// Most recent time any IP connected on this key, from the persisted
// key-activity log. Null when the key has never been used. Lets the Moderators
// panel show how long a mod has been inactive without tracking sockets.
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

// Hashes, levels, provenance, and last-seen - safe to send to the dev panel.
function listModKeys() {
  return modKeys.map((k) => ({
    hash: k.hash,
    label: k.label,
    level: normalizeLevel(k.level),
    grantedBy: k.grantedBy || null,
    grantedAt: k.grantedAt || null,
    lastSeen: lastSeenForHash(k.hash),
  }));
}

// Appends one audit line. Best-effort; failures are logged but never throw.
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

// Records that a key (by hash) was just used from `ip`. Returns
// { newIp } so the caller can raise an alert the first time a key is seen
// from an address it has never connected from before.
function recordKeyUse(hash, label, role, ip) {
  if (!hash || !ip) return { newIp: false };
  let rec = keyActivity[hash];
  if (!rec) rec = keyActivity[hash] = { label: label || role, role, ips: {} };
  rec.label = label || rec.label;
  rec.role = role || rec.role;
  const now = Date.now();
  const seen = rec.ips[ip];
  const newIp = !seen;
  if (seen) {
    seen.last = now;
    seen.count = (seen.count || 0) + 1;
  } else {
    rec.ips[ip] = { first: now, last: now, count: 1 };
  }
  saveKeyActivitySoon();
  return { newIp };
}

// Serializable snapshot of every key's known IPs, newest IP first.
function getKeyActivity() {
  return Object.entries(keyActivity).map(([hash, r]) => ({
    hash,
    label: r.label,
    role: r.role,
    ips: Object.entries(r.ips || {})
      .map(([ip, m]) => ({ ip, first: m.first, last: m.last, count: m.count }))
      .sort((a, b) => (b.last || 0) - (a.last || 0)),
  }));
}

loadModKeys();
loadDevKeys();
loadKeyActivity();
loadFormerMods();

module.exports = {
  hashKey,
  loadModKeys,
  saveModKeys,
  loadDevKeys,
  getDevKey,
  isDevKey,
  listDevKeys,
  publicStaffName,
  getModKeyByPlain,
  validateKey,
  grantModKey,
  revokeModKey,
  setModLevel,
  listModKeys,
  listFormerMods,
  formerLabels,
  modLog,
  recordKeyUse,
  getKeyActivity,
};
