// server/suggestions.js
// Community suggestion board. Anyone in the lobby can post, reply, and vote;
// devs set a status tag (approved / declined / implemented) everyone can see.
// Same flat-array JSON store as appeals; load() migrates the old mod-dashboard
// records (status "resolved" + resolution) forward so nothing is lost.
//
// Abuse posture, all server-side:
//   - posts capped per rolling 24h by BOTH device id and IP hash (fresh
//     incognito tabs share the IP, clearing storage does not reset the cap)
//   - one vote per device per suggestion, and at most VOTES_PER_IP distinct
//     devices from the same IP may hold a vote on one suggestion, so opening
//     new private tabs cannot stack upvotes
//   - roles (dev/mod/jr) are stamped from the socket at write time, never
//     taken from the client, so badges cannot be impersonated

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "suggestions.json");
const MAX = 2000;
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const POSTS_PER_DAY = 3;
const REPLIES_PER_DAY = 15;
const MAX_REPLIES = 40; // per suggestion
const VOTES_PER_IP = 2; // distinct devices per IP holding a vote on one post

let suggestions = []; // oldest first
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

// Old records: { status: "open"|"resolved", resolution, reviewedBy, reviewedAt }
// New records: { kind, status: "open"|"approved"|"declined"|"implemented",
//                statusBy, statusAt, voters, replies, role, ipKey, editedAt }
//
// Everything already on the board predates the idea/bug split, so it becomes an
// idea: that is what people were posting when the box only asked for one thing,
// and silently refiling 300 posts as bugs would be worse than leaving them.
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

// Rolling-24h post count for a device or IP. Counts replies separately.
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

// dir: 1 (up), -1 (down), 0 (clear). One vote per device; the per-IP cap only
// applies when ADDING a vote from a device that does not already hold one.
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

function setStatus(id, status, byLabel) {
  if (!STATUSES.includes(status)) return null;
  const s = get(id);
  if (!s) return null;
  s.status = status;
  s.statusBy = byLabel || null;
  s.statusAt = Date.now();
  saveSoon();
  return s;
}

// Who may change or remove a given post. Ownership is by device id, which is
// the same thing the vote and rate limits key on - never a client-sent id, so
// "mine" cannot be claimed by asking. Staff may always remove; only the author
// may edit, because an edit puts words in somebody's mouth under their name.
function ownsPost(s, deviceId) {
  return !!(s && deviceId && s.deviceId === deviceId);
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

// `byStaff` skips the ownership check: a mod clearing something abusive is the
// whole reason the board can be left open to everybody.
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

// Projection sent to browsers. deviceId / ipKey never leave the server;
// userId is included for devs only (user tracing, same as the old dashboard).
// The whole board goes to the client in one payload and is filtered, searched
// and sorted there. At a couple of thousand posts that is a few hundred KB
// once, against a round trip for every keystroke in the search box - and the
// board is opened far less often than it is scrolled.
function publicList({ deviceId, isDev, limit = MAX } = {}) {
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
        text: s.text,
        at: s.at,
        editedAt: s.editedAt || null,
        status: s.status,
        statusBy: s.statusBy,
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
          text: r.text,
          at: r.at,
          editedAt: r.editedAt || null,
          // Replies carry it too, so the author gets edit and delete on their
          // own without the client guessing from a name.
          mine: !!deviceId && r.deviceId === deviceId,
          userId: isDev ? r.userId : undefined,
        })),
      };
    });
  return out;
}

// ── Legacy API kept for the old mod-dashboard events ────────────────────────

function submit({ deviceId, userId, name, text }) {
  return post({ deviceId, ip: null, userId, name, role: "user", text });
}

function resolve(id, resolution, reviewedBy) {
  return setStatus(id, resolution === "approved" ? "approved" : "declined", reviewedBy);
}

function openCount() {
  return suggestions.reduce((n, s) => n + (s.status === "open" ? 1 : 0), 0);
}

function list() {
  return suggestions.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

load();

module.exports = {
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
  submit,
  resolve,
  openCount,
  list,
  flushSync,
};
