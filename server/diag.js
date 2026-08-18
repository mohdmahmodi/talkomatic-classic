const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const state = require("./state");

const STORE_PATH = path.join(DATA_DIR, "service.json");

let fx = null;
let holdUntil = 0;
let holdScope = null;
let timer = null;
let open = true;

try {
  const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  if (raw && typeof raw.open === "boolean") open = raw.open;
} catch (_) {}

async function persist() {
  try {
    const tmp = STORE_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify({ open }, null, 2), "utf8");
    await fsp.rename(tmp, STORE_PATH);
  } catch (_) {}
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
  };
}

module.exports = {
  lag,
  drop,
  clear,
  onConnect,
  inboundDelay,
  blocked,
  locked,
  setGate,
  status,
};
