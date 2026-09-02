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
    if (simRooms.has(id)) continue;
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
  return held.has(userId) || sim.has(userId);
}

function reconcile() {
  for (const [, rec] of held) {
    if (!rec.roomId) continue;
    const room = state.rooms.get(rec.roomId);
    if (!room || !(room.users || []).some((u) => u.id === rec.id)) {
      state.deleteBuffer(rec.id, rec.roomId);
      rec.roomId = null;
      persistSoon();
    }
  }
}

function noteEvicted(userId) {
  if (sim.has(userId)) {
    state.deleteBuffer(userId, sim.get(userId).roomId);
    sim.get(userId).roomId = null;
    sim.delete(userId);
    return;
  }
  const rec = held.get(userId);
  if (!rec) return;
  state.deleteBuffer(userId, rec.roomId);
  rec.roomId = null;
  persistSoon();
}

function pushText(rec) {
  if (!rec.roomId || !deps) return;
  state.setBuffer(rec.id, rec.roomId, rec.text || "");
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
  state.setBuffer(rec.id, room.id, rec.text || "");
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
  state.deleteBuffer(rec.id, rec.roomId);
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

// ── Load simulation ─────────────────────────────────────────────────────────

const NAMES = (
  "Aaliyah Adam Adrian Aisha Alex Alina Amara Amir Ana Andre Anika Anton " +
  "Ariel Asha Aurora Bea Ben Bianca Bruno Caleb Cara Carlos Cassie Chen " +
  "Chloe Cian Clara Cole Dana Daniel Dara Dev Diana Dmitri Eden Eli Elif " +
  "Ella Emeka Emil Emma Enzo Esme Ethan Eva Ezra Farah Felix Finn Fiona " +
  "Gabe Gemma Grace Gus Hana Hannah Hassan Hugo Ibrahim Ida Imani Ines " +
  "Iris Isaac Ivan Jade Jamal Jasmine Javi Jonas Jude Julia Kai Kaito " +
  "Kara Kenji Khalid Kira Lars Layla Leo Lena Liam Lila Lior Luca Lucia " +
  "Mads Maia Marco Maria Mateo Maya Mei Micah Mila Mira Nadia Nate Nia " +
  "Niko Nora Omar Oscar Paloma Pedro Petra Priya Quinn Rafa Rania Reza " +
  "Rhea Rin Rosa Ruben Sana Sasha Sean Selin Sofia Soren Tara Theo Tomas " +
  "Uma Vera Viktor Wren Yara Yusuf Zaid Zara Zoe"
).split(/\s+/);

const PLACES = (
  "Dublin|Lisbon|Porto|Madrid|Seville|Lyon|Nice|Milan|Turin|Naples|" +
  "Athens|Krakow|Prague|Vienna|Zurich|Munich|Hamburg|Bremen|Utrecht|" +
  "Ghent|Bruges|Oslo|Bergen|Malmo|Turku|Tallinn|Riga|Vilnius|Sofia|" +
  "Zagreb|Ljubljana|Cluj|Iasi|Odesa|Tbilisi|Yerevan|Baku|Ankara|Izmir|" +
  "Beirut|Amman|Doha|Muscat|Karachi|Lahore|Pune|Kochi|Jaipur|Dhaka|" +
  "Colombo|Hanoi|Danang|Cebu|Surabaya|Penang|Busan|Sapporo|Osaka|" +
  "Kyoto|Taipei|Chengdu|Perth|Hobart|Wellington|Christchurch|Suva|" +
  "Vancouver|Calgary|Halifax|Quebec|Portland|Boise|Reno|Tucson|Omaha|" +
  "Tulsa|Wichita|Boulder|Fargo|Duluth|Buffalo|Providence|Richmond|" +
  "Savannah|Mobile|Waco|El Paso|Merida|Puebla|Bogota|Medellin|Quito|" +
  "Lima|Cusco|Rosario|Recife|Salvador|Curitiba|Montevideo|Accra|Lagos|" +
  "Nairobi|Kigali|Dakar|Rabat|Tunis|Alexandria|Windhoek|Gaborone"
).split("|");

const ROOM_WORDS_A = (
  "late night|quiet|slow|open|corner|back|third|small|early|midnight|" +
  "sunday|weekday|after hours|rainy day|first|second|spare|old|new|" +
  "friendly|sleepy|casual|honest|random|long|short|warm|cold|bright"
).split("|");

const ROOM_WORDS_B = (
  "chat|room|table|lounge|corner|bench|porch|window|hangout|circle|" +
  "club|spot|booth|meetup|talk|space|shelter|landing|hall|nook"
).split("|");

// Each entry is one conversation, taken a line at a time by whoever speaks
// next in the room, so a room reads like people actually talking.
const TALK = [
  [
    "hey", "hey, how's it going", "not bad, just got in", "long day?",
    "yeah pretty long", "same here honestly", "what were you up to",
    "work mostly, nothing exciting", "fair enough", "you?",
    "just got home too", "nice", "gonna make something to eat in a bit",
  ],
  [
    "anyone here", "yep", "oh nice, wasn't sure", "it's quiet tonight",
    "usually is around now", "makes sense", "where are you from",
    "up north, you?", "other side of the country", "long way then",
    "haha yeah", "still counts", "true",
  ],
  [
    "what's everyone listening to", "nothing right now actually",
    "put something on then", "any suggestions", "depends what you like",
    "anything calm", "got a few of those", "send them over",
    "will do in a sec", "no rush", "cool",
  ],
  [
    "weather's been strange", "same here", "rained all morning",
    "it cleared up later though", "yeah it did", "hoping it holds",
    "supposed to be nice tomorrow", "we'll see", "always do",
  ],
  [
    "first time on here", "welcome", "thanks", "it's pretty simple",
    "yeah I noticed", "you just type and it shows up", "that's neat",
    "old school", "kind of the point", "I like it",
  ],
  [
    "anyone play anything lately", "a bit", "what kind",
    "mostly puzzle stuff", "same actually", "small ones are the best",
    "agreed", "easier to put down", "that's the trick",
  ],
  [
    "gonna head off soon", "already?", "yeah early start",
    "fair enough", "good talking", "you too", "see you around", "later",
  ],
  [
    "coffee or tea", "tea", "coffee", "both", "not at the same time though",
    "obviously", "haha", "tea in the evening though", "that's the rule",
  ],
];

const DEVICE_POOL = DEVICE_MIX;

const sim = new Map();
const simRooms = new Set();
const simNames = new Set();
let simCfg = null;
let simTimer = null;
let simSeq = 0;
let lagMon = null;
let simStat = {
  added: 0,
  removed: 0,
  said: 0,
  ticks: 0,
  paused: null,
  startedAt: 0,
};

const TICK_MS = 500;
const SPEAK_CAP = 300;
const TYPE_CHARS = 7;

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

function isSimRoom(roomId) {
  return simRooms.has(roomId);
}

function simRoomCount() {
  return simRooms.size;
}

function loopLagMs() {
  if (!lagMon) return 0;
  return Math.round(lagMon.percentile(99) / 1e6);
}

function heapMB() {
  return Math.round(process.memoryUsage().heapUsed / 1048576);
}

function simRoomName() {
  for (let i = 0; i < 40; i++) {
    const n = pick(ROOM_WORDS_A) + " " + pick(ROOM_WORDS_B);
    const key = n.toLowerCase();
    if (!simNames.has(key)) {
      simNames.add(key);
      return n;
    }
  }
  return "room " + ++simSeq;
}

function newSimRoom() {
  let roomId = null;
  for (let i = 0; i < 60; i++) {
    const c = deps.generateRoomId();
    if (!state.rooms.has(c)) {
      roomId = c;
      break;
    }
  }
  if (!roomId) return null;
  const now = ms();
  const room = {
    id: roomId,
    name: simRoomName(),
    type: simCfg.roomType,
    layout: "vertical",
    maxSize: simCfg.perRoom,
    allowBots: false,
    users: [],
    accessCode: null,
    votes: {},
    bannedUserIds: new Set(),
    lastActiveTime: now,
    createdAt: now,
    thread: Math.floor(Math.random() * TALK.length),
    line: 0,
  };
  state.rooms.set(roomId, room);
  simRooms.add(roomId);
  return room;
}

// Fill one room at a time and move on when it is full. Scanning the whole set
// for a free slot is O(rooms) per person added, which stops the ramp dead once
// there are tens of thousands of them.
let fillRoomId = null;

function roomWithSpace() {
  if (fillRoomId) {
    const room = state.rooms.get(fillRoomId);
    if (room && (room.users || []).length < simCfg.perRoom) return room;
  }
  const room = newSimRoom();
  fillRoomId = room ? room.id : null;
  return room;
}

function addSimUser() {
  const room = roomWithSpace();
  if (!room) return false;
  const id = newId();
  const rec = {
    id,
    username: pick(NAMES) + (Math.random() < 0.25 ? Math.floor(Math.random() * 90 + 10) : ""),
    location: pick(PLACES),
    roomId: room.id,
    say: null,
  };
  sim.set(id, rec);
  room.users.push({
    id,
    username: rec.username,
    location: rec.location,
    deviceType: pick(DEVICE_POOL),
    deviceId: null,
    avatar: Math.random() < 0.55 ? { preset: 1 + Math.floor(Math.random() * 9) } : null,
  });
  room.lastActiveTime = ms();
  state.setBuffer(id, room.id, "");
  simStat.added++;
  return true;
}

function dropSimUser(id) {
  const rec = sim.get(id);
  if (!rec) return;
  const room = rec.roomId ? state.rooms.get(rec.roomId) : null;
  if (room) {
    room.users = (room.users || []).filter((u) => u.id !== id);
    if (room.votes) delete room.votes[id];
    if (!room.users.length && simRooms.has(room.id)) {
      simRooms.delete(room.id);
      simNames.delete(String(room.name).toLowerCase());
      if (fillRoomId === room.id) fillRoomId = null;
      state.rooms.delete(room.id);
      state.roomSoloSince.delete(room.id);
      state.roomLastChatActivity.delete(room.id);
      if (state.roomDeletionTimers.has(room.id)) {
        clearTimeout(state.roomDeletionTimers.get(room.id));
        state.roomDeletionTimers.delete(room.id);
      }
    }
  }
  state.deleteUserBuffers(id);
  sim.delete(id);
  simStat.removed++;
}

function simSpeak(rec) {
  const room = state.rooms.get(rec.roomId);
  if (!room) return;
  if (!rec.say) {
    const thread = TALK[room.thread % TALK.length];
    rec.say = { text: thread[room.line % thread.length], at: 0 };
    room.line++;
  }
  const t = rec.say;
  t.at = Math.min(t.text.length, t.at + TYPE_CHARS);
  const partial = t.text.slice(0, t.at);
  state.setBuffer(rec.id, rec.roomId, partial);
  state.roomLastChatActivity.set(rec.roomId, ms());
  room.lastActiveTime = ms();
  if (simCfg.roomType !== "private")
    deps.emitChat(socketFor({ ...rec }), {
      userId: rec.id,
      username: rec.username,
      diff: { type: "full-replace", text: partial },
    });
  if (t.at >= t.text.length) {
    rec.say = null;
    simStat.said++;
  }
}

function simTick() {
  if (!simCfg) return;
  simStat.ticks++;

  // Read the delay for the tick just gone, then start a fresh window, so the
  // gauge tracks how the server is doing now and not the worst it ever was.
  const lag = loopLagMs();
  simStat.lag = lag;
  if (lagMon) lagMon.reset();
  const heap = heapMB();
  const overLag = lag > simCfg.maxLagMs;
  const overHeap = heap > simCfg.maxHeapMB;

  if (overLag || overHeap) {
    simStat.paused = overHeap
      ? `heap ${heap}MB over ${simCfg.maxHeapMB}MB`
      : `event loop ${lag}ms over ${simCfg.maxLagMs}ms`;
    if (simCfg.autoDrain) {
      const shed = Math.min(sim.size, Math.max(50, simCfg.rate));
      const ids = [];
      for (const id of sim.keys()) {
        ids.push(id);
        if (ids.length >= shed) break;
      }
      for (const id of ids) dropSimUser(id);
      deps.updateLobby();
      return;
    }
  } else if (simStat.paused) simStat.paused = null;

  let touched = false;

  if (!simStat.paused && sim.size < simCfg.target) {
    const want = Math.min(simCfg.rate, simCfg.target - sim.size);
    for (let i = 0; i < want; i++) if (!addSimUser()) break;
    touched = true;
  }

  if (simCfg.chat && sim.size) {
    const ids = [...sim.keys()];
    const n = Math.min(SPEAK_CAP, Math.max(1, Math.round(ids.length * 0.02)));
    for (let i = 0; i < n; i++) {
      const rec = sim.get(ids[Math.floor(Math.random() * ids.length)]);
      if (rec) simSpeak(rec);
    }
  }

  if (simCfg.churn && sim.size > 20 && Math.random() < 0.5) {
    const ids = [...sim.keys()];
    const n = Math.min(20, Math.round(ids.length * 0.001) + 1);
    for (let i = 0; i < n; i++)
      dropSimUser(ids[Math.floor(Math.random() * ids.length)]);
    touched = true;
  }

  if (touched) deps.updateLobby();
}

function simStart(o) {
  if (!deps) return { error: "Not ready." };
  o = o || {};
  const target = num(o.target, 1, 2000000, 1000);
  const cfg = {
    target,
    rate: num(o.rate, 1, 20000, 250),
    perRoom: num(o.perRoom, 2, 500, 5),
    roomType: ROOM_TYPES.includes(o.roomType) ? o.roomType : "private",
    chat: o.chat !== false,
    churn: o.churn !== false,
    maxHeapMB: num(o.maxHeapMB, 8, 16384, 1400),
    maxLagMs: num(o.maxLagMs, 20, 5000, 250),
    autoDrain: o.autoDrain !== false,
  };
  simCfg = cfg;
  if (!simStat.startedAt) simStat.startedAt = ms();
  if (!lagMon) {
    try {
      lagMon = require("perf_hooks").monitorEventLoopDelay({ resolution: 20 });
      lagMon.enable();
    } catch (_) {}
  }
  if (!simTimer) {
    simTimer = setInterval(simTick, TICK_MS);
    simTimer.unref && simTimer.unref();
  }
  return { ok: true, ...simStatus() };
}

function simRetarget(o) {
  if (!simCfg) return { error: "No test running." };
  if (o && o.target !== undefined)
    simCfg.target = num(o.target, 0, 2000000, simCfg.target);
  if (o && o.rate !== undefined) simCfg.rate = num(o.rate, 1, 20000, simCfg.rate);
  if (o && o.chat !== undefined) simCfg.chat = !!o.chat;
  if (o && o.churn !== undefined) simCfg.churn = !!o.churn;
  return { ok: true, ...simStatus() };
}

function simStop(o) {
  const hard = !!(o && o.now);
  if (hard) {
    for (const id of [...sim.keys()]) dropSimUser(id);
    for (const id of [...simRooms]) {
      simRooms.delete(id);
      state.rooms.delete(id);
      state.roomSoloSince.delete(id);
      state.roomLastChatActivity.delete(id);
      if (state.roomDeletionTimers.has(id)) {
        clearTimeout(state.roomDeletionTimers.get(id));
        state.roomDeletionTimers.delete(id);
      }
    }
    simNames.clear();
    fillRoomId = null;
    simCfg = null;
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
    simStat = { added: 0, removed: 0, said: 0, ticks: 0, paused: null, startedAt: 0 };
    if (deps) deps.updateLobby();
    return { ok: true, drained: true, ...simStatus() };
  }
  if (!simCfg) return { error: "No test running." };
  simCfg.target = 0;
  simCfg.chat = false;
  simCfg.churn = false;
  simCfg.autoDrain = true;
  simCfg.maxLagMs = 1;
  return { ok: true, draining: true, ...simStatus() };
}

function simStatus() {
  return {
    running: !!simCfg,
    users: sim.size,
    rooms: simRooms.size,
    target: simCfg ? simCfg.target : 0,
    rate: simCfg ? simCfg.rate : 0,
    perRoom: simCfg ? simCfg.perRoom : 0,
    roomType: simCfg ? simCfg.roomType : null,
    chat: simCfg ? simCfg.chat : false,
    churn: simCfg ? simCfg.churn : false,
    paused: simStat.paused,
    lagMs: simStat.lag || 0,
    heapMB: heapMB(),
    maxHeapMB: simCfg ? simCfg.maxHeapMB : 0,
    maxLagMs: simCfg ? simCfg.maxLagMs : 0,
    added: simStat.added,
    removed: simStat.removed,
    said: simStat.said,
    realRooms: state.rooms.size - simRooms.size,
    online: io() ? io().sockets.sockets.size : 0,
    upMs: simStat.startedAt ? ms() - simStat.startedAt : 0,
  };
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
  isSimRoom,
  simRoomCount,
  simStart,
  simRetarget,
  simStop,
  simStatus,
};
