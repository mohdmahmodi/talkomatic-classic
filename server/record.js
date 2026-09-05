// server/record.js
// One staff member's record: what they did, what the evidence said at the
// time, what happened afterwards, and how that compares with the rest of the
// team at the same level.

const audit = require("./audit");
const cases = require("./cases");
const persons = require("./persons");
const roles = require("./roles");
const appeals = require("./appeals");
const receipts = require("./receipts");

const WINDOW_MS = audit.HISTORY_WINDOW_MS;
const BASELINE_MS = 60 * 60 * 1000;
const MIN_PEER_DECISIONS = 20;
const MIN_PEERS = 3;
const OVERTURN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BOUNCE_MS = 60 * 60 * 1000;
const CHASE_MS = 2 * 60 * 1000;
const WRITEUP_DUE_MS = 24 * 60 * 60 * 1000;
const CASE_PAGE = 25;
const CASE_FILTERS = new Set(["all", "heavy", "contradicted", "contested"]);

const baselines = new Map();

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function isHeavy(d) {
  return d.parts.some((p) => audit.HEAVY.has(p));
}

function labelOf(reviewer) {
  const s = String(reviewer || "");
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(i + 1);
}

function dayKey(ts) {
  return new Date(ts).toDateString();
}

// ── Measures shared by the record and the team baseline ────────────────────

// Heavy decisions later undone by somebody else, or lifted on appeal by
// somebody else. The issuer catching their own mistake is not counted.
function undoIndex() {
  const byTarget = new Map();
  for (const e of audit.userActionEntries()) {
    const a = audit.toAct(e);
    if (!cases.UNDO.has(a.base) || !a.targetId) continue;
    if (!byTarget.has(a.targetId)) byTarget.set(a.targetId, []);
    byTarget.get(a.targetId).push(a);
  }
  return byTarget;
}

function overturnedBy(label, decisions, undos) {
  const out = [];
  for (const d of decisions) {
    if (!isHeavy(d) || !d.targetId) continue;
    const later = (undos.get(d.targetId) || []).find(
      (u) => u.ts > d.ts && u.ts - d.ts <= OVERTURN_WINDOW_MS && u.label !== label,
    );
    if (later) out.push({ d, by: later.label, at: later.ts });
  }
  for (const a of appeals.list()) {
    if (!a.ban || labelOf(a.ban.by) !== label || a.resolution !== "lifted") continue;
    const by = labelOf(a.reviewedBy);
    if (by === label) continue;
    const d = decisions.find((x) => x.ids.includes(a.ban.auditId));
    if (d && !out.some((o) => o.d === d)) out.push({ d, by, at: a.reviewedAt });
  }
  return out;
}

function isCold(d) {
  const r = d.receipt;
  if (!r || !isHeavy(d)) return false;
  if (r.grade === "corroborated" || r.grade === "reported") return false;
  if (r.prior.length || r.person.evader || r.person.bot) return false;
  return !receipts.NO_WARNING_RULES.has(r.reason.rule);
}

function isBlankWarn(d) {
  const r = d.receipt;
  return !!(
    r &&
    d.parts.includes("warn") &&
    r.bare &&
    !r.text &&
    r.reports.hour === 0 &&
    r.dislikes === 0
  );
}

function measures(label, decisions, undos, since) {
  const recent = decisions.filter((d) => d.ts >= since);
  const graded = recent.filter((d) => d.receipt);
  const counts = { corroborated: 0, reported: 0, unverifiable: 0, contradicted: 0 };
  for (const d of graded) counts[d.receipt.grade] = (counts[d.receipt.grade] || 0) + 1;
  const heavy = graded.filter(isHeavy);
  const warns = graded.filter((d) => d.parts.includes("warn"));
  return {
    total: graded.length,
    counts,
    contradictedPct: pct(counts.contradicted, graded.length),
    coldPct: pct(heavy.filter(isCold).length, heavy.length),
    blankWarnPct: pct(warns.filter(isBlankWarn).length, warns.length),
    overturned: overturnedBy(label, recent, undos).length,
  };
}

function rungOf(role, level) {
  if (role === "dev") return "admin";
  return level >= 2 ? "full" : "junior";
}

function peersOf(rung) {
  if (rung === "admin")
    return roles.listDevKeys(false).map((d) => ({ label: d.label, role: "dev" }));
  return roles
    .listModKeys()
    .filter((k) => rungOf("mod", k.level) === rung)
    .map((k) => ({ label: k.label, role: "mod" }));
}

// The median of everybody at the same rung with enough decisions to count.
// Peer names never leave this function.
function baselineFor(rung) {
  const hit = baselines.get(rung);
  if (hit && Date.now() - hit.at < BASELINE_MS) return hit.value;
  const since = Date.now() - WINDOW_MS;
  const undos = undoIndex();
  const rows = [];
  for (const p of peersOf(rung)) {
    const decisions = audit.toDecisions(
      audit.actsForLabel(p.label, p.role, since).filter((a) => a.group === "users"),
    );
    if (decisions.length < MIN_PEER_DECISIONS) continue;
    rows.push(measures(p.label, decisions, undos, since));
  }
  const value =
    rows.length < MIN_PEERS
      ? { peers: rows.length, enough: false }
      : {
          peers: rows.length,
          enough: true,
          contradictedPct: median(rows.map((r) => r.contradictedPct)),
          coldPct: median(rows.map((r) => r.coldPct)),
          blankWarnPct: median(rows.map((r) => r.blankWarnPct)),
          overturned: median(rows.map((r) => r.overturned)),
          corroboratedPct: median(rows.map((r) => pct(r.counts.corroborated, r.total))),
        };
  baselines.set(rung, { at: Date.now(), value });
  return value;
}

// ── Flags that need receipts or other people's actions ─────────────────────

function evidence(d, note, gap) {
  return audit.ev(d, gap == null ? null : gap, note);
}

function versus(mine, team, key) {
  if (!team || !team.enough || team[key] == null) return "";
  return ` You ${mine}%, team ${team[key]}%.`;
}

function coldFlag(decisions, team) {
  const heavy = decisions.filter((d) => d.receipt && isHeavy(d));
  const cold = heavy.filter(isCold);
  const rate = pct(cold.length, heavy.length);
  if (cold.length < 3 || rate < 50) return null;
  return {
    key: "cold",
    score: Math.min(100, 25 + cold.length * 5),
    title: cold.length + " heavy blocks with nothing on record first",
    detail:
      "Out of " +
      heavy.length +
      " heavy punishments with a snapshot, these had no earlier step by anyone, no report, nothing caught by the filters, and no rule that skips the warning." +
      versus(rate, team, "coldPct"),
    innocent:
      "Some things do not deserve a warning, and a moderator arriving mid-raid will not stop to issue one. Read what the snapshot says they typed.",
    evidence: cold.slice(-12).map((d) => evidence(d)),
  };
}

function chaseCounts(decisions) {
  const byPerson = new Map();
  for (const d of decisions) {
    const r = d.receipt;
    if (!r || !r.room || !r.actor.joinedAt || !r.target.joinedAt || !d.targetId) continue;
    const key = d.targetId + "|" + dayKey(d.ts);
    const cur = byPerson.get(key) || {
      name: d.targetName,
      chased: new Set(),
      cameToMod: new Set(),
      rows: [],
    };
    const gap = r.actor.joinedAt - r.target.joinedAt;
    if (gap > 0 && gap <= CHASE_MS) cur.chased.add(r.room.id);
    else if (gap < 0) cur.cameToMod.add(r.room.id);
    cur.rows.push(d);
    byPerson.set(key, cur);
  }
  return byPerson;
}

function followedFlag(decisions) {
  const worst = [...chaseCounts(decisions).values()]
    .filter((c) => c.chased.size >= 3)
    .sort((a, b) => b.chased.size - a.chased.size)[0];
  if (!worst) return null;
  return {
    key: "followed",
    score: 30 + worst.chased.size * 8,
    title: worst.name + " was followed into " + worst.chased.size + " rooms in one day",
    detail:
      "The moderator entered each of those rooms within two minutes after " +
      worst.name +
      " did. Join times are recorded on the snapshot, so this is measured, not guessed.",
    innocent:
      "Somebody who moves rooms to escape a moderator dealing with them produces this. Check whether the first room already had a case.",
    evidence: worst.rows
      .slice(-12)
      .map((d) =>
        evidence(
          d,
          "arrived " +
            audit.relGap(d.receipt.actor.joinedAt - d.receipt.target.joinedAt) +
            " after them",
        ),
      ),
  };
}

function blankWarnFlag(decisions, team) {
  const warns = decisions.filter((d) => d.receipt && d.parts.includes("warn"));
  const blank = warns.filter(isBlankWarn);
  const rate = pct(blank.length, warns.length);
  if (blank.length < 3 || rate < 30) return null;
  return {
    key: "blank-warns",
    score: Math.min(80, 15 + rate),
    title: blank.length + " warnings with nothing on record to warn about",
    detail:
      "Empty chat box, no reports, no dislikes, no earlier step, and no reason written." +
      versus(rate, team, "blankWarnPct"),
    innocent:
      "A warning for something said out loud in a voice room or on the board leaves no text. Ask what it was for.",
    evidence: blank.slice(-12).map((d) => evidence(d)),
  };
}

function unjustifiedFlag(decisions, now) {
  const missing = decisions.filter(
    (d) =>
      d.justify &&
      d.justify.required &&
      !d.justify.at &&
      now - d.ts > WRITEUP_DUE_MS,
  );
  if (!missing.length) return null;
  return {
    key: "unjustified",
    score: Math.min(100, 40 + missing.length * 10),
    title:
      missing.length +
      (missing.length === 1 ? " long block" : " long blocks") +
      " never written up",
    detail:
      "A 7-day or permanent block needs a written reason within the day. These are still blank.",
    innocent:
      "A block placed and then the moderator lost their connection or their key. Ask them to write it up now.",
    evidence: missing.slice(-12).map((d) => evidence(d)),
  };
}

function overturnedFlag(label, decisions, undos, team) {
  const list = overturnedBy(label, decisions, undos);
  if (list.length < 2) return null;
  return {
    key: "overturned",
    score: Math.min(100, 30 + list.length * 12),
    title: list.length + " punishments overturned by somebody else",
    detail:
      "Lifted by another staff member or granted on appeal by somebody other than the issuer." +
      (team && team.enough ? " Team median: " + team.overturned + "." : ""),
    innocent:
      "A temporary block lifted early as a courtesy counts here too. Read who lifted it and what they wrote.",
    evidence: list
      .slice(-12)
      .map((o) => evidence(o.d, "undone by " + o.by, o.at - o.d.ts)),
  };
}

function ownAppealFlag(label) {
  const own = appeals
    .list()
    .filter(
      (a) =>
        a.ban &&
        a.status === "resolved" &&
        labelOf(a.ban.by) === label &&
        labelOf(a.reviewedBy) === label,
    );
  if (!own.length) return null;
  return {
    key: "own-appeal",
    score: Math.min(100, 35 + own.length * 10),
    title: own.length + (own.length === 1 ? " appeal" : " appeals") + " decided against their own block",
    detail:
      "The person who placed the block also closed the appeal about it. The server refuses this now; these are from before.",
    innocent:
      "Nobody else was around and the appeal was plainly hopeless. Still worth a second pair of eyes.",
    evidence: own.slice(-12).map((a) => ({
      ts: a.reviewedAt,
      action: a.resolution === "lifted" ? "lift ban (appeal)" : "dismiss appeal",
      target: a.name || null,
      targetId: a.userId || null,
      room: null,
      gap: null,
      note: "their own " + (a.ban.permanent ? "permanent" : "temporary") + " block",
    })),
  };
}

function bouncedFlag(label, acts, idx) {
  const dismissals = acts.filter((a) => a.base === "dismiss report" && a.targetId);
  const bounced = [];
  for (const d of dismissals) {
    const later = (idx.get(d.targetId) || []).find(
      (o) => o.label !== label && o.ts > d.ts && o.ts - d.ts <= BOUNCE_MS,
    );
    if (later) bounced.push({ d, later });
  }
  const rate = pct(bounced.length, dismissals.length);
  if (bounced.length < 3 || rate < 25) return null;
  return {
    key: "bounced-dismissals",
    score: Math.min(80, 20 + rate),
    title: bounced.length + " dismissed reports where somebody else then acted",
    detail:
      "Within an hour of the report being dismissed, another staff member warned, kicked or blocked the same person. " +
      rate +
      "% of their dismissals.",
    innocent:
      "The person may have started again after being cleared. Compare the report's quote with what the other moderator saw.",
    evidence: bounced
      .slice(-12)
      .map((b) =>
        evidence(b.d, b.later.base + " by " + b.later.label, b.later.ts - b.d.ts),
      ),
  };
}

function actsByTarget() {
  const idx = new Map();
  for (const e of audit.userActionEntries()) {
    const a = audit.toAct(e);
    if (!a.targetId) continue;
    if (!idx.has(a.targetId)) idx.set(a.targetId, []);
    idx.get(a.targetId).push(a);
  }
  return idx;
}

function extraFlags(label, role, acts, decisions, team, who) {
  const now = Date.now();
  const undos = undoIndex();
  const found = [
    coldFlag(decisions, team),
    followedFlag(decisions),
    blankWarnFlag(decisions, team),
    unjustifiedFlag(decisions, now),
    overturnedFlag(label, decisions, undos, team),
    ownAppealFlag(label),
    bouncedFlag(label, acts, actsByTarget()),
  ].filter(Boolean);
  return found.map((f) => {
    const score = Math.max(0, Math.min(100, Math.round(f.score)));
    return audit.applyReview({ ...f, score, level: audit.levelFor(score) }, who);
  });
}

// The older "sought out" flag guessed at who arrived first. Where receipts
// can answer that and the answer is "they came to the moderator", it is
// replaced by a neutral notice.
function settleFollowing(flags, decisions) {
  const chased = chaseCounts(decisions);
  return flags.map((f) => {
    if (f.key !== "following") return f;
    const rows = f.evidence || [];
    const id = rows.length ? rows[0].targetId : null;
    if (!id) return f;
    const came = [...chased.entries()]
      .filter(([k]) => k.startsWith(id + "|"))
      .reduce((n, [, c]) => n + c.cameToMod.size, 0);
    if (!came) return f;
    return {
      ...f,
      key: "kept-turning-up",
      score: 15,
      level: "notice",
      title: (f.evidence[0].target || "One person") + " kept turning up where this moderator already was",
      detail:
        "Join times on the receipts show the person entering rooms the moderator was already in, " +
        came +
        " times. Nobody was followed.",
      innocent: "This is not a mark against anybody. It is here so the old pattern is not misread.",
    };
  });
}

// ── Masking for the reader ──────────────────────────────────────────────────

function redactStep(s, view) {
  return {
    ...s,
    by: roles.teamLabel(s.by, s.role, view),
    receipt: s.receipt && !view.ip ? audit.redactReceipt(s.receipt) : s.receipt,
  };
}

function redactCase(c, view) {
  const outcome = c.outcome && c.outcome.by
    ? { ...c.outcome, by: roles.teamLabel(c.outcome.by, null, view) }
    : c.outcome;
  const notes = c.notes
    ? Object.fromEntries(
        Object.entries(c.notes).map(([k, n]) => [
          k,
          { ...n, by: roles.teamLabel(n.by, null, view) },
        ]),
      )
    : null;
  return { ...c, outcome, notes, steps: c.steps.map((s) => redactStep(s, view)) };
}

function matchesFilter(c, filter) {
  if (filter === "heavy") return c.steps.some((s) => s.heavy);
  if (filter === "contradicted") return c.steps.some((s) => s.grade === "contradicted");
  if (filter === "contested")
    return ["overturned", "appeal open", "re-actioned", "upheld"].includes(c.outcome.kind);
  return true;
}

// ── The record itself ──────────────────────────────────────────────────────

function spanLabel(from, to) {
  const days = Math.floor(Math.max(0, to - from) / 86400000);
  if (days >= 60) return Math.floor(days / 30) + " months";
  if (days >= 14) return Math.floor(days / 7) + " weeks";
  if (days >= 1) return days + (days === 1 ? " day" : " days");
  return "less than a day";
}

function summaryLine(h, caseCount, flags) {
  const live = flags.filter((f) => f.level !== "reviewed").length;
  const reviewed = flags.length - live;
  const parts = [];
  if (h.first) parts.push("Active " + spanLabel(h.first, h.last || Date.now()) + ".");
  const people = h.distinctTargets || 0;
  parts.push(
    (h.onUsers || 0) +
      (h.onUsers === 1 ? " action on " : " actions on ") +
      people +
      (people === 1 ? " person in " : " people in ") +
      caseCount +
      (caseCount === 1 ? " case." : " cases."),
  );
  parts.push(
    live
      ? live + (live === 1 ? " thing" : " things") + " worth a look" + (reviewed ? ", " + reviewed + " reviewed." : ".")
      : reviewed
        ? "Everything flagged has been reviewed."
        : "Nothing flagged.",
  );
  return parts.join(" ");
}

function peopleOf(h) {
  return (h.targets || []).map((t) => {
    const p = persons.resolve(t.uid || t.name);
    return {
      ...t,
      personId: p.id,
      aka: p.names.filter((n) => n !== t.name),
      devices: p.devices.length,
    };
  });
}

function build(label, role, opts = {}, view = {}) {
  const h = audit.historyFor(label, role, opts);
  const level = role === "dev" ? 0 : roles.modLevelForLabel(label) || 1;
  const team = baselineFor(rungOf(role, level));
  const acts = audit.actsForLabel(label, role);
  const decisions = audit.toDecisions(acts.filter((a) => a.group === "users"));
  const who = { role: role || "mod", label };

  const flags = settleFollowing(h.flags || [], decisions)
    .concat(extraFlags(label, role, acts, decisions, team, who))
    .sort((a, b) => b.score - a.score);

  const all = cases.casesInvolving(label, role);
  const filter = CASE_FILTERS.has(opts.caseFilter) ? opts.caseFilter : "all";
  const matched = all.filter((c) => matchesFilter(c, filter));
  const caseOffset = Math.max(0, Number(opts.caseOffset) || 0);
  const undos = undoIndex();

  return {
    ...h,
    level,
    flags,
    quality: measures(label, decisions, undos, Date.now() - WINDOW_MS),
    team,
    summary: summaryLine(h, all.length, flags),
    people: peopleOf(h),
    cases: matched
      .slice(caseOffset, caseOffset + CASE_PAGE)
      .map((c) => redactCase(c, view)),
    casesTotal: all.length,
    casesMatched: matched.length,
    caseFilter: filter,
    caseOffset,
    casePage: CASE_PAGE,
  };
}

// Everything about one staff member in one document, written so a person or
// a language model can read it cold. Admins only; the caller checks.
const GUIDE = {
  purpose:
    "A complete moderator record from Talkomatic. Read the cases first: each one is one person, one sitting, every staff member involved, with the evidence captured at the moment of each action.",
  words:
    "A receipt in this file is called a snapshot on screen. The grade keys read as: corroborated = backed up, reported = reported by users, unverifiable = nothing captured, contradicted = nothing behind it, none = no snapshot.",
  grades: {
    corroborated: "The text the person had typed, or their history, supports the action.",
    reported: "Ordinary users had reported or disliked them shortly before.",
    unverifiable: "Nothing was captured that confirms or contradicts the action. Live typing means the line may already have been gone.",
    contradicted: "A heavy punishment with an empty or clean box, no reports, no earlier step by anyone, and no reason written.",
    none: "The action predates receipts. Never counted in any rate.",
  },
  ladder: {
    "mild-first": "A warning, kick or wipe came before the first heavy step.",
    "straight-heavy": "The first thing anybody did was a ban or block.",
    "no-heavy": "Nobody was banned or blocked in this case.",
  },
  outcomes: {
    quiet: "The person stayed online for thirty minutes and nobody acted on them again.",
    left: "They were gone within thirty minutes.",
    "came back": "They rejoined after being kicked, the number of times shown.",
    banned: "The last step was a ban or block.",
    evaded: "The ban-evasion watch matched them afterwards.",
    "re-actioned": "Somebody acted on the same person again within a day.",
    "appeal open": "An appeal about this block is still being handled.",
    upheld: "The appeal was declined.",
    overturned: "The block was lifted by somebody other than the issuer.",
    lifted: "The issuer lifted their own block.",
  },
  flags:
    "Prompts, not verdicts. Every flag names what tripped it, the rows it was built from, and what an innocent explanation would look like. Rates sit beside the team median for the same rank when enough peers exist.",
  writeups:
    "A 7-day or permanent block by a moderator needs a written justification: what the person did, the rule, what was tried first, and why this length. A missing one after a day is flagged.",
  masking: "Addresses are removed unless the export was made by the main developer.",
};

function exportRecord(label, role, view = {}) {
  const r = build(label, role, {}, view);
  const all = cases.casesInvolving(label, role).map((c) => redactCase(c, view));
  const entries = audit
    .entriesForLabel(label, role)
    .map((e) => (view.ip ? e : audit.redactEntry(e, view)));
  return {
    format: "talkomatic-mod-record",
    version: 1,
    exportedAt: new Date().toISOString(),
    guide: GUIDE,
    staff: {
      label,
      role,
      level: r.level,
      firstAction: r.first ? new Date(r.first).toISOString() : null,
      lastAction: r.last ? new Date(r.last).toISOString() : null,
      summary: r.summary,
    },
    totals: {
      total: r.total,
      onUsers: r.onUsers,
      useful: r.useful,
      passive: r.passive,
      distinctPeople: r.distinctTargets,
      byAction: r.counts,
      byGroup: r.groups,
    },
    quality: r.quality,
    team: r.team,
    flags: r.flags,
    people: r.people,
    cases: all,
    entries,
  };
}

module.exports = { build, exportRecord, redactCase, baselineFor, CASE_PAGE };
