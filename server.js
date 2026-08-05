// server.js (root entry point)
// Express, Socket.IO, API routes, startup.

require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const fs = require("fs").promises;
const session = require("express-session");
const cookieParser = require("cookie-parser");
const sharedsession = require("express-socket.io-session");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const xss = require("xss-clean");
const hpp = require("hpp");
const crypto = require("crypto");

const {
  CONFIG,
  ERROR_CODES,
  state,
  getClientIP,
  createErrorResponse,
  sendErrorResponse,
  promisifySessionSave,
  sanitizeMessage,
  wordFilter,
} = require("./server/state");
const {
  antibotMiddleware,
  enhancedRateLimit,
  handleBotTokenRequest,
  handleBotTokenInfo,
  apiAuth,
  detectBrowserRequest,
  validateBotToken,
  createIPBasedUser,
  socketRateLimiter,
  ipRateLimiter,
  enhancedRateLimiters,
  validateObject,
} = require("./server/security");
const rooms = require("./server/rooms");
const roles = require("./server/roles");
const appeals = require("./server/appeals");
const ipban = require("./server/ipban");
const puzzle = require("./server/puzzle");
const nsfw = require("./server/nsfw");
const communityThemes = require("./server/themes");

// ── Global Error Handlers ───────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("=== UNHANDLED REJECTION ===", reason);
});
process.on("uncaughtException", (error) => {
  console.error("=== UNCAUGHT EXCEPTION ===", error.message, error.stack);
});

// On a clean shutdown, flush every store to disk so nothing is lost in the
// debounce window. Invites, identity, applications, reports, mod keys, the audit
// log, and the IP ban list all persist across restarts and version updates -
// each store's load() tolerates old/missing fields so data migrates forward
// instead of disappearing.
function gracefulFlush() {
  try {
    require("./server/invites").flushSync();
  } catch (e) {}
  try {
    require("./server/identity").flushSync();
  } catch (e) {}
  try {
    require("./server/applications").flushSync();
  } catch (e) {}
  try {
    require("./server/reports").flushSync();
  } catch (e) {}
  try {
    require("./server/appeals").flushSync();
  } catch (e) {}
  try {
    require("./server/suggestions").flushSync();
  } catch (e) {}
  try {
    require("./server/themes").flushSync();
  } catch (e) {}
  try {
    require("./server/banhistory").flushSync();
  } catch (e) {}
  try {
    require("./server/blocklist").flushSync();
  } catch (e) {}
  try {
    require("./server/warnings").flushSync();
  } catch (e) {}
  try {
    rooms.saveBoardSync(); // persist Talkoboard strokes across the restart
  } catch (e) {}
}
let shuttingDown = false;
function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: notifying clients, then shutting down.`);
  // Tell every client we are restarting so they show a countdown and return to
  // the lobby, instead of silently freezing on the dropped socket.
  try {
    if (state.io) state.io.emit("server restarting", { seconds: 5 });
  } catch (e) {}
  // Let the notice flush before we drop sockets, persist, and exit. Stays under
  // pm2's kill_timeout (default 1600ms). Rooms are force-saved (past the save
  // throttle) so returning clients rejoin the rooms they were in.
  setTimeout(async () => {
    try {
      await rooms.saveRooms(true);
    } catch (e) {
      console.error("Shutdown room save failed:", e);
    }
    gracefulFlush();
    process.exit(0);
  }, 800);
}
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => beginShutdown(sig));
process.on("beforeExit", gracefulFlush);

// ── Express & HTTP ──────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// Behind a reverse proxy (Dokploy/Traefik, Cloudflare, nginx) the proxy is the
// TCP peer; trust one hop so req.ip, req.protocol, and secure cookies reflect
// the real client. Set TRUST_PROXY=0 to disable when exposed directly.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

// Extra origins (e.g. the domain you deploy on) via ALLOWED_ORIGINS, comma-separated.
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://classic.talkomatic.co",
  ...(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];
const corsOptions = {
  origin: (origin, cb) =>
    !origin || allowedOrigins.includes(origin) || origin.endsWith("github.io")
      ? cb(null, true)
      : cb(new Error("CORS blocked"), false),
  methods: ["GET", "POST"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
};

// ── Middleware (order matters) ──────────────────────────────────────────────

app.use(express.json({ limit: "100kb" }));
app.use(cors(corsOptions));
app.use(cookieParser());

// Per-request CSP nonce for inline scripts
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
        "https://cdnjs.cloudflare.com",
        "https://classic.talkomatic.co",
        "https://unpkg.com",
        "https://static.cloudflareinsights.com",
      ],
      scriptSrcElem: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
        "https://cdnjs.cloudflare.com",
        "https://classic.talkomatic.co",
        "https://unpkg.com",
        "https://static.cloudflareinsights.com",
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdnjs.cloudflare.com",
        "https://fonts.googleapis.com",
      ],
      styleSrcElem: [
        "'self'",
        "'unsafe-inline'",
        "https://cdnjs.cloudflare.com",
        "https://fonts.googleapis.com",
      ],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com",
        "https://cdnjs.cloudflare.com",
        "https://classic.talkomatic.co",
      ],
      connectSrc: [
        "'self'",
        "https://classic.talkomatic.co",
        "https://raw.githubusercontent.com",
        // Discord avatar lookups (pfp feature) are made from the browser
        "https://pfpgrab.com",
      ],
      mediaSrc: ["'self'", "data:"],
      frameAncestors: ["'self'", "*"],
      frameSrc: ["'self'"], // same-origin only (the in-room puzzle iframe)
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false,
});

app.use(xss());
app.use(hpp());

// Rate limiter, skips static assets and socket.io so they don't eat the limit
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIP(req),
    skip: (req) => {
      const url = req.path || req.url;
      return (
        /\.(js|css|png|jpg|jpeg|gif|ico|svg|ttf|otf|woff|woff2|mp3|wav|ogg|json|map)$/i.test(
          url,
        ) ||
        url.startsWith("/socket.io/") ||
        // The ban screen polls ban-status every 20s as its ONLY channel to learn
        // it has been unbanned (its socket stays refused while blocked). It must
        // never eat the rate budget: if it 429s, the banned user can't detect an
        // unban, and a 429 body used to be misread client-side as "unbanned",
        // spawning a reload loop. Exempt this cheap read.
        url.endsWith("/ban-status")
      );
    },
    message: {
      error: { code: ERROR_CODES.RATE_LIMITED, message: "Too many requests." },
    },
  }),
);

app.use((req, res, next) => {
  // TalkoBrowser is a self-contained page that needs inline JS,
  // external icon images, and iframes - exempt it from the strict CSP
  if (req.path === "/browser.html") return next();
  // The puzzle page is self-contained too (Tailwind/FontAwesome/TF.js from CDNs,
  // its own canvas + inline module) and runs sandboxed in a room iframe.
  if (req.path === "/puzzle.html") return next();
  // Same for the standalone games under /games: they are whole pages with their
  // own inline scripts, framed by the mini games panel. They cannot carry our
  // per-request nonce, so the strict policy would just break them.
  if (req.path.startsWith("/games/")) return next();
  return helmetMiddleware(req, res, next);
});

// ── Session ─────────────────────────────────────────────────────────────────
// SESSION_SECRET must be set in .env for sessions to survive restarts.
// Without it a random secret is generated on boot, which signs out every
// user and invalidates all validated room access codes.

const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Add SESSION_SECRET=<long random string> to .env (generate one with: openssl rand -hex 32)",
  );
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  proxy: true,
  cookie: {
    // "auto": secure only when the request actually came in over HTTPS (direct
    // or via a trusted proxy's X-Forwarded-Proto). Keeps sessions working on
    // plain-HTTP local/docker runs without weakening HTTPS deployments.
    secure: "auto",
    httpOnly: true,
    maxAge: 14 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
  },
});

// Optionally auto-assigns IP-based guest identities to browser requests
function enhancedSessionMiddleware(req, res, next) {
  sessionMiddleware(req, res, () => {
    if (CONFIG.FEATURES.ENABLE_IP_BASED_USERS && !req.session.username) {
      const browser = detectBrowserRequest(req);
      if (browser.isBrowser) {
        const ipUser = createIPBasedUser(getClientIP(req));
        Object.assign(req.session, {
          username: ipUser.username,
          location: ipUser.location,
          userId: ipUser.userId,
          isIPBased: true,
        });
      }
    }
    next();
  });
}
app.use(enhancedSessionMiddleware);

// ── Socket.IO ───────────────────────────────────────────────────────────────

const io = socketIo(server, {
  cors: {
    origin: (origin, cb) =>
      !origin || allowedOrigins.includes(origin) || origin.endsWith("github.io")
        ? cb(null, true)
        : cb(new Error("Socket CORS"), false),
    methods: ["GET", "POST"],
    credentials: true,
  },
  proxy: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 2e6,
  // WebSocket only. The polling fallback doubled the handshake and made every
  // client start on long-poll before upgrading; anything that cannot open a
  // WebSocket to us is not going to work well anyway.
  transports: ["websocket"],
  allowUpgrades: false,
  perMessageDeflate: { threshold: 1024 },
  httpCompression: true,
});

// Store io reference in shared state
state.io = io;
puzzle.init(() => io);

io.use(sharedsession(sessionMiddleware, { autoSave: true }));

// Socket.IO security middleware: IP blocks, dev key validation, antibot,
// connection caps, and per-socket event rate limiting
io.use((socket, next) => {
  try {
    const clientIp = getClientIP({
      headers: socket.handshake.headers,
      socket: { remoteAddress: socket.handshake.address },
    });
    const botToken =
      socket.handshake.auth.token || socket.handshake.query.token;
    const browser = detectBrowserRequest(socket.handshake);

    // Durable per-browser device id (active-vs-new + invite credit). Parsed
    // before the block check and mirrored onto the session so HTTP routes see
    // the same identity as the socket layer.
    const rawDeviceId = socket.handshake.auth.deviceId;
    const deviceId =
      typeof rawDeviceId === "string" && /^[a-f0-9-]{8,64}$/i.test(rawDeviceId)
        ? rawDeviceId.toLowerCase()
        : null;
    if (deviceId) {
      socket.deviceId = deviceId;
      try {
        const sess = socket.handshake.session;
        if (sess && sess.did !== deviceId) {
          sess.did = deviceId;
          sess.save();
        }
      } catch (_) {}
    }

    // Blocked if the exact address is banned OR it falls inside a banned range
    // (IPv6 /64), so rotating within a /64 does not evade the ban.
    const activeBlock =
      ipban.findActiveBlock(clientIp) ||
      (deviceId ? ipban.findActiveIdBlock(deviceId) : null);
    if (activeBlock) {
      const block = activeBlock.block;
      const expiry = block && typeof block === "object" ? block.expiry : block;
      const err = new Error("IP blocked");
      // Surfaced to the client's connect_error handler so the lobby can show
      // a clear ban screen with a live countdown (or "permanent").
      err.data = {
        banned: true,
        permanent: expiry >= Number.MAX_SAFE_INTEGER,
        expiry,
        reason: (block && block.reason) || null,
        // Who placed the ban and when, so the ban screen can name the staff
        // member. Only the staff label is exposed, never the raw IP.
        by: (block && block.by) || null,
        bannedAt: (block && typeof block === "object" && block.ts) || null,
      };
      return next(err);
    }
    // Opportunistically drop a stale exact entry so the map does not grow.
    const stale = state.blockedIPs.get(clientIp);
    if (stale !== undefined && !ipban.isActiveBlock(stale))
      state.blockedIPs.delete(clientIp);

    // Dev mode: validate devKey by hash against the configured dev keys
    // (.env DEV_KEY_HASH supports multiple labeled keys). Owner-only.
    const devKey = socket.handshake.auth.devKey;
    const devMatch = devKey ? roles.getDevKey(devKey) : null;
    if (devMatch) {
      socket.isDev = true;
      socket.staffLabel = devMatch.label;
      socket.devKeyHash = devMatch.hash;
      socket.isHidden = !!socket.handshake?.session?.isDevHidden;
      // Track which IPs this key connects from; flag a brand-new one.
      socket.keyNewIp = roles.recordKeyUse(
        devMatch.hash,
        devMatch.label,
        "dev",
        clientIp,
      ).newIp;
      console.log(
        `[DEV] Dev mode activated (${devMatch.label}) for IP:${clientIp}`,
      );
    }

    // Mod mode: validate modKey by hash against mod-keys.json. Dev outranks mod,
    // so only check when the connection is not already a dev.
    if (!socket.isDev) {
      const modKey = socket.handshake.auth.modKey;
      const mk = modKey ? roles.getModKeyByPlain(modKey) : null;
      if (mk) {
        socket.isMod = true;
        socket.modKeyHash = mk.hash;
        socket.modLevel = mk.level || 2;
        socket.staffLabel = mk.label;
        // Mods can hide their badge with the same persisted toggle as devs.
        socket.isHidden = !!socket.handshake?.session?.isDevHidden;
        socket.keyNewIp = roles.recordKeyUse(
          mk.hash,
          mk.label,
          "mod",
          clientIp,
        ).newIp;
        console.log(`[MOD] Mod mode activated (${mk.label}) for IP:${clientIp}`);
      }
    }

    if (CONFIG.FEATURES.ENABLE_STRICT_ANTIBOT && !browser.isBrowser) {
      if (CONFIG.FEATURES.ENABLE_BOT_TOKENS) {
        if (!botToken) return next(new Error("Bot token required"));
        const tokenData = validateBotToken(botToken);
        if (!tokenData) return next(new Error("Invalid bot token"));
        socket.isBot = true;
        socket.botToken = tokenData;
      } else return next(new Error("Automated access blocked"));
    } else if (botToken && browser.isBrowser)
      return next(new Error("Bot tokens not allowed in browsers"));

    ipRateLimiter
      .consume(clientIp)
      .then(() => {
        const count = state.ipConnections.get(clientIp) || 0;
        if (count >= CONFIG.LIMITS.MAX_CONNECTIONS_PER_IP)
          return next(new Error("Too many connections"));
        state.ipConnections.set(clientIp, count + 1);
        socket.clientIp = clientIp;
        socket.browserDetection = browser;

        socket.use((packet, nextMw) => {
          // Dev users bypass socket rate limits
          if (socket.isDev) return nextMw();

          const evt = packet[0];
          if (
            [
              "error",
              "connect",
              "disconnect",
              "disconnecting",
              "typing",
              // Piano note batches are a real-time stream (~18/sec while playing)
              // with their own dedicated flood caps (msgs/sec, notes/sec, and
              // per-message), so the blunt generic limiter must not drop them -
              // that is what made notes cut out during active play.
              "piano notes",
              // Same story for Draw & Guess strokes: batched, and capped by
              // its own per-second limit in server/games/socket.js.
              "games draw",
              "get rooms",
              "get room state",
            ].includes(evt)
          )
            return nextMw();
          const limiter = socket.isBot
            ? enhancedRateLimiters.botApi
            : socketRateLimiter;
          limiter
            .consume(socket.id)
            .then(() => nextMw())
            .catch(() => {
              socket.emit(
                "error",
                createErrorResponse(
                  ERROR_CODES.RATE_LIMITED,
                  "Rate limit exceeded.",
                ),
              );
            });
        });
        next();
      })
      .catch(() => next(new Error("IP rate limit exceeded")));
  } catch (err) {
    console.error("Socket middleware error:", err);
    next(new Error("Connection setup failed"));
  }
});

// ── Static Files (after session so HTML pages get session cookies) ──────────

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        // HTML must always be revalidated, never served stale from cache. The
        // pages reference assets by ?v=, so a deploy only reaches users if they
        // re-fetch the HTML and see the new versions. Without this the old HTML
        // (and its old ?v=) sticks until a manual hard refresh. ETag still
        // yields a cheap 304 when nothing changed.
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      } else if (filePath.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        // Versioned by ?v=, so the URL itself changes on update - safe to cache
        // hard and skip revalidation entirely (immutable).
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith(".css"))
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else if (filePath.match(/\.(jpg|jpeg|png|gif|ico|svg)$/))
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      if (filePath.endsWith(".ttf")) res.setHeader("Content-Type", "font/ttf");
    },
  }),
);

// ── Pages ───────────────────────────────────────────────────────────────────
// The HTML pages live in public/pages/ but are served at their original
// top-level URLs (/index.html, /room.html, ...) so no link or redirect changes.
// Same no-cache header the static handler gives HTML (see comment above).

const PAGES_DIR = path.join(__dirname, "public", "pages");
const PAGE_HEADERS = { "Cache-Control": "no-cache, must-revalidate" };
const PAGES = [
  "about",
  "app-directory",
  "browser",
  "contributors",
  "documentation",
  "index",
  "mod",
  "puzzle",
  "room",
  "sponsors",
  "themes",
];
// The pages carry nonce="<%= nonce %>" on their script tags, but nothing was
// ever substituting it: sendFile ships the file byte for byte, so that literal
// text went to the browser and the nonce matched nothing. Any inline script
// would have been blocked by our own CSP. Stamp the per-request nonce in as the
// page is sent. Read fresh each time, as sendFile did, so editing a page during
// development still shows up without a restart.
function sendPage(req, res, file) {
  fs
    .readFile(file, "utf8")
    .then((html) => {
      res.set(PAGE_HEADERS);
      res.type("html").send(
        html.replace(/<%=\s*nonce\s*%>/g, res.locals.nonce || ""),
      );
    })
    .catch(() => res.status(404).end());
}

for (const page of PAGES) {
  app.get(`/${page}.html`, (req, res) =>
    sendPage(req, res, path.join(PAGES_DIR, `${page}.html`)),
  );
}
app.get("/", (req, res) =>
  sendPage(req, res, path.join(PAGES_DIR, "index.html")),
);

// ── API Routes ──────────────────────────────────────────────────────────────

const API = `/api/${CONFIG.VERSIONS.API}`;

// ── Monitoring endpoints ────────────────────────────────────────────────────
// All three are registered BEFORE the antibot middleware on purpose: uptime
// monitors (Uptime Kuma, Docker healthchecks, wget/curl) are not browsers and
// would otherwise get 401. They expose no per-user data.

// Liveness probe: is the process up at all. Used by the Docker HEALTHCHECK.
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Detailed health: stable shape for keyword monitors ("status":"ok" only when
// every subsystem is fine).
app.get(`${API}/health`, (req, res) => {
  const stats = rooms.getRoomStatistics();
  const mem = process.memoryUsage();
  const nsfwReady = nsfw.isReady();
  res.json({
    status: nsfwReady ? "ok" : "degraded",
    timestamp: Date.now(),
    uptimeSeconds: Math.floor(process.uptime()),
    version: {
      server: CONFIG.VERSIONS.SERVER,
      api: CONFIG.VERSIONS.API,
      protocol: CONFIG.VERSIONS.PROTOCOL,
    },
    process: {
      node: process.version,
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      rssMB: Math.round(mem.rss / 1048576),
    },
    rooms: { active: stats.totalRooms, limit: stats.currentLimit },
    users: { inRooms: stats.totalUsers, sockets: io.engine.clientsCount },
    subsystems: {
      socketio: "ok",
      imageSafetyScanner: nsfwReady ? "ok" : "loading",
    },
  });
});

// Public status summary, safe to embed in a status page.
app.get(`${API}/status`, (req, res) => {
  const stats = rooms.getRoomStatistics();
  res.json({
    status: "online",
    name: "Talkomatic Classic",
    version: CONFIG.VERSIONS.SERVER,
    uptimeSeconds: Math.floor(process.uptime()),
    usersOnline: io.engine.clientsCount,
    usersInRooms: stats.totalUsers,
    activeRooms: stats.totalRooms,
  });
});

app.post(`${API}/bot-tokens/request`, handleBotTokenRequest);
app.get(`${API}/bot-tokens/info`, handleBotTokenInfo);
app.use("/api", antibotMiddleware);
app.use("/api", enhancedRateLimit);

app.get(`${API}/config`, (req, res) => {
  const cached = state.apiCache.get("config");
  if (cached && Date.now() - cached.timestamp < state.API_CACHE_TTL)
    return res.json(cached.data);
  const data = {
    limits: CONFIG.LIMITS,
    features: CONFIG.FEATURES,
    versions: CONFIG.VERSIONS,
    roomStatistics: rooms.getRoomStatistics(),
  };
  state.apiCache.set("config", { timestamp: Date.now(), data });
  res.json(data);
});

app.get(`${API}/me`, (req, res) => {
  const { username, location, userId, isIPBased } = req.session;
  if (username && location && userId)
    res.json({
      isSignedIn: true,
      username,
      location,
      userId,
      isIPBased: !!isIPBased,
      isBot: !!req.isBot,
    });
  else res.json({ isSignedIn: false, isBot: !!req.isBot });
});

// Ban appeal, submitted straight from the ban screen. The IP block only rejects
// socket connections, so a banned user can still reach this HTTP route. We only
// accept an appeal from an IP that is actually blocked, capture a snapshot of
// the ban it contests, and surface it to staff in the Appeals tab. One open
// appeal per IP, so the inbox cannot be flooded.
app.post(`${API}/appeal`, (req, res) => {
  try {
    const ip = getClientIP(req);
    const rawDevice =
      typeof req.body?.deviceId === "string"
        ? req.body.deviceId
        : req.session?.did || "";
    const deviceId = /^[a-f0-9-]{8,64}$/i.test(rawDevice)
      ? rawDevice.toLowerCase()
      : null;
    // Match a range ban too, so a range-banned user (whose exact address is not
    // itself a key) can still submit an appeal from the ban screen.
    const active =
      ipban.findActiveBlock(ip) ||
      (deviceId ? ipban.findActiveIdBlock(deviceId) : null);
    if (!active) return res.json({ ok: false, code: "not_banned" });
    const block = active.block;

    const message = sanitizeMessage(
      typeof req.body?.message === "string" ? req.body.message : "",
    ).slice(0, 1000);
    if (message.trim().length < 3)
      return res.json({ ok: false, code: "too_short" });

    // Identity comes from the session the banned browser still carries, so a
    // moderator can trace the appealing user's activity by their userId.
    const name = req.session?.username || null;
    const userId = req.session?.userId || null;
    const b = block && typeof block === "object" ? block : {};

    const result = appeals.submit({
      ip,
      deviceId,
      userId,
      name,
      message,
      ban: {
        by: b.by || null,
        label: b.label || null,
        reason: b.reason || null,
        expiry: b.expiry || 0,
        permanent: (b.expiry || 0) >= Number.MAX_SAFE_INTEGER,
        ts: b.ts || null,
      },
    });
    if (!result.ok) return res.json(result);
    try {
      rooms.announceAppeal(result.id);
    } catch (e) {
      console.error("announceAppeal failed:", e);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("appeal route error:", e);
    res.status(500).json({ ok: false, code: "server_error" });
  }
});

// Is the requester's IP still blocked? The ban screen polls this over HTTP
// (which works while the socket is refused) so it can reload itself the moment
// a ban is lifted, instead of stranding the user until they refresh by hand.
app.get(`${API}/ban-status`, (req, res) => {
  const ip = getClientIP(req);
  // Range-aware: a range-banned user must keep reading banned:true here (matches
  // the socket gate), or the ban screen would think they were unbanned and
  // reload-loop. Mirrors the socket gate exactly, session identity included.
  const active =
    ipban.findActiveBlock(ip) ||
    (req.session?.did ? ipban.findActiveIdBlock(req.session.did) : null);
  const block = active ? active.block : null;
  const expiry = block && typeof block === "object" ? block.expiry : block;
  const banned = !!active;
  res.json({
    banned,
    permanent: banned && expiry >= Number.MAX_SAFE_INTEGER,
    expiry: banned ? expiry : 0,
  });
});

// ── Collaborative puzzle: one shared board per room ─────────────────────────
// The image is uploaded as a raw JPEG body (no multipart). The uploader must be
// a member of the room. Two safety gates: the browser runs a fast nsfwjs
// pre-check (attested in x-nsfw-scan), and the server then classifies the
// ACTUAL uploaded bytes itself (server/nsfw.js) - the attestation alone is
// self-reported and forgeable, so the server scan is the one that counts.
app.post(
  `${API}/puzzle/:roomId/image`,
  express.raw({ type: () => true, limit: "6mb" }),
  async (req, res) => {
    try {
      const roomId = req.params.roomId;
      const userId = req.session?.userId;
      const room = state.rooms.get(roomId);
      const member = room && room.users?.find((u) => u.id === userId);
      if (!userId || !member)
        return sendErrorResponse(res, ERROR_CODES.FORBIDDEN, "You are not in this room.", 403);

      const isStaff = !!(member.isDev || member.isMod);
      if (!state.puzzleEnabled && !isStaff)
        return sendErrorResponse(res, ERROR_CODES.FORBIDDEN, "Puzzles are currently turned off.", 403);

      // Client-side nsfwjs must have run and passed. Enforcement is client-side
      // by design; the server re-checks the reported scores. Thresholds mirror
      // the browser scan in public/pages/puzzle.html - keep the two in sync.
      let att = null;
      try { att = JSON.parse(req.get("x-nsfw-scan") || "null"); } catch { att = null; }
      const sc = (att && att.scores) || {};
      const porn = +sc.Porn || 0, hentai = +sc.Hentai || 0, sexy = +sc.Sexy || 0;
      if (!att || att.safe !== true || porn > 0.3 || hentai > 0.3 || sexy > 0.5 || porn + hentai + sexy > 0.6)
        return sendErrorResponse(res, ERROR_CODES.FORBIDDEN, "That image did not pass the safety check.", 403);

      const iw = parseInt(req.query.w, 10) | 0;
      const ih = parseInt(req.query.h, 10) | 0;
      let target = parseInt(req.query.n, 10) | 0;
      if (!iw || !ih) return sendErrorResponse(res, ERROR_CODES.BAD_REQUEST, "need w & h", 400);
      if (!puzzle.VALID_COUNTS.includes(target)) target = 100;

      const image = req.body;
      if (!Buffer.isBuffer(image) || image.length < 64)
        return sendErrorResponse(res, ERROR_CODES.BAD_REQUEST, "no image", 400);

      // Server-side classification of the actual bytes. Fails closed: a scan
      // error rejects the upload rather than letting it through unchecked.
      let verdict;
      try {
        verdict = await nsfw.scanJpeg(image);
      } catch (e) {
        console.error("puzzle nsfw scan failed:", e.message);
        return sendErrorResponse(
          res,
          ERROR_CODES.SERVER_ERROR,
          "The safety check is unavailable right now. Try again in a minute.",
          503,
        );
      }
      if (!verdict.safe) {
        console.log(
          `[NSFW] Blocked puzzle upload in room ${roomId} by ${req.session?.username || "?"} ` +
            `(Porn ${verdict.scores.Porn.toFixed(2)}, Hentai ${verdict.scores.Hentai.toFixed(2)}, Sexy ${verdict.scores.Sexy.toFixed(2)})`,
        );
        return sendErrorResponse(
          res,
          ERROR_CODES.FORBIDDEN,
          "That image did not pass the safety check.",
          403,
        );
      }

      const started = puzzle.start(
        roomId, userId, req.session?.username, image, { iw, ih }, target, isStaff,
      );
      if (!started.ok)
        return sendErrorResponse(
          res,
          ERROR_CODES.FORBIDDEN,
          "Someone just started a puzzle - join that one, or ask them to end it first.",
          403,
        );
      io.to(roomId).emit("puzzle active", { by: req.session?.username || "Someone" });
      res.json({ ok: true });
    } catch (e) {
      console.error("puzzle upload error:", e);
      sendErrorResponse(res, ERROR_CODES.SERVER_ERROR, "upload failed", 500);
    }
  },
);

app.get(`${API}/puzzle/:roomId/image`, (req, res) => {
  const img = puzzle.imageFor(req.params.roomId);
  if (!img) return sendErrorResponse(res, ERROR_CODES.NOT_FOUND, "no puzzle", 404);
  res.writeHead(200, {
    "content-type": "image/jpeg",
    "cache-control": "public, max-age=31536000",
    "content-length": img.length,
  });
  res.end(img);
});

// Emoji list, cached in memory for an hour
const emojiCache = { data: null, ts: 0 };
app.get("/js/emojiList.json", async (req, res) => {
  try {
    if (emojiCache.data && Date.now() - emojiCache.ts < 3600000) {
      res.setHeader("Content-Type", "application/json");
      return res.send(emojiCache.data);
    }
    const data = await require("fs").promises.readFile(
      path.join(__dirname, "public", "js", "emojiList.json"),
      "utf8",
    );
    emojiCache.data = data;
    emojiCache.ts = Date.now();
    res.setHeader("Content-Type", "application/json");
    res.send(data);
  } catch (e) {
    res.status(404).json({ error: "Emoji list not found" });
  }
});

app.get(`${API}/rooms`, apiAuth, (req, res) => {
  try {
    const cached = state.apiCache.get("public_rooms");
    if (cached && Date.now() - cached.timestamp < state.API_CACHE_TTL)
      return res.json(cached.data);
    const data = Array.from(state.rooms.values())
      .filter((r) => r.type !== "private")
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        users: (r.users || [])
          .filter((u) => !u.isDev || !u.isVanished)
          .map((u) => ({
            id: u.id,
            username: u.username,
            location: u.location,
          })),
        isFull:
          (r.users || []).filter((u) => !u.isDev || !u.isVanished).length >=
          rooms.roomCapacity(r),
      }));
    state.apiCache.set("public_rooms", { timestamp: Date.now(), data });
    res.json(data);
  } catch (e) {
    sendErrorResponse(res, ERROR_CODES.SERVER_ERROR, "Internal error", 500);
  }
});

app.get(`${API}/rooms/:id`, apiAuth, (req, res) => {
  const room = state.rooms.get(req.params.id);
  if (!room)
    return sendErrorResponse(res, ERROR_CODES.NOT_FOUND, "Room not found", 404);
  res.json({
    id: room.id,
    name: room.name,
    type: room.type,
    users: (room.users || [])
      .filter((u) => !u.isDev || !u.isVanished)
      .map((u) => ({
        id: u.id,
        username: u.username,
        location: u.location,
      })),
    isFull:
      (room.users || []).filter((u) => !u.isDev || !u.isVanished).length >=
      rooms.roomCapacity(room),
  });
});

app.post(`${API}/rooms`, apiAuth, async (req, res) => {
  try {
    const data = req.body;
    const valErr = validateObject(data, {
      name: { rule: "roomName" },
      type: { rule: "roomType" },
      layout: { rule: "layout" },
      accessCode: { rule: "accessCode", context: data.type },
    });
    if (valErr)
      return sendErrorResponse(
        res,
        ERROR_CODES.VALIDATION_ERROR,
        "Validation failed",
        400,
        valErr,
      );
    const limit = rooms.calculateCurrentRoomLimit();
    if (state.rooms.size >= limit)
      return sendErrorResponse(
        res,
        ERROR_CODES.ROOM_LIMIT_REACHED,
        `Room limit (${limit}) reached`,
        429,
      );
    const ip = getClientIP(req);
    if (
      Date.now() - (state.lastRoomCreationTimes.get(ip) || 0) <
      CONFIG.TIMING.ROOM_CREATION_COOLDOWN
    )
      return sendErrorResponse(
        res,
        ERROR_CODES.RATE_LIMITED,
        "Creating rooms too fast",
        429,
      );

    // Room names get the same zalgo/RTL sanitization as the socket path
    const { enforceRoomNameLimit, sanitizeName } = require("./server/state");
    let name = enforceRoomNameLimit(sanitizeName(data.name));
    if (!name)
      return sendErrorResponse(
        res,
        ERROR_CODES.VALIDATION_ERROR,
        "Room name contains no valid characters",
        400,
      );
    if (rooms.roomNameExists(name))
      return sendErrorResponse(
        res,
        ERROR_CODES.ROOM_NAME_EXISTS,
        "Room name exists",
        409,
      );

    let roomId,
      attempts = 0;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
      attempts++;
    } while (state.rooms.has(roomId) && attempts < 100);
    if (state.rooms.has(roomId))
      return sendErrorResponse(
        res,
        ERROR_CODES.SERVER_ERROR,
        "Could not generate ID",
        500,
      );

    state.lastRoomCreationTimes.set(ip, Date.now());
    state.rooms.set(roomId, {
      id: roomId,
      name,
      type: data.type,
      layout: data.layout,
      users: [],
      accessCode: data.type === "semi-private" ? data.accessCode : null,
      votes: {},
      bannedUserIds: new Set(),
      lastActiveTime: Date.now(),
    });
    if (req.session && data.type === "semi-private" && data.accessCode) {
      if (!req.session.validatedRooms) req.session.validatedRooms = {};
      req.session.validatedRooms[roomId] = data.accessCode;
      await promisifySessionSave(req.session).catch(() => {});
    }
    state.apiCache.delete("public_rooms");
    rooms.updateLobby();
    await rooms.debouncedSaveRooms();
    res.status(201).json({
      success: true,
      roomId,
      currentStatistics: rooms.getRoomStatistics(),
    });
  } catch (e) {
    console.error("POST rooms error:", e);
    sendErrorResponse(res, ERROR_CODES.SERVER_ERROR, "Internal error", 500);
  }
});

// ── Community themes: browse and publish visual-editor themes ──────────────
// Submissions carry only validated tokens/effects/fonts (custom CSS is
// rejected by design) and the title/description ALWAYS pass the word filter,
// independent of the global automod toggle.

app.get(`${API}/themes`, (req, res) => {
  res.json({ themes: communityThemes.publicList() });
});

app.post(`${API}/themes`, (req, res) => {
  try {
    const userId = req.session?.userId;
    const by = req.session?.username;
    if (!userId || !by)
      return sendErrorResponse(
        res,
        ERROR_CODES.FORBIDDEN,
        "Sign in on the lobby first, then publish.",
        403,
      );
    let title = sanitizeMessage(String(req.body?.title || ""))
      .slice(0, 40)
      .trim();
    let desc = sanitizeMessage(String(req.body?.desc || ""))
      .slice(0, 160)
      .trim();
    if (title.length < 3)
      return sendErrorResponse(
        res,
        ERROR_CODES.VALIDATION_ERROR,
        "Give the theme a name (3 or more characters).",
        400,
      );
    title = wordFilter.filterText(title);
    desc = wordFilter.filterText(desc);

    const rawDevice =
      typeof req.body?.deviceId === "string" ? req.body.deviceId : "";
    const deviceId = /^[a-f0-9-]{8,64}$/i.test(rawDevice)
      ? rawDevice.toLowerCase()
      : null;

    const result = communityThemes.submit({
      deviceId,
      ip: getClientIP(req),
      userId,
      by: wordFilter.filterText(by),
      title,
      desc,
      state: req.body?.state,
    });
    if (!result.ok)
      return sendErrorResponse(
        res,
        result.code === "limit"
          ? ERROR_CODES.RATE_LIMITED
          : ERROR_CODES.VALIDATION_ERROR,
        result.code === "limit"
          ? "You can publish 3 themes per day. Try again tomorrow."
          : "That theme has no changes in it. Customize something first.",
        result.code === "limit" ? 429 : 400,
      );
    res.status(201).json({ ok: true, id: result.id });
  } catch (e) {
    console.error("theme publish error:", e);
    sendErrorResponse(res, ERROR_CODES.SERVER_ERROR, "Could not publish.", 500);
  }
});

app.post(`${API}/rooms/:id/join`, apiAuth, async (req, res) => {
  const room = state.rooms.get(req.params.id);
  if (!room)
    return sendErrorResponse(res, ERROR_CODES.NOT_FOUND, "Room not found", 404);
  if (
    (room.users || []).filter((u) => !u.isDev || !u.isVanished).length >=
    rooms.roomCapacity(room)
  )
    return sendErrorResponse(res, ERROR_CODES.ROOM_FULL, "Full", 400);
  if (room.type === "semi-private") {
    const validated = req.session?.validatedRooms?.[req.params.id];
    if (!validated) {
      if (!req.body.accessCode)
        return sendErrorResponse(
          res,
          ERROR_CODES.FORBIDDEN,
          "Access code required",
          403,
        );
      if (room.accessCode !== req.body.accessCode)
        return sendErrorResponse(res, ERROR_CODES.FORBIDDEN, "Wrong code", 403);
      if (req.session) {
        if (!req.session.validatedRooms) req.session.validatedRooms = {};
        req.session.validatedRooms[req.params.id] = req.body.accessCode;
        await promisifySessionSave(req.session).catch(() => {});
      }
    }
  }
  res.json({
    success: true,
    message: "Access granted. Connect via Socket.IO.",
  });
});

// ── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  await rooms.loadRooms();
  rooms.loadBoard(); // restore saved Talkoboard strokes for the loaded rooms
  rooms.registerSocketHandlers();
  rooms.startCleanupIntervals();
  nsfw.warmup(); // preload the puzzle image classifier

  setTimeout(() => {
    rooms.purgeAllGhostUsers();
    rooms.updateLobby();
  }, 2000);

  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || "0.0.0.0";
  server.listen(PORT, HOST, () => {
    const stats = rooms.getRoomStatistics();
    console.log(`
══════════════════════════════════════════════════════
  Talkomatic Server v${CONFIG.VERSIONS.SERVER} listening on ${HOST}:${PORT}
  Node.js ${process.version}
  Rooms: ${stats.totalRooms}/${stats.currentLimit} | Users: ${stats.totalUsers}
  Antibot: ${CONFIG.FEATURES.ENABLE_STRICT_ANTIBOT ? "ON" : "OFF"} | Bot Tokens: ${CONFIG.FEATURES.ENABLE_BOT_TOKENS ? "ON" : "OFF"}
  Dev Mode: ${CONFIG.DEV.KEY_HASH ? "CONFIGURED" : "NOT SET"}
  Session Secret: ${SESSION_SECRET ? "SET (persistent)" : "MISSING (ephemeral - sessions reset on restart)"}
══════════════════════════════════════════════════════`);
  });
}

// Shutdown is handled by beginShutdown() above (SIGINT/SIGTERM), which notifies
// clients, force-saves rooms, flushes the other stores, then exits.

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
