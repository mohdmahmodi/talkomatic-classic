// server/evasion.js
// Ban-evasion watch.

const { state } = require("./state");
const ipban = require("./ipban");
const identity = require("./identity");
const audit = require("./audit");

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const recentAlerts = new Map();

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
    for (const seen of known) {
      if (seen === ip) continue;
      const covering = ipban.keysCovering(seen, snap.prepared);
      if (covering.length) {
        signal = {
          kind: "history",
          text: "has connected before from an address that is blocked now",
          priorIp: seen,
          blocks: covering.map(describeBlock),
          seenCount: (rec.ips && rec.ips[seen]) || null,
        };
        break;
      }
    }
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
      category: "possible ban evasion",
      reason: signal.text,
    },
  });
  return signal;
}

function invalidate() {
  cache = null;
}

module.exports = { check, invalidate, ALERT_COOLDOWN_MS };
