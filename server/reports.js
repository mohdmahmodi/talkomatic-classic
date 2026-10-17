// server/reports.js
// Tally of user reports so staff can see how many distinct people reported
// someone, and why.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "reports.json");
const CLOSED_PATH = path.join(DATA_DIR, "reports-closed.json");

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TARGETS = 5000;
const MAX_PER_TARGET = 100;
const CLOSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const CLOSED_MAX = 1500;
const FOLLOWUP_MS = 15 * 60 * 1000;

let byTarget = new Map();
let closed = [];
let closedSeq = 0;
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
  try {
    const obj = JSON.parse(fs.readFileSync(CLOSED_PATH, "utf8"));
    closed = Array.isArray(obj.closed) ? obj.closed : [];
    closedSeq = Number(obj.seq) || closed.reduce((m, c) => Math.max(m, c.id || 0), 0);
    pruneClosed(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading reports-closed.json:", err);
    closed = [];
  }
}

function closedJson() {
  return JSON.stringify({ seq: closedSeq, closed });
}

function pruneClosed(now) {
  closed = closed.filter((c) => now - (c.closedAt || 0) <= CLOSED_KEEP_MS);
  if (closed.length > CLOSED_MAX) closed.length = CLOSED_MAX;
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
      const ctmp = CLOSED_PATH + ".tmp";
      await fsp.writeFile(ctmp, closedJson(), "utf8");
      await fsp.rename(ctmp, CLOSED_PATH);
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
    const ctmp = CLOSED_PATH + ".tmp";
    fs.writeFileSync(ctmp, closedJson(), "utf8");
    fs.renameSync(ctmp, CLOSED_PATH);
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
  openedText,
  openedTextWiped,
  openedAt,
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
    openedText: openedText || null,
    openedTextWiped: !!openedTextWiped,
    openedAt: openedAt || null,
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

function close(targetKey, { outcome, action, detail, by, name } = {}) {
  if (!targetKey) return null;
  const now = Date.now();
  const step = { action: action || outcome || "closed", detail: detail || null, by: by || null, at: now };
  const rows = byTarget.get(targetKey);
  if (!rows || !rows.length) {
    if (outcome !== "action") return null;
    const recent = closed.find(
      (c) => c.targetKey === targetKey && c.outcome === "action" && now - c.closedAt < FOLLOWUP_MS,
    );
    if (!recent) return null;
    recent.steps.push(step);
    if (recent.steps.length > 12) recent.steps.splice(0, recent.steps.length - 12);
    saveSoon();
    return recent;
  }
  byTarget.delete(targetKey);
  const categories = {};
  for (const r of rows) categories[r.category] = (categories[r.category] || 0) + 1;
  let location = null;
  for (let i = rows.length - 1; i >= 0 && !location; i--) location = rows[i].targetLocation || null;
  const rec = {
    id: ++closedSeq,
    targetKey,
    name: name || rows[rows.length - 1].targetName || null,
    location,
    rows: rows.slice(),
    categories,
    total: rows.length,
    distinct: distinctReporters(rows),
    first: rows[0].at,
    last: rows[rows.length - 1].at,
    outcome: outcome === "discarded" ? "discarded" : "action",
    steps: [step],
    closedAt: now,
  };
  closed.unshift(rec);
  pruneClosed(now);
  saveSoon();
  return rec;
}

function closedList() {
  pruneClosed(Date.now());
  return closed.slice();
}

function removeClosed(id) {
  const before = closed.length;
  closed = closed.filter((c) => c.id !== id);
  if (closed.length === before) return false;
  saveSoon();
  return true;
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
  close,
  closedList,
  removeClosed,
  isTarget,
  flushSync,
};
