// server/ipban.js
// IP-range ban matching.

const ipaddr = require("ipaddr.js");
const { state } = require("./state");

const DEFAULT_IPV6_PREFIX = 64;
const DEFAULT_IPV4_PREFIX = 24;

const MIN_IPV4_PREFIX = 16;
const MIN_IPV6_PREFIX = 32;
const BROAD_IPV4_PREFIX = 24;
const BROAD_IPV6_PREFIX = 48;

const ID_PREFIX = "id:";

function isRangeKey(key) {
  return typeof key === "string" && key.indexOf("/") !== -1;
}

function isIdKey(key) {
  return typeof key === "string" && key.startsWith(ID_PREFIX);
}

function idKey(id) {
  return ID_PREFIX + String(id).toLowerCase();
}

function isActiveBlock(b) {
  const expiry = b && typeof b === "object" ? b.expiry : b;
  return (
    !!b &&
    (!expiry || expiry === Number.MAX_SAFE_INTEGER || Date.now() < expiry)
  );
}

function isPermanentBlock(b) {
  if (!b) return false;
  const expiry = typeof b === "object" ? b.expiry : b;
  return !expiry || expiry >= Number.MAX_SAFE_INTEGER;
}

function computeRangeCidr(ip, prefix) {
  try {
    let addr = ipaddr.parse(String(ip));
    if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress())
      addr = addr.toIPv4Address();
    const v4 = addr.kind() === "ipv4";
    const bits = prefix || (v4 ? DEFAULT_IPV4_PREFIX : DEFAULT_IPV6_PREFIX);
    const bytes = addr.toByteArray();
    const keepBytes = Math.floor(bits / 8);
    for (let i = keepBytes; i < bytes.length; i++) bytes[i] = 0;
    const network = ipaddr.fromByteArray(bytes);
    return `${network.toString()}/${bits}`;
  } catch (_) {
    return null;
  }
}

function autoRangeCidr(ip) {
  try {
    const addr = ipaddr.parse(String(ip));
    if (addr.kind() !== "ipv6" || addr.isIPv4MappedAddress()) return null;
    return computeRangeCidr(ip, DEFAULT_IPV6_PREFIX);
  } catch (_) {
    return null;
  }
}

function parseRangeKey(text) {
  try {
    let [addr, bits] = ipaddr.parseCIDR(String(text).trim());
    if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress()) {
      if (bits < 96) return null;
      addr = addr.toIPv4Address();
      bits -= 96;
    }
    const v4 = addr.kind() === "ipv4";
    if (!v4 && bits > DEFAULT_IPV6_PREFIX) bits = DEFAULT_IPV6_PREFIX;
    const floor = v4 ? MIN_IPV4_PREFIX : MIN_IPV6_PREFIX;
    if (bits < floor) return { key: null, bits, v4, floor, tooWide: true };
    const bytes = addr.toByteArray();
    for (let i = 0; i < bytes.length; i++) {
      const keep = bits - i * 8;
      if (keep >= 8) continue;
      bytes[i] = keep <= 0 ? 0 : bytes[i] & (0xff << (8 - keep));
    }
    const network = ipaddr.fromByteArray(bytes).toString();
    return {
      key: v4 && bits === 32 ? network : `${network}/${bits}`,
      bits,
      v4,
      broad: bits < (v4 ? BROAD_IPV4_PREFIX : BROAD_IPV6_PREFIX),
    };
  } catch (_) {
    return null;
  }
}

function ipInCidr(ip, cidr) {
  try {
    let addr = ipaddr.parse(String(ip));
    const [range, bits] = ipaddr.parseCIDR(String(cidr));
    if (addr.kind() !== range.kind()) {
      if (
        addr.kind() === "ipv6" &&
        addr.isIPv4MappedAddress() &&
        range.kind() === "ipv4"
      ) {
        addr = addr.toIPv4Address();
      } else {
        return false;
      }
    }
    return addr.match(range, bits);
  } catch (_) {
    return false;
  }
}

function matchesKey(ip, key) {
  return isRangeKey(key) ? ipInCidr(ip, key) : ip === key;
}

function findActiveBlock(ip) {
  if (!ip) return null;
  const exact = state.blockedIPs.get(ip);
  if (exact !== undefined && isActiveBlock(exact)) {
    return { key: ip, block: exact };
  }
  for (const [key, b] of state.blockedIPs) {
    if (!isRangeKey(key)) continue;
    if (!isActiveBlock(b)) continue;
    if (ipInCidr(ip, key)) return { key, block: b };
  }
  return null;
}

function isBlocked(ip) {
  return findActiveBlock(ip) !== null;
}

function findActiveIdBlock(id) {
  if (!id) return null;
  const low = String(id).toLowerCase();
  const key = idKey(low);
  const exact = state.blockedIPs.get(key);
  if (exact !== undefined && isActiveBlock(exact)) {
    return { key, block: exact };
  }
  for (const [k, b] of state.blockedIPs) {
    if (!isActiveBlock(b)) continue;
    if (b && typeof b === "object" && b.did === low)
      return { key: k, block: b };
  }
  return null;
}

// The block a requester is serving under any id they carry, and which id hit.
function findActiveBlockFor({ ip, deviceId, legacyId }) {
  const byIp = findActiveBlock(ip);
  if (byIp) return { ...byIp, deviceId: deviceId || null };
  for (const id of [deviceId, legacyId]) {
    const hit = id ? findActiveIdBlock(id) : null;
    if (hit) return { ...hit, deviceId: id };
  }
  return null;
}

function removeBlocksForDevice(id) {
  const removed = [];
  if (!id) return removed;
  const low = String(id).toLowerCase();
  const key = idKey(low);
  if (state.blockedIPs.delete(key)) removed.push(key);
  for (const [k, b] of [...state.blockedIPs]) {
    if (b && typeof b === "object" && b.did === low) {
      state.blockedIPs.delete(k);
      removed.push(k);
    }
  }
  return removed;
}

function isValidIp(ip) {
  try {
    return ipaddr.isValid(String(ip));
  } catch (_) {
    return false;
  }
}

function normalizeIp(ip) {
  try {
    return ipaddr.parse(String(ip)).toString();
  } catch (_) {
    return null;
  }
}

// ── Bulk matching ───────────────────────────────────────────────────────────

function prepareKeys(keys) {
  const exact = new Set();
  const ranges = [];
  for (const key of keys) {
    if (isIdKey(key)) continue;
    if (isRangeKey(key)) {
      try {
        const [range, bits] = ipaddr.parseCIDR(String(key));
        ranges.push({ key, range, bits, kind: range.kind() });
      } catch (_) {}
    } else {
      exact.add(key);
    }
  }
  return { exact, ranges };
}

function keysCovering(ip, prepared) {
  const hits = [];
  if (!ip || !prepared) return hits;
  if (prepared.exact.has(ip)) hits.push(ip);
  if (!prepared.ranges.length) return hits;
  let addr;
  try {
    addr = ipaddr.parse(String(ip));
  } catch (_) {
    return hits;
  }
  for (const r of prepared.ranges) {
    let a = addr;
    if (a.kind() !== r.kind) {
      if (a.kind() === "ipv6" && a.isIPv4MappedAddress() && r.kind === "ipv4")
        a = a.toIPv4Address();
      else continue;
    }
    try {
      if (a.match(r.range, r.bits)) hits.push(r.key);
    } catch (_) {}
  }
  return hits;
}

function removeBlocksForIp(ip) {
  const removed = [];
  if (!ip) return removed;
  if (state.blockedIPs.delete(ip)) removed.push(ip);
  for (const key of [...state.blockedIPs.keys()]) {
    if (isRangeKey(key) && ipInCidr(ip, key)) {
      state.blockedIPs.delete(key);
      removed.push(key);
    }
  }
  return removed;
}

module.exports = {
  DEFAULT_IPV6_PREFIX,
  DEFAULT_IPV4_PREFIX,
  BROAD_IPV4_PREFIX,
  BROAD_IPV6_PREFIX,
  parseRangeKey,
  isRangeKey,
  isIdKey,
  idKey,
  isActiveBlock,
  isPermanentBlock,
  findActiveIdBlock,
  findActiveBlockFor,
  removeBlocksForDevice,
  computeRangeCidr,
  autoRangeCidr,
  ipInCidr,
  matchesKey,
  findActiveBlock,
  isBlocked,
  isValidIp,
  normalizeIp,
  removeBlocksForIp,
  prepareKeys,
  keysCovering,
};
