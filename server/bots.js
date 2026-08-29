// server/bots.js
// User-made room bots, both tiers.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const {
  CONFIG,
  ERROR_CODES,
  state,
  wordFilter,
  createErrorResponse,
  sanitizeMessage,
  sanitizeName,
  enforceRoomNameLimit,
  enforceLocationLimit,
  isReservedName,
} = require("./state");
const ipredact = require("./ipredact");
const linkfilter = require("./linkfilter");
const nameguard = require("./nameguard");
const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "bots.json");

// ── Limits (the whole abuse posture in one place) ───────────────────────────

const LIMITS = {
  MAX_BOTS_PER_ROOM: 5,
  MAX_SAVED: 20,
  MAX_DEPLOYED_PER_OWNER: 1,
  MAX_ACTIVE_TOTAL: 20,
  MAX_RULES: 200,
  MAX_ACTIONS_PER_RULE: 20,
  MAX_CONDITIONS_PER_RULE: 10,
  MAX_SAY_LENGTH: 1000,
  MAX_QUEUE: 12,
  ACTION_TOKENS: 20,
  SAY_MIN_GAP_MS: 1500,
  TIMER_MIN_MINUTES: 2,
  MAX_VARS: 256,
  MAX_USER_VARS: 200,
  VAR_VALUE_LENGTH: 500,
  UTTERANCE_IDLE_MS: 1500,
  TYPE_CHARS_PER_TICK: 4,
  OWNER_GRACE_MS: 60000,
  MAX_CONFIG_BYTES: 200000,
  MAX_MANAGERS: 5,
};

const TICK_MS = 120;
const SWEEP_EVERY_TICKS = 16;

// ── Persistence (same flat JSON store pattern as suggestions/appeals) ───────

let store = { enabled: true, owners: {} };
let saveTimer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (raw && typeof raw === "object") {
      store.enabled = raw.enabled !== false;
      store.owners =
        raw.owners && typeof raw.owners === "object" ? raw.owners : {};
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading bots.json:", err);
    store = { enabled: true, owners: {} };
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("bots save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("bots flush failed:", e);
  }
}

function ownerKeyOf(socket) {
  return socket.deviceId || socket.handshake?.session?.userId || null;
}

function ownerRecord(ownerKey, create) {
  let rec = store.owners[ownerKey];
  if (!rec && create) {
    rec = { bots: [] };
    store.owners[ownerKey] = rec;
  }
  return rec || null;
}

// ── Managers (bots shared with other users) ─────────────────────────────────
// A manager can edit, deploy and stop the bot. Only the owner can delete it,
// hand out or revoke the invite code, demote managers, or transfer it.
// Manager device ids never leave the server; the client sees opaque refs.

function mgrRef(did) {
  return crypto
    .createHash("sha256")
    .update(String(did))
    .digest("hex")
    .slice(0, 12);
}

function isManager(bot, actorKey) {
  return (bot.managers || []).some((m) => m.did === actorKey);
}

function managerView(bot) {
  return (bot.managers || []).map((m) => ({
    ref: mgrRef(m.did),
    name: m.name || "someone",
    addedAt: m.addedAt || 0,
  }));
}

function findBotFor(actorKey, botId) {
  if (!actorKey || !botId) return null;
  const own = ownerRecord(actorKey, false);
  const mine = own?.bots.find((b) => b.id === botId);
  if (mine) return { bot: mine, rec: own, ownerKey: actorKey, role: "owner" };
  for (const [key, rec] of Object.entries(store.owners)) {
    const bot = rec.bots.find((b) => b.id === botId && isManager(b, actorKey));
    if (bot) return { bot, rec, ownerKey: key, role: "admin" };
  }
  return null;
}

function sharedBotsFor(actorKey) {
  const out = [];
  for (const rec of Object.values(store.owners))
    for (const b of rec.bots) if (isManager(b, actorKey)) out.push(b);
  return out;
}

function activeBotOfActor(actorKey) {
  for (const rt of active.values()) {
    if (rt.ownerKey === actorKey) return rt;
    if (isManager(rt.bot, actorKey)) return rt;
  }
  return null;
}

// ── Attribution: who did what, and the versions that protect against it ─────
// Every meaningful action lands in bot.history (a capped log the whole group
// can read), and every overwrite first snapshots the state it replaces into
// bot.versions, so the owner can restore if an edit wrecked the bot.

const CARRY = [
  "managers",
  "inviteCode",
  "sharedBy",
  "lastStop",
  "createdBy",
  "history",
  "versions",
];
const MAX_HISTORY = 25;
const MAX_VERSIONS = 5;

function actorName(socket) {
  return sanitizeName(
    String(socket.handshake?.session?.username || "someone"),
  ).slice(0, 30);
}

function logHistory(bot, entry) {
  if (!bot.history) bot.history = [];
  bot.history.unshift({ at: Date.now(), ...entry });
  if (bot.history.length > MAX_HISTORY) bot.history.length = MAX_HISTORY;
}

function snapshotVersion(bot) {
  if (!bot.versions) bot.versions = [];
  bot.versions.unshift({
    at: bot.updatedAt || Date.now(),
    by: (bot.editedBy && bot.editedBy.name) || bot.createdBy || "someone",
    name: bot.name,
    location: bot.location,
    prefix: bot.prefix || "!",
    rules: bot.rules,
  });
  if (bot.versions.length > MAX_VERSIONS) bot.versions.length = MAX_VERSIONS;
}

// ── Rule validation ─────────────────────────────────────────────────────────

const TRIGGERS = ["command", "says", "mention", "join", "leave", "timer", "arrive"];
const PREFIX_RE = /^[!?.,;:~#$%^&*+=/\\<>@|-]{1,2}$/;
const ACTIONS = ["say", "append", "wait", "set", "add", "random", "repeat", "clear", "leave"];
const OPS = ["is", "not", "gt", "lt", "has"];
const MATH_OPS = ["add", "sub", "mul", "div"];

const VAR_NAME = /^[a-z0-9_]{1,20}$/i;
const CMD_WORD = /^[a-z0-9]{1,16}$/i;

function cleanTemplate(text, max) {
  return sanitizeMessage(String(text == null ? "" : text)).slice(0, max);
}

function validateConfig(input, existingId) {
  if (!input || typeof input !== "object")
    return { ok: false, error: "No bot data." };

  let name = sanitizeName(String(input.name || "")).slice(0, 14);
  if (name.length < 2)
    return { ok: false, error: "Give the bot a name (2-14 characters)." };
  if (wordFilter.checkText(name).hasOffensiveWord)
    return { ok: false, error: "That bot name is not allowed." };
  if (isReservedName(name))
    return { ok: false, error: "That name is reserved." };
  if (ipredact.containsIp(name))
    return { ok: false, error: "Names cannot contain an IP address." };
  if (linkfilter.containsLink(name))
    return { ok: false, error: "Names cannot contain a link." };
  const nameCheck = nameguard.check(name, { reserved: CONFIG.RESERVED_NAMES });
  if (!nameCheck.ok)
    return {
      ok: false,
      error:
        nameCheck.reason === "reserved"
          ? "That name is too close to a name Talkomatic reserves."
          : "Names can only use ordinary letters, numbers and punctuation.",
    };

  let location = enforceLocationLimit(sanitizeName(String(input.location || "")));
  if (location && wordFilter.checkText(location).hasOffensiveWord)
    return { ok: false, error: "That location is not allowed." };
  if (location && ipredact.containsIp(location))
    return { ok: false, error: "Locations cannot contain an IP address." };
  if (location && linkfilter.containsLink(location))
    return { ok: false, error: "Locations cannot contain a link." };
  if (location && !nameguard.check(location).ok)
    return {
      ok: false,
      error: "Locations can only use ordinary letters, numbers and punctuation.",
    };
  if (!location) location = "Bot";

  let prefix = String(input.prefix == null ? "!" : input.prefix).trim();
  if (!prefix) prefix = "!";
  if (!PREFIX_RE.test(prefix))
    return {
      ok: false,
      error: "Prefixes are 1-2 symbols, like ! or ? or >> (no letters or spaces).",
    };

  const rulesIn = Array.isArray(input.rules) ? input.rules : [];
  if (!rulesIn.length)
    return { ok: false, error: "The bot needs at least one rule." };
  if (rulesIn.length > LIMITS.MAX_RULES)
    return { ok: false, error: `At most ${LIMITS.MAX_RULES} rules.` };

  const rules = [];
  for (const r of rulesIn) {
    if (!r || typeof r !== "object") continue;
    const on = r.on && typeof r.on === "object" ? r.on : {};
    if (!TRIGGERS.includes(on.type))
      return { ok: false, error: "A rule has an unknown trigger." };

    const trig = { type: on.type };
    if (on.type === "command") {
      let word = String(on.word || "").trim();
      if (word.startsWith(prefix)) word = word.slice(prefix.length);
      word = word.replace(/^!/, "");
      if (!CMD_WORD.test(word))
        return {
          ok: false,
          error: "Command words are 1-16 letters or digits (like !roll).",
        };
      trig.word = word.toLowerCase();
    } else if (on.type === "says") {
      trig.text = cleanTemplate(on.text, 80).trim();
      if (!trig.text)
        return { ok: false, error: 'A "someone says" rule needs a phrase.' };
    } else if (on.type === "timer") {
      const m = Math.round(Number(on.minutes));
      if (!Number.isFinite(m) || m < LIMITS.TIMER_MIN_MINUTES || m > 120)
        return {
          ok: false,
          error: `Timers run every ${LIMITS.TIMER_MIN_MINUTES}-120 minutes.`,
        };
      trig.minutes = m;
    }

    const condsIn = Array.isArray(r.if) ? r.if : [];
    if (condsIn.length > LIMITS.MAX_CONDITIONS_PER_RULE)
      return {
        ok: false,
        error: `At most ${LIMITS.MAX_CONDITIONS_PER_RULE} conditions per rule.`,
      };
    const conds = [];
    for (const c of condsIn) {
      if (!c || typeof c !== "object") continue;
      if (!OPS.includes(c.op))
        return { ok: false, error: "A condition has an unknown comparison." };
      conds.push({
        a: cleanTemplate(c.a, 80),
        op: c.op,
        b: cleanTemplate(c.b, 80),
      });
    }

    const doIn = Array.isArray(r.do) ? r.do : [];
    if (!doIn.length)
      return { ok: false, error: "A rule has no actions. Give it something to do." };
    if (doIn.length > LIMITS.MAX_ACTIONS_PER_RULE)
      return {
        ok: false,
        error: `At most ${LIMITS.MAX_ACTIONS_PER_RULE} actions per rule.`,
      };
    const actions = [];
    for (const a of doIn) {
      if (!a || typeof a !== "object" || !ACTIONS.includes(a.type))
        return { ok: false, error: "A rule has an unknown action." };
      const act = { type: a.type };
      if (a.type === "say" || a.type === "append") {
        act.text = cleanTemplate(a.text, LIMITS.MAX_SAY_LENGTH);
        if (!act.text.trim())
          return { ok: false, error: "A say action has no text." };
      } else if (a.type === "wait") {
        const s = Number(a.seconds);
        if (!Number.isFinite(s) || s < 0.5 || s > 10)
          return { ok: false, error: "Waits are 0.5-10 seconds." };
        act.seconds = Math.round(s * 10) / 10;
      } else if (a.type === "set" || a.type === "add" || a.type === "random") {
        const name0 = String(a.var || "").trim();
        const stripped = name0.replace(/\{[^{}]*\}/g, "x");
        const valid = name0.includes("{")
          ? name0.length <= 60 && /^[a-z0-9_x]+$/i.test(stripped)
          : VAR_NAME.test(name0);
        if (!valid)
          return {
            ok: false,
            error:
              "Memory names are 1-20 letters, digits or _, and may include a placeholder like {word1}.",
          };
        act.var = name0.toLowerCase();
        act.per = a.per === "user" ? "user" : "bot";
        if (a.type === "set") act.value = cleanTemplate(a.value, 500);
        else if (a.type === "add") {
          act.amount = cleanTemplate(a.amount, 40) || "1";
          act.op = MATH_OPS.includes(a.op) ? a.op : "add";
        } else {
          act.from = cleanTemplate(a.from, 1000);
          if (!act.from.trim())
            return {
              ok: false,
              error: "A random action needs options (a, b, c) or a range (1-100).",
            };
        }
      } else if (a.type === "repeat") {
        const t = Math.round(Number(a.times));
        if (!Number.isFinite(t) || t < 2 || t > 5)
          return { ok: false, error: "Repeat runs the blocks above 2-5 times." };
        act.times = t;
      }
      actions.push(act);
    }
    if (actions.filter((a) => a.type === "repeat").length > 1)
      return { ok: false, error: "One repeat block per rule." };
    if (actions[0] && actions[0].type === "repeat")
      return {
        ok: false,
        error: "Put the blocks to repeat ABOVE the repeat block.",
      };

    const rule = { on: trig, if: conds, do: actions };
    // Owner-only rules ("admin commands"): only the person running the bot
    // can trigger them. Absent on old bots, so nothing changes for those.
    // Timers have no speaker, so the flag means nothing there.
    if (r.who === "owner" && on.type !== "timer") rule.who = "owner";
    rules.push(rule);
  }
  if (!rules.length)
    return { ok: false, error: "The bot needs at least one valid rule." };

  const bot = {
    id: existingId || "b" + crypto.randomBytes(5).toString("hex"),
    name,
    location,
    prefix,
    rules,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    vars: {},
    uvars: {},
  };
  if (JSON.stringify(bot).length > LIMITS.MAX_CONFIG_BYTES)
    return { ok: false, error: "That bot is too large. Trim some rules." };
  return { ok: true, bot };
}

// ── Runtime state ───────────────────────────────────────────────────────────

let deps = null;

const active = new Map();
const roomText = new Map();
const ownerSeen = new Map();

let tickTimer = null;
let tickCount = 0;

function io() {
  return state.io;
}

function botCountInRoom(room) {
  return (room?.users || []).filter((u) => u.isBotUser).length;
}

function maxBotsForRoom(room) {
  const cap = deps && deps.roomCapacity ? deps.roomCapacity(room) : 5;
  return Math.max(1, Math.min(LIMITS.MAX_BOTS_PER_ROOM, Math.floor(cap / 5)));
}

function humanCount(room) {
  return (room?.users || []).filter(
    (u) => !u.isBotUser && !(u.isDev && u.isVanished),
  ).length;
}

function activeBotOfOwner(ownerKey) {
  for (const rt of active.values()) if (rt.ownerKey === ownerKey) return rt;
  return null;
}

function makeFakeSocket(botUserId, name, roomId, location) {
  return {
    id: "bot:" + botUserId,
    roomId,
    connected: true,
    isBotRuntime: true,
    handshake: {
      session: { userId: botUserId, username: name, location: location || "Bot" },
    },
    emit() {},
    join() {},
    leave() {},
  };
}

// ── Template expansion ──────────────────────────────────────────────────────
// Tokens may nest one level, so a memory can be picked by name at runtime:
// {memory:note_{word1}} looks up whatever the first word names.

const TOKEN_RE = /\{((?:[^{}]|\{[^{}]*\})*)\}/g;

function varName(raw) {
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
}

// Reads a memory with an optional |fallback for when nothing is stored:
// {memory:note_pizza|I have no note about that}
function readVar(rt, ctx, per, body) {
  const bar = body.indexOf("|");
  const rawName = bar === -1 ? body : body.slice(0, bar);
  const fallback = bar === -1 ? null : body.slice(bar + 1);
  const n = varName(rawName);
  let v;
  if (per === "user") {
    const row = ctx.userId ? rt.bot.uvars[ctx.userId] : null;
    v = row ? row[n] : undefined;
  } else {
    v = rt.bot.vars[n];
  }
  if (v != null && String(v) !== "") return String(v);
  if (fallback != null) return fallback;
  return v != null ? String(v) : "0";
}

function expand(rt, template, ctx, depth) {
  const d = depth || 0;
  if (d > 2) return String(template);
  return String(template).replace(TOKEN_RE, (whole, body) => {
    const inner = body.includes("{") ? expand(rt, body, ctx, d + 1) : body;
    const out = resolveToken(rt, inner, ctx);
    if (out != null) return out;
    return inner === body ? whole : "{" + inner + "}";
  });
}

function resolveToken(rt, body, ctx) {
  const key = body.trim();
  const low = key.toLowerCase();
  if (low === "user" || low === "name") return ctx.username || "someone";
  if (low === "line" || low === "text") return ctx.line || "";
  if (low === "arg" || low === "words" || low === "everything")
    return ctx.args ? ctx.args.join(" ") : "";
  if (/^arg[1-9]$/.test(low))
    return (ctx.args && ctx.args[Number(low.slice(3)) - 1]) || "";
  if (/^word[1-9]$/.test(low))
    return (ctx.args && ctx.args[Number(low.slice(4)) - 1]) || "";
  if (/^words[2-8]$/.test(low)) {
    const from = Number(low.slice(5)) - 1;
    if (ctx.after != null) {
      const parts = String(ctx.after).split(/\s+/).filter(Boolean);
      return parts.slice(from).join(" ");
    }
    return ctx.args ? ctx.args.slice(from).join(" ") : "";
  }
  if (low.startsWith("memory:")) return readVar(rt, ctx, "bot", key.slice(7));
  if (low.startsWith("mymemory:"))
    return readVar(rt, ctx, "user", key.slice(9));
  if (low.startsWith("var:")) return readVar(rt, ctx, "bot", key.slice(4));
  if (low.startsWith("uvar:")) return readVar(rt, ctx, "user", key.slice(5));
  if (low === "bot") return rt.name;
  if (low === "owner") return rt.ownerName || "the owner";
  if (low === "newline") return "\n";
  if (low === "commands") {
    const p = rt.bot.prefix || "!";
    const seen = [];
    for (const r of rt.bot.rules)
      if (
        r.on.type === "command" &&
        r.who !== "owner" &&
        seen.indexOf(p + r.on.word) === -1
      )
        seen.push(p + r.on.word);
    return seen.join("\n");
  }
  if (low === "ownercommands" || low === "admincommands") {
    const p = rt.bot.prefix || "!";
    const seen = [];
    for (const r of rt.bot.rules)
      if (
        r.on.type === "command" &&
        r.who === "owner" &&
        seen.indexOf(p + r.on.word) === -1
      )
        seen.push(p + r.on.word);
    return seen.join("\n");
  }
  if (low === "prefix") return rt.bot.prefix || "!";
  if (low === "runtime")
    return fmtRuntime(Date.now() - (rt.deployedAt || Date.now()));
  if (low === "room") return rt.roomName || "";
  if (low === "humans") {
    const room = state.rooms.get(rt.roomId);
    return String(room ? humanCount(room) : 0);
  }
  if (low === "time")
    return new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC";
  if (low.startsWith("rand:")) {
    const m = low.slice(5).match(/^(-?\d+)\s*-\s*(-?\d+)$/);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    return null;
  }
  if (low.startsWith("pick:")) {
    const opts = key.slice(5).split("|").map((s) => s.trim()).filter(Boolean);
    if (opts.length) return opts[Math.floor(Math.random() * opts.length)];
    return null;
  }
  return null;
}

function fmtRuntime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (s % 60) + "s";
  return s + "s";
}

function evalConds(rt, conds, ctx) {
  for (const c of conds || []) {
    const a = expand(rt, c.a, ctx).trim();
    const b = expand(rt, c.b, ctx).trim();
    const an = Number(a), bn = Number(b);
    const numeric = a !== "" && b !== "" && Number.isFinite(an) && Number.isFinite(bn);
    let pass;
    switch (c.op) {
      case "is": pass = numeric ? an === bn : a.toLowerCase() === b.toLowerCase(); break;
      case "not": pass = numeric ? an !== bn : a.toLowerCase() !== b.toLowerCase(); break;
      case "gt": pass = numeric && an > bn; break;
      case "lt": pass = numeric && an < bn; break;
      case "has": pass = a.toLowerCase().includes(b.toLowerCase()); break;
      default: pass = false;
    }
    if (!pass) return false;
  }
  return true;
}

// ── Variables ───────────────────────────────────────────────────────────────

// A memory name may itself contain placeholders (note_{word1}); it resolves
// against the message that fired the rule. Empty after resolution = no-op.
function actVarName(rt, act, ctx) {
  const raw = String(act.var || "");
  return varName(raw.includes("{") ? expand(rt, raw, ctx) : raw);
}

function setVar(rt, act, ctx, value) {
  const name = actVarName(rt, act, ctx);
  if (!name) return;
  const v = String(value).slice(0, LIMITS.VAR_VALUE_LENGTH);
  if (act.per === "user") {
    if (!ctx.userId) return;
    const u = rt.bot.uvars;
    if (!u[ctx.userId]) {
      const keys = Object.keys(u);
      if (keys.length >= LIMITS.MAX_USER_VARS) delete u[keys[0]];
      u[ctx.userId] = {};
    }
    const row = u[ctx.userId];
    // Writing an empty value forgets the memory and frees its slot.
    if (v === "") {
      if (row[name] != null) {
        delete row[name];
        rt.varsDirty = true;
      }
      return;
    }
    if (Object.keys(row).length >= 64 && row[name] == null) return;
    row[name] = v;
  } else {
    if (v === "") {
      if (rt.bot.vars[name] != null) {
        delete rt.bot.vars[name];
        rt.varsDirty = true;
      }
      return;
    }
    if (Object.keys(rt.bot.vars).length >= LIMITS.MAX_VARS && rt.bot.vars[name] == null)
      return;
    rt.bot.vars[name] = v;
  }
  rt.varsDirty = true;
}

function getVar(rt, act, ctx) {
  const name = actVarName(rt, act, ctx);
  if (!name) return undefined;
  if (act.per === "user") {
    const row = ctx.userId ? rt.bot.uvars[ctx.userId] : null;
    return row ? row[name] : undefined;
  }
  return rt.bot.vars[name];
}

function applyMath(cur, op, amt) {
  const a = Number.isFinite(cur) ? cur : 0;
  const b = Number.isFinite(amt) ? amt : 0;
  let out;
  if (op === "sub") out = a - b;
  else if (op === "mul") out = a * b;
  else if (op === "div") out = b === 0 ? a : a / b;
  else out = a + b;
  return Math.round(out * 100) / 100;
}

// ── The interpreter ─────────────────────────────────────────────────────────

function unrollActions(acts) {
  if (!acts.some((a) => a.type === "repeat")) return acts;
  const out = [];
  for (const a of acts) {
    if (a.type === "repeat") {
      const base = out.slice();
      for (let k = 1; k < a.times; k++)
        for (const b of base) {
          if (out.length >= 25) break;
          out.push(b);
        }
    } else if (out.length < 25) out.push(a);
  }
  return out;
}

function fireRule(rt, rule, ctx, ri) {
  if (rt.queue.length >= LIMITS.MAX_QUEUE) {
    rt.dropped++;
    return;
  }
  rt.queue.push({
    conds: rule.if,
    acts: unrollActions(rule.do),
    ctx,
    i: 0,
    checked: false,
    ri: typeof ri === "number" ? ri : rt.bot.rules.indexOf(rule),
  });
}

function takeToken(rt) {
  const now = Date.now();
  const refill = ((now - rt.bucketAt) / 60000) * LIMITS.ACTION_TOKENS;
  rt.tokens = Math.min(LIMITS.ACTION_TOKENS, rt.tokens + refill);
  rt.bucketAt = now;
  if (rt.tokens < 1) return false;
  rt.tokens -= 1;
  return true;
}

function commandIndex(lowerLine, word, prefix) {
  const token = (prefix || "!") + word;
  let i = lowerLine.indexOf(token);
  while (i !== -1) {
    const okBefore = i === 0 || /\s/.test(lowerLine[i - 1]);
    const afterCh = lowerLine[i + token.length];
    const okAfter = afterCh === undefined || /\s/.test(afterCh);
    if (okBefore && okAfter) return i;
    i = lowerLine.indexOf(token, i + 1);
  }
  return -1;
}

// Admin-only rules fire for the person who deployed the bot and for the
// bot's managers. The deployer is matched by session userId, managers by the
// device behind the speaker's live socket - never by name, so nobody can
// trigger them by renaming.
function allowedBy(rt, rule, userId) {
  if (rule.who !== "owner") return true;
  if (!userId) return false;
  if (userId === rt.ownerId) return true;
  const managers = rt.bot.managers;
  if (!managers || !managers.length || !io()) return false;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || s.handshake?.session?.userId !== userId) continue;
    if (s.deviceId && managers.some((m) => m.did === s.deviceId)) return true;
  }
  return false;
}

// Runs when the bot lands in a room. "arrive" rules take over completely;
// without one the bot introduces itself and lists its public commands. An
// arrive rule with only a wait block keeps the bot silent on arrival.
function greetOnArrival(rt) {
  const ctx = { userId: null, username: "", line: "", args: [] };
  let fired = false;
  for (let ri = 0; ri < rt.bot.rules.length; ri++)
    if (rt.bot.rules[ri].on.type === "arrive") {
      fireRule(rt, rt.bot.rules[ri], ctx, ri);
      fired = true;
    }
  if (fired) return;
  const p = rt.bot.prefix || "!";
  const words = [];
  for (const r of rt.bot.rules)
    if (
      r.on.type === "command" &&
      r.who !== "owner" &&
      words.indexOf(p + r.on.word) === -1
    )
      words.push(p + r.on.word);
  const list = words.slice(0, 6).join("  ");
  const text = list ? "🤖 Hi! I'm {bot}. Try: " + list : "🤖 Hi! I'm {bot}.";
  rt.queue.push({
    conds: [],
    acts: [{ type: "say", text }],
    ctx,
    i: 0,
    checked: false,
    ri: -1,
  });
}

function onUtterance(rt, userId, username, line, fullText) {
  const lower = line.toLowerCase();
  const prefix = rt.bot.prefix || "!";
  for (let ri = 0; ri < rt.bot.rules.length; ri++) {
    const rule = rt.bot.rules[ri];
    if (!allowedBy(rt, rule, userId)) continue;
    const on = rule.on;
    const ctx = { userId, username, line, args: [] };
    if (on.type === "command") {
      const at = commandIndex(lower, on.word, prefix);
      if (at === -1) continue;
      const after = line.slice(at + prefix.length + on.word.length).trim();
      ctx.after = after;
      ctx.args = after ? after.split(/\s+/).slice(0, 8) : [];
    } else if (on.type === "says") {
      if (!lower.includes(on.text.toLowerCase())) continue;
    } else if (on.type === "mention") {
      if (!lower.includes(rt.name.toLowerCase())) continue;
    } else continue;
    fireRule(rt, rule, ctx, ri);
  }
}

function polishSay(rt, act, ctx) {
  let text = expand(rt, act.text, ctx);
  text = sanitizeMessage(text).slice(0, LIMITS.MAX_SAY_LENGTH);
  if (ipredact.looksLikeIp(text)) text = ipredact.redact(text);
  return text;
}

function runAction(rt, act, ctx) {
  switch (act.type) {
    case "say": {
      const sinceLast = Date.now() - rt.lastSayAt;
      if (sinceLast < LIMITS.SAY_MIN_GAP_MS) {
        rt.waitUntil = Date.now() + (LIMITS.SAY_MIN_GAP_MS - sinceLast);
        return false;
      }
      const text = polishSay(rt, act, ctx);
      if (!text.trim()) return true;
      rt.lastSayAt = Date.now();
      rt.typing = { text, at: 0 };
      deps.emitTyping(rt.fake, rt.userId, rt.name, true);
      return true;
    }
    case "append": {
      const sinceLast = Date.now() - rt.lastSayAt;
      if (sinceLast < LIMITS.SAY_MIN_GAP_MS) {
        rt.waitUntil = Date.now() + (LIMITS.SAY_MIN_GAP_MS - sinceLast);
        return false;
      }
      const text = polishSay(rt, act, ctx);
      if (!text.trim()) return true;
      const cur = state.userMessageBuffers.get(rt.userId) || "";
      let combined = cur ? cur + "\n" + text : text;
      while (combined.length > CONFIG.LIMITS.MAX_MESSAGE_LENGTH) {
        const nl = combined.indexOf("\n");
        if (nl === -1) {
          combined = combined.slice(-CONFIG.LIMITS.MAX_MESSAGE_LENGTH);
          break;
        }
        combined = combined.slice(nl + 1);
      }
      rt.lastSayAt = Date.now();
      rt.typing = { text: combined, at: Math.min(cur.length, combined.length) };
      deps.emitTyping(rt.fake, rt.userId, rt.name, true);
      return true;
    }
    case "wait":
      rt.waitUntil = Date.now() + act.seconds * 1000;
      return true;
    case "set":
      setVar(rt, act, ctx, expand(rt, act.value, ctx));
      return true;
    case "add": {
      const cur = Number(getVar(rt, act, ctx));
      const amt = Number(expand(rt, act.amount, ctx));
      setVar(rt, act, ctx, applyMath(cur, act.op, amt));
      return true;
    }
    case "random": {
      const from = expand(rt, act.from, ctx).trim();
      const range = from.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
      let value;
      if (range) {
        const a = Number(range[1]), b = Number(range[2]);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        value = lo + Math.floor(Math.random() * (hi - lo + 1));
      } else {
        const opts = from.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
        value = opts.length ? opts[Math.floor(Math.random() * opts.length)] : "";
      }
      setVar(rt, act, ctx, value);
      return true;
    }
    case "clear":
      setBotText(rt, "");
      return true;
    case "leave":
      retire(rt, "left by its own rule");
      return true;
    default:
      return true;
  }
}

function setBotText(rt, text) {
  state.userMessageBuffers.set(rt.userId, text);
  deps.emitChat(rt.fake, {
    userId: rt.userId,
    username: rt.name,
    diff: { type: "full-replace", text },
  });
}

function tickTyping(rt) {
  const t = rt.typing;
  if (!t) return;
  t.at = Math.min(t.text.length, t.at + LIMITS.TYPE_CHARS_PER_TICK);
  setBotText(rt, t.text.slice(0, t.at));
  if (t.at >= t.text.length) {
    rt.typing = null;
    deps.emitTyping(rt.fake, rt.userId, rt.name, false);
  }
}

// ── Deploy / retire ─────────────────────────────────────────────────────────

function deploy(socket, bot, room, ownerKey) {
  const botUserId = "bot_" + crypto.randomBytes(6).toString("hex");
  const ownerId = socket.handshake.session.userId;
  const ownerName = socket.handshake.session.username || "someone";

  const entry = {
    id: botUserId,
    username: bot.name,
    location: bot.location || "Bot",
    isBotUser: true,
    botOwnerId: ownerId,
    botOwnerName: ownerName,
    deviceType: "bot",
    deviceId: null,
    avatar: null,
  };
  room.users.push(entry);
  room.lastActiveTime = Date.now();

  const rt = {
    userId: botUserId,
    name: bot.name,
    bot,
    ownerKey,
    ownerId,
    ownerName,
    roomId: room.id,
    roomName: room.name,
    fake: makeFakeSocket(botUserId, bot.name, room.id, bot.location),
    queue: [],
    typing: null,
    waitUntil: 0,
    lastSayAt: 0,
    tokens: LIMITS.ACTION_TOKENS,
    bucketAt: Date.now(),
    dropped: 0,
    deployedAt: Date.now(),
    timers: bot.rules
      .map((r, i) => (r.on.type === "timer" ? { i, nextAt: Date.now() + r.on.minutes * 60000 } : null))
      .filter(Boolean),
    varsDirty: false,
  };
  active.set(botUserId, rt);
  ownerSeen.set(ownerId, Date.now());

  state.userMessageBuffers.set(botUserId, "");
  deps.userJoined(room, entry);
  deps.updateRoom(room.id);
  deps.updateLobby();
  greetOnArrival(rt);
  startTick();
  return rt;
}

function stampStop(rt, why) {
  const rec = store.owners[rt.ownerKey];
  const cfg = rec?.bots.find((b) => b.id === rt.bot.id);
  if (!cfg) return;
  cfg.lastStop = { why: String(why || "stopped").slice(0, 80), at: Date.now() };
  saveSoon();
}

function retire(rt, why) {
  if (!active.has(rt.userId)) return;
  active.delete(rt.userId);
  const room = state.rooms.get(rt.roomId);
  if (room) {
    const entry = (room.users || []).find((u) => u.id === rt.userId);
    if (entry) {
      room.users = room.users.filter((u) => u.id !== rt.userId);
      if (room.votes) {
        delete room.votes[rt.userId];
        for (const vid in room.votes)
          if (room.votes[vid] === rt.userId) delete room.votes[vid];
      }
      deps.userLeft(rt.roomId, rt.userId, entry);
      deps.updateRoom(rt.roomId);
      deps.updateLobby();
      if (room.users.length === 0) deps.startRoomDeletionTimer(rt.roomId);
    }
  }
  state.userMessageBuffers.delete(rt.userId);
  if (rt.varsDirty) saveSoon();
  stampStop(rt, why);
  notifyOwner(rt, "bot stopped", { botId: rt.bot.id, why: why || "stopped" });
}

function notifyOwner(rt, event, payload) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected) continue;
    if (s.handshake?.session?.userId !== rt.ownerId) continue;
    s.emit(event, payload);
  }
}

// ── The tick ────────────────────────────────────────────────────────────────

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, TICK_MS);
}

function stopTickIfIdle() {
  if (tickTimer && active.size === 0) {
    clearInterval(tickTimer);
    tickTimer = null;
    roomText.clear();
  }
}

function tick() {
  tickCount++;
  const now = Date.now();

  for (const [roomId, users] of roomText) {
    let anyBotHere = false;
    for (const rt of active.values()) if (rt.roomId === roomId) { anyBotHere = true; break; }
    if (!anyBotHere) {
      roomText.delete(roomId);
      continue;
    }
    for (const [userId, rec] of users) {
      if (!rec.lineDirty && rec.text === rec.doneText) continue;
      if (now - rec.changedAt < LIMITS.UTTERANCE_IDLE_MS) continue;
      rec.doneText = rec.text;
      const fire = rec.lineDirty;
      rec.lineDirty = false;
      if (!fire) continue;
      const line = lastLine(rec.text);
      if (!line) continue;
      for (const rt of active.values())
        if (rt.roomId === roomId) onUtterance(rt, userId, rec.username, line, rec.text);
    }
  }

  for (const rt of active.values()) {
    for (const t of rt.timers) {
      if (now < t.nextAt) continue;
      const rule = rt.bot.rules[t.i];
      t.nextAt = now + rule.on.minutes * 60000;
      fireRule(rt, rule, { userId: null, username: "", line: "", args: [] });
    }

    if (rt.typing) {
      tickTyping(rt);
      continue;
    }
    if (rt.waitUntil > now) continue;

    const group = rt.queue[0];
    if (!group) continue;
    if (!group.checked) {
      group.checked = true;
      if (!evalConds(rt, group.conds, group.ctx)) {
        rt.queue.shift();
        continue;
      }
      if (!takeToken(rt)) {
        rt.dropped++;
        rt.queue.shift();
        continue;
      }
    }
    const act = group.acts[group.i];
    if (!act) {
      rt.queue.shift();
      continue;
    }
    if (runAction(rt, act, group.ctx)) group.i++;
  }

  if (tickCount % SWEEP_EVERY_TICKS === 0) sweep();
}

function lastLine(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.slice(0, 200);
  }
  return "";
}

function lastLineKey(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return i + ":" + l.slice(0, 200);
  }
  return "";
}

function sweep() {
  const now = Date.now();

  if (io()) {
    for (const [, s] of io().sockets.sockets) {
      const uid = s.connected && s.handshake?.session?.userId;
      if (uid && ownerSeen.has(uid)) ownerSeen.set(uid, now);
    }
  }

  for (const rt of [...active.values()]) {
    if (!store.enabled) {
      retire(rt, "bots are turned off right now");
      continue;
    }
    const room = state.rooms.get(rt.roomId);
    if (!room || !(room.users || []).some((u) => u.id === rt.userId)) {
      active.delete(rt.userId);
      state.userMessageBuffers.delete(rt.userId);
      if (rt.varsDirty) saveSoon();
      stampStop(rt, "removed from the room");
      notifyOwner(rt, "bot stopped", { botId: rt.bot.id, why: "removed from the room" });
      continue;
    }
    if (humanCount(room) === 0) {
      retire(rt, "the room emptied");
      continue;
    }
    const seen = ownerSeen.get(rt.ownerId) || 0;
    if (now - seen > LIMITS.OWNER_GRACE_MS) {
      retire(rt, "its owner left the site");
      continue;
    }
    if (rt.varsDirty) {
      rt.varsDirty = false;
      saveSoon();
    }
  }

  for (const [uid, at] of ownerSeen)
    if (now - at > LIMITS.OWNER_GRACE_MS * 5) ownerSeen.delete(uid);

  stopTickIfIdle();
}

// ── Hooks called by rooms.js ────────────────────────────────────────────────

function onText(roomId, userId, username, text) {
  if (!active.size || !roomId) return;
  let hasBot = false;
  for (const rt of active.values()) if (rt.roomId === roomId) { hasBot = true; break; }
  if (!hasBot) return;
  if (userId.startsWith("bot_")) return;
  let users = roomText.get(roomId);
  if (!users) {
    users = new Map();
    roomText.set(roomId, users);
  }
  const rec = users.get(userId);
  if (rec && rec.text === text) return;
  users.set(userId, {
    text,
    username,
    changedAt: Date.now(),
    doneText: rec ? rec.doneText : "",
    lineDirty:
      (rec ? rec.lineDirty : false) ||
      lastLineKey(text) !== lastLineKey(rec ? rec.text : ""),
  });
}

function onJoin(roomId, user) {
  if (!active.size || !user || user.isBotUser) return;
  const ctx = { userId: user.id, username: user.username, line: "", args: [] };
  for (const rt of active.values()) {
    if (rt.roomId !== roomId) continue;
    for (const rule of rt.bot.rules)
      if (rule.on.type === "join" && allowedBy(rt, rule, user.id))
        fireRule(rt, rule, ctx);
  }
}

function onLeave(roomId, userId, user) {
  if (!active.size || (user && user.isBotUser)) return;
  const users = roomText.get(roomId);
  if (users) users.delete(userId);
  const ctx = { userId, username: user?.username || "someone", line: "", args: [] };
  for (const rt of active.values()) {
    if (rt.roomId !== roomId) continue;
    for (const rule of rt.bot.rules)
      if (rule.on.type === "leave" && allowedBy(rt, rule, userId))
        fireRule(rt, rule, ctx);
  }
}

function noteEvicted(botUserId) {
  const rt = active.get(botUserId);
  if (!rt) return;
  const room = state.rooms.get(rt.roomId);
  if (room?.bannedUserIds?.has(botUserId)) room.bannedUserIds.add(rt.bot.id);
  active.delete(botUserId);
  state.userMessageBuffers.delete(botUserId);
  if (rt.varsDirty) saveSoon();
  stampStop(rt, "removed from the room");
  notifyOwner(rt, "bot stopped", { botId: rt.bot.id, why: "removed from the room" });
}

function isActiveBot(userId) {
  return active.has(userId);
}

// ── Socket surface ──────────────────────────────────────────────────────────

function ownerStatus(ownerKey) {
  const rec = ownerRecord(ownerKey, false);
  const rt = activeBotOfActor(ownerKey);
  return {
    enabled: store.enabled,
    limits: {
      maxSaved: LIMITS.MAX_SAVED,
      maxPerRoom: LIMITS.MAX_BOTS_PER_ROOM,
      maxRules: LIMITS.MAX_RULES,
      maxActions: LIMITS.MAX_ACTIONS_PER_RULE,
      maxConditions: LIMITS.MAX_CONDITIONS_PER_RULE,
      sayLength: LIMITS.MAX_SAY_LENGTH,
      timerMinMinutes: LIMITS.TIMER_MIN_MINUTES,
      maxManagers: LIMITS.MAX_MANAGERS,
    },
    bots: (rec?.bots || []).map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location || "Bot",
      prefix: b.prefix || "!",
      rules: b.rules,
      updatedAt: b.updatedAt,
      vars: b.vars || {},
      lastStop: b.lastStop || null,
      managers: managerView(b),
      inviteCode: b.inviteCode?.code || null,
      createdBy: b.createdBy || null,
      editedBy: b.editedBy || null,
      history: b.history || [],
      versions: (b.versions || []).map((x) => ({
        at: x.at,
        by: x.by,
        name: x.name,
        rules: (x.rules || []).length,
      })),
    })),
    shared: sharedBotsFor(ownerKey).map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location || "Bot",
      prefix: b.prefix || "!",
      rules: b.rules,
      updatedAt: b.updatedAt,
      vars: b.vars || {},
      lastStop: b.lastStop || null,
      sharedBy: b.sharedBy || "the owner",
      createdBy: b.createdBy || null,
      editedBy: b.editedBy || null,
      history: b.history || [],
      managers: (b.managers || []).map((m) => ({
        name: m.name || "someone",
        addedAt: m.addedAt || 0,
      })),
      versions: (b.versions || []).map((x) => ({
        at: x.at,
        by: x.by,
        name: x.name,
        rules: (x.rules || []).length,
      })),
    })),
    deployed: rt
      ? {
          botId: rt.bot.id,
          botUserId: rt.userId,
          roomId: rt.roomId,
          roomName: rt.roomName,
          since: rt.deployedAt,
          dropped: rt.dropped,
          vars: rt.bot.vars || {},
        }
      : null,
  };
}

function requireSignin(socket) {
  const s = socket.handshake?.session;
  if (s?.userId && s?.username) return true;
  socket.emit(
    "error",
    createErrorResponse(
      ERROR_CODES.UNAUTHORIZED,
      "Sign in at the lobby first, then come back to the Bot Creator.",
    ),
  );
  return false;
}

function fail(socket, message, code) {
  socket.emit("bots error", { message, code: code || null });
}

function register(socket, safe) {
  socket.on(
    "bots status",
    safe(async () => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      if (!ownerKey) return;
      ownerSeen.set(socket.handshake.session.userId, Date.now());
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots save",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      if (!ownerKey) return;
      const found = data?.id ? findBotFor(ownerKey, data.id) : null;
      const rec = found ? found.rec : ownerRecord(ownerKey, true);
      const existing = found ? found.bot : null;
      if (!existing && rec.bots.length >= LIMITS.MAX_SAVED)
        return fail(socket, `You can keep ${LIMITS.MAX_SAVED} bots. Delete one first.`);
      const v = validateConfig(data?.bot, existing?.id);
      if (!v.ok) return fail(socket, v.error);
      const who = actorName(socket);
      if (existing) {
        // Refuse to silently overwrite an edit somebody else saved while
        // this copy was open. The client re-opens the bot to catch up.
        const base = Number(data?.baseUpdatedAt);
        if (
          Number.isFinite(base) &&
          existing.updatedAt &&
          existing.updatedAt > base
        )
          return fail(
            socket,
            "Someone saved this bot after you opened it. Go back to your bot list and open it again to see their version.",
            "stale_save",
          );
        v.bot.createdAt = existing.createdAt;
        v.bot.vars = existing.vars || {};
        v.bot.uvars = existing.uvars || {};
        snapshotVersion(existing);
        for (const k of CARRY) if (existing[k] != null) v.bot[k] = existing[k];
        v.bot.editedBy = {
          name: who,
          role: found && found.role === "admin" ? "manager" : "owner",
          at: Date.now(),
        };
        logHistory(v.bot, {
          by: who,
          role: v.bot.editedBy.role,
          action: "edited the bot",
          rules: v.bot.rules.length,
        });
        rec.bots[rec.bots.indexOf(existing)] = v.bot;
      } else {
        v.bot.createdBy = who;
        v.bot.editedBy = { name: who, role: "owner", at: Date.now() };
        logHistory(v.bot, { by: who, role: "owner", action: "made the bot" });
        rec.bots.push(v.bot);
      }
      saveSoon();
      socket.emit("bots saved", { id: v.bot.id, updatedAt: v.bot.updatedAt });
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots delete",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      if (!data?.id) return;
      const bot = rec?.bots.find((b) => b.id === data.id);
      if (!bot) {
        if (findBotFor(ownerKey, data.id))
          fail(socket, "Only the owner can delete this bot.");
        return;
      }
      const rt = activeBotOfOwner(ownerKey);
      if (rt && rt.bot.id === bot.id) retire(rt, "deleted");
      rec.bots = rec.bots.filter((b) => b.id !== bot.id);
      saveSoon();
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots deploy",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const found = findBotFor(ownerKey, data?.id);
      const bot = found?.bot;
      if (!bot) return fail(socket, "Save the bot first.", "save_first");
      const homeKey = found.ownerKey;

      if (!store.enabled)
        return fail(socket, "Bots are turned off by staff right now.", "bots_off");
      if (state.maintenance)
        return fail(socket, "Talkomatic is in maintenance mode. Try again shortly.", "maintenance");
      if (active.size >= LIMITS.MAX_ACTIVE_TOTAL)
        return fail(socket, "Too many bots are running right now. Try again in a while.", "busy");
      const already = activeBotOfActor(ownerKey) || activeBotOfOwner(homeKey);
      if (already)
        return fail(
          socket,
          `You already have "${already.name}" running. Stop it first.`,
          "already_running",
        );

      let room = null;
      if (data?.roomId) {
        room = state.rooms.get(String(data.roomId));
        if (!room) return fail(socket, "That room is gone.", "room_gone");
        if (room.type !== "public")
          return fail(socket, "Bots can only join public rooms.", "room_private");
        if (room.allowBots === false)
          return fail(socket, "That room does not allow bots.", "room_no_bots");
        if (room.locked)
          return fail(socket, "That room is locked.", "room_locked");
        if (room.bannedUserIds?.has?.(bot.id))
          return fail(socket, "This bot was removed from that room.", "room_banned");
        if (humanCount(room) === 0)
          return fail(
            socket,
            "That room is empty. Bots need someone to talk to.",
            "room_empty",
          );
        const maxBots = maxBotsForRoom(room);
        if (botCountInRoom(room) >= maxBots)
          return fail(
            socket,
            `That room is at its bot limit (${maxBots} for its size).`,
            "room_bots_full",
          );
        const seats = (room.users || []).filter(
          (u) => !(u.isDev && u.isVanished),
        ).length;
        if (seats >= deps.roomCapacity(room))
          return fail(socket, "That room is full.", "room_full");
      } else if (data?.newRoom) {
        if (!CONFIG.FEATURES.ENABLE_ROOM_CREATION)
          return fail(socket, "Room creation is turned off right now.", "no_new_rooms");
        const name = enforceRoomNameLimit(sanitizeName(String(data.newRoom.name || "")));
        if (!name || name.length < 3)
          return fail(socket, "Give the new room a name (3+ characters).", "name_room");
        if (wordFilter.checkText(name).hasOffensiveWord)
          return fail(socket, "That room name is not allowed.", "bad_room_name");
        if (deps.roomNameExists(name))
          return fail(socket, "A room with that name already exists.", "room_exists");
        if (state.rooms.size >= deps.calculateCurrentRoomLimit())
          return fail(socket, "The room limit has been reached. Try an existing room.", "room_limit");
        const ip = socket.clientIp || "";
        const last = state.lastRoomCreationTimes.get(ip) || 0;
        if (Date.now() - last < CONFIG.TIMING.ROOM_CREATION_COOLDOWN)
          return fail(socket, "You are creating rooms too fast. Give it a few seconds.", "too_fast");
        let roomId, attempts = 0;
        do {
          roomId = Math.floor(100000 + Math.random() * 900000).toString();
        } while (state.rooms.has(roomId) && ++attempts < 100);
        if (state.rooms.has(roomId))
          return fail(socket, "Could not create the room.", "create_fail");
        state.lastRoomCreationTimes.set(ip, Date.now());
        room = {
          id: roomId,
          name,
          type: "public",
          layout: "vertical",
          maxSize: deps.newRoomCapacity(5, socket),
          allowBots: true,
          users: [],
          accessCode: null,
          votes: {},
          bannedUserIds: new Set(),
          lastActiveTime: Date.now(),
          createdAt: Date.now(),
        };
        state.rooms.set(roomId, room);
        state.apiCache.delete("public_rooms");
        deps.startRoomDeletionTimer(roomId);
      } else {
        return fail(socket, "Pick a room, or name a new one.", "pick_room");
      }

      if (data?.newRoom) {
        pendingNewRoom.set(socket.handshake.session.userId, {
          botId: bot.id,
          ownerKey: homeKey,
          roomId: room.id,
          at: Date.now(),
        });
        deps.updateLobby();
        socket.emit("bots deployed", {
          botId: bot.id,
          roomId: room.id,
          roomName: room.name,
          pending: true,
        });
        return;
      }

      const rt = deploy(socket, bot, room, homeKey);
      socket.emit("bots deployed", {
        botId: bot.id,
        roomId: room.id,
        roomName: room.name,
        botUserId: rt.userId,
      });
    }),
  );

  socket.on(
    "bots stop",
    safe(async () => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      pendingNewRoom.delete(socket.handshake.session.userId);
      const rt = activeBotOfActor(ownerKey);
      if (rt) retire(rt, "stopped by you");
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  // ── Managers: invite codes, promotion, demotion, transfer ────────────────

  socket.on(
    "bots invite create",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      const bot = rec?.bots.find((b) => b.id === data?.id);
      if (!bot) return;
      bot.inviteCode = {
        code: "BOT-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
        at: Date.now(),
      };
      bot.sharedBy = actorName(socket);
      logHistory(bot, {
        by: bot.sharedBy,
        role: "owner",
        action: "made a share code",
      });
      saveSoon();
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots invite revoke",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      const bot = rec?.bots.find((b) => b.id === data?.id);
      if (!bot) return;
      bot.inviteCode = null;
      logHistory(bot, {
        by: actorName(socket),
        role: "owner",
        action: "revoked the share code",
      });
      saveSoon();
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots invite redeem",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const actorKey = ownerKeyOf(socket);
      if (!actorKey) return;
      if (Date.now() - (socket._botCodeTick || 0) < 2000)
        return fail(socket, "Give it a second between attempts.");
      socket._botCodeTick = Date.now();
      const code = String(data?.code || "").trim().toUpperCase();
      if (!code) return fail(socket, "Enter a bot code.");
      for (const [key, rec] of Object.entries(store.owners)) {
        for (const bot of rec.bots) {
          if (bot.inviteCode?.code !== code) continue;
          if (key === actorKey)
            return fail(socket, "That is your own bot.");
          if (isManager(bot, actorKey))
            return fail(socket, "You already manage this bot.");
          if ((bot.managers || []).length >= LIMITS.MAX_MANAGERS)
            return fail(socket, "This bot already has its limit of managers.");
          if (!bot.managers) bot.managers = [];
          const joiner = actorName(socket);
          bot.managers.push({
            did: actorKey,
            name: joiner,
            addedAt: Date.now(),
          });
          logHistory(bot, {
            by: joiner,
            role: "manager",
            action: "joined as a manager",
          });
          saveSoon();
          socket.emit("bots redeemed", {
            id: bot.id,
            name: bot.name,
            sharedBy: bot.sharedBy || null,
          });
          socket.emit("bots status", ownerStatus(actorKey));
          return;
        }
      }
      fail(socket, "That code does not match any bot.");
    }),
  );

  socket.on(
    "bots manager remove",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const found = findBotFor(ownerKey, data?.id);
      if (!found || !data?.ref) return;
      const { bot } = found;
      const self = mgrRef(ownerKey) === data.ref;
      const canRemove = found.role === "owner" || self;
      if (!canRemove) return;
      const removed = (bot.managers || []).find(
        (m) => mgrRef(m.did) === data.ref,
      );
      if (!removed) return;
      bot.managers = (bot.managers || []).filter(
        (m) => mgrRef(m.did) !== data.ref,
      );
      logHistory(
        bot,
        self && found.role !== "owner"
          ? { by: removed.name, role: "manager", action: "left" }
          : {
              by: actorName(socket),
              role: "owner",
              action: "removed " + (removed.name || "a manager"),
            },
      );
      saveSoon();
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots transfer",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      const bot = rec?.bots.find((b) => b.id === data?.id);
      if (!bot) return;
      const target = (bot.managers || []).find(
        (m) => mgrRef(m.did) === data?.ref,
      );
      if (!target) return fail(socket, "Pick a manager to hand the bot to.");
      for (const rt of active.values())
        if (rt.bot.id === bot.id && rt.ownerKey === ownerKey)
          return fail(socket, "Stop the bot before transferring it.");
      const targetRec = ownerRecord(target.did, true);
      if (targetRec.bots.length >= LIMITS.MAX_SAVED)
        return fail(socket, "They already keep the maximum number of bots.");
      rec.bots = rec.bots.filter((b) => b !== bot);
      targetRec.bots.push(bot);
      const oldOwner = actorName(socket);
      bot.managers = (bot.managers || []).filter((m) => m.did !== target.did);
      bot.managers.push({
        did: ownerKey,
        name: oldOwner,
        addedAt: Date.now(),
      });
      bot.sharedBy = target.name || "the owner";
      logHistory(bot, {
        by: oldOwner,
        role: "owner",
        action: "handed the bot to " + (target.name || "a manager"),
      });
      saveSoon();
      socket.emit("bots transferred", { id: bot.id, to: target.name });
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  // ── Restore: the owner rolls the bot back to a kept version ──────────────
  socket.on(
    "bots restore",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      const bot = rec?.bots.find((b) => b.id === data?.id);
      if (!bot) {
        if (findBotFor(ownerKey, data?.id))
          fail(socket, "Only the owner can restore an earlier version.");
        return;
      }
      const ver = (bot.versions || []).find((x) => x.at === Number(data?.at));
      if (!ver || !Array.isArray(ver.rules) || !ver.rules.length)
        return fail(socket, "That version is no longer kept.");
      const who = actorName(socket);
      snapshotVersion(bot);
      bot.name = ver.name;
      bot.location = ver.location;
      bot.prefix = ver.prefix || "!";
      bot.rules = ver.rules;
      bot.updatedAt = Date.now();
      bot.editedBy = { name: who, role: "owner", at: Date.now() };
      logHistory(bot, {
        by: who,
        role: "owner",
        action: "restored the version by " + (ver.by || "someone"),
        versionAt: ver.at,
      });
      saveSoon();
      socket.emit("bots restored", { id: bot.id, updatedAt: bot.updatedAt });
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  // ── The test room: run the current rules without deploying anything ──────

  socket.on(
    "bots test start",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const v = validateConfig(data?.bot, "test");
      if (!v.ok) return socket.emit("bots test error", { message: v.error });
      const old = testSessions.get(socket.id);
      if (old && data?.keepMemory) {
        v.bot.vars = old.bot.vars;
        v.bot.uvars = old.bot.uvars;
      }
      const rt = makeSandbox(v.bot, socket.handshake.session.username);
      testSessions.set(socket.id, rt);
      socket.emit("bots test ready", { name: v.bot.name });
    }),
  );

  socket.on(
    "bots test say",
    safe(async (data) => {
      const rt = testSessions.get(socket.id);
      if (!rt) return;
      const line = lastLine(sanitizeMessage(String(data?.text || "")));
      if (!line) return;
      onUtterance(rt, "tester", rt.tester, line, line);
      testReply(socket, { about: "say", line, ...drainTest(rt) });
    }),
  );

  socket.on(
    "bots test event",
    safe(async (data) => {
      const rt = testSessions.get(socket.id);
      if (!rt) return;
      const kind = data?.kind;
      const ctx = { userId: "friend", username: "Testy", line: "", args: [] };
      if (kind === "join" || kind === "leave") {
        for (let ri = 0; ri < rt.bot.rules.length; ri++)
          if (
            rt.bot.rules[ri].on.type === kind &&
            allowedBy(rt, rt.bot.rules[ri], ctx.userId)
          )
            fireRule(rt, rt.bot.rules[ri], ctx, ri);
      } else if (kind === "timer") {
        for (let ri = 0; ri < rt.bot.rules.length; ri++)
          if (rt.bot.rules[ri].on.type === "timer")
            fireRule(
              rt,
              rt.bot.rules[ri],
              { userId: null, username: "", line: "", args: [] },
              ri,
            );
      } else if (kind === "arrive") {
        greetOnArrival(rt);
      } else return;
      testReply(socket, { about: kind, ...drainTest(rt) });
    }),
  );

  socket.on(
    "bots test reset",
    safe(async () => {
      const rt = testSessions.get(socket.id);
      if (!rt) return;
      rt.bot.vars = {};
      rt.bot.uvars = {};
      rt.queue.length = 0;
      socket.emit("bots test out", {
        about: "reset",
        fired: [], skipped: [], says: [],
        memories: {}, myMemories: {}, friendMemories: {},
      });
    }),
  );

  socket.on("disconnect", () => testSessions.delete(socket.id));

  // ── Staff: see every bot, kill any bot, master switch ─────────────────────

  socket.on(
    "staff bots list",
    safe(async () => {
      if (!socket.isDev && !socket.isMod) return;
      const hosted = [...active.values()].map((rt) => ({
        tier: 1,
        botUserId: rt.userId,
        name: rt.name,
        roomId: rt.roomId,
        roomName: state.rooms.get(rt.roomId)?.name || rt.roomName,
        owner: rt.ownerName,
        ownerId: rt.ownerId,
        since: rt.deployedAt,
        dropped: rt.dropped,
      }));
      const external = [];
      if (io()) {
        for (const [, s] of io().sockets.sockets) {
          if (!s.connected || !s.isBot) continue;
          const sess = s.handshake?.session || {};
          external.push({
            tier: 2,
            botUserId: sess.userId || null,
            name: sess.username || "(not signed in)",
            roomId: s.roomId || null,
            roomName: s.roomId ? state.rooms.get(s.roomId)?.name || null : null,
            since: null,
          });
        }
      }
      socket.emit("staff bots list", {
        enabled: store.enabled,
        bots: [...hosted, ...external],
      });
    }),
  );

  socket.on(
    "staff bots kill",
    safe(async (data) => {
      if (!socket.isDev && !socket.isMod) return;
      const id = data?.botUserId;
      if (!id) return;
      const rt = active.get(id);
      if (rt) {
        retire(rt, "stopped by staff");
        deps.logStaff(socket, "kill bot", { id, username: rt.name }, rt.roomId || "-");
      } else if (io()) {
        for (const [, s] of io().sockets.sockets) {
          if (s.isBot && s.handshake?.session?.userId === id) {
            deps.logStaff(
              socket,
              "kill bot",
              { id, username: s.handshake?.session?.username || "api bot" },
              s.roomId || "-",
            );
            s.disconnect(true);
          }
        }
      }
      socket.emit("staff action result", { action: "kill bot", ok: true });
    }),
  );

  socket.on(
    "staff bots toggle",
    safe(async (data) => {
      if (!socket.isDev) return;
      store.enabled = data?.enabled !== false;
      saveSoon();
      if (!store.enabled) for (const rt of [...active.values()]) retire(rt, "bots turned off");
      deps.logStaff(socket, store.enabled ? "bots on" : "bots off", null, "-");
      socket.emit("staff bots list", { enabled: store.enabled, bots: [] });
    }),
  );
}

// ── The test room ───────────────────────────────────────────────────────────

const testSessions = new Map();

function makeSandbox(bot, username) {
  return {
    userId: "test",
    name: bot.name,
    bot,
    roomId: null,
    roomName: "the test room",
    queue: [],
    dropped: 0,
    deployedAt: Date.now(),
    tester: username || "You",
    // In the test room you are the owner, so owner-only rules fire for you
    // (utterances arrive as "tester") and not for Testy ("friend").
    ownerId: "tester",
    ownerName: username || "You",
  };
}

function drainTest(rt) {
  const out = { fired: [], skipped: [], says: [], left: false };
  let delay = 0;
  let guard = 0;
  while (rt.queue.length && guard++ < 80) {
    const group = rt.queue.shift();
    if (!evalConds(rt, group.conds, group.ctx)) {
      out.skipped.push(group.ri);
      continue;
    }
    out.fired.push(group.ri);
    for (const act of group.acts) {
      if (out.says.length >= 20) break;
      switch (act.type) {
        case "say": {
          const text = polishSay(rt, act, group.ctx);
          if (!text.trim()) break;
          delay += LIMITS.SAY_MIN_GAP_MS / 2;
          out.says.push({ text, delayMs: delay });
          delay += Math.min(4000, text.length * 30);
          break;
        }
        case "append": {
          const text = polishSay(rt, act, group.ctx);
          if (!text.trim()) break;
          delay += LIMITS.SAY_MIN_GAP_MS / 2;
          out.says.push({ text, delayMs: delay, append: true });
          delay += Math.min(4000, text.length * 30);
          break;
        }
        case "wait":
          delay += act.seconds * 1000;
          break;
        case "set":
          setVar(rt, act, group.ctx, expand(rt, act.value, group.ctx));
          break;
        case "add": {
          const cur = Number(getVar(rt, act, group.ctx));
          const amt = Number(expand(rt, act.amount, group.ctx));
          setVar(rt, act, group.ctx, applyMath(cur, act.op, amt));
          break;
        }
        case "random": {
          const from = expand(rt, act.from, group.ctx).trim();
          const range = from.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
          let value;
          if (range) {
            const a = Number(range[1]), b = Number(range[2]);
            const lo = Math.min(a, b), hi = Math.max(a, b);
            value = lo + Math.floor(Math.random() * (hi - lo + 1));
          } else {
            const opts = from.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
            value = opts.length ? opts[Math.floor(Math.random() * opts.length)] : "";
          }
          setVar(rt, act, group.ctx, value);
          break;
        }
        case "clear":
          out.says.push({ text: "", delayMs: delay, clear: true });
          break;
        case "leave":
          out.left = true;
          rt.queue.length = 0;
          break;
      }
      if (out.left) break;
    }
  }
  out.memories = rt.bot.vars;
  out.myMemories = rt.bot.uvars["tester"] || {};
  out.friendMemories = rt.bot.uvars["friend"] || {};
  return out;
}

function testReply(socket, extra) {
  socket.emit("bots test out", extra);
}

const pendingNewRoom = new Map();

function onOwnerJoined(socket, room) {
  const ownerId = socket.handshake?.session?.userId;
  if (!ownerId) return;
  const pend = pendingNewRoom.get(ownerId);
  if (!pend || pend.roomId !== room.id) return;
  pendingNewRoom.delete(ownerId);
  if (Date.now() - pend.at > 120000) return;
  if (!store.enabled) return;
  const rec = ownerRecord(pend.ownerKey, false);
  const bot = rec?.bots.find((b) => b.id === pend.botId);
  if (!bot) return;
  if (room.allowBots === false) return;
  if (activeBotOfOwner(pend.ownerKey)) return;
  if (botCountInRoom(room) >= maxBotsForRoom(room)) return;
  const seats = (room.users || []).filter((u) => !(u.isDev && u.isVanished)).length;
  if (seats >= deps.roomCapacity(room)) return;
  const rt = deploy(socket, bot, room, pend.ownerKey);
  notifyOwner(rt, "bots deployed", {
    botId: bot.id,
    roomId: room.id,
    roomName: room.name,
    botUserId: rt.userId,
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingNewRoom)
    if (now - v.at > 120000) pendingNewRoom.delete(k);
}, 60000).unref();

// ── Wiring ──────────────────────────────────────────────────────────────────

function init(injected) {
  deps = injected;
  load();
}

module.exports = {
  init,
  register,
  flushSync,
  onText,
  onJoin,
  onLeave,
  onOwnerJoined,
  noteEvicted,
  isActiveBot,
  botCountInRoom,
  maxBotsForRoom,
};
