// server/receipts.js
// The evidence captured at the moment staff act on a person: what they had
// typed, who had reported them, what staff had already done to them, and
// where everybody was. Graded on the spot, so a record can say what the
// evidence showed rather than what anyone meant.

const { state, wordFilter } = require("./state");
const audit = require("./audit");
const reports = require("./reports");
const identity = require("./identity");
const lastseen = require("./lastseen");
const ipban = require("./ipban");
const banhistory = require("./banhistory");
const bots = require("./bots");
const linkfilter = require("./linkfilter");
const ipredact = require("./ipredact");
const buffertrail = require("./buffertrail");

const PRIOR_WINDOW_MS = 24 * 60 * 60 * 1000;
const CASE_WINDOW_MS = 10 * 60 * 1000;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const JOINS_WINDOW_MS = 5 * 60 * 1000;
const TEXT_MIN = 3;

// Community rules that end in a block with no warning first. Numbers follow
// DEFAULT_COMMUNITY in rules.js: 2 age, 4 hate speech, 5 personal
// information, 6 impersonating staff, 8 sexual content, 10 illegal,
// 15 getting around a block.
const NO_WARNING_RULES = new Set([2, 4, 5, 6, 8, 10, 15]);

const GRADES = ["corroborated", "reported", "unverifiable", "contradicted"];

function parseReason(reason) {
  const text = String(reason || "").trim();
  const m = /^Rule (\d+)\b/.exec(text);
  return { rule: m ? Number(m[1]) : null, text: text || null };
}

function votesAgainst(room, userId) {
  if (!room || !room.votes) return 0;
  const present = new Set((room.users || []).map((u) => u.id));
  let n = 0;
  for (const voter in room.votes)
    if (room.votes[voter] === userId && present.has(voter)) n++;
  return n;
}

function roomFacts(room, now) {
  const users = room.users || [];
  return {
    id: room.id,
    name: room.name,
    occupants: users.length,
    staff: users.filter((u) => u.isMod || u.isDev).length,
    joins5m: (room.recentJoins || []).filter((t) => now - t <= JOINS_WINDOW_MS)
      .length,
  };
}

function reportFacts(userId, now) {
  const list = reports
    .forTarget(userId)
    .filter((r) => now - r.at <= REPORT_WINDOW_MS);
  const reporters = new Set(list.map((r) => r.byDeviceId || "anonymous"));
  return {
    hour: list.length,
    reporters: reporters.size,
    categories: [...new Set(list.map((r) => r.category))],
  };
}

function personFacts(userId, deviceId, ip, net, targetUser) {
  const rec = deviceId ? identity.getRecord(deviceId) : null;
  const idBlock = deviceId ? ipban.findActiveIdBlock(deviceId) : null;
  const block = idBlock && idBlock.block;
  return {
    evader: !!(rec && rec.evaderAt),
    autoBlocked: !!(block && typeof block === "object" && block.by == null),
    bot: !!(targetUser && targetUser.isBotUser),
    maker: bots.ownerOf(userId) || null,
    bans: banhistory.countBans(net || ip),
  };
}

function autoChecks(texts) {
  const joined = texts.filter(Boolean).join("\n");
  let words = false;
  try {
    words = !!wordFilter.checkText(joined).hasOffensiveWord;
  } catch (_) {}
  return {
    words,
    links: linkfilter.containsLink(joined),
    ip: ipredact.containsIp(joined),
  };
}

function gradeOf(r, action, now) {
  const base = audit.baseAction(action);
  const recentPrior = r.prior.some((p) => now - p.at <= CASE_WINDOW_MS);
  const corroborated =
    r.auto.words ||
    r.auto.links ||
    r.auto.ip ||
    r.person.evader ||
    r.person.autoBlocked ||
    (r.person.bot && base === "kill bot") ||
    recentPrior;
  if (corroborated) return "corroborated";
  if (r.reports.hour > 0 || r.dislikes >= 2) return "reported";
  if (audit.HEAVY.has(base) && r.bare) return "contradicted";
  return "unverifiable";
}

// What the box says right now, or what it said just before a wipe.
function boxNow(userId, roomId) {
  let text = roomId ? state.getBuffer(userId, roomId).trim() : "";
  let wiped = false;
  if (text.length < TEXT_MIN) {
    const last = buffertrail.lastSeen(userId);
    text = last ? last.text : "";
    wiped = !!last;
  }
  return { text: text.slice(0, buffertrail.MAX_CHARS), wiped };
}

// The box as it was when the dialog opened, before anything was typed into
// it. Kept on the acting socket until the action lands, so a box cleared
// between opening the dialog and pressing send is still on the receipt.
const OPENED_TTL_MS = 10 * 60 * 1000;

function noteOpened(socket, targetUserId, room) {
  if (!socket || !targetUserId) return null;
  const box = boxNow(targetUserId, room ? room.id : null);
  const entry = { text: box.text || null, wiped: box.wiped, at: Date.now() };
  if (!socket._opened) socket._opened = new Map();
  socket._opened.set(targetUserId, entry);
  return entry;
}

function takeOpened(socket, targetUserId) {
  if (!socket || !socket._opened) return null;
  const e = socket._opened.get(targetUserId);
  socket._opened.delete(targetUserId);
  if (!e || Date.now() - e.at > OPENED_TTL_MS) return null;
  return e;
}

// Everything the handler already has in hand goes in; the receipt comes out.
// Call it BEFORE the action changes anything, or a wipe records an empty box.
function capture(o) {
  const now = Date.now();
  const room = o.room && typeof o.room === "object" ? o.room : null;
  const userId = o.targetUserId;
  const targetUser = o.targetUser || null;
  const targetSocket = o.targetSocket || null;
  const seen = targetSocket ? null : lastseen.get(userId);
  const deviceId =
    o.deviceId ||
    (targetSocket && targetSocket.deviceId) ||
    (targetUser && targetUser.deviceId) ||
    (seen && seen.deviceId) ||
    null;
  const ip = (targetSocket && targetSocket.clientIp) || (seen && seen.ip) || null;
  const net = ip ? ipban.computeRangeCidr(ip) : null;

  const box = boxNow(userId, room ? room.id : null);
  const text = box.text;
  const textWiped = box.wiped;
  const opened = takeOpened(o.socket, userId);
  const trail = buffertrail
    .recent(userId)
    .filter((t) => t.text !== text)
    .map((t) => ({ text: t.text, at: t.at }));

  const prior = audit.actionsOn({ userId, deviceId }, now - PRIOR_WINDOW_MS);
  const reason = parseReason(o.reason);
  const receipt = {
    v: 1,
    origin: room ? "room" : "offline",
    text: text || null,
    textWiped,
    opened,
    trail,
    target: {
      did: deviceId,
      uid: userId,
      ip,
      net,
      name:
        (targetUser && targetUser.username) ||
        (seen && seen.name) ||
        o.targetName ||
        null,
      loc: (targetUser && targetUser.location) || null,
      pfp: !!(targetUser && targetUser.avatar),
      joinedAt: (targetUser && targetUser.joinedAt) || null,
    },
    actor: {
      joinedAt:
        room && o.socket && o.socket.roomId === room.id
          ? o.socket.roomJoinedAt || null
          : null,
      spectating: !!(o.socket && o.socket.spectating),
    },
    room: room ? roomFacts(room, now) : null,
    reports: reportFacts(userId, now),
    dislikes: room ? votesAgainst(room, userId) : 0,
    prior,
    person: personFacts(userId, deviceId, ip, net, targetUser),
    reason,
    auto: autoChecks([text, ...trail.map((t) => t.text)]),
    ref: o.ref || null,
  };
  receipt.bare = !prior.length && !reason.rule && !reason.text;
  receipt.grade = gradeOf(receipt, o.action, now);
  return receipt;
}

function quote(receipt) {
  if (!receipt) return null;
  if (receipt.text) return receipt.text;
  return receipt.origin === "offline" ? "(acted on from outside a room)" : "(box was empty)";
}

module.exports = {
  capture,
  noteOpened,
  takeOpened,
  parseReason,
  quote,
  NO_WARNING_RULES,
  GRADES,
};
