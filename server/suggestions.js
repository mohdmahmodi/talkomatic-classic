// server/suggestions.js
// Community suggestion board.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");
const roles = require("./roles");
const linkfilter = require("./linkfilter");

const STORE_PATH = path.join(DATA_DIR, "suggestions.json");
const MAX = 2000;
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const POSTS_PER_DAY = 3;
const REPLIES_PER_DAY = 15;
const MAX_REPLIES = 40;
const VOTES_PER_IP = 2;

let suggestions = [];
let seq = 0;
let saveTimer = null;

function ipKeyFor(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    suggestions = Array.isArray(arr) ? arr : [];
    for (const s of suggestions) migrate(s);
    seq = suggestions.reduce((m, s) => Math.max(m, s.id || 0), 0);
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading suggestions.json:", err);
    suggestions = [];
  }
}

const STATUSES = ["open", "approved", "declined", "implemented"];
const KINDS = ["idea", "bug"];

function migrate(s) {
  if (s.status === "resolved") {
    s.status = s.resolution === "approved" ? "approved" : "declined";
    s.statusBy = s.statusBy || s.reviewedBy || null;
    s.statusAt = s.statusAt || s.reviewedAt || null;
  }
  if (!STATUSES.includes(s.status)) s.status = "open";
  if (!KINDS.includes(s.kind)) s.kind = "idea";
  if (!s.voters || typeof s.voters !== "object") s.voters = {};
  if (!Array.isArray(s.replies)) s.replies = [];
  if (!s.role) s.role = "user";
  if (s.statusBy === undefined) s.statusBy = null;
  if (s.statusAt === undefined) s.statusAt = null;
  if (s.ipKey === undefined) s.ipKey = null;
  if (s.editedAt === undefined) s.editedAt = null;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(suggestions, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("suggestions save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(suggestions, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("suggestions flush failed:", e);
  }
}

function prune(now) {
  suggestions = suggestions.filter((s) => now - (s.at || 0) <= WINDOW_MS);
  if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
}

function countRecent(kind, deviceId, ipKey) {
  const cutoff = Date.now() - DAY_MS;
  let n = 0;
  for (const s of suggestions) {
    if (kind === "post") {
      if (
        s.at > cutoff &&
        ((deviceId && s.deviceId === deviceId) || (ipKey && s.ipKey === ipKey))
      )
        n++;
    } else {
      for (const r of s.replies)
        if (
          r.at > cutoff &&
          ((deviceId && r.deviceId === deviceId) || (ipKey && r.ipKey === ipKey))
        )
          n++;
    }
  }
  return n;
}

function remainingPosts(deviceId, ip) {
  return Math.max(0, POSTS_PER_DAY - countRecent("post", deviceId, ipKeyFor(ip)));
}

function post({ deviceId, ip, userId, name, role, text, avatar, kind, title }) {
  if (!text) return { ok: false, code: "empty" };
  const ipKey = ipKeyFor(ip);
  if (countRecent("post", deviceId, ipKey) >= POSTS_PER_DAY)
    return { ok: false, code: "limit" };
  const s = {
    id: ++seq,
    deviceId: deviceId || null,
    ipKey,
    userId: userId || null,
    name: name || null,
    role: role || "user",
    avatar: avatar || null,
    kind: KINDS.includes(kind) ? kind : "idea",
    title: title || null,
    text,
    at: Date.now(),
    editedAt: null,
    status: "open",
    statusBy: null,
    statusAt: null,
    voters: {},
    replies: [],
  };
  suggestions.push(s);
  prune(Date.now());
  saveSoon();
  return { ok: true, id: s.id, remaining: remainingPosts(deviceId, ip) };
}

function reply({ id, deviceId, ip, userId, name, role, text, avatar }) {
  const s = get(id);
  if (!s) return { ok: false, code: "not_found" };
  if (!text) return { ok: false, code: "empty" };
  if (s.replies.length >= MAX_REPLIES) return { ok: false, code: "full" };
  const ipKey = ipKeyFor(ip);
  if (countRecent("reply", deviceId, ipKey) >= REPLIES_PER_DAY)
    return { ok: false, code: "limit" };
  s.replies.push({
    id: s.replies.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1,
    deviceId: deviceId || null,
    ipKey,
    userId: userId || null,
    name: name || null,
    role: role || "user",
    avatar: avatar || null,
    text,
    at: Date.now(),
  });
  saveSoon();
  return { ok: true };
}

function vote({ id, deviceId, ip, dir }) {
  const s = get(id);
  if (!s) return { ok: false, code: "not_found" };
  if (!deviceId) return { ok: false, code: "no_device" };
  const ipKey = ipKeyFor(ip);
  const existing = s.voters[deviceId];

  if (dir === 0) {
    delete s.voters[deviceId];
  } else if (dir === 1 || dir === -1) {
    if (!existing) {
      let sameIp = 0;
      for (const v of Object.values(s.voters)) if (ipKey && v.ip === ipKey) sameIp++;
      if (sameIp >= VOTES_PER_IP) return { ok: false, code: "ip_cap" };
    }
    s.voters[deviceId] = { v: dir, ip: ipKey, at: Date.now() };
  } else {
    return { ok: false, code: "bad_dir" };
  }
  saveSoon();
  const { up, down } = voteCounts(s);
  return { ok: true, up, down, myVote: s.voters[deviceId]?.v || 0 };
}

function voteCounts(s) {
  let up = 0,
    down = 0;
  for (const v of Object.values(s.voters)) v.v === 1 ? up++ : down++;
  return { up, down };
}

function setStatus(id, status, byLabel, byRole) {
  if (!STATUSES.includes(status)) return null;
  const s = get(id);
  if (!s) return null;
  s.status = status;
  s.statusBy = byLabel || null;
  if (byRole) s.statusRole = byRole === "dev" ? "dev" : "mod";
  s.statusAt = Date.now();
  saveSoon();
  return s;
}

function ownsPost(s, deviceId) {
  return !!(s && deviceId && s.deviceId === deviceId);
}

// The signed device cookie replaced the browser-held id in September 2026.
// Posts, replies and votes made under the old id follow the browser to its
// new one, so "My posts", edit and delete keep working.
function adoptDevice(from, to) {
  if (!from || !to || from === to) return;
  let changed = false;
  for (const s of suggestions) {
    if (s.deviceId === from) {
      s.deviceId = to;
      changed = true;
    }
    for (const r of s.replies || [])
      if (r.deviceId === from) {
        r.deviceId = to;
        changed = true;
      }
    if (s.voters && s.voters[from]) {
      s.voters[to] = s.voters[to] || s.voters[from];
      delete s.voters[from];
      changed = true;
    }
  }
  if (changed) saveSoon();
}

function editPost({ id, replyId, deviceId, text }) {
  const s = get(id);
  if (!s) return { ok: false, code: "not_found" };
  if (!text) return { ok: false, code: "empty" };
  if (replyId) {
    const r = s.replies.find((x) => x.id === replyId);
    if (!r) return { ok: false, code: "not_found" };
    if (!deviceId || r.deviceId !== deviceId) return { ok: false, code: "denied" };
    r.text = text;
    r.editedAt = Date.now();
  } else {
    if (!ownsPost(s, deviceId)) return { ok: false, code: "denied" };
    s.text = text;
    s.editedAt = Date.now();
  }
  saveSoon();
  return { ok: true };
}

function remove(id, replyId, deviceId, byStaff) {
  const s = get(id);
  if (!s) return false;
  if (replyId) {
    const r = s.replies.find((x) => x.id === replyId);
    if (!r) return false;
    if (!byStaff && (!deviceId || r.deviceId !== deviceId)) return false;
    s.replies = s.replies.filter((x) => x.id !== replyId);
  } else {
    if (!byStaff && !ownsPost(s, deviceId)) return false;
    suggestions = suggestions.filter((x) => x.id !== id);
  }
  saveSoon();
  return true;
}

function get(id) {
  return suggestions.find((s) => s.id === id) || null;
}

function publicList({ deviceId, isDev, isStaff, limit = MAX } = {}) {
  const out = suggestions
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit)
    .map((s) => {
      const { up, down } = voteCounts(s);
      return {
        id: s.id,
        name: s.name,
        role: s.role || "user",
        avatar: s.avatar || null,
        kind: s.kind || "idea",
        title: s.title || null,
        text: linkfilter.redact(s.text),
        at: s.at,
        editedAt: s.editedAt || null,
        status: s.status,
        statusBy: isStaff
          ? roles.systemLabel(s.statusBy, s.statusRole)
          : roles.publicStaffName(s.statusBy, s.statusRole),
        statusAt: s.statusAt,
        up,
        down,
        score: up - down,
        myVote: (deviceId && s.voters[deviceId]?.v) || 0,
        mine: !!deviceId && s.deviceId === deviceId,
        userId: isDev ? s.userId : undefined,
        replyCount: s.replies.length,
        replies: s.replies.slice(-30).map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role || "user",
          avatar: r.avatar || null,
          text: linkfilter.redact(r.text),
          at: r.at,
          editedAt: r.editedAt || null,
          mine: !!deviceId && r.deviceId === deviceId,
          userId: isDev ? r.userId : undefined,
        })),
      };
    });
  return out;
}

function unreadFor(deviceId, since) {
  const out = { approved: 0, declined: 0, replies: 0 };
  if (!deviceId) return out;
  const from = Number(since) || 0;
  for (const s of suggestions) {
    if (s.deviceId !== deviceId) continue;
    if ((s.statusAt || 0) > from) {
      if (s.status === "approved" || s.status === "implemented") out.approved++;
      else if (s.status === "declined") out.declined++;
    }
    for (const r of s.replies || [])
      if ((r.at || 0) > from && r.deviceId !== deviceId) out.replies++;
  }
  return out;
}

// ── Legacy API kept for the old mod-dashboard events ────────────────────────

function submit({ deviceId, userId, name, text }) {
  return post({ deviceId, ip: null, userId, name, role: "user", text });
}

function resolve(id, resolution, reviewedBy, reviewerRole) {
  return setStatus(
    id,
    resolution === "approved" ? "approved" : "declined",
    reviewedBy,
    reviewerRole,
  );
}

function openCount() {
  return suggestions.reduce((n, s) => n + (s.status === "open" ? 1 : 0), 0);
}

function list() {
  return suggestions.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

load();

module.exports = {
  adoptDevice,
  post,
  reply,
  vote,
  setStatus,
  editPost,
  ownsPost,
  remove,
  get,
  STATUSES,
  KINDS,
  remainingPosts,
  publicList,
  unreadFor,
  submit,
  resolve,
  openCount,
  list,
  flushSync,
};
