// server/devicetoken.js
// Server-signed device identity. A browser gets one signed token in an
// httpOnly cookie; the id inside it is the device identity bans and identity
// tracking key on, and the stable userId is derived from it one-way. Clients
// never see the token from script and cannot mint or forge an id.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { DATA_DIR } = require("./datadir");

const COOKIE_NAME = "tk_device";
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const SECRET_PATH = path.join(DATA_DIR, "device-secret.json");

// Signing survives restarts: SESSION_SECRET when configured, otherwise a
// generated secret persisted next to the other stores.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const s = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
    if (s && typeof s.secret === "string" && s.secret.length >= 32)
      return s.secret;
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading device-secret.json:", err);
  }
  const secret = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(SECRET_PATH, JSON.stringify({ secret }));
  } catch (e) {
    console.error("device-secret save failed:", e);
  }
  return secret;
}

const KEY = crypto
  .createHash("sha256")
  .update("tk-device:" + loadSecret())
  .digest();

function sign(id) {
  return crypto
    .createHmac("sha256", KEY)
    .update("device:" + id)
    .digest("base64url");
}

function issue() {
  const id = crypto.randomUUID();
  return { id, token: id + "." + sign(id) };
}

function verify(token) {
  if (typeof token !== "string" || token.length > 200) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    return null;
  const given = Buffer.from(token.slice(dot + 1));
  const good = Buffer.from(sign(id));
  if (given.length !== good.length) return null;
  return crypto.timingSafeEqual(given, good) ? id : null;
}

// One-way: the public userId reveals nothing about the token and cannot be
// chosen or reproduced by a client.
function userIdFor(id) {
  return crypto
    .createHmac("sha256", KEY)
    .update("user:" + id)
    .digest("base64url")
    .slice(0, 32);
}

function idFromCookieHeader(header) {
  if (typeof header !== "string" || !header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_) {}
    return verify(value);
  }
  return null;
}

function middleware(req, res, next) {
  let id = req.cookies ? verify(req.cookies[COOKIE_NAME]) : null;
  if (!id) {
    const t = issue();
    id = t.id;
    res.cookie(COOKIE_NAME, t.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: MAX_AGE_MS,
    });
  }
  req.deviceId = id;
  next();
}

module.exports = {
  COOKIE_NAME,
  middleware,
  issue,
  verify,
  userIdFor,
  idFromCookieHeader,
};
