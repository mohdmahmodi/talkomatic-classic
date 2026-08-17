// server/appeals.js
// Ban-appeal store. A blocked user can appeal directly from the ban screen.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "appeals.json");
const BARS_PATH = path.join(DATA_DIR, "appeal-bars.json");
const MAX = 2000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const MSG_MAX = 1000;
const THREAD_CAP = 120;
const USER_MSG_CAP = 40;
const USER_COOLDOWN_MS = 5000;

let appeals = [];
let seq = 0;
let saveTimer = null;

// ── Appeal bars ─────────────────────────────────────────────────────────────
let bars = [];
let barSeq = 0;
let barsSaveTimer = null;
const BARS_MAX = 5000;

function loadBars() {
  try {
    const arr = JSON.parse(fs.readFileSync(BARS_PATH, "utf8"));
    bars = Array.isArray(arr) ? arr : [];
    barSeq = bars.reduce((m, b) => Math.max(m, b.id || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading appeal-bars.json:", err);
    bars = [];
  }
}

function saveBarsSoon() {
  if (barsSaveTimer) return;
  barsSaveTimer = setTimeout(async () => {
    barsSaveTimer = null;
    try {
      if (bars.length > BARS_MAX) bars = bars.slice(-BARS_MAX);
      const tmp = BARS_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(bars, null, 2), "utf8");
      await fsp.rename(tmp, BARS_PATH);
    } catch (e) {
      console.error("appeal bars save failed:", e);
    }
  }, 1500);
}

function saveBarsSync() {
  try {
    if (bars.length > BARS_MAX) bars = bars.slice(-BARS_MAX);
    const tmp = BARS_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(bars, null, 2), "utf8");
    fs.renameSync(tmp, BARS_PATH);
  } catch (e) {
    console.error("appeal bars flush failed:", e);
  }
}

function barFor({ ip, deviceId, userId } = {}) {
  return (
    bars.find(
      (b) =>
        (deviceId && b.deviceId && b.deviceId === deviceId) ||
        (userId && b.userId && b.userId === userId) ||
        (ip && b.ip && b.ip === ip),
    ) || null
  );
}

function isBarred(who) {
  return !!barFor(who);
}

function addBar({ ip, deviceId, userId, name, by, byRole, reason }) {
  const already = barFor({ ip, deviceId, userId });
  if (already) return already;
  const rec = {
    id: ++barSeq,
    ip: ip || null,
    deviceId: deviceId || null,
    userId: userId || null,
    name: name || null,
    by: by || null,
    byRole: byRole || null,
    reason: reason || null,
    at: Date.now(),
  };
  bars.push(rec);
  saveBarsSoon();
  return rec;
}

function removeBar(id) {
  const n = Number(id);
  const before = bars.length;
  bars = bars.filter((b) => b.id !== n);
  if (bars.length === before) return false;
  saveBarsSoon();
  return true;
}

function listBars() {
  return bars.slice().reverse();
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    appeals = Array.isArray(arr) ? arr : [];
    seq = appeals.reduce((m, a) => Math.max(m, a.id || 0), 0);
    for (const a of appeals) {
      if (!a.banKey) a.banKey = banKeyOf(a.ban);
      if (Array.isArray(a.messages)) continue;
      a.messages = a.message
        ? [{ id: 1, ts: a.at || Date.now(), from: "user", text: a.message }]
        : [];
      a.msgSeq = a.messages.length;
    }
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading appeals.json:", err);
    appeals = [];
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (appeals.length > MAX) appeals = appeals.slice(-MAX);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(appeals, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("appeals save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    if (appeals.length > MAX) appeals = appeals.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(appeals, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("appeals flush failed:", e);
  }
  saveBarsSync();
}

function prune(now) {
  appeals = appeals.filter((a) => now - (a.at || 0) <= WINDOW_MS);
  if (appeals.length > MAX) appeals = appeals.slice(-MAX);
}

function banKeyOf(ban) {
  if (!ban || typeof ban !== "object") return "none";
  return [ban.ts || 0, ban.expiry || 0, ban.reason || ""].join("|");
}

function openForIp(ip, banKey) {
  return (
    appeals.find(
      (a) =>
        a.ip === ip &&
        a.status === "open" &&
        (!banKey || (a.banKey || banKeyOf(a.ban)) === banKey),
    ) || null
  );
}

function submit({ ip, deviceId, userId, name, message, ban }) {
  if (!ip) return { ok: false, code: "no_ip" };
  if (isBarred({ ip, deviceId, userId })) return { ok: false, code: "barred" };
  const key = banKeyOf(ban);
  if (openForIp(ip, key)) return { ok: false, code: "already" };
  const decided = appeals.find(
    (a) =>
      (a.ip === ip || (deviceId && a.deviceId === deviceId)) &&
      a.status === "resolved" &&
      (a.banKey || banKeyOf(a.ban)) === key,
  );
  if (decided) return { ok: false, code: "decided" };
  const now = Date.now();
  const a = {
    id: ++seq,
    ip,
    deviceId: deviceId || null,
    userId: userId || null,
    name: name || null,
    message: message || "",
    at: now,
    status: "open",
    resolution: null,
    reviewedBy: null,
    reviewedAt: null,
    msgSeq: 1,
    messages: [{ id: 1, ts: now, from: "user", text: message || "" }],
    locked: false,
    lockedBy: null,
    lockedAt: null,
    ban: ban || null,
    banKey: key,
  };
  appeals.push(a);
  if (appeals.length > MAX) appeals = appeals.slice(-MAX);
  prune(Date.now());
  saveSoon();
  return { ok: true, id: a.id };
}

function get(id) {
  return appeals.find((a) => a.id === id) || null;
}

// ── The conversation ────────────────────────────────────────────────────────

function forUser(ip, deviceId, banKey) {
  const mine = appeals.filter(
    (a) => (ip && a.ip === ip) || (deviceId && a.deviceId === deviceId),
  );
  if (!mine.length) return null;
  const scoped = banKey
    ? mine.filter((a) => (a.banKey || banKeyOf(a.ban)) === banKey)
    : mine;
  if (!scoped.length) return null;
  return (
    scoped.filter((a) => a.status === "open").sort((x, y) => y.at - x.at)[0] ||
    scoped.sort((x, y) => y.at - x.at)[0]
  );
}

function reopen(id, byLabel, note) {
  const a = get(id);
  if (!a) return { ok: false, code: "no_appeal" };
  if (a.status !== "resolved") return { ok: false, code: "not_closed" };
  if (a.resolution === "lifted") return { ok: false, code: "already_lifted" };
  a.status = "open";
  a.resolution = null;
  a.reviewedBy = null;
  a.reviewedAt = null;
  a.locked = false;
  a.lockedBy = null;
  a.lockedAt = null;
  a.reopenedBy = byLabel || null;
  a.reopenedAt = Date.now();
  systemNote(
    a,
    "This appeal was reopened. Somebody is looking at it again." +
      (note ? " " + note : ""),
  );
  saveSoon();
  return { ok: true, appeal: a };
}

function pushMessage(a, msg) {
  a.msgSeq = (a.msgSeq || a.messages.length || 0) + 1;
  const m = { id: a.msgSeq, ts: Date.now(), ...msg };
  a.messages.push(m);
  if (a.messages.length > THREAD_CAP)
    a.messages = [a.messages[0]].concat(
      a.messages.slice(a.messages.length - (THREAD_CAP - 1)),
    );
  saveSoon();
  return m;
}

function replySnapshot(a, replyToId) {
  const src = (a.messages || []).find((m) => m.id === Number(replyToId));
  if (!src) return null;
  return {
    id: src.id,
    from: src.from,
    by: src.by || null,
    text: String(src.text || "").slice(0, 120),
  };
}

function awaitingFirstReply(a) {
  const msgs = (a && a.messages) || [];
  if (!msgs.some((m) => m.from === "user")) return false;
  return !msgs.some((m) => m.from === "staff");
}

function userReply(a, text, replyToId) {
  if (!a) return { ok: false, code: "no_appeal" };
  if (a.status !== "open") return { ok: false, code: "closed" };
  if (a.locked) return { ok: false, code: "locked" };
  const body = String(text || "").trim().slice(0, MSG_MAX);
  if (body.length < 2) return { ok: false, code: "too_short" };
  const mine = a.messages.filter((m) => m.from === "user");
  if (mine.length >= USER_MSG_CAP) return { ok: false, code: "too_many" };
  if (awaitingFirstReply(a)) return { ok: false, code: "wait_reply" };
  const last = mine[mine.length - 1];
  if (last && Date.now() - last.ts < USER_COOLDOWN_MS)
    return { ok: false, code: "slow_down" };
  const m = pushMessage(a, {
    from: "user",
    text: body,
    ...(replySnapshot(a, replyToId)
      ? { reply: replySnapshot(a, replyToId) }
      : {}),
  });
  return { ok: true, message: m };
}

function staffReply(a, text, who, replyToId) {
  if (!a) return { ok: false, code: "no_appeal" };
  const body = String(text || "").trim().slice(0, MSG_MAX);
  if (!body) return { ok: false, code: "too_short" };
  const w = typeof who === "string" ? { label: who } : who || {};
  const m = pushMessage(a, {
    from: "staff",
    by: w.label || "staff",
    role: w.role === "dev" ? "dev" : "mod",
    level: w.role === "dev" ? 0 : w.level === 1 ? 1 : 2,
    ...(w.avatar && (w.avatar.id || w.avatar.discordId) && w.avatar.hash
      ? {
          avatar: {
            id: String(w.avatar.id || w.avatar.discordId),
            hash: String(w.avatar.hash),
            animated: !!w.avatar.animated,
          },
        }
      : {}),
    text: body,
    ...(replySnapshot(a, replyToId)
      ? { reply: replySnapshot(a, replyToId) }
      : {}),
  });
  return { ok: true, message: m };
}

function systemNote(a, text) {
  if (!a) return null;
  return pushMessage(a, { from: "system", text: String(text).slice(0, 200) });
}

function setLocked(id, locked, byLabel) {
  const a = get(id);
  if (!a) return null;
  a.locked = !!locked;
  a.lockedBy = locked ? byLabel || null : null;
  a.lockedAt = locked ? Date.now() : null;
  systemNote(
    a,
    locked
      ? "This chat was ended by staff. Your appeal is still being reviewed."
      : "Staff reopened this chat.",
  );
  saveSoon();
  return a;
}

function resolve(id, resolution, reviewedBy, note) {
  const a = get(id);
  if (!a) return null;
  a.status = "resolved";
  a.resolution = resolution || "dismissed";
  a.reviewedBy = reviewedBy || null;
  a.reviewedAt = Date.now();
  systemNote(
    a,
    a.resolution === "lifted"
      ? "Your ban has been lifted." + (note ? " " + note : "")
      : "This appeal was declined and the ban stays in place." +
          (note ? " " + note : ""),
  );
  saveSoon();
  return a;
}

function resolveOpenForIp(ip, resolution, reviewedBy) {
  let n = 0;
  const now = Date.now();
  for (const a of appeals)
    if (a.ip === ip && a.status === "open") {
      a.status = "resolved";
      a.resolution = resolution || "lifted";
      a.reviewedBy = reviewedBy || null;
      a.reviewedAt = now;
      systemNote(
        a,
        a.resolution === "lifted"
          ? "Your ban has been lifted."
          : "This appeal was closed.",
      );
      n++;
    }
  if (n) saveSoon();
  return n;
}

function resolveOpenForDevice(deviceId, resolution, reviewedBy) {
  let n = 0;
  const now = Date.now();
  const low = String(deviceId || "").toLowerCase();
  if (!low) return 0;
  for (const a of appeals)
    if (a.deviceId === low && a.status === "open") {
      a.status = "resolved";
      a.resolution = resolution || "lifted";
      a.reviewedBy = reviewedBy || null;
      a.reviewedAt = now;
      systemNote(
        a,
        a.resolution === "lifted"
          ? "Your ban has been lifted."
          : "This appeal was closed.",
      );
      n++;
    }
  if (n) saveSoon();
  return n;
}

function remove(id) {
  const i = appeals.findIndex((a) => a.id === Number(id));
  if (i === -1) return { ok: false, code: "no_appeal" };
  const [a] = appeals.splice(i, 1);
  saveSoon();
  return { ok: true, appeal: a };
}

function openCount() {
  return appeals.reduce((n, a) => n + (a.status === "open" ? 1 : 0), 0);
}

function list() {
  return appeals.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

load();
loadBars();

module.exports = {
  submit,
  get,
  banKeyOf,
  forUser,
  reopen,
  userReply,
  staffReply,
  systemNote,
  setLocked,
  resolve,
  resolveOpenForIp,
  resolveOpenForDevice,
  remove,
  openForIp,
  openCount,
  list,
  flushSync,
  MSG_MAX,
  USER_MSG_CAP,
  awaitingFirstReply,
  isBarred,
  barFor,
  addBar,
  removeBar,
  listBars,
};
