// server/proxyguard.js

const ipaddr = require("ipaddr.js");
const { tuned } = require("./state");

const TTL_MS = tuned("GUARD_PROXY_HOURS", 24) * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2500;
const MAX_ENTRIES = 20000;

const cache = new Map();
const pending = new Map();

function publicIp(ip) {
  try {
    let a = ipaddr.parse(String(ip));
    if (a.kind() === "ipv6" && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.range() === "unicast" ? a.toString() : null;
  } catch (_) {
    return null;
  }
}

function remember(ip, value, ttl) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(ip, { ...value, until: Date.now() + ttl });
}

function cached(rawIp) {
  const ip = publicIp(rawIp);
  const hit = ip ? cache.get(ip) : null;
  if (!hit) return null;
  if (hit.until < Date.now()) {
    cache.delete(ip);
    return null;
  }
  return hit;
}

async function lookup(ip) {
  const key = process.env.GUARD_PROXY_KEY;
  const url =
    "https://proxycheck.io/v2/" + encodeURIComponent(ip) + "?vpn=3" +
    (key ? "&key=" + encodeURIComponent(key) : "");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json();
    const row = body && body[ip];
    if (!row) {
      remember(ip, { flagged: false, failed: true }, RETRY_MS);
      return null;
    }
    const flagged = row.proxy === "yes";
    const value = { flagged, type: flagged ? row.type || "proxy" : null, fresh: flagged };
    remember(ip, value, TTL_MS);
    return value;
  } catch (_) {
    remember(ip, { flagged: false, failed: true }, RETRY_MS);
    return null;
  }
}

async function check(rawIp) {
  const ip = publicIp(rawIp);
  if (!ip) return null;
  const hit = cached(ip);
  if (hit) {
    const out = { ...hit };
    if (hit.fresh) hit.fresh = false;
    return out;
  }
  if (pending.has(ip)) return pending.get(ip);
  const p = lookup(ip).finally(() => pending.delete(ip));
  pending.set(ip, p);
  const out = await p;
  const stored = cache.get(ip);
  if (stored && stored.fresh) stored.fresh = false;
  return out;
}

module.exports = { check, cached };
