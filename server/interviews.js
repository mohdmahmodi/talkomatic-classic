const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");
const { sanitizeMessage } = require("./state");
const { maskIps } = require("./audit");

const FILE = path.join(DATA_DIR, "mod-interviews.json");
const STAFF_MAX = 1000;
const APPLICANT_MAX = 600;
const MSG_CAP = 500;
const APPLICANT_CAP = 250;
const APPLICANT_GAP_MS = 900;
const STAFF_GAP_MS = 300;
const TYPING_GAP_MS = 1200;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const REACTIONS = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "✅", "🙏"];
const REACTION_KINDS = 8;

let store = {};
let saveTimer = null;
let ctx = null;
const lastSend = new WeakMap();
const lastTyping = new WeakMap();

function io() {
  return ctx && ctx.io();
}

function apps() {
  return ctx.applications;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = raw && raw.byApp && typeof raw.byApp === "object" ? raw.byApp : {};
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading mod-interviews.json:", err);
    store = {};
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify({ byApp: store }), "utf8");
      await fsp.rename(tmp, FILE);
    } catch (e) {
      console.error("mod-interviews save failed:", e);
    }
  }, 2000);
}

function flushSync() {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ byApp: store }), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error("mod-interviews flush failed:", e);
  }
}

function prune() {
  if (!ctx) return;
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!apps().get(Number(id))) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) saveSoon();
}

const isStaff = (s) => !!(s && (s.isDev || s.isMod));
const levelOf = (s) => (!s ? 0 : s.isDev ? 4 : s.isMod ? s.modLevel || 1 : 0);
const canView = (s) => levelOf(s) >= 2;
const canLead = (s) => levelOf(s) >= 3;

function staffOf(socket) {
  return {
    label: socket.staffLabel || (socket.isDev ? "dev" : "mod"),
    role: socket.isDev ? "dev" : "mod",
    level: socket.isDev ? 0 : socket.modLevel || 1,
  };
}

const idKey = (w) => w.role + ":" + w.label;

function cleanAvatar(av) {
  if (!av || typeof av !== "object") return null;
  if (av.preset !== undefined && av.preset !== null) {
    const n = Number(av.preset);
    return Number.isInteger(n) && n >= 1 && n <= 999 ? { preset: n } : null;
  }
  const id = av.id || av.discordId;
  if (!id || !av.hash) return null;
  return { id: String(id), hash: String(av.hash), animated: !!av.animated };
}

function veiled(label, role) {
  try {
    return !!ctx.roles.isMainDevActor(label, role);
  } catch (_) {
    return false;
  }
}

function staffName(label, role, viewer) {
  if (!label) return "Staff";
  if (viewer && viewer.isMainDev) return label;
  try {
    return ctx.roles.systemLabel(label, role) || label;
  } catch (_) {
    return label;
  }
}

function publicName(label, role) {
  try {
    return ctx.roles.teamLabel(label, role, null) || "Talkomatic staff";
  } catch (_) {
    return "Talkomatic staff";
  }
}

function splitActor(value) {
  const s = String(value || "");
  const i = s.indexOf(":");
  return i === -1 ? { role: null, label: s } : { role: s.slice(0, i), label: s.slice(i + 1) };
}

function cleanText(raw, max) {
  return sanitizeMessage(typeof raw === "string" ? raw : "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

function cut(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function addMessage(iv, m) {
  iv.seq = (iv.seq || 0) + 1;
  m.id = "i" + iv.seq;
  m.ts = Math.max(Date.now(), (iv.lastTs || 0) + 1);
  iv.messages.push(m);
  if (iv.messages.length > MSG_CAP)
    iv.messages.splice(0, iv.messages.length - MSG_CAP);
  iv.lastTs = m.ts;
  saveSoon();
  return m;
}

function lastFrom(iv, from) {
  for (let i = iv.messages.length - 1; i >= 0; i--)
    if (iv.messages[i].from === from) return iv.messages[i];
  return null;
}

function stateFor(appId) {
  const iv = store[appId];
  return iv ? iv.status : null;
}

function summary(appId) {
  const iv = store[appId];
  if (!iv) return null;
  return {
    status: iv.status,
    startedAt: iv.startedAt,
    endedAt: iv.endedAt || null,
    count: iv.messages.filter((m) => m.from !== "system").length,
  };
}

function onlineSet() {
  const out = new Set();
  if (!io()) return out;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && s.deviceId && !isStaff(s)) out.add(s.deviceId);
  return out;
}

function applicantSockets(deviceId) {
  const out = [];
  if (!io() || !deviceId) return out;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && s.deviceId === deviceId && !isStaff(s)) out.push(s);
  return out;
}

function isLatest(app) {
  const latest = apps().latestForDevice(app.deviceId);
  return !!latest && latest.id === app.id;
}

function systemText(m, viewer, isPublic) {
  if (isPublic)
    return (
      {
        start: "Interview started",
        reopen: "Interview reopened",
        end: "Interview ended",
        approved: "Application approved",
        rejected: "Application declined",
        accepted: "You accepted the role",
        withdrawn: "You turned down the role",
      }[m.event] || ""
    );
  const who = staffName(m.by, m.role, viewer);
  const them = m.name || "The applicant";
  return (
    {
      start: who + " started the interview",
      reopen: who + " reopened the interview",
      end: who + " ended the interview",
      approved: who + " approved the application",
      rejected: who + " declined the application",
      accepted: them + " accepted the junior mod role",
      withdrawn: them + " turned down the role",
    }[m.event] || ""
  );
}

function reactionKeyName(k, app, viewer) {
  if (k === "a") return app.username || "Applicant";
  const a = splitActor(k.slice(2));
  return staffName(a.label, a.role, viewer);
}

function staffUnread(iv, socket) {
  if (iv.status !== "open") return 0;
  const since = (iv.read && iv.read[idKey(staffOf(socket))]) || 0;
  let n = 0;
  for (let i = iv.messages.length - 1; i >= 0; i--) {
    const m = iv.messages[i];
    if (m.ts <= since) break;
    if (m.from === "applicant") n++;
  }
  return n;
}

function previewFor(m, viewer, app) {
  if (!m) return null;
  if (m.from === "system") return { from: "system", text: systemText(m, viewer, false) };
  return {
    from: m.from,
    by: m.from === "staff" ? staffName(m.by, m.role, viewer) : app.username || "Applicant",
    text: cut(viewer.isMainDev ? m.text : maskIps(m.text), 90),
  };
}

function listed(app, now) {
  if (!app) return false;
  if (app.status === "pending") return true;
  const iv = store[app.id];
  const at = Math.max(
    app.reviewedAt || 0,
    app.withdrawnAt || 0,
    (iv && iv.lastTs) || 0,
  );
  return now - at < KEEP_MS;
}

function row(app, socket, online) {
  const iv = store[app.id] || null;
  const last = iv && iv.messages.length ? iv.messages[iv.messages.length - 1] : null;
  return {
    appId: app.id,
    name: app.username || "Applicant",
    status: app.status,
    claimed: !!app.claimed,
    submittedAt: app.submittedAt || null,
    reviewedAt: app.reviewedAt || null,
    discord: app.discord || null,
    noDiscord: !!(app.answers && app.answers.hasDiscord === false),
    online: online ? online.has(app.deviceId) : applicantSockets(app.deviceId).length > 0,
    avatar: (iv && iv.avatar) || null,
    interview: iv
      ? {
          status: iv.status,
          startedAt: iv.startedAt,
          endedAt: iv.endedAt || null,
          lastTs: iv.lastTs || iv.startedAt,
          last: previewFor(last, socket, app),
          count: iv.messages.filter((m) => m.from !== "system").length,
          unread: staffUnread(iv, socket),
        }
      : null,
  };
}

function rowsFor(socket) {
  const now = Date.now();
  const online = onlineSet();
  return apps()
    .list()
    .filter((a) => listed(a, now))
    .map((a) => row(a, socket, online));
}

function staffMsg(m, socket, app) {
  const out = { id: m.id, ts: m.ts, from: m.from };
  if (m.from === "system") {
    out.text = systemText(m, socket, false);
    return out;
  }
  out.text = socket.isMainDev ? m.text : maskIps(m.text);
  if (m.from === "staff") {
    const hide = !socket.isMainDev && veiled(m.by, m.role);
    out.by = staffName(m.by, m.role, socket);
    out.role = hide ? "dev" : m.role;
    out.level = hide ? 0 : m.level || 0;
    out.avatar = hide ? null : m.avatar || null;
    out.mine = m.by === socket.staffLabel && m.role === (socket.isDev ? "dev" : "mod");
  } else {
    out.by = app.username || "Applicant";
    out.avatar = m.avatar || null;
  }
  const mineKey = "s:" + idKey(staffOf(socket));
  out.reactions = (m.reactions || [])
    .filter((r) => r.by && r.by.length)
    .map((r) => ({
      e: r.e,
      n: r.by.length,
      me: r.by.includes(mineKey),
      who: r.by.map((k) => reactionKeyName(k, app, socket)),
    }));
  return out;
}

function staffThread(app, socket) {
  const iv = store[app.id] || null;
  const showIp = !!socket.isMainDev;
  const mask = (v) => (typeof v === "string" && !showIp ? maskIps(v) : v);
  const a = app.answers || {};
  const rv = splitActor(app.reviewedBy);
  const pending = app.status === "pending";
  return {
    appId: app.id,
    name: app.username || "Applicant",
    status: app.status,
    claimed: !!app.claimed,
    submittedAt: app.submittedAt || null,
    reviewedAt: app.reviewedAt || null,
    reviewedBy: app.reviewedBy ? staffName(rv.label, rv.role, socket) : null,
    reason: mask(app.reason || null),
    discord: app.discord || null,
    noDiscord: !!(a.hasDiscord === false),
    answers: {
      why: mask(a.why || ""),
      experience: mask(a.experience || ""),
      availability: mask(a.availability || ""),
      age14: !!a.age14,
      agreed: !!a.agreed,
    },
    online: applicantSockets(app.deviceId).length > 0,
    avatar: (iv && iv.avatar) || null,
    interview: iv
      ? {
          status: iv.status,
          startedAt: iv.startedAt,
          startedBy: staffName(iv.startedBy && iv.startedBy.label, iv.startedBy && iv.startedBy.role, socket),
          endedAt: iv.endedAt || null,
          endedBy: iv.endedBy ? staffName(iv.endedBy.label, iv.endedBy.role, socket) : null,
          applicantSeen: iv.applicantSeen || 0,
          messages: iv.messages.map((m) => staffMsg(m, socket, app)),
        }
      : null,
    can: {
      start: pending && !iv,
      reopen: pending && !!iv && iv.status === "ended" && canLead(socket),
      write: !!iv && iv.status === "open",
      end: !!iv && iv.status === "open" && canLead(socket),
      decide: pending && canLead(socket),
    },
  };
}

function publicMsg(m) {
  const out = { id: m.id, ts: m.ts, from: m.from === "applicant" ? "me" : m.from };
  if (m.from === "system") {
    out.text = systemText(m, null, true);
    return out;
  }
  if (m.from === "staff") {
    out.text = maskIps(m.text);
    out.by = publicName(m.by, m.role);
    out.chip = m.role === "dev" && !veiled(m.by, m.role) ? "ADMIN" : "STAFF";
  } else {
    out.text = m.text;
  }
  out.reactions = (m.reactions || [])
    .filter((r) => r.by && r.by.length)
    .map((r) => ({ e: r.e, n: r.by.length, me: r.by.includes("a") }));
  return out;
}

function applicantPayload(app, iv, notice) {
  if (!app || !iv) return { has: false };
  const a = app.answers || {};
  return {
    has: true,
    appId: app.id,
    status: iv.status,
    decision: app.status,
    offer: app.status === "approved" && !app.claimed,
    startedAt: iv.startedAt,
    endedAt: iv.endedAt || null,
    staffSeen: iv.staffSeen || 0,
    seen: iv.applicantSeen || 0,
    answers: {
      why: a.why || "",
      experience: a.experience || "",
      availability: a.availability || "",
    },
    reactions: REACTIONS,
    messages: iv.messages.map(publicMsg),
    ...(notice ? { notice } : {}),
  };
}

function pushApplicant(app, notice) {
  const iv = store[app.id];
  if (!iv || !isLatest(app)) return;
  const payload = applicantPayload(app, iv, notice);
  for (const s of applicantSockets(app.deviceId)) {
    if (iv.status !== "open") s.ivWindow = false;
    s.emit("interview", payload);
  }
}

function pushStaff(app) {
  if (!io()) return;
  const online = onlineSet();
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !s.ivHello || !canView(s)) continue;
    s.emit("staff interview row", row(app, s, online));
    if (s.ivOpen === app.id) s.emit("staff interview", staffThread(app, s));
  }
}

function refreshStatus(app) {
  if (!ctx.statusFor || !isLatest(app)) return;
  const st = ctx.statusFor(app.deviceId);
  for (const s of applicantSockets(app.deviceId)) s.emit("mod application status", st);
}

function markRead(app, socket) {
  const iv = store[app.id];
  if (!iv) return;
  iv.read = iv.read || {};
  const k = idKey(staffOf(socket));
  const prev = iv.read[k] || 0;
  iv.read[k] = Math.max(prev, iv.lastTs || 0);
  const la = lastFrom(iv, "applicant");
  if (la && la.ts > (iv.staffSeen || 0)) {
    iv.staffSeen = la.ts;
    pushApplicant(app);
  }
  if (iv.read[k] !== prev) {
    saveSoon();
    if (!io()) return socket.emit("staff interview row", row(app, socket));
    for (const [, s] of io().sockets.sockets)
      if (s.connected && s.ivHello && canView(s) && idKey(staffOf(s)) === k)
        s.emit("staff interview row", row(app, s));
  }
}

function toggleReaction(m, key, e) {
  m.reactions = m.reactions || [];
  let r = m.reactions.find((x) => x.e === e);
  if (!r) {
    if (m.reactions.length >= REACTION_KINDS) return false;
    r = { e, by: [] };
    m.reactions.push(r);
  }
  const i = r.by.indexOf(key);
  if (i === -1) r.by.push(key);
  else r.by.splice(i, 1);
  m.reactions = m.reactions.filter((x) => x.by.length);
  return true;
}

function touch(app) {
  if (app && ctx) pushStaff(app);
}

function onDecision(app, decision, socket) {
  const iv = app && store[app.id];
  if (!iv) return touch(app);
  const w = staffOf(socket);
  if (iv.status === "open") {
    iv.status = "ended";
    iv.endedAt = Date.now();
    iv.endedBy = w;
  }
  addMessage(iv, {
    from: "system",
    event: decision === "approve" ? "approved" : "rejected",
    by: w.label,
    role: w.role,
  });
  pushStaff(app);
  pushApplicant(app, { kind: "decision" });
}

function onAnswer(app, accepted) {
  const iv = app && store[app.id];
  if (!iv) return touch(app);
  addMessage(iv, {
    from: "system",
    event: accepted ? "accepted" : "withdrawn",
    name: app.username || null,
  });
  pushStaff(app);
  pushApplicant(app);
}

function greet(socket) {
  if (!socket.deviceId || isStaff(socket)) return;
  const app = apps().latestForDevice(socket.deviceId);
  if (!app) return;
  const iv = store[app.id];
  if (iv) socket.emit("interview", applicantPayload(app, iv));
  if (app.status === "pending" || iv) pushStaff(app);
}

function init(context) {
  ctx = context;
  prune();
  setInterval(prune, 60 * 60 * 1000).unref();
}

function register(socket, safe) {
  const result = (action, ok, extra) =>
    socket.emit("staff interview result", { action, ok, ...(extra || {}) });

  const appFor = (data) => {
    const id = Number(data && data.appId);
    return id ? apps().get(id) : null;
  };

  socket.on(
    "staff interview list",
    safe(async () => {
      if (!canView(socket)) return;
      socket.ivHello = true;
      socket.emit("staff interview list", { rows: rowsFor(socket), reactions: REACTIONS });
    }),
  );

  socket.on(
    "staff interview open",
    safe(async (data) => {
      if (!canView(socket)) return;
      const id = Number(data && data.appId) || null;
      socket.ivOpen = id;
      if (!id) return;
      const app = apps().get(id);
      if (!app) {
        socket.ivOpen = null;
        return socket.emit("staff interview", { appId: id, missing: true });
      }
      markRead(app, socket);
      socket.emit("staff interview", staffThread(app, socket));
    }),
  );

  socket.on(
    "staff interview read",
    safe(async (data) => {
      if (!canView(socket)) return;
      const app = appFor(data);
      if (!app || socket.ivOpen !== app.id) return;
      markRead(app, socket);
    }),
  );

  socket.on(
    "staff interview start",
    safe(async (data) => {
      if (!canView(socket))
        return result("start", false, { error: "Interviews are for full mods and up." });
      const app = appFor(data);
      if (!app || app.status !== "pending")
        return result("start", false, { error: "This application is no longer pending." });
      let iv = store[app.id];
      if (iv && iv.status === "open")
        return result("start", false, { error: "The interview is already open." });
      if (iv && !canLead(socket))
        return result("start", false, {
          error: "Only mod leaders and admins can reopen an interview.",
        });
      const w = staffOf(socket);
      const now = Date.now();
      let kind;
      if (!iv) {
        iv = store[app.id] = {
          appId: app.id,
          deviceId: app.deviceId,
          status: "open",
          startedAt: now,
          startedBy: w,
          endedAt: null,
          endedBy: null,
          seq: 0,
          lastTs: 0,
          messages: [],
          read: {},
          applicantSeen: 0,
          staffSeen: 0,
          avatar: null,
        };
        addMessage(iv, { from: "system", event: "start", by: w.label, role: w.role });
        kind = "invite";
      } else {
        iv.status = "open";
        iv.endedAt = null;
        iv.endedBy = null;
        addMessage(iv, { from: "system", event: "reopen", by: w.label, role: w.role });
        kind = "reopened";
      }
      iv.read[idKey(w)] = iv.lastTs;
      ctx.logStaff(
        socket,
        kind === "invite" ? "start interview" : "reopen interview",
        { id: app.deviceId, username: app.username },
        "-",
      );
      pushStaff(app);
      pushApplicant(app, { kind });
      refreshStatus(app);
      if (ctx.changed) ctx.changed();
      result("start", true, { appId: app.id, reopened: kind === "reopened" });
    }),
  );

  socket.on(
    "staff interview send",
    safe(async (data) => {
      if (!canView(socket)) return;
      const app = appFor(data);
      const iv = app && store[app.id];
      if (!iv || iv.status !== "open")
        return result("send", false, { error: "This interview is not open." });
      const now = Date.now();
      if (now - (lastSend.get(socket) || 0) < STAFF_GAP_MS)
        return result("send", false, { error: "Slow down a little." });
      const text = cleanText(data && data.text, STAFF_MAX);
      if (!text) return;
      lastSend.set(socket, now);
      const w = staffOf(socket);
      addMessage(iv, {
        from: "staff",
        by: w.label,
        role: w.role,
        level: w.level,
        avatar: cleanAvatar(socket.handshake?.session?.avatar),
        text,
      });
      iv.read[idKey(w)] = iv.lastTs;
      pushStaff(app);
      pushApplicant(app, { kind: "message" });
    }),
  );

  socket.on(
    "staff interview end",
    safe(async (data) => {
      if (!canLead(socket))
        return result("end", false, {
          error: "Only mod leaders and admins can end an interview.",
        });
      const app = appFor(data);
      const iv = app && store[app.id];
      if (!iv || iv.status !== "open")
        return result("end", false, { error: "This interview is not open." });
      const w = staffOf(socket);
      iv.status = "ended";
      iv.endedAt = Date.now();
      iv.endedBy = w;
      addMessage(iv, { from: "system", event: "end", by: w.label, role: w.role });
      ctx.logStaff(socket, "end interview", { id: app.deviceId, username: app.username }, "-");
      pushStaff(app);
      pushApplicant(app, { kind: "ended" });
      refreshStatus(app);
      if (ctx.changed) ctx.changed();
      result("end", true, { appId: app.id });
    }),
  );

  socket.on(
    "staff interview react",
    safe(async (data) => {
      if (!canView(socket)) return;
      const app = appFor(data);
      const iv = app && store[app.id];
      if (!iv || iv.status !== "open") return;
      const e = typeof data?.e === "string" ? data.e : "";
      if (!REACTIONS.includes(e)) return;
      const m = iv.messages.find((x) => x.id === data?.id && x.from !== "system");
      if (!m) return;
      if (!toggleReaction(m, "s:" + idKey(staffOf(socket)), e)) return;
      saveSoon();
      pushStaff(app);
      pushApplicant(app);
    }),
  );

  socket.on(
    "staff interview typing",
    safe(async (data) => {
      if (!canView(socket)) return;
      const now = Date.now();
      if (now - (lastTyping.get(socket) || 0) < TYPING_GAP_MS) return;
      const app = appFor(data);
      const iv = app && store[app.id];
      if (!iv || iv.status !== "open") return;
      lastTyping.set(socket, now);
      const w = staffOf(socket);
      if (isLatest(app))
        for (const s of applicantSockets(app.deviceId))
          s.emit("interview typing", { name: publicName(w.label, w.role) });
      if (!io()) return;
      for (const [, s] of io().sockets.sockets) {
        if (s === socket || !s.connected || s.ivOpen !== app.id || !canView(s)) continue;
        if (s.staffLabel === socket.staffLabel && !!s.isDev === !!socket.isDev) continue;
        s.emit("staff interview typing", {
          appId: app.id,
          name: staffName(w.label, w.role, s),
          applicant: false,
        });
      }
    }),
  );

  const mine = () => {
    if (!socket.deviceId || isStaff(socket)) return null;
    const app = apps().latestForDevice(socket.deviceId);
    const iv = app && store[app.id];
    return iv ? { app, iv } : null;
  };
  const refuse = (error) => socket.emit("interview error", { error });

  socket.on(
    "interview get",
    safe(async () => {
      const m = mine();
      socket.emit("interview", m ? applicantPayload(m.app, m.iv) : { has: false });
    }),
  );

  socket.on(
    "interview send",
    safe(async (data) => {
      const m = mine();
      if (!m) return refuse("There is no interview for you right now.");
      if (m.iv.status !== "open") return refuse("The interview has ended.");
      const now = Date.now();
      if (now - (lastSend.get(socket) || 0) < APPLICANT_GAP_MS)
        return refuse("Wait a moment before sending again.");
      const count = m.iv.messages.reduce((n, x) => n + (x.from === "applicant" ? 1 : 0), 0);
      if (count >= APPLICANT_CAP)
        return refuse("This interview has reached its message limit.");
      const text = cleanText(data && data.text, APPLICANT_MAX);
      if (!text) return;
      lastSend.set(socket, now);
      const avatar = cleanAvatar(socket.handshake?.session?.avatar);
      if (avatar) m.iv.avatar = avatar;
      addMessage(m.iv, { from: "applicant", text, avatar });
      m.iv.applicantSeen = m.iv.lastTs;
      pushApplicant(m.app);
      pushStaff(m.app);
    }),
  );

  socket.on(
    "interview window",
    safe(async (data) => {
      const m = mine();
      socket.ivWindow = !!(data && data.open) && !!m && m.iv.status === "open";
    }),
  );

  socket.on(
    "interview seen",
    safe(async () => {
      const m = mine();
      if (!m) return;
      const ls = lastFrom(m.iv, "staff");
      if (!ls || ls.ts <= (m.iv.applicantSeen || 0)) return;
      m.iv.applicantSeen = ls.ts;
      saveSoon();
      if (!io()) return;
      for (const [, s] of io().sockets.sockets)
        if (s.connected && s.ivOpen === m.app.id && canView(s))
          s.emit("staff interview seen", { appId: m.app.id, ts: ls.ts });
    }),
  );

  socket.on(
    "interview typing",
    safe(async () => {
      const m = mine();
      if (!m || m.iv.status !== "open") return;
      const now = Date.now();
      if (now - (lastTyping.get(socket) || 0) < TYPING_GAP_MS) return;
      lastTyping.set(socket, now);
      if (!io()) return;
      for (const [, s] of io().sockets.sockets)
        if (s.connected && s.ivOpen === m.app.id && canView(s))
          s.emit("staff interview typing", {
            appId: m.app.id,
            name: m.app.username || "Applicant",
            applicant: true,
          });
    }),
  );

  socket.on(
    "interview react",
    safe(async (data) => {
      const m = mine();
      if (!m || m.iv.status !== "open") return;
      const e = typeof data?.e === "string" ? data.e : "";
      if (!REACTIONS.includes(e)) return;
      const msg = m.iv.messages.find((x) => x.id === data?.id && x.from === "staff");
      if (!msg) return;
      if (!toggleReaction(msg, "a", e)) return;
      saveSoon();
      pushApplicant(m.app);
      pushStaff(m.app);
    }),
  );

  if (socket.deviceId && !isStaff(socket))
    socket.on("disconnect", () => {
      const app = apps().latestForDevice(socket.deviceId);
      if (!app || (app.status !== "pending" && !store[app.id])) return;
      setTimeout(() => pushStaff(app), 100);
    });
}

load();

module.exports = {
  init,
  register,
  greet,
  touch,
  onDecision,
  onAnswer,
  stateFor,
  summary,
  flushSync,
  REACTIONS,
};
