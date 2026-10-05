// server/clientdetails.js

const identity = require("./identity");
const devicetoken = require("./devicetoken");

const VERSION = 1;
const SHARED = /apple gpu|apple m\d|swiftshader|llvmpipe|softpipe|basic render|virtualbox|vmware|svga3d|parallels|offscreen/i;
const HANDHELD = /adreno|mali|powervr|videocore/i;
const HASH = /^[0-9a-f]{16}$/;

const text = (v, max) => (typeof v === "string" && v.length ? v.slice(0, max) : null);
const whole = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null);

function family(ua, touch) {
  const s = String(ua || "");
  let os = "other";
  if (/iPhone|iPad|iPod/.test(s)) os = "ios";
  else if (/Android/.test(s)) os = "android";
  else if (/CrOS/.test(s)) os = "chromeos";
  else if (/Windows/.test(s)) os = "windows";
  else if (/Mac OS X|Macintosh/.test(s)) os = touch > 1 ? "ios" : "mac";
  else if (/Linux|X11/.test(s)) os = touch > 0 ? "android" : "linux";
  let engine = "other";
  if (os === "ios") engine = "webkit";
  else if (/Firefox\//.test(s)) engine = "firefox";
  else if (/Chrome\/|Chromium\//.test(s)) engine = "chromium";
  else if (/Safari\//.test(s)) engine = "webkit";
  return { os, engine };
}

function graphics(raw) {
  const s = text(raw, 250);
  if (!s) return null;
  return s
    .toLowerCase()
    .replace(/[-\s]*\d+(\.\d+){2,}[^,)|]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function read(socket, data) {
  const d = data && typeof data === "object" ? data : {};
  const headers = (socket.handshake && socket.handshake.headers) || {};
  const touch = whole(d.touch, 0, 64) || 0;
  const { os, engine } = family(headers["user-agent"], touch);
  const shield = d.shield === true;
  const gl = graphics(d.graphics);
  const canvas = HASH.test(d.canvas || "") ? d.canvas : null;
  const audio = HASH.test(d.audio || "") ? d.audio : null;
  const glGood = !!gl && !SHARED.test(gl) && !shield;
  const canvasGood = !!canvas && d.canvasNoisy !== true && engine === "chromium" && !shield;
  const hardware = engine === "chromium" && !shield ? (whole(d.cores, 1, 512) || 0) + "/" + (whole(d.memory, 0, 512) || 0) : "";
  const model = (text(d.model, 64) || "").split("|")[0];
  const desktop = (os === "windows" || os === "mac" || os === "linux") && !HANDHELD.test(gl || "");
  const grade = shield || os === "ios" ? 0 : glGood && canvasGood && desktop ? 2 : glGood ? 1 : 0;
  const tz = text(d.tz, 40);
  const screen = text(d.screen, 12);
  return {
    v: whole(d.v, 1, 99) || VERSION,
    at: Date.now(),
    os,
    br: engine,
    tz: tz && /^[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : null,
    off: whole(d.offset, -900, 900),
    lang: text(d.langs, 60),
    scr: screen && /^\d{2,5}x\d{2,5}$/.test(screen) ? screen : null,
    grade,
    core: grade
      ? devicetoken.seal(["core", os, engine, gl, canvasGood ? canvas : "", hardware, touch, whole(d.depth, 1, 64) || 0, model].join("~"))
      : null,
    gl: gl ? devicetoken.seal("gl~" + gl) : null,
    cv: canvasGood ? devicetoken.seal("cv~" + canvas) : null,
    au: audio && d.audioNoisy !== true && !shield ? devicetoken.seal("au~" + audio) : null,
    shield,
    driven: d.driven === true,
  };
}

function accept(socket, data) {
  if (!socket || socket.detailsAt) return;
  socket.detailsAt = Date.now();
  try {
    socket.clientDetails = read(socket, data);
    settle(socket);
  } catch (_) {
    socket.clientDetails = null;
  }
}

function settle(socket) {
  if (!socket || !socket.clientDetails || socket.detailsSaved) return;
  if (identity.setClient(socket.deviceId, socket.clientDetails)) socket.detailsSaved = true;
}

function odd(socket) {
  const headers = (socket && socket.handshake && socket.handshake.headers) || {};
  const out = [];
  if (!headers.origin) out.push("origin");
  if (!headers["user-agent"]) out.push("browser name");
  return out;
}

function of(deviceId) {
  const rec = identity.getRecord(deviceId);
  return (rec && rec.cl) || null;
}

function register(socket, safe) {
  socket.on(
    "client details",
    safe(async (data) => accept(socket, data)),
  );
}

module.exports = { register, accept, settle, odd, of, read, family, VERSION };
