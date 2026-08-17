// server/keywatch.js
// One staff key, one person.

const SETTLE_MS = 20000;

const live = new Map();
const handled = new Set();

function join(hash, socketId, info) {
  if (!hash || !socketId) return;
  let group = live.get(hash);
  if (!group) live.set(hash, (group = new Map()));
  group.set(socketId, {
    deviceId: info.deviceId || null,
    network: info.network || null,
    userId: info.userId || null,
    since: Date.now(),
  });
}

function leave(hash, socketId) {
  const group = live.get(hash);
  if (!group) return;
  group.delete(socketId);
  if (!group.size) {
    live.delete(hash);
    handled.delete(hash);
  }
}

function holders(hash) {
  const group = live.get(hash);
  if (!group) return [];

  const parent = new Map();
  const find = (t) => {
    while (parent.get(t) !== t) {
      parent.set(t, parent.get(parent.get(t)));
      t = parent.get(t);
    }
    return t;
  };
  const add = (t) => {
    if (!parent.has(t)) parent.set(t, t);
    return find(t);
  };
  const union = (a, b) => {
    const ra = add(a);
    const rb = add(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const rootOf = new Map();
  for (const [socketId, s] of group) {
    const tokens = [];
    if (s.deviceId) tokens.push("d:" + s.deviceId);
    if (s.userId) tokens.push("u:" + s.userId);
    if (!tokens.length) continue;
    for (let i = 1; i < tokens.length; i++) union(tokens[0], tokens[i]);
    rootOf.set(socketId, add(tokens[0]));
  }

  const by = new Map();
  for (const [socketId, s] of group) {
    const token = rootOf.get(socketId);
    if (!token) continue;
    const key = find(token);
    let h = by.get(key);
    if (!h)
      by.set(
        key,
        (h = {
          key,
          networks: new Set(),
          since: s.since,
          sockets: 0,
          identified: false,
        }),
      );
    h.sockets++;
    h.since = Math.min(h.since, s.since);
    if (s.deviceId) h.identified = true;
    if (s.network) h.networks.add(s.network);
  }
  return [...by.values()];
}

function verdict(hash, now) {
  const at = now || Date.now();
  const list = holders(hash)
    .filter((h) => at - h.since >= SETTLE_MS)
    .filter((h) => h.identified);
  if (list.length < 2) return null;
  const placed = list.filter((h) => h.networks.size);
  if (placed.length < 2) return "watch";
  const seen = new Map();
  for (const h of placed)
    for (const n of h.networks) {
      const owner = seen.get(n);
      if (owner != null && owner !== h.key) return "watch";
      seen.set(n, h.key);
    }
  return "shared";
}

function summary(hash) {
  return holders(hash)
    .filter((h) => h.identified)
    .map((h) => ({
      id: h.key,
      sockets: h.sockets,
      networks: [...h.networks],
      since: h.since,
    }));
}

const markHandled = (hash) => handled.add(hash);
const wasHandled = (hash) => handled.has(hash);

module.exports = {
  join,
  leave,
  holders,
  verdict,
  summary,
  markHandled,
  wasHandled,
  SETTLE_MS,
};
