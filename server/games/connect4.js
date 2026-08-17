// server/games/connect4.js
// Rules only.

const COLS = 7;
const ROWS = 6;
const MARKS = ["R", "Y"];

function create(players, opts) {
  const first = (opts && opts.matchNumber ? opts.matchNumber : 0) % 2;
  return {
    cols: Array.from({ length: COLS }, () => []),
    players: players.map((p, i) => ({
      userId: p.userId,
      username: p.username,
      mark: MARKS[i],
    })),
    turn: first,
    winner: null,
    line: null,
    draw: false,
    moves: 0,
    last: null,
  };
}

function turnOf(state) {
  if (isOver(state)) return null;
  const p = state.players[state.turn];
  return p ? p.userId : null;
}

function at(state, c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
  return state.cols[c][r] || null;
}

function move(state, userId, mv) {
  if (isOver(state)) return { ok: false, err: "This match is over." };
  const idx = state.players.findIndex((p) => p.userId === userId);
  if (idx < 0) return { ok: false, err: "You are not in this match." };
  if (idx !== state.turn) return { ok: false, err: "Not your turn." };

  const c = Number(mv && mv.col);
  if (!Number.isInteger(c) || c < 0 || c >= COLS)
    return { ok: false, err: "Invalid column." };
  if (state.cols[c].length >= ROWS)
    return { ok: false, err: "That column is full." };

  const mark = state.players[idx].mark;
  state.cols[c].push(mark);
  const r = state.cols[c].length - 1;
  state.moves++;
  state.last = { col: c, row: r };

  const hit = lineThrough(state, c, r, mark);
  if (hit) {
    state.winner = userId;
    state.line = hit;
  } else if (state.moves === COLS * ROWS) {
    state.draw = true;
  } else {
    state.turn = 1 - state.turn;
  }
  return { ok: true };
}

function lineThrough(state, c, r, mark) {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dc, dr] of dirs) {
    const cells = [{ col: c, row: r }];
    for (const sign of [1, -1]) {
      let i = 1;
      for (;;) {
        const nc = c + dc * i * sign;
        const nr = r + dr * i * sign;
        if (at(state, nc, nr) !== mark) break;
        cells.push({ col: nc, row: nr });
        i++;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return null;
}

function timeoutMove(state) {
  const open = [];
  for (let c = 0; c < COLS; c++) if (state.cols[c].length < ROWS) open.push(c);
  if (!open.length) return null;
  return { col: open[Math.floor(Math.random() * open.length)] };
}

function isOver(state) {
  return !!state.winner || !!state.draw;
}

function result(state) {
  return {
    winnerId: state.winner || null,
    draw: !!state.draw,
    scores: state.players.map((p) => ({
      userId: p.userId,
      score: state.winner === p.userId ? 1 : 0,
    })),
  };
}

function view(state) {
  const grid = [];
  for (let r = ROWS - 1; r >= 0; r--) {
    for (let c = 0; c < COLS; c++) grid.push(at(state, c, r));
  }
  return {
    grid,
    cols: COLS,
    rows: ROWS,
    heights: state.cols.map((c) => c.length),
    players: state.players,
    turn: state.turn,
    turnUserId: turnOf(state),
    winner: state.winner,
    line: state.line,
    draw: state.draw,
    last: state.last,
  };
}

module.exports = {
  id: "connect4",
  name: "Connect Four",
  icon: { emoji: "🔴" },
  blurb: "Drop discs, get four in a line. Gravity does the rest.",
  howTo: [
    "Pick a column and your disc falls to the lowest free slot.",
    "Four in a row wins: across, up, or diagonally.",
    "You get 30 seconds a move. Miss two in a row and you lose the seat.",
  ],
  minPlayers: 2,
  maxPlayers: 2,
  turnBased: true,
  turnMs: 30000,
  create,
  move,
  turnOf,
  timeoutMove,
  isOver,
  result,
  view,
};
