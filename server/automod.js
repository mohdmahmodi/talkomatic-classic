// server/automod.js

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const { state, isGuestName, tuned } = require("./state");
const identity = require("./identity");
const persons = require("./persons");
const lastseen = require("./lastseen");
const nameguard = require("./nameguard");
const ipban = require("./ipban");
const devicetoken = require("./devicetoken");
const banhistory = require("./banhistory");
const roles = require("./roles");
const clientdetails = require("./clientdetails");

const FILE = path.join(DATA_DIR, "automod.json");
const CHANNEL = "automod";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WATCH_MS = 7 * DAY;
const WATCH_MAX = 20;
const WATCH_QUIET_MS = 30 * 60 * 1000;
const RETURN_QUIET_MS = DAY;
const RETURN_OPEN_MS = 14 * DAY;
const RETURN_FLOOR = tuned("GUARD_AM_FLOOR", 25) / 100;
const INDEX_MS = 60 * 1000;
const RESULTS_MAX = 8;
const MATCHES_MAX = 6;
const VARIANT_MIN = tuned("GUARD_AM_NAME_MIN", 5);
const VARIANT_EXTRA = tuned("GUARD_AM_NAME_EXTRA", 6);
const VOTES_TO_ASK = tuned("GUARD_AM_VOTES", 2);
const KEEP_RETURNS = 5000;
const LOOKUP_QUIET_MS = 10 * 60 * 1000;
const KEEP_LOOKUPS = 1000;
const KEEP_ASKED = 500;
const KEEP_WEEKS = 12;
const STAFF_KEEP_MS = 90 * DAY;
const SWEEP_MS = 10 * 60 * 1000;
const SWEEP_GAP_MS = 30 * 1000;
const SCRIPT_GRACE_MS = tuned("GUARD_AM_GRACE_DAYS", 3) * DAY;
const SCRIPT_WAIT_MS = tuned("GUARD_AM_WAIT_SEC", 8) * 1000;
const SCRIPT_HOURLY = tuned("GUARD_AM_HOURLY", 6);
const KEEP_SCRIPTS = 500;
const DEVICE_RARE = atLeastZero(process.env.GUARD_AM_DEVICE_SHARE, 0);
const KEEP_VOTES = 3000;
const DEVICE_MIN = tuned("GUARD_AM_DEVICE_MIN", 150);
const STANDING_LETTERS = tuned("GUARD_AM_OLD_LETTERS", 6);
const STANDING_OTHERS = tuned("GUARD_AM_OLD_SHARE", 2);
const EVENT_HOURLY = tuned("GUARD_AM_EVENT_HOURLY", 10);
const EVENT_QUIET_MS = HOUR;
const KEEP_EVENTS = 3000;
const KEEP_BANS = 200;
const FLOOD_TRIPS = tuned("GUARD_AM_FLOOD_TRIPS", 3);
const RENAME_TRIPS = tuned("GUARD_AM_RENAMES", 4);
const LINK_TRIPS = tuned("GUARD_AM_LINKS", 3);
const VOTES_NOTE = tuned("GUARD_AM_VOTES_NOTE", 3);
const REPORTS_NOTE = tuned("GUARD_AM_REPORTS", 2);
const WINDOW_MS = tuned("GUARD_AM_WINDOW_MIN", 10) * 60 * 1000;
const NEWFACE_MS = tuned("GUARD_AM_NEWFACE_MIN", 10) * 60 * 1000;
const SYSTEMS = { windows: "Windows", android: "Android", ios: "iPhone or iPad", mac: "Mac", chromeos: "Chromebook", linux: "Linux" };
const BROWSERS = { chromium: "Chrome", firefox: "Firefox", webkit: "Safari" };
const WORDS_FILE = path.join(__dirname, "..", "public", "js", "dictionary_words.json");
const NOBODY = new Set(["anonymous", "anon", "guest", "user", "me", "your name", "name", "undefined"].map((n) => nameguard.skeleton(n)));

const MODEL = weights(process.env.GUARD_AM_WEIGHTS, [-2.6, 0.46, 1.06, 1.09, 0.89, 0.53]);

function atLeastZero(raw, def) {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function weights(raw, def) {
  const n = String(raw || "").split(",").map(Number);
  const w = n.length === def.length && n.every(Number.isFinite) ? n : def;
  if (w === def) console.warn("[guard] GUARD_AM_WEIGHTS not set, using built-in value");
  return { base: w[0], exact: w[1], day: w[2], week: w[3], location: w[4], repeat: w[5] };
}

let ctx = null;
let store = { watches: [], returns: [], votes: [], links: [], lookups: [], asked: [], scripts: [], events: [], bans: [], usage: {}, staff: {}, since: 0, deviceOn: false };
let saveTimer = null;
let index = null;
let banCounts = null;
let staffSeen = 0;
let devDevices = new Set();
const lastOpen = new Map();
let blockIndex = null;
let words = null;
let deviceIndex = null;
let scriptPosts = [];
let lastSweep = 0;
let sweptTo = 0;
const lastReturn = new Map();
const calls = new Map();
const trips = new Map();
const eventPosts = new Map();
const lastEvent = new Map();
const knocks = new Map();
let modLabels = null;

function load() {
  let text;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch (_) {
    return;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error("automod store could not be read, keeping a copy:", e.message);
    try {
      fs.renameSync(FILE, FILE + ".bad-" + Date.now());
    } catch (_) {}
    return;
  }
  if (!raw || typeof raw !== "object") return;
  for (const k of ["watches", "returns", "votes", "links", "lookups", "asked", "scripts", "events", "bans"])
    if (Array.isArray(raw[k])) store[k] = raw[k];
  if (raw.usage && typeof raw.usage === "object") store.usage = raw.usage;
  if (raw.staff && typeof raw.staff === "object") store.staff = raw.staff;
  store.since = Number(raw.since) || 0;
  store.deviceOn = raw.deviceOn === true;
  const now = Date.now();
  for (const r of store.returns) {
    if (!r || now - r.at >= RETURN_QUIET_MS) continue;
    lastReturn.set(r.uid + "|" + (r.band === "device" ? "device" : r.key), r.at);
    if (r.id && r.band !== "device") lastReturn.set("name|" + r.key, r.at);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = FILE + ".tmp";
    fsp
      .writeFile(tmp, JSON.stringify(store), "utf8")
      .then(() => fsp.rename(tmp, FILE))
      .catch((e) => console.error("automod save failed:", e.message));
  }, 4000);
  if (saveTimer.unref) saveTimer.unref();
}

function flushSync() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (_) {}
}

function init(deps) {
  ctx = deps;
  if (!store.since) {
    store.since = Date.now();
    saveSoon();
  }
  const timer = setInterval(sweep, SWEEP_MS);
  if (timer.unref) timer.unref();
}

const io = () => (ctx && ctx.io ? ctx.io() : null);
const isStaff = (s) => !!(s && (s.isDev || s.isMod));
const levelOf = (s) => (s.isDev ? 4 : s.modLevel || 1);
const staffKey = (s) => (s.isDev ? "dev" : "mod") + ":" + (s.staffLabel || "?");
const modName = (s) => (s.isDev ? null : s.staffLabel || null);
const nameKey = (n) => nameguard.skeleton(n || "");
const letters = (n) => (String(n || "").match(/[\p{L}\p{N}]/gu) || []).length;
const usable = (n) => {
  const k = nameKey(n);
  return k.length >= 4 && letters(n) >= 4 && !NOBODY.has(k) && !isGuestName(n);
};
const variantOf = (key, base) =>
  base.length >= VARIANT_MIN && key.length > base.length && key.length - base.length <= VARIANT_EXTRA && key.startsWith(base);

function allow(socket) {
  const now = Date.now();
  const times = (calls.get(socket.id) || []).filter((t) => now - t < 10000);
  if (times.length >= 30) return false;
  times.push(now);
  calls.set(socket.id, times);
  if (calls.size > 2000) calls.clear();
  return true;
}

function weekOf(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function count(socket, what) {
  if (socket.isDev) return;
  const week = weekOf(Date.now());
  const w = (store.usage[week] = store.usage[week] || {});
  const who = (w[staffKey(socket)] = w[staffKey(socket)] || { level: levelOf(socket) });
  who.level = levelOf(socket);
  who[what] = (who[what] || 0) + 1;
  const weeks = Object.keys(store.usage).sort();
  while (weeks.length > KEEP_WEEKS) delete store.usage[weeks.shift()];
  saveSoon();
}

function staffRole(person) {
  let role = null;
  for (const uid of person.userIds) {
    const live = ctx.getUserStaffRole(uid);
    const seen = (lastseen.get(uid) || {}).role;
    if (live === "dev" || seen === "dev") return "dev";
    if (live || seen) role = "mod";
  }
  const known = staffDevices();
  for (const d of person.devices) {
    const seen = known[d.id] && known[d.id].role;
    if (seen === "dev" || devDevices.has(d.id)) return "dev";
    if (seen || roles.keyForDevice(d.id)) role = "mod";
  }
  return role;
}

function staffDevices() {
  const now = Date.now();
  if (now - staffSeen < INDEX_MS) return store.staff;
  staffSeen = now;
  devDevices = new Set();
  for (const k of roles.getKeyActivity())
    if (k.role === "dev") for (const d of k.devices) devDevices.add(d.id);
  let changed = false;
  for (const [did, role] of lastseen.staffDevices()) {
    const had = store.staff[did];
    if (had && had.role === role && now - had.at < DAY) continue;
    store.staff[did] = { role, at: now };
    changed = true;
  }
  for (const did of Object.keys(store.staff))
    if (now - store.staff[did].at > STAFF_KEEP_MS) {
      delete store.staff[did];
      changed = true;
    }
  if (changed) saveSoon();
  return store.staff;
}

function canSee(person, socket) {
  if (socket.isMainDev) return true;
  const role = staffRole(person);
  if (!role) return true;
  return !!socket.isDev && role !== "dev";
}

function nameIndex() {
  if (index && Date.now() - index.at < INDEX_MS) return index.rows;
  const rows = [];
  const byKey = new Map();
  for (const [did, rec] of Object.entries(identity.allRecords())) {
    if (!rec || !rec.name) continue;
    const row = { did, name: rec.name, key: nameKey(rec.name), first: rec.first || 0, last: rec.last || 0 };
    rows.push(row);
    if (byKey.has(row.key)) byKey.get(row.key).push(row);
    else byKey.set(row.key, [row]);
  }
  index = { at: Date.now(), rows, byKey };
  return rows;
}

function plainWord(name) {
  if (!words) {
    try {
      words = new Set(JSON.parse(fs.readFileSync(WORDS_FILE, "utf8")));
    } catch (_) {
      words = new Set();
    }
  }
  const parts = String(name || "").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return parts.length === 1 && words.has(parts[0]);
}

function distinct(username, key, hit) {
  if (letters(username) < STANDING_LETTERS || plainWord(username)) return false;
  nameIndex();
  const theirs = new Set(hit.b.did ? persons.peek(hit.b.did).devices.map((d) => d.id) : []);
  const idx = blocks();
  let others = 0;
  for (const row of index.byKey.get(key) || []) {
    if (row.first >= hit.since || theirs.has(row.did)) continue;
    if (idx.dids.has(row.did.toLowerCase()) || idx.idKeys.has(ipban.idKey(row.did))) continue;
    if (++others > STANDING_OTHERS) return false;
  }
  return true;
}

function timesBlocked(key) {
  if (!banCounts || Date.now() - banCounts.at > INDEX_MS) {
    const map = new Map();
    for (const e of banhistory.recent(5000))
      if (e && e.action === "ban" && e.name) {
        const k = nameKey(e.name);
        map.set(k, (map.get(k) || 0) + 1);
      }
    banCounts = { at: Date.now(), map };
  }
  return banCounts.map.get(key) || 0;
}

function blockedNow(person) {
  const idx = blocks();
  for (const d of person.devices) {
    const id = String(d.id).toLowerCase();
    if (idx.dids.has(id) || idx.idKeys.has(ipban.idKey(id))) return true;
  }
  for (const ip of person.ips) if (ipban.keysCovering(ip, idx.prepared).length) return true;
  return false;
}

function lookup(key) {
  const p = persons.peek(key);
  if (p.standalone) return p;
  return { ...p, blocked: blockedNow(p), evader: p.devices.some((d) => !!d.evaderAt) };
}

function presence() {
  return ctx.presenceByUser();
}

function whereabouts(person, socket, live) {
  for (const uid of person.userIds) {
    const seat = live.seatedIn.get(uid);
    if (seat) {
      const open = seat.room.type === "public" || socket.isMainDev;
      return {
        online: true,
        uid,
        roomId: open ? seat.room.id : null,
        room: open ? seat.room.name : "a room that is not public",
      };
    }
    if ((live.sockets.get(uid) || []).length) return { online: true, uid, roomId: null, room: null };
  }
  return { online: false };
}

function newest(person) {
  let best = null;
  for (const d of person.devices) if (!best || (d.last || 0) > (best.last || 0)) best = d;
  return best;
}

function uidFor(person) {
  const d = newest(person);
  return d ? d.userId || devicetoken.userIdFor(d.id) : person.userIds[0] || person.id;
}

function toUid(key) {
  const k = String(key || "").slice(0, 120);
  return identity.validId(k) && identity.getRecord(k) ? devicetoken.userIdFor(k) : k;
}

function summary(person, socket, live, why) {
  const d = newest(person);
  const at = whereabouts(person, socket, live);
  return {
    key: at.online ? at.uid : uidFor(person),
    name: (d && d.name) || person.names[0] || "(no name)",
    names: person.names.slice(0, 6),
    accounts: Math.max(1, person.devices.length),
    blocked: !!person.blocked,
    evader: !!person.evader,
    online: at.online,
    room: at.room || null,
    last: person.last || 0,
    why: why || null,
  };
}

function search(q, socket) {
  const text = String(q || "").trim().slice(0, 60);
  if (text.length < 2) return [];
  const live = presence();
  const uid = /^[A-Za-z0-9_-]{20,64}$/.test(text) ? toUid(text) : null;
  const direct = uid ? lookup(uid) : null;
  if (direct && (!direct.standalone || lastseen.get(uid) || lastseen.get(text)))
    return canSee(direct, socket) ? [summary(direct, socket, live, "matches that id")] : [];

  const key = nameKey(text);
  if (key.length < 2) return [];
  const ranked = [];
  for (const row of nameIndex()) {
    if (!row.key) continue;
    const rank = row.key === key ? 0 : row.key.startsWith(key) ? 1 : key.length >= 3 && row.key.includes(key) ? 2 : -1;
    if (rank >= 0) ranked.push({ row, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.row.last - a.row.last);
  const seen = new Set();
  const out = [];
  for (const { row, rank } of ranked) {
    const person = persons.peek(row.did);
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    if (!canSee(person, socket)) continue;
    out.push(
      summary(lookup(row.did), socket, live, rank === 0 ? "same name" : rank === 1 ? "name starts the same" : "name contains it"),
    );
    if (out.length >= RESULTS_MAX) break;
  }
  return out;
}

function score({ exact, gap, sameLocation, repeat }) {
  let z = MODEL.base;
  if (exact) z += MODEL.exact;
  if (gap != null && gap < DAY) z += MODEL.day;
  else if (gap != null && gap < 7 * DAY) z += MODEL.week;
  if (sameLocation) z += MODEL.location;
  if (repeat) z += MODEL.repeat;
  return 1 / (1 + Math.exp(-z));
}

function band(p) {
  return p >= 0.5 ? "likely" : p >= RETURN_FLOOR ? "possible" : "unlikely";
}

function ago(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + (m === 1 ? " minute" : " minutes");
  const h = Math.round(m / 60);
  if (h < 48) return h + (h === 1 ? " hour" : " hours");
  const d = Math.round(h / 24);
  return d + (d === 1 ? " day" : " days");
}

function short(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + " min";
  const h = Math.round(m / 60);
  if (h < 48) return h + " h";
  return Math.round(h / 24) + " d";
}

function reasons({ exact, base, gap, sameLocation, repeat, standing, permanent }) {
  const same = [exact ? "name" : "name start (" + base + ")"];
  if (sameLocation) same.push("location");
  const notes = [];
  if (standing) notes.push(permanent ? "old block, permanent" : "old block, still on");
  else if (gap != null) notes.push("back " + short(gap) + " after the block");
  if (repeat) notes.push("blocked more than once");
  return { same, notes };
}

// Lines for a user page: what matches, what differs, then the notes.
function whyLines(bits, cmp) {
  const out = factsOf(bits, cmp);
  for (const n of bits ? bits.notes : []) out.push("Note|" + n);
  return out;
}

// Rows as "Label|value" or "Label|chip|chip"; a chip can be "Key=value".
function factsOf(bits, cmp) {
  const out = [];
  const same = (bits ? bits.same : []).concat(cmp ? cmp.same : []);
  if (same.length) out.push("Same|" + same.join("|"));
  if (cmp && cmp.differs.length) out.push("Differs|" + cmp.differs.join("|"));
  if (cmp && cmp.firstAfter) out.push("New browser|" + short(cmp.firstAfter) + " after the block");
  return out;
}

// "name, location, system" for a User or Blocked user row.
function sysTokens(cl) {
  if (!cl) return [];
  const out = [];
  if (SYSTEMS[cl.os]) out.push("Device=" + SYSTEMS[cl.os]);
  if (BROWSERS[cl.br]) out.push("Browser=" + BROWSERS[cl.br]);
  return out;
}

function whoRow(name, loc, did) {
  const rec = did ? identity.getRecord(did) : null;
  const where = loc || (rec && rec.loc) || null;
  return ["Name=" + (name || "(no name)")].concat(where ? ["Location=" + where] : [], sysTokens(rec && rec.cl)).join("|");
}

function blockedRow(label, did) {
  return "Blocked user|" + whoRow(label, null, did);
}

function blockFact(b) {
  if (!b || typeof b !== "object") return [];
  let r = b.reason ? String(b.reason).replace(/[.\s]+$/, "") : null;
  if (r && r.length > 140) r = r.slice(0, 140).replace(/\s+\S*$/, "");
  const ends = ipban.isPermanentBlock(b) ? "never" : b.expiry ? "in " + short(b.expiry - Date.now()) : null;
  return [r ? "Block|" + r : null, ends ? "Ends|" + ends : null].filter(Boolean);
}

function placedFact(b) {
  if (!b || typeof b !== "object") return null;
  let who = null;
  try {
    who = b.by ? roles.systemLabel(b.by, b.byRole || null) : "Automod";
  } catch (_) {
    who = b.by || "Automod";
  }
  const at = b.ts || b.since || null;
  return "Placed|" + [who, at ? short(Date.now() - at) + " ago" : null].filter(Boolean).join("|");
}

// Rows and the ban list anchor for a card about a block.
function blockRows(b) {
  return blockFact(b).concat([placedFact(b)].filter(Boolean));
}

function blockAnchor(b) {
  const at = b && typeof b === "object" ? b.ts || b.since || null : null;
  return at ? { itemId: at } : {};
}

function locationOf(did) {
  const rec = did ? identity.getRecord(did) : null;
  return rec && rec.loc ? nameKey(rec.loc) : "";
}

function blockSince(person) {
  let since = 0;
  for (const d of person.devices) {
    const hit = ipban.findActiveIdBlock(d.id);
    const b = hit && hit.block;
    const at = b && typeof b === "object" ? b.since || b.ts || 0 : 0;
    if (at > since) since = at;
  }
  return since;
}

function matchesFor(person, socket) {
  const mine = new Set(person.devices.map((d) => d.id));
  const bases = person.names.filter(usable).map((n) => ({ name: n, key: nameKey(n) }));
  if (!bases.length) return [];
  const since = blockSince(person);
  const places = new Set(person.devices.map((d) => locationOf(d.id)).filter((l) => l.length >= 3));
  const repeat = bases.some((b) => timesBlocked(b.key) >= 2);
  const live = presence();
  const seen = new Set();
  const out = [];
  const found = [];
  for (const row of nameIndex()) {
    if (mine.has(row.did) || !row.key) continue;
    const base = bases.find((b) => b.key === row.key) || bases.find((b) => variantOf(row.key, b.key));
    if (!base) continue;
    const other = persons.peek(row.did);
    if (other.id === person.id || seen.has(other.id)) continue;
    seen.add(other.id);
    if (!canSee(other, socket)) continue;
    const first = other.first || row.last;
    const facts = {
      exact: base.key === row.key,
      base: base.name,
      gap: since && first > since ? first - since : null,
      sameLocation: places.has(locationOf(row.did)),
      repeat,
    };
    found.push({ row, facts, p: score(facts), last: other.last || row.last });
  }
  found.sort((a, b) => b.p - a.p || b.last - a.last);
  const theirs = person.devices.map((d) => d.id);
  for (const { row, facts, p } of found.slice(0, MATCHES_MAX)) {
    const other = lookup(row.did);
    const s = summary(other, socket, live);
    out.push({
      key: s.key,
      name: s.name,
      accounts: s.accounts,
      blocked: s.blocked,
      online: s.online,
      last: s.last,
      percent: Math.round(p * 100),
      band: band(p),
      why: whyLines(reasons(facts), withDevice(compare(row.did, null, theirs, { label: person.names[0] || null, since: since || null }), deviceFacts(row.did, theirs))),
      votes: votesOn(person.id, other.id),
    });
  }
  return out;
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function livePair(v) {
  if (!v.a || !v.b) return v.pair || "";
  const a = persons.peek(v.a).id;
  const b = persons.peek(v.b).id;
  return a === b ? "" : pairKey(a, b);
}

function votesOn(a, b) {
  const key = pairKey(a, b);
  const latest = new Map();
  for (const v of store.votes) if (livePair(v) === key) latest.set(v.by, v);
  const rows = [...latest.values()];
  return {
    same: rows.filter((v) => v.same).length,
    different: rows.filter((v) => !v.same).length,
  };
}

function cleanWhy(why, socket) {
  const text = String(why || "");
  return socket.isMainDev ? text : text.replace(/\s*\([^)]*[.:/][^)]*\)/g, "").trim();
}

function linksFor(person, socket) {
  const names = new Map(person.devices.map((d) => [d.id, d]));
  const strength = { A: "confirmed", B: "strong", C: "medium" };
  const best = new Map();
  for (const e of person.edges) {
    for (const [self, other] of [
      [e.a, e.b],
      [e.b, e.a],
    ]) {
      const had = best.get(self);
      if (!had || e.tier < had.tier) best.set(self, { tier: e.tier, why: e.why, other });
    }
  }
  const primary = person.id;
  return person.devices.map((d) => {
    const edge = best.get(d.id);
    const link =
      edge && edge.tier === "A"
        ? store.links.find((l) => l.pair === pairKey(d.id, edge.other) && l.together)
        : null;
    return {
      name: d.name || "(no name)",
      first: d.first || 0,
      last: d.last || 0,
      evader: !!d.evaderAt,
      main: d.id === primary,
      strength: edge ? strength[edge.tier] || "medium" : d.id === primary ? "main" : "medium",
      why: edge ? cleanWhy(edge.why, socket) : null,
      with: edge && names.get(edge.other) ? names.get(edge.other).name || null : null,
      linkedBy: link ? link.by : null,
      linkedAt: link ? link.at : null,
    };
  });
}

function watchOf(socket, person) {
  const mine = staffKey(socket);
  return store.watches.find((w) => w.by === mine && w.until > Date.now() && persons.peek(w.pid).id === person.id) || null;
}

function card(key, socket) {
  const uid = toUid(key);
  if (!uid) return null;
  const level = levelOf(socket);
  const real = lookup(uid);
  const shown = canSee(real, socket);
  const ghost = shown ? uid : devicetoken.seal("none:" + uid) + devicetoken.seal("more:" + uid);
  const person = shown ? real : persons.peek(ghost);
  const file = shown ? ctx.buildQuickFile(uid, socket) : JSON.parse(JSON.stringify(ctx.buildQuickFile(ghost, socket)).split(ghost).join(uid));
  const live = presence();
  const at = whereabouts(person, socket, live);
  const watch = watchOf(socket, person);
  const opened = staffKey(socket) + "|" + person.id;
  if (shown && !socket.isDev && Date.now() - (lastOpen.get(opened) || 0) > LOOKUP_QUIET_MS) {
    lastOpen.set(opened, Date.now());
    if (lastOpen.size > 5000) lastOpen.clear();
    count(socket, "opens");
    store.lookups.push({ by: socket.staffLabel || "?", name: file.name || null, at: Date.now() });
    if (store.lookups.length > KEEP_LOOKUPS) store.lookups.splice(0, store.lookups.length - KEEP_LOOKUPS);
  }
  const open =
    shown
      ? store.returns.find(
          (r) => r.id && r.uid === uid && !r.result && Date.now() - r.at < RETURN_OPEN_MS && (r.band !== "device" || store.deviceOn),
        )
      : null;
  return {
    key: uid,
    level,
    file,
    online: at.online,
    room: at.room || null,
    roomId: at.roomId || null,
    accounts: level >= 2 && !person.standalone ? linksFor(person, socket) : null,
    matches: level >= 2 && !person.standalone ? matchesFor(person, socket) : null,
    watch: watch ? { until: watch.until } : null,
    script: shown && store.scripts.some((s) => s.uid === uid || (s.did && person.devices.some((d) => d.id === s.did))),
    flagged: open
      ? { id: open.id, percent: open.percent, band: open.band, label: open.label, why: open.why, at: open.at }
      : null,
    can: {
      warn: true,
      room: !!live.seatedIn.get(at.uid || uid),
      block: level >= 2,
      vote: level >= 2,
      confirm: level >= 3,
    },
  };
}

function watches(socket) {
  const mine = staffKey(socket);
  const now = Date.now();
  const live = presence();
  return store.watches
    .filter((w) => w.by === mine && w.until > now)
    .map((w) => {
      const person = persons.peek(w.uid);
      const hit = (w.hits || [])[(w.hits || []).length - 1] || null;
      return {
        key: w.show || w.uid,
        name: w.name,
        until: w.until,
        online: whereabouts(person, socket, live).online,
        hit,
      };
    });
}

function setWatch(key, on, socket) {
  const asked = toUid(key);
  const shown = canSee(persons.peek(asked), socket);
  const uid = shown ? asked : devicetoken.seal("none:" + asked) + devicetoken.seal("more:" + asked);
  const person = persons.peek(uid);
  const mine = staffKey(socket);
  const now = Date.now();
  store.watches = store.watches.filter((w) => w.until > now && !(w.by === mine && persons.peek(w.pid).id === person.id));
  if (on) {
    if (store.watches.filter((w) => w.by === mine).length >= WATCH_MAX)
      return { error: "You are watching " + WATCH_MAX + " users already. Unwatch one first." };
    const d = newest(person);
    const rec = shown && identity.validId(String(key)) ? identity.getRecord(String(key)) : null;
    const name = (d && d.name) || person.names[0] || (rec && rec.name) || (lastseen.get(uid) || {}).name || "(no name)";
    store.watches.push({
      uid,
      show: asked,
      pid: person.id,
      name,
      keys: [...new Set([name, ...person.names].filter(usable).map(nameKey))].slice(0, 8),
      by: mine,
      at: now,
      until: now + WATCH_MS,
      hits: [],
    });
    count(socket, "watches");
  }
  saveSoon();
  return { ok: true };
}

function post(text, card, minLevel) {
  if (!ctx || !ctx.staffchat) return null;
  return ctx.staffchat.post(CHANNEL, "automod", text, { card, minLevel: minLevel || null });
}

function tell(by, payload) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && isStaff(s) && staffKey(s) === by) s.emit("automod ping", payload);
}

function whoIs(socket) {
  const uid = socket.handshake && socket.handshake.session && socket.handshake.session.userId;
  return { uid: uid || null, did: socket.deviceId || null };
}

function watchersOf(uid, did, username) {
  const now = Date.now();
  const live = store.watches.filter((w) => w.until > now);
  if (!live.length) return [];
  const person = persons.peek(did || uid);
  const key = usable(username) ? nameKey(username) : "";
  const out = [];
  for (const w of live) {
    const sure = w.uid === uid || (!person.standalone && persons.peek(w.pid).id === person.id);
    if (sure || (key && w.keys.some((k) => k === key || variantOf(key, k)))) out.push({ w, sure });
  }
  return out;
}

function noteWatch(socket, username, blocked) {
  if (!ctx || !socket || socket.isDev || socket.isMod || socket.isBot) return;
  const { uid, did } = whoIs(socket);
  if (!uid || !username) return;
  try {
    const now = Date.now();
    let changed = false;
    for (const { w, sure } of watchersOf(uid, did, username)) {
      changed = true;
      const hits = (w.hits = w.hits || []);
      const last = hits[hits.length - 1];
      if (last && last.uid === uid && now - last.at < WATCH_QUIET_MS) {
        if (!blocked || last.blocked) continue;
        last.blocked = true;
      } else {
        hits.push({ at: now, uid, name: username, sure, blocked: !!blocked });
        if (hits.length > 5) hits.shift();
      }
      tell(w.by, { kind: "watch", name: username, key: uid, sure, blocked: !!blocked });
    }
    if (blocked) sweep();
    if (changed) saveSoon();
  } catch (e) {
    console.error("automod watch check failed:", e.message);
  }
}

function noteSignin(socket, username) {
  if (!ctx || !socket || socket.isDev || socket.isMod || socket.isBot) return;
  const { uid, did } = whoIs(socket);
  if (!uid || !username) return;
  const run = () => {
    try {
      clientdetails.settle(socket);
      if (socket.detailsAt || socket.connected) scriptHit(socket, uid, did, username);
      if (!returnHit(socket, uid, did, username)) deviceHit(socket, uid, did, username);
      if (socket._amEvasion) {
        const held = socket._amEvasion;
        socket._amEvasion = null;
        postEvasion(socket, whoFrom(socket), held);
      }
    } catch (e) {
      console.error("automod sign-in check failed:", e.message);
    }
  };
  if (socket.detailsAt) return run();
  const timer = setTimeout(run, SCRIPT_WAIT_MS);
  if (timer.unref) timer.unref();
}

function scriptHit(socket, uid, did, username) {
  if (socket.detailsAt) return;
  const now = Date.now();
  const missing = clientdetails.odd(socket);
  if (!missing.length && now - store.since < SCRIPT_GRACE_MS) return;
  if (store.scripts.some((s) => s.uid === uid && now - s.at < DAY)) return;
  identity.noteScript(did);
  scriptPosts = scriptPosts.filter((t) => now - t < HOUR);
  let msg = null;
  if (scriptPosts.length < SCRIPT_HOURLY) {
    scriptPosts.push(now);
    msg = post(
      username + " signed in without browser details",
      {
        category: "script",
        target: username,
        targetUserId: uid,
        facts: missing.length ? ["Missing|" + missing.join("|"), "Possible|script"] : ["Possible|script|old tab"],
      },
      1,
    );
  }
  store.scripts.push({ id: msg ? msg.id : null, uid, did, name: username, at: now, odd: missing.length > 0 });
  if (store.scripts.length > KEEP_SCRIPTS) store.scripts.splice(0, store.scripts.length - KEEP_SCRIPTS);
  saveSoon();
}

function devices() {
  const now = Date.now();
  if (deviceIndex && now - deviceIndex.at < INDEX_MS) return deviceIndex;
  const idx = blocks();
  const cores = new Map();
  const blocked = new Map();
  const os = {};
  let total = 0;
  let strong = 0;
  for (const [did, rec] of Object.entries(identity.allRecords())) {
    const cl = rec && rec.cl;
    if (!cl) continue;
    total++;
    os[cl.os] = (os[cl.os] || 0) + 1;
    if (cl.grade !== 2 || !cl.core) continue;
    strong++;
    const pid = persons.peek(did).id;
    if (cores.has(cl.core)) cores.get(cl.core).add(pid);
    else cores.set(cl.core, new Set([pid]));
    const low = did.toLowerCase();
    if (idx.dids.has(low) || idx.idKeys.has(ipban.idKey(low))) blocked.set(cl.core, did);
  }
  deviceIndex = { at: now, cores, blocked, os, total, strong };
  return deviceIndex;
}

function deviceFacts(did, others) {
  if (!store.deviceOn || !did) return {};
  const mine = clientdetails.of(did);
  if (!mine) return {};
  const idx = devices();
  const out = {};
  for (const other of others) {
    const theirs = other === did ? null : clientdetails.of(other);
    if (!theirs) continue;
    if (mine.tz && theirs.tz && out.zone !== "same") out.zone = mine.tz === theirs.tz ? "same" : "different";
    if (mine.grade !== 2 || theirs.grade !== 2 || mine.core !== theirs.core) continue;
    const group = idx.cores.get(mine.core) || new Set();
    const pair = new Set([persons.peek(did).id, persons.peek(other).id]);
    let extra = 0;
    for (const pid of group) if (!pair.has(pid)) extra++;
    if (idx.strong >= DEVICE_MIN && extra <= DEVICE_RARE) out.device = true;
    else out.common = true;
  }
  return out;
}

function withDevice(cmp, df) {
  if (df && df.device) cmp.same.push("device details");
  return cmp;
}

function uniq(lines) {
  const out = [];
  for (const l of lines) if (l && !out.includes(l)) out.push(l);
  return out;
}

const q = (s) => '"' + s + '"';

function systemOf(cl) {
  if (!cl) return null;
  const os = SYSTEMS[cl.os] || "other system";
  const br = BROWSERS[cl.br];
  return br ? os + ", " + br : os;
}

function netOf(did) {
  const rec = did ? identity.getRecord(did) : null;
  return (rec && rec.net) || null;
}

function rangeOf(ip) {
  try {
    return ip ? ipban.computeRangeCidr(ip) || ip : null;
  } catch (_) {
    return null;
  }
}

// What two people have in common and where they differ, said without an
// address. "mine" is the device being looked at, "others" the devices of the
// person it is compared with. opts.label names the block, opts.since is when
// it was placed, opts.history false skips the "blocked network before" line.
function compare(did, ip, others, opts) {
  const o = opts || {};
  const out = { same: [], differs: [], firstAfter: null };
  const mine = did ? identity.getRecord(did) : null;
  const theirs = (others || []).filter((d) => d && d !== did).map((d) => identity.getRecord(d)).filter(Boolean);
  if (!theirs.length) return out;
  const myNets = new Set(Object.keys((mine && mine.nets) || {}));
  const r = rangeOf(ip);
  if (r) myNets.add(r);
  const theirNets = new Set();
  for (const t of theirs) for (const n of Object.keys(t.nets || {})) theirNets.add(n);
  let net = false;
  for (const n of myNets) if (theirNets.has(n)) net = true;
  if (net) out.same.push("network");
  const myNet = netOf(did);
  const isps = new Set(theirs.map((t) => t.net && t.net.n).filter(Boolean));
  if (myNet && myNet.n && isps.size) {
    (isps.has(myNet.n) ? out.same : out.differs).push("provider");
  }
  if (mine && mine.ips && o.label && o.history !== false) {
    const idx = blocks();
    const set = new Set((others || []).map((d) => String(d).toLowerCase()));
    let seen = false;
    for (const addr of Object.keys(mine.ips)) {
      if (addr === ip) continue;
      for (const key of ipban.keysCovering(addr, idx.prepared)) {
        const b = state.blockedIPs.get(key);
        if (!b || typeof b !== "object" || !ipban.isActiveBlock(b)) continue;
        if ((b.did && set.has(String(b.did).toLowerCase())) || b.label === o.label) seen = true;
      }
    }
    if (seen) out.same.push("blocked network before");
  }
  const mcl = mine && mine.cl;
  const tcl = theirs.map((t) => t.cl).filter(Boolean);
  if (mcl && tcl.length) {
    const same = tcl.find((c) => c.os === mcl.os && c.br === mcl.br);
    (same ? out.same : out.differs).push("system");
    const zones = tcl.map((c) => c.tz).filter(Boolean);
    if (mcl.tz && zones.length) (zones.includes(mcl.tz) ? out.same : out.differs).push("time zone");
    const screens = tcl.map((c) => c.scr).filter(Boolean);
    if (mcl.scr && screens.length) (screens.includes(mcl.scr) ? out.same : out.differs).push("screen size");
  }
  if (mine && o.since && mine.first > o.since) out.firstAfter = mine.first - o.since;
  return out;
}

function deviceHit(socket, uid, did, username) {
  if (!store.deviceOn || !did) return;
  const mine = clientdetails.of(did);
  if (!mine || mine.grade !== 2) return;
  const other = devices().blocked.get(mine.core);
  if (!other || other === did) return;
  const me = persons.peek(did);
  if (me.devices.some((d) => d.id === other)) return;
  const facts = deviceFacts(did, [other]);
  if (!facts.device || facts.zone === "different") return;
  const theirs = identity.getRecord(other);
  const label = (theirs && theirs.name) || "a blocked user";
  const now = Date.now();
  const quiet = uid + "|device";
  if (now - (lastReturn.get(quiet) || 0) < RETURN_QUIET_MS) return;
  if (store.returns.some((r) => r.uid === uid && r.band === "device" && now - r.at < RETURN_QUIET_MS)) return;
  lastReturn.set(quiet, now);
  const cmp = compare(did, socket.clientIp || null, [other], { label });
  cmp.same.unshift("device details");
  const why = whyLines(null, cmp);
  const session = (socket.handshake && socket.handshake.session) || {};
  const msg = post(
    username + " has the same device details as " + label,
    {
      category: "return",
      target: username,
      targetUserId: uid,
      chips: ["Device match"],
      facts: ["User|" + whoRow(username, session.location, did), blockedRow(label, other)].concat(factsOf(null, cmp)),
    },
    1,
  );
  store.returns.push({ id: msg ? msg.id : null, uid, did, key: nameKey(username), name: username, label, percent: 0, band: "device", why, at: now, result: null, linkedBy: null });
  if (store.returns.length > KEEP_RETURNS) store.returns.splice(0, store.returns.length - KEEP_RETURNS);
  saveSoon();
}

function blockedNames(b) {
  const out = new Map();
  const add = (n) => {
    if (usable(n)) out.set(nameKey(n), n);
  };
  add(b.label);
  if (b.did) {
    const rec = identity.getRecord(b.did);
    if (rec) add(rec.name);
    for (const n of persons.peek(b.did).names) add(n);
  }
  return out;
}

function blocks() {
  const now = Date.now();
  if (blockIndex && blockIndex.size === state.blockedIPs.size && now - blockIndex.at < INDEX_MS) return blockIndex;
  const map = new Map();
  const dids = new Set();
  const idKeys = new Set();
  const keys = [];
  for (const [key, b] of state.blockedIPs) {
    if (!ipban.isActiveBlock(b)) continue;
    if (ipban.isIdKey(key)) idKeys.add(key);
    else keys.push(key);
    if (b && typeof b === "object" && b.did) dids.add(String(b.did).toLowerCase());
    if (!b || typeof b !== "object" || !b.label) continue;
    const since = b.since || b.ts || 0;
    for (const [baseKey, baseName] of blockedNames(b)) {
      const row = { b, since, baseKey, baseName };
      if (map.has(baseKey)) map.get(baseKey).push(row);
      else map.set(baseKey, [row]);
    }
  }
  blockIndex = { at: now, size: state.blockedIPs.size, map, dids, idKeys, prepared: ipban.prepareKeys(keys) };
  return blockIndex;
}

function returnHit(socket, uid, did, username) {
  if (!usable(username)) return;
  const key = nameKey(username);
  const now = Date.now();
  const mine = did ? persons.peek(did) : null;
  const own = new Set(mine ? mine.devices.map((d) => d.id) : []);
  if (did) own.add(did);
  const byName = blocks().map;
  let best = null;
  for (let len = key.length; len >= Math.max(4, key.length - VARIANT_EXTRA) && !best; len--) {
    const exact = len === key.length;
    const baseKey = exact ? key : key.slice(0, len);
    if (!exact && !variantOf(key, baseKey)) continue;
    for (const row of byName.get(baseKey) || []) {
      if (!ipban.isActiveBlock(row.b) || (row.b.did && own.has(row.b.did))) continue;
      if (!best || row.since > best.since) best = { ...row, exact };
    }
  }
  if (!best) return;
  const quiet = uid + "|" + key;
  if (now - (lastReturn.get(quiet) || 0) < RETURN_QUIET_MS) return;
  if (store.returns.some((r) => r.uid === uid && r.key === key && now - r.at < RETURN_QUIET_MS)) return;
  const session = (socket.handshake && socket.handshake.session) || {};
  const facts = {
    exact: best.exact,
    base: best.baseName,
    gap: best.since ? now - best.since : null,
    sameLocation:
      !!best.b.did && nameKey(session.location || "").length >= 3 && nameKey(session.location) === locationOf(best.b.did),
    repeat: timesBlocked(best.baseKey) >= 2,
  };
  const p = score(facts);
  const low = p < RETURN_FLOOR;
  const standing = low && best.exact && distinct(username, key, best);
  facts.standing = standing;
  facts.permanent = ipban.isPermanentBlock(best.b);
  const told = "name|" + key;
  const since = now - (lastReturn.get(told) || 0);
  const waiting = store.returns.some((r) => r.id && r.key === key && !r.result && now - r.at < HOUR);
  const silent = low ? !standing || since < RETURN_QUIET_MS : waiting;
  if (lastReturn.size > 5000) lastReturn.clear();
  lastReturn.set(quiet, now);
  if (!silent) lastReturn.set(told, now);
  const theirs = best.b.did ? [best.b.did, ...persons.peek(best.b.did).devices.map((d) => d.id)] : [];
  const bits = reasons(facts);
  const cmp = withDevice(compare(did, socket.clientIp || null, theirs, { label: best.b.label, since: best.since }), deviceFacts(did, theirs));
  const why = whyLines(bits, cmp);
  const percent = Math.round(p * 100);
  const linked = mine
    ? mine.edges
        .filter((e) => e.tier === "A")
        .map((e) => store.links.find((l) => l.pair === pairKey(e.a, e.b) && l.together))
        .find(Boolean)
    : null;
  const rows = ["User|" + whoRow(username, session.location, did), blockedRow(best.b.label, best.b.did || null)].concat(blockRows(best.b));
  if (!standing && facts.gap != null) rows.push("Signed in|" + short(facts.gap) + " after the block" + (cmp.firstAfter ? "|new browser" : ""));
  else if (cmp.firstAfter) rows.push("Signed in|new browser|" + short(cmp.firstAfter) + " after the block");
  cmp.firstAfter = null;
  rows.push(...factsOf(bits, cmp));
  const chips = standing ? ["Old block"] : [percent + "%"];
  if (facts.repeat) chips.push("Repeat");
  const card = () =>
    post(
      standing ? "Blocked name " + username + " signed in" : best.exact ? username + " may be back" : username + " may be " + best.b.label,
      { category: "return", target: username, targetUserId: uid, chips, facts: rows, ...blockAnchor(best.b) },
      1,
    );
  const msg = silent ? null : card();
  store.returns.push({
    id: msg ? msg.id : null,
    uid,
    did,
    key,
    name: username,
    label: best.b.label,
    percent,
    band: standing ? "standing" : band(p),
    why,
    at: now,
    result: null,
    linkedBy: linked ? linked.by : null,
  });
  if (store.returns.length > KEEP_RETURNS) store.returns.splice(0, store.returns.length - KEEP_RETURNS);
  saveSoon();
  return !!msg;
}

function settle(entry, result, by) {
  entry.result = result;
  entry.by = by || null;
  entry.settledAt = Date.now();
  saveSoon();
  if (entry.id && ctx.staffchat.amend)
    ctx.staffchat.amend(entry.id, (m) => {
      m.card = { ...(m.card || {}), category: result === "blocked" ? "return confirmed" : "return cleared" };
      if (by) m.card.by = by;
    });
}

function openReturns() {
  const now = Date.now();
  return store.returns.filter((r) => !r.result && now - r.at < RETURN_OPEN_MS);
}

function blockedSince(entry, recent) {
  let person = null;
  let ids = null;
  let named = null;
  for (const { key, b, at, label, id } of recent) {
    if (at <= entry.at) continue;
    if (!person) {
      person = persons.peek(entry.did || entry.uid);
      ids = new Set(person.standalone ? [entry.did, entry.uid].filter(Boolean) : person.devices.map((d) => d.id));
    }
    if (b.did && ids.has(b.did)) return true;
    if (id) {
      for (const one of ids) if (ipban.idKey(one) === key) return true;
      continue;
    }
    if (!label) continue;
    if (named === null) named = nameKey(entry.label);
    if (!(label === entry.key || variantOf(entry.key, label) || label === named)) continue;
    for (const ip of person.ips) if (ipban.matchesKey(ip, key)) return true;
  }
  return false;
}

function sweep() {
  const now = Date.now();
  if (!ctx || now - lastSweep < SWEEP_GAP_MS) return;
  lastSweep = now;
  try {
    const open = openReturns();
    const from = sweptTo;
    sweptTo = now;
    if (!open.length) return;
    let oldest = Infinity;
    for (const r of open) if (r.at < oldest) oldest = r.at;
    const floor = Math.max(oldest, from);
    const recent = [];
    for (const [key, b] of state.blockedIPs) {
      if (!b || typeof b !== "object" || !ipban.isActiveBlock(b)) continue;
      const at = b.ts || b.since || 0;
      if (at <= floor) continue;
      const id = ipban.isIdKey(key);
      recent.push({ key, b, at, id, label: !id && usable(b.label) ? nameKey(b.label) : "" });
    }
    if (!recent.length) return;
    for (const entry of open)
      if (blockedSince(entry, recent)) {
        entry.auto = true;
        settle(entry, "blocked", null);
      }
  } catch (e) {
    console.error("automod sweep failed:", e.message);
  }
}

function noteAction(label, action, target, role) {
  if (!/^(ip block|ban ip|id block)/.test(String(action || ""))) return;
  const uid = (/\(([^)]+)\)$/.exec(String(target || "")) || [])[1];
  if (!uid) return;
  const now = Date.now();
  const person = persons.peek(uid);
  const uids = new Set([uid, ...person.userIds]);
  const dids = new Set(person.devices.map((d) => d.id));
  const open = openReturns().filter((r) => uids.has(r.uid) || (r.did && dids.has(r.did)));
  if (!open.length) return;
  const by = role === "mod" ? label : null;
  for (const r of open) settle(r, "blocked", by);
  const entry = open.filter((r) => r.id).pop();
  if (!entry) return;
  post(
    entry.name + " blocked" + (by ? " by " + by : ""),
    {
      category: "caught",
      target: entry.name,
      targetUserId: entry.uid,
      by,
      facts: ["Flagged|" + short(now - entry.at) + " earlier" + (entry.band === "standing" ? "" : " at " + entry.percent + "%")].concat(
        entry.linkedBy ? ["Link by|" + entry.linkedBy] : [],
      ),
    },
    1,
  );
}

function clearReturn(id, socket) {
  const entry = store.returns.find((r) => r.id === id && !r.result);
  if (!entry) return false;
  settle(entry, "cleared", modName(socket));
  count(socket, "cleared");
  return true;
}

function vote({ a, b, same, reason }, socket) {
  const ua = toUid(a);
  const ub = toUid(b);
  if (!ua || !ub || ua === ub) return { error: "Pick two different accounts." };
  const pa = persons.peek(ua);
  const pb = persons.peek(ub);
  if (pa.id === pb.id) return { error: "Those are already the same user." };
  if (!canSee(pa, socket) || !canSee(pb, socket))
    return levelOf(socket) >= 3 ? { error: "Those two cannot be linked." } : { ok: true, confirmed: false };
  const pair = pairKey(pa.id, pb.id);
  const mine = staffKey(socket);
  const asked = store.asked.some((x) => (typeof x === "string" ? x : livePair(x)) === pair);
  let confirmed = false;
  if (levelOf(socket) >= 3) {
    const da = newest(pa);
    const db = newest(pb);
    const why = String(reason || "").trim().slice(0, 300);
    if (why.length < 5) return { error: "Say why in a few words." };
    if (!da || !db || !persons.pin(da.id, db.id, !!same)) return { error: "Those two cannot be linked." };
    confirmed = true;
    store.links = store.links.filter((l) => l.pair !== pairKey(da.id, db.id));
    store.links.push({ pair: pairKey(da.id, db.id), together: !!same, by: modName(socket), at: Date.now() });
    if (store.links.length > KEEP_VOTES) store.links.splice(0, store.links.length - KEEP_VOTES);
    ctx.logStaff(
      socket,
      same ? "merge person" : "split person",
      null,
      "-",
      da.id.slice(0, 8) + " and " + db.id.slice(0, 8) + ": " + why,
    );
  }
  store.votes = store.votes.filter((v) => !(v.by === mine && livePair(v) === pair));
  store.votes.push({ a: pa.id, b: pb.id, by: mine, level: levelOf(socket), same: !!same, at: Date.now() });
  if (store.votes.length > KEEP_VOTES) store.votes.splice(0, store.votes.length - KEEP_VOTES);
  count(socket, "votes");
  if (!confirmed && same && !asked && votesOn(pa.id, pb.id).same >= VOTES_TO_ASK) {
    store.asked.push({ a: pa.id, b: pb.id });
    if (store.asked.length > KEEP_ASKED) store.asked.splice(0, store.asked.length - KEEP_ASKED);
    const na = (newest(pa) || {}).name || pa.names[0] || "one account";
    const nb = (newest(pb) || {}).name || pb.names[0] || "another";
    post(
      na + " and " + nb + " may be one user",
      { category: "confirm", target: na, targetUserId: ua, facts: ["Votes|" + VOTES_TO_ASK + " mods", "Next|a leader confirms on the user page"] },
      3,
    );
  }
  saveSoon();
  return { ok: true, confirmed };
}

function deviceStats() {
  const idx = devices();
  let shared = 0;
  const sizes = [];
  for (const group of idx.cores.values()) {
    if (group.size > 1) shared += group.size;
    sizes.push(group.size);
  }
  sizes.sort((a, b) => b - a);
  return {
    on: store.deviceOn,
    since: store.since,
    total: idx.total,
    strong: idx.strong,
    distinct: idx.cores.size,
    shared,
    biggest: sizes.slice(0, 5),
    os: idx.os,
    scripts: store.scripts.length,
    needed: DEVICE_MIN,
  };
}

function stats() {
  sweep();
  const done = store.returns.filter((r) => r.result && r.id);
  const bands = {};
  for (const r of store.returns) {
    const b = (bands[r.band] = bands[r.band] || { flagged: 0, blocked: 0, cleared: 0, open: 0 });
    b.flagged++;
    if (r.result === "blocked") b.blocked++;
    else if (r.result === "cleared") b.cleared++;
    else b.open++;
  }
  const weeks = Object.keys(store.usage)
    .sort()
    .slice(-4)
    .map((week) => ({
      week,
      staff: Object.entries(store.usage[week])
        .filter(([who]) => who.startsWith("mod:"))
        .map(([who, n]) => ({
          who: who.slice(4),
          level: n.level || 1,
          opens: n.opens || 0,
          searches: n.searches || 0,
          watches: n.watches || 0,
          votes: n.votes || 0,
        }))
        .sort((x, y) => y.opens - x.opens),
    }));
  return {
    flagged: store.returns.filter((r) => r.id).length,
    blocked: done.filter((r) => r.result === "blocked").length,
    cleared: done.filter((r) => r.result === "cleared").length,
    bands,
    links: store.links.length,
    votes: store.votes.length,
    watching: store.watches.filter((w) => w.until > Date.now()).length,
    weeks,
    recent: store.lookups.slice(-40).reverse(),
  };
}

// ── Feed cards for things other than a name coming back ─────────────────────

const plain = (socket) => !!(ctx && socket && !socket.isDev && !socket.isMod && !socket.isBot);

function whoFrom(socket) {
  const { uid, did } = whoIs(socket);
  const s = (socket.handshake && socket.handshake.session) || {};
  return { uid: uid || socket.stableUserId || (did ? devicetoken.userIdFor(did) : null), did, name: s.username || null, location: s.location || null };
}

function roomLabel(socket) {
  const room = socket && socket.roomId ? state.rooms.get(socket.roomId) : null;
  return room ? room.name : null;
}

function tally(kind, key, windowMs) {
  const now = Date.now();
  const k = kind + "|" + key;
  const list = (trips.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  if (list.length > 1000) list.splice(0, list.length - 1000);
  if (trips.size > 20000) trips.clear();
  trips.set(k, list);
  return list.length;
}

// One card per kind per person per hour, and a ceiling per kind per hour so
// a raid cannot bury the feed. Everything is kept in the store, posted or
// not, so the numbers can be checked later.
function event(kind, who, text, card, opts) {
  if (!ctx) return null;
  const o = opts || {};
  const now = Date.now();
  const pid = o.pid || (who.did || who.uid ? persons.peek(who.did || who.uid).id : "?");
  const k = kind + "|" + pid;
  if (!o.force && now - (lastEvent.get(k) || 0) < (o.quietMs || EVENT_QUIET_MS)) return null;
  const posts = (eventPosts.get(kind) || []).filter((t) => now - t < HOUR);
  eventPosts.set(kind, posts);
  let msg = null;
  if (posts.length < EVENT_HOURLY) {
    posts.push(now);
    const c = { category: kind, target: who.name || "(no name)", targetUserId: who.uid || null, ...(card || {}) };
    if (!o.noUser) c.facts = ["User|" + whoRow(who.name, who.location, who.did)].concat(c.facts || []);
    msg = post(text, c, o.minLevel || 1);
  }
  if (lastEvent.size > 20000) lastEvent.clear();
  lastEvent.set(k, now);
  store.events.push({ id: msg ? msg.id : null, kind, uid: who.uid || null, did: who.did || null, name: who.name || null, at: now });
  if (store.events.length > KEEP_EVENTS) store.events.splice(0, store.events.length - KEEP_EVENTS);
  saveSoon();
  return msg;
}

const noName = (who) => who.name || "(no name)";

// A blocked connection was refused. Once a day per person; the count on the
// card grows as they keep trying.
function noteKnock({ socket, deviceId, ip, hit }) {
  if (!ctx || !hit || !hit.block) return;
  try {
    const b = hit.block;
    const label = b && typeof b === "object" && b.label ? b.label : null;
    const did = deviceId ? String(deviceId) : null;
    const low = did ? did.toLowerCase() : null;
    const own =
      !!low &&
      ((b && typeof b === "object" && b.did && String(b.did).toLowerCase() === low) ||
        ipban.isIdKey(hit.key || "") ||
        !!ipban.findActiveIdBlock(low));
    const pid = did ? persons.peek(did).id : devicetoken.seal("knock:" + String(hit.key || rangeOf(ip) || ""));
    const day = new Date().toISOString().slice(0, 10);
    if (knocks.size > 5000) knocks.clear();
    let k = knocks.get(pid);
    if (!k || k.day !== day) {
      k = { day, count: 0, id: null, at: 0 };
      knocks.set(pid, k);
    }
    k.count++;
    const them = label || "a blocked user";
    const text = own ? them + " tried to sign in again" : "Sign-in from a network blocked for " + them;
    const chips = (n) => ["Blocked"].concat(n > 1 ? [n + " today"] : []);
    const now = Date.now();
    if (!k.id) {
      const session = (socket && socket.handshake && socket.handshake.session) || {};
      const who = { uid: session.userId || (did ? devicetoken.userIdFor(did) : null), did, name: label, location: session.location || null };
      const facts = blockRows(b).concat(own ? [] : ["Browser|different"]);
      const msg = event("knock", who, text, { chips: chips(1), facts, ...blockAnchor(b) }, { pid, quietMs: DAY });
      if (msg) {
        k.id = msg.id;
        k.at = now;
      }
    } else if (now - k.at > 60 * 1000) {
      k.at = now;
      const n = k.count;
      if (ctx.staffchat.amend)
        ctx.staffchat.amend(k.id, (m) => {
          m.card = { ...(m.card || {}), chips: chips(n) };
        });
    }
  } catch (e) {
    console.error("automod knock failed:", e.message);
  }
}

function labelsOf(hit) {
  const out = [];
  for (const k of hit.blockKeys || []) {
    const b = state.blockedIPs.get(k);
    if (b && typeof b === "object" && b.label && !out.includes(b.label)) out.push(b.label);
  }
  if (!out.length && hit.ownerName) out.push(hit.ownerName);
  for (const n of hit.names || []) if (!out.includes(n)) out.push(n);
  return out;
}

function devicesOf(hit) {
  const out = new Set();
  for (const k of hit.blockKeys || []) {
    const b = state.blockedIPs.get(k);
    if (b && typeof b === "object" && b.did) out.add(String(b.did));
  }
  if (hit.ownerDid) out.add(String(hit.ownerDid));
  return [...out];
}

// The sign-in checks found something. With a name it posts now; a hint about
// a nameless connection waits for the sign-in so the card can say who.
function noteEvasion(socket, hit) {
  if (!plain(socket) || !hit) return;
  try {
    const who = whoFrom(socket);
    if (!who.name) {
      const rec = who.did ? identity.getRecord(who.did) : null;
      if (hit.autoBlocked) who.name = (rec && rec.name) || null;
      else {
        socket._amEvasion = hit;
        return;
      }
    }
    postEvasion(socket, who, hit);
  } catch (e) {
    console.error("automod evasion note failed:", e.message);
  }
}

function postEvasion(socket, who, hit) {
  const labels = labelsOf(hit);
  const label = labels[0] || null;
  const them = label || "a blocked user";
  const others = devicesOf(hit);
  const ip = socket.clientIp || null;
  const name = noName(who);
  const blocked = blockedRow(them, others[0] || null);
  const matched = (hit.blockKeys || []).map((k) => state.blockedIPs.get(k)).find((b) => b && typeof b === "object") || null;
  if (hit.autoBlocked) {
    const cmp = compare(who.did, ip, others, { label, history: hit.kind !== "history" });
    cmp.same.unshift(hit.kind === "history" ? "browser" : hit.kind === "address" ? "network" : "name, network");
    event(
      "autoblock",
      who,
      name + " blocked at sign-in",
      {
        chips: ["Blocked", hit.autoBlocked.permanent ? "Permanent" : "Until the old block ends"],
        facts: [blocked].concat(matched ? blockRows(matched) : [], factsOf(null, cmp)),
        ...blockAnchor(matched),
      },
      { force: true },
    );
    return;
  }
  if (hit.kind === "history") {
    const n = hit.seenCount || 1;
    const cmp = compare(who.did, ip, others, { label, history: false });
    event("evade", who, name + " was on a blocked network before", {
      facts: [blocked, "This browser|seen " + n + (n === 1 ? " time" : " times") + " on the network blocked for " + them].concat(matched ? blockRows(matched) : [], factsOf(null, cmp), ["Action|none"]),
      ...blockAnchor(matched),
    });
  } else if (hit.kind === "address") {
    const cmp = compare(who.did, ip, others, { label });
    event("evade", who, name + " is on the network " + them + " last used", {
      facts: [blocked].concat(factsOf(null, cmp), ["Action|none"]),
    });
  }
}

// A block placed by a sign-in check that does not go through evasion.check.
// info.facts are "Label|value" rows, info.chips go after "Blocked".
function noteAutoBlock(socket, username, info) {
  if (!ctx || !socket || socket.isDev || socket.isMod) return;
  try {
    const who = whoFrom(socket);
    if (username) who.name = username;
    const i = info || {};
    event(
      "autoblock",
      who,
      noName(who) + " blocked at sign-in",
      { chips: ["Blocked"].concat(i.chips || []), facts: i.facts || [] },
      { force: true },
    );
  } catch (e) {
    console.error("automod block note failed:", e.message);
  }
}

function noteFlood(socket) {
  if (!plain(socket)) return;
  try {
    const who = whoFrom(socket);
    if (!who.uid) return;
    const n = tally("flood", who.uid, WINDOW_MS);
    if (n < FLOOD_TRIPS) return;
    const room = roomLabel(socket);
    event("flood", who, noName(who) + " flooded " + (room || "the lobby"), {
      facts: ["Bursts|" + n + " in " + short(WINDOW_MS), "Action|extra updates dropped|not blocked"],
      roomName: room,
    });
  } catch (e) {
    console.error("automod flood note failed:", e.message);
  }
}

function staffLike(name) {
  const now = Date.now();
  if (!modLabels || now - modLabels.at > 5 * 60 * 1000) {
    let labels = [];
    try {
      labels = roles
        .listModKeys()
        .map((k) => k.label)
        .filter((l) => usable(l) && letters(l) >= 5 && !plainWord(l));
    } catch (_) {}
    modLabels = { at: now, keys: labels.map((l) => ({ label: l, key: nameKey(l) })) };
  }
  const key = nameKey(name);
  const hit = key ? modLabels.keys.find((k) => k.key === key) : null;
  return hit ? hit.label : null;
}

// Every sign-in and rename passes here: name hopping, and names that copy a
// staff member.
function noteName(socket, username) {
  if (!plain(socket) || !username) return;
  try {
    const who = whoFrom(socket);
    who.name = username;
    const key = who.did || who.uid;
    if (!key) return;
    const now = Date.now();
    const k = "names|" + key;
    const list = (trips.get(k) || []).filter((e) => now - e.at < WINDOW_MS);
    const sk = nameKey(username);
    if (!list.length || list[list.length - 1].sk !== sk) list.push({ at: now, sk, name: username });
    trips.set(k, list);
    if (new Set(list.map((e) => e.sk)).size >= RENAME_TRIPS) {
      const names = [];
      for (const e of list) if (!names.includes(e.name)) names.push(e.name);
      event("rename", who, username + " changed name " + (list.length - 1) + " times in " + short(now - list[0].at), {
        facts: ["Names|" + names.slice(0, 8).join("|") + (names.length > 8 ? "|and " + (names.length - 8) + " more" : "")],
      });
    }
    const label = staffLike(username);
    if (label) {
      const same = nameguard.fold(username) === nameguard.fold(label);
      event("copycat", who, username + (same ? " is using staff name " : " is close to staff name ") + label, {
        facts: [same ? "Spelling|same" : "Spelling|differs"],
      });
    }
  } catch (e) {
    console.error("automod name note failed:", e.message);
  }
}

// Someone sat down in a room: a lookalike name, or a fresh browser arriving
// right after a ban in that room.
function noteJoin(socket, room, userId) {
  if (!plain(socket) || !room) return;
  try {
    const who = whoFrom(socket);
    if (!who.name) return;
    copycatIn(who, room, userId);
    newFace(socket, who, room);
  } catch (e) {
    console.error("automod join check failed:", e.message);
  }
}

function copycatIn(who, room, userId) {
  const sk = nameKey(who.name);
  if (!sk) return;
  const me = persons.peek(who.did || who.uid);
  const folded = nameguard.fold(who.name);
  for (const u of room.users || []) {
    if (!u || u.id === userId || !u.username) continue;
    if (nameKey(u.username) !== sk || nameguard.fold(u.username) === folded) continue;
    if (ctx.getUserStaffRole && ctx.getUserStaffRole(u.id) === "dev") continue;
    const other = persons.peek(u.id);
    if (!me.standalone && !other.standalone && other.id === me.id) continue;
    event("copycat", who, who.name + " looks like " + u.username + " in " + room.name, {
      facts: ["Already in the room|Name=" + u.username + (u.location ? "|Location=" + u.location : ""), "Spelling|differs"],
      roomName: room.name,
      roomId: room.id,
    });
    return;
  }
}

function newFace(socket, who, room) {
  if (!who.did) return;
  const now = Date.now();
  const rec = identity.getRecord(who.did);
  if (!rec || now - rec.first > NEWFACE_MS) return;
  const me = persons.peek(who.did);
  const myNet = rangeOf(socket.clientIp || null);
  const myIsp = netOf(who.did);
  const myLoc = nameKey(who.location || "");
  const cl = clientdetails.of(who.did);
  for (let i = store.bans.length - 1; i >= 0; i--) {
    const b = store.bans[i];
    if (now - b.at > NEWFACE_MS) break;
    if (b.roomId !== room.id) continue;
    if (b.did && me.devices.some((d) => d.id === b.did)) continue;
    const same = [];
    if (myNet && b.net && myNet === b.net) same.push("network");
    if (myIsp && myIsp.n && b.isp && myIsp.n === b.isp) same.push("provider");
    if (myLoc.length >= 3 && b.loc && myLoc === b.loc) same.push("location");
    if (cl && b.sys && systemOf(cl) === b.sys && cl.tz && b.tz && cl.tz === b.tz) same.push("system", "time zone");
    if (!same.length) continue;
    event("newface", who, who.name + " joined " + room.name + " " + short(now - b.at) + " after " + (b.name || "a user") + " was banned there", {
      chips: ["New browser"],
      facts: ["Banned user|Name=" + (b.name || "(no name)") + (b.locRaw ? "|Location=" + b.locRaw : ""), "Same|" + same.join("|")],
      roomName: room.name,
      roomId: room.id,
    });
    return;
  }
}

function noteRoomBan(room, info) {
  if (!ctx || !room) return;
  try {
    const i = info || {};
    const cl = i.did ? clientdetails.of(i.did) : null;
    const net = netOf(i.did);
    store.bans.push({
      roomId: room.id,
      roomName: room.name,
      at: Date.now(),
      uid: i.uid || null,
      did: i.did || null,
      name: i.name || null,
      net: rangeOf(i.ip),
      isp: net && net.n ? net.n : null,
      loc: nameKey(i.location || ""),
      locRaw: i.location || null,
      sys: cl ? systemOf(cl) : null,
      tz: cl && cl.tz ? cl.tz : null,
    });
    if (store.bans.length > KEEP_BANS) store.bans.splice(0, store.bans.length - KEEP_BANS);
    saveSoon();
  } catch (e) {
    console.error("automod room ban note failed:", e.message);
  }
}

function noteLink(socket) {
  if (!plain(socket)) return;
  try {
    const who = whoFrom(socket);
    if (!who.uid) return;
    const n = tally("links", who.uid, WINDOW_MS);
    if (n < LINK_TRIPS) return;
    const room = roomLabel(socket);
    event("links", who, noName(who) + " posted " + n + " blocked links" + (room ? " in " + room : ""), {
      facts: ["Window|" + short(WINDOW_MS)],
      roomName: room,
    });
  } catch (e) {
    console.error("automod link note failed:", e.message);
  }
}

function noteVote(target, room, n, kicked) {
  if (!ctx || !room || !target || !target.uid) return;
  try {
    if (ctx.getUserStaffRole && ctx.getUserStaffRole(target.uid)) return;
    const who = { uid: target.uid, did: target.did || null, name: target.name || null, location: target.location || null };
    if (kicked)
      event("voted", who, noName(who) + " voted out of " + room.name, { facts: ["Votes|" + n], roomName: room.name, roomId: room.id }, { force: true });
    else if (n >= VOTES_NOTE)
      event("voted", who, noName(who) + " has " + n + " votes against in " + room.name, {
        facts: ["Needed to remove|" + (Math.floor((room.users || []).length / 2) + 1)],
        roomName: room.name,
        roomId: room.id,
      });
  } catch (e) {
    console.error("automod vote note failed:", e.message);
  }
}

function noteProxy(socket, info) {
  if (!ctx || !socket || socket.isDev || socket.isMod) return;
  try {
    const i = info || {};
    const who = whoFrom(socket);
    if (i.username) who.name = i.username;
    const kind = String(i.through || "proxy").replace(/^an? /, "");
    event(
      "proxy",
      who,
      noName(who) + " refused, " + kind,
      { facts: ["Network|" + kind + (i.provider ? "|" + i.provider : ""), "Action|" + (i.refused || "refused").toLowerCase() + "|no block"] },
      { quietMs: DAY },
    );
  } catch (e) {
    console.error("automod proxy note failed:", e.message);
  }
}

function noteReport(target, count, what) {
  if (!ctx || !target || !target.uid || target.role) return;
  try {
    if (!count || count.total < REPORTS_NOTE) return;
    const who = { uid: target.uid, did: target.did || null, name: target.name || null, location: target.location || null };
    event("reported", who, noName(who) + " reported again", {
      facts: ["Reports|" + count.total + " from " + count.distinct + (count.distinct === 1 ? " person" : " people"), "Latest|" + (what || "other")],
    });
  } catch (e) {
    console.error("automod report note failed:", e.message);
  }
}

function register(socket, safe) {
  const guard = (fn) =>
    safe(async (data) => {
      if (!ctx || !isStaff(socket) || !allow(socket)) return;
      return fn(data || {});
    });

  socket.on(
    "automod search",
    guard((data) => {
      const q = typeof data.q === "string" ? data.q : "";
      count(socket, "searches");
      socket.emit("automod results", { q: q.slice(0, 60), results: search(q, socket) });
    }),
  );

  socket.on(
    "automod card",
    guard((data) => {
      const key = typeof data.key === "string" ? data.key : "";
      socket.emit("automod card", { key, card: card(key, socket) });
    }),
  );

  socket.on(
    "automod watch",
    guard((data) => {
      const res = setWatch(data.key, data.on !== false, socket);
      socket.emit("automod watch", { key: data.key, on: data.on !== false, ...res, watches: watches(socket) });
    }),
  );

  socket.on(
    "automod mine",
    guard(() => socket.emit("automod mine", { watches: watches(socket) })),
  );

  socket.on(
    "automod vote",
    guard((data) => {
      if (levelOf(socket) < 2) return;
      socket.emit("automod vote", { a: data.a, b: data.b, ...vote(data, socket) });
    }),
  );

  socket.on(
    "automod share",
    guard((data) => {
      const key = typeof data.key === "string" ? toUid(data.key) : "";
      if (!key || !canSee(persons.peek(key), socket)) return;
      const file = ctx.buildQuickFile(key, socket);
      const by = modName(socket);
      count(socket, "shares");
      post((by || "Staff") + " shared " + (file.name || "a user"), {
        category: "shared",
        target: file.name || "(no name)",
        targetUserId: key,
        by,
      });
    }),
  );

  socket.on(
    "automod not them",
    guard((data) => {
      if (levelOf(socket) < 2) return;
      socket.emit("automod not them", { id: data.id, ok: clearReturn(String(data.id || ""), socket) });
    }),
  );

  socket.on(
    "automod stats",
    guard(() => {
      if (levelOf(socket) < 3) return;
      const out = stats();
      if (socket.isMainDev) out.device = deviceStats();
      socket.emit("automod stats", out);
    }),
  );

  socket.on(
    "automod device",
    guard((data) => {
      if (!socket.isMainDev) return;
      store.deviceOn = data.on === true;
      deviceIndex = null;
      saveSoon();
      const out = stats();
      out.device = deviceStats();
      socket.emit("automod stats", out);
    }),
  );
}

load();

module.exports = {
  init,
  register,
  noteWatch,
  noteSignin,
  noteAction,
  noteKnock,
  noteEvasion,
  noteAutoBlock,
  noteFlood,
  noteName,
  noteJoin,
  noteRoomBan,
  noteLink,
  noteVote,
  noteProxy,
  noteReport,
  flushSync,
  search,
  card,
  score,
  CHANNEL,
};
