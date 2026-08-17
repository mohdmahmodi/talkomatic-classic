// server/staffchat.js
// The Desk: staff-only chat and shift console.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const { maskIps } = require("./audit");

const FILE = path.join(DATA_DIR, "staff-chat.json");

// ── Channels ────────────────────────────────────────────────────────────────
const CHANNELS = [
  { key: "floor", name: "floor", desc: "Day to day. The default." },
  { key: "help", name: "help", desc: "Live calls for backup from rooms." },
  { key: "queues", name: "queues", desc: "Incoming reports, appeals, applications.", access: "l2" },
  { key: "l2", name: "l2", desc: "Bans, blocks, escalations.", access: "l2" },
  { key: "devs", name: "devs", desc: "Keys, promotions, mod abuse.", access: "dev" },
  { key: "stats", name: "stats", desc: "How yesterday went.", readonly: true },
  {
    key: "activity",
    name: "activity",
    desc: "Every staff action, as it happens.",
    readonly: true,
    virtual: true,
  },
  {
    key: "bans",
    name: "bans",
    desc: "Blocks placed and lifted.",
    access: "l2",
    readonly: true,
    virtual: true,
  },
  {
    key: "announce",
    name: "announce",
    desc: "Notices sent to everyone.",
    access: "dev",
    readonly: true,
    virtual: true,
  },
];

const isVirtual = (key) => {
  const ch = CHANNELS.find((c) => c.key === key);
  return !!(ch && ch.virtual);
};

const MSG_MAX = 1200;
const CHANNEL_CAP = 1500;
const THREAD_MSG_CAP = 800;
const ARCHIVED_CAP = 300;
const EDIT_WINDOW_MS = 5 * 60 * 1000;
const THREAD_QUIET_MS = 24 * 60 * 60 * 1000;
const PING_COOLDOWN_MS = 60 * 1000;
const PING_ESCALATE_MS = 3 * 60 * 1000;
const RECEIPT_WINDOW_MS = 30 * 60 * 1000;

const REACTIONS = [
  "👍", "👎", "✅", "❌", "👀", "🔥", "❤️", "😂", "🎉", "🤔", "⚠️", "🚨",
];
const EMOTE_CODE_RE = /^:[A-Za-z0-9_.-]{1,40}:$/;
const REACTION_CAP = 12;

// ── State ───────────────────────────────────────────────────────────────────
let desk = {
  seq: 0,
  channels: {},
  threads: [],
  lastRead: {},
  day: null,
};
for (const c of CHANNELS) desk.channels[c.key] = [];

const byId = new Map();
let visitorSet = new Set();
let ctx = null;
let saveTimer = null;
let presenceTimer = null;
const sendTimes = new Map();
const pingCooldowns = new Map();
const pingEdge = new WeakMap();

function io() {
  return ctx && ctx.io();
}

// ── Identity ────────────────────────────────────────────────────────────────
function isStaff(socket) {
  return !!(socket && (socket.isDev || socket.isMod));
}

function who(socket) {
  const av = socket.handshake?.session?.avatar;
  return {
    label: socket.staffLabel || (socket.isDev ? "dev" : "mod"),
    role: socket.isDev ? "dev" : "mod",
    level: socket.isDev ? 0 : socket.modLevel || 2,
    alias: socket.handshake?.session?.username || null,
    avatar:
      av && (av.id || av.discordId) && av.hash
        ? {
            id: String(av.id || av.discordId),
            hash: String(av.hash),
            animated: !!av.animated,
          }
        : null,
  };
}

const idKeyOf = (w) => w.role + ":" + w.label;

function canRead(socket, key) {
  if (!isStaff(socket)) return false;
  if (key.startsWith("t")) return true;
  const ch = CHANNELS.find((c) => c.key === key);
  if (!ch) return false;
  if (ch.access === "dev") return !!socket.isDev;
  if (ch.access === "l2") return socket.isDev || (socket.modLevel || 2) >= 2;
  return true;
}

const isReadonly = (key) => {
  const ch = CHANNELS.find((c) => c.key === key);
  return !!(ch && ch.readonly);
};

function canSeeMessage(socket, key, msg) {
  if (!canRead(socket, key)) return false;
  if (msg.devOnly && !socket.isDev) return false;
  if (msg.minLevel && !socket.isDev && (socket.modLevel || 2) < msg.minLevel)
    return false;
  return true;
}

// ── Persistence (board.json pattern: debounce + tmp/rename + sync flush) ────
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(desk), "utf8");
      await fsp.rename(tmp, FILE);
    } catch (e) {
      console.error("staff chat save failed:", e.message);
    }
  }, 5000);
}

function flushSync() {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    fs.writeFileSync(FILE, JSON.stringify(desk), "utf8");
  } catch (e) {
    console.error("staff chat flush failed:", e.message);
  }
}

function indexAll() {
  byId.clear();
  for (const c of CHANNELS)
    for (const m of desk.channels[c.key] || []) byId.set(m.id, { msg: m, key: c.key });
  for (const t of desk.threads)
    for (const m of t.messages || []) byId.set(m.id, { msg: m, key: t.id });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") {
      desk.seq = raw.seq || 0;
      desk.lastRead = raw.lastRead || {};
      desk.threads = Array.isArray(raw.threads) ? raw.threads : [];
      for (const c of CHANNELS)
        desk.channels[c.key] = Array.isArray(raw.channels?.[c.key])
          ? raw.channels[c.key]
          : [];
      if (raw.day && typeof raw.day === "object") {
        desk.day = raw.day;
        visitorSet = new Set(
          Array.isArray(raw.day.visitors) ? raw.day.visitors : [],
        );
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("staff chat load failed:", e.message);
  }
  backfillCards();
  indexAll();
}

// ── Reading the old messages back ───────────────────────────────────────────
function parseQueueCard(m) {
  const t = String(m.text || "");
  if (m.qkind === "report") {
    const re =
      /^(.+?) reported (.+?)( \(staff\))? for ([^:.]+?)(?::\s([\s\S]*?))?\.\s(\d+)\s(?:person has|people have) reported [\s\S]*? recently\.(?:\s+Their chat box read: "([\s\S]*)")?$/;
    const x = re.exec(t);
    if (!x) return null;
    return {
      by: x[1],
      target: x[2],
      targetRole: x[3] ? "mod" : null,
      category: x[4],
      reason: x[5] || null,
      reports: Number(x[6]) || null,
      quote: x[7] || null,
    };
  }
  if (m.qkind === "application") {
    const x = /^New mod application from (.+)$/.exec(t);
    return x ? { by: x[1] } : null;
  }
  if (m.qkind === "appeal") {
    const x = /^(.+?) submitted a ban appeal\.$/.exec(t);
    return x ? { by: x[1] } : null;
  }
  if (m.qkind === "suggestion") {
    let x = /^(.+?) posted (an idea|a bug) on the board: ([\s\S]+)$/.exec(t);
    if (x)
      return {
        by: x[1],
        category: x[2] === "an idea" ? "Idea" : "Bug",
        target: x[3],
      };
    x = /^(.+?) posted on the board: ([\s\S]+)$/.exec(t);
    if (x) return { by: x[1], category: "Idea", reason: x[2] };
    x = /^(.+?) suggested: ([\s\S]+)$/.exec(t);
    return x ? { by: x[1], category: "Idea", reason: x[2] } : null;
  }
  if (m.qkind === "abuse") {
    const x =
      /^Possible mod abuse by (.+?): ([\s\S]*?)\.\s*Recent actions:\s*([\s\S]*?)\.?$/.exec(
        t,
      );
    if (!x) return null;
    return {
      target: x[1],
      targetRole: "mod",
      reason: x[2],
      lines: x[3]
        .split(", ")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  return null;
}

function parseStats(m) {
  const t = String(m.text || "");
  const at = t.indexOf(": ");
  if (at === -1) return null;
  const when = t.slice(0, at);
  const body = t.slice(at + 2);
  const num = (re) => {
    const x = re.exec(body);
    return x ? Number(x[1]) || 0 : 0;
  };
  const visitors = num(
    /(\d+)\s+(?:person|people)\s+(?:stopped by|used Talkomatic)/,
  );
  const rooms = num(/(\d+)\s+rooms?\s+(?:opened|created)/);
  if (!visitors && !rooms) return null;
  return {
    when,
    visitors,
    rooms,
    peak: num(/(\d+)\s+online at once/),
    actions: num(/(\d+)\s+(?:staff|moderator) actions?/),
    reports: num(/(\d+)\s+reports?/),
    pings: num(/(\d+)\s+calls?\s+for backup/),
    strokes: 0,
  };
}

function dropSettledCards() {
  const list = desk.channels.queues || [];
  const kept = list.filter((m) => !(m && m.done));
  if (kept.length === list.length) return 0;
  for (const m of list) if (m && m.done) byId.delete(m.id);
  desk.channels.queues = kept;
  return list.length - kept.length;
}

function backfillCards() {
  let changed = dropSettledCards();
  for (const m of desk.channels.queues || []) {
    if (!m || m.card || m.kind !== "system") continue;
    const c = parseQueueCard(m);
    if (!c) continue;
    m.card = sanitizeCard(m.qkind, c);
    changed++;
  }
  for (const m of desk.channels.stats || []) {
    if (!m || m.stats || m.kind !== "system") continue;
    const s = parseStats(m);
    if (!s) continue;
    m.stats = s;
    changed++;
  }
  if (changed) scheduleSave();
  return changed;
}
load();

// ── Threads ─────────────────────────────────────────────────────────────────
const isArchived = (t) => Date.now() - (t.lastTs || t.createdAt) > THREAD_QUIET_MS;

function threadSummary(t, showIp) {
  return {
    id: t.id,
    title: showIp ? t.title : maskIps(t.title),
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    lastTs: t.lastTs,
    archived: isArchived(t),
    link: t.link || null,
    n: (t.messages || []).length,
  };
}

function pruneArchived() {
  const archived = desk.threads.filter(isArchived);
  if (archived.length <= ARCHIVED_CAP) return;
  archived.sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
  const drop = new Set(archived.slice(0, archived.length - ARCHIVED_CAP).map((t) => t.id));
  desk.threads = desk.threads.filter((t) => !drop.has(t.id));
}

// ── Mentions ────────────────────────────────────────────────────────────────
function staffDirectory() {
  const by = new Map();
  const add = (label, role, level) => {
    if (!label) return;
    const k = label.toLowerCase();
    if (!by.has(k)) by.set(k, { label, role, level });
  };
  try {
    for (const k of ctx.roles.listModKeys()) add(k.label, "mod", k.level || 2);
    for (const d of ctx.roles.listDevKeys()) add(d.label, "dev", 0);
  } catch (_) {}
  if (io())
    for (const [, s] of io().sockets.sockets)
      if (s.connected && isStaff(s) && s.staffLabel)
        add(s.staffLabel, s.isDev ? "dev" : "mod", s.isDev ? 0 : s.modLevel || 2);
  return [...by.values()];
}

const staffLabels = () =>
  staffDirectory()
    .map((s) => s.label)
    .sort((a, b) => b.length - a.length);

const MENTION_GROUPS = [
  { key: "everyone", tokens: ["everyone", "all"] },
  { key: "dev", tokens: ["devs", "developers"] },
  { key: "l2", tokens: ["l2 mods", "full mods", "l2"] },
  { key: "l1", tokens: ["l1 mods", "jr mods", "junior mods", "juniors", "l1"] },
];
const GROUP_BY_TOKEN = new Map();
for (const g of MENTION_GROUPS)
  for (const t of g.tokens) GROUP_BY_TOKEN.set(t, g.key);
const GROUP_TOKENS = [...GROUP_BY_TOKEN.keys()].sort(
  (a, b) => b.length - a.length,
);

function inGroup(key, role, level) {
  if (key === "everyone") return true;
  if (key === "dev") return role === "dev";
  if (key === "l2") return role !== "dev" && (level || 2) >= 2;
  if (key === "l1") return role !== "dev" && (level || 2) === 1;
  return false;
}

function extractMentions(text) {
  const out = { labels: [], groups: [] };
  if (typeof text !== "string" || text.indexOf("@") === -1) return out;
  const low = text.toLowerCase();
  const found = (needle) => {
    let from = 0;
    for (;;) {
      const at = low.indexOf(needle, from);
      if (at === -1) return false;
      from = at + needle.length;
      const before = at > 0 ? text[at - 1] : "";
      const after = text[from] || "";
      if (/[\w@#]/.test(before) || /\w/.test(after)) continue;
      return true;
    }
  };
  for (const t of GROUP_TOKENS)
    if (found("@" + t)) {
      const key = GROUP_BY_TOKEN.get(t);
      if (!out.groups.includes(key)) out.groups.push(key);
    }
  for (const label of staffLabels())
    if (found("@" + label.toLowerCase()) && !out.labels.includes(label))
      out.labels.push(label);
  return out;
}

function mentions(msg, socket) {
  if (!socket.staffLabel) return false;
  const mine = socket.staffLabel.toLowerCase();
  if (Array.isArray(msg.mentionGroups))
    for (const g of msg.mentionGroups)
      if (inGroup(g, socket.isDev ? "dev" : "mod", socket.modLevel || 2))
        return true;
  if (Array.isArray(msg.mentions))
    return msg.mentions.some((l) => String(l).toLowerCase() === mine);
  if (Array.isArray(msg.mentionGroups)) return false;
  return (
    typeof msg.text === "string" && msg.text.toLowerCase().includes("@" + mine)
  );
}

// ── Fan-out ─────────────────────────────────────────────────────────────────
function outbound(msg, socket) {
  const copy = socket.isMainDev ? { ...msg } : maskDeep(msg);
  if (!socket.isDev) delete copy.history;
  copy.mention = mentions(msg, socket);
  if (Array.isArray(msg.reactions) && msg.reactions.length) {
    const mine = idKeyOf(who(socket));
    copy.reactions = msg.reactions.map((r) => ({
      e: r.e,
      n: r.by.length,
      me: r.by.includes(mine),
      who: r.by.map((k) => k.slice(k.indexOf(":") + 1)),
    }));
  }
  return copy;
}

function broadcast(key, msg, updated) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !canSeeMessage(s, key, msg)) continue;
    s.emit("desk message", { key, msg: outbound(msg, s), updated: !!updated });
  }
}

function broadcastThreadList() {
  if (!io()) return;
  const masked = desk.threads.map((t) => threadSummary(t, false));
  const full = desk.threads.map((t) => threadSummary(t, true));
  for (const [, s] of io().sockets.sockets)
    if (s.connected && isStaff(s))
      s.emit("desk threads", { threads: s.isMainDev ? full : masked });
}

// ── Messages ────────────────────────────────────────────────────────────────
function targetList(key) {
  if (key.startsWith("t")) {
    const t = desk.threads.find((x) => x.id === key);
    return t ? { list: t.messages, thread: t, cap: THREAD_MSG_CAP } : null;
  }
  if (isVirtual(key)) return null;
  return desk.channels[key] ? { list: desk.channels[key], cap: CHANNEL_CAP } : null;
}

function pushMessage(key, msg) {
  const tgt = targetList(key);
  if (!tgt) return null;
  msg.id = "m" + ++desk.seq;
  tgt.list.push(msg);
  byId.set(msg.id, { msg, key });
  if (tgt.list.length > tgt.cap) {
    const dropped = tgt.list.splice(0, tgt.list.length - tgt.cap);
    for (const d of dropped) byId.delete(d.id);
  }
  if (tgt.thread) {
    const wasArchived = isArchived(tgt.thread);
    tgt.thread.lastTs = msg.ts;
    if (wasArchived) broadcastThreadList();
  }
  scheduleSave();
  return msg;
}

function system(key, text, extra) {
  const msg = pushMessage(key, {
    ts: Date.now(),
    kind: "system",
    author: null,
    text: String(text || "").slice(0, 500),
    ...(extra || {}),
  });
  if (msg) broadcast(key, msg);
  return msg;
}

function systemQueues(qkind, text, opts) {
  if (qkind === "report") noteEvent("report");
  const card = opts && opts.card ? sanitizeCard(qkind, opts.card) : null;
  return system("queues", text, {
    qkind: qkind || "notice",
    minLevel: (opts && opts.minLevel) || null,
    devOnly: !!(opts && opts.devOnly),
    ...(card ? { card } : {}),
  });
}

function cut(v, n) {
  return v == null ? null : String(v).slice(0, n || 200);
}

function sanitizeCard(qkind, c) {
  const out = {
    ids: Array.isArray(c.ids)
      ? c.ids.filter(Boolean).map((x) => cut(x, 100)).slice(0, 6)
      : [],
    by: cut(c.by, 60),
    byRole: cut(c.byRole, 10),
    target: cut(c.target, 60),
    targetRole: cut(c.targetRole, 10),
    targetUserId: cut(c.targetUserId, 100),
    deviceId: cut(c.deviceId, 100),
    category: cut(c.category, 60),
    reason: cut(c.reason, 300),
    quote: cut(c.quote, 300),
    reports: Number(c.reports) || null,
    itemId: Number.isFinite(Number(c.itemId)) ? Number(c.itemId) : null,
    roomId: cut(c.roomId, 60),
    roomName: cut(c.roomName, 60),
    discord: cut(c.discord, 60),
    lines: Array.isArray(c.lines)
      ? c.lines.filter(Boolean).map((x) => cut(x, 160)).slice(0, 12)
      : null,
  };
  for (const k in out) if (out[k] == null) delete out[k];
  if (!out.ids.length) delete out.ids;
  return out;
}

const NEVER_MASK = new Set([
  "id", "key", "refId", "ids", "itemId", "roomId",
  "targetUserId", "byUserId", "deviceId",
]);

function maskDeep(value, field) {
  if (typeof value === "string")
    return NEVER_MASK.has(field) ? value : maskIps(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, field));
  if (value && typeof value === "object") {
    const out = {};
    for (const k in value) out[k] = maskDeep(value[k], k);
    return out;
  }
  return value;
}

// ── Queue cards: settled, and cleared out ───────────────────────────────────
function settleQueue(match) {
  dropQueue(match);
}

const SETTLES_QUEUE =
  /^(kick|ban|ip block|unblock ip|warn|wipe buffer|dismiss report|freeze|reset location|turn pfp off|piano mute|approve mod application|reject mod application|dismiss appeal|lift ban|approve suggestion|decline suggestion|revoke mod)/;

function dropQueue(match) {
  const list = desk.channels.queues || [];
  const gone = [];
  desk.channels.queues = list.filter((m) => {
    if (!m.card || !match(m)) return true;
    gone.push(m.id);
    byId.delete(m.id);
    return false;
  });
  if (!gone.length) return;
  scheduleSave();
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && isStaff(s) && canRead(s, "queues"))
      s.emit("desk drop", { key: "queues", ids: gone });
}

function settleQueueForTarget(byLabel, action, id) {
  if (!id || !SETTLES_QUEUE.test(String(action || ""))) return;
  settleQueue(
    (m) =>
      (m.card.ids || []).includes(id) ||
      m.card.targetUserId === id ||
      m.card.deviceId === id,
  );
}

const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

function pruneQueues() {
  const list = desk.channels.queues || [];
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const gone = [];
  const kept = [];
  for (const m of list) {
    if (m.ts < cutoff) {
      gone.push(m.id);
      byId.delete(m.id);
    } else kept.push(m);
  }
  if (!gone.length) return;
  desk.channels.queues = kept;
  scheduleSave();
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && s.deskHello && canRead(s, "queues"))
      s.emit("desk drop", { key: "queues", ids: gone });
}

// ── The daily tally ─────────────────────────────────────────────────────────
const VISITOR_CAP = 5000;

function freshDay(start) {
  return {
    start,
    visitors: [],
    rooms: 0,
    reports: 0,
    pings: 0,
    actions: 0,
    peak: 0,
    boardStrokes: 0,
  };
}

function dayStart(now) {
  try {
    const s = ctx && ctx.audit && ctx.audit.startOfPacificDay(now);
    if (s) return s;
  } catch (_) { }
  return Math.floor(now / 86400000) * 86400000;
}

function ensureDay(now) {
  const start = dayStart(now || Date.now());
  if (!desk.day) {
    desk.day = freshDay(start);
    visitorSet = new Set();
    return;
  }
  if (desk.day.start === start) return;
  const finished = desk.day;
  desk.day = freshDay(start);
  visitorSet = new Set();
  postDailyStats(finished);
}

function noteEvent(kind, id) {
  ensureDay();
  const d = desk.day;
  if (kind === "visitor") {
    if (!id || visitorSet.has(id)) return;
    visitorSet.add(id);
    if (d.visitors.length < VISITOR_CAP) d.visitors.push(id);
    scheduleSave();
    return;
  }
  if (kind === "room") d.rooms++;
  else if (kind === "report") d.reports++;
  else if (kind === "ping") d.pings++;
  else if (kind === "action") d.actions++;
  else if (kind === "stroke") d.boardStrokes++;
  else return;
  scheduleSave();
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

function postDailyStats(d) {
  if (!d) return;
  const visitors = visitorSet.size || d.visitors.length;
  if (!visitors && !d.rooms && !d.actions) return;
  const when = new Date(d.start).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const bits = [
    plural(visitors, "person", "people") + " used Talkomatic",
    plural(d.rooms, "room") + " created",
  ];
  if (d.peak) bits.push(d.peak + " online at once at the busiest");
  if (d.actions) bits.push(plural(d.actions, "moderator action"));
  if (d.reports) bits.push(plural(d.reports, "report") + " filed");
  if (d.pings) bits.push(plural(d.pings, "call") + " for backup");
  const msg = pushMessage("stats", {
    ts: Date.now(),
    kind: "system",
    author: null,
    qkind: "stats",
    text: when + ": " + bits.join(", ") + ".",
    stats: {
      day: d.start,
      when,
      visitors,
      rooms: d.rooms || 0,
      peak: d.peak || 0,
      actions: d.actions || 0,
      reports: d.reports || 0,
      pings: d.pings || 0,
      strokes: d.boardStrokes || 0,
    },
  });
  if (msg) broadcast("stats", msg);
}

function samplePeak() {
  if (!io()) return;
  ensureDay();
  let n = 0;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && !s.isModLog && s.handshake?.session?.userId) n++;
  if (n > desk.day.peak) {
    desk.day.peak = n;
    scheduleSave();
  }
}

// ── Rate limiting ───────────────────────────────────────────────────────────
function allowSend(idKey) {
  const now = Date.now();
  const times = (sendTimes.get(idKey) || []).filter((t) => now - t < 10000);
  if (times.length >= 8) return false;
  times.push(now);
  sendTimes.set(idKey, times);
  return true;
}

// ── Unread ──────────────────────────────────────────────────────────────────
function unreadFor(socket) {
  const w = who(socket);
  const read = desk.lastRead[idKeyOf(w)] || {};
  const out = {};
  for (const c of CHANNELS) {
    if (!canRead(socket, c.key)) continue;
    if (c.virtual) {
      out[c.key] = { n: 0, mentions: 0 };
      continue;
    }
    const since = read[c.key] || 0;
    let n = 0;
    let named = 0;
    for (let i = (desk.channels[c.key] || []).length - 1; i >= 0; i--) {
      const m = desk.channels[c.key][i];
      if (m.ts <= since) break;
      if (!canSeeMessage(socket, c.key, m)) continue;
      n++;
      if (mentions(m, socket)) named++;
    }
    out[c.key] = { n, mentions: named };
  }
  for (const t of desk.threads) {
    const since = read[t.id] || 0;
    let n = 0;
    for (let i = t.messages.length - 1; i >= 0; i--) {
      if (t.messages[i].ts <= since) break;
      n++;
    }
    if (n) out[t.id] = { n, mentions: 0 };
  }
  return out;
}

// ── The team ────────────────────────────────────────────────────────────────
function rosterFor(socket) {
  const live = buildPresence(socket).staff;
  const online = new Map(live.map((s) => [s.role + ":" + s.label, s]));

  let lastBy = new Map();
  try {
    lastBy = ctx.audit.lastActiveByLabel();
  } catch (_) {}

  const out = [...live];
  try {
    for (const k of ctx.roles.listModKeys()) {
      const key = "mod:" + k.label;
      if (online.has(key)) continue;
      out.push({
        label: k.label,
        role: "mod",
        level: k.level || 2,
        offline: true,
        lastActive: lastBy.get(key) || null,
        grantedAt: k.grantedAt || null,
        locations: [],
      });
    }
    for (const d of ctx.roles.listDevKeys()) {
      const key = "dev:" + d.label;
      if (online.has(key)) continue;
      out.push({
        label: d.label,
        role: "dev",
        level: 0,
        offline: true,
        lastActive: lastBy.get(key) || null,
        locations: [],
      });
    }
  } catch (_) {}
  return out;
}

function rosterDirty() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && s.deskHello && isStaff(s))
      s.emit("desk roster", { staff: rosterFor(s) });
}

// ── Presence ────────────────────────────────────────────────────────────────
function buildPresence(recipient) {
  const staff = new Map();
  const roomsWithStaff = new Map();
  if (!io()) return { staff: [], rooms: [] };

  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s)) continue;
    if (s.isVanished && !recipient.isDev) continue;
    const w = who(s);
    const k = idKeyOf(w);
    let row = staff.get(k);
    if (!row) {
      row = {
        label: w.label,
        role: w.role,
        level: w.level,
        alias: w.alias,
        avatar: w.avatar,
        hidden: false,
        vanished: false,
        locations: [],
      };
      staff.set(k, row);
    }
    if (!row.alias && w.alias) row.alias = w.alias;
    if (!row.avatar && w.avatar) row.avatar = w.avatar;
    if (s.isHidden) row.hidden = true;
    if (s.isVanished) row.vanished = true;
    const room = s.roomId ? ctx.state.rooms.get(s.roomId) : null;
    let loc = null;
    if (room && s.spectating)
      loc = { kind: "watch", roomId: room.id, roomName: room.name };
    else if (room) loc = { kind: "room", roomId: room.id, roomName: room.name };
    else if (s.isModLog) loc = { kind: "dashboard" };
    else if (s.handshake?.auth?.app === "desk") loc = { kind: "desk" };
    else loc = { kind: "lobby" };
    if (
      !row.locations.some(
        (l) => l.kind === loc.kind && l.roomId === loc.roomId,
      )
    )
      row.locations.push(loc);
    if (room && !s.spectating) {
      if (!roomsWithStaff.has(room.id)) roomsWithStaff.set(room.id, new Set());
      roomsWithStaff.get(room.id).add(w.label);
    }
  }

  const rooms = [];
  for (const [id, room] of ctx.state.rooms) {
    const users = room.users || [];
    const visible = recipient.isDev
      ? users.length
      : users.filter((u) => !u.isVanished).length;
    rooms.push({
      id,
      name: room.name,
      type: room.type,
      n: visible,
      cap: ctx.roomCapacity ? ctx.roomCapacity(room) : null,
      locked: !!room.locked,
      slow: !!room.slowMode,
      staff: [...(roomsWithStaff.get(id) || [])],
    });
  }
  rooms.sort((a, b) => b.n - a.n);

  return {
    staff: [...staff.values()].sort((a, b) => a.label.localeCompare(b.label)),
    rooms,
  };
}

function presenceDirty() {
  if (presenceTimer || !io()) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    for (const [, s] of io().sockets.sockets)
      if (s.connected && isStaff(s) && s.deskHello)
        s.emit("desk presence", buildPresence(s));
  }, 400);
}

// ── Pings ───────────────────────────────────────────────────────────────────
function onRoomText(socket, roomId, text) {
  if (!ctx || !isStaff(socket) || !roomId) return;
  const had = pingEdge.get(socket) || { mod: false, dev: false };
  const has = {
    mod: /(^|\s)@mods?\b/i.test(text),
    dev: /(^|\s)@devs?\b/i.test(text),
  };
  pingEdge.set(socket, has);
  const wants = has.dev && !had.dev ? "dev" : has.mod && !had.mod ? "mod" : null;
  if (!wants) return;

  const w = who(socket);
  const cdKey = idKeyOf(w) + "|" + roomId;
  const now = Date.now();
  if (now - (pingCooldowns.get(cdKey) || 0) < PING_COOLDOWN_MS) return;
  pingCooldowns.set(cdKey, now);
  if (pingCooldowns.size > 500)
    for (const [k, t] of pingCooldowns)
      if (now - t > PING_COOLDOWN_MS) pingCooldowns.delete(k);

  const room = ctx.state.rooms.get(roomId);
  if (!room) return;
  const users = room.users || [];
  const staffThere = users
    .filter((u) => u.isDev || u.isMod)
    .map((u) => u.username);

  noteEvent("ping");
  const msg = pushMessage("help", {
    ts: now,
    kind: "ping",
    author: w,
    text: "@" + wants + " needed in " + (room.name || "a room"),
    ping: {
      wants,
      roomId,
      roomName: room.name || "?",
      byLabel: w.label,
      byUserId: socket.handshake?.session?.userId || null,
      status: "open",
      count: users.length,
      staffThere,
      claimedBy: null,
      claimedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      note: null,
      actions: [],
    },
  });
  if (!msg) return;
  broadcast("help", msg);

  setTimeout(() => {
    const ref = byId.get(msg.id);
    if (!ref || ref.msg.ping?.status !== "open") return;
    ref.msg.ping.status = "waiting";
    scheduleSave();
    broadcast("help", ref.msg, true);
  }, PING_ESCALATE_MS);
}

function noteStaffAction(byLabel, action, targetStr, roomTag, byRole) {
  if (targetStr && targetStr.startsWith("user:")) {
    const o = targetStr.lastIndexOf("(");
    const c = targetStr.lastIndexOf(")");
    const id = o !== -1 && c > o ? targetStr.slice(o + 1, c) : null;
    settleQueueForTarget(byLabel, action, id);
  }
  if (byRole === "dev") return;
  if (!roomTag || typeof roomTag !== "string") return;
  const open = roomTag.lastIndexOf("(");
  const close = roomTag.lastIndexOf(")");
  if (open === -1 || close < open) return;
  const roomId = roomTag.slice(open + 1, close);
  if (/^(spectate|staff key)/.test(action)) return;
  const now = Date.now();
  let touched = false;
  const list = desk.channels.help;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (now - m.ts > RECEIPT_WINDOW_MS) break;
    const p = m.ping;
    if (!p || p.roomId !== roomId) continue;
    if (p.status === "resolved") continue;
    let target = null;
    if (targetStr && targetStr.startsWith("user:")) {
      const o = targetStr.lastIndexOf("(");
      target = o > 5 ? targetStr.slice(5, o) : targetStr.slice(5);
    }
    p.actions.push({ ts: now, by: byLabel, action, target });
    if (p.actions.length > 20) p.actions.shift();
    broadcast("help", m, true);
    touched = true;
  }
  if (touched) scheduleSave();
}

// ── Virtual channels ────────────────────────────────────────────────────────

const VIRTUAL_LIMIT = 200;

function activityRow(e) {
  return { id: "a" + e.id, ts: e.ts || 0, kind: "activity", entry: e };
}

function banRow(b) {
  return { id: "b" + (b.id || b.at), ts: b.at || 0, kind: "ban", ban: b };
}

function announceRow(a) {
  return { id: "n" + a.id, ts: a.at || 0, kind: "announce", item: a };
}

function virtualHistory(key, socket) {
  try {
    if (key === "activity") {
      if (!ctx || !ctx.audit) return [];
      const rows = ctx.audit.recent(VIRTUAL_LIMIT, {
        showIp: !!socket.isMainDev,
        showAll: !!socket.isMainDev,
        isDev: !!socket.isDev,
        modLevel: socket.isDev ? 0 : socket.modLevel || 2,
      });
      return rows.map(activityRow);
    }
    if (key === "bans") {
      if (!ctx || !ctx.banHistory) return [];
      return ctx
        .banHistory(!!socket.isMainDev)
        .slice(0, VIRTUAL_LIMIT)
        .map(banRow)
        .reverse();
    }
    if (key === "announce") {
      if (!ctx || !ctx.announcements) return [];
      return ctx.announcements
        .listFor(socket.deviceId || null, VIRTUAL_LIMIT)
        .map(announceRow)
        .reverse();
    }
  } catch (e) {
    console.error("desk virtual history failed:", e.message);
  }
  return [];
}

function pushActivity(entry) {
  if (!io() || !entry) return;
  const privileged =
    ctx && ctx.audit ? ctx.audit.isPrivilegedEntry(entry) : !!entry.devOnly;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s) || !canRead(s, "activity")) continue;
    if (privileged && !s.isMainDev) continue;
    if (entry.minLevel && !s.isDev && (s.modLevel || 2) < entry.minLevel)
      continue;
    const shown =
      s.isMainDev || !ctx || !ctx.audit ? entry : ctx.audit.redactEntry(entry);
    s.emit("desk message", { key: "activity", msg: activityRow(shown) });
  }
}

function dropActivity(ids) {
  if (!io() || !ids || !ids.length) return;
  const rows = ids.map((id) => "a" + id);
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s) || !canRead(s, "activity")) continue;
    s.emit("desk drop", { key: "activity", ids: rows });
  }
}

function pushBans() {
  if (!io() || !ctx || !ctx.banHistory) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s) || !canRead(s, "bans")) continue;
    const list = ctx.banHistory(!!s.isMainDev);
    if (!list.length) continue;
    s.emit("desk message", { key: "bans", msg: banRow(list[0]) });
  }
}

function pushAnnounce(item) {
  if (!io() || !item) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s) || !canRead(s, "announce")) continue;
    s.emit("desk message", {
      key: "announce",
      msg: announceRow(item),
      updated: true,
    });
  }
}

// ── Socket wiring ───────────────────────────────────────────────────────────
function init(context) {
  ctx = context;
  setInterval(presenceDirty, 25000).unref();
  ensureDay();
  setInterval(() => {
    ensureDay();
    samplePeak();
  }, 60000).unref();
  pruneQueues();
  setInterval(pruneQueues, 60 * 60 * 1000).unref();
}

function register(socket, safe) {

  socket.on(
    "desk hello",
    safe(async () => {
      if (!isStaff(socket)) return;
      socket.deskHello = true;
      const w = who(socket);
      socket.emit("desk ready", {
        me: { ...w, mainDev: !!socket.isMainDev },
        channels: CHANNELS.filter((c) => canRead(socket, c.key)).map((c) => ({
          key: c.key,
          name: c.name,
          desc: c.desc,
          restricted: !!c.access,
          readonly: !!c.readonly,
        })),
        threads: desk.threads.map((t) => threadSummary(t, socket.isMainDev)),
        unread: unreadFor(socket),
        presence: buildPresence(socket),
      });
    }),
  );

  socket.on(
    "desk history",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key)) return;
      if (isVirtual(key))
        return socket.emit("desk history", {
          key,
          messages: virtualHistory(key, socket),
          hasMore: false,
          hasMoreNewer: false,
          thread: null,
        });
      const tgt = targetList(key);
      if (!tgt) return;
      const thread = key.startsWith("t")
        ? threadSummary(
          desk.threads.find((t) => t.id === key) || {},
          socket.isMainDev,
        )
        : null;

      const around = Number(data?.around) || 0;
      if (around) {
        const visible = tgt.list.filter((m) => canSeeMessage(socket, key, m));
        let at = visible.findIndex((m) => m.ts >= around);
        if (at === -1) at = visible.length - 1;
        const start = Math.max(0, at - 24);
        const end = Math.min(visible.length, at + 26);
        return socket.emit("desk history", {
          key,
          around,
          messages: visible.slice(start, end).map((m) => outbound(m, socket)),
          hasMore: start > 0,
          hasMoreNewer: end < visible.length,
          thread,
        });
      }

      const before = Number(data?.before) || Infinity;
      const visible = tgt.list.filter(
        (m) => m.ts < before && canSeeMessage(socket, key, m),
      );
      const page = visible.slice(-50);
      socket.emit("desk history", {
        key,
        before: Number.isFinite(before) ? before : null,
        messages: page.map((m) => outbound(m, socket)),
        hasMore: visible.length > page.length,
        thread,
      });
    }),
  );

  socket.on(
    "desk send",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key))
        return socket.emit("desk error", { message: "You cannot post there." });
      if (isReadonly(key))
        return socket.emit("desk error", {
          message: "#" + key + " is written by the server. Try #floor.",
        });
      const w = who(socket);
      if (!allowSend(idKeyOf(w)))
        return socket.emit("desk error", {
          message: "Slow down - a few seconds between messages.",
        });
      const text = String(data?.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      let reply = null;
      if (typeof data?.replyTo === "string") {
        const ref = byId.get(data.replyTo);
        if (ref && ref.key === key && !ref.msg.deletedAt)
          reply = {
            id: ref.msg.id,
            ts: ref.msg.ts,
            label: ref.msg.author ? ref.msg.author.label : "system",
            text: String(ref.msg.text || "").slice(0, 120),
          };
      }
      const named = extractMentions(text);
      const msg = pushMessage(key, {
        ts: Date.now(),
        kind: "chat",
        author: w,
        text,
        ...(named.labels.length ? { mentions: named.labels } : {}),
        ...(named.groups.length ? { mentionGroups: named.groups } : {}),
        ...(reply ? { reply } : {}),
      });
      if (!msg) return;
      broadcast(key, msg);
      if (!named.labels.length && !named.groups.length) return;

      const dir = staffDirectory();
      const wanted = new Map();
      for (const l of named.labels) wanted.set(l.toLowerCase(), l);
      for (const g of named.groups)
        for (const p of dir)
          if (inGroup(g, p.role, p.level)) wanted.set(p.label.toLowerCase(), p.label);
      wanted.delete(w.label.toLowerCase());

      const on = new Set();
      const mine = idKeyOf(w);
      for (const [, s] of io().sockets.sockets) {
        if (!s.connected || !isStaff(s) || !s.staffLabel) continue;
        const label = wanted.get(s.staffLabel.toLowerCase());
        if (!label) continue;
        on.add(label);
        if (idKeyOf(who(s)) === mine) continue;
        if (!canSeeMessage(s, key, msg)) continue;
        s.emit("desk mention", {
          key,
          id: msg.id,
          by: w.label,
          group: named.groups[0] || null,
        });
      }
      const all = [...wanted.values()];
      socket.emit("desk mention receipt", {
        key,
        id: msg.id,
        groups: named.groups,
        pinged: all,
        online: all.filter((l) => on.has(l)),
        offline: all.filter((l) => !on.has(l)),
      });
    }),
  );

  socket.on(
    "desk resolve",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const q = String(data?.q || "").trim();
      if (!q || q.length > 60) return;
      const ql = q.toLowerCase();
      const seen = new Map();
      const consider = (id, username, roomId, exact) => {
        if (!id || seen.has(id)) return;
        const room = roomId ? ctx.state.rooms.get(roomId) : null;
        seen.set(id, {
          id,
          username: username || "?",
          roomId: room ? room.id : null,
          roomName: room ? room.name : null,
          exact,
        });
      };
      for (const [, s] of io().sockets.sockets) {
        if (!s.connected) continue;
        const id = s.handshake?.session?.userId;
        const name = s.handshake?.session?.username || "";
        if (!id) continue;
        if (id === q) consider(id, name, s.roomId, true);
        else if (name.toLowerCase() === ql) consider(id, name, s.roomId, true);
        else if (name.toLowerCase().startsWith(ql))
          consider(id, name, s.roomId, false);
      }
      const matches = [...seen.values()]
        .sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0))
        .slice(0, 5);
      socket.emit("desk resolve", {
        q,
        matches: matches.map(({ exact, ...m }) => m),
        exact: matches.filter((m) => m.exact).length,
      });
    }),
  );

  socket.on(
    "desk edit",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      if (!ref || ref.msg.kind !== "chat" || ref.msg.deletedAt) return;
      const w = who(socket);
      if (!ref.msg.author || idKeyOf(ref.msg.author) !== idKeyOf(w))
        return socket.emit("desk error", { message: "Not your message." });
      if (Date.now() - ref.msg.ts > EDIT_WINDOW_MS)
        return socket.emit("desk error", {
          message: "Edits close five minutes after sending.",
        });
      const text = String(data?.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      (ref.msg.history = ref.msg.history || []).push({
        ts: Date.now(),
        text: ref.msg.text,
      });
      ref.msg.text = text;
      ref.msg.editedAt = Date.now();
      const named = extractMentions(text);
      if (named.labels.length) ref.msg.mentions = named.labels;
      else delete ref.msg.mentions;
      if (named.groups.length) ref.msg.mentionGroups = named.groups;
      else delete ref.msg.mentionGroups;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  socket.on(
    "desk delete",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      if (!ref || ref.msg.deletedAt) return;
      const w = who(socket);
      const own = ref.msg.author && idKeyOf(ref.msg.author) === idKeyOf(w);
      if (!own && !socket.isDev)
        return socket.emit("desk error", { message: "Not your message." });
      (ref.msg.history = ref.msg.history || []).push({
        ts: Date.now(),
        text: ref.msg.text,
      });
      ref.msg.text = "";
      ref.msg.deletedAt = Date.now();
      ref.msg.deletedBy = w.label;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  // ── Reactions ─────────────────────────────────────────────────────────
  socket.on(
    "desk react",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      if (!ref || ref.msg.deletedAt) return;
      if (!canRead(socket, ref.key)) return;
      const e = String(data?.emoji || "");
      if (!REACTIONS.includes(e) && !EMOTE_CODE_RE.test(e)) return;
      const mine = idKeyOf(who(socket));
      const list = (ref.msg.reactions = ref.msg.reactions || []);
      let r = list.find((x) => x.e === e);
      if (!r) {
        if (list.length >= REACTION_CAP) return;
        list.push((r = { e, by: [] }));
      }
      const at = r.by.indexOf(mine);
      if (at === -1) r.by.push(mine);
      else r.by.splice(at, 1);
      if (!r.by.length) list.splice(list.indexOf(r), 1);
      if (!list.length) delete ref.msg.reactions;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  socket.on(
    "desk thread create",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const title = String(data?.title || "").trim().slice(0, 60);
      if (!title) return;
      const w = who(socket);
      const t = {
        id: "t" + ++desk.seq,
        title,
        createdBy: w.label,
        createdAt: Date.now(),
        lastTs: Date.now(),
        link:
          data?.link && typeof data.link.roomId === "string"
            ? {
                roomId: String(data.link.roomId).slice(0, 12),
                roomName: String(data.link.roomName || "").slice(0, 60),
              }
            : null,
        messages: [],
      };
      desk.threads.push(t);
      pruneArchived();
      scheduleSave();
      broadcastThreadList();
      socket.emit("desk thread created", { id: t.id });
    }),
  );

  socket.on(
    "desk thread delete",
    safe(async (data) => {
      if (!socket.isDev) return;
      const id = String(data?.id || "");
      const t = desk.threads.find((x) => x.id === id);
      if (!t) return;
      for (const m of t.messages) byId.delete(m.id);
      desk.threads = desk.threads.filter((x) => x.id !== id);
      scheduleSave();
      broadcastThreadList();
    }),
  );

  socket.on(
    "desk read",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key)) return;
      const w = who(socket);
      const k = idKeyOf(w);
      if (!desk.lastRead[k]) desk.lastRead[k] = {};
      desk.lastRead[k][key] = Math.max(
        desk.lastRead[k][key] || 0,
        Number(data?.ts) || Date.now(),
      );
      scheduleSave();
      let synced = false;
      if (io())
        for (const [, s] of io().sockets.sockets) {
          if (!s.connected || !isStaff(s) || !s.deskHello) continue;
          if (idKeyOf(who(s)) !== k) continue;
          s.emit("desk unread", { unread: unreadFor(s) });
          if (s === socket) synced = true;
        }
      if (!synced) socket.emit("desk unread", { unread: unreadFor(socket) });
    }),
  );

  socket.on(
    "desk presence",
    safe(async () => {
      if (!isStaff(socket)) return;
      socket.emit("desk presence", buildPresence(socket));
    }),
  );

  socket.on(
    "desk roster",
    safe(async () => {
      if (!isStaff(socket)) return;
      socket.emit("desk roster", { staff: rosterFor(socket) });
    }),
  );

  socket.on(
    "desk ping claim",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      const p = ref?.msg?.ping;
      if (!p || (p.status !== "open" && p.status !== "waiting")) return;
      const w = who(socket);
      p.status = "claimed";
      p.claimedBy = w.label;
      p.claimedAt = Date.now();
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
      if (p.byUserId)
        for (const s of ctx.findSocketsByUserId(p.byUserId))
          if (isStaff(s))
            s.emit("desk ping update", {
              id: ref.msg.id,
              status: "claimed",
              by: w.label,
            });
    }),
  );

  socket.on(
    "desk ping resolve",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      const p = ref?.msg?.ping;
      if (!p || p.status === "resolved") return;
      const w = who(socket);
      if (p.status === "claimed" && p.claimedBy !== w.label && !socket.isDev)
        return socket.emit("desk error", {
          message: p.claimedBy + " claimed this one.",
        });
      p.status = "resolved";
      p.resolvedBy = w.label;
      p.resolvedAt = Date.now();
      p.note = String(data?.note || "").trim().slice(0, 200) || null;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  socket.on(
    "desk room info",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const roomId = typeof data?.roomId === "string" ? data.roomId : "";
      const room = ctx.state.rooms.get(roomId);
      if (!room)
        return socket.emit("desk room info", { roomId, gone: true });
      const users = (room.users || [])
        .filter((u) => socket.isDev || !u.isVanished)
        .map((u) => ({
          ...ctx.formatUserForSocket(u, socket),
          location: u.location || "",
        }));
      socket.emit("desk room info", {
        roomId,
        name: room.name,
        type: room.type,
        locked: !!room.locked,
        slow: !!room.slowMode,
        cap: ctx.roomCapacity ? ctx.roomCapacity(room) : null,
        users,
      });
    }),
  );

  socket.on(
    "desk search",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const q = String(data?.q || "").trim().toLowerCase();
      if (q.length < 2 || q.length > 80) return;
      const hits = [];
      const scan = (key, list, title) => {
        for (let i = list.length - 1; i >= 0 && hits.length < 60; i--) {
          const m = list[i];
          if (m.deletedAt || !m.text) continue;
          if (!canSeeMessage(socket, key, m)) continue;
          if (
            m.text.toLowerCase().includes(q) ||
            (m.author && m.author.label.toLowerCase().includes(q))
          )
            hits.push({
              key,
              title: (socket.isMainDev ? title : maskIps(title)) || null,
              ts: m.ts,
              author: m.author ? m.author.label : null,
              text: (socket.isMainDev ? m.text : maskIps(m.text)).slice(0, 200),
            });
        }
      };
      for (const c of CHANNELS)
        if (!c.virtual && canRead(socket, c.key))
          scan(c.key, desk.channels[c.key] || []);
      for (const t of desk.threads) scan(t.id, t.messages, t.title);
      hits.sort((a, b) => b.ts - a.ts);
      socket.emit("desk search", { q, hits: hits.slice(0, 60) });
    }),
  );
}

module.exports = {
  init,
  register,
  onRoomText,
  noteStaffAction,
  systemQueues,
  pushActivity,
  dropActivity,
  pushBans,
  pushAnnounce,
  noteEvent,
  presenceDirty,
  rosterDirty,
  settleQueue,
  dropQueue,
  flushSync,
};
