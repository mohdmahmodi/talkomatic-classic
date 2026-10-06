// server/banstatus.js

const { state } = require("./state");
const ipban = require("./ipban");
const durations = require("./durations");
const banhistory = require("./banhistory");

const AUTOMOD = "Automod";
const AUTOMOD_EVASION =
  "Automod: ban evasion detected. This connection belongs to an account that is already banned.";
const SPELL_GAP_MS = 5000;

function shownReason(by, reason) {
  const r = reason ? String(reason) : "";
  if (by) return r || null;
  if (!r) return by === null ? AUTOMOD_EVASION : null;
  if (r === "Ban evasion.") return AUTOMOD_EVASION;
  if (/^Flood guard: /.test(r)) return "Automod: " + r.slice("Flood guard: ".length);
  return r;
}

function liveBlock(key) {
  const b = state.blockedIPs.get(key);
  if (b === undefined || !ipban.isActiveBlock(b)) return null;
  return {
    permanent: ipban.isPermanentBlock(b),
    expiry: b && typeof b === "object" ? b.expiry : b,
  };
}

function statusOf(e, next, now) {
  if (next && next.action === "unban")
    return { status: "lifted", endedAt: next.at, liftedBy: next.by || null, liftedByRole: next.byRole || null };
  if (next && next.action === "ban") {
    const ms = durations.msFor(e.duration);
    if (ms && ms !== Infinity && e.at + ms <= next.at) return { status: "served", endedAt: e.at + ms };
    return { status: "replaced", endedAt: next.at };
  }
  const live = liveBlock(e.ip);
  if (live) return live.permanent ? { status: "permanent" } : { status: "active", endsAt: live.expiry };
  const ms = durations.msFor(e.duration);
  if (ms && ms !== Infinity) {
    const end = e.at + ms;
    if (end <= now) return { status: "served", endedAt: end };
  }
  return { status: "ended", endedAt: null };
}

function statuses(events, now = Date.now()) {
  const byKey = new Map();
  for (const e of events) {
    if (!e.ip) continue;
    if (!byKey.has(e.ip)) byKey.set(e.ip, []);
    byKey.get(e.ip).push(e);
  }
  const out = new Map();
  for (const list of byKey.values()) {
    list.sort((a, b) => a.at - b.at || a.id - b.id);
    for (let i = 0; i < list.length; i++)
      if (list[i].action === "ban") out.set(list[i].id, statusOf(list[i], list[i + 1], now));
  }
  return out;
}

const RANK = { active: 5, permanent: 5, lifted: 4, replaced: 3, served: 2, ended: 1 };

let memo = null;

function recentWithStatus() {
  const all = banhistory.recent(5000);
  const top = all.length ? all[0].id : 0;
  const now = Date.now();
  if (!memo || memo.top !== top || memo.size !== all.length || now - memo.at > 5000)
    memo = { top, size: all.length, at: now, all, st: statuses(all, now) };
  return memo;
}

function spellsFor(matches, limit = 20) {
  const { all, st } = recentWithStatus();
  const spells = [];
  for (const e of all) {
    if (e.action !== "ban" || !matches(e.ip)) continue;
    const s = st.get(e.id) || { status: "ended" };
    const last = spells[spells.length - 1];
    if (last && Math.abs(last.at - e.at) < SPELL_GAP_MS) {
      if ((RANK[s.status] || 0) > (RANK[last.status] || 0)) {
        for (const k of ["endsAt", "endedAt", "liftedBy", "liftedByRole", "permanent"]) delete last[k];
        Object.assign(last, s);
      }
      if (!last.reason && e.reason) last.reason = e.reason;
      continue;
    }
    if (spells.length >= limit) break;
    spells.push({
      at: e.at,
      by: e.by || null,
      byRole: e.byRole || null,
      name: e.name || null,
      duration: e.duration || null,
      reason: e.reason || null,
      ...s,
    });
  }
  return spells;
}

function summarize(spells) {
  const count = (k) => spells.filter((s) => s.status === k).length;
  return {
    total: spells.length,
    active: count("active") + count("permanent"),
    served: count("served"),
    lifted: count("lifted"),
    last: spells[0] || null,
  };
}

module.exports = { AUTOMOD, AUTOMOD_EVASION, shownReason, statuses, spellsFor, summarize };
