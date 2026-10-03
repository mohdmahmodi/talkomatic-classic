// server/evasion.js
// Ban-evasion watch.

const ipaddr = require("ipaddr.js");
const { state, isGuestName } = require("./state");
const nameguard = require("./nameguard");
const ipban = require("./ipban");
const identity = require("./identity");
const audit = require("./audit");
const blocklist = require("./blocklist");
const banhistory = require("./banhistory");
const personblocks = require("./personblocks");
const durations = require("./durations");

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const recentAlerts = new Map();

// A device is auto-blocked only when it used the blocked address more than
// once, so a single stray connection from a recycled address does not ban an
// unrelated person.
const AUTO_BLOCK_MIN_SEEN = 2;

const CACHE_MS = 60 * 1000;
const LONG_MS = 7 * 24 * 60 * 60 * 1000;
let cache = null;

function head(ip) {
  try {
    const a = ipaddr.parse(String(ip).split("/")[0]);
    if (a.kind() !== "ipv6" || a.isIPv4MappedAddress()) return null;
    return a.toByteArray().slice(0, 8);
  } catch (_) {
    return null;
  }
}

function shared(list) {
  let bits = 0;
  for (let i = 0; i < 8; i++) {
    let diff = 0;
    for (const n of list) diff |= n[i] ^ list[0][i];
    if (diff) return bits + Math.clz32(diff) - 24;
    bits += 8;
  }
  return bits;
}

function akin(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 5 && l.includes(s);
}

function lasting(b) {
  if (ipban.isPermanentBlock(b)) return true;
  if (!b || typeof b !== "object") return false;
  const from = b.since || b.ts || 0;
  return !!from && b.expiry - from >= LONG_MS;
}

function snapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  const keys = [];
  const seenIps = new Map();
  const marks = [];
  for (const [key, b] of state.blockedIPs) {
    if (!ipban.isActiveBlock(b)) continue;
    keys.push(key);
    const did =
      (b && typeof b === "object" && b.did) ||
      (ipban.isIdKey(key) ? key.slice(3) : null);
    const rec = did ? identity.getRecord(did) : null;
    if (lasting(b)) {
      const label = (b && typeof b === "object" && b.label) || null;
      const sks = new Set();
      for (const n of [label, rec && rec.name])
        if (n && !isGuestName(n)) sks.add(nameguard.skeleton(n));
      const nets = [];
      if (!ipban.isIdKey(key)) nets.push(head(key));
      if (rec && rec.ips) for (const ip of Object.keys(rec.ips)) nets.push(head(ip));
      const kept = nets.filter(Boolean);
      if (sks.size && kept.length)
        marks.push({ key, sks: [...sks], nets: kept, label: label || (rec && rec.name) || null });
    }
    if (!did) continue;
    if (!rec || !rec.ips) continue;
    for (const ip of Object.keys(rec.ips))
      if (!seenIps.has(ip)) seenIps.set(ip, { did, name: rec.name || null });
  }
  cache = { at: now, prepared: ipban.prepareKeys(keys), seenIps, marks };
  return cache;
}

function shortAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}

function describeBlock(key) {
  const b = state.blockedIPs.get(key);
  const bits = [key];
  if (b && typeof b === "object") {
    bits.push(ipban.isPermanentBlock(b) ? "permanent" : "temporary");
    if (b.label) bits.push('on "' + b.label + '"');
    if (b.by) bits.push("by " + b.by);
    if (b.ts) bits.push("placed " + shortAgo(Date.now() - b.ts) + " ago");
    if (b.reason) bits.push('reason: "' + String(b.reason).slice(0, 160) + '"');
  }
  return bits.join(", ");
}

// Blocks the evading device (and its current address) with the same lifetime
// as the block it slipped past. Returns what was placed, or null.
function placeAutoBlock({ deviceId, ip, username, signal }) {
  const live = (signal.blockKeys || []).filter((k) =>
    ipban.isActiveBlock(state.blockedIPs.get(k)),
  );
  if (!live.length) return null;

  let permanent = false;
  let expiry = 0;
  let since = 0;
  for (const k of live) {
    const b = state.blockedIPs.get(k);
    if (ipban.isPermanentBlock(b)) permanent = true;
    else {
      const e = b && typeof b === "object" ? b.expiry : b;
      if (e > expiry) expiry = e;
    }
    const s = b && typeof b === "object" ? b.since || b.ts || 0 : 0;
    if (s && (!since || s < since)) since = s;
  }
  if (permanent) expiry = Number.MAX_SAFE_INTEGER;
  if (!expiry) return null;

  const rec = identity.getRecord(deviceId);
  const entry = {
    expiry,
    label: username || (rec && rec.name) || null,
    by: null,
    ts: Date.now(),
    since: since || Date.now(),
    reason: "Ban evasion.",
    did: deviceId,
  };

  const targets = deviceId ? [ipban.idKey(deviceId)] : [];
  if (ip && ipban.isValidIp(ip)) targets.push(ipban.computeRangeCidr(ip) || ip);

  const placed = [];
  for (const key of targets) {
    const held = state.blockedIPs.get(key);
    if (held !== undefined && ipban.isActiveBlock(held)) {
      const heldExpiry = held && typeof held === "object" ? held.expiry : held;
      if (!heldExpiry || heldExpiry >= expiry) continue;
    }
    state.blockedIPs.set(key, { ...entry });
    placed.push(key);
  }
  if (!placed.length) return null;

  try {
    personblocks.align({ deviceId, ip });
  } catch (_) {}
  blocklist.saveSoon();
  cache = null;
  banhistory.record({
    ip: placed.find((k) => !ipban.isIdKey(k)) || placed[0],
    name: entry.label,
    action: "ban",
    reason: "Ban evasion.",
    duration: permanent ? "permanent" : durations.nearestKey(expiry - Date.now()),
  });
  return { keys: placed, expiry, permanent };
}

function check({ deviceId, ip, username }) {
  if (!deviceId && !ip) return null;
  if (!state.blockedIPs.size) return null;

  const snap = snapshot();
  let signal = null;

  if (deviceId) {
    const rec = identity.getRecord(deviceId);
    const known = rec && rec.ips ? Object.keys(rec.ips) : [];
    let best = null;
    for (const seen of known) {
      if (seen === ip) continue;
      const covering = ipban.keysCovering(seen, snap.prepared);
      if (!covering.length) continue;
      const count = (rec.ips && rec.ips[seen]) || 0;
      if (!best || count > best.count) best = { seen, covering, count };
    }
    if (best)
      signal = {
        kind: "history",
        text: "is on a browser that connected before from an IP address that is blocked now",
        priorIp: best.seen,
        blockKeys: best.covering,
        blocks: best.covering.map(describeBlock),
        seenCount: best.count || null,
      };
  }

  if (!signal && ip) {
    const owner = snap.seenIps.get(ip);
    if (owner && owner.did !== deviceId)
      signal = {
        kind: "address",
        text:
          "is on an IP address last used by " +
          (owner.name ? `"${owner.name}"` : "somebody") +
          ", who is blocked",
        ownerName: owner.name || null,
        ownerDid: owner.did || null,
        blocks: ipban.keysCovering(ip, snap.prepared).map(describeBlock),
      };
  }

  if (!signal) return null;
  if (
    signal.kind === "history" &&
    deviceId &&
    (signal.seenCount || 0) >= AUTO_BLOCK_MIN_SEEN
  )
    signal.autoBlocked = placeAutoBlock({ deviceId, ip, username, signal });
  return report(signal, { deviceId, ip, username });
}

function likeness(ip, username, snap) {
  if (!username || isGuestName(username)) return null;
  const here = head(ip);
  if (!here) return null;
  const sk = nameguard.skeleton(username);
  if (sk.length < 5) return null;
  const nets = new Map();
  const keys = new Set();
  const names = new Set();
  const near = [];
  for (const m of snap.marks) {
    const local = m.nets.filter((n) => shared([n, here]) >= 32);
    if (local.length) near.push({ m, local });
  }
  const sks = new Set([sk]);
  const same = near.some(({ m }) => m.sks.includes(sk));
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = near.length - 1; i >= 0; i--) {
      const { m, local } = near[i];
      if (!m.sks.some((s) => [...sks].some((t) => akin(s, t)))) continue;
      near.splice(i, 1);
      grew = true;
      for (const s of m.sks) sks.add(s);
      for (const n of local) nets.set(n.join("."), n);
      keys.add(m.key);
      if (m.label) names.add(m.label);
    }
  }
  if (nets.size < 2) return null;
  const list = [...nets.values()];
  const bits = shared(list);
  if (!same && shared([list[0], here]) < bits) return null;
  return { keys: [...keys], names: [...names], seen: nets.size, bits: same ? 32 : bits };
}

function recheck({ deviceId, ip, username }) {
  if (!ip || !state.blockedIPs.size) return null;
  const hit = likeness(ip, username, snapshot());
  if (!hit) return null;
  const signal = {
    kind: "likeness",
    text: "looks like somebody who is blocked",
    blockKeys: hit.keys,
    blocks: hit.keys.map(describeBlock),
    names: hit.names,
    spread: hit.seen + " earlier networks, /" + hit.bits,
  };
  signal.autoBlocked = placeAutoBlock({ deviceId, ip, username, signal });
  if (!signal.autoBlocked) return null;
  return report(signal, { deviceId, ip, username });
}

const MEANING = {
  history:
    "the same browser as before, on a new IP address. This is the strongest sign: the device id matches one that connected from an IP address that is blocked.",
  address:
    "a different browser on the same IP address as a blocked user. It can be the same person on a new browser or device, or somebody else sharing that network (family, school, mobile carrier).",
  likeness:
    "this sign-in resembles a user who is blocked.",
};

function report(signal, { deviceId, ip, username }) {
  // The cooldown quiets repeat alerts about one device. It never holds back a
  // block, so a weak match seen earlier cannot shield a strong one now.
  const last = deviceId ? recentAlerts.get(deviceId) : 0;
  if (!signal.autoBlocked && last && Date.now() - last < ALERT_COOLDOWN_MS)
    return null;
  if (deviceId) {
    recentAlerts.set(deviceId, Date.now());
    identity.noteEvasion(deviceId);
  }
  if (recentAlerts.size > 5000) recentAlerts.clear();

  const who = username ? `"${username}"` : "A new connection";
  const quoted = (list) => list.map((n) => '"' + n + '"').join(", ");
  const lines = [`${who} ${signal.text}.`];
  lines.push("What this means: " + MEANING[signal.kind]);
  lines.push(
    "Action taken: " +
      (signal.autoBlocked
        ? "blocked automatically" +
          (signal.autoBlocked.permanent
            ? ", permanently"
            : " for " + shortAgo(signal.autoBlocked.expiry - Date.now())) +
          " (" + signal.autoBlocked.keys.join(", ") + ")"
        : "none. Nothing was blocked, this is for a moderator to judge."),
  );
  lines.push("Name used now: " + (username ? '"' + username + '"' : "none yet"));
  lines.push("IP address now: " + (ip || "unknown"));
  if (deviceId) lines.push("Device id (their browser): " + deviceId);
  const rec = deviceId ? identity.getRecord(deviceId) : null;
  if (rec) {
    if (rec.name && rec.name !== username)
      lines.push('Name this browser used before: "' + rec.name + '"');
    const all = rec.ips ? Object.keys(rec.ips) : [];
    if (all.length > 1)
      lines.push(
        "IP addresses this browser has used (" + all.length + "): " +
          all.slice(0, 12).join(", ") +
          (all.length > 12 ? ", and " + (all.length - 12) + " more" : ""),
      );
  }
  if (signal.priorIp)
    lines.push(
      "Blocked IP address this browser used before: " +
        signal.priorIp +
        (signal.seenCount ? " (seen there " + signal.seenCount + " times)" : ""),
    );
  if (signal.ownerName || signal.ownerDid)
    lines.push(
      "Blocked user who used this IP address: " +
        (signal.ownerName ? '"' + signal.ownerName + '"' : "name unknown") +
        (signal.ownerDid ? ", device id " + signal.ownerDid : ""),
    );
  if (signal.names && signal.names.length)
    lines.push("Blocked names it resembles: " + quoted(signal.names.slice(0, 6)));
  if (signal.spread) lines.push("Networks matched: " + signal.spread);
  if (signal.blocks && signal.blocks.length)
    for (const blk of signal.blocks) lines.push("Block on file: " + blk);

  audit.recordNotification({
    kind: "evasion",
    minLevel: 2,
    opsOnly: true,
    text: lines.join("\n"),
    target: username || null,
    targetUserId: null,
    ip: ip || null,
    card: {
      ids: deviceId ? [deviceId] : [],
      target: username || "(no name yet)",
      deviceId: deviceId || null,
      category: signal.autoBlocked
        ? "ban evasion, blocked automatically"
        : "possible ban evasion",
      reason: signal.text,
    },
  });
  return signal;
}

function invalidate() {
  cache = null;
}

module.exports = { check, recheck, invalidate, ALERT_COOLDOWN_MS };
