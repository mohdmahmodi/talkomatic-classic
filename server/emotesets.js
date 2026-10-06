// server/emotesets.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./datadir");
const { wordFilter } = require("./state");

const FILE = path.join(DATA_DIR, "emote-sets.json");
const SOURCE = "https://7tv.io/v3/gql";
const REFRESH_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 20000;
const MAX_EMOTES = 8000;
const ZERO_WIDTH = 256;
const ACTIVE_ZERO_WIDTH = 1;
const CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const ID = /^[0-9A-Za-z]{20,32}$/;

const list = (raw) =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const SETS = list(process.env.EMOTE_SETS).filter((s) => ID.test(s));
const BLOCKED = new Set(list(process.env.EMOTE_BLOCK).map((s) => s.toLowerCase()));

let current = { v: "", at: 0, emotes: [] };
let timer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && Array.isArray(raw.emotes)) current = { v: String(raw.v || ""), at: Number(raw.at) || 0, emotes: raw.emotes };
  } catch (_) {}
}

function save() {
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(current), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("emote sets save failed:", e.message);
  }
}

async function fetchSet(id) {
  const query = "{emoteSet(id:" + JSON.stringify(id) + "){emotes{id name flags data{flags animated listed}}}}";
  const res = await fetch(SOURCE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = await res.json();
  const set = body && body.data && body.data.emoteSet;
  if (!set || !Array.isArray(set.emotes)) throw new Error("no set " + id);
  return set.emotes;
}

function allowed(e) {
  if (!e || !CODE.test(e.name || "") || !ID.test(e.id || "")) return false;
  if ((Number(e.flags) || 0) & ACTIVE_ZERO_WIDTH) return false;
  if (e.data && (Number(e.data.flags) || 0) & ZERO_WIDTH) return false;
  if (BLOCKED.has(e.id.toLowerCase()) || BLOCKED.has(e.name.toLowerCase())) return false;
  try {
    if (wordFilter.checkText(e.name).hasOffensiveWord) return false;
  } catch (_) {}
  return true;
}

async function refresh() {
  if (!SETS.length) {
    if (current.emotes.length) {
      current = { v: "", at: Date.now(), emotes: [] };
      save();
    }
    return current;
  }
  const seen = new Set();
  const out = [];
  let failed = 0;
  for (const id of SETS) {
    let emotes;
    try {
      emotes = await fetchSet(id);
    } catch (e) {
      failed++;
      console.error("emote set " + id + " could not be read:", e.message);
      continue;
    }
    for (const e of emotes) {
      if (out.length >= MAX_EMOTES) break;
      if (!allowed(e)) continue;
      const key = e.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([e.name, e.id, e.data && e.data.animated ? 1 : 0]);
    }
  }
  if (failed === SETS.length) return current;
  const v = crypto.createHash("sha1").update(JSON.stringify(out)).digest("hex").slice(0, 12);
  if (v !== current.v) {
    current = { v, at: Date.now(), emotes: out };
    save();
  }
  return current;
}

function init() {
  load();
  if (timer) return;
  const run = () => refresh().catch((e) => console.error("emote sets refresh failed:", e.message));
  const first = setTimeout(run, 5000);
  if (first.unref) first.unref();
  timer = setInterval(run, REFRESH_MS);
  if (timer.unref) timer.unref();
}

function route(req, res) {
  const tag = '"' + (current.v || "none") + '"';
  res.set("Cache-Control", "public, max-age=600");
  res.set("ETag", tag);
  if (req.headers["if-none-match"] === tag) return res.status(304).end();
  res.json({ v: current.v, emotes: current.emotes });
}

module.exports = { init, refresh, route, allowed };
