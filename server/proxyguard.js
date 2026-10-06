// server/proxyguard.js

const ipaddr = require("ipaddr.js");
const { tuned } = require("./state");

const HOUR = 60 * 60 * 1000;
const TTL_MS = tuned("GUARD_PROXY_HOURS", 24) * HOUR;
const WAIT_MS = tuned("GUARD_PROXY_WAIT_SEC", 4) * 1000;
const BASE = String(process.env.GUARD_PROXY_URL || "").replace(/\/+$/, "");
const HOSTING = process.env.GUARD_PROXY_HOSTING !== "0";
const FIELDS = "status,message,proxy,proxyType,provider,hosting,mobile,risk,isp,org,networkClass";
const SCHOOL = /\b(schools?|universit\w*|college|colegio|escola|escuela|k-?12|isd|school district|board of education|department of education|education service district|educational service)\b/i;
const REPORTABLE = new Set(["hosting", "vpn", "proxy", "public", "residential"]);
const REPORT_EVERY_MS = 7 * 24 * HOUR;
const REPORT_DAY_MAX = tuned("GUARD_PROXY_REPORTS", 40);
const REPORT_POLL_MS = 10 * 60 * 1000;
const REPORT_KEEP_MS = 14 * 24 * HOUR;
const FAST_MS = 1500;
const FULL_MS = 2500;
const BACKUP_MS = 2000;
const DRAIN_MS = 5000;
const BATCH_MAX = 95;
const RESERVE = 10;
const BACKUP_PER_TICK = 5;
const QUEUE_MAX = 5000;
const MAX_ENTRIES = 20000;
const REPORT_GAP_MS = 10 * 60 * 1000;

const cache = new Map();
const pending = new Map();
const queue = new Map();
const late = new Set();
const reported = new Map();
const reviews = new Map();
let sentToday = { day: "", n: 0 };
let lastPoll = 0;
let pausedUntil = 0;
let left = null;
let windowEnd = 0;
let hooks = { onFlag: null, isLive: null };
let timer = null;

function publicIp(ip) {
  try {
    let a = ipaddr.parse(String(ip));
    if (a.kind() === "ipv6" && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.range() === "unicast" ? a.toString() : null;
  } catch (_) {
    return null;
  }
}

function clean(source) {
  return { flagged: false, type: null, provider: null, network: null, school: false, mobile: false, hosting: false, risk: null, source };
}

function named(kind, ...parts) {
  const text = parts.filter((p) => typeof p === "string" && p).join(" / ").slice(0, 120);
  return { network: text || null, school: SCHOOL.test(text) || /educat/i.test(String(kind || "")) };
}

function fromOwl(row) {
  if (!row || typeof row !== "object") return null;
  if (row.status !== "success")
    return row.message === "private range" || row.message === "reserved range" ? clean("owl") : null;
  const proxy = row.proxy === true;
  const hosting = row.hosting === true;
  const net = named(row.networkClass, row.isp, row.org !== row.isp ? row.org : null);
  return {
    flagged: proxy || (HOSTING && hosting),
    type: proxy ? row.proxyType || "proxy" : hosting ? "hosting" : null,
    provider: typeof row.provider === "string" && row.provider ? row.provider.slice(0, 60) : null,
    ...net,
    mobile: row.mobile === true,
    hosting,
    risk: Number.isFinite(row.risk) ? row.risk : null,
    source: "owl",
  };
}

function fromBackup(row) {
  if (!row || typeof row !== "object") return null;
  if (row.proxy !== "yes") return clean("backup");
  const kind = String(row.type || "proxy").toLowerCase();
  const hosting = /hosting|business|data/.test(kind);
  const type = kind === "vpn" ? "vpn" : kind === "tor" ? "tor" : hosting ? "hosting" : "proxy";
  return {
    flagged: type !== "hosting" || HOSTING,
    type,
    provider: typeof row.provider === "string" && row.provider ? row.provider.slice(0, 60) : null,
    ...named(null, row.provider, row.organisation),
    mobile: false,
    hosting,
    risk: Number.isFinite(row.risk) ? row.risk : null,
    source: "backup",
  };
}

function note(res) {
  const rlText = res.headers.get("x-rl");
  const ttlText = res.headers.get("x-ttl");
  const rl = rlText == null || rlText === "" ? NaN : Number(rlText);
  const ttl = ttlText == null || ttlText === "" ? NaN : Number(ttlText);
  if (Number.isFinite(rl) && Number.isFinite(ttl)) {
    left = rl;
    windowEnd = Date.now() + ttl * 1000;
    if (rl <= 0) pausedUntil = windowEnd;
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 60;
    pausedUntil = Date.now() + Math.min(wait, 600) * 1000;
    left = 0;
    windowEnd = pausedUntil;
    return true;
  }
  return false;
}

function paused() {
  if (Date.now() >= windowEnd) left = null;
  return !BASE || Date.now() < pausedUntil;
}

async function owl(ip, fast) {
  if (paused()) return { limited: true };
  const url = BASE + "/json/" + encodeURIComponent(ip) + "?fields=" + FIELDS + (fast ? "&fast=1" : "");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(fast ? FAST_MS : FULL_MS) });
    if (note(res)) return { limited: true };
    const value = fromOwl(await res.json());
    return value ? { value } : null;
  } catch (_) {
    return null;
  }
}

async function backup(ip) {
  const key = process.env.GUARD_PROXY_KEY;
  const url =
    "https://proxycheck.io/v2/" + encodeURIComponent(ip) + "?vpn=3&risk=1&asn=1" +
    (key ? "&key=" + encodeURIComponent(key) : "");
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(BACKUP_MS) });
    const body = await res.json();
    return fromBackup(body && body.status !== "denied" && body.status !== "error" ? body[ip] : null);
  } catch (_) {
    return null;
  }
}

function settle(ip, value) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(ip, { ...value, until: Date.now() + TTL_MS });
  queue.delete(ip);
  return value;
}

function enqueue(ip) {
  if (queue.has(ip)) return;
  if (queue.size >= QUEUE_MAX) queue.delete(queue.keys().next().value);
  queue.set(ip, { since: Date.now(), tries: 0 });
}

function tell(ip, value) {
  if (!value || !value.flagged || !hooks.onFlag) return;
  try {
    hooks.onFlag(ip, value);
  } catch (e) {
    console.error("proxy guard follow-up failed:", e.message);
  }
}

async function lookup(ip) {
  let r = await owl(ip, true);
  if (r && r.value) return settle(ip, r.value);
  if (!r || !r.limited) {
    r = await owl(ip, false);
    if (r && r.value) return settle(ip, r.value);
  }
  const b = await backup(ip);
  if (b) return settle(ip, b);
  enqueue(ip);
  return null;
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

function start(ip) {
  if (pending.has(ip)) return pending.get(ip);
  const p = lookup(ip)
    .catch(() => {
      enqueue(ip);
      return null;
    })
    .then((value) => {
      pending.delete(ip);
      if (late.delete(ip)) tell(ip, value);
      return value;
    });
  pending.set(ip, p);
  return p;
}

async function check(rawIp, wait) {
  const ip = publicIp(rawIp);
  if (!ip) return null;
  const hit = cached(ip);
  if (hit) return { ...hit };
  if (queue.has(ip) && !pending.has(ip)) return null;
  const p = start(ip);
  if (!wait) return p;
  let timer;
  const out = await Promise.race([p, new Promise((res) => (timer = setTimeout(() => res(late), wait)))]);
  clearTimeout(timer);
  if (out === late) {
    late.add(ip);
    return null;
  }
  return out;
}

async function drain() {
  if (!queue.size) return;
  const now = Date.now();
  for (const ip of [...queue.keys()])
    if (hooks.isLive && !hooks.isLive(ip) && now - queue.get(ip).since > 60 * 1000) queue.delete(ip);
  const todo = [...queue.keys()].filter((ip) => !pending.has(ip));
  if (!todo.length) return;
  let done = new Set();
  let owlDown = !BASE;
  if (!paused()) {
    const room = left == null ? 40 : Math.max(0, left - RESERVE);
    const batch = todo.slice(0, Math.min(BATCH_MAX, room));
    if (batch.length)
      try {
        const res = await fetch(BASE + "/batch?fields=" + FIELDS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(FULL_MS * 2),
        });
        if (!note(res)) {
          const rows = await res.json();
          if (Array.isArray(rows))
            batch.forEach((ip, i) => {
              const value = fromOwl(rows[i]);
              if (!value) return;
              done.add(ip);
              settle(ip, value);
              tell(ip, value);
            });
          else owlDown = true;
        }
      } catch (_) {
        owlDown = true;
      }
  }
  if (owlDown)
    for (const ip of todo.filter((x) => !done.has(x)).slice(0, BACKUP_PER_TICK)) {
      const value = await backup(ip);
      if (!value) continue;
      settle(ip, value);
      tell(ip, value);
    }
  for (const ip of todo) {
    const q = queue.get(ip);
    if (q) q.tries++;
  }
}

function canReport(net) {
  return !!(BASE && net && net.flagged && net.source === "owl" && REPORTABLE.has(net.type));
}

async function report(rawIp, net) {
  const ip = publicIp(rawIp);
  if (!ip || !canReport(net)) return { outcome: "not-allowed" };
  const now = Date.now();
  const had = reviews.get(ip);
  if (had && now - had.at < REPORT_EVERY_MS) return { outcome: had.review === "rejected" ? "rejected" : "already-sent" };
  const day = new Date(now).toISOString().slice(0, 10);
  if (sentToday.day !== day) sentToday = { day, n: 0 };
  if (sentToday.n >= REPORT_DAY_MAX || paused()) return { outcome: "busy" };
  const type = net.type === "hosting" ? "not-hosting" : "not-proxy";
  try {
    const res = await fetch(BASE + "/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ip,
        type,
        note: "Refused at sign-in on a chat site. The person says they are not using a VPN, proxy or hosting network.",
      }),
      signal: AbortSignal.timeout(FULL_MS * 2),
    });
    if (note(res)) return { outcome: "busy" };
    const body = await res.json();
    if (!body || body.status !== "success") return { outcome: "busy" };
    sentToday.n++;
    if (body.outcome === "confirmed" || body.outcome === "already-detected") {
      cache.delete(ip);
      return { outcome: "fixed", type };
    }
    if (reviews.size >= MAX_ENTRIES) reviews.delete(reviews.keys().next().value);
    reviews.set(ip, { id: typeof body.id === "string" ? body.id : null, at: now, review: "waiting" });
    return { outcome: "sent", type };
  } catch (_) {
    return { outcome: "busy" };
  }
}

async function poll() {
  const now = Date.now();
  if (!BASE || !reviews.size || now - lastPoll < REPORT_POLL_MS || paused()) return;
  lastPoll = now;
  for (const [ip, r] of reviews) {
    if (now - r.at > REPORT_KEEP_MS) {
      reviews.delete(ip);
      continue;
    }
    if (r.review !== "waiting" || !r.id) continue;
    try {
      const res = await fetch(BASE + "/report/" + encodeURIComponent(r.id), { signal: AbortSignal.timeout(FULL_MS) });
      if (note(res)) return;
      if (res.status === 404) {
        reviews.delete(ip);
        continue;
      }
      const body = await res.json();
      if (!body || body.status !== "success") continue;
      if (body.review === "confirmed" && body.effect === "active") {
        r.review = "confirmed";
        cache.delete(ip);
      } else if (body.review === "rejected") r.review = "rejected";
    } catch (_) {}
  }
}

function init(next) {
  hooks = { ...hooks, ...(next || {}) };
  if (timer) return;
  timer = setInterval(() => {
    drain()
      .then(poll)
      .catch((e) => console.error("proxy guard queue failed:", e.message));
  }, DRAIN_MS);
  if (timer.unref) timer.unref();
}

const WHAT = {
  vpn: ["A VPN", "Turn off your VPN"],
  tor: ["Tor", "Close Tor and use a normal browser"],
  relay: ["A privacy relay", "Turn off the relay"],
  residential: ["A proxy", "Turn off the proxy"],
  public: ["A proxy", "Turn off the proxy"],
  proxy: ["A proxy", "Turn off the proxy"],
  hosting: ["A hosting or data centre network", "Switch to your normal home or mobile connection"],
};

function messageFor(net) {
  const n = net || {};
  if (n.type === "relay" && /icloud|apple/i.test(String(n.provider || "") + " " + String(n.network || "")))
    return (
      "iCloud Private Relay was detected on your connection. It works as a proxy, and proxies can't be used on Talkomatic. " +
      "Turn off iCloud Private Relay in your iCloud settings on your iPhone, iPad or Mac, then reload the page."
    );
  if (n.school)
    return (
      "A school network proxy was detected on your connection. VPNs, proxies and hosting networks can't be used on Talkomatic. " +
      "Switch to your home or mobile connection, then reload the page."
    );
  const [what, fix] = WHAT[n.type || "proxy"] || WHAT.proxy;
  return (
    what + " was detected on your connection. VPNs, proxies and hosting networks can't be used on Talkomatic. " +
    fix + ", then reload the page."
  );
}

function shouldReport(key) {
  const now = Date.now();
  const last = reported.get(key);
  if (last && now - last < REPORT_GAP_MS) return false;
  if (reported.size >= MAX_ENTRIES) reported.clear();
  reported.set(key, now);
  return true;
}

function status() {
  return {
    queued: queue.size,
    pending: pending.size,
    cached: cache.size,
    reviews: reviews.size,
    paused: Date.now() < pausedUntil,
    left,
    source: BASE ? "set" : "backup only",
  };
}

module.exports = { init, check, cached, shouldReport, messageFor, publicIp, status, canReport, report, poll, WAIT_MS, fromOwl, fromBackup, drain };
