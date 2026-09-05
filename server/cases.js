// server/cases.js
// A case is one person, one sitting, and every staff member who touched it.
// Built from the audit log when asked for. The only thing stored here is the
// note a moderator or a reviewer attaches to a case.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const audit = require("./audit");
const persons = require("./persons");
const appeals = require("./appeals");

const NOTES_PATH = path.join(DATA_DIR, "case-notes.json");
const QUIET_MS = 30 * 60 * 1000;
const FOLLOW_UP_MS = 24 * 60 * 60 * 1000;
const OVERTURN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const UNDO = new Set(["lift ban", "unblock ip"]);
const NOTE_MAX = 300;
const NOTE_KINDS = new Set(["mod", "reviewer"]);

let notes = {};
let saveTimer = null;

// ── Notes ───────────────────────────────────────────────────────────────────

function loadNotes() {
  try {
    const o = JSON.parse(fs.readFileSync(NOTES_PATH, "utf8"));
    if (o && typeof o === "object") notes = o;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading case-notes.json:", err);
  }
}

function saveNotesSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = NOTES_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(notes, null, 2), "utf8");
      await fsp.rename(tmp, NOTES_PATH);
    } catch (e) {
      console.error("case-notes save failed:", e);
    }
  }, 1000);
}

function setNote(caseId, kind, by, text) {
  if (!Number.isInteger(caseId) || !NOTE_KINDS.has(kind)) return null;
  const body = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);
  const c = notes[caseId] || (notes[caseId] = {});
  if (body) c[kind] = { by, text: body, at: Date.now() };
  else delete c[kind];
  if (!Object.keys(c).length) delete notes[caseId];
  saveNotesSoon();
  return notes[caseId] || null;
}

function notesFor(caseId) {
  return notes[caseId] || null;
}

// ── Building cases ──────────────────────────────────────────────────────────

// Every action that landed on a person, indexed by user id and device id, so
// a record with three hundred targets does not scan the log three hundred
// times.
function indexActs() {
  const byUid = new Map();
  const byDid = new Map();
  const put = (map, key, act) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(act);
  };
  for (const e of audit.userActionEntries()) {
    const act = audit.toAct(e);
    put(byUid, act.targetId, act);
    if (act.tgt && act.tgt.did) put(byDid, act.tgt.did, act);
  }
  return { byUid, byDid };
}

function actsFor(person, idx) {
  const seen = new Set();
  const acts = [];
  const take = (list) => {
    for (const a of list || [])
      if (!seen.has(a.id)) {
        seen.add(a.id);
        acts.push(a);
      }
  };
  for (const uid of person.userIds) take(idx.byUid.get(uid));
  for (const d of person.devices) take(idx.byDid.get(d.id));
  if (person.standalone) take(idx.byUid.get(person.id));
  return acts.sort((a, b) => a.ts - b.ts);
}

function stepOf(d) {
  return {
    id: d.id,
    ids: d.ids,
    ts: d.ts,
    by: d.label,
    role: d.role,
    action: d.parts.length > 1 ? d.parts.join(" + ") : d.action,
    parts: d.parts,
    targetName: d.targetName,
    room: d.roomName,
    roomId: d.roomId,
    heavy: d.parts.some((p) => audit.HEAVY.has(p)),
    mild: d.parts.some((p) => audit.MILD.has(p)),
    kick: d.parts.some((p) => audit.REQUIRES_REJOIN.has(p)),
    undo: d.parts.some((p) => UNDO.has(p)),
    grade: d.receipt ? d.receipt.grade : "none",
    receipt: d.receipt || null,
    justify: d.justify || null,
  };
}

function labelOf(reviewer) {
  const s = String(reviewer || "");
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(i + 1);
}

function mildBefore(steps, i) {
  if (steps.slice(0, i).some((s) => s.mild)) return true;
  const r = steps[i].receipt;
  return !!(
    r && r.prior.some((p) => audit.MILD.has(audit.baseAction(p.action)))
  );
}

function appealOutcome(heavy) {
  const ids = new Set(heavy.flatMap((s) => s.ids));
  const a = appeals.list().find((x) => x.ban && ids.has(x.ban.auditId));
  if (!a) return null;
  const issuer = heavy.find((s) => s.ids.includes(a.ban.auditId)).by;
  if (a.status !== "resolved") return { kind: "appeal open", appealId: a.id };
  const by = labelOf(a.reviewedBy);
  const own = by === issuer;
  if (a.resolution === "lifted")
    return { kind: own ? "lifted" : "overturned", by, at: a.reviewedAt, appealId: a.id };
  return { kind: "upheld", by, at: a.reviewedAt, appealId: a.id, ownAppeal: own };
}

function outcomeOf(c, steps, heavy, person, later, next) {
  const fromAppeal = appealOutcome(heavy);
  if (fromAppeal) return fromAppeal;
  const issuers = new Set(heavy.map((s) => s.by));
  const undone = heavy.length
    ? later.find(
        (d) =>
          d.parts.some((p) => UNDO.has(p)) &&
          d.ts - c.endTs <= OVERTURN_WINDOW_MS,
      )
    : null;
  if (undone)
    return {
      kind: issuers.has(undone.label) ? "lifted" : "overturned",
      by: undone.label,
      at: undone.ts,
    };
  if (person.devices.some((d) => d.evaderAt && d.evaderAt > c.endTs))
    return { kind: "evaded" };
  if (heavy.length) return { kind: "banned" };
  if (next && next.startTs - c.endTs <= FOLLOW_UP_MS)
    return { kind: "re-actioned", by: next.steps[0].label, at: next.startTs };
  const kicks = steps.filter((s) => s.kick).length;
  if (kicks >= 2) return { kind: "came back", n: kicks - 1 };
  if (!person.devices.length) return { kind: "unknown" };
  return person.last >= c.endTs + QUIET_MS ? { kind: "quiet" } : { kind: "left" };
}

function finish(c, person, later, next) {
  const steps = c.steps.map(stepOf);
  const heavy = steps.filter((s) => s.heavy);
  const first = steps.findIndex((s) => s.heavy);
  return {
    id: steps[0].id,
    personId: person.id,
    names: [...new Set(steps.map((s) => s.targetName).filter(Boolean))],
    rooms: [...new Set(steps.map((s) => s.room).filter(Boolean))],
    startTs: c.startTs,
    endTs: c.endTs,
    steps,
    ladder: !heavy.length
      ? "no-heavy"
      : mildBefore(steps, first)
        ? "mild-first"
        : "straight-heavy",
    outcome: outcomeOf(c, steps, heavy, person, later, next),
    notes: notesFor(steps[0].id),
  };
}

function forPerson(person, idx) {
  const decisions = audit.toDecisions(actsFor(person, idx));
  const sittings = [];
  let cur = null;
  for (const d of decisions) {
    if (cur && d.ts - cur.endTs <= audit.INCIDENT_GAP_MS) {
      cur.steps.push(d);
      cur.endTs = Math.max(cur.endTs, d.lastTs);
      continue;
    }
    cur = { steps: [d], startTs: d.ts, endTs: d.lastTs };
    sittings.push(cur);
  }
  const real = sittings.filter((s) =>
    s.steps.some((d) => !d.parts.every((p) => UNDO.has(p))),
  );
  return real.map((s, i) => {
    const later = decisions.filter((d) => d.ts > s.endTs);
    return finish(s, person, later, real[i + 1] || null);
  });
}

function casesForPerson(key) {
  const person = persons.resolve(key);
  return { person, cases: forPerson(person, indexActs()).reverse() };
}

// The case whose first step is this audit entry.
function caseById(id) {
  const entry = audit.getEntry(Number(id));
  if (!entry || entry.type !== "action") return null;
  const act = audit.toAct(entry);
  if (!act.targetId) return null;
  const person = persons.resolve(act.tgt && act.tgt.did ? act.tgt.did : act.targetId);
  return forPerson(person, indexActs()).find((c) => c.id === entry.id) || null;
}

// Every case a staff member took part in, newest first.
function casesInvolving(label, role) {
  const idx = indexActs();
  const mine = audit
    .actsForLabel(label, role)
    .filter((a) => a.group === "users" && a.targetId);
  const people = new Map();
  for (const a of mine) {
    const p = persons.resolve(a.tgt && a.tgt.did ? a.tgt.did : a.targetId);
    if (!people.has(p.id)) people.set(p.id, p);
  }
  const out = new Map();
  for (const p of people.values())
    for (const c of forPerson(p, idx))
      if (c.steps.some((s) => s.by === label)) out.set(c.id, c);
  return [...out.values()].sort((a, b) => b.startTs - a.startTs);
}

loadNotes();

module.exports = {
  casesInvolving,
  casesForPerson,
  caseById,
  setNote,
  notesFor,
  UNDO,
  NOTE_MAX,
};
