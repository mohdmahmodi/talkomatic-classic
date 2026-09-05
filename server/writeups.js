// server/writeups.js
// The write-up a full mod or leader owes after a 7-day or permanent block.
// The block never waits for it. The debt does: an overdue write-up holds the
// next long block until it is written, and a day of silence tells the leads.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const audit = require("./audit");
const durations = require("./durations");

const STORE_PATH = path.join(DATA_DIR, "pending-writeups.json");
const GRACE_MS = 10 * 60 * 1000;
const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

const NEEDS_WRITEUP = durations.LONG;
const TRIED = new Set(["warned-me", "warned-other", "kicked", "rules", "nothing"]);
const MIN_CHARS = { did: 30, why: 20, length: 20 };
const MIN_WORDS = 4;
const RULE_MAX = 30;

let pending = {};
let saveTimer = null;

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (o && typeof o === "object") pending = o;
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading pending-writeups.json:", err);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(pending, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("pending-writeups save failed:", e);
    }
  }, 1000);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("pending-writeups flush failed:", e);
  }
}

// Mods write up their long blocks. Admins are the readers, so they do not.
function requiredFor(socket, duration) {
  return !!(
    socket &&
    socket.isMod &&
    !socket.isDev &&
    NEEDS_WRITEUP.has(duration)
  );
}

function owe(hash, debt) {
  if (!hash || !debt || !debt.entryId) return;
  const list = pending[hash] || (pending[hash] = []);
  list.push({ ...debt, due: debt.at + GRACE_MS, alerted: false });
  saveSoon();
}

function listFor(hash) {
  return (pending[hash] || []).slice();
}

function overdue(hash, now = Date.now()) {
  return (pending[hash] || []).filter((d) => d.due <= now);
}

function settle(hash, entryId) {
  const list = pending[hash];
  if (!list) return false;
  const kept = list.filter((d) => d.entryId !== entryId);
  if (kept.length === list.length) return false;
  if (kept.length) pending[hash] = kept;
  else delete pending[hash];
  saveSoon();
  return true;
}

function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function distinctWords(s) {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter(Boolean),
  ).size;
}

function thin(s, min) {
  return s.length < min || distinctWords(s) < MIN_WORDS || /(.)\1{6,}/.test(s);
}

function validate(input) {
  const f = {
    did: clean(input && input.did, 600),
    rule: Number(input && input.rule),
    tried: clean(input && input.tried, 20),
    why: clean(input && input.why, 400),
    length: clean(input && input.length, 400),
  };
  if (thin(f.did, MIN_CHARS.did))
    return { ok: false, error: "Say what they did, in at least a sentence." };
  if (!Number.isInteger(f.rule) || f.rule < 1 || f.rule > RULE_MAX)
    return { ok: false, error: "Pick the rule they broke." };
  if (!TRIED.has(f.tried))
    return { ok: false, error: "Say what was tried first." };
  if (f.tried === "nothing" && thin(f.why, MIN_CHARS.why))
    return {
      ok: false,
      error: "Explain why a milder step would not have worked.",
    };
  if (f.tried !== "nothing") f.why = f.why || null;
  if (thin(f.length, MIN_CHARS.length))
    return { ok: false, error: "Say why this length." };
  return { ok: true, fields: f };
}

// A day after the block with nothing written, the leads hear about it. The
// block itself stays: an underage or evasion block must not lapse because a
// moderator went quiet. People decide that.
function sweep(now = Date.now()) {
  let changed = false;
  for (const hash of Object.keys(pending)) {
    for (const d of pending[hash]) {
      if (d.alerted || now - d.at < ALERT_AFTER_MS) continue;
      d.alerted = true;
      changed = true;
      audit.recordNotification({
        kind: "writeup",
        role: "mod",
        label: d.label,
        minLevel: 3,
        devOnly: (d.level || 1) >= 3,
        text: `${d.label} placed a ${d.duration} block on ${d.target || "somebody"} a day ago and has not written it up.`,
        card: {
          target: d.label,
          targetRole: "mod",
          itemId: d.entryId,
          reason: `${d.duration} block on ${d.target || "somebody"}, no write-up after 24 hours`,
        },
      });
    }
  }
  if (changed) saveSoon();
}

load();
const sweeper = setInterval(sweep, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = {
  requiredFor,
  owe,
  listFor,
  overdue,
  settle,
  validate,
  sweep,
  flushSync,
  NEEDS_WRITEUP,
  TRIED,
};
