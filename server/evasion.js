// server/evasion.js
// Ban-evasion watch.

const { state } = require("./state");
const ipban = require("./ipban");
const identity = require("./identity");
const audit = require("./audit");
const blocklist = require("./blocklist");
const banhistory = require("./banhistory");

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const recentAlerts = new Map();

// A device is auto-blocked only when it used the blocked address more than
// once, so a single stray connection from a recycled address does not ban an
// unrelated person.
const AUTO_BLOCK_MIN_SEEN = 2;

const CACHE_MS = 60 * 1000;
let cache = null;

function snapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  const keys = [];
  const seenIps = new Map();
  for (const [key, b] of state.blockedIPs) {
    if (!ipban.isActiveBlock(b)) continue;
    keys.push(key);
    const did =
      (b && typeof b === "object" && b.did) ||
      (ipban.isIdKey(key) ? key.slice(3) : null);
    if (!did) continue;
    const rec = identity.getRecord(did);
    if (!rec || !rec.ips) continue;
    for (const ip of Object.keys(rec.ips))
      if (!seenIps.has(ip)) seenIps.set(ip, { did, name: rec.name || null });
  }
  cache = { at: now, prepared: ipban.prepareKeys(keys), seenIps };
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
  for (const k of live) {
    const b = state.blockedIPs.get(k);
    if (ipban.isPermanentBlock(b)) permanent = true;
    else {
      const e = b && typeof b === "object" ? b.expiry : b;
      if (e > expiry) expiry = e;
    }
  }
  if (permanent) expiry = Number.MAX_SAFE_INTEGER;
  if (!expiry) return null;

  const rec = identity.getRecord(deviceId);
  const entry = {
    expiry,
    label: username || (rec && rec.name) || null,
    by: null,
    ts: Date.now(),
    reason: "Ban evasion.",
    did: deviceId,
  };

  const targets = [ipban.idKey(deviceId)];
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

  blocklist.saveSoon();
  cache = null;
  banhistory.record({
    ip: placed.find((k) => !ipban.isIdKey(k)) || placed[0],
    name: entry.label,
    action: "ban",
    reason: "Ban evasion.",
    duration: permanent ? "permanent" : "inherited",
  });
  return { keys: placed, expiry, permanent };
}

function check({ deviceId, ip, username }) {
  if (!deviceId && !ip) return null;
  if (!state.blockedIPs.size) return null;
  const last = deviceId ? recentAlerts.get(deviceId) : 0;
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return null;

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
        text: "has connected before from an address that is blocked now",
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
          "is on an address last used by " +
          (owner.name ? `"${owner.name}"` : "somebody") +
          ", who is blocked",
        ownerName: owner.name || null,
        ownerDid: owner.did || null,
        blocks: ipban.keysCovering(ip, snap.prepared).map(describeBlock),
      };
  }

  if (!signal) return null;
  if (deviceId) recentAlerts.set(deviceId, Date.now());
  if (recentAlerts.size > 5000) recentAlerts.clear();

  const who = username ? `"${username}"` : "A new connection";
  const lines = [`${who} ${signal.text}.`];
  lines.push("Now on: " + (ip || "unknown address"));
  if (deviceId) lines.push("Client id: " + deviceId);
  const rec = deviceId ? identity.getRecord(deviceId) : null;
  if (rec) {
    if (rec.name && rec.name !== username) lines.push('Known before as: "' + rec.name + '"');
    const all = rec.ips ? Object.keys(rec.ips) : [];
    if (all.length > 1)
      lines.push(
        "This client has used " + all.length + " addresses: " + all.slice(0, 8).join(", "),
      );
  }
  if (signal.priorIp)
    lines.push(
      "Matched on an earlier address: " +
        signal.priorIp +
        (signal.seenCount ? " (seen " + signal.seenCount + "x)" : ""),
    );
  if (signal.ownerName || signal.ownerDid)
    lines.push(
      "Address belongs to: " +
        (signal.ownerName ? '"' + signal.ownerName + '"' : "unknown") +
        (signal.ownerDid ? " (id " + signal.ownerDid + ")" : ""),
    );
  if (signal.blocks && signal.blocks.length)
    for (const b of signal.blocks) lines.push("Block: " + b);

  if (
    signal.kind === "history" &&
    deviceId &&
    (signal.seenCount || 0) >= AUTO_BLOCK_MIN_SEEN
  )
    signal.autoBlocked = placeAutoBlock({ deviceId, ip, username, signal });
  if (signal.autoBlocked)
    lines.push(
      "Auto-block placed: " +
        signal.autoBlocked.keys.join(", ") +
        (signal.autoBlocked.permanent
          ? " (permanent)"
          : " (for " + shortAgo(signal.autoBlocked.expiry - Date.now()) + ")"),
    );

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

module.exports = { check, invalidate, ALERT_COOLDOWN_MS };
