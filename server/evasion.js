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
      if (ipban.keysCovering(seen, snap.prepared).length) {
        signal = {
          kind: "history",
          text: "has connected before from an address that is blocked now",
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
      };
  }

  if (!signal) return null;
  if (deviceId) recentAlerts.set(deviceId, Date.now());
  if (recentAlerts.size > 5000) recentAlerts.clear();

  const who = username ? `"${username}"` : "A new connection";
  audit.recordNotification({
    kind: "evasion",
    minLevel: 2,
    text: `${who} ${signal.text}. Worth a look before they settle in.`,
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
