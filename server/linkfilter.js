// server/linkfilter.js
// Links are not shareable on Talkomatic. This is the one place that decides
// what counts as one, for every surface that has to take them out (room
// textboxes, the board, the games feed) or turn them away (names).

const SKIP =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u3164\ufeff\uffa0\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f]/;

const FOLD = {
  "。": ".", "．": ".", "｡": ".", "˙": ".", "․": ".",
  "∕": "/", "⁄": "/", "／": "/",
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c",
  т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ԛ: "q",
  ԝ: "w", ѡ: "w", ɡ: "g", ⅼ: "l", ⅰ: "i", ᴏ: "o", ᴀ: "a",
  α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u",
};

// Returns the scanned form plus map[i] = index in `value` of scanned char i,
// so a hit resolves back to the span the person actually typed. The original
// is never rewritten.
function normalize(value) {
  let text = "";
  const map = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (SKIP.test(ch)) continue;
    let out = FOLD[ch];
    if (out === undefined) {
      const code = ch.charCodeAt(0);
      out =
        code >= 0xff01 && code <= 0xff5e
          ? String.fromCharCode(code - 0xfee0)
          : ch;
    }
    out = out.toLowerCase();
    for (let k = 0; k < out.length; k++) {
      text += out[k];
      map.push(i);
    }
  }
  map.push(value.length);
  return { text, map };
}

// Read on its own. Anything not here needs a scheme, a leading www, a port or
// a path before it is treated as an address, so ordinary sentences survive.
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

// Leave the sentence its own punctuation.
const TRAILING = /[.,!?;:)\]}'"]+$/;

const DEFAULT_LABEL = "[link removed]";

// Cheap gate. This sits on the room broadcast path, once per batch of
// keystrokes per speaker, so ordinary chat must not reach the pattern.
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

// Ranges into the original string, [start, end).
function findRanges(value) {
  const ranges = [];
  if (!looksLikeLink(value)) return ranges;
  const { text, map } = normalize(value);
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
      const evidence = !!(m[5] || m[6]) || /^www\b/.test(labels);
      if (!TLD.has(tld) && !tld.startsWith("xn--") && !evidence) continue;
      if (/^\d+$/.test(labels) && !evidence) continue;
    }
    const trimmed = m[0].replace(TRAILING, "");
    if (!trimmed) continue;
    ranges.push([map[m.index], map[m.index + trimmed.length]]);
  }
  return ranges;
}

// Replaces every link in `value` with `label`. Non-strings and strings without
// one come back untouched, so a nullable field can be passed straight in.
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

// For inputs that are refused rather than rewritten. A username or a room name
// cannot be shown as a placeholder - the roster and the lobby have to stay
// readable - so those are turned away at the door instead.
function containsLink(value) {
  return findRanges(value).length > 0;
}

module.exports = { redact, containsLink, looksLikeLink, DEFAULT_LABEL };
