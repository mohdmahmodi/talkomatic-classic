// server/state.js
// Shared config, constants, mutable state, and utility functions.

const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const util = require("util");
const WordFilter = require("../public/js/word-filter.js");

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  LIMITS: {
    MAX_USERNAME_LENGTH: 15,
    MAX_AFK_TIME: 180000,
    MAX_LOCATION_LENGTH: 20,
    MAX_ROOM_NAME_LENGTH: 25,
    MAX_MESSAGE_LENGTH: 5000,
    MAX_ROOM_CAPACITY: 5,
    BASE_MAX_ROOMS: 15,
    ROOM_SCALING_INCREMENT: 5,
    MAX_CONNECTIONS_PER_IP: 8,
    SOCKET_MAX_REQUESTS_WINDOW: 1,
    SOCKET_MAX_REQUESTS_PER_WINDOW: 75,
    CHAT_UPDATE_RATE_LIMIT: 500,
    TYPING_RATE_LIMIT: 60,
    CONNECTION_DELAY: 100,
    MAX_ID_GEN_ATTEMPTS: 100,
    BATCH_SIZE_LIMIT: 50,
    MAX_ROOMS_PER_USER: 1,
    BOT_DETECTION_JOIN_THRESHOLD: 10,
    BOT_DETECTION_WINDOW: 60000,
    MAX_REQUESTS_PER_MINUTE: 100,
    MAX_BOT_REQUESTS_PER_MINUTE: 500,
    MAX_BOT_TOKENS_PER_IP: 3,
    BOT_TOKEN_REQUEST_COOLDOWN: 300000,
    IP_USER_CLEANUP_INTERVAL: 3600000,

    // Minimum users in a room before the vote-kick system is active
    MIN_USERS_FOR_VOTING: 3,

    // Maximum consecutive combining marks allowed per base character
    MAX_COMBINING_MARKS: 2,

    // Anti-spam: per-IP room limits
    MAX_ROOMS_PER_IP: 2,
    IP_ROOM_CREATION_COOLDOWN: 30000,

    // Anti-spam: pressure system
    HARD_MAX_ROOMS: 50,

    PRESSURE_TIERS: [
      { threshold: 0, ttl: 20 * 60 * 1000 },
      { threshold: 15, ttl: 10 * 60 * 1000 },
      { threshold: 30, ttl: 3 * 60 * 1000 },
      { threshold: 40, ttl: 60 * 1000 },
    ],

    HEALTHY_ROOM_AGE_MS: 5 * 60 * 1000,
    PRESSURE_CLEANUP_INTERVAL: 30000,
  },
  FEATURES: {
    ENABLE_WORD_FILTER: true,
    // Rehydrate rooms from rooms.json on boot so a restart/redeploy keeps rooms
    // alive. loadRooms() clears their member lists and starts the empty-room
    // deletion timers, so returning users repopulate them and rooms nobody
    // comes back to self-delete. Set false to start every boot with no rooms.
    LOAD_ROOMS_ON_STARTUP: true,
    ENABLE_BOT_PROTECTION: true,
    ENABLE_DYNAMIC_SCALING: true,
    ENABLE_STRICT_ANTIBOT: true,
    ENABLE_BOT_TOKENS: true,
    ENABLE_IP_BASED_USERS: false,
    REQUIRE_USER_AGENT: true,
    // Live dev feature flag: when false, non-staff cannot create new rooms.
    ENABLE_ROOM_CREATION: true,
  },
  TIMING: {
    ROOM_CREATION_COOLDOWN: 10000,
    ROOM_DELETION_TIMEOUT: 30000,
    TYPING_TIMEOUT: 2000,
    BATCH_PROCESSING_INTERVAL: 20,
    // Slow mode: broadcast cadence for rooms a staffer has throttled. Keystrokes
    // are still captured; the room just sees updates less frequently.
    SLOW_MODE_BATCH_INTERVAL: 1000,
    AFK_WARNING_TIME: 150000,
    BOT_BLOCK_DURATION: 300000,
    BOT_TOKEN_EXPIRY: 2592000000,
    BOT_TOKEN_CLEANUP_INTERVAL: 86400000,
  },

  // Usernames that only validate when the connection carries a dev or mod key,
  // so trolls cannot impersonate staff. Compared case-insensitively.
  RESERVED_NAMES: ["mohd", "talkomatic", "admin", "mod", "dev"],
  VERSIONS: {
    API: "v1",
    SERVER: "5.5.0",
    // Socket message-shape version. Restarts are invisible while this matches
    // the client's baked-in copy; bump it ONLY when a client<->server payload
    // shape changes, which makes still-open clients reload once to pick up the
    // new code instead of silently rejoining with a stale protocol.
    PROTOCOL: 1,
  },

  // Dev mode: SHA-256 hash of the secret dev key, set in .env as DEV_KEY_HASH.
  // Generate with: crypto.createHash('sha256').update('your_key').digest('hex')
  // MAIN_KEY_HASH is the same format for the key that carries the site itself
  // (uptime, error triage, the raw server-side detail the health checks read).
  DEV: {
    KEY_HASH: process.env.DEV_KEY_HASH || "",
    MAIN_KEY_HASH: process.env.MAIN_DEV_KEY_HASH || "",
  },
};

const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SERVER_ERROR: "SERVER_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  ROOM_FULL: "ROOM_FULL",
  ACCESS_DENIED: "ACCESS_DENIED",
  BAD_REQUEST: "BAD_REQUEST",
  FORBIDDEN: "FORBIDDEN",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
  AFK_WARNING: "AFK_WARNING",
  AFK_TIMEOUT: "AFK_TIMEOUT",
  ROOM_NAME_EXISTS: "ROOM_NAME_EXISTS",
  ROOM_LIMIT_REACHED: "ROOM_LIMIT_REACHED",
  BOT_TOKEN_REQUIRED: "BOT_TOKEN_REQUIRED",
  INVALID_BOT_TOKEN: "INVALID_BOT_TOKEN",
  TOKEN_NOT_ALLOWED_IN_BROWSER: "TOKEN_NOT_ALLOWED_IN_BROWSER",
  AUTOMATED_ACCESS_BLOCKED: "AUTOMATED_ACCESS_BLOCKED",
};

// ── Word Filter ─────────────────────────────────────────────────────────────

let wordFilter;
try {
  wordFilter = new WordFilter(
    path.join(__dirname, "..", "public", "js", "offensive_words.json"),
    path.join(__dirname, "..", "public", "js", "character_substitutions.json"),
  );
} catch (err) {
  console.error("Failed to initialize WordFilter:", err);
  wordFilter = {
    checkText: () => ({ hasOffensiveWord: false }),
    filterText: (text) => text,
  };
  CONFIG.FEATURES.ENABLE_WORD_FILTER = false;
}

// ── Shared Mutable State ────────────────────────────────────────────────────

const state = {
  // io reference (set by server.js after creation)
  io: null,

  // Room data
  rooms: new Map(),
  users: new Map(),
  roomDeletionTimers: new Map(),
  lastRoomCreationTimes: new Map(),

  // Chat / typing
  typingTimeouts: new Map(),
  userMessageBuffers: new Map(),
  pendingChatUpdates: new Map(),
  batchProcessingTimers: new Map(),

  // AFK
  afkTimers: new Map(),
  afkWarningTimers: new Map(),

  // Circuit breaker
  chatCircuitState: {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    threshold: 50,
    resetTimeout: 15000,
  },

  // Connection / security tracking
  ipConnections: new Map(),
  ipLastConnectionTime: new Map(),
  blockedIPs: new Map(),
  userJoinAttempts: new Map(),
  ipJoinAttempts: new Map(),
  suspiciousUsers: new Map(),
  botBlacklist: new Set(),

  // Bot tokens
  botTokens: new Map(),
  ipBotTokenCounts: new Map(),
  botTokenRequests: new Map(),
  ipBasedUsers: new Map(),

  // Anti-spam: per-IP room creation tracking
  ipLastRoomCreation: new Map(),

  // Anti-spam: per-room solo timestamp
  roomSoloSince: new Map(),

  // Anti-spam: per-room last chat activity
  roomLastChatActivity: new Map(),

  // Dev mode: userIds with a verified dev key
  devUsers: new Set(),

  // Staff runtime toggles (in-memory; reset on restart by design). The
  // application intake switch is NOT one of these - it is owned and persisted
  // by server/applications.js, because closing it has to mean closed.
  maintenance: false, // blocks new room creation and joins for non-staff
  lobbyTicker: "", // editable banner shown at the top of the lobby

  // Caches
  normalizeCache: new Map(),
  apiCache: new Map(),
  API_CACHE_TTL: 10000,

  // Save state
  saveRoomsPending: false,
  lastSaveTimestamp: 0,
  SAVE_INTERVAL_MIN: 30000,
};

// ── Utility Functions ───────────────────────────────────────────────────────

function getClientIP(req) {
  const cfIP = req.headers["cf-connecting-ip"];
  if (cfIP) return cfIP;
  const realIP = req.headers["x-real-ip"];
  if (realIP) return realIP;
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress;
}

function createErrorResponse(
  code,
  message,
  details = null,
  replaceDefaultText = false,
) {
  const response = { error: { code, message, replaceDefaultText } };
  if (details) response.error.details = details;
  return response;
}

function sendErrorResponse(res, code, message, status = 400, details = null) {
  return res.status(status).json(createErrorResponse(code, message, details));
}

function normalize(str) {
  if (!str) return "";
  if (state.normalizeCache.has(str)) return state.normalizeCache.get(str);
  const normalized = str.trim().toLowerCase();
  if (str.length <= 30) {
    state.normalizeCache.set(str, normalized);
    if (state.normalizeCache.size > 1000) {
      const keys = Array.from(state.normalizeCache.keys()).slice(0, 200);
      keys.forEach((k) => state.normalizeCache.delete(k));
    }
  }
  return normalized;
}

// ── Text Sanitization ───────────────────────────────────────────────────────
// COMBINING_MARK_RUN matches runs of combining diacritical marks (zalgo text)
// longer than the allowed maximum. Targets the generic combining blocks while
// leaving language-specific marks (Arabic, Hebrew, Thai) untouched.

const COMBINING_MARK_RUN = new RegExp(
  "[\\u0300-\\u036f" + // Combining Diacritical Marks
    "\\u0483-\\u0489" + // Combining Cyrillic
    "\\u1ab0-\\u1aff" + // Combining Diacritical Marks Extended
    "\\u1dc0-\\u1dff" + // Combining Diacritical Marks Supplement
    "\\u20d0-\\u20ff" + // Combining Marks for Symbols
    "\\ufe20-\\ufe2f]" + // Combining Half Marks
    `{${CONFIG.LIMITS.MAX_COMBINING_MARKS + 1},}`,
  "g",
);

// Sanitizes a chat message buffer: strips the right-to-left override and
// carriage returns, clamps zalgo runs, enforces the message length limit.
function sanitizeMessage(msg) {
  if (typeof msg !== "string") return "";

  let clean = "";
  for (const char of msg) {
    const code = char.codePointAt(0);
    if (code === 0x202e) continue; // right-to-left override
    if (char === "\r") continue;
    clean += char;
  }

  clean = clean.replace(COMBINING_MARK_RUN, (run) =>
    run.slice(0, CONFIG.LIMITS.MAX_COMBINING_MARKS),
  );

  return clean.slice(0, CONFIG.LIMITS.MAX_MESSAGE_LENGTH);
}

// Sanitizes identity fields (usernames, locations, room names). These render
// in every user-info row, the lobby list, and join notifications, so they get
// the same zalgo/RTL protection as chat messages. Also strips newlines and
// tabs, which have no place in a name. Length limits are applied separately
// by the enforce* helpers.
function sanitizeName(value) {
  if (typeof value !== "string") return "";

  let clean = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === 0x202e) continue; // right-to-left override
    if (char === "\r" || char === "\n" || char === "\t") continue;
    clean += char;
  }

  clean = clean.replace(COMBINING_MARK_RUN, (run) =>
    run.slice(0, CONFIG.LIMITS.MAX_COMBINING_MARKS),
  );

  return clean.trim();
}

// ── Length Enforcement ──────────────────────────────────────────────────────

function enforceCharacterLimit(msg) {
  return typeof msg === "string"
    ? msg.slice(0, CONFIG.LIMITS.MAX_MESSAGE_LENGTH)
    : "";
}
function enforceUsernameLimit(val) {
  return typeof val === "string"
    ? val.slice(0, CONFIG.LIMITS.MAX_USERNAME_LENGTH)
    : "";
}
function enforceLocationLimit(val) {
  return typeof val === "string"
    ? val.slice(0, CONFIG.LIMITS.MAX_LOCATION_LENGTH)
    : "";
}
function enforceRoomNameLimit(val) {
  return typeof val === "string"
    ? val.slice(0, CONFIG.LIMITS.MAX_ROOM_NAME_LENGTH)
    : "";
}

function promisifySessionSave(session) {
  if (!session || typeof session.save !== "function") return Promise.resolve();
  return util.promisify(session.save).bind(session)();
}

// True if the (already-sanitized) name matches a reserved staff name.
function isReservedName(name) {
  if (typeof name !== "string") return false;
  return CONFIG.RESERVED_NAMES.includes(name.trim().toLowerCase());
}

// True for a name the app handed out rather than one a person chose: the
// lobby's old "Guest12345", the IP fallback's "Guest-A1B2C3D4", a bare
// "Guest", or the placeholders used when a name was missing. Everyone picks a
// name in the lobby now, so these are refused wherever a name is accepted.
// Matched on the trimmed form; the trailing group is hex so both the digit and
// the hash variants are covered by the one test.
function isGuestName(name) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  if (!n) return true;
  if (/^guest[\s._-]*[0-9a-f]*$/i.test(n)) return true;
  if (/^(anonymous|someone|unknown)$/i.test(n)) return true;
  return false;
}

// Deployment name list, comma separated in the environment. Kept out of CONFIG
// so it is never part of anything the app serializes outward.
function nameKey(val) {
  return String(val)
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}
const NAME_LIST = (process.env.BLOCKER_USER || "")
  .split(",")
  .map(nameKey)
  .filter(Boolean);

// Compared on the stripped form, so spacing and punctuation do not change the
// result ("Test Account", "test-account" and "testaccount" all agree).
function isListedName(name) {
  if (!NAME_LIST.length || typeof name !== "string") return false;
  return NAME_LIST.includes(nameKey(name));
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  CONFIG,
  ERROR_CODES,
  wordFilter,
  state,
  getClientIP,
  createErrorResponse,
  sendErrorResponse,
  normalize,
  sanitizeMessage,
  sanitizeName,
  enforceCharacterLimit,
  enforceUsernameLimit,
  enforceLocationLimit,
  enforceRoomNameLimit,
  promisifySessionSave,
  isReservedName,
  isGuestName,
  isListedName,
};
