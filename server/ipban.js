// server/ipban.js
// IP-range ban matching. The blocklist (state.blockedIPs) is keyed by a string:
// either an exact address ("1.2.3.4", "2001:db8::1") or a CIDR range
// ("2001:db8:1:2::/64"). Range keys exist so an IPv6 client that rotates its
// address within its /64 cannot trivially evade a ban. IPv4 is always banned as
// a single address (a /24 would be far too much collateral behind CGNAT), so we
// only ever auto-compute IPv6 ranges.
//
// Everything here is defensive: any parse failure resolves to "no match" / null
// rather than throwing, so a malformed key or address can never crash the
// connection path.

const ipaddr = require("ipaddr.js");
const { state } = require("./state");

const DEFAULT_IPV6_PREFIX = 64;
// IPv4 ranges are opt-in per ban and never automatic: a /24 is 256 addresses,
// which behind CGNAT can be a lot of unrelated people. Staff choose it only
// when the evasion pattern (neighbouring addresses from one pool) justifies it.
const DEFAULT_IPV4_PREFIX = 24;

// Floors on a range typed in by hand. Past these a block stops being about a
// person and starts being about an ISP: a v4 /16 is 65k addresses and a v6 /32
// is a whole allocation. Anything wider than the "broad" line is a developer
// decision, the same way a permanent block is.
const MIN_IPV4_PREFIX = 16;
const MIN_IPV6_PREFIX = 32;
const BROAD_IPV4_PREFIX = 24;
const BROAD_IPV6_PREFIX = 48;

// Some blocklist keys are not addresses: they carry an "id:" prefix and match
// on the connection's client identifier instead. They never match an IP.
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

// True while the block has not expired. Tolerates the legacy shape where the
// stored value is a bare expiry number instead of a { expiry, ... } object.
function isActiveBlock(b) {
  const expiry = b && typeof b === "object" ? b.expiry : b;
  return (
    !!b &&
    (!expiry || expiry === Number.MAX_SAFE_INTEGER || Date.now() < expiry)
  );
}

// Given an address, return the CIDR string of the range we'd ban to catch
// rotation, or null if it cannot be computed. IPv6 collapses to its /64 (the
// home network); IPv4 collapses to its /24 (the surrounding pool). An
// IPv4-mapped IPv6 address is treated as the IPv4 it really is.
function computeRangeCidr(ip, prefix) {
  try {
    let addr = ipaddr.parse(String(ip));
    if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress())
      addr = addr.toIPv4Address();
    const v4 = addr.kind() === "ipv4";
    const bits = prefix || (v4 ? DEFAULT_IPV4_PREFIX : DEFAULT_IPV6_PREFIX);
    const bytes = addr.toByteArray(); // most-significant first
    const keepBytes = Math.floor(bits / 8);
    for (let i = keepBytes; i < bytes.length; i++) bytes[i] = 0;
    // /24 and /64 are both whole numbers of bytes, so no partial-byte masking
    const network = ipaddr.fromByteArray(bytes);
    return `${network.toString()}/${bits}`;
  } catch (_) {
    return null;
  }
}

// The span a ban has to cover to mean anything, worked out from the address
// itself. An IPv6 client is handed a whole /64 for its own network and moves
// around inside it freely, so blocking the single address it happens to be on
// blocks nothing; that range is applied to every IPv6 ban rather than being
// offered as a choice, because nobody placing the ban can see the address to
// judge it. IPv4 gets null: one address per ban, since a /24 behind CGNAT is a
// lot of unrelated people, and widening it stays an explicit decision.
function autoRangeCidr(ip) {
  try {
    const addr = ipaddr.parse(String(ip));
    if (addr.kind() !== "ipv6" || addr.isIPv4MappedAddress()) return null;
    return computeRangeCidr(ip, DEFAULT_IPV6_PREFIX);
  } catch (_) {
    return null;
  }
}

// A range typed in by staff ("151.57.212.0/24") turned into the key it gets
// stored under. null means the text is not a range at all; a result carrying
// `tooWide` parsed fine but reaches past the floor, which is worth saying out
// loud rather than reporting as a typo. `broad` marks the ones that parse,
// store, and still want a developer behind them.
//
// The key is canonical: host bits are cleared, so "151.57.212.9/24" and
// "151.57.212.0/24" cannot sit in the list as two entries covering one range.
// IPv6 is never stored narrower than the /64 every other v6 block already
// covers - a /96 typed by hand would block less than the bare address does.
// A v4 /32 is one address rather than a range and comes back as the bare
// address, so it dedupes against an exact entry instead of shadowing it.
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
    const bytes = addr.toByteArray(); // most-significant first
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

// Is `ip` inside the CIDR range `cidr`?
function ipInCidr(ip, cidr) {
  try {
    let addr = ipaddr.parse(String(ip));
    const [range, bits] = ipaddr.parseCIDR(String(cidr));
    if (addr.kind() !== range.kind()) {
      // An IPv4-mapped IPv6 client is logically IPv4; normalize so it can match
      // an IPv4 range. We don't create IPv4 ranges today, but stay correct.
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

// Does an address match a blocklist key (exact or range)?
function matchesKey(ip, key) {
  return isRangeKey(key) ? ipInCidr(ip, key) : ip === key;
}

// The active block covering `ip`, or null. Checks the exact address first (the
// fast path and the only path for IPv4), then any CIDR range that contains it.
// Returns { key, block } so callers can act on the underlying entry.
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

// Convenience: is this address blocked right now?
function isBlocked(ip) {
  return findActiveBlock(ip) !== null;
}

// The active block covering a client identifier, or null. Checks the direct
// "id:" key first, then any block whose record carries the same identifier.
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

// Remove every block tied to a client identifier: the direct "id:" key plus
// any record carrying it. Used when a ban is lifted so the user is actually
// let back in. Returns the removed keys.
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

// A bare, valid IPv4 or IPv6 address? Rejects CIDR text ("1.2.3.4/24"), which
// is how callers tell an address apart from a range; a range goes through
// parseRangeKey instead.
function isValidIp(ip) {
  try {
    return ipaddr.isValid(String(ip));
  } catch (_) {
    return false;
  }
}

// Canonical form of a typed address so the stored key matches socket.clientIp
// (which is already canonical). Returns null on anything unparseable.
function normalizeIp(ip) {
  try {
    return ipaddr.parse(String(ip)).toString();
  } catch (_) {
    return null;
  }
}

// ── Bulk matching ───────────────────────────────────────────────────────────
// Checking "which of these N block keys covers this address?" one key at a time
// re-parses the same CIDRs for every address tested, which is what made the
// dashboard take about a second to redraw once the identity store grew. Parse
// the key set once up front, then each address is a Set lookup plus a compare
// against the (few) ranges.

function prepareKeys(keys) {
  const exact = new Set();
  const ranges = [];
  for (const key of keys) {
    if (isIdKey(key)) continue; // identifier keys never match an address
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

// Every prepared key that covers `ip`.
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

// Remove every block that applies to `ip`: the exact entry plus any CIDR range
// that contains it. Used when a ban is lifted (e.g. a granted appeal) so a
// range-banned user is actually let back in instead of silently staying blocked
// because only their exact address was deleted. Returns the removed keys.
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
  findActiveIdBlock,
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
