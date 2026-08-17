// server/blocklist.js
// Disk persistence for the IP ban list so blocks survive a restart or update.
// The live data stays in state.blockedIPs (ip -> { expiry, label, by, ts,
// reason }), which the rest of the app reads directly; this module just loads it
// at boot and writes it back on change. Loading tolerates old/missing fields.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { state } = require("./state");
const ipban = require("./ipban");

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "blocklist.json");
let saveTimer = null;

function snapshot() {
  return Object.fromEntries(state.blockedIPs);
}

// Populate state.blockedIPs from disk, skipping anything already expired.
function load() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const now = Date.now();
    if (obj && typeof obj === "object")
      for (const [ip, b] of Object.entries(obj)) {
        const expiry = b && typeof b === "object" ? b.expiry : b;
        if (expiry && expiry !== Number.MAX_SAFE_INTEGER && now >= expiry)
          continue;
        // A v6 ban written as one address was banning nothing: the client
        // rotates inside its own /64 and walks straight back in. New ones
        // cover the range; these are brought up to the same rule on the way
        // in, keeping whichever entry runs longest if both are on file.
        const key = ipban.autoRangeCidr(ip) || ip;
        const held = state.blockedIPs.get(key);
        if (held !== undefined && longerOf(held) >= longerOf(b)) continue;
        state.blockedIPs.set(key, b);
      }
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading blocklist.json:", err);
  }
}

function longerOf(b) {
  const e = b && typeof b === "object" ? b.expiry : b;
  return e || 0;
}

// Atomic write (tmp + rename), debounced, mirrors the other JSON stores.
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(snapshot()), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("blocklist save failed:", e);
    }
  }, 1500);
}

// Synchronous write for a clean shutdown (survives the debounce window).
function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("blocklist flush failed:", e);
  }
}

load();

module.exports = { saveSoon, flushSync };
