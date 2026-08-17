// server/games/flagguess.js
// Ten flags, everybody guessing at once.

const {
  COUNTRIES, BY_CODE, matches, isNearMiss, isAnyCountry, normalize,
} = require("./flags");
const flagcdn = require("./flagcdn");

const ROUNDS = 10;
const GUESS_MS = 24000;
const REVEAL_MS = 5500;
const OPEN_MS = 3000;

const MIX = [1, 1, 1, 2, 1, 2, 3, 2, 1, 3];

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickCountries() {
  const byTier = { 1: shuffled(COUNTRIES.filter((c) => c.tier === 1)),
                   2: shuffled(COUNTRIES.filter((c) => c.tier === 2)),
                   3: shuffled(COUNTRIES.filter((c) => c.tier === 3)) };
  const taken = new Set();
  const out = [];
  for (const want of MIX) {
    let pick = null;
    for (const tier of [want, 2, 1, 3]) {
      const pool = byTier[tier] || [];
      while (pool.length) {
        const c = pool.pop();
        if (taken.has(c.code)) continue;
        pick = c;
        break;
      }
      if (pick) break;
    }
    if (!pick) break;
    taken.add(pick.code);
    out.push(pick);
  }
  return out;
}

function create(players) {
  const picks = pickCountries().map((c) => ({
    code: c.code,
    name: c.name,
    token: flagcdn.tokenFor(c.code),
  }));
  flagcdn.warm(picks.map((p) => p.code));

  const state = {
    players: players.map((p) => ({
      userId: p.userId,
      username: p.username,
      score: 0,
      got: 0,
      joinedAt: Date.now(),
    })),
    picks,
    round: 0,
    phase: "opening",
    endsAt: Date.now() + OPEN_MS,
    guessed: [],
    misses: [],
    over: false,
  };
  return state;
}

function current(state) {
  return state.picks[state.round] || null;
}

function addScore(state, userId, n) {
  const p = state.players.find((x) => x.userId === userId);
  if (p) p.score += n;
}

function maskFor(state, now) {
  const pick = current(state);
  if (!pick) return "";
  const name = pick.name;
  const left = Math.max(0, state.endsAt - now);
  const elapsed = 1 - left / GUESS_MS;
  const letters = [];
  for (let i = 0; i < name.length; i++) if (/[a-z]/i.test(name[i])) letters.push(i);

  const shown = new Set();
  if (elapsed > 0.45 && letters.length) shown.add(letters[0]);
  if (elapsed > 0.7 && letters.length > 2) {
    let seed = 0;
    for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0;
    shown.add(letters[1 + (seed % Math.max(1, letters.length - 1))]);
  }
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (!/[a-z0-9]/i.test(ch)) out += ch === " " ? "  " : ch;
    else out += shown.has(i) ? ch : "_";
  }
  return out;
}

function pending(state) {
  return state.players
    .filter((p) => !state.guessed.some((g) => g.userId === p.userId))
    .map((p) => ({ userId: p.userId, username: p.username }));
}

function toReveal(state) {
  state.phase = "reveal";
  state.endsAt = Date.now() + REVEAL_MS;
}

function nextRound(state) {
  state.round++;
  state.guessed = [];
  state.misses = [];
  if (state.round >= state.picks.length) {
    state.phase = "done";
    state.over = true;
    state.endsAt = 0;
    return;
  }
  state.phase = "guessing";
  state.endsAt = Date.now() + GUESS_MS;
}

function move(state, userId, mv) {
  if (state.over) return { ok: false, err: "This game is over." };
  const me = state.players.find((p) => p.userId === userId);
  if (!me) return { ok: false, err: "You are not in this game." };
  if ((mv && mv.kind) !== "guess") return { ok: false, err: "Unknown action." };
  if (state.phase !== "guessing")
    return { ok: false, err: "Wait for the next flag." };
  if (state.guessed.some((g) => g.userId === userId))
    return { ok: false, err: "You already got this one." };

  const said = String(mv.text || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!normalize(said)) return { ok: false, err: "Type a country." };
  const pick = current(state);
  if (!pick) return { ok: false, err: "No flag up right now." };

  if (!matches(said, pick.code)) {
    return {
      ok: true,
      quiet: true,
      correct: false,
      known: isAnyCountry(said),
      close: isNearMiss(said, pick.code),
      chat: said,
    };
  }

  const now = Date.now();
  const frac = Math.max(0, Math.min(1, (state.endsAt - now) / GUESS_MS));
  const pts = 50 + Math.round(150 * frac);
  state.guessed.push({
    userId,
    username: me.username,
    pts,
    place: state.guessed.length + 1,
    ms: Math.max(0, GUESS_MS - (state.endsAt - now)),
  });
  me.got++;
  addScore(state, userId, pts);

  if (state.guessed.length >= state.players.length) toReveal(state);

  return {
    ok: true,
    correct: true,
    pts,
    place: state.guessed.length,
    announce: `${me.username} named it`,
    tone: "good",
  };
}

function tick(state, now) {
  if (state.over) return false;
  if (!state.endsAt || now < state.endsAt) return false;

  if (state.phase === "opening") {
    state.phase = "guessing";
    state.endsAt = now + GUESS_MS;
    return true;
  }
  if (state.phase === "guessing") {
    toReveal(state);
    return true;
  }
  if (state.phase === "reveal") {
    nextRound(state);
    return true;
  }
  return false;
}

function addPlayer(state, p) {
  if (state.over) return false;
  if (state.players.some((x) => x.userId === p.userId)) return false;
  state.players.push({
    userId: p.userId,
    username: p.username,
    score: 0,
    got: 0,
    joinedAt: Date.now(),
  });
  return true;
}

function removePlayer(state, userId) {
  state.players = state.players.filter((p) => p.userId !== userId);
  state.guessed = state.guessed.filter((g) => g.userId !== userId);
  if (!state.players.length) {
    state.over = true;
    state.phase = "done";
    return true;
  }
  if (state.phase === "guessing" && state.guessed.length >= state.players.length) {
    toReveal(state);
    return true;
  }
  return false;
}

function turnOf() {
  return null;
}

function isOver(state) {
  return !!state.over;
}

function result(state) {
  const ranked = state.players.slice().sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const tied = ranked.filter((p) => p.score === (top ? top.score : 0)).length > 1;
  return {
    winnerId: !top || tied || !top.score ? null : top.userId,
    draw: tied && !!top && top.score > 0,
    scores: ranked.map((p) => ({
      userId: p.userId,
      username: p.username,
      score: p.score,
    })),
  };
}

function view(state, userId) {
  const now = Date.now();
  const pick = current(state);
  const revealing = state.phase === "reveal" || state.phase === "done";
  const mine = state.players.find((p) => p.userId === userId);
  return {
    phase: state.phase,
    endsAt: state.endsAt,
    phaseMs:
      state.phase === "guessing"
        ? GUESS_MS
        : state.phase === "reveal"
          ? REVEAL_MS
          : OPEN_MS,
    round: state.round,
    totalRounds: state.picks.length,
    token: pick && state.phase !== "opening" ? pick.token : null,
    hint: pick && state.phase === "guessing" ? maskFor(state, now) : null,
    reveal: revealing && pick ? pick.name : null,
    guessed: state.guessed.map((g) => ({
      userId: g.userId,
      username: g.username,
      pts: g.pts,
      place: g.place,
    })),
    waitingOn: state.phase === "guessing" ? pending(state) : [],
    iGuessed: state.guessed.some((g) => g.userId === userId),
    canGuess:
      state.phase === "guessing" &&
      !!mine &&
      !state.guessed.some((g) => g.userId === userId),
    players: state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        score: p.score,
        got: p.got,
        gotThis: state.guessed.some((g) => g.userId === p.userId),
      })),
    over: state.over,
  };
}

module.exports = {
  id: "flagguess",
  name: "Guess the Flag",
  icon: { emoji: "🚩" },
  blurb: "Ten flags, everyone at once. Name the country before the rest.",
  howTo: [
    "A flag appears. Type the country it belongs to.",
    "The faster you get it, the more it scores. Everybody guesses at once.",
    "Common names count: UK, USA, Holland, Ivory Coast all work.",
    "Letters appear as the clock runs down if the room is stuck.",
    "Ten flags a game, and you can join one already running.",
  ],
  minPlayers: 1,
  maxPlayers: 20,
  turnBased: false,
  joinInProgress: true,
  openMs: 8000,
  create,
  move,
  turnOf,
  tick,
  isOver,
  result,
  view,
  addPlayer,
  removePlayer,
  _pickCountries: pickCountries,
  _maskFor: maskFor,
  ROUNDS,
  GUESS_MS,
};
