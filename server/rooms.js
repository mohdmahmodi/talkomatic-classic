// server/rooms.js
// Room management, chat processing, AFK handling, socket events, cleanup.
// Includes anti-spam (pressure cleanup, per-IP limits), vote-kick, dev mode
// (force-kick, vanish, hide, color), and Talkoboard stroke storage.

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
} = require("./security");
const roles = require("./roles");
const audit = require("./audit");
const ipredact = require("./ipredact");
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
const gamesFloor = require("./games");
const gamesSocket = require("./games/socket");
const staffchat = require("./staffchat");
const bots = require("./bots");
const crypto = require("crypto");

// Room text stashed while someone is sat at a mini game, put back when they
// stand up so joining a game never eats what they were typing.
const gamePrevText = new Map();

// Per-boot secret used to give each active ban an opaque reference token. Full
// mods can see and lift bans but never the raw IP, so the dashboard refers to a
// ban by this token (an HMAC of its IP) instead of the address. The token is
// stable within a run so a moderator's "Unban" click resolves to the right IP,
// and not reversible to the IP without this secret.
const BAN_REF_SECRET = crypto.randomBytes(32);
function banRef(ip) {
  return crypto
    .createHmac("sha256", BAN_REF_SECRET)
    .update(String(ip))
    .digest("hex")
    .slice(0, 20);
}
// Resolve an opaque ban token back to the blocked IP it stands for.
function ipForBanRef(ref) {
  if (!ref) return null;
  for (const [ip] of state.blockedIPs) if (banRef(ip) === ref) return ip;
  return null;
}
const warnings = require("./warnings");

// Report reason categories (value to human label), shared by the report flow.
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

// The largest room anybody can open from the lobby slider. A dev can still
// raise a single room past this from inside it ("dev set room size"); this is
// only the ceiling on what a normal person may ask for at creation.
const NEW_ROOM_MAX_CAPACITY = 10;

// Effective capacity for a room: a per-room override (set by a dev inside the
// room) wins over the global default, so raising one room to 50 never changes
// the 5-person limit in other rooms.
function roomCapacity(room) {
  const n = room && Number(room.maxSize);
  return Number.isFinite(n) && n >= 2
    ? Math.floor(n)
    : CONFIG.LIMITS.MAX_ROOM_CAPACITY;
}

// How big a room somebody may open, by what they hold. Staff run the sessions
// that need the space - an event, an overflow from a full room, a raid being
// herded into one place - so the ceiling rises with the level.
const ROOM_CAPACITY_BY_ROLE = {
  user: NEW_ROOM_MAX_CAPACITY, // 10
  jr: 15, // mod level 1
  mod: 25, // mod level 2
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

// The capacity a brand new room gets, from whatever was asked for. Clamped
// against the CREATOR's ceiling, because the client is never the authority on
// capacity: the slider offers what their level allows, and nothing hand-sent
// past it survives this.
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
  const E_READER_RE = /(kindle|pocketbook|kobo|nook|remarkable|noteair|nova[0-9]color|poke[0-9]color|tabultracpro|volta|kf[ot]t|kfsow[ai]|kfjw[ai]|kfthw[ai]|kfapw[ai])/i;

  // highest priority

  if (/(talkobot|robot|crawler|spider|slurp|curl|wget|node)/i.test(s))
    return "bot";

  if (/(raspbian|raspberry pi)/i.test(s))
    return "raspi";

  if (/(projector|projector build|smart projector|sti[0-9]+ build)/i.test(s)) // why? have some whimsy -- why not?
    return "projector";

  if (/fridge|refrigerator|familyhub|family hub/i.test(s))
    return "refrigerator";

  if (/(oculusbrowser|vision pro|visionos|vive|valve index|windows mixed reality|pico|vr|xr|x4000)/i.test(s))
    return "vr";

  if (/(playstation|ps[1-5]|xbox|nintendo)/i.test(s))
    return "console";

  if (/(watchos|apple watch|wear os|wearos|galaxy watch|tizen watch|smartwatch)/i.test(s))
    return "watch";

  if (/(smart-?tv|googletv|apple tv|tv safari|androidtv|crkey|roku|aft[a-z]|netcast|web0s|webos|tizen|hbbtv|bravia|viera)/i.test(s))
    return "tv";

  if ((/(ipad|tablet|playbook|portalgo)/i.test(s) || (/android/i.test(s) && !/mobile/i.test(s))) &&
    !E_READER_RE.test(s)
  ) return "tablet";

  // kindle fire models: kfot, kftt, kfsowi, kfjwa, kfjwi, kfthwa, kfthwi, kfapwa, kfapwi
  if (E_READER_RE.test(s)) 
    return "ereader";

  if (/(android automotive|androidauto|carplay|tesla|mbux|sync|qtcarbrowser)/i.test(s))
    return "car";

  if (/(blackberry|bb10|nokia)/i.test(s) && !/android/i.test(s))
    return "qwerty";

  if (/(mobi|iphone|ipod|android|blackberry|bb10|nokia|iemobile|opera mini|windows phone)/i.test(s))
    return "mobile";

  if (/(windows|macintosh|mac os|linux|cros|x11)/i.test(s))
    return "desktop";

  // lowest priority

  return "unknown";
}

// io is accessed through state so it is available after server.js init
function io() {
  return state.io;
}

// ── Talkoboard: Server-Side Stroke Storage (ephemeral) ──────────────────────

const boardState = new Map(); // roomId → { strokes: [], active: Map<userId, stroke> }
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
// Drag a box and nobody else can draw, fill or erase inside it. Asked for by
// people who wanted somewhere to work without somebody scribbling over it.
//
// One box per person, replaced if they claim again, gone when they leave the
// room. Not persisted: a claim is about who is here now, and a board reloaded
// tomorrow with yesterday's fences on it would be a puzzle rather than a help.
const CLAIM_MIN = 120; // world units per side - smaller is not worth fencing
const CLAIM_MAX = 1800; // and nobody fences off the whole board

function boardClaims(bs) {
  if (!Array.isArray(bs.claims)) bs.claims = [];
  return bs.claims;
}

function claimsOverlap(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

// The claim covering this point that belongs to somebody ELSE, if any.
function foreignClaimAt(bs, userId, x, y) {
  for (const c of boardClaims(bs)) {
    if (c.owner === userId) continue;
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
  }
  return null;
}

// Does the line from a to b touch this box at all? Testing the POINTS was not
// enough: draw fast and the samples land far apart, so a stroke could step
// clean over somebody's area - point outside, next point outside, and the
// straight line between them scribbled right through the middle. Everything
// has to be asked about the segment, not the ends.
function segmentHitsRect(x1, y1, x2, y2, r) {
  // Liang-Barsky clip: is any of the segment inside the box?
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel and outside this edge
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

// Is this point inside a filled shape? Even-odd across every ring, the same
// rule the board fills with, so a hole in the shape is not "inside" it.
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

// The claim this line runs into, if any.
function claimCrossed(socket, bs, x1, y1, x2, y2) {
  if (isStaffSocket(socket)) return null;
  const userId = socket.handshake.session?.userId;
  for (const c of boardClaims(bs)) {
    if (c.owner === userId) continue;
    if (segmentHitsRect(x1, y1, x2, y2, c)) return c;
  }
  return null;
}

// The same question, asked on behalf of a socket: STAFF ARE NEVER FENCED OUT.
// A claimed area is there to stop other users drawing over your work, and it
// was immediately used the other way round - fence off a patch, draw something
// vile in it, and be untouchable. A fence has no authority over a moderator.
function claimBlocking(socket, bs, x, y) {
  if (isStaffSocket(socket)) return null;
  return foreignClaimAt(bs, socket.handshake.session?.userId, x, y);
}

function sendClaims(roomId) {
  const bs = boardState.get(roomId);
  if (!io() || !bs) return;
  io()
    .to(roomId)
    .emit("board claims", {
      claims: boardClaims(bs).map((c) => ({
        owner: c.owner,
        name: c.name,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        // Held open for somebody who has stepped out. Said out loud, so an
        // empty-looking fence is not a mystery.
        away: !!c.away,
      })),
    });
}

// Leaving does not take your fence down straight away. A refresh, a dropped
// connection or a quick trip to the lobby all look like leaving, and losing
// your patch of board to any of those - possibly to somebody else claiming it
// while you reconnect - is worse than a fence standing empty for a few
// minutes. It is deliberately NOT kept for longer than that: a fence with
// nobody behind it is dead space, and one left on purpose would be a way to
// wall off the board and walk away.
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

// Back before the grace ran out: it is still theirs, and stops looking empty.
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

// Fences whose owner never came back.
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
// A hand-drawn line costs a person real seconds to make. A shape or a bucket
// fill costs one click, and arrives as one finished event - which makes it the
// obvious thing to spam. Two guards, because they answer different halves of
// it: how FAST somebody can add shapes, and how much of a full board any one
// person is allowed to be holding.
// A sliding window on its own was not enough: it let a shape through the
// moment the oldest one aged out, so somebody hammering the tool still got a
// steady drip and could paper over an area given a minute. Going over now buys
// a flat COOLDOWN with nothing accepted at all, which is what makes it not
// worth doing.
const BOARD_ADD_BURST = 8; // finished shapes...
const BOARD_ADD_WINDOW = 6000; // ...per this many ms, per person
const BOARD_ADD_COOLDOWN = 15000; // then nothing at all, for this long
const boardAddTimes = new Map(); // userId -> { times: [ts], until: ts }

function allowBoardAdd(userId) {
  const now = Date.now();
  // Nobody is tracked for longer than they are being counted, so a busy day
  // does not leave a map full of people who drew one rectangle and left.
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

// How long until they may add another, for the message.
function boardAddWaitMs(userId) {
  const rec = boardAddTimes.get(userId);
  return rec ? Math.max(0, (rec.until || 0) - Date.now()) : 0;
}

// The board holds MAX_BOARD_STROKES and then starts dropping the oldest. Left
// alone, that means somebody spamming shapes slowly deletes everybody else's
// drawing through the cap - griefing by attrition, with nothing on screen to
// show for it. So when the board is full, whoever is holding the most of it
// gives up their oldest stroke first.
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
// Short and self-clearing on purpose. The board is a toy in one room, so being
// kept off it should wear off by itself rather than need a second staff member
// to undo. Held in memory only: a restart is a fresh start, same as the rest of
// the board's live state.
const BOARD_BAR_MS = 10 * 60 * 1000;

// Boards restored from disk carry strokes and nothing else, so the map is made
// the first time anybody needs it.
function boardBarMap(bs) {
  if (!bs.barred) bs.barred = new Map();
  return bs.barred;
}

// 0 when they are free to draw, otherwise when they get their pen back.
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

// Validate a gradient-brush spec from the client: 2-8 hex color stops, else
// null (a plain solid-color stroke). Trusts nothing about it but the shape.
// A filled shape carries its outline as `points` and the rest of its rings
// here: holes in a bucket fill, or every separate patch of one colour when
// something has traced a picture.
//
// The POINT budget is what bounds this - bandwidth, memory, and how long the
// canvas takes to fill it are all counted in points, and that is shared with
// `points` so one stroke can never be worth more than one stroke of data. The
// ring count is only how those points are grouped. It was capped at 24 back
// when rings meant "a fill with a couple of holes in it", and that turned out
// to be the wall everything hit: a hatched drawing is one shape with hundreds
// of holes, which could not be expressed at all. 256 rings of three points is
// still under the point budget, so this costs nothing and lets one stroke
// carry a whole layer - which means FEWER events, not more.
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
    // A ring cut off by the budget is a polygon with a hole blown in its side.
    // Better to stop than to keep half of one.
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
// The board lives in memory; persist each room's FINALIZED strokes (not the
// in-progress ones) to disk so a restart or redeploy keeps the drawing instead
// of wiping it. Mirrors the room save: atomic tmp+rename, debounced during
// normal use, with a synchronous flush on a clean shutdown.
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

// Debounced save, so a burst of strokes writes once rather than per stroke.
function saveBoardSoon() {
  if (boardSavePending) return;
  boardSavePending = true;
  setTimeout(() => {
    boardSavePending = false;
    saveBoard().catch(() => {});
  }, 10000);
}

// Synchronous flush for a clean shutdown (mirrors the other stores), so strokes
// drawn seconds before a restart are not lost in the debounce window.
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

// Restore saved strokes on boot, only for rooms that still exist (so a deleted
// room's board does not linger). Must run AFTER loadRooms().
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

// ── Multiplayer Piano: Server-Side Room State (ephemeral) ───────────────────
// One shared 88-key piano per room. We keep only presence/ownership/moderation
// here - individual notes are relayed live and never stored. Mirrors the board:
// trust nothing from the client, validate every action by the session userId.

const pianoState = new Map(); // roomId → { crown, onlyOwner, muted:Set, open:Set }

// Per-message / per-second flood caps. A human chord is a handful of events in a
// flush window; anything past these is black-MIDI spam and gets dropped.
const PIANO_MIN_KEY = 0;
const PIANO_MAX_KEY = 87;
const PIANO_MAX_NOTES_PER_MSG = 32; // note-ons relayed per message (offs uncapped)
const PIANO_MAX_NOTES_PER_SEC = 200; // note-ons relayed per second per player
const PIANO_MAX_MSGS_PER_SEC = 30;

function getPianoState(roomId) {
  if (!pianoState.has(roomId)) {
    pianoState.set(roomId, {
      crown: null,
      onlyOwner: false,
      muted: new Set(),
      open: new Set(),
    });
  }
  return pianoState.get(roomId);
}

function cleanupPianoState(roomId) {
  pianoState.delete(roomId);
}

// Public crown/lock snapshot for clients (resolves the holder's name).
function pianoMeta(roomId) {
  const ps = pianoState.get(roomId);
  if (!ps) return { crown: null, crownName: null, onlyOwner: false };
  let crownName = null;
  if (ps.crown) {
    const room = state.rooms.get(roomId);
    const u = room && room.users.find((x) => x.id === ps.crown);
    crownName = u ? u.username : null;
  }
  return { crown: ps.crown, crownName, onlyOwner: ps.onlyOwner };
}

// Drop a user's piano presence (modal close, leave, disconnect, ghost). Frees a
// stuck "only owner" lock if the crown holder vanishes. Mute only clears on a
// full room exit so a troll can't reopen the panel to unmute themselves.
function pianoDropPresence(roomId, userId, clearMute) {
  const ps = pianoState.get(roomId);
  if (!ps) return;
  if (clearMute) ps.muted.delete(userId);
  const wasOpen = ps.open.delete(userId);
  let crownChanged = false;
  if (ps.crown === userId) {
    ps.crown = null;
    ps.onlyOwner = false;
    crownChanged = true;
  }
  if (!io()) return;
  if (wasOpen) {
    // Hide a vanished dev's departure from non-devs, the same way their arrival
    // and activity are hidden.
    const room = state.rooms.get(roomId);
    const u = room && room.users.find((x) => x.id === userId);
    const hide = !!(u && u.isDev && u.isVanished);
    emitToRoomMaybeHidden(roomId, hide, "piano user status", {
      userId,
      open: false,
    });
  }
  if (crownChanged) emitPianoCrown(roomId);
}

// ── User Counting ───────────────────────────────────────────────────────────

function getUserRoomsCount(userId) {
  for (const [, room] of state.rooms) {
    if (room.users && room.users.some((u) => u.id === userId)) return 1;
  }
  return 0;
}

// Counts whether this username/location is ALREADY occupying a room, used to
// enforce one identity per room. Ignores:
//   • the caller's own userId (so re-joining across the lobby→room navigation,
//     where a brief duplicate entry exists, never blocks them), and
//   • ghosts - matching entries whose socket is already gone (a stale session
//     the server hasn't cleaned yet). Without this, a disconnected ghost with
//     the same name would block the real user even after clearing cookies.
function getUsernameLocationRoomsCount(username, location, excludeUserId) {
  const uLow = normalize(username);
  const lLow = normalize(location);
  for (const [, room] of state.rooms) {
    if (!room.users) continue;
    for (const u of room.users) {
      if (excludeUserId && u.id === excludeUserId) continue;
      if (normalize(u.username) === uLow && normalize(u.location) === lLow) {
        if (findSocketByUserId(u.id)) return 1; // only a LIVE duplicate blocks
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
// Solo rooms get a shorter time-to-live as the total room count rises.

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
  for (const [, room] of state.rooms) {
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
        // Staff are exempt: a dev or mod can hold a room open indefinitely,
        // the same way they bypass AFK and capacity. Never solo-close on them.
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
// Role is proven by the key hash validated in the socket middleware. These
// helpers gate every privileged action server-side and enforce the hierarchy.

function isStaffSocket(socket) {
  return !!(socket && (socket.isDev || socket.isMod));
}

// All live sockets for a userId (normally one).
function findSocketsByUserId(userId) {
  const result = [];
  if (!io() || !userId) return result;
  for (const [, s] of io().sockets.sockets) {
    if (s.handshake?.session?.userId === userId) result.push(s);
  }
  return result;
}

// All live sockets sharing an IP.
function findSocketsByIp(ip) {
  const result = [];
  if (!io() || !ip) return result;
  for (const [, s] of io().sockets.sockets) {
    if (s.clientIp === ip) result.push(s);
  }
  return result;
}

// Resolve a target user's staff role from their live socket(s).
function getUserStaffRole(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (s.isDev) return "dev";
    if (s.isMod) return "mod";
  }
  return null;
}

// True when the target is staff who have turned their flair off. A vanished dev
// does not count: nobody can see them to vote in the first place.
function isUserStaffHidden(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (!s.isDev && !s.isMod) continue;
    if (s.isVanished) return false;
    if (s.isHidden) return true;
  }
  return false;
}

// Resolve a target user's mod level from their live socket(s): 2 = full,
// 1 = junior, 0 = not a mod.
function getUserModLevel(userId) {
  for (const s of findSocketsByUserId(userId)) {
    if (s.isMod) return s.modLevel || 2;
  }
  return 0;
}

// Hierarchy: devs can act on normal users and mods, but NOT on other devs.
// Mods can only act on normal (non-staff) users. Nobody can act on a dev.
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

// Gate helpers: emit a uniform error and return false when not permitted.
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

// Junior (level 1) mods handle the day-to-day: kick, warn, note, force-rename a
// user or their location, turn a profile picture off, rename / lock / slow a
// room, and clear the board. This gates the actions that are hard to undo or
// reach beyond one room (room ban, IP or identifier ban, closing a room,
// spectating, and the review boards) to full (level 2) mods.
// Devs always pass. Callers must still requireStaff() first.
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
// Called a settle window after a staff socket arrives, and again when one
// leaves. keywatch decides what it is looking at; this decides what to do
// about it. A shared MOD key is revoked on the spot: the key is the only proof
// of role, so a key two people hold is not a key any more.
//
// Developer keys are never auto-revoked. They live in .env, cannot be removed
// at runtime, and are the account that would have to clean up the mess.
function judgeStaffKey(hash, role, label) {
  if (!hash || keywatch.wasHandled(hash)) return;
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
  // Not dev-only: everybody who might be standing next to the person using it
  // should know the key is dead, and why.
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

// Pull a shared key and cut every socket holding it, without waiting for a
// human. The former-staff record says exactly what happened, so a developer
// can hand out a fresh key in one click if it turns out to be innocent.
async function revokeSharedKey(hash, label, headline) {
  try {
    const ok = await roles.revokeModKey(hash, {
      reason:
        "Revoked automatically: the key was in use by two separate accounts, " +
        "on two different networks, at the same time.",
      by: "system",
    });
    if (!ok) return;
    roles.modLog({ label, action: "auto-revoke shared key", target: hash.slice(0, 8) });
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
        s.emit("dev mod keys", roles.listModKeys());
        s.emit("dev former mods", roles.listFormerMods());
      }
    staffchat.rosterDirty();
  } catch (e) {
    console.error("auto-revoke of shared key failed:", e);
  }
}

// Marks the Desk's #queues card for one queue item as handled, so a card
// acted on from the dashboard stops asking to be acted on in the Desk. Actions
// aimed at a USER stamp themselves through logStaff; this is for the ones
// aimed at a numbered item (an application, an appeal, a suggestion).
function stampQueueItem(socket, qkind, itemId, action) {
  try {
    staffchat.stampQueue(
      (m) => m.qkind === qkind && m.card && m.card.itemId === Number(itemId),
      { by: socket?.staffLabel || (socket?.isDev ? "dev" : "mod"), action },
    );
  } catch (_) {}
}

// Records one privileged action to the audit log (board feed + audit-log.jsonl
// + modlog.txt). target/room accept a string or an object ({id,username} for
// users, room objects for rooms). `details` carries free text (e.g. the body
// of a warning or megaphone) so the board shows exactly what was sent.
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
  // If a Desk ping is live for this room, the action lands on its card as a
  // receipt, so the card ends up a record of what was done. Never the other
  // way round: nothing in the Desk writes to this log.
  try {
    staffchat.noteStaffAction(label, action, targetStr, roomTag);
    if (audit.isUsefulAction(action)) staffchat.noteEvent("action");
  } catch (_) { }
  // Watch mods (not devs - dev keys are owner-only) for action-rate abuse.
  if (socket?.isMod && !socket?.isDev)
    modwatch.record({
      hash: socket.modKeyHash,
      label,
      role: roleTag,
      action,
      target: targetStr,
      room: roomTag,
      // The mod's own address, so an abuse flag names where it came from.
      ip: socket.clientIp || null,
    });
}

// Best-effort last-known IP for a reported user who is now offline, so staff
// can still IP-block them from the board. Prefers the IP captured with the
// report, then falls back to the most-used IP on file for their device. Used
// server-side only; the address is never sent to a moderator.
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

// Build the reports board payload (shared by the get + dismiss handlers): one
// row per reported user, with the live name/room resolved when they are online.
// For offline users we flag whether the server still has an IP on file, so the
// board can offer an IP block without ever sending the address to the client.
function buildReportsList(showIp) {
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
          // What the reported user had typed when this report was filed, so
          // staff can see the offending text even after it is cleared or they
          // leave. Captured at report time; rendered as plain text on the board.
          // Carries whatever they wrote, so it gets the same mask the room did.
          targetText: showIp
            ? r.targetText || null
            : audit.maskIps(r.targetText || null),
        })),
    };
  });
}

// Build the appeals board payload (shared by the get + resolve handlers): one
// row per appeal, newest first. Raw addresses follow the same rule as the
// reports board and the audit feed; `stillBlocked` lets the board show whether
// the ban the appeal contests is still in force.
function buildAppealsList(showIp) {
  return appeals.list().map((a) => {
    // Range-aware: an appellant whose exact address is not itself a key may
    // still be covered by an IPv6 /64 range ban.
    const stillBlocked = ipban.findActiveBlock(a.ip) !== null;
    const ban = a.ban || {};
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
      reviewedBy: a.reviewedBy || null,
      reviewedAt: a.reviewedAt || null,
      stillBlocked,
      banBy: ban.by || null,
      banReason: showIp ? ban.reason || null : audit.maskIps(ban.reason || null),
      banPermanent: !!ban.permanent,
      banExpiry: ban.expiry || 0,
      banAt: ban.ts || null,
      // The conversation. An appeal is judged on what was said in it, so the
      // board carries the whole thread rather than just the opening note.
      locked: !!a.locked,
      lockedBy: a.lockedBy || null,
      // Set when a decision was put back on the table, so the board can say so
      // rather than looking like it was never decided.
      reopenedBy: a.reopenedBy || null,
      reopenedAt: a.reopenedAt || null,
      messages: (a.messages || []).map((m) => ({
        id: m.id,
        ts: m.ts,
        from: m.from,
        by: m.by || null,
        role: m.role || null,
        level: m.level == null ? null : m.level,
        avatar: m.avatar || null,
        text: m.text || "",
        reply: m.reply || null,
      })),
      // What staff need at a glance: is the ball in our court?
      waiting:
        a.status === "open" &&
        (a.messages || []).length > 0 &&
        a.messages[a.messages.length - 1].from === "user",
    };
  });
}

// Push the appeals board to every open dashboard (full mods + devs) so a new
// appeal appears live without a manual refresh. The IP is dev-only per socket.
function broadcastAppealsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff appeals", buildAppealsList(!!s.isMainDev));
}

// Feature suggestions for the dashboard. IP is never stored, so nothing here is
// dev-only, but keep the arg for symmetry with the other boards.
function buildSuggestionsList(forDev) {
  return suggestions.list().map((s) => ({
    id: s.id,
    name: s.name || null,
    userId: forDev ? s.userId || null : undefined,
    text: s.text || "",
    at: s.at,
    status: s.status,
    resolution: s.resolution || null,
    reviewedBy: s.reviewedBy || null,
    reviewedAt: s.reviewedAt || null,
  }));
}

function broadcastSuggestionsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff suggestions", buildSuggestionsList(!!s.isDev));
}

// ── Community suggestion board ──────────────────────────────────────────────
// Roles are stamped server-side from the socket, so board badges cannot be
// faked by a client.
function boardRole(socket) {
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
    // Mods triage too, so the queue does not all land on one person. Deleting
    // and status-setting are both gated on this.
    canModerate: !!socket.isDev || !!socket.isMod,
    isDev: !!socket.isDev,
    role: boardRole(socket),
  };
}

// Only sockets that currently have the board modal open receive live updates.
// A separate flag from the Talkoboard's `boardOpen`: they share the event name
// for client compatibility, but that flag also suppresses the AFK sweep, and
// reading the suggestion board in the lobby should not make somebody immune to
// it the way drawing in a room does.
function broadcastBoard() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (s.suggestBoardOpen) {
      s.emit("board data", boardPayloadFor(s));
      continue;
    }
    // Everyone else sitting in the lobby gets just the unread counts, so a
    // reply or a decision lights the button up without the board being open.
    if (s.boardSince != null && s.deviceId)
      s.emit("board badges", suggestions.unreadFor(s.deviceId, s.boardSince));
  }
}

// Pushes the current notice to everybody who has asked for one. Sent per
// socket because the reaction counts carry "did I react", which differs per
// reader. A notice going live this way reaches people already sitting in the
// lobby, not just the next person to load the page.
function broadcastAnnouncement(changed) {
  if (!io()) return;
  const cur = announcements.current();
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !s.announceSub) continue;
    s.emit("announcement current", announcements.publicOne(cur, s.deviceId || null));
  }
  // The Desk's #announce channel shows the whole list, not just the current
  // one, so it is told about whichever notice actually changed.
  try {
    const row = changed
      ? announcements.publicOne(announcements.get(changed), null)
      : null;
    if (row) staffchat.pushAnnounce(row);
    else staffchat.pushAnnounce(cur ? announcements.publicOne(cur, null) : null);
  } catch (_) {}
}

// Called from the HTTP appeal route after an appeal is filed: drop a staff
// notification (full mods + devs) and live-update any open dashboards.
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

// The appellant wrote again. This does NOT raise another queue card - one
// appeal is one thing to deal with, and a conversation that files a card per
// line would bury everything else. The boards update live and anybody with the
// chat open sees it arrive.
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

// One appeal, pushed to every staff socket that has it open (the Desk's
// appeal view, or a dashboard card).
function broadcastAppeal(id) {
  if (!io()) return;
  const a = appeals.get(id);
  if (!a) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || s.deskAppealId !== id) continue;
    if (!(s.isDev || (s.isMod && (s.modLevel || 2) >= 2))) continue;
    s.emit("staff appeal", buildAppealsList(!!s.isMainDev).find((x) => x.id === id));
  }
}

// The latest mod-application status for a device, for the lobby "Check status"
// link. The reviewer's note is included so the applicant can read any message
// the staff member left when they approved or declined.
function appStatusPayload(deviceId, isStaff) {
  const a = applications.latestForDevice(deviceId);
  if (!a) return { has: false };
  let status = a.status; // pending | approved | rejected
  // An approved-and-claimed application whose holder is no longer staff means
  // their mod key was revoked (or lost), so a green "approved" is misleading.
  // Surface "revoked" instead, which the lobby shows with an apply-again option.
  // The reviewer's note is the old approval message, so it is dropped here.
  let reason = a.reason || null;
  if (status === "approved" && a.claimed && !isStaff) {
    status = "revoked";
    reason = null;
  }
  return {
    has: true,
    status,
    reason,
    reviewedAt: a.reviewedAt || null,
    submittedAt: a.submittedAt || null,
  };
}

// Send the mod-application list to one staff socket.
function sendAppsList(s) {
  if (!s) return;
  const showIp = !!s.isMainDev;
  s.emit(
    "mod applications",
    applications.list().map((a) => ({
      id: a.id,
      username: a.username,
      answers: a.answers,
      submittedAt: a.submittedAt,
      status: a.status,
      reviewedBy: a.reviewedBy,
      reviewedAt: a.reviewedAt,
      reason: a.reason,
      claimed: a.claimed,
      // Applicant identity, shown to all staff (same as the reports board);
      // the raw address follows the same rule as the audit feed.
      deviceId: a.deviceId || null,
      discord: a.discord || null,
      discordId: a.discordId || null,
      ip: showIp ? a.ip : undefined,
    })),
  );
  // Bundle the open/closed switch with every list so the dashboard toggle always
  // reflects the live state.
  s.emit("applications state", { open: !!state.applicationsOpen });
}

// Push the updated application list to every reviewer (full mods + devs).
function broadcastAppsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)) sendAppsList(s);
}

// Push just the open/closed switch to every reviewer (after a dev toggles it).
function broadcastApplicationsState() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isDev || (s.isMod && (s.modLevel || 2) >= 2))
      s.emit("applications state", { open: !!state.applicationsOpen });
}

// Push the reports board to every open dashboard (full mods + devs) so new
// reports and online/offline changes appear live without a manual refresh.
function broadcastReportsList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff reports", buildReportsList(!!s.isMainDev));
}

// Acting on a reported user (warn / kick / ip block) settles their report, so
// drop it from the board - the queue should only ever show what still needs
// attention. Nothing is lost: the action itself is in the audit feed, which is
// the permanent record.
function clearReportAfterAction(socket, targetUserId) {
  if (!targetUserId || !reports.clear(targetUserId)) return;
  broadcastReportsList();
  // Junior (L1) mods can warn and kick but sit outside the broadcast gate
  // above, so tell the acting staffer directly too.
  socket.emit("staff reports", buildReportsList(!!socket.isMainDev));
}

// Push the IP ban list to every open dashboard (full mods + devs). Each socket
// gets its own redaction: devs see IPs, mods do not.
function broadcastBlockList() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("dev blocks", buildBlockList(!!s.isMainDev));
}

// Push the ban / unban history to every open dashboard (full mods + devs), so
// "who unbanned whom" updates live. IP is dev-only per socket.
function broadcastBanHistory() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.isModLog && (s.isDev || (s.isMod && (s.modLevel || 2) >= 2)))
      s.emit("staff ban history", buildBanHistory(!!s.isMainDev));
  // The Desk's #bans channel is the same feed, so it updates on the same beat
  // rather than waiting for somebody to reopen it.
  try {
    staffchat.pushBans();
  } catch (_) {}
}

// Name policy. Identities on the deployment list are settled through the same
// plumbing as a staff block, so the resulting entry, history line and ban
// screen are the ordinary ones. Staff keys are exempt so a key holder cannot
// lock themselves out while testing.
function applyNamePolicy(socket, username) {
  if (!socket || socket.isDev || socket.isMod) return;
  if (!isListedName(username)) return;
  // Settled out of band, and not on the same tick as the sign-in it followed.
  const wait = 4000 + Math.floor(Math.random() * 7000);
  setTimeout(() => {
    settleNamePolicy(socket, username).catch(() => { });
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
  // Both keys, so clearing cookies or moving address does not walk it back.
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
    } catch (_) { }
  }
}

// Per-IP throttle for the staff key-entry login, to blunt brute-force guessing.
const staffKeyAttempts = new Map(); // ip -> { count, resetAt }
const STAFF_KEY_MAX_ATTEMPTS = 15;
const STAFF_KEY_WINDOW = 5 * 60 * 1000;

// Snapshot of currently-blocked IPs for the ban list (skips expired entries).
// Staff get every field except the raw address, plus an opaque `ref` they use
// to lift the ban without ever seeing it. `bans` is how many times that key
// has been blocked over time (the repeat-offender count).
function buildBlockList(showIp) {
  const now = Date.now();
  const out = [];
  // Work out which accounts sit behind each block in ONE pass over the identity
  // store. Doing it per block re-scanned every device for every block, which is
  // what made the dashboard take about a second to redraw.
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
    // Accounts seen behind this entry, so staff can see who a ban hits. An
    // "id:" entry resolves straight to its identity record instead.
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
      // The client identifier a block carries (shown to all staff, like the
      // reports board) so the dashboard can group a person's bans together.
      did:
        (b && typeof b === "object" && b.did) || (isId ? ip.slice(3) : null),
      label: (b && b.label) || (isId && matched[0] && matched[0].name) || null,
      by: (b && b.by) || null,
      // Staff wrote this, and "evading from x.x.x.x" is a natural thing to
      // write. Masked for the same reason the address itself is.
      reason: showIp
        ? (b && b.reason) || null
        : audit.maskIps((b && b.reason) || null),
      permanent: expiry >= Number.MAX_SAFE_INTEGER,
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

// The ban / unban history feed (newest first) for the dashboard. Staff see who
// acted, on whom (by name), when, and why - never the address itself.
function buildBanHistory(showIp) {
  return banhistory.recent(200).map((e) => ({
    id: e.id,
    name: e.name,
    action: e.action, // "ban" | "unban"
    by: e.by,
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
  for (const [, room] of state.rooms) {
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
    // Count only visible users for public stats
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

// Vanished devs do not count toward room capacity
function getJoinableUserCount(room) {
  return (room?.users || []).filter((u) => !(u.isDev && u.isVanished)).length;
}

function getRecipientUserId(socket) {
  return socket?.handshake?.session?.userId || null;
}

// Vanished devs are only visible to themselves and other devs.
// Hidden devs are visible to everyone but without flair.
function canRecipientSeeDevUser(recipientSocket, user) {
  if (!user) return false;
  if (!user.isDev) return true;
  if (!user.isVanished) return true;
  const recipientUserId = getRecipientUserId(recipientSocket);
  if (recipientUserId && recipientUserId === user.id) return true;
  if (recipientSocket?.isDev) return true;
  return false;
}

// Formats one user for one recipient. Returns null if not visible.
// Hidden devs are stripped of all dev flair.
function formatUserForSocket(user, recipientSocket) {
  if (!user) return null;

  if (!canRecipientSeeDevUser(recipientSocket, user)) return null;

  const formatted = {
    id: user.id,
    username: user.username,
    location: user.location,
    deviceType: user.deviceType || "unknown",
  };
  // Bots are always labeled. A bot passing as a person is the one thing the
  // bot system must never allow, so the flag rides on every view of the user.
  if (user.isBotUser) {
    formatted.isBotUser = true;
    if (user.botOwnerName) formatted.botOwner = user.botOwnerName;
  }
  // Discord avatar: validated snowflake id + CDN hash only; clients rebuild
  // the cdn.discordapp.com URL themselves.
  if (user.avatar) formatted.avatar = user.avatar;
  // Hidden staff render as plain users to everyone EXCEPT a dev recipient: a
  // dev always needs to know who is staff, so a hidden (or vanished) dev/mod
  // keeps their role when seen by a dev, with isHidden/isVanished markers so the
  // dev can tell they are concealed from normal users.
  const recipientIsDev = !!recipientSocket?.isDev;
  if (user.isHidden && !recipientIsDev) {
    return formatted;
  }

  if (recipientSocket?.isDev || recipientSocket?.isMod) {
    const note = user.deviceId ? identity.getNote(user.deviceId) : null;
    if (note) formatted.note = note;
  }

  if (user.isDev) {
    formatted.isDev = true;
    // Keep the loud color off the concealed view - the crown + marker is enough
    // for a dev to identify them without making them look fully public.
    if (user.devColor && !user.isHidden) formatted.devColor = user.devColor;
    if (user.isVanished) formatted.isVanished = true;
    if (user.isHidden) formatted.isHidden = true;
  } else if (user.isMod) {
    // Mod badge is distinct from the dev crown; mods are never vanished.
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

// The "spectate joined" payload, filtered for this recipient. A non-staff
// spectator's socket has isDev/isMod false, so the filters strip vanished devs
// and staff flair for free.
function spectatePayload(socket, room) {
  const createdAt = room.createdAt || room.lastActiveTime || 0;
  return {
    roomId: room.id,
    roomName: room.name,
    roomType: room.type,
    layout: room.layout,
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

// Votes involving invisible (vanished) users are hidden from non-devs
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

function filterCurrentMessagesForSocket(room, recipientSocket) {
  const messages = {};
  const raw = !!recipientSocket?.isMainDev;
  const own = getRecipientUserId(recipientSocket);
  for (const user of room?.users || []) {
    if (!canRecipientSeeDevUser(recipientSocket, user)) continue;
    const text = state.userMessageBuffers.get(user.id) || "";
    // Same rule as the live update. Their own box comes back exactly as they
    // left it: rewriting what somebody is still typing helps nobody.
    messages[user.id] =
      raw || user.id === own ? text : ipredact.redact(text);
  }
  return messages;
}

// Lobby-list view of a room, tailored to one recipient
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

// Full in-room state, tailored to one recipient
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
    // The joining user gets "room joined" instead
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
    recipient.emit("user typing", { userId, username, isTyping });
  }
}

function emitRoomChatUpdate(socket, payload) {
  if (!socket.roomId || !io()) return;
  const room = state.rooms.get(socket.roomId);
  if (!room) return;
  const senderUser = room.users?.find((u) => u.id === payload.userId);
  // A textbox is how one user hands another user's address to a whole room, so
  // an address never leaves the server as it was typed. It stays readable on
  // the operations feed, because somebody has to be able to act on it. The
  // speaker is not a recipient in this loop, so nothing here rewrites the box
  // they are still typing in.
  const text = payload.diff?.text;
  const safe = ipredact.looksLikeIp(text)
    ? { ...payload, diff: { ...payload.diff, text: ipredact.redact(text) } }
    : payload;
  for (const [, recipient] of io().sockets.sockets) {
    if (
      !recipient.connected ||
      recipient.roomId !== socket.roomId ||
      recipient.id === socket.id
    )
      continue;
    if (!canRecipientSeeDevUser(recipient, senderUser)) continue;
    recipient.emit("chat update", recipient.isMainDev ? payload : safe);
  }
}

// ── Sub-app (Piano / Talkoboard) broadcast helpers, vanish-aware ────────────
// The piano and the board relay presence and activity straight to the room.
// Left raw, those streams reveal a vanished dev to ANY client reading the
// socket - including an unofficial one - even though room chat and typing
// already hide them. These helpers carry the same visibility rule into the live
// sub-apps: a vanished dev's events reach only other devs (and, when asked,
// themselves), so an invisible admin never surfaces through the piano or board.
// The common case (sender not vanished) keeps the fast native broadcast.
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
    if (recipient.isDev) recipient.emit(event, payload);
  }
}

// Room-scoped emit for a presence drop with no originating socket (close,
// disconnect, ghost cleanup). `hide` keeps a vanished dev's departure from
// reaching non-devs, mirroring emitSubAppEvent.
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

// Crown snapshot for one recipient. A vanished dev holding the crown reads as
// "no crown" to anyone who cannot see them, so the holder (and any lock they
// set) never leaks through the crown broadcast.
function pianoMetaFor(roomId, recipient) {
  const ps = pianoState.get(roomId);
  if (!ps) return { crown: null, crownName: null, onlyOwner: false };
  if (ps.crown) {
    const room = state.rooms.get(roomId);
    const holder = room && room.users.find((u) => u.id === ps.crown);
    if (holder && !canRecipientSeeDevUser(recipient, holder))
      return { crown: null, crownName: null, onlyOwner: false };
  }
  return pianoMeta(roomId);
}

// Per-recipient crown broadcast so the redaction above reaches every viewer.
function emitPianoCrown(roomId) {
  if (!io()) return;
  for (const [, recipient] of io().sockets.sockets) {
    if (!recipient.connected || recipient.roomId !== roomId) continue;
    recipient.emit("piano crown", pianoMetaFor(roomId, recipient));
  }
}

// ── Dev Mode: Room / Lobby Context ──────────────────────────────────────────

function getDevRoomContext(roomId) {
  if (!io()) return {};
  const ctx = {};
  const room = state.rooms.get(roomId);
  const roomUsers = new Map((room?.users || []).map((u) => [u.id, u]));
  for (const [, s] of io().sockets.sockets) {
    if (s.roomId !== roomId || !s.handshake?.session?.userId) continue;
    const userId = s.handshake.session.userId;
    const roomUser = roomUsers.get(userId);
    if (roomUser?.isHidden) continue;
    ctx[userId] = { d: s.clientIp || "unknown" };
  }
  return ctx;
}

// IP overlay is dev-only for safety: mods can still kick / ban / IP-block a
// user (the server resolves the IP for them) but never SEE raw IP addresses.
function sendDevRoomContext(roomId) {
  if (!io()) return;
  const ctx = getDevRoomContext(roomId);
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev && s.roomId === roomId) {
      s.emit("dev context", ctx);
    }
  }
}

// Devs idle in the lobby receive semi-private access codes
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
    s.emit("dev lobby context", data);
  }
}

// ── Room Save / Load ────────────────────────────────────────────────────────

async function saveRooms(force = false) {
  const now = Date.now();
  // The throttle keeps routine saves cheap; a forced save (clean shutdown)
  // bypasses it so the very latest room state survives the restart.
  if (!force && now - state.lastSaveTimestamp < state.SAVE_INTERVAL_MIN) return;
  try {
    const data = Array.from(state.rooms.entries()).map(([id, room]) => {
      return [
        id,
        {
          ...room,
          users: (room.users || []).map((u) => {
            const clean = { ...u };
            delete clean.isVanished; // ephemeral, never persisted
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
    } catch (_) { }
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
  if (socket.isDev || socket.isMod) return; // staff bypass AFK
  if (socket.boardOpen) return; // drawing on the board counts as active
  if (socket.pianoOpen) return; // playing the piano counts as active
  // Sitting in a mini game is not idling, even if they never type in the room
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

// Slow mode lengthens the broadcast cadence for a room: keystrokes are still
// captured, the room just sees full-replace updates less often.
function getBatchInterval(roomId) {
  const room = roomId ? state.rooms.get(roomId) : null;
  return room && room.slowMode
    ? CONFIG.TIMING.SLOW_MODE_BATCH_INTERVAL
    : CONFIG.TIMING.BATCH_PROCESSING_INTERVAL;
}

// Applies queued diffs to the user's message buffer in rate-limited batches,
// sanitizes the result, and broadcasts a full-replace to the room.
// ── "@name" mentions inside a room ──────────────────────────────────────────
// The textbox is live, so a name sitting in the text must nudge its owner
// once, when it appears, and not again on every keystroke after it. The edge
// is remembered per speaker, and a cooldown stops a delete-and-retype loop
// from being used to pester somebody.
const mentionEdge = new WeakMap(); // socket -> Set of userIds currently named
const mentionCooldown = new Map(); // "speaker|target" -> ts
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
    if (before.has(targetId)) continue; // already named a keystroke ago
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
    // The buffer stays exactly as typed, addresses and all. It is the copy the
    // client's own text is diffed against, and the diffs that arrive carry
    // indexes into THEIR string - shortening an address to a placeholder here
    // would slide every later index and garble the rest of what they write.
    // Redaction happens on the way out instead: emitRoomChatUpdate and
    // filterCurrentMessagesForSocket.
    state.userMessageBuffers.set(userId, msg);

    // Typing "@someone" in a room nudges that person. Their name may contain
    // spaces, so this matches against the actual roster rather than trying to
    // guess where a name ends.
    if (msg.includes("@")) notifyRoomMentions(socket, userId, msg);

    // Staff typing @mod/@dev in their textbox raises a Desk ping. The check
    // is edge-triggered inside staffchat, so a token sitting in the text does
    // not re-fire on every keystroke. Non-staff text never reaches it.
    if (socket.isDev || socket.isMod) {
      try {
        staffchat.onRoomText(socket, socket.roomId, msg);
      } catch (_) { }
    }

    if (socket.roomId) {
      state.roomLastChatActivity.set(socket.roomId, Date.now());
    }

    emitRoomChatUpdate(socket, {
      userId,
      username,
      diff: { type: "full-replace", text: msg },
    });

    // Bots seated in this room read the settled text for their triggers.
    // Guarded: nothing in the bot runtime may ever break a person's chat.
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
    pianoDropPresence(roomId, userId, true);

    const room = state.rooms.get(roomId);
    if (room) {
      // Ownership guard. leaveRoom is keyed only by userId, but during the
      // lobby->room handoff two sockets briefly share one userId. When the old
      // (lobby / superseded) socket disconnects it must NOT evict the membership
      // the newer room socket just added, or that room tab loses its own row and
      // textbox until a manual refresh. If a live successor socket already owns
      // this room for this userId, just detach this stale socket and keep the
      // membership intact.
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
        for (const vid in room.votes) {
          if (room.votes[vid] === userId) delete room.votes[vid];
        }
        emitRoomVoteUpdates(roomId);
      }

      socket.leave(roomId);
      emitRoomUserLeft(roomId, userId, leftUser);
      updateRoom(roomId);
      sendDevRoomContext(roomId);
      updateRoomSoloTracking(roomId);
      if (socket.isDev || socket.isMod) staffchat.presenceDirty();

      // Drops their queue slots and forfeits any live match. Runs after the
      // successor check above, so the lobby->room handoff does not trip it.
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

    // Maintenance mode and per-room locks block new joins for everyone but staff.
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
    // The one caller already refuses a guest or missing name, so this is a
    // backstop rather than a branch anybody reaches: it must never quietly
    // invent a name the way it used to.
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

    // Staff sit in as many rooms at once as they have tabs open: watching three
    // rooms is the job, and being bounced out of one to look at another was the
    // main reason moderators spectated instead of joining.
    if (!isStaff) {
      const curRoom = getUserCurrentRoom(userId);
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

    // Staff bypass room capacity (can always enter a full room to handle a
    // report); normal users check the visible count.
    //
    // Exclude the joining user's OWN entry from the count. The lobby->room
    // handoff briefly leaves a stale membership for this same userId in
    // room.users (the lobby socket full-joins before navigating to room.html);
    // the dedup filter just below removes it, but that runs AFTER this check.
    // Counting the phantom self would fill the last slot and bounce an
    // otherwise-valid join at exactly capacity-1 (e.g. 4/5 -> "room full").
    const joinableUserCount = (room.users || []).filter(
      (u) => u.id !== userId && !(u.isDev && u.isVanished),
    ).length;
    if (!isStaff && joinableUserCount >= roomCapacity(room))
      return socket.emit(
        "room full",
        createErrorResponse(ERROR_CODES.ROOM_FULL, "Room is full."),
      );

    // Rooms opened with "allow bots: no" take no automation at all.
    if (socket.isBot && room.allowBots === false)
      return socket.emit(
        "error",
        createErrorResponse(
          ERROR_CODES.FORBIDDEN,
          "This room does not allow bots.",
        ),
      );

    // API (tier 2) bots take a normal seat but are capped per room, same
    // budget the hosted bots share, so a room is never mostly machines.
    // The budget scales with the room: 1 bot per 5 seats, at most 5.
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
      isMod: !!socket.isMod,
      modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
      isHidden: !!socket.isHidden,
      isVanished: !!socket.isVanished,
      // A token-authenticated (tier 2) bot wears the bot badge like a hosted
      // one; there is no way for automation to sit in a room unlabeled.
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

    // One active room tab per browser: pause any OTHER tab of this session that
    // is also in a room. Lobby-only tabs and the Mod Log are left alone, so a
    // user can watch the lobby in one tab and chat in another.
    //
    // Staff are exempt, otherwise the multi-room allowance above is undone the
    // moment they open the second room: each new tab would kill the last.
    if (socket.handshake?.sessionID && !socket.isModLog && !isStaff) {
      const sid = socket.handshake.sessionID;
      for (const [, other] of io().sockets.sockets) {
        if (other.id === socket.id || other.isBot || other.isModLog) continue;
        if (other.handshake?.sessionID !== sid) continue;
        if (!other.roomId) continue; // lobby-only tab stays active
        try {
          other.emit("session superseded", {});
          other.disconnect(true);
        } catch (_) { }
      }
    }

    setupAFKTimers(socket, userId);
    updateRoomSoloTracking(roomId);
    if (isStaff) staffchat.presenceDirty();

    // Session save must complete before emitting join success, so the
    // room page can rejoin via the session without an access code in the URL
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
    debouncedSaveRooms().catch(() => { });
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
    isMod: !!socket.isMod,
    modLevel: socket.isMod ? socket.modLevel || 2 : undefined,
    isHidden: !!socket.isHidden,
    isVanished: !!socket.isVanished,
  };

  // The joining user always sees themselves in full
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
    uptime: Date.now() - createdAt
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

  // A "deploy to a new room" waits for its owner to arrive; this is the
  // arrival. No-op for everyone without a pending deploy.
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

// Set by the entry point: returns the id of the client code being served, so a
// page that reconnects after a deploy can tell it is running something old.
let getBuildId = null;

function registerSocketHandlers(opts) {
  if (opts && typeof opts.buildId === "function") getBuildId = opts.buildId;
  // The Desk reads room and roster state but never owns any of it, so it gets
  // read accessors and the badge formatter, nothing that mutates.
  staffchat.init({
    io,
    state,
    formatUserForSocket,
    findSocketsByUserId,
    roomCapacity,
    roles,
    audit,
    // The stores behind #bans and #announce. Passed as the same builders the
    // dashboard uses, so the two views cannot drift apart.
    banHistory: buildBanHistory,
    announcements,
  });
  // The game floor resolves players through the room roster, so a spectator or
  // a stale socket can never hold a seat.
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
      // Concealed staff read as ordinary players in games. A badge would out a
      // hidden mod or a vanished dev to the whole room, which is the one thing
      // hiding is for.
      const concealed = !!(u.isHidden || u.isVanished);
      let role = null;
      if (!concealed && u.isDev) role = "dev";
      else if (!concealed && u.isMod) role = (u.modLevel || 2) >= 2 ? "mod" : "jr";
      return {
        userId,
        username: u.username,
        role,
        avatar: u.avatar || null,
      };
    },
    // Sitting down at a game parks a status line in their room textbox so the
    // room can see where they went, and stops the AFK sweep evicting them
    // mid-match. Standing up puts their own text back.
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

  // The bot runtime drives room membership and textboxes through the same
  // broadcast helpers real sockets use, injected here so every client renders
  // a bot exactly like a person.
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

  io().on("connection", (socket) => {
    const clientIp = socket.clientIp || socket.handshake.address;

    // Give the per-IP connection slot back, registered before anything else and
    // kept separate from the main disconnect handler further down. The slot is
    // taken in the connect middleware, so if any setup below threw before the
    // handlers were attached, that slot would never come back and the IP would
    // creep up to the cap until it could not connect at all ("Too many
    // connections"). The process survives thrown errors, so this must not
    // depend on the rest of this function running.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased || !socket.clientIp) return;
      slotReleased = true;
      const c = state.ipConnections.get(socket.clientIp) || 0;
      if (c > 1) state.ipConnections.set(socket.clientIp, c - 1);
      else state.ipConnections.delete(socket.clientIp);
    };
    socket.on("disconnect", releaseSlot);
    // Somebody putting their laptop down does not clear a shared key: the
    // question is asked again from what is left behind.
    socket.on("disconnect", () => {
      if (!socket.keyWatchHash) return;
      const hash = socket.keyWatchHash;
      keywatch.leave(hash, socket.id);
      const role = socket.isDev ? "dev" : "mod";
      const label = socket.staffLabel || role;
      judgeStaffKey(hash, role, label);
    });

    // Which build of the client code this server is serving. A page that
    // reconnects after a deploy compares it with the one it loaded and reloads
    // itself if it is behind, which is the only way a room page picks up new
    // scripts and styles: it rejoins in place rather than reloading.
    if (getBuildId) socket.emit("server build", { id: getBuildId() });

    socket.deviceType = deviceTypeFromUA(socket.handshake.headers["user-agent"]);

    // Best-effort setup for a returning browser. Wrapped because it must never
    // abort this function: the handlers below (chat, room, disconnect) would
    // then never be attached and the socket would sit there half-alive.
    try {
    // Durable per-browser device id: record presence for "active vs new"
    // checks. Not a secret; never gates a privileged action. Bots and
    // the Mod Log board carry none, so this is a no-op for them.
    if (socket.deviceId) {
      identity.touch(
        socket.deviceId,
        clientIp,
        socket.handshake?.session?.username,
        socket.handshake?.session?.location,
      );
      socket._idAt = Date.now();
      socket.emit("identity status", identity.summary(socket.deviceId));
      // They got in, which means nothing on the blocklist matched them. Ask
      // the other question: does anything on it know them anyway?
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
      // Deliver any staff warnings queued while this device was offline. Slight
      // delay so the page (and its toast handler) is ready to show them.
      const queuedWarnings = warnings.takeFor(socket.deviceId);
      if (queuedWarnings.length)
        setTimeout(() => {
          for (const w of queuedWarnings)
            socket.emit("staff warning", { message: w.message });
        }, 1500);
    }

    // Deliver an approved-but-unclaimed mod application: mint the L1 key now
    // (so nothing plaintext was ever stored) and hand it to this browser.
    if (socket.deviceId && !socket.isDev && !socket.isMod) {
      const claim = applications.unclaimedApproved(socket.deviceId);
      if (claim) {
        // reviewedBy is stored as "dev:Label" / "mod:Label"; keep just the label
        // so the Moderators panel credits the reviewer who approved them.
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

    // Tell this browser the status of its latest mod application (if any), so
    // the lobby menu can offer "Check status" with the reviewer's note instead
    // of "Apply to be a mod". Staff never see this (their link is hidden).
    if (socket.deviceId && !socket.isDev && !socket.isMod) {
      const st = appStatusPayload(socket.deviceId, false);
      if (st.has) socket.emit("mod application status", st);
    }

    // ── One active ROOM tab per browser session ─────────────────────────
    // Identity is the session id (shared across a browser's tabs). Two tabs
    // both in rooms would cross names and typed messages, so only one room tab
    // is allowed at a time, enforced when a tab JOINS a room (see joinRoom).
    // A lobby-only tab and the read-only Mod Log are always allowed, so you can
    // watch the lobby in one tab and chat in another.
    socket.isModLog = socket.handshake?.auth?.app === "modlog";

    // ── Staff key leak watch ────────────────────────────────────────────
    // A dev/mod key is the only proof of role, so a shared or stolen key is
    // the real risk. Two people on one key is the thing worth acting on, and
    // keywatch works out whether that is what it is looking at.
    if ((socket.isDev || socket.isMod) && clientIp) {
      const hash = socket.isDev ? socket.devKeyHash : socket.modKeyHash;
      const role = socket.isDev ? "dev" : "mod";
      const label = socket.staffLabel || role;
      socket.keyWatchHash = hash;
      keywatch.join(hash, socket.id, {
        deviceId: socket.deviceId || null,
        userId: socket.handshake?.session?.userId || null,
        // The NETWORK, not the address: an IPv6 client rotating inside its own
        // /64 must read as the same place it has always been.
        network: ipban.computeRangeCidr(clientIp) || null,
      });
      // Nothing is decided on arrival. Overlap is normal for a few seconds
      // (reconnects, the room handoff, a page navigation), so the question is
      // asked again once it has had time to settle.
      setTimeout(
        () => judgeStaffKey(hash, role, label),
        keywatch.SETTLE_MS + 1000,
      ).unref?.();
      if (socket.keyNewIp) {
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

    // Wraps handlers so one error cannot crash the process; disconnects
    // sockets that error repeatedly
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
          } catch (_) { }
        }
      };
    }

    // ── Check Sign-In Status ────────────────────────────────────────────
    socket.on(
      "check signin status",
      safe(async () => {
        let { username, location, userId, isIPBased } =
          socket.handshake.session || {};
        // A session carrying a name from before guest names were dropped (or a
        // minted IP-based one) reads as signed out, so the lobby asks for a
        // real name instead of letting the old one through.
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
          // Also checked on a restored session, so a name added to the list
          // later still applies to someone already carrying it.
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
    // Open to everyone, signed in or not, and that includes the moderator
    // set: rules staff are held to are worth nothing if only staff can read
    // them. Devs write them from the dashboard.
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
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Could not save rules."),
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

        // Optional Discord avatar. Only the validated snowflake + hash are
        // kept; sending avatar:null (or omitting it) clears the stored one.
        // Staff can turn a device's picture off, in which case we ignore
        // whatever it sends so it cannot simply be re-attached on rejoin.
        const pfpBlocked =
          !!socket.deviceId && identity.isPfpBlocked(socket.deviceId);
        const avatar =
          !pfpBlocked && data.avatar && typeof data.avatar === "object"
            ? {
                id: String(data.avatar.discordId),
                hash: String(data.avatar.hash).toLowerCase(),
                animated: !!data.avatar.animated,
              }
            : null;

        // Identity fields are sanitized (zalgo/RTL stripped) before the
        // word filter runs, so obfuscated slurs are cleaned then caught
        let username = enforceUsernameLimit(sanitizeName(data.username));
        let location = enforceLocationLimit(
          sanitizeName(data.location || "On The Web"),
        );

        // Sanitization can empty a name made entirely of stripped
        // characters; reject instead of admitting a blank user
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

        // A textbox rewrites an address to a placeholder, but a name cannot be
        // rewritten and still work - the roster and every @mention read it - so
        // an address in a name is refused instead. Nobody is exempt: a name is
        // shown to everyone in the room, with no way to mask it per reader the
        // way chat is.
        if (ipredact.containsIp(username) || ipredact.containsIp(location))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Names and locations cannot contain an IP address.",
            ),
          );

        // Nobody chats as a guest. The lobby no longer hands out a name, so
        // this catches a stale one from an old session and anyone typing the
        // pattern in by hand. The client refuses it too, for a faster answer.
        if (isGuestName(username)) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Please choose a username - guest names are not allowed.",
            ),
          );
        }

        // Reserved staff names only validate for connections carrying a
        // dev or mod key, so trolls cannot impersonate staff.
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

        // If they are already in a room, update their live user record so the
        // avatar shows without a rejoin.
        for (const room of state.rooms.values()) {
          const u = (room.users || []).find((x) => x.id === userId);
          if (u && u.avatar !== avatar) {
            u.avatar = avatar;
            emitRoomSnapshot(room);
          }
        }

        // Accountability: log the chosen name + IP, and any later change to it
        audit.recordIdentity({
          userId,
          username,
          location,
          ip: socket.clientIp || null,
        });

        // One head towards today's count, per device, per day.
        try {
          staffchat.noteEvent("visitor", socket.deviceId || userId);
        } catch (_) { }

        // Keep this device's display name + location current so staff surfaces
        // show their real name, not an old guest one.
        if (socket.deviceId)
          identity.setName(socket.deviceId, username, location);
        // A reported user coming online flips to "online" on dashboards.
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

    socket.on(
      "board open",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return; // spectators are read-only
        // Kept off the board by staff: say so and stop, rather than opening a
        // board that refuses every line drawn on it.
        const barred = boardBarredUntil(
          socket.roomId,
          socket.handshake.session.userId,
        );
        if (barred) return socket.emit("board barred", { until: barred });
        socket.boardOpen = true;
        // Back inside the grace window: the area is theirs again.
        markBoardClaimBack(socket.roomId, socket.handshake.session.userId);
        clearAFKTimers(socket.handshake.session.userId);

        const bs = getBoardState(socket.roomId);
        const room = state.rooms.get(socket.roomId);
        const activeObj = {};
        for (const [uid, stroke] of bs.active) {
          // Hide a vanished dev's in-progress stroke from a non-dev newcomer.
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
    // Every stroke already carries its author server-side, so a moderator
    // looking at something they have to act on can find out who put it there
    // instead of guessing or clearing the whole board. The lookup is by stroke
    // id and answered from server state, so a client cannot fish for names, and
    // a vanished dev stays invisible exactly as they are everywhere else.
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
          // So the panel can offer to let somebody back in rather than only
          // ever offering to remove them again.
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
        // Somebody else's fence is somebody else's. Overlapping would make
        // "only you can draw here" untrue for both of you.
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
        // One each: claiming again moves your fence rather than adding one.
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
        // Your own always; anybody's if you are staff, because a fence left
        // round something that has to go would stop staff dealing with it.
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
    // Erasing what one person drew leaves everybody else's work where it is,
    // and taking their pen away stops it happening again without closing the
    // board for the room. Any staff level, the same as clearing the board: a
    // junior mod looking at something that has to go should not have to find a
    // full mod first.
    socket.on(
      "board wipe user",
      safe(async (data) => {
        if (!socket.roomId) return;
        if (!isStaffSocket(socket)) return;
        const userId = typeof data?.userId === "string" ? data.userId : null;
        if (!userId) return;

        const room = state.rooms.get(socket.roomId);
        const target = room?.users?.find((u) => u.id === userId) || null;
        // A vanished dev is invisible here exactly as they are everywhere else.
        if (target && !canRecipientSeeDevUser(socket, target)) return;

        const bs = getBoardState(socket.roomId);
        const before = bs.strokes.length;
        bs.strokes = bs.strokes.filter((s) => s.owner !== userId);
        const gone = before - bs.strokes.length;
        bs.active.delete(userId);
        saveBoardSoon();
        // Everybody in the room, not only the people with the board open: a
        // board opened a second later must not show what was just taken off it.
        io()
          .to(socket.roomId)
          .emit("board user wiped", { userId, n: gone });
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
        if (userId === socket.handshake.session?.userId) return; // not yourself

        const room = state.rooms.get(socket.roomId);
        const target = room?.users?.find((u) => u.id === userId) || null;
        if (target && !canRecipientSeeDevUser(socket, target)) return;
        // Staff do not take each other's pens away. A developer can, because
        // somebody has to be able to.
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
        // Their unfinished line goes with them, or it hangs on everyone's
        // screen until the room empties.
        if (bs.active.delete(userId))
          io().to(socket.roomId).emit("board stroke end", { userId });
        for (const s of findSocketsByUserId(userId)) {
          if (s.roomId !== socket.roomId) continue;
          s.boardOpen = false;
          s.emit("board barred", { until });
        }
        // A plain room emit, not emitSubAppEvent: this is about the person
        // being removed, and routing it through the sender's visibility would
        // hide it whenever a vanished dev is the one doing it.
        io().to(socket.roomId).emit("board user status", { userId, open: false });
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
        // The real enforcement: a client that ignores being removed from the
        // board still cannot put a line on it.
        const barred = boardBarredUntil(socket.roomId, userId);
        if (barred) return socket.emit("board barred", { until: barred });

        if (
          !data ||
          typeof data.color !== "string" ||
          typeof data.size !== "number"
        )
          return;
        if (
          !data.point ||
          typeof data.point.x !== "number" ||
          typeof data.point.y !== "number"
        )
          return;

        // Optional client-supplied id lets the drawer undo/redo this exact
        // stroke later. Ownership for undo is enforced server-side via `owner`,
        // never by trusting the id, so a forged id can't touch anyone else's work.
        const strokeId =
          typeof data.id === "string" && data.id.length <= 64 ? data.id : null;

        // Somebody else's patch of board: not yours to draw on, or rub out.
        // Staff excepted - see claimBlocking.
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
          size: Math.min(Math.max(data.size, 1), 50),
          eraser: !!data.eraser,
          gradient: data.eraser ? null : sanitizeGradient(data.gradient),
        };

        const bs = getBoardState(socket.roomId);
        finalizeBoardUserStroke(socket.roomId, userId);
        bs.active.set(userId, stroke);

        emitSubAppEvent(socket, "board stroke start", {
          userId,
          id: stroke.id,
          color: stroke.color,
          size: stroke.size,
          eraser: stroke.eraser,
          gradient: stroke.gradient,
          point: stroke.points[0],
        }, false);
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

        // A line that runs into somebody else's area ENDS there. Skipping the
        // points inside and joining what was left either side is what let a
        // fast scribble cross the box in one straight line.
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
          // Finish what they drew up to the fence and refuse the rest. Anything
          // further needs a fresh stroke, which has to start outside.
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

        emitSubAppEvent(socket, "board stroke move", {
          userId,
          points: validPoints,
        }, false);
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
        // Ownership enforced here - you can only remove a stroke you own.
        const idx = bs.strokes.findIndex(
          (s) => s.id === id && s.owner === userId,
        );
        if (idx !== -1) {
          bs.strokes.splice(idx, 1);
          saveBoardSoon();
        } else {
          // Could still be the user's active (unfinished) stroke
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
        // Redo is a way of drawing too.
        if (boardBarredUntil(socket.roomId, userId)) return;
        // Shapes and fills come through here, one click each. Staff are not
        // exempt: the point is the board, not who is at it.
        if (!allowBoardAdd(userId)) {
          const wait = Math.ceil(boardAddWaitMs(userId) / 1000);
          return socket.emit("board too fast", {
            // Which one was refused, so the drawer's own screen can drop it
            // rather than showing a shape nobody else has.
            id:
              typeof data?.stroke?.id === "string"
                ? data.stroke.id.slice(0, 64)
                : null,
            wait,
            message:
              "Too many shapes at once" +
              (wait ? " - wait " + wait + "s" : ""),
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

        // A shape or a fill is all or nothing: if any of it lands in somebody
        // else's area, none of it does. Staff excepted.
        //
        // Every EDGE is checked, not every corner: a rectangle drawn around
        // somebody's area has all four corners outside it. And a filled shape
        // is checked for swallowing the area whole, which would paint over it
        // without any edge going near it.
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
          size: Math.min(Math.max(Number(s.size) || 3, 1), 50),
          eraser: !!s.eraser,
          gradient: s.eraser ? null : sanitizeGradient(s.gradient),
          // Shapes and bucket fills arrive whole through this event rather than
          // point by point, so this is the only place the extra fields a shape
          // needs have to be accepted.
          fill: !!s.fill,
          rings: s.fill
            ? sanitizeRings(s.rings, MAX_POINTS_PER_STROKE - points.length)
            : null,
          sharp: !!s.sharp,
        };

        const bs = getBoardState(socket.roomId);
        if (bs.strokes.some((x) => x.id === stroke.id)) return; // dedupe
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
        const text = data.text.slice(0, 200);
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
        // Any staff can wipe the board: it is one room's drawing and the only
        // way to remove something drawn that should not be on screen.
        if (!socket.isDev && !socket.isMod) return;
        const bs = boardState.get(socket.roomId);
        if (bs) {
          bs.strokes = [];
          bs.active.clear();
        }
        saveBoardSoon(); // persist the cleared board so a restart can't restore it
        io().to(socket.roomId).emit("board clear");
        const room = state.rooms.get(socket.roomId);
        logStaff(socket, "clear board", null, room);
      }),
    );

    // ── Multiplayer Piano: presence, notes, cursor, chat, crown, mute ───
    // Every handler proves identity from the session (never the payload),
    // scopes to socket.roomId, and re-validates ownership/lock/mute server-side.

    socket.on(
      "piano open",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return; // spectators are read-only
        const userId = socket.handshake.session.userId;
        socket.pianoOpen = true;
        clearAFKTimers(userId);

        const ps = getPianoState(socket.roomId);
        ps.open.add(userId);

        // Tell the newcomer who is already at the piano + the crown/mute state.
        const room = state.rooms.get(socket.roomId);
        const participants = [];
        for (const uid of ps.open) {
          if (uid === userId) continue;
          const u = room && room.users.find((x) => x.id === uid);
          // Hide a vanished dev at the piano from a non-dev newcomer.
          if (u && !canRecipientSeeDevUser(socket, u)) continue;
          participants.push({ userId: uid, username: u ? u.username : "User" });
        }
        socket.emit("piano participants", { participants });
        socket.emit("piano crown", pianoMetaFor(socket.roomId, socket));
        socket.emit("piano muted", { muted: Array.from(ps.muted) });

        // Announce the newcomer to everyone else (hidden from non-devs when the
        // newcomer is a vanished dev).
        emitSubAppEvent(
          socket,
          "piano user status",
          {
            userId,
            username: socket.handshake.session.username || "Anonymous",
            open: true,
          },
          false,
        );
      }),
    );

    socket.on(
      "piano close",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        socket.pianoOpen = false;
        setupAFKTimers(socket, userId);
        // Keep mute across a close so it can't be self-cleared.
        pianoDropPresence(socket.roomId, userId, false);
      }),
    );

    socket.on(
      "piano notes",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const userId = socket.handshake.session.userId;
        if (!data || !Array.isArray(data.notes) || data.notes.length === 0)
          return;

        const ps = getPianoState(socket.roomId);
        // Must have announced presence (be "at the piano") to broadcast. Stops a
        // modified client from streaming notes while staying off the participant
        // list - which would also dodge the per-user mute, since both the mute
        // UI and presence key off ps.open.
        if (!ps.open.has(userId)) return;
        if (ps.muted.has(userId)) return; // staff-muted: silenced server-side

        // "Only owner can play": only the crown holder or staff may sound notes.
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.onlyOwner && ps.crown !== userId && !isStaff) return;

        // Inline per-second flood guard (no async work per note; mirrors how the
        // board clamps points). A new 1s window resets the counters.
        const now = Date.now();
        if (!socket._pianoWin || now - socket._pianoWin.t >= 1000) {
          socket._pianoWin = { t: now, notes: 0, msgs: 0 };
        }
        const win = socket._pianoWin;
        if (++win.msgs > PIANO_MAX_MSGS_PER_SEC) return;

        const clean = [];
        let onCount = 0;
        const list = data.notes;
        const limit = Math.min(list.length, 256); // hard bound on work per message
        for (let i = 0; i < limit; i++) {
          const ev = list[i];
          if (!ev || typeof ev.n !== "number") continue;
          const n = ev.n | 0;
          if (n < PIANO_MIN_KEY || n > PIANO_MAX_KEY) continue;
          let d = typeof ev.d === "number" ? ev.d : 0;
          if (!(d >= 0)) d = 0;
          if (d > 250) d = 250;
          d = d | 0;

          if (ev.s === 1) {
            // Note-offs ALWAYS relay - throttling them would leave keys/voices
            // stuck on everyone else's screen.
            clean.push({ n, s: 1, d });
            continue;
          }
          // Throttle only note-ONs (per second + per message) so a bot or
          // black-MIDI flood can't lag the room.
          if (++win.notes > PIANO_MAX_NOTES_PER_SEC) continue;
          if (++onCount > PIANO_MAX_NOTES_PER_MSG) continue;
          let v = typeof ev.v === "number" ? ev.v : 0.6;
          if (!(v > 0)) v = 0.6;
          if (v > 1) v = 1;
          clean.push({ n, v: Math.round(v * 1000) / 1000, d });
        }
        if (clean.length === 0) return;

        emitSubAppEvent(socket, "piano notes", { userId, notes: clean }, false);
      }),
    );

    socket.on(
      "piano cursor",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (typeof data?.x !== "number" || typeof data?.y !== "number") return;
        // Only players actually at the piano broadcast a cursor (mirrors notes).
        if (!getPianoState(socket.roomId).open.has(socket.handshake.session.userId))
          return;
        // x,y are fractions (0..1) of the keyboard area, resolution-independent.
        const x = Math.max(0, Math.min(1, data.x));
        const y = Math.max(0, Math.min(1, data.y));
        emitSubAppEvent(
          socket,
          "piano cursor",
          {
            userId: socket.handshake.session.userId,
            username: socket.handshake.session.username || "Anonymous",
            x,
            y,
          },
          false,
        );
      }),
    );

    socket.on(
      "piano chat",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        if (!data?.text || typeof data.text !== "string") return;
        // Only players actually at the piano may post to its chat.
        if (!getPianoState(socket.roomId).open.has(socket.handshake.session.userId))
          return;
        const text = sanitizeMessage(data.text).slice(0, 200);
        if (!text.trim()) return;
        // Relay raw; each client applies its own word filter on display, matching
        // the room's per-viewer automod toggle.
        emitSubAppEvent(
          socket,
          "piano chat",
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

    // Claim the crown. Restricted to staff (devs + mods): the crown gates the
    // "only owner can play" lock, so only higher-level users may hold it.
    socket.on(
      "piano crown claim",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        if (socket.spectating) return;
        const isStaff = !!(socket.isDev || socket.isMod);
        if (!isStaff) {
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "Only staff can hold the crown.",
            ),
          );
        }
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        ps.crown = userId;
        emitPianoCrown(socket.roomId);
      }),
    );

    // Drop the crown (holder or staff). Clears any "only owner" lock with it.
    socket.on(
      "piano crown drop",
      safe(async () => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.crown !== userId && !isStaff) return;
        ps.crown = null;
        ps.onlyOwner = false;
        emitPianoCrown(socket.roomId);
      }),
    );

    // Toggle "only owner can play" (crown holder or staff only).
    socket.on(
      "piano set lock",
      safe(async (data) => {
        if (!socket.roomId || !socket.handshake.session?.userId) return;
        const userId = socket.handshake.session.userId;
        const ps = getPianoState(socket.roomId);
        const isStaff = !!(socket.isDev || socket.isMod);
        if (ps.crown !== userId && !isStaff) return;
        ps.onlyOwner = !!(data && data.onlyOwner);
        emitPianoCrown(socket.roomId);
      }),
    );

    // Staff-only: silence a user's notes. Mirrors "staff kick" hierarchy.
    socket.on(
      "piano mute user",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId = data?.targetUserId;
        if (!targetUserId || typeof targetUserId !== "string")
          return socket.emit(
            "error",
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "targetUserId required."),
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
        const ps = getPianoState(roomId);
        const mute = data.mute !== false;
        if (mute) ps.muted.add(targetUserId);
        else ps.muted.delete(targetUserId);
        io().to(roomId).emit("piano muted", { muted: Array.from(ps.muted) });
        const targetUser = room.users.find((u) => u.id === targetUserId);
        logStaff(socket, mute ? "piano mute" : "piano unmute", targetUser, room);
        socket.emit("staff action result", {
          action: "piano mute",
          ok: true,
          targetUserId,
          mute,
          roomId,
        });
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

        // Maintenance mode and the live room-creation flag block new rooms for
        // everyone but staff.
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

        // No layout here: the lobby stopped asking, because the room itself has
        // a button that flips it per person. Every new room starts vertical.
        const valErr = validateObject(data, {
          name: { rule: "roomName" },
          type: { rule: "roomType" },
          accessCode: { rule: "accessCode", context: data.type },
        });
        if (valErr) return socket.emit("validation_error", valErr);

        // How many people fit, from the lobby slider, capped by the creator's
        // level rather than by a single number for everybody.
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

        if (state.rooms.size >= CONFIG.LIMITS.HARD_MAX_ROOMS) {
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

        // Staff can already sit in several rooms at once (see joinRoom), so the
        // one-room limit does not apply to opening another one either.
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

        // Room names get the same zalgo/RTL sanitization as usernames
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
        // A room name sits in the lobby for everyone, staff or not. Same rule
        // as a username: refused, because there is nobody to hide it from
        // selectively.
        if (ipredact.containsIp(roomName))
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.VALIDATION_ERROR,
              "Room name cannot contain an IP address.",
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
          // Rooms allow bots unless the creator said no in the lobby form.
          allowBots: data.allowBots !== false,
          users: [],
          accessCode: data.type === "semi-private" ? data.accessCode : null,
          votes: {},
          bannedUserIds: new Set(),
          lastActiveTime: now,
          createdAt: now,
        });

        // Creator's access code is validated into the session up front,
        // so the room page can join without the code in the URL
        if (data.type === "semi-private" && data.accessCode) {
          if (!socket.handshake.session.validatedRooms)
            socket.handshake.session.validatedRooms = {};
          socket.handshake.session.validatedRooms[roomId] = data.accessCode;
          await promisifySessionSave(socket.handshake.session).catch(() => { });
        }

        state.apiCache.delete("public_rooms");
        try {
          staffchat.noteEvent("room");
        } catch (_) { }
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
        // A room used to invent "Anonymous" for anyone arriving without a
        // session name - a direct link, an embed, a lost session. That was the
        // last way into a room without picking a name, so it is refused and
        // the room page sends them to the lobby instead.
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

        // Early copy of the one-room-at-a-time rule, so a normal user is turned
        // away before any of the join work happens. Staff are exempt here for
        // the same reason as in joinRoom: watching several rooms is the job.
        if (!socket.isDev && !socket.isMod) {
          const cur = getUserCurrentRoom(userId);
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

        // Semi-private rooms: session-validated codes skip the prompt. Only devs
        // bypass the code (they can see codes anyway); mods enter it like a normal
        // user, or moderate read-only via spectate, which needs no code.
        const bypassAccessCode = socket.isDev;
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
              () => { },
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
        // Votes are only accepted at or above the minimum room size
        if (room.users.length < CONFIG.LIMITS.MIN_USERS_FOR_VOTING) return;
        if (!room.users.find((u) => u.id === data.targetUserId)) return;
        // Staff wearing their badge cannot be vote-kicked. Turning the flair off
        // gives that up: while they are passing as a normal user they take a
        // normal user's dislikes, which is the whole point of hiding. They can
        // walk back into the room afterwards (staff ignore the room ban list),
        // so the worst case is being told to put the badge back on.
        if (
          getUserStaffRole(data.targetUserId) &&
          !isUserStaffHidden(data.targetUserId)
        )
          return;
        if (!room.votes) room.votes = {};
        if (room.votes[userId] === data.targetUserId) delete room.votes[userId];
        else room.votes[userId] = data.targetUserId;
        emitRoomVoteUpdates(roomId);
        const votesAgainst = Object.values(room.votes).filter(
          (v) => v === data.targetUserId,
        ).length;
        if (votesAgainst > Math.floor(room.users.length / 2)) {
          const target = findSocketByUserId(data.targetUserId, roomId);
          if (target) {
            target.emit("kicked");
            if (!room.bannedUserIds) room.bannedUserIds = new Set();
            room.bannedUserIds.add(data.targetUserId);
            await leaveRoom(target, data.targetUserId);
          } else if (bots.isActiveBot(data.targetUserId)) {
            // A hosted bot has no socket to kick; the room voted it out all
            // the same. The room ban stops this exact bot being redeployed
            // here, and noteEvicted shuts its runtime down.
            if (!room.bannedUserIds) room.bannedUserIds = new Set();
            room.bannedUserIds.add(data.targetUserId);
            const botUser = room.users.find((u) => u.id === data.targetUserId);
            room.users = room.users.filter((u) => u.id !== data.targetUserId);
            emitRoomUserLeft(roomId, data.targetUserId, botUser);
            bots.noteEvicted(data.targetUserId);
            updateRoom(roomId);
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
        // Spectators are read-only; frozen users are input-locked by staff.
        if (socket.spectating) return;
        if (socket.frozen) return;
        const userId = socket.handshake.session.userId;
        // Throttled participation signal for the activity record (Phase 2).
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
        await typingLimiter.consume(userId).catch(() => { });
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
          for (const [roomId, room] of state.rooms) {
            if (room.type === "semi-private" && room.accessCode) {
              codes[roomId] = room.accessCode;
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
          await promisifySessionSave(socket.handshake.session).catch(() => { });
        }

        const userId = socket.handshake.session?.userId;
        if (userId) {
          // Staff can hold several rooms open at once, so every socket and every
          // room they are sitting in has to agree about the flair. Missing one
          // leaves a tab still wearing the badge - and, because hidden staff are
          // votable, leaves it unclear which way round they are.
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
    // STAFF ACTIONS (mod + dev). Every handler validates role by the key
    // hash set in the socket middleware and enforces the hierarchy.
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
        // Junior (level 1) mods can remove a user but never place a room ban.
        const canBan =
          socket.isDev || (socket.isMod && (socket.modLevel || 2) >= 2);
        const ban = canBan && data.ban !== false; // room ban: L2/dev only
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
          // If that memberless entry was a hosted bot, stop its runtime too.
          bots.noteEvicted(targetUserId);
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
          // Offline: fall back to the IP captured on the report board. We cannot
          // read the target's role from a live socket, so enforce the staff
          // hierarchy with the role recorded when they were last seen.
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

        // An IPv6 ban always covers the client's own /64, because banning one
        // address out of a range it rotates through freely bans nothing. The
        // checkbox is what widens an IPv4 ban to its /24, which stays a
        // decision somebody makes. Either way the block is stored under the
        // CIDR key, which covers the exact address too.
        const cidr =
          ipban.autoRangeCidr(ip) ||
          (data?.banRange ? ipban.computeRangeCidr(ip) : null);
        const blockKey = cidr || ip;

        state.blockedIPs.set(blockKey, {
          expiry,
          label: blockedName,
          by: socket.staffLabel || null,
          // Kept so the ban screen can say which half of the team it came
          // from without naming anybody.
          byRole: socket.isDev ? "dev" : "mod",
          ts: Date.now(),
          reason,
          did: blockedDid,
        });
        blocklist.saveSoon(); // persist so the ban survives a restart
        evasion.invalidate();
        // Record the ban so the history feed and repeat-offender count stay
        // accurate even after the block expires or is lifted.
        banhistory.record({
          ip: blockKey,
          name: blockedName,
          action: "ban",
          by: socket.staffLabel || null,
          reason,
          duration,
        });
        broadcastBlockList();
        broadcastBanHistory();

        // Disconnect every live socket the ban now covers - the exact address,
        // or the whole range when a CIDR was placed.
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
          } catch (_) { }
        }
        logStaff(
          socket,
          `ip block ${duration}${cidr ? " (range)" : ""}`,
          // blockedName covers the offline case, where there is no live
          // targetUser to read a username from. Acting clears their report, so
          // this audit line is the only lasting record of who was blocked.
          targetUser || { id: targetUserId, name: blockedName },
          room || "-",
          reason || undefined,
        );
        socket.emit("staff action result", {
          action: "ip block",
          ok: true,
          targetUserId,
          duration,
          // Tell the mod what actually happened without leaking the address: a
          // range ban only lands for IPv6, so this confirms it for them.
          rangeApplied: !!cidr,
        });
        clearReportAfterAction(socket, targetUserId);
      }),
    );

    // Ban an IP directly by typing it in - no target user required. Full mods +
    // devs; permanent is dev-only. Takes effect immediately.
    socket.on(
      "staff ban ip",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        if (!requireModLevel(socket, 2)) return;
        const raw = typeof data?.ip === "string" ? data.ip.trim() : "";
        // The field accepts an address or a client id (the uuid shown on the
        // reports / appeals cards); ids resolve to an "id:" blocklist key.
        const isIp = ipban.isValidIp(raw);
        const isId =
          !isIp && /^[a-f0-9-]{8,64}$/i.test(raw) && raw.includes("-");
        if (!isIp && !isId)
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.BAD_REQUEST,
              "Enter a valid IPv4 / IPv6 address or a client id.",
            ),
          );
        const ip = isIp ? ipban.normalizeIp(raw) : ipban.idKey(raw);
        const duration = data?.duration;
        const DURATIONS = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
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
        const expiry =
          ms === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + ms;
        const reason =
          sanitizeMessage(
            typeof data?.reason === "string" ? data.reason : "",
          ).slice(0, 500) || null;
        const cidr = isIp
          ? ipban.autoRangeCidr(ip) ||
            (data?.banRange ? ipban.computeRangeCidr(ip) : null)
          : null;
        const blockKey = cidr || ip;
        // For an id entry, name it from the identity record so the list and
        // history show who it hits instead of a bare token.
        const idRec = isId ? identity.getRecord(raw.toLowerCase()) : null;
        const blockedName = (idRec && idRec.name) || null;
        state.blockedIPs.set(blockKey, {
          expiry,
          label: blockedName,
          by: socket.staffLabel || null,
          byRole: socket.isDev ? "dev" : "mod",
          ts: Date.now(),
          reason,
        });
        blocklist.saveSoon();
        evasion.invalidate();
        banhistory.record({
          ip: blockKey,
          name: blockedName,
          action: "ban",
          by: socket.staffLabel || null,
          reason,
          duration,
        });
        broadcastBlockList();
        broadcastBanHistory();
        const affected = isId
          ? [...io().sockets.sockets.values()].filter(
            (s) => s.deviceId === raw.toLowerCase(),
          )
          : cidr
            ? [...io().sockets.sockets.values()].filter((s) =>
              ipban.ipInCidr(s.clientIp, cidr),
            )
            : findSocketsByIp(ip);
        for (const s of affected) {
          try {
            const uid = s.handshake?.session?.userId;
            s.emit("kicked", {
              message: "Your connection has been blocked by staff.",
            });
            if (s.roomId && uid) await leaveRoom(s, uid);
            s.disconnect(true);
          } catch (_) { }
        }
        logStaff(
          socket,
          `ban ip ${duration}${cidr ? " (range)" : ""}`,
          blockedName || blockKey,
          "-",
          reason || undefined,
        );
        socket.emit("staff action result", {
          action: "ban ip",
          ok: true,
          duration,
          rangeApplied: !!cidr,
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

    // ── Wipe user buffer: clear typed content for everyone (any staff) ──
    // Junior mods need this: it is the fastest way to pull a slur off screen,
    // and it only clears text the author can retype.
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
        const targetDeviceId = targetSocket?.deviceId || targetUser?.deviceId || null;
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
            () => { },
          );
        }
        const existing = state.users.get(targetUserId) || { id: targetUserId };
        state.users.set(targetUserId, {
          ...existing,
          username: "Anonymous",
          location: targetUser.location,
        });
        // Tell the room to relabel that row (room update doesn't relabel)
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
    // The location line is as visible as the name, so juniors need to be able
    // to clear an offensive one without calling in a full mod.
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
            () => { },
          );
        }
        const existing = state.users.get(targetUserId) || { id: targetUserId };
        state.users.set(targetUserId, {
          ...existing,
          username: targetUser.username,
          location: "On The Web",
        });
        // Same relabel path the forced rename uses, so the row updates live.
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
    // The block is stored against the device, so clearing cookies does not
    // bring the picture back.
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
              () => { },
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
    // Same sanitize / duplicate / word-filter rules as creating one, so a mod
    // cannot set a name a user would have been refused.
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
    // Reversible with one click and scoped to a single room, so juniors get it.
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
    // Staff (dev or mod) can watch a room live without taking a slot or
    // appearing. Role is carried in the payload so the client can build the
    // matching staff panel (devs keep full powers, incl. room size). IP
    // context is still dev-only - sendDevRoomContext only targets dev sockets.
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
        if (!socket.isDev && room.type !== "public")
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

    // Public read-only spectate: anyone can watch a PUBLIC room. Semi-private
    // and private rooms need the access code, so they cannot be spectated
    // (devs excepted). Spectators never enter room.users, so this works even
    // on a full room.
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
        if (!socket.isDev && room.type !== "public")
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

    // ── Spotlight: pin a room to the top with an "Official" badge (dev) ─
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
        const on =
          typeof data?.on === "boolean" ? data.on : !room.spotlight;
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
        // Shrinking below current occupancy would leave the room over capacity
        // with no one removed, so evict the newest non-staff users past the new
        // cap. Staff are never evicted.
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
              s.emit("kicked", { message: "The room size was reduced by staff." });
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
        // Capacity affects every room's isFull/display - refresh all views.
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

    // Ban list: full mods + devs. Mods see every field except the raw IP, and
    // can lift a ban via its opaque ref (see "dev unblock ip").
    socket.on(
      "dev list blocks",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("dev blocks", buildBlockList(!!socket.isMainDev));
      }),
    );

    // Ban / unban history feed: who banned or unbanned whom, and how many times
    // each user has been banned. Full mods + devs; IP is dev-only.
    socket.on(
      "staff get ban history",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff ban history", buildBanHistory(!!socket.isMainDev));
      }),
    );

    // Active staff key sessions (who is connected right now, on which key, from
    // which IPs) plus the full per-key IP history, for the dashboard's Sessions
    // tab and to spot a leaked key. Dev only.
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
        // Staff may look at this board, but never at raw addresses: these are
        // other staff members' home IPs, and nobody sees any other IP anywhere
        // else in the dashboard. They still get the shape of the problem (how
        // many addresses a key is live on), which is the point of the board,
        // without the addresses themselves.
        const showIp = !!socket.isMainDev;
        const sessions = [...byKey.values()].map((g) => ({
          hash: showIp ? g.hash : g.hash.slice(0, 8),
          label: g.label,
          role: g.role,
          ips: showIp ? [...g.ips] : [],
          ipCount: g.ips.size,
          sessionCount: g.count,
          multiIp: g.ips.size > 1,
        }));
        const history = roles.getKeyActivity().map((h) => ({
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

    // Unban: full mods + devs. The dashboard sends the ban's opaque `ref`,
    // which resolves back to the address here; a raw IP is still accepted for
    // anything typed in by hand.
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
        // Capture who was blocked before we drop the entry, so the history feed
        // can name them.
        const prev = state.blockedIPs.get(ip);
        const blockedName = (prev && typeof prev === "object" && prev.label) || null;
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
          });
        broadcastBlockList();
        broadcastBanHistory();
        // Any open appeal against this block is now moot; close it so the
        // appeals inbox does not keep a stale entry for a lifted ban. An "id:"
        // entry closes by the identifier it carried instead of the address.
        const reviewer = `${socket.isDev ? "dev" : "mod"}:${socket.staffLabel || ""}`;
        const resolved = ipban.isIdKey(ip)
          ? appeals.resolveOpenForDevice(ip.slice(3), "lifted", reviewer)
          : appeals.resolveOpenForIp(ip, "lifted", reviewer);
        if (resolved) broadcastAppealsList();
        // Audit target is the user's name; the address itself rides on the
        // entry's own `ip` field, where the feed's redaction can reach it.
        logStaff(socket, "unblock ip", blockedName || ip, "-");
        socket.emit("staff action result", {
          action: "unblock ip",
          ok: true,
          ref: data?.ref || null,
          removed,
        });
        // Refresh this dashboard's live block list immediately.
        socket.emit("dev blocks", buildBlockList(!!socket.isMainDev));
      }),
    );

    // ── Adjust an existing IP block: shorten / extend its duration (dev) ──
    // Re-times a live block from now, preserving who placed it, the name, and
    // the message. Lets a dev reduce an over-long ban without lifting it first.
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
        // Legacy entries may be a bare expiry number; normalize to an object.
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
        socket.emit("dev blocks", buildBlockList(!!socket.isMainDev));
      }),
    );

    // ── Edit the message a blocked user sees on the ban screen (dev) ──────
    // The reason is surfaced to the blocked connection (server.js middleware),
    // so this doubles as a way to leave them a note or appeal instructions.
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
        socket.emit("dev blocks", buildBlockList(!!socket.isMainDev));
      }),
    );

    // ── Role management: grant / revoke / list mod keys (dev) ───────────
    socket.on(
      "dev grant mod",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        const label = typeof data?.label === "string" ? data.label : "mod";
        // Devs grant a full (level 2) key by default; level 1 on request.
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
        // Plaintext key is shown to the dev once and never stored
        socket.emit("dev mod granted", {
          key: granted.key,
          hash: granted.hash,
          label: granted.label,
          level: granted.level,
        });
        socket.emit("dev mod keys", roles.listModKeys());
        // Somebody handed their key back stops being listed as former staff the
        // moment it happens, rather than on the next refresh.
        socket.emit("dev former mods", roles.listFormerMods());
        // A new name has to show up in everyone's team list and "@" list now,
        // not whenever they next open the Desk.
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
        // Why somebody stopped being a moderator is part of the record, so the
        // panel asks for it and the server insists on it.
        const reason = String(data?.reason || "").trim().slice(0, 300);
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
          // Live-downgrade any connected socket using this key
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
        socket.emit("dev mod keys", roles.listModKeys());
        socket.emit("dev former mods", roles.listFormerMods());
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
        // Mods see the roster, not the key material. Only a dev acts on keys,
        // so only a dev needs the hash that identifies one.
        const keys = roles.listModKeys();
        socket.emit(
          "dev mod keys",
          socket.isDev
            ? keys
            : keys.map((k) => ({ ...k, hash: String(k.hash || "").slice(0, 8) })),
        );
        // Who used to be staff rides along with the roster - the panel shows
        // them apart from it, marked as no longer moderators.
        const former = roles.listFormerMods();
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
    // Only developers can change a moderator's level. L2 mods can mint L1
    // keys but never raise anyone to L2.
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
        // Live-update any connected socket on this key so their powers and
        // badge change without a reload.
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
        socket.emit("dev mod keys", roles.listModKeys());
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
    // The in-room staff menu knows a user, not their key hash, so this
    // resolves the user's live mod key(s) and re-levels them in place.
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
        socket.emit("dev mod keys", roles.listModKeys());
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
        // A whole week of Pacific days. The dashboard picks one at a time, but
        // it holds all seven so switching between them is instant and a mod can
        // look back over a week without a round trip.
        const days = audit.pacificDayStarts(7);
        const weekStart = days[0];
        socket.emit("audit snapshot", {
          entries: audit.recent(limit, {
            showIp: !!socket.isMainDev,
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
            devs: roles.listDevKeys().map((d) => d.label),
            mods: roles.listModKeys().map((m) => m.label),
          },
        });
      }),
    );

    // Everything one staff member has ever done. Any staff level may look at
    // any other, so the team can hold each other to account. The addresses on
    // each entry come off, same as the main feed.
    socket.on(
      "staff get mod history",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const label = typeof data?.label === "string" ? data.label : "";
        const role = data?.role === "dev" ? "dev" : "mod";
        const h = audit.historyFor(label, role, {
          offset: data?.offset,
          limit: data?.limit,
          group: typeof data?.group === "string" ? data.group : null,
          targetUid: typeof data?.targetUid === "string" ? data.targetUid : null,
        });
        socket.emit("staff mod history", {
          ...h,
          canReview: !!socket.isDev,
          // Same redaction as the main feed rather than a second copy of the
          // rule: deleting `ip` here was not enough, because an IP ban records
          // the address it blocked as the entry's target.
          entries: socket.isMainDev
            ? h.entries
            : h.entries.map(audit.redactEntry),
        });
      }),
    );

    // A developer who has read the log and is satisfied puts a flag to sleep.
    // Dev-only: a moderator clearing the flags on their own record would make
    // the whole panel pointless.
    socket.on(
      "staff review flag",
      safe(async (data) => {
        if (!requireDev(socket)) return;
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
        // Hand the record straight back so the panel updates in place.
        const h = audit.historyFor(label, role, {
          offset: data?.offset,
          limit: data?.limit,
          group: typeof data?.group === "string" ? data.group : null,
          targetUid: typeof data?.targetUid === "string" ? data.targetUid : null,
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

    // Take rows off the activity board for good. Dev-only, and deliberately
    // not logged: a cleared row that leaves a "cleared a row" entry behind has
    // not been cleared. The Desk reads the same rows, so it drops them on the
    // same beat rather than showing a board the dashboard no longer has.
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

    // ── Reports board (full mods + devs): who has been reported, with actions ─
    socket.on(
      "staff get reports",
      safe(async () => {
        if (!requireStaff(socket)) return;
        socket.emit("staff reports", buildReportsList(!!socket.isMainDev));
      }),
    );

    // ── Dismiss a report (full mods + devs): clear a false / handled report ─
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
        socket.emit("staff reports", buildReportsList(!!socket.isMainDev));
      }),
    );

    // ── Delete a report (dev): the row goes, and so does the Desk card ──────
    // Dismissing settles a report and says who settled it. This is the other
    // thing: the report should never have been on the board, so nothing about
    // it is kept - no audit line, no stamped card, no trace on either surface.
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
        socket.emit("staff reports", buildReportsList(!!socket.isMainDev));
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
        socket.emit("staff appeals", buildAppealsList(!!socket.isMainDev));
      }),
    );

    // Follow one appeal's conversation. The Desk opens a chat this way; the
    // dashboard uses it so an open card updates as the user types back.
    socket.on(
      "staff appeal open",
      safe(async (data) => {
        if (!requireModLevel(socket, 2)) return;
        const id = Number(data?.id) || null;
        socket.deskAppealId = id;
        if (!id) return;
        const row = buildAppealsList(!!socket.isMainDev).find((x) => x.id === id);
        if (row) socket.emit("staff appeal", row);
      }),
    );

    // Answer the person appealing. This is the whole point of the change: a
    // ban is much easier to judge once you have asked what happened.
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
            avatar:
              av && (av.id || av.discordId) && av.hash
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
            createErrorResponse(ERROR_CODES.BAD_REQUEST, "Write something first."),
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

    // Put a decided appeal back on the table. One moderator's call is not the
    // last word - a second opinion is the whole point of having a team - so
    // any full mod can reopen one, including a decision they made themselves.
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
        // The queue card said "dismissed by someone". It has to stop saying
        // that, or the next person to look will think it is handled.
        try {
          staffchat.stampQueue(
            (m) => m.qkind === "appeal" && m.card && m.card.itemId === id,
            { by: label, action: "reopened" },
            true,
          );
        } catch (_) {}
        broadcastAppealsList();
        broadcastAppeal(id);
      }),
    );

    // End the chat without deciding. For the case the whole feature invites:
    // somebody who answers every question with another twenty messages.
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

    // Resolve an appeal. "lift" unblocks the IP (dev-only, like every other IP
    // unblock) and marks the appeal accepted; "dismiss" just closes it (full
    // mods + devs). Either way the board refreshes live for every open dash.
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
          if (!requireDev(socket)) return; // lifting a ban is dev-only
          // Remove the exact entry AND any covering range (e.g. an IPv6 /64),
          // plus any block tied to the appellant's client identifier: deleting
          // only a.ip would leave the user still blocked after their appeal
          // was "accepted".
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
              reason: "appeal accepted",
            });
          broadcastBlockList();
          broadcastBanHistory();
          appeals.resolveOpenForIp(a.ip, "lifted", reviewer);
          logStaff(socket, "lift ban (appeal)", a.name || a.ip, "-");
        } else {
          // Whatever the moderator types goes to the user as the last line of
          // the conversation, so a decision is never just a closed door.
          const note = sanitizeMessage(
            typeof data?.note === "string" ? data.note : "",
          ).slice(0, 300);
          appeals.resolve(id, "dismissed", reviewer, note || null);
          logStaff(
            socket,
            "dismiss appeal",
            { name: a.name || "?", id: a.userId || a.deviceId || "-" },
            "-",
            note || undefined,
          );
        }
        broadcastAppealsList();
        broadcastAppeal(id);
        stampQueueItem(
          socket,
          "appeal",
          id,
          decision === "lift" ? "ban lifted" : "dismissed",
        );
        socket.emit("staff appeals", buildAppealsList(!!socket.isMainDev));
      }),
    );

    // Remove an appeal outright (dev). The record and its conversation go
    // together; the person can file a fresh one afterwards.
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
        try {
          staffchat.stampQueue(
            (m) => m.qkind === "appeal" && m.card && m.card.itemId === id,
            { by: socket.staffLabel || "dev", action: "handled" },
            true,
          );
        } catch (_) {}
        broadcastAppealsList();
        socket.emit("staff appeals", buildAppealsList(!!socket.isMainDev));
      }),
    );

    // ── Suggestions: any lobby user files a feature idea; full mods + devs
    // review them in the dashboard. ──
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
        socket.emit("staff suggestions", buildSuggestionsList(!!socket.isDev));
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
        stampQueueItem(socket, "suggestion", id, decision);
        socket.emit("staff suggestions", buildSuggestionsList(!!socket.isDev));
      }),
    );

    // ── Community suggestion board: everyone reads/posts/replies/votes from
    // the lobby modal; devs set status tags. Word filter is ALWAYS applied
    // here, independent of the global toggle. ──
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

    // The lobby asking "is there anything for me?". The browser sends the
    // moment it last had the board open; the server answers with counts over
    // that person's OWN posts only.
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
    // The lobby asks once on load. The answer is the single newest live notice
    // (or null); the browser decides whether it has already read that id.
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
        // NOT run through the word filter: this is a developer writing to the
        // whole site, and the filter mangling their own notice is worse than
        // the risk it guards against.
        const body = typeof data?.body === "string" ? data.body : "";
        // Who it reads as being from. A notice often speaks for the team
        // rather than the person who happened to type it, so this is free
        // text - but it falls back to the real staff label, and it is only
        // ever settable by a dev, so it cannot be used to impersonate.
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
        if (text.trim().length < 8) return fail("Please write a little more.");
        // A one-line title, so a list of 300 can be skimmed instead of read.
        let title = wordFilter.filterText(
          sanitizeMessage(typeof data?.title === "string" ? data.title : "")
            .slice(0, 80),
        ).trim();
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
          // The structured version, so the Desk draws a real card with the same
          // buttons the board has instead of a one-line sentence. itemId is
          // what a status change stamps the card by.
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
        // Mods as well as devs: triaging 300 posts is not a one-person job,
        // and every change is logged below like any other staff action.
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
        // Stamp the Desk card for this post, so a decision made anywhere shows
        // as handled in #queues rather than leaving two people to open it.
        stampQueueItem(socket, "suggestion", s.id, s.status);
        broadcastBoard();
      }),
    );

    // Anybody can clear up their OWN post or reply; staff can clear anybody's.
    // Ownership is decided server-side from the device id, never from a "mine"
    // flag sent by the client.
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
        // Only a staff removal is a moderation action. Somebody tidying up
        // after themselves is not work, and logging it would pad the record.
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

    // Fixing your own typo. Authors only - staff can delete something, but
    // rewriting it would put words in somebody's mouth under their name.
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

    // ── Mod application status (any user): power the lobby "Check status" link.
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

    // ── Comment on a log entry (mod + dev) - for accountability discussion ─
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
    // Lets a normal user flag a problem to moderators. Surfaces as a dashboard
    // notification and a live toast for full mods + devs (never junior mods).
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
        // Snapshot what the reported user has typed right now, so staff see the
        // offending text in the report even after it is edited, cleared, or the
        // user leaves. Sanitized like any chat text; capped for the feed.
        const targetText = sanitizeMessage(
          state.userMessageBuffers.get(targetUserId) || "",
        ).slice(0, 300);
        const reporter = socket.handshake.session?.username || "A user";
        const catLabel = REPORT_CATEGORIES[category];
        // Roles read off the socket, never off a name. Somebody calling
        // themselves "MOD katie" is not staff, and the feed has to be able to
        // say so plainly.
        const roleOf = (s) =>
          s?.isDev ? "dev" : s?.isMod ? ((s.modLevel || 2) >= 2 ? "mod" : "jr") : null;
        const targetRole = roleOf(targetSocket);
        const byRole = roleOf(socket);
        const tally = reports.add({
          targetKey: targetUserId,
          targetName,
          byDeviceId: socket.deviceId,
          byName: reporter,
          category,
          reason,
          // Remember how to reach the target if they later go offline, so staff
          // can still act from the board. The IP is never sent to the client.
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
          // Both addresses on the entry, so a dev reading the feed can act on
          // it without going and looking them up. Stripped for mods.
          ip: socket.clientIp || null,
          targetIp: targetSocket?.clientIp || null,
          targetUserId,
          byUserId: socket.handshake.session?.userId || null,
          byRole,
          targetRole,
          reports: tally.distinct || null,
          minLevel: 2,
          // The Desk draws its own card from these and puts warn / kick /
          // block / discard on it, firing the same events the board does.
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
        broadcastReportsList(); // live-update open dashboards
      }),
    );

    // ── Mod applications: submit (active users) + review (full mods + devs) ─
    socket.on(
      "mod application submit",
      safe(async (data) => {
        if (!socket.deviceId)
          return socket.emit("mod application result", {
            ok: false,
            error: "This browser can't be identified. Enable storage and retry.",
          });
        if (socket.isDev || socket.isMod)
          return socket.emit("mod application result", {
            ok: false,
            error: "You're already staff.",
          });
        if (!state.applicationsOpen)
          return socket.emit("mod application result", {
            ok: false,
            error: "Moderator applications are closed right now. Please check back later.",
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
        const availability = sanitizeMessage(
          typeof data?.availability === "string" ? data.availability : "",
        ).slice(0, 120);
        if (!why)
          return socket.emit("mod application result", {
            ok: false,
            error: "Please say why you'd like to help moderate.",
          });
        // Discord handle, so a reviewer can find them in the server. Strip a
        // leading @ and keep it to the characters Discord actually allows.
        const discord = sanitizeMessage(
          typeof data?.discord === "string" ? data.discord : "",
        )
          .replace(/^@+/, "")
          .replace(/[^A-Za-z0-9._-]/g, "")
          .slice(0, 40);
        if (!discord)
          return socket.emit("mod application result", {
            ok: false,
            error:
              "Please enter your Discord username so we can reach you in the Talkomatic server.",
          });
        const res = applications.submit({
          deviceId: socket.deviceId,
          ip: socket.clientIp,
          username: socket.handshake.session?.username,
          discord,
          answers: { why, availability },
          // Present only when they have linked their Discord picture, which is
          // what lets a reviewer match them to the Talkomatic server. Either
          // shape the session can hold counts.
          discordId:
            socket.handshake.session?.avatar?.id ||
            socket.handshake.session?.avatar?.discordId ||
            null,
        });
        if (!res.ok) return socket.emit("mod application result", res);
        audit.recordNotification({
          kind: "application",
          text: `New mod application from ${socket.handshake.session?.username || "a user"}`,
          by: socket.handshake.session?.username || null,
          minLevel: 2,
          // Everything a reviewer needs to decide, so approving does not mean
          // going to find the application first.
          card: {
            ids: [socket.deviceId].filter(Boolean),
            by: socket.handshake.session?.username || "a user",
            itemId: res.id,
            deviceId: socket.deviceId || null,
            discord,
            reason: why,
            lines: availability ? ["Around: " + availability] : null,
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

    // Dev-only: open or close the moderator-application intake. Closing it does
    // not touch existing applications; it only stops new ones being accepted.
    socket.on(
      "dev set applications open",
      safe(async (data) => {
        if (!requireDev(socket)) return;
        state.applicationsOpen = !!(data && data.open);
        logStaff(
          socket,
          state.applicationsOpen ? "open applications" : "close applications",
          "-",
          "-",
        );
        broadcastApplicationsState();
        socket.emit("staff action result", {
          action: "applications open",
          ok: true,
          open: state.applicationsOpen,
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
          // Notify the applicant live if they are online, so they learn the
          // outcome and the reviewer's message without waiting to reconnect -
          // the same idea as the ban screen reloading when a ban is lifted.
          // (Approvals already signal the user via the "you are now mod" key
          // delivery, so only the reject path needs this push.)
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
        stampQueueItem(
          socket,
          "application",
          id,
          decision === "approve" ? "approved" : "declined",
        );
        socket.emit("staff action result", {
          action: "review application",
          ok: true,
          id,
        });
      }),
    );

    // ── Warn a reported user, online or offline (any staff) ─────────────
    // Offline targets are queued by device id and delivered on next connect.
    socket.on(
      "staff warn user",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        const targetUserId =
          typeof data?.targetUserId === "string" ? data.targetUserId : "";
        if (!targetUserId) return;
        const lk = reports.lastKnown(targetUserId);
        // Hierarchy: a mod cannot warn another staffer (use the stored role when
        // the target is offline and we cannot read it live).
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
    // Anyone may submit a key; the server says whether it's a dev/mod key so
    // the client can store it. Per-IP throttled to resist brute force.
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
          rec.count = 0; // reset throttle on success
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
    // Generates a mod key and delivers it privately to that user's socket,
    // which stores it and reloads - no manual key hand-off.
    socket.on(
      "dev grant mod to user",
      safe(async (data) => {
        if (!requireStaff(socket)) return;
        // Who may grant, and at what level: devs grant level 1 or 2 (full by
        // default); full (level 2) mods may grant level 1 only; junior (level 1)
        // mods cannot grant at all.
        let grantLevel;
        if (socket.isDev) grantLevel = data?.level === 1 ? 1 : 2;
        else if (socket.isMod && (socket.modLevel || 2) >= 2) grantLevel = 1;
        else
          return socket.emit(
            "error",
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You cannot grant a moderator role.",
            ),
          );
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
        // Clear any votes already cast against them - staff are vote-immune, so
        // stale pre-promotion votes shouldn't linger.
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
        // Only devs receive the full key roster (hashes/labels/levels).
        if (socket.isDev) socket.emit("dev mod keys", roles.listModKeys());
        staffchat.rosterDirty();
      }),
    );

    // ── Demote: revoke a connected user's mod key by userId (dev) ────────
    // Lets a dev remove a mod from inside a room (the lobby manage-keys list
    // revokes by hash; this revokes by the user you're looking at).
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
        // A dev is never demoted this way; only mods can be removed.
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
        // Same rule as the Moderators tab: nobody comes off staff without a
        // reason on the record.
        const reason = String(data?.reason || "").trim().slice(0, 300);
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
          // Live-downgrade every socket using this key
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
        socket.emit("dev mod keys", roles.listModKeys());
        socket.emit("dev former mods", roles.listFormerMods());
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
        // If a reported user just went offline, refresh the dashboards.
        if (userId && reports.isTarget(userId))
          setTimeout(() => broadcastReportsList(), 150);
        if (userId) {
          clearAFKTimers(userId);
          await leaveRoom(socket, userId);
          state.userMessageBuffers.delete(userId);
          state.devUsers.delete(userId);
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
        releaseSlot(); // no-op when the dedicated listener already ran
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
  // Pressure cleanup (30s)
  setInterval(async () => {
    try {
      await pressureCleanup();
    } catch (err) {
      console.error("Pressure cleanup error:", err);
    }
  }, CONFIG.LIMITS.PRESSURE_CLEANUP_INTERVAL);

  // Bot detection cleanup (2 min)
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

  // Board areas whose owner never came back (every 30s)
  setInterval(() => {
    try {
      sweepBoardClaims();
    } catch (e) {
      console.error("board claim sweep failed:", e);
    }
  }, 30000);

  // Bot token cleanup (daily)
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

  // IP user cleanup (hourly)
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

  // Resource cleanup (5 min): drop buffers/timers for users no longer in rooms
  setInterval(() => {
    const active = new Set();
    for (const [, room] of state.rooms) {
      if (room.users) room.users.forEach((u) => active.add(u.id));
    }
    for (const id of state.userMessageBuffers.keys()) {
      if (!active.has(id)) state.userMessageBuffers.delete(id);
    }
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

  // Cache cleanup (3 min)
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
    for (const roomId of pianoState.keys()) {
      if (!state.rooms.has(roomId)) pianoState.delete(roomId);
    }
  }, 180000);

  // Empty room cleanup (10 min)
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
      cleanupPianoState(id);
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

  // Per-IP connection count reconcile (30s).
  //
  // The count is taken in the connect middleware and given back on disconnect.
  // That pairing can still be broken by a client that vanishes in between: a
  // websocket upgrade that fails after the handshake, a request killed by an
  // extension or a proxy, a tab closed mid-connect. In those cases the socket
  // never reaches the connection handler, so nothing ever releases its count.
  // One stale count is invisible; MAX_CONNECTIONS_PER_IP of them lock that
  // address out of the site completely with "Too many connections", and only a
  // restart clears it.
  //
  // Rather than trying to enumerate every way that pairing can break, recount
  // from the sockets that actually exist. Any leak, from any cause, heals
  // within half a minute.
  setInterval(() => {
    if (!io()) return;
    const live = new Map();
    for (const [, s] of io().sockets.sockets) {
      const ip = s.clientIp;
      if (!ip) continue;
      live.set(ip, (live.get(ip) || 0) + 1);
    }
    // Report what was corrected. If the logs stay quiet the pairing is sound;
    // if they show counts drifting above the live socket count, that names the
    // leak and how fast it grows.
    let leaked = 0;
    let worst = null;
    for (const ip of [...state.ipConnections.keys()]) {
      const had = state.ipConnections.get(ip) || 0;
      const now = live.get(ip) || 0;
      if (had > now) {
        leaked += had - now;
        if (!worst || had - now > worst.by) worst = { ip, had, now, by: had - now };
      }
      if (!live.has(ip)) state.ipConnections.delete(ip);
    }
    for (const [ip, n] of live) state.ipConnections.set(ip, n);
    if (leaked)
      console.warn(
        `[conn] reclaimed ${leaked} stale connection slot(s); worst: ${worst.ip} counted ${worst.had} with ${worst.now} live`,
      );
  }, 30000);

  // Ghost user cleanup (1 min): removes room users with no live socket
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
        // A hosted bot never has a socket; its liveness is the bot runtime.
        // Without this exemption the sweep would evict every bot within a
        // minute of deploying. Dead bot entries (runtime gone) still purge.
        if (u.isBotUser && bots.isActiveBot(u.id)) return true;
        if (!activeIds.has(u.id)) {
          console.log(`Ghost removed: "${u.username}" from "${room.name}"`);
          state.userMessageBuffers.delete(u.id);
          clearAFKTimers(u.id);
          state.devUsers.delete(u.id);
          finalizeBoardUserStroke(roomId, u.id);
          pianoDropPresence(roomId, u.id, true);
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
      debouncedSaveRooms().catch(() => { });
    }
  }, 60000);

  // Server monitor (2 min): status log and memory pressure relief
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
  // A "ghost" is a room user with no live socket: a leftover from a room loaded
  // from disk, or a crash. Only those get purged. We must NOT blindly wipe room
  // users, because by the time this runs (a couple of seconds after boot)
  // clients have already reconnected and rejoined - wiping would kick the very
  // users we just let back in. Mirrors the 60s ghost cleanup in
  // startCleanupIntervals().
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
      if (activeIds.has(u.id)) return true; // live socket -> a real user, keep
      if (u.isBotUser && bots.isActiveBot(u.id)) return true; // live hosted bot
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
    // Only tear down board state / arm the delete timer if the room is now
    // truly empty; a room with surviving live users keeps its board.
    if (r.users.length === 0) {
      cleanupBoardState(id);
      startRoomDeletionTimer(id);
    }
  }
  if (total > 0) {
    console.log(`Startup purge: removed ${total} ghost(s)`);
    updateLobby();
    debouncedSaveRooms().catch(() => { });
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
