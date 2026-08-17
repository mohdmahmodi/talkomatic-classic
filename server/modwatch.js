// server/modwatch.js
// Lightweight, tunable mod-abuse detector.

const audit = require("./audit");

const SHORT_MS = 5 * 60 * 1000;
const LONG_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LOG = 60;
const MAX_KEYS = 2000;

const THRESHOLDS = {
  short5: 12,
  long60: 60,
  minForShare: 8,
  kickShare: 0.7,
  sameTarget: 4,
  distinctBurst: 6,
};

const log = new Map();
const lastAlert = new Map();

function isKick(action) {
  return /kick/i.test(action || "");
}

function targetName(target) {
  const m = /^user:(.*)\(/.exec(target || "");
  return m ? m[1] : target || "";
}

function evictOldest() {
  let oldest = null;
  let ts = Infinity;
  for (const [h, a] of log) {
    const last = a.length ? a[a.length - 1].at : 0;
    if (last < ts) {
      ts = last;
      oldest = h;
    }
  }
  if (oldest) {
    log.delete(oldest);
    lastAlert.delete(oldest);
  }
}

function record({ hash, label, role, action, target, room, ip }) {
  if (!hash) return;
  const now = Date.now();
  let arr = log.get(hash) || [];
  arr.push({ at: now, action: action || "?", target: target || null, kick: isKick(action) });
  arr = arr.filter((e) => now - e.at <= LONG_MS);
  if (arr.length > MAX_LOG) arr = arr.slice(-MAX_LOG);
  log.set(hash, arr);
  if (log.size > MAX_KEYS) evictOldest();

  const recent5 = arr.filter((e) => now - e.at <= SHORT_MS);
  const reasons = [];

  if (recent5.length > THRESHOLDS.short5)
    reasons.push(`${recent5.length} actions in 5 min`);
  if (arr.length > THRESHOLDS.long60)
    reasons.push(`${arr.length} actions in 60 min`);

  const kicks5 = recent5.filter((e) => e.kick).length;
  if (
    recent5.length >= THRESHOLDS.minForShare &&
    kicks5 / recent5.length >= THRESHOLDS.kickShare
  )
    reasons.push(`${Math.round((kicks5 / recent5.length) * 100)}% of recent actions are kicks`);

  const targetCounts = {};
  for (const e of recent5)
    if (e.target) targetCounts[e.target] = (targetCounts[e.target] || 0) + 1;
  let maxSame = 0;
  let maxSameName = "";
  for (const t in targetCounts)
    if (targetCounts[t] > maxSame) {
      maxSame = targetCounts[t];
      maxSameName = targetName(t);
    }
  if (maxSame >= THRESHOLDS.sameTarget)
    reasons.push(`hit ${maxSameName || "one user"} ${maxSame} times in 5 min`);

  const distinct = Object.keys(targetCounts).length;
  if (distinct >= THRESHOLDS.distinctBurst)
    reasons.push(`hit ${distinct} different users in 5 min`);

  if (!reasons.length) return;
  if (now - (lastAlert.get(hash) || 0) < ALERT_COOLDOWN_MS) return;
  lastAlert.set(hash, now);

  const who = label || role || "A moderator";
  const recentList = arr
    .slice(-10)
    .map((e) => e.action + (e.target ? " > " + targetName(e.target) : ""))
    .join(", ");
  audit.recordNotification({
    kind: "abuse",
    role: role || "mod",
    label: who,
    text: `Possible mod abuse by ${who}: ${reasons.join("; ")}. Recent actions: ${recentList}.`,
    room: room || null,
    ip: ip || null,
    minLevel: 2,
    card: {
      target: who,
      targetRole: role || "mod",
      reason: reasons.join("; "),
      lines: arr
        .slice(-10)
        .map((e) => e.action + (e.target ? " > " + targetName(e.target) : "")),
    },
  });
}

module.exports = { record };
