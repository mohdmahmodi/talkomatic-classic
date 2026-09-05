// server/durations.js
// The block lengths staff can pick. One ladder, each step a few times longer
// than the last. The client keeps the same table in staff-ui.js; change both.

const DURATIONS = [
  { key: "1h", ms: 60 * 60 * 1000, label: "1 hour" },
  { key: "6h", ms: 6 * 60 * 60 * 1000, label: "6 hours" },
  { key: "24h", ms: 24 * 60 * 60 * 1000, label: "1 day" },
  { key: "3d", ms: 3 * 24 * 60 * 60 * 1000, label: "3 days" },
  { key: "7d", ms: 7 * 24 * 60 * 60 * 1000, label: "1 week" },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000, label: "1 month" },
  { key: "permanent", ms: Infinity, label: "Permanent" },
];

const byKey = new Map(DURATIONS.map((d) => [d.key, d]));

// A week or longer is a long block: it needs a write-up from a moderator.
const LONG = new Set(["7d", "30d", "permanent"]);

const USAGE = "Use " + DURATIONS.map((d) => d.key).join(", ") + ".";

function isValid(key) {
  return byKey.has(key);
}

function msFor(key) {
  const d = byKey.get(key);
  return d ? d.ms : undefined;
}

function expiryFor(key, now = Date.now()) {
  const ms = msFor(key);
  if (ms === undefined) return undefined;
  return ms === Infinity ? Number.MAX_SAFE_INTEGER : now + ms;
}

function labelFor(key) {
  const d = byKey.get(key);
  return d ? d.label : String(key || "");
}

module.exports = { DURATIONS, LONG, USAGE, isValid, msFor, expiryFor, labelFor };
