const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { state } = require("./state");
const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "room-moves.jsonl");
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 2 * 60 * 1000;

let moves = [];
let seq = 0;
const pending = new Map();
const online = new Map();

const uidOf = (s) => (s && s.handshake && s.handshake.session && s.handshake.session.userId) || null;

function tagOf(room) {
  return "room:" + (room.name || room.id) + "(" + room.id + ")";
}

let writeChain = Promise.resolve();
function enqueue(fn) {
  writeChain = writeChain.then(fn).catch((e) => console.error("movement io failed:", e));
}

function redact(e) {
  const copy = Object.assign({}, e);
  delete copy.ip;
  return copy;
}

function visibleTo(s, e) {
  if (s.isMainDev) return true;
  if (e.ops) return false;
  if (e.devOnly) return !!s.isDev;
  return !!(s.isDev || s.isMod);
}

function broadcast(e) {
  if (!state.io) return;
  let shown = null;
  for (const [, s] of state.io.sockets.sockets) {
    if (!s.auditSub || !visibleTo(s, e)) continue;
    if (s.isMainDev) s.emit("audit move", e);
    else s.emit("audit move", shown || (shown = redact(e)));
  }
}

function write(e) {
  e.id = "m" + ++seq;
  moves.push(e);
  enqueue(() => fsp.appendFile(STORE_PATH, JSON.stringify(e) + "\n"));
  broadcast(e);
}

function entryFor(socket, room, user, event, extra) {
  const e = {
    ts: Date.now(),
    type: "move",
    event,
    userId: (user && user.id) || uidOf(socket),
    username: (user && user.username) || socket?.handshake?.session?.username || null,
    location: (user && user.location) || socket?.handshake?.session?.location || null,
    room: tagOf(room),
    roomType: room.type || null,
    staff: socket && socket.isDev ? "dev" : socket && socket.isMod ? "mod" : null,
    ip: (socket && socket.clientIp) || null,
    ...extra,
  };
  if (socket && socket.isMainDev) e.ops = true;
  else if (socket && socket.isVanished) e.devOnly = true;
  return e;
}

function flushPending(uid) {
  const p = pending.get(uid);
  if (!p) return null;
  clearTimeout(p.timer);
  pending.delete(uid);
  return p;
}

function joined(socket, room, user, spectating) {
  const uid = (user && user.id) || uidOf(socket);
  if (!uid || !room) return;
  const p = flushPending(uid);
  const rec = online.get(uid);
  if (rec) rec.rooms.add(room.id);
  if (p && p.roomId === room.id && !spectating) return;
  if (p) write(p.entry);
  write(entryFor(socket, room, user, "join", { spectating: !!spectating }));
}

function left(socket, room, user, why, opts) {
  const uid = (user && user.id) || uidOf(socket);
  if (!uid || !room) return;
  const prev = flushPending(uid);
  if (prev) write(prev.entry);
  const e = entryFor(socket, room, user, "leave", {
    why: why || "left",
    spectating: !!(opts && opts.spectating),
  });
  const wait = opts && opts.wait;
  if (!wait) return write(e);
  const timer = setTimeout(() => {
    if (pending.get(uid)?.entry !== e) return;
    pending.delete(uid);
    write(e);
  }, wait);
  if (timer.unref) timer.unref();
  pending.set(uid, { roomId: room.id, entry: e, timer });
}

function cameOnline(socket) {
  const uid = uidOf(socket);
  const sess = socket.handshake.session;
  if (!uid || !sess.username) return;
  let rec = online.get(uid);
  if (!rec) {
    rec = { since: Date.now(), rooms: new Set(), sockets: new Set(), timer: null };
    online.set(uid, rec);
  }
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  rec.sockets.add(socket.id);
  rec.username = sess.username;
  rec.location = sess.location || null;
  rec.ip = socket.clientIp || null;
  rec.ops = rec.ops || !!socket.isMainDev;
}

function wentOffline(socket, onSignoff) {
  const uid = uidOf(socket);
  const rec = uid && online.get(uid);
  if (!rec || !rec.sockets.delete(socket.id) || rec.sockets.size) return;
  const until = Date.now();
  rec.timer = setTimeout(() => {
    if (online.get(uid) !== rec || rec.sockets.size) return;
    online.delete(uid);
    onSignoff({
      userId: uid,
      username: rec.username,
      location: rec.location,
      ip: rec.ip,
      since: rec.since,
      until,
      rooms: rec.rooms.size,
      opsOnly: rec.ops,
    });
  }, OFFLINE_GRACE_MS);
  if (rec.timer.unref) rec.timer.unref();
}

function recent(socket, since) {
  const from = Math.max(since || 0, Date.now() - KEEP_MS);
  const out = [];
  for (const e of moves) {
    if (e.ts < from || !visibleTo(socket, e)) continue;
    out.push(socket.isMainDev ? e : redact(e));
  }
  return out;
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  if (!moves.length || moves[0].ts >= cutoff) return;
  moves = moves.filter((e) => e.ts >= cutoff);
  const snapshot = moves.slice();
  enqueue(async () => {
    const tmp = STORE_PATH + ".tmp";
    await fsp.writeFile(tmp, snapshot.map((e) => JSON.stringify(e)).join("\n") + (snapshot.length ? "\n" : ""));
    await fsp.rename(tmp, STORE_PATH);
  });
}

function load() {
  try {
    moves = fs
      .readFileSync(STORE_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    seq = moves.reduce((m, e) => Math.max(m, Number(String(e.id || "").slice(1)) || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("movement load failed:", err);
    moves = [];
  }
  prune();
}

load();
setInterval(prune, 60 * 60 * 1000).unref();

module.exports = { joined, left, cameOnline, wentOffline, recent, KEEP_MS };
