// server/applications.js
// Moderator-application store. Active members apply to become a (junior) mod;
// a dev or full mod reviews and approves. Approval grants an L1 key - delivered
// to the applicant immediately if they're online, otherwise claimed on their
// next connect (the key is minted at delivery, so no plaintext is ever stored).
//
// Persisted to mod-applications.json the same way as the other JSON stores
// (atomic tmp + rename, debounced), capped and never committed.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const APPS_PATH = path.join(DATA_DIR, "mod-applications.json");
const OPEN_PATH = path.join(DATA_DIR, "applications-open.json");
const MAX = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 3; // submissions per device per rolling 24h

// { id, deviceId, ip, username, answers, submittedAt, status, reviewedBy,
//   reviewedAt, reason, claimed }
let apps = [];
let seq = 0;
let saveTimer = null;

// Whether new applications are being accepted. Kept in its own file rather
// than in memory: a switch that quietly flipped itself back on at every deploy
// is the same as no switch at all, which is exactly how it behaved. Closed
// unless somebody has opened it, so intake never reopens on its own.
let open = false;

function loadOpen() {
  try {
    const o = JSON.parse(fs.readFileSync(OPEN_PATH, "utf8"));
    open = !!(o && o.open);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading applications-open.json:", err);
    open = false;
  }
}

function isOpen() {
  return open;
}

// Written straight through rather than debounced: this is a rare, deliberate
// act, and it has to survive the restart that happens seconds later.
async function setOpen(v) {
  open = !!v;
  const tmp = OPEN_PATH + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify({ open }), "utf8");
  await fsp.rename(tmp, OPEN_PATH);
  return open;
}

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(APPS_PATH, "utf8"));
    apps = Array.isArray(arr) ? arr : [];
    seq = apps.reduce((m, a) => Math.max(m, a.id || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading mod-applications.json:", err);
    apps = [];
  }
  loadOpen();
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (apps.length > MAX) apps = apps.slice(-MAX);
      const tmp = APPS_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(apps, null, 2), "utf8");
      await fsp.rename(tmp, APPS_PATH);
    } catch (e) {
      console.error("mod-applications save failed:", e);
    }
  }, 3000);
}

function pendingForDevice(deviceId) {
  return apps.find((a) => a.deviceId === deviceId && a.status === "pending");
}

// How many times this device has submitted in the trailing window, counting
// every status so re-applying after a rejection still adds up.
function recentCountForDevice(deviceId, windowMs) {
  if (!deviceId) return 0;
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (const a of apps)
    if (a.deviceId === deviceId && (a.submittedAt || 0) >= cutoff) n++;
  return n;
}

function submit({ deviceId, ip, username, answers, discordId, discord }, opts = {}) {
  if (!deviceId) return { ok: false, error: "This browser can't be identified." };
  if (pendingForDevice(deviceId))
    return { ok: false, error: "You already have an application pending." };
  // Spam guard: 3 submissions in 24h locks further tries until the oldest of
  // those ages out. A system-filed application bypasses it.
  if (!opts.system && recentCountForDevice(deviceId, DAY_MS) >= DAILY_LIMIT)
    return {
      ok: false,
      error:
        "You've sent too many applications recently. Please try again in 24 hours.",
    };
  const app = {
    id: ++seq,
    deviceId,
    ip: ip || null,
    username: username || null,
    answers: answers || {},
    // How a reviewer finds them in the Talkomatic Discord: the username they
    // typed, plus the account id when they have their Discord picture linked.
    discord: discord || null,
    discordId: discordId || null,
    submittedAt: Date.now(),
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    reason: null,
    claimed: false,
  };
  apps.push(app);
  if (apps.length > MAX) apps = apps.slice(-MAX);
  saveSoon();
  return { ok: true, id: app.id };
}

function get(id) {
  return apps.find((a) => a.id === id) || null;
}

function setStatus(id, status, reviewedBy, reason) {
  const a = get(id);
  if (!a) return null;
  a.status = status;
  a.reviewedBy = reviewedBy || null;
  a.reviewedAt = Date.now();
  a.reason = reason || null;
  saveSoon();
  return a;
}

function unclaimedApproved(deviceId) {
  return apps.find(
    (a) => a.deviceId === deviceId && a.status === "approved" && !a.claimed,
  );
}

// The most recent application from a device, whatever its status. Powers the
// lobby "Check status" link so an applicant can see pending / approved /
// rejected and any note the reviewer left.
function latestForDevice(deviceId) {
  if (!deviceId) return null;
  let best = null;
  for (const a of apps)
    if (a.deviceId === deviceId && (!best || (a.id || 0) > (best.id || 0)))
      best = a;
  return best;
}

function markClaimed(id) {
  const a = get(id);
  if (a) {
    a.claimed = true;
    saveSoon();
  }
}

function pendingCount() {
  return apps.reduce((n, a) => n + (a.status === "pending" ? 1 : 0), 0);
}

// Newest first. The caller decides whether to include the IP (dev-only).
function list() {
  return apps.slice().sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
}

// Synchronous write for a clean shutdown (survives the debounce window).
function flushSync() {
  try {
    if (apps.length > MAX) apps = apps.slice(-MAX);
    const tmp = APPS_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(apps, null, 2), "utf8");
    fs.renameSync(tmp, APPS_PATH);
  } catch (e) {
    console.error("applications flush failed:", e);
  }
}

load();

module.exports = {
  isOpen,
  setOpen,
  submit,
  get,
  setStatus,
  unclaimedApproved,
  latestForDevice,
  markClaimed,
  pendingForDevice,
  pendingCount,
  list,
  flushSync,
};
