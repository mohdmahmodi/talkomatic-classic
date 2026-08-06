// server/keywatch.js
// One staff key, one person. This watches for a key being held by two
// different people at the same moment and says so plainly.
//
// The hard part is not spotting two connections - staff open several all the
// time - it is spotting two PEOPLE without accusing one person of being two.
// Three things get confused for sharing and none of them are:
//
//  - Several sockets from one browser. Joining a room alone opens two, and the
//    dashboard, the Desk and a room tab are three more.
//  - An address that changes. IPv6 privacy addresses rotate within the same
//    /64 constantly, and phones hop between mobile data and wifi. So addresses
//    are compared as NETWORKS (/64 or /24), never as exact addresses, and a
//    changed network on its own is never treated as a second person.
//  - A dual-stack browser. One tab reaches us over IPv6 and another over IPv4,
//    which are two different networks belonging to one machine sitting in one
//    place. Nothing can pair those two addresses up, so the test below never
//    relies on a network being unique to a person - only on the two people
//    having no network in common at all.
//  - A moment of overlap. A reconnect, a page navigation, or the room handoff
//    leaves the old socket alive for a second or two while the new one starts.
//
// So the rule is deliberately narrow: two different CLIENT IDENTIFIERS, on two
// sets of NETWORKS with nothing in common, both live, both settled. That is a
// second browser on a second connection - which is a second person - and it is
// the one shape none of the innocent cases above can produce.

const SETTLE_MS = 20000; // how long an overlap must last before it counts

// hash -> Map(socketId -> { deviceId, network, userId, since })
const live = new Map();
// Keys already actioned, so a dozen sockets do not fire a dozen revokes.
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

// Everyone currently on this key, one entry per identity rather than per
// socket - the count that matters is people, not tabs.
//
// A socket carries up to two ways of naming who is behind it: the browser's
// device id, and the session id its tabs share. Either one matching another
// socket is proof of the same person, and BOTH have to be followed at once,
// because not every page sends a device id - the dashboard and the Desk do
// not. Keying on "device id, or else session id" put those sockets in a group
// of their own, and a moderator with the dashboard open beside a room read as
// two people holding one key.
function holders(hash) {
  const group = live.get(hash);
  if (!group) return [];

  // Union-find over the identifiers, so any chain of shared ids collapses to
  // one person however the sockets are ordered.
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

  const rootOf = new Map(); // socketId -> a token in that person's group
  for (const [socketId, s] of group) {
    const tokens = [];
    if (s.deviceId) tokens.push("d:" + s.deviceId);
    if (s.userId) tokens.push("u:" + s.userId);
    // No identifier at all means no evidence either way, so it never counts
    // as a second holder. A missing id must never be a reason to revoke.
    if (!tokens.length) continue;
    for (let i = 1; i < tokens.length; i++) union(tokens[0], tokens[i]);
    rootOf.set(socketId, add(tokens[0]));
  }

  const by = new Map(); // person -> holder
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
          // Whether anything in this group named an actual browser, rather
          // than only the session it happens to share.
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

// The verdict for a key right now.
//   null      - one person, or not enough evidence
//   "watch"   - two identities, but sharing a network. Their own second
//               browser, most likely. Worth saying, not worth revoking.
//   "shared"  - two identified browsers whose networks have nothing in
//               common, both settled. Two people.
function verdict(hash, now) {
  const at = now || Date.now();
  const list = holders(hash)
    .filter((h) => at - h.since >= SETTLE_MS)
    // A group nobody's browser ever named cannot be shown to be a second
    // person, only a second connection.
    .filter((h) => h.identified);
  if (list.length < 2) return null;
  // A holder whose network is unknown cannot be placed, so it cannot be the
  // one that proves a second location.
  const placed = list.filter((h) => h.networks.size);
  if (placed.length < 2) return "watch";
  // Two people in two places have no network in common. One person does: a
  // dual-stack browser is on an IPv6 /64 in one tab and an IPv4 /24 in the
  // next, and any tab that stays put keeps the network it started on. So a
  // network appearing under more than one holder settles it as one person,
  // whatever else they are also connected from.
  const seen = new Map(); // network -> the holder it was first seen under
  for (const h of placed)
    for (const n of h.networks) {
      const owner = seen.get(n);
      if (owner != null && owner !== h.key) return "watch";
      seen.set(n, h.key);
    }
  return "shared";
}

// Everything the alert needs to say who is where, without inventing detail.
// Only the holders whose browser named itself: those are the ones the verdict
// was reached on, so they are the ones worth naming in it.
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
