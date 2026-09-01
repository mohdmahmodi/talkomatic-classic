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
const VOTES_PER_IP = 2;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const EFFECTS = ["", "glass", "brutal", "soft", "crt"];
// Mirrors the catalog in public/js/theme-engine.js. A font missing here gets
// silently stripped from published themes, so keep the two lists in step.
const FONTS = [
  "",
  "Inter", "Poppins", "Nunito", "Montserrat", "Lato", "Open Sans", "Raleway",
  "Quicksand", "Josefin Sans",
  "Roboto Slab", "Merriweather", "Playfair Display", "Lora", "EB Garamond",
  "Bebas Neue", "Oswald", "Orbitron", "Audiowide", "Righteous", "Bangers",
  "Luckiest Guy", "Alfa Slab One",
  "JetBrains Mono", "Fira Code", "Space Mono", "IBM Plex Mono", "VT323",
  "Press Start 2P", "Silkscreen",
  "Comic Neue", "Patrick Hand", "Caveat", "Indie Flower", "Pacifico",
  "Lobster", "Dancing Script", "Amatic SC",
  "Comic Sans MS", "Arial", "Verdana", "Trebuchet MS", "Tahoma", "Georgia",
  "Times New Roman", "Courier New", "Impact",
];
const RANGES = { radius: [0, 24], "border-width": [1, 4], blur: [4, 30] };

let themes = [];
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    themes = Array.isArray(arr) ? arr : [];
    for (const t of themes)
      if (!t.voters || typeof t.voters !== "object") t.voters = {};
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
    voters: {},
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

function get(id) {
  return themes.find((t) => t.id === id) || null;
}

function voteCounts(t) {
  let up = 0,
    down = 0;
  for (const v of Object.values(t.voters || {})) v.v === 1 ? up++ : down++;
  return { up, down };
}

// One vote per browser, capped per hashed IP, same as the suggestion board.
// dir 0 withdraws the vote. Counts are always recomputed from the voter map,
// so there is no separate number a client could bump.
function vote({ id, deviceId, ip, dir }) {
  const t = get(id);
  if (!t) return { ok: false, code: "not_found" };
  if (!deviceId) return { ok: false, code: "no_device" };
  const ipKey = ipKeyFor(ip);
  if (!t.voters || typeof t.voters !== "object") t.voters = {};
  const existing = t.voters[deviceId];

  if (dir === 0) {
    delete t.voters[deviceId];
  } else if (dir === 1 || dir === -1) {
    if (!existing) {
      let sameIp = 0;
      for (const v of Object.values(t.voters))
        if (ipKey && v.ip === ipKey) sameIp++;
      if (sameIp >= VOTES_PER_IP) return { ok: false, code: "ip_cap" };
    }
    t.voters[deviceId] = { v: dir, ip: ipKey, at: Date.now() };
  } else {
    return { ok: false, code: "bad_dir" };
  }
  saveSoon();
  const { up, down } = voteCounts(t);
  return { ok: true, up, down, myVote: t.voters[deviceId]?.v || 0 };
}

function publicOne(t, deviceId) {
  const { up, down } = voteCounts(t);
  return {
    id: t.id,
    title: t.title,
    desc: t.desc,
    by: t.by,
    at: t.at,
    state: t.state,
    up,
    down,
    myVote: (deviceId && t.voters?.[deviceId]?.v) || 0,
  };
}

function publicList(limit = 500, deviceId = null) {
  return themes
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((t) => publicOne(t, deviceId));
}

load();

module.exports = { submit, remove, publicList, vote, get, publicOne, flushSync };
