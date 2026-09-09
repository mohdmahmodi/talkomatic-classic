// server/roles.js
// Staff key system: mod-key store, hash validation, and the action audit log.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { CONFIG } = require("./state");

const { DATA_DIR } = require("./datadir");
const ipban = require("./ipban");
const ipredact = require("./ipredact");

const MOD_KEYS_PATH = path.join(DATA_DIR, "mod-keys.json");
const MODLOG_PATH = path.join(DATA_DIR, "modlog.txt");
const KEY_ACTIVITY_PATH = path.join(DATA_DIR, "key-activity.json");
const FORMER_MODS_PATH = path.join(DATA_DIR, "former-mods.json");
const KEY_REQUESTS_PATH = path.join(DATA_DIR, "key-requests.json");

const MAX_DEVICES = 2;
const MINT_TTL_MS = 15 * 60 * 1000;
const MINTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

let modKeys = [];
let modKeysSaveTimer = null;
let keyRequests = { list: [], declines: {} };
let keyRequestsSaveTimer = null;

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

function normalizeDevices(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((d) => d && typeof d.id === "string" && typeof d.token === "string")
    .map((d) => ({
      id: d.id,
      token: d.token,
      kind: String(d.kind || "device"),
      browser: d.browser ? String(d.browser) : null,
      os: d.os ? String(d.os) : null,
      at: Number(d.at) || 0,
      last: Number(d.last) || 0,
      ip: d.ip ? String(d.ip) : null,
    }))
    .slice(-MAX_DEVICES);
}

function normalizeKey(k) {
  const secret = k.secret && typeof k.secret.hash === "string" ? k.secret : null;
  return {
    hash: k.hash,
    label: String(k.label || "mod"),
    level: normalizeLevel(k.level),
    grantedBy: k.grantedBy ? String(k.grantedBy) : null,
    grantedAt: typeof k.grantedAt === "number" ? k.grantedAt : null,
    legacy: k.legacy !== false,
    secret: secret
      ? {
          hash: secret.hash,
          at: Number(secret.at) || 0,
          expires: Number(secret.expires) || null,
        }
      : null,
    devices: normalizeDevices(k.devices),
    active: typeof k.active === "string" ? k.active : null,
    switches: Array.isArray(k.switches)
      ? k.switches.map(Number).filter(Boolean)
      : [],
    mints: Array.isArray(k.mints) ? k.mints.slice(-30) : [],
    pending: typeof k.pending === "string" ? k.pending : null,
  };
}

function loadModKeys() {
  try {
    const raw = fs.readFileSync(MOD_KEYS_PATH, "utf8");
    const arr = JSON.parse(raw);
    modKeys = Array.isArray(arr)
      ? arr.filter((k) => k && typeof k.hash === "string").map(normalizeKey)
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

function saveModKeysSoon() {
  if (modKeysSaveTimer) return;
  modKeysSaveTimer = setTimeout(() => {
    modKeysSaveTimer = null;
    saveModKeys().catch((e) => console.error("mod-keys save failed:", e));
  }, 500);
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
            tokens: Array.isArray(f.tokens) ? f.tokens.map(String) : [],
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

function secretOpen(k, h, now) {
  return (
    !!k.secret &&
    k.secret.hash === h &&
    (!k.secret.expires || k.secret.expires > now)
  );
}

function keyForPlainHash(h, now) {
  return (
    modKeys.find(
      (k) =>
        k.devices.some((d) => d.token === h) ||
        secretOpen(k, h, now) ||
        (k.legacy && k.hash === h),
    ) || null
  );
}

function deviceInfo(ua) {
  const s = String(ua || "").toLowerCase();
  const kind = /ipad|tablet|(android(?!.*mobile))/.test(s)
    ? "tablet"
    : /mobile|iphone|android/.test(s)
      ? "phone"
      : "desktop";
  const os = /iphone|ipad|ipod/.test(s)
    ? "iOS"
    : /android/.test(s)
      ? "Android"
      : /windows/.test(s)
        ? "Windows"
        : /mac os x|macintosh/.test(s)
          ? "macOS"
          : /cros/.test(s)
            ? "ChromeOS"
            : /linux/.test(s)
              ? "Linux"
              : null;
  const browser = /edg\//.test(s)
    ? "Edge"
    : /opr\/|opera/.test(s)
      ? "Opera"
      : /samsungbrowser/.test(s)
        ? "Samsung Internet"
        : /firefox|fxios/.test(s)
          ? "Firefox"
          : /crios|chrome/.test(s)
            ? "Chrome"
            : /safari/.test(s)
              ? "Safari"
              : null;
  return { kind, os, browser };
}

function enroll(key, deviceId, ip, info, takeover) {
  const token = "mt_" + crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  key.devices = key.devices.filter((d) => d.id !== deviceId);
  if (key.devices.length >= MAX_DEVICES)
    key.devices
      .sort((a, b) => a.last - b.last)
      .splice(0, key.devices.length - MAX_DEVICES + 1);
  const device = {
    id: deviceId,
    token: hashKey(token),
    kind: info.kind,
    browser: info.browser,
    os: info.os,
    at: now,
    last: now,
    ip: ip || null,
  };
  key.devices.push(device);
  if (takeover || !key.devices.some((d) => d.id === key.active))
    key.active = deviceId;
  saveModKeysSoon();
  return {
    key,
    status: key.active === deviceId ? "active" : "standby",
    device,
    token,
  };
}

function resolveModKey(plain, deviceId, ip, ua) {
  if (!plain) return null;
  const h = hashKey(plain);
  const now = Date.now();
  for (const key of modKeys) {
    const dev = key.devices.find((d) => d.token === h);
    if (!dev) continue;
    if (dev.id !== deviceId) {
      key.devices = key.devices.filter((d) => d !== dev);
      if (key.active === dev.id) key.active = key.devices[0]?.id || null;
      saveModKeysSoon();
      return { key, status: "mismatch", device: dev };
    }
    dev.last = now;
    if (ip) dev.ip = ip;
    if (!key.devices.some((d) => d.id === key.active)) key.active = dev.id;
    const info = deviceInfo(ua);
    const changed =
      dev.browser && dev.os && info.browser && info.os &&
      (dev.browser !== info.browser || dev.os !== info.os)
        ? { from: dev.browser + " on " + dev.os, to: info.browser + " on " + info.os }
        : null;
    for (const f of ["kind", "browser", "os"]) if (info[f]) dev[f] = info[f];
    saveModKeysSoon();
    return {
      key,
      status: key.active === dev.id ? "active" : "standby",
      device: dev,
      changed,
    };
  }
  const key = modKeys.find(
    (k) => secretOpen(k, h, now) || (k.legacy && k.hash === h),
  );
  if (!key || !deviceId) return null;
  const fresh = secretOpen(key, h, now);
  if (fresh) key.secret = null;
  return enroll(key, deviceId, ip, deviceInfo(ua), fresh);
}

function tokenBelongsTo(plain, deviceId) {
  if (!plain || !deviceId) return false;
  const h = hashKey(plain);
  return modKeys.some((k) =>
    k.devices.some((d) => d.token === h && d.id === deviceId),
  );
}

function pendingReissueFor(deviceId, ip, ua) {
  const key = deviceId && modKeys.find((k) => k.pending === deviceId);
  if (!key) return null;
  key.pending = null;
  return enroll(key, deviceId, ip, deviceInfo(ua), true);
}

function setPendingReissue(hash, deviceId) {
  const key = modKeyByHash(hash);
  if (!key || !deviceId) return false;
  key.pending = deviceId;
  key.devices = key.devices.filter((d) => d.id !== deviceId);
  saveModKeysSoon();
  return true;
}

function mintKey(hash, by, ttl) {
  const key = modKeyByHash(hash);
  if (!key) return null;
  const now = Date.now();
  key.mints = key.mints.filter((m) => m.at > now - HOUR_MS * 24 * 30).slice(-29);
  if (key.mints.filter((m) => m.at > now - HOUR_MS).length >= MINTS_PER_HOUR)
    return { throttled: true };
  const plain = "mk_" + crypto.randomBytes(24).toString("hex");
  key.secret = { hash: hashKey(plain), at: now, expires: now + (ttl || MINT_TTL_MS) };
  key.legacy = false;
  key.mints.push({
    at: now,
    ip: by?.ip || null,
    deviceId: by?.deviceId || null,
    userId: by?.userId || null,
  });
  saveModKeysSoon();
  return { key: plain, expires: key.secret.expires };
}

function switchDevice(hash, deviceId, ip) {
  const key = modKeyByHash(hash);
  const device = key && key.devices.find((d) => d.id === deviceId);
  if (!device) return null;
  const now = Date.now();
  const from = key.devices.find((d) => d.id === key.active) || null;
  key.active = deviceId;
  device.last = now;
  if (ip) device.ip = ip;
  key.switches = key.switches.filter((t) => t > now - HOUR_MS).concat(now);
  saveModKeysSoon();
  return {
    from,
    device,
    count: key.switches.length,
    ips: [...new Set(key.devices.map((d) => d.ip).filter(Boolean))],
  };
}

function dropDevice(hash, deviceId) {
  const key = modKeyByHash(hash);
  if (!key) return false;
  const before = key.devices.length;
  key.devices = key.devices.filter((d) => d.id !== deviceId);
  if (key.active === deviceId) key.active = key.devices[0]?.id || null;
  saveModKeysSoon();
  return key.devices.length !== before;
}

function keepDevice(hash, deviceId) {
  const key = modKeyByHash(hash);
  if (!key) return [];
  const gone = key.devices.filter((d) => d.id !== deviceId).map((d) => d.id);
  key.devices = key.devices.filter((d) => d.id === deviceId);
  key.active = key.devices.length ? deviceId : null;
  saveModKeysSoon();
  return gone;
}

function keyForDevice(deviceId) {
  let best = null;
  let at = -1;
  for (const k of modKeys)
    for (const d of k.devices)
      if (d.id === deviceId && d.last > at) {
        best = k;
        at = d.last;
      }
  return best;
}

function deviceView(key, showIp) {
  return key.devices.map((d) => ({
    id: d.id.slice(0, 8),
    kind: d.kind,
    browser: d.browser,
    os: d.os,
    at: d.at,
    last: d.last,
    active: d.id === key.active,
    ...(showIp ? { ip: d.ip } : {}),
  }));
}

function restoreFormer(hash) {
  if (modKeyByHash(hash)) return null;
  const f = formerByHash(hash);
  if (!f) return null;
  const key = normalizeKey({ ...f, legacy: false, devices: [] });
  modKeys.push(key);
  saveModKeysSoon();
  return key;
}

function loadKeyRequests() {
  try {
    const obj = JSON.parse(fs.readFileSync(KEY_REQUESTS_PATH, "utf8"));
    keyRequests = {
      list: Array.isArray(obj?.list) ? obj.list.filter((r) => r && r.id) : [],
      declines:
        obj?.declines && typeof obj.declines === "object" ? obj.declines : {},
    };
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading key-requests.json:", err);
    keyRequests = { list: [], declines: {} };
  }
}

function saveKeyRequestsSoon() {
  if (keyRequestsSaveTimer) return;
  keyRequestsSaveTimer = setTimeout(async () => {
    keyRequestsSaveTimer = null;
    try {
      const tmp = KEY_REQUESTS_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(keyRequests), "utf8");
      await fsp.rename(tmp, KEY_REQUESTS_PATH);
    } catch (e) {
      console.error("key-requests save failed:", e);
    }
  }, 500);
}

function openKeyRequest(r) {
  if (!r?.label || !r.deviceId) return null;
  if (keyRequests.list.some((x) => x.label === r.label || x.deviceId === r.deviceId))
    return null;
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    label: String(r.label).slice(0, 40),
    hash: r.hash || null,
    level: normalizeLevel(r.level),
    kind: r.kind === "revoked" ? "revoked" : "lost",
    text: String(r.text || "").slice(0, 600),
    deviceId: r.deviceId,
    ip: r.ip || null,
    known: !!r.known,
    at: Date.now(),
  };
  keyRequests.list.push(entry);
  saveKeyRequestsSoon();
  return entry;
}

const keyRequestById = (id) =>
  keyRequests.list.find((r) => r.id === id) || null;

const keyRequestFor = (field, value) =>
  (value && keyRequests.list.find((r) => r[field] === value)) || null;

function closeKeyRequest(id) {
  const r = keyRequestById(id);
  if (!r) return null;
  keyRequests.list = keyRequests.list.filter((x) => x !== r);
  saveKeyRequestsSoon();
  return r;
}

function noteDecline(deviceId, note) {
  if (!deviceId) return;
  keyRequests.declines[deviceId] = { note: String(note || "").slice(0, 300), at: Date.now() };
  saveKeyRequestsSoon();
}

function takeDecline(deviceId) {
  const d = deviceId && keyRequests.declines[deviceId];
  if (!d) return null;
  delete keyRequests.declines[deviceId];
  saveKeyRequestsSoon();
  return d;
}

const requestSummary = (r) =>
  r
    ? { id: r.id, kind: r.kind, at: r.at, text: ipredact.redact(r.text), known: r.known }
    : null;

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
  const mk = key ? keyForPlainHash(hashKey(key), Date.now()) : null;
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
  const entry = normalizeKey({
    hash: hashKey(key),
    label: String(label || "mod")
      .trim()
      .slice(0, 40) || "mod",
    level: normalizeLevel(level == null ? 1 : level),
    grantedBy: grantedBy
      ? String(grantedBy).trim().slice(0, 60) || null
      : null,
    grantedAt: Date.now(),
    legacy: false,
    secret: { hash: hashKey(key), at: Date.now(), expires: null },
  });
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
    tokens: gone.devices.map((d) => d.token),
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
      request: requestSummary(keyRequestFor("hash", f.hash)),
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
    devices: deviceView(k, showAll),
    switches: k.switches.filter((t) => t > Date.now() - HOUR_MS).length,
    minted: k.mints.length,
    request: requestSummary(keyRequestFor("hash", k.hash)),
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
  if (deviceId) {
    bump(rec.devices, deviceId, now);
    const d = rec.devices[deviceId];
    (d.ips = d.ips || {})[ip] = now;
  }
  saveKeyActivitySoon();
  return { newIp };
}

const NET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NET_WARN_AT = 2;
const NET_REVIEW_AT = 3;
// History alone cannot tell a phone from a leak: carriers hand out a fresh
// address from another block most days. So a busy history only warns and
// asks for a look; the automatic revoke stays with the concurrent-use
// watcher, which is the one case that proves two people. Flip this to make
// three networks revoke on the spot anyway.
const NET_AUTO_REVOKE = false;

// Distinct network families a key has used lately: IPv4 by /16, IPv6 by
// /32, coarse enough that one carrier's daily address shuffle stays one
// family. An IPv4 and an IPv6 family together are just marked: that is one
// connection speaking both.
function netFamily(ip) {
  const cidr = ipban.computeRangeCidr(ip, ip.includes(":") && !/^::ffff:/i.test(ip) ? 32 : 16);
  return cidr || ip;
}

function networkReport(hash, now) {
  const rec = keyActivity[hash];
  const at = now || Date.now();
  const v4 = new Set();
  const v6 = new Set();
  const ips = [];
  for (const [ip, m] of Object.entries(rec?.ips || {})) {
    if (at - (m.last || 0) > NET_WINDOW_MS) continue;
    const fam = netFamily(ip);
    (fam.includes(":") ? v6 : v4).add(fam);
    ips.push(ip);
  }
  const level =
    v4.size >= NET_REVIEW_AT
      ? NET_AUTO_REVOKE
        ? "revoke"
        : "review"
      : v4.size >= NET_WARN_AT
        ? "warn"
        : v4.size && v6.size
          ? "mixed"
          : "ok";
  return {
    v4: [...v4],
    v6: [...v6],
    ips,
    level,
    windowDays: NET_WINDOW_MS / 86400000,
    warnAt: NET_WARN_AT,
    reviewAt: NET_REVIEW_AT,
    autoRevoke: NET_AUTO_REVOKE,
  };
}

function formerByHash(hash) {
  for (let i = formerMods.length - 1; i >= 0; i--)
    if (formerMods[i].hash === hash) return formerMods[i];
  return null;
}

function modKeyByHash(hash) {
  return modKeys.find((k) => k.hash === hash) || null;
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
    if (formerMods[i].hash === h || formerMods[i].tokens.includes(h))
      return formerMods[i];
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
      .map(([id, m]) => ({
        id,
        first: m.first,
        last: m.last,
        count: m.count,
        ips: Object.keys(m.ips || {}),
      }))
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
loadKeyRequests();

module.exports = {
  hashKey,
  rememberProfile,
  getProfile,
  noteKeyEntered,
  networkReport,
  formerByHash,
  modKeyByHash,
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
  getModKeyByHash,
  deviceInfo,
  resolveModKey,
  tokenBelongsTo,
  pendingReissueFor,
  setPendingReissue,
  mintKey,
  switchDevice,
  dropDevice,
  keepDevice,
  keyForDevice,
  restoreFormer,
  openKeyRequest,
  keyRequestById,
  keyRequestFor,
  closeKeyRequest,
  noteDecline,
  takeDecline,
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
