// server/polls.js

const chatguard = require("./chatguard");
const linkfilter = require("./linkfilter");
const identity = require("./identity");
const automod = require("./automod");

const QUESTION_MAX = 120;
const OPTION_MAX = 40;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 6;
const MINUTES = [2, 3, 4, 5];
const DEFAULT_MINUTES = 2;
const KEEP_ENDED_MS = 10 * 60 * 1000;
const CREATE_GAP_MS = 20 * 1000;
const VOTES_PER_SEC = 4;

let deps = null;
const polls = new Map();
const lastCreate = new Map();
let seq = 0;

function init(d) {
  deps = d;
}

const io = () => (deps && deps.io ? deps.io() : null);
const roomOf = (roomId) => (deps && deps.state.rooms.get(roomId)) || null;
const isStaff = (s) => !!(s && (s.isDev || s.isMod));
const uidOf = (s) => (s.handshake && s.handshake.session && s.handshake.session.userId) || null;

function eligible(roomId) {
  const room = roomOf(roomId);
  if (!room) return [];
  return room.users.filter((u) => !u.isBotUser && !u.isVanished);
}

function who(socket) {
  const uid = uidOf(socket);
  if (!socket.roomId || !uid || socket.spectating || socket.isBot) return null;
  const room = roomOf(socket.roomId);
  const u = room && room.users.find((x) => x.id === uid);
  if (!u) return null;
  return { userId: uid, username: u.username || "Someone" };
}

function allowed(socket, perSec) {
  const now = Date.now();
  if (!socket._pollW || now - socket._pollW > 1000) {
    socket._pollW = now;
    socket._pollC = 0;
  }
  socket._pollC++;
  return socket._pollC <= perSec;
}

function text(v, max) {
  if (typeof v !== "string") return "";
  return chatguard.clean(v, max * 2).replace(/\s+/g, " ").trim().slice(0, max);
}

function current(roomId) {
  const p = polls.get(roomId);
  if (!p) return null;
  if (p.ended && Date.now() - p.ended.at > KEEP_ENDED_MS) {
    polls.delete(roomId);
    return null;
  }
  return p;
}

function view(poll, socket) {
  const staff = isStaff(socket);
  const uid = uidOf(socket);
  const mine = poll.voters.has(uid) ? poll.voters.get(uid) : null;
  const open = mine != null || !!poll.ended || staff;
  const here = !!who(socket);
  const people = eligible(poll.roomId);
  return {
    id: poll.id,
    question: poll.question,
    by: { userId: poll.by.userId, username: poll.by.username },
    createdAt: poll.createdAt,
    endsAt: poll.endsAt,
    minutes: poll.minutes,
    options: poll.options.map((o) => ({
      text: o.text,
      count: open ? o.votes.size : null,
      voters: open ? [...o.votes].map((id) => poll.names.get(id) || "?") : undefined,
    })),
    total: poll.voters.size,
    eligible: people.length,
    waiting: people.filter((u) => !poll.voters.has(u.id)).length,
    mine,
    ended: poll.ended,
    staff,
    canVote: here && !poll.ended,
    canEnd: !poll.ended && (staff || uid === poll.by.userId),
  };
}

function push(roomId) {
  const srv = io();
  if (!srv) return;
  const poll = current(roomId);
  for (const [, s] of srv.sockets.sockets) {
    if (!s.connected || (s.roomId !== roomId && s.spectating !== roomId)) continue;
    if (poll && poll.ghost && uidOf(s) !== poll.by.userId) continue;
    s.emit("poll state", poll ? view(poll, s) : null);
  }
}

function send(socket) {
  if (!socket.roomId && !socket.spectating) return;
  const roomId = socket.roomId || socket.spectating;
  const poll = current(roomId);
  if (poll && poll.ghost && uidOf(socket) !== poll.by.userId) return socket.emit("poll state", null);
  socket.emit("poll state", poll ? view(poll, socket) : null);
}

function end(roomId, reason, by) {
  const poll = current(roomId);
  if (!poll || poll.ended) return;
  poll.ended = { at: Date.now(), reason, by: by || null };
  if (poll.timer) clearTimeout(poll.timer);
  poll.timer = null;
  push(roomId);
}

function settle(roomId) {
  const poll = current(roomId);
  if (!poll || poll.ended) return;
  const people = eligible(roomId);
  if (people.length && people.every((u) => poll.voters.has(u.id))) end(roomId, "all");
}

function create(socket, data) {
  const me = who(socket);
  if (!me) return { err: "Join a room to start a poll." };
  const roomId = socket.roomId;
  const running = current(roomId);
  if (running && !running.ghost && !running.ended) return { err: "A poll is already running. Wait for it to end." };
  const now = Date.now();
  if (now - (lastCreate.get(me.userId) || 0) < CREATE_GAP_MS) return { err: "Give it a moment before starting another poll." };

  const rawQ = typeof data.question === "string" ? data.question : "";
  const rawOpts = Array.isArray(data.options) ? data.options.slice(0, OPTIONS_MAX) : [];
  if (linkfilter.containsLink(rawQ) || rawOpts.some((o) => typeof o === "string" && linkfilter.containsLink(o)))
    return { err: "Links are not allowed in polls." };
  const question = text(rawQ, QUESTION_MAX);
  if (!question) return { err: "Write a question." };
  const options = [];
  const seen = new Set();
  for (const raw of rawOpts) {
    const t = text(raw, OPTION_MAX);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) return { err: "Two answers say the same thing." };
    seen.add(key);
    options.push({ text: t, votes: new Set() });
  }
  if (options.length < OPTIONS_MIN) return { err: "Give at least 2 answers." };
  let minutes = Number(data.minutes);
  if (!MINUTES.includes(minutes)) minutes = DEFAULT_MINUTES;

  const poll = {
    id: "p" + now.toString(36) + (seq++).toString(36),
    roomId,
    question,
    options,
    by: { userId: me.userId, username: me.username, deviceId: socket.deviceId || null },
    createdAt: now,
    minutes,
    endsAt: now + minutes * 60 * 1000,
    voters: new Map(),
    names: new Map(),
    ended: null,
    ghost: !!(socket.deviceId && identity.isSilenced(socket.deviceId)),
    timer: null,
  };
  poll.timer = setTimeout(() => end(roomId, "timer"), minutes * 60 * 1000);
  if (poll.timer.unref) poll.timer.unref();
  polls.set(roomId, poll);
  if (lastCreate.size > 5000) lastCreate.clear();
  lastCreate.set(me.userId, now);
  push(roomId);
  automod.notePoll(socket, poll);
  return { ok: true };
}

function vote(socket, data) {
  const me = who(socket);
  if (!me) return { err: "Join the room to vote." };
  const poll = current(socket.roomId);
  if (!poll || poll.ended) return { err: "That poll is over." };
  if (data.id !== poll.id) return { err: "That poll is over." };
  if (poll.ghost && poll.by.userId !== me.userId) return { err: "That poll is over." };
  const idx = Number(data.option);
  if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) return { err: "Pick one of the answers." };
  const before = poll.voters.get(me.userId);
  if (before === idx) return { ok: true };
  if (before != null) poll.options[before].votes.delete(me.userId);
  poll.options[idx].votes.add(me.userId);
  poll.voters.set(me.userId, idx);
  poll.names.set(me.userId, me.username);
  push(socket.roomId);
  settle(socket.roomId);
  return { ok: true };
}

function close(socket, data) {
  const roomId = socket.roomId;
  const poll = roomId && current(roomId);
  if (!poll || poll.ended || data.id !== poll.id) return { err: "That poll is over." };
  const uid = uidOf(socket);
  if (uid === poll.by.userId) {
    end(roomId, "creator", poll.by.username);
    return { ok: true };
  }
  if (!isStaff(socket)) return { err: "Only the asker or staff can end a poll." };
  end(roomId, "staff");
  const room = roomOf(roomId);
  if (deps.logStaff)
    deps.logStaff(socket, "ended poll", { username: poll.by.username, id: poll.by.userId }, room ? { name: room.name, id: room.id } : "-", poll.question.slice(0, 80));
  return { ok: true };
}

function userLeft(roomId) {
  settle(roomId);
  push(roomId);
}

function roomClosed(roomId) {
  const poll = polls.get(roomId);
  if (poll && poll.timer) clearTimeout(poll.timer);
  polls.delete(roomId);
}

function register(socket, safe) {
  const act = (fn) =>
    safe(async (data) => {
      if (!allowed(socket, VOTES_PER_SEC)) return;
      const out = fn(socket, data && typeof data === "object" ? data : {});
      if (out && out.err) socket.emit("poll error", { message: out.err });
    });
  socket.on("poll get", safe(async () => send(socket)));
  socket.on("poll create", act(create));
  socket.on("poll vote", act(vote));
  socket.on("poll end", act(close));
}

module.exports = { init, register, userLeft, roomClosed };
