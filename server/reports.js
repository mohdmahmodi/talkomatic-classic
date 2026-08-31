// server/reports.js
// Tally of user reports so staff can see how many distinct people reported
// someone, and why.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "reports.json");

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TARGETS = 5000;
const MAX_PER_TARGET = 100;

let byTarget = new Map();
let saveTimer = null;
let dirty = false;

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const obj = JSON.parse(raw);
    byTarget = new Map();
    if (obj && typeof obj === "object") {
      for (const [k, arr] of Object.entries(obj))
        if (Array.isArray(arr)) byTarget.set(k, arr);
    }
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading reports.json:", err);
    byTarget = new Map();
  }
}

function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(byTarget)), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("reports save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(byTarget)), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("reports flush failed:", e);
  }
}

function prune(now) {
  for (const [k, arr] of byTarget) {
    const fresh = arr.filter((r) => now - r.at <= WINDOW_MS);
    if (fresh.length) byTarget.set(k, fresh);
    else byTarget.delete(k);
  }
  if (byTarget.size > MAX_TARGETS) {
    const keys = [...byTarget.keys()];
    for (let i = 0; i < keys.length - MAX_TARGETS; i++) byTarget.delete(keys[i]);
  }
}

function distinctReporters(list) {
  const ids = new Set();
  let anon = 0;
  for (const r of list) {
    if (r.byDeviceId) ids.add(r.byDeviceId);
    else anon++;
  }
  return ids.size + (anon > 0 ? 1 : 0);
}

function add({
  targetKey,
  targetName,
  targetLocation,
  byDeviceId,
  byName,
  category,
  reason,
  targetIp,
  targetDeviceId,
  targetRole,
  targetText,
  targetTextWiped,
}) {
  if (!targetKey) return { total: 0, distinct: 0 };
  const now = Date.now();
  let arr = byTarget.get(targetKey);
  if (!arr) {
    arr = [];
    byTarget.set(targetKey, arr);
  }
  arr.push({
    targetName: targetName || null,
    targetLocation: targetLocation || null,
    byDeviceId: byDeviceId || null,
    byName: byName || null,
    category: category || "other",
    reason: reason || null,
    at: now,
    targetIp: targetIp || null,
    targetDeviceId: targetDeviceId || null,
    targetRole: targetRole || null,
    targetText: targetText || null,
    targetTextWiped: !!targetTextWiped,
  });
  if (arr.length > MAX_PER_TARGET) arr.splice(0, arr.length - MAX_PER_TARGET);
  prune(now);
  saveSoon();
  const list = byTarget.get(targetKey) || [];
  return { total: list.length, distinct: distinctReporters(list) };
}

function forTarget(targetKey) {
  return (byTarget.get(targetKey) || []).slice();
}

function lastKnown(targetKey) {
  const arr = byTarget.get(targetKey);
  if (!arr || !arr.length) return null;
  let ip = null,
    deviceId = null,
    name = null,
    role = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (!ip && r.targetIp) ip = r.targetIp;
    if (!deviceId && r.targetDeviceId) deviceId = r.targetDeviceId;
    if (!name && r.targetName) name = r.targetName;
    if (!role && r.targetRole) role = r.targetRole;
  }
  return { ip, deviceId, name, role };
}

function clear(targetKey) {
  const had = byTarget.delete(targetKey);
  if (had) saveSoon();
  return had;
}

function summary() {
  const out = [];
  for (const [targetKey, arr] of byTarget) {
    const cats = {};
    for (const r of arr) cats[r.category] = (cats[r.category] || 0) + 1;
    out.push({
      targetKey,
      name: arr.length ? arr[arr.length - 1].targetName : null,
      total: arr.length,
      distinct: distinctReporters(arr),
      categories: cats,
      first: arr.length ? arr[0].at : 0,
      last: arr.length ? arr[arr.length - 1].at : 0,
    });
  }
  return out.sort((a, b) => b.distinct - a.distinct || b.total - a.total);
}

load();

function isTarget(targetKey) {
  return !!targetKey && byTarget.has(targetKey);
}

module.exports = {
  add,
  forTarget,
  lastKnown,
  summary,
  clear,
  isTarget,
  flushSync,
};
