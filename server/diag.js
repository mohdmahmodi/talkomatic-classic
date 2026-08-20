const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const { DATA_DIR } = require("./datadir");
const {
  CONFIG,
  state,
  sanitizeName,
  enforceUsernameLimit,
  enforceLocationLimit,
  enforceRoomNameLimit,
} = require("./state");

const STORE_PATH = path.join(DATA_DIR, "service.json");

let fx = null;
let holdUntil = 0;
let holdScope = null;
let timer = null;
let open = true;
let carried = [];

try {
  const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  if (raw && typeof raw.open === "boolean") open = raw.open;
  if (raw && Array.isArray(raw.held)) carried = raw.held;
} catch (_) {}

let persistTimer = null;

async function persist() {
  try {
    const tmp = STORE_PATH + ".tmp";
    const body = JSON.stringify({ open, held: snapshot() }, null, 2);
    await fsp.writeFile(tmp, body, "utf8");
    await fsp.rename(tmp, STORE_PATH);
  } catch (_) {}
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, 1500);
  persistTimer.unref && persistTimer.unref();
}

function io() {
  return state.io;
}
function ms() {
  return Date.now();
}
function num(v, lo, hi, d) {
  v = Number(v);
  if (!isFinite(v)) v = d;
  return Math.max(lo, Math.min(hi, v));
}

function hit(s, scope) {
  if (scope && scope.self) return !!s.isMainDev;
  if (s.isMainDev) return false;
  if (scope && scope.room) return s.roomId === scope.room;
  return true;
}

function eachSocket(fn) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) fn(s);
}

function wrap(s) {
  if (s._diagEmit) return;
  const orig = s.emit.bind(s);
  s._diagEmit = orig;
  s.emit = function (...a) {
    if (!fx || !hit(s, fx.scope)) return orig(...a);
    if (fx.drop && Math.random() < fx.drop) return true;
    const d = fx.lat + (fx.jit ? Math.floor(Math.random() * fx.jit) : 0);
    if (d > 0) {
      setTimeout(() => {
        try {
          orig(...a);
        } catch (_) {}
      }, d);
      return true;
    }
    return orig(...a);
  };
}

function unwrap(s) {
  if (s._diagEmit) {
    s.emit = s._diagEmit;
    s._diagEmit = null;
  }
}

function arm(until) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(clear, Math.max(0, until - ms()));
  timer.unref && timer.unref();
}

function lag(o) {
  o = o || {};
  const ttl = num(o.ttl, 5, 900, 60) * 1000;
  fx = {
    lat: num(o.ms, 0, 15000, 800),
    jit: num(o.jitter, 0, 8000, 0),
    drop: num(o.drop, 0, 0.9, 0),
    scope: o.scope || { all: true },
    until: ms() + ttl,
  };
  eachSocket(wrap);
  arm(fx.until);
  return status();
}

function drop(o) {
  o = o || {};
  const scope = o.scope || { all: true };
  const list = [];
  eachSocket((s) => {
    if (hit(s, scope)) list.push(s);
  });
  let n = 0;
  for (const s of list) {
    try {
      s.disconnect(true);
      n++;
    } catch (_) {}
  }
  if (o.hold) {
    holdScope = scope;
    holdUntil = ms() + num(o.hold, 1, 180, 10) * 1000;
  }
  return { dropped: n, holdMs: o.hold ? holdUntil - ms() : 0 };
}

function clear() {
  fx = null;
  holdUntil = 0;
  holdScope = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  eachSocket(unwrap);
  return status();
}

function onConnect(s) {
  if (holdUntil > ms() && hit(s, holdScope)) {
    try {
      s.disconnect(true);
    } catch (_) {}
    return true;
  }
  if (fx) wrap(s);
  return false;
}

function inboundDelay(s) {
  if (!fx || !hit(s, fx.scope)) return 0;
  return fx.lat + (fx.jit ? Math.floor(Math.random() * fx.jit) : 0);
}

function blocked(s) {
  return !open && !(s && s.isMainDev);
}

function locked() {
  return !open;
}

function setGate(on) {
  open = !!on;
  persist();
  if (!open) {
    const list = [];
    eachSocket((s) => {
      if (!s.isMainDev) list.push(s);
    });
    for (const s of list) {
      try {
        s.disconnect(true);
      } catch (_) {}
    }
  }
  return status();
}

function status() {
  return {
    open,
    active: !!fx,
    lag: fx
      ? {
          ms: fx.lat,
          jitter: fx.jit,
          drop: fx.drop,
          scope: fx.scope,
          expiresMs: Math.max(0, fx.until - ms()),
        }
      : null,
    hold: holdUntil > ms() ? { scope: holdScope, ms: holdUntil - ms() } : null,
    online: io() ? io().sockets.sockets.size : 0,
    held: held.size,
  };
}

// ── Held sessions ───────────────────────────────────────────────────────────

let deps = null;
const held = new Map();

const ROOM_TYPES = ["public", "semi-private", "private"];

const DEVICE_MIX = [
  "mobile",
  "mobile",
  "mobile",
  "mobile",
  "desktop",
  "desktop",
  "desktop",
  "tablet",
];

function pickDevice() {
  return DEVICE_MIX[Math.floor(Math.random() * DEVICE_MIX.length)];
}

function newId() {
  return crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function str(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function snapshot() {
  const out = [];
  for (const [, rec] of held) {
    out.push({
      id: rec.id,
      username: rec.username,
      location: rec.location,
      deviceType: rec.deviceType,
      text: rec.text,
      roomId: rec.roomId,
      roomName: rec.roomName,
      roomType: rec.roomType,
      accessCode: rec.accessCode,
      maxSize: rec.maxSize,
      at: rec.at,
    });
  }
  return out;
}

function view(rec) {
  const room = rec.roomId ? state.rooms.get(rec.roomId) : null;
  return {
    id: rec.id,
    username: rec.username,
    location: rec.location,
    deviceType: rec.deviceType,
    text: rec.text || "",
    roomId: room ? rec.roomId : null,
    roomName: room ? room.name : null,
    roomType: room ? room.type : null,
    accessCode: room ? room.accessCode || null : null,
    roomUsers: room ? (room.users || []).length : 0,
    roomCap: room && deps ? deps.roomCapacity(room) : null,
    at: rec.at,
  };
}

function list() {
  reconcile();
  return { held: [...held.values()].map(view), rooms: roomList() };
}

function roomList() {
  const out = [];
  for (const [id, room] of state.rooms) {
    out.push({
      id,
      name: room.name,
      type: room.type,
      users: (room.users || []).length,
      cap: deps ? deps.roomCapacity(room) : null,
      held: (room.users || []).filter((u) => held.has(u.id)).length,
    });
  }
  out.sort((a, b) => b.users - a.users);
  return out;
}

function socketFor(rec) {
  return {
    id: "held:" + rec.id,
    roomId: rec.roomId,
    connected: true,
    isHeldSession: true,
    handshake: {
      session: {
        userId: rec.id,
        username: rec.username,
        location: rec.location,
      },
    },
    emit() {},
    join() {},
    leave() {},
  };
}

function entryOf(rec) {
  return {
    id: rec.id,
    username: rec.username,
    location: rec.location,
    deviceType: rec.deviceType || "unknown",
    deviceId: null,
    avatar: null,
  };
}

function isHeld(userId) {
  return held.has(userId);
}

function reconcile() {
  for (const [, rec] of held) {
    if (!rec.roomId) continue;
    const room = state.rooms.get(rec.roomId);
    if (!room || !(room.users || []).some((u) => u.id === rec.id)) {
      rec.roomId = null;
      state.userMessageBuffers.delete(rec.id);
      persistSoon();
    }
  }
}

function noteEvicted(userId) {
  const rec = held.get(userId);
  if (!rec) return;
  rec.roomId = null;
  state.userMessageBuffers.delete(userId);
  persistSoon();
}

function pushText(rec) {
  if (!rec.roomId || !deps) return;
  state.userMessageBuffers.set(rec.id, rec.text || "");
  state.roomLastChatActivity.set(rec.roomId, Date.now());
  deps.emitChat(socketFor(rec), {
    userId: rec.id,
    username: rec.username,
    diff: { type: "full-replace", text: rec.text || "" },
  });
}

function place(rec, room) {
  room.users = (room.users || []).filter((u) => u.id !== rec.id);
  const entry = entryOf(rec);
  room.users.push(entry);
  room.lastActiveTime = Date.now();
  rec.roomId = room.id;
  rec.roomName = room.name;
  rec.roomType = room.type;
  rec.accessCode = room.accessCode || null;
  rec.maxSize = room.maxSize || null;
  state.userMessageBuffers.set(rec.id, rec.text || "");
  deps.userJoined(room, entry);
  deps.updateRoom(room.id);
  deps.updateRoomSoloTracking(room.id);
  deps.updateLobby();
  if (rec.text) pushText(rec);
  persistSoon();
}

function lift(rec) {
  const room = rec.roomId ? state.rooms.get(rec.roomId) : null;
  if (room) {
    const entry = (room.users || []).find((u) => u.id === rec.id) || null;
    room.users = (room.users || []).filter((u) => u.id !== rec.id);
    if (room.votes) {
      delete room.votes[rec.id];
      for (const vid in room.votes)
        if (room.votes[vid] === rec.id) delete room.votes[vid];
    }
    if (entry) deps.userLeft(room.id, rec.id, entry);
    deps.updateRoom(room.id);
    deps.updateRoomSoloTracking(room.id);
    deps.updateLobby();
    if (room.users.length === 0) deps.startRoomDeletionTimer(room.id);
  }
  state.userMessageBuffers.delete(rec.id);
  rec.roomId = null;
  persistSoon();
}

function add(o) {
  if (!deps) return { error: "Not ready." };
  o = o || {};
  const username = enforceUsernameLimit(sanitizeName(str(o.username, 40)));
  if (!username) return { error: "Name is empty." };
  const location =
    enforceLocationLimit(sanitizeName(str(o.location, 40))) || "On The Web";
  if (held.size >= 100) return { error: "Too many held sessions." };
  const rec = {
    id: newId(),
    username,
    location,
    deviceType: str(o.deviceType, 20) || pickDevice(),
    text: str(o.text, 5000),
    roomId: null,
    roomName: null,
    roomType: null,
    accessCode: null,
    maxSize: null,
    at: ms(),
  };
  held.set(rec.id, rec);
  persistSoon();
  return { ok: true, id: rec.id, held: view(rec) };
}

function edit(id, o) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  o = o || {};
  if (typeof o.username === "string") {
    const name = enforceUsernameLimit(sanitizeName(str(o.username, 40)));
    if (!name) return { error: "Name is empty." };
    rec.username = name;
  }
  if (typeof o.location === "string") {
    rec.location =
      enforceLocationLimit(sanitizeName(str(o.location, 40))) || "On The Web";
  }
  if (typeof o.deviceType === "string")
    rec.deviceType = str(o.deviceType, 20) || pickDevice();
  const room = rec.roomId ? state.rooms.get(rec.roomId) : null;
  if (room) {
    const entry = (room.users || []).find((u) => u.id === rec.id);
    if (entry) {
      entry.username = rec.username;
      entry.location = rec.location;
      entry.deviceType = rec.deviceType;
      deps.updateRoom(room.id);
      deps.updateLobby();
    }
  }
  persistSoon();
  return { ok: true, held: view(rec) };
}

function say(id, text) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  rec.text = str(text, 5000);
  pushText(rec);
  persistSoon();
  return { ok: true, held: view(rec) };
}

function openRoom(id, o) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  if (rec.roomId && state.rooms.get(rec.roomId))
    return { error: "Already in a room." };
  o = o || {};

  const name = enforceRoomNameLimit(sanitizeName(str(o.name, 60)));
  if (!name) return { error: "Room name is empty." };
  if (deps.roomNameExists(name)) return { error: "Room name already exists." };

  const type = ROOM_TYPES.includes(o.type) ? o.type : "public";
  let accessCode = null;
  if (type === "semi-private") {
    accessCode = str(o.accessCode, 6);
    if (!/^\d{6}$/.test(accessCode))
      return { error: "Semi-private rooms need a 6 digit code." };
  }

  if (state.rooms.size >= CONFIG.LIMITS.HARD_MAX_ROOMS)
    return { error: "Server is at its room cap." };

  let roomId = null;
  if (/^\d{6}$/.test(str(o.roomId, 6)) && !state.rooms.has(o.roomId))
    roomId = o.roomId;
  for (let i = 0; !roomId && i < 50; i++) {
    const candidate = deps.generateRoomId();
    if (!state.rooms.has(candidate)) roomId = candidate;
  }
  if (!roomId) return { error: "Could not allocate a room id." };

  const now = ms();
  const room = {
    id: roomId,
    name,
    type,
    layout: "vertical",
    maxSize: deps.newRoomCapacity(o.maxSize, null),
    allowBots: o.allowBots !== false,
    users: [],
    accessCode,
    votes: {},
    bannedUserIds: new Set(),
    lastActiveTime: now,
    createdAt: now,
  };
  state.rooms.set(roomId, room);
  state.apiCache.delete("public_rooms");
  place(rec, room);
  return { ok: true, roomId, held: view(rec) };
}

function joinRoom(id, o) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  o = o || {};
  const room = state.rooms.get(str(o.roomId, 6));
  if (!room) return { error: "Room not found." };
  if (rec.roomId === room.id) return { ok: true, held: view(rec) };
  if (rec.roomId && state.rooms.get(rec.roomId))
    return { error: "Already in a room." };
  if (room.bannedUserIds && room.bannedUserIds.has(rec.id))
    return { error: "Banned from that room." };
  if ((room.users || []).length >= deps.roomCapacity(room))
    return { error: "Room is full." };
  place(rec, room);
  return { ok: true, roomId: room.id, held: view(rec) };
}

function leaveRoom(id) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  lift(rec);
  return { ok: true, held: view(rec) };
}

function remove(id) {
  const rec = held.get(id);
  if (!rec) return { error: "No such session." };
  lift(rec);
  held.delete(id);
  persistSoon();
  return { ok: true, id };
}

function removeAll() {
  const ids = [...held.keys()];
  for (const id of ids) remove(id);
  return { ok: true, removed: ids.length };
}

function restore() {
  if (!deps || !carried.length) return;
  const wanted = carried;
  carried = [];
  for (const raw of wanted) {
    if (!raw || typeof raw.id !== "string") continue;
    const rec = {
      id: raw.id,
      username: str(raw.username, 40) || "Someone",
      location: str(raw.location, 40) || "On The Web",
      deviceType: str(raw.deviceType, 20) || pickDevice(),
      text: str(raw.text, 5000),
      roomId: null,
      roomName: str(raw.roomName, 60) || null,
      roomType: ROOM_TYPES.includes(raw.roomType) ? raw.roomType : null,
      accessCode: str(raw.accessCode, 6) || null,
      maxSize: Number(raw.maxSize) || null,
      at: Number(raw.at) || ms(),
    };
    held.set(rec.id, rec);
    if (!raw.roomId) continue;

    let room = state.rooms.get(raw.roomId);
    if (!room && rec.roomName && rec.roomType) {
      if (deps.roomNameExists(rec.roomName)) continue;
      const now = ms();
      room = {
        id: raw.roomId,
        name: rec.roomName,
        type: rec.roomType,
        layout: "vertical",
        maxSize: deps.newRoomCapacity(rec.maxSize, null),
        allowBots: true,
        users: [],
        accessCode: rec.roomType === "semi-private" ? rec.accessCode : null,
        votes: {},
        bannedUserIds: new Set(),
        lastActiveTime: now,
        createdAt: now,
      };
      state.rooms.set(room.id, room);
    }
    if (!room) continue;
    if ((room.users || []).length >= deps.roomCapacity(room)) continue;
    place(rec, room);
  }
  state.apiCache.delete("public_rooms");
  deps.updateLobby();
  persist();
  if (held.size) console.log(`[diag] restored ${held.size} held session(s)`);
}

function init(injected) {
  deps = injected;
  restore();
  const t = setInterval(reconcile, 20000);
  t.unref && t.unref();
}

module.exports = {
  init,
  lag,
  drop,
  clear,
  onConnect,
  inboundDelay,
  blocked,
  locked,
  setGate,
  status,
  isHeld,
  noteEvicted,
  list,
  add,
  edit,
  say,
  openRoom,
  joinRoom,
  leaveRoom,
  remove,
  removeAll,
};
