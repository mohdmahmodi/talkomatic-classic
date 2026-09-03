// server/state.js
// Shared config, constants, mutable state, and utility functions.

const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const util = require("util");
const WordFilter = require("../public/js/word-filter.js");
const nameguard = require("./nameguard");

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
    // Live sockets, not people: schools and carrier NAT put many users behind
    // one address, and a frozen phone tab holds its slot until the ping
    // timeout reaps it. 8 locked whole networks out of the lobby.
    // A room join holds two sockets per person, so 60 is thirty people.
    MAX_CONNECTIONS_PER_IP: 60,
    SOCKET_MAX_REQUESTS_WINDOW: 1,
    SOCKET_MAX_REQUESTS_PER_WINDOW: 150,
    CHAT_UPDATE_RATE_LIMIT: 500,
    TYPING_RATE_LIMIT: 60,
    CONNECTION_DELAY: 100,
    MAX_ID_GEN_ATTEMPTS: 100,
    BATCH_SIZE_LIMIT: 50,
    MAX_ROOMS_PER_USER: 1,
    BOT_DETECTION_JOIN_THRESHOLD: 10,
    BOT_DETECTION_WINDOW: 60000,
    MAX_REQUESTS_PER_MINUTE: 300,
    MAX_BOT_REQUESTS_PER_MINUTE: 500,
    MAX_BOT_TOKENS_PER_IP: 3,
    BOT_TOKEN_REQUEST_COOLDOWN: 300000,
    IP_USER_CLEANUP_INTERVAL: 3600000,

    MIN_USERS_FOR_VOTING: 3,

    MAX_COMBINING_MARKS: 2,

    MAX_ROOMS_PER_IP: 2,
    IP_ROOM_CREATION_COOLDOWN: 30000,

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
    LOAD_ROOMS_ON_STARTUP: true,
    ENABLE_BOT_PROTECTION: true,
    ENABLE_DYNAMIC_SCALING: true,
    ENABLE_STRICT_ANTIBOT: true,
    ENABLE_BOT_TOKENS: true,
    ENABLE_IP_BASED_USERS: false,
    REQUIRE_USER_AGENT: true,
    ENABLE_ROOM_CREATION: true,
  },
  TIMING: {
    ROOM_CREATION_COOLDOWN: 10000,
    ROOM_DELETION_TIMEOUT: 30000,
    TYPING_TIMEOUT: 2000,
    BATCH_PROCESSING_INTERVAL: 20,
    SLOW_MODE_BATCH_INTERVAL: 1000,
    AFK_WARNING_TIME: 150000,
    BOT_BLOCK_DURATION: 300000,
    BOT_TOKEN_EXPIRY: 2592000000,
    BOT_TOKEN_CLEANUP_INTERVAL: 86400000,
  },

  RESERVED_NAMES: ["mohd", "talkomatic", "admin", "mod", "dev"],
  VERSIONS: {
    API: "v1",
    SERVER: "5.5.0",
    PROTOCOL: 1,
  },

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

function bufferKey(userId, roomId) {
  return (roomId || "?") + ":" + userId;
}

const state = {
  io: null,

  rooms: new Map(),
  users: new Map(),
  roomDeletionTimers: new Map(),
  lastRoomCreationTimes: new Map(),

  typingTimeouts: new Map(),
  // Typed chat text, one buffer per user per room
  userMessageBuffers: new Map(),
  getBuffer(userId, roomId) {
    return this.userMessageBuffers.get(bufferKey(userId, roomId)) || "";
  },
  setBuffer(userId, roomId, text) {
    this.userMessageBuffers.set(bufferKey(userId, roomId), text);
  },
  deleteBuffer(userId, roomId) {
    this.userMessageBuffers.delete(bufferKey(userId, roomId));
  },
  deleteUserBuffers(userId) {
    const suffix = ":" + userId;
    for (const key of [...this.userMessageBuffers.keys()])
      if (key.endsWith(suffix)) this.userMessageBuffers.delete(key);
  },
  pendingChatUpdates: new Map(),
  batchProcessingTimers: new Map(),

  afkTimers: new Map(),
  afkWarningTimers: new Map(),
  afkSpectateTimers: new Map(),

  chatCircuitState: {
    failures: 0,
    lastFailure: 0,
    isOpen: false,
    threshold: 50,
    resetTimeout: 15000,
  },

  ipConnections: new Map(),
  ipLastConnectionTime: new Map(),
  blockedIPs: new Map(),
  userJoinAttempts: new Map(),
  ipJoinAttempts: new Map(),
  suspiciousUsers: new Map(),
  botBlacklist: new Set(),

  botTokens: new Map(),
  ipBotTokenCounts: new Map(),
  botTokenRequests: new Map(),
  ipBasedUsers: new Map(),

  ipLastRoomCreation: new Map(),

  roomSoloSince: new Map(),

  roomLastChatActivity: new Map(),

  devUsers: new Set(),

  maintenance: false,
  lobbyTicker: "",

  normalizeCache: new Map(),
  apiCache: new Map(),
  API_CACHE_TTL: 10000,

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

const COMBINING_MARK_RUN = new RegExp(
  "[\\u0300-\\u036f" +
    "\\u0483-\\u0489" +
    "\\u1ab0-\\u1aff" +
    "\\u1dc0-\\u1dff" +
    "\\u20d0-\\u20ff" +
    "\\ufe20-\\ufe2f]" +
    `{${CONFIG.LIMITS.MAX_COMBINING_MARKS + 1},}`,
  "g",
);

function sanitizeMessage(msg) {
  if (typeof msg !== "string") return "";

  let clean = "";
  for (const char of msg) {
    const code = char.codePointAt(0);
    if (code === 0x202e) continue;
    if (char === "\r") continue;
    clean += char;
  }

  clean = clean.replace(COMBINING_MARK_RUN, (run) =>
    run.slice(0, CONFIG.LIMITS.MAX_COMBINING_MARKS),
  );

  return clean.slice(0, CONFIG.LIMITS.MAX_MESSAGE_LENGTH);
}

function sanitizeName(value) {
  if (typeof value !== "string") return "";

  value = nameguard.normalize(value);

  let clean = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === 0x202e) continue;
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

function isReservedName(name) {
  if (typeof name !== "string") return false;
  return CONFIG.RESERVED_NAMES.includes(name.trim().toLowerCase());
}

function isGuestName(name) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  if (!n) return true;
  if (n.length < 3) return true;
  if ((n.match(/[\p{L}\p{N}]/gu) || []).length < 2) return true;
  if (/^guest[\s._-]*[0-9a-f]*$/i.test(n)) return true;
  if (/^(anonymous|someone|unknown)$/i.test(n)) return true;
  return false;
}

function nameKey(val) {
  return String(val)
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}
const NAME_LIST = (process.env.BLOCKER_USER || "")
  .split(",")
  .map((v) => nameguard.skeleton(v))
  .filter((v) => v.length >= 3);

function isListedName(name) {
  if (!NAME_LIST.length || typeof name !== "string") return false;
  const key = nameguard.skeleton(name);
  if (!key) return false;
  return NAME_LIST.some((v) => key.includes(v));
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
