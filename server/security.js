// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ FILE 2: server/security.js ║ ║ Rate limiting, bot protection,
// validation, auth ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const {
  CONFIG,
  ERROR_CODES,
  state,
  getClientIP,
  createErrorResponse,
  sendErrorResponse,
} = require("./state");

// ── Rate Limiters ───────────────────────────────────────────────────────────

const socketRateLimiter = new RateLimiterMemory({
  points: CONFIG.LIMITS.SOCKET_MAX_REQUESTS_PER_WINDOW,
  duration: CONFIG.LIMITS.SOCKET_MAX_REQUESTS_WINDOW,
  blockDuration: 5,
});

const chatUpdateLimiter = new RateLimiterMemory({
  points: CONFIG.LIMITS.CHAT_UPDATE_RATE_LIMIT,
  duration: 5,
  blockDuration: 1,
});

const typingLimiter = new RateLimiterMemory({
  points: CONFIG.LIMITS.TYPING_RATE_LIMIT,
  duration: 1,
});

const ipRateLimiter = new RateLimiterMemory({
  points: 20,
  duration: 15,
  blockDuration: 30,
});

const enhancedRateLimiters = {
  suspicious: new RateLimiterMemory({
    points: 10,
    duration: 60,
    blockDuration: 300,
  }),
  botTokenRequest: new RateLimiterMemory({
    points: 3,
    duration: 3600,
    blockDuration: 3600,
  }),
  botApi: new RateLimiterMemory({
    points: CONFIG.LIMITS.MAX_BOT_REQUESTS_PER_MINUTE,
    duration: 60,
    blockDuration: 60,
  }),
  humanApi: new RateLimiterMemory({
    points: CONFIG.LIMITS.MAX_REQUESTS_PER_MINUTE,
    duration: 60,
    blockDuration: 300,
  }),
};

// ── Browser Detection ───────────────────────────────────────────────────────

function detectBrowserRequest(req) {
  const ua = req.headers["user-agent"] || "";
  const accept = req.headers["accept"] || "";
  const lang = req.headers["accept-language"] || "";
  const enc = req.headers["accept-encoding"] || "";

  let score = 0;
  if (/Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua)) score++;
  if (accept.includes("text/html")) score++;
  if (lang.length > 0) score++;
  if (enc.length > 0) score++;

  return {
    isBrowser: score >= 3,
    browserScore: score,
    userAgent: ua,
    details: {
      hasBrowserUserAgent: score >= 1,
      hasHtmlAccept: accept.includes("text/html"),
      hasLanguageHeader: lang.length > 0,
      hasEncodingHeader: enc.length > 0,
    },
  };
}

// ── Bot Token Management ────────────────────────────────────────────────────

function generateBotToken() {
  return "tk_" + crypto.randomBytes(32).toString("hex");
}

function validateBotToken(token) {
  if (!token || !token.startsWith("tk_")) return null;
  const data = state.botTokens.get(token);
  if (!data) return null;
  if (Date.now() - data.createdAt > CONFIG.TIMING.BOT_TOKEN_EXPIRY) {
    state.botTokens.delete(token);
    return null;
  }
  return data;
}

function createIPBasedUser(ip) {
  const existing = state.ipBasedUsers.get(ip);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const hash = crypto
    .createHash("md5")
    .update(ip)
    .digest("hex")
    .substring(0, 8);
  const ipUser = {
    userId: `ip_${hash}`,
    username: `Guest-${hash.toUpperCase()}`,
    location: "Anonymous",
    createdAt: Date.now(),
    lastSeen: Date.now(),
    isIPBased: true,
  };
  state.ipBasedUsers.set(ip, ipUser);
  console.log(`Created IP-based user: ${ipUser.username} for ${ip}`);
  return ipUser;
}

// ── Bot Detection ───────────────────────────────────────────────────────────

function detectBotBehavior(userId, clientIp) {
  const now = Date.now();
  const window = CONFIG.LIMITS.BOT_DETECTION_WINDOW;
  const threshold = CONFIG.LIMITS.BOT_DETECTION_JOIN_THRESHOLD;

  if (!state.userJoinAttempts.has(userId))
    state.userJoinAttempts.set(userId, []);
  const userAttempts = state.userJoinAttempts.get(userId);
  userAttempts.push(now);
  const validUser = userAttempts.filter((t) => now - t < window);
  state.userJoinAttempts.set(userId, validUser);

  if (!state.ipJoinAttempts.has(clientIp))
    state.ipJoinAttempts.set(clientIp, []);
  const ipAttempts = state.ipJoinAttempts.get(clientIp);
  ipAttempts.push(now);
  const validIp = ipAttempts.filter((t) => now - t < window);
  state.ipJoinAttempts.set(clientIp, validIp);

  if (validUser.length > threshold || validIp.length > threshold * 2) {
    console.warn(
      `Bot behavior: User=${userId} IP=${clientIp} attempts=${validUser.length}/${validIp.length}`,
    );
    state.suspiciousUsers.set(userId, {
      ip: clientIp,
      firstDetection: now,
      attempts: validUser.length,
    });
    if (validUser.length > threshold * 2) {
      state.botBlacklist.add(userId);
      state.botBlacklist.add(clientIp);
    }
    return true;
  }
  return false;
}

function isBlacklisted(userId, clientIp) {
  return state.botBlacklist.has(userId) || state.botBlacklist.has(clientIp);
}

// ── Middleware ───────────────────────────────────────────────────────────────

function antibotMiddleware(req, res, next) {
  if (!CONFIG.FEATURES.ENABLE_STRICT_ANTIBOT) return next();
  const botToken =
    req.headers["authorization"]?.replace("Bearer ", "") || req.query.token;
  const browser = detectBrowserRequest(req);

  if (browser.isBrowser) {
    if (botToken && CONFIG.FEATURES.ENABLE_BOT_TOKENS) {
      return res.status(403).json({
        error: {
          code: ERROR_CODES.TOKEN_NOT_ALLOWED_IN_BROWSER,
          message: "Bot tokens cannot be used in web browsers.",
        },
      });
    }
    return next();
  }

  if (CONFIG.FEATURES.ENABLE_BOT_TOKENS) {
    if (!botToken) {
      return res.status(401).json({
        error: {
          code: ERROR_CODES.BOT_TOKEN_REQUIRED,
          message: "Bot token required for automated access.",
        },
      });
    }
    const tokenData = validateBotToken(botToken);
    if (!tokenData) {
      return res.status(401).json({
        error: {
          code: ERROR_CODES.INVALID_BOT_TOKEN,
          message: "Invalid or expired bot token",
        },
      });
    }
    tokenData.lastUsed = Date.now();
    tokenData.uses = (tokenData.uses || 0) + 1;
    req.botToken = tokenData;
    req.isBot = true;
  } else {
    return res.status(403).json({
      error: {
        code: ERROR_CODES.AUTOMATED_ACCESS_BLOCKED,
        message: "Automated access is not permitted",
      },
    });
  }
  next();
}

async function enhancedRateLimit(req, res, next) {
  const clientIp = getClientIP(req);
  try {
    if (state.suspiciousUsers.has(clientIp) || state.blockedIPs.has(clientIp)) {
      await enhancedRateLimiters.suspicious.consume(clientIp);
    } else if (req.isBot) {
      await enhancedRateLimiters.botApi.consume(clientIp);
    } else {
      await enhancedRateLimiters.humanApi.consume(clientIp);
    }
    next();
  } catch (rl) {
    const sec = Math.round(rl.msBeforeNext / 1000) || 1;
    res.set({ "Retry-After": sec });
    return res.status(429).json({
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: `Rate limit exceeded. Try again in ${sec} seconds.`,
        retryAfter: sec,
      },
    });
  }
}

// ── Bot Token Handlers ──────────────────────────────────────────────────────

async function handleBotTokenRequest(req, res) {
  if (!CONFIG.FEATURES.ENABLE_BOT_TOKENS) {
    return res
      .status(404)
      .json({
        error: {
          code: "FEATURE_DISABLED",
          message: "Bot token system is disabled",
        },
      });
  }
  const clientIp = getClientIP(req);
  if (detectBrowserRequest(req).isBrowser) {
    return res
      .status(403)
      .json({
        error: {
          code: "BROWSER_TOKEN_REQUEST_BLOCKED",
          message: "Bot tokens cannot be requested from browsers",
        },
      });
  }
  try {
    await enhancedRateLimiters.botTokenRequest.consume(clientIp);
  } catch (rl) {
    return res
      .status(429)
      .json({
        error: {
          code: ERROR_CODES.RATE_LIMITED,
          message: "Too many token requests.",
        },
      });
  }
  const count = state.ipBotTokenCounts.get(clientIp) || 0;
  if (count >= CONFIG.LIMITS.MAX_BOT_TOKENS_PER_IP) {
    return res
      .status(429)
      .json({
        error: {
          code: "TOKEN_LIMIT_EXCEEDED",
          message: `Max ${CONFIG.LIMITS.MAX_BOT_TOKENS_PER_IP} tokens per IP`,
        },
      });
  }
  const token = generateBotToken();
  state.botTokens.set(token, {
    ip: clientIp,
    userAgent: req.headers["user-agent"] || "",
    createdAt: Date.now(),
    lastUsed: Date.now(),
    uses: 0,
  });
  state.ipBotTokenCounts.set(clientIp, count + 1);
  console.log(
    `Bot token generated for ${clientIp}: ${token.substring(0, 10)}...`,
  );
  res.status(201).json({
    token,
    expiresIn: CONFIG.TIMING.BOT_TOKEN_EXPIRY,
    expiresAt: new Date(
      Date.now() + CONFIG.TIMING.BOT_TOKEN_EXPIRY,
    ).toISOString(),
    usage: {
      rateLimit: CONFIG.LIMITS.MAX_BOT_REQUESTS_PER_MINUTE + " req/min",
      headers: "Authorization: Bearer {token}",
    },
  });
}

async function handleBotTokenInfo(req, res) {
  const token =
    req.headers["authorization"]?.replace("Bearer ", "") || req.query.token;
  if (!token)
    return res
      .status(400)
      .json({
        error: { code: "TOKEN_REQUIRED", message: "Bot token required" },
      });
  const data = validateBotToken(token);
  if (!data)
    return res
      .status(401)
      .json({
        error: {
          code: "INVALID_TOKEN",
          message: "Invalid or expired bot token",
        },
      });
  res.json({
    valid: true,
    createdAt: new Date(data.createdAt).toISOString(),
    lastUsed: new Date(data.lastUsed).toISOString(),
    expiresAt: new Date(
      data.createdAt + CONFIG.TIMING.BOT_TOKEN_EXPIRY,
    ).toISOString(),
    uses: data.uses || 0,
  });
}

function apiAuth(req, res, next) {
  const apiKey = req.header("x-api-key");
  const validKey =
    process.env.TALKOMATIC_API_KEY ||
    "tK_public_key_4f8a9b2c7d6e3f1a5g8h9i0j4k5l6m7n8o9p";
  if (!apiKey || apiKey !== validKey) {
    return sendErrorResponse(
      res,
      ERROR_CODES.UNAUTHORIZED,
      "Forbidden: invalid or missing x-api-key.",
      403,
    );
  }
  next();
}

// ── Validation ──────────────────────────────────────────────────────────────

const PFP_DIR = path.join(__dirname, "..", "public", "images", "pfp");
const PFP_RESCAN_MS = 60000;
let pfpScan = { at: 0, list: [] };

function presetAvatars() {
  const now = Date.now();
  if (pfpScan.at && now - pfpScan.at < PFP_RESCAN_MS) return pfpScan.list;
  let list = [];
  try {
    list = fs
      .readdirSync(PFP_DIR)
      .map((f) => /^(\d{1,3})\.png$/i.exec(f))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .filter((n) => n >= 1 && n <= 999)
      .sort((a, b) => a - b);
  } catch (_) {}
  pfpScan = { at: now, list };
  return list;
}

function isPresetAvatar(n) {
  return Number.isInteger(n) && presetAvatars().indexOf(n) !== -1;
}

const validationRules = {
  username: (v) => {
    if (!v || typeof v !== "string")
      return "Username is required and must be a string.";
    if (v.trim().length === 0) return "Username cannot be empty.";
    if (v.length > CONFIG.LIMITS.MAX_USERNAME_LENGTH)
      return `Username must be at most ${CONFIG.LIMITS.MAX_USERNAME_LENGTH} characters.`;
    return null;
  },
  location: (v) => {
    if (v && typeof v !== "string") return "Location must be a string.";
    if (typeof v === "string" && v.length > CONFIG.LIMITS.MAX_LOCATION_LENGTH)
      return `Location must be at most ${CONFIG.LIMITS.MAX_LOCATION_LENGTH} characters.`;
    return null;
  },
  roomName: (v) => {
    if (!v || typeof v !== "string")
      return "Room name is required and must be a string.";
    if (v.trim().length === 0) return "Room name cannot be empty.";
    if (v.length > CONFIG.LIMITS.MAX_ROOM_NAME_LENGTH)
      return `Room name must be at most ${CONFIG.LIMITS.MAX_ROOM_NAME_LENGTH} characters.`;
    return null;
  },
  roomType: (v) => {
    if (!v) return "Room type is required.";
    if (!["public", "semi-private", "private"].includes(v))
      return "Room type must be public, semi-private, or private.";
    return null;
  },
  layout: (v) => {
    if (!v) return "Room layout is required.";
    if (!["horizontal", "vertical"].includes(v))
      return "Room layout must be horizontal or vertical.";
    return null;
  },
  accessCode: (v, roomType) => {
    if (roomType === "semi-private") {
      if (!v) return "Access code is required for semi-private rooms.";
      if (typeof v !== "string" || v.length !== 6 || !/^\d+$/.test(v))
        return "Access code must be a 6-digit number.";
    }
    return null;
  },
  avatar: (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "object") return "Avatar must be an object.";
    if (v.preset !== undefined) {
      const n = Number(v.preset);
      if (!Number.isInteger(n) || n < 1 || n > 999)
        return "Avatar preset is invalid.";
      return null;
    }
    if (!/^\d{17,20}$/.test(String(v.discordId || "")))
      return "Avatar Discord ID must be 17-20 digits.";
    if (!/^(?:a_)?[a-f0-9]{32}$/i.test(String(v.hash || "")))
      return "Avatar hash is invalid.";
    return null;
  },
};

function validate(field, value, context) {
  return validationRules[field]
    ? validationRules[field](value, context)
    : `Unknown field: ${field}`;
}

function validateObject(obj, rules) {
  const errors = {};
  if (typeof obj !== "object" || obj === null) {
    errors._general = "Invalid data.";
    return errors;
  }
  for (const [field, opts] of Object.entries(rules)) {
    const ctx =
      opts.context !== undefined ? opts.context : obj.type || obj.roomType;
    const err = validate(opts.rule || field, obj[field], ctx);
    if (err) errors[field] = err;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  socketRateLimiter,
  chatUpdateLimiter,
  typingLimiter,
  ipRateLimiter,
  enhancedRateLimiters,
  detectBrowserRequest,
  detectBotBehavior,
  isBlacklisted,
  validateBotToken,
  createIPBasedUser,
  antibotMiddleware,
  enhancedRateLimit,
  apiAuth,
  handleBotTokenRequest,
  handleBotTokenInfo,
  validate,
  validateObject,
  presetAvatars,
  isPresetAvatar,
};
