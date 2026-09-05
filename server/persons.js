// server/persons.js
// One person across the devices, addresses and networks they have used.
// Computed from identity.json whenever asked, never stored: the only thing
// written here is a pin, and a wrong merge is undone with a pin, not an edit.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const identity = require("./identity");
const devicetoken = require("./devicetoken");
const ipban = require("./ipban");
const nameguard = require("./nameguard");
const lastseen = require("./lastseen");
const audit = require("./audit");

const PINS_PATH = path.join(DATA_DIR, "persons.json");
const CACHE_MS = 60 * 1000;
const NEAR_MS = 30 * 60 * 1000;
// An address or network shared by more devices than this is a carrier or a
// school, not a household. Nothing is joined through it.
const CROWD = 50;
// A shared network on its own never joins two devices. Flip this and a
// stranger on the same /24 inherits somebody else's bans.
const RANGE_ALONE_MERGES = false;
const NOBODY = new Set(["anonymous", "anon", "guest", "user", "me"]);

let pins = { together: [], apart: [] };
let cache = null;

// ── Pins ────────────────────────────────────────────────────────────────────

function pairList(v) {
  return Array.isArray(v)
    ? v.filter((p) => Array.isArray(p) && p.length === 2)
    : [];
}

function loadPins() {
  try {
    const o = JSON.parse(fs.readFileSync(PINS_PATH, "utf8"));
    pins = { together: pairList(o.together), apart: pairList(o.apart) };
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading persons.json:", err);
  }
}

async function savePins() {
  try {
    const tmp = PINS_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(pins, null, 2), "utf8");
    await fsp.rename(tmp, PINS_PATH);
  } catch (e) {
    console.error("persons save failed:", e);
  }
}

function pairKey(pair) {
  return pair.slice().sort().join("|");
}

function samePair(x, y) {
  return pairKey(x) === pairKey(y);
}

function pin(a, b, together) {
  if (!identity.validId(a) || !identity.validId(b) || a === b) return false;
  const pair = [a, b];
  pins.together = pins.together.filter((p) => !samePair(p, pair));
  pins.apart = pins.apart.filter((p) => !samePair(p, pair));
  (together ? pins.together : pins.apart).push(pair);
  invalidate();
  savePins();
  return true;
}

function unpin(a, b) {
  const pair = [a, b];
  const before = pins.together.length + pins.apart.length;
  pins.together = pins.together.filter((p) => !samePair(p, pair));
  pins.apart = pins.apart.filter((p) => !samePair(p, pair));
  if (pins.together.length + pins.apart.length === before) return false;
  invalidate();
  savePins();
  return true;
}

// ── Signals between two devices ─────────────────────────────────────────────

function nameKey(name) {
  const k = nameguard.skeleton(name || "");
  if (!k || NOBODY.has(k) || /^guest\d*$/.test(k)) return null;
  return k;
}

function byAge(store, a, b) {
  return (store[a].first || 0) <= (store[b].first || 0) ? [a, b] : [b, a];
}

function sameName(store, a, b) {
  const ka = nameKey(store[a].name);
  return ka && ka === nameKey(store[b].name) ? store[a].name : null;
}

// The newer device appeared shortly after the older one went quiet, and the
// older one was never used again: what clearing cookies looks like from the
// server. Two devices in use at the same time are two devices.
function tookOver(store, older, newer) {
  const quietAt = store[older].last || 0;
  const arrivedAt = store[newer].first || 0;
  return quietAt <= arrivedAt && arrivedAt - quietAt <= NEAR_MS;
}

function thrownOutBefore(store, older, newer) {
  const at = store[newer].first || 0;
  return audit
    .actionsOn({ deviceId: older }, at - NEAR_MS, 20)
    .some((p) => {
      const base = audit.baseAction(p.action);
      return (
        p.at <= at &&
        (audit.HEAVY.has(base) || audit.REQUIRES_REJOIN.has(base))
      );
    });
}

// A shared address joins two devices on a matching name, or when the newer
// one appeared right after the older one was kicked or blocked and never
// came back. Two people in one house who simply take turns stay two people.
function addressReason(store, a, b, ip) {
  const name = sameName(store, a, b);
  if (name) return `same name "${name}" on one address`;
  const [older, newer] = byAge(store, a, b);
  if (tookOver(store, older, newer) && thrownOutBefore(store, older, newer))
    return "appeared within 30 minutes of a kick or block on the other device, same address";
  return null;
}

function networkReason(store, a, b, net) {
  const name = sameName(store, a, b);
  if (name) return `same name "${name}" on one network (${net})`;
  const [older, newer] = byAge(store, a, b);
  if (thrownOutBefore(store, older, newer))
    return `appeared within 30 minutes of a kick or block on the other device, same network (${net})`;
  if (ipban.findActiveIdBlock(older) && store[newer].evaderAt)
    return "the other device is blocked and this one was flagged for ban evasion";
  return RANGE_ALONE_MERGES ? `same network (${net})` : null;
}

function shareAddress(store, a, b) {
  for (const ip of Object.keys(store[a].ips || {})) if (store[b].ips[ip]) return true;
  return false;
}

// ── Building the clusters ───────────────────────────────────────────────────

function groupBy(ids, keysOf) {
  const out = new Map();
  for (const id of ids)
    for (const k of keysOf(id)) {
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(id);
    }
  return out;
}

function eachPair(ids, fn) {
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) fn(ids[i], ids[j]);
}

function find(parent, x) {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
}

function deviceView(store, id) {
  const r = store[id];
  return {
    id,
    userId: devicetoken.userIdFor(id),
    name: r.name || null,
    first: r.first || 0,
    last: r.last || 0,
    evaderAt: r.evaderAt || null,
    ips: Object.keys(r.ips || {}),
    nets: Object.keys(r.nets || {}),
  };
}

function personOf(store, ids, edges) {
  const devices = ids.map((id) => deviceView(store, id)).sort((a, b) => a.first - b.first);
  const set = new Set(ids);
  return {
    id: devices[0].id,
    devices,
    userIds: devices.map((d) => d.userId),
    names: [...new Set(devices.map((d) => d.name).filter(Boolean))],
    ips: [...new Set(devices.flatMap((d) => d.ips))],
    nets: [...new Set(devices.flatMap((d) => d.nets))],
    edges: [...edges.values()].filter((e) => set.has(e.a) && set.has(e.b)),
    first: devices[0].first,
    last: Math.max(...devices.map((d) => d.last)),
  };
}

function build() {
  const store = identity.allRecords();
  const devices = Object.keys(store).filter((id) => store[id] && store[id].ips);
  const byIp = groupBy(devices, (id) => Object.keys(store[id].ips));
  const byNet = groupBy(devices, (id) => Object.keys(store[id].nets || {}));
  const parent = new Map(devices.map((id) => [id, id]));
  const apart = new Set(pins.apart.map(pairKey));
  const edges = new Map();

  const link = (a, b, tier, why) => {
    const k = pairKey([a, b]);
    if (apart.has(k) || edges.has(k)) return;
    edges.set(k, { a, b, tier, why });
    parent.set(find(parent, a), find(parent, b));
  };

  for (const [a, b] of pins.together)
    if (parent.has(a) && parent.has(b)) link(a, b, "A", "pinned together by staff");

  for (const [ip, ids] of byIp) {
    if (ids.length > CROWD) continue;
    eachPair(ids, (a, b) => {
      const why = addressReason(store, a, b, ip);
      if (why) link(a, b, "B", why);
    });
  }

  for (const [net, ids] of byNet) {
    if (ids.length > CROWD) continue;
    eachPair(ids, (a, b) => {
      if (shareAddress(store, a, b)) return;
      const why = networkReason(store, a, b, net);
      if (why) link(a, b, "C", why);
    });
  }

  const clusters = new Map();
  for (const id of devices) {
    const root = find(parent, id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  }

  const persons = new Map();
  const byDevice = new Map();
  const byUser = new Map();
  for (const ids of clusters.values()) {
    const p = personOf(store, ids, edges);
    persons.set(p.id, p);
    for (const d of p.devices) {
      byDevice.set(d.id, p.id);
      byUser.set(d.userId, d.id);
    }
  }
  return { at: Date.now(), persons, byDevice, byUser, byNet };
}

function current() {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = build();
  return cache;
}

function invalidate() {
  cache = null;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function withStatus(p) {
  return {
    ...p,
    blocked:
      p.devices.some((d) => !!ipban.findActiveIdBlock(d.id)) ||
      p.ips.some((ip) => ipban.isBlocked(ip)),
    evader: p.devices.some((d) => !!d.evaderAt),
  };
}

function standalone(id, name) {
  return {
    id,
    standalone: true,
    devices: [],
    userIds: [id],
    names: name ? [name] : [],
    ips: [],
    nets: [],
    edges: [],
    blocked: false,
    evader: false,
    first: 0,
    last: 0,
  };
}

// Accepts a device id, a user id, or the audit log's "user:name(id)" tag. A
// user id that was never derived from a device still resolves through the
// last connection that carried both.
function resolve(key) {
  const s = String(key || "");
  const tag = /^user:(.*)\(([^)]*)\)$/.exec(s);
  const id = tag ? tag[2] : s;
  const c = current();
  let did = c.byDevice.has(id) ? id : c.byUser.get(id);
  if (!did) {
    const seen = lastseen.get(id);
    if (seen && seen.deviceId && c.byDevice.has(seen.deviceId)) did = seen.deviceId;
  }
  if (!did) return standalone(id, tag ? tag[1] : null);
  return withStatus(c.persons.get(c.byDevice.get(did)));
}

function sameNetwork(person, limit = 10) {
  const c = current();
  const mine = new Set(person.devices.map((d) => d.id));
  const out = [];
  const seen = new Set();
  for (const net of person.nets) {
    const ids = c.byNet.get(net) || [];
    if (ids.length > CROWD) continue;
    for (const id of ids) {
      if (mine.has(id) || seen.has(id)) continue;
      seen.add(id);
      const p = c.persons.get(c.byDevice.get(id));
      const dev = p.devices.find((d) => d.id === id);
      out.push({ id, name: dev.name, net, last: dev.last, personId: p.id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function pinsFor(person) {
  const mine = new Set(person.devices.map((d) => d.id));
  const touching = (p) => mine.has(p[0]) || mine.has(p[1]);
  return {
    together: pins.together.filter(touching),
    apart: pins.apart.filter(touching),
  };
}

loadPins();

module.exports = {
  resolve,
  sameNetwork,
  pinsFor,
  pin,
  unpin,
  invalidate,
  RANGE_ALONE_MERGES,
};
