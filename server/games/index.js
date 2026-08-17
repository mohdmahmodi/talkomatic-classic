// server/games/index.js
// The game floor for a room: pools, tables, seating, winner-stays rotation,
// challenges, forfeits and clocks.

// ── Adding a game ───────────────────────────────────────────────────────────

const chatguard = require("../chatguard");
const tictactoe = require("./tictactoe");
const connect4 = require("./connect4");
const drawguess = require("./drawguess");
const flagguess = require("./flagguess");
const flagcdn = require("./flagcdn");

const GAMES = { drawguess, flagguess, tictactoe, connect4 };

const EXTERNAL = [
  {
    id: "popshot",
    name: "Popshot",
    icon: { image: "games/popshot/bottle.png" },
    blurb: "Shoot the swinging bottle before it swings back.",
    url: "games/popshot/",
    solo: true,
    howTo: [
      "Click or tap to fire at the bottle.",
      "It swings faster the longer you last.",
      "Play on your own, then post your score in the room.",
    ],
  },
];

const SHOUT_TYPES = { drawguess: true, flagguess: true };
const SHOUT_GAP_MS = 4 * 60 * 1000;

const WINNER_STAYS = { tictactoe: true, connect4: true };

const MAX_MISSES = 2;

const MAX_TABLES_PER_ROOM = 40;
const FINISH_MS = 12000;
const CHALLENGE_MS = 60000;
const CHALLENGE_COOLDOWN_MS = 15000;
const GRACE_MS = 20000;
const STREAK_CAP = 5;
const TICK_MS = 1000;
const CHAT_MAX = 80;
const CHAT_LEN = 200;
const CHAT_MIN_GAP_MS = 700;
const CHAT_BURST = 6;
const CHAT_BURST_MS = 9000;
const SAY_REPEAT_MS = 8000;
const TYPING_MS = 4000;

const CHEERS = ["👏", "🔥", "😱", "😂", "💪", "🎉"];
const CHEER_GAP_MS = 900;

const floors = new Map();
const challenges = new Map();
const lastChallengeAt = new Map();

let deps = null;
let timer = null;
let seq = 0;

function init(d) {
  deps = d;
  if (!timer) timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
}

function id(prefix) {
  seq++;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

function rulesFor(type) {
  return GAMES[type] || null;
}

function catalog() {
  const live = Object.values(GAMES).map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    blurb: g.blurb,
    howTo: g.howTo || [],
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    turnBased: !!g.turnBased,
    winnerStays: !!WINNER_STAYS[g.id],
    joinInProgress: !!g.joinInProgress,
    external: false,
  }));
  const solo = EXTERNAL.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    blurb: g.blurb,
    howTo: g.howTo || [],
    url: g.url,
    solo: !!g.solo,
    external: true,
  }));
  return live.concat(solo);
}

function floorFor(roomId) {
  let f = floors.get(roomId);
  if (!f) {
    f = { roomId, tables: new Map(), pools: new Map() };
    floors.set(roomId, f);
  }
  return f;
}

function poolFor(f, type) {
  let p = f.pools.get(type);
  if (!p) {
    p = [];
    f.pools.set(type, p);
  }
  return p;
}

function tablesOfType(f, type) {
  return [...f.tables.values()].filter((t) => t.type === type);
}

function tableOf(f, userId, type) {
  for (const t of f.tables.values()) {
    if (type && t.type !== type) continue;
    if (t.seats.some((s) => s.userId === userId)) return t;
  }
  return null;
}

function inPool(f, userId, type) {
  return poolFor(f, type).includes(userId);
}

// ── Emission ────────────────────────────────────────────────────────────────

function tableSummary(t) {
  const rules = rulesFor(t.type);
  return {
    id: t.id,
    type: t.type,
    state: t.state,
    seats: t.seats.map((s) => ({
      userId: s.userId,
      username: s.username,
      role: s.role || null,
      avatar: s.avatar || null,
    })),
    reservedFor: t.reservedFor
      ? { userId: t.reservedFor.userId, username: t.reservedFor.username }
      : null,
    spectators: t.spectators.size,
    streak: t.streak,
    openDeadline: t.openDeadline,
    matchNumber: t.matchNumber,
    room: rules ? rules.maxPlayers - t.seats.length : 0,
    canJoin:
      !!rules &&
      !t.reservedFor &&
      t.seats.length < rules.maxPlayers &&
      (t.state === "open" || (t.state === "playing" && !!rules.joinInProgress)),
  };
}

const WATCHERS_SHOWN = 24;

function watcherList(t) {
  const out = [];
  for (const uid of t.spectators) {
    if (out.length >= WATCHERS_SHOWN) break;
    const u = deps.userInfo(t.roomId, uid);
    if (!u) continue;
    out.push({
      userId: uid,
      username: u.username,
      role: u.role || null,
      avatar: u.avatar || null,
    });
  }
  return out;
}

function tableDetail(t, userId) {
  const rules = rulesFor(t.type);
  const seated = t.seats.some((s) => s.userId === userId);
  const votes = [];
  for (const [target, set] of t.votes)
    votes.push({ userId: target, count: set.size, mine: set.has(userId) });
  return {
    ...tableSummary(t),
    seated,
    spectating: t.spectators.has(userId),
    watchers: watcherList(t),
    turnDeadline: t.turnDeadline,
    rotateAt: t.rotateAt || null,
    rematch: [...t.rematch],
    result: t.result,
    outcome: outcomeFor(t, userId),
    chat: t.chat,
    typing: typingList(t).filter((x) => x.userId !== userId),
    votes,
    voteNeeded: Math.ceil((t.seats.length - 1) / 2),
    canVote: seated && t.seats.length >= 3,
    nextUp: nextUpList(t),
    iAmNext: t.nextUp.includes(userId),
    canPlayNext: !seated && !!rules && WINNER_STAYS[t.type] !== undefined,
    game: t.game && rules ? rules.view(t.game, userId) : null,
  };
}

function floorFor_view(f, userId) {
  const pools = {};
  const myQueue = {};
  for (const [type, arr] of f.pools) {
    pools[type] = arr.length;
    const at = arr.indexOf(userId);
    if (at >= 0) myQueue[type] = at + 1;
  }
  const mine = {};
  const counts = {};
  for (const type of Object.keys(GAMES))
    counts[type] = { playing: 0, waiting: 0, games: 0, live: 0, names: [] };
  const myNext = [];
  for (const t of f.tables.values()) {
    if (t.seats.some((s) => s.userId === userId)) mine[t.type] = t.id;
    if (t.nextUp.includes(userId)) myNext.push(t.id);
    const c = counts[t.type];
    if (!c) continue;
    c.games++;
    if (t.state === "playing") c.live++;
    for (const s of t.seats) {
      if (t.state === "playing") c.playing++;
      else c.waiting++;
      if (c.names.length < 6) c.names.push(s.username);
    }
  }
  for (const [type, arr] of f.pools)
    if (counts[type]) counts[type].waiting += arr.length;

  return {
    tables: [...f.tables.values()].map(tableSummary),
    counts,
    pools,
    myQueue,
    myTables: mine,
    myNext,
  };
}

function emitFloor(roomId) {
  if (!deps) return;
  for (const s of deps.socketsInRoom(roomId)) {
    const uid = deps.userIdOf(s);
    if (!uid) continue;
    s.emit("games floor", floorFor_view(floorFor(roomId), uid));
  }
}

function emitTable(t) {
  if (!deps) return;
  for (const s of deps.socketsInRoom(t.roomId)) {
    const uid = deps.userIdOf(s);
    if (!uid) continue;
    if (!t.seats.some((x) => x.userId === uid) && !t.spectators.has(uid))
      continue;
    s.emit("games table", tableDetail(t, uid));
  }
}

function emitRelay(t, payload) {
  if (!deps) return;
  for (const s of deps.socketsInRoom(t.roomId)) {
    const uid = deps.userIdOf(s);
    if (!uid) continue;
    if (!t.seats.some((x) => x.userId === uid) && !t.spectators.has(uid))
      continue;
    s.emit("games relay", { tableId: t.id, ...payload });
  }
}

function toUser(roomId, userId, event, payload) {
  if (!deps) return;
  for (const s of deps.socketsInRoom(roomId)) {
    if (deps.userIdOf(s) === userId) s.emit(event, payload);
  }
}

const lastShout = new Map();
function shoutRoom(t, text) {
  if (!deps) return;
  const key = t.roomId + ":" + t.type;
  const now = Date.now();
  if (now - (lastShout.get(key) || 0) < SHOUT_GAP_MS) return;
  lastShout.set(key, now);
  const g = rulesFor(t.type);
  for (const s of deps.socketsInRoom(t.roomId)) {
    const uid = deps.userIdOf(s);
    if (!uid) continue;
    if (t.seats.some((x) => x.userId === uid)) continue;
    s.emit("games shout", {
      tableId: t.id,
      type: t.type,
      name: g ? g.name : t.type,
      text,
    });
  }
}

// ── Tables ──────────────────────────────────────────────────────────────────

function createTable(f, type, opts) {
  const t = {
    id: id("tbl"),
    roomId: f.roomId,
    type,
    seats: [],
    reservedFor: (opts && opts.reservedFor) || null,
    spectators: new Set(),
    state: "open",
    game: null,
    matchNumber: 0,
    streak: null,
    turnDeadline: null,
    openDeadline: null,
    rotateAt: null,
    rematch: new Set(),
    result: null,
    createdAt: Date.now(),
    missingSince: new Map(),
    misses: new Map(),
    chat: [],
    chatSeq: 0,
    lastChatAt: new Map(),
    nextUp: [],
    chatBurst: new Map(),
    cheerAt: new Map(),
    lastSaid: new Map(),
    saidAt: new Map(),
    typing: new Map(),
    votes: new Map(),
  };
  f.tables.set(t.id, t);
  return t;
}

function seatPlayer(f, t, user) {
  if (t.seats.some((s) => s.userId === user.userId)) return;
  t.seats.push({
    userId: user.userId,
    username: user.username,
    role: user.role || null,
    avatar: user.avatar || null,
  });
  t.spectators.delete(user.userId);
  const rules = rulesFor(t.type);
  if (deps.setPlaying)
    deps.setPlaying(t.roomId, user.userId, true, rules ? rules.name : null);
  if (t.state === "playing" && t.game && rules && rules.addPlayer) {
    rules.addPlayer(t.game, { userId: user.userId, username: user.username });
  }
  say(t, `${user.username} joined`);
  if (t.game) syncCanvas(t.roomId, user.userId, t.id);
}

function unseatPlayer(f, t, userId) {
  const at = t.seats.findIndex((s) => s.userId === userId);
  if (at < 0) return null;
  const [gone] = t.seats.splice(at, 1);
  t.rematch.delete(userId);
  t.missingSince.delete(userId);
  t.typing.delete(userId);
  t.votes.delete(userId);
  t.misses.delete(userId);
  for (const set of t.votes.values()) set.delete(userId);
  if (deps.setPlaying && !tableOf(f, userId, null))
    deps.setPlaying(t.roomId, userId, false);
  return gone;
}

// ── Per-game chat & event feed ──────────────────────────────────────────────

function pushChat(t, entry) {
  t.chat.push(Object.assign({ id: ++t.chatSeq, at: Date.now() }, entry));
  if (t.chat.length > CHAT_MAX) t.chat = t.chat.slice(-CHAT_MAX);
  emitRelay(t, { kind: "chat", message: t.chat[t.chat.length - 1] });
}

function say(t, text, tone) {
  const now = Date.now();
  if (now - (t.saidAt.get(text) || 0) < SAY_REPEAT_MS) return;
  t.saidAt.set(text, now);
  if (t.saidAt.size > 80)
    for (const [k, v] of t.saidAt) if (now - v > SAY_REPEAT_MS) t.saidAt.delete(k);
  pushChat(t, { kind: "system", text, tone: tone || null });
}

function canSpeak(t, userId) {
  const now = Date.now();
  const hits = (t.chatBurst.get(userId) || []).filter(
    (at) => now - at < CHAT_BURST_MS,
  );
  if (hits.length >= CHAT_BURST) {
    t.chatBurst.set(userId, hits);
    return false;
  }
  hits.push(now);
  t.chatBurst.set(userId, hits);
  return true;
}

function pushGuess(t, userId, text) {
  if (!canSpeak(t, userId)) return;
  const who = deps.userInfo(t.roomId, userId) || {};
  const seat = t.seats.find((s) => s.userId === userId);
  pushChat(t, {
    kind: "guess",
    userId,
    username: (seat && seat.username) || who.username || "Someone",
    role: who.role || null,
    avatar: who.avatar || null,
    text,
  });
}

function audienceOf(t) {
  const ids = new Set(t.seats.map((s) => s.userId));
  for (const s of t.spectators) ids.add(s);
  return ids;
}

function dissolve(f, t, reason) {
  if (!f.tables.has(t.id)) return;
  const had = t.seats.map((s) => s.userId);
  f.tables.delete(t.id);
  for (const uid of had) unseatPlayer(f, t, uid);
  if (reason)
    for (const uid of had)
      toUser(t.roomId, uid, "games closed", { tableId: t.id, reason });
}

function startMatch(t) {
  const rules = rulesFor(t.type);
  if (!rules) return;
  t.game = rules.create(
    t.seats.map((s) => ({ userId: s.userId, username: s.username })),
    { matchNumber: t.matchNumber },
  );
  t.state = "playing";
  t.result = null;
  t.rematch = new Set();
  t.misses = new Map();
  t.openDeadline = null;
  t.rotateAt = null;
  t.matchNumber++;
  armTurn(t);
  emitTable(t);

  if (SHOUT_TYPES[t.type] && t.matchNumber === 1) {
    const who = t.seats.length === 1 ? t.seats[0].username : null;
    shoutRoom(
      t,
      rules.shout
        ? rules.shout(t.seats, rules.name)
        : who
          ? `${who} started ${rules.name}. There is room to join.`
          : `${rules.name} just started with ${t.seats.length} players. You can still join.`,
    );
  }
}

function armTurn(t) {
  const rules = rulesFor(t.type);
  if (!rules || !rules.turnBased || !t.game) {
    t.turnDeadline = null;
    return;
  }
  t.turnDeadline = rules.turnOf(t.game) ? Date.now() + rules.turnMs : null;
}

function maybeStart(f, t) {
  const rules = rulesFor(t.type);
  if (!rules || t.state !== "open") return;
  if (t.reservedFor) return;
  if (t.seats.length >= rules.maxPlayers) return startMatch(t);
  if (t.seats.length >= rules.minPlayers) {
    if (!rules.openMs) return;
    if (!t.openDeadline) t.openDeadline = Date.now() + rules.openMs;
  } else {
    t.openDeadline = null;
  }
}

function pump(f, type) {
  const rules = rulesFor(type);
  if (!rules) return;
  const pool = poolFor(f, type);

  for (const t of tablesOfType(f, type)) {
    if (t.reservedFor) continue;
    const joinable =
      t.state === "open" || (t.state === "playing" && rules.joinInProgress);
    if (!joinable) continue;
    while (pool.length && t.seats.length < rules.maxPlayers) {
      const uid = pool.shift();
      const u = deps.userInfo(f.roomId, uid);
      if (!u) continue;
      seatPlayer(f, t, u);
    }
    if (t.state === "open") maybeStart(f, t);
    else emitTable(t);
  }

  while (pool.length >= rules.minPlayers && f.tables.size < MAX_TABLES_PER_ROOM) {
    const t = createTable(f, type);
    while (pool.length && t.seats.length < rules.maxPlayers) {
      const uid = pool.shift();
      const u = deps.userInfo(f.roomId, uid);
      if (!u) continue;
      seatPlayer(f, t, u);
    }
    if (!t.seats.length) {
      f.tables.delete(t.id);
      break;
    }
    maybeStart(f, t);
    if (t.state === "open") emitTable(t);
  }

  if (
    pool.length &&
    !tablesOfType(f, type).length &&
    f.tables.size < MAX_TABLES_PER_ROOM
  ) {
    const t = createTable(f, type);
    while (pool.length && t.seats.length < rules.maxPlayers) {
      const uid = pool.shift();
      const u = deps.userInfo(f.roomId, uid);
      if (!u) continue;
      seatPlayer(f, t, u);
    }
    if (!t.seats.length) {
      f.tables.delete(t.id);
      return;
    }
    maybeStart(f, t);
    if (t.state === "open") emitTable(t);
  }
}

function finishMatch(t) {
  const rules = rulesFor(t.type);
  const res = rules.result(t.game);
  t.result = res;
  t.state = "finished";
  t.turnDeadline = null;
  t.rematch = new Set();
  t.votes = new Map();

  const winner = res.winnerId
    ? t.seats.find((s) => s.userId === res.winnerId)
    : null;
  t.result.winnerName = winner ? winner.username : null;

  if (WINNER_STAYS[t.type]) {
    if (res.winnerId) {
      if (t.streak && t.streak.userId === res.winnerId) t.streak.n++;
      else
        t.streak = {
          userId: res.winnerId,
          username: winner ? winner.username : "",
          n: 1,
        };
    } else if (!res.draw) {
      t.streak = null;
    }
  }
  t.rotateAt = Date.now() + FINISH_MS;

  if (res.draw) say(t, "Draw, nobody takes it");
  else if (winner)
    say(
      t,
      res.forfeit
        ? `${winner.username} wins, the other player left`
        : `${winner.username} wins`,
    );
  else say(t, "Game over");
  emitTable(t);
}

function outcomeFor(t, userId) {
  if (t.state !== "finished" || !t.result) return null;
  const r = t.result;
  const seated = t.seats.some((s) => s.userId === userId);
  const scores = r.scores || [];
  const mine = scores.find((s) => s.userId === userId);

  if (!seated) {
    return {
      kind: "watched",
      headline: r.draw
        ? "Draw"
        : r.winnerName
          ? `${r.winnerName} wins`
          : "Game over",
      detail: null,
    };
  }
  if (r.draw)
    return { kind: "draw", headline: "Draw", detail: "Nobody takes this one." };
  if (r.winnerId === userId)
    return {
      kind: "win",
      headline: "You win",
      detail: r.forfeit
        ? "Your opponent left the game."
        : t.streak && t.streak.n > 1
          ? `That is ${t.streak.n} in a row.`
          : null,
    };
  if (r.winnerId)
    return {
      kind: "loss",
      headline: `${r.winnerName || "Your opponent"} wins`,
      detail: mine ? `You finished on ${mine.score}.` : "Better luck next one.",
    };
  return { kind: "over", headline: "Game over", detail: null };
}

function rotate(f, t) {
  const rules = rulesFor(t.type);
  const pool = poolFor(f, t.type);

  const waiting = t.nextUp.filter((uid) => deps.userInfo(t.roomId, uid));
  t.nextUp = [];

  if (!WINNER_STAYS[t.type]) {
    const keen = t.seats.filter((s) => t.rematch.has(s.userId));
    if (keen.length) {
      for (const s of t.seats.slice())
        if (!t.rematch.has(s.userId)) unseatPlayer(f, t, s.userId);
      t.state = "open";
      t.game = null;
      t.result = null;
      t.turnDeadline = null;
      t.rotateAt = null;
      t.rematch = new Set();
      t.votes = new Map();
      for (const uid of waiting) {
        if (t.seats.length >= rules.maxPlayers) {
          if (!pool.includes(uid)) pool.push(uid);
          continue;
        }
        const u = deps.userInfo(t.roomId, uid);
        if (!u) continue;
        t.spectators.delete(uid);
        seatPlayer(f, t, u);
      }
      say(
        t,
        keen.length === 1
          ? `${keen[0].username} is going again. Anyone can join.`
          : `${keen.length} players are going again. Anyone can join.`,
      );
      pump(f, t.type);
      maybeStart(f, t);
      if (t.state === "open") emitTable(t);
      emitFloor(f.roomId);
      return;
    }
    for (const uid of waiting) if (!pool.includes(uid)) pool.unshift(uid);
    dissolve(f, t, "over");
    pump(f, t.type);
    emitFloor(f.roomId);
    return;
  }

  const everyone = t.seats.every((s) => t.rematch.has(s.userId));
  if (everyone && t.seats.length >= rules.minPlayers && !pool.length && !waiting.length) {
    startMatch(t);
    emitFloor(f.roomId);
    return;
  }

  const res = t.result || {};
  const queueWaiting = pool.length + waiting.length;
  let keep = [];
  if (res.winnerId && t.streak && t.streak.n < STREAK_CAP) {
    keep = t.seats.filter((s) => s.userId === res.winnerId);
  } else if (res.draw && !queueWaiting) {
    keep = t.seats.slice();
  }
  if (!res.winnerId && !res.draw) keep = [];

  const dropped = t.seats.filter((s) => !keep.some((k) => k.userId === s.userId));
  for (const d of dropped) unseatPlayer(f, t, d.userId);
  if (!t.seats.length) t.streak = null;

  t.state = "open";
  t.game = null;
  t.result = null;
  t.turnDeadline = null;
  t.rotateAt = null;
  t.rematch = new Set();
  t.votes = new Map();

  for (const d of dropped)
    toUser(t.roomId, d.userId, "games seat lost", {
      tableId: t.id,
      type: t.type,
      winnerName: res.winnerName || null,
    });

  for (const uid of waiting) {
    if (t.seats.length >= rules.maxPlayers) {
      if (!pool.includes(uid)) pool.push(uid);
      continue;
    }
    const u = deps.userInfo(t.roomId, uid);
    if (!u) continue;
    t.spectators.delete(uid);
    seatPlayer(f, t, u);
  }

  if (!t.seats.length && !pool.length) {
    dissolve(f, t);
  } else {
    if (t.seats.length && !pool.length)
      say(t, `${t.seats[0].username} is waiting for a challenger`);
    pump(f, t.type);
  }
  emitFloor(f.roomId);
}

// ── Public API ──────────────────────────────────────────────────────────────

function queueJoin(roomId, user, type) {
  const rules = rulesFor(type);
  if (!rules) return { err: "Unknown game." };
  const f = floorFor(roomId);
  if (tableOf(f, user.userId, type))
    return { err: `You are already in a game of ${rules.name}.` };
  const pool = poolFor(f, type);
  if (pool.includes(user.userId)) return { err: "Already in the queue." };
  pool.push(user.userId);
  pump(f, type);
  emitFloor(roomId);
  return { ok: true };
}

function playNext(roomId, user, tableId, on) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (!deps.userInfo(roomId, user.userId))
    return { err: "You are not in this room." };
  const at = t.nextUp.indexOf(user.userId);
  if (!on) {
    if (at >= 0) t.nextUp.splice(at, 1);
    emitTable(t);
    emitFloor(roomId);
    return { ok: true };
  }
  if (t.seats.some((s) => s.userId === user.userId))
    return { err: "You are already playing this one." };
  if (at >= 0) return { ok: true };
  const rules = rulesFor(t.type);
  if (tableOf(f, user.userId, t.type))
    return { err: `You are already in a game of ${rules.name}.` };
  t.nextUp.push(user.userId);
  if (!t.spectators.has(user.userId)) t.spectators.add(user.userId);
  say(t, `${user.username} is up for the next round`);
  emitTable(t);
  emitFloor(roomId);
  return { ok: true };
}

function nextUpList(t) {
  const out = [];
  for (const uid of t.nextUp) {
    const u = deps.userInfo(t.roomId, uid);
    if (u) out.push({ userId: uid, username: u.username, avatar: u.avatar || null, role: u.role || null });
  }
  return out;
}

function queueLeave(roomId, userId, type) {
  const f = floorFor(roomId);
  const pool = poolFor(f, type);
  const at = pool.indexOf(userId);
  if (at < 0) return { err: "Not in that queue." };
  pool.splice(at, 1);
  emitFloor(roomId);
  return { ok: true };
}

function joinTable(roomId, user, tableId) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  const rules = rulesFor(t.type);
  if (t.state === "playing" && !rules.joinInProgress)
    return { err: "That game already started. Join the line for the next one." };
  if (t.state === "finished") return { err: "That game just finished." };
  if (t.reservedFor && t.reservedFor.userId !== user.userId)
    return { err: `That spot is held for ${t.reservedFor.username}.` };
  if (t.seats.length >= rules.maxPlayers) return { err: "That game is full." };
  if (tableOf(f, user.userId, t.type))
    return { err: `You are already in a game of ${rules.name}.` };

  const pool = poolFor(f, t.type);
  const at = pool.indexOf(user.userId);
  if (at >= 0) pool.splice(at, 1);

  if (t.reservedFor && t.reservedFor.userId === user.userId) t.reservedFor = null;
  seatPlayer(f, t, user);
  if (t.state === "open") maybeStart(f, t);
  emitTable(t);
  emitFloor(roomId);
  return { ok: true };
}

// ── Chat, typing, and voting somebody out ───────────────────────────────────

function chat(roomId, user, tableId, text) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (!audienceOf(t).has(user.userId)) {
    if (!deps.userInfo(t.roomId, user.userId))
      return { err: "You are not in this room." };
    t.spectators.add(user.userId);
    emitFloor(t.roomId);
  }

  let body = chatguard.clean(
    String(text || "").replace(/\s+/g, " ").trim(),
    CHAT_LEN,
  );
  if (!body) return { ok: true };
  const last = t.lastChatAt.get(user.userId) || 0;
  if (Date.now() - last < CHAT_MIN_GAP_MS) return { err: "Slow down a moment." };
  if (t.lastSaid.get(user.userId) === body.toLowerCase())
    return { err: "You just said that." };
  if (!canSpeak(t, user.userId))
    return { err: "That is a lot of messages. Give it a few seconds." };
  t.lastChatAt.set(user.userId, Date.now());
  t.lastSaid.set(user.userId, body.toLowerCase());

  const playing = t.seats.some((s) => s.userId === user.userId);
  t.typing.delete(user.userId);

  if (t.state === "playing" && t.game) {
    const rules = rulesFor(t.type);
    if (rules && rules.chatGuess) {
      const out = rules.chatGuess(t.game, user.userId, body);
      if (out && out.swallow) {
        return { ok: true };
      } else if (out) {
        t.misses.delete(user.userId);
        if (out.announce) say(t, out.announce, out.tone);
        if (rules.isOver(t.game)) {
          finishMatch(t);
          emitFloor(t.roomId);
        } else {
          armTurn(t);
          emitTable(t);
        }
        return { ok: true, guessed: true };
      }
    }
  }
  const who = deps.userInfo(t.roomId, user.userId) || {};
  pushChat(t, {
    kind: "msg",
    userId: user.userId,
    username: user.username,
    role: who.role || null,
    avatar: who.avatar || null,
    text: body,
    watching: !playing,
  });
  return { ok: true };
}

function typing(roomId, userId, tableId, on) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t || !audienceOf(t).has(userId)) return { ok: true };
  if (on) t.typing.set(userId, Date.now() + TYPING_MS);
  else t.typing.delete(userId);
  emitRelay(t, { kind: "typing", users: typingList(t) });
  return { ok: true };
}

function typingList(t) {
  const now = Date.now();
  const out = [];
  for (const [uid, exp] of t.typing) {
    if (exp <= now) continue;
    const seat = t.seats.find((s) => s.userId === uid);
    out.push({ userId: uid, username: seat ? seat.username : null });
  }
  return out;
}

function voteRemove(roomId, userId, tableId, targetUserId) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (!t.seats.some((s) => s.userId === userId))
    return { err: "Only players can vote." };
  if (userId === targetUserId) return { err: "Use Leave game instead." };
  const target = t.seats.find((s) => s.userId === targetUserId);
  if (!target) return { err: "They are not in this game." };
  if (t.seats.length < 3)
    return { err: "Needs at least three players to vote somebody out." };

  let set = t.votes.get(targetUserId);
  if (!set) {
    set = new Set();
    t.votes.set(targetUserId, set);
  }
  if (set.has(userId)) {
    set.delete(userId);
    if (!set.size) t.votes.delete(targetUserId);
    say(t, `${deps.userInfo(roomId, userId)?.username || "Someone"} took back their vote`);
    emitTable(t);
    return { ok: true, removed: false };
  }
  set.add(userId);

  const needed = Math.ceil((t.seats.length - 1) / 2);
  if (set.size >= needed) {
    say(t, `${target.username} was voted out`);
    t.votes.delete(targetUserId);
    forfeit(f, t, targetUserId);
    toUser(roomId, targetUserId, "games closed", {
      tableId: t.id,
      reason: "voted-out",
    });
    emitFloor(roomId);
  } else {
    say(t, `${set.size} of ${needed} voted to remove ${target.username}`);
    emitTable(t);
  }
  return { ok: true };
}

function syncCanvas(roomId, userId, tableId) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t || !t.game) return { ok: true };
  const rules = rulesFor(t.type);
  if (!rules || !rules.snapshotStrokes) return { ok: true };
  if (!audienceOf(t).has(userId)) return { ok: true };
  const snap = rules.snapshotStrokes(t.game);
  toUser(roomId, userId, "games relay", {
    tableId: t.id,
    kind: "strokes",
    strokes: snap.strokes,
    rev: snap.rev,
  });
  return { ok: true };
}

function isPlaying(roomId, userId) {
  const f = floors.get(roomId);
  if (!f) return false;
  for (const t of f.tables.values())
    if (t.seats.some((s) => s.userId === userId)) return true;
  return false;
}

function leaveTable(roomId, userId, tableId) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (!t.seats.some((s) => s.userId === userId)) {
    t.spectators.delete(userId);
    emitFloor(roomId);
    return { ok: true };
  }
  forfeit(f, t, userId);
  emitFloor(roomId);
  return { ok: true };
}

function forfeit(f, t, userId) {
  const rules = rulesFor(t.type);
  const gone = unseatPlayer(f, t, userId);
  if (gone && t.state === "playing") say(t, `${gone.username} left the game`);

  if (t.state === "playing") {
    if (rules.removePlayer && t.game) {
      const ended = rules.removePlayer(t.game, userId);
      if (rules.isOver(t.game)) return finishMatch(t);
      if (ended) emitTable(t);
      if (t.seats.length < rules.minPlayers) {
        t.game = null;
        t.state = "open";
        t.turnDeadline = null;
        maybeStart(f, t);
        emitTable(t);
      }
      return;
    }
    if (t.seats.length < rules.minPlayers) {
      const survivor = t.seats[0];
      t.result = {
        winnerId: survivor ? survivor.userId : null,
        draw: false,
        forfeit: true,
        scores: [],
      };
      t.state = "finished";
      t.turnDeadline = null;
      if (survivor) {
        if (t.streak && t.streak.userId === survivor.userId) t.streak.n++;
        else t.streak = { userId: survivor.userId, username: survivor.username, n: 1 };
      }
      t.rotateAt = Date.now() + FINISH_MS;
      emitTable(t);
      return;
    }
    armTurn(t);
    emitTable(t);
    return;
  }

  if (!t.seats.length && !t.reservedFor) dissolve(f, t);
  else {
    maybeStart(f, t);
    emitTable(t);
  }
}

function makeMove(roomId, userId, tableId, mv) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (t.state !== "playing" || !t.game) return { err: "No match running." };
  const rules = rulesFor(t.type);
  const out = rules.move(t.game, userId, mv);
  if (!out.ok) return { err: out.err || "Illegal move." };
  t.misses.delete(userId);

  if (out.announce) say(t, out.announce, out.tone);
  if (out.chat) pushGuess(t, userId, out.chat);

  if (rules.isOver(t.game)) {
    finishMatch(t);
    emitFloor(roomId);
    return { ok: true, ...out };
  }

  if (out.relay) emitRelay(t, out.relay);
  if (out.quiet) {
    if (out.selfPush)
      toUser(roomId, userId, "games table", tableDetail(t, userId));
  } else {
    armTurn(t);
    emitTable(t);
  }
  return { ok: true, ...out };
}

function drawStrokes(roomId, userId, tableId, segments) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t || t.state !== "playing" || !t.game) return { err: "No game running." };
  const rules = rulesFor(t.type);
  const applied = [];
  for (const seg of segments) {
    const out = rules.move(t.game, userId, { kind: "stroke", stroke: seg });
    if (!out.ok) break;
    if (out.relay && out.relay.stroke) applied.push(out.relay.stroke);
  }
  if (!applied.length) return { ok: true };
  t.misses.delete(userId);
  emitRelay(t, {
    kind: "strokeBatch",
    strokes: applied,
    rev: rules.snapshotStrokes ? rules.snapshotStrokes(t.game).rev : 0,
  });
  return { ok: true };
}

function rematch(roomId, userId, tableId) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (t.state !== "finished") return { err: "Nothing to rematch yet." };
  if (!t.seats.some((s) => s.userId === userId))
    return { err: "You are not in this game." };
  if (WINNER_STAYS[t.type]) {
    if (poolFor(f, t.type).length)
      return { err: "People are waiting, so the seat rotates." };
    if (t.nextUp.some((uid) => deps.userInfo(t.roomId, uid)))
      return { err: "Somebody is up next, so the seat rotates." };
  }

  const seat = t.seats.find((s) => s.userId === userId);
  if (t.rematch.has(userId)) {
    t.rematch.delete(userId);
    emitTable(t);
    return { ok: true };
  }
  t.rematch.add(userId);

  const need = t.seats.length;
  const anyWaiting = t.nextUp.some((uid) => deps.userInfo(t.roomId, uid));
  if (t.rematch.size >= need && need >= rulesFor(t.type).minPlayers && !anyWaiting) {
    say(t, "Everyone wants another go. Here we go.");
    startMatch(t);
    emitFloor(roomId);
    return { ok: true };
  }
  say(
    t,
    `${(seat && seat.username) || "Someone"} wants a rematch (${t.rematch.size}/${need})`,
  );
  emitTable(t);
  return { ok: true };
}

function spectate(roomId, userId, tableId, on) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (t.seats.some((s) => s.userId === userId))
    return { err: "You are playing in this one." };
  if (on) {
    if (!t.spectators.has(userId)) {
      t.spectators.add(userId);
      const u = deps.userInfo(roomId, userId);
      if (u) say(t, `${u.username} is watching`);
    }
  } else t.spectators.delete(userId);
  if (on) {
    toUser(roomId, userId, "games table", tableDetail(t, userId));
    syncCanvas(roomId, userId, t.id);
  }
  emitTable(t);
  emitFloor(roomId);
  return { ok: true };
}

function challenge(roomId, from, targetUserId, type) {
  const rules = rulesFor(type);
  if (!rules) return { err: "Unknown game." };
  if (rules.maxPlayers !== 2 || rules.minPlayers !== 2)
    return { err: `${rules.name} is not a head to head game.` };
  if (targetUserId === from.userId) return { err: "Pick somebody else." };

  const last = lastChallengeAt.get(from.userId) || 0;
  if (Date.now() - last < CHALLENGE_COOLDOWN_MS)
    return { err: "Slow down a moment." };
  for (const c of challenges.values())
    if (c.from === from.userId) return { err: "You already have one out." };

  const target = deps.userInfo(roomId, targetUserId);
  if (!target) return { err: "They are not in this room." };
  if (deps.hasBlocked && deps.hasBlocked(targetUserId, from.userId))
    return { err: "They are not taking challenges." };

  const f = floorFor(roomId);
  if (tableOf(f, from.userId, type))
    return { err: `You are already in a game of ${rules.name}.` };
  if (tableOf(f, targetUserId, type))
    return { err: `${target.username} is already in a game of ${rules.name}.` };
  if (f.tables.size >= MAX_TABLES_PER_ROOM) return { err: "Too many tables." };

  const pool = poolFor(f, type);
  const at = pool.indexOf(from.userId);
  if (at >= 0) pool.splice(at, 1);

  const t = createTable(f, type, {
    reservedFor: { userId: targetUserId, username: target.username },
  });
  seatPlayer(f, t, from);

  const cid = id("ch");
  const rec = {
    id: cid,
    roomId,
    from: from.userId,
    fromName: from.username,
    to: targetUserId,
    type,
    tableId: t.id,
    expiresAt: Date.now() + CHALLENGE_MS,
  };
  challenges.set(cid, rec);
  lastChallengeAt.set(from.userId, Date.now());

  toUser(roomId, targetUserId, "games challenge", {
    id: cid,
    from: from.username,
    fromUserId: from.userId,
    type,
    gameName: rules.name,
    expiresAt: rec.expiresAt,
  });
  emitTable(t);
  emitFloor(roomId);
  return { ok: true, tableId: t.id };
}

function respondChallenge(roomId, userId, challengeId, accept) {
  const rec = challenges.get(challengeId);
  if (!rec || rec.to !== userId) return { err: "That challenge is gone." };
  challenges.delete(challengeId);
  const f = floorFor(rec.roomId);
  const t = f.tables.get(rec.tableId);
  if (!t) return { err: "That challenge is gone." };

  if (!accept) {
    dissolve(f, t, "declined");
    toUser(rec.roomId, rec.from, "games challenge result", {
      accepted: false,
      by: deps.userInfo(rec.roomId, userId)?.username || "They",
    });
    emitFloor(rec.roomId);
    return { ok: true };
  }

  const u = deps.userInfo(rec.roomId, userId);
  if (!u) return { err: "You left the room." };
  t.reservedFor = null;
  const other = tableOf(f, userId, t.type);
  if (other && other.id !== t.id) {
    dissolve(f, t, "busy");
    return { err: "You are already in a game of that." };
  }
  seatPlayer(f, t, { userId, username: u.username });
  maybeStart(f, t);
  toUser(rec.roomId, rec.from, "games challenge result", {
    accepted: true,
    by: u.username,
  });
  emitTable(t);
  emitFloor(rec.roomId);
  return { ok: true };
}

function userLeftRoom(roomId, userId) {
  const f = floors.get(roomId);
  if (!f) return;
  let touched = false;
  for (const [type, pool] of f.pools) {
    const at = pool.indexOf(userId);
    if (at >= 0) {
      pool.splice(at, 1);
      touched = true;
    }
  }
  for (const t of [...f.tables.values()]) {
    if (t.spectators.delete(userId)) touched = true;
    const up = t.nextUp.indexOf(userId);
    if (up >= 0) {
      t.nextUp.splice(up, 1);
      touched = true;
    }
    if (t.seats.some((s) => s.userId === userId)) {
      forfeit(f, t, userId);
      touched = true;
    }
    if (t.reservedFor && t.reservedFor.userId === userId) {
      dissolve(f, t, "gone");
      touched = true;
    }
  }
  for (const [cid, c] of challenges)
    if (c.roomId === roomId && (c.from === userId || c.to === userId))
      challenges.delete(cid);
  if (touched) {
    for (const type of f.pools.keys()) pump(f, type);
    emitFloor(roomId);
  }
  if (!f.tables.size && ![...f.pools.values()].some((p) => p.length))
    floors.delete(roomId);
}

function roomClosed(roomId) {
  floors.delete(roomId);
  for (const [cid, c] of challenges) if (c.roomId === roomId) challenges.delete(cid);
}

function snapshot(roomId, userId) {
  return {
    catalog: catalog(),
    ...floorFor_view(floorFor(roomId), userId),
  };
}

// ── Clock ───────────────────────────────────────────────────────────────────

function tick() {
  if (!deps) return;
  const now = Date.now();

  for (const [cid, c] of challenges) {
    if (now < c.expiresAt) continue;
    challenges.delete(cid);
    const f = floors.get(c.roomId);
    const t = f && f.tables.get(c.tableId);
    if (t) {
      dissolve(f, t, "expired");
      emitFloor(c.roomId);
    }
    toUser(c.roomId, c.from, "games challenge result", {
      accepted: false,
      expired: true,
    });
  }

  for (const [roomId, f] of [...floors]) {
    let floorChanged = false;

    for (const [type, pool] of f.pools) {
      const before = pool.length;
      for (let i = pool.length - 1; i >= 0; i--)
        if (!deps.userInfo(roomId, pool[i])) pool.splice(i, 1);
      if (pool.length !== before) floorChanged = true;
    }

    for (const t of [...f.tables.values()]) {
      const rules = rulesFor(t.type);
      if (!rules) continue;

      for (const uid of [...t.spectators]) {
        if (!deps.userInfo(roomId, uid)) {
          t.spectators.delete(uid);
          floorChanged = true;
        }
      }

      for (const s of [...t.seats]) {
        if (deps.userInfo(roomId, s.userId)) {
          t.missingSince.delete(s.userId);
          continue;
        }
        const since = t.missingSince.get(s.userId);
        if (!since) {
          t.missingSince.set(s.userId, now);
        } else if (now - since > GRACE_MS) {
          forfeit(f, t, s.userId);
          floorChanged = true;
        }
      }
      if (!f.tables.has(t.id)) continue;

      if (t.reservedFor && !deps.userInfo(roomId, t.reservedFor.userId)) {
        dissolve(f, t, "gone");
        floorChanged = true;
        continue;
      }

      if (t.state === "open" && t.openDeadline && now >= t.openDeadline) {
        if (t.seats.length >= rules.minPlayers) startMatch(t);
        else t.openDeadline = null;
        floorChanged = true;
        continue;
      }

      if (t.state === "playing" && t.game) {
        if (rules.tick && rules.tick(t.game, now)) {
          if (rules.isOver(t.game)) {
            finishMatch(t);
            floorChanged = true;
          } else {
            emitTable(t);
          }
          continue;
        }
        if (t.turnDeadline && now >= t.turnDeadline) {
          const who = rules.turnOf(t.game);
          const auto = rules.timeoutMove ? rules.timeoutMove(t.game) : null;
          const misses = who ? (t.misses.get(who) || 0) + 1 : 0;
          if (who) t.misses.set(who, misses);
          const seat = who ? t.seats.find((s) => s.userId === who) : null;

          if (who && misses >= MAX_MISSES) {
            if (seat) say(t, `${seat.username} stopped playing`);
            toUser(roomId, who, "games closed", { tableId: t.id, reason: "idle" });
            forfeit(f, t, who);
            floorChanged = true;
          } else if (who && auto) {
            rules.move(t.game, who, auto);
            toUser(roomId, who, "games timeout", {
              tableId: t.id,
              warning: MAX_MISSES - misses,
            });
            if (seat) say(t, `${seat.username} ran out of time`);
            if (rules.isOver(t.game)) {
              finishMatch(t);
              floorChanged = true;
            } else {
              armTurn(t);
              emitTable(t);
            }
          } else if (who) {
            forfeit(f, t, who);
            floorChanged = true;
          }
          continue;
        }
      }

      if (t.state === "finished" && t.rotateAt && now >= t.rotateAt) {
        rotate(f, t);
        floorChanged = true;
      }
    }

    if (floorChanged) emitFloor(roomId);
    if (!f.tables.size && ![...f.pools.values()].some((p) => p.length))
      floors.delete(roomId);
  }
}

function cheer(roomId, userId, tableId, emoji) {
  const f = floorFor(roomId);
  const t = f.tables.get(tableId);
  if (!t) return { err: "That game has finished." };
  if (CHEERS.indexOf(emoji) < 0) return { ok: true };
  if (!audienceOf(t).has(userId)) {
    if (!deps.userInfo(roomId, userId)) return { err: "You are not in this room." };
    t.spectators.add(userId);
    emitFloor(roomId);
  }
  const now = Date.now();
  if (now - (t.cheerAt.get(userId) || 0) < CHEER_GAP_MS) return { ok: true };
  t.cheerAt.set(userId, now);
  const u = deps.userInfo(roomId, userId) || {};
  emitRelay(t, {
    kind: "cheer",
    userId,
    username: u.username || "Someone",
    emoji,
  });
  return { ok: true };
}

module.exports = {
  init,
  catalog,
  snapshot,
  cheer,
  CHEERS,
  queueJoin,
  queueLeave,
  playNext,
  joinTable,
  leaveTable,
  makeMove,
  rematch,
  spectate,
  challenge,
  respondChallenge,
  chat,
  typing,
  voteRemove,
  drawStrokes,
  syncCanvas,
  isPlaying,
  flagImage: (token) => {
    const code = flagcdn.codeForToken(token);
    return code ? flagcdn.imageFor(code) : null;
  },
  userLeftRoom,
  roomClosed,
  emitFloor,
  GAMES,
  _tick: tick,
  _floors: floors,
};
