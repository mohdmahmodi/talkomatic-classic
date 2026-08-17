// server/evasion.js
// Ban-evasion watch. Addresses are not on the dashboard, so "is this the
// person we banned last night, back on a fresh browser?" has to be answered by
// the server instead of by eye. It asks two questions of every connection that
// gets in:
//
//   - has this browser been here before from an address that is blocked now?
//   - is this address one a currently-blocked identity was last seen on?
//
// Neither of them bans anybody. A shared house, a phone handed to a sibling,
// and a carrier reassigning an address all look exactly like evasion from
// outside, so every signal is a prompt for a human to go and look. A wrong
// automatic ban is worse than a missed one, and staff already have the tools.

const { state } = require("./state");
const ipban = require("./ipban");
const identity = require("./identity");
const audit = require("./audit");

// One alert per browser per hour. A determined evader reconnects constantly,
// and a queue with the same card in it forty times is a queue nobody reads.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const recentAlerts = new Map(); // deviceId -> ts

// The active blocklist, parsed once and reused. Rebuilt on a timer rather than
// on every write: this sits on the connection path, and a signal that is up to
// a minute stale is still a signal.
const CACHE_MS = 60 * 1000;
let cache = null;

function snapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  const keys = [];
  // Address -> the blocked identity that has used it. Built from the device id
  // each block carries, so an identifier-only ban still has addresses behind it.
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

// Called for a connection that was NOT blocked. Returns the signal it raised,
// or null when there is nothing to say.
function check({ deviceId, ip, username }) {
  if (!deviceId && !ip) return null;
  if (!state.blockedIPs.size) return null;
  const last = deviceId ? recentAlerts.get(deviceId) : 0;
  if (last && Date.now() - last < ALERT_COOLDOWN_MS) return null;

  const snap = snapshot();
  let signal = null;

  // This browser's own history, against the blocks in force now.
  if (deviceId) {
    const rec = identity.getRecord(deviceId);
    const known = rec && rec.ips ? Object.keys(rec.ips) : [];
    for (const seen of known) {
      if (seen === ip) continue; // they would not be here if it were blocked
      if (ipban.keysCovering(seen, snap.prepared).length) {
        signal = {
          kind: "history",
          text: "has connected before from an address that is blocked now",
        };
        break;
      }
    }
  }

  // The other direction: a blocked identity has used this address.
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

// The blocklist changed under us; the next check rebuilds rather than waiting
// out the timer. Used when a ban is placed or lifted.
function invalidate() {
  cache = null;
}

module.exports = { check, invalidate, ALERT_COOLDOWN_MS };
