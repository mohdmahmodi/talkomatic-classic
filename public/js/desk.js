// public/js/desk.js
// The Desk - staff chat and shift console, mounted on every page. The page's
// own script calls TalkoDesk.init(socket); the Desk then asks the server
// "desk hello" and only builds any interface at all if the server answers,
// so a normal user's page never shows a trace of it.
//
// Layout is the familiar messenger shape: channels down the left, the
// conversation in the middle, who-is-on down the right. On a phone the rails
// become drawers and the panel takes the whole screen.
//
// Everything user-authored is rendered with textContent. No innerHTML ever
// touches message text, names, room names, or notes.

(function () {
  "use strict";
  if (window.TalkoDesk) return;

  // ── State ─────────────────────────────────────────────────────────────────
  let socket = null;
  let me = null; // { label, role, level, alias }
  let channels = []; // [{key, name, desc, restricted}]
  let threads = []; // thread summaries
  let unread = {}; // key -> { n, mentions }
  let presence = { staff: [], rooms: [] };
  let view = { kind: "channel", key: "floor" }; // or kind:"thread"
  let mode = "chat"; // chat | inspector | search
  let inspectorRoom = null;
  let searchHits = null;
  let panelOpen = false;
  let mounted = false;
  let showArchived = false;
  let soundOn = localStorage.getItem("talkomatic_deskSound") === "1";
  let audioCtx = null;
  let readTimer = null;
  // /desk.html: the Desk owns the whole window - no pill, no close button.
  let pageMode = false;
  const drafts = new Map(); // key -> composer text not yet sent
  const caches = new Map(); // key -> { messages, hasMore, loaded, detached, newWhile }

  const els = {}; // pill, badge, panel, rail, main, side, list, composer...

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(fa) {
    const i = document.createElement("i");
    i.className = "fas " + fa;
    i.setAttribute("aria-hidden", "true");
    return i;
  }
  function btn(cls, label, fa, title) {
    const b = el("button", cls);
    b.type = "button";
    if (fa) b.appendChild(icon(fa));
    if (label) b.appendChild(document.createTextNode(label));
    if (title) b.title = title;
    return b;
  }
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  function clockTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }
  function dayKey(ts) {
    const d = new Date(ts || 0);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }
  function dayLabel(ts) {
    const today = new Date();
    if (dayKey(ts) === dayKey(today.getTime())) return "Today";
    if (dayKey(ts) === dayKey(today.getTime() - 86400000)) return "Yesterday";
    try {
      return new Date(ts).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
    } catch (_) {
      return new Date(ts).toDateString();
    }
  }

  const rankOf = (a) =>
    !a ? null : a.role === "dev" ? "dev" : (a.level || 2) >= 2 ? "l2" : "l1";
  const rankName = (r) =>
    r === "dev" ? "DEV" : r === "l2" ? "MOD L2" : "MOD L1";

  // First visible character of a name, without splitting a surrogate pair -
  // charAt(0) turns fancy unicode names into broken squares.
  function initialOf(name) {
    const c = Array.from(String(name || "?").trim())[0];
    return (c || "?").toUpperCase();
  }

  // Discord avatar URL, rebuilt from the validated snowflake + hash the
  // server stores - same rule as the rooms, never a raw URL from data.
  const PFP_ID_RE = /^\d{17,20}$/;
  const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;
  // The same builder the lobby and the rooms use, character for character.
  // The Desk had its own, and it was wrong twice: it only read `id` (the
  // stored shape is sometimes `discordId`, which is why some people had no
  // picture here but did in rooms), and it dropped `animated`, which is why
  // the animated ones were showing as a still frame.
  function avatarUrl(av, size) {
    if (!av) return null;
    const id = av.discordId || av.id;
    if (!PFP_ID_RE.test(id || "") || !PFP_HASH_RE.test(av.hash || ""))
      return null;
    return (
      "https://cdn.discordapp.com/avatars/" +
      id +
      "/" +
      av.hash +
      ".webp?size=" +
      (size || 64) +
      (av.animated ? "&animated=true" : "")
    );
  }

  // Everybody's picture, remembered by staff label. Payloads disagree about
  // who carries one: presence rows have it, offline roster rows never do, and
  // an old message carries whatever was true when it was sent. Rendering
  // straight from whichever payload happened to arrive is why faces came and
  // went. Once seen, a picture is used everywhere that person appears.
  const avatarMemory = new Map(); // lowercase label -> avatar

  function rememberAvatar(label, av) {
    if (!label || !av || !avatarUrl(av)) return;
    avatarMemory.set(String(label).toLowerCase(), av);
  }

  function avatarFor(person) {
    if (!person) return null;
    if (person.avatar && avatarUrl(person.avatar)) {
      rememberAvatar(person.label, person.avatar);
      return person.avatar;
    }
    return avatarMemory.get(String(person.label || "").toLowerCase()) || null;
  }

  // The round face next to a message or presence row: their picture when they
  // have one, their initial when they do not.
  // Pictures that have loaded at least once. The panel re-renders constantly -
  // every presence tick rebuilds the side pane - and each rebuild asks the CDN
  // for the picture again. One hiccup used to replace it with a letter for the
  // rest of the session, which is why faces kept vanishing. A URL that has
  // worked before gets one retry before giving up.
  const avatarSeen = new Set();

  function faceEl(author, cls) {
    const wrap = el(
      "span",
      "dk-av " + (cls || "") + " " + (rankOf(author) || ""),
    );
    // The initial is ALWAYS there, underneath. The picture sits on top of it,
    // so a slow or failed load shows a letter rather than an empty circle, and
    // nothing has to be swapped in later.
    wrap.appendChild(el("span", "dk-av-i", initialOf(author && author.label)));
    // Their last known picture, not just whatever this payload carried.
    const url = avatarUrl(avatarFor(author), 64);
    if (!url) return wrap;
    const img = document.createElement("img");
    // Not lazy: these are 26px and live in lists that re-render under the
    // scroll position, where a deferred load often never happens at all.
    img.loading = "eager";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    let retried = false;
    img.addEventListener("load", () => avatarSeen.add(url));
    img.addEventListener("error", () => {
      // A picture that has loaded before gets one retry: a single CDN hiccup
      // used to drop somebody's face for the rest of the session. One that has
      // never loaded is simply gone, and the letter underneath shows through.
      if (avatarSeen.has(url) && !retried) {
        retried = true;
        setTimeout(() => {
          img.src = url + "&r=1";
        }, 400);
        return;
      }
      img.remove();
    });
    img.src = url;
    wrap.appendChild(img);
    return wrap;
  }

  // ── Names: #channels and @people ──────────────────────────────────────────
  // Both are written the same way you write them anywhere else, and both are
  // matched against a known list rather than a pattern - staff labels can have
  // spaces and punctuation in them, so "anything after an @" would guess wrong
  // more often than it guessed right.
  let nameIndex = null; // { re, people: Map(lowercase label -> person) }

  function forgetNames() {
    nameIndex = null;
  }

  // Anything that arrives with a picture on it teaches the memory. Called on
  // every presence tick, roster push and message, so a face only has to be
  // seen once to keep showing up.
  function learnAvatars(list) {
    for (const s of list || []) if (s && s.label) rememberAvatar(s.label, s.avatar);
  }

  function channelLabel(key) {
    const c = channels.find((x) => x.key === key);
    if (c) return "#" + c.name;
    const t = threads.find((x) => x.id === key);
    return t ? t.title : "the Desk";
  }

  // Everyone who can be mentioned: the whole team from the roster, with
  // whoever is on right now folded in so the list is right even before the
  // roster lands.
  function mentionPeople() {
    const by = new Map();
    const add = (s, online) => {
      if (!s || !s.label) return;
      const k = s.label.toLowerCase();
      const row = by.get(k);
      if (row) {
        if (online) row.online = true;
        if (!row.avatar && s.avatar) row.avatar = s.avatar;
        return;
      }
      by.set(k, {
        label: s.label,
        role: s.role || "mod",
        level: s.level,
        avatar: s.avatar || null,
        online: !!online,
      });
    };
    for (const s of roster || []) add(s, !s.offline);
    for (const s of (presence && presence.staff) || []) add(s, true);
    return [...by.values()].sort(
      (a, b) =>
        (b.online ? 1 : 0) - (a.online ? 1 : 0) ||
        a.label.localeCompare(b.label),
    );
  }

  // Group mentions: one @ instead of eight names. Exclusive by design -
  // "@L2 mods" is the full mods, not the developers as well; somebody after a
  // developer says "@devs" and somebody after the lot says "@everyone". The
  // server keeps the same table and decides who is actually reached.
  const MENTION_GROUPS = [
    {
      key: "everyone",
      write: "everyone",
      name: "@everyone",
      tokens: ["everyone", "all"],
      desc: "Everybody holding a staff key",
      // Symmetric glyphs only in these chips: a bullhorn points right and its
      // weight sits left, so it reads as badly centred however it is boxed.
      icon: "fa-users",
    },
    {
      key: "l2",
      write: "L2 mods",
      name: "@L2 mods",
      tokens: ["l2 mods", "full mods", "l2"],
      desc: "Full moderators",
      icon: "fa-user-shield",
    },
    {
      key: "l1",
      write: "L1 mods",
      name: "@L1 mods",
      tokens: ["l1 mods", "jr mods", "junior mods", "juniors", "l1"],
      desc: "Junior moderators",
      icon: "fa-user-plus",
    },
    {
      key: "dev",
      write: "devs",
      name: "@devs",
      tokens: ["devs", "developers"],
      desc: "Developers only",
      icon: "fa-code",
    },
  ];
  const GROUP_BY_TOKEN = new Map();
  for (const g of MENTION_GROUPS)
    for (const t of g.tokens) GROUP_BY_TOKEN.set(t, g);

  const myRole = () => (me && me.role === "dev" ? "dev" : "mod");
  const myLevel = () => (me && me.role === "dev" ? 0 : (me && me.level) || 2);
  function inGroup(key, role, level) {
    if (key === "everyone") return true;
    if (key === "dev") return role === "dev";
    if (key === "l2") return role !== "dev" && (level || 2) >= 2;
    if (key === "l1") return role !== "dev" && (level || 2) === 1;
    return false;
  }
  // How many people a group actually reaches, so the palette can say so
  // before you send it rather than after.
  function groupReach(key) {
    const people = mentionPeople();
    const hit = people.filter((p) => inGroup(key, p.role, p.level));
    return { n: hit.length, on: hit.filter((p) => p.online).length };
  }

  // Places that behave like a channel when you write them, but are not on the
  // server: the guide is a page, not a conversation, and pointing somebody at
  // it should work the same way as pointing at #floor.
  const VIRTUAL_CHANNELS = [
    {
      key: "$guide",
      name: "guide",
      alt: ["how this works"],
      desc: "How the Desk works - the whole guide",
      icon: "fa-circle-question",
      open: () => openHelp(),
    },
  ];
  const virtualChannel = (nm) => {
    const low = String(nm || "").toLowerCase();
    return (
      VIRTUAL_CHANNELS.find(
        (v) => v.name === low || (v.alt || []).includes(low),
      ) || null
    );
  };

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function names() {
    if (nameIndex) return nameIndex;
    const people = mentionPeople();
    const alt = (arr, sigil) => {
      const list = arr.filter(Boolean);
      if (!list.length) return null;
      // Longest first, so "#floorplan" is never matched as "#floor", and
      // "@l2 mods" is never matched as "@l2" with "mods" left dangling.
      return (
        sigil +
        "(?:" +
        list
          .slice()
          .sort((a, b) => b.length - a.length)
          .map(escRe)
          .join("|") +
        ")"
      );
    };
    const parts = [
      alt(
        channels
          .map((c) => c.name)
          .concat(
            VIRTUAL_CHANNELS.flatMap((v) => [v.name].concat(v.alt || [])),
          ),
        "#",
      ),
      alt(
        people.map((p) => p.label).concat([...GROUP_BY_TOKEN.keys()]),
        "@",
      ),
    ].filter(Boolean);
    nameIndex = {
      re: parts.length ? new RegExp(parts.join("|"), "gi") : null,
      people: new Map(people.map((p) => [p.label.toLowerCase(), p])),
    };
    return nameIndex;
  }

  function chanLink(token) {
    const nm = token.slice(1);
    const v = virtualChannel(nm);
    if (v) {
      const b = el("button", "dk-chanlink", "#" + nm);
      b.type = "button";
      b.title = v.desc;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        v.open();
      });
      return b;
    }
    const ch = channels.find((c) => c.name.toLowerCase() === nm.toLowerCase());
    const b = el("button", "dk-chanlink", "#" + (ch ? ch.name : nm));
    b.type = "button";
    if (!ch) return b;
    b.title = ch.desc ? "#" + ch.name + " - " + ch.desc : "Open #" + ch.name;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openView({ kind: "channel", key: ch.key });
    });
    return b;
  }

  function mentionChip(token) {
    const nm = token.slice(1);
    const g = GROUP_BY_TOKEN.get(nm.toLowerCase());
    if (g) {
      // A group reads as a group: it is not one person's name, and whether it
      // is aimed at you is the first thing you want to know.
      const hits = inGroup(g.key, myRole(), myLevel());
      const s = el("span", "dk-ment group" + (hits ? " self" : ""), "@" + nm);
      const reach = groupReach(g.key);
      s.title =
        g.desc +
        " - " +
        reach.n +
        (reach.n === 1 ? " person" : " people") +
        ", " +
        reach.on +
        " on now" +
        (hits ? ". That includes you." : ". Not aimed at you.");
      return s;
    }
    const self = !!me && nm.toLowerCase() === String(me.label).toLowerCase();
    const p = names().people.get(nm.toLowerCase());
    const s = el("span", "dk-ment" + (self ? " self" : ""), "@" + nm);
    s.title = self
      ? "This one is you"
      : p && p.online
        ? nm + " is on now"
        : nm + " is off - it is waiting for them";
    return s;
  }

  // #channels and @names picked out of a run of plain text. Everything that is
  // not a known name stays a text node, so nothing user-authored is ever
  // parsed as markup.
  function namesInto(parent, text) {
    const re = names().re;
    if (!re || !text) {
      if (text) parent.appendChild(document.createTextNode(text));
      return;
    }
    re.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index;
      const tok = m[0];
      const before = at > 0 ? text[at - 1] : "";
      const after = text[at + tok.length] || "";
      // Not a name in the middle of a word, an email, or another token.
      if (/[\w@#]/.test(before) || /[\w]/.test(after)) continue;
      if (at > last)
        parent.appendChild(document.createTextNode(text.slice(last, at)));
      parent.appendChild(tok[0] === "#" ? chanLink(tok) : mentionChip(tok));
      last = at + tok.length;
    }
    if (last < text.length)
      parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // ── Emotes ────────────────────────────────────────────────────────────────
  // The same set the rooms use, from the same file, written the same way: a
  // code between colons. Fetched once, the first time a staff member opens the
  // Desk, so a page belonging to anybody else never asks for it.
  const EMOTE_BASE =
    "https://raw.githubusercontent.com/ZackiBoiz/Multiplayer-Piano-Optimizations/refs/heads/main/emotes";
  const EMOTE_EXT = /^(?:png|gif|webp|jpe?g|avif|heif|tiff|bmp|svg)$/i;
  let emotes = {}; // code -> url
  let emotesAsked = false;

  // meta.jsonc is JSON with comments in it, and a comment of "*" is how the
  // file marks an emote that is not meant to be offered. Both are read the
  // same way the room client reads them, so the two never disagree about
  // which codes exist.
  function parseEmoteMeta(src) {
    const out = {};
    const body = String(src).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const raw of body.split("\n")) {
      const cut = raw.indexOf("//");
      if (
        cut !== -1 &&
        raw
          .slice(cut + 2)
          .split(";")
          .some((t) => t.trim() === "*")
      )
        continue;
      const line = cut === -1 ? raw : raw.slice(0, cut);
      const m = /"([A-Za-z0-9_.-]+)"\s*:\s*"([A-Za-z0-9]+)"/.exec(line);
      if (m && EMOTE_EXT.test(m[2]))
        out[m[1]] = EMOTE_BASE + "/assets/" + m[1] + "." + m[2];
    }
    return out;
  }

  async function loadEmotes() {
    if (emotesAsked) return;
    emotesAsked = true;
    try {
      const resp = await fetch(EMOTE_BASE + "/meta.jsonc?_=" + Date.now(), {
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const next = parseEmoteMeta(await resp.text());
      // Only a non-empty answer counts: a blank one would turn every emote in
      // the channel back into the text it was typed as.
      if (!Object.keys(next).length) return;
      emotes = next;
      if (panelOpen && mode === "chat") renderMessages(true);
    } catch (_) {
      // A GitHub blip is not worth saying anything about. The codes stay as
      // typed, and the next page load asks again.
    }
  }

  function emoteImg(code, cls) {
    const img = document.createElement("img");
    img.className = "dk-emote" + (cls ? " " + cls : "");
    img.src = emotes[code];
    img.alt = ":" + code + ":";
    img.title = ":" + code + ":";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    return img;
  }

  // ── Markdown, the small useful half of it ─────────────────────────────────
  // `code`, **bold**, __bold__, ~~strike~~, *italic*, _italic_, links, bullet
  // lists and ``` blocks. Deliberately not a markdown engine: no HTML is ever
  // parsed, every leaf is a text node, and anything that does not match a rule
  // is left exactly as it was typed.
  const MD_SRC =
    "(`+)([\\s\\S]+?)\\1" + // 1,2 code span
    "|\\*\\*([\\s\\S]+?)\\*\\*" + // 3 bold
    "|__([\\s\\S]+?)__" + // 4 bold
    "|~~([\\s\\S]+?)~~" + // 5 strike
    "|\\*([^*\\n]+?)\\*" + // 6 italic
    "|_([^_\\n]+?)_" + // 7 italic
    "|(https?:\\/\\/[^\\s<>]+)" + // 8 link
    // 9 emote. Here rather than in a pass of its own so it competes with the
    // emphasis rules on position: ":kappa_pride: :some_thing:" starts with a
    // colon, so it is claimed as two emotes instead of one stray italic run
    // between the two underscores.
    "|:([A-Za-z0-9_.-]{1,40}):"; // 9 emote

  // Trailing punctuation is nearly always the sentence, not the address.
  function trimUrl(u) {
    let end = u.length;
    while (end > 0 && /[.,!?;:'"]/.test(u[end - 1])) end--;
    // Keep a closing bracket only when the address opened one.
    while (
      end > 0 &&
      u[end - 1] === ")" &&
      (u.slice(0, end).match(/\(/g) || []).length <
        (u.slice(0, end).match(/\)/g) || []).length
    )
      end--;
    return u.slice(0, end);
  }

  function linkEl(url) {
    const a = document.createElement("a");
    a.className = "dk-link";
    a.href = url;
    a.textContent = url.length > 70 ? url.slice(0, 67) + "..." : url;
    a.title = url;
    a.target = "_blank";
    // Staff chat is not a place to leak a referrer or hand a tab opener out.
    a.rel = "noopener noreferrer nofollow";
    a.addEventListener("click", (e) => e.stopPropagation());
    return a;
  }

  function inlineInto(parent, text) {
    if (!text) return;
    // A fresh regex per call: this recurses into emphasis, and a shared
    // lastIndex across those levels would eat text.
    const re = new RegExp(MD_SRC, "g");
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index;
      const before = at > 0 ? text[at - 1] : "";
      // snake_case and file_names are not italics.
      if (
        m[7] != null &&
        (/\w/.test(before) || /\w/.test(text[re.lastIndex] || ""))
      )
        continue;
      if (at > last) namesInto(parent, text.slice(last, at));
      last = at + m[0].length;
      if (m[2] != null) {
        parent.appendChild(el("code", "dk-code-in", m[2]));
      } else if (m[3] != null || m[4] != null) {
        const b = el("strong", "dk-b");
        inlineInto(b, m[3] != null ? m[3] : m[4]);
        parent.appendChild(b);
      } else if (m[5] != null) {
        const s = el("s", "dk-s");
        inlineInto(s, m[5]);
        parent.appendChild(s);
      } else if (m[6] != null || m[7] != null) {
        const i = el("em", "dk-i");
        inlineInto(i, m[6] != null ? m[6] : m[7]);
        parent.appendChild(i);
      } else if (m[8] != null) {
        const url = trimUrl(m[8]);
        parent.appendChild(linkEl(url));
        last = at + url.length;
        re.lastIndex = last;
      } else if (m[9] != null) {
        // A code nobody has an image for is just something somebody typed.
        if (emotes[m[9]]) parent.appendChild(emoteImg(m[9]));
        else parent.appendChild(document.createTextNode(m[0]));
      }
    }
    if (last < text.length) namesInto(parent, text.slice(last));
  }

  // Block level: fenced code, bullet lists, and paragraphs of lines.
  function textEl(text, cls) {
    const wrap = el("span", cls || "dk-mtext");
    const src = String(text == null ? "" : text);
    const lines = src.split("\n");
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el("span", "dk-p");
      para.forEach((ln, i) => {
        if (i) p.appendChild(document.createElement("br"));
        inlineInto(p, ln);
      });
      wrap.appendChild(p);
      para = [];
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i]))
          buf.push(lines[i++]);
        i++; // the closing fence, if it is there
        const pre = el("pre", "dk-code-bl");
        pre.textContent = buf.join("\n");
        wrap.appendChild(pre);
        continue;
      }
      if (/^\s*[-*+]\s+\S/.test(line)) {
        flush();
        const ul = el("ul", "dk-ul");
        while (i < lines.length && /^\s*[-*+]\s+\S/.test(lines[i])) {
          const li = document.createElement("li");
          inlineInto(li, lines[i].replace(/^\s*[-*+]\s+/, ""));
          ul.appendChild(li);
          i++;
        }
        wrap.appendChild(ul);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return wrap;
  }

  // ── Sounds and toasts ─────────────────────────────────────────────────────
  // The beep only ever fires after the user has interacted with the Desk, so
  // it can never hit an autoplay block or surprise a fresh page.
  function beep() {
    if (!soundOn) return;
    try {
      audioCtx =
        audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 740;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.2);
    } catch (_) {}
  }

  // One question, one answer. Uses the themed StaffUI prompt when the page
  // has it (all three pages do) and falls back to the native one otherwise,
  // so the Desk never depends on another script being healthy.
  function ask(opts, cb) {
    if (window.StaffUI && window.StaffUI.prompt) {
      window.StaffUI.prompt({
        title: opts.title,
        icon: opts.icon || '<i class="fas fa-comments"></i>',
        message: opts.message || "",
        fields: [
          {
            name: "v",
            label: opts.label || "",
            placeholder: opts.placeholder || "",
            value: opts.value || "",
            maxLength: opts.max || 200,
          },
        ],
      }).then((r) => {
        if (r && typeof r.v === "string") cb(r.v);
      });
    } else {
      const v = window.prompt(opts.title, opts.value || "");
      if (v != null) cb(v);
    }
  }

  let toastTimer = null;
  function toast(text) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }

  // ── Cache ─────────────────────────────────────────────────────────────────
  function cacheFor(key) {
    if (!caches.has(key))
      caches.set(key, {
        messages: [],
        hasMore: false,
        loaded: false,
        // A search jump shows an old window of the conversation. While it is
        // up, live messages are counted instead of appended, so the reader is
        // never teleported and the window never grows gaps.
        detached: false,
        newWhile: 0,
      });
    return caches.get(key);
  }
  function upsert(key, msg) {
    const c = cacheFor(key);
    const i = c.messages.findIndex((m) => m.id === msg.id);
    if (i !== -1) {
      c.messages[i] = msg;
      return "updated";
    }
    c.messages.push(msg);
    if (c.messages.length > 400) c.messages.shift();
    return "appended";
  }

  const viewKey = () => view.key;
  const viewingNow = (key) =>
    panelOpen &&
    mode === "chat" &&
    viewKey() === key &&
    !cacheFor(key).detached &&
    document.hasFocus();

  // ── Unread and badges ─────────────────────────────────────────────────────
  function bumpUnread(key, mention) {
    const u = unread[key] || { n: 0, mentions: 0 };
    u.n++;
    if (mention) u.mentions++;
    unread[key] = u;
  }
  function markRead(key) {
    const c = cacheFor(key);
    const last = c.messages[c.messages.length - 1];
    unread[key] = { n: 0, mentions: 0 };
    renderBadges();
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (socket)
        socket.emit("desk read", { key, ts: last ? last.ts : Date.now() });
    }, 400);
  }
  function totals() {
    let n = 0;
    let loud = 0;
    for (const k in unread) {
      n += unread[k].n || 0;
      loud += unread[k].mentions || 0;
    }
    // Red is reserved for #help. Everything else - ordinary talk, even a
    // mention - stays the usual orange, so red on the dock button means one
    // thing only: somebody in a room is waiting for staff.
    let help = (unread.help && unread.help.n) || 0;
    // An unclaimed call for backup keeps it red until somebody takes it, even
    // after the card itself has been read.
    for (const m of cacheFor("help").messages)
      if (m.ping && (m.ping.status === "open" || m.ping.status === "waiting"))
        help++;
    return { n, loud, help };
  }
  function renderBadges() {
    const t = totals();
    if (els.badge) {
      els.badge.textContent = t.n > 99 ? "99+" : String(t.n);
      els.badge.style.display = t.n ? "" : "none";
      els.badge.classList.toggle("loud", t.help > 0);
    }
    // The button itself carries the alarm too: a bare count can be missed on a
    // busy page, an outlined red button cannot.
    if (els.pill) els.pill.classList.toggle("urgent", t.help > 0);
    // The pop-out window has no pill, so the unread count lives in its title.
    if (pageMode)
      document.title =
        (t.n ? "(" + (t.n > 99 ? "99+" : t.n) + ") " : "") +
        "The Desk - Talkomatic";
    if (els.rail) renderRail();
  }

  // ── Socket wiring ─────────────────────────────────────────────────────────
  function init(sock) {
    if (!sock || socket) return;
    socket = sock;

    socket.on("desk ready", (d) => {
      if (!d || !d.me) return;
      me = d.me;
      channels = d.channels || [];
      threads = d.threads || [];
      unread = d.unread || {};
      presence = d.presence || presence;
      learnAvatars(presence.staff);
      forgetNames();
      if (!channels.some((c) => c.key === viewKey()) && view.kind === "channel")
        view = {
          kind: "channel",
          key: channels[0] ? channels[0].key : "floor",
        };
      mount();
      renderBadges();
      // The whole team, up front: "@" has to be able to offer somebody who is
      // not on right now, which is exactly when you most need to leave them a
      // message.
      socket.emit("desk roster");
      if (pageMode && !panelOpen) setOpen(true);
      else if (panelOpen) {
        renderAll();
        loadView(true);
        // A reconnect can land while the inspector is up; its snapshot is
        // stale by definition, so ask for the room again.
        if (mode === "inspector" && inspectorRoom)
          socket.emit("desk room info", { roomId: inspectorRoom.roomId });
      }
    });

    socket.on("desk message", (d) => {
      if (!d || !d.msg) return;
      if (d.msg.author) rememberAvatar(d.msg.author.label, d.msg.author.avatar);
      const c = cacheFor(d.key);
      let change;
      if (c.detached && !d.updated) {
        // Reading an old window: count it instead of appending, and let the
        // "back to the latest" button carry the number.
        c.newWhile++;
        change = "held";
      } else {
        change = upsert(d.key, d.msg);
      }
      const mention =
        d.msg.mention ||
        (me &&
          d.msg.text &&
          d.msg.text.toLowerCase().includes("@" + me.label.toLowerCase()));
      if (change !== "updated" && !viewingNow(d.key)) {
        bumpUnread(d.key, !!mention);
        if (d.msg.kind === "ping" || mention) {
          beep();
          if (els.pill) {
            els.pill.classList.remove("nudge");
            void els.pill.offsetWidth; // restart the animation
            els.pill.classList.add("nudge");
          }
        }
      }
      if (panelOpen && mode === "chat" && viewKey() === d.key) {
        if (change === "appended") appendRow(d.msg);
        else if (change === "updated") updateRow(d.msg);
        else if (change === "held" && els.newer)
          els.newer.lastChild.textContent =
            " Back to the latest (" + c.newWhile + " new)";
        if (viewingNow(d.key)) markRead(d.key);
      }
      renderBadges();
    });

    socket.on("desk unread", (d) => {
      if (d && d.unread) {
        unread = d.unread;
        renderBadges();
      }
    });

    // The server swept old queue cards. Drop them here too rather than leaving
    // a tray that only empties on reload.
    socket.on("desk drop", (d) => {
      if (!d || !d.key || !Array.isArray(d.ids) || !d.ids.length) return;
      const gone = new Set(d.ids);
      const c = cacheFor(d.key);
      c.messages = c.messages.filter((m) => !gone.has(m.id));
      if (panelOpen && mode === "chat" && viewKey() === d.key) {
        if (els.list)
          for (const id of gone) {
            const node = els.list.querySelector('[data-id="' + id + '"]');
            if (node) node.remove();
          }
      }
    });

    socket.on("desk threads", (d) => {
      threads = (d && d.threads) || [];
      if (view.kind === "thread" && !threads.some((t) => t.id === view.key)) {
        view = { kind: "channel", key: "floor" }; // it was deleted under us
        if (panelOpen) loadView(true);
      }
      if (els.rail) renderRail();
    });

    socket.on("desk thread created", (d) => {
      if (d && d.id) openView({ kind: "thread", key: d.id });
    });

    socket.on("desk history", (d) => {
      if (!d || !d.key) return;
      learnAvatars((d.messages || []).map((m) => m.author).filter(Boolean));
      const c = cacheFor(d.key);
      if (d.around != null) {
        // A window centred on a search hit.
        c.messages = d.messages || [];
        c.loaded = true;
        c.detached = !!d.hasMoreNewer;
        c.newWhile = 0;
      } else if (d.before == null) {
        c.messages = d.messages || [];
        c.loaded = true;
        c.detached = false;
        c.newWhile = 0;
      } else {
        const known = new Set(c.messages.map((m) => m.id));
        c.messages = (d.messages || [])
          .filter((m) => !known.has(m.id))
          .concat(c.messages);
      }
      c.hasMore = !!d.hasMore;
      if (panelOpen && mode === "chat" && viewKey() === d.key) {
        renderMessages(d.before != null);
        if (d.around != null) flashNear(d.around);
      }
      if (viewingNow(d.key)) markRead(d.key);
    });

    socket.on("desk presence", (p) => {
      if (p) {
        presence = p;
        learnAvatars(p.staff);
        forgetNames();
        if (panelOpen) renderSide();
      }
    });

    socket.on("desk room info", (d) => {
      if (!d) return;
      inspectorRoom = d;
      if (panelOpen && mode === "inspector") renderInspector();
    });

    socket.on("desk search", (d) => {
      if (!d) return;
      searchHits = d.hits || [];
      if (panelOpen && mode === "search") renderSearch();
    });

    socket.on("desk roster", (d) => {
      roster = (d && d.staff) || [];
      learnAvatars(roster);
      forgetNames();
      if (panelOpen && mode === "team") renderTeam();
    });

    // A record we asked for. The dashboard listens for this too, so only take
    // it when the Desk is the one waiting.
    socket.on("staff mod history", (h) => {
      if (!h || !recordFor || !recordFor.loading) return;
      if ((h.label || "") !== recordFor.label) return;
      // The reply says what they have done, not what they hold, so the rank we
      // already knew has to survive it.
      recordFor = Object.assign({}, h, {
        loading: false,
        role: recordFor.role,
        level: h.modLevel != null ? h.modLevel : recordFor.level,
      });
      showRecord();
    });

    // The appeal being read, pushed whenever either side says anything.
    socket.on("staff appeal", (d) => {
      if (!d || !d.id) return;
      if (!appeal || appeal.id !== d.id) return;
      appeal = d;
      if (panelOpen && mode === "appeal") renderAppeal();
    });

    // Somebody wrote your name. The badge and the beep already happened on the
    // message itself; this is the line that says where to look.
    socket.on("desk mention", (d) => {
      if (!d || !panelOpen) return;
      const g = d.group && GROUP_BY_TOKEN.get(d.group);
      toast(
        (d.by || "Someone") +
          (g ? " called " + g.name : " mentioned you") +
          " in " +
          channelLabel(d.key) +
          ".",
      );
    });

    // Sent straight back to whoever wrote the mention: who got it now, and who
    // is off and will get it when they return. A ping is never silently lost,
    // and a group says how many people it actually reached rather than letting
    // you assume it woke the whole team.
    socket.on("desk mention receipt", (d) => {
      if (!d) return;
      const off = Array.isArray(d.offline) ? d.offline : [];
      const on = Array.isArray(d.online) ? d.online : [];
      if (d.groups && d.groups.length) {
        const n = on.length + off.length;
        if (!n) return toast("There is nobody else in that group.");
        toast(
          "Pinged " +
            n +
            (n === 1 ? " person: " : " people: ") +
            on.length +
            " on now" +
            (off.length
              ? ", " + off.length + " will see it when they are back"
              : ""),
        );
        return;
      }
      if (!off.length) return;
      toast(
        off.join(", ") +
          (off.length === 1
            ? " is offline - they"
            : " are offline - they") +
          " will see it when they are back.",
      );
    });

    socket.on("desk error", (d) =>
      toast((d && d.message) || "That did not work."),
    );

    socket.on("desk ping update", (d) => {
      if (d && d.status === "claimed")
        toast(d.by + " is on it - they saw your ping.");
    });

    socket.on("staff action result", (d) => {
      if (!d || !panelOpen) return;
      if (d.ok) toast(d.action + " done.");
      // The room may have changed under the inspector; ask again.
      if (mode === "inspector" && inspectorRoom)
        socket.emit("desk room info", { roomId: inspectorRoom.roomId });
    });

    // A failed action must never fail silently - not from the inspector, and
    // not from a slash command. Say what the server said, and refresh the
    // room snapshot if one is up.
    socket.on("error", (d) => {
      if (!panelOpen) return;
      const fromCommand = Date.now() - lastCommandAt < 6000;
      if (mode !== "inspector" && !fromCommand) return;
      const m = d && d.error && d.error.message;
      if (m) toast(m);
      if (mode === "inspector" && inspectorRoom)
        socket.emit("desk room info", { roomId: inspectorRoom.roomId });
    });

    // A revoked key must lose the Desk instantly, not at next reload.
    socket.on("staff revoked", () => teardown());

    socket.on("connect", () => socket.emit("desk hello"));
    socket.on("disconnect", () => {
      if (els.panel) els.panel.classList.add("dk-offline");
    });
    socket.io?.on?.("reconnect", () => {
      if (els.panel) els.panel.classList.remove("dk-offline");
    });
    socket.on("desk ready", () => {
      if (els.panel) els.panel.classList.remove("dk-offline");
    });

    if (socket.connected) socket.emit("desk hello");
  }

  function teardown() {
    panelOpen = false;
    if (els.panel) els.panel.remove();
    if (els.pill) els.pill.remove();
    mounted = false;
    me = null;
  }

  // ── Mounting ──────────────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    mounted = true;
    injectCss();
    // Only ever from here: mount runs once the server has confirmed a staff
    // key, so nobody else's page fetches the emote list.
    loadEmotes();
    if (pageMode) {
      // Its own window: the Desk IS the page. The sign-in gate goes away the
      // moment the server has confirmed a staff key.
      const gate = document.getElementById("deskGate");
      if (gate) gate.remove();
    } else {
      buildPill();
    }
    buildPanel();
    if (pageMode) els.panel.classList.add("dk-fullpage");
  }

  // ── The dock button ───────────────────────────────────────────────────────
  // Bottom left by default, but hold it and it goes wherever you want. Every
  // page has something different in its corners, so the only workable answer
  // is to let whoever is looking at it move it out of the way.
  const PILL_KEY = "talkomatic_deskPill";

  function clampPill(x, y) {
    const p = els.pill;
    const w = (p && p.offsetWidth) || 96;
    const h = (p && p.offsetHeight) || 38;
    return {
      x: Math.max(6, Math.min(x, window.innerWidth - w - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - h - 6)),
    };
  }

  function placePill(x, y) {
    const p = els.pill;
    if (!p) return;
    const c = clampPill(x, y);
    p.style.left = c.x + "px";
    p.style.top = c.y + "px";
    p.style.right = "auto";
    p.style.bottom = "auto";
    return c;
  }

  function restorePill() {
    let r = null;
    try {
      r = JSON.parse(localStorage.getItem(PILL_KEY) || "null");
    } catch (_) {}
    if (!r || typeof r.x !== "number" || typeof r.y !== "number") return;
    placePill(r.x, r.y);
  }

  function makePillDraggable(pill) {
    let drag = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      const r = pill.getBoundingClientRect();
      drag = {
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
      };
      try {
        pill.setPointerCapture(e.pointerId);
      } catch (_) {}
    });
    pill.addEventListener("pointermove", (e) => {
      if (!drag) return;
      // A few pixels of slop, so a shaky click is still a click.
      if (
        !drag.moved &&
        Math.abs(e.clientX - drag.sx) < 4 &&
        Math.abs(e.clientY - drag.sy) < 4
      )
        return;
      drag.moved = true;
      pill.classList.add("dragging");
      placePill(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const done = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      pill.classList.remove("dragging");
      if (!moved) return;
      const r = pill.getBoundingClientRect();
      try {
        localStorage.setItem(PILL_KEY, JSON.stringify({ x: r.left, y: r.top }));
      } catch (_) {}
      // Swallow the click this drag is about to fire, so letting go of the
      // button does not also open the panel.
      pill.addEventListener("click", (e) => e.stopImmediatePropagation(), {
        capture: true,
        once: true,
      });
    };
    pill.addEventListener("pointerup", done);
    pill.addEventListener("pointercancel", done);
    // A smaller window must not strand it off-screen.
    window.addEventListener("resize", () => {
      if (!els.pill || !els.pill.style.left) return;
      const r = els.pill.getBoundingClientRect();
      placePill(r.left, r.top);
    });
  }

  function buildPill() {
    const pill = el("button", "dk-pill");
    pill.type = "button";
    pill.id = "deskPill";
    pill.setAttribute("aria-label", "Open the staff Desk");
    pill.title = "The Desk. Hold and drag to move it anywhere.";
    pill.appendChild(icon("fa-comments"));
    pill.appendChild(document.createTextNode(" Desk"));
    const badge = el("span", "dk-pill-badge");
    badge.style.display = "none";
    pill.appendChild(badge);
    pill.addEventListener("click", toggle);
    document.body.appendChild(pill);
    els.pill = pill;
    els.badge = badge;
    restorePill();
    makePillDraggable(pill);
    // Quiet pages get no message traffic to trigger a badge pass, so re-check
    // the corner a couple of times while the page finishes signing in.
    setTimeout(renderBadges, 2500);
    setTimeout(renderBadges, 8000);
  }

  function buildPanel() {
    const panel = el("div", "dk-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "The Desk - staff chat");
    panel.style.display = "none";

    // ── Header ──
    const head = el("div", "dk-head");
    const burger = btn("dk-hbtn dk-burger", null, "fa-bars", "Channels");
    burger.addEventListener("click", () => panel.classList.toggle("rail-open"));
    head.appendChild(burger);
    const title = el("div", "dk-title");
    title.appendChild(el("span", "dk-title-main", "The Desk"));
    els.headSub = el("span", "dk-title-sub", "#floor");
    title.appendChild(els.headSub);
    head.appendChild(title);

    const search = el("input", "dk-search");
    search.type = "search";
    search.placeholder = "Search everything you can read";
    search.setAttribute("aria-label", "Search staff chat");
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && search.value.trim().length >= 2) {
        searchHits = null;
        mode = "search";
        socket.emit("desk search", { q: search.value.trim() });
        renderMain();
      }
    });
    head.appendChild(search);
    els.searchInput = search;

    const searchBtn = btn(
      "dk-hbtn dk-msearch",
      null,
      "fa-magnifying-glass",
      "Search",
    );
    searchBtn.addEventListener("click", () =>
      ask(
        {
          title: "Search staff chat",
          label: "Looking for",
          max: 80,
          icon: '<i class="fas fa-magnifying-glass"></i>',
        },
        (q) => {
          if (q.trim().length < 2) return;
          searchHits = null;
          mode = "search";
          socket.emit("desk search", { q: q.trim() });
          renderMain();
        },
      ),
    );
    head.appendChild(searchBtn);

    const people = btn("dk-hbtn dk-people", null, "fa-user-group", "Who is on");
    people.addEventListener("click", () => panel.classList.toggle("side-open"));
    head.appendChild(people);

    const helpBtn = btn(
      "dk-hbtn",
      null,
      "fa-circle-question",
      "How the Desk works",
    );
    helpBtn.addEventListener("click", openHelp);
    head.appendChild(helpBtn);

    const sound = btn(
      "dk-hbtn",
      null,
      soundOn ? "fa-bell" : "fa-bell-slash",
      "Sound on new pings and mentions",
    );
    sound.addEventListener("click", () => {
      soundOn = !soundOn;
      localStorage.setItem("talkomatic_deskSound", soundOn ? "1" : "0");
      sound.replaceChild(
        icon(soundOn ? "fa-bell" : "fa-bell-slash"),
        sound.firstChild,
      );
      if (soundOn) beep();
    });
    head.appendChild(sound);

    if (!pageMode) {
      // Tear the Desk off into its own window, for a second monitor or just
      // to keep it up while moving between pages.
      const pop = btn(
        "dk-hbtn dk-popbtn",
        null,
        "fa-up-right-from-square",
        "Open in its own window",
      );
      pop.addEventListener("click", () => {
        window.open("/desk.html", "talkodesk", "width=1120,height=780");
        setOpen(false);
      });
      head.appendChild(pop);

      const close = btn("dk-hbtn", null, "fa-xmark", "Close");
      close.addEventListener("click", () => setOpen(false));
      head.appendChild(close);
    }
    panel.appendChild(head);

    // ── Body: rail / main / side ──
    const body = el("div", "dk-body");
    els.rail = el("nav", "dk-rail");
    els.rail.setAttribute("aria-label", "Channels and threads");
    body.appendChild(els.rail);

    els.main = el("div", "dk-main");
    body.appendChild(els.main);

    els.side = el("aside", "dk-side");
    els.side.setAttribute("aria-label", "Who is on");
    body.appendChild(els.side);

    // Tapping the dimmed area closes whichever drawer is open (mobile).
    const scrim = el("div", "dk-scrim");
    scrim.addEventListener("click", () =>
      panel.classList.remove("rail-open", "side-open"),
    );
    body.appendChild(scrim);
    panel.appendChild(body);

    els.toast = el("div", "dk-toast");
    panel.appendChild(els.toast);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelOpen && !pageMode) setOpen(false);
    });
    window.addEventListener("focus", () => {
      if (viewingNow(viewKey())) markRead(viewKey());
    });

    document.body.appendChild(panel);
    els.panel = panel;
    if (!pageMode) makeMovable(panel, head);
  }

  // ── Placement: centred by default, then wherever you drag it ─────────────
  // The panel remembers its spot and size per browser. On a phone it always
  // fills the screen and none of this applies.
  const RECT_KEY = "talkomatic_deskRect";
  const onDesktop = () => window.innerWidth > 760 && !pageMode;

  // Set while the code is positioning the panel itself. The resize observer
  // fires during that, and during the browser's first layout pass, and a save
  // from either would store a half built rectangle over the real one.
  let placing = 0;

  function placePanel(x, y, w, h) {
    const p = els.panel;
    if (!p) return;
    placing = Date.now();
    const W = window.innerWidth;
    const H = window.innerHeight;
    w = Math.max(560, Math.min(w || p.offsetWidth, W - 16));
    h = Math.max(420, Math.min(h || p.offsetHeight, H - 16));
    x = Math.max(8, Math.min(x, W - w - 8));
    y = Math.max(8, Math.min(y, H - h - 8));
    p.style.left = x + "px";
    p.style.top = y + "px";
    p.style.right = "auto";
    p.style.bottom = "auto";
    p.style.width = w + "px";
    p.style.height = h + "px";
  }

  function saveRect() {
    const p = els.panel;
    if (!p || !onDesktop() || !panelOpen) return;
    const r = p.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) return; // mid layout, not a real size
    try {
      localStorage.setItem(
        RECT_KEY,
        JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height }),
      );
    } catch (_) {}
  }

  function applyRect() {
    if (!onDesktop()) return;
    let r = null;
    try {
      r = JSON.parse(localStorage.getItem(RECT_KEY) || "null");
    } catch (_) {}
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = r && r.w ? r.w : Math.min(1060, W - 32);
    const h = r && r.h ? r.h : Math.min(680, H - 64);
    const x = r && r.x != null ? r.x : (W - Math.min(w, W - 16)) / 2;
    const y = r && r.y != null ? r.y : (H - Math.min(h, H - 16)) / 2;
    placePanel(x, y, w, h);
  }

  function clearInlineRect() {
    const p = els.panel;
    if (!p) return;
    p.style.left = p.style.top = p.style.right = p.style.bottom = "";
    p.style.width = p.style.height = "";
  }

  function makeMovable(panel, head) {
    head.classList.add("dk-drag");
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
      if (!onDesktop()) return;
      if (e.target.closest("button, input")) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try {
        head.setPointerCapture(e.pointerId);
      } catch (_) {}
      panel.classList.add("dragging");
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      placePanel(
        e.clientX - drag.dx,
        e.clientY - drag.dy,
        panel.offsetWidth,
        panel.offsetHeight,
      );
    });
    const done = () => {
      if (!drag) return;
      drag = null;
      panel.classList.remove("dragging");
      saveRect();
    };
    head.addEventListener("pointerup", done);
    head.addEventListener("pointercancel", done);

    // The native resize handle changes width and height; remember it, but
    // only when the change came from the user rather than from our own
    // placement or the browser's first layout pass.
    let t = null;
    try {
      new ResizeObserver(() => {
        if (!panelOpen || !onDesktop()) return;
        if (Date.now() - placing < 600) return;
        clearTimeout(t);
        t = setTimeout(saveRect, 300);
      }).observe(panel);
    } catch (_) {}

    // Crossing the phone breakpoint: inline position must not fight the
    // full-screen layout, so it is dropped and restored on the way back.
    window.addEventListener("resize", () => {
      if (!panelOpen) return;
      if (window.innerWidth <= 760) clearInlineRect();
      else applyRect();
    });
  }

  function setOpen(on) {
    if (pageMode && !on) return; // the window's own close button does this
    panelOpen = !!on;
    if (!els.panel) return;
    els.panel.style.display = panelOpen ? "" : "none";
    els.panel.classList.remove("rail-open", "side-open");
    if (panelOpen) {
      if (onDesktop()) applyRect();
      else clearInlineRect();
      renderAll();
      loadView(true);
      socket.emit("desk presence");
    }
  }
  const toggle = () => setOpen(!panelOpen);

  // ── View switching ────────────────────────────────────────────────────────
  function openView(v) {
    view = v;
    mode = "chat";
    replyTo = null; // a reply armed in one channel must not fire in another
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    renderAll();
    loadView();
  }
  function loadView(force) {
    const c = cacheFor(viewKey());
    if (!c.loaded || force) socket.emit("desk history", { key: viewKey() });
    else if (viewingNow(viewKey())) markRead(viewKey());
  }

  function renderAll() {
    renderRail();
    renderMain();
    renderSide();
  }

  // ── Rail ──────────────────────────────────────────────────────────────────
  function renderRail() {
    if (!els.rail || !me) return;
    const rail = els.rail;
    rail.textContent = "";

    rail.appendChild(el("div", "dk-rail-h", "Channels"));
    for (const c of channels) {
      const row = el(
        "button",
        "dk-chan" +
          (view.kind === "channel" && viewKey() === c.key && mode === "chat"
            ? " on"
            : ""),
      );
      row.type = "button";
      row.appendChild(el("span", "dk-hash", "#"));
      row.appendChild(el("span", "dk-chan-name", c.name));
      if (c.restricted) row.appendChild(icon("fa-lock"));
      const u = unread[c.key];
      if (u && u.n) {
        const b = el(
          "span",
          "dk-b" + (u.mentions ? " loud" : ""),
          u.n > 99 ? "99+" : String(u.n),
        );
        row.appendChild(b);
      }
      row.title = c.desc || "";
      row.addEventListener("click", () =>
        openView({ kind: "channel", key: c.key }),
      );
      rail.appendChild(row);
    }

    const th = el("div", "dk-rail-h");
    th.appendChild(document.createTextNode("Threads"));
    const add = btn("dk-tadd", null, "fa-plus", "New thread");
    add.addEventListener("click", () =>
      ask(
        {
          title: "New thread",
          label: "What is it about?",
          placeholder: "raid in 67room67",
          max: 60,
          message:
            "Threads that go quiet for a day drop into the archive but stay readable.",
        },
        (t) => {
          if (t.trim()) socket.emit("desk thread create", { title: t.trim() });
        },
      ),
    );
    th.appendChild(add);
    rail.appendChild(th);

    const live = threads
      .filter((t) => !t.archived)
      .sort((a, b) => b.lastTs - a.lastTs);
    const archived = threads
      .filter((t) => t.archived)
      .sort((a, b) => b.lastTs - a.lastTs);
    if (!live.length)
      rail.appendChild(el("div", "dk-rail-empty", "No open threads."));
    for (const t of live) rail.appendChild(threadRow(t));

    if (archived.length) {
      const tog = el("button", "dk-arch-toggle");
      tog.type = "button";
      tog.appendChild(
        icon(showArchived ? "fa-chevron-down" : "fa-chevron-right"),
      );
      tog.appendChild(
        document.createTextNode(" Archived (" + archived.length + ")"),
      );
      tog.addEventListener("click", () => {
        showArchived = !showArchived;
        renderRail();
      });
      rail.appendChild(tog);
      if (showArchived)
        for (const t of archived) rail.appendChild(threadRow(t, true));
    }

    // Not channels: places to look rather than places to talk.
    rail.appendChild(el("div", "dk-rail-h", "Look up"));
    const team = el("button", "dk-chan" + (mode === "team" ? " on" : ""));
    team.type = "button";
    team.appendChild(icon("fa-user-group"));
    team.appendChild(el("span", "dk-chan-name", "The team"));
    team.title = "Every moderator and developer, on or off";
    team.addEventListener("click", openTeam);
    rail.appendChild(team);

    const help = el("button", "dk-chan" + (mode === "help" ? " on" : ""));
    help.type = "button";
    help.appendChild(icon("fa-circle-question"));
    help.appendChild(el("span", "dk-chan-name", "How this works"));
    help.title = "The whole guide. Write #guide to send anybody here.";
    help.addEventListener("click", openHelp);
    rail.appendChild(help);

    // Decision made out loud, not buried: moderators know devs can read it all.
    rail.appendChild(
      el(
        "div",
        "dk-rail-foot",
        "Developers can read every channel and thread, including edits and deletions.",
      ),
    );
  }

  function threadRow(t, archived) {
    const row = el(
      "button",
      "dk-thread" +
        (view.kind === "thread" && viewKey() === t.id && mode === "chat"
          ? " on"
          : "") +
        (archived ? " arch" : ""),
    );
    row.type = "button";
    row.appendChild(icon("fa-message"));
    const w = el("span", "dk-thread-t", t.title);
    row.appendChild(w);
    const u = unread[t.id];
    if (u && u.n && !archived) row.appendChild(el("span", "dk-dot"));
    row.title =
      "Started by " +
      t.createdBy +
      (t.link ? " - about " + t.link.roomName : "");
    row.addEventListener("click", () =>
      openView({ kind: "thread", key: t.id }),
    );
    return row;
  }

  // ── Main pane ─────────────────────────────────────────────────────────────
  function renderMain() {
    if (!els.main) return;
    if (mode === "inspector") return renderInspector();
    if (mode === "search") return renderSearch();
    if (mode === "team") return renderTeam();
    if (mode === "appeal") return renderAppeal();
    if (mode === "help") return renderHelp();
    const main = els.main;
    main.textContent = "";

    const ch = channels.find((c) => c.key === viewKey());
    const th = threads.find((t) => t.id === viewKey());
    if (els.headSub)
      els.headSub.textContent =
        view.kind === "channel"
          ? "#" + (ch ? ch.name : viewKey())
          : th
            ? th.title
            : "thread";

    if (view.kind === "thread" && th) {
      const bar = el("div", "dk-threadbar");
      bar.appendChild(el("span", "dk-threadbar-t", th.title));
      bar.appendChild(
        el(
          "span",
          "dk-threadbar-s",
          (th.archived ? "Archived - a reply reopens it. " : "") +
            "Started by " +
            th.createdBy,
        ),
      );
      if (th.link) {
        const jump = btn(
          "dk-minib",
          th.link.roomName,
          "fa-door-open",
          "Inspect this room",
        );
        jump.addEventListener("click", () => openInspector(th.link.roomId));
        bar.appendChild(jump);
      }
      if (me && me.role === "dev") {
        const del = btn(
          "dk-minib danger",
          "Delete",
          "fa-trash",
          "Hard-delete this thread (dev)",
        );
        armTwice(del, "Delete for good?", () =>
          socket.emit("desk thread delete", { id: th.id }),
        );
        bar.appendChild(del);
      }
      main.appendChild(bar);
    } else if (ch && ch.desc) {
      const bar = el("div", "dk-chandesc", ch.desc);
      main.appendChild(bar);
    }

    els.list = el("div", "dk-msgs");
    els.list.setAttribute("aria-live", "polite");
    // Reading back through something while the room is busy: the moment you
    // scroll away from the bottom, new arrivals stop yanking you down and are
    // counted on a bar instead.
    els.list.addEventListener("scroll", () => {
      if (nearBottom() && missed) clearMissed();
    });
    main.appendChild(els.list);

    els.jump = el("div", "dk-jump");
    els.jump.style.display = "none";
    const jumpBtn = el("button", "dk-jump-b");
    jumpBtn.type = "button";
    jumpBtn.title = "Jump to the latest";
    els.jumpText = el("span", "dk-jump-t", "");
    jumpBtn.appendChild(els.jumpText);
    jumpBtn.appendChild(icon("fa-arrow-down"));
    jumpBtn.addEventListener("click", () => {
      clearMissed();
      if (els.list) els.list.scrollTop = els.list.scrollHeight;
    });
    els.jump.appendChild(jumpBtn);
    main.appendChild(els.jump);

    // ── Composer ──
    // Some channels are written by the server. Rather than show a box that
    // refuses everything typed into it, say so and stop.
    if (ch && ch.readonly) {
      els.replyBar = null;
      els.palette = null;
      els.emotes = null;
      els.emoteBtn = null;
      els.composer = null;
      els.sizeTa = null;
      main.appendChild(
        el(
          "div",
          "dk-readonly",
          "The server writes this channel. Nothing to add.",
        ),
      );
      renderMessages();
      return;
    }

    els.replyBar = el("div", "dk-replybar");
    els.replyBar.style.display = "none";
    main.appendChild(els.replyBar);
    renderReplyBar();

    els.palette = el("div", "dk-palette");
    els.palette.style.display = "none";
    main.appendChild(els.palette);

    // The picker sits between the list above the box and the box itself, so
    // whichever one is up, the box never moves under your hands.
    els.emotes = el("div", "dk-empanel");
    els.emotes.style.display = "none";
    main.appendChild(els.emotes);

    const comp = el("div", "dk-comp");
    const ta = el("textarea", "dk-input");
    ta.rows = 1;
    ta.maxLength = 1200;
    ta.placeholder =
      view.kind === "channel"
        ? "Message #" + (ch ? ch.name : "")
        : "Reply in thread";
    ta.setAttribute("aria-label", ta.placeholder);
    const count = el("span", "dk-count");
    const emoteBtn = btn(
      "dk-emobtn",
      null,
      "fa-face-smile",
      "Emotes - or type a colon and the first letters of one",
    );
    emoteBtn.addEventListener("click", () => toggleEmotePicker());
    const send = btn("dk-send", null, "fa-paper-plane", "Send");
    // One line tall until the text needs more, then it grows to a cap. The
    // reset to "auto" first is what lets it shrink again on delete.
    const sizeTa = () => {
      ta.style.height = "auto";
      ta.style.height = Math.max(38, Math.min(ta.scrollHeight, 120)) + "px";
      count.textContent =
        ta.value.length > 1000 ? 1200 - ta.value.length + " left" : "";
    };
    const doSend = () => {
      const text = ta.value.trim();
      if (!text) return;
      // A leading slash is a command, not a message.
      if (text.startsWith("/")) {
        drafts.delete(viewKey());
        ta.value = "";
        sizeTa();
        hidePalette();
        runCommand(text);
        ta.focus();
        return;
      }
      socket.emit("desk send", {
        key: viewKey(),
        text,
        ...(replyTo ? { replyTo: replyTo.id } : {}),
      });
      clearReply();
      drafts.delete(viewKey());
      ta.value = "";
      sizeTa();
      hidePalette();
      ta.focus();
    };
    ta.addEventListener("keydown", (e) => {
      // While the list above the box is up it owns the arrows, Tab, and - for
      // names, where there is always something highlighted - Enter.
      if (paletteOpen()) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          movePalette(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          choosePalette(Math.max(0, palette.idx));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && palette.idx >= 0) {
          e.preventDefault();
          choosePalette(palette.idx);
          return;
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          hidePalette();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
      if (e.key === "Escape" && emotePickerOpen()) {
        e.stopPropagation();
        toggleEmotePicker(false);
        return;
      }
      if (e.key === "Escape" && replyTo) {
        e.stopPropagation();
        clearReply();
      }
    });
    ta.addEventListener("input", () => {
      // Half-typed messages follow you between channels and page loads within
      // the session, instead of vanishing on every switch.
      if (ta.value) drafts.set(viewKey(), ta.value);
      else drafts.delete(viewKey());
      sizeTa();
      updatePalette(ta);
    });
    // Moving the caret with the mouse or the arrows can land it on a half
    // typed name, or take it off one.
    ta.addEventListener("click", () => updatePalette(ta));
    ta.addEventListener("keyup", (e) => {
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Home" ||
        e.key === "End"
      )
        updatePalette(ta);
    });
    ta.addEventListener("blur", () => setTimeout(hidePalette, 150));
    els.sizeTa = sizeTa;
    if (drafts.has(viewKey())) {
      ta.value = drafts.get(viewKey());
      requestAnimationFrame(sizeTa);
    }
    send.addEventListener("click", doSend);
    comp.appendChild(ta);
    comp.appendChild(count);
    comp.appendChild(emoteBtn);
    comp.appendChild(send);
    main.appendChild(comp);
    els.composer = ta;
    els.emoteBtn = emoteBtn;

    renderMessages();
  }

  function nearBottom() {
    const l = els.list;
    return l && l.scrollHeight - l.scrollTop - l.clientHeight < 120;
  }

  // How many messages have landed since you scrolled away from the bottom.
  // Only ever counts what arrived while you were reading something above:
  // scrolling back down, or switching view, clears it.
  let missed = 0;
  function renderJump() {
    if (!els.jump || !els.jumpText) return;
    if (!missed) {
      els.jump.style.display = "none";
      return;
    }
    els.jump.style.display = "";
    els.jumpText.textContent =
      missed === 1 ? "1 new message" : missed + " new messages";
  }
  function clearMissed() {
    if (!missed) return;
    missed = 0;
    renderJump();
  }

  function renderMessages(keepScroll) {
    const list = els.list;
    if (!list) return;
    const c = cacheFor(viewKey());
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.textContent = "";

    if (c.hasMore) {
      const older = btn("dk-older", "Load older", "fa-chevron-up");
      older.addEventListener("click", () => {
        const first = c.messages[0];
        socket.emit("desk history", {
          key: viewKey(),
          before: first ? first.ts : Date.now(),
        });
      });
      list.appendChild(older);
    }

    if (!c.messages.length && c.loaded) {
      list.appendChild(el("div", "dk-empty", "Nothing here yet. Say hello."));
    }

    let prev = null;
    let lastDay = null;
    for (const m of c.messages) {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) {
        lastDay = dk;
        list.appendChild(el("div", "dk-day", dayLabel(m.ts)));
        prev = null;
      }
      list.appendChild(row(m, prev));
      prev = m;
    }

    // Looking at an old window after a search jump: the way home is explicit,
    // and it carries the count of what has happened since.
    els.newer = null;
    if (c.detached) {
      const newer = btn(
        "dk-older dk-newer",
        c.newWhile
          ? " Back to the latest (" + c.newWhile + " new)"
          : " Back to the latest",
        "fa-chevron-down",
      );
      newer.addEventListener("click", () =>
        socket.emit("desk history", { key: viewKey() }),
      );
      list.appendChild(newer);
      els.newer = newer;
    }

    if (keepScroll) {
      list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    } else {
      list.scrollTop = list.scrollHeight;
      missed = 0;
    }
    renderJump();
  }

  // Scroll to the message nearest a timestamp and flash it - the landing half
  // of a search jump.
  function flashNear(ts) {
    const c = cacheFor(viewKey());
    if (!c.messages.length || !els.list) return;
    let best = c.messages[0];
    for (const m of c.messages)
      if (Math.abs(m.ts - ts) < Math.abs(best.ts - ts)) best = m;
    const node = els.list.querySelector('[data-id="' + best.id + '"]');
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1800);
  }

  function appendRow(msg) {
    const list = els.list;
    if (!list) return renderMessages();
    const c = cacheFor(viewKey());
    const stick = nearBottom();
    const prev =
      c.messages.length > 1 ? c.messages[c.messages.length - 2] : null;
    if (!prev || dayKey(prev.ts) !== dayKey(msg.ts))
      list.appendChild(el("div", "dk-day", dayLabel(msg.ts)));
    list.appendChild(row(msg, prev));
    if (stick) {
      list.scrollTop = list.scrollHeight;
    } else {
      // Reading above: say how much has come in rather than moving the page.
      missed++;
      renderJump();
    }
  }

  function updateRow(msg) {
    const list = els.list;
    if (!list) return;
    const node = list.querySelector('[data-id="' + msg.id + '"]');
    if (!node) return;
    const c = cacheFor(viewKey());
    const i = c.messages.findIndex((m) => m.id === msg.id);
    const prev = i > 0 ? c.messages[i - 1] : null;
    node.replaceWith(row(msg, prev));
  }

  // ── Queue cards ───────────────────────────────────────────────────────────
  // #queues is a working tray, not a log. Every card says what happened in
  // fields rather than a paragraph, and carries the buttons you would have
  // gone to the dashboard for. The buttons fire the SAME staff events the
  // dashboard fires, so every permission check stays on the server - and
  // because the server stamps the card from its own action log, handling
  // something anywhere marks it handled here, whoever did it and wherever.
  const QICON = {
    report: "fa-flag",
    appeal: "fa-scale-balanced",
    application: "fa-file-signature",
    suggestion: "fa-lightbulb",
    invite: "fa-user-plus",
    abuse: "fa-triangle-exclamation",
    stats: "fa-chart-simple",
  };
  const QNAME = {
    report: "Report",
    appeal: "Ban appeal",
    application: "Mod application",
    suggestion: "Suggestion",
    abuse: "Worth a look",
    invite: "Invites",
    stats: "Daily summary",
  };

  const isDev = () => !!me && me.role === "dev";
  const isFullMod = () => !!me && (me.role === "dev" || (me.level || 2) >= 2);

  function qField(label, value, cls) {
    const f = el("div", "dk-q-f" + (cls ? " " + cls : ""));
    f.appendChild(el("span", "dk-q-fl", label));
    const v = el("span", "dk-q-fv");
    inlineInto(v, String(value == null ? "" : value));
    f.appendChild(v);
    return f;
  }
  function qChip(text, cls, fa) {
    const s = el("span", "dk-q-chip" + (cls ? " " + cls : ""));
    if (fa) s.appendChild(icon(fa));
    s.appendChild(document.createTextNode(text));
    return s;
  }

  function queueHeadline(kind, c) {
    if (kind === "report")
      return (c.by || "Someone") + " reported " + (c.target || "a user");
    if (kind === "application")
      return (c.by || "Someone") + " wants to help moderate";
    if (kind === "appeal")
      return (c.by || "A banned user") + " is appealing a ban";
    if (kind === "suggestion")
      return (c.by || "A user") + " suggested something";
    if (kind === "abuse")
      return (c.target || "A moderator") + " is worth a look";
    return c.by || "";
  }

  function queueBody(kind, c, m) {
    const b = el("div", "dk-q-b");

    if (kind === "report") {
      const chips = el("div", "dk-q-chips");
      if (c.category) chips.appendChild(qChip(c.category, "cat", "fa-tag"));
      if (c.reports)
        chips.appendChild(
          qChip(
            c.reports + (c.reports === 1 ? " reporter" : " reporters"),
            c.reports >= 3 ? "hot" : "",
            "fa-user-group",
          ),
        );
      if (c.targetRole)
        chips.appendChild(
          qChip("reported user is staff", "warn", "fa-user-shield"),
        );
      if (c.roomName) chips.appendChild(qChip(c.roomName, "", "fa-door-open"));
      b.appendChild(chips);
      if (c.reason) b.appendChild(qField("Their note", c.reason));
      if (c.quote)
        b.appendChild(qField("Their chat box read", c.quote, "quote"));
      return b;
    }

    if (kind === "application") {
      const chips = el("div", "dk-q-chips");
      if (c.discord)
        chips.appendChild(qChip("@" + c.discord, "", "fa-comments"));
      for (const l of c.lines || [])
        chips.appendChild(qChip(l, "", "fa-clock"));
      if (chips.childNodes.length) b.appendChild(chips);
      if (c.reason) b.appendChild(qField("Why they want to help", c.reason));
      return b;
    }

    if (kind === "appeal") {
      for (const l of c.lines || []) b.appendChild(qField("Ban", l));
      if (c.reason) b.appendChild(qField("What they say", c.reason, "quote"));
      return b;
    }

    if (kind === "suggestion") {
      if (c.reason) b.appendChild(qField("The idea", c.reason, "quote"));
      return b;
    }

    if (kind === "abuse") {
      if (c.reason) b.appendChild(qField("What tripped it", c.reason));
      if (c.lines && c.lines.length) {
        const l = el("div", "dk-q-acts-list");
        l.appendChild(el("span", "dk-q-fl", "Their last actions"));
        const strip = el("div", "dk-q-chips");
        for (const line of c.lines) strip.appendChild(qChip(line, "quiet"));
        l.appendChild(strip);
        b.appendChild(l);
      }
      b.appendChild(
        el(
          "div",
          "dk-q-note",
          "A prompt to go and read their record, never a verdict. Every one of these has an innocent explanation.",
        ),
      );
      return b;
    }

    if (m.text) b.appendChild(qField("", m.text));
    return b;
  }

  // The duration picker the dashboard uses, so a block from here is the same
  // decision it is there.
  function pickDuration(title, then) {
    const durs = [
      { label: "1 hour", value: "1h" },
      { label: "24 hours", value: "24h" },
      { label: "7 days", value: "7d" },
      { label: "Permanent", value: "permanent" },
    ];
    if (!window.StaffUI || !window.StaffUI.menu) return then("24h");
    let ctrl;
    ctrl = StaffUI.menu({
      title,
      icon: '<i class="fas fa-ban"></i>',
      groups: [
        {
          title: "How long",
          items: durs.map((d) => ({
            icon: '<i class="fas fa-clock"></i>',
            label: d.label,
            danger: d.value === "permanent",
            onClick: () => then(d.value),
          })),
        },
      ],
    });
    return ctrl;
  }

  function queueActions(kind, c, m) {
    const bar = el("div", "dk-q-acts");
    const add = (label, fa, cls, fn) => {
      const b = btn("dk-minib" + (cls ? " " + cls : ""), label, fa);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        // Same window a slash command opens: whatever the server says about
        // this - "they already left", "not your call" - has to reach the
        // person who pressed the button.
        lastCommandAt = Date.now();
        fn();
      });
      bar.appendChild(b);
    };

    if (kind === "report" && c.targetUserId) {
      add("Warn", "fa-triangle-exclamation", "", () =>
        ask(
          {
            title: "Warn " + (c.target || "them"),
            label: "Message (optional)",
            placeholder: "Please follow the Talkomatic rules.",
            max: 1000,
            icon: '<i class="fas fa-triangle-exclamation"></i>',
          },
          (message) =>
            socket.emit("staff warn user", {
              targetUserId: c.targetUserId,
              message: String(message || "").trim(),
            }),
        ),
      );
      add("Kick", "fa-door-open", "", () =>
        socket.emit("staff kick", { targetUserId: c.targetUserId }),
      );
      if (isFullMod())
        add("Block", "fa-ban", "danger", () =>
          pickDuration("Block " + (c.target || "this user"), (duration) =>
            ask(
              {
                title: "Block for " + duration,
                label: "Reason (optional, saved to the ban list)",
                max: 500,
                icon: '<i class="fas fa-ban"></i>',
              },
              (reason) =>
                socket.emit("staff ip block", {
                  targetUserId: c.targetUserId,
                  duration,
                  reason: String(reason || "").trim(),
                }),
            ),
          ),
        );
      if (isFullMod())
        add("Discard", "fa-xmark", "", () =>
          socket.emit("staff dismiss report", {
            targetUserId: c.targetUserId,
          }),
        );
      if (c.roomId) add("Inspect", "fa-eye", "", () => openInspector(c.roomId));
      return bar;
    }

    if (kind === "application" && c.itemId) {
      add("Approve as L1", "fa-check", "primary", () =>
        ask(
          {
            title: "Approve " + (c.by || "this applicant"),
            message:
              "They get a junior (L1) mod key straight away." +
              (c.discord
                ? " Remember to give @" +
                  c.discord +
                  " the mod role in the Talkomatic Discord."
                : ""),
            label: "Message to them (optional)",
            max: 300,
            icon: '<i class="fas fa-check"></i>',
          },
          (reason) =>
            socket.emit("mod application review", {
              id: c.itemId,
              decision: "approve",
              reason: String(reason || "").trim(),
            }),
        ),
      );
      add("Decline", "fa-xmark", "danger", () =>
        ask(
          {
            title: "Decline " + (c.by || "this applicant"),
            label: "Message to them (optional)",
            max: 300,
            icon: '<i class="fas fa-xmark"></i>',
          },
          (reason) =>
            socket.emit("mod application review", {
              id: c.itemId,
              decision: "reject",
              reason: String(reason || "").trim(),
            }),
        ),
      );
      return bar;
    }

    if (kind === "appeal" && c.itemId) {
      // An appeal is a conversation, so the card opens it rather than asking
      // for a verdict on one paragraph.
      add("Open the chat", "fa-comments", "primary", () =>
        openAppeal(c.itemId),
      );
      if (isDev())
        add("Lift the ban", "fa-unlock", "", () =>
          socket.emit("staff resolve appeal", {
            id: c.itemId,
            decision: "lift",
          }),
        );
      return bar;
    }

    if (kind === "suggestion" && c.itemId) {
      add("Approve", "fa-check", "primary", () =>
        socket.emit("staff resolve suggestion", {
          id: c.itemId,
          decision: "approve",
        }),
      );
      add("Decline", "fa-xmark", "", () =>
        socket.emit("staff resolve suggestion", {
          id: c.itemId,
          decision: "decline",
        }),
      );
      return bar;
    }

    if (c.roomId) {
      add("Inspect", "fa-eye", "", () => openInspector(c.roomId));
      return bar;
    }
    return bar.childNodes.length ? bar : null;
  }

  function queueCard(m) {
    const c = m.card || {};
    const kind = m.qkind || "notice";
    const r = el("div", "dk-q q-" + kind + (m.done ? " is-done" : ""));
    r.dataset.id = m.id;

    const head = el("div", "dk-q-h");
    const ico = el("span", "dk-q-ico");
    ico.appendChild(icon(QICON[kind] || "fa-circle-info"));
    head.appendChild(ico);
    const who = el("div", "dk-q-who");
    who.appendChild(el("span", "dk-q-kind", QNAME[kind] || "Notice"));
    who.appendChild(el("span", "dk-q-hl", queueHeadline(kind, c)));
    head.appendChild(who);
    const t = el("span", "dk-q-t", clockTime(m.ts));
    t.title = new Date(m.ts).toLocaleString();
    head.appendChild(t);
    r.appendChild(head);

    r.appendChild(queueBody(kind, c, m));

    if (m.done) {
      const d = el("div", "dk-q-done");
      d.appendChild(icon("fa-circle-check"));
      d.appendChild(
        document.createTextNode(
          " " +
            (m.done.action || "handled") +
            " by " +
            (m.done.by || "staff") +
            " - " +
            relTime(m.done.ts),
        ),
      );
      r.appendChild(d);
    } else {
      const acts = queueActions(kind, c, m);
      if (acts && acts.childNodes.length) r.appendChild(acts);
    }
    return r;
  }

  // ── The daily summary ─────────────────────────────────────────────────────
  // Nobody types in #stats, so the server's post does not have to pretend to
  // be a message. One headline, then the numbers as numbers.
  function statsCard(m) {
    const s = m.stats || {};
    const r = el("div", "dk-st");
    r.dataset.id = m.id;

    const head = el("div", "dk-st-h");
    head.appendChild(icon("fa-chart-simple"));
    head.appendChild(el("span", "dk-st-day", s.when || "Yesterday"));
    const t = el("span", "dk-q-t", clockTime(m.ts));
    t.title = new Date(m.ts).toLocaleString();
    head.appendChild(t);
    r.appendChild(head);
    // The card is posted the moment the day rolls over, so it lands under
    // today's divider while the date on it is the day it is about. Saying so
    // costs one line and stops the double-take.
    r.appendChild(
      el("div", "dk-st-sub", "That whole day, midnight to midnight."),
    );

    const grid = el("div", "dk-st-g");
    const tile = (n, label, hint, fa, cls) => {
      const c = el("div", "dk-st-c" + (cls ? " " + cls : ""));
      const top = el("div", "dk-st-n");
      top.appendChild(icon(fa));
      top.appendChild(el("span", null, String(n)));
      c.appendChild(top);
      c.appendChild(el("div", "dk-st-l", label));
      c.appendChild(el("div", "dk-st-s", hint));
      grid.appendChild(c);
    };
    // Every number says what it counts, in full. "93 people stopped by" and
    // "45 on at the busiest" sat next to each other reading like two counts of
    // the same thing, and "staff actions" did not say whose or what.
    // "1 calls for backup" reads like a bug in the counting, so the labels
    // agree with their numbers too.
    const p = (n, one, many) => (n === 1 ? one : many);
    tile(
      s.visitors || 0,
      p(s.visitors, "person used Talkomatic", "people used Talkomatic"),
      "counted once each, however many times they came back",
      "fa-users",
      "lead",
    );
    tile(
      s.peak || 0,
      "online at the same time",
      "the most at any one moment, not a total",
      "fa-signal",
    );
    tile(
      s.rooms || 0,
      p(s.rooms, "room created", "rooms created"),
      "new rooms opened that day",
      "fa-door-open",
    );
    tile(
      s.actions || 0,
      p(s.actions, "moderator action", "moderator actions"),
      "kicks, bans, warnings and the rest, across the team",
      "fa-gavel",
    );
    tile(
      s.reports || 0,
      p(s.reports, "report filed", "reports filed"),
      "sent in by people in rooms",
      "fa-flag",
      s.reports ? "warn" : "",
    );
    tile(
      s.pings || 0,
      p(s.pings, "call for backup", "calls for backup"),
      "staff asking the team for a hand",
      "fa-hand",
      s.pings ? "warn" : "",
    );
    r.appendChild(grid);
    return r;
  }

  // One message row. `prev` decides whether the author header repeats.
  function row(m, prev) {
    if (m.kind === "ping") return pingCard(m);
    if (m.kind === "system") {
      if (m.stats) return statsCard(m);
      if (m.card) return queueCard(m);
      const r = el("div", "dk-sys" + (m.qkind ? " card q-" + m.qkind : ""));
      r.dataset.id = m.id;
      r.appendChild(icon(QICON[m.qkind] || "fa-circle-info"));
      r.appendChild(el("span", "dk-sys-x", m.text));
      r.appendChild(el("span", "dk-sys-t", clockTime(m.ts)));
      return r;
    }

    const grouped =
      prev &&
      prev.kind === "chat" &&
      m.kind === "chat" &&
      prev.author &&
      m.author &&
      prev.author.label === m.author.label &&
      prev.author.role === m.author.role &&
      m.ts - prev.ts < 5 * 60 * 1000 &&
      !prev.deletedAt &&
      !m.reply; // a reply always shows who is answering whom

    const mention =
      m.mention ||
      (me &&
        m.text &&
        m.text.toLowerCase().includes("@" + me.label.toLowerCase()));

    const r = el(
      "div",
      "dk-msg" + (grouped ? " grouped" : "") + (mention ? " mention" : ""),
    );
    r.dataset.id = m.id;

    // The quote above a reply: who it answers and what they said. Clicking it
    // walks up the chain to the original.
    if (m.reply) {
      const q = el("button", "dk-quote");
      q.type = "button";
      q.title = "Go to the original message";
      q.appendChild(icon("fa-reply"));
      q.appendChild(el("span", "dk-quote-w", m.reply.label));
      q.appendChild(el("span", "dk-quote-t", m.reply.text || "(removed)"));
      q.addEventListener("click", () => {
        const c = cacheFor(viewKey());
        const there = c.messages.some((x) => x.id === m.reply.id);
        if (there) {
          const node =
            els.list &&
            els.list.querySelector('[data-id="' + m.reply.id + '"]');
          if (node) {
            node.scrollIntoView({ block: "center" });
            node.classList.add("flash");
            setTimeout(() => node.classList.remove("flash"), 1800);
            return;
          }
        }
        // The original scrolled out of the loaded window: fetch around it.
        socket.emit("desk history", { key: viewKey(), around: m.reply.ts });
      });
      r.appendChild(q);
    }

    if (!grouped) {
      const rank = rankOf(m.author);
      // Face and name both open that person's record.
      const openRec = (e) => {
        e.stopPropagation();
        openRecord(m.author.label, m.author.role, m.author.level);
      };
      const face = faceEl(m.author);
      face.classList.add("clickable");
      face.title = "Open " + m.author.label + "'s record";
      face.addEventListener("click", openRec);
      r.appendChild(face);
      const head = el("div", "dk-mhead");
      const nameBtn = el("button", "dk-mname clickable " + rank, m.author.label);
      nameBtn.type = "button";
      nameBtn.title = "Open " + m.author.label + "'s record";
      nameBtn.addEventListener("click", openRec);
      head.appendChild(nameBtn);
      head.appendChild(el("span", "dk-chip " + rank, rankName(rank)));
      if (m.author.alias && m.author.alias !== m.author.label)
        head.appendChild(el("span", "dk-alias", 'as "' + m.author.alias + '"'));
      const t = el("span", "dk-mtime", clockTime(m.ts));
      t.title = new Date(m.ts).toLocaleString();
      head.appendChild(t);
      r.appendChild(head);
    }

    const body = el("div", "dk-mbody");
    if (m.deletedAt) {
      body.appendChild(
        el("span", "dk-tomb", "Message removed by " + (m.deletedBy || "?")),
      );
    } else {
      body.appendChild(textEl(m.text));
      if (m.editedAt) {
        const e = el("span", "dk-edited", "(edited)");
        e.title = "Edited " + new Date(m.editedAt).toLocaleString();
        body.appendChild(e);
      }
    }
    // A dev can always read what a message used to say.
    if (me && me.role === "dev" && m.history && m.history.length) {
      const h = el("button", "dk-hist");
      h.type = "button";
      h.textContent = "history (" + m.history.length + ")";
      h.addEventListener("click", () => {
        let open = r.querySelector(".dk-histbox");
        if (open) return open.remove();
        open = el("div", "dk-histbox");
        for (const v of m.history) {
          const line = el("div", "dk-histline");
          line.appendChild(
            el("span", "dk-hist-t", new Date(v.ts).toLocaleString()),
          );
          line.appendChild(el("span", null, v.text));
          open.appendChild(line);
        }
        r.appendChild(open);
      });
      body.appendChild(h);
    }
    r.appendChild(body);

    // On touch layouts the tool row stays hidden until the message is tapped,
    // so a dev scrolling the floor is not looking at a column of bins.
    r.addEventListener("click", (e) => {
      if (e.target.closest("button, textarea, a, input")) return;
      r.classList.toggle("tools");
    });

    // Every message can be replied to; your own can be edited for five
    // minutes and deleted; a dev can delete anything.
    const own =
      me &&
      m.author &&
      m.author.label === me.label &&
      m.author.role === me.role;
    if (!m.deletedAt) {
      const tools = el("div", "dk-mtools");
      const rb = btn("dk-tool", null, "fa-reply", "Reply");
      rb.addEventListener("click", () => startReply(m));
      tools.appendChild(rb);
      if (own && Date.now() - m.ts < 5 * 60 * 1000) {
        const eb = btn("dk-tool", null, "fa-pen", "Edit");
        eb.addEventListener("click", () => startEdit(r, m));
        tools.appendChild(eb);
      }
      if (own || (me && me.role === "dev")) {
        const db = btn(
          "dk-tool",
          null,
          "fa-trash",
          own ? "Delete" : "Delete (dev)",
        );
        armTwice(db, null, () => socket.emit("desk delete", { id: m.id }));
        tools.appendChild(db);
      }
      r.appendChild(tools);
    }
    return r;
  }

  // Arm the composer to answer a specific message. The bar above the box says
  // so, and sending carries the link.
  let replyTo = null; // { id, label, text }
  function startReply(m) {
    replyTo = {
      id: m.id,
      label: m.author ? m.author.label : "system",
      text: String(m.text || "").slice(0, 90),
    };
    renderReplyBar();
    if (els.composer) els.composer.focus();
  }
  function clearReply() {
    replyTo = null;
    renderReplyBar();
  }
  function renderReplyBar() {
    if (!els.replyBar) return;
    els.replyBar.textContent = "";
    if (!replyTo) {
      els.replyBar.style.display = "none";
      return;
    }
    els.replyBar.style.display = "";
    els.replyBar.appendChild(icon("fa-reply"));
    els.replyBar.appendChild(
      el("span", "dk-rb-w", "Replying to " + replyTo.label),
    );
    els.replyBar.appendChild(el("span", "dk-rb-t", replyTo.text));
    const x = btn("dk-rb-x", null, "fa-xmark", "Cancel the reply");
    x.addEventListener("click", clearReply);
    els.replyBar.appendChild(x);
  }

  function startEdit(node, m) {
    const body = node.querySelector(".dk-mbody");
    if (!body || body.querySelector("textarea")) return;
    body.textContent = "";
    const ta = el("textarea", "dk-editbox");
    ta.value = m.text;
    ta.maxLength = 1200;
    const save = btn("dk-minib", "Save", "fa-check");
    const cancel = btn("dk-minib", "Cancel", "fa-xmark");
    save.addEventListener("click", () => {
      const t = ta.value.trim();
      if (t && t !== m.text) socket.emit("desk edit", { id: m.id, text: t });
      else updateRow(m);
    });
    cancel.addEventListener("click", () => updateRow(m));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save.click();
      }
      if (e.key === "Escape") cancel.click();
    });
    body.appendChild(ta);
    body.appendChild(save);
    body.appendChild(cancel);
    ta.focus();
  }

  // Destructive buttons ask once, inline: first tap arms, second confirms.
  function armTwice(b, label, fn) {
    let armed = false;
    let timer = null;
    b.addEventListener("click", () => {
      if (armed) {
        clearTimeout(timer);
        armed = false;
        b.classList.remove("armed");
        fn();
        return;
      }
      armed = true;
      b.classList.add("armed");
      if (label) b.title = label;
      timer = setTimeout(() => {
        armed = false;
        b.classList.remove("armed");
      }, 2600);
    });
  }

  // ── Ping cards ────────────────────────────────────────────────────────────
  function pingCard(m) {
    const p = m.ping || {};
    const r = el("div", "dk-ping s-" + (p.status || "open"));
    r.dataset.id = m.id;

    const head = el("div", "dk-ping-h");
    head.appendChild(
      el("span", "dk-ping-badge", (p.status || "open").toUpperCase()),
    );
    head.appendChild(
      el(
        "span",
        "dk-ping-t",
        "@" + (p.wants || "mod") + " needed in " + (p.roomName || "?"),
      ),
    );
    const t = el("span", "dk-mtime", relTime(m.ts));
    t.title = new Date(m.ts).toLocaleString();
    head.appendChild(t);
    r.appendChild(head);

    const meta = el("div", "dk-ping-m");
    meta.appendChild(
      el(
        "span",
        null,
        "Asked by " +
          (p.byLabel || "?") +
          " - " +
          (p.count || 0) +
          " in the room",
      ),
    );
    if (p.staffThere && p.staffThere.length)
      meta.appendChild(
        el("span", "dk-ping-staff", "Staff there: " + p.staffThere.join(", ")),
      );
    if (p.status === "claimed" && p.claimedBy)
      meta.appendChild(el("span", "dk-ping-claim", p.claimedBy + " is on it"));
    if (p.status === "resolved")
      meta.appendChild(
        el(
          "span",
          "dk-ping-done",
          "Resolved by " +
            (p.resolvedBy || "?") +
            (p.note ? ' - "' + p.note + '"' : ""),
        ),
      );
    r.appendChild(meta);

    if (p.actions && p.actions.length) {
      const acts = el("div", "dk-ping-acts");
      for (const a of p.actions.slice(-6)) {
        acts.appendChild(
          el(
            "div",
            "dk-ping-act",
            a.by + " " + a.action + (a.target ? " on " + a.target : ""),
          ),
        );
      }
      r.appendChild(acts);
    }

    const bar = el("div", "dk-ping-b");
    if (p.status === "open" || p.status === "waiting") {
      const claim = btn("dk-minib primary", "Claim", "fa-hand");
      claim.addEventListener("click", () =>
        socket.emit("desk ping claim", { id: m.id }),
      );
      bar.appendChild(claim);
    }
    if (p.status !== "resolved") {
      const res = btn("dk-minib", "Resolve", "fa-check");
      res.addEventListener("click", () =>
        ask(
          {
            title: "Resolve this ping",
            label: "What happened? (optional)",
            max: 200,
            icon: '<i class="fas fa-check"></i>',
          },
          (note) => socket.emit("desk ping resolve", { id: m.id, note }),
        ),
      );
      bar.appendChild(res);
    }
    const insp = btn("dk-minib", "Inspect", "fa-eye");
    insp.addEventListener("click", () => openInspector(p.roomId));
    bar.appendChild(insp);
    const join = btn("dk-minib", "Join", "fa-door-open");
    // The live room list knows how full it is; the card only knows how many
    // were in it when the ping went up.
    join.addEventListener("click", () =>
      enterRoom(
        (presence.rooms || []).find((x) => x.id === p.roomId) || {
          id: p.roomId,
          name: p.roomName,
        },
      ),
    );
    bar.appendChild(join);
    const watch = btn("dk-minib", "Watch", "fa-binoculars");
    watch.addEventListener("click", () =>
      window.open(roomUrl(p.roomId, true), "_blank"),
    );
    bar.appendChild(watch);
    r.appendChild(bar);
    return r;
  }

  // ── Side pane: who is on, and the room map ────────────────────────────────
  // Two lines per person, one line per room. The detail lives in tooltips,
  // so the pane reads at a glance instead of scrolling forever.
  // Room types, in the same words the lobby uses.
  const ROOM_TYPE = {
    public: {
      cls: "pub",
      icon: "fa-globe",
      short: "public",
      label: "Public room - anybody can walk in",
    },
    "semi-private": {
      cls: "semi",
      icon: "fa-user-check",
      short: "code only",
      label: "Semi-private, needs an access code",
    },
    private: {
      cls: "priv",
      icon: "fa-lock",
      short: "private",
      label: "Private room, invite only",
    },
  };

  function locText(l) {
    if (l.kind === "room") return 'in "' + (l.roomName || "?") + '"';
    if (l.kind === "watch") return 'watching "' + (l.roomName || "?") + '"';
    if (l.kind === "dashboard") return "on the dashboard";
    if (l.kind === "desk") return "at the Desk";
    return "in the lobby";
  }

  function locLine(s) {
    const parts = [];
    for (const l of s.locations || []) {
      const t = locText(l);
      if (!parts.includes(t)) parts.push(t);
    }
    if (!parts.length) return "around";
    const extra = parts.length - 2;
    return extra > 0
      ? parts.slice(0, 2).join(", ") + " +" + extra + " more"
      : parts.join(", ");
  }

  const rankKey = (s) =>
    s.role === "dev" ? "dev" : (s.level || 2) >= 2 ? "l2" : "l1";

  // One row for a person. The rank is carried by the group heading above
  // them, so it is not repeated on every line.
  function staffRow(s, offline) {
    const row = el("div", "dk-staff" + (offline ? " off" : ""));
    // The whole identity opens their record: the picture and the name are the
    // two things people actually aim at.
    const open = (e) => {
      e.stopPropagation();
      openRecord(s.label, s.role, s.level);
    };
    const face = faceEl(s, "sm");
    face.classList.add("clickable");
    face.title = "Open " + s.label + "'s record";
    face.addEventListener("click", open);
    row.appendChild(face);
    const w = el("div", "dk-staff-w");
    const nameLine = el("div", "dk-staff-n");
    const nameBtn = el("button", "dk-staff-name clickable", s.label);
    nameBtn.type = "button";
    nameBtn.title = "Open " + s.label + "'s record";
    nameBtn.addEventListener("click", open);
    nameLine.appendChild(nameBtn);
    if (s.hidden) nameLine.appendChild(el("span", "dk-chip ghost", "HIDDEN"));
    if (s.vanished)
      nameLine.appendChild(el("span", "dk-chip ghost", "VANISHED"));
    w.appendChild(nameLine);
    const differs =
      s.alias && s.alias.toLowerCase() !== (s.label || "").toLowerCase();
    const sub = offline
      ? s.lastActive
        ? "last on " + relTime(s.lastActive) + " ago"
        : "nothing on record yet"
      : (differs ? 'as "' + s.alias + '", ' : "") + locLine(s);
    const subEl = el("div", "dk-staff-l", sub);
    // The full story on hover, however many tabs they have open.
    subEl.title =
      (s.alias ? 'Appearing as "' + s.alias + '"\n' : "") +
      (s.locations || []).map(locText).join("\n");
    w.appendChild(subEl);
    row.appendChild(w);
    return row;
  }

  // Devs, then full mods, then juniors, each under their own heading. Twelve
  // people each wearing their own rank chip was a column of noise; the rank
  // only needs saying once.
  function byRank(list) {
    return [
      {
        key: "dev",
        label: "Developers",
        rows: list.filter((s) => rankKey(s) === "dev"),
      },
      {
        key: "l2",
        label: "Full mods",
        rows: list.filter((s) => rankKey(s) === "l2"),
      },
      {
        key: "l1",
        label: "Junior mods",
        rows: list.filter((s) => rankKey(s) === "l1"),
      },
    ].filter((g) => g.rows.length);
  }

  function groupHead(g) {
    const h = el("div", "dk-group " + g.key);
    h.appendChild(el("span", "dk-group-n", g.label));
    h.appendChild(el("span", "dk-group-c", String(g.rows.length)));
    return h;
  }

  function renderSide() {
    if (!els.side || !me) return;
    const side = els.side;
    side.textContent = "";

    side.appendChild(
      el("div", "dk-side-h", "On now - " + presence.staff.length),
    );
    for (const g of byRank(presence.staff)) {
      side.appendChild(groupHead(g));
      for (const s of g.rows) side.appendChild(staffRow(s, false));
    }
    if (!presence.staff.length)
      side.appendChild(el("div", "dk-rail-empty", "Nobody is on."));

    side.appendChild(
      el("div", "dk-side-h", "Rooms - " + presence.rooms.length),
    );
    for (const room of presence.rooms.slice(0, 20)) {
      // Three lines, all of them saying what they mean. The old card had a
      // bare icon and a bare number in the corner and you had to already know
      // that they meant "public" and "how many are in it".
      const card = el("div", "dk-room");
      const t = ROOM_TYPE[room.type] || ROOM_TYPE.public;
      const full = !!room.cap && room.n >= room.cap;

      const top = el("div", "dk-room-top");
      const name = el("span", "dk-room-n", room.name || "?");
      name.title = (room.name || "?") + "  (id " + room.id + ")";
      top.appendChild(name);
      const count = el("span", "dk-room-c" + (full ? " full" : ""));
      count.appendChild(icon("fa-user"));
      count.appendChild(
        document.createTextNode(
          " " + room.n + (room.cap ? " / " + room.cap : ""),
        ),
      );
      count.title = room.cap
        ? room.n + " of " + room.cap + " seats taken"
        : room.n === 1
          ? "1 person inside"
          : room.n + " people inside";
      top.appendChild(count);
      card.appendChild(top);

      // Every tag is a word, not a symbol you have to have been taught.
      const tags = el("div", "dk-room-tags");
      const tag = (text, cls, fa, title) => {
        const s = el("span", "dk-rtag" + (cls ? " " + cls : ""));
        if (fa) s.appendChild(icon(fa));
        s.appendChild(document.createTextNode(text));
        if (title) s.title = title;
        tags.appendChild(s);
      };
      tag(t.short, "t-" + t.cls, t.icon, t.label);
      if (full)
        tag("full", "full", "fa-circle-exclamation", "Nobody else can get in");
      if (room.locked) tag("locked", "warn", "fa-lock", "Nobody new can join");
      if (room.slow)
        tag("slow mode", "warn", "fa-gauge-simple", "Typing is rate limited");
      if (room.n > 0 && (!room.staff || !room.staff.length))
        tag(
          "no staff",
          "none",
          "fa-user-slash",
          "Nobody from the team is in here",
        );
      else if (room.staff && room.staff.length)
        tag(
          room.staff.length === 1
            ? room.staff[0]
            : room.staff.length + " staff",
          "ok",
          "fa-user-shield",
          "Staff inside: " + room.staff.join(", "),
        );
      card.appendChild(tags);

      const bar = el("div", "dk-room-bar");
      const insp = btn("dk-minib", "Inspect", "fa-eye");
      insp.title = "See inside without going in";
      insp.addEventListener("click", () => openInspector(room.id));
      bar.appendChild(insp);
      const join = btn("dk-minib", "Join", "fa-door-open");
      join.title = "Open this room in a new tab";
      join.addEventListener("click", () => enterRoom(room));
      bar.appendChild(join);
      card.appendChild(bar);
      side.appendChild(card);
    }
    if (!presence.rooms.length)
      side.appendChild(el("div", "dk-rail-empty", "No rooms open right now."));
  }

  const roomUrl = (id, watch) =>
    "/room.html?roomId=" +
    encodeURIComponent(id) +
    (watch ? "&spectate=1" : "");

  // Walking into a full room is allowed - staff bypass the limit - but it
  // makes the room 6 of 5 for everybody in it, and watching does the same job
  // without taking a seat. So the full case asks first, and leads with watch.
  function enterRoom(room) {
    const id = room && (room.id || room.roomId);
    if (!id) return;
    const cap = room.cap || null;
    const n = room.n != null ? room.n : null;
    const full = cap && n != null && n >= cap;
    if (!full) return window.open(roomUrl(id), "_blank");
    if (!window.StaffUI || !window.StaffUI.menu) {
      window.open(roomUrl(id, true), "_blank");
      return;
    }
    StaffUI.menu({
      title: "That room is full",
      icon: '<i class="fas fa-door-closed"></i>',
      subtitle:
        (room.name || "The room") + " is at " + n + " of " + cap + " seats",
      groups: [
        {
          title: "How do you want to go in",
          items: [
            {
              icon: '<i class="fas fa-eye"></i>',
              label: "Watch it",
              desc:
                "Read everything live without taking a seat. Nobody is pushed out and the room stays at " +
                n +
                " of " +
                cap +
                ".",
              onClick: () => window.open(roomUrl(id, true), "_blank"),
            },
            {
              icon: '<i class="fas fa-door-open"></i>',
              label: "Join anyway",
              desc:
                "Staff are allowed past the limit, so the room becomes " +
                (n + 1) +
                " of " +
                cap +
                " while you are in it.",
              danger: true,
              onClick: () => window.open(roomUrl(id), "_blank"),
            },
          ],
        },
      ],
    });
  }

  // ── Room inspector ────────────────────────────────────────────────────────
  // See into a room and act without joining it. The buttons reuse the same
  // staff events the dashboard fires, so every permission check stays where
  // it already lives - on the server.
  function openInspector(roomId) {
    if (!roomId) return;
    mode = "inspector";
    inspectorRoom = { roomId, loading: true };
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    socket.emit("desk room info", { roomId });
    renderMain();
  }

  function renderInspector() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    const d = inspectorRoom || {};
    if (els.headSub) els.headSub.textContent = "inspector";

    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", () => {
      mode = "chat";
      renderAll();
    });
    bar.appendChild(back);
    bar.appendChild(
      el("span", "dk-threadbar-t", d.name || "Room " + (d.roomId || "")),
    );
    if (d.cap)
      bar.appendChild(
        el(
          "span",
          "dk-chip ghost" + ((d.users || []).length >= d.cap ? " hot" : ""),
          (d.users || []).length + " / " + d.cap,
        ),
      );
    if (d.locked) bar.appendChild(el("span", "dk-chip ghost", "LOCKED"));
    if (d.slow) bar.appendChild(el("span", "dk-chip ghost", "SLOW"));
    const refresh = btn("dk-minib", null, "fa-rotate", "Refresh");
    refresh.addEventListener("click", () =>
      socket.emit("desk room info", { roomId: d.roomId }),
    );
    bar.appendChild(refresh);
    const watch = btn("dk-minib", "Watch", "fa-binoculars");
    watch.title = "Read it live without taking a seat";
    watch.addEventListener("click", () =>
      window.open(roomUrl(d.roomId, true), "_blank"),
    );
    bar.appendChild(watch);
    const join = btn("dk-minib", "Join", "fa-door-open");
    join.addEventListener("click", () =>
      enterRoom({
        id: d.roomId,
        name: d.name,
        cap: d.cap || null,
        n: (d.users || []).length,
      }),
    );
    bar.appendChild(join);
    main.appendChild(bar);

    const list = el("div", "dk-msgs");
    if (d.loading) list.appendChild(el("div", "dk-empty", "Looking..."));
    else if (d.gone)
      list.appendChild(el("div", "dk-empty", "That room is gone."));
    else if (!d.users || !d.users.length)
      list.appendChild(el("div", "dk-empty", "Nobody in the room."));
    else {
      const canBan = me && (me.role === "dev" || (me.level || 2) >= 2);
      for (const u of d.users) {
        const row = el("div", "dk-occ");
        const head = el("div", "dk-occ-h");
        head.appendChild(el("span", "dk-occ-n", u.username || "?"));
        if (u.isDev) head.appendChild(el("span", "dk-chip dev", "DEV"));
        else if (u.isMod)
          head.appendChild(
            el(
              "span",
              "dk-chip " + ((u.modLevel || 2) >= 2 ? "l2" : "l1"),
              rankName((u.modLevel || 2) >= 2 ? "l2" : "l1"),
            ),
          );
        if (u.location) head.appendChild(el("span", "dk-occ-l", u.location));
        row.appendChild(head);

        // Staff rows get no action buttons; the server refuses anyway, this
        // just keeps the interface honest about it.
        if (!u.isDev && !u.isMod) {
          const acts = el("div", "dk-occ-b");
          const warn = btn("dk-minib", "Warn", "fa-triangle-exclamation");
          warn.addEventListener("click", () =>
            ask(
              {
                title: "Warn " + (u.username || "user"),
                label: "The warning they will see",
                value: "Please follow the room rules.",
                max: 1000,
                icon: '<i class="fas fa-triangle-exclamation"></i>',
              },
              (message) =>
                socket.emit("staff warn", { targetUserId: u.id, message }),
            ),
          );
          acts.appendChild(warn);
          const wipe = btn("dk-minib", "Wipe", "fa-eraser");
          armTwice(wipe, null, () =>
            socket.emit("staff wipe buffer", { targetUserId: u.id }),
          );
          acts.appendChild(wipe);
          const kick = btn("dk-minib danger", "Kick", "fa-user-slash");
          armTwice(kick, null, () =>
            socket.emit("staff kick", { targetUserId: u.id, ban: false }),
          );
          acts.appendChild(kick);
          if (canBan) {
            const kb = btn("dk-minib danger", "Kick + ban", "fa-ban");
            armTwice(kb, null, () =>
              socket.emit("staff kick", { targetUserId: u.id, ban: true }),
            );
            acts.appendChild(kb);
          }
          row.appendChild(acts);
        }
        list.appendChild(row);
      }
    }
    main.appendChild(list);
  }

  // ── The team ──────────────────────────────────────────────────────────────
  // Everyone who holds a key, on or off, so you can see at a glance whether
  // there is anybody to hand something to.
  let roster = null;

  // ── One appeal, as a conversation ─────────────────────────────────────────
  // The same thread the dashboard shows and the banned user is typing into.
  // Opened from the #queues card, because deciding a ban without being able to
  // ask a question is how bad bans stay in place.
  let appeal = null; // the open appeal, live-updated by the server
  const appealDraft = new Map();
  let appealReply = null;

  // ── One staff member's record, from anywhere ──────────────────────────────
  // Clicking a name or a face on the Desk asks the server the same question
  // the dashboard asks, and shows the answer in place. The Desk is on every
  // page, so this is usually the fastest way to check who somebody is before
  // handing them something.
  let recordFor = null; // { label, role, level }

  // What level somebody holds, from whoever on the Desk happens to know: the
  // presence rows, the roster, the message that was clicked. The server's
  // record reply carries their actions, not their rank, so without this every
  // record card called everybody a full mod - devs and juniors included.
  function levelFor(label, fallback) {
    const want = String(label || "").toLowerCase();
    if (!want) return fallback;
    const lists = [presence.staff || [], roster || []];
    for (const list of lists)
      for (const s of list)
        if (String(s.label || "").toLowerCase() === want) {
          if (s.role === "dev") return 0;
          if (s.level != null) return s.level;
        }
    return fallback;
  }

  function openRecord(label, role, level) {
    if (!label) return;
    const known = levelFor(label, level);
    recordFor = {
      label,
      role: role === "dev" ? "dev" : "mod",
      level: known,
      loading: true,
    };
    socket.emit("staff get mod history", { label, role: recordFor.role, limit: 12 });
    showRecord();
  }

  function showRecord() {
    if (!els.record) {
      els.record = el("div", "dk-rec");
      els.record.addEventListener("click", (e) => {
        if (e.target === els.record) closeRecord();
      });
      els.panel.appendChild(els.record);
    }
    const h = recordFor || {};
    els.record.textContent = "";
    els.record.style.display = "";

    const card = el("div", "dk-rec-c");
    const head = el("div", "dk-rec-h");
    head.appendChild(
      faceEl({ label: h.label, role: h.role, level: h.level }, "sm"),
    );
    const ht = el("div", "dk-rec-ht");
    ht.appendChild(el("span", "dk-rec-n", h.label || "Staff"));
    const r = rankOf({ role: h.role, level: h.level });
    ht.appendChild(el("span", "dk-chip " + r, rankName(r)));
    head.appendChild(ht);
    const x = btn("dk-hbtn", null, "fa-xmark", "Close");
    x.addEventListener("click", closeRecord);
    head.appendChild(x);
    card.appendChild(head);

    const body = el("div", "dk-rec-b");
    if (h.loading) {
      body.appendChild(el("div", "dk-empty", "Looking..."));
    } else {
      const grid = el("div", "dk-rec-g");
      const stat = (n, label, cls) => {
        const c = el("div", "dk-rec-s" + (cls ? " " + cls : ""));
        c.appendChild(el("div", "dk-rec-sn", String(n)));
        c.appendChild(el("div", "dk-rec-sl", label));
        grid.appendChild(c);
      };
      stat(h.onUsers || 0, "actions on users", "lead");
      stat(h.useful || 0, "not passive");
      stat(h.total || 0, "logged in total");
      stat(h.distinctTargets || 0, "different people");
      body.appendChild(grid);
      if (h.last)
        body.appendChild(
          el("div", "dk-rec-when", "Last action " + relTime(h.last) + " ago"),
        );
      if (h.flags && h.flags.length) {
        body.appendChild(el("div", "dk-side-h", "Worth a look"));
        for (const f of h.flags.slice(0, 4))
          body.appendChild(el("div", "dk-rec-flag", f.title || f.kind || "flag"));
      }
      body.appendChild(el("div", "dk-side-h", "Recent"));
      const list = h.entries || [];
      if (!list.length) body.appendChild(el("div", "dk-empty", "Nothing yet."));
      for (const e of list.slice(0, 12)) {
        const row = el("div", "dk-rec-e");
        row.appendChild(el("span", "dk-rec-ea", e.action || "?"));
        if (e.target)
          row.appendChild(el("span", "dk-rec-et", String(e.target).replace(/^user:/, "")));
        row.appendChild(el("span", "dk-rec-ew", relTime(e.ts)));
        body.appendChild(row);
      }
      body.appendChild(
        el(
          "div",
          "dk-rec-foot",
          "The full record, with the flags and every page of it, is in the dashboard.",
        ),
      );
    }
    card.appendChild(body);
    els.record.appendChild(card);
  }

  function closeRecord() {
    recordFor = null;
    if (els.record) els.record.style.display = "none";
  }

  // One appeal's conversation, drawn into `host`. Bubbles, not rows: the
  // banned person on the left, staff on the right, so who is answering whom is
  // readable without stopping to read a name. Several moderators in one thread
  // is the case that used to get confusing, so every staff message carries its
  // own face and name, and only repeats them when the speaker changes.
  function appealThread(host, a) {
    const msgs = (a.messages || []).slice();
    if (!msgs.length) {
      host.appendChild(el("div", "dk-empty", "Nothing said yet."));
      return;
    }
    let lastKey = null;
    let lastTs = 0;
    for (const m of msgs) {
      if (m.from === "system") {
        host.appendChild(el("div", "dk-ap-sys", m.text));
        lastKey = null;
        continue;
      }
      const mine = m.from === "staff";
      // Two messages group when the same person sends them close together.
      const key = mine ? "staff:" + (m.by || "?") : "user";
      const grouped = key === lastKey && m.ts - lastTs < 5 * 60 * 1000;
      lastKey = key;
      lastTs = m.ts;

      const row = el(
        "div",
        "dk-ap-m " + (mine ? "staff" : "user") + (grouped ? " grouped" : ""),
      );

      // The face column. Empty on a grouped message so a run from one person
      // reads as one block rather than a column of repeated pictures.
      const gutter = el("div", "dk-ap-gut");
      if (!grouped) {
        if (mine) {
          // faceEl falls back to the remembered picture, so a moderator whose
          // message predates their avatar still shows the face you know them
          // by across the rest of the Desk.
          rememberAvatar(m.by, m.avatar);
          const f = faceEl(
            { label: m.by, role: m.role, level: m.level, avatar: m.avatar },
            "sm",
          );
          // Clicking a moderator opens their record, the same as anywhere else
          // on the Desk.
          f.classList.add("clickable");
          f.title = "Open " + (m.by || "their") + "'s record";
          f.addEventListener("click", (e) => {
            e.stopPropagation();
            openRecord(m.by, m.role === "dev" ? "dev" : "mod", m.level);
          });
          gutter.appendChild(f);
        } else {
          const f = el("span", "dk-av sm banned");
          f.appendChild(el("span", "dk-av-i", initialOf(a.name || "?")));
          f.title = (a.name || "This user") + " - the banned user";
          gutter.appendChild(f);
        }
      }
      row.appendChild(gutter);

      const stack = el("div", "dk-ap-stack");
      if (!grouped) {
        const who = el("div", "dk-ap-who");
        if (mine) {
          const nm = el("button", "dk-ap-name", m.by || "Staff");
          nm.type = "button";
          nm.title = "Open " + (m.by || "their") + "'s record";
          nm.addEventListener("click", (e) => {
            e.stopPropagation();
            openRecord(m.by, m.role === "dev" ? "dev" : "mod", m.level);
          });
          who.appendChild(nm);
          const r = m.role === "dev" ? "dev" : (m.level || 2) >= 2 ? "l2" : "l1";
          who.appendChild(el("span", "dk-chip " + r, rankName(r)));
        } else {
          who.appendChild(el("span", "dk-ap-name plain", a.name || "Banned user"));
          who.appendChild(el("span", "dk-chip banned", "BANNED"));
        }
        const t = el("span", "dk-ap-t", relTime(m.ts));
        t.title = new Date(m.ts).toLocaleString();
        who.appendChild(t);
        stack.appendChild(who);
      }

      const b = el("div", "dk-ap-bub");
      if (m.reply)
        b.appendChild(
          el(
            "div",
            "dk-ap-quote",
            (m.reply.from === "staff"
              ? m.reply.by || "Staff"
              : a.name || "Them") +
              ": " +
              m.reply.text,
          ),
        );
      b.appendChild(textEl(m.text, "dk-ap-txt"));
      // Clicking a message is the quick way to answer it: it arms the reply
      // exactly as the reply button does.
      if (a.status === "open") {
        b.classList.add("clickable");
        b.title = "Click to reply to this";
        b.addEventListener("click", () => {
          appealReply = {
            id: m.id,
            by: mine ? m.by || "Staff" : a.name || "Them",
            text: String(m.text || "").slice(0, 90),
          };
          renderAppeal();
          const box = els.main && els.main.querySelector(".dk-comp .dk-input");
          if (box) box.focus();
        });
      }
      stack.appendChild(b);
      row.appendChild(stack);
      host.appendChild(row);
    }
  }

  function openAppeal(id) {
    mode = "appeal";
    appeal = appeal && appeal.id === id ? appeal : { id, loading: true };
    appealReply = null;
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    socket.emit("staff appeal open", { id });
    renderAll();
  }

  function renderAppeal() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    if (els.headSub) els.headSub.textContent = "appeal";
    const a = appeal || {};

    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", () => {
      socket.emit("staff appeal open", { id: null });
      appeal = null;
      backToChat();
    });
    bar.appendChild(back);
    bar.appendChild(
      el("span", "dk-threadbar-t", (a.name || "A banned user") + "'s appeal"),
    );
    if (a.status === "resolved")
      bar.appendChild(
        el(
          "span",
          "dk-chip ghost",
          a.resolution === "lifted" ? "BAN LIFTED" : "DECLINED",
        ),
      );
    else if (a.stillBlocked)
      bar.appendChild(el("span", "dk-chip ghost", "STILL BLOCKED"));
    main.appendChild(bar);

    const body = el("div", "dk-msgs");
    if (a.loading) {
      body.appendChild(el("div", "dk-empty", "Looking..."));
      main.appendChild(body);
      return;
    }

    // What they are contesting, so a decision is not made blind.
    const head = el("div", "dk-ap-ban");
    head.appendChild(icon("fa-ban"));
    const hb = el("div", "dk-ap-ban-b");
    hb.appendChild(
      el(
        "span",
        "dk-ap-ban-t",
        (a.banPermanent ? "Permanent ban" : "Temporary ban") +
          (a.banBy ? " by " + a.banBy : ""),
      ),
    );
    hb.appendChild(
      el("span", "dk-ap-ban-r", a.banReason || "No ban reason on file."),
    );
    head.appendChild(hb);
    body.appendChild(head);

    appealThread(body, a);
    main.appendChild(body);
    // Land on the newest line without animating past the whole history.
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });

    if (a.status !== "open") {
      main.appendChild(
        el(
          "div",
          "dk-readonly",
          a.resolution === "lifted"
            ? "Ban lifted" + (a.reviewedBy ? " by " + a.reviewedBy : "") + "."
            : "Appeal declined" +
              (a.reviewedBy ? " by " + a.reviewedBy : "") +
              ". The ban stays in place.",
        ),
      );
      // Anybody can ask for a second look, including whoever declined it.
      if (a.resolution !== "lifted" && isFullMod()) {
        const acts = el("div", "dk-ap-acts");
        const re = btn("dk-minib", "Reopen this appeal", "fa-rotate-left");
        re.title = "Put it back on the board and give them their reply box back";
        re.addEventListener("click", () =>
          ask(
            {
              title: "Reopen this appeal",
              message:
                "It goes back on the board and they can write again. Say why, so the next person reading it knows what changed.",
              label: "Why (optional, they see this)",
              max: 300,
              icon: '<i class="fas fa-rotate-left"></i>',
            },
            (note) =>
              socket.emit("staff appeal reopen", {
                id: a.id,
                note: String(note || "").trim(),
              }),
          ),
        );
        acts.appendChild(re);
        main.appendChild(acts);
      }
      return;
    }

    if (appealReply) {
      const rb = el("div", "dk-replybar");
      rb.appendChild(icon("fa-reply"));
      rb.appendChild(el("span", "dk-rb-w", "Replying to " + appealReply.by));
      rb.appendChild(el("span", "dk-rb-t", appealReply.text));
      const x = btn("dk-rb-x", null, "fa-xmark", "Cancel the reply");
      x.addEventListener("click", () => {
        appealReply = null;
        renderAppeal();
      });
      main.appendChild(rb);
    }

    const comp = el("div", "dk-comp");
    const ta = el("textarea", "dk-input");
    ta.rows = 1;
    ta.maxLength = 1000;
    ta.placeholder = a.locked
      ? "Chat ended for them - you can still write"
      : "Ask them what happened...";
    ta.value = appealDraft.get(a.id) || "";
    ta.addEventListener("input", () => appealDraft.set(a.id, ta.value));
    const send = () => {
      const text = ta.value.trim();
      if (!text) return;
      socket.emit("staff appeal reply", {
        id: a.id,
        text,
        replyTo: appealReply ? appealReply.id : undefined,
      });
      appealDraft.delete(a.id);
      appealReply = null;
      ta.value = "";
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    comp.appendChild(ta);
    const sendBtn = btn("dk-send", null, "fa-paper-plane", "Send");
    sendBtn.addEventListener("click", send);
    comp.appendChild(sendBtn);
    main.appendChild(comp);

    // The decision, and the way to stop somebody flooding the thread while it
    // is still being made.
    const acts = el("div", "dk-ap-acts");
    const lock = btn(
      "dk-minib",
      a.locked ? "Reopen chat" : "End chat",
      a.locked ? "fa-lock-open" : "fa-lock",
    );
    lock.title = a.locked
      ? "Let them write again"
      : "Stop them writing. The appeal stays open and you still decide it.";
    lock.addEventListener("click", () =>
      socket.emit("staff appeal lock", { id: a.id, locked: !a.locked }),
    );
    acts.appendChild(lock);
    if (isDev() && a.stillBlocked) {
      const lift = btn("dk-minib primary", "Lift the ban", "fa-unlock");
      armTwice(lift, "Lift it for good?", () =>
        socket.emit("staff resolve appeal", { id: a.id, decision: "lift" }),
      );
      acts.appendChild(lift);
    }
    const decline = btn("dk-minib danger", "Decline", "fa-xmark");
    decline.addEventListener("click", () =>
      ask(
        {
          title: "Decline this appeal",
          message:
            "The ban stays in place. What you write is the last thing they read on their ban screen.",
          label: "Message to them (optional)",
          max: 300,
          icon: '<i class="fas fa-xmark"></i>',
        },
        (note) =>
          socket.emit("staff resolve appeal", {
            id: a.id,
            decision: "dismiss",
            note: String(note || "").trim(),
          }),
      ),
    );
    acts.appendChild(decline);
    main.appendChild(acts);
  }

  function openTeam() {
    mode = "team";
    roster = null;
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    socket.emit("desk roster");
    renderAll();
  }

  function backToChat() {
    mode = "chat";
    renderAll();
  }

  function viewBar(title, extra) {
    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", backToChat);
    bar.appendChild(back);
    bar.appendChild(el("span", "dk-threadbar-t", title));
    if (extra) bar.appendChild(el("span", "dk-threadbar-s", extra));
    return bar;
  }

  function renderTeam() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    if (els.headSub) els.headSub.textContent = "the team";

    const list = roster || [];
    const on = list.filter((s) => !s.offline);
    const off = list.filter((s) => s.offline);
    main.appendChild(
      viewBar(
        "The team",
        roster ? on.length + " on, " + off.length + " off" : "",
      ),
    );

    const body = el("div", "dk-msgs");
    if (!roster) {
      body.appendChild(el("div", "dk-empty", "Looking..."));
      main.appendChild(body);
      return;
    }

    // Same shape as the side panel: on or off first, then grouped by rank
    // with the rank said once at the top of each group.
    const section = (label, rows, offline) => {
      if (!rows.length) return;
      body.appendChild(el("div", "dk-side-h", label));
      for (const g of byRank(rows)) {
        body.appendChild(groupHead(g));
        for (const s of g.rows) {
          const row = staffRow(s, offline);
          if (!offline) {
            const room = (s.locations || []).find((l) => l.roomId);
            if (room) {
              const go = btn(
                "dk-ib",
                null,
                "fa-eye",
                "Inspect " + room.roomName,
              );
              go.addEventListener("click", () => openInspector(room.roomId));
              row.appendChild(go);
            }
          }
          body.appendChild(row);
        }
      }
    };

    section("On now", on, false);
    section("Off", off, true);
    if (!list.length)
      body.appendChild(el("div", "dk-empty", "No staff keys yet."));
    main.appendChild(body);
  }

  // ── How this works ────────────────────────────────────────────────────────
  function openHelp() {
    mode = "help";
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    renderAll();
  }

  // The guide. Written as data so it stays one place to edit, and rendered
  // through the same message renderer as chat - so every #channel and @name in
  // it is a real link, and the formatting examples show themselves working.
  const HELP = [
    {
      icon: "fa-comments",
      tone: "orange",
      h: "What the Desk is",
      p: [
        "The staff room. It rides along on every page, so you never have to leave a room to talk to the team or to act on somebody.",
        "Only people holding a staff key can see it. Regular users cannot tell it exists.",
        "Drag the header to move the panel, pull the bottom right corner to resize it, and drag the Desk button itself anywhere on the page. All three are remembered.",
      ],
    },
    {
      icon: "fa-hashtag",
      tone: "blue",
      h: "The channels",
      list: [
        ["#floor", "Day to day talk. Start here."],
        [
          "#help",
          "Calls for backup from rooms. Cards, not chat. Anything unread or unclaimed in here turns the Desk button red - nothing else does.",
        ],
        [
          "#queues",
          "Reports, appeals, applications and suggestions as they arrive, each a card you can act on without leaving. Full mods and devs.",
        ],
        ["#l2", "Bans, blocks and escalations. Full mods and devs."],
        ["#devs", "Keys, promotions, abuse flags. Developers only."],
        ["#stats", "How each day went, written by the server at midnight."],
        ["#guide", "This page. Point anybody at it by writing its name."],
      ],
    },
    {
      icon: "fa-at",
      tone: "purple",
      h: "Naming people",
      p: [
        'Type "@" and the team appears - everyone with a key, on or off. Pick one and their name goes in marked, and they are pinged.',
        "Somebody who is off is not a wasted ping: it waits as an unread mention and is the first thing they see when they sign back in. You are told at the time who was off.",
        "Groups save typing eight names: @everyone, @L2 mods, @L1 mods, @devs. They are exclusive - @L2 mods does not reach developers, and the list tells you how many people each one actually reaches before you send it.",
        'Not the same as calling for backup: "@mod" typed in a ROOM raises a card in #help. "@" in here just names a person.',
      ],
    },
    {
      icon: "fa-hand",
      tone: "amber",
      h: "Calling for backup",
      p: [
        'Type "@mod" or "@dev" in your normal room textbox. A card appears in #help with the room, how many people are in it, and who asked.',
        "Claim it before you act. Everyone sees who took it, including the person who asked, so two of you never land on the same user.",
        "Anything you do in that room while the card is open is attached to it, so the card ends up being the record of what happened.",
      ],
    },
    {
      icon: "fa-inbox",
      tone: "green",
      h: "Working the queue",
      p: [
        "Every report, appeal, application and suggestion lands in #queues as a card with the buttons on it: warn, kick, block or discard a report, approve or decline an application, open an appeal. Same events the dashboard fires, so your level still decides what goes through.",
        "The moment anybody deals with something - here, in the dashboard, or from a room - the card says who did it and what they did, so two of you never chase the same report.",
        "Cards clear themselves after a day. #queues is a tray, not an archive: the dashboard feed and the audit log are where things are kept.",
      ],
    },
    {
      icon: "fa-scale-balanced",
      tone: "amber",
      h: "Appeals are a conversation",
      p: [
        "A ban appeal is a chat, not a note. Open it from its card in #queues and ask what actually happened - they answer from their ban screen, and you both see the same thread.",
        "End chat stops them writing without deciding anything, for the one who answers every question with twenty messages. The appeal stays open and you still judge it.",
        "Declining takes a message. Whatever you write is the last thing they read on their ban screen, so a refusal is never just a closed door. Lifting a ban is a developer call.",
      ],
    },
    {
      icon: "fa-keyboard",
      tone: "blue",
      h: "Writing a message",
      p: [
        "Links are clickable. **bold**, *italic*, ~~strike~~ and `code` all work, three backticks on their own line open a code block, and lines starting with - become a list.",
        "Emotes are the same ones the rooms have, written the same way: a colon, the code, a colon. Type a colon and two letters and the list narrows as you go, or press the face next to the send button to browse them.",
        "Shift+Enter starts a new line without sending. Hover a message to reply to it; the quote above your reply links back to the original.",
        "Scrolled up reading something? New messages stop pulling you down and a bar appears saying how many came in. Click it to jump back to the latest.",
      ],
    },
    {
      icon: "fa-eye",
      tone: "blue",
      h: "Acting without joining",
      p: [
        "Inspect on any room or ping card shows you who is inside. Warn, wipe and kick are right there. Ban and IP block appear if you are a full mod.",
        "The room list says what each room is in words, and how full it is. Joining a full room asks first: staff get in past the limit, but that makes it 6 of 5 for everybody in there. Watching reads it live without taking a seat, which is usually what you wanted.",
      ],
    },
    {
      icon: "fa-terminal",
      tone: "orange",
      h: "Commands and threads",
      p: [
        "Type a slash and the full list appears. Every command does exactly what the matching button does.",
        'Names with spaces go in quotes: /warn "sasha here" please stop. Stuck? Ask in plain words: /help how do I ban someone.',
        "Threads are for side discussions. One that goes quiet for a day drops into the archive, but it is never deleted and stays searchable.",
      ],
    },
    {
      icon: "fa-circle-info",
      tone: "red",
      h: "Things worth knowing",
      p: [
        "Developers can read every channel and thread, including edits and deleted messages. That is deliberate, and it is said out loud here rather than hidden.",
        "Hiding your flair hides you from users, never from the team. Your Desk name is always your staff name.",
        "Nothing you say here counts as moderation work. The leaderboard only counts what you do to actual users, and it only lists people who currently hold a key.",
      ],
    },
  ];

  function renderHelp() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    if (els.headSub) els.headSub.textContent = "#guide";
    main.appendChild(viewBar("How the Desk works", "#guide"));

    const body = el("div", "dk-msgs dk-help");

    // One line at the top that says what to do with this page.
    const hero = el("div", "dk-help-hero");
    hero.appendChild(icon("fa-book-open"));
    const ht = el("div", "dk-help-hero-t");
    ht.appendChild(el("span", "dk-help-hero-h", "Everything the Desk does"));
    const hp = el("span", "dk-help-hero-p");
    inlineInto(
      hp,
      "Written for somebody who has just been handed a key. Send anybody here by writing #guide in a message.",
    );
    ht.appendChild(hp);
    hero.appendChild(ht);
    body.appendChild(hero);

    for (const s of HELP) {
      const sec = el("section", "dk-help-s" + (s.tone ? " t-" + s.tone : ""));
      const head = el("div", "dk-help-sh");
      const ic = el("span", "dk-help-si");
      ic.appendChild(icon(s.icon || "fa-circle-info"));
      head.appendChild(ic);
      head.appendChild(el("h3", "dk-help-h", s.h));
      sec.appendChild(head);
      // Through the message renderer, so the channels in the guide are real
      // links and the formatting examples demonstrate themselves.
      for (const p of s.p || []) {
        const para = el("p", "dk-help-p");
        inlineInto(para, p);
        sec.appendChild(para);
      }
      if (s.list) {
        const dl = el("div", "dk-help-list");
        for (const [k, v] of s.list) {
          const row = el("div", "dk-help-row");
          const key = el("span", "dk-help-k");
          inlineInto(key, k);
          row.appendChild(key);
          const val = el("span", "dk-help-v");
          inlineInto(val, v);
          row.appendChild(val);
          dl.appendChild(row);
        }
        sec.appendChild(dl);
      }
      body.appendChild(sec);
    }

    const cmds = el("section", "dk-help-s t-green");
    const ch = el("div", "dk-help-sh");
    const ci = el("span", "dk-help-si");
    ci.appendChild(icon("fa-slash"));
    ch.appendChild(ci);
    ch.appendChild(el("h3", "dk-help-h", "Every command"));
    cmds.appendChild(ch);
    const dl = el("div", "dk-help-list");
    for (const c of COMMANDS) {
      const row = el("div", "dk-help-row");
      row.appendChild(el("span", "dk-help-k mono", c.usage));
      row.appendChild(el("span", "dk-help-v", c.what));
      dl.appendChild(row);
    }
    cmds.appendChild(dl);
    body.appendChild(cmds);
    main.appendChild(body);
  }

  // ── Search results ────────────────────────────────────────────────────────
  function renderSearch() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    if (els.headSub) els.headSub.textContent = "search";

    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", () => {
      mode = "chat";
      if (els.searchInput) els.searchInput.value = "";
      renderAll();
    });
    bar.appendChild(back);
    bar.appendChild(el("span", "dk-threadbar-t", "Search"));
    main.appendChild(bar);

    const list = el("div", "dk-msgs");
    if (searchHits == null)
      list.appendChild(el("div", "dk-empty", "Searching..."));
    else if (!searchHits.length)
      list.appendChild(el("div", "dk-empty", "Nothing matched."));
    else
      for (const h of searchHits) {
        const row = el("button", "dk-hit");
        row.type = "button";
        const head = el("div", "dk-hit-h");
        head.appendChild(
          el("span", "dk-hit-w", h.title ? h.title : "#" + h.key),
        );
        head.appendChild(el("span", "dk-mtime", relTime(h.ts) + " ago"));
        row.appendChild(head);
        row.appendChild(
          el("div", "dk-hit-t", (h.author ? h.author + ": " : "") + h.text),
        );
        row.addEventListener("click", () => jumpTo(h.key, h.ts));
        list.appendChild(row);
      }
    main.appendChild(list);
  }

  // Open the place a search hit lives, landed right on the moment it was
  // said, with the message flashed so the eye finds it.
  function jumpTo(key, ts) {
    view = key.startsWith("t")
      ? { kind: "thread", key }
      : { kind: "channel", key };
    mode = "chat";
    replyTo = null;
    if (els.searchInput) els.searchInput.value = "";
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    renderAll();
    socket.emit("desk history", { key, around: ts });
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  // Typed straight into the composer. Every command fires the same staff
  // event a button would, so the server's permission gates decide everything;
  // the composer only saves the walk to the right screen.
  const COMMANDS = [
    {
      name: "warn",
      usage: "/warn <name or id> <message>",
      what: "Send them a staff warning",
    },
    {
      name: "kick",
      usage: "/kick <name or id>",
      what: "Remove them from their room",
    },
    {
      name: "ban",
      usage: "/ban <name or id>",
      what: "Kick with a room ban (full mods)",
    },
    { name: "wipe", usage: "/wipe <name or id>", what: "Clear their textbox" },
    {
      name: "note",
      usage: "/note <name or id> <text>",
      what: "Put a note on their record",
    },
    {
      name: "ipban",
      usage: "/ipban <ip, client id or name> [1h|24h|7d|permanent] [reason]",
      what: "Place an IP block (full mods)",
    },
    {
      name: "unban",
      usage: "/unban <ip>",
      what: "Lift an IP block (full mods)",
    },
    {
      name: "inspect",
      usage: "/inspect <room name or id>",
      what: "See who is in a room",
    },
    {
      name: "join",
      usage: "/join <room name or id>",
      what: "Open the room in a new tab",
    },
    {
      name: "watch",
      usage: "/watch <room name or id>",
      what: "Spectate in a new tab",
    },
    { name: "thread", usage: "/thread <title>", what: "Start a thread" },
    { name: "find", usage: "/find <text>", what: "Search staff chat" },
    { name: "help", usage: "/help", what: "Show this list" },
  ];
  const DURATIONS = ["1h", "24h", "7d", "permanent"];
  let lastCommandAt = 0;

  // Multi-word names go in quotes: /warn "sasha was here" stop that.
  function splitTarget(rest) {
    rest = rest.trim();
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end > 0)
        return { target: rest.slice(1, end), rest: rest.slice(end + 1).trim() };
    }
    const sp = rest.indexOf(" ");
    if (sp === -1) return { target: rest, rest: "" };
    return { target: rest.slice(0, sp), rest: rest.slice(sp + 1).trim() };
  }

  function resolveUser(q) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off("desk resolve", fn);
        resolve(null);
      }, 2500);
      const fn = (d) => {
        if (!d || d.q !== q) return;
        clearTimeout(timer);
        socket.off("desk resolve", fn);
        resolve(d);
      };
      socket.on("desk resolve", fn);
      socket.emit("desk resolve", { q });
    });
  }

  // Turn what they typed into one connected user, or say plainly why not.
  async function targetUser(q) {
    if (!q) {
      toast("Say who: a name, or a user id. Quotes for names with spaces.");
      return null;
    }
    const d = await resolveUser(q);
    if (!d) {
      toast("No answer from the server. Try again.");
      return null;
    }
    if (!d.matches.length) {
      toast('Nobody connected matches "' + q + '".');
      return null;
    }
    if (!d.exact && d.matches.length > 1) {
      toast(
        "Which one? " +
          d.matches.map((m) => m.username).join(", ") +
          ". Use the exact name in quotes, or the id.",
      );
      return null;
    }
    return d.matches[0];
  }

  function findRoom(q) {
    if (!q) {
      toast("Say which room: its name or its number.");
      return null;
    }
    const rooms = presence.rooms || [];
    const ql = q.toLowerCase();
    const hits = rooms.filter((r) => r.id === q).length
      ? rooms.filter((r) => r.id === q)
      : rooms.filter((r) => (r.name || "").toLowerCase() === ql).length
        ? rooms.filter((r) => (r.name || "").toLowerCase() === ql)
        : rooms.filter((r) => (r.name || "").toLowerCase().includes(ql));
    if (!hits.length) {
      toast('No open room matches "' + q + '".');
      return null;
    }
    if (hits.length > 1) {
      toast(
        "Which room? " +
          hits
            .slice(0, 4)
            .map((r) => r.name + " (" + r.id + ")")
            .join(", "),
      );
      return null;
    }
    return hits[0];
  }

  const looksLikeIp = (s) =>
    /^[0-9a-f.:]+$/i.test(s) && (s.includes(".") || s.includes(":"));
  const looksLikeClientId = (s) =>
    /^[a-f0-9-]{8,64}$/i.test(s) && s.includes("-");

  async function runCommand(line) {
    lastCommandAt = Date.now();
    const sp = line.indexOf(" ");
    const name = (sp === -1 ? line.slice(1) : line.slice(1, sp)).toLowerCase();
    const rest = sp === -1 ? "" : line.slice(sp + 1).trim();
    const { target, rest: after } = splitTarget(rest);

    switch (name) {
      case "help":
        if (rest) askBot(rest);
        else openHelp();
        return;
      case "warn": {
        const u = await targetUser(target);
        if (!u) return;
        socket.emit("staff warn", {
          targetUserId: u.id,
          message: after || "Please follow the room rules.",
        });
        return;
      }
      case "kick": {
        const u = await targetUser(target);
        if (u) socket.emit("staff kick", { targetUserId: u.id, ban: false });
        return;
      }
      case "ban": {
        const u = await targetUser(target);
        if (u) socket.emit("staff kick", { targetUserId: u.id, ban: true });
        return;
      }
      case "wipe": {
        const u = await targetUser(target);
        if (u) socket.emit("staff wipe buffer", { targetUserId: u.id });
        return;
      }
      case "note": {
        if (!after)
          return toast(
            "Usage: " + COMMANDS.find((c) => c.name === "note").usage,
          );
        const u = await targetUser(target);
        if (u) socket.emit("staff note", { targetUserId: u.id, note: after });
        return;
      }
      case "ipban": {
        const { target: d0, rest: r0 } = splitTarget(after);
        const duration = DURATIONS.includes(d0.toLowerCase())
          ? d0.toLowerCase()
          : "24h";
        const reason = DURATIONS.includes(d0.toLowerCase()) ? r0 : after;
        if (looksLikeIp(target) || looksLikeClientId(target)) {
          socket.emit("staff ban ip", { ip: target, duration, reason });
          return;
        }
        const u = await targetUser(target);
        if (u)
          socket.emit("staff ip block", {
            targetUserId: u.id,
            duration,
            reason,
          });
        return;
      }
      case "unban": {
        if (!looksLikeIp(target) && !looksLikeClientId(target))
          return toast(
            "Usage: /unban <ip>. Mods can also lift bans from the dashboard's ban list.",
          );
        socket.emit("dev unblock ip", { ip: target });
        return;
      }
      case "inspect": {
        const room = findRoom(rest);
        if (room) openInspector(room.id);
        return;
      }
      case "join": {
        const room = findRoom(rest);
        if (room)
          window.open(
            "/room.html?roomId=" + encodeURIComponent(room.id),
            "_blank",
          );
        return;
      }
      case "watch": {
        const room = findRoom(rest);
        if (room)
          window.open(
            "/room.html?roomId=" + encodeURIComponent(room.id) + "&spectate=1",
            "_blank",
          );
        return;
      }
      case "thread": {
        if (!rest) return toast("Usage: /thread <title>");
        socket.emit("desk thread create", { title: rest.slice(0, 60) });
        return;
      }
      case "find": {
        if (rest.length < 2) return toast("Usage: /find <text>");
        searchHits = null;
        mode = "search";
        socket.emit("desk search", { q: rest });
        renderMain();
        return;
      }
      default:
        toast("No command called /" + name + ". Type /help for the list.");
    }
  }

  // ── The help bot ──────────────────────────────────────────────────────────
  // Ask in plain words and it points at the command. It answers only to you,
  // in the channel you are looking at, and is never sent to anybody else or
  // saved: it is a hint, not a message.
  const BOT_TOPICS = [
    {
      words: ["ban", "block", "ip", "blacklist", "banned"],
      say: "To block a connection, use /ipban. It takes a name, a raw IP, or a client id, so it works whether they are online or you only have the address off a report.",
      cmds: ["ipban", "unban", "ban"],
    },
    {
      words: ["kick", "remove", "boot", "eject", "throw"],
      say: "/kick removes them from their room. /ban does the same and stops them coming back to that room, if you are a full mod.",
      cmds: ["kick", "ban"],
    },
    {
      words: ["warn", "warning", "tell", "message"],
      say: "/warn sends them a private staff warning. Whatever you type after their name is what they read.",
      cmds: ["warn"],
    },
    {
      words: ["wipe", "clear", "textbox", "buffer", "erase"],
      say: "/wipe clears what somebody has typed into their box, without removing them from the room.",
      cmds: ["wipe"],
    },
    {
      words: ["note", "record", "remember", "history"],
      say: "/note puts a line on their record that every staff member sees next time they come up.",
      cmds: ["note"],
    },
    {
      words: ["room", "inspect", "watch", "spectate", "join", "see", "look"],
      say: "/inspect shows you who is in a room without joining it, and the buttons to act are right there. /watch opens it read only, /join walks in properly.",
      cmds: ["inspect", "watch", "join"],
    },
    {
      words: ["search", "find", "said", "earlier", "history", "past"],
      say: "/find searches everything you are allowed to read. Clicking a result drops you at that exact moment in the conversation.",
      cmds: ["find"],
    },
    {
      words: ["thread", "discussion", "side", "topic"],
      say: "/thread starts a side discussion. It archives after a quiet day but is never deleted.",
      cmds: ["thread"],
    },
    {
      words: ["ping", "backup", "help", "call", "mod", "dev", "@"],
      say: 'Type "@mod" or "@dev" in your room textbox, not here. A card appears in #help with the room and who asked, and somebody claims it.',
      cmds: [],
    },
    {
      words: ["reply", "quote", "answer", "respond"],
      say: "Hover a message and hit the reply arrow. Your message then carries a quote of theirs that links back to it.",
      cmds: [],
    },
    {
      words: ["hide", "hidden", "flair", "badge", "incognito"],
      say: "Hiding your flair hides you from users, never from the team. You still show here, marked HIDDEN, and you can be disliked in rooms while you are passing as a normal user.",
      cmds: [],
    },
    {
      words: ["stats", "numbers", "yesterday", "daily", "how many"],
      say: "#stats gets a short summary of each day from the server: how many people came by, how many rooms opened, how busy it got.",
      cmds: [],
    },
  ];

  function askBot(question) {
    const q = question.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const t of BOT_TOPICS) {
      let score = 0;
      for (const w of t.words) if (q.includes(w)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) {
      botSay(
        'Not sure about that one. Type a slash on its own to see every command, or open "How this works" in the left column.',
        [],
      );
      return;
    }
    botSay(best.say, best.cmds);
  }

  // A message only you can see, in the channel you are in.
  function botSay(text, cmdNames) {
    if (!els.list) return;
    const r = el("div", "dk-bot");
    const head = el("div", "dk-bot-h");
    head.appendChild(icon("fa-robot"));
    head.appendChild(el("span", "dk-bot-n", "Desk help"));
    head.appendChild(el("span", "dk-bot-only", "only you can see this"));
    r.appendChild(head);
    r.appendChild(el("div", "dk-bot-t", text));
    const cmds = (cmdNames || [])
      .map((n) => COMMANDS.find((c) => c.name === n))
      .filter(Boolean);
    if (cmds.length) {
      const bar = el("div", "dk-bot-b");
      for (const c of cmds) {
        const b = el("button", "dk-bot-cmd");
        b.type = "button";
        b.textContent = c.usage;
        b.title = c.what + ". Click to fill it in.";
        b.addEventListener("click", () => {
          const box = els.composer;
          if (!box) return;
          box.value = "/" + c.name + " ";
          box.focus();
          drafts.set(viewKey(), box.value);
        });
        bar.appendChild(b);
      }
      r.appendChild(bar);
    }
    const close = btn("dk-bot-x", null, "fa-xmark", "Dismiss");
    close.addEventListener("click", () => r.remove());
    r.appendChild(close);

    const stick = nearBottom();
    els.list.appendChild(r);
    if (stick) els.list.scrollTop = els.list.scrollHeight;
  }

  // ── The list above the composer ───────────────────────────────────────────
  // Three things can fill it and only one is ever up: a slash command, a
  // channel after "#", or a person after "@". Nothing in here sends anything
  // or runs anything - it only ever writes into the box.
  let palette = { rows: [], idx: -1, kind: null };

  const paletteOpen = () =>
    !!(
      els.palette &&
      els.palette.style.display !== "none" &&
      palette.rows.length
    );

  function hidePalette() {
    palette = { rows: [], idx: -1, kind: null };
    if (els.palette) {
      els.palette.textContent = "";
      els.palette.style.display = "none";
    }
  }

  function paintPalette() {
    palette.rows.forEach((r, i) =>
      r.node.classList.toggle("on", i === palette.idx),
    );
    const active = palette.rows[palette.idx];
    if (active && active.node.scrollIntoView)
      active.node.scrollIntoView({ block: "nearest" });
  }

  function movePalette(step) {
    if (!palette.rows.length) return;
    const n = palette.rows.length;
    palette.idx = (((palette.idx < 0 ? 0 : palette.idx + step) % n) + n) % n;
    paintPalette();
  }

  function choosePalette(i) {
    const row = palette.rows[i];
    if (row) row.apply();
  }

  // Swap the half-typed token under the caret for the finished one.
  function applyToken(ta, start, end, insert) {
    const v = ta.value;
    ta.value = v.slice(0, start) + insert + v.slice(end);
    const at = start + insert.length;
    ta.focus();
    try {
      ta.setSelectionRange(at, at);
    } catch (_) {}
    drafts.set(viewKey(), ta.value);
    if (els.sizeTa) els.sizeTa();
    hidePalette();
  }

  function openPalette(kind, rows, startIdx) {
    if (!els.palette || !rows.length) return hidePalette();
    els.palette.textContent = "";
    for (const r of rows) els.palette.appendChild(r.node);
    palette = { rows, idx: startIdx, kind };
    els.palette.style.display = "";
    els.palette.scrollTop = 0;
    paintPalette();
  }

  // What is being typed at the caret decides which list appears.
  function updatePalette(ta) {
    if (!ta || !els.palette) return;
    const v = ta.value;
    const caret = ta.selectionStart == null ? v.length : ta.selectionStart;
    const head = v.slice(0, caret);
    // A slash only ever means a command at the very start of the box.
    if (v.startsWith("/") && !/\s/.test(head)) return showCommands(head, ta);
    // ":ka" - a colon and at least two letters, the way it works everywhere
    // else. One letter would put a list up on every "10:3" and "note: ".
    const em = /(^|[\s(]):([A-Za-z0-9_.-]{2,40})$/.exec(head);
    if (em)
      return showEmotes(
        em[2].toLowerCase(),
        caret - em[2].length - 1,
        caret,
        ta,
      );
    const m = /(^|[\s(])([#@])([^\s#@]{0,40})$/.exec(head);
    if (!m) return hidePalette();
    const q = m[3].toLowerCase();
    const start = caret - q.length - 1;
    if (m[2] === "#") return showChannels(q, start, caret, ta);
    return showPeople(q, start, caret, ta);
  }

  function showCommands(value, ta) {
    const q = value.slice(1).split(" ")[0].toLowerCase();
    const hits = COMMANDS.filter((c) => c.name.startsWith(q));
    const rows = hits.map((c) => {
      const node = el("button", "dk-cmd");
      node.type = "button";
      node.appendChild(el("span", "dk-cmd-u", c.usage));
      node.appendChild(el("span", "dk-cmd-w", c.what));
      const apply = () => {
        const box = ta || els.composer;
        if (box) {
          box.value = "/" + c.name + " ";
          box.focus();
          drafts.set(viewKey(), box.value);
          if (els.sizeTa) els.sizeTa();
        }
        hidePalette();
      };
      node.addEventListener("click", apply);
      return { node, apply };
    });
    // Nothing is highlighted, so Enter still runs what has been typed rather
    // than completing it - the way the palette has always behaved.
    openPalette("cmd", rows, -1);
  }

  function showChannels(q, start, end, ta) {
    const score = (c) => (c.name.toLowerCase().startsWith(q) ? 0 : 1);
    // The guide is written the same way a channel is, so it is offered here
    // the same way too.
    const all = channels.concat(VIRTUAL_CHANNELS);
    const hits = all
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.alt || []).some((a) => a.includes(q)),
      )
      .sort((a, b) => score(a) - score(b))
      .slice(0, 8);
    if (!hits.length) return hidePalette();
    const rows = hits.map((c) => {
      const node = el("button", "dk-pick");
      node.type = "button";
      if (c.icon) {
        const face = el("span", "dk-pick-hash");
        face.appendChild(icon(c.icon));
        node.appendChild(face);
      } else node.appendChild(el("span", "dk-pick-hash", "#"));
      const mid = el("span", "dk-pick-mid");
      mid.appendChild(el("span", "dk-pick-n", c.name));
      if (c.desc) mid.appendChild(el("span", "dk-pick-s", c.desc));
      node.appendChild(mid);
      if (c.restricted) node.appendChild(icon("fa-lock"));
      const apply = () => applyToken(ta, start, end, "#" + c.name + " ");
      node.addEventListener("click", apply);
      return { node, apply };
    });
    openPalette("chan", rows, 0);
  }

  // Typing a colon and a couple of letters. Two before it opens, so an
  // ordinary colon in the middle of a sentence does not put a list up.
  function showEmotes(q, start, end, ta) {
    const codes = Object.keys(emotes);
    if (!codes.length) return hidePalette();
    const score = (c) => (c.toLowerCase().startsWith(q) ? 0 : 1);
    const hits = codes
      .filter((c) => c.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          score(a) - score(b) || a.length - b.length || (a < b ? -1 : 1),
      )
      .slice(0, 8);
    if (!hits.length) return hidePalette();
    const rows = hits.map((c) => {
      const node = el("button", "dk-pick");
      node.type = "button";
      const face = el("span", "dk-pick-em");
      face.appendChild(emoteImg(c));
      node.appendChild(face);
      const mid = el("span", "dk-pick-mid");
      mid.appendChild(el("span", "dk-pick-n", ":" + c + ":"));
      node.appendChild(mid);
      const apply = () => applyToken(ta, start, end, ":" + c + ": ");
      node.addEventListener("click", apply);
      return { node, apply };
    });
    openPalette("emote", rows, 0);
  }

  // ── The emote picker ──────────────────────────────────────────────────────
  // For when you know the face and not the word. Same list as the palette,
  // laid out as a grid with a box to narrow it down.
  const emotePickerOpen = () =>
    !!(els.emotes && els.emotes.style.display !== "none");

  function insertEmote(code) {
    const box = els.composer;
    if (!box) return;
    const at = box.selectionStart == null ? box.value.length : box.selectionStart;
    const to = box.selectionEnd == null ? at : box.selectionEnd;
    applyToken(box, at, to, ":" + code + ": ");
  }

  function paintEmoteGrid(grid, q) {
    grid.textContent = "";
    const want = String(q || "").toLowerCase();
    const codes = Object.keys(emotes)
      .filter((c) => !want || c.toLowerCase().includes(want))
      .sort()
      .slice(0, 300);
    if (!codes.length) {
      grid.appendChild(
        el(
          "div",
          "dk-emnone",
          Object.keys(emotes).length
            ? "Nothing matches that."
            : "The emote list has not loaded.",
        ),
      );
      return;
    }
    for (const c of codes) {
      const b = el("button", "dk-emb");
      b.type = "button";
      b.title = ":" + c + ":";
      b.appendChild(emoteImg(c));
      b.addEventListener("click", () => {
        insertEmote(c);
        toggleEmotePicker(false);
      });
      grid.appendChild(b);
    }
  }

  function toggleEmotePicker(on) {
    const host = els.emotes;
    if (!host) return;
    const want = on == null ? !emotePickerOpen() : !!on;
    if (els.emoteBtn) els.emoteBtn.classList.toggle("on", want);
    if (!want) {
      host.style.display = "none";
      host.textContent = "";
      if (els.composer) els.composer.focus();
      return;
    }
    hidePalette();
    host.textContent = "";
    const search = el("input", "dk-emsearch");
    search.type = "text";
    search.placeholder = "Search emotes";
    search.setAttribute("aria-label", "Search emotes");
    const grid = el("div", "dk-emgrid");
    search.addEventListener("input", () => paintEmoteGrid(grid, search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        toggleEmotePicker(false);
      }
    });
    host.appendChild(search);
    host.appendChild(grid);
    paintEmoteGrid(grid, "");
    host.style.display = "";
    search.focus();
  }

  function showPeople(q, start, end, ta) {
    const people = mentionPeople();
    const score = (p) => (p.label.toLowerCase().startsWith(q) ? 0 : 1);
    const hits = people
      .filter((p) => p.label.toLowerCase().includes(q))
      .sort((a, b) => score(a) - score(b))
      .slice(0, 8);

    // Groups first: they are the shortcut, and burying them under a list of
    // names is how nobody ever finds them.
    const groups = MENTION_GROUPS.filter(
      (g) =>
        !q ||
        g.key.startsWith(q) ||
        g.tokens.some((t) => t.startsWith(q)) ||
        g.write.toLowerCase().startsWith(q),
    );
    const groupRows = groups.map((g) => {
      const reach = groupReach(g.key);
      const node = el("button", "dk-pick grp");
      node.type = "button";
      const face = el("span", "dk-pick-grp");
      face.appendChild(icon(g.icon));
      node.appendChild(face);
      const mid = el("span", "dk-pick-mid");
      mid.appendChild(el("span", "dk-pick-n", g.name));
      mid.appendChild(
        el(
          "span",
          "dk-pick-s",
          g.desc +
            " - " +
            reach.n +
            (reach.n === 1 ? " person, " : " people, ") +
            reach.on +
            " on now",
        ),
      );
      node.appendChild(mid);
      node.appendChild(el("span", "dk-chip ghost", "GROUP"));
      const apply = () => applyToken(ta, start, end, "@" + g.write + " ");
      node.addEventListener("click", apply);
      return { node, apply };
    });

    if (!hits.length && !groupRows.length) return hidePalette();
    const rows = hits.map((p) => {
      const node = el("button", "dk-pick");
      node.type = "button";
      node.appendChild(faceEl(p, "sm"));
      const mid = el("span", "dk-pick-mid");
      mid.appendChild(el("span", "dk-pick-n", p.label));
      // Whether they are here changes what the mention does, so it is said
      // before the name is picked, not after.
      mid.appendChild(
        el(
          "span",
          "dk-pick-s",
          p.online ? "On now" : "Off - it waits for them",
        ),
      );
      node.appendChild(mid);
      const r = rankOf(p);
      node.appendChild(el("span", "dk-chip " + r, rankName(r)));
      node.appendChild(el("span", "dk-pick-dot " + (p.online ? "on" : "off")));
      const apply = () => applyToken(ta, start, end, "@" + p.label + " ");
      node.addEventListener("click", apply);
      return { node, apply };
    });
    openPalette("ment", groupRows.concat(rows), 0);
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // Talkomatic's staff palette throughout: the same blacks, the same #ff9800,
  // the same role colors the dashboard uses. Fonts inherit from the page so
  // the Desk matches wherever it is mounted.
  function injectCss() {
    if (document.getElementById("dk-css")) return;
    const s = document.createElement("style");
    s.id = "dk-css";
    s.textContent = `
/* The Desk sizes itself, whatever the host page's global box model is. The
   composer in particular grows to its own scrollHeight, which is wrong by
   exactly the padding under content-box. */
.dk-panel,.dk-panel *,.dk-pill,.dk-pill *{box-sizing:border-box;}
/* Thin black scrollbars everywhere inside the Desk. The browser default is
   wide, pale, and lands right next to the message text. */
.dk-panel *{scrollbar-width:thin;scrollbar-color: #3d3d3d transparent;}
.dk-panel *::-webkit-scrollbar{width:7px;height:7px;}
.dk-panel *::-webkit-scrollbar-track{background: #000;border-radius:4px;}
.dk-panel *::-webkit-scrollbar-thumb{background: #3d3d3d;border-radius:4px;border:1px solid #000;}
.dk-panel *::-webkit-scrollbar-thumb:hover{background: #ff9800;}
.dk-panel *::-webkit-scrollbar-corner{background: #000;}
/* Bottom LEFT: the right-hand corner is where the site keeps everything else
   worth clicking, and the pill was sitting on top of it. */
.dk-pill{position:fixed;bottom:16px;left:16px;z-index:99988;background: #000;color: #fff;
  border:1px solid #ff9800;border-radius:4px;padding:10px 16px;font-size:13px;font-weight:bold;
  font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5);display:inline-flex;
  align-items:center;gap:8px;transition:background .2s,color .2s;}
.dk-pill:hover{background: #ff9800;color: #000;}
.dk-pill{touch-action:none;user-select:none;}
.dk-pill.dragging{cursor:grabbing;opacity:.9;}
.dk-pill-badge{background: #ff9800;color: #000;border-radius:9px;font-size:11px;line-height:1;
  padding:3px 7px;font-variant-numeric:tabular-nums;}
/* Red means #help, and only #help: somebody in a room is waiting for staff.
   Ordinary traffic never turns this red, which is what makes it worth
   looking at. */
.dk-pill-badge.loud{background: #ff5468;color: #fff;}
.dk-pill.urgent{border-color: #ff5468;box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 1px rgba(255,84,104,.5);
  animation:dkUrgent 2.4s ease-in-out infinite;}
.dk-pill.urgent:hover{background: #ff5468;color: #fff;}
@keyframes dkUrgent{0%,100%{box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 1px rgba(255,84,104,.5);}
  50%{box-shadow:0 6px 20px rgba(0,0,0,.5),0 0 0 4px rgba(255,84,104,.22);}}
@keyframes dkNudge{0%,100%{transform:translateY(0)}25%{transform:translateY(-4px)}50%{transform:translateY(0)}75%{transform:translateY(-2px)}}
.dk-pill.nudge{animation:dkNudge .5s ease;}
.dk-panel{position:fixed;right:16px;bottom:76px;z-index:99989;display:flex;flex-direction:column;
  width:min(1060px,calc(100vw - 32px));height:min(680px,calc(100vh - 108px));
  background: #202020;border:1px solid #616161;border-radius:8px;overflow:hidden;
  box-shadow:0 18px 55px rgba(0,0,0,.65);color: #fff;font-family:inherit;font-size:14px;}
.dk-panel.dragging{user-select:none;}
.dk-head.dk-drag{cursor:grab;}
.dk-panel.dragging .dk-head{cursor:grabbing;}
@media (min-width:761px){
  .dk-panel{resize:both;min-width:560px;min-height:420px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);}
  .dk-panel.dk-fullpage{resize:none;min-width:0;min-height:0;}
  /* A notch bigger on a desktop monitor, where it read a little far away.
     Only the body: the header stays in real pixels so dragging and the resize
     handle keep working against the same coordinates the panel is placed in. */
  /* .dk-panel qualifies these two so they outrank the base .dk-body rule
     further down the sheet, which would otherwise win on source order. */
  .dk-panel .dk-body{zoom:1.08;grid-template-columns:206px minmax(0,1fr) 290px;}
  /* The channel list sits a touch below the rest: it is a list of short names
     you aim at, not something you read, and at the body's full zoom it ate the
     panel. This lands it just above where it started. */
  .dk-panel .dk-rail{zoom:0.98;}
}
.dk-panel.dk-offline .dk-head{opacity:.55;}
.dk-panel.dk-offline .dk-head .dk-title-sub::after{content:" - reconnecting";color: #ff5468;}
.dk-head{flex:none;display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid #616161;background: #303030;}
.dk-title{flex:none;display:flex;flex-direction:column;min-width:0;}
.dk-title-main{font-weight:bold;color: #ff9800;font-size:14px;letter-spacing:.4px;}
.dk-title-sub{font-size:11px;color: #ededed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;}
.dk-search{flex:1;min-width:0;background: #000;color: #fff;border:1px solid #616161;border-radius:5px;
  padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none;}
.dk-search:focus{border-color: #ff9800;}
.dk-hbtn{flex:none;background:none;border:none;color: #fff;font-size:15px;cursor:pointer;
  padding:6px 8px;border-radius:4px;line-height:1;}
.dk-hbtn:hover{background: #ff9800;color: #000;}
.dk-burger,.dk-msearch{display:none;}
.dk-body{flex:1;display:grid;grid-template-columns:200px minmax(0,1fr) 290px;min-height:0;position:relative;}
.dk-scrim{display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);z-index:4;}
.dk-rail{background: #1b1b1b;border-right:1px solid #333;overflow-y:auto;padding:10px 8px;
  display:flex;flex-direction:column;gap:2px;}
.dk-rail-h{display:flex;align-items:center;font-size:10.5px;font-weight:bold;letter-spacing:.6px;
  text-transform:uppercase;color: #8d8d8d;padding:10px 8px 4px;}
.dk-rail-h:first-child{padding-top:2px;}
.dk-tadd{margin-left:auto;background:none;border:none;color: #8d8d8d;cursor:pointer;font-size:11px;padding:2px 4px;border-radius:3px;}
.dk-tadd:hover{color: #000;background: #ff9800;}
.dk-chan,.dk-thread{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:none;
  border:none;color: #c3c3c3;font-family:inherit;font-size:13.5px;
  padding:7px 8px;border-radius:4px;cursor:pointer;}
.dk-chan:hover,.dk-thread:hover{background: #242424;color: #fff;}
.dk-chan.on,.dk-thread.on{background: #2e2e2e;color: #fff;font-weight:bold;}
.dk-hash{color: #8d8d8d;font-weight:bold;}
.dk-chan.on .dk-hash,.dk-thread.on .fa-message{color: #ff9800;}
.dk-chan .fa-lock{font-size:9px;color: #8d8d8d;}
.dk-chan-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-b{background: #ff9800;color: #000;border-radius:8px;font-size:10.5px;font-weight:bold;
  padding:2px 6px;font-variant-numeric:tabular-nums;}
.dk-b.loud{background: #ff5468;color: #fff;}
.dk-thread .fa-message{font-size:10px;color: #8d8d8d;}
.dk-thread-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-thread.arch{opacity:.55;}
.dk-dot{width:8px;height:8px;border-radius:50%;background: #ff9800;flex:none;}
.dk-arch-toggle{background:none;border:none;color: #8d8d8d;font-family:inherit;font-size:12px;
  text-align:left;padding:7px 8px;cursor:pointer;}
.dk-arch-toggle:hover{color: #fff;}
.dk-rail-empty{color: #8d8d8d;font-size:12px;padding:6px 8px;}
.dk-rail-foot{margin-top:auto;padding:12px 8px 4px;font-size:10.5px;color: #8d8d8d;line-height:1.5;
  border-top:1px solid #2a2a2a;}
.dk-main{display:flex;flex-direction:column;min-width:0;min-height:0;background: #202020;}
.dk-chandesc{flex:none;padding:8px 14px;font-size:12px;color: #8d8d8d;border-bottom:1px solid #2a2a2a;}
.dk-threadbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;
  border-bottom:1px solid #2a2a2a;}
.dk-threadbar-t{font-weight:bold;}
.dk-threadbar-s{font-size:11.5px;color: #8d8d8d;}
.dk-msgs{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 14px;display:flex;flex-direction:column;gap:2px;}
.dk-day{text-align:center;font-size:10.5px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;
  color: #8d8d8d;padding:12px 0 6px;}
.dk-empty{color: #8d8d8d;text-align:center;padding:30px 10px;font-size:13px;}
.dk-older{align-self:center;background: #1b1b1b;border:1px solid #333;color: #c3c3c3;font-family:inherit;
  font-size:12px;padding:5px 12px;border-radius:12px;cursor:pointer;margin-bottom:8px;display:inline-flex;gap:6px;align-items:center;}
.dk-older:hover{border-color: #ff9800;color: #fff;}
.dk-msg{position:relative;padding:2px 8px 2px 46px;border-radius:5px;margin-top:10px;}
.dk-msg.grouped{margin-top:0;}
.dk-msg:hover{background: #242424;}
.dk-msg.mention{background:rgba(255,152,0,.09);}
.dk-msg.mention:hover{background:rgba(255,152,0,.14);}
@keyframes dkFlash{0%,55%{background:rgba(255,152,0,.22)}100%{background:transparent}}
.dk-msg.flash,.dk-sys.flash,.dk-ping.flash{animation:dkFlash 1.8s ease;}
.dk-av{position:absolute;left:4px;top:2px;width:32px;height:32px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-weight:bold;font-size:14px;color: #fff;background: #616161;
  overflow:hidden;flex:none;}
.dk-av.sm{position:relative;width:26px;height:26px;font-size:12px;}
.dk-av.dev{background: #a3323f;}
.dk-av.l2{background: #2b5e9e;}
.dk-av.l1{background: #6d4b9e;}
/* The letter sits underneath and the picture covers it, so a slow or failed
   load degrades to an initial instead of an empty hole. */
.dk-av-i{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
.dk-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;}
.dk-quote{display:flex;align-items:baseline;gap:6px;width:100%;text-align:left;background:none;border:none;
  font-family:inherit;color: #8d8d8d;font-size:11.5px;padding:0 0 3px 0;cursor:pointer;min-width:0;}
.dk-quote .fas{font-size:9px;flex:none;}
.dk-quote-w{color: #c3c3c3;font-weight:bold;flex:none;}
.dk-quote-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.dk-quote:hover .dk-quote-t,.dk-quote:hover{color: #fff;}
.dk-mhead{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;}
/* Who is talking, in their rank's colour and a size up from what they said.
   The name used to come out the same white, the same size and - because the
   button reset below said font:inherit - not even bold, so a name and a
   message were one wall of identical text. */
.dk-mname{font-weight:bold;font-size:14.5px;color: #fff;letter-spacing:.1px;}
.dk-mname.dev{color: #ff7a88;}
.dk-mname.l2{color: #7dbcff;}
.dk-mname.l1{color: #cfa6ff;}
.dk-chip{font-size:9px;font-weight:bold;letter-spacing:.5px;padding:1px 5px;border-radius:3px;border:1px solid;}
.dk-chip.dev{color: #ff5468;border-color: #ff5468;}
.dk-chip.l2{color: #5aa9ff;border-color: #5aa9ff;}
.dk-chip.l1{color: #c08bff;border-color: #c08bff;}
.dk-chip.ghost{color: #8d8d8d;border-color: #8d8d8d;}
.dk-alias{font-size:11px;color: #8d8d8d;font-style:italic;}
.dk-mtime{font-size:10.5px;color: #8d8d8d;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dk-mbody{font-size:13.5px;line-height:1.5;word-break:break-word;white-space:pre-wrap;color: #dedede;}
.dk-edited{font-size:10px;color: #8d8d8d;margin-left:5px;}
.dk-tomb{color: #8d8d8d;font-style:italic;font-size:12.5px;}
.dk-hist{background:none;border:none;color: #5aa9ff;font-size:10.5px;cursor:pointer;font-family:inherit;
  padding:0;margin-left:7px;text-decoration:underline;}
.dk-histbox{margin-top:5px;border-left:2px solid #333;padding-left:8px;display:flex;flex-direction:column;gap:3px;}
.dk-histline{font-size:11.5px;color: #c3c3c3;}
.dk-hist-t{color: #8d8d8d;margin-right:7px;font-size:10px;}
.dk-mtools{position:absolute;top:-10px;right:8px;display:none;gap:2px;background: #1b1b1b;
  border:1px solid #333;border-radius:4px;padding:2px;}
.dk-msg:hover .dk-mtools{display:flex;}
.dk-tool{background:none;border:none;color: #c3c3c3;cursor:pointer;font-size:11px;padding:4px 6px;border-radius:3px;}
.dk-tool:hover{background: #333;color: #fff;}
.dk-tool.armed{background: #ff5468;color: #fff;}
.dk-editbox{width:100%;background: #000;color: #fff;border:1px solid #ff9800;border-radius:5px;
  padding:7px 9px;font-family:inherit;font-size:13px;resize:vertical;min-height:40px;}
/* flex-start, not baseline: on a line that wraps, a baseline-aligned icon
   stays glued to the first line's baseline and ends up floating in the middle
   of the block. Nudged down a hair so it still sits on the first line. */
.dk-sys{display:flex;align-items:flex-start;gap:8px;font-size:12px;color: #8d8d8d;padding:5px 8px;margin-top:6px;}
.dk-sys .fas{font-size:11px;flex:none;width:1em;text-align:center;margin-top:2px;}
.dk-sys-x{min-width:0;word-break:break-word;}
.dk-sys.card{background: #1b1b1b;border:1px solid #2a2a2a;border-radius:5px;color: #c3c3c3;
  padding:8px 11px;margin-top:8px;font-size:12.5px;line-height:1.5;}
.dk-sys.q-report .fas{color: #5aa9ff;}
.dk-sys.q-appeal .fas{color: #ffb454;}
.dk-sys.q-application .fas{color: #c08bff;}
.dk-sys.q-suggestion .fas{color: #57d9a3;}
.dk-sys.q-abuse .fas{color: #ff5468;}
.dk-sys.q-invite .fas{color: #8d8d8d;}
.dk-sys-t{margin-left:auto;font-size:10px;flex:none;color: #8d8d8d;}
.dk-ping{border:1px solid rgba(255,180,84,.45);border-radius:5px;background: #1b1b1b;
  padding:10px 12px;margin-top:10px;display:flex;flex-direction:column;gap:6px;}
.dk-ping.s-waiting{border-color:rgba(255,84,104,.55);}
.dk-ping.s-claimed{border-color:rgba(90,169,255,.45);}
.dk-ping.s-resolved{border-color: #333;opacity:.75;}
.dk-ping-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dk-ping-badge{font-size:9px;font-weight:bold;letter-spacing:.6px;padding:2px 6px;border-radius:3px;
  color: #ffb454;border:1px solid #ffb454;}
@keyframes dkPulse{0%,100%{opacity:1}50%{opacity:.45}}
.dk-ping.s-open .dk-ping-badge{animation:dkPulse 1.6s infinite;}
.dk-ping.s-waiting .dk-ping-badge{color: #ff5468;border-color: #ff5468;animation:dkPulse .9s infinite;}
.dk-ping.s-claimed .dk-ping-badge{color: #5aa9ff;border-color: #5aa9ff;animation:none;}
.dk-ping.s-resolved .dk-ping-badge{color: #57d9a3;border-color: #57d9a3;animation:none;}
.dk-ping-t{font-weight:bold;font-size:13.5px;}
.dk-ping-m{display:flex;flex-direction:column;gap:2px;font-size:12px;color: #c3c3c3;}
.dk-ping-staff{color: #8d8d8d;}
.dk-ping-claim{color: #5aa9ff;font-weight:bold;}
.dk-ping-done{color: #57d9a3;}
.dk-ping-acts{border-top:1px dashed #333;padding-top:6px;display:flex;flex-direction:column;gap:2px;}
.dk-ping-act{font-size:11.5px;color: #8d8d8d;}
.dk-ping-b{display:flex;gap:6px;flex-wrap:wrap;}
.dk-minib{display:inline-flex;align-items:center;gap:6px;background: #1b1b1b;border:1px solid #616161;
  color: #fff;font-family:inherit;font-size:12px;font-weight:bold;padding:6px 10px;border-radius:4px;cursor:pointer;}
.dk-minib:hover{border-color: #ff9800;}
.dk-minib.primary{background: #ff9800;border-color: #ff9800;color: #000;}
.dk-minib.primary:hover{background: #ffad33;}
.dk-minib.danger{color: #ff5468;}
.dk-minib.danger:hover{background: #ff5468;border-color: #ff5468;color: #fff;}
.dk-minib.armed{background: #ff5468;border-color: #ff5468;color: #fff;}
.dk-readonly{flex:none;padding:12px 14px;border-top:1px solid #333;background: #1b1b1b;
  font-size:12px;color: #6f6f6f;text-align:center;}
.dk-sys.q-stats .fas{color: #ff9800;}
.dk-sys.q-stats{font-size:13px;color: #fff;}

/* ── Queue cards ──
   A tray of things to do, so each one is a card with its own buttons rather
   than a line in a wall of text. The left edge carries the kind's colour. */
/* Square corners because of the strip: a radius clips it into a tapered
   sliver, and the strip is what says what kind of card this is. */
.dk-q{margin-top:10px;background: #1b1b1b;border:1px solid #2a2a2a;border-left:3px solid #616161;
  border-radius:0;padding:9px 12px;display:flex;flex-direction:column;gap:8px;}
.dk-q.q-report{border-left-color: #5aa9ff;}
.dk-q.q-appeal{border-left-color: #ffb454;}
.dk-q.q-application{border-left-color: #c08bff;}
.dk-q.q-suggestion{border-left-color: #57d9a3;}
.dk-q.q-abuse{border-left-color: #ff5468;}
.dk-q.is-done{opacity:.62;}
.dk-q-h{display:flex;align-items:flex-start;gap:9px;min-width:0;}
.dk-q-ico{flex:none;width:24px;height:24px;border-radius:5px;background: #252525;display:flex;
  align-items:center;justify-content:center;font-size:11px;color: #8d8d8d;}
.q-report .dk-q-ico{color: #5aa9ff;background:rgba(90,169,255,.12);}
.q-appeal .dk-q-ico{color: #ffb454;background:rgba(255,180,84,.12);}
.q-application .dk-q-ico{color: #c08bff;background:rgba(192,139,255,.12);}
.q-suggestion .dk-q-ico{color: #57d9a3;background:rgba(87,217,163,.12);}
.q-abuse .dk-q-ico{color: #ff5468;background:rgba(255,84,104,.12);}
.dk-q-who{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px;}
.dk-q-kind{font-size:9.5px;font-weight:bold;letter-spacing:.7px;text-transform:uppercase;color: #8d8d8d;}
.dk-q-hl{font-size:13.5px;font-weight:bold;color: #fff;word-break:break-word;}
.dk-q-t{flex:none;font-size:10px;color: #8d8d8d;}
.dk-q-b{display:flex;flex-direction:column;gap:7px;min-width:0;}
.dk-q-chips{display:flex;flex-wrap:wrap;gap:5px;}
.dk-q-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;color: #c3c3c3;
  background: #252525;border:1px solid #333;border-radius:3px;padding:2px 7px;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-q-chip .fas{font-size:9px;color: #8d8d8d;}
.dk-q-chip.cat{color: #fff;border-color: #4a4a4a;}
.dk-q-chip.hot{color: #ff5468;border-color:rgba(255,84,104,.5);}
.dk-q-chip.warn{color: #ffb454;border-color:rgba(255,180,84,.5);}
.dk-q-chip.quiet{color: #8d8d8d;background:transparent;}
.dk-q-f{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dk-q-fl{font-size:9.5px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color: #6f6f6f;}
.dk-q-fv{font-size:12.5px;color: #ededed;line-height:1.5;word-break:break-word;
  overflow-wrap:anywhere;white-space:pre-wrap;}
.dk-q-f.quote .dk-q-fv{background: #000;border-left:2px solid #333;border-radius:0;
  padding:6px 9px;color: #c3c3c3;max-height:120px;overflow:auto;}
.dk-q-acts-list{display:flex;flex-direction:column;gap:4px;}
.dk-q-note{font-size:11px;color: #6f6f6f;line-height:1.5;}
.dk-q-acts{display:flex;flex-wrap:wrap;gap:6px;padding-top:2px;}
.dk-q-acts .dk-minib{font-size:11.5px;padding:5px 9px;}
.dk-q-done{display:flex;align-items:center;gap:6px;font-size:11.5px;color: #57d9a3;
  border-top:1px dashed #333;padding-top:7px;}
.dk-q-done .fas{font-size:10px;}

/* ── The daily summary ── */
.dk-st{margin-top:10px;background: #1b1b1b;border:1px solid #3a3126;
  border-radius:6px;padding:11px 13px;display:flex;flex-direction:column;gap:10px;
  /* The card measures itself, not the window: the panel can be dragged down to
     560px with both rails open, and the grid below has to answer to that. */
  container-type:inline-size;}
.dk-st-h{display:flex;align-items:center;gap:8px;}
.dk-st-h .fas{color: #ff9800;font-size:12px;}
.dk-st-day{font-size:13.5px;font-weight:bold;color: #ff9800;letter-spacing:.2px;flex:1;min-width:0;}
/* Six numbers, three across, two down. auto-fit put five on one line and left
   the sixth on a row of its own, which read like an afterthought. Three is
   fixed rather than fitted, so the shape is the same every day. */
.dk-st-g{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;}
/* Below this a third tile is thinner than the words in it, so it drops to two
   and then to one rather than shredding every label. A phone lands here. */
@container (max-width:380px){.dk-st-g{grid-template-columns:repeat(2,minmax(0,1fr));}}
@container (max-width:250px){.dk-st-g{grid-template-columns:minmax(0,1fr);}}
.dk-st-c{background: #141414;border:1px solid #2a2a2a;border-radius:5px;padding:8px 10px;min-width:0;}
.dk-st-c.lead{border-color:rgba(255,152,0,.35);}
.dk-st-n{display:flex;align-items:center;gap:6px;font-size:17px;font-weight:bold;color: #fff;
  font-variant-numeric:tabular-nums;line-height:1.2;}
.dk-st-n .fas{font-size:11px;color: #6f6f6f;}
.dk-st-c.lead .dk-st-n{color: #ff9800;}
.dk-st-c.lead .dk-st-n .fas{color: #ff9800;}
.dk-st-c.warn .dk-st-n{color: #ffb454;}
.dk-st-l{font-size:11px;color: #c3c3c3;margin-top:3px;line-height:1.3;}
.dk-st-s{font-size:10px;color: #8d8d8d;margin-top:2px;line-height:1.35;}
.dk-st-sub{font-size:11px;color: #8d8d8d;margin-top:-2px;}

/* ── One appeal, as a conversation ──
   Theirs on the left, staff on the right. Same thread the banned user is
   typing into on their ban screen. */
.dk-ap-ban{display:flex;gap:9px;align-items:flex-start;background: #1b1b1b;border:1px solid #2a2a2a;
  border-left:3px solid #ff5468;padding:9px 12px;margin-bottom:10px;}
.dk-ap-ban > .fas{color: #ff5468;font-size:12px;margin-top:2px;flex:none;}
.dk-ap-ban-b{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dk-ap-ban-t{font-size:12.5px;font-weight:bold;}
.dk-ap-ban-r{font-size:12px;color: #8d8d8d;line-height:1.5;word-break:break-word;}
/* Bubbles, not rows. The banned person is on the left with a face and a
   BANNED tag, staff are on the right; a run from one person keeps one face
   and one name. Nothing here wears a coloured edge strip - the side of the
   panel it sits on is what says who is talking. */
.dk-ap-m{display:flex;gap:8px;margin-top:10px;max-width:86%;align-items:flex-end;}
.dk-ap-m.grouped{margin-top:2px;}
.dk-ap-m.staff{margin-left:auto;flex-direction:row-reverse;}
.dk-ap-gut{flex:none;width:26px;}
.dk-ap-stack{display:flex;flex-direction:column;gap:3px;min-width:0;}
.dk-ap-m.staff .dk-ap-stack{align-items:flex-end;}
.dk-ap-who{display:flex;align-items:center;gap:6px;font-size:11px;color: #8d8d8d;flex-wrap:wrap;}
.dk-ap-m.staff .dk-ap-who{flex-direction:row-reverse;}
.dk-ap-name{font-weight:bold;color: #ff9800;background:none;border:none;padding:0;
  font-family:inherit;font-size:11.5px;cursor:pointer;}
.dk-ap-name:hover{text-decoration:underline;}
.dk-ap-name.plain{color: #c3c3c3;cursor:default;}
.dk-ap-name.plain:hover{text-decoration:none;}
.dk-chip.banned{color: #ff5468;border-color: #ff5468;}
.dk-av.banned{background: #4a2a30;}
.dk-ap-bub{background: #262626;padding:8px 11px;font-size:13px;line-height:1.55;
  word-break:break-word;border-radius:12px 12px 12px 3px;max-width:100%;}
.dk-ap-m.staff .dk-ap-bub{background: #7a4d05;color: #fff;border-radius:12px 12px 3px 12px;}
.dk-ap-m.grouped.user .dk-ap-bub{border-radius:3px 12px 12px 3px;}
.dk-ap-m.grouped.staff .dk-ap-bub{border-radius:12px 3px 3px 12px;}
.dk-ap-bub.clickable{cursor:pointer;}
.dk-ap-bub.clickable:hover{filter:brightness(1.16);}
.dk-ap-quote{font-size:11px;color:rgba(255,255,255,.62);border-left:2px solid rgba(255,255,255,.3);
  padding-left:7px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-ap-sys{align-self:center;text-align:center;font-size:11.5px;color: #8d8d8d;background: #1b1b1b;
  border:1px solid #2a2a2a;padding:5px 10px;margin:10px auto 0;max-width:100%;width:fit-content;}
.dk-av.clickable,.dk-mname.clickable,.dk-staff-name.clickable{cursor:pointer;}
/* font-family only, not the font shorthand: the shorthand also reset the size
   and the weight, which is what flattened the name into the message. */
.dk-mname.clickable,.dk-staff-name.clickable{background:none;border:none;padding:0;
  font-family:inherit;text-align:left;}
.dk-staff-name.clickable{font:inherit;color:inherit;}
.dk-mname.clickable:hover,.dk-staff-name.clickable:hover{color: #ff9800;text-decoration:underline;}
.dk-av.clickable:hover{outline:2px solid #ff9800;outline-offset:1px;}

/* ── One staff member's record, over the panel ── */
.dk-rec{position:absolute;inset:0;z-index:9;background:rgba(0,0,0,.62);display:flex;
  align-items:center;justify-content:center;padding:18px;}
.dk-rec-c{background: #202020;border:1px solid #616161;width:min(460px,100%);
  max-height:100%;display:flex;flex-direction:column;overflow:hidden;}
.dk-rec-h{flex:none;display:flex;align-items:center;gap:10px;padding:11px 13px;
  border-bottom:1px solid #333;background: #1b1b1b;}
.dk-rec-ht{display:flex;align-items:center;gap:8px;flex:1;min-width:0;}
.dk-rec-n{font-weight:bold;font-size:14px;}
.dk-rec-b{overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:9px;}
.dk-rec-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:7px;}
.dk-rec-s{background: #141414;border:1px solid #2a2a2a;padding:8px 10px;}
.dk-rec-s.lead{border-color:rgba(255,152,0,.35);}
.dk-rec-sn{font-size:17px;font-weight:bold;font-variant-numeric:tabular-nums;}
.dk-rec-s.lead .dk-rec-sn{color: #ff9800;}
.dk-rec-sl{font-size:10.5px;color: #8d8d8d;margin-top:2px;}
.dk-rec-when{font-size:11.5px;color: #8d8d8d;}
.dk-rec-flag{font-size:12px;color: #ffb454;background:rgba(255,180,84,.08);
  border-left:3px solid #ffb454;padding:6px 9px;}
.dk-rec-e{display:flex;align-items:baseline;gap:8px;font-size:12px;padding:5px 8px;background: #1b1b1b;}
.dk-rec-ea{font-weight:bold;flex:none;}
.dk-rec-et{color: #8d8d8d;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-rec-ew{color: #6f6f6f;font-size:11px;flex:none;}
.dk-rec-foot{font-size:11px;color: #6f6f6f;line-height:1.5;}
.dk-ap-acts{flex:none;display:flex;gap:6px;flex-wrap:wrap;padding:9px 14px;border-top:1px solid #333;
  background: #1b1b1b;}

/* ── Discord's "you are reading, this is how much you missed" bar ── */
.dk-jump{position:relative;height:0;overflow:visible;z-index:3;}
.dk-jump-b{position:absolute;right:14px;bottom:8px;display:inline-flex;align-items:center;gap:8px;
  background: #ff9800;color: #000;border:none;border-radius:14px;padding:6px 12px;font-family:inherit;
  font-size:11.5px;font-weight:bold;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5);}
.dk-jump-b:hover{background: #ffad33;}
.dk-jump-b .fas{font-size:10px;}
.dk-replybar{flex:none;display:flex;align-items:center;gap:8px;padding:7px 14px;background: #1b1b1b;
  border-top:1px solid #333;font-size:12px;color: #c3c3c3;min-width:0;}
.dk-replybar .fas{font-size:10px;color: #8d8d8d;flex:none;}
.dk-rb-w{font-weight:bold;flex:none;}
.dk-rb-t{color: #8d8d8d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;}
.dk-rb-x{background:none;border:none;color: #8d8d8d;cursor:pointer;font-size:13px;padding:2px 6px;
  border-radius:3px;flex:none;}
.dk-rb-x:hover{color: #000;background: #ff9800;}
.dk-palette{flex:none;max-height:220px;overflow-y:auto;background: #1b1b1b;border-top:1px solid #333;
  padding:6px;display:flex;flex-direction:column;gap:2px;}
.dk-cmd{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;background:none;border:none;
  font-family:inherit;color: #fff;padding:6px 8px;border-radius:4px;cursor:pointer;min-width:0;}
.dk-cmd:hover,.dk-cmd.on{background: #2a2a2a;}
.dk-cmd-u{font-weight:bold;font-size:12.5px;color: #ff9800;flex:none;}
.dk-cmd-w{font-size:11.5px;color: #8d8d8d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
/* One row of the # or @ list. The highlighted row is the one Enter takes. */
.dk-pick{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:none;
  font-family:inherit;color: #fff;padding:5px 8px;border-radius:0px;cursor:pointer;min-width:0;}
.dk-pick:hover,.dk-pick.on{background: #2a2a2a;}
.dk-pick.on{box-shadow:inset 2px 0 0 #ff9800;}
.dk-pick-hash{color: #ff9800;font-weight:bold;font-size:14px;width:26px;text-align:center;flex:none;}
.dk-pick-mid{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px;}
.dk-pick-n{font-size:13px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-pick-s{font-size:11px;color: #8d8d8d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-pick > .fa-lock{color: #8d8d8d;font-size:11px;flex:none;}
.dk-pick-dot{width:7px;height:7px;border-radius:50%;flex:none;}
.dk-pick-dot.on{background: #57d9a3;}
.dk-pick-dot.off{background: #5a5a5a;}
/* Group rows sit above the names and are marked as what they are: one @ that
   reaches several people. */
.dk-pick-grp{flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:rgba(192,139,255,.16);color: #c08bff;font-size:11px;}
/* An icon alone in a round chip gets a square box of its own. Font Awesome
   glyphs are all different widths, so without this each one centres slightly
   differently and the whole column looks nudged about. */
.dk-pick-grp > i,.dk-q-ico > i{width:1em;text-align:center;line-height:1;}
.dk-pick.grp .dk-pick-n{color: #c08bff;}
/* A name written in a message. A channel opens; a mention is just marked, in
   your own colour when it is you. */
.dk-chanlink{background:none;border:none;font-family:inherit;font-size:inherit;padding:0;
  color: #5aa9ff;font-weight:bold;cursor:pointer;border-radius:3px;}
.dk-chanlink:hover{background:rgba(90,169,255,.18);text-decoration:underline;}
.dk-ment{color: #ffb454;font-weight:bold;background:rgba(255,152,0,.14);border-radius:3px;padding:0 3px;}
.dk-ment.self{color: #000;background: #ff9800;}
/* A group is not a person, so it does not look like one. It only goes solid
   when the group actually includes you. */
.dk-ment.group{color: #c08bff;background:rgba(192,139,255,.14);}
.dk-ment.group.self{color: #150022;background: #c08bff;}
/* ── Markdown ──
   Only the half people actually type. Nothing here parses HTML: every leaf is
   a text node, so a message is still exactly what somebody wrote. */
.dk-link{color: #5aa9ff;text-decoration:underline;text-underline-offset:2px;word-break:break-all;}
.dk-link:hover{color: #8cc4ff;}
.dk-p{display:block;}
.dk-p + .dk-p,.dk-mtext .dk-ul,.dk-mtext .dk-code-bl{margin-top:5px;}
.dk-b{font-weight:bold;color: #fff;}
.dk-i{font-style:italic;}
.dk-s{text-decoration:line-through;color: #8d8d8d;}
.dk-code-in{font-family:"Courier New",monospace;font-size:12px;background: #000;border:1px solid #333;
  border-radius:3px;padding:0 4px;color: #ffb454;word-break:break-word;}
.dk-code-bl{font-family:"Courier New",monospace;font-size:12px;background: #000;border:1px solid #333;
  border-radius:5px;padding:8px 10px;margin:0;color: #ededed;white-space:pre-wrap;word-break:break-word;
  max-height:260px;overflow:auto;}
.dk-ul{margin:0;padding-left:18px;display:block;}
.dk-ul li{margin:1px 0;}
.dk-comp{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 14px;border-top:1px solid #333;background: #1b1b1b;}
.dk-input{flex:1;min-width:0;background: #000;color: #fff;border:1px solid #3a3a3a;border-radius:5px;
  padding:0 11px;font-family:inherit;font-size:13.5px;resize:none;outline:none;
  line-height:20px;height:38px;min-height:38px;max-height:120px;padding-top:9px;padding-bottom:9px;
  display:block;overflow-y:auto;}
.dk-input::placeholder{color: #6f6f6f;}
.dk-input:focus{border-color: #ff9800;}
.dk-count{flex:none;font-size:10.5px;color: #ffb454;font-variant-numeric:tabular-nums;}
.dk-send{flex:none;background: #ff9800;border:1px solid #ff9800;color: #000;border-radius:5px;
  width:38px;height:38px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;font-size:14px;padding:0;}
.dk-send:hover{background: #ffad33;}

/* ── Emotes ──
   The same codes the rooms use. Sized in em so an emote sits on the line it
   was typed into rather than pushing it open. */
.dk-emote{height:1.55em;width:auto;max-width:130px;vertical-align:-0.42em;object-fit:contain;}
.dk-emobtn{flex:none;background:none;border:1px solid #3a3a3a;color: #c3c3c3;border-radius:5px;
  width:38px;height:38px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;font-size:15px;padding:0;}
.dk-emobtn:hover{border-color: #ff9800;color: #fff;}
.dk-emobtn.on{border-color: #ff9800;color: #ff9800;}
.dk-pick-em{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;}
.dk-pick-em .dk-emote{height:24px;max-width:26px;vertical-align:middle;}
.dk-empanel{flex:none;background: #1b1b1b;border-top:1px solid #333;padding:8px 12px;
  display:flex;flex-direction:column;gap:7px;max-height:236px;}
.dk-emsearch{flex:none;background: #000;color: #fff;border:1px solid #3a3a3a;border-radius:5px;
  padding:7px 10px;font-family:inherit;font-size:12.5px;outline:none;}
.dk-emsearch::placeholder{color: #6f6f6f;}
.dk-emsearch:focus{border-color: #ff9800;}
.dk-emgrid{overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(40px,1fr));gap:4px;}
.dk-emb{background:none;border:1px solid transparent;border-radius:5px;padding:2px;height:40px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;}
.dk-emb:hover{background: #2a2a2a;border-color: #ff9800;}
.dk-emb .dk-emote{height:28px;max-width:34px;vertical-align:middle;}
.dk-emnone{grid-column:1/-1;color: #8d8d8d;font-size:12px;padding:8px 2px;}
.dk-side{background: #1b1b1b;border-left:1px solid #333;overflow-y:auto;padding:10px;}
.dk-side-h{font-size:10.5px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color: #8d8d8d;
  padding:10px 4px 6px;}
.dk-side-h:first-child{padding-top:2px;}
.dk-staff{display:flex;gap:8px;align-items:center;padding:5px 4px;border-radius:4px;}
.dk-staff:hover{background: #242424;}
.dk-staff-w{min-width:0;flex:1;}
.dk-staff-n{display:flex;align-items:center;gap:5px;font-size:12.5px;font-weight:bold;min-width:0;}
.dk-staff-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.dk-staff-n .dk-chip{flex:none;}
/* This line says where somebody is and what name they are wearing, and both
   of those are the whole point of it - so it wraps rather than being cut off
   halfway through the answer. */
.dk-staff-l{font-size:11px;color: #8d8d8d;line-height:1.45;overflow-wrap:anywhere;}
.dk-staff.off{opacity:.6;}
/* One heading per rank instead of a chip on every single row. */
.dk-group{display:flex;align-items:center;gap:6px;padding:9px 5px 3px;}
.dk-group-n{font-size:10px;font-weight:bold;letter-spacing:.7px;text-transform:uppercase;color: #8d8d8d;}
.dk-group.dev .dk-group-n{color: #ff5468;}
.dk-group.l2 .dk-group-n{color: #5aa9ff;}
.dk-group.l1 .dk-group-n{color: #c08bff;}
.dk-group-c{font-size:10px;color: #6f6f6f;font-variant-numeric:tabular-nums;}
.dk-group::after{content:"";flex:1;height:1px;background: #2a2a2a;}
/* Two rows: what the room is, then what to do about it. */
.dk-room{padding:7px 8px;border-radius:5px;min-width:0;background: #202020;
  border:1px solid #2a2a2a;margin-bottom:6px;}
.dk-room:hover{border-color: #3a3a3a;}
.dk-room-top{display:flex;align-items:center;gap:6px;min-width:0;}
.dk-room-top .fas{font-size:9px;color: #8d8d8d;flex:none;}
.dk-room-bar{display:flex;align-items:center;gap:6px;margin-top:7px;}
.dk-room-bar .dk-minib{padding:4px 9px;font-size:11px;}
.dk-room-n{font-size:12.5px;font-weight:bold;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* The headcount says what it is counting and what the ceiling is, because
   "4" on its own in a corner told nobody anything. */
.dk-room-c{display:inline-flex;align-items:center;gap:4px;color: #c3c3c3;font-weight:bold;font-size:11.5px;
  font-variant-numeric:tabular-nums;flex:none;background: #252525;border:1px solid #333;
  border-radius:3px;padding:1px 6px;}
.dk-room-c .fas{font-size:9px;color: #8d8d8d;}
.dk-room-c.full{color: #ff5468;border-color:rgba(255,84,104,.45);}
.dk-room-c.full .fas{color: #ff5468;}
/* Room state in words. An icon on its own is a quiz. */
.dk-room-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;}
.dk-rtag{display:inline-flex;align-items:center;gap:4px;font-size:10px;color: #8d8d8d;
  background: #252525;border-radius:3px;padding:1px 6px;max-width:100%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.dk-rtag .fas{font-size:8.5px;}
.dk-rtag.t-pub .fas{color: #57d9a3;}
.dk-rtag.t-semi .fas{color: #ffb454;}
.dk-rtag.t-priv .fas{color: #ff5468;}
.dk-rtag.warn{color: #ffb454;}
.dk-rtag.warn .fas{color: #ffb454;}
.dk-rtag.full{color: #ff5468;}
.dk-rtag.full .fas{color: #ff5468;}
.dk-rtag.none{color: #ff5468;background:rgba(255,84,104,.12);}
.dk-rtag.none .fas{color: #ff5468;}
.dk-rtag.ok{color: #57d9a3;}
.dk-rtag.ok .fas{color: #57d9a3;}
.dk-ib{flex:none;background:none;border:1px solid #333;color: #c3c3c3;border-radius:4px;
  padding:4px 7px;font-size:11px;cursor:pointer;line-height:1;}
.dk-ib:hover{border-color: #ff9800;color: #fff;}
.dk-occ{border:1px solid #2a2a2a;border-radius:5px;background: #1b1b1b;padding:9px 11px;margin-bottom:7px;}
.dk-occ-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dk-occ-n{font-weight:bold;}
.dk-occ-l{font-size:11.5px;color: #8d8d8d;}
.dk-occ-b{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;}
.dk-hit{display:block;width:100%;text-align:left;background: #1b1b1b;border:1px solid #2a2a2a;
  border-radius:5px;padding:8px 11px;margin-bottom:6px;color: #fff;font-family:inherit;cursor:pointer;}
.dk-hit:hover{border-color: #ff9800;}
.dk-hit-h{display:flex;align-items:baseline;gap:8px;}
.dk-hit-w{font-weight:bold;color: #ff9800;font-size:12px;}
.dk-hit-t{font-size:12.5px;color: #c3c3c3;margin-top:3px;word-break:break-word;}
/* ── The guide ──
   Sections as cards with their own icon, rather than one long wall of
   headings. Each tone is one colour used in three places: the icon, its
   backing, and the strip down the left. */
.dk-help{padding:16px 18px 24px;display:flex;flex-direction:column;gap:12px;}
.dk-help-hero{display:flex;gap:12px;align-items:flex-start;background: #1b1b1b;
  border:1px solid #3a3126;border-left:3px solid #ff9800;padding:13px 15px;}
.dk-help-hero > .fas{color: #ff9800;font-size:17px;margin-top:2px;flex:none;width:1em;text-align:center;}
.dk-help-hero-t{display:flex;flex-direction:column;gap:3px;min-width:0;}
.dk-help-hero-h{font-size:15px;font-weight:bold;color: #ff9800;}
.dk-help-hero-p{font-size:12.5px;color: #c3c3c3;line-height:1.6;}
.dk-help-s{background: #1b1b1b;border:1px solid #2a2a2a;border-left:3px solid #616161;padding:12px 15px 14px;}
.dk-help-sh{display:flex;align-items:center;gap:9px;margin-bottom:8px;}
.dk-help-si{flex:none;width:26px;height:26px;display:flex;align-items:center;justify-content:center;
  background: #252525;color: #8d8d8d;font-size:12px;}
.dk-help-si > i{width:1em;text-align:center;line-height:1;}
.dk-help-s.t-orange{border-left-color: #ff9800;}
.dk-help-s.t-orange .dk-help-si{color: #ff9800;background:rgba(255,152,0,.12);}
.dk-help-s.t-blue{border-left-color: #5aa9ff;}
.dk-help-s.t-blue .dk-help-si{color: #5aa9ff;background:rgba(90,169,255,.12);}
.dk-help-s.t-purple{border-left-color: #c08bff;}
.dk-help-s.t-purple .dk-help-si{color: #c08bff;background:rgba(192,139,255,.12);}
.dk-help-s.t-green{border-left-color: #57d9a3;}
.dk-help-s.t-green .dk-help-si{color: #57d9a3;background:rgba(87,217,163,.12);}
.dk-help-s.t-amber{border-left-color: #ffb454;}
.dk-help-s.t-amber .dk-help-si{color: #ffb454;background:rgba(255,180,84,.12);}
.dk-help-s.t-red{border-left-color: #ff5468;}
.dk-help-s.t-red .dk-help-si{color: #ff5468;background:rgba(255,84,104,.12);}
.dk-help-h{font-size:14px;color: #fff;margin:0;letter-spacing:.2px;}
.dk-help-p{font-size:13px;color: #c3c3c3;line-height:1.7;margin:0 0 9px;max-width:74ch;}
.dk-help-p:last-child{margin-bottom:0;}
.dk-help-list{display:flex;flex-direction:column;gap:2px;margin:2px 0 0;}
.dk-help-row{display:flex;gap:12px;align-items:baseline;padding:7px 10px;background: #141414;}
.dk-help-k{flex:none;width:11rem;max-width:42%;font-weight:bold;font-size:12.5px;color: #fff;}
.dk-help-k.mono{font-family:"Courier New",monospace;color: #ff9800;font-size:11.5px;}
.dk-help-v{font-size:12.5px;color: #8d8d8d;line-height:1.6;min-width:0;}
@media (max-width:760px){
  .dk-help-row{flex-direction:column;gap:3px;}
  .dk-help-k{width:auto;max-width:100%;}
}
.dk-bot{position:relative;background: #1b1b1b;border:1px solid #2a2a2a;border-radius:6px;
  padding:10px 34px 10px 12px;margin:10px 0;display:flex;flex-direction:column;gap:6px;}
.dk-bot-h{display:flex;align-items:center;gap:7px;}
.dk-bot-h .fas{font-size:11px;color: #5aa9ff;}
.dk-bot-n{font-size:12px;font-weight:bold;color: #5aa9ff;}
.dk-bot-only{font-size:10px;color: #6f6f6f;}
.dk-bot-t{font-size:13px;color: #c3c3c3;line-height:1.6;}
.dk-bot-b{display:flex;gap:6px;flex-wrap:wrap;}
.dk-bot-cmd{background: #000;border:1px solid #3a3a3a;color: #ff9800;font-family:"Courier New",monospace;
  font-size:11.5px;padding:5px 9px;border-radius:4px;cursor:pointer;text-align:left;}
.dk-bot-cmd:hover{border-color: #ff9800;}
.dk-bot-x{position:absolute;top:6px;right:6px;background:none;border:none;color: #6f6f6f;
  cursor:pointer;font-size:12px;padding:3px 5px;border-radius:3px;}
.dk-bot-x:hover{color: #fff;background: #2a2a2a;}
.dk-toast{position:absolute;left:50%;bottom:70px;transform:translate(-50%,12px);background: #000;
  border:1px solid #ff9800;color: #fff;font-size:12.5px;padding:8px 14px;border-radius:5px;
  opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;z-index:6;max-width:80%;}
.dk-toast.show{opacity:1;transform:translate(-50%,0);}
.dk-panel.dk-fullpage{position:fixed;inset:0;right:0;bottom:0;width:100%;height:100%;max-height:none;
  border:none;border-radius:0;box-shadow:none;}
button.dk-chan:focus-visible,button.dk-thread:focus-visible,.dk-minib:focus-visible,
.dk-hbtn:focus-visible,.dk-pill:focus-visible,.dk-send:focus-visible{outline:2px solid #ff9800;outline-offset:1px;}
@media (min-width:1001px){
  .dk-people{display:none;}
}
@media (max-width:1000px){
  .dk-body{grid-template-columns:200px minmax(0,1fr);}
  .dk-side{position:absolute;top:0;right:0;bottom:0;width:min(280px,85vw);z-index:5;
    transform:translateX(100%);transition:transform .2s ease;border-left:1px solid #616161;}
  .dk-panel.side-open .dk-side{transform:translateX(0);}
  .dk-panel.side-open .dk-scrim{display:block;}
}
@media (max-width:760px){
  .dk-panel{right:0;bottom:0;width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0;border:none;}
  .dk-body{grid-template-columns:minmax(0,1fr);}
  .dk-search,.dk-popbtn{display:none;}
  .dk-burger,.dk-msearch{display:inline-flex;}
  .dk-title-sub{max-width:120px;}
  .dk-rail{position:absolute;top:0;left:0;bottom:0;width:min(260px,85vw);z-index:5;
    transform:translateX(-100%);transition:transform .2s ease;border-right:1px solid #616161;}
  .dk-panel.rail-open .dk-rail{transform:translateX(0);}
  .dk-panel.rail-open .dk-scrim,.dk-panel.side-open .dk-scrim{display:block;}
  .dk-msg .dk-mtools{display:none;position:static;margin-top:4px;width:max-content;}
  .dk-msg:hover .dk-mtools{display:none;}
  .dk-msg.tools .dk-mtools{display:flex;}
  /* 16px inputs, or iOS zooms the whole page every time the composer opens. */
  .dk-input,.dk-editbox{font-size:16px;}
  /* Two across on a phone. The card's own container query says the same, so
     this is only here for a browser that does not do container queries. */
  .dk-st-g{grid-template-columns:repeat(2,minmax(0,1fr));}
}
@media (prefers-reduced-motion:reduce){
  .dk-pill.nudge,.dk-pill.urgent,.dk-ping-badge,.dk-msg.flash,.dk-sys.flash,.dk-ping.flash{animation:none !important;}
  .dk-rail,.dk-side,.dk-toast{transition:none !important;}
}`;
    document.head.appendChild(s);
  }

  // /desk.html carries data-desk-page on its body and no client script of its
  // own, so the Desk builds its own socket there. The keys come from the same
  // localStorage the other pages use; without one, the server stays silent
  // and the page keeps its sign-in note.
  document.addEventListener("DOMContentLoaded", () => {
    if (!document.body || document.body.dataset.deskPage !== "1") return;
    pageMode = true;
    if (typeof window.io !== "function") return;
    init(
      window.io({
        transports: ["websocket"],
        upgrade: false,
        auth: {
          devKey: localStorage.getItem("talkomatic_devKey") || undefined,
          modKey: localStorage.getItem("talkomatic_modKey") || undefined,
          // The same device id the lobby and the rooms send. The key watch
          // counts people by it, so a Desk tab that left it out used to look
          // like a second person holding the same key.
          deviceId:
            (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
            undefined,
          app: "desk",
        },
      }),
    );
  });

  window.TalkoDesk = {
    init,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle,
  };
})();
