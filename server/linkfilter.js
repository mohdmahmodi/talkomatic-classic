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
  "(?:\\.|\\s+\\.\\s+|\\s*[\\[({<]\\s*(?:\\.|dot|d0t)\\s*[\\])}>]\\s*|\\s+dot\\s+)";
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
    "([a-z][a-z0-9-]{1,23})" +
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
      /dot/i.test(value) ||
      /[。．｡․]/.test(value))
  );
}

function rangesIn({ text, map }, out) {
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
      if (!TLD.has(tld) && !tld.startsWith("xn--") && !evidence) continue;
      if (/^\d+$/.test(labels) && !evidence) continue;
    }
    const trimmed = m[0].replace(TRAILING, "");
    if (!trimmed) continue;
    out.push([map[m.index], map[m.index + trimmed.length]]);
  }
}

const MARKER = /(?:^|[^a-z0-9])wwws*./i;

function markerRange(scanned, out) {
  const m = MARKER.exec(scanned.text);
  if (!m) return;
  const at = m.index + m[0].toLowerCase().indexOf("www");
  out.push([scanned.map[at], scanned.map[scanned.map.length - 1]]);
}
function findRanges(value) {
  const found = [];
  if (!looksLikeLink(value)) return found;
  const loose = scan(value);
  rangesIn(loose, found);
  const extra = [];
  if (SPACE.test(loose.text)) {
    rangesIn(tighten(loose), found);
    rangesIn(closeUp(loose), extra);
    markerRange(closeUp(loose), extra);
  }
  markerRange(loose, extra);
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
