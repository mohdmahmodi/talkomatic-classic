// server/bots.js
// User-made room bots, both tiers.
//
// Tier 1 is the no-code creator (botcreator.html): a bot is a JSON rule set -
// triggers, conditions, actions - executed HERE, by this interpreter. Nobody's
// code ever runs on this server; the "program" is data, capped and inspectable.
// A deployed bot occupies a real seat in room.users (flagged isBotUser) and
// types into a real textbox buffer at human speed, so to every client it is
// just another member of the room.
//
// Tier 2 is the developer API: an external process connects over Socket.IO
// with a bot token (server/security.js) and drives an ordinary user session
// from its own code. Those sockets are marked isBot at the handshake; rooms.js
// stamps their room entry isBotUser and holds them to the same per-room cap,
// and the staff surface here can see and kill them like any hosted bot.
//
// The rules that keep this from ever hurting the server or the rooms:
//   - a room holds 1 bot per 5 seats, capped at 5, both tiers combined
//   - one deployed bot per owner, MAX_SAVED saved configs per owner
//   - a bot runs only while its owner is connected somewhere on the site;
//     the sweep retires it (grace period) when the owner is gone
//   - a bot alone in a room leaves, so bots never keep empty rooms alive
//   - every action drains a token bucket; an empty bucket drops the action
//   - everything a bot says passes sanitizeMessage + IP redaction; automod
//     is each viewer's client-side choice, same as for human keystrokes
//   - a global kill switch (staff), plus per-bot kill and room vote-kick
//
// Wired from rooms.js: init(deps) hands over the room broadcast helpers,
// register(socket, safe) attaches the socket events, and three tiny hooks
// (onText / onJoin / onLeave) feed the interpreter its triggers.

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
const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "bots.json");

// ── Limits (the whole abuse posture in one place) ───────────────────────────

// Creative room (rules, actions, say length) is deliberately roomy: people
// build whole games. The abuse posture lives in the RATE limits underneath
// (queue, tokens, say gap), which is what actually protects a room.
const LIMITS = {
  MAX_BOTS_PER_ROOM: 5, // the hard ceiling; rooms earn 1 bot per 5 seats
  MAX_SAVED: 20, // saved configs per owner
  MAX_DEPLOYED_PER_OWNER: 1,
  MAX_ACTIVE_TOTAL: 20, // hosted bots server-wide, a hard load ceiling
  MAX_RULES: 200,
  MAX_ACTIONS_PER_RULE: 20,
  MAX_CONDITIONS_PER_RULE: 10,
  MAX_SAY_LENGTH: 1000,
  MAX_QUEUE: 12, // pending actions; a full queue drops the whole new group
  ACTION_TOKENS: 20, // token bucket: actions per minute
  SAY_MIN_GAP_MS: 1500,
  TIMER_MIN_MINUTES: 2,
  MAX_VARS: 256, // global variables per bot
  MAX_USER_VARS: 200, // per-user variable rows per bot (oldest evicted)
  VAR_VALUE_LENGTH: 500,
  UTTERANCE_IDLE_MS: 1500, // text unchanged this long = the person finished
  TYPE_CHARS_PER_TICK: 4, // ~33 chars/sec at the 120ms tick
  OWNER_GRACE_MS: 60000, // owner may drop briefly (reload) without killing bots
  MAX_CONFIG_BYTES: 200000,
};

const TICK_MS = 120;
const SWEEP_EVERY_TICKS = 16; // ~2s

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

// Saved bots belong to the device, not the session: the device id survives
// sign-ins and restarts, so people keep their bots. Sessions without a device
// id (rare) fall back to the session user id.
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

// ── Rule validation ─────────────────────────────────────────────────────────
// Everything a config can contain is whitelisted here. Anything else is
// stripped, so a hand-crafted payload cannot smuggle extra shapes into the
// store or the interpreter.

const TRIGGERS = ["command", "says", "mention", "join", "leave", "timer"];
const ACTIONS = ["say", "append", "wait", "set", "add", "random", "repeat", "clear", "leave"];
const OPS = ["is", "not", "gt", "lt", "has"];
const MATH_OPS = ["add", "sub", "mul", "div"];

const VAR_NAME = /^[a-z0-9_]{1,20}$/i;
const CMD_WORD = /^[a-z0-9]{1,16}$/i;

function cleanTemplate(text, max) {
  return sanitizeMessage(String(text == null ? "" : text)).slice(0, max);
}

// Returns { ok, bot } with a fully rebuilt object, or { ok:false, error }.
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

  // The line after the slash, like a person's "Sara / Earth". Their choice;
  // the BOT badge is what marks it as a bot, not this text.
  let location = enforceLocationLimit(sanitizeName(String(input.location || "")));
  if (location && wordFilter.checkText(location).hasOffensiveWord)
    return { ok: false, error: "That location is not allowed." };
  if (location && ipredact.containsIp(location))
    return { ok: false, error: "Locations cannot contain an IP address." };
  if (!location) location = "Bot";

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
      const word = String(on.word || "").trim().replace(/^!/, "");
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
        if (!VAR_NAME.test(name0))
          return {
            ok: false,
            error: "Variable names are 1-20 letters, digits or _.",
          };
        act.var = name0.toLowerCase();
        act.per = a.per === "user" ? "user" : "bot";
        if (a.type === "set") act.value = cleanTemplate(a.value, 500);
        else if (a.type === "add") {
          act.amount = cleanTemplate(a.amount, 40) || "1";
          // Older saved bots have no op; they keep plain adding forever.
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

    rules.push({ on: trig, if: conds, do: actions });
  }
  if (!rules.length)
    return { ok: false, error: "The bot needs at least one valid rule." };

  const bot = {
    id: existingId || "b" + crypto.randomBytes(5).toString("hex"),
    name,
    location,
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

let deps = null; // injected by rooms.js in init()

// botUserId -> runtime
const active = new Map();
// roomId -> Map(userId -> { text, changedAt, doneText }) for utterance detection
const roomText = new Map();
// ownerId(session userId) -> last time a socket of theirs was seen connected
const ownerSeen = new Map();

let tickTimer = null;
let tickCount = 0;

function io() {
  return state.io;
}

function botCountInRoom(room) {
  return (room?.users || []).filter((u) => u.isBotUser).length;
}

// How many bots a room may hold, both tiers combined: 1 per 5 seats, so the
// default 5-person room gets 1, a 10-person room 2, and a 25+ seat room the
// ceiling of 5. Bigger rooms have the people to absorb more bot chatter.
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

// The stand-in for a socket. The room broadcast helpers only ever read
// roomId, id, and the session identity off it - verified against
// emitRoomChatUpdate / emitRoomTyping / canRecipientSeeDevUser before this
// shape was settled - so this is every field they touch.
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
// Single pass, never recursive: a variable whose value contains {braces} is
// inserted as-is, so user data can never become new template code.

function expand(rt, template, ctx) {
  return String(template).replace(/\{([a-z0-9:_|.\- ]+)\}/gi, (whole, body) => {
    const key = body.trim();
    const low = key.toLowerCase();
    // Both vocabularies work everywhere. The creator page teaches the plain
    // one ({name}, {word1}, {memory:coins}); the older coder-flavored tokens
    // stay valid so no saved bot ever breaks.
    if (low === "user" || low === "name") return ctx.username || "someone";
    if (low === "line" || low === "text") return ctx.line || "";
    if (low === "arg" || low === "words" || low === "everything")
      return ctx.args ? ctx.args.join(" ") : "";
    if (/^arg[1-9]$/.test(low))
      return (ctx.args && ctx.args[Number(low.slice(3)) - 1]) || "";
    if (/^word[1-9]$/.test(low))
      return (ctx.args && ctx.args[Number(low.slice(4)) - 1]) || "";
    if (low.startsWith("memory:")) {
      const n = low.slice(7);
      return rt.bot.vars[n] != null ? String(rt.bot.vars[n]) : "0";
    }
    if (low.startsWith("mymemory:")) {
      const n = low.slice(9);
      const row = ctx.userId ? rt.bot.uvars[ctx.userId] : null;
      return row && row[n] != null ? String(row[n]) : "0";
    }
    if (low === "bot") return rt.name;
    // A line break mid-say, for people who miss that Enter works in the box.
    if (low === "newline") return "\n";
    // Every !command this bot answers to, one per line: a !help say that
    // never goes stale.
    if (low === "commands") {
      const seen = [];
      for (const r of rt.bot.rules)
        if (r.on.type === "command" && seen.indexOf("!" + r.on.word) === -1)
          seen.push("!" + r.on.word);
      return seen.join("\n");
    }
    // How long the bot has been in its room, for !info style commands.
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
    if (low.startsWith("var:")) {
      const n = low.slice(4);
      return rt.bot.vars[n] != null ? String(rt.bot.vars[n]) : "0";
    }
    if (low.startsWith("uvar:")) {
      const n = low.slice(5);
      const row = ctx.userId ? rt.bot.uvars[ctx.userId] : null;
      return row && row[n] != null ? String(row[n]) : "0";
    }
    if (low.startsWith("rand:")) {
      const m = low.slice(5).match(/^(-?\d+)\s*-\s*(-?\d+)$/);
      if (m) {
        const a = Number(m[1]), b = Number(m[2]);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
      }
      return whole;
    }
    if (low.startsWith("pick:")) {
      const opts = key.slice(5).split("|").map((s) => s.trim()).filter(Boolean);
      if (opts.length) return opts[Math.floor(Math.random() * opts.length)];
      return whole;
    }
    return whole; // unknown token: left visible so the creator can see the typo
  });
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

function setVar(rt, act, ctx, value) {
  const v = String(value).slice(0, LIMITS.VAR_VALUE_LENGTH);
  if (act.per === "user") {
    if (!ctx.userId) return;
    const u = rt.bot.uvars;
    if (!u[ctx.userId]) {
      // Oldest row out when the table is full, so one bot cannot grow without
      // bound by watching a busy room for a month.
      const keys = Object.keys(u);
      if (keys.length >= LIMITS.MAX_USER_VARS) delete u[keys[0]];
      u[ctx.userId] = {};
    }
    const row = u[ctx.userId];
    if (Object.keys(row).length >= 64 && row[act.var] == null) return;
    row[act.var] = v;
  } else {
    if (Object.keys(rt.bot.vars).length >= LIMITS.MAX_VARS && rt.bot.vars[act.var] == null)
      return;
    rt.bot.vars[act.var] = v;
  }
  rt.varsDirty = true;
}

function getVar(rt, act, ctx) {
  if (act.per === "user") {
    const row = ctx.userId ? rt.bot.uvars[ctx.userId] : null;
    return row ? row[act.var] : undefined;
  }
  return rt.bot.vars[act.var];
}

// The "change a memory" action's arithmetic, one place for both the live tick
// and the test sandbox. Divide by zero keeps the old value instead of turning
// a counter into Infinity, and results are trimmed to two decimals so a
// divided score stays readable.
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

// A matched rule becomes a GROUP on the bot's single queue, and groups run
// strictly one at a time. Two things hang on this shape:
//   - conditions are evaluated when the group STARTS, not when the trigger
//     fired, so "!rps" can roll a random in rule 1 and have rules 2-9 judge
//     the result - earlier rules' variable writes are visible to later ones
//   - the action token is charged at the same moment, so a rule whose
//     conditions turn out false costs nothing
// A repeat block runs everything above it again, 2-5 times in total. It is
// unrolled into a flat list the moment the rule fires, so the interpreter
// itself never loops. Hard cap keeps a 5x repeat of 5 blocks bounded.
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
    // Which rule this came from. The live runtime never reads it; the test
    // sandbox uses it to light up the rule card that just ran.
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

// Where "!word" sits in the line as its own word: at the start, or after a
// space, and not glued to more letters ("!fishing" is not "!fish"). Anywhere
// in the line counts, so nobody has to know that Enter starts a fresh line.
function commandIndex(lowerLine, word) {
  const token = "!" + word;
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

function onUtterance(rt, userId, username, line, fullText) {
  const lower = line.toLowerCase();
  for (let ri = 0; ri < rt.bot.rules.length; ri++) {
    const rule = rt.bot.rules[ri];
    const on = rule.on;
    // Each match gets its own ctx: a command's args must not leak into a
    // plain "says" rule that fired off the same line.
    const ctx = { userId, username, line, args: [] };
    if (on.type === "command") {
      const at = commandIndex(lower, on.word);
      if (at === -1) continue;
      const after = line.slice(at + 1 + on.word.length).trim();
      ctx.args = after ? after.split(/\s+/).slice(0, 8) : [];
    } else if (on.type === "says") {
      if (!lower.includes(on.text.toLowerCase())) continue;
    } else if (on.type === "mention") {
      if (!lower.includes(rt.name.toLowerCase())) continue;
    } else continue;
    fireRule(rt, rule, ctx, ri); // the queue cap bounds a runaway rulebook
  }
}

// What a bot is about to say, made safe the same way for every path:
// expanded, sanitized, length-capped, IPs redacted. Deliberately NOT run
// through the word filter: automod is a per-viewer choice made client-side,
// for bot text exactly as for human keystrokes.
function polishSay(rt, act, ctx) {
  let text = expand(rt, act.text, ctx);
  text = sanitizeMessage(text).slice(0, LIMITS.MAX_SAY_LENGTH);
  if (ipredact.looksLikeIp(text)) text = ipredact.redact(text);
  return text;
}

// Runs one action of the current group. Returns true when the action is done
// and the group may advance; false means "try this same action again next
// tick" (a say pacing itself behind the minimum gap).
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
    // Like say, but under what the bot already wrote instead of replacing
    // it: a greeter can stack arrivals, a game can keep its board on screen.
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
      // The box is capped like anyone's; oldest lines scroll away first.
      while (combined.length > CONFIG.LIMITS.MAX_MESSAGE_LENGTH) {
        const nl = combined.indexOf("\n");
        if (nl === -1) {
          combined = combined.slice(-CONFIG.LIMITS.MAX_MESSAGE_LENGTH);
          break;
        }
        combined = combined.slice(nl + 1);
      }
      rt.lastSayAt = Date.now();
      // Typing picks up from the end of what is already there.
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

// The bot's textbox. Progressive writes through the same buffer + broadcast
// path a person's keystrokes take, so every client renders it identically.
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
  startTick();
  return rt;
}

// Why the last run ended, written onto the saved config so the owner can see
// it on their bot list later. "Timers don't work" reports were mostly bots
// that had quietly gone home when the owner left; now the card says so.
function stampStop(rt, why) {
  const rec = store.owners[rt.ownerKey];
  const cfg = rec?.bots.find((b) => b.id === rt.bot.id);
  if (!cfg) return;
  cfg.lastStop = { why: String(why || "stopped").slice(0, 80), at: Date.now() };
  saveSoon();
}

// Takes the bot out of its room and out of the runtime, through the same
// leave path a person takes so every client and the lobby stay consistent.
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

// Tell the owner's open botcreator page(s) their bot changed state.
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

  // Utterances: a person's text has settled and their LAST LINE moved through
  // an actual change since the last settle. The box persists, so two things
  // must both work: clearing the box and retyping the same command fires again
  // (the line changed on the way, even though the final text looks identical),
  // and fixing a typo on an OLD line, or adding blank lines, fires nothing
  // (the last line never changed). lineDirty tracks exactly that.
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
    // Timers fire on their own schedule, with no triggering user.
    for (const t of rt.timers) {
      if (now < t.nextAt) continue;
      const rule = rt.bot.rules[t.i];
      t.nextAt = now + rule.on.minutes * 60000;
      fireRule(rt, rule, { userId: null, username: "", line: "", args: [] });
    }

    if (rt.typing) {
      tickTyping(rt);
      continue; // typing occupies the bot, like it occupies a person
    }
    if (rt.waitUntil > now) continue;

    const group = rt.queue[0];
    if (!group) continue;
    if (!group.checked) {
      group.checked = true;
      // Conditions read the variables as they are NOW, after every earlier
      // group finished, and the token is only charged on a pass.
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

// Identity of the last non-empty line: its row AND its text. The row matters
// for one paste-shaped case: dropping a second "!roll" under an old "!roll"
// in a single update keeps the text identical, but it is a new line and must
// count as one.
function lastLineKey(text) {
  const lines = String(text || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return i + ":" + l.slice(0, 200);
  }
  return "";
}

// The one place every way a bot can die is checked. Event-driven paths exist
// for the common cases, but membership here is self-healing: whatever state
// the rest of the server gets into, a bot that should not be running stops
// within a couple of seconds.
function sweep() {
  const now = Date.now();

  // Which owners are online right now.
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
      // Room closed, or the bot was removed by staff/vote out from under the
      // runtime. Clean up quietly - the membership change already happened.
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

// Every processed textbox update in every room passes through here. Cheap by
// design: one map write unless a bot is actually seated in that room.
function onText(roomId, userId, username, text) {
  if (!active.size || !roomId) return;
  let hasBot = false;
  for (const rt of active.values()) if (rt.roomId === roomId) { hasBot = true; break; }
  if (!hasBot) return;
  if (userId.startsWith("bot_")) return; // never listen to a bot (or itself)
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
    // Sticky until the next settle: the moment the last line differs from
    // what it just was, this update cycle counts as a real utterance.
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
      if (rule.on.type === "join") fireRule(rt, rule, ctx);
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
      if (rule.on.type === "leave") fireRule(rt, rule, ctx);
  }
}

// A vote-kick or staff kick that removed the bot's room entry directly.
function noteEvicted(botUserId) {
  const rt = active.get(botUserId);
  if (!rt) return;
  // A room ban lands on the seat's random userId; carry it over to the bot's
  // saved config id, or the same bot could be redeployed straight back into
  // the room that just threw it out.
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
  const rt = activeBotOfOwner(ownerKey);
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
    },
    bots: (rec?.bots || []).map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location || "Bot",
      rules: b.rules,
      updatedAt: b.updatedAt,
      vars: b.vars || {},
      lastStop: b.lastStop || null,
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

// The code names WHY it failed, so the page can answer with a proper modal
// ("that room is full, here is what to do") instead of a bare toast.
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
      const rec = ownerRecord(ownerKey, true);
      const existing = data?.id
        ? rec.bots.find((b) => b.id === data.id)
        : null;
      if (!existing && rec.bots.length >= LIMITS.MAX_SAVED)
        return fail(socket, `You can keep ${LIMITS.MAX_SAVED} bots. Delete one first.`);
      const v = validateConfig(data?.bot, existing?.id);
      if (!v.ok) return fail(socket, v.error);
      if (existing) {
        v.bot.createdAt = existing.createdAt;
        v.bot.vars = existing.vars || {};
        v.bot.uvars = existing.uvars || {};
        rec.bots[rec.bots.indexOf(existing)] = v.bot;
        // A live deployment keeps running the OLD rules until redeployed;
        // swapping a rulebook mid-conversation is more surprising than
        // "stop, edit, start again".
      } else {
        rec.bots.push(v.bot);
      }
      saveSoon();
      socket.emit("bots saved", { id: v.bot.id });
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  socket.on(
    "bots delete",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      const ownerKey = ownerKeyOf(socket);
      const rec = ownerRecord(ownerKey, false);
      if (!rec || !data?.id) return;
      const bot = rec.bots.find((b) => b.id === data.id);
      if (!bot) return;
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
      const rec = ownerRecord(ownerKey, false);
      const bot = rec?.bots.find((b) => b.id === data?.id);
      if (!bot) return fail(socket, "Save the bot first.", "save_first");

      if (!store.enabled)
        return fail(socket, "Bots are turned off by staff right now.", "bots_off");
      if (state.maintenance)
        return fail(socket, "Talkomatic is in maintenance mode. Try again shortly.", "maintenance");
      if (active.size >= LIMITS.MAX_ACTIVE_TOTAL)
        return fail(socket, "Too many bots are running right now. Try again in a while.", "busy");
      const already = activeBotOfOwner(ownerKey);
      if (already)
        return fail(
          socket,
          `You already have "${already.name}" running. Stop it first.`,
          "already_running",
        );

      // The room: an existing one by id, or a fresh one they name here.
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
        // The bot needs its owner in the room (a bot alone leaves), so a new
        // room deploy sends the OWNER there; the bot follows them in.
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
        // An empty room self-deletes on its timer unless somebody arrives.
        // The page navigates the owner there on "bots deployed".
        deps.startRoomDeletionTimer(roomId);
      } else {
        return fail(socket, "Pick a room, or name a new one.", "pick_room");
      }

      // New rooms start empty: the bot deploys pending, seated the moment its
      // owner walks in (the sweep would retire a bot alone in a room anyway).
      if (data?.newRoom) {
        pendingNewRoom.set(socket.handshake.session.userId, {
          botId: bot.id,
          ownerKey,
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

      const rt = deploy(socket, bot, room, ownerKey);
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
      const rt = activeBotOfOwner(ownerKey);
      if (rt) retire(rt, "stopped by you");
      socket.emit("bots status", ownerStatus(ownerKey));
    }),
  );

  // ── The test room: run the current rules without deploying anything ──────

  socket.on(
    "bots test start",
    safe(async (data) => {
      if (!requireSignin(socket)) return;
      // The same validator a save uses, so a broken rule is caught HERE,
      // while they are looking at it, with a plain sentence about what is
      // wrong - not later at deploy time.
      const v = validateConfig(data?.bot, "test");
      if (!v.ok) return socket.emit("bots test error", { message: v.error });
      // Editing a rule mid-test restarts the sandbox with the new rules but
      // KEEPS what the bot remembered, so someone tuning a fishing bot does
      // not lose their coins every time they reword a message. The wipe
      // button is the only thing that wipes.
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
          if (rt.bot.rules[ri].on.type === kind)
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
        // A tier-2 bot is a real socket; killing it is a disconnect.
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
      if (!socket.isDev) return; // the master switch is dev-only
      store.enabled = data?.enabled !== false;
      saveSoon();
      if (!store.enabled) for (const rt of [...active.values()]) retire(rt, "bots turned off");
      deps.logStaff(socket, store.enabled ? "bots on" : "bots off", null, "-");
      socket.emit("staff bots list", { enabled: store.enabled, bots: [] });
    }),
  );
}

// ── The test room ───────────────────────────────────────────────────────────
// The creator page has a pretend room next to the editor: the builder types a
// line, the CURRENT (even unsaved) rules run against it through the exact
// same interpreter as a live bot - same validation, same conditions, same
// word filter - and the page animates the replies and lights up the rules
// that fired. Nothing here touches real rooms, caps, or the store; a sandbox
// is one in-memory object per socket, gone on disconnect.

const testSessions = new Map(); // socket.id -> sandbox runtime

function makeSandbox(bot, username) {
  return {
    userId: "test",
    name: bot.name,
    bot, // a validated deep copy; vars start empty so tests are predictable
    roomId: null,
    roomName: "the test room",
    queue: [],
    dropped: 0,
    deployedAt: Date.now(), // so {runtime} has something to say here too
    tester: username || "You",
  };
}

// Drains the sandbox queue synchronously, capturing what the live tick would
// have done: which rules ran or were skipped, what got said and with what
// pacing, and what the bot now remembers.
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
      if (out.says.length >= 20) break; // a runaway test stays readable
      switch (act.type) {
        case "say": {
          const text = polishSay(rt, act, group.ctx);
          if (!text.trim()) break;
          delay += LIMITS.SAY_MIN_GAP_MS / 2;
          out.says.push({ text, delayMs: delay });
          delay += Math.min(4000, text.length * 30); // the typing time
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
  // The tester's own per-person memories, plus the pretend friend's if any.
  out.myMemories = rt.bot.uvars["tester"] || {};
  out.friendMemories = rt.bot.uvars["friend"] || {};
  return out;
}

function testReply(socket, extra) {
  socket.emit("bots test out", extra);
}

// A "deploy to a brand-new room" waits for the owner to arrive in that room.
// ownerId -> { botId, ownerKey, roomId, at }
const pendingNewRoom = new Map();

// Called by rooms.js when anyone joins a room: if this joiner has a pending
// new-room deploy for THIS room, seat their bot next to them now.
function onOwnerJoined(socket, room) {
  const ownerId = socket.handshake?.session?.userId;
  if (!ownerId) return;
  const pend = pendingNewRoom.get(ownerId);
  if (!pend || pend.roomId !== room.id) return;
  pendingNewRoom.delete(ownerId);
  if (Date.now() - pend.at > 120000) return; // they took too long; forget it
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

// Expired pending deploys are dropped so the map cannot grow.
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
