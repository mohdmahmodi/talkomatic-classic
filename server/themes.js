// server/themes.js
// Community theme library store.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "community-themes.json");
const MAX = 500;
const PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const EFFECTS = ["", "glass", "brutal", "soft"];
const FONTS = [
  "", "Inter", "Poppins", "Nunito", "Montserrat", "Lato", "Roboto Slab",
  "Merriweather", "JetBrains Mono", "Space Mono", "VT323", "Press Start 2P",
  "Orbitron", "Bebas Neue", "Comic Neue",
];
const RANGES = { radius: [0, 24], "border-width": [1, 4], blur: [4, 30] };

let themes = [];
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    themes = Array.isArray(arr) ? arr : [];
    seq = themes.reduce((m, t) => Math.max(m, t.id || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading community-themes.json:", err);
    themes = [];
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (themes.length > MAX) themes = themes.slice(-MAX);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(themes, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("themes save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    if (themes.length > MAX) themes = themes.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(themes, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("themes flush failed:", e);
  }
}

function ipKeyFor(ip) {
  if (!ip) return null;
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
}

function cleanProfile(p) {
  const out = { tokens: {}, effect: "", fonts: {} };
  if (!p || typeof p !== "object") return out;
  if (p.tokens && typeof p.tokens === "object") {
    for (const [k, v] of Object.entries(p.tokens)) {
      if (!/^[a-z][a-z-]{1,24}$/.test(k)) continue;
      if (RANGES[k]) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= RANGES[k][0] && n <= RANGES[k][1])
          out.tokens[k] = n;
      } else if (typeof v === "string" && HEX.test(v)) {
        out.tokens[k] = v.toLowerCase();
      }
    }
  }
  if (EFFECTS.includes(p.effect)) out.effect = p.effect;
  if (p.fonts && typeof p.fonts === "object") {
    for (const slot of ["main", "heading", "chat"]) {
      if (FONTS.includes(p.fonts[slot]) && p.fonts[slot])
        out.fonts[slot] = p.fonts[slot];
    }
  }
  return out;
}

function countRecent(deviceId, ipKey) {
  const cutoff = Date.now() - DAY_MS;
  let n = 0;
  for (const t of themes)
    if (
      t.at > cutoff &&
      ((deviceId && t.deviceId === deviceId) || (ipKey && t.ipKey === ipKey))
    )
      n++;
  return n;
}

function submit({ deviceId, ip, userId, by, title, desc, state }) {
  const ipKey = ipKeyFor(ip);
  if (countRecent(deviceId, ipKey) >= PER_DAY)
    return { ok: false, code: "limit" };
  const clean = {
    lobby: cleanProfile(state && state.lobby),
    room: cleanProfile(state && state.room),
  };
  const hasAnything =
    Object.keys(clean.lobby.tokens).length ||
    Object.keys(clean.room.tokens).length ||
    clean.lobby.effect || clean.room.effect ||
    Object.keys(clean.lobby.fonts).length ||
    Object.keys(clean.room.fonts).length;
  if (!hasAnything) return { ok: false, code: "empty" };
  const t = {
    id: ++seq,
    title,
    desc: desc || "",
    by: by || "Anonymous",
    userId: userId || null,
    deviceId: deviceId || null,
    ipKey,
    state: clean,
    at: Date.now(),
  };
  themes.push(t);
  if (themes.length > MAX) themes = themes.slice(-MAX);
  saveSoon();
  return { ok: true, id: t.id };
}

function remove(id) {
  const before = themes.length;
  themes = themes.filter((t) => t.id !== id);
  if (themes.length === before) return false;
  saveSoon();
  return true;
}

function publicList(limit = 100) {
  return themes
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      title: t.title,
      desc: t.desc,
      by: t.by,
      at: t.at,
      state: t.state,
    }));
}

load();

module.exports = { submit, remove, publicList, flushSync };
