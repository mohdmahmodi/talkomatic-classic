// server/buffertrail.js
// What a person's chat box said recently. Reports, wipes and receipts read
// from here, so clearing the box before staff look does not erase the line.
// Kept server-side on purpose: nobody can forge what somebody else typed.

const KEEP_MS = 10 * 60 * 1000;
const KEEP_N = 5;
const MIN_CHARS = 3;
const MAX_CHARS = 300;
const SETTLE_MS = 20 * 1000;

const trails = new Map();
const settleTimers = new Map();

function remember(userId, text) {
  const t = String(text || "").trim();
  if (t.length < MIN_CHARS) return;
  const now = Date.now();
  const arr = trails.get(userId) || [];
  const last = arr[arr.length - 1];
  if (last && last.text === t.slice(0, MAX_CHARS)) {
    last.at = now;
    return;
  }
  arr.push({ text: t.slice(0, MAX_CHARS), at: now });
  if (arr.length > KEEP_N) arr.shift();
  trails.set(userId, arr);
}

function armSettle(userId, text) {
  clearTimeout(settleTimers.get(userId));
  settleTimers.delete(userId);
  if (String(text || "").trim().length < MIN_CHARS) return;
  const t = setTimeout(() => {
    settleTimers.delete(userId);
    remember(userId, text);
  }, SETTLE_MS);
  if (t.unref) t.unref();
  settleTimers.set(userId, t);
}

// Called on every buffer write. A hard shrink or a wipe saves the old text at
// once; anything left standing for twenty seconds is saved as well.
function noteChange(userId, oldText, newText) {
  const oldLen = (oldText || "").trim().length;
  const newLen = (newText || "").trim().length;
  const shrank = newLen === 0 || newLen < oldLen / 2;
  if (oldLen >= MIN_CHARS && shrank) remember(userId, oldText);
  armSettle(userId, newText);
}

function recent(userId) {
  const arr = trails.get(userId);
  if (!arr) return [];
  const cutoff = Date.now() - KEEP_MS;
  while (arr.length && arr[0].at < cutoff) arr.shift();
  if (!arr.length) {
    trails.delete(userId);
    return [];
  }
  return arr.slice();
}

function lastSeen(userId) {
  const arr = recent(userId);
  return arr.length ? arr[arr.length - 1] : null;
}

function forget(userId) {
  trails.delete(userId);
  clearTimeout(settleTimers.get(userId));
  settleTimers.delete(userId);
}

module.exports = { noteChange, remember, recent, lastSeen, forget, MAX_CHARS };
