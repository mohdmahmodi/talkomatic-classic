const { state } = require("./state");
const ipban = require("./ipban");
const persons = require("./persons");
const devicetoken = require("./devicetoken");

function expiryOf(b) {
  return b && typeof b === "object" ? b.expiry || 0 : b || 0;
}

function sinceOf(b) {
  return b && typeof b === "object" ? b.since || b.ts || 0 : 0;
}

function keysFor(who) {
  const w = who || {};
  const deviceIds = new Set();
  const userIds = new Set();
  const ips = new Set();
  for (const id of [w.deviceId, w.legacyId])
    if (id) deviceIds.add(String(id).toLowerCase());
  if (w.userId) userIds.add(w.userId);
  if (w.ip) ips.add(w.ip);
  for (const id of deviceIds) {
    try {
      const uid = devicetoken.userIdFor(id);
      if (uid) userIds.add(uid);
    } catch (_) {}
  }
  let person = null;
  for (const key of [w.deviceId, w.legacyId, w.userId]) {
    if (!key) continue;
    const p = persons.resolve(key);
    if (p && !p.standalone) {
      person = p;
      break;
    }
  }
  if (person) {
    for (const d of person.devices) deviceIds.add(d.id);
    for (const uid of person.userIds) userIds.add(uid);
    for (const ip of person.ips) ips.add(ip);
  }
  return { deviceIds, userIds, ips, ip: w.ip || null, person };
}

function ownedBlocks(keys) {
  const out = [];
  const seen = new Set();
  const take = (key) => {
    if (!key || seen.has(key)) return;
    const b = state.blockedIPs.get(key);
    if (b === undefined || !ipban.isActiveBlock(b)) return;
    seen.add(key);
    out.push({ key, block: b });
  };
  for (const did of keys.deviceIds) take(ipban.idKey(did));
  for (const [k, b] of state.blockedIPs)
    if (b && typeof b === "object" && b.did && keys.deviceIds.has(b.did))
      take(k);
  for (const ip of keys.ips) take(ip);
  return out;
}

function coveringBlocks(who) {
  const out = [];
  const seen = new Set();
  const push = (hit) => {
    if (!hit || seen.has(hit.key)) return;
    seen.add(hit.key);
    out.push({ key: hit.key, block: hit.block });
  };
  if (who.ip) push(ipban.findActiveBlock(who.ip));
  for (const id of [who.deviceId, who.legacyId])
    if (id) push(ipban.findActiveIdBlock(id));
  return out;
}

function longest(list) {
  let best = null;
  for (const item of list) {
    const e = expiryOf(item.block);
    const be = best ? expiryOf(best.block) : -1;
    const ts = item.block && typeof item.block === "object" ? item.block.ts || 0 : 0;
    const bts = best && typeof best.block === "object" ? best.block.ts || 0 : 0;
    if (!best || e > be || (e === be && ts > bts)) best = item;
  }
  return best;
}

function effective(who, keys) {
  const k = keys || keysFor(who);
  const owned = ownedBlocks(k);
  const covering = coveringBlocks(who || {});
  const all = owned.slice();
  const seen = new Set(owned.map((o) => o.key));
  for (const c of covering) if (!seen.has(c.key)) all.push(c);
  if (!all.length) return null;
  const top = longest(all);
  const b = top.block && typeof top.block === "object" ? top.block : null;
  const expiry = expiryOf(top.block);
  let since = 0;
  for (const item of all) {
    const s = sinceOf(item.block);
    if (s && (!since || s < since)) since = s;
  }
  return {
    key: top.key,
    block: b,
    expiry,
    permanent: !expiry || expiry >= Number.MAX_SAFE_INTEGER,
    since: since || (b && b.ts) || 0,
    covered: covering.length > 0,
    keys: all.map((a) => a.key),
    owned: owned.map((o) => o.key),
  };
}

function spellFor(who, keys) {
  const eff = effective(who, keys);
  return eff ? eff.since || 0 : 0;
}

function align(who) {
  const keys = keysFor(who);
  const owned = ownedBlocks(keys);
  if (owned.length < 2) return [];
  let expiry = 0;
  let since = 0;
  for (const { block } of owned) {
    const e = expiryOf(block);
    if (e > expiry) expiry = e;
    const s = sinceOf(block);
    if (s && (!since || s < since)) since = s;
  }
  const changed = [];
  for (const { key, block } of owned) {
    if (!block || typeof block !== "object") {
      if ((block || 0) < expiry) {
        state.blockedIPs.set(key, { expiry, since: since || undefined });
        changed.push(key);
      }
      continue;
    }
    let touched = false;
    if ((block.expiry || 0) < expiry) {
      block.expiry = expiry;
      touched = true;
    }
    if (since && (!block.since || block.since > since)) {
      block.since = since;
      touched = true;
    }
    if (touched) changed.push(key);
  }
  return changed;
}

function companionsOf(key) {
  const b = state.blockedIPs.get(key);
  const did = ipban.isIdKey(key)
    ? key.slice(3)
    : b && typeof b === "object" && b.did
      ? b.did
      : null;
  if (!did) return { did: null, keys: [] };
  const keys = keysFor({ deviceId: did });
  return {
    did,
    keys: ownedBlocks(keys)
      .map((o) => o.key)
      .filter((k) => k !== key),
  };
}

function liftAll(who) {
  const keys = keysFor(who);
  const removed = [];
  for (const { key } of ownedBlocks(keys)) {
    if (state.blockedIPs.delete(key)) removed.push(key);
  }
  return removed;
}

module.exports = {
  keysFor,
  ownedBlocks,
  effective,
  spellFor,
  align,
  companionsOf,
  liftAll,
};
