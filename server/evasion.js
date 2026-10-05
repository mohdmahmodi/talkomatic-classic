// server/evasion.js
// Ban-evasion watch.

const fs = require("fs");
const path = require("path");
const ipaddr = require("ipaddr.js");
const { state, isGuestName, tuned } = require("./state");
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
const POOL_OTHERS = tuned("GUARD_POOL_OTHERS", 5);
const PLACE_OTHERS = tuned("GUARD_PLACE_OTHERS", 1);
const PLACE_MIN = tuned("GUARD_PLACE_MIN", 10);
const NAME_MIN = tuned("GUARD_NAME_MIN", 6);
const WORDS_FILE = path.join(__dirname, "..", "public", "js", "dictionary_words.json");
let words = null;
const CENSUS_MS = 5 * 60 * 1000;
let cache = null;
let counted = null;

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

function pool(net) {
  return net.slice(0, 4).join(".");
}

function plain(name) {
  if (!words) {
    try {
      words = new Set(JSON.parse(fs.readFileSync(WORDS_FILE, "utf8")));
    } catch (_) {
      words = new Set();
    }
  }
  const text = String(name || "");
  if ((text.match(/[\p{L}\p{N}]/gu) || []).length < NAME_MIN) return true;
  const parts = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return parts.length === 1 && words.has(parts[0]);
}

function half(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(\/\d+)?$/.exec(String(ip || ""));
  return m ? m[1] + "." + m[2] : null;
}

function near(a, b) {
  if (!a || !b || a.length < PLACE_MIN || b.length < PLACE_MIN) return false;
  if (a === b) return true;
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  if (same >= PLACE_MIN) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length] <= 1;
}

function others(list, sks) {
  let n = 0;
  for (const s of list || []) if (!s || ![...sks].some((t) => akin(s, t))) n++;
  return n;
}

function lasting(b) {
  if (ipban.isPermanentBlock(b)) return true;
  if (!b || typeof b !== "object") return false;
  const from = b.since || b.ts || 0;
  return !!from && b.expiry - from >= LONG_MS;
}

function census() {
  const now = Date.now();
  if (counted && now - counted.at < CENSUS_MS) return counted;
  const pools = new Map();
  const places = new Map();
  const people = [];
  for (const rec of Object.values(identity.allRecords())) {
    if (!rec) continue;
    const sk = rec.name && !isGuestName(rec.name) ? nameguard.skeleton(rec.name) : "";
    const loc = rec.loc ? nameguard.skeleton(rec.loc) : "";
    if (loc) {
      if (places.has(loc)) places.get(loc).push(sk);
      else places.set(loc, [sk]);
    }
    const mine = new Set();
    const v6 = [];
    for (const ip of Object.keys(rec.ips || {})) {
      const net = head(ip);
      if (!net) continue;
      mine.add(pool(net));
      v6.push(ip);
    }
    if (sk && v6.length) people.push({ sk, name: rec.name, ips: v6 });
    for (const p of mine) {
      if (pools.has(p)) pools.get(p).push(sk);
      else pools.set(p, [sk]);
    }
  }
  counted = { at: now, pools, places, people };
  return counted;
}

function snapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  const keys = [];
  const seenIps = new Map();
  const marks = [];
  const { pools, places, people } = census();
  const bare = [];
  for (const [key, b] of state.blockedIPs)
    if (ipban.isActiveBlock(b) && lasting(b) && !ipban.isIdKey(key) && head(key) && !(b && typeof b === "object" && (b.label || b.did)))
      bare.push(key);
  const bareKeys = bare.length ? ipban.prepareKeys(bare) : null;
  const bareNames = new Map();
  if (bareKeys)
    for (const p of people)
      for (const ip of p.ips)
        for (const k of ipban.keysCovering(ip, bareKeys)) {
          if (!bareNames.has(k)) bareNames.set(k, new Map());
          bareNames.get(k).set(p.sk, p.name);
        }
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
      const stored = b && typeof b === "object" && Array.isArray(b.names) ? b.names : [];
      const found = bareNames.get(key);
      const kept = new Set(stored.filter((n) => n && !isGuestName(n)).map((n) => nameguard.skeleton(n)));
      const only = label || did ? [] : found ? (found.size === 1 ? [...found.values()] : []) : kept.size === 1 ? stored.slice(0, 1) : [];
      const derived = only;
      for (const n of [label, rec && rec.name, ...only])
        if (n && !isGuestName(n)) sks.add(nameguard.skeleton(n));
      const locs = rec && rec.loc ? [nameguard.skeleton(rec.loc)] : [];
      const nets = [];
      const halves = new Set();
      if (!ipban.isIdKey(key)) {
        nets.push(head(key));
        if (half(key)) halves.add(half(key));
      }
      if (rec && rec.ips)
        for (const ip of Object.keys(rec.ips)) {
          nets.push(head(ip));
          if (half(ip)) halves.add(half(ip));
        }
      const v6 = nets.filter(Boolean);
      if (sks.size && (v6.length || halves.size))
        marks.push({ key, sks: [...sks], nets: v6, halves: [...halves], locs, label: label || (rec && rec.name) || derived[0] || null });
    }
    if (!did) continue;
    if (!rec || !rec.ips) continue;
    for (const ip of Object.keys(rec.ips))
      if (!seenIps.has(ip)) seenIps.set(ip, { did, name: rec.name || null });
  }
  cache = { at: now, prepared: ipban.prepareKeys(keys), seenIps, marks, pools, places };
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

function settled(loc, fam, sks, snap) {
  if (!loc) return false;
  for (const m of fam)
    for (const l of m.locs)
      if (near(l, loc) && others(snap.places.get(l), sks) <= PLACE_OTHERS && others(snap.places.get(loc), sks) <= PLACE_OTHERS)
        return true;
  return false;
}

function likeness(ip, username, snap, location) {
  if (!username || isGuestName(username)) return null;
  const here = head(ip);
  if (!here) return null;
  const sk = nameguard.skeleton(username);
  if (sk.length < 5) return null;
  const nets = new Map();
  const keys = new Set();
  const names = new Set();
  const fam = [];
  const around = [];
  for (const m of snap.marks) {
    const local = m.nets.filter((n) => shared([n, here]) >= 32);
    if (local.length) around.push({ m, local });
  }
  const sks = new Set([sk]);
  const same = around.some(({ m }) => m.sks.includes(sk));
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = around.length - 1; i >= 0; i--) {
      const { m, local } = around[i];
      if (!m.sks.some((s) => [...sks].some((t) => akin(s, t)))) continue;
      around.splice(i, 1);
      grew = true;
      for (const s of m.sks) sks.add(s);
      for (const n of local) nets.set(n.join("."), n);
      fam.push(m);
      keys.add(m.key);
      if (m.label) names.add(m.label);
    }
  }
  if (!nets.size) return null;
  const loc = location ? nameguard.skeleton(location) : "";
  if (nets.size < 2) {
    const quiet = same && !plain(username) && others(snap.pools.get(pool(here)), sks) <= POOL_OTHERS;
    if (!quiet && !settled(loc, fam, sks, snap)) return null;
    return { keys: [...keys], names: [...names], seen: 1, bits: 32 };
  }
  const list = [...nets.values()];
  const bits = shared(list);
  if (!same && shared([list[0], here]) < bits && !settled(loc, fam, sks, snap)) return null;
  return { keys: [...keys], names: [...names], seen: nets.size, bits: same ? 32 : bits };
}

function agrees({ ip, username, location }) {
  if (!username || isGuestName(username) || !state.blockedIPs.size) return true;
  const snap = snapshot();
  const sk = nameguard.skeleton(username);
  const fam = snap.marks.filter((m) => m.sks.some((s) => akin(s, sk)));
  if (!fam.length) return true;
  const sks = new Set([sk]);
  for (const m of fam) for (const s of m.sks) sks.add(s);
  const here = ip ? head(ip) : null;
  if (here && fam.some((m) => m.nets.some((n) => shared([n, here]) >= 32))) return true;
  const mine = ip ? half(ip) : null;
  if (mine && fam.some((m) => m.halves.includes(mine))) return true;
  return settled(location ? nameguard.skeleton(location) : "", fam, sks, snap);
}

function recheck({ deviceId, ip, username, location }) {
  if (!ip || !state.blockedIPs.size) return null;
  const hit = likeness(ip, username, snapshot(), location);
  if (!hit) return null;
  const signal = {
    kind: "likeness",
    text: "looks like somebody who is blocked",
    blockKeys: hit.keys,
    blocks: hit.keys.map(describeBlock),
    names: hit.names,
    spread: hit.seen + (hit.seen === 1 ? " earlier network, /" : " earlier networks, /") + hit.bits,
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

function invalidate(all) {
  cache = null;
  if (all) counted = null;
}

module.exports = { check, recheck, agrees, invalidate, ALERT_COOLDOWN_MS };
