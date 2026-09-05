// server/modwatch.js
// Live watch on how fast a moderator is acting on people. It reads the same
// decisions the record does, so ten appeal replies are one conversation and
// a ban button is one decision rather than three.

const audit = require("./audit");
const receipts = require("./receipts");

const SHORT_MS = 5 * 60 * 1000;
const LONG_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

const LIMITS = {
  decisions5: 12,
  samePerson: 4,
  distinctPeople: 6,
  coldHeavy: 3,
};

const lastAlert = new Map();

function isKick(d) {
  return d.parts.some((p) => audit.REQUIRES_REJOIN.has(p));
}

function isHeavy(d) {
  return d.parts.some((p) => audit.HEAVY.has(p));
}

function describe(d) {
  const what = d.parts.length > 1 ? d.parts.join(" + ") : d.base;
  const who = d.targetName ? " > " + d.targetName : "";
  const q = d.receipt ? receipts.quote(d.receipt) : null;
  return what + who + (q ? ': "' + q.slice(0, 80) + '"' : "");
}

function reasonsFor(recent) {
  const reasons = [];
  if (recent.length > LIMITS.decisions5)
    reasons.push(`${recent.length} decisions on people in 5 min`);

  const perPerson = new Map();
  for (const d of recent) {
    if (!d.targetId || isKick(d)) continue;
    const cur = perPerson.get(d.targetId) || { name: d.targetName, n: 0 };
    cur.n++;
    perPerson.set(d.targetId, cur);
  }
  for (const p of perPerson.values())
    if (p.n >= LIMITS.samePerson) {
      reasons.push(`${p.n} passes at ${p.name || "one person"} in 5 min`);
      break;
    }

  const people = new Set(recent.map((d) => d.targetId).filter(Boolean));
  if (people.size >= LIMITS.distinctPeople)
    reasons.push(`${people.size} different people in 5 min`);

  const cold = new Set(
    recent
      .filter((d) => isHeavy(d) && d.receipt && d.receipt.grade === "contradicted")
      .map((d) => d.targetId),
  );
  if (cold.size >= LIMITS.coldHeavy)
    reasons.push(`${cold.size} heavy punishments with nothing on record to support them`);
  return reasons;
}

function record({ hash, label, role, level, room, ip }) {
  if (!hash || !label) return;
  const now = Date.now();
  const hour = audit.recentDecisionsFor(label, LONG_MS);
  const recent = hour.filter((d) => now - d.ts <= SHORT_MS);
  const reasons = reasonsFor(recent);
  if (!reasons.length) return;
  if (now - (lastAlert.get(hash) || 0) < ALERT_COOLDOWN_MS) return;
  lastAlert.set(hash, now);

  const lines = hour.slice(-10).map(describe);
  audit.recordNotification({
    kind: "abuse",
    role: role || "mod",
    label,
    text: `Possible mod abuse by ${label}: ${reasons.join("; ")}. Recent actions: ${lines.join(", ")}.`,
    room: room || null,
    ip: ip || null,
    minLevel: 3,
    devOnly: (level || 1) >= 3,
    card: {
      target: label,
      targetRole: role || "mod",
      reason: reasons.join("; "),
      lines,
    },
  });
}

module.exports = { record };
