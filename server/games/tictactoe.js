// server/games/tictactoe.js
// Rules only. No sockets, no timers, no knowledge of tables or queues.

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const MARKS = ["X", "O"];

function create(players, opts) {
  const first = (opts && opts.matchNumber ? opts.matchNumber : 0) % 2;
  return {
    board: Array(9).fill(null),
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
  };
}

function turnOf(state) {
  if (isOver(state)) return null;
  const p = state.players[state.turn];
  return p ? p.userId : null;
}

function seatOf(state, userId) {
  return state.players.findIndex((p) => p.userId === userId);
}

function move(state, userId, mv) {
  if (isOver(state)) return { ok: false, err: "This match is over." };
  const idx = seatOf(state, userId);
  if (idx < 0) return { ok: false, err: "You are not in this match." };
  if (idx !== state.turn) return { ok: false, err: "Not your turn." };

  const pos = Number(mv && mv.cell);
  if (!Number.isInteger(pos) || pos < 0 || pos > 8)
    return { ok: false, err: "Invalid square." };
  if (state.board[pos]) return { ok: false, err: "That square is taken." };

  state.board[pos] = state.players[idx].mark;
  state.moves++;

  const hit = winningLine(state.board);
  if (hit) {
    state.winner = userId;
    state.line = hit;
  } else if (state.moves === 9) {
    state.draw = true;
  } else {
    state.turn = 1 - state.turn;
  }
  return { ok: true };
}

function winningLine(board) {
  for (const l of LINES) {
    const [a, b, c] = l;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return l;
  }
  return null;
}

function timeoutMove(state) {
  const open = [];
  for (let i = 0; i < 9; i++) if (!state.board[i]) open.push(i);
  if (!open.length) return null;
  return { cell: open[Math.floor(Math.random() * open.length)] };
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
  return {
    board: state.board,
    players: state.players,
    turn: state.turn,
    turnUserId: turnOf(state),
    winner: state.winner,
    line: state.line,
    draw: state.draw,
  };
}

module.exports = {
  id: "tictactoe",
  name: "Tic Tac Toe",
  icon: { emoji: "❌" },
  blurb: "Three in a row. Quick games, quick rematches.",
  howTo: [
    "Take turns claiming a square.",
    "First to line up three of yours wins.",
    "You get 25 seconds a move. Miss two in a row and you lose the seat.",
  ],
  minPlayers: 2,
  maxPlayers: 2,
  turnBased: true,
  turnMs: 25000,
  create,
  move,
  turnOf,
  timeoutMove,
  isOver,
  result,
  view,
};
