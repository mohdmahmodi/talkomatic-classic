// server/games/index.js
// The game floor for a room: pools, tables, seating, winner-stays rotation,
// challenges, forfeits and clocks. Knows nothing about any particular game.
//
// The idea that makes the "nobody waits" requirement fall out: a pool is not a
// line waiting for one table, it is a bucket. Whenever the bucket has enough
// people for another match, another table is spawned. Fifty people queueing
// tic tac toe get twenty five tables, not a queue.
//
// Everything is keyed on userId, never socket.id. Room joins here hand off
// between two sockets sharing one userId, so a socket-keyed seat would drop a
// player every time they walked from the lobby into a room.

// ── Adding a game ───────────────────────────────────────────────────────────
// Multiplayer game: write a rules module next to this file exposing
//   id, name, icon, blurb, howTo[], minPlayers, maxPlayers, turnBased,
//   create/move/turnOf/isOver/result/view  (+ optional tick, addPlayer,
//   removePlayer, timeoutMove, openMs, joinInProgress, shout)
// then require it and drop it in GAMES below. Nothing else needs touching:
// queueing, chat, spectating, forfeits and clocks all come for free.
//
// A game that runs on a clock rather than on turns sets realtime: true and
// adds input/frame/frameView. It then gets the 60 Hz lane further down instead
// of the one second one, and its own snapshots on the wire rather than a full
// table push per change. Pong is the worked example.
//
// Standalone game that runs on its own page: add an entry to EXTERNAL. It gets
// a card in the picker and opens in a frame, with no server side at all.
//
// Icons are one of { emoji }, { fa } (Font Awesome class) or { image } (path
// under public/), so a game can use whichever suits it.

const tictactoe = require("./tictactoe");
const connect4 = require("./connect4");
const wordrace = require("./wordrace");
const drawguess = require("./drawguess");
const flagguess = require("./flagguess");
const flagcdn = require("./flagcdn");
const pong = require("./pong");

// Order matters: this is the order the picker lists them in, most-played first.
const GAMES = { pong, drawguess, flagguess, tictactoe, connect4, wordrace };

// Games that live on their own page under public/games. No sockets, no seats,
// no server state; the panel just frames them.
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
  {
    id: "penalty",
    name: "Penalty",
    icon: { emoji: "⚽" },
    blurb: "Take the shot, beat the keeper.",
    url: "games/penalty/",
    solo: true,
    howTo: ["Pick your corner and shoot.", "The keeper reads you, so mix it up."],
  },
];

// Games worth telling the room about when one starts. The turn-based pair are
// deliberately not here: two people playing tic tac toe is not news, and it
// would fire every rotation. Pong is, because it is the one people watch.
const SHOUT_TYPES = { wordrace: true, drawguess: true, flagguess: true, pong: true };
const SHOUT_GAP_MS = 4 * 60 * 1000; // per room, per game type

// Winner keeps the seat in these; the timed group dissolves its table instead.
const WINNER_STAYS = { tictactoe: true, connect4: true, pong: true };

// Two clocks missed in a row and the seat goes to somebody who wants it.
const MAX_MISSES = 2;

const MAX_TABLES_PER_ROOM = 40;
const FINISH_MS = 12000; // result stays up this long before the seat changes
const CHALLENGE_MS = 60000;
const CHALLENGE_COOLDOWN_MS = 15000;
const GRACE_MS = 20000; // reconnect window before a missing player forfeits
const STREAK_CAP = 5; // champion rotates out after this many straight wins
const TICK_MS = 1000;
const CHAT_MAX = 80; // messages kept per game
const CHAT_LEN = 200;
const CHAT_MIN_GAP_MS = 700;
const CHAT_BURST = 6; // messages allowed inside the window below
const CHAT_BURST_MS = 9000;
const SAY_REPEAT_MS = 8000; // the same announcement will not repeat inside this
const TYPING_MS = 4000;

// Realtime lane. Only runs while a realtime game is actually being played, and
// stops itself the moment the last one ends.
const FRAME_MS = 16;
const CHEERS = ["👏", "🔥", "😱", "😂", "💪", "🎉"];
const CHEER_GAP_MS = 900;
const AUDIENCE_CACHE_MS = 500;

const floors = new Map(); // roomId -> floor
const challenges = new Map(); // challengeId -> record
const lastChallengeAt = new Map(); // userId -> ts
const liveTables = new Set(); // tables currently being simulated at 60 Hz

let deps = null;
let timer = null;
let frameTimer = null;
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

// The one table of this type a player may hold at a time.
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
      inviteRank: s.inviteRank || null,
    })),
    reservedFor: t.reservedFor
      ? { userId: t.reservedFor.userId, username: t.reservedFor.username }
      : null,
    spectators: t.spectators.size,
    streak: t.streak,
    openDeadline: t.openDeadline,
    matchNumber: t.matchNumber,
    // Precomputed so the client never has to work out whether a row is
    // joinable from three separate fields.
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
    // Watchers waiting on a seat here, and whether you are one of them.
    nextUp: nextUpList(t),
    iAmNext: t.nextUp.includes(userId),
    canPlayNext: !seated && !!rules && WINNER_STAYS[t.type] !== undefined,
    game: t.game && rules ? rules.view(t.game, userId) : null,
  };
}

// The floor list is deliberately light: table summaries and pool sizes only.
// Board state rides on the per-table event so a fifty person room does not
// resend twenty five boards every time somebody queues.
function floorFor_view(f, userId) {
  const pools = {};
  const myQueue = {};
  for (const [type, arr] of f.pools) {
    pools[type] = arr.length;
    const at = arr.indexOf(userId);
    if (at >= 0) myQueue[type] = at + 1;
  }
  const mine = {};
  // Headline numbers per game, so the picker can say who is playing what
  // without the client counting across every row.
  const counts = {};
  for (const type of Object.keys(GAMES))
    counts[type] = { playing: 0, waiting: 0, games: 0, live: 0, names: [] };
  // Tables where this person has claimed the next round, so the panel can give
  // those claims back when it closes without having each board open.
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

// Only people at the table (or watching it) need the board.
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

// Same thing for the 20 a second stream a realtime game puts out. Walking
// every socket on the server that often to find the same handful of people is
// the one part of this that would actually show up under load, so the list is
// worked out twice a second and reused in between.
function emitFrame(t, payload) {
  if (!deps) return;
  const now = Date.now();
  const stamp = t.seats.length + ":" + t.spectators.size;
  if (!t.audience || now - t.audienceAt > AUDIENCE_CACHE_MS || t.audienceStamp !== stamp) {
    t.audienceAt = now;
    t.audienceStamp = stamp;
    t.audience = deps.socketsInRoom(t.roomId).filter((s) => {
      const uid = deps.userIdOf(s);
      return (
        !!uid && (t.seats.some((x) => x.userId === uid) || t.spectators.has(uid))
      );
    });
  }
  const msg = { tableId: t.id, ...payload };
  for (const s of t.audience) if (s.connected) s.emit("games relay", msg);
}

function toUser(roomId, userId, event, payload) {
  if (!deps) return;
  for (const s of deps.socketsInRoom(roomId)) {
    if (deps.userIdOf(s) === userId) s.emit(event, payload);
  }
}

// "Somebody started Word Race" to the whole room, so the games nobody stumbles
// into get an audience. Skips whoever is already at the table, and one type can
// only shout once every SHOUT_GAP_MS however many boards open in between.
const lastShout = new Map(); // roomId:type -> when
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
    misses: new Map(), // consecutive missed clocks, resets on a real move
    chat: [],
    chatSeq: 0,
    lastChatAt: new Map(),
    nextUp: [], // watchers who asked for a seat when this round ends
    chatBurst: new Map(), // userId -> recent send times, caps a flood
    cheerAt: new Map(), // userId -> last cheer, one lane per person
    audience: null, // cached socket list for the realtime stream
    audienceAt: 0,
    audienceStamp: "",
    lastSaid: new Map(), // userId -> their last line, kills copy-paste repeats
    saidAt: new Map(), // announcement -> when, stops narration looping
    typing: new Map(), // userId -> expiry, drives "someone is typing"
    votes: new Map(), // targetUserId -> Set of voters
  };
  f.tables.set(t.id, t);
  return t;
}

// Every seat change runs through these two so the room status line, the AFK
// exemption and the event feed can never drift out of sync with the seats.
function seatPlayer(f, t, user) {
  if (t.seats.some((s) => s.userId === user.userId)) return;
  t.seats.push({
    userId: user.userId,
    username: user.username,
    role: user.role || null,
    avatar: user.avatar || null,
    inviteRank: user.inviteRank || null,
  });
  t.spectators.delete(user.userId);
  const rules = rulesFor(t.type);
  if (deps.setPlaying)
    deps.setPlaying(t.roomId, user.userId, true, rules ? rules.name : null);
  // Someone joining a game already underway takes a live seat too.
  if (t.state === "playing" && t.game && rules && rules.addPlayer) {
    rules.addPlayer(t.game, { userId: user.userId, username: user.username });
  }
  say(t, `${user.username} joined`);
  // Catch them up on the canvas, once.
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
  // They may still be sat at another game, so only clear the room status when
  // this was their last seat anywhere in the room.
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

// Narration. This is what makes a game feel busy rather than silent, right up
// until somebody works out they can flip a switch on and off and fill the feed
// with it. The same line does not go out twice in a row inside the window.
function say(t, text, tone) {
  const now = Date.now();
  if (now - (t.saidAt.get(text) || 0) < SAY_REPEAT_MS) return;
  t.saidAt.set(text, now);
  if (t.saidAt.size > 80)
    for (const [k, v] of t.saidAt) if (now - v > SAY_REPEAT_MS) t.saidAt.delete(k);
  pushChat(t, { kind: "system", text, tone: tone || null });
}

// One rate limiter for everything a person can put in the feed, so a guess box
// is not a way around the chat box.
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

// A wrong guess reads as a message from that person, marked so the client can
// colour it. Right ones are announced without ever printing the word.
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
    text, // masked per viewer in the browser, not here
  });
}

function audienceOf(t) {
  const ids = new Set(t.seats.map((s) => s.userId));
  for (const s of t.spectators) ids.add(s);
  return ids;
}

function dissolve(f, t, reason) {
  if (!f.tables.has(t.id)) return;
  liveTables.delete(t);
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
  if (rules.realtime && rules.frame) {
    liveTables.add(t);
    armFrames();
  }
  emitTable(t);

  // Tell the room, but only for the games that want a crowd, and only on the
  // first match at that board: a rematch is not news.
  if (SHOUT_TYPES[t.type] && t.matchNumber === 1) {
    const who = t.seats.length === 1 ? t.seats[0].username : null;
    shoutRoom(
      t,
      // A game with nothing to offer a joiner says so itself, because the
      // generic line below invites people into a seat that does not exist.
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
  if (t.reservedFor) return; // a challenge holds the seat until answered
  if (t.seats.length >= rules.maxPlayers) return startMatch(t);
  if (t.seats.length >= rules.minPlayers) {
    // Timed group games take late joiners for a moment before locking in;
    // a two seater has nothing to wait for once it is full.
    if (!rules.openMs) return;
    if (!t.openDeadline) t.openDeadline = Date.now() + rules.openMs;
  } else {
    t.openDeadline = null;
  }
}

// Fill open seats, then spawn tables while the pool can still fill one.
function pump(f, type) {
  const rules = rulesFor(type);
  if (!rules) return;
  const pool = poolFor(f, type);

  // Fill anything already running that still takes people (Draw & Guess) or
  // is waiting to start, before opening anything new.
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

  // One person left over with nowhere to sit gets their own board and waits
  // there, instead of watching a queue position on the floor. Only when this
  // game has nothing else running: if a board already exists, they queue for
  // it so the winner-stays rotation still feeds off the line.
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
    // Hand them their board even though it cannot start yet, so they wait at
    // it rather than on the floor.
    if (t.state === "open") emitTable(t);
  }
}

function finishMatch(t) {
  const rules = rulesFor(t.type);
  liveTables.delete(t);
  const res = rules.result(t.game);
  t.result = res;
  t.state = "finished";
  t.turnDeadline = null;
  t.rematch = new Set();
  t.votes = new Map();

  const winner = res.winnerId
    ? t.seats.find((s) => s.userId === res.winnerId)
    : null;
  // Named here once so the headline, the feed and the room all agree.
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

// What this particular viewer should be told happened. Working it out on the
// server means the client never has to infer a loss from a missing win.
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

// Seats change hands here: winner keeps theirs, everyone else goes back to the
// room, and the front of the pool fills the gap.
function rotate(f, t) {
  const rules = rulesFor(t.type);
  const pool = poolFor(f, t.type);

  // Watchers who asked for a seat go first, ahead of the room-wide queue: they
  // sat through the round, and they are already looking at this board.
  const waiting = t.nextUp.filter((uid) => deps.userInfo(t.roomId, uid));
  t.nextUp = [];

  if (!WINNER_STAYS[t.type]) {
    // Whoever asked for another round gets one, even if the rest of the table
    // did not. Requiring everybody meant one person wandering off ended the
    // game for the five who wanted to keep playing. The board stays up, so
    // anyone else can walk back in.
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
      // The watchers who put their hand up join this round too.
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
      pump(f, t.type); // fills the rest from the room queue
      maybeStart(f, t);
      if (t.state === "open") emitTable(t);
      emitFloor(f.roomId);
      return;
    }
    // Nobody wanted another. This board is going away, so a watcher's claim
    // moves to the front of the line for the next one rather than evaporating.
    for (const uid of waiting) if (!pool.includes(uid)) pool.unshift(uid);
    dissolve(f, t, "over");
    pump(f, t.type);
    emitFloor(f.roomId);
    return;
  }

  // Both sides asked for another and nobody is waiting, so let them have it.
  // Somebody who sat through the round waiting to play counts as waiting.
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
    keep = t.seats.slice(); // nobody waiting, a draw just plays on
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

  // Seat the watchers who put their hand up, then let the room queue fill
  // whatever is left.
  for (const uid of waiting) {
    if (t.seats.length >= rules.maxPlayers) {
      if (!pool.includes(uid)) pool.push(uid); // no room, back of the line
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

// A watcher asking for a seat at THIS board when the round ends. Without it a
// spectator had to leave the game, find the floor, and queue, by which time the
// winner had already been paired with somebody else.
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
  // Watching implies wanting to see it, so put them on the spectator list too.
  if (!t.spectators.has(user.userId)) t.spectators.add(user.userId);
  say(t, `${user.username} is up for the next round`);
  emitTable(t);
  emitFloor(roomId);
  return { ok: true };
}

// Everyone still in the room who asked for the next round here, in order.
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
  // A reconnect hands you a new socket, and the panel can be showing a game
  // you are no longer formally watching. Rather than refusing the message,
  // enrol them: anybody in the room is entitled to watch and talk.
  if (!audienceOf(t).has(user.userId)) {
    if (!deps.userInfo(t.roomId, user.userId))
      return { err: "You are not in this room." };
    t.spectators.add(user.userId);
    emitFloor(t.roomId);
  }

  let body = String(text || "").replace(/\s+/g, " ").trim().slice(0, CHAT_LEN);
  if (!body) return { ok: true };
  const last = t.lastChatAt.get(user.userId) || 0;
  if (Date.now() - last < CHAT_MIN_GAP_MS) return { err: "Slow down a moment." };
  // Saying "a" thirty times is under any per-message gap, so the same line
  // twice running is refused and a burst is capped on top of that.
  if (t.lastSaid.get(user.userId) === body.toLowerCase())
    return { err: "You just said that." };
  if (!canSpeak(t, user.userId))
    return { err: "That is a lot of messages. Give it a few seconds." };
  t.lastChatAt.set(user.userId, Date.now());
  t.lastSaid.set(user.userId, body.toLowerCase());
  // Sent as typed, the same as the room's own chat. Masking happens per viewer
  // in the browser, so somebody who turned the word filter off actually gets
  // what they asked for instead of pre-censored text.

  const playing = t.seats.some((s) => s.userId === user.userId);
  t.typing.delete(user.userId);

  // Some games treat plain chat as a play. Draw & Guess does: typing in the
  // feed is guessing, so there is no second box to find. The game decides;
  // the floor only asks. A line it does not claim falls through and is posted
  // as an ordinary message below.
  if (t.state === "playing" && t.game) {
    const rules = rulesFor(t.type);
    if (rules && rules.chatGuess) {
      const out = rules.chatGuess(t.game, user.userId, body);
      if (out && out.swallow) {
        // One letter off the answer. Posting it would spoil the word for
        // everybody, so the line is dropped without comment.
        return { ok: true };
      } else if (out) {
        t.misses.delete(user.userId); // they are clearly still here
        // The word itself is never echoed: that would hand it to everybody
        // still guessing. The announcement covers it.
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
  // Role and picture are stamped from the room record, never from the client,
  // so a badge cannot be faked by a patched page.
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

// Majority of the other players can put somebody out of a game. Kept to the
// people actually in it, so a room full of spectators cannot brigade a player.
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
  // Clicking again takes the vote back, so a misclick is not permanent.
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

// The drawing canvas is sent once on join and then kept current by deltas.
// This is the "catch me up" call for a joiner, a watcher, or a client that
// spots a gap in the revision numbers.
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

// Walking away from a live match hands the win to whoever is left.
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
      // Group games reshuffle around the gap instead of ending.
      const ended = rules.removePlayer(t.game, userId);
      if (rules.isOver(t.game)) return finishMatch(t);
      if (ended) emitTable(t);
      if (t.seats.length < rules.minPlayers) {
        t.game = null;
        t.state = "open";
        t.turnDeadline = null;
        liveTables.delete(t);
        maybeStart(f, t);
        emitTable(t);
      }
      return;
    }
    if (t.seats.length < rules.minPlayers) {
      // Two seater: the one still sitting there takes it. Ends the match
      // without going through finishMatch, so the lane is released here.
      liveTables.delete(t);
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
  t.misses.delete(userId); // they are still here

  // "Sarah guessed it" and friends land in the game feed, so everybody can see
  // that people are getting somewhere. A near miss goes in as the person said
  // it, which is half the fun of watching.
  if (out.announce) say(t, out.announce, out.tone);
  if (out.chat) pushGuess(t, userId, out.chat);

  if (rules.isOver(t.game)) {
    finishMatch(t);
    emitFloor(roomId);
    return { ok: true, ...out };
  }

  // A relay is a small delta for the whole table (a stroke, a score tick)
  // instead of resending the board to everyone.
  if (out.relay) emitRelay(t, out.relay);
  if (out.quiet) {
    // Only the mover's own view changed, and only some moves need it resent.
    // Strokes do not: the relay above already carries them.
    if (out.selfPush)
      toUser(roomId, userId, "games table", tableDetail(t, userId));
  } else {
    armTurn(t);
    emitTable(t);
  }
  return { ok: true, ...out };
}

// A drag arrives as a batch. Applying them one at a time meant one broadcast
// per segment; this applies the lot and sends a single relay.
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
  // These two only apply where a seat is scarce. In the timed games the board
  // stays up and anyone can walk into it, so asking for another round never
  // costs anybody else theirs.
  if (WINNER_STAYS[t.type]) {
    if (poolFor(f, t.type).length)
      return { err: "People are waiting, so the seat rotates." };
    // Somebody sat through the round to get a turn. Two players rematching
    // each other forever would step straight over them.
    if (t.nextUp.some((uid) => deps.userInfo(t.roomId, uid)))
      return { err: "Somebody is up next, so the seat rotates." };
  }

  const seat = t.seats.find((s) => s.userId === userId);
  // Clicking again takes it back, the same as every other vote here.
  if (t.rematch.has(userId)) {
    t.rematch.delete(userId);
    emitTable(t);
    return { ok: true };
  }
  t.rematch.add(userId);

  // Once everybody has asked, go now. Making them sit out the rest of the
  // countdown made the button look broken.
  const need = t.seats.length;
  const anyWaiting = t.nextUp.some((uid) => deps.userInfo(t.roomId, uid));
  if (t.rematch.size >= need && need >= rulesFor(t.type).minPlayers && !anyWaiting) {
    say(t, "Everyone wants another go. Here we go.");
    startMatch(t);
    emitFloor(roomId);
    return { ok: true };
  }
  // Said out loud, so the other side knows somebody is waiting on them.
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
  // Everyone at the game needs the new count and name list, not just the
  // person who started or stopped watching.
  emitTable(t);
  emitFloor(roomId);
  return { ok: true };
}

function challenge(roomId, from, targetUserId, type) {
  const rules = rulesFor(type);
  if (!rules) return { err: "Unknown game." };
  // Head to head is about the seat count, not about taking turns. Pong is two
  // people and nothing else, so asking somebody by name has to work there too.
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

// Everything this user is holding in this room, released at once.
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

    // Anyone who walked out of the room stops holding a seat or a queue slot.
    // Checked by sweep rather than a disconnect hook, because a room join here
    // hands off between two sockets and a hook would fire on the handoff.
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

          // One missed clock gets a move played for them. Two in a row and the
          // seat goes to somebody who actually wants it, so a player who walks
          // off cannot hold a board hostage.
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

// ── Realtime lane ───────────────────────────────────────────────────────────
// The one second clock above runs the whole floor. It is far too coarse for a
// game with a ball in it, and far too expensive to run at sixty: it walks every
// room, every table and every pool. So realtime games get their own timer that
// only ever touches the handful of tables actually mid-match, and only exists
// while at least one of them does.

function armFrames() {
  if (frameTimer || !liveTables.size) return;
  frameTimer = setInterval(frameTick, FRAME_MS);
  if (frameTimer.unref) frameTimer.unref();
}

function frameTick() {
  if (!deps) return;
  const now = Date.now();
  for (const t of [...liveTables]) {
    const f = floors.get(t.roomId);
    // Self healing rather than a delete on every path a match can end by:
    // rotate, forfeit and the room closing all leave the table in a state this
    // spots on the next frame.
    if (!f || f.tables.get(t.id) !== t || t.state !== "playing" || !t.game) {
      liveTables.delete(t);
      continue;
    }
    const rules = rulesFor(t.type);
    if (!rules || !rules.frame) {
      liveTables.delete(t);
      continue;
    }
    const out = rules.frame(t.game, now) || {};
    if (out.say) for (const line of out.say) say(t, line.text, line.tone || null);
    if (rules.isOver(t.game)) {
      liveTables.delete(t);
      finishMatch(t);
      emitFloor(t.roomId);
      continue;
    }
    if (out.push) emitFrame(t, { kind: "frame", f: rules.frameView(t.game) });
  }
  if (!liveTables.size && frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

// Paddle intent. This arrives up to forty times a second per player, so it
// answers nothing and broadcasts nothing: the next frame carries the result.
// A refusal here would mean a toast every twenty five milliseconds.
function realtimeInput(roomId, userId, tableId, inp) {
  const f = floors.get(roomId);
  if (!f) return { ok: true };
  const t = f.tables.get(tableId);
  if (!t || t.state !== "playing" || !t.game) return { ok: true };
  const rules = rulesFor(t.type);
  if (!rules || !rules.input) return { ok: true };
  if (!t.seats.some((s) => s.userId === userId)) return { ok: true };
  rules.input(t.game, userId, inp || {});
  return { ok: true };
}

// Watching a game and having nothing to do but type is a poor deal, so a
// watcher can throw an emoji at the board. It goes nowhere near the chat feed:
// cheering is meant to be spammable, and the feed is not.
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
  // Dropped in silence rather than refused: being told off for cheering twice
  // would be a strange thing to happen to somebody enjoying themselves.
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
  realtimeInput,
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
  // The flag proxy, wired to an express route. Takes the opaque round token
  // and gives back image bytes, so the country code is never in a url.
  flagImage: (token) => {
    const code = flagcdn.codeForToken(token);
    return code ? flagcdn.imageFor(code) : null;
  },
  userLeftRoom,
  roomClosed,
  emitFloor,
  GAMES,
  _tick: tick,
  _frameTick: frameTick,
  _liveCount: () => liveTables.size,
  _floors: floors,
};
