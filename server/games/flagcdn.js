// server/games/flagcdn.js
// Flag images, fetched once from flagcdn.net and then served from here.

const crypto = require("crypto");

const SIZE = "w640";
const ORIGIN = "https://flagcdn.com";
const FETCH_TIMEOUT_MS = 8000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

const images = new Map();
const tokens = new Map();

function sweep() {
  const now = Date.now();
  for (const [t, rec] of tokens)
    if (now - rec.at > TOKEN_TTL_MS) tokens.delete(t);
}
setInterval(sweep, 10 * 60 * 1000).unref();

function tokenFor(code) {
  const token = crypto.randomBytes(12).toString("hex");
  tokens.set(token, { code, at: Date.now() });
  return token;
}

function codeForToken(token) {
  const rec = tokens.get(String(token || ""));
  return rec ? rec.code : null;
}

async function download(code) {
  const url = `${ORIGIN}/${SIZE}/${encodeURIComponent(code)}.png`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Talkomatic/1.0 (+https://talkomatic.co)" },
    });
    if (!res.ok) throw new Error("flagcdn " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("empty flag");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

function imageFor(code) {
  const hit = images.get(code);
  if (hit && hit.buf) return Promise.resolve(hit.buf);
  if (hit && hit.pending) return hit.pending;
  const pending = download(code)
    .then((buf) => {
      images.set(code, { buf, at: Date.now() });
      return buf;
    })
    .catch((err) => {
      images.delete(code);
      throw err;
    });
  images.set(code, { pending });
  return pending;
}

function warm(codes) {
  for (const code of codes) imageFor(code).catch(() => {});
}

function has(code) {
  const hit = images.get(code);
  return !!(hit && hit.buf);
}

module.exports = { tokenFor, codeForToken, imageFor, warm, has, SIZE };
