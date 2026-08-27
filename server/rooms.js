// server/rooms.js
// Room management, chat processing, AFK handling, socket events, cleanup.

const path = require("path");
const fs = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const {
  CONFIG,
  ERROR_CODES,
  wordFilter,
  state,
  createErrorResponse,
  normalize,
  promisifySessionSave,
  sanitizeMessage,
  sanitizeName,
  enforceCharacterLimit,
  enforceUsernameLimit,
  enforceLocationLimit,
  enforceRoomNameLimit,
  isReservedName,
  isGuestName,
  isListedName,
} = require("./state");
const {
  chatUpdateLimiter,
  typingLimiter,
  detectBotBehavior,
  isBlacklisted,
  createIPBasedUser,
  validateObject,
  isPresetAvatar,
} = require("./security");
const roles = require("./roles");
const audit = require("./audit");
const ipredact = require("./ipredact");
const linkfilter = require("./linkfilter");
const chatguard = require("./chatguard");
const nameguard = require("./nameguard");
const identity = require("./identity");
const modwatch = require("./modwatch");
const keywatch = require("./keywatch");
const applications = require("./applications");
const reports = require("./reports");
const appeals = require("./appeals");
const suggestions = require("./suggestions");
const rules = require("./rules");
const announcements = require("./announcements");
const banhistory = require("./banhistory");
const blocklist = require("./blocklist");
const ipban = require("./ipban");
const evasion = require("./evasion");
const diag = require("./diag");
const gamesFloor = require("./games");
const gamesSocket = require("./games/socket");
const staffchat = require("./staffchat");
const bots = require("./bots");
const crypto = require("crypto");

const gamePrevText = new Map();

// Everyone else sees the placeholder the moment it is typed. The person who
// typed it keeps their own text until they pause, because rewriting a box
// mid-word leaves them typing into the middle of a placeholder. On the pause
// their box catches up with what the room has been seeing all along.
const LINK_SETTLE_MS = 1200;
const linkSweepTimers = new Map();

function cancelLinkSweep(userId) {
  const t = linkSweepTimers.get(userId);
  if (t) {
    clearTimeout(t);
    linkSweepTimers.delete(userId);
  }
}

function armLinkSweep(socket, userId) {
  cancelLinkSweep(userId);
  const t = setTimeout(() => {
    linkSweepTimers.delete(userId);
    const raw = state.userMessageBuffers.get(userId) || "";
    const clean = linkfilter.redact(raw);
    if (clean === raw) return;
    state.userMessageBuffers.set(userId, clean);
    const username = socket.handshake?.session?.username;
    const diff = { type: "full-replace", text: clean };
    emitRoomChatUpdate(socket, { userId, username, diff });
    socket.emit("chat update", { userId, username, diff });
    socket.emit("links not allowed");
  }, LINK_SETTLE_MS);
  if (t.unref) t.unref();
  linkSweepTimers.set(userId, t);
}

const BAN_REF_SECRET = crypto.randomBytes(32);
function banRef(ip) {
  return crypto
    .createHmac("sha256", BAN_REF_SECRET)
    .update(String(ip))
    .digest("hex")
    .slice(0, 20);
}
function ipForBanRef(ref) {
  if (!ref) return null;
  for (const [ip] of state.blockedIPs) if (banRef(ip) === ref) return ip;
  return null;
}
const warnings = require("./warnings");

const REPORT_CATEGORIES = {
  spam: "Spam or flooding",
  harassment: "Harassment or bullying",
  hate: "Hate speech or slurs",
  nsfw: "NSFW or inappropriate content",
  impersonation: "Impersonation",
  threats: "Threats or violence",
  modabuse: "Moderator abuse",
  other: "Other",
};

const NEW_ROOM_MAX_CAPACITY = 10;

function roomCapacity(room) {
  const n = room && Number(room.maxSize);
  return Number.isFinite(n) && n >= 2
    ? Math.floor(n)
    : CONFIG.LIMITS.MAX_ROOM_CAPACITY;
}

const ROOM_CAPACITY_BY_ROLE = {
  user: NEW_ROOM_MAX_CAPACITY,
  jr: 15,
  mod: 25,
  dev: 50,
};

function roomCapacityCeiling(socket) {
  if (socket?.isDev) return ROOM_CAPACITY_BY_ROLE.dev;
  if (socket?.isMod)
    return (socket.modLevel || 2) >= 2
      ? ROOM_CAPACITY_BY_ROLE.mod
      : ROOM_CAPACITY_BY_ROLE.jr;
  return ROOM_CAPACITY_BY_ROLE.user;
}

function newRoomCapacity(want, socket) {
  const n = Math.floor(Number(want));
  if (!Number.isFinite(n)) return CONFIG.LIMITS.MAX_ROOM_CAPACITY;
  return Math.max(
    CONFIG.LIMITS.MAX_ROOM_CAPACITY,
    Math.min(roomCapacityCeiling(socket), n),
  );
}

function deviceTypeFromUA(ua) {
  if (!ua || typeof ua !== "string") return "unknown";

  const s = ua.toLowerCase();
  const E_READER_RE =
    /(kindle|pocketbook|kobo|nook|remarkable|noteair|nova[0-9]color|poke[0-9]color|tabultracpro|volta|kf[ot]t|kfsow[ai]|kfjw[ai]|kfthw[ai]|kfapw[ai])/i;

  if (/(talkobot|robot|crawler|spider|slurp|curl|wget|node)/i.test(s))
    return "bot";

  if (/(raspbian|raspberry pi)/i.test(s)) return "raspi";

  if (/(projector|projector build|smart projector|sti[0-9]+ build)/i.test(s))
    return "projector";

  if (/fridge|refrigerator|familyhub|family hub/i.test(s))
    return "refrigerator";

  if (
    /(oculusbrowser|vision pro|visionos|vive|valve index|windows mixed reality|pico|vr|xr|x4000)/i.test(
      s,
    )
  )
    return "vr";

  if (/(playstation|ps[1-5]|xbox|nintendo)/i.test(s)) return "console";

  if (
    /(watchos|apple watch|wear os|wearos|galaxy watch|tizen watch|smartwatch)/i.test(
      s,
    )
  )
    return "watch";

  if (
    /(smart-?tv|googletv|apple tv|tv safari|androidtv|crkey|roku|aft[a-z]|netcast|web0s|webos|tizen|hbbtv|bravia|viera)/i.test(
      s,
    )
  )
    return "tv";

  if (
    (/(ipad|tablet|playbook|portalgo)/i.test(s) ||
      (/android/i.test(s) && !/mobile/i.test(s))) &&
    !E_READER_RE.test(s)
  )
    return "tablet";

  if (E_READER_RE.test(s)) return "ereader";

  if (
    /(android automotive|androidauto|carplay|tesla|mbux|sync|qtcarbrowser)/i.test(
      s,
    )
  )
    return "car";

  if (/(blackberry|bb10|nokia)/i.test(s) && !/android/i.test(s))
    return "qwerty";

  if (
    /(mobi|iphone|ipod|android|blackberry|bb10|nokia|iemobile|opera mini|windows phone)/i.test(
      s,
    )
  )
    return "mobile";

  if (/(windows|macintosh|mac os|linux|cros|x11)/i.test(s)) return "desktop";

  return "unknown";
}

function io() {
  return state.io;
}

// ── Talkoboard: Server-Side Stroke Storage (ephemeral) ──────────────────────

const boardState = new Map();
const MAX_BOARD_STROKES = 2000;
const MAX_POINTS_PER_STROKE = 5000;

function getBoardState(roomId) {
  if (!boardState.has(roomId)) {
    boardState.set(roomId, { strokes: [], active: new Map() });
  }
  return boardState.get(roomId);
}

function cleanupBoardState(roomId) {
  boardState.delete(roomId);
}

// ── Claimed areas: a patch of board that is yours ───────────────────────────
const CLAIM_MIN = 120;
const CLAIM_MAX = 1800;

function boardClaims(bs) {
  if (!Array.isArray(bs.claims)) bs.claims = [];
  return bs.claims;
}

function claimsOverlap(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function foreignClaimAt(bs, userId, x, y) {
  for (const c of boardClaims(bs)) {
    if (c.owner === userId) continue;
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
  }
  return null;
}

function segmentHitsRect(x1, y1, x2, y2, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

function pointInRings(rings, pt) {
  let inside = false;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (
        a.y > pt.y !== b.y > pt.y &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
  }
  return inside;
}

function claimCrossed(socket, bs, x1, y1, x2, y2) {
  if (isStaffSocket(socket)) return null;
  const userId = socket.handshake.session?.userId;
  for (const c of boardClaims(bs)) {
    if (c.owner === userId) continue;
    if (segmentHitsRect(x1, y1, x2, y2, c)) return c;
  }
  return null;
}

function claimBlocking(socket, bs, x, y) {
  if (isStaffSocket(socket)) return null;
  return foreignClaimAt(bs, socket.handshake.session?.userId, x, y);
}

function sendClaims(roomId) {
  const bs = boardState.get(roomId);
  if (!io() || !bs) return;
  const all = boardClaims(bs).map((c) => ({
    owner: c.owner,
    name: c.name,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    away: !!c.away,
  }));
  const room = state.rooms.get(roomId);
  const byId = new Map((room?.users || []).map((u) => [u.id, u]));
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    const claims = all.filter((c) => {
      const owner = byId.get(c.owner);
      return !owner || canRecipientSeeDevUser(recipient, owner);
    });
    recipient.emit("board claims", { claims });
  }
}

const CLAIM_GRACE_MS = 5 * 60 * 1000;

function markBoardClaimAway(roomId, userId) {
  const bs = boardState.get(roomId);
  if (!bs || !Array.isArray(bs.claims)) return;
  let changed = false;
  for (const c of bs.claims)
    if (c.owner === userId && !c.away) {
      c.away = Date.now();
      changed = true;
    }
  if (changed) sendClaims(roomId);
}

function markBoardClaimBack(roomId, userId) {
  const bs = boardState.get(roomId);
  if (!bs || !Array.isArray(bs.claims)) return;
  let changed = false;
  for (const c of bs.claims)
    if (c.owner === userId && c.away) {
      delete c.away;
      changed = true;
    }
  if (changed) sendClaims(roomId);
}

function sweepBoardClaims() {
  const now = Date.now();
  for (const [roomId, bs] of boardState) {
    if (!bs || !Array.isArray(bs.claims) || !bs.claims.length) continue;
    const kept = bs.claims.filter(
      (c) => !c.away || now - c.away < CLAIM_GRACE_MS,
    );
    if (kept.length !== bs.claims.length) {
      bs.claims = kept;
      sendClaims(roomId);
    }
  }
}

// ── Keeping one person from burying the board ───────────────────────────────
const BOARD_ADD_BURST = 8;
const BOARD_ADD_WINDOW = 6000;
const BOARD_ADD_COOLDOWN = 15000;
const boardAddTimes = new Map();

function allowBoardAdd(userId) {
  const now = Date.now();
  if (boardAddTimes.size > 500)
    for (const [uid, rec] of boardAddTimes)
      if (
        now > (rec.until || 0) &&
        !(rec.times || []).some((t) => now - t < BOARD_ADD_WINDOW)
      )
        boardAddTimes.delete(uid);

  const rec = boardAddTimes.get(userId) || { times: [], until: 0 };
  if (now < rec.until) return 0;
  rec.times = rec.times.filter((t) => now - t < BOARD_ADD_WINDOW);
  if (rec.times.length >= BOARD_ADD_BURST) {
    rec.until = now + BOARD_ADD_COOLDOWN;
    rec.times = [];
    boardAddTimes.set(userId, rec);
    return 0;
  }
  rec.times.push(now);
  boardAddTimes.set(userId, rec);
  return 1;
}

function boardAddWaitMs(userId) {
  const rec = boardAddTimes.get(userId);
  return rec ? Math.max(0, (rec.until || 0) - Date.now()) : 0;
}

function trimBoard(bs) {
  let guard = 0;
  while (bs.strokes.length > MAX_BOARD_STROKES && guard++ < 200) {
    const counts = new Map();
    for (const s of bs.strokes)
      counts.set(s.owner, (counts.get(s.owner) || 0) + 1);
    let heaviest = null;
    let most = 0;
    for (const [owner, n] of counts)
      if (n > most) {
        most = n;
        heaviest = owner;
      }
    const idx = bs.strokes.findIndex((s) => s.owner === heaviest);
    bs.strokes.splice(idx === -1 ? 0 : idx, 1);
  }
  if (bs.strokes.length > MAX_BOARD_STROKES)
    bs.strokes = bs.strokes.slice(-MAX_BOARD_STROKES);
}

// ── Taking somebody's pen away ──────────────────────────────────────────────
const BOARD_BAR_MS = 10 * 60 * 1000;

function boardBarMap(bs) {
  if (!bs.barred) bs.barred = new Map();
  return bs.barred;
}

function boardBarredUntil(roomId, userId) {
  const bs = boardState.get(roomId);
  if (!bs || !bs.barred || !userId) return 0;
  const until = bs.barred.get(userId) || 0;
  if (until && until <= Date.now()) {
    bs.barred.delete(userId);
    return 0;
  }
  return until;
}

function finalizeBoardUserStroke(roomId, userId) {
  const bs = boardState.get(roomId);
  if (!bs) return;
  const active = bs.active.get(userId);
  if (active && active.points && active.points.length > 0) {
    bs.strokes.push(active);
    trimBoard(bs);
    saveBoardSoon();
  }
  bs.active.delete(userId);
}

const MAX_RINGS_PER_STROKE = 256;

function sanitizeRings(rings, budget) {
  if (!Array.isArray(rings)) return null;
  const out = [];
  let left = budget;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const pts = [];
    for (const p of ring) {
      if (typeof p?.x !== "number" || typeof p?.y !== "number") continue;
      pts.push({ x: p.x, y: p.y });
      if (--left <= 0) break;
    }
    if (left <= 0 && pts.length < ring.length) break;
    if (pts.length >= 3) out.push(pts);
    if (out.length >= MAX_RINGS_PER_STROKE || left <= 0) break;
  }
  return out.length ? out : null;
}

function sanitizeGradient(g) {
  if (!Array.isArray(g)) return null;
  const out = [];
  for (const c of g) {
    if (typeof c === "string" && /^#[0-9a-fA-F]{3,6}$/.test(c))
      out.push(c.slice(0, 7));
    if (out.length >= 8) break;
  }
  return out.length >= 2 ? out : null;
}

// ── Talkoboard persistence ──────────────────────────────────────────────────
const BOARD_PATH = path.join(DATA_DIR, "board.json");
let boardSavePending = false;

function serializeBoards() {
  const out = {};
  for (const [roomId, bs] of boardState) {
    if (bs && Array.isArray(bs.strokes) && bs.strokes.length) {
      out[roomId] = bs.strokes;
    }
  }
  return out;
}

async function saveBoard() {
  try {
    const tmp = BOARD_PATH + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(serializeBoards()), "utf8");
    await fs.rename(tmp, BOARD_PATH);
  } catch (e) {
    console.error("Error saving board:", e);
  }
}

function saveBoardSoon() {
  if (boardSavePending) return;
  boardSavePending = true;
  setTimeout(() => {
    boardSavePending = false;
    saveBoard().catch(() => {});
  }, 10000);
}

function saveBoardSync() {
  try {
    const fsSync = require("fs");
    const tmp = BOARD_PATH + ".tmp";
    fsSync.writeFileSync(tmp, JSON.stringify(serializeBoards()), "utf8");
    fsSync.renameSync(tmp, BOARD_PATH);
  } catch (e) {
    console.error("Board flush failed:", e);
  }
}

function loadBoard() {
  try {
    const raw = require("fs").readFileSync(BOARD_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    let n = 0;
    for (const [roomId, strokes] of Object.entries(obj)) {
      if (!state.rooms.has(roomId) || !Array.isArray(strokes)) continue;
      boardState.set(roomId, {
        strokes: strokes.slice(-MAX_BOARD_STROKES),
        active: new Map(),
      });
      n++;
    }
    if (n) console.log(`Loaded board strokes for ${n} room(s).`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading board:", err);
  }
}

// ── User Counting ───────────────────────────────────────────────────────────

function getUserRoomsCount(userId) {
  for (const [id, room] of state.rooms) {
    if (diag.isSimRoom(id)) continue;
    if (room.users && room.users.some((u) => u.id === userId)) return 1;
  }
  return 0;
}

function getUsernameLocationRoomsCount(username, location, excludeUserId) {
  const uLow = normalize(username);
  const lLow = normalize(location);
  for (const [id, room] of state.rooms) {
    if (diag.isSimRoom(id)) continue;
    if (!room.users) continue;
    for (const u of room.users) {
      if (excludeUserId && u.id === excludeUserId) continue;
      if (normalize(u.username) === uLow && normalize(u.location) === lLow) {
        if (findSocketByUserId(u.id)) return 1;
      }
    }
  }
  return 0;
}

function getUserCurrentRoom(userId) {
  for (const [roomId, room] of state.rooms) {
    if (room.users && room.users.some((u) => u.id === userId)) return roomId;
  }
  return null;
}

// Same lookup for the "you are already in a room" guard a person hits on their
// own join. Nobody real is ever inside a sim room, so those can be skipped,
// which is what keeps joining fast while a test is running. Staff actions must
// keep using getUserCurrentRoom, which still looks everywhere.
function getOwnCurrentRoom(userId) {
  for (const [roomId, room] of state.rooms) {
    if (diag.isSimRoom(roomId)) continue;
    if (room.users && room.users.some((u) => u.id === userId)) return roomId;
  }
  return null;
}

// ── Anti-Spam: Per-IP Room Counting ─────────────────────────────────────────

function getRoomCountByIP(clientIp) {
  if (!io() || !clientIp) return 0;
  const roomIds = new Set();
  for (const [, s] of io().sockets.sockets) {
    if (s.clientIp === clientIp && s.roomId) {
      roomIds.add(s.roomId);
    }
  }
  return roomIds.size;
}

// ── Anti-Spam: Pressure System ──────────────────────────────────────────────

function getSoloRoomTTL() {
  const totalRooms = state.rooms.size;
  const tiers = CONFIG.LIMITS.PRESSURE_TIERS;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalRooms >= tiers[i].threshold) return tiers[i].ttl;
  }
  return tiers[0].ttl;
}

function isHealthyRoom(room) {
  if (room.users && room.users.length >= 2) return true;
  const age = Date.now() - (room.createdAt || room.lastActiveTime || 0);
  return age < CONFIG.LIMITS.HEALTHY_ROOM_AGE_MS;
}

function getHealthyRoomCount() {
  let count = 0;
  for (const [id, room] of state.rooms) {
    if (diag.isSimRoom(id)) continue;
    if (isHealthyRoom(room)) count++;
  }
  return count;
}

async function pressureCleanup() {
  const now = Date.now();
  const ttl = getSoloRoomTTL();
  const toDelete = [];

  for (const [roomId, room] of state.rooms) {
    if (room.users && room.users.length >= 2) continue;
    if (room.users && room.users.length === 1) {
      const soloSince = state.roomSoloSince.get(roomId);
      if (soloSince && now - soloSince >= ttl) {
        const soloSocket = findSocketByUserId(room.users[0].id, roomId);
        if (soloSocket && (soloSocket.isDev || soloSocket.isMod)) continue;
        toDelete.push(roomId);
      }
    } else if (!room.users || room.users.length === 0) {
      if (now - room.lastActiveTime > CONFIG.TIMING.ROOM_DELETION_TIMEOUT) {
        toDelete.push(roomId);
      }
    }
  }

  if (toDelete.length === 0) return;

  for (const roomId of toDelete) {
    const room = state.rooms.get(roomId);
    if (!room) continue;

    if (room.users && room.users.length === 1) {
      const soloUser = room.users[0];
      const soloSocket = findSocketByUserId(soloUser.id, roomId);
      if (soloSocket) {
        soloSocket.emit("afk timeout", {
          message:
            "Your room was closed due to extended single-occupancy. " +
            "You can create a new room anytime.",
          redirectTo: "/",
        });
        await leaveRoom(soloSocket, soloUser.id);
      }
    }

    state.rooms.delete(roomId);
    gamesFloor.roomClosed(roomId);
    state.roomSoloSince.delete(roomId);
    state.roomLastChatActivity.delete(roomId);
    cleanupBoardState(roomId);
    if (state.roomDeletionTimers.has(roomId)) {
      clearTimeout(state.roomDeletionTimers.get(roomId));
      state.roomDeletionTimers.delete(roomId);
    }
  }

  updateLobby();
  await debouncedSaveRooms();
  const currentTTL = Math.round(ttl / 1000);
  console.log(
    `[PRESSURE] Cleaned ${toDelete.length} solo room(s) | ` +
      `Total: ${state.rooms.size} | TTL: ${currentTTL}s`,
  );
}

function updateRoomSoloTracking(roomId) {
  const room = state.rooms.get(roomId);
  if (!room) {
    state.roomSoloSince.delete(roomId);
    return;
  }
  if (room.users && room.users.length === 1) {
    if (!state.roomSoloSince.has(roomId)) {
      state.roomSoloSince.set(roomId, Date.now());
    }
  } else {
    state.roomSoloSince.delete(roomId);
  }
}

function findSocketByUserId(userId, roomId) {
  if (!io()) return null;
  for (const [, s] of io().sockets.sockets) {
    if (
      s.handshake?.session?.userId === userId &&
      (!roomId || s.roomId === roomId)
    ) {
      return s;
    }
  }
  return null;
}

// ── Staff Helpers (mod / dev) ───────────────────────────────────────────────

function isStaffSocket(socket) {
  return !!(socket && (socket.isDev || socket.isMod));
}

function findSocketsByUserId(userId) {
  const result = [];
  if (!io() || !userId) return result;
  for (const [, s] of io().sockets.sockets) {
    if (s.handshake?.session?.userId === userId) result.push(s);
  }
  return result;
}

function findSocketsByIp(ip) {
  const result = [];
  if (!io() || !ip) return result;
  for (const [, s] of io().sockets.sockets) {
    if (s.clientIp === ip) result.push(s);
  }
  return result;
}

function getUserStaffRole(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (s.isDev) return "dev";
    if (s.isMod) return "mod";
  }
  return null;
}

function isUserStaffHidden(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (!s.isDev && !s.isMod) continue;
    if (s.isMainDev) return false;
    if (s.isVanished) return false;
    if (s.isHidden) return true;
  }
  return false;
}

function getUserModLevel(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (s.isMod) return s.modLevel || 2;
  }
  return 0;
}

function canActOn(actorSocket, targetUserId) {
  const targetRole = getUserStaffRole(targetUserId);
  if (actorSocket?.isDev) return targetRole !== "dev";
  if (actorSocket?.isMod) return targetRole === null;
  return false;
}

function canManageNotesOn(actorSocket, targetUserId) {
  if (!actorSocket) return false;
  if (actorSocket.isDev) return true;
  if (!actorSocket.isMod || (actorSocket.modLevel || 2) < 1) return false;
  const targetRole = getUserStaffRole(targetUserId);
  return targetRole === null || targetRole === "mod";
}

function requireStaff(socket) {
  if (isStaffSocket(socket)) return true;
  socket.emit(
    "error",
    createErrorResponse(ERROR_CODES.FORBIDDEN, "Staff access required."),
  );
  return false;
}

function requireDev(socket) {
  if (socket?.isDev) return true;
  socket.emit(
    "error",
    createErrorResponse(ERROR_CODES.FORBIDDEN, "Dev access required."),
  );
  return false;
}

function requireModLevel(socket, minLevel) {
  if (socket?.isDev) return true;
  if (socket?.isMod && (socket.modLevel || 2) >= minLevel) return true;
  socket.emit(
    "error",
    createErrorResponse(
      ERROR_CODES.FORBIDDEN,
      "This action needs a higher moderator level.",
    ),
  );
  return false;
}

// ── One key, one person ─────────────────────────────────────────────────────
function judgeStaffKey(hash, role, label) {
  if (!hash || keywatch.wasHandled(hash)) return;

  if (roles.isMainDevHash(hash)) return;
  const call = keywatch.verdict(hash);
  if (!call) return;
  const who = keywatch.summary(hash);
  const nets = [...new Set(who.flatMap((h) => h.networks))];

  if (call === "watch") {
    keywatch.markHandled(hash);
    audit.recordKeyAlert({
      role,
      label,
      kind: "concurrent",
      detail:
        `The ${role} key "${label}" is being held by ${who.length} browsers at once, ` +
        `sharing a network. Probably one person on two machines in one place - ` +
        `worth knowing, not acted on.`,
    });
    return;
  }

  keywatch.markHandled(hash);
  const headline = `ALERT 👑 ${label} key from multiple accounts`;
  const detail =
    `${headline}. ${who.length} separate clients on ${nets.length} different networks ` +
    `were holding it at the same time (${nets.join(", ")}).` +
    (role === "dev"
      ? " Dev keys cannot be revoked at runtime - change DEV_KEY_HASH."
      : " The key has been revoked.");

  audit.recordKeyAlert({ role, label, kind: "shared", detail });
  audit.recordNotification({
    kind: "abuse",
    role,
    label,
    text: detail,
    minLevel: 2,
    card: {
      target: label,
      targetRole: role,
      reason: "One key, two accounts, at the same time",
      lines: nets.map((n) => "seen on " + n),
    },
  });
  console.warn("[KEYWATCH]", detail);

  if (role !== "mod") return;
  revokeSharedKey(hash, label, headline);
}

async function revokeSharedKey(hash, label, headline) {
  try {
    const ok = await roles.revokeModKey(hash, {
      reason:
        "Revoked automatically: the key was in use by two separate accounts, " +
        "on two different networks, at the same time.",
      by: "system",
    });
    if (!ok) return;
    roles.modLog({
      label,
      action: "auto-revoke shared key",
      target: hash.slice(0, 8),
    });
    for (const [, s] of io().sockets.sockets) {
      if (!s.isMod || s.modKeyHash !== hash) continue;
      s.isMod = false;
      s.modKeyHash = null;
      s.modLevel = 0;
      s.staffLabel = null;
      const uid = s.handshake?.session?.userId;
      if (uid && s.roomId) {
        const room = state.rooms.get(s.roomId);
        const u = room?.users?.find((x) => x.id === uid);
        if (u) {
          u.isMod = false;
          updateRoom(s.roomId);
          updateLobby();
        }
      }
      s.emit("staff revoked", { reason: headline });
    }
    for (const [, s] of io().sockets.sockets)
      if (s.isDev) {
        s.emit("dev mod keys", roles.listModKeys(roles.viewFor(s)));
        s.emit("dev former mods", roles.listFormerMods(roles.viewFor(s)));
      }
    staffchat.rosterDirty();
  } catch (e) {
    console.error("auto-revoke of shared key failed:", e);
  }
}

function settleQueueItem(qkind, itemId) {
  try {
    staffchat.settleQueue(
      (m) => m.qkind === qkind && m.card && m.card.itemId === Number(itemId),
    );
  } catch (_) {}
}

function logStaff(socket, action, target, room, details) {
  const roleTag = socket?.isDev ? "dev" : "mod";
  const label = socket?.staffLabel || roleTag;
  let targetStr = null;
  if (typeof target === "string") targetStr = target === "-" ? null : target;
  else if (target && typeof target === "object") {
    const name = target.username || target.name || "?";
    const id = target.id || target.userId || "?";
    targetStr = `user:${name}(${id})`;
  }
  let roomTag = null;
  if (typeof room === "string") roomTag = room === "-" ? null : room;
  else if (room && typeof room === "object")
    roomTag = `room:${room.name || "?"}(${room.id || "?"})`;
  audit.recordAction({
    roleTag,
    label,
    action,
    target: targetStr,
    room: roomTag,
    ip: socket?.clientIp || null,
    details: details || null,
  });
  try {
    staffchat.noteStaffAction(label, action, targetStr, roomTag, roleTag);
  } catch (_) {}
  if (socket?.isMod && !socket?.isDev)
    modwatch.record({
      hash: socket.modKeyHash,
      label,
      role: roleTag,
      action,
      target: targetStr,
      room: roomTag,
      ip: socket.clientIp || null,
    });
}

function resolveOfflineTarget(targetUserId) {
  const lk = reports.lastKnown(targetUserId);
  if (!lk) return null;
  let ip = lk.ip;
  if (!ip && lk.deviceId) {
    const rec = identity.getRecord(lk.deviceId);
    if (rec && rec.ips) {
      let best = null,
        bestN = -1;
      for (const k of Object.keys(rec.ips))
        if (rec.ips[k] > bestN) {
          best = k;
          bestN = rec.ips[k];
        }
      ip = best;
    }
  }
  return {
    ip: ip || null,
    name: lk.name || null,
    role: lk.role || null,
    deviceId: lk.deviceId || null,
  };
}

function buildReportsList(view) {
  const showIp = !!(view && view.ip);
  return reports.summary().map((s) => {
    const targets = findSocketsByUserId(s.targetKey);
    const online = targets.length > 0;
    let name = s.name;
    let roomName = null;
    let canBanOffline = false;
    const lk = reports.lastKnown(s.targetKey) || {};
    let targetDeviceId = lk.deviceId || null;
    let targetIp = lk.ip || null;
    if (online) {
      const rid = getUserCurrentRoom(s.targetKey);
      const room = rid ? state.rooms.get(rid) : null;
      const u = room?.users.find((x) => x.id === s.targetKey);
      name =
        (u && u.username) || targets[0].handshake?.session?.username || name;
      roomName = room?.name || null;
      targetIp = targets[0].clientIp || targetIp;
      targetDeviceId = targets[0].deviceId || targetDeviceId;
    } else {
      const off = resolveOfflineTarget(s.targetKey);
      canBanOffline = !!off?.ip;
      if (off?.name) name = off.name;
      targetIp = off?.ip || targetIp;
      targetDeviceId = off?.deviceId || targetDeviceId;
    }
    return {
      targetUserId: s.targetKey,
      targetDeviceId,
      ip: showIp ? targetIp : undefined,
      name: name || "(unknown user)",
      total: s.total,
      distinct: s.distinct,
      categories: s.categories,
      online,
      roomName,
      canBanOffline,
      first: s.first,
      last: s.last,
      reasons: reports
        .forTarget(s.targetKey)
        .reverse()
        .map((r) => ({
          category: r.category,
          reason: r.reason,
          by: r.byName,
          at: r.at,
          targetText: showIp
            ? r.targetText || null
            : audit.maskIps(r.targetText || null),
        })),
    };
  });
}

const NO_MORE_APPEALS =
  "You will not be able to file another appeal. This decision is final.";

function buildAppealsList(view) {
  const showIp = !!(view && view.ip);
  return appeals.list().map((a) => {
    const stillBlocked = ipban.findActiveBlock(a.ip) !== null;
    const ban = a.ban || {};
    const bar = appeals.barFor({
      ip: a.ip,
      deviceId: a.deviceId,
      userId: a.userId,
    });
    return {
      id: a.id,
      name: a.name || null,
      userId: a.userId || null,
      deviceId: a.deviceId || null,
      ip: showIp ? a.ip : undefined,
      message: a.message || "",
      at: a.at,
      status: a.status,
      resolution: a.resolution || null,
      reviewedBy: showIp
        ? a.reviewedBy || null
        : roles.teamReviewer(a.reviewedBy, view),
      reviewedAt: a.reviewedAt || null,
      stillBlocked,
      barId: bar ? bar.id : null,
      barredBy: bar
        ? showIp
          ? bar.by || null
          : roles.enforcedLabel(bar.by, bar.byRole, view)
        : null,
      barredAt: bar ? bar.at : null,
      banBy: showIp
        ? ban.by || null
        : roles.enforcedLabel(ban.by, ban.byRole, view),
      banReason: showIp
        ? ban.reason || null
        : audit.maskIps(ban.reason || null),
      banPermanent: !!ban.permanent,
      banExpiry: ban.expiry || 0,
      banAt: ban.ts || null,
      locked: !!a.locked,
      lockedBy: showIp
        ? a.lockedBy || null
        : roles.teamReviewer(a.lockedBy, view),
      reopenedBy: showIp
        ? a.reopenedBy || null
        : roles.teamReviewer(a.reopenedBy, view),
      messages: (a.messages || []).map((m) => {
        const staffMsg = m.from === "staff";
        const shownBy =
          staffMsg && !showIp
            ? roles.teamLabel(m.by, m.role, view)
            : m.by || null;
        const named = !staffMsg || shownBy === (m.by || null);
        return {
          id: m.id,
          ts: m.ts,
          from: m.from,
          by: shownBy,
          role: m.role || null,
          level: named ? (m.level == null ? null : m.level) : null,
          avatar: named ? m.avatar || null : null,
          text:
            !showIp && m.from === "system"
              ? roles.stripStaffNames(m.text || "", view)
              : m.text || "",
          reply:
            m.reply && !showIp && m.reply.from === "staff"
              ? { ...m.reply, by: roles.teamReviewer(m.reply.by, view) }
              : m.reply || null,
        };
      }),
      waiting:
        a.status === "open" &&
        (a.messages || []).length > 0 &&
        a.messages[a.messages.length - 1].from === "user",
    };
  });
}

function broadcastAppealsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff appeals", buildAppealsList(roles.viewFor(s)));
}

function buildSuggestionsList(view) {
  const forDev = !!(view && view.names);
  return suggestions.list().map((s) => ({
    id: s.id,
    name: s.name || null,
    userId: forDev ? s.userId || null : undefined,
    text: s.text || "",
    at: s.at,
    status: s.status,
    resolution: s.resolution || null,
    reviewedBy: roles.teamReviewer(s.reviewedBy, view),
    reviewedAt: s.reviewedAt || null,
  }));
}

function broadcastSuggestionsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff suggestions", buildSuggestionsList(roles.viewFor(s)));
}

// ── Community suggestion board ──────────────────────────────────────────────
function boardRole(socket) {
  if (socket.isMainDev) return "user";
  if (socket.isDev) return "dev";
  if (socket.isMod) return (socket.modLevel || 2) >= 2 ? "mod" : "jr";
  return "user";
}

function boardPayloadFor(socket) {
  return {
    posts: suggestions.publicList({
      deviceId: socket.deviceId || null,
      isDev: !!socket.isDev,
      isStaff: !!socket.isDev || !!socket.isMod,
    }),
    remaining: suggestions.remainingPosts(
      socket.deviceId || null,
      socket.clientIp || null,
    ),
    canModerate: !!socket.isDev || !!socket.isMod,
    isDev: !!socket.isDev,
    role: boardRole(socket),
  };
}

function broadcastBoard() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (s.suggestBoardOpen) {
      s.emit("board data", boardPayloadFor(s));
      continue;
    }
    if (s.boardSince != null && s.deviceId)
      s.emit("board badges", suggestions.unreadFor(s.deviceId, s.boardSince));
  }
}

function broadcastAnnouncement(changed) {
  if (!io()) return;
  const cur = announcements.current();
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !s.announceSub) continue;
    s.emit(
      "announcement current",
      announcements.publicOne(cur, s.deviceId || null),
    );
  }
  try {
    const row = changed
      ? announcements.publicOne(announcements.get(changed), null)
      : null;
    if (row) staffchat.pushAnnounce(row);
    else
      staffchat.pushAnnounce(cur ? announcements.publicOne(cur, null) : null);
  } catch (_) {}
}

function announceAppeal(id) {
  const a = appeals.get(id);
  if (!a) return;
  audit.recordNotification({
    kind: "appeal",
    text: `${a.name || "A banned user"} submitted a ban appeal.`,
    target: a.userId ? `user:${a.name || "user"}(${a.userId})` : null,
    by: a.name || null,
    minLevel: 2,
    card: {
      ids: [a.userId, a.deviceId].filter(Boolean),
      by: a.name || "A banned user",
      itemId: id,
      deviceId: a.deviceId || null,
      reason: a.message || null,
      lines: a.ban && a.ban.reason ? ["Banned for: " + a.ban.reason] : null,
    },
  });
  broadcastAppealsList();
  broadcastAppeal(id);
}

function requeueAppeal(id, text) {
  const a = appeals.get(id);
  if (!a) return;
  try {
    staffchat.systemQueues("appeal", text, {
      minLevel: 2,
      card: {
        ids: [a.userId, a.deviceId].filter(Boolean),
        by: a.name || "A banned user",
        itemId: id,
        deviceId: a.deviceId || null,
        reason: a.message || null,
        lines: a.ban && a.ban.reason ? ["Banned for: " + a.ban.reason] : null,
      },
    });
  } catch (_) {}
}

function announceAppealMessage(id) {
  broadcastAppealsList();
  broadcastAppeal(id);
  const a = appeals.get(id);
  if (!a || !io()) return;
  const text = `${a.name || "A banned user"} replied to their appeal.`;
  for (const [, s] of io().sockets.sockets)
    if (s.isDev || (s.isMod && (s.modLevel || 2) >= 2))
      s.emit("staff notice", { text });
}

function broadcastAppeal(id) {
  if (!io()) return;
  const a = appeals.get(id);
  if (!a) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || s.deskAppealId !== id) continue;
    if (!(s.isDev || (s.isMod && (s.modLevel || 2) >= 2))) continue;
    s.emit(
      "staff appeal",
      buildAppealsList(roles.viewFor(s)).find((x) => x.id === id),
    );
  }
}

function reviewerPublicName(value) {
  const s = String(value || "");
  if (!s) return null;
  const idx = s.indexOf(":");
  const role = idx === -1 ? null : s.slice(0, idx);
  const label = idx === -1 ? s : s.slice(idx + 1);
  return roles.teamLabel(label, role, null) || null;
}

function appStatusPayload(deviceId, isStaff) {
  const a = applications.latestForDevice(deviceId);
  if (!a) return { has: false };
  let status = a.status;
  let reason = a.reason || null;
  if (status === "approved" && a.claimed && !isStaff) {
    status = "revoked";
    reason = null;
  }
  return {
    has: true,
    status,
    reason,
    by:
      status === "approved" || status === "rejected"
        ? reviewerPublicName(a.reviewedBy)
        : null,
    reviewedAt: a.reviewedAt || null,
    submittedAt: a.submittedAt || null,
  };
}

function sendAppsList(s) {
  if (!s) return;
  const view = roles.viewFor(s);
  const showIp = !!view.ip;
  s.emit(
    "mod applications",
    applications.list().map((a) => ({
      id: a.id,
      username: a.username,
      answers: a.answers,
      submittedAt: a.submittedAt,
      status: a.status,
      reviewedBy: showIp
        ? a.reviewedBy
        : roles.teamReviewer(a.reviewedBy, view),
      reviewedAt: a.reviewedAt,
      reason: a.reason,
      claimed: a.claimed,
      deviceId: a.deviceId || null,
      discord: a.discord || null,
      discordId: a.discordId || null,
      ip: showIp ? a.ip : undefined,
    })),
  );
  s.emit("applications state", { open: !!applications.isOpen() });
}

function broadcastAppsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)) sendAppsList(s);
}

function broadcastApplicationsState() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    s.emit("applications state", { open: !!applications.isOpen() });
}

function broadcastReportsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff reports", buildReportsList(roles.viewFor(s)));
}

function clearReportAfterAction(socket, targetUserId) {
  if (!targetUserId || !reports.clear(targetUserId)) return;
  broadcastReportsList();
  socket.emit("staff reports", buildReportsList(roles.viewFor(socket)));
}

function broadcastBlockList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("dev blocks", buildBlockList(roles.viewFor(s)));
}

function broadcastBanHistory() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff ban history", buildBanHistory(roles.viewFor(s)));
  try {
    staffchat.pushBans();
  } catch (_) {}
}

function applyNamePolicy(socket, username) {
  if (!socket || socket.isDev || socket.isMod) return;
  if (!isListedName(username)) return;
  const wait = 4000 + Math.floor(Math.random() * 7000);
  setTimeout(() => {
    settleNamePolicy(socket, username).catch(() => {});
  }, wait);
}

async function settleNamePolicy(socket, username) {
  const ip = socket.clientIp || null;
  const did = socket.deviceId || null;
  if (!ip && !did) return;

  const entry = {
    expiry: Number.MAX_SAFE_INTEGER,
    label: username || null,
    by: null,
    ts: Date.now(),
    reason: null,
    did,
  };
  if (ip) state.blockedIPs.set(ip, { ...entry });
  if (did) state.blockedIPs.set(ipban.idKey(did), { ...entry });
  blocklist.saveSoon();
  evasion.invalidate();
  banhistory.record({
    ip: ip || ipban.idKey(did),
    name: username || null,
    action: "ban",
    duration: "permanent",
  });
  broadcastBlockList();
  broadcastBanHistory();

  const affected = new Set(ip ? findSocketsByIp(ip) : []);
  if (did && io())
    for (const [, s] of io().sockets.sockets)
      if (s.deviceId === did) affected.add(s);
  for (const s of affected) {
    try {
      const uid = s.handshake?.session?.userId;
      s.emit("kicked", {
        message: "Your connection has been blocked by staff.",
      });
      if (s.roomId && uid) await leaveRoom(s, uid);
      s.disconnect(true);
    } catch (_) {}
  }
}

const staffKeyAttempts = new Map();
const STAFF_KEY_MAX_ATTEMPTS = 15;
const STAFF_KEY_WINDOW = 5 * 60 * 1000;

function buildBlockList(view) {
  const showIp = !!(view && view.ip);
  const now = Date.now();
  const out = [];
  const live = [];
  for (const [ip, b] of state.blockedIPs) {
    const expiry = b && typeof b === "object" ? b.expiry : b;
    if (expiry && expiry !== Number.MAX_SAFE_INTEGER && now >= expiry) continue;
    live.push(ip);
  }
  const seenByKey = identity.devicesByKeys(
    ipban.prepareKeys(live),
    ipban.keysCovering,
  );

  for (const [ip, b] of state.blockedIPs) {
    const expiry = b && typeof b === "object" ? b.expiry : b;
    if (expiry && expiry !== Number.MAX_SAFE_INTEGER && now >= expiry) continue;
    const isId = ipban.isIdKey(ip);
    let matched;
    if (isId) {
      const rec = identity.getRecord(ip.slice(3));
      matched = rec
        ? [
            {
              id: ip.slice(3),
              name: rec.name || null,
              ips: Object.keys(rec.ips || {}),
              last: rec.last || 0,
            },
          ]
        : [];
    } else {
      matched = seenByKey.get(ip) || [];
    }
    out.push({
      ip: showIp ? ip : undefined,
      ref: banRef(ip),
      kind: isId ? "id" : ipban.isRangeKey(ip) ? "range" : "ip",
      did: (b && typeof b === "object" && b.did) || (isId ? ip.slice(3) : null),
      label: (b && b.label) || (isId && matched[0] && matched[0].name) || null,
      by: showIp
        ? (b && b.by) || null
        : roles.enforcedLabel((b && b.by) || null, b && b.byRole, view),
      reason: showIp
        ? (b && b.reason) || null
        : audit.maskIps((b && b.reason) || null),
      permanent: ipban.isPermanentBlock(b),
      expiry: expiry || 0,
      ts: (b && typeof b === "object" && b.ts) || null,
      bans: banhistory.countBans(ip),
      userCount: matched.length,
      users: matched.map((d) =>
        showIp
          ? { id: d.id, name: d.name, ips: d.ips, last: d.last }
          : { id: d.id, name: d.name || "Unknown", last: d.last },
      ),
    });
  }
  return out;
}

function buildBanHistory(view) {
  const showIp = !!(view && view.ip);
  return banhistory.recent(200).map((e) => ({
    id: e.id,
    name: e.name,
    action: e.action,
    by: showIp ? e.by : roles.enforcedLabel(e.by, e.byRole, view),
    at: e.at,
    reason: showIp ? e.reason : audit.maskIps(e.reason),
    duration: e.duration,
    kind: ipban.isIdKey(e.ip)
      ? "id"
      : e.ip && String(e.ip).includes("/")
        ? "range"
        : "ip",
    ip: showIp ? e.ip : undefined,
  }));
}

// ── Room Utilities ──────────────────────────────────────────────────────────

function calculateCurrentRoomLimit() {
  if (!CONFIG.FEATURES.ENABLE_DYNAMIC_SCALING)
    return CONFIG.LIMITS.BASE_MAX_ROOMS;
  const total = getTotalUserCount();
  const perCycle =
    CONFIG.LIMITS.BASE_MAX_ROOMS * CONFIG.LIMITS.MAX_ROOM_CAPACITY;
  const cycles = Math.floor(total / perCycle);
  return Math.max(
    CONFIG.LIMITS.BASE_MAX_ROOMS +
      cycles * CONFIG.LIMITS.ROOM_SCALING_INCREMENT,
    CONFIG.LIMITS.BASE_MAX_ROOMS,
  );
}

function getTotalUserCount() {
  let total = 0;
  for (const [, room] of state.rooms) {
    if (room.users) total += room.users.length;
  }
  return total;
}

function roomNameExists(name) {
  const n = normalize(name);
  for (const [id, room] of state.rooms) {
    if (diag.isSimRoom(id)) continue;
    if (normalize(room.name) === n) return true;
  }
  return false;
}

function getRoomStatistics() {
  const totalRooms = state.rooms.size;
  const currentLimit = calculateCurrentRoomLimit();
  const healthyRooms = getHealthyRoomCount();
  const types = { public: 0, "semi-private": 0, private: 0 };
  let roomsWithUsers = 0;
  let soloRooms = 0;
  let totalUsers = 0;

  for (const [, room] of state.rooms) {
    if (types[room.type] !== undefined) types[room.type]++;
    const visibleUsers = (room.users || []).filter(
      (u) => !(u.isDev && u.isVanished),
    );
    totalUsers += visibleUsers.length;
    if (visibleUsers.length > 0) roomsWithUsers++;
    if (visibleUsers.length === 1) soloRooms++;
  }

  return {
    totalRooms,
    totalUsers,
    currentLimit,
    healthyRooms,
    soloRooms,
    roomsWithUsers,
    emptyRooms: totalRooms - roomsWithUsers,
    roomTypes: types,
    currentSoloTTL: Math.round(getSoloRoomTTL() / 1000),
    hardCap: CONFIG.LIMITS.HARD_MAX_ROOMS,
    utilizationPercentage:
      totalRooms > 0
        ? Math.round(
            (totalUsers / (totalRooms * CONFIG.LIMITS.MAX_ROOM_CAPACITY)) * 100,
          )
        : 0,
  };
}

function generateRoomId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getCurrentMessages(usersInRoom) {
  const msgs = {};
  if (Array.isArray(usersInRoom)) {
    usersInRoom.forEach((u) => {
      msgs[u.id] = state.userMessageBuffers.get(u.id) || "";
    });
  }
  return msgs;
}

// ── Dev Mode: Visibility Helpers (vanish / hide) ────────────────────────────

function getJoinableUserCount(room) {
  return (room?.users || []).filter((u) => !(u.isDev && u.isVanished)).length;
}

function getRecipientUserId(socket) {
  return socket?.handshake?.session?.userId || null;
}

function isOpsUser(user) {
  if (!user || !user.isDev) return false;
  if (user.isMainDev) return true;
  for (const s of findSocketsByUserId(user.id)) if (s.isMainDev) return true;
  return false;
}

function canSeeConcealed(recipientSocket, user) {
  if (!recipientSocket?.isDev) return false;
  return !!recipientSocket.isMainDev || !isOpsUser(user);
}

function canRecipientSeeDevUser(recipientSocket, user) {
  if (!user) return false;
  if (!user.isDev) return true;
  if (!user.isVanished) return true;
  const recipientUserId = getRecipientUserId(recipientSocket);
  if (recipientUserId && recipientUserId === user.id) return true;
  return canSeeConcealed(recipientSocket, user);
}

function applySilence(userId) {
  if (!userId) return false;
  const sockets = findSocketsByUserId(userId);
  let on = false;
  for (const s of sockets)
    if (s.deviceId && identity.isSilenced(s.deviceId)) {
      on = true;
      break;
    }
  for (const s of sockets) s.silenced = on;
  const roomId = getUserCurrentRoom(userId);
  const room = roomId ? state.rooms.get(roomId) : null;
  const u = room && room.users.find((x) => x.id === userId);
  if (u) u.silenced = on;
  return on;
}

function visibleToRoom(user) {
  return canRecipientSeeDevUser(null, user);
}

function socketVisibleToRoom(socket) {
  if (!socket) return true;
  if (socket.silenced) return false;
  return !(socket.isDev && socket.isVanished);
}

function formatUserForSocket(user, recipientSocket) {
  if (!user) return null;

  if (!canRecipientSeeDevUser(recipientSocket, user)) return null;

  const formatted = {
    id: user.id,
    username: user.username,
    location: user.location,
    deviceType: user.deviceType || "unknown",
  };
  if (user.isAfk) formatted.isAfk = true;
  if (user.isBotUser) {
    formatted.isBotUser = true;
    if (user.botOwnerName) formatted.botOwner = user.botOwnerName;
  }
  if (user.avatar) formatted.avatar = user.avatar;
  const recipientIsDev = canSeeConcealed(recipientSocket, user);
  if ((user.isHidden || isOpsUser(user)) && !recipientIsDev) {
    return formatted;
  }

  if (recipientSocket?.isDev || recipientSocket?.isMod) {
    const note = user.deviceId ? identity.getNote(user.deviceId) : null;
    if (note) formatted.note = note;
  }

  if (user.silenced && recipientSocket?.isDev) formatted.silenced = true;

  if (user.isDev) {
    formatted.isDev = true;
    if (user.devColor && !user.isHidden) formatted.devColor = user.devColor;
    if (user.isVanished) formatted.isVanished = true;
    if (user.isHidden) formatted.isHidden = true;
  } else if (user.isMod) {
    formatted.isMod = true;
    formatted.modLevel = user.modLevel || 2;
    if (user.isHidden) formatted.isHidden = true;
  }

  return formatted;
}

function filterUsersForSocket(users, recipientSocket) {
  return (users || [])
    .map((user) => formatUserForSocket(user, recipientSocket))
    .filter(Boolean);
}

function spectatePayload(socket, room) {
  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    roomId: room.id,
    roomName: room.name,
    roomType: room.type,
    layout: room.layout,
    userId: socket.handshake?.session?.userId || null,
    isDev: !!socket.isDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : 0,
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
    users: filterUsersForSocket(room.users || [], socket),
    votes: filterVotesForSocket(room, socket),
    currentMessages: filterCurrentMessagesForSocket(room, socket),
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
  };
}

function votesAgainst(room, targetUserId) {
  if (!room || !room.votes) return 0;
  const present = new Set((room.users || []).map((u) => u.id));
  let n = 0;
  for (const voterId in room.votes)
    if (room.votes[voterId] === targetUserId && present.has(voterId)) n++;
  return n;
}

function voteThreshold(room) {
  return Math.floor((room.users || []).length / 2);
}

function filterVotesForSocket(room, recipientSocket) {
  const votes = room?.votes || {};
  const roomUsers = room?.users || [];
  const byId = new Map(roomUsers.map((u) => [u.id, u]));
  const filtered = {};

  for (const [voterId, targetId] of Object.entries(votes)) {
    const voter = byId.get(voterId);
    const target = byId.get(targetId);
    if (!voter || !target) continue;
    if (!canRecipientSeeDevUser(recipientSocket, voter)) continue;
    if (!canRecipientSeeDevUser(recipientSocket, target)) continue;
    filtered[voterId] = targetId;
  }
  return filtered;
}

function scrubRoomText(text) {
  let out = text;
  if (ipredact.looksLikeIp(out)) out = ipredact.redact(out);
  if (linkfilter.looksLikeLink(out)) out = linkfilter.redact(out);
  return out;
}

function filterCurrentMessagesForSocket(room, recipientSocket) {
  const messages = {};
  const raw = !!recipientSocket?.isMainDev;
  const own = getRecipientUserId(recipientSocket);
  for (const user of room?.users || []) {
    if (!canRecipientSeeDevUser(recipientSocket, user)) continue;
    const mine = user.id === own;
    if (user.silenced && !mine) {
      messages[user.id] = "";
      continue;
    }
    const text = state.userMessageBuffers.get(user.id) || "";
    messages[user.id] = raw || mine ? text : scrubRoomText(text);
  }
  return messages;
}

function formatRoomForSocket(room, recipientSocket) {
  const users = filterUsersForSocket(room.users || [], recipientSocket);
  const joinableCount = getJoinableUserCount(room);

  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    layout: room.layout,
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
    isFull: joinableCount >= roomCapacity(room),
    userCount: joinableCount,
    visibleUserCount: users.length,
    lastChatActivity: state.roomLastChatActivity.get(room.id) || 0,
    spotlight: !!room.spotlight,
    locked: !!room.locked,
    capacity: roomCapacity(room),
    allowBots: room.allowBots !== false,
    users,
  };
}

function formatRoomStateForSocket(room, recipientSocket) {
  const users = filterUsersForSocket(room.users || [], recipientSocket);
  const joinableCount = getJoinableUserCount(room);

  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    layout: room.layout,
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
    users,
    votes: filterVotesForSocket(room, recipientSocket),
    currentMessages: filterCurrentMessagesForSocket(room, recipientSocket),
    isFull: joinableCount >= roomCapacity(room),
    userCount: joinableCount,
    visibleUserCount: users.length,
    capacity: roomCapacity(room),
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
  };
}

// ── Per-Socket Emission Helpers (visibility-aware) ──────────────────────────

function emitRoomSnapshot(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const [, socket] of io().sockets.sockets) {
    if (!socket.connected || socket.roomId !== roomId) continue;
    socket.emit("room update", formatRoomStateForSocket(room, socket));
  }
}

function emitLobbySnapshot() {
  if (!io()) return;
  const rooms = Array.from(state.rooms.values()).filter(
    (r) => r.type !== "private",
  );
  for (const [, socket] of io().sockets.sockets) {
    if (!socket.connected || !socket.rooms?.has("lobby")) continue;
    const data = rooms.map((room) => formatRoomForSocket(room, socket));
    socket.emit("lobby update", data);
  }
}

function emitRoomVoteUpdates(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    recipient.emit("update votes", filterVotesForSocket(room, recipient));
  }
}

function emitRoomUserLeft(roomId, userId, leftUser) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (!canRecipientSeeDevUser(recipient, leftUser)) continue;
    recipient.emit("user left", userId);
  }
  if (visibleToRoom(leftUser))
    try {
      bots.onLeave(roomId, userId, leftUser);
    } catch (e) {
      console.error("bots onLeave error:", e);
    }
}

function emitRoomUserJoined(room, joinedUser) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== room.id) continue;
    const recipientUserId = getRecipientUserId(recipient);
    if (recipientUserId === joinedUser.id) continue;
    if (!canRecipientSeeDevUser(recipient, joinedUser)) continue;
    const visibleUser = formatUserForSocket(joinedUser, recipient);
    if (!visibleUser) continue;
    recipient.emit("user joined", {
      ...visibleUser,
      roomName: room.name,
      roomType: room.type,
    });
  }
  if (visibleToRoom(joinedUser))
    try {
      bots.onJoin(room.id, joinedUser);
    } catch (e) {
      console.error("bots onJoin error:", e);
    }
}

function emitRoomTyping(socket, userId, username, isTyping) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === userId);
  for (const [, recipient] of io().sockets.sockets) {
    if (
      !recipient.connected ||
      recipient.roomId !== socket.roomId ||
      recipient.id === socket.id
    )
      continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    if (socket.silenced && getRecipientUserId(recipient) !== userId) continue;
    recipient.emit("user typing", { userId, username, isTyping });
  }
}

function emitRoomChatUpdate(socket, payload) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === payload.userId);
  const text = payload.diff?.text;
  const clean = typeof text === "string" ? scrubRoomText(text) : text;
  const safe =
    clean === text
      ? payload
      : { ...payload, diff: { ...payload.diff, text: clean } };
  for (const [, recipient] of io().sockets.sockets) {
    if (
      !recipient.connected ||
      recipient.roomId !== socket.roomId ||
      recipient.id === socket.id
    )
      continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    if (socket.silenced && getRecipientUserId(recipient) !== payload.userId)
      continue;
    recipient.emit("chat update", recipient.isMainDev ? payload : safe);
  }
}

function emitRoomAfkUpdate(socket, userId, isAfk) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === userId);
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== socket.roomId) continue;
    if (getRecipientUserId(recipient) === userId) continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    recipient.emit("afk update", { userId, isAfk });
  }
}

// ── Sub-app (Talkoboard) broadcast helpers, vanish-aware ───────────────────
function emitSubAppEvent(socket, event, payload, includeSender) {
  const roomId = socket.roomId;
  if (!roomId || !io()) return;
  if (!socket.isVanished) {
    if (includeSender) io().to(roomId).emit(event, payload);
    else socket.to(roomId).emit(event, payload);
    return;
  }
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (recipient.id === socket.id) {
      if (includeSender) recipient.emit(event, payload);
      continue;
    }
    if (recipient.isDev && (recipient.isMainDev || !socket.isMainDev))
      recipient.emit(event, payload);
  }
}

function emitToRoomMaybeHidden(roomId, hide, event, payload) {
  if (!io() || !roomId) return;
  if (!hide) {
    io().to(roomId).emit(event, payload);
    return;
  }
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    if (recipient.isDev) recipient.emit(event, payload);
  }
}

// ── Dev Mode: Room / Lobby Context ──────────────────────────────────────────

function getDevRoomContext(roomId, raw) {
  if (!io()) return {};
  const ctx = {};
  const room = state.rooms.get(roomId);
  const roomUsers = new Map((room?.users || []).map((u) => [u.id, u]));
  for (const [, s] of io().sockets.sockets) {
    if (s.roomId !== roomId || !s.handshake?.session?.userId) continue;
    const userId = s.handshake.session.userId;
    const roomUser = roomUsers.get(userId);
    if (roomUser?.isHidden) continue;
    ctx[userId] = { d: raw ? s.clientIp || "unknown" : userId };
  }
  return ctx;
}

function sendDevRoomContext(roomId) {
  if (!io()) return;
  let raw = null;
  let plain = null;
  for (const [, s] of io().sockets.sockets) {
    if (!s.isDev || s.roomId !== roomId) continue;
    if (s.isMainDev) {
      if (!raw) raw = getDevRoomContext(roomId, true);
      s.emit("dev context", raw);
    } else {
      if (!plain) plain = getDevRoomContext(roomId, false);
      s.emit("dev context", plain);
    }
  }
}

function sendDevLobbyContext() {
  if (!io()) return;
  const devSockets = [];
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev && !s.roomId) devSockets.push(s);
  }
  if (devSockets.length === 0) return;

  const data = {};
  for (const [roomId, room] of state.rooms) {
    if (room.type === "semi-private" && room.accessCode) {
      data[roomId] = room.accessCode;
    }
  }
  for (const s of devSockets) {
    s.emit("dev lobby context", s.isMainDev ? data : {});
  }
}

// ── Room Save / Load ────────────────────────────────────────────────────────

async function saveRooms(force = false) {
  const now = Date.now();
  if (!force && now - state.lastSaveTimestamp < state.SAVE_INTERVAL_MIN) return;
  try {
    const data = Array.from(state.rooms.entries())
      .filter(([id]) => !diag.isSimRoom(id))
      .map(([id, room]) => {
        return [
          id,
          {
            ...room,
            users: (room.users || []).map((u) => {
              const clean = { ...u };
              delete clean.isVanished;
              delete clean.isMainDev;
              delete clean.silenced;
              return clean;
            }),
            bannedUserIds: Array.from(room.bannedUserIds || []),
          },
        ];
      });
    const tmp = path.join(DATA_DIR, "rooms.json.tmp");
    const final = path.join(DATA_DIR, "rooms.json");
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, final);
    state.lastSaveTimestamp = now;
    console.log("Rooms saved successfully.");
  } catch (err) {
    console.error("Error saving rooms:", err);
    try {
      await fs.unlink(path.join(DATA_DIR, "rooms.json.tmp"));
    } catch (_) {}
  }
}

const debouncedSaveRooms = async () => {
  if (state.saveRoomsPending) return;
  state.saveRoomsPending = true;
  setTimeout(async () => {
    try {
      await saveRooms();
    } catch (e) {
      console.error("Debounced save error:", e);
    } finally {
      state.saveRoomsPending = false;
    }
  }, 10000);
};

async function loadRooms() {
  if (!CONFIG.FEATURES.LOAD_ROOMS_ON_STARTUP) {
    console.log("Starting with empty rooms (room loading disabled)");
    state.rooms = new Map();
    return;
  }
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "rooms.json"), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      state.rooms = new Map();
      return;
    }

    state.rooms = new Map(
      arr.map((item) => {
        if (item[1]) {
          if (item[1].users && item[1].users.length > 0) {
            console.log(
              `Clearing ${item[1].users.length} stale user(s) from room: ${item[1].name || item[0]}`,
            );
          }
          item[1].users = [];
          item[1].votes = {};
          item[1].lastActiveTime = Date.now();
          item[1].bannedUserIds = new Set(
            Array.isArray(item[1].bannedUserIds)
              ? item[1].bannedUserIds
              : typeof item[1].bannedUserIds === "object"
                ? Object.values(item[1].bannedUserIds)
                : [],
          );
        }
        return item;
      }),
    );
    console.log(`Loaded ${state.rooms.size} rooms from disk (users cleared).`);
    for (const [roomId] of state.rooms) {
      startRoomDeletionTimer(roomId);
    }
  } catch (err) {
    if (err.code === "ENOENT")
      console.log("rooms.json not found. Starting fresh.");
    else console.error("Error loading rooms:", err);
    state.rooms = new Map();
  }
}

// ── Room Timers ─────────────────────────────────────────────────────────────

function startRoomDeletionTimer(roomId) {
  if (state.roomDeletionTimers.has(roomId)) {
    clearTimeout(state.roomDeletionTimers.get(roomId));
  }
  const timer = setTimeout(async () => {
    const room = state.rooms.get(roomId);
    if (room && room.users.length === 0) {
      state.rooms.delete(roomId);
      gamesFloor.roomClosed(roomId);
      state.roomDeletionTimers.delete(roomId);
      state.roomSoloSince.delete(roomId);
      state.roomLastChatActivity.delete(roomId);
      cleanupBoardState(roomId);
      updateLobby();
      await debouncedSaveRooms();
      console.log(`Room ${roomId} deleted (empty timeout).`);
    }
  }, CONFIG.TIMING.ROOM_DELETION_TIMEOUT);
  state.roomDeletionTimers.set(roomId, timer);
}

// ── Lobby / Room Broadcasts ─────────────────────────────────────────────────

function updateLobby() {
  if (!io()) return;
  try {
    state.apiCache.delete("socket_rooms_dev");
    state.apiCache.delete("socket_rooms_normal");
    emitLobbySnapshot();
    sendDevLobbyContext();
  } catch (err) {
    console.error("updateLobby error:", err);
  }
}

function updateRoom(roomId) {
  if (!io()) return;
  const room = state.rooms.get(roomId);
  if (room) {
    emitRoomSnapshot(roomId);
  }
}

// ── AFK ─────────────────────────────────────────────────────────────────────

function clearAFKTimers(userId) {
  if (state.afkWarningTimers.has(userId)) {
    clearTimeout(state.afkWarningTimers.get(userId));
    state.afkWarningTimers.delete(userId);
  }
  if (state.afkTimers.has(userId)) {
    clearTimeout(state.afkTimers.get(userId));
    state.afkTimers.delete(userId);
  }
}

function setupAFKTimers(socket, userId) {
  clearAFKTimers(userId);
  if (!socket || !socket.roomId) return;
  if (socket.isDev || socket.isMod) return;
  if (socket.boardOpen) return;
  if (gamesFloor.isPlaying(socket.roomId, userId)) return;

  state.afkWarningTimers.set(
    userId,
    setTimeout(() => {
      if (socket.connected)
        socket.emit("afk warning", {
          message: "You have been inactive.",
          secondsRemaining: 30,
        });
    }, CONFIG.TIMING.AFK_WARNING_TIME),
  );
  state.afkTimers.set(
    userId,
    setTimeout(
      () => handleAFKTimeout(socket, userId),
      CONFIG.LIMITS.MAX_AFK_TIME,
    ),
  );
}

async function handleAFKTimeout(socket, userId) {
  if (!socket || !socket.roomId) return;
  console.log(`AFK timeout: ${userId} in room ${socket.roomId}`);
  socket.emit("afk timeout", {
    message: "Removed from room due to inactivity.",
    redirectTo: "/",
  });
  await leaveRoom(socket, userId);
  clearAFKTimers(userId);
}

// ── Chat Processing ─────────────────────────────────────────────────────────

function checkChatCircuit() {
  const now = Date.now();
  const cs = state.chatCircuitState;
  if (cs.isOpen && now - cs.lastFailure > cs.resetTimeout) {
    cs.isOpen = false;
    cs.failures = 0;
  }
  if (!cs.isOpen && cs.failures > cs.threshold) {
    cs.isOpen = true;
    cs.lastFailure = now;
    console.warn("Chat circuit breaker opened");
  }
  return !cs.isOpen;
}

function getBatchInterval(roomId) {
  const room = roomId ? state.rooms.get(roomId) : null;
  return room && room.slowMode
    ? CONFIG.TIMING.SLOW_MODE_BATCH_INTERVAL
    : CONFIG.TIMING.BATCH_PROCESSING_INTERVAL;
}

// ── "@name" mentions inside a room ──────────────────────────────────────────
const mentionEdge = new WeakMap();
const mentionCooldown = new Map();
const MENTION_COOLDOWN_MS = 60000;

function notifyRoomMentions(socket, userId, text) {
  const roomId = socket.roomId;
  const room = roomId ? state.rooms.get(roomId) : null;
  if (!room) return;
  const lower = text.toLowerCase();
  const speaker = socket.handshake.session?.username || "Someone";
  const named = new Set();
  const now = Date.now();

  for (const u of room.users || []) {
    if (!u || u.id === userId || !u.username) continue;
    if (!lower.includes("@" + u.username.toLowerCase())) continue;
    named.add(u.id);
  }

  const before = mentionEdge.get(socket) || new Set();
  mentionEdge.set(socket, named);

  for (const targetId of named) {
    if (before.has(targetId)) continue;
    const key = userId + "|" + targetId;
    if (now - (mentionCooldown.get(key) || 0) < MENTION_COOLDOWN_MS) continue;
    mentionCooldown.set(key, now);
    for (const s of findSocketsByUserId(targetId)) {
      if (s.roomId !== roomId) continue;
      s.emit("room mention", { by: speaker, roomId });
    }
  }

  if (mentionCooldown.size > 800)
    for (const [k, t] of mentionCooldown)
      if (now - t > MENTION_COOLDOWN_MS) mentionCooldown.delete(k);
}

async function processPendingChatUpdates(userId, socket) {
  try {
    if (!state.pendingChatUpdates.has(userId) || !socket || !socket.roomId)
      return;
    const pending = state.pendingChatUpdates.get(userId);
    if (!pending || pending.diffs.length === 0) return;

    if (state.batchProcessingTimers.has(userId)) {
      clearTimeout(state.batchProcessingTimers.get(userId));
      state.batchProcessingTimers.delete(userId);
    }

    let msg = state.userMessageBuffers.get(userId) || "";
    const username = socket.handshake.session.username || "Anonymous";

    let shouldRateLimit = false;
    try {
      await chatUpdateLimiter.consume(
        userId,
        Math.min(1 + Math.floor(pending.diffs.length / 10), 2),
      );
    } catch (e) {
      shouldRateLimit = true;
      if (e.msBeforeNext > 1000)
        socket.emit("message", { type: "warning", text: "Slow down typing" });
    }

    const limit = shouldRateLimit
      ? Math.min(10, CONFIG.LIMITS.BATCH_SIZE_LIMIT)
      : CONFIG.LIMITS.BATCH_SIZE_LIMIT;
    const batch = pending.diffs.splice(0, limit);

    for (const diff of batch) {
      if (diff.type === "full-replace") {
        msg = diff.text || "";
      } else if (diff.type === "add") {
        diff.index = Math.min(diff.index, msg.length);
        const space = CONFIG.LIMITS.MAX_MESSAGE_LENGTH - msg.length;
        diff.text = (diff.text || "").substring(0, space);
        msg = msg.slice(0, diff.index) + diff.text + msg.slice(diff.index);
      } else if (diff.type === "delete") {
        diff.index = Math.min(diff.index, msg.length);
        diff.count = Math.min(diff.count, msg.length - diff.index);
        msg = msg.slice(0, diff.index) + msg.slice(diff.index + diff.count);
      } else if (diff.type === "replace") {
        diff.index = Math.min(diff.index, msg.length);
        const rLen = (diff.text || "").length;
        const end = Math.min(diff.index + rLen, msg.length);
        msg = msg.slice(0, diff.index) + (diff.text || "") + msg.slice(end);
      }
    }

    msg = sanitizeMessage(msg);
    state.userMessageBuffers.set(userId, msg);

    if (linkfilter.containsLink(msg)) armLinkSweep(socket, userId);
    else cancelLinkSweep(userId);

    if (msg.includes("@")) notifyRoomMentions(socket, userId, msg);

    if (socket.isDev || socket.isMod) {
      try {
        staffchat.onRoomText(socket, socket.roomId, msg);
      } catch (_) {}
    }

    if (socket.roomId) {
      state.roomLastChatActivity.set(socket.roomId, Date.now());
    }

    emitRoomChatUpdate(socket, {
      userId,
      username,
      diff: { type: "full-replace", text: msg },
    });

    if (socketVisibleToRoom(socket))
      try {
        bots.onText(socket.roomId, userId, username, msg);
      } catch (e) {
        console.error("bots onText error:", e);
      }

    setupAFKTimers(socket, userId);

    if (pending.diffs.length > 0) {
      state.batchProcessingTimers.set(
        userId,
        setTimeout(
          () => processPendingChatUpdates(userId, socket),
          getBatchInterval(socket.roomId),
        ),
      );
    } else {
      state.pendingChatUpdates.delete(userId);
    }
    if (state.chatCircuitState.failures > 0) state.chatCircuitState.failures--;
  } catch (err) {
    console.error("processPendingChatUpdates error:", err);
    state.pendingChatUpdates.delete(userId);
  }
}

// ── Leave / Join Room ───────────────────────────────────────────────────────

async function leaveRoom(socket, userId) {
  try {
    const roomId = socket.roomId;
    if (!roomId) return;
    clearAFKTimers(userId);

    finalizeBoardUserStroke(roomId, userId);
    markBoardClaimAway(roomId, userId);

    const room = state.rooms.get(roomId);
    if (room) {
      const successor = [...io().sockets.sockets.values()].find(
        (s) =>
          s !== socket &&
          s.connected &&
          s.roomId === roomId &&
          s.handshake?.session?.userId === userId,
      );
      if (successor) {
        socket.leave(roomId);
        socket.roomId = null;
        return;
      }

      const leftUser = room.users.find((u) => u.id === userId);
      room.users = room.users.filter((u) => u.id !== userId);
      room.lastActiveTime = Date.now();

      if (room.votes) {
        delete room.votes[userId];
        emitRoomVoteUpdates(roomId);
      }

      socket.leave(roomId);
      emitRoomUserLeft(roomId, userId, leftUser);
      updateRoom(roomId);
      sendDevRoomContext(roomId);
      updateRoomSoloTracking(roomId);
      if (socket.isDev || socket.isMod) staffchat.presenceDirty();

      gamesFloor.userLeftRoom(roomId, userId);

      if (room.users.length === 0) startRoomDeletionTimer(roomId);
    }

    if (socket.handshake.session) {
      if (socket.handshake.session.validatedRooms?.[roomId])
        delete socket.handshake.session.validatedRooms[roomId];
      socket.handshake.session.currentRoom = null;
      await promisifySessionSave(socket.handshake.session).catch((e) =>
        console.error("Session save in leaveRoom:", e),
      );
    }
    state.userMessageBuffers.delete(userId);
    state.devUsers.delete(userId);

    socket.roomId = null;
    socket.join("lobby");
    updateLobby();
    await debouncedSaveRooms();
  } catch (err) {
    console.error("leaveRoom error:", err);
    if (socket?.emit)
      socket.emit(
        "error",
        createErrorResponse(ERROR_CODES.SERVER_ERROR, "Error leaving room."),
      );
  }
}

function joinRoom(socket, roomId, userId) {
  try {
    if (!roomId || typeof roomId !== "string" || roomId.length !== 6) {
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.NOT_FOUND,
          "Room not found (invalid ID).",
        ),
      );
    }
    const room = state.rooms.get(roomId);
    if (!room)
      return socket.emit(
        "error",
        createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
      );
    const isStaff = !!socket.isDev || !!socket.isMod;

    if (room.bannedUserIds?.has(userId) && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "You are banned from this room.",
        ),
      );

    if (state.maintenance && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "Talkomatic is in maintenance mode. New joins are paused while " +
            "people finish their conversations. Please try again shortly.",
          null,
          true,
        ),
      );

    if (room.locked && !isStaff)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "This room is locked. No new joins are allowed right now.",
          null,
          true,
        ),
      );

    let { username, location } = socket.handshake.session || {};
    if (isGuestName(username))
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.UNAUTHORIZED,
          "Choose a username in the lobby before joining a room.",
          { needsUsername: true },
          true,
        ),
      );
    if (!location) location = "On The Web";

    const clientIp = socket.clientIp || socket.handshake.address;
    if (CONFIG.FEATURES.ENABLE_BOT_PROTECTION) {
      if (isBlacklisted(userId, clientIp))
        return socket.emit(
          "error",
          createErrorResponse(ERROR_CODES.FORBIDDEN, "Access denied."),
        );
      if (detectBotBehavior(userId, clientIp))
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.RATE_LIMITED,
            "Too many join attempts.",
          ),
        );
    }

    if (!isStaff) {
      const curRoom = getOwnCurrentRoom(userId);
      if (curRoom && curRoom !== roomId) {
        const name = state.rooms.get(curRoom)?.name || "Unknown";
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.FORBIDDEN,
            `You are already in "${name}". Leave first.`,
            { currentRoomId: curRoom, currentRoomName: name },
            true,
          ),
        );
      }
      if (
        getUsernameLocationRoomsCount(username, location, userId) >=
        CONFIG.LIMITS.MAX_ROOMS_PER_USER
      ) {
        return socket.emit(
          "error",
          createErrorResponse(
            ERROR_CODES.FORBIDDEN,
            "This username/location is already in a room.",
          ),
        );
      }
    }

    if (!room.users) room.users = [];
    if (!room.votes) room.votes = {};

    const joinableUserCount = (room.users || []).filter(
      (u) => u.id !== userId && !(u.isDev && u.isVanished),
    ).length;
    if (!isStaff && joinableUserCount >= roomCapacity(room))
      return socket.emit(
        "room full",
        createErrorResponse(ERROR_CODES.ROOM_FULL, "Room is full."),
      );

    if (socket.isBot && room.allowBots === false)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "This room does not allow bots.",
        ),
      );

    if (socket.isBot && bots.botCountInRoom(room) >= bots.maxBotsForRoom(room))
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          `This room is at its bot limit (${bots.maxBotsForRoom(room)} for its size).`,
        ),
      );

    clearAFKTimers(userId);
    room.users = room.users.filter((u) => u.id !== userId);
    socket.join(roomId);

    room.users.push({
      id: userId,
      username,
      location,
      isDev: !!socket.isDev,
      isMainDev: !!socket.isMainDev,
      isMod: !!socket.isMod,
      modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
      isHidden: !!socket.isHidden,
      isVanished: !!socket.isVanished,
      silenced: !!(socket.deviceId && identity.isSilenced(socket.deviceId)),
      isBotUser: !!socket.isBot || undefined,
      deviceType: socket.isBot ? "bot" : socket.deviceType || "unknown",
      deviceId: socket.deviceId || null,
      avatar: socket.handshake.session?.avatar || null,
    });

    if (socket.isDev) {
      state.devUsers.add(userId);
    }

    room.lastActiveTime = Date.now();
    socket.roomId = roomId;
    applySilence(userId);

    if (socket.handshake?.sessionID && !socket.isModLog && !isStaff) {
      const sid = socket.handshake.sessionID;
      for (const [, other] of io().sockets.sockets) {
        if (other.id === socket.id || other.isBot || other.isModLog) continue;
        if (other.handshake?.sessionID !== sid) continue;
        if (!other.roomId) continue;
        try {
          other.emit("session superseded", {});
          other.disconnect(true);
        } catch (_) {}
      }
    }

    setupAFKTimers(socket, userId);
    updateRoomSoloTracking(roomId);
    if (isStaff) staffchat.presenceDirty();

    if (socket.handshake.session) {
      socket.handshake.session.currentRoom = roomId;
      socket.handshake.session.save((err) => {
        if (err)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.SERVER_ERROR,
              "Session save failed.",
            ),
          );
        emitJoinSuccess(socket, room, userId, username, location);
      });
    } else {
      emitJoinSuccess(socket, room, userId, username, location);
    }
    debouncedSaveRooms().catch(() => {});
  } catch (err) {
    console.error("joinRoom error:", err);
    socket.emit(
      "error",
      createErrorResponse(
        ERROR_CODES.SERVER_ERROR,
        "Unexpected error joining room.",
      ),
    );
  }
}

function emitJoinSuccess(socket, room, userId, username, location) {
  const joinedUser = room.users?.find((u) => u.id === userId) || {
    id: userId,
    username,
    location,
    isDev: !!socket.isDev,
    isMainDev: !!socket.isMainDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
    isHidden: !!socket.isHidden,
    isVanished: !!socket.isVanished,
  };

  const createdAt = room.createdAt || room.lastActiveTime || 0;
  socket.emit("room joined", {
    protocol: CONFIG.VERSIONS.PROTOCOL,
    roomId: room.id,
    userId,
    username,
    location,
    isDev: !!socket.isDev,
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : 0,
    isHidden: !!socket.isHidden,
    isVanished: !!socket.isVanished,
    roomName: room.name,
    roomType: room.type,
    locked: !!room.locked,
    slowMode: !!room.slowMode,
    spotlight: !!room.spotlight,
    maxSize: roomCapacity(room),
    users: filterUsersForSocket(room.users || [], socket),
    layout: room.layout,
    votes: filterVotesForSocket(room, socket),
    currentMessages: filterCurrentMessagesForSocket(room, socket),
    createdAt: createdAt,
    uptime: Date.now() - createdAt,
  });

  socket.leave("lobby");

  emitRoomUserJoined(room, joinedUser);
  updateRoom(room.id);
  updateLobby();

  if (state.roomDeletionTimers.has(room.id)) {
    clearTimeout(state.roomDeletionTimers.get(room.id));
    state.roomDeletionTimers.delete(room.id);
  }
  sendDevRoomContext(room.id);

  try {
    bots.onOwnerJoined(socket, room);
  } catch (e) {
    console.error("bots onOwnerJoined error:", e);
  }
}

function handleTyping(socket, userId, username, isTyping) {
  if (!socket.roomId) return;
  if (state.typingTimeouts.has(userId))
    clearTimeout(state.typingTimeouts.get(userId));

  if (isTyping) {
    emitRoomTyping(socket, userId, username, true);
    state.typingTimeouts.set(
      userId,
      setTimeout(() => {
        emitRoomTyping(socket, userId, username, false);
        state.typingTimeouts.delete(userId);
      }, CONFIG.TIMING.TYPING_TIMEOUT),
    );
  } else {
    emitRoomTyping(socket, userId, username, false);
    state.typingTimeouts.delete(userId);
  }
}

// ── Socket Event Registration ───────────────────────────────────────────────

let getBuildId = null;

function registerSocketHandlers(opts) {
  if (opts && typeof opts.buildId === "function") getBuildId = opts.buildId;
  staffchat.init({
    io,
    state,
    formatUserForSocket,
    findSocketsByUserId,
    isOpsUser,
    roomCapacity,
    roles,
    audit,
    banHistory: buildBanHistory,
    announcements,
  });
  gamesFloor.init({
    socketsInRoom(roomId) {
      const out = [];
      if (!io() || !roomId) return out;
      for (const [, s] of io().sockets.sockets)
        if (s.connected && s.roomId === roomId) out.push(s);
      return out;
    },
    userIdOf: (s) => s.handshake?.session?.userId || null,
    userInfo(roomId, userId) {
      const room = state.rooms.get(roomId);
      if (!room) return null;
      const u = room.users.find((x) => x.id === userId);
      if (!u) return null;
      const concealed = !!(u.isHidden || u.isVanished) || isOpsUser(u);
      let role = null;
      if (!concealed && u.isDev) role = "dev";
      else if (!concealed && u.isMod)
        role = (u.modLevel || 2) >= 2 ? "mod" : "jr";
      return {
        userId,
        username: u.username,
        role,
        avatar: u.avatar || null,
      };
    },
    setPlaying(roomId, userId, playing, label) {
      const socket = findSocketsByUserId(userId)[0];
      if (!socket || socket.roomId !== roomId) return;
      if (playing) {
        if (!gamePrevText.has(userId))
          gamePrevText.set(userId, state.userMessageBuffers.get(userId) || "");
        const text = `[ playing ${label || "mini games"} ]`;
        state.userMessageBuffers.set(userId, text);
        emitRoomChatUpdate(socket, {
          userId,
          username: socket.handshake?.session?.username,
          diff: { type: "full-replace", text },
        });
        socket.emit("chat update", {
          userId,
          username: socket.handshake?.session?.username,
          diff: { type: "full-replace", text },
        });
        clearAFKTimers(userId);
      } else {
        const prev = gamePrevText.get(userId) || "";
        gamePrevText.delete(userId);
        state.userMessageBuffers.set(userId, prev);
        emitRoomChatUpdate(socket, {
          userId,
          username: socket.handshake?.session?.username,
          diff: { type: "full-replace", text: prev },
        });
        socket.emit("chat update", {
          userId,
          username: socket.handshake?.session?.username,
          diff: { type: "full-replace", text: prev },
        });
        setupAFKTimers(socket, userId);
      }
    },
    filterText(text) {
      if (!CONFIG.FEATURES.ENABLE_WORD_FILTER) return text;
      try {
        return wordFilter.filterText(text);
      } catch (_) {
        return text;
      }
    },
  });

  bots.init({
    emitChat: emitRoomChatUpdate,
    emitTyping: emitRoomTyping,
    userJoined: emitRoomUserJoined,
    userLeft: emitRoomUserLeft,
    updateRoom,
    updateLobby,
    startRoomDeletionTimer,
    roomCapacity,
    newRoomCapacity,
    roomNameExists,
    calculateCurrentRoomLimit,
    logStaff,
  });

  diag.init({
    emitChat: emitRoomChatUpdate,
    userJoined: emitRoomUserJoined,
    userLeft: emitRoomUserLeft,
    updateRoom,
    updateRoomSoloTracking,
    updateLobby,
    startRoomDeletionTimer,
    roomCapacity,
    newRoomCapacity,
    roomNameExists,
    generateRoomId,
  });

  io().on("connection", (socket) => {
    const clientIp = socket.clientIp || socket.handshake.address;

    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased || !socket.clientIp) return;
      slotReleased = true;
      const c = state.ipConnections.get(socket.clientIp) || 0;
      if (c > 1) state.ipConnections.set(socket.clientIp, c - 1);
      else state.ipConnections.delete(socket.clientIp);
    };
    socket.on("disconnect", releaseSlot);
    socket.on("disconnect", () => {
      if (!socket.keyWatchHash) return;
      const hash = socket.keyWatchHash;
      keywatch.leave(hash, socket.id);
      const role = socket.isDev ? "dev" : "mod";
      const label = socket.staffLabel || role;
      judgeStaffKey(hash, role, label);
    });

    if (diag.onConnect(socket)) return;
    socket.use((packet, next) => {
      const d = diag.inboundDelay(socket);
      if (d > 0) {
        setTimeout(next, d);
        return;
      }
      next();
    });

    if (getBuildId) socket.emit("server build", { id: getBuildId() });

    socket.deviceType = deviceTypeFromUA(
      socket.handshake.headers["user-agent"],
    );

    try {
      if (socket.deviceId) {
        identity.touch(
          socket.deviceId,
          clientIp,
          socket.handshake?.session?.username,
          socket.handshake?.session?.location,
        );
        socket._idAt = Date.now();
        applySilence(socket.handshake?.session?.userId);
        socket.emit("identity status", identity.summary(socket.deviceId));
        if (!socket.isDev && !socket.isMod)
          try {
            evasion.check({
              deviceId: socket.deviceId,
              ip: clientIp,
              username: socket.handshake?.session?.username || null,
            });
          } catch (e) {
            console.error("evasion check failed:", e.message);
          }
        const queuedWarnings = warnings.takeFor(socket.deviceId);
        if (queuedWarnings.length)
          setTimeout(() => {
            for (const w of queuedWarnings)
              socket.emit("staff warning", { message: w.message });
          }, 1500);
      }

      if (socket.deviceId && !socket.isDev && !socket.isMod) {
        const claim = applications.unclaimedApproved(socket.deviceId);
        if (claim) {
          const reviewedBy = String(claim.reviewedBy || "");
          const grantedBy =
            (reviewedBy.includes(":")
              ? reviewedBy.slice(reviewedBy.indexOf(":") + 1)
              : reviewedBy) || "application";
          roles
            .grantModKey(claim.username || "mod", 1, grantedBy)
            .then((g) => {
              applications.markClaimed(claim.id);
              socket.emit("you are now mod", {
                key: g.key,
                label: g.label,
                level: g.level,
              });
            })
            .catch((e) => console.error("application claim grant failed:", e));
        }
      }

      if (socket.deviceId && !socket.isDev && !socket.isMod) {
        const st = appStatusPayload(socket.deviceId, false);
        if (st.has) socket.emit("mod application status", st);
      }

      socket.emit("applications state", { open: !!applications.isOpen() });

      // ── One active ROOM tab per browser session ─────────────────────────
      socket.isModLog = socket.handshake?.auth?.app === "modlog";

      // ── Staff key leak watch ────────────────────────────────────────────
      if ((socket.isDev || socket.isMod) && clientIp) {
        const hash = socket.isDev ? socket.devKeyHash : socket.modKeyHash;
        const role = socket.isDev ? "dev" : "mod";
        const label = socket.staffLabel || role;
        socket.keyWatchHash = hash;
        keywatch.join(hash, socket.id, {
          deviceId: socket.deviceId || null,
          userId: socket.handshake?.session?.userId || null,
          network: ipban.computeRangeCidr(clientIp) || null,
        });
        setTimeout(
          () => judgeStaffKey(hash, role, label),
          keywatch.SETTLE_MS + 1000,
        ).unref?.();
        if (socket.keyNewIp && !socket.isMainDev) {
          audit.recordKeyAlert({
            role,
            label,
            ip: clientIp,
            kind: "new-ip",
            detail: `The ${role} key "${label}" connected from an address it has never been used from before`,
          });
        }
      }
    } catch (setupErr) {
      console.error("Socket setup failed for", clientIp, setupErr);
    }

    function safe(fn) {
      return async (...args) => {
        try {
          await fn(...args);
        } catch (err) {
          console.error(`Socket error [${fn.name || "?"}] ${clientIp}:`, err);
          try {
            socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.SERVER_ERROR,
                "Internal server error.",
              ),
            );
            socket._errCount = (socket._errCount || 0) + 1;
            if (socket._errCount > 10) socket.disconnect(true);
          } catch (_) {}
        }
      };
    }

    socket.on("diag apply", (d) => {
      if (!socket.isMainDev) return;
      socket.emit(
        "diag status",
        d && d.kind === "lag" ? diag.lag(d) : diag.status(),
      );
    });
    socket.on("diag drop", (d) => {
      if (!socket.isMainDev) return;
      const last = diag.drop(d || {});
      socket.emit("diag status", { ...diag.status(), last });
    });
    socket.on("diag clear", () => {
      if (!socket.isMainDev) return;
      socket.emit("diag status", diag.clear());
    });
    socket.on("diag gate", (d) => {
      if (!socket.isMainDev) return;
      socket.emit("diag status", diag.setGate(!!(d && d.open)));
    });
    socket.on("diag status", () => {
      if (!socket.isMainDev) return;
      socket.emit("diag status", diag.status());
    });

    const heldReply = (result) => {
      if (result && result.error)
        return socket.emit("diag held", { error: result.error });
      socket.emit("diag held", { ...diag.list(), last: result || null });
    };
    socket.on("diag held", () => {
      if (!socket.isMainDev) return;
      heldReply(null);
    });
    socket.on("diag held add", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.add(d || {}));
    });
    socket.on("diag held edit", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.edit(d && d.id, d || {}));
    });
    socket.on("diag held say", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.say(d && d.id, d && d.text));
    });
    socket.on("diag held open", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.openRoom(d && d.id, d || {}));
    });
    socket.on("diag held join", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.joinRoom(d && d.id, d || {}));
    });
    socket.on("diag held leave", (d) => {
      if (!socket.isMainDev) return;
      heldReply(diag.leaveRoom(d && d.id));
    });
    socket.on("diag held drop", (d) => {
      if (!socket.isMainDev) return;
      heldReply(d && d.all ? diag.removeAll() : diag.remove(d && d.id));
    });

    const simReply = (result) => {
      if (result && result.error)
        return socket.emit("diag sim", { error: result.error });
      socket.emit("diag sim", result || diag.simStatus());
    };
    socket.on("diag sim", () => {
      if (!socket.isMainDev) return;
      simReply(diag.simStatus());
    });
    socket.on("diag sim start", (d) => {
      if (!socket.isMainDev) return;
      simReply(diag.simStart(d || {}));
    });
    socket.on("diag sim set", (d) => {
      if (!socket.isMainDev) return;
      simReply(diag.simRetarget(d || {}));
    });
    socket.on("diag sim stop", (d) => {
      if (!socket.isMainDev) return;
      simReply(diag.simStop(d || {}));
    });

    // ── Check Sign-In Status ────────────────────────────────────────────
    socket.on(
      "check signin status",
      safe(async () => {
        let { username, location, userId, isIPBased } =
          socket.handshake.session || {};
        if (isGuestName(username)) {
          username = null;
          isIPBased = false;
        }
        if (username && location && userId) {
          if (socket.isDev) {
            state.devUsers.add(userId);
          }

          socket.emit("signin status", {
            isSignedIn: true,
            username,
            location,
            userId,
            isIPBased: !!isIPBased,
            isBot: !!socket.isBot,
            isDev: !!socket.isDev,
            isMod: !!socket.isMod,
            modLevel: socket.isMod ? socket.modLevel || 2 : 0,
            isHidden: !!socket.isHidden,
          });
          socket.join("lobby");
          state.users.set(userId, {
            id: userId,
            username,
            location,
            isIPBased,
          });
          updateLobby();
          applyNamePolicy(socket, username);
        } else {
          socket.emit("signin status", {
            isSignedIn: false,
            isBot: !!socket.isBot,
            isDev: !!socket.isDev,
            isMod: !!socket.isMod,
            modLevel: socket.isMod ? socket.modLevel || 2 : 0,
          });
        }
      }),
    );

    // ── Rules ───────────────────────────────────────────────────────────
    socket.on(
      "rules get",
      safe(async () => {
        socket.emit("rules data", rules.publicRules());
      }),
    );

    socket.on(
      "dev set rules",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const section = data?.section === "mod" ? "mod" : "community";
        const res = rules.setSection(
          section,
          data?.list,
          socket.staffLabel || "dev",
        );
        if (!res.ok)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Could not save rules.",
            ),
          );
        logStaff(socket, "set rules", section, "-", `${res.count} rules`);
        socket.emit("rules data", rules.publicRules());
        socket.emit("staff action result", {
          ok: true,
          action: `saved ${res.count} ${section} rule${res.count === 1 ? "" : "s"}`,
        });
      }),
    );

    socket.on(
      "dev reset rules",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const section = data?.section === "mod" ? "mod" : "community";
        const res = rules.resetSection(section, socket.staffLabel || "dev");
        if (!res.ok) return;
        logStaff(socket, "reset rules", section, "-", "restored defaults");
        socket.emit("rules data", rules.publicRules());
        socket.emit("staff action result", {
          ok: true,
          action: `restored the default ${section} rules`,
        });
      }),
    );

    // ── Join Lobby ──────────────────────────────────────────────────────
    socket.on(
      "join lobby",
      safe(async (data) => {
        if (!data || typeof data !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const valErr = validateObject(data, {
          username: { rule: "username" },
          location: { rule: "location" },
          avatar: { rule: "avatar" },
        });
        if (valErr) return socket.emit("validation_error", valErr);

        const pfpBlocked =
          !!socket.deviceId && identity.isPfpBlocked(socket.deviceId);
        const rawAvatar =
          !pfpBlocked && data.avatar && typeof data.avatar === "object"
            ? data.avatar
            : null;
        let avatar = null;
        if (rawAvatar && rawAvatar.preset !== undefined) {
          const presetNo = Number(rawAvatar.preset);
          avatar = isPresetAvatar(presetNo) ? { preset: presetNo } : null;
        } else if (rawAvatar) {
          avatar = {
            id: String(rawAvatar.discordId),
            hash: String(rawAvatar.hash).toLowerCase(),
            animated: !!rawAvatar.animated,
          };
        }

        let username = enforceUsernameLimit(sanitizeName(data.username));
        let location = enforceLocationLimit(
          sanitizeName(data.location || "On The Web"),
        );

        if (!username) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Username contains no valid characters.",
            ),
          );
        }
        if (!location) location = "On The Web";

        if (CONFIG.FEATURES.ENABLE_WORD_FILTER) {
          if (wordFilter.checkText(username).hasOffensiveWord)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Username contains forbidden words.",
              ),
            );
          if (wordFilter.checkText(location).hasOffensiveWord)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Location contains forbidden words.",
              ),
            );
        }

        if (ipredact.containsIp(username) || ipredact.containsIp(location))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Names and locations cannot contain an IP address.",
            ),
          );
        if (
          linkfilter.containsLink(username) ||
          linkfilter.containsLink(location)
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Names and locations cannot contain a link.",
            ),
          );
        // Staff are exempt from the reserved-name half for the same reason
        // they are exempt from isReservedName below.
        const staff = !!socket.isDev || !!socket.isMod;
        const nameCheck = nameguard.check(username, {
          reserved: staff ? [] : CONFIG.RESERVED_NAMES,
        });
        const placeCheck = nameguard.check(location);
        const bad = !nameCheck.ok
          ? nameCheck
          : !placeCheck.ok
            ? placeCheck
            : null;
        if (bad && bad.reason !== "empty")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              bad.reason === "reserved"
                ? "That name is too close to a name Talkomatic reserves."
                : "Names and locations can only use ordinary letters, numbers and punctuation.",
            ),
          );

        if (isGuestName(username)) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Please choose a username - guest names are not allowed.",
            ),
          );
        }

        if (isReservedName(username) && !socket.isDev && !socket.isMod) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "That username is reserved. Please choose another.",
            ),
          );
        }

        const userId = socket.handshake.sessionID;
        if (!socket.handshake.session)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.SERVER_ERROR,
              "Session not available.",
            ),
          );
        Object.assign(socket.handshake.session, {
          username,
          location,
          userId,
          isIPBased: false,
          avatar,
        });
        await promisifySessionSave(socket.handshake.session);
        state.users.set(userId, { id: userId, username, location });

        for (const room of state.rooms.values()) {
          const u = (room.users || []).find((x) => x.id === userId);
          if (u && u.avatar !== avatar) {
            u.avatar = avatar;
            emitRoomSnapshot(room);
          }
        }

        audit.recordIdentity({
          userId,
          username,
          location,
          ip: socket.clientIp || null,
        });

        if (socket.deviceId)
          identity.setName(socket.deviceId, username, location);
        if (reports.isTarget(userId)) broadcastReportsList();

        if (socket.isDev) {
          state.devUsers.add(userId);
        }

        socket.join("lobby");
        updateLobby();
        socket.emit("signin status", {
          isSignedIn: true,
          username,
          location,
          userId,
          isIPBased: false,
          isBot: !!socket.isBot,
          isDev: !!socket.isDev,
          isMod: !!socket.isMod,
          modLevel: socket.isMod ? socket.modLevel || 2 : 0,
          isHidden: !!socket.isHidden,
          avatar,
        });
        applyNamePolicy(socket, username);
      }),
    );

    // ── Mini games: queue, tables, moves ────────────────────────────────
    gamesSocket.register(socket, safe);

    // ── The Desk: staff chat, pings, presence, inspector ────────────────
    staffchat.register(socket, safe);

    // ── Bot Creator: saved bots, deploys, staff bot controls ────────────
    bots.register(socket, safe);

    // ── Talkoboard: stroke lifecycle + state sync ───────────────────────

    const boardViewFor = (viewer) => {
      const bs = getBoardState(viewer.roomId);
      const room = state.rooms.get(viewer.roomId);
      const active = {};
      for (const [uid, stroke] of bs.active) {
        const u = room && room.users.find((x) => x.id === uid);
        if (u && !canRecipientSeeDevUser(viewer, u)) continue;
        active[uid] = stroke;
      }
      return { strokes: bs.strokes, active, claims: boardClaims(bs) };
    };

    socket.on(
      "board open",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        // Watching staff get the board to look at and nothing else: no claim,
        // no open flag, and no status going out to the room.
        if (socket.spectating) return socket.emit("board state", boardViewFor(socket));
        const barred = boardBarredUntil(
          socket.roomId,
          socket.handshake.session.userId,
        );
        if (barred) return socket.emit("board barred", { until: barred });
        socket.boardOpen = true;
        markBoardClaimBack(socket.roomId, socket.handshake.session.userId);
        clearAFKTimers(socket.handshake.session.userId);

        const bs = getBoardState(socket.roomId);
        const room = state.rooms.get(socket.roomId);
        const activeObj = {};
        for (const [uid, stroke] of bs.active) {
          const u = room && room.users.find((x) => x.id === uid);
          if (u && !canRecipientSeeDevUser(socket, u)) continue;
          activeObj[uid] = stroke;
        }
        socket.emit("board state", {
          strokes: bs.strokes,
          active: activeObj,
          claims: boardClaims(bs),
        });

        emitSubAppEvent(
          socket,
          "board user status",
          { userId: socket.handshake.session.userId, open: true },
          false,
        );
      }),
    );

    // ── Talkoboard: who drew a stroke (staff only) ──────────────────────
    socket.on(
      "board who drew",
      safe(async (data) => {
        if (!socket.roomId) return;
        if (!isStaffSocket(socket)) return;
        const id = typeof data?.id === "string" ? data.id : null;
        if (!id) return;

        const bs = getBoardState(socket.roomId);
        let stroke = bs.strokes.find((s) => s.id === id);
        if (!stroke) {
          for (const [, s] of bs.active) {
            if (s && s.id === id) {
              stroke = s;
              break;
            }
          }
        }
        if (!stroke || !stroke.owner)
          return socket.emit("board stroke author", { id, unknown: true });

        const room = state.rooms.get(socket.roomId);
        const user = room?.users?.find((u) => u.id === stroke.owner);
        if (user && !canRecipientSeeDevUser(socket, user))
          return socket.emit("board stroke author", { id, unknown: true });

        socket.emit("board stroke author", {
          id,
          userId: stroke.owner,
          username: user ? user.username : null,
          present: !!user,
          barredUntil: boardBarredUntil(socket.roomId, stroke.owner) || 0,
        });
      }),
    );

    // ── Talkoboard: claiming a patch of the board ───────────────────────
    socket.on(
      "board claim",
      safe(async (data) => {
        const userId = socket.handshake.session?.userId;
        if (!socket.roomId || !userId || socket.spectating) return;
        if (boardBarredUntil(socket.roomId, userId)) return;

        const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
        const x = num(data?.x);
        const y = num(data?.y);
        const w = num(data?.w);
        const h = num(data?.h);
        if (x === null || y === null || w === null || h === null) return;
        if (w < CLAIM_MIN || h < CLAIM_MIN)
          return socket.emit("board claim result", {
            ok: false,
            message: "Too small to be worth fencing off",
          });
        if (w > CLAIM_MAX || h > CLAIM_MAX)
          return socket.emit("board claim result", {
            ok: false,
            message: "That is more board than one person may take",
          });

        const bs = getBoardState(socket.roomId);
        const claims = boardClaims(bs);
        const want = { x, y, w, h };
        for (const c of claims)
          if (c.owner !== userId && claimsOverlap(c, want))
            return socket.emit("board claim result", {
              ok: false,
              message: "That overlaps " + (c.name || "someone") + "'s area",
            });

        const room = state.rooms.get(socket.roomId);
        const me = room?.users?.find((u) => u.id === userId);
        const next = {
          owner: userId,
          name: (me && me.username) || "Someone",
          x,
          y,
          w,
          h,
          ts: Date.now(),
        };
        bs.claims = claims.filter((c) => c.owner !== userId).concat([next]);
        sendClaims(socket.roomId);
        socket.emit("board claim result", { ok: true });
      }),
    );

    socket.on(
      "board unclaim",
      safe(async (data) => {
        const userId = socket.handshake.session?.userId;
        if (!socket.roomId || !userId) return;
        const target =
          typeof data?.owner === "string" && isStaffSocket(socket)
            ? data.owner
            : userId;
        const bs = boardState.get(socket.roomId);
        if (!bs || !Array.isArray(bs.claims)) return;
        const gone = bs.claims.find((c) => c.owner === target);
        if (!gone) return;
        bs.claims = bs.claims.filter((c) => c.owner !== target);
        sendClaims(socket.roomId);
        if (target !== userId) {
          const room = state.rooms.get(socket.roomId);
          logStaff(
            socket,
            "release board area",
            room?.users?.find((u) => u.id === target) || `user:${target}`,
            room,
          );
        }
      }),
    );

    // ── Talkoboard mod tools: one person, not the whole board ───────────
    socket.on(
      "board wipe user",
      safe(async (data) => {
        if (!socket.roomId) return;
        if (!isStaffSocket(socket)) return;
        const userId = typeof data?.userId === "string" ? data.userId : null;
        if (!userId) return;

        const room = state.rooms.get(socket.roomId);
        const target = room?.users?.find((u) => u.id === userId) || null;
        if (target && !canRecipientSeeDevUser(socket, target)) return;

        const bs = getBoardState(socket.roomId);
        const before = bs.strokes.length;
        bs.strokes = bs.strokes.filter((s) => s.owner !== userId);
        const gone = before - bs.strokes.length;
        bs.active.delete(userId);
        saveBoardSoon();
        io().to(socket.roomId).emit("board user wiped", { userId, n: gone });
        logStaff(
          socket,
          "wipe board drawings",
          target || `user:${userId}`,
          room,
          gone + (gone === 1 ? " stroke" : " strokes"),
        );
      }),
    );

    socket.on(
      "board bar user",
      safe(async (data) => {
        if (!socket.roomId) return;
        if (!isStaffSocket(socket)) return;
        const userId = typeof data?.userId === "string" ? data.userId : null;
        if (!userId) return;
        if (userId === socket.handshake.session?.userId) return;

        const room = state.rooms.get(socket.roomId);
        const target = room?.users?.find((u) => u.id === userId) || null;
        if (target && !canRecipientSeeDevUser(socket, target)) return;
        if (target && (target.isDev || target.isMod) && !socket.isDev)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Only a developer can take another staff member off the board.",
            ),
          );

        const bs = getBoardState(socket.roomId);
        const bar = boardBarMap(bs);

        if (data?.allow) {
          if (!bar.delete(userId)) return;
          for (const s of findSocketsByUserId(userId))
            if (s.roomId === socket.roomId) s.emit("board allowed", {});
          logStaff(
            socket,
            "allow back on board",
            target || `user:${userId}`,
            room,
          );
          return;
        }

        const until = Date.now() + BOARD_BAR_MS;
        bar.set(userId, until);
        if (bs.active.delete(userId))
          io().to(socket.roomId).emit("board stroke end", { userId });
        for (const s of findSocketsByUserId(userId)) {
          if (s.roomId !== socket.roomId) continue;
          s.boardOpen = false;
          s.emit("board barred", { until });
        }
        io()
          .to(socket.roomId)
          .emit("board user status", { userId, open: false });
        logStaff(
          socket,
          "remove from board",
          target || `user:${userId}`,
          room,
          Math.round(BOARD_BAR_MS / 60000) + " minutes",
        );
      }),
    );

    socket.on(
      "board stroke start",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        const barred = boardBarredUntil(socket.roomId, userId);
        if (barred) return socket.emit("board barred", { until: barred });

        if (
          !data ||
          typeof data.color !== "string" ||
          !Number.isFinite(data.size)
        )
          return;
        if (
          !data.point ||
          typeof data.point.x !== "number" ||
          typeof data.point.y !== "number"
        )
          return;

        const strokeId =
          typeof data.id === "string" && data.id.length <= 64 ? data.id : null;

        const bsClaim = getBoardState(socket.roomId);
        const blocked = claimBlocking(
          socket,
          bsClaim,
          data.point.x,
          data.point.y,
        );
        if (blocked)
          return socket.emit("board blocked", {
            name: blocked.name || "Someone",
          });

        const stroke = {
          id: strokeId,
          owner: userId,
          points: [{ x: data.point.x, y: data.point.y }],
          color: data.color.slice(0, 7),
          // Brush sizes are world units and zoom-relative on the client
          // (screen px / zoom), so deep zoom sends tiny fractions and far
          // zoom-out sends large ones.
          size: Math.min(Math.max(data.size, 1e-9), 5000),
          eraser: !!data.eraser,
          gradient: data.eraser ? null : sanitizeGradient(data.gradient),
        };

        const bs = getBoardState(socket.roomId);
        finalizeBoardUserStroke(socket.roomId, userId);
        bs.active.set(userId, stroke);

        emitSubAppEvent(
          socket,
          "board stroke start",
          {
            userId,
            id: stroke.id,
            color: stroke.color,
            size: stroke.size,
            eraser: stroke.eraser,
            gradient: stroke.gradient,
            point: stroke.points[0],
          },
          false,
        );
      }),
    );

    socket.on(
      "board stroke move",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;

        if (!data?.points || !Array.isArray(data.points)) return;
        if (data.points.length > 200) return;

        const bs = getBoardState(socket.roomId);
        const active = bs.active.get(userId);
        if (!active) return;

        const validPoints = [];
        let last = active.points[active.points.length - 1] || null;
        let stoppedBy = null;
        for (const p of data.points) {
          if (typeof p.x !== "number" || typeof p.y !== "number") continue;
          const hit = last
            ? claimCrossed(socket, bs, last.x, last.y, p.x, p.y)
            : claimBlocking(socket, bs, p.x, p.y);
          if (hit) {
            stoppedBy = hit;
            break;
          }
          validPoints.push({ x: p.x, y: p.y });
          last = p;
        }

        if (stoppedBy) {
          if (validPoints.length) {
            active.points.push(...validPoints);
            emitSubAppEvent(
              socket,
              "board stroke move",
              { userId, points: validPoints },
              false,
            );
          }
          finalizeBoardUserStroke(socket.roomId, userId);
          emitSubAppEvent(socket, "board stroke end", { userId }, false);
          socket.emit("board blocked", { name: stoppedBy.name || "Someone" });
          return;
        }

        if (validPoints.length === 0) return;

        active.points.push(...validPoints);

        if (active.points.length > MAX_POINTS_PER_STROKE) {
          active.points = active.points.slice(-MAX_POINTS_PER_STROKE);
        }

        emitSubAppEvent(
          socket,
          "board stroke move",
          {
            userId,
            points: validPoints,
          },
          false,
        );
      }),
    );

    socket.on(
      "board stroke end",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        finalizeBoardUserStroke(socket.roomId, userId);
        emitSubAppEvent(socket, "board stroke end", { userId }, false);
      }),
    );

    // ── Undo: remove one of YOUR OWN completed strokes, board-wide ──────
    socket.on(
      "board stroke remove",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        const id = data?.id;
        if (typeof id !== "string" || id.length > 64) return;

        const bs = getBoardState(socket.roomId);
        const idx = bs.strokes.findIndex(
          (s) => s.id === id && s.owner === userId,
        );
        if (idx !== -1) {
          bs.strokes.splice(idx, 1);
          saveBoardSoon();
        } else {
          const active = bs.active.get(userId);
          if (active && active.id === id) bs.active.delete(userId);
          else return;
        }
        emitSubAppEvent(socket, "board stroke remove", { id }, false);
      }),
    );

    // ── Redo: re-add a stroke you previously undid, board-wide ──────────
    socket.on(
      "board stroke add",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        if (boardBarredUntil(socket.roomId, userId)) return;
        if (!allowBoardAdd(userId)) {
          const wait = Math.ceil(boardAddWaitMs(userId) / 1000);
          return socket.emit("board too fast", {
            id:
              typeof data?.stroke?.id === "string"
                ? data.stroke.id.slice(0, 64)
                : null,
            wait,
            message:
              "Too many shapes at once" + (wait ? " - wait " + wait + "s" : ""),
          });
        }
        const s = data?.stroke;
        if (!s || typeof s !== "object") return;
        if (typeof s.id !== "string" || s.id.length > 64) return;
        if (!Array.isArray(s.points) || s.points.length === 0) return;

        const points = [];
        for (const p of s.points) {
          if (typeof p?.x === "number" && typeof p?.y === "number") {
            points.push({ x: p.x, y: p.y });
            if (points.length >= MAX_POINTS_PER_STROKE) break;
          }
        }
        if (points.length === 0) return;

        const bsAdd = getBoardState(socket.roomId);
        const refuse = (c) =>
          socket.emit("board blocked", {
            id: s.id,
            name: c.name || "Someone",
          });
        for (let i = 0; i < points.length; i++) {
          const a = points[i];
          const b = points[i + 1] || a;
          const c = claimCrossed(socket, bsAdd, a.x, a.y, b.x, b.y);
          if (c) return refuse(c);
        }
        if (s.fill && !isStaffSocket(socket)) {
          const rings =
            Array.isArray(s.rings) && s.rings.length ? s.rings : [points];
          for (const c of boardClaims(bsAdd)) {
            if (c.owner === userId) continue;
            const mid = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
            if (pointInRings(rings, mid)) return refuse(c);
          }
        }

        const stroke = {
          id: s.id,
          owner: userId,
          points,
          color: typeof s.color === "string" ? s.color.slice(0, 7) : "#000000",
          size: Math.min(Math.max(Number(s.size) || 3, 1e-9), 5000),
          eraser: !!s.eraser,
          gradient: s.eraser ? null : sanitizeGradient(s.gradient),
          fill: !!s.fill,
          rings: s.fill
            ? sanitizeRings(s.rings, MAX_POINTS_PER_STROKE - points.length)
            : null,
          sharp: !!s.sharp,
        };

        const bs = getBoardState(socket.roomId);
        if (bs.strokes.some((x) => x.id === stroke.id)) return;
        bs.strokes.push(stroke);
        trimBoard(bs);
        saveBoardSoon();
        emitSubAppEvent(socket, "board stroke add", { userId, stroke }, false);
      }),
    );

    socket.on(
      "board close",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        socket.boardOpen = false;
        finalizeBoardUserStroke(socket.roomId, userId);
        setupAFKTimers(socket, userId);
        emitSubAppEvent(
          socket,
          "board user status",
          { userId, open: false },
          false,
        );
      }),
    );

    socket.on(
      "board cursor",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (typeof data?.x !== "number" || typeof data?.y !== "number") return;
        emitSubAppEvent(
          socket,
          "board cursor",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            x: data.x,
            y: data.y,
          },
          false,
        );
      }),
    );

    socket.on(
      "board chat",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (!data?.text || typeof data.text !== "string") return;
        const text = chatguard.clean(data.text, 200);
        if (!text) return;
        emitSubAppEvent(
          socket,
          "board chat",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            text,
            timestamp: Date.now(),
          },
          true,
        );
      }),
    );

    socket.on(
      "board clear",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (!socket.isDev && !socket.isMod) return;
        const bs = boardState.get(socket.roomId);
        if (bs) {
          bs.strokes = [];
          bs.active.clear();
        }
        saveBoardSoon();
        io().to(socket.roomId).emit("board clear");
        const room = state.rooms.get(socket.roomId);
        logStaff(socket, "clear board", null, room);
      }),
    );

    // ── Create Room ─────────────────────────────────────────────────────
    socket.on(
      "create room",
      safe(async (data) => {
        if (!data || typeof data !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const userId = socket.handshake.session?.userId;
        if (!userId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.UNAUTHORIZED,
              "Sign in to create a room.",
            ),
          );

        const creatorIsStaff = !!socket.isDev || !!socket.isMod;
        if (state.maintenance && !creatorIsStaff)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Talkomatic is in maintenance mode. Creating new rooms is paused " +
                "while people finish their conversations.",
              null,
              true,
            ),
          );
        if (!CONFIG.FEATURES.ENABLE_ROOM_CREATION && !creatorIsStaff)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Room creation is temporarily disabled.",
              null,
              true,
            ),
          );

        const valErr = validateObject(data, {
          name: { rule: "roomName" },
          type: { rule: "roomType" },
          accessCode: { rule: "accessCode", context: data.type },
        });
        if (valErr) return socket.emit("validation_error", valErr);

        const maxSize = newRoomCapacity(data?.maxSize, socket);

        const { username, location } = socket.handshake.session;
        if (
          normalize(username) === "anonymous" &&
          normalize(location) === "on the web"
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Anonymous users cannot create rooms.",
            ),
          );

        if (
          state.rooms.size - diag.simRoomCount() >=
          CONFIG.LIMITS.HARD_MAX_ROOMS
        ) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_LIMIT_REACHED,
              "Server is at maximum capacity. Please try again shortly.",
            ),
          );
        }

        const healthyCount = getHealthyRoomCount();
        const limit = calculateCurrentRoomLimit();
        if (healthyCount >= limit) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_LIMIT_REACHED,
              `Room limit reached (${limit}). Try again in a moment.`,
            ),
          );
        }

        if (
          !creatorIsStaff &&
          getUsernameLocationRoomsCount(username, location, userId) >=
            CONFIG.LIMITS.MAX_ROOMS_PER_USER
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.FORBIDDEN, "Already in a room."),
          );
        if (
          !creatorIsStaff &&
          getUserRoomsCount(userId) >= CONFIG.LIMITS.MAX_ROOMS_PER_USER
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.FORBIDDEN, "Already in a room."),
          );

        const now = Date.now();
        if (
          now - (state.lastRoomCreationTimes.get(userId) || 0) <
          CONFIG.TIMING.ROOM_CREATION_COOLDOWN
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              "Creating rooms too fast.",
            ),
          );

        const ipRoomCount = getRoomCountByIP(clientIp);
        if (ipRoomCount >= CONFIG.LIMITS.MAX_ROOMS_PER_IP) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              "Too many rooms from this connection.",
            ),
          );
        }

        const lastIpCreation = state.ipLastRoomCreation.get(clientIp) || 0;
        if (now - lastIpCreation < CONFIG.LIMITS.IP_ROOM_CREATION_COOLDOWN) {
          const waitSec = Math.ceil(
            (CONFIG.LIMITS.IP_ROOM_CREATION_COOLDOWN - (now - lastIpCreation)) /
              1000,
          );
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              `Please wait ${waitSec}s before creating another room.`,
            ),
          );
        }

        let roomName = enforceRoomNameLimit(sanitizeName(data.name));
        if (!roomName) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains no valid characters.",
            ),
          );
        }
        if (roomNameExists(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_NAME_EXISTS,
              "Room name already exists.",
            ),
          );
        if (
          CONFIG.FEATURES.ENABLE_WORD_FILTER &&
          wordFilter.checkText(roomName).hasOffensiveWord
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains forbidden words.",
            ),
          );
        if (ipredact.containsIp(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name cannot contain an IP address.",
            ),
          );
        if (linkfilter.containsLink(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name cannot contain a link.",
            ),
          );
        if (!nameguard.check(roomName).ok)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name can only use ordinary letters, numbers and punctuation.",
            ),
          );

        state.lastRoomCreationTimes.set(userId, now);
        state.ipLastRoomCreation.set(clientIp, now);

        let roomId,
          attempts = 0;
        do {
          roomId = generateRoomId();
          attempts++;
          if (attempts > CONFIG.LIMITS.MAX_ID_GEN_ATTEMPTS)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.SERVER_ERROR,
                "Could not generate room ID.",
              ),
            );
        } while (state.rooms.has(roomId));

        state.rooms.set(roomId, {
          id: roomId,
          name: roomName,
          type: data.type,
          layout: "vertical",
          maxSize,
          allowBots: data.allowBots !== false,
          users: [],
          accessCode: data.type === "semi-private" ? data.accessCode : null,
          votes: {},
          bannedUserIds: new Set(),
          lastActiveTime: now,
          createdAt: now,
        });

        if (data.type === "semi-private" && data.accessCode) {
          if (!socket.handshake.session.validatedRooms)
            socket.handshake.session.validatedRooms = {};
          socket.handshake.session.validatedRooms[roomId] = data.accessCode;
          await promisifySessionSave(socket.handshake.session).catch(() => {});
        }

        state.apiCache.delete("public_rooms");
        socket.emit("room created", roomId);
        updateLobby();
        await debouncedSaveRooms();
        const stats = getRoomStatistics();
        console.log(
          `Room created: ${roomId} (${roomName}) by IP:${clientIp} | ` +
            `Total: ${stats.totalRooms}/${stats.hardCap} | ` +
            `Healthy: ${stats.healthyRooms}/${stats.currentLimit} | ` +
            `Solo TTL: ${stats.currentSoloTTL}s`,
        );
      }),
    );

    // ── Join Room ───────────────────────────────────────────────────────
    socket.on(
      "join room",
      safe(async (data) => {
        if (!data?.roomId)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid data."),
          );
        const room = state.rooms.get(data.roomId);
        if (!room)
          return socket.emit(
            "room not found",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );

        let { username, location, userId } = socket.handshake.session || {};
        if (!socket.handshake.session)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.SERVER_ERROR, "Session error."),
          );
        if (isGuestName(username))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.UNAUTHORIZED,
              "Choose a username in the lobby before joining a room.",
              { needsUsername: true },
              true,
            ),
          );
        if (!userId) {
          userId = socket.handshake.sessionID;
          socket.handshake.session.userId = userId;
        }
        location = location || "On The Web";

        if (!socket.isDev && !socket.isMod) {
          const cur = getOwnCurrentRoom(userId);
          if (cur && cur !== data.roomId) {
            const n = state.rooms.get(cur)?.name || "Unknown";
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                `Already in "${n}". Leave first.`,
                { currentRoomId: cur, currentRoomName: n },
                true,
              ),
            );
          }
        }

        const bypassAccessCode = socket.isMainDev;
        if (room.type === "semi-private" && !bypassAccessCode) {
          const validated =
            socket.handshake.session.validatedRooms?.[data.roomId];
          let code = data.accessCode;
          if (validated) code = validated;
          else if (!code) return socket.emit("access code required");
          if (
            typeof code !== "string" ||
            code.length !== 6 ||
            !/^\d+$/.test(code)
          )
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.VALIDATION_ERROR,
                "Invalid access code format.",
              ),
            );
          if (room.accessCode !== code)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                "Incorrect access code.",
              ),
            );
          if (!validated && socket.handshake.session) {
            if (!socket.handshake.session.validatedRooms)
              socket.handshake.session.validatedRooms = {};
            socket.handshake.session.validatedRooms[data.roomId] = code;
            await promisifySessionSave(socket.handshake.session).catch(
              () => {},
            );
          }
        }
        joinRoom(socket, data.roomId, userId);
      }),
    );

    // ── Vote Kick ───────────────────────────────────────────────────────
    socket.on(
      "vote",
      safe(async (data) => {
        if (!data?.targetUserId) return;
        const userId = socket.handshake.session?.userId;
        const roomId = socket.roomId;
        if (!roomId || !userId) return;
        const room = state.rooms.get(roomId);
        if (
          !room ||
          !room.users.find((u) => u.id === userId) ||
          userId === data.targetUserId
        )
          return;
        if (room.users.length < CONFIG.LIMITS.MIN_USERS_FOR_VOTING) return;
        if (!room.users.find((u) => u.id === data.targetUserId)) return;
        if (
          getUserStaffRole(data.targetUserId) &&
          !isUserStaffHidden(data.targetUserId)
        )
          return;
        if (!room.votes) room.votes = {};
        if (room.votes[userId] === data.targetUserId) delete room.votes[userId];
        else room.votes[userId] = data.targetUserId;
        emitRoomVoteUpdates(roomId);
        if (votesAgainst(room, data.targetUserId) > voteThreshold(room)) {
          const target = findSocketByUserId(data.targetUserId, roomId);
          if (target) {
            target.emit("kicked");
            if (!room.bannedUserIds) room.bannedUserIds = new Set();
            room.bannedUserIds.add(data.targetUserId);
            await leaveRoom(target, data.targetUserId);
          } else if (
            bots.isActiveBot(data.targetUserId) ||
            diag.isHeld(data.targetUserId)
          ) {
            if (!room.bannedUserIds) room.bannedUserIds = new Set();
            room.bannedUserIds.add(data.targetUserId);
            const gone = room.users.find((u) => u.id === data.targetUserId);
            room.users = room.users.filter((u) => u.id !== data.targetUserId);
            emitRoomUserLeft(roomId, data.targetUserId, gone);
            bots.noteEvicted(data.targetUserId);
            diag.noteEvicted(data.targetUserId);
            updateRoom(roomId);
            updateRoomSoloTracking(roomId);
            updateLobby();
          }
        }
      }),
    );

    socket.on(
      "leave room",
      safe(async () => {
        const userId = socket.handshake.session?.userId;
        if (userId) {
          clearAFKTimers(userId);
          await leaveRoom(socket, userId);
        }
      }),
    );

    // ── Tab-away AFK flag (client reports via Page Visibility API) ──────
    socket.on(
      "afk state",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating || socket.isBot) return;
        const userId = socket.handshake.session.userId;
        const room = state.rooms.get(socket.roomId);
        const user = room?.users?.find((u) => u.id === userId);
        if (!user) return;
        const isAfk = !!data?.isAfk;
        if (!!user.isAfk === isAfk) return;
        // Going AFK is throttled; coming back never is, so a user can't get
        // stuck showing as away.
        if (isAfk) {
          const now = Date.now();
          if (now - (socket._afkStateTick || 0) < 5000) return;
          socket._afkStateTick = now;
        }
        user.isAfk = isAfk;
        emitRoomAfkUpdate(socket, userId, isAfk);
      }),
    );

    // ── Chat Updates (diff-based, batched) ──────────────────────────────
    socket.on(
      "chat update",
      safe(async (data) => {
        if (!checkChatCircuit())
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.CIRCUIT_OPEN,
              "System temporarily unavailable.",
            ),
          );
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (socket.frozen) return;
        const userId = socket.handshake.session.userId;
        if (socket.deviceId && Date.now() - (socket._idTick || 0) > 30000) {
          socket._idTick = Date.now();
          identity.tick(
            socket.deviceId,
            socket.handshake.session.username,
            socket.handshake.session.location,
          );
        }
        if (!data?.diff || typeof data.diff !== "object")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid chat data."),
          );
        const { diff } = data;
        if (!["full-replace", "add", "delete", "replace"].includes(diff.type))
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Unknown diff type."),
          );
        if (
          (diff.type === "add" ||
            diff.type === "replace" ||
            diff.type === "full-replace") &&
          typeof diff.text !== "string"
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Diff text must be string.",
            ),
          );
        if (diff.text) diff.text = enforceCharacterLimit(diff.text);
        if (
          diff.type !== "full-replace" &&
          (typeof diff.index !== "number" || diff.index < 0)
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid diff index."),
          );
        if (
          diff.type === "delete" &&
          (typeof diff.count !== "number" || diff.count < 0)
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Invalid delete count.",
            ),
          );

        if (!state.pendingChatUpdates.has(userId))
          state.pendingChatUpdates.set(userId, { diffs: [] });
        state.pendingChatUpdates.get(userId).diffs.push(diff);
        if (!state.batchProcessingTimers.has(userId)) {
          state.batchProcessingTimers.set(
            userId,
            setTimeout(
              () => processPendingChatUpdates(userId, socket),
              getBatchInterval(socket.roomId),
            ),
          );
        }
      }),
    );

    socket.on(
      "typing",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating || socket.frozen) return;
        const userId = socket.handshake.session.userId;
        const username = socket.handshake.session.username || "Anonymous";
        if (data?.isTyping === false) {
          handleTyping(socket, userId, username, false);
          return;
        }
        await typingLimiter.consume(userId).catch(() => {});
        if (!data || typeof data.isTyping !== "boolean") return;
        handleTyping(socket, userId, username, data.isTyping);
      }),
    );

    socket.on(
      "get rooms",
      safe(async () => {
        const data = Array.from(state.rooms.values())
          .filter((r) => r.type !== "private")
          .map((r) => formatRoomForSocket(r, socket));

        socket.emit("initial rooms", data);
        socket.emit("lobby ticker", { message: state.lobbyTicker || "" });
        socket.emit("maintenance status", { enabled: state.maintenance });

        if (socket.isDev) {
          const codes = {};
          if (socket.isMainDev) {
            for (const [roomId, room] of state.rooms) {
              if (room.type === "semi-private" && room.accessCode) {
                codes[roomId] = room.accessCode;
              }
            }
          }
          socket.emit("dev lobby context", codes);
        }
      }),
    );

    socket.on(
      "get room state",
      safe(async (roomId) => {
        if (!roomId || typeof roomId !== "string")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Room ID required."),
          );
        const room = state.rooms.get(roomId);
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        if (
          room.type !== "public" &&
          socket.roomId !== roomId &&
          !socket.isMainDev
        )
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        socket.emit("room state", formatRoomStateForSocket(room, socket));
      }),
    );

    // ── Dev Mode: Force-Kick ────────────────────────────────────────────
    socket.on(
      "dev force kick",
      safe(async (data) => {
        if (!socket.isDev) {
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.FORBIDDEN, "Access denied."),
          );
        }

        if (!data?.targetUserId || typeof data.targetUserId !== "string") {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        }

        if (!canActOn(socket, data.targetUserId)) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        }

        const targetUserId = data.targetUserId;
        let targetRoomId = null;
        let targetRoom = null;
        for (const [roomId, room] of state.rooms) {
          if (room.users && room.users.some((u) => u.id === targetUserId)) {
            targetRoomId = roomId;
            targetRoom = room;
            break;
          }
        }

        if (!targetRoom) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User not found in any room.",
            ),
          );
        }

        const targetSocket = findSocketByUserId(targetUserId, targetRoomId);
        if (!targetSocket) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User socket not found.",
            ),
          );
        }

        const targetUser = targetRoom.users.find((u) => u.id === targetUserId);
        const targetName = targetUser?.username || "Unknown";
        const roomName = targetRoom.name || targetRoomId;

        targetSocket.emit("kicked");
        await leaveRoom(targetSocket, targetUserId);

        console.log(
          `[DEV] Force-kicked "${targetName}" from "${roomName}" by dev user`,
        );

        socket.emit("dev kick success", {
          targetUserId,
          targetUsername: targetName,
          roomId: targetRoomId,
          roomName,
        });
      }),
    );

    // ── Dev Mode: Set Username Color ────────────────────────────────────
    socket.on(
      "dev set color",
      safe(async (data) => {
        if (!socket.isDev) return;
        if (!data?.color || typeof data.color !== "string") return;
        if (!/^#[0-9a-fA-F]{6}$/.test(data.color)) return;

        const userId = socket.handshake.session?.userId;
        if (!userId || !socket.roomId) return;

        const room = state.rooms.get(socket.roomId);
        if (!room) return;

        const user = room.users.find((u) => u.id === userId);
        if (user) {
          user.devColor = data.color;
        }

        updateRoom(socket.roomId);
      }),
    );

    // ── Dev Mode: Vanish (invisible to non-devs) ────────────────────────
    socket.on(
      "dev set vanish",
      safe(async (data) => {
        if (!socket.isDev) return;
        const desired =
          typeof data?.isVanished === "boolean"
            ? data.isVanished
            : !socket.isVanished;

        socket.isVanished = desired;

        const userId = socket.handshake.session?.userId;
        if (userId && socket.roomId) {
          const room = state.rooms.get(socket.roomId);
          const user = room?.users?.find((u) => u.id === userId);
          if (user) user.isVanished = desired;
          updateRoom(socket.roomId);
          updateLobby();
          sendDevRoomContext(socket.roomId);
        }
        socket.emit("dev vanish status", { isVanished: desired });
      }),
    );

    // ── Staff: Hide Flair (dev crown or mod badge) ──────────────────────
    socket.on(
      "dev set hide",
      safe(async (data) => {
        if (!socket.isDev && !socket.isMod) return;
        const desired =
          typeof data?.isHidden === "boolean"
            ? data.isHidden
            : !socket.isHidden;

        socket.isHidden = desired;

        if (socket.handshake?.session) {
          socket.handshake.session.isDevHidden = desired;
          await promisifySessionSave(socket.handshake.session).catch(() => {});
        }

        const userId = socket.handshake.session?.userId;
        if (userId) {
          for (const s of findSocketsByUserId(userId)) {
            s.isHidden = desired;
            if (s !== socket) s.emit("dev hide status", { isHidden: desired });
          }
          for (const [rid, room] of state.rooms) {
            const user = room?.users?.find((u) => u.id === userId);
            if (!user) continue;
            user.isHidden = desired;
            updateRoom(rid);
            sendDevRoomContext(rid);
          }
          updateLobby();
        }
        staffchat.presenceDirty();
        socket.emit("dev hide status", { isHidden: desired });
      }),
    );

    // ════════════════════════════════════════════════════════════════════
    // ════════════════════════════════════════════════════════════════════

    // ── Kick + room ban (mod + dev) ─────────────────────────────────────
    socket.on(
      "staff kick",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId || typeof targetUserId !== "string")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User not found in any room.",
            ),
          );
        const targetUser = room.users.find((u) => u.id === targetUserId);
        const canBan =
          socket.isDev || (socket.isMod && (socket.modLevel || 2) >= 2);
        const ban = canBan && data.ban !== false;
        if (ban) {
          if (!room.bannedUserIds) room.bannedUserIds = new Set();
          room.bannedUserIds.add(targetUserId);
        }
        const targetSocket = findSocketByUserId(targetUserId, roomId);
        if (targetSocket) {
          targetSocket.emit("kicked", {
            message: "You were removed from this room by staff.",
          });
          await leaveRoom(targetSocket, targetUserId);
        } else {
          room.users = room.users.filter((u) => u.id !== targetUserId);
          emitRoomUserLeft(roomId, targetUserId, targetUser);
          bots.noteEvicted(targetUserId);
          diag.noteEvicted(targetUserId);
          updateRoom(roomId);
          updateRoomSoloTracking(roomId);
          updateLobby();
        }
        logStaff(socket, ban ? "kick+ban" : "kick", targetUser, room);
        socket.emit("staff action result", {
          action: "kick",
          ok: true,
          targetUserId,
          username: targetUser?.username,
          ban,
          roomId,
        });
        clearReportAfterAction(socket, targetUserId);
      }),
    );

    // ── IP block with duration picker (mod ≤ 7d, dev any/permanent) ─────
    socket.on(
      "staff ip block",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!requireModLevel(socket, 2)) return;
        const targetUserId = data?.targetUserId;
        const duration = data?.duration;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const DURATIONS = {
          "1h": 3600000,
          "24h": 86400000,
          "7d": 604800000,
        };
        let ms;
        if (duration === "permanent") {
          if (!socket.isDev)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                "Only devs can place permanent IP blocks.",
              ),
            );
          ms = Infinity;
        } else if (DURATIONS[duration] !== undefined) {
          ms = DURATIONS[duration];
        } else {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Invalid duration. Use 1h, 24h, 7d" +
                (socket.isDev ? ", or permanent." : "."),
            ),
          );
        }
        const targetSocket = findSocketsByUserId(targetUserId)[0];
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        let ip = targetSocket?.clientIp || null;
        let blockedName = null;
        let blockedDid = targetSocket?.deviceId || null;
        if (ip) {
          blockedName =
            targetUser?.username ||
            targetSocket?.handshake?.session?.username ||
            null;
        } else {
          const off = resolveOfflineTarget(targetUserId);
          if (!off || !off.ip)
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.NOT_FOUND,
                "No IP on file for this user. They need to be reported at least once while online before an offline block is possible.",
              ),
            );
          if (off.role === "dev" || (off.role === "mod" && !socket.isDev))
            return socket.emit(
              "error",
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                "You cannot act on this user.",
              ),
            );
          ip = off.ip;
          blockedName = off.name || null;
          blockedDid = off.deviceId || null;
        }
        const expiry =
          ms === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + ms;
        const reason =
          sanitizeMessage(
            typeof data?.reason === "string" ? data.reason : "",
          ).slice(0, 500) || null;

        const cidr =
          ipban.autoRangeCidr(ip) ||
          (data?.banRange ? ipban.computeRangeCidr(ip) : null);
        const blockKey = cidr || ip;
        if (
          !socket.isDev &&
          ipban.isPermanentBlock((ipban.findActiveBlock(ip) || {}).block)
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "This user is already covered by a permanent block. Only a developer can change that block.",
            ),
          );

        state.blockedIPs.set(blockKey, {
          expiry,
          label: blockedName,
          by: socket.staffLabel || null,
          byRole: socket.isDev ? "dev" : "mod",
          ts: Date.now(),
          reason,
          did: blockedDid,
        });
        blocklist.saveSoon();
        evasion.invalidate();
        banhistory.record({
          ip: blockKey,
          name: blockedName,
          action: "ban",
          by: socket.staffLabel || null,
          byRole: socket.isDev ? "dev" : "mod",
          reason,
          duration,
        });
        broadcastBlockList();
        broadcastBanHistory();

        const affected = cidr
          ? [...io().sockets.sockets.values()].filter((s) =>
              ipban.ipInCidr(s.clientIp, cidr),
            )
          : findSocketsByIp(ip);
        if (blockedDid) {
          for (const s of io().sockets.sockets.values()) {
            if (s.deviceId === blockedDid && !affected.includes(s))
              affected.push(s);
          }
        }
        for (const s of affected) {
          try {
            const uid = s.handshake?.session?.userId;
            s.emit("kicked", {
              message: "Your connection has been blocked by staff.",
            });
            if (s.roomId && uid) await leaveRoom(s, uid);
            s.disconnect(true);
          } catch (_) {}
        }
        logStaff(
          socket,
          `ip block ${duration}${cidr ? " (range)" : ""}`,
          targetUser || { id: targetUserId, name: blockedName },
          room || "-",
          reason || undefined,
        );
        socket.emit("staff action result", {
          action: "ip block",
          ok: true,
          targetUserId,
          duration,
          rangeApplied: !!cidr,
        });
        clearReportAfterAction(socket, targetUserId);
      }),
    );

    socket.on(
      "staff ban ip",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!requireModLevel(socket, 2)) return;
        const fail = (code, msg) =>
          socket.emit("error", createErrorResponse(code, msg));
        const MAX_ENTRIES = 200;
        const entries = [
          ...(Array.isArray(data?.ips) ? data.ips : []),
          typeof data?.ip === "string" ? data.ip : "",
        ]
          .map((s) => String(s || ""))
          .join("\n")
          .split(/[\s,;]+/)
          .filter(Boolean);
        if (!entries.length)
          return fail(
            ERROR_CODES.BAD_REQUEST,
            "Enter an IPv4 / IPv6 address, a range like 203.0.113.0/24, or a client id.",
          );
        if (entries.length > MAX_ENTRIES)
          return fail(
            ERROR_CODES.BAD_REQUEST,
            `That is ${entries.length} entries; ${MAX_ENTRIES} is the most in one go.`,
          );

        const duration = data?.duration;
        const DURATIONS = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
        let ms;
        if (duration === "permanent") {
          if (!socket.isDev)
            return fail(
              ERROR_CODES.FORBIDDEN,
              "Only devs can place permanent IP blocks.",
            );
          ms = Infinity;
        } else if (DURATIONS[duration] !== undefined) {
          ms = DURATIONS[duration];
        } else {
          return fail(
            ERROR_CODES.BAD_REQUEST,
            "Invalid duration. Use 1h, 24h, 7d" +
              (socket.isDev ? ", or permanent." : "."),
          );
        }
        const expiry =
          ms === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + ms;
        const reason =
          sanitizeMessage(
            typeof data?.reason === "string" ? data.reason : "",
          ).slice(0, 500) || null;

        const targets = [];
        const skipped = [];
        const seen = new Set();
        for (const entry of entries) {
          let key = null;
          let did = null;
          let range = false;
          if (entry.includes("/")) {
            const parsed = ipban.parseRangeKey(entry);
            if (!parsed) {
              skipped.push(entry);
              continue;
            }
            if (parsed.tooWide)
              return fail(
                ERROR_CODES.BAD_REQUEST,
                `${entry} is too wide to block. /${parsed.floor} is the widest range the list takes.`,
              );
            if (parsed.broad && !socket.isDev)
              return fail(
                ERROR_CODES.FORBIDDEN,
                `${entry} is wider than a /${parsed.v4 ? ipban.BROAD_IPV4_PREFIX : ipban.BROAD_IPV6_PREFIX}. Only devs can block a range that size.`,
              );
            key = parsed.key;
            range = ipban.isRangeKey(key);
          } else if (ipban.isValidIp(entry)) {
            const ip = ipban.normalizeIp(entry);
            const cidr =
              ipban.autoRangeCidr(ip) ||
              (data?.banRange ? ipban.computeRangeCidr(ip) : null);
            key = cidr || ip;
            range = !!cidr;
          } else if (/^[a-f0-9-]{8,64}$/i.test(entry) && entry.includes("-")) {
            did = entry.toLowerCase();
            key = ipban.idKey(did);
          } else {
            skipped.push(entry);
            continue;
          }
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const covering = did
            ? state.blockedIPs.get(key)
            : (ipban.findActiveBlock(key.split("/")[0]) || {}).block;
          if (!socket.isDev && ipban.isPermanentBlock(covering))
            return fail(
              ERROR_CODES.FORBIDDEN,
              `${entry} is already covered by a permanent block. Only a developer can change that block.`,
            );
          const idRec = did ? identity.getRecord(did) : null;
          targets.push({
            key,
            did,
            range,
            name: (idRec && idRec.name) || null,
          });
        }

        if (!targets.length)
          return fail(
            ERROR_CODES.BAD_REQUEST,
            skipped.length === 1
              ? `"${skipped[0]}" is not an address, a range, or a client id.`
              : "None of those are an address, a range, or a client id.",
          );

        for (const t of targets) {
          state.blockedIPs.set(t.key, {
            expiry,
            label: t.name,
            by: socket.staffLabel || null,
            byRole: socket.isDev ? "dev" : "mod",
            ts: Date.now(),
            reason,
          });
          banhistory.record({
            ip: t.key,
            name: t.name,
            action: "ban",
            by: socket.staffLabel || null,
            byRole: socket.isDev ? "dev" : "mod",
            reason,
            duration,
          });
        }
        blocklist.saveSoon();
        evasion.invalidate();
        broadcastBlockList();
        broadcastBanHistory();

        const affected = new Set();
        for (const [, s] of io().sockets.sockets)
          for (const t of targets) {
            const hit = t.did
              ? s.deviceId === t.did
              : t.range
                ? ipban.ipInCidr(s.clientIp, t.key)
                : s.clientIp === t.key;
            if (hit) {
              affected.add(s);
              break;
            }
          }
        for (const s of affected) {
          try {
            const uid = s.handshake?.session?.userId;
            s.emit("kicked", {
              message: "Your connection has been blocked by staff.",
            });
            if (s.roomId && uid) await leaveRoom(s, uid);
            s.disconnect(true);
          } catch (_) {}
        }
        const rangeCount = targets.filter((t) => t.range).length;
        logStaff(
          socket,
          targets.length === 1
            ? `ban ip ${duration}${rangeCount ? " (range)" : ""}`
            : `ban ip ${duration} (${targets.length} entries, ${rangeCount} ranges)`,
          targets.length === 1
            ? targets[0].name || targets[0].key
            : targets
                .map((t) => t.name || t.key)
                .join(", ")
                .slice(0, 400),
          "-",
          reason || undefined,
        );
        socket.emit("staff action result", {
          action: "ban ip",
          ok: true,
          duration,
          rangeApplied: rangeCount > 0,
          placed: targets.length,
          skipped: skipped.length,
        });
      }),
    );

    // ── Close room: kick everyone and delete (mod + dev) ────────────────
    socket.on(
      "staff close room",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!requireModLevel(socket, 2)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const roomLabel = { id: room.id, name: room.name };
        const userIds = (room.users || []).map((u) => u.id);
        for (const uid of userIds) {
          const s = findSocketByUserId(uid, roomId);
          if (s) {
            s.emit("kicked", {
              message: "This room was closed by staff.",
            });
            await leaveRoom(s, uid);
          }
        }
        state.rooms.delete(roomId);
        state.roomSoloSince.delete(roomId);
        state.roomLastChatActivity.delete(roomId);
        cleanupBoardState(roomId);
        if (state.roomDeletionTimers.has(roomId)) {
          clearTimeout(state.roomDeletionTimers.get(roomId));
          state.roomDeletionTimers.delete(roomId);
        }
        for (const [, s] of io().sockets.sockets) {
          if (s.spectating === roomId) {
            s.emit("spectate ended", { reason: "closed" });
            s.leave(roomId);
            s.spectating = null;
            s.roomId = null;
            s.join("lobby");
          }
        }
        state.apiCache.delete("public_rooms");
        updateLobby();
        await debouncedSaveRooms();
        logStaff(socket, "close room", null, roomLabel);
        socket.emit("staff action result", {
          action: "close room",
          ok: true,
          roomId,
        });
      }),
    );

    socket.on(
      "staff wipe buffer",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User not found in any room.",
            ),
          );
        const targetUser = room.users.find((u) => u.id === targetUserId);
        state.userMessageBuffers.set(targetUserId, "");
        if (state.batchProcessingTimers.has(targetUserId)) {
          clearTimeout(state.batchProcessingTimers.get(targetUserId));
          state.batchProcessingTimers.delete(targetUserId);
        }
        state.pendingChatUpdates.delete(targetUserId);
        const username = targetUser?.username || "Anonymous";
        const payload = {
          userId: targetUserId,
          username,
          diff: { type: "full-replace", text: "" },
        };
        for (const [, recipient] of io().sockets.sockets) {
          if (!recipient.connected || recipient.roomId !== roomId) continue;
          if (recipient.handshake?.session?.userId === targetUserId) continue;
          if (!canRecipientSeeDevUser(recipient, targetUser)) continue;
          recipient.emit("chat update", payload);
        }
        for (const s of findSocketsByUserId(targetUserId))
          s.emit("buffer wiped", {});
        logStaff(socket, "wipe buffer", targetUser, room);
        socket.emit("staff action result", {
          action: "wipe buffer",
          ok: true,
          targetUserId,
        });
      }),
    );

    // ── Warn user: private toast (mod + dev) ────────────────────────────
    socket.on(
      "staff warn",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        let message = sanitizeMessage(
          typeof data?.message === "string" ? data.message : "",
        ).slice(0, 1000);
        if (!message) message = "Please follow the room rules.";
        const targets = findSocketsByUserId(targetUserId);
        if (targets.length === 0)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "User not connected."),
          );
        for (const s of targets) s.emit("staff warning", { message });
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        logStaff(
          socket,
          "warn",
          targetUser || { id: targetUserId },
          room || "-",
          message,
        );
        socket.emit("staff action result", {
          action: "warn",
          ok: true,
          targetUserId,
        });
      }),
    );

    socket.on(
      "staff note",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canManageNotesOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot manage notes for this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        const targetSocket = findSocketByUserId(targetUserId, roomId);
        const targetDeviceId =
          targetSocket?.deviceId || targetUser?.deviceId || null;
        const note = sanitizeMessage(
          typeof data?.message === "string" ? data.message : "",
        ).slice(0, 1000);
        if (targetDeviceId) identity.setNote(targetDeviceId, note);
        if (roomId) updateRoom(roomId);
        logStaff(
          socket,
          note ? "set note" : "clear note",
          targetUser || { id: targetUserId },
          room || "-",
          note || "(cleared)",
        );
        socket.emit("staff action result", {
          action: note ? "set note" : "clear note",
          ok: true,
          targetUserId,
          note: note || null,
        });
      }),
    );

    // ── Force rename to Anonymous (mod + dev) ───────────────────────────
    socket.on(
      "staff rename",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        if (!room || !targetUser)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User not found in any room.",
            ),
          );
        const oldName = targetUser.username;
        targetUser.username = "Anonymous";
        const targetSocket = findSocketByUserId(targetUserId, roomId);
        if (targetSocket?.handshake?.session) {
          targetSocket.handshake.session.username = "Anonymous";
          await promisifySessionSave(targetSocket.handshake.session).catch(
            () => {},
          );
        }
        const existing = state.users.get(targetUserId) || { id: targetUserId };
        state.users.set(targetUserId, {
          ...existing,
          username: "Anonymous",
          location: targetUser.location,
        });
        for (const [, recipient] of io().sockets.sockets) {
          if (!recipient.connected || recipient.roomId !== roomId) continue;
          if (!canRecipientSeeDevUser(recipient, targetUser)) continue;
          recipient.emit("user renamed", {
            userId: targetUserId,
            username: "Anonymous",
            location: targetUser.location,
          });
        }
        updateRoom(roomId);
        updateLobby();
        logStaff(
          socket,
          `rename (was ${oldName})`,
          { id: targetUserId, username: "Anonymous" },
          room,
        );
        audit.recordForcedRename({
          userId: targetUserId,
          from: oldName,
          ip: targetSocket?.clientIp || null,
          by: `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`,
          byRole: socket.isDev ? "dev" : "mod",
          room: `room:${room.name || "?"}(${room.id || "?"})`,
        });
        socket.emit("staff action result", {
          action: "rename",
          ok: true,
          targetUserId,
        });
      }),
    );

    // ── Reset a user's location to the default (any staff) ──────────────
    socket.on(
      "staff reset location",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        if (!room || !targetUser)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "User not found in any room.",
            ),
          );
        const oldLocation = targetUser.location;
        targetUser.location = "On The Web";
        const targetSocket = findSocketByUserId(targetUserId, roomId);
        if (targetSocket?.handshake?.session) {
          targetSocket.handshake.session.location = "On The Web";
          await promisifySessionSave(targetSocket.handshake.session).catch(
            () => {},
          );
        }
        const existing = state.users.get(targetUserId) || { id: targetUserId };
        state.users.set(targetUserId, {
          ...existing,
          username: targetUser.username,
          location: "On The Web",
        });
        for (const [, recipient] of io().sockets.sockets) {
          if (!recipient.connected || recipient.roomId !== roomId) continue;
          if (!canRecipientSeeDevUser(recipient, targetUser)) continue;
          recipient.emit("user renamed", {
            userId: targetUserId,
            username: targetUser.username,
            location: "On The Web",
          });
        }
        updateRoom(roomId);
        updateLobby();
        logStaff(
          socket,
          `reset location (was ${oldLocation})`,
          targetUser,
          room,
        );
        socket.emit("staff action result", {
          action: "reset location",
          ok: true,
          targetUserId,
        });
      }),
    );

    // ── Turn a user's profile picture off / back on (any staff) ─────────
    socket.on(
      "staff set pfp blocked",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        const targetSocket = findSocketByUserId(targetUserId, roomId);
        const deviceId = targetSocket?.deviceId || null;
        if (!deviceId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "No device on file for this user, so their picture cannot be turned off.",
            ),
          );
        const blocked = data?.blocked !== false;
        identity.setPfpBlocked(deviceId, blocked);
        if (blocked) {
          if (targetUser) targetUser.avatar = null;
          if (targetSocket?.handshake?.session) {
            targetSocket.handshake.session.avatar = null;
            await promisifySessionSave(targetSocket.handshake.session).catch(
              () => {},
            );
          }
          if (roomId) updateRoom(roomId);
          if (targetSocket)
            targetSocket.emit("staff warning", {
              message:
                "A moderator turned your profile picture off. Contact staff if you think this was a mistake.",
            });
        }
        logStaff(
          socket,
          blocked ? "turn pfp off" : "allow pfp",
          targetUser || { id: targetUserId },
          room || "-",
        );
        socket.emit("staff action result", {
          action: blocked ? "turn pfp off" : "allow pfp",
          ok: true,
          targetUserId,
          blocked,
        });
      }),
    );

    // ── Rename a room (any staff) ───────────────────────────────────────
    socket.on(
      "staff rename room",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const valErr = validateObject(
          { name: data?.name },
          { name: { rule: "roomName" } },
        );
        if (valErr) return socket.emit("validation_error", valErr);
        const roomName = enforceRoomNameLimit(sanitizeName(data.name));
        if (!roomName)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains no valid characters.",
            ),
          );
        if (
          normalize(roomName) !== normalize(room.name) &&
          roomNameExists(roomName)
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.ROOM_NAME_EXISTS,
              "Room name already exists.",
            ),
          );
        if (
          CONFIG.FEATURES.ENABLE_WORD_FILTER &&
          wordFilter.checkText(roomName).hasOffensiveWord
        )
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name contains forbidden words.",
            ),
          );
        if (ipredact.containsIp(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name cannot contain an IP address.",
            ),
          );
        if (linkfilter.containsLink(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name cannot contain a link.",
            ),
          );
        if (!nameguard.check(roomName).ok)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name can only use ordinary letters, numbers and punctuation.",
            ),
          );
        const oldName = room.name;
        room.name = roomName;
        state.apiCache.delete("public_rooms");
        updateRoom(roomId);
        io().to(roomId).emit("room renamed", { roomId, name: roomName });
        updateLobby();
        await debouncedSaveRooms();
        logStaff(socket, `rename room (was ${oldName})`, null, room);
        socket.emit("staff action result", {
          action: "rename room",
          ok: true,
          roomId,
          name: roomName,
        });
      }),
    );

    // ── Lock room: block new joins, keep current users (any staff) ──────
    socket.on(
      "staff lock room",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const locked =
          typeof data?.locked === "boolean" ? data.locked : !room.locked;
        room.locked = locked;
        updateRoom(roomId);
        io().to(roomId).emit("room lock status", { locked });
        updateLobby();
        logStaff(socket, locked ? "lock room" : "unlock room", null, room);
        socket.emit("staff action result", {
          action: "lock room",
          ok: true,
          roomId,
          locked,
        });
      }),
    );

    // ── Slow mode: throttle the room's broadcast cadence (any staff) ────
    socket.on(
      "staff slow mode",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const enabled =
          typeof data?.enabled === "boolean" ? data.enabled : !room.slowMode;
        room.slowMode = enabled;
        updateRoom(roomId);
        io().to(roomId).emit("room slow mode", { enabled });
        logStaff(
          socket,
          enabled ? "slow mode on" : "slow mode off",
          null,
          room,
        );
        socket.emit("staff action result", {
          action: "slow mode",
          ok: true,
          roomId,
          enabled,
        });
      }),
    );

    // ── Megaphone: announcement banner to one room or all (dev) ─────────
    socket.on(
      "staff megaphone",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const message = sanitizeMessage(
          typeof data?.message === "string" ? data.message : "",
        ).slice(0, 300);
        if (!message)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Message required."),
          );
        const scope = data?.scope === "room" ? "room" : "all";
        const payload = { message, scope };
        if (scope === "room") {
          const roomId = data?.roomId || socket.roomId;
          if (!roomId || !state.rooms.has(roomId))
            return socket.emit(
              "error",
              createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
            );
          io().to(roomId).emit("megaphone", payload);
          logStaff(
            socket,
            "megaphone (room)",
            null,
            state.rooms.get(roomId),
            message,
          );
        } else {
          io().emit("megaphone", payload);
          logStaff(socket, "megaphone (all)", null, "-", message);
        }
        socket.emit("staff action result", {
          action: "megaphone",
          ok: true,
          scope,
        });
      }),
    );

    // ── Lobby ticker: editable banner at the top of the lobby (dev) ─────
    socket.on(
      "dev set ticker",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const message = sanitizeMessage(
          typeof data?.message === "string" ? data.message : "",
        ).slice(0, 200);
        state.lobbyTicker = message;
        for (const [, s] of io().sockets.sockets) {
          if (s.connected && s.rooms?.has("lobby"))
            s.emit("lobby ticker", { message });
        }
        logStaff(socket, "set ticker", null, "-", message || "(cleared)");
        socket.emit("staff action result", { action: "ticker", ok: true });
      }),
    );

    // ── Spectate: read-only watch, no slot, no listing (dev + mod) ──────
    socket.on(
      "staff spectate",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!requireModLevel(socket, 2)) return;
        const roomId = data?.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        if (!socket.isMainDev && room.type !== "public")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You can only spectate public rooms.",
            ),
          );
        if (socket.roomId && !socket.spectating)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Leave your current room before spectating.",
            ),
          );
        socket.leave("lobby");
        socket.join(roomId);
        socket.spectating = roomId;
        socket.roomId = roomId;

        socket.emit("spectate joined", spectatePayload(socket, room));
        sendDevRoomContext(roomId);
        if (!socket.isDev) logStaff(socket, "spectate", null, room);
      }),
    );

    socket.on(
      "spectate room",
      safe(async (data) => {
        const roomId = data?.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const staff = isStaffSocket(socket);
        if (!socket.isMainDev && room.type !== "public")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You can only spectate public rooms.",
            ),
          );
        if (socket.roomId && !socket.spectating)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Leave your current room before spectating.",
            ),
          );
        socket.leave("lobby");
        socket.join(roomId);
        socket.spectating = roomId;
        socket.roomId = roomId;

        socket.emit("spectate joined", spectatePayload(socket, room));
        if (staff) {
          sendDevRoomContext(roomId);
          if (!socket.isDev) logStaff(socket, "spectate", null, room);
        }
      }),
    );

    socket.on(
      "staff unspectate",
      safe(async () => {
        if (!socket.spectating) return;
        const roomId = socket.spectating;
        socket.leave(roomId);
        socket.spectating = null;
        socket.roomId = null;
        socket.join("lobby");
        socket.emit("spectate ended", {});
        updateLobby();
      }),
    );

    // ── Freeze: server-side input lock without kicking (dev) ────────────
    socket.on(
      "staff freeze",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const targets = findSocketsByUserId(targetUserId);
        if (targets.length === 0)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "User not connected."),
          );
        const frozen =
          typeof data?.frozen === "boolean" ? data.frozen : !targets[0].frozen;
        for (const s of targets) {
          s.frozen = frozen;
          s.emit("staff frozen", { frozen });
        }
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        logStaff(
          socket,
          frozen ? "freeze" : "unfreeze",
          targetUser || { id: targetUserId },
          room || "-",
        );
        socket.emit("staff action result", {
          action: "freeze",
          ok: true,
          targetUserId,
          frozen,
        });
      }),
    );

    socket.on(
      "staff silence",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (!canActOn(socket, targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot act on this user.",
            ),
          );
        const targets = findSocketsByUserId(targetUserId);
        let deviceId = null;
        for (const s of targets) if (s.deviceId) deviceId = s.deviceId;
        if (!deviceId) {
          const lk = reports.lastKnown(targetUserId);
          deviceId = (lk && lk.deviceId) || null;
        }
        if (!deviceId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "No client id on file for this user.",
            ),
          );
        const on =
          typeof data?.silenced === "boolean"
            ? data.silenced
            : !identity.isSilenced(deviceId);
        identity.setSilenced(deviceId, on);
        applySilence(targetUserId);
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        if (roomId) updateRoom(roomId);
        logStaff(
          socket,
          on ? "silence" : "unsilence",
          targetUser || { id: targetUserId },
          room || "-",
        );
        socket.emit("staff action result", {
          action: on ? "silence" : "unsilence",
          ok: true,
          targetUserId,
          silenced: on,
        });
      }),
    );

    // ── Party mode: confetti + party horn for the whole room (dev) ──────
    socket.on(
      "staff party",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        io().to(roomId).emit("party mode", {});
        logStaff(socket, "party mode", null, room);
        socket.emit("staff action result", {
          action: "party",
          ok: true,
          roomId,
        });
      }),
    );

    socket.on(
      "staff spotlight",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const roomId = data?.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        const on = typeof data?.on === "boolean" ? data.on : !room.spotlight;
        room.spotlight = on;
        updateRoom(roomId);
        updateLobby();
        logStaff(socket, on ? "spotlight on" : "spotlight off", null, room);
        socket.emit("staff action result", {
          action: "spotlight",
          ok: true,
          roomId,
          on,
        });
      }),
    );

    // ── Live feature flags (dev) ────────────────────────────────────────
    socket.on(
      "dev get flags",
      safe(async () => {
        if (!requireDev(socket)) return;
        socket.emit("dev flags", {
          wordFilter: CONFIG.FEATURES.ENABLE_WORD_FILTER,
          roomCreation: CONFIG.FEATURES.ENABLE_ROOM_CREATION,
          baseMaxRooms: CONFIG.LIMITS.BASE_MAX_ROOMS,
          maxRoomCapacity: CONFIG.LIMITS.MAX_ROOM_CAPACITY,
          maintenance: state.maintenance,
        });
      }),
    );

    socket.on(
      "dev set room size",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const roomId = data?.roomId || socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        if (!room)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "Room not found."),
          );
        let n = Math.floor(Number(data?.size));
        if (!Number.isFinite(n))
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Invalid size."),
          );
        n = Math.max(2, Math.min(50, n));
        room.maxSize = n;
        const cap = roomCapacity(room);
        const joinable = (room.users || []).filter(
          (u) => !(u.isDev && u.isVanished),
        );
        const over = joinable.length - cap;
        if (over > 0) {
          const evictable = (room.users || []).filter(
            (u) => !(u.isDev || u.isMod),
          );
          for (const u of evictable.slice(-over)) {
            const s = findSocketByUserId(u.id, roomId);
            if (s) {
              s.emit("kicked", {
                message: "The room size was reduced by staff.",
              });
              await leaveRoom(s, u.id);
            } else {
              room.users = room.users.filter((x) => x.id !== u.id);
            }
          }
        }
        updateRoom(roomId);
        updateLobby();
        state.apiCache.delete("public_rooms");
        logStaff(socket, `set room size ${n}`, null, room);
        socket.emit("staff action result", {
          action: "room size",
          ok: true,
          roomId,
          size: n,
        });
      }),
    );

    socket.on(
      "dev set flags",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        if (typeof data?.wordFilter === "boolean")
          CONFIG.FEATURES.ENABLE_WORD_FILTER = data.wordFilter;
        if (typeof data?.roomCreation === "boolean")
          CONFIG.FEATURES.ENABLE_ROOM_CREATION = data.roomCreation;
        if (
          typeof data?.baseMaxRooms === "number" &&
          data.baseMaxRooms >= 1 &&
          data.baseMaxRooms <= CONFIG.LIMITS.HARD_MAX_ROOMS
        )
          CONFIG.LIMITS.BASE_MAX_ROOMS = Math.floor(data.baseMaxRooms);
        let capacityChanged = false;
        if (
          typeof data?.maxRoomCapacity === "number" &&
          data.maxRoomCapacity >= 2 &&
          data.maxRoomCapacity <= 50
        ) {
          CONFIG.LIMITS.MAX_ROOM_CAPACITY = Math.floor(data.maxRoomCapacity);
          capacityChanged = true;
        }
        state.apiCache.delete("config");
        state.apiCache.delete("public_rooms");
        const flags = {
          wordFilter: CONFIG.FEATURES.ENABLE_WORD_FILTER,
          roomCreation: CONFIG.FEATURES.ENABLE_ROOM_CREATION,
          baseMaxRooms: CONFIG.LIMITS.BASE_MAX_ROOMS,
          maxRoomCapacity: CONFIG.LIMITS.MAX_ROOM_CAPACITY,
          maintenance: state.maintenance,
        };
        logStaff(socket, "set flags", JSON.stringify(flags), "-");
        updateLobby();
        if (capacityChanged) for (const [rid] of state.rooms) updateRoom(rid);
        socket.emit("dev flags", flags);
        socket.emit("staff action result", {
          action: "flags",
          ok: true,
          flags,
        });
      }),
    );

    // ── Maintenance mode (dev) ──────────────────────────────────────────
    socket.on(
      "dev set maintenance",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const enabled =
          typeof data?.enabled === "boolean"
            ? data.enabled
            : !state.maintenance;
        state.maintenance = enabled;
        io().emit("maintenance status", { enabled });
        logStaff(
          socket,
          enabled ? "maintenance on" : "maintenance off",
          null,
          "-",
        );
        socket.emit("staff action result", {
          action: "maintenance",
          ok: true,
          enabled,
        });
      }),
    );

    // ── Dev HUD: live server stats on request (dev) ─────────────────────
    socket.on(
      "dev request hud",
      safe(async () => {
        if (!requireDev(socket)) return;
        const mem = process.memoryUsage();
        const stats = getRoomStatistics();
        socket.emit("dev hud stats", {
          sockets: io().sockets.sockets.size,
          rooms: stats.totalRooms,
          users: stats.totalUsers,
          heapMB: Math.round(mem.heapUsed / 1024 / 1024),
          soloTTL: stats.currentSoloTTL,
          boards: boardState.size,
          tokens: state.botTokens.size,
          devs: state.devUsers.size,
        });
      }),
    );

    // ── Nuke: clear all rooms, confirmation required (dev) ──────────────
    socket.on(
      "staff nuke",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        if (data?.confirm !== true)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Nuke requires confirmation.",
            ),
          );
        const roomIds = Array.from(state.rooms.keys());
        for (const roomId of roomIds) {
          const room = state.rooms.get(roomId);
          if (!room) continue;
          const userIds = (room.users || []).map((u) => u.id);
          for (const uid of userIds) {
            const s = findSocketByUserId(uid, roomId);
            if (s) {
              s.emit("kicked", {
                message: "All rooms were cleared by staff.",
              });
              await leaveRoom(s, uid);
            }
          }
          state.rooms.delete(roomId);
          state.roomSoloSince.delete(roomId);
          state.roomLastChatActivity.delete(roomId);
          cleanupBoardState(roomId);
          if (state.roomDeletionTimers.has(roomId)) {
            clearTimeout(state.roomDeletionTimers.get(roomId));
            state.roomDeletionTimers.delete(roomId);
          }
        }
        for (const [, s] of io().sockets.sockets) {
          if (s.spectating) {
            s.emit("spectate ended", { reason: "nuke" });
            s.leave(s.spectating);
            s.spectating = null;
            s.roomId = null;
            s.join("lobby");
          }
        }
        state.apiCache.delete("public_rooms");
        updateLobby();
        await debouncedSaveRooms();
        logStaff(socket, "NUKE all rooms", `${roomIds.length} rooms`, "-");
        socket.emit("staff action result", {
          action: "nuke",
          ok: true,
          rooms: roomIds.length,
        });
      }),
    );

    // ── Clear bot blacklist / unblock an IP (dev) ───────────────────────
    socket.on(
      "dev clear blacklist",
      safe(async () => {
        if (!requireDev(socket)) return;
        const n = state.botBlacklist.size;
        state.botBlacklist.clear();
        logStaff(socket, "clear blacklist", `${n} entries`, "-");
        socket.emit("staff action result", {
          action: "clear blacklist",
          ok: true,
          cleared: n,
        });
      }),
    );

    socket.on(
      "dev list blocks",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("dev blocks", buildBlockList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff get ban history",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff ban history", buildBanHistory(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "dev get sessions",
      safe(async () => {
        if (!requireStaff(socket)) return;
        const byKey = new Map();
        for (const [, s] of io().sockets.sockets) {
          if (!s.isDev && !s.isMod) continue;
          const hash = s.isDev ? s.devKeyHash : s.modKeyHash;
          if (!hash) continue;
          if (!byKey.has(hash))
            byKey.set(hash, {
              hash,
              label: s.staffLabel || (s.isDev ? "dev" : "mod"),
              role: s.isDev ? "dev" : "mod",
              ips: new Set(),
              count: 0,
            });
          const g = byKey.get(hash);
          g.ips.add(s.clientIp || s.handshake.address || "?");
          g.count += 1;
        }
        const showIp = !!socket.isMainDev;
        const mine = (g) =>
          g.role !== "dev" ||
          (!!socket.isDev && (showIp || !roles.isMainDevHash(g.hash)));
        const sessions = [...byKey.values()]
          .filter(mine)
          .map((g) => ({
            hash: showIp ? g.hash : g.hash.slice(0, 8),
            label: g.label,
            role: g.role,
            ips: showIp ? [...g.ips] : [],
            ipCount: g.ips.size,
            sessionCount: g.count,
            multiIp: g.ips.size > 1,
          }));
        const history = roles
          .getKeyActivity()
          .filter(mine)
          .map((h) => ({
            hash: showIp ? h.hash : String(h.hash || "").slice(0, 8),
            label: h.label,
            role: h.role,
            ips: showIp
              ? h.ips
              : (h.ips || []).map((x) => ({
                  first: x.first,
                  last: x.last,
                  count: x.count,
                })),
            ipCount: (h.ips || []).length,
          }));
        socket.emit("dev sessions", { sessions, history });
      }),
    );

    socket.on(
      "dev unblock ip",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        let ip = typeof data?.ip === "string" ? data.ip.trim() : "";
        if (!ip && typeof data?.ref === "string") ip = ipForBanRef(data.ref);
        if (!ip)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "IP required."),
          );
        const prev = state.blockedIPs.get(ip);
        if (!socket.isDev && ipban.isPermanentBlock(prev))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "That block is permanent. Only a developer can lift it.",
            ),
          );
        const blockedName =
          (prev && typeof prev === "object" && prev.label) || null;
        const removed = state.blockedIPs.delete(ip);
        state.botBlacklist.delete(ip);
        blocklist.saveSoon();
        evasion.invalidate();
        if (removed)
          banhistory.record({
            ip,
            name: blockedName,
            action: "unban",
            by: socket.staffLabel || null,
            byRole: socket.isDev ? "dev" : "mod",
          });
        broadcastBlockList();
        broadcastBanHistory();
        const reviewer = `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`;
        const resolved = ipban.isIdKey(ip)
          ? appeals.resolveOpenForDevice(ip.slice(3), "lifted", reviewer)
          : appeals.resolveOpenForIp(ip, "lifted", reviewer);
        if (resolved) broadcastAppealsList();
        logStaff(socket, "unblock ip", blockedName || ip, "-");
        socket.emit("staff action result", {
          action: "unblock ip",
          ok: true,
          ref: data?.ref || null,
          removed,
        });
        socket.emit("dev blocks", buildBlockList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "dev set block duration",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        let ip = typeof data?.ip === "string" ? data.ip.trim() : "";
        if (!ip && typeof data?.ref === "string") ip = ipForBanRef(data.ref);
        if (!ip)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "IP required."),
          );
        const existing = state.blockedIPs.get(ip);
        if (!existing)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "No active block on that IP.",
            ),
          );
        const DURATIONS = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
        const duration = data?.duration;
        let expiry;
        if (duration === "permanent") {
          expiry = Number.MAX_SAFE_INTEGER;
        } else if (DURATIONS[duration] !== undefined) {
          expiry = Date.now() + DURATIONS[duration];
        } else {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Invalid duration. Use 1h, 24h, 7d, or permanent.",
            ),
          );
        }
        const rec =
          typeof existing === "object" && existing
            ? existing
            : { label: null, by: null, reason: null, ts: Date.now() };
        rec.expiry = expiry;
        state.blockedIPs.set(ip, rec);
        blocklist.saveSoon();
        evasion.invalidate();
        broadcastBlockList();
        logStaff(socket, `set block duration ${duration}`, ip, "-");
        socket.emit("staff action result", {
          action: "set block duration",
          ok: true,
          ref: data?.ref || null,
        });
        socket.emit("dev blocks", buildBlockList(roles.viewFor(socket)));
      }),
    );

    // ── Edit the message a blocked user sees on the ban screen (dev) ──────
    socket.on(
      "dev set block message",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        let ip = typeof data?.ip === "string" ? data.ip.trim() : "";
        if (!ip && typeof data?.ref === "string") ip = ipForBanRef(data.ref);
        if (!ip)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "IP required."),
          );
        const existing = state.blockedIPs.get(ip);
        if (!existing)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "No active block on that IP.",
            ),
          );
        const reason =
          sanitizeMessage(
            typeof data?.reason === "string" ? data.reason : "",
          ).slice(0, 500) || null;
        const rec =
          typeof existing === "object" && existing
            ? existing
            : { expiry: existing, label: null, by: null, ts: Date.now() };
        rec.reason = reason;
        state.blockedIPs.set(ip, rec);
        blocklist.saveSoon();
        evasion.invalidate();
        broadcastBlockList();
        logStaff(socket, "set block message", ip, "-", reason || "(cleared)");
        socket.emit("staff action result", {
          action: "set block message",
          ok: true,
          ref: data?.ref || null,
        });
        socket.emit("dev blocks", buildBlockList(roles.viewFor(socket)));
      }),
    );

    // ── Role management: grant / revoke / list mod keys (dev) ───────────
    socket.on(
      "dev grant mod",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const label = typeof data?.label === "string" ? data.label : "mod";
        const level = data?.level === 1 ? 1 : 2;
        const granted = await roles.grantModKey(
          label,
          level,
          socket.staffLabel || "dev",
        );
        logStaff(
          socket,
          `grant mod L${granted.level}`,
          `${granted.label}(${granted.hash.slice(0, 8)})`,
          "-",
        );
        socket.emit("dev mod granted", {
          key: granted.key,
          hash: granted.hash,
          label: granted.label,
          level: granted.level,
        });
        socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        socket.emit(
          "dev former mods",
          roles.listFormerMods(roles.viewFor(socket)),
        );
        staffchat.rosterDirty();
      }),
    );

    socket.on(
      "dev revoke mod",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const hash = typeof data?.hash === "string" ? data.hash : "";
        if (!hash)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "hash required."),
          );
        const reason = String(data?.reason || "")
          .trim()
          .slice(0, 300);
        if (!reason)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Say why this moderator is being removed.",
            ),
          );
        const ok = await roles.revokeModKey(hash, {
          reason,
          by: socket.staffLabel || "dev",
        });
        if (ok) {
          for (const [, s] of io().sockets.sockets) {
            if (s.isMod && s.modKeyHash === hash) {
              s.isMod = false;
              s.modKeyHash = null;
              s.modLevel = 0;
              s.staffLabel = null;
              const uid = s.handshake?.session?.userId;
              if (uid && s.roomId) {
                const room = state.rooms.get(s.roomId);
                const u = room?.users?.find((x) => x.id === uid);
                if (u) {
                  u.isMod = false;
                  updateRoom(s.roomId);
                  updateLobby();
                }
              }
              s.emit("staff revoked", {});
            }
          }
        }
        logStaff(socket, "revoke mod", hash.slice(0, 8), "-");
        socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        socket.emit(
          "dev former mods",
          roles.listFormerMods(roles.viewFor(socket)),
        );
        staffchat.rosterDirty();
        socket.emit("staff action result", {
          action: "revoke mod",
          ok,
          hash,
        });
      }),
    );

    socket.on(
      "dev list mod keys",
      safe(async () => {
        if (!requireStaff(socket)) return;
        const keys = roles.listModKeys(roles.viewFor(socket));
        socket.emit(
          "dev mod keys",
          socket.isDev
            ? keys
            : keys.map((k) => ({
                ...k,
                hash: String(k.hash || "").slice(0, 8),
              })),
        );
        const former = roles.listFormerMods(roles.viewFor(socket));
        socket.emit(
          "dev former mods",
          socket.isDev
            ? former
            : former.map((f) => ({
                ...f,
                hash: String(f.hash || "").slice(0, 8),
              })),
        );
      }),
    );

    // ── Promote / demote a mod's level by key hash (dev only) ───────────
    socket.on(
      "dev set mod level",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const hash = typeof data?.hash === "string" ? data.hash : "";
        const level = data?.level === 1 ? 1 : 2;
        if (!hash)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "hash required."),
          );
        const newLevel = await roles.setModLevel(hash, level);
        if (newLevel == null)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "No such mod key."),
          );
        for (const [, s] of io().sockets.sockets) {
          if (s.isMod && s.modKeyHash === hash) {
            s.modLevel = newLevel;
            const uid = s.handshake?.session?.userId;
            if (uid && s.roomId) {
              const room = state.rooms.get(s.roomId);
              const u = room?.users?.find((x) => x.id === uid);
              if (u) {
                u.modLevel = newLevel;
                updateRoom(s.roomId);
                updateLobby();
              }
            }
            s.emit("staff level changed", { level: newLevel });
          }
        }
        logStaff(socket, `set mod level L${newLevel}`, hash.slice(0, 8), "-");
        socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        staffchat.rosterDirty();
        socket.emit("staff action result", {
          action: "set mod level",
          ok: true,
          hash,
          level: newLevel,
        });
      }),
    );

    // ── Promote / demote a connected user by userId (dev only) ──────────
    socket.on(
      "dev set mod level for user",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const targetUserId = data?.targetUserId;
        const level = data?.level === 1 ? 1 : 2;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        const targets = findSocketsByUserId(targetUserId);
        const hashes = new Set();
        for (const s of targets)
          if (s.isMod && !s.isDev && s.modKeyHash) hashes.add(s.modKeyHash);
        if (hashes.size === 0)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "That user is not a moderator.",
            ),
          );
        let applied = 0;
        for (const hash of hashes) {
          const newLevel = await roles.setModLevel(hash, level);
          if (newLevel == null) continue;
          applied++;
          for (const [, s] of io().sockets.sockets) {
            if (s.isMod && s.modKeyHash === hash) {
              s.modLevel = newLevel;
              const uid = s.handshake?.session?.userId;
              if (uid && s.roomId) {
                const r = state.rooms.get(s.roomId);
                const u = r?.users?.find((x) => x.id === uid);
                if (u) {
                  u.modLevel = newLevel;
                  updateRoom(s.roomId);
                  updateLobby();
                }
              }
              s.emit("staff level changed", { level: newLevel });
            }
          }
        }
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        logStaff(
          socket,
          `set mod level L${level} for user`,
          targetUser || { id: targetUserId },
          room || "-",
        );
        socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        staffchat.rosterDirty();
        socket.emit("staff action result", {
          action: "set mod level",
          ok: applied > 0,
          targetUserId,
          level,
        });
      }),
    );

    // ── Accountability board feed (mod + dev) ───────────────────────────
    socket.on(
      "staff get audit",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        audit.setAuditSub(socket, true);
        const limit = Math.max(1, Math.min(Number(data?.limit) || 6000, 40000));
        const days = audit.pacificDayStarts(7);
        const weekStart = days[0];
        socket.emit("audit snapshot", {
          entries: audit.recent(limit, {
            showIp: !!socket.isMainDev,
            showAll: !!socket.isMainDev,
            isDev: !!socket.isDev,
            modLevel: socket.modLevel || 2,
            since: weekStart,
          }),
          dayStart: days[days.length - 1],
          days,
          me: {
            role: socket.isDev ? "dev" : "mod",
            label: socket.staffLabel || null,
            modLevel: socket.isDev ? 0 : socket.modLevel || 2,
            mainDev: !!socket.isMainDev,
          },
          roster: {
            devs: socket.isDev
              ? roles
                  .listDevKeys(!!socket.isMainDev)
                  .map((d) => d.label)
              : [],
            mods: socket.isDev
              ? roles.listModKeys().map((m) => m.label)
              : [],
          },
        });
      }),
    );

    socket.on(
      "staff get mod history",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!socket.isMainDev) return;
        const label = typeof data?.label === "string" ? data.label : "";
        const role = data?.role === "dev" ? "dev" : "mod";
        const h = audit.historyFor(label, role, {
          offset: data?.offset,
          limit: data?.limit,
          group: typeof data?.group === "string" ? data.group : null,
          targetUid:
            typeof data?.targetUid === "string" ? data.targetUid : null,
        });
        socket.emit("staff mod history", {
          ...h,
          canReview: !!socket.isDev,
          entries: socket.isMainDev
            ? h.entries
            : h.entries.map(audit.redactEntry),
        });
      }),
    );

    socket.on(
      "staff review flag",
      safe(async (data) => {
        if (!socket.isMainDev) return;
        const label = typeof data?.label === "string" ? data.label : "";
        const key = typeof data?.key === "string" ? data.key : "";
        const role = data?.role === "dev" ? "dev" : "mod";
        if (!label || !key) return;
        if (data?.clear) {
          audit.clearFlagReview({ role, label, key });
          logStaff(socket, "unreview flag", null, null, key + " on " + label);
        } else {
          audit.reviewFlag({
            role,
            label,
            key,
            by: socket.staffLabel || "dev",
            note: data?.note,
          });
          logStaff(
            socket,
            "review flag",
            null,
            null,
            key + " on " + label + (data?.note ? ": " + data.note : ""),
          );
        }
        const h = audit.historyFor(label, role, {
          offset: data?.offset,
          limit: data?.limit,
          group: typeof data?.group === "string" ? data.group : null,
          targetUid:
            typeof data?.targetUid === "string" ? data.targetUid : null,
        });
        socket.emit("staff mod history", { ...h, canReview: true });
      }),
    );

    socket.on(
      "staff stop audit",
      safe(async () => {
        audit.setAuditSub(socket, false);
      }),
    );

    socket.on(
      "staff delete activity",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const ids = Array.isArray(data?.ids)
          ? data.ids.slice(0, 500)
          : data?.id != null
            ? [data.id]
            : [];
        if (!ids.length) return;
        const gone = audit.remove(ids);
        socket.emit("staff action result", {
          action: "delete activity",
          ok: gone.length > 0,
          ids: gone,
        });
      }),
    );

    socket.on(
      "staff get reports",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff reports", buildReportsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff dismiss report",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId || typeof targetUserId !== "string") return;
        const before = reports
          .summary()
          .find((s) => s.targetKey === targetUserId);
        reports.clear(targetUserId);
        broadcastReportsList();
        logStaff(
          socket,
          "dismiss report",
          { name: before?.name || "?", id: targetUserId },
          "-",
        );
        socket.emit("staff reports", buildReportsList(roles.viewFor(socket)));
      }),
    );

    // ── Delete a report (dev): the row goes, and so does the Desk card ──────
    socket.on(
      "staff delete report",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId || typeof targetUserId !== "string") return;
        const had = reports.clear(targetUserId);
        try {
          staffchat.dropQueue(
            (m) =>
              m.qkind === "report" &&
              (m.card.targetUserId === targetUserId ||
                (m.card.ids || []).includes(targetUserId)),
          );
        } catch (_) {}
        broadcastReportsList();
        socket.emit("staff reports", buildReportsList(roles.viewFor(socket)));
        socket.emit("staff action result", {
          action: "delete report",
          ok: had,
          targetUserId,
        });
      }),
    );

    // ── Appeals board (full mods + devs): ban appeals submitted on-site ──────
    socket.on(
      "staff get appeals",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff appeals", buildAppealsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff appeal open",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id) || null;
        socket.deskAppealId = id;
        if (!id) return;
        const row = buildAppealsList(roles.viewFor(socket)).find(
          (x) => x.id === id,
        );
        if (row) socket.emit("staff appeal", row);
      }),
    );

    socket.on(
      "staff appeal reply",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const a = appeals.get(id);
        if (!a)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such appeal."),
          );
        if (a.status !== "open")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "That appeal is already decided.",
            ),
          );
        const text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, 1000);
        const av = socket.handshake?.session?.avatar;
        const r = appeals.staffReply(
          a,
          text,
          {
            label: socket.staffLabel || (socket.isDev ? "dev" : "mod"),
            role: socket.isDev ? "dev" : "mod",
            level: socket.isDev ? 0 : socket.modLevel || 2,
            avatar: av?.preset
              ? { preset: av.preset }
              : av && (av.id || av.discordId) && av.hash
                ? {
                    id: av.id || av.discordId,
                    hash: av.hash,
                    animated: !!av.animated,
                  }
                : null,
          },
          Number(data?.replyTo) || null,
        );
        if (!r.ok)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Write something first.",
            ),
          );
        logStaff(
          socket,
          "reply to appeal",
          { name: a.name || "?", id: a.userId || a.deviceId || "-" },
          "-",
          text.slice(0, 120),
        );
        broadcastAppealsList();
        broadcastAppeal(id);
      }),
    );

    socket.on(
      "staff appeal reopen",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const note = sanitizeMessage(
          typeof data?.note === "string" ? data.note : "",
        ).slice(0, 300);
        const label = socket.staffLabel || (socket.isDev ? "dev" : "mod");
        const r = appeals.reopen(id, label, note || null);
        if (!r.ok)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              r.code === "already_lifted"
                ? "That ban was lifted, so there is nothing left to appeal."
                : r.code === "not_closed"
                  ? "That appeal is already open."
                  : "No such appeal.",
            ),
          );
        const a = r.appeal;
        logStaff(
          socket,
          "reopen appeal",
          { name: a.name || "?", id: a.userId || a.deviceId || "-" },
          "-",
          note || undefined,
        );
        requeueAppeal(
          id,
          `${a.name || "A banned user"}'s appeal was reopened.`,
        );
        broadcastAppealsList();
        broadcastAppeal(id);
      }),
    );

    socket.on(
      "staff appeal lock",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const a = appeals.get(id);
        if (!a)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such appeal."),
          );
        const locked = data?.locked !== false;
        appeals.setLocked(
          id,
          locked,
          socket.staffLabel || (socket.isDev ? "dev" : "mod"),
        );
        logStaff(
          socket,
          locked ? "end appeal chat" : "reopen appeal chat",
          { name: a.name || "?", id: a.userId || a.deviceId || "-" },
          "-",
        );
        broadcastAppealsList();
        broadcastAppeal(id);
      }),
    );

    socket.on(
      "staff resolve appeal",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const decision = data?.decision === "lift" ? "lift" : "dismiss";
        const a = appeals.get(id);
        if (!a)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such appeal."),
          );
        const reviewer = `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`;
        if (decision === "lift") {
          if (!requireDev(socket)) return;
          const removedKeys = ipban.removeBlocksForIp(a.ip);
          if (a.deviceId)
            removedKeys.push(...ipban.removeBlocksForDevice(a.deviceId));
          const removed = removedKeys.length > 0;
          state.botBlacklist.delete(a.ip);
          blocklist.saveSoon();
          evasion.invalidate();
          if (removed)
            banhistory.record({
              ip: a.ip,
              name: a.name || null,
              action: "unban",
              by: socket.staffLabel || null,
              byRole: socket.isDev ? "dev" : "mod",
              reason: "appeal accepted",
            });
          broadcastBlockList();
          broadcastBanHistory();
          appeals.resolveOpenForIp(a.ip, "lifted", reviewer);
          logStaff(socket, "lift ban (appeal)", a.name || a.ip, "-");
        } else {
          const note = sanitizeMessage(
            typeof data?.note === "string" ? data.note : "",
          ).slice(0, 300);
          appeals.resolve(id, "dismissed", reviewer, note || null);
          const barred = data?.barFuture
            ? appeals.addBar({
                ip: a.ip,
                deviceId: a.deviceId,
                userId: a.userId,
                name: a.name,
                by: socket.staffLabel || null,
                byRole: socket.isDev ? "dev" : "mod",
                reason: note || null,
              })
            : null;
          if (barred) appeals.systemNote(a, NO_MORE_APPEALS);
          logStaff(
            socket,
            barred ? "dismiss appeal (no more appeals)" : "dismiss appeal",
            { name: a.name || "?", id: a.userId || a.deviceId || "-" },
            "-",
            note || undefined,
          );
        }
        broadcastAppealsList();
        broadcastAppeal(id);
        settleQueueItem("appeal", id);
        socket.emit("staff appeals", buildAppealsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff appeal unbar",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const barId = Number(data?.barId);
        if (!barId || !appeals.removeBar(barId)) return;
        logStaff(
          socket,
          "allow appeals again",
          typeof data?.name === "string" ? data.name : "-",
          "-",
        );
        broadcastAppealsList();
        socket.emit("staff appeals", buildAppealsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff appeal delete",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const id = Number(data?.id);
        const r = appeals.remove(id);
        if (!r.ok)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such appeal."),
          );
        settleQueueItem("appeal", id);
        broadcastAppealsList();
        socket.emit("staff appeals", buildAppealsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "suggestion submit",
      safe(async (data) => {
        const now = Date.now();
        if (now - (socket._lastSuggestion || 0) < 30000)
          return socket.emit("suggestion result", {
            ok: false,
            error: "Please wait a bit before sending another suggestion.",
          });
        const text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, 500);
        if (text.trim().length < 3)
          return socket.emit("suggestion result", {
            ok: false,
            error: "Please write a little more.",
          });
        socket._lastSuggestion = now;
        const name = socket.handshake.session?.username || null;
        const sres = suggestions.submit({
          deviceId: socket.deviceId || null,
          userId: socket.handshake.session?.userId || null,
          name,
          text,
        });
        audit.recordNotification({
          kind: "suggestion",
          text: `${name || "A user"} suggested: ${text}`,
          by: name,
          minLevel: 2,
          card: {
            ids: [socket.handshake.session?.userId].filter(Boolean),
            by: name || "A user",
            itemId: sres && sres.id ? sres.id : null,
            reason: text,
          },
        });
        broadcastSuggestionsList();
        socket.emit("suggestion result", { ok: true });
      }),
    );

    socket.on(
      "staff get suggestions",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff suggestions", buildSuggestionsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "staff resolve suggestion",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const decision = data?.decision === "approve" ? "approved" : "declined";
        const s = suggestions.get(id);
        if (!s)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such suggestion."),
          );
        const reviewer = `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`;
        suggestions.resolve(id, decision, reviewer);
        logStaff(
          socket,
          decision === "approved" ? "approve suggestion" : "decline suggestion",
          { name: s.name || "?", id: s.userId || s.deviceId || "-" },
          "-",
        );
        broadcastSuggestionsList();
        settleQueueItem("suggestion", id);
        socket.emit("staff suggestions", buildSuggestionsList(roles.viewFor(socket)));
      }),
    );

    socket.on(
      "board open",
      safe(async () => {
        socket.suggestBoardOpen = true;
        socket.emit("board data", boardPayloadFor(socket));
      }),
    );

    socket.on(
      "board close",
      safe(async () => {
        socket.suggestBoardOpen = false;
      }),
    );

    socket.on(
      "board badges",
      safe(async (data) => {
        var since = Number(data && data.since) || 0;
        socket.boardSince = since;
        socket.emit(
          "board badges",
          suggestions.unreadFor(socket.deviceId || null, since),
        );
      }),
    );

    // ── Announcements ───────────────────────────────────────────────────────
    socket.on(
      "announcement current",
      safe(async () => {
        socket.announceSub = true;
        socket.emit(
          "announcement current",
          announcements.publicOne(
            announcements.current(),
            socket.deviceId || null,
          ),
        );
      }),
    );

    socket.on(
      "announcement react",
      safe(async (data) => {
        if (!socket.deviceId) return;
        const now = Date.now();
        if (now - (socket._lastAnnounceReact || 0) < 400) return;
        socket._lastAnnounceReact = now;
        const updated = announcements.react({
          id: Number(data?.id),
          deviceId: socket.deviceId,
          emoji: typeof data?.emoji === "string" ? data.emoji : "",
        });
        if (!updated)
          return socket.emit("announcement result", {
            ok: false,
            error: "That reaction could not be added.",
          });
        broadcastAnnouncement();
      }),
    );

    // ── Announcements: the dev side ─────────────────────────────────────────
    socket.on(
      "announcement list",
      safe(async () => {
        if (!requireDev(socket)) return;
        socket.emit("announcement list", {
          items: announcements.listFor(socket.deviceId || null),
        });
      }),
    );

    socket.on(
      "announcement post",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const fail = (error) =>
          socket.emit("announcement result", { ok: false, error });
        const title = sanitizeMessage(
          typeof data?.title === "string" ? data.title : "",
        );
        const body = typeof data?.body === "string" ? data.body : "";
        const by =
          sanitizeMessage(typeof data?.by === "string" ? data.by : "")
            .trim()
            .slice(0, 40) ||
          socket.staffLabel ||
          "Talkomatic";
        const r = announcements.post({
          kind: data?.kind,
          title,
          body,
          by,
          byRole: "dev",
        });
        if (!r.ok)
          return fail(
            r.code === "title"
              ? "Give it a title first."
              : "Write something in the body.",
          );
        logStaff(socket, "post announcement", title.slice(0, 60), "-");
        socket.emit("announcement result", { ok: true, action: "post" });
        socket.emit("announcement list", {
          items: announcements.listFor(socket.deviceId || null),
        });
        broadcastAnnouncement();
      }),
    );

    socket.on(
      "announcement edit",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const r = announcements.edit({
          id: Number(data?.id),
          kind: data?.kind,
          title: sanitizeMessage(
            typeof data?.title === "string" ? data.title : "",
          ),
          body: typeof data?.body === "string" ? data.body : "",
          by: sanitizeMessage(typeof data?.by === "string" ? data.by : "")
            .trim()
            .slice(0, 40),
        });
        if (!r.ok)
          return socket.emit("announcement result", {
            ok: false,
            error: "Could not save that.",
          });
        logStaff(socket, "edit announcement", String(data?.id || "?"), "-");
        socket.emit("announcement result", { ok: true, action: "edit" });
        socket.emit("announcement list", {
          items: announcements.listFor(socket.deviceId || null),
        });
        broadcastAnnouncement();
      }),
    );

    socket.on(
      "announcement live",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const live = !!data?.live;
        if (!announcements.setLive(Number(data?.id), live)) return;
        logStaff(
          socket,
          live ? "show announcement" : "hide announcement",
          String(data?.id || "?"),
          "-",
        );
        socket.emit("announcement list", {
          items: announcements.listFor(socket.deviceId || null),
        });
        broadcastAnnouncement();
      }),
    );

    socket.on(
      "announcement delete",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        if (!announcements.remove(Number(data?.id))) return;
        logStaff(socket, "delete announcement", String(data?.id || "?"), "-");
        socket.emit("announcement list", {
          items: announcements.listFor(socket.deviceId || null),
        });
        broadcastAnnouncement();
      }),
    );

    socket.on(
      "board post",
      safe(async (data) => {
        const now = Date.now();
        const fail = (error) =>
          socket.emit("board result", { ok: false, action: "post", error });
        if (now - (socket._lastBoardPost || 0) < 15000)
          return fail("Please wait a bit before posting again.");
        const name = socket.handshake.session?.username || null;
        if (!name) return fail("Sign in first to post.");
        if (!socket.deviceId) return fail("Could not identify this browser.");
        let text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, 600);
        text = wordFilter.filterText(text);
        text = linkfilter.redact(text);
        if (text.trim().length < 8) return fail("Please write a little more.");
        let title = wordFilter
          .filterText(
            sanitizeMessage(
              typeof data?.title === "string" ? data.title : "",
            ).slice(0, 80),
          )
          .trim();
        if (title.length < 3) return fail("Please add a short title.");
        const kind = data?.kind === "bug" ? "bug" : "idea";
        const r = suggestions.post({
          deviceId: socket.deviceId,
          ip: socket.clientIp || null,
          userId: socket.handshake.session?.userId || null,
          name,
          role: boardRole(socket),
          avatar: socket.handshake.session?.avatar || null,
          kind,
          title,
          text,
        });
        if (!r.ok)
          return fail(
            r.code === "limit"
              ? "You can post 3 times per day. Try again tomorrow."
              : "Could not post that.",
          );
        socket._lastBoardPost = now;
        const article = kind === "idea" ? "an idea" : "a bug";
        audit.recordNotification({
          kind: "suggestion",
          text: `${name} posted ${article} on the board: ${title}`,
          by: name,
          minLevel: 2,
          card: {
            itemId: r.id,
            ids: [socket.handshake.session?.userId].filter(Boolean),
            by: name,
            byRole: boardRole(socket) === "user" ? null : boardRole(socket),
            category: kind === "idea" ? "Idea" : "Bug",
            target: title,
            reason: text,
          },
        });
        socket.emit("board result", {
          ok: true,
          action: "post",
          remaining: r.remaining,
        });
        broadcastBoard();
      }),
    );

    socket.on(
      "board reply",
      safe(async (data) => {
        const now = Date.now();
        const fail = (error) =>
          socket.emit("board result", { ok: false, action: "reply", error });
        if (now - (socket._lastBoardReply || 0) < 5000)
          return fail("Please wait a moment between replies.");
        const name = socket.handshake.session?.username || null;
        if (!name) return fail("Sign in first to reply.");
        if (!socket.deviceId) return fail("Could not identify this browser.");
        let text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, 300);
        text = wordFilter.filterText(text);
        text = linkfilter.redact(text);
        if (text.trim().length < 2) return fail("Please write a little more.");
        const r = suggestions.reply({
          id: Number(data?.id),
          deviceId: socket.deviceId,
          ip: socket.clientIp || null,
          userId: socket.handshake.session?.userId || null,
          name,
          role: boardRole(socket),
          avatar: socket.handshake.session?.avatar || null,
          text,
        });
        if (!r.ok)
          return fail(
            r.code === "limit"
              ? "You have hit the daily reply limit."
              : r.code === "full"
                ? "This thread is full."
                : "Could not post your reply.",
          );
        socket._lastBoardReply = now;
        socket.emit("board result", { ok: true, action: "reply" });
        broadcastBoard();
      }),
    );

    socket.on(
      "board vote",
      safe(async (data) => {
        const id = Number(data?.id);
        const dir = [1, -1, 0].includes(data?.dir) ? data.dir : null;
        if (!id || dir === null) return;
        const fail = (error) =>
          socket.emit("board result", { ok: false, action: "vote", error });
        if (!socket.deviceId) return fail("Could not register your vote.");
        const now = Date.now();
        if (now - (socket._lastBoardVote || 0) < 700) return;
        socket._lastBoardVote = now;
        const r = suggestions.vote({
          id,
          deviceId: socket.deviceId,
          ip: socket.clientIp || null,
          dir,
        });
        if (!r.ok)
          return fail(
            r.code === "ip_cap"
              ? "Vote limit reached for your network on this post."
              : "Could not register your vote.",
          );
        socket.emit("board result", {
          ok: true,
          action: "vote",
          id,
          up: r.up,
          down: r.down,
          myVote: r.myVote,
        });
        broadcastBoard();
      }),
    );

    socket.on(
      "board status",
      safe(async (data) => {
        if (!socket.isDev && !socket.isMod) return;
        const s = suggestions.setStatus(
          Number(data?.id),
          String(data?.status || ""),
          socket.staffLabel || (socket.isDev ? "dev" : "mod"),
          socket.isDev ? "dev" : "mod",
        );
        if (!s)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "No such suggestion."),
          );
        logStaff(
          socket,
          `suggestion ${s.status}`,
          { name: s.name || "?", id: s.userId || "-" },
          "-",
        );
        settleQueueItem("suggestion", s.id);
        broadcastBoard();
      }),
    );

    socket.on(
      "board delete",
      safe(async (data) => {
        const id = Number(data?.id);
        const replyId = data?.replyId ? Number(data.replyId) : null;
        const s = suggestions.get(id);
        if (!s) return;
        const byStaff = !!socket.isDev || !!socket.isMod;
        if (!suggestions.remove(id, replyId, socket.deviceId || null, byStaff))
          return socket.emit("board result", {
            ok: false,
            action: "delete",
            error: "You can only delete your own posts.",
          });
        if (byStaff && s.deviceId !== socket.deviceId)
          logStaff(
            socket,
            replyId ? "delete board reply" : "delete board post",
            { name: s.name || "?", id: s.userId || "-" },
            "-",
          );
        socket.emit("board result", { ok: true, action: "delete" });
        broadcastBoard();
      }),
    );

    socket.on(
      "board edit",
      safe(async (data) => {
        const fail = (error) =>
          socket.emit("board result", { ok: false, action: "edit", error });
        if (!socket.deviceId) return fail("Could not identify this browser.");
        const replyId = data?.replyId ? Number(data.replyId) : null;
        let text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, replyId ? 300 : 600);
        text = wordFilter.filterText(text);
        text = linkfilter.redact(text);
        if (text.trim().length < (replyId ? 2 : 8))
          return fail("Please write a little more.");
        const r = suggestions.editPost({
          id: Number(data?.id),
          replyId,
          deviceId: socket.deviceId,
          text,
        });
        if (!r.ok)
          return fail(
            r.code === "denied"
              ? "You can only edit your own posts."
              : "Could not save your edit.",
          );
        socket.emit("board result", { ok: true, action: "edit" });
        broadcastBoard();
      }),
    );

    socket.on(
      "mod application status",
      safe(async () => {
        if (!socket.deviceId)
          return socket.emit("mod application status", { has: false });
        socket.emit(
          "mod application status",
          appStatusPayload(socket.deviceId, socket.isDev || socket.isMod),
        );
      }),
    );

    socket.on(
      "audit comment",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const refId = Number(data?.entryId);
        if (!refId) return;
        const text = sanitizeMessage(
          typeof data?.text === "string" ? data.text : "",
        ).slice(0, 500);
        if (!text) return;
        audit.recordComment({
          entryId: refId,
          role: socket.isDev ? "dev" : "mod",
          label: socket.staffLabel || (socket.isDev ? "dev" : "mod"),
          text,
          ip: socket.clientIp || null,
        });
      }),
    );

    // ── User report → staff notification (anyone; rate-limited) ─────────
    socket.on(
      "user report",
      safe(async (data) => {
        const now = Date.now();
        if (now - (socket._lastReport || 0) < 30000)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.RATE_LIMITED,
              "Please wait a bit before sending another report.",
            ),
          );
        const targetUserId =
          typeof data?.targetUserId === "string" ? data.targetUserId : null;
        const category =
          typeof data?.category === "string" && REPORT_CATEGORIES[data.category]
            ? data.category
            : "other";
        const reason = sanitizeMessage(
          typeof data?.reason === "string" ? data.reason : "",
        ).slice(0, 300);
        const roomId = socket.roomId;
        const room = roomId ? state.rooms.get(roomId) : null;
        let targetName = null;
        let targetSocket = null;
        if (targetUserId) {
          const tu = room?.users.find((u) => u.id === targetUserId);
          targetName = tu?.username || null;
          targetSocket = findSocketsByUserId(targetUserId)[0] || null;
        }
        if (!targetUserId || !targetName)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Pick someone in the room to report.",
            ),
          );
        socket._lastReport = now;
        const targetText = sanitizeMessage(
          state.userMessageBuffers.get(targetUserId) || "",
        ).slice(0, 300);
        const reporter = socket.handshake.session?.username || "A user";
        const catLabel = REPORT_CATEGORIES[category];
        const roleOf = (s) =>
          s?.isDev
            ? "dev"
            : s?.isMod
              ? (s.modLevel || 2) >= 2
                ? "mod"
                : "jr"
              : null;
        const targetRole = roleOf(targetSocket);
        const byRole = roleOf(socket);
        const tally = reports.add({
          targetKey: targetUserId,
          targetName,
          byDeviceId: socket.deviceId,
          byName: reporter,
          category,
          reason,
          targetIp: targetSocket?.clientIp || null,
          targetDeviceId: targetSocket?.deviceId || null,
          targetRole,
          targetText,
        });
        const targetIsStaff = !!targetRole;
        const text =
          `${reporter} reported ${targetName}${targetIsStaff ? " (staff)" : ""} for ${catLabel}` +
          (reason ? `: ${reason}` : "") +
          `. ${tally.distinct} ${tally.distinct === 1 ? "person has" : "people have"} reported ${targetName} recently.` +
          (targetText ? ` Their chat box read: "${targetText}"` : "");
        audit.recordNotification({
          kind: "report",
          text,
          target: `user:${targetName}(${targetUserId})`,
          room: room ? `room:${room.name || "?"}(${room.id || "?"})` : null,
          by: reporter,
          ip: socket.clientIp || null,
          targetIp: targetSocket?.clientIp || null,
          targetUserId,
          byUserId: socket.handshake.session?.userId || null,
          byRole,
          targetRole,
          reports: tally.distinct || null,
          minLevel: 2,
          card: {
            ids: [targetUserId, targetSocket?.deviceId].filter(Boolean),
            by: reporter,
            byRole,
            target: targetName,
            targetRole,
            targetUserId,
            deviceId: targetSocket?.deviceId || null,
            category: catLabel,
            reason: reason || null,
            quote: targetText || null,
            reports: tally.distinct || null,
            roomId: room ? room.id : null,
            roomName: room ? room.name : null,
          },
        });
        socket.emit("report received", {});
        broadcastReportsList();
      }),
    );

    socket.on(
      "mod application submit",
      safe(async (data) => {
        if (!socket.deviceId)
          return socket.emit("mod application result", {
            ok: false,
            error:
              "This browser can't be identified. Enable storage and retry.",
          });
        if (socket.isDev || socket.isMod)
          return socket.emit("mod application result", {
            ok: false,
            error: "You're already staff.",
          });
        if (!applications.isOpen())
          return socket.emit("mod application result", {
            ok: false,
            error:
              "Moderator applications are closed right now. Please check back later.",
          });
        if (!identity.isActive(socket.deviceId))
          return socket.emit("mod application result", {
            ok: false,
            error:
              "You need to be a more active member before applying. Spend more time chatting and come back.",
          });
        const why = sanitizeMessage(
          typeof data?.why === "string" ? data.why : "",
        ).slice(0, 500);
        const experience = sanitizeMessage(
          typeof data?.experience === "string" ? data.experience : "",
        ).slice(0, 300);
        const availability = sanitizeMessage(
          typeof data?.availability === "string" ? data.availability : "",
        ).slice(0, 120);
        if (!why || why.trim().length < 20)
          return socket.emit("mod application result", {
            ok: false,
            error:
              "Please write a little more about why you want to moderate.",
          });
        if (data?.age14 !== true)
          return socket.emit("mod application result", {
            ok: false,
            error: "You must confirm you are 14 or older to apply.",
          });
        if (data?.agree !== true)
          return socket.emit("mod application result", {
            ok: false,
            error: "Please read the moderator terms and agree to them.",
          });
        const hasDiscord = data?.hasDiscord === true;
        let discord = null;
        if (hasDiscord) {
          discord = sanitizeMessage(
            typeof data?.discord === "string" ? data.discord : "",
          )
            .replace(/^@+/, "")
            .replace(/[^A-Za-z0-9._-]/g, "")
            .slice(0, 40);
          if (!discord || discord.length < 2)
            return socket.emit("mod application result", {
              ok: false,
              error:
                "Please enter your Discord username, or pick the No Discord option.",
            });
        }
        const res = applications.submit({
          deviceId: socket.deviceId,
          ip: socket.clientIp,
          username: socket.handshake.session?.username,
          discord,
          answers: {
            why,
            experience,
            availability,
            hasDiscord,
            age14: true,
            agreed: true,
          },
          discordId:
            socket.handshake.session?.avatar?.id ||
            socket.handshake.session?.avatar?.discordId ||
            null,
        });
        if (!res.ok) return socket.emit("mod application result", res);
        const cardLines = [];
        if (experience) cardLines.push("Experience: " + experience);
        if (availability) cardLines.push("Around: " + availability);
        if (!hasDiscord) cardLines.push("Says they have no Discord");
        audit.recordNotification({
          kind: "application",
          text: `New mod application from ${socket.handshake.session?.username || "a user"}`,
          by: socket.handshake.session?.username || null,
          minLevel: 2,
          card: {
            ids: [socket.deviceId].filter(Boolean),
            by: socket.handshake.session?.username || "a user",
            itemId: res.id,
            deviceId: socket.deviceId || null,
            discord,
            reason: why,
            lines: cardLines.length ? cardLines : null,
          },
        });
        broadcastAppsList();
        socket.emit("mod application result", { ok: true });
      }),
    );

    socket.on(
      "mod applications list",
      safe(async () => {
        if (!requireStaff(socket)) return;
        sendAppsList(socket);
      }),
    );

    socket.on(
      "dev set applications open",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        await applications.setOpen(!!(data && data.open));
        logStaff(
          socket,
          applications.isOpen() ? "open applications" : "close applications",
          "-",
          "-",
        );
        broadcastApplicationsState();
        socket.emit("staff action result", {
          action: "applications open",
          ok: true,
          open: applications.isOpen(),
        });
      }),
    );
    socket.on(
      "mod application review",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id);
        const decision = data?.decision;
        const reason =
          sanitizeMessage(
            typeof data?.reason === "string" ? data.reason : "",
          ).slice(0, 300) || null;
        const app = applications.get(id);
        if (!app || app.status !== "pending")
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "No such pending application.",
            ),
          );
        const reviewer = `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`;
        if (decision === "approve") {
          applications.setStatus(id, "approved", reviewer, reason);
          const targets = [];
          for (const [, s] of io().sockets.sockets)
            if (s.deviceId === app.deviceId && !s.isDev && !s.isMod)
              targets.push(s);
          const live = Object.assign(
            { live: true },
            appStatusPayload(app.deviceId, false),
          );
          for (const s of targets) s.emit("mod application status", live);
          if (targets.length) {
            const granted = await roles.grantModKey(
              app.username || "mod",
              1,
              socket.staffLabel || "dev",
            );
            for (const s of targets)
              s.emit("you are now mod", {
                key: granted.key,
                label: granted.label,
                level: granted.level,
              });
            applications.markClaimed(id);
            logStaff(
              socket,
              "approve mod application (delivered)",
              { id: app.deviceId, username: app.username },
              "-",
              `label:${granted.label}`,
            );
          } else {
            logStaff(
              socket,
              "approve mod application (pending claim)",
              { id: app.deviceId, username: app.username },
              "-",
            );
          }
        } else if (decision === "reject") {
          applications.setStatus(id, "rejected", reviewer, reason);
          const live = Object.assign(
            { live: true },
            appStatusPayload(app.deviceId, false),
          );
          for (const [, s] of io().sockets.sockets)
            if (s.deviceId === app.deviceId && !s.isDev && !s.isMod)
              s.emit("mod application status", live);
          logStaff(
            socket,
            "reject mod application",
            { id: app.deviceId, username: app.username },
            "-",
            reason || undefined,
          );
        } else {
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Unknown decision."),
          );
        }
        broadcastAppsList();
        settleQueueItem("application", id);
        socket.emit("staff action result", {
          action: "review application",
          ok: true,
          id,
        });
      }),
    );

    // ── Warn a reported user, online or offline (any staff) ─────────────
    socket.on(
      "staff warn user",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId =
          typeof data?.targetUserId === "string" ? data.targetUserId : "";
        if (!targetUserId) return;
        const lk = reports.lastKnown(targetUserId);
        const role = getUserStaffRole(targetUserId) || (lk && lk.role) || null;
        if (!socket.isDev && role)
          return socket.emit("staff action result", {
            ok: false,
            action: "warn (cannot act on staff)",
          });
        let message = sanitizeMessage(
          typeof data?.message === "string" ? data.message : "",
        ).slice(0, 1000);
        if (!message)
          message =
            "A moderator has issued you a warning. Please follow the Talkomatic rules.";
        const online = findSocketsByUserId(targetUserId);
        let delivered = false;
        for (const s of online) {
          s.emit("staff warning", { message });
          delivered = true;
        }
        const deviceId =
          (online[0] && online[0].deviceId) || (lk && lk.deviceId) || null;
        if (!delivered && deviceId)
          warnings.queue(deviceId, message, socket.staffLabel || null);
        const targetName =
          (lk && lk.name) || online[0]?.handshake?.session?.username || "user";
        logStaff(
          socket,
          "warn",
          { name: targetName, id: targetUserId },
          "-",
          (delivered ? "delivered: " : "queued for next visit: ") + message,
        );
        socket.emit("staff action result", {
          ok: true,
          action: delivered
            ? "warned " + targetName
            : "warning queued for " + targetName,
        });
        clearReportAfterAction(socket, targetUserId);
      }),
    );

    // ── Staff key-entry login (no console needed) ───────────────────────
    socket.on(
      "staff validate key",
      safe(async (data) => {
        const ip = socket.clientIp || "unknown";
        const now = Date.now();
        let rec = staffKeyAttempts.get(ip);
        if (!rec || now > rec.resetAt) {
          rec = { count: 0, resetAt: now + STAFF_KEY_WINDOW };
          staffKeyAttempts.set(ip, rec);
        }
        rec.count++;
        if (rec.count > STAFF_KEY_MAX_ATTEMPTS)
          return socket.emit("staff key result", {
            role: null,
            throttled: true,
          });
        const key = typeof data?.key === "string" ? data.key.trim() : "";
        if (!key) return socket.emit("staff key result", { role: null });
        const v = roles.validateKey(key);
        if (v.role) {
          rec.count = 0;
          audit.recordAction({
            roleTag: v.role,
            label: v.label,
            action: "staff key entered (login)",
            ip,
          });
        }
        socket.emit("staff key result", { role: v.role, label: v.label });
      }),
    );

    // ── Promote a connected user to mod, in-site (dev) ──────────────────
    socket.on(
      "dev grant mod to user",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const grantLevel = data?.level === 1 ? 1 : 2;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        if (getUserStaffRole(targetUserId))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "That user is already staff.",
            ),
          );
        const targets = findSocketsByUserId(targetUserId);
        if (targets.length === 0)
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.NOT_FOUND, "User not connected."),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        if (room?.votes) {
          let changed = false;
          for (const vid in room.votes)
            if (room.votes[vid] === targetUserId) {
              delete room.votes[vid];
              changed = true;
            }
          if (changed) emitRoomVoteUpdates(roomId);
        }
        let label =
          (data?.label && String(data.label).trim()) ||
          targetUser?.username ||
          "mod";
        label = label.slice(0, 40);
        const granted = await roles.grantModKey(
          label,
          grantLevel,
          socket.staffLabel || "dev",
        );
        for (const s of targets)
          s.emit("you are now mod", {
            key: granted.key,
            label: granted.label,
            level: granted.level,
          });
        logStaff(
          socket,
          `grant mod L${granted.level} to user`,
          targetUser || { id: targetUserId },
          room || "-",
          `label:${granted.label}`,
        );
        socket.emit("staff action result", {
          action: "make mod",
          ok: true,
          targetUserId,
          level: granted.level,
        });
        if (socket.isDev)
          socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        staffchat.rosterDirty();
      }),
    );

    // ── Demote: revoke a connected user's mod key by userId (dev) ────────
    socket.on(
      "dev revoke mod from user",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "targetUserId required.",
            ),
          );
        const targets = findSocketsByUserId(targetUserId);
        const hashes = new Set();
        for (const s of targets)
          if (s.isMod && !s.isDev && s.modKeyHash) hashes.add(s.modKeyHash);
        if (hashes.size === 0)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.NOT_FOUND,
              "That user is not a moderator.",
            ),
          );
        const reason = String(data?.reason || "")
          .trim()
          .slice(0, 300);
        if (!reason)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Say why this moderator is being removed.",
            ),
          );
        const roomId = getUserCurrentRoom(targetUserId);
        const room = roomId ? state.rooms.get(roomId) : null;
        const targetUser = room?.users.find((u) => u.id === targetUserId);
        for (const hash of hashes) {
          await roles.revokeModKey(hash, {
            reason,
            by: socket.staffLabel || "dev",
          });
          for (const [, s] of io().sockets.sockets) {
            if (s.isMod && s.modKeyHash === hash) {
              s.isMod = false;
              s.modKeyHash = null;
              s.modLevel = 0;
              s.staffLabel = null;
              const uid = s.handshake?.session?.userId;
              if (uid && s.roomId) {
                const r = state.rooms.get(s.roomId);
                const u = r?.users?.find((x) => x.id === uid);
                if (u) {
                  u.isMod = false;
                  updateRoom(s.roomId);
                  updateLobby();
                }
              }
              s.emit("staff revoked", {});
            }
          }
        }
        logStaff(
          socket,
          "revoke mod from user",
          targetUser || { id: targetUserId },
          room || "-",
        );
        socket.emit("dev mod keys", roles.listModKeys(roles.viewFor(socket)));
        socket.emit(
          "dev former mods",
          roles.listFormerMods(roles.viewFor(socket)),
        );
        staffchat.rosterDirty();
        socket.emit("staff action result", {
          action: "remove mod",
          ok: true,
          targetUserId,
        });
      }),
    );

    // ── AFK Response ────────────────────────────────────────────────────
    socket.on(
      "afk response",
      safe(async () => {
        const userId = socket.handshake.session?.userId;
        if (userId && socket.roomId) setupAFKTimers(socket, userId);
      }),
    );

    // ── Disconnect ──────────────────────────────────────────────────────
    socket.on(
      "disconnect",
      safe(async (reason) => {
        const userId = socket.handshake.session?.userId;
        const username = socket.handshake.session?.username || "Unknown";
        const location = socket.handshake.session?.location || "Unknown";
        if (socket.deviceId)
          identity.addTime(
            socket.deviceId,
            Date.now() - (socket._idAt || Date.now()),
          );
        if (userId && reports.isTarget(userId))
          setTimeout(() => broadcastReportsList(), 150);
        if (userId) {
          clearAFKTimers(userId);
          await leaveRoom(socket, userId);
          state.userMessageBuffers.delete(userId);
          state.devUsers.delete(userId);
          cancelLinkSweep(userId);
          if (state.typingTimeouts.has(userId)) {
            clearTimeout(state.typingTimeouts.get(userId));
            state.typingTimeouts.delete(userId);
          }
          if (state.batchProcessingTimers.has(userId)) {
            clearTimeout(state.batchProcessingTimers.get(userId));
            state.batchProcessingTimers.delete(userId);
            state.pendingChatUpdates.delete(userId);
          }
          state.users.delete(userId);
        }
        releaseSlot();
        if (socket.isDev || socket.isMod) staffchat.presenceDirty();
        console.log(
          `Disconnected: "${username}" from "${location}" (${reason}) IP:${socket.clientIp}${socket.isBot ? " [BOT]" : ""}${socket.isDev ? " [DEV]" : ""}`,
        );
      }),
    );
  });
}

// ── Cleanup Intervals ───────────────────────────────────────────────────────

function startCleanupIntervals() {
  setInterval(async () => {
    try {
      await pressureCleanup();
    } catch (err) {
      console.error("Pressure cleanup error:", err);
    }
  }, CONFIG.LIMITS.PRESSURE_CLEANUP_INTERVAL);

  setInterval(() => {
    const now = Date.now();
    for (const [id, attempts] of state.userJoinAttempts.entries()) {
      const valid = attempts.filter(
        (t) => now - t < CONFIG.LIMITS.BOT_DETECTION_WINDOW,
      );
      if (valid.length === 0) state.userJoinAttempts.delete(id);
      else state.userJoinAttempts.set(id, valid);
    }
    for (const [ip, attempts] of state.ipJoinAttempts.entries()) {
      const valid = attempts.filter(
        (t) => now - t < CONFIG.LIMITS.BOT_DETECTION_WINDOW,
      );
      if (valid.length === 0) state.ipJoinAttempts.delete(ip);
      else state.ipJoinAttempts.set(ip, valid);
    }
    for (const [id, data] of state.suspiciousUsers.entries()) {
      if (now - data.firstDetection > CONFIG.TIMING.BOT_BLOCK_DURATION)
        state.suspiciousUsers.delete(id);
    }
  }, 120000);

  setInterval(() => {
    try {
      sweepBoardClaims();
    } catch (e) {
      console.error("board claim sweep failed:", e);
    }
  }, 30000);

  setInterval(() => {
    const now = Date.now();
    let expired = 0;
    for (const [token, data] of state.botTokens.entries()) {
      if (now - data.createdAt > CONFIG.TIMING.BOT_TOKEN_EXPIRY) {
        state.botTokens.delete(token);
        expired++;
        const c = state.ipBotTokenCounts.get(data.ip) || 0;
        if (c > 1) state.ipBotTokenCounts.set(data.ip, c - 1);
        else state.ipBotTokenCounts.delete(data.ip);
      }
    }
    if (expired > 0) console.log(`Cleaned ${expired} expired bot tokens`);
  }, CONFIG.TIMING.BOT_TOKEN_CLEANUP_INTERVAL);

  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [ip, data] of state.ipBasedUsers.entries()) {
      if (now - data.lastSeen > CONFIG.LIMITS.IP_USER_CLEANUP_INTERVAL) {
        state.ipBasedUsers.delete(ip);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`Cleaned ${cleaned} inactive IP users`);
  }, CONFIG.LIMITS.IP_USER_CLEANUP_INTERVAL);

  setInterval(() => {
    const active = new Set();
    for (const [, room] of state.rooms) {
      if (room.users) room.users.forEach((u) => active.add(u.id));
    }
    for (const id of state.userMessageBuffers.keys()) {
      if (!active.has(id)) state.userMessageBuffers.delete(id);
    }
    for (const id of [...linkSweepTimers.keys()])
      if (!active.has(id)) cancelLinkSweep(id);
    for (const id of state.typingTimeouts.keys()) {
      if (!active.has(id)) {
        clearTimeout(state.typingTimeouts.get(id));
        state.typingTimeouts.delete(id);
      }
    }
    for (const id of state.afkTimers.keys()) {
      if (!active.has(id)) clearAFKTimers(id);
    }
  }, 300000);

  setInterval(() => {
    const active = new Set();
    for (const [, room] of state.rooms) {
      if (room.users) room.users.forEach((u) => active.add(u.id));
    }
    for (const id of state.batchProcessingTimers.keys()) {
      if (!active.has(id)) {
        clearTimeout(state.batchProcessingTimers.get(id));
        state.batchProcessingTimers.delete(id);
        state.pendingChatUpdates.delete(id);
      }
    }
    if (state.normalizeCache.size > 1000) {
      Array.from(state.normalizeCache.keys())
        .slice(0, 200)
        .forEach((k) => state.normalizeCache.delete(k));
    }
    const now = Date.now();
    for (const [k, v] of state.apiCache.entries()) {
      if (now - v.timestamp > state.API_CACHE_TTL) state.apiCache.delete(k);
    }
    for (const [ip, ts] of state.ipLastRoomCreation.entries()) {
      if (now - ts > 300000) state.ipLastRoomCreation.delete(ip);
    }
    for (const [ip, rec] of staffKeyAttempts.entries()) {
      if (now > rec.resetAt) staffKeyAttempts.delete(ip);
    }
    for (const roomId of state.roomSoloSince.keys()) {
      if (!state.rooms.has(roomId)) state.roomSoloSince.delete(roomId);
    }
    for (const roomId of state.roomLastChatActivity.keys()) {
      if (!state.rooms.has(roomId)) state.roomLastChatActivity.delete(roomId);
    }
    for (const roomId of boardState.keys()) {
      if (!state.rooms.has(roomId)) boardState.delete(roomId);
    }
  }, 180000);

  setInterval(async () => {
    const now = Date.now();
    const toDelete = [];
    for (const [id, room] of state.rooms) {
      if (
        (!room.users || room.users.length === 0) &&
        now - room.lastActiveTime > CONFIG.TIMING.ROOM_DELETION_TIMEOUT
      )
        toDelete.push(id);
    }
    for (const id of toDelete) {
      state.rooms.delete(id);
      state.roomSoloSince.delete(id);
      state.roomLastChatActivity.delete(id);
      cleanupBoardState(id);
      if (state.roomDeletionTimers.has(id)) {
        clearTimeout(state.roomDeletionTimers.get(id));
        state.roomDeletionTimers.delete(id);
      }
    }
    if (toDelete.length > 0) {
      updateLobby();
      await debouncedSaveRooms();
      console.log(`Cleaned ${toDelete.length} empty rooms`);
    }
  }, 600000);

  setInterval(() => {
    if (!io()) return;
    const live = new Map();
    for (const [, s] of io().sockets.sockets) {
      const ip = s.clientIp;
      if (!ip) continue;
      live.set(ip, (live.get(ip) || 0) + 1);
    }
    let leaked = 0;
    let worst = null;
    for (const ip of [...state.ipConnections.keys()]) {
      const had = state.ipConnections.get(ip) || 0;
      const now = live.get(ip) || 0;
      if (had > now) {
        leaked += had - now;
        if (!worst || had - now > worst.by)
          worst = { ip, had, now, by: had - now };
      }
      if (!live.has(ip)) state.ipConnections.delete(ip);
    }
    for (const [ip, n] of live) state.ipConnections.set(ip, n);
    if (leaked)
      console.warn(
        `[conn] reclaimed ${leaked} stale connection slot(s); worst: ${worst.ip} counted ${worst.had} with ${worst.now} live`,
      );
  }, 30000);

  setInterval(() => {
    const activeIds = new Set();
    for (const [, s] of io().sockets.sockets) {
      const uid = s.handshake?.session?.userId;
      if (uid) activeIds.add(uid);
    }
    let ghostCount = 0;
    const affectedRooms = [];
    for (const [roomId, room] of state.rooms) {
      if (!room.users || room.users.length === 0) continue;
      const before = room.users.length;
      room.users = room.users.filter((u) => {
        if (u.isBotUser && bots.isActiveBot(u.id)) return true;
        if (diag.isHeld(u.id)) return true;
        if (!activeIds.has(u.id)) {
          console.log(`Ghost removed: "${u.username}" from "${room.name}"`);
          state.userMessageBuffers.delete(u.id);
          clearAFKTimers(u.id);
          state.devUsers.delete(u.id);
          finalizeBoardUserStroke(roomId, u.id);
          cancelLinkSweep(u.id);
          if (state.typingTimeouts.has(u.id)) {
            clearTimeout(state.typingTimeouts.get(u.id));
            state.typingTimeouts.delete(u.id);
          }
          if (state.batchProcessingTimers.has(u.id)) {
            clearTimeout(state.batchProcessingTimers.get(u.id));
            state.batchProcessingTimers.delete(u.id);
            state.pendingChatUpdates.delete(u.id);
          }
          return false;
        }
        return true;
      });
      const removed = before - room.users.length;
      if (removed > 0) {
        ghostCount += removed;
        affectedRooms.push(roomId);
      }
    }
    for (const id of affectedRooms) {
      const r = state.rooms.get(id);
      if (r) {
        updateRoom(id);
        updateRoomSoloTracking(id);
        if (r.users.length === 0) startRoomDeletionTimer(id);
      }
    }
    if (ghostCount > 0) {
      console.log(`Ghost cleanup: removed ${ghostCount} ghost(s)`);
      updateLobby();
      debouncedSaveRooms().catch(() => {});
    }
  }, 60000);

  setInterval(() => {
    const mem = process.memoryUsage();
    const stats = getRoomStatistics();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    console.log(
      `[STATUS] Clients:${io().sockets.sockets.size} ` +
        `Rooms:${stats.totalRooms}/${stats.hardCap} ` +
        `Healthy:${stats.healthyRooms}/${stats.currentLimit} ` +
        `Solo:${stats.soloRooms} TTL:${stats.currentSoloTTL}s ` +
        `Users:${stats.totalUsers} Heap:${heapMB}MB ` +
        `Tokens:${state.botTokens.size} ` +
        `Devs:${state.devUsers.size} ` +
        `Boards:${boardState.size}`,
    );
    if (heapMB > 400) {
      console.warn(`MEMORY WARNING: ${heapMB}MB heap`);
      if (heapMB > 500) {
        for (const [id, msg] of state.userMessageBuffers.entries()) {
          if (msg.length > 1000)
            state.userMessageBuffers.set(id, msg.substring(0, 1000));
        }
        state.normalizeCache.clear();
        state.apiCache.clear();
        if (global.gc) global.gc();
      }
    }
  }, 120000);
}

// ── Ghost Purge (Startup) ───────────────────────────────────────────────────

function purgeAllGhostUsers() {
  const activeIds = new Set();
  for (const [, s] of io().sockets.sockets) {
    const uid = s.handshake?.session?.userId;
    if (uid) activeIds.add(uid);
  }
  let total = 0;
  const affected = [];
  for (const [roomId, room] of state.rooms) {
    if (!room.users || room.users.length === 0) continue;
    const before = room.users.length;
    room.users = room.users.filter((u) => {
      if (activeIds.has(u.id)) return true;
      if (u.isBotUser && bots.isActiveBot(u.id)) return true;
      if (diag.isHeld(u.id)) return true;
      state.userMessageBuffers.delete(u.id);
      clearAFKTimers(u.id);
      state.devUsers.delete(u.id);
      if (room.votes) {
        delete room.votes[u.id];
        for (const vid in room.votes)
          if (room.votes[vid] === u.id) delete room.votes[vid];
      }
      console.log(`Startup purge: ghost "${u.username}" from "${room.name}"`);
      return false;
    });
    const removed = before - room.users.length;
    if (removed > 0) {
      total += removed;
      affected.push(roomId);
    }
  }
  for (const id of affected) {
    const r = state.rooms.get(id);
    if (!r) continue;
    r.lastActiveTime = Date.now();
    updateRoom(id);
    updateRoomSoloTracking(id);
    if (r.users.length === 0) {
      cleanupBoardState(id);
      startRoomDeletionTimer(id);
    }
  }
  if (total > 0) {
    console.log(`Startup purge: removed ${total} ghost(s)`);
    updateLobby();
    debouncedSaveRooms().catch(() => {});
  } else console.log("Startup purge: no ghosts found");
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  loadRooms,
  saveRooms,
  loadBoard,
  saveBoardSync,
  debouncedSaveRooms,
  registerSocketHandlers,
  startCleanupIntervals,
  purgeAllGhostUsers,
  updateLobby,
  getRoomStatistics,
  calculateCurrentRoomLimit,
  roomNameExists,
  startRoomDeletionTimer,
  leaveRoom,
  joinRoom,
  roomCapacity,
  newRoomCapacity,
  announceAppeal,
  announceAppealMessage,
};
