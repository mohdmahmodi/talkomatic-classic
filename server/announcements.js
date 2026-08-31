// server/announcements.js
// Notices from the developers, shown to everybody as a full-screen card the
// next time they open the lobby.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "announcements.json");

const MAX_KEPT = 200;
const MAX_TITLE = 120;
const MAX_BODY = 4000;

// The only reactions a notice accepts. Fixed on purpose: the old free-for-all
// buried the message under a pile of novelty emoji.
const REACTION_EMOJIS = ["👍", "😄", "❤️", "🎉"];

const KINDS = ["update", "notice", "alert"];

let items = [];
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    items = Array.isArray(arr) ? arr : [];
    for (const a of items) migrate(a);
    seq = items.reduce((m, a) => Math.max(m, a.id || 0), 0);
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading announcements.json:", err);
    items = [];
  }
}

function migrate(a) {
  if (!KINDS.includes(a.kind)) a.kind = "notice";
  if (!a.reactions || typeof a.reactions !== "object") a.reactions = {};
  if (a.editedAt === undefined) a.editedAt = null;
  if (a.live === undefined) a.live = true;
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (items.length > MAX_KEPT) items = items.slice(-MAX_KEPT);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(items, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("announcements save failed:", e);
    }
  }, 2000);
}

function flushSync() {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (items.length > MAX_KEPT) items = items.slice(-MAX_KEPT);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("announcements flush failed:", e);
  }
}

function get(id) {
  return items.find((a) => a.id === Number(id)) || null;
}

function post({ kind, title, body, by, byRole }) {
  const t = String(title || "").trim().slice(0, MAX_TITLE);
  const b = String(body || "").trim().slice(0, MAX_BODY);
  if (t.length < 3) return { ok: false, code: "title" };
  if (b.length < 3) return { ok: false, code: "body" };
  const a = {
    id: ++seq,
    kind: KINDS.includes(kind) ? kind : "notice",
    title: t,
    body: b,
    by: by || "Talkomatic",
    byRole: byRole || "dev",
    at: Date.now(),
    editedAt: null,
    live: true,
    reactions: {},
  };
  items.push(a);
  saveSoon();
  return { ok: true, id: a.id };
}

function edit({ id, kind, title, body, by }) {
  const a = get(id);
  if (!a) return { ok: false, code: "not_found" };
  const t = String(title || "").trim().slice(0, MAX_TITLE);
  const b = String(body || "").trim().slice(0, MAX_BODY);
  if (t.length < 3) return { ok: false, code: "title" };
  if (b.length < 3) return { ok: false, code: "body" };
  a.title = t;
  a.body = b;
  const who = String(by || "").trim().slice(0, 40);
  if (who) a.by = who;
  if (KINDS.includes(kind)) a.kind = kind;
  a.editedAt = Date.now();
  saveSoon();
  return { ok: true };
}

function setLive(id, live) {
  const a = get(id);
  if (!a) return false;
  a.live = !!live;
  saveSoon();
  return true;
}

function remove(id) {
  const before = items.length;
  items = items.filter((a) => a.id !== Number(id));
  if (items.length === before) return false;
  saveSoon();
  return true;
}

function current() {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].live) return items[i];
  return null;
}

function react({ id, deviceId, emoji }) {
  const a = get(id);
  if (!a || !deviceId) return null;
  const key = String(emoji || "");
  if (!REACTION_EMOJIS.includes(key)) return null;
  const holders = a.reactions[key];
  if (holders && holders[deviceId]) {
    delete holders[deviceId];
    if (!Object.keys(holders).length) delete a.reactions[key];
  } else {
    if (!a.reactions[key]) a.reactions[key] = {};
    a.reactions[key][deviceId] = Date.now();
  }
  saveSoon();
  return publicOne(a, deviceId);
}

function reactionsFor(a, deviceId) {
  const out = [];
  for (const emoji in a.reactions) {
    const holders = a.reactions[emoji];
    const n = Object.keys(holders).length;
    if (!n) continue;
    out.push({ e: emoji, n, me: !!(deviceId && holders[deviceId]) });
  }
  out.sort((x, y) => y.n - x.n || (x.e < y.e ? -1 : 1));
  return out;
}

function publicOne(a, deviceId) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    body: a.body,
    by: a.by,
    byRole: a.byRole,
    at: a.at,
    editedAt: a.editedAt,
    live: !!a.live,
    reactions: reactionsFor(a, deviceId),
  };
}

function listFor(deviceId, limit = 50) {
  return items
    .slice()
    .reverse()
    .slice(0, limit)
    .map((a) => publicOne(a, deviceId));
}

load();

module.exports = {
  post,
  edit,
  remove,
  setLive,
  react,
  get,
  current,
  publicOne,
  listFor,
  flushSync,
  KINDS,
  REACTION_EMOJIS,
};
