// server/linkfilter.js
// Links are not shareable on Talkomatic.

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
  return { text, map };
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
  return { text, map };
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
  return { text, map };
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
  "gi",
);

const TRAILING = /[.,!?;:)\]}'"]+$/;

const DEFAULT_LABEL = "[link removed]";

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
      /[。．｡․]/.test(value))
  );
}

function rangesIn({ text, map }, out, weak) {
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(text)) !== null) {
    if (m[0] === "") {
      LINK.lastIndex++;
      continue;
    }
    if (!m[1]) {
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
        } else if (!TLD.has(tld) && !tld.startsWith("xn--") && !evidence)
          continue;
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
    rangesIn({ text: scanned.text.split(ch).join("."), map: scanned.map }, out);
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
  return { text, map };
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
    { text: scanned.text.replace(WEAK_ANY, "."), map: scanned.map },
    out,
    true,
  );
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
    rangesIn({ text: scanned.text.split(ch).join("."), map: scanned.map }, out);
  }
}

function findRanges(value) {
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
  if (JUNK.test(loose.text)) rangesIn(stripJunk(loose), extra);
  if (SPACE.test(loose.text)) {
    rangesIn(tighten(loose), found);
    const closed = closeUp(loose);
    rangesIn(closed, extra);
    markerRange(closed, extra);
    swapRanges(closed, extra);
    toldRanges(closed, chars, extra);
    if (JUNK.test(closed.text)) rangesIn(stripJunk(closed), extra);
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
  return merged;
}

function redact(value, label) {
  const ranges = findRanges(value);
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

function containsLink(value) {
  return findRanges(value).length > 0;
}

module.exports = { redact, containsLink, looksLikeLink, DEFAULT_LABEL };
