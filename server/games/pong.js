// server/games/pong.js
// Rules only. No sockets, no timers, no knowledge of tables or queues: the
// floor drives this with frame(state, now) off its 60 Hz lane.
//
// This is the first game here that is not turn based, so a note on how it is
// kept honest and kept smooth at the same time.
//
// The server owns everything. A client never sends a paddle position, it sends
// where it would LIKE its paddle to be, and the paddle walks toward that at a
// fixed speed. A patched page can ask for anything it wants and still only
// moves as fast as everybody else.
//
// The ball travels in straight lines and only ever changes direction at an
// event: a wall, a paddle, a point. So the wire does not need a position sixty
// times a second. It needs the breakpoints, sent the instant they happen, plus
// a slow heartbeat to cover a dropped packet. Between two breakpoints the
// browser reconstructs the exact path the server took, because the path is
// arithmetic, not a guess. That is why the ball looks glued to the physics
// instead of sliding between samples.

// Court units. The browser scales these to whatever space it has, so nothing
// here is in pixels and the game plays identically on a phone and a monitor.
const W = 200;
const H = 120;

const WALL = 4; // gap between the end of the court and the back of a paddle
const PADDLE_W = 2.4;
const PADDLE_H = 22;
const BALL_R = 1.9;

const LEFT_FACE = WALL + PADDLE_W;
const RIGHT_FACE = W - WALL - PADDLE_W;
const MIN_Y = PADDLE_H / 2;
const MAX_Y = H - PADDLE_H / 2;

// The ball crosses the court in 2.7s at serve speed and 1.07s flat out, so a
// rally can always be reached: losing a point is a read, never a sprint you
// were never going to win. That was true at 110 and at 175 as well - reaching
// was never the problem.
//
// This is the number that decides whether the game feels connected to your
// hand, and it was the answer to a long hunt through the netcode for a lag
// that was never in the netcode.
//
// At 175 the paddle took 560ms to cross the court. Players described it,
// exactly, as "I try to move up and it moves me up 600ms later". Worse, the
// ball's vertical component reaches 152 u/s on a steep return, so a paddle at
// 175 out-paced the ball it was trying to track by 1.15x - meaning that while
// following a fast rally the paddle was permanently behind and never caught
// up. That reads as lag no matter how good the network is, and it is why it
// was reported as lag on a LAN too.
//
// The rule now is that the paddle must comfortably out-run the thing it is
// asked to follow: roughly three times the ball's steepest vertical speed. The
// court takes about 210ms to cross, which is quick enough that a hand never
// feels the cap during ordinary play, and still a cap - a patched client
// cannot teleport onto the ball, and the server holds everyone to it.
const PADDLE_SPEED = 460;
// Holding a key is a different thing from pointing at a spot. A pointer says
// "be here", and the only honest answer is to be there; a key says "keep
// going", and at 900 a tap would send the paddle across the whole court before
// you let go. So the two inputs get their own ceilings. Both are still far
// above the 152 u/s the ball manages vertically, so neither can be outrun by
// the thing it is chasing - which was the whole complaint.
const KEY_SPEED = 460;
// The most one-way delay anybody is ever credited for, honest or otherwise.
// 60ms of travel is about one paddle height, which is enough to cover a real
// return that this end had not caught up with yet, and small enough that
// claiming a worse connection than you have buys you very little.
const COMP_CAP_MS = 60;
// Spin is still computed off the OLD speed. It is "a moving paddle drags the
// ball with it", and it was tuned against a paddle that moved at 175; feeding
// it a number two and a half times bigger would not make the game feel more
// connected, it would just make every return off a moving paddle fly. The
// bounce is deliberately unchanged by this.
const SPIN_CAP = 175;
const BASE_SPEED = 70;
const SPEED_STEP = 1.05;
const MAX_SPEED = 175;

const MAX_BOUNCE = Math.PI / 3; // 60 degrees off the middle of the paddle
const SPIN = 0.14; // a moving paddle drags the ball with it

// A ball returned from the exact middle of a still paddle would come back dead
// flat, straight into the middle of the other paddle, and back again forever.
// Nudging it off the horizontal by a hair costs nothing to play against and
// means every rally is going somewhere: over one length of the court this is
// enough drift to walk the ball off the end of a paddle that never moves.
const MIN_VY_FRAC = 0.06;

const TARGET = 7;
const STEP_MS = 1000 / 60;
const MAX_CATCHUP = 6; // physics steps one frame may swallow
// Heartbeat snapshot every physics step, so sixty a second. The opponent's
// paddle only exists between real samples, drawn far enough in the past that a
// sample sits either side of the drawing moment - so the snapshot gap IS the
// floor on how fresh that paddle can ever be. Halving the gap took the far
// paddle from ~45ms behind to ~30ms behind for a few kilobytes a second per
// person at the board, which is the cheapest latency on offer anywhere in
// this file.
const PUSH_EVERY = 1;
const SERVE_MS = 1500;
const FIRST_SERVE_MS = 2600;
// Two ways to notice somebody has walked off. The counter is the one that
// usually fires: an opponent who never moves loses seven nil in about twenty
// five seconds, so a plain input timeout is a race with the scoreline and the
// room ends up reading a fake whitewash instead of what actually happened.
// Conceding three points in a row without the paddle twitching once is not a
// bad run, it is an empty chair, and it is caught in about ten seconds.
const STILL_POINTS = 3;
const IDLE_MS = 25000; // backstop: no input at all for this long during a rally
const MATCH_CAP_MS = 7 * 60 * 1000;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const r2 = (n) => Math.round(n * 100) / 100;

function create(players, opts) {
  const now = Date.now();
  const matchNumber = (opts && opts.matchNumber) || 0;
  return {
    players: players.slice(0, 2).map((p, i) => ({
      userId: p.userId,
      username: p.username,
      side: i, // 0 is the left paddle
      score: 0,
      y: H / 2,
      vy: 0,
      dir: 0, // keyboard: -1, 0, 1
      targetY: null, // pointer: where they want the paddle
      lastInputAt: now,
      // The highest intent number from this player that has actually been
      // applied here. It goes back out on every snapshot, and it is the whole
      // reason the browser can predict its own paddle without fighting this
      // one: it can see exactly how far behind the server's copy is and
      // rebuild the rest from intents it knows are still in the wire.
      ack: 0,
      lagMs: 0, // measured round trip, for lag compensation
      hits: 0,
      stirred: false, // paddle actually moved during this point
      still: 0, // points conceded in a row without it moving at all
    })),
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: BASE_SPEED, past: false },
    phase: "serve",
    // Alternate who receives the opening serve between matches at the same
    // board, so holding a seat is not a standing advantage.
    serveTo: matchNumber % 2,
    serveAt: now + FIRST_SERVE_MS,
    rally: 0,
    bestRally: 0,
    lastPoint: null, // { by, rally } so the browser can say what just happened
    winner: null,
    idleOut: null,
    over: false,
    startedAt: now,
    lastStepAt: now,
    simAt: now, // the clock time the simulated position actually belongs to
    acc: 0,
    skew: 0, // wall time a stall swallowed and the simulation never ran

    since: 0, // steps since the last snapshot
    pushNow: true,
  };
}

function seatOf(state, userId) {
  return state.players.findIndex((p) => p.userId === userId);
}

// ── Input ───────────────────────────────────────────────────────────────────
// Never a position, only an intent. Both shapes end at the same speed cap.

function input(state, userId, inp) {
  if (state.over) return false;
  const p = state.players[seatOf(state, userId)];
  if (!p) return false;
  p.lastInputAt = Date.now();
  // Intents can only ever go forwards. A reordered or replayed one is dropped
  // rather than applied late, because applying it would move the paddle back
  // to somewhere the player has already left and the browser, which numbered
  // it in the first place, would have no way to know that had happened.
  // The client echoes the timestamp of the newest frame it has seen. Both
  // ends of that are numbers this server minted, so the round trip is measured
  // here rather than reported by the browser: the only way to game it is to
  // echo an older frame and claim to be further away, which the cap bounds.
  if (inp && inp.r) {
    const rtt = clamp(Date.now() - Number(inp.r), 0, 400);
    if (Number.isFinite(rtt))
      p.lagMs = p.lagMs ? p.lagMs + (rtt - p.lagMs) * 0.2 : rtt;
  }
  if (inp && inp.n !== undefined) {
    const n = Number(inp.n);
    if (!Number.isFinite(n) || n <= p.ack) return false;
    p.ack = n;
  }
  if (inp && inp.d !== undefined) {
    const d = Number(inp.d);
    p.dir = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (p.dir) p.targetY = null;
    return true;
  }
  if (inp && inp.y !== undefined) {
    const y = Number(inp.y);
    if (!Number.isFinite(y)) return false;
    p.targetY = clamp(y, MIN_Y, MAX_Y);
    p.dir = 0;
    return true;
  }
  return false;
}

// The floor's ordinary move path, kept so a client that falls back to it still
// works. Quiet, because a paddle nudge must never redraw the whole table.
function move(state, userId, mv) {
  if (!input(state, userId, mv || {}))
    return { ok: false, err: "Not your paddle." };
  return { ok: true, quiet: true };
}

// ── Physics ─────────────────────────────────────────────────────────────────

// Where a paddle would already be if its owner's intent had reached us the
// instant they gave it. Never further than the intent actually asks for, and
// never more than the compensation ceiling allows.
function leadOf(p, py, capMs) {
  const comp = clamp((p.lagMs || 0) * 0.5, 0, capMs);
  if (comp <= 0) return py;
  let want = py;
  if (p.dir) want = py + p.dir * H;
  else if (p.targetY != null) want = p.targetY;
  const room = (p.dir ? KEY_SPEED : PADDLE_SPEED) * (comp / 1000);
  return clamp(py + clamp(want - py, -room, room), MIN_Y, MAX_Y);
}

function movePaddles(state, dt) {
  for (const p of state.players) {
    const before = p.y;
    let want = p.y;
    if (p.dir) want = p.y + p.dir * H;
    else if (p.targetY != null) want = p.targetY;
    const room = (p.dir ? KEY_SPEED : PADDLE_SPEED) * dt;
    p.y = clamp(p.y + clamp(want - p.y, -room, room), MIN_Y, MAX_Y);
    p.vy = (p.y - before) / dt;
    if (Math.abs(p.y - before) > 0.01) p.stirred = true;
  }
}

// Where the ball leaves the paddle. Middle of the paddle sends it back flat,
// the ends send it away at 60 degrees, and a paddle that is moving drags the
// ball with it. That one line is the whole skill ceiling of Pong: you are not
// returning the ball, you are choosing where it goes next.
function bounce(state, idx, p, py, evs) {
  const b = state.ball;
  const off = clamp((b.y - py) / (PADDLE_H / 2), -1, 1);
  const speed = Math.min(MAX_SPEED, b.speed * SPEED_STEP);
  const away = idx === 0 ? 1 : -1;

  let vx = Math.cos(off * MAX_BOUNCE) * speed * away;
  let vy = Math.sin(off * MAX_BOUNCE) * speed + clamp(p.vy, -SPIN_CAP, SPIN_CAP) * SPIN;

  // Spin can push the total over the speed we just set, so renormalise.
  const mag = Math.hypot(vx, vy) || speed;
  vx = (vx / mag) * speed;
  vy = (vy / mag) * speed;

  // And it must never bend the ball so steep that it crawls up and down the
  // court forever. 60 degrees is the limit in both directions.
  const minVx = Math.cos(MAX_BOUNCE) * speed;
  if (Math.abs(vx) < minVx) {
    vx = away * minVx;
    vy = Math.sign(vy || 1) * Math.sqrt(Math.max(0, speed * speed - vx * vx));
  }

  // And never perfectly flat. Which way it tips follows where it hit, so this
  // is not a coin toss the player cannot read: it is the same rule as the
  // angle, just refusing to round down to nothing.
  const minVy = speed * MIN_VY_FRAC;
  if (Math.abs(vy) < minVy) {
    const tip = off !== 0 ? Math.sign(off) : b.vy !== 0 ? Math.sign(b.vy) : 1;
    vy = tip * minVy;
    vx = away * Math.sqrt(Math.max(0, speed * speed - vy * vy));
  }

  b.speed = speed;
  b.vx = vx;
  b.vy = vy;
  b.x = idx === 0 ? LEFT_FACE + BALL_R + 0.01 : RIGHT_FACE - BALL_R - 0.01;
  p.hits++;
  state.rally++;
  evs.push(idx === 0 ? "hit0" : "hit1");
}

function point(state, by, now, evs, say) {
  const scorer = state.players[by];
  const other = state.players[1 - by];
  if (!scorer) return;
  scorer.score++;
  // Only the player who let it past is judged. Someone who kept still because
  // the ball kept coming straight at them was winning those points, not
  // sitting them out.
  if (other) {
    other.still = other.stirred ? 0 : other.still + 1;
    other.stirred = false;
  }
  // Winning the point does not clear it. A paddle parked dead centre blocks a
  // fair few balls on its own, and letting that reset the count meant an empty
  // chair could sit through most of a match on luck.
  scorer.stirred = false;
  state.lastPoint = { by, rally: state.rally };
  if (state.rally > state.bestRally) state.bestRally = state.rally;
  evs.push("point" + by);

  if (state.rally >= 10)
    say.push({ text: `${state.rally} shot rally, ${scorer.username} takes it` });

  if (scorer.score >= TARGET) {
    state.winner = scorer.userId;
    state.phase = "over";
    state.over = true;
    return;
  }

  say.push({
    text:
      scorer.score === other.score
        ? `${scorer.score} all`
        : `${scorer.username} ${scorer.score} - ${other.score} ${other.username}`,
  });
  if (scorer.score === TARGET - 1)
    say.push({ text: `Match point, ${scorer.username}`, tone: "good" });

  state.rally = 0;
  state.phase = "serve";
  state.serveTo = 1 - by; // the ball goes to whoever just conceded
  state.serveAt = now + SERVE_MS;
  const b = state.ball;
  b.x = W / 2;
  b.y = H / 2;
  b.vx = 0;
  b.vy = 0;
  b.speed = BASE_SPEED;
  b.past = false;
}

function launch(state, evs) {
  const b = state.ball;
  const ang = (Math.random() * 2 - 1) * 0.42; // up to 24 degrees off flat
  const away = state.serveTo === 0 ? -1 : 1;
  b.x = W / 2;
  b.y = H / 2;
  b.speed = BASE_SPEED;
  b.vx = Math.cos(ang) * BASE_SPEED * away;
  b.vy = Math.sin(ang) * BASE_SPEED;
  b.past = false;
  state.phase = "live";
  evs.push("serve");
}

// One physics step. Swept, not sampled: the ball is walked to the first thing
// it actually touches inside the step and bounced there. At full speed it
// covers 2.9 units a step and a paddle is 2.4 wide, so sampling positions
// would let it pass straight through one.
function step(state, dt, now, evs, say) {
  // Kept so the ball can be tested against where the paddle actually was at
  // the instant it crossed, not where it ended the step. A paddle covers three
  // units in a step, more than its own thickness, so testing the end position
  // turned fair edge hits into misses and the ball sailed past a paddle it had
  // visibly touched.
  for (const p of state.players) p.yPrev = p.y;
  movePaddles(state, dt);

  if (state.phase === "serve") {
    if (now >= state.serveAt) launch(state, evs);
    return;
  }
  if (state.phase !== "live") return;

  const b = state.ball;
  let left = dt;
  let guard = 0;
  while (left > 1e-6 && guard++ < 8) {
    let span = left;
    let hit = null;

    if (b.vy < 0) {
      const t = (BALL_R - b.y) / b.vy;
      if (t >= 0 && t < span) {
        span = t;
        hit = "wall";
      }
    } else if (b.vy > 0) {
      const t = (H - BALL_R - b.y) / b.vy;
      if (t >= 0 && t < span) {
        span = t;
        hit = "wall";
      }
    }

    // Once the ball is behind a paddle the plane is done with for this point,
    // otherwise the crossing keeps solving at zero and the loop spins.
    if (!b.past) {
      if (b.vx < 0) {
        const t = (LEFT_FACE + BALL_R - b.x) / b.vx;
        if (t >= 0 && t < span) {
          span = t;
          hit = "p0";
        }
      } else if (b.vx > 0) {
        const t = (RIGHT_FACE - BALL_R - b.x) / b.vx;
        if (t >= 0 && t < span) {
          span = t;
          hit = "p1";
        }
      }
    }

    b.x += b.vx * span;
    b.y += b.vy * span;
    left -= span;

    if (hit === "wall") {
      b.vy = -b.vy;
      b.y = clamp(b.y, BALL_R, H - BALL_R);
      evs.push("wall");
      continue;
    }
    if (hit === "p0" || hit === "p1") {
      const idx = hit === "p0" ? 0 : 1;
      const p = state.players[idx];
      // How far into the step the crossing happened, and therefore where the
      // paddle had got to by then.
      const at = dt > 0 ? clamp((dt - left) / dt, 0, 1) : 1;
      const py = p ? p.yPrev + (p.y - p.yPrev) * at : 0;
      if (!p) {
        b.past = true;
        continue;
      }
      // Lag compensation.
      //
      // This paddle is chasing an intent that left the player's machine one
      // uplink ago, so their screen has ALWAYS shown it further along than we
      // have it here. The faster the paddle, the wider that gap: at 460 u/s
      // and 60ms it is well over a paddle height. Judging the hit on our copy
      // alone means telling somebody who watched themselves make a clean
      // return that they missed it, which is the single most infuriating
      // thing a game can do.
      //
      // So the paddle is credited the travel that intent would already have
      // finished, and the ball counts as returned anywhere along that sweep.
      // Bounded twice over: by how far it actually still has to go, and by a
      // measured one-way delay with a hard ceiling. A player on a good line
      // gets almost none of this; nobody gets more than the ceiling however
      // bad, or however dishonest, their connection claims to be.
      const lead = leadOf(p, py, COMP_CAP_MS);
      const lo = Math.min(py, lead) - PADDLE_H / 2 - BALL_R;
      const hi = Math.max(py, lead) + PADDLE_H / 2 + BALL_R;
      if (b.y >= lo && b.y <= hi) {
        // Bounce off the point along that sweep nearest the ball, so the angle
        // is the one the player was actually aiming with.
        const use = clamp(b.y, Math.min(py, lead), Math.max(py, lead));
        bounce(state, idx, p, use, evs);
      } else b.past = true; // missed it, so let it run through to the back wall
      continue;
    }
  }

  if (b.x + BALL_R < 0) point(state, 1, now, evs, say);
  else if (b.x - BALL_R > W) point(state, 0, now, evs, say);
}

// ── The floor's realtime lane calls this ────────────────────────────────────

function frame(state, now) {
  if (state.over) return { push: false };

  const evs = [];
  const say = [];

  // A stalled event loop must not fast forward a second of physics into one
  // frame: that is how a ball ends up on the wrong side of a paddle.
  let elapsed = now - state.lastStepAt;
  state.lastStepAt = now;
  if (elapsed < 0) elapsed = 0;
  const budget = MAX_CATCHUP * STEP_MS;
  if (elapsed > budget) {
    // Time this simulation is never going to run. It has to be remembered
    // rather than quietly forgotten: the snapshot carries a timestamp, and if
    // that timestamp keeps pace with the wall clock while the ball does not,
    // every browser is told the ball is somewhere it will not reach for
    // another fifth of a second and dutifully draws it there. A host that
    // hitches should cost a hitch, not a court that is permanently lying about
    // where the ball is.
    state.skew += elapsed - budget;
    elapsed = budget;
  }
  state.acc += elapsed;

  let steps = 0;
  while (state.acc >= STEP_MS && steps < MAX_CATCHUP) {
    state.acc -= STEP_MS;
    steps++;
    step(state, STEP_MS / 1000, now, evs, say);
    if (state.over) break;
  }
  state.since += steps;
  // Physics runs on a fixed step, so at the moment this returns the ball is
  // wherever the last whole step left it - up to one step behind the wall
  // clock. Stamping the snapshot with the wall clock instead would tell the
  // browser the ball was somewhere it will not be for another 16ms, and it
  // would faithfully reconstruct that error. This is the time the position on
  // the wire genuinely belongs to.
  state.simAt = now - state.acc - state.skew;

  if (!state.over) {
    // Somebody who walked off would otherwise sit there conceding points until
    // seven: a hollow win for the other player, and half a minute of the queue
    // behind them watching an empty chair lose.
    for (const p of state.players) {
      const gone =
        p.still >= STILL_POINTS ||
        (now - p.lastInputAt > IDLE_MS && now - state.startedAt > IDLE_MS);
      if (!gone) continue;
      const other = state.players[1 - p.side];
      state.idleOut = p.userId;
      state.winner = other ? other.userId : null;
      state.phase = "over";
      state.over = true;
      say.push({ text: `${p.username} stopped playing` });
      break;
    }
  }

  // Nobody is getting to seven. Whoever is ahead takes it rather than the
  // board running all afternoon.
  if (!state.over && now - state.startedAt > MATCH_CAP_MS) {
    const [a, b] = state.players;
    state.phase = "over";
    state.over = true;
    state.winner = a.score === b.score ? null : a.score > b.score ? a.userId : b.userId;
    say.push({ text: "Time. The board goes to the higher score." });
  }

  const push = state.pushNow || evs.length > 0 || state.since >= PUSH_EVERY;
  if (push) {
    state.pushNow = false;
    state.since = 0;
  }
  return { push, events: evs, say };
}

// The wire snapshot. Small on purpose: this is the thing that goes out twenty
// times a second to everybody at the board, players and watchers alike.
function frameView(state) {
  const [a, b] = state.players;
  return {
    t: state.simAt || Date.now(),
    b: [r2(state.ball.x), r2(state.ball.y), r2(state.ball.vx), r2(state.ball.vy)],
    p: [r2(a ? a.y : H / 2), r2(b ? b.y : H / 2)],
    // How far through each player's intents this position accounts for.
    k: [a ? a.ack : 0, b ? b.ack : 0],
    s: [a ? a.score : 0, b ? b.score : 0],
    ph: state.phase,
    sa: state.phase === "serve" ? state.serveAt : 0,
    to: state.serveTo,
    r: state.rally,
    sp: r2(state.ball.speed),
  };
}

// Sent once when a board opens or somebody starts watching. Carries the court
// dimensions too, so nothing about the geometry is duplicated in the browser.
function view(state, userId) {
  return {
    court: {
      w: W,
      h: H,
      wall: WALL,
      paddleW: PADDLE_W,
      paddleH: PADDLE_H,
      ballR: BALL_R,
      baseSpeed: BASE_SPEED,
      maxSpeed: MAX_SPEED,
      paddleSpeed: PADDLE_SPEED,
      keySpeed: KEY_SPEED,
      // The browser runs this same bounce to predict the ball against its own
      // paddle, so the numbers behind it go out with the geometry rather than
      // being written down a second time over there. Two copies of a rule this
      // fiddly would drift the first time one of them was tuned, and the
      // symptom - a ball that leaves your paddle at a slightly different angle
      // than the server thinks - is close to impossible to spot by eye.
      speedStep: SPEED_STEP,
      bounceMax: MAX_BOUNCE,
      spin: SPIN,
      spinCap: SPIN_CAP,
      minVy: MIN_VY_FRAC,
    },
    target: TARGET,
    players: state.players.map((p) => ({
      userId: p.userId,
      username: p.username,
      side: p.side,
      score: p.score,
      hits: p.hits,
    })),
    mySide: seatOf(state, userId),
    bestRally: state.bestRally,
    lastPoint: state.lastPoint,
    winner: state.winner,
    over: state.over,
    frame: frameView(state),
  };
}

function turnOf() {
  return null; // realtime, both paddles are always live
}

function isOver(state) {
  return !!state.over;
}

function result(state) {
  return {
    winnerId: state.winner || null,
    draw: !state.winner,
    forfeit: !!state.idleOut,
    scores: state.players.map((p) => ({ userId: p.userId, score: p.score })),
  };
}

// The room-wide "come and watch this" line. The generic one offers a seat,
// which is wrong here: a match is two people and there is no third chair.
function shout(seats, name) {
  if (seats.length < 2) return `${seats[0].username} is waiting for a game of ${name}.`;
  return `${seats[0].username} and ${seats[1].username} are playing ${name}. Come and watch.`;
}

module.exports = {
  id: "pong",
  name: "Pong",
  icon: { emoji: "🏓" },
  blurb: "One on one, first to seven. Winner keeps the board.",
  howTo: [
    "You score when the ball gets past the other player's paddle. First to seven takes the board.",
    "Move your paddle with the mouse, a finger on the court, or W and S.",
    "Where the ball hits your paddle decides the angle it leaves at. The middle sends it back flat, the ends send it away steep.",
    "A moving paddle drags the ball with it, and every return makes it faster.",
    "First to seven wins and keeps the board. Everyone else can watch, chat and cheer.",
  ],
  minPlayers: 2,
  maxPlayers: 2,
  turnBased: false,
  realtime: true,
  create,
  move,
  input,
  frame,
  frameView,
  turnOf,
  isOver,
  result,
  view,
  shout,
};
