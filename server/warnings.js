// server/warnings.js
// Staff warnings held against the durable device id until the person opens
// one and ticks the box. They ride out a reload and a reconnect, so the only
// way past a warning is to acknowledge it.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "warnings.json");
const MAX_PER_DEVICE = 5;
const TTL = 30 * 24 * 60 * 60 * 1000;

let store = {};
let saveTimer = null;

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (o && typeof o === "object") store = o;
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading warnings.json:", err);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("warnings save failed:", e);
    }
  }, 1500);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("warnings flush failed:", e);
  }
}

function queue(deviceId, message, by) {
  if (!deviceId || !message) return null;
  const arr = store[deviceId] || (store[deviceId] = []);
  const entry = {
    id: crypto.randomBytes(8).toString("hex"),
    message: String(message).slice(0, 1000),
    by: by || null,
    at: Date.now(),
  };
  arr.push(entry);
  if (arr.length > MAX_PER_DEVICE) arr.splice(0, arr.length - MAX_PER_DEVICE);
  saveSoon();
  return entry;
}

function pendingFor(deviceId) {
  const arr = deviceId && store[deviceId];
  if (!arr) return [];
  const now = Date.now();
  const live = arr.filter((w) => w.id && now - (w.at || 0) <= TTL);
  if (live.length !== arr.length) {
    if (live.length) store[deviceId] = live;
    else delete store[deviceId];
    saveSoon();
  }
  return live;
}

function has(deviceId) {
  const arr = deviceId && store[deviceId];
  if (!arr || !arr.length) return false;
  const now = Date.now();
  return arr.some((w) => w.id && now - (w.at || 0) <= TTL);
}

function ack(deviceId, id) {
  const arr = deviceId && id && store[deviceId];
  if (!arr) return null;
  const i = arr.findIndex((w) => w.id === id);
  if (i === -1) return null;
  const [entry] = arr.splice(i, 1);
  if (!arr.length) delete store[deviceId];
  saveSoon();
  return entry;
}

load();

module.exports = { queue, pendingFor, has, ack, flushSync };
