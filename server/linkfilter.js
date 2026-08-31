// server/linkfilter.js
// Links are not shareable on Talkomatic, except for the admin-managed list of
// allowed domains at the bottom of this file.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");

const SKIP =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u3164\ufeff\uffa0\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f]/;

const FOLD = { "。": ".", "．": ".", "｡": ".", "˙": ".", "․": "." };
for (const [from, to] of Object.entries(
  require("./confusables.json").map,
)) {
  if (from.codePointAt(0) < 0x80) continue;
  if (!/^[a-z0-9./-]$/.test(to)) continue;
  FOLD[from] = to;
}

const SPACE = /\s/;
const CACHE = new Map();

function foldChar(ch) {
  let v = CACHE.get(ch);
  if (v !== undefined) return v;
  let mapped = "";
  for (const c of ch.normalize("NFKC")) mapped += FOLD[c] || c;
  v = mapped
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  if (CACHE.size < 8192) CACHE.set(ch, v);
  return v;
}

function scan(value) {
  let text = "";
  const map = [];
  let at = 0;
  for (const ch of value) {
    const start = at;
    at += ch.length;
    if (SKIP.test(ch)) continue;
    for (const c of foldChar(ch)) {
      text += c;
      map.push(start);
    }
  }
  map.push(value.length);
  return { text, map, src: value };
}

function tighten(scanned) {
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(scanned.text)) !== null)
    toks.push({ s: m.index, e: m.index + m[0].length, solo: m[0].length === 1 });

  const join = new Array(toks.length).fill(false);
  for (let i = 0; i < toks.length; ) {
    if (!toks[i].solo) {
      i++;
      continue;
    }
    let j = i;
    while (j < toks.length && toks[j].solo) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) join[k] = true;
    i = j;
  }

  let text = "";
  const map = [];
  for (let n = 0; n < toks.length; n++) {
    if (n > 0 && !(join[n] && join[n - 1])) {
      text += " ";
      map.push(scanned.map[toks[n - 1].e]);
    }
    for (let p = toks[n].s; p < toks[n].e; p++) {
      text += scanned.text[p];
      map.push(scanned.map[p]);
    }
  }
  map.push(scanned.map[scanned.map.length - 1]);
  return { text, map, src: scanned.src };
}

function closeUp(scanned) {
  let text = "";
  const map = [];
  for (let i = 0; i < scanned.text.length; i++) {
    if (SPACE.test(scanned.text[i])) continue;
    text += scanned.text[i];
    map.push(scanned.map[i]);
  }
  map.push(scanned.map[scanned.map.length - 1]);
  return { text, map, src: scanned.src };
}

const TLD = new Set(
  (
    "ac ad ae af ag ai al ao aq ar au aw ax az ba bb bd bf bg bh bi bj bm " +
    "bn bo br bs bt bw bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw " +
    "cx cy cz de dj dk dm dz ec ee eg eh er es et eu fi fj fk fm fo fr ga " +
    "gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hn hr ht hu " +
    "ie il io iq ir je jm jo jp ke kg kh ki km kn kp kr kw ky kz lb lc li " +
    "lk lr ls lt lu lv ly ma mc md mg mh mk ml mm mn mo mp mq mr mt mu mv " +
    "mw mx mz na nc nf ng ni nl np nr nu nz om pa pe pf pg ph pk pl pm pn " +
    "pr ps pt pw py qa ro rs ru rw sa sb sc sd se sg si sj sk sl sm sn sr " +
    "ss su sv sx sy sz tc td tf tg th tj tk tl tm tn tr tt tv tw tz ua ug " +
    "uk uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw " +
    "com net org info biz xyz app dev site online club tech store pro edu " +
    "gov mil int aero asia coop jobs mobi museum tel xxx cloud email " +
    "network systems solutions services group zone wiki blog media video " +
    "photo gallery pics tube agency digital studio design website webcam " +
    "buzz exchange market deals gift bank fund capital credit loans insure " +
    "clinic doctor legal fitness dating singles community forum events " +
    "tickets tours flights hotel restaurant cafe pizza kitchen recipes " +
    "sports bike auto cars taxi moto software computer codes tools center " +
    "company enterprises industries ventures holdings partners associates " +
    "consulting management marketing careers education academy institute " +
    "school college university training courses reviews ninja rocks wtf " +
    "ooo icu cyou cfd sbs quest bond monster makeup boutique jewelry " +
    "clothing shoes bags fashion beauty"
  ).split(/\s+/),
);

const DOT =
  "(?:\\.|\\s+\\.\\s+|\\s*[\\[({<]\\s*(?:\\.|d[o0]t|period)\\s*[\\])}>]\\s*|\\s+d[o0]t\\s+)";
const LEET = {
  "0": ["o"],
  "1": ["i", "l"],
  "3": ["e"],
  "4": ["a"],
  "5": ["s"],
  "6": ["g"],
  "7": ["t"],
  "8": ["b"],
  "9": ["g"],
};

function deLeet(tld) {
  let out = [""];
  for (const ch of tld) {
    const opts = LEET[ch] || [ch];
    const next = [];
    for (const pre of out) for (const o of opts) next.push(pre + o);
    if (next.length > 16) return next.slice(0, 16);
    out = next;
  }
  return out;
}

function isTld(tld) {
  if (TLD.has(tld) || tld.startsWith("xn--")) return true;
  if (!/\d/.test(tld) || !/[a-z]/.test(tld)) return false;
  for (const alt of deLeet(tld)) if (TLD.has(alt)) return true;
  return false;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SCHEME = "[a-z][a-z0-9+.*-]{1,14}\\s*:\\s*\\/\\s*\\/";

const LINK = new RegExp(
  "(" + SCHEME + "[^\\s<>\"']*)" +
    "|((" +
    LABEL +
    "(?:" +
    DOT +
    LABEL +
    "){0,8})" +
    DOT +
    "((?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{1,23})" +
    "(:\\d{1,5})?" +
    "([\\/?#][^\\s<>\"']*)?)",
  "dgi",
);

const TRAILING = /[.,!?;:)\]}'"]+$/;

const DEFAULT_LABEL = "[link removed]";

// The cheap gate for the space-for-dot tier: a word followed by one of its
// no-evidence TLDs ("skribbl io"). The full pass still decides.
const SPACED_HINT = /[a-z0-9]\s+(?:com|org|io|co)(?![a-z0-9])/i;

function looksLikeLink(value) {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    (value.includes(".") ||
      value.includes("/") ||
      value.includes(":") ||
      /d\s*[o0]\s*t|period/i.test(value) ||
      SWAP_SHAPE.test(value) ||
      pairedWeak(value) ||
      SPACED_HINT.test(value) ||
      /[。．｡․]/.test(value))
  );
}

// A "port" whose characters sat apart in the original text, or one followed
// by another colon, is prose ("time: 5:32", "score: 5/10"), not a port.
function phonyPort(m, scanned) {
  if (!m[5]) return false;
  if (scanned.text[m.index + m[0].length] === ":") return true;
  const idx = m.indices && m.indices[5];
  if (!idx || typeof scanned.src !== "string") return false;
  const span = scanned.src.slice(scanned.map[idx[0]], scanned.map[idx[1]]);
  return /\s/.test(span);
}

// strict is set for passes that rewrite the text before matching (spaces
// removed, punctuation swapped for dots). Those rewrites manufacture
// host-shaped strings out of ordinary prose - "the comment. Do /untarget"
// collapses to "comment.do/untarget" - so a made-up TLD there cannot be
// rescued by port/path evidence the way it can in the original text.
function rangesIn(scanned, out, weak, strict) {
  const { text, map } = scanned;
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(text)) !== null) {
    if (m[0] === "") {
      LINK.lastIndex++;
      continue;
    }
    if (!m[1]) {
      if (phonyPort(m, scanned)) continue;
      const labels = m[3] || "";
      const tld = m[4] || "";
      const tail = m[6] || "";
      const evidence =
        !!m[5] ||
        tail.startsWith("/") ||
        tail.length >= 2 ||
        /^www\b/.test(labels);
      if (weak) {
        if (!weakHost(labels, tld, tail, !!m[5])) continue;
      } else {
        if (/\d/.test(tld)) {
          if (!isTld(tld)) continue;
        } else if (!TLD.has(tld) && !tld.startsWith("xn--")) {
          if (strict || !evidence) continue;
        }
        if (/^\d+$/.test(labels) && !evidence) continue;
      }
    } else if (weak) continue;
    const trimmed = m[0].replace(TRAILING, "");
    if (!trimmed) continue;
    out.push([map[m.index], map[m.index + trimmed.length]]);
  }
}

const MARKER = /(?:^|[^a-z0-9])www\s*\./i;

function markerRange(scanned, out) {
  const m = MARKER.exec(scanned.text);
  if (!m) return;
  const at = m.index + m[0].toLowerCase().indexOf("www");
  out.push([scanned.map[at], scanned.map[scanned.map.length - 1]]);
}

const SWAPPABLE = "!,;*#~^=+&%$|";
const SWAP_SHAPE = /[a-z0-9][!,;*#~^=+&%$|][a-z0-9]/;

function swapRanges(scanned, out) {
  if (!SWAP_SHAPE.test(scanned.text)) return;
  for (const ch of SWAPPABLE) {
    if (!scanned.text.includes(ch)) continue;
    rangesIn(
      { ...scanned, text: scanned.text.split(ch).join(".") },
      out,
      false,
      true,
    );
  }
}

const JUNK = /[|()\[\]{}<>!*#~^=+&%$]/;

function stripJunk(scanned) {
  let text = "";
  const map = [];
  for (let i = 0; i < scanned.text.length; i++) {
    if (JUNK.test(scanned.text[i])) continue;
    text += scanned.text[i];
    map.push(scanned.map[i]);
  }
  map.push(scanned.map[scanned.map.length - 1]);
  return { text, map, src: scanned.src };
}

// People swap the dot for a plain space: "skribbl io", "talkomatic co",
// "discord gg/CODE". Rewriting every space as a dot would flag half of
// ordinary chat ("the store", "watch tv", "safety net" are all real TLD
// shapes), so this is the strictest tier: without a path or port attached,
// only a handful of TLDs that barely exist as English words count, the word
// before the TLD must not be an everyday one, and only the host itself is
// flagged rather than the sentence around it. Accepted misses, in line with
// the other second-class swap tiers: a bare "discord gg" with no invite code
// attached, and word-like TLDs ("safety net", "that was fun gg").
const SPACED_STOP = new Set(
  (
    "a an the and or of to in on at as is are was were be been being by for " +
    "with from not no yes ok okay yeah nah it its this that these those " +
    "there their they them then than you your yours we our ours us me my " +
    "mine he she his her hers him had has have having do does did done im " +
    "ive id ill youre theyre weve dont wont cant isnt arent wasnt didnt " +
    "go goes going gone get gets got getting let lets like liked just " +
    "really very so but if because when what who whom how why where which " +
    "while will would can could should shall may might must one two three " +
    "too also more most much many some any every all each both few out up " +
    "down off over under again once here now new old good bad big small " +
    "long short high low right wrong left next last first second only own " +
    "same other another such well even never always often sometimes maybe " +
    "please thanks thank sorry hello hi hey bye see saw seen say says said " +
    "come came comes back still yet after before about against between " +
    "during without within into onto want wants wanted need needs needed " +
    "know knows knew think thinks thought make makes made take takes took " +
    "play plays played game games fun nice cool great wanna gonna gotta " +
    "kinda sorta dot www com net org"
  ).split(/\s+/),
);

// Whitespace runs between letters or digits become a single dot; everything
// else is left alone so the rest of the text still reads as prose.
function spaceDots(scanned) {
  const t = scanned.text;
  let text = "";
  const map = [];
  let i = 0;
  while (i < t.length) {
    if (SPACE.test(t[i])) {
      let j = i;
      while (j < t.length && SPACE.test(t[j])) j++;
      const prev = text[text.length - 1] || "";
      const next = t[j] || "";
      text += /[a-z0-9]/.test(prev) && /[a-z0-9]/.test(next) ? "." : " ";
      map.push(scanned.map[i]);
      i = j;
      continue;
    }
    text += t[i];
    map.push(scanned.map[i]);
    i++;
  }
  map.push(scanned.map[scanned.map.length - 1]);
  return { text, map, src: scanned.src };
}

// The general LINK regex reads a dotted-up sentence as one giant host, which
// buries the real one ("come.play.skribbl.io.with.us" ends in "us"). These
// two shapes find the host inside the sentence instead: name.tld standing on
// its own, and name.tld with a path or port hanging off it.
const SPACED_NAKED = /([a-z0-9][a-z0-9-]{2,62})\.(com|org|io|co)(?![a-z0-9-])/g;
const SPACED_TAILED =
  /([a-z0-9][a-z0-9-]{2,62})\.([a-z0-9]{2,24})(?::\d{1,5})?\/[^\s<>"']*/g;

function spacedRanges(scanned, out) {
  const sp = spaceDots(scanned);
  if (sp.text === scanned.text) return;
  const { text, map } = sp;
  const scanShape = (re, checkTld) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (checkTld && !TLD.has(m[2])) continue;
      // The word before the TLD is the name being shared; an everyday word
      // there means this is a sentence, not a host.
      if (m[1].length < 3 || SPACED_STOP.has(m[1])) continue;
      // Never start mid-word; a dot before is fine ("www skribbl io").
      const before = text[m.index - 1];
      if (before && /[a-z0-9-]/.test(before)) continue;
      const trimmed = m[0].replace(TRAILING, "");
      out.push([map[m.index], map[m.index + trimmed.length]]);
    }
  };
  scanShape(SPACED_NAKED, false);
  scanShape(SPACED_TAILED, true);
}

const WEAK_ANY = /[-_‐-―⁃־－＿]/g;
const WEAK_PAIR = /[a-z0-9][-_‐-―⁃־－＿](?=[a-z0-9])/gi;

const STOP = new Set(
  "an the and or of to in on at as is are be by for with from not".split(" "),
);

function pairedWeak(value) {
  WEAK_PAIR.lastIndex = 0;
  return WEAK_PAIR.test(value) && WEAK_PAIR.test(value);
}

function weakHost(labels, tld, tail, port) {
  const parts = labels ? labels.split(".") : [];
  if (!parts.length) return false;
  for (const part of parts) if (STOP.has(part)) return false;
  if (parts.every((part) => part === tld)) return false;
  const real = isTld(tld);
  const hard = port || tail.startsWith("/") || parts[0] === "www";
  return parts.length >= 2 ? real || hard : real && hard;
}

function weakRanges(scanned, out) {
  WEAK_ANY.lastIndex = 0;
  if (!WEAK_ANY.test(scanned.text)) return;
  rangesIn(
    { ...scanned, text: scanned.text.replace(WEAK_ANY, ".") },
    out,
    true,
  );
}

const WEAK_ONE = /[-_‐-―⁃־－＿]/;
const SPELL = new RegExp(
  "(?:[a-z0-9.][ \\t]*" +
    "[-_\\u2010-\\u2015\\u2043\\u05be\\uff0d\\uff3f]" +
    "[ \\t]*){2,}[a-z0-9.]",
  "g",
);

function unspell(scanned) {
  SPELL.lastIndex = 0;
  if (!SPELL.test(scanned.text)) return null;
  SPELL.lastIndex = 0;
  const drop = new Array(scanned.text.length).fill(false);
  let m;
  while ((m = SPELL.exec(scanned.text)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      const c = scanned.text[i];
      if (WEAK_ONE.test(c) || c === " " || c === "\t") drop[i] = true;
    }
  }
  let text = "";
  const map = [];
  for (let i = 0; i < scanned.text.length; i++) {
    if (drop[i]) continue;
    text += scanned.text[i];
    map.push(scanned.map[i]);
  }
  map.push(scanned.map[scanned.map.length - 1]);
  return { text, map, src: scanned.src };
}

const TOLD = [
  /(?:replac|swap|switch|chang|sub|substitut)\w*\s+(?:the|a|an|all|every|each)?\s*(?:letters?|chars?|characters?|symbols?)?\s*['"]?(\S)['"]?\s*'?s?\s*(?:with|for|to|into|=)\s+(?:a|an|the)?\s*(?:\.|dots?|periods?|full\s*stops?)/i,
  /(?:use|put|add|type|write|imagine|pretend)\s+(?:a|an|the)?\s*(?:\.|dots?|periods?|full\s*stops?)\s*(?:instead\s+of|in\s+place\s+of|rather\s+than|not)\s+(?:the|a|an|every|each)?\s*(?:letters?|chars?|characters?|symbols?)?\s*['"]?(\S)['"]?/i,
  /(?:^|\s)['"]?(\S)['"]?\s*(?:=|is|are|means?|equals?)\s*(?:a|an|the)?\s*(?:\.|dots?|periods?|full\s*stops?)(?![a-z0-9])/i,
];

function namedChars(scanned) {
  const chars = [];
  for (const re of TOLD) {
    const m = re.exec(scanned.text);
    if (!m) continue;
    const ch = m[1];
    if (!ch || ch === "." || /["'`\s]/.test(ch)) continue;
    if (chars.indexOf(ch) === -1) chars.push(ch);
  }
  return chars;
}

function toldRanges(scanned, chars, out) {
  for (const ch of chars) {
    if (!scanned.text.includes(ch)) continue;
    rangesIn({ ...scanned, text: scanned.text.split(ch).join(".") }, out);
  }
}

// ── Allowed domains ─────────────────────────────────────────────────────────
// Admin-managed hosts that may be shared in chat. Matching is exact on
// purpose: youtube.com covers youtube.com and www.youtube.com and nothing
// else - not other subdomains, and never youtube.com as a label inside
// somebody else's host. Identity fields (names, locations, room names) pass
// ignoreAllowed and keep blocking everything.

const ALLOW_PATH = path.join(DATA_DIR, "link-whitelist.json");
const HOST_OK =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DOT_ALL = new RegExp(DOT, "gi");

let allowedHosts = ["youtube.com"];
let allowSaveTimer = null;

function loadAllowed() {
  try {
    const arr = JSON.parse(fs.readFileSync(ALLOW_PATH, "utf8"));
    if (Array.isArray(arr))
      allowedHosts = arr.filter(
        (h) => typeof h === "string" && h.length <= 253 && HOST_OK.test(h),
      );
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading link-whitelist.json:", err);
  }
}

function saveAllowedSoon() {
  if (allowSaveTimer) return;
  allowSaveTimer = setTimeout(async () => {
    allowSaveTimer = null;
    try {
      const tmp = ALLOW_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(allowedHosts, null, 2), "utf8");
      await fsp.rename(tmp, ALLOW_PATH);
    } catch (e) {
      console.error("link-whitelist save failed:", e);
    }
  }, 500);
}

// "https://www.YouTube.com/watch?v=x" typed into the admin form becomes
// "youtube.com".
function normalizeEntry(input) {
  let s = String(input || "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const cut = s.search(/[\/?#]/);
  if (cut !== -1) s = s.slice(0, cut);
  const at = s.lastIndexOf("@");
  if (at !== -1) s = s.slice(at + 1);
  s = s.replace(/:\d+$/, "").replace(/\.+$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s || s.length > 253 || !HOST_OK.test(s)) return null;
  return s;
}

function listAllowed() {
  return allowedHosts.slice();
}

function addAllowed(input) {
  const host = normalizeEntry(input);
  if (!host) return { ok: false };
  if (!allowedHosts.includes(host)) {
    allowedHosts.push(host);
    allowedHosts.sort();
    saveAllowedSoon();
  }
  return { ok: true, host };
}

function removeAllowed(input) {
  const host = normalizeEntry(input);
  if (!host) return false;
  const i = allowedHosts.indexOf(host);
  if (i === -1) return false;
  allowedHosts.splice(i, 1);
  saveAllowedSoon();
  return true;
}

function hostAllowed(host) {
  return (
    allowedHosts.includes(host) ||
    (host.startsWith("www.") && allowedHosts.includes(host.slice(4)))
  );
}

// Splits normalized link text (lowercase, real dots, no spaces) into host and
// tail, the way a browser would read it: scheme off the front, userinfo cut
// at the last @ so "youtube.com@evil.com" resolves to evil.com, then an
// optional numeric port. Null means it does not parse as one clean URL.
function splitUrlish(text) {
  const sm = /^[a-z][a-z0-9+.*-]{1,14}:\/\//.exec(text);
  let host = sm ? text.slice(sm[0].length) : text;
  let tail = "";
  const cut = host.search(/[/?#:]/);
  if (cut !== -1) {
    tail = host.slice(cut);
    host = host.slice(0, cut);
  }
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  if (tail.startsWith(":")) {
    const pm = /^:\d{1,5}/.exec(tail);
    if (!pm) return null;
    tail = tail.slice(pm[0].length);
    if (tail && !/^[/?#]/.test(tail)) return null;
  }
  return { host: host.replace(/\.+$/, ""), tail };
}

// A second host hiding in an allowed link's path or query - a redirector
// target, "?q=evil.com" - keeps the whole thing blocked.
function tailSmuggles(tail) {
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(tail)) !== null) {
    if (m[0] === "") {
      LINK.lastIndex++;
      continue;
    }
    let host;
    if (m[1]) {
      const parts = splitUrlish(m[1].replace(/\s+/g, ""));
      if (!parts) return true;
      host = parts.host;
    } else {
      const tld = m[4] || "";
      if (
        !TLD.has(tld) &&
        !tld.startsWith("xn--") &&
        !(/\d/.test(tld) && isTld(tld))
      )
        continue;
      host = (m[3] + "." + tld).replace(DOT_ALL, ".").replace(/\s+/g, "");
    }
    if (!hostAllowed(host)) return true;
  }
  return false;
}

// A flagged range passes only when the WHOLE range reads as one link to an
// allowed host: [scheme://][user@]host[:port][/tail]. A host glued to prose
// the parser cannot split, or anything extra inside the range, keeps it
// blocked - blocked is the safe direction.
function allowedRange(value, start, end) {
  const dotted = scan(value.slice(start, end)).text.replace(DOT_ALL, ".");
  // Two readings of leftover spaces: stripped out ("y o u t u b e . c o m")
  // and standing in for dots ("youtube com"). Allowed if either parses to an
  // allowed host.
  const variants = [dotted.replace(/\s+/g, "")];
  if (/\s/.test(dotted.trim())) variants.push(dotted.trim().replace(/\s+/g, "."));
  for (const v of variants) {
    const text = v.replace(TRAILING, "");
    const parts = splitUrlish(text);
    if (!parts) continue;
    if (!HOST_OK.test(parts.host) || !hostAllowed(parts.host)) continue;
    if (!parts.tail || !tailSmuggles(parts.tail)) return true;
  }
  return false;
}

loadAllowed();

function findRanges(value, ignoreAllowed) {
  const found = [];
  if (!looksLikeLink(value)) return found;
  const loose = scan(value);
  rangesIn(loose, found);
  const extra = [];
  const chars = namedChars(loose);
  markerRange(loose, extra);
  swapRanges(loose, extra);
  weakRanges(loose, extra);
  toldRanges(loose, chars, extra);
  const spelled = unspell(loose);
  if (spelled) {
    rangesIn(spelled, extra);
    markerRange(spelled, extra);
  }
  if (JUNK.test(loose.text)) rangesIn(stripJunk(loose), extra, false, true);
  if (SPACE.test(loose.text)) {
    rangesIn(tighten(loose), found);
    spacedRanges(loose, extra);
    const closed = closeUp(loose);
    rangesIn(closed, extra, false, true);
    markerRange(closed, extra);
    swapRanges(closed, extra);
    toldRanges(closed, chars, extra);
    if (JUNK.test(closed.text))
      rangesIn(stripJunk(closed), extra, false, true);
  }
  for (const r of extra)
    if (!found.some((f) => r[0] < f[1] && f[0] < r[1])) found.push(r);
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  if (ignoreAllowed || !allowedHosts.length) return merged;
  return merged.filter((r) => !allowedRange(value, r[0], r[1]));
}

function redact(value, label, ignoreAllowed) {
  const ranges = findRanges(value, ignoreAllowed);
  if (!ranges.length) return value;
  const tag = label || DEFAULT_LABEL;
  let out = "";
  let last = 0;
  for (const [start, end] of ranges) {
    if (start < last) continue;
    out += value.slice(last, start) + tag;
    last = end;
  }
  return out + value.slice(last);
}

function containsLink(value, ignoreAllowed) {
  return findRanges(value, ignoreAllowed).length > 0;
}

module.exports = {
  redact,
  containsLink,
  looksLikeLink,
  listAllowed,
  addAllowed,
  removeAllowed,
  DEFAULT_LABEL,
};
