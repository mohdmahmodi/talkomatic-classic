// public/js/theme-engine.js (v2) Design-token theming for Talkomatic, loaded
// in the <head> of the lobby AND the room page before first paint.
(function () {
  "use strict";

  var KEY = "talkomaticThemeV2";
  var LEGACY_KEY = "talkomaticThemeTokens";
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  var PAGE = /room\.html/i.test(location.pathname) ? "room" : "lobby";

  // ── Registry ──────────────────────────────────────────────────────────────
  var TOKENS = [
    { id: "accent", label: "Accent", group: "Colors", def: "#ff9800", hint: "Titles, borders, buttons" },
    { id: "accent-hover", label: "Accent hover", group: "Colors", def: "#f57c00", hint: "Buttons when hovered" },
    { id: "detail", label: "Highlights", group: "Colors", def: "#01ffff", hint: "Small colored details" },
    { id: "bg", label: "Background", group: "Page", def: "#202020", hint: "Page background" },
    { id: "text", label: "Text", group: "Page", def: "#ffffff", hint: "Main text" },
    { id: "muted", label: "Muted text", group: "Page", def: "#cccccc", hint: "Secondary text" },
    { id: "border", label: "Borders", group: "Page", def: "#616161", hint: "Lines and outlines" },
    { id: "panel", label: "Menu panel", group: "Panels", def: "#616161", hint: "Side panel background", pages: ["lobby"] },
    { id: "tile", label: "Buttons", group: "Panels", def: "#1b1b1b", hint: "Menu tiles and flat buttons" },
    { id: "tile-hover", label: "Button hover", group: "Panels", def: "#242424", hint: "Tiles when hovered" },
    { id: "card", label: "Cards", group: "Panels", def: "#000000", hint: "Room cards and dark surfaces" },
    { id: "cream", label: "Section strips", group: "Panels", def: "#fdf5e6", hint: "The Be Known As style strips" },
    { id: "cream-text", label: "Strip text", group: "Panels", def: "#000000", hint: "Text on the strips" },
    { id: "chat-text", label: "Typing text", group: "Chat", def: "#ffa500", hint: "Text in the chat boxes", pages: ["room"] },
    { id: "chat-bg", label: "Typing background", group: "Chat", def: "#000000", hint: "Chat box background", pages: ["room"] },
    { id: "chat-size", label: "Chat text size", group: "Chat", kind: "range", def: 18, min: 12, max: 28, unit: "px", hint: "How big chat text is in rooms", pages: ["room"] },
    { id: "radius", label: "Corner roundness", group: "Shape", kind: "range", def: 5, min: 0, max: 24, unit: "px", hint: "How rounded buttons and cards are" },
    { id: "border-width", label: "Border thickness", group: "More shape", kind: "range", def: 1, min: 1, max: 4, unit: "px", hint: "Outline weight on tiles and cards", adv: true },
    { id: "blur", label: "Glass blur", group: "More shape", kind: "range", def: 14, min: 4, max: 30, unit: "px", hint: "Blur strength of the Glass effect", adv: true },
    { id: "input-bg", label: "Form inputs", group: "More colors", def: "#ffffff", hint: "Name and room name fields", adv: true },
    { id: "userbar-bottom", label: "Name bar shade", group: "More colors", def: "#303030", hint: "Bottom of the name bars in rooms", adv: true, pages: ["room"] },
    { id: "error", label: "Errors", group: "More colors", def: "#ff5252", hint: "Error messages and warnings", adv: true },
    { id: "success", label: "Success", group: "More colors", def: "#4caf50", hint: "Approved tags and confirmations", adv: true },
    { id: "staff-badge-bg", label: "Badge color", group: "Staff", def: "#ff9800", hint: "Your MOD or DEV badge", staff: true },
    { id: "staff-badge-text", label: "Badge text", group: "Staff", def: "#000000", hint: "Text on the badge", staff: true },
  ];

  var EFFECTS = [
    { id: "", label: "Classic (flat)" },
    { id: "glass", label: "Glassmorphism" },
    { id: "brutal", label: "Neo-brutalism" },
    { id: "soft", label: "Soft (neumorphic)" },
    { id: "crt", label: "Terminal (CRT glow)" },
  ];

  // Image backgrounds. Stored per profile under images: {slot: {src, fit,
  // dim}}. Device-only: publishing strips them, sharing as text keeps them.
  var IMG_SLOTS = [
    {
      id: "bg",
      label: "Page background",
      hint: "Behind the whole page",
      pages: ["lobby", "room"],
      dim: true,
    },
    {
      id: "panel",
      label: "Menu panel",
      hint: "The left side panel",
      pages: ["lobby"],
    },
    {
      id: "chat",
      label: "Chat boxes",
      hint: "Behind everyone's typing",
      pages: ["room"],
    },
  ];

  var IMG_FITS = ["cover", "tile", "pixel"];

  // Font catalog. google:false means a system font: no CDN fetch, it either
  // exists on the device or the fallback kicks in. "gen" is the generic
  // family used at the end of the stack.
  var FONT_GROUPS = [
    {
      label: "Clean & modern",
      fonts: [
        { name: "Inter", gen: "sans-serif" },
        { name: "Poppins", gen: "sans-serif" },
        { name: "Nunito", gen: "sans-serif" },
        { name: "Montserrat", gen: "sans-serif" },
        { name: "Lato", gen: "sans-serif" },
        { name: "Open Sans", gen: "sans-serif" },
        { name: "Raleway", gen: "sans-serif" },
        { name: "Quicksand", gen: "sans-serif" },
        { name: "Josefin Sans", gen: "sans-serif" },
      ],
    },
    {
      label: "Serif & bookish",
      fonts: [
        { name: "Roboto Slab", gen: "serif" },
        { name: "Merriweather", gen: "serif" },
        { name: "Playfair Display", gen: "serif" },
        { name: "Lora", gen: "serif" },
        { name: "EB Garamond", gen: "serif" },
      ],
    },
    {
      label: "Display & loud",
      fonts: [
        { name: "Bebas Neue", gen: "sans-serif" },
        { name: "Oswald", gen: "sans-serif" },
        { name: "Orbitron", gen: "sans-serif" },
        { name: "Audiowide", gen: "sans-serif" },
        { name: "Righteous", gen: "sans-serif" },
        { name: "Bangers", gen: "cursive" },
        { name: "Luckiest Guy", gen: "cursive" },
        { name: "Alfa Slab One", gen: "serif" },
      ],
    },
    {
      label: "Mono & retro",
      fonts: [
        { name: "JetBrains Mono", gen: "monospace" },
        { name: "Fira Code", gen: "monospace" },
        { name: "Space Mono", gen: "monospace" },
        { name: "IBM Plex Mono", gen: "monospace" },
        { name: "VT323", gen: "monospace" },
        { name: "Press Start 2P", gen: "monospace" },
        { name: "Silkscreen", gen: "monospace" },
      ],
    },
    {
      label: "Handwriting & fun",
      fonts: [
        { name: "Comic Neue", gen: "cursive" },
        { name: "Patrick Hand", gen: "cursive" },
        { name: "Caveat", gen: "cursive" },
        { name: "Indie Flower", gen: "cursive" },
        { name: "Pacifico", gen: "cursive" },
        { name: "Lobster", gen: "cursive" },
        { name: "Dancing Script", gen: "cursive" },
        { name: "Amatic SC", gen: "cursive" },
      ],
    },
    {
      label: "System classics",
      fonts: [
        { name: "Comic Sans MS", gen: "cursive", google: false },
        { name: "Arial", gen: "sans-serif", google: false },
        { name: "Verdana", gen: "sans-serif", google: false },
        { name: "Trebuchet MS", gen: "sans-serif", google: false },
        { name: "Tahoma", gen: "sans-serif", google: false },
        { name: "Georgia", gen: "serif", google: false },
        { name: "Times New Roman", gen: "serif", google: false },
        { name: "Courier New", gen: "monospace", google: false },
        { name: "Impact", gen: "sans-serif", google: false },
      ],
    },
  ];

  var FONT_META = {};
  var FONTS = [""];
  FONT_GROUPS.forEach(function (g) {
    g.fonts.forEach(function (f) {
      FONT_META[f.name] = { gen: f.gen, google: f.google !== false };
      FONTS.push(f.name);
    });
  });

  var FONT_SLOTS = {
    lobby: [
      { id: "main", label: "Main font" },
      { id: "heading", label: "Headings font" },
    ],
    room: [
      { id: "main", label: "Main font" },
      { id: "heading", label: "Headings font" },
      { id: "chat", label: "Chat font" },
    ],
  };

  // ── State ─────────────────────────────────────────────────────────────────

  function blankProfile() {
    return { tokens: {}, effect: "", fonts: {}, images: {} };
  }

  function blankState() {
    return { lobby: blankProfile(), room: blankProfile(), css: "" };
  }

  function getState() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var st = JSON.parse(raw);
        if (st && typeof st === "object") {
          st.lobby = Object.assign(blankProfile(), st.lobby);
          st.room = Object.assign(blankProfile(), st.room);
          if (typeof st.css !== "string") st.css = "";
          return st;
        }
      }
    } catch (e) {}
    try {
      var old = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
      if (old && typeof old === "object") {
        var st2 = blankState();
        st2.lobby.tokens = Object.assign({}, old);
        st2.room.tokens = Object.assign({}, old);
        localStorage.setItem(KEY, JSON.stringify(st2));
        localStorage.removeItem(LEGACY_KEY);
        return st2;
      }
    } catch (e) {}
    return blankState();
  }

  // False when the browser refuses the write (images can push a theme past
  // the localStorage quota); the editor tells the user instead of silently
  // losing the save.
  function saveState(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      return false;
    }
    applyProfile(state[PAGE], state.css);
    return true;
  }

  function hasCustom() {
    var st = getState();
    var p = st[PAGE];
    return (
      Object.keys(p.tokens).length > 0 || !!p.effect ||
      Object.keys(p.fonts || {}).some(function (k) { return p.fonts[k]; }) ||
      Object.keys(p.images || {}).length > 0 ||
      !!st.css
    );
  }

  // ── Application ───────────────────────────────────────────────────────────

  var loadedFonts = {};

  function ensureFont(family) {
    if (!family || loadedFonts[family]) return;
    var meta = FONT_META[family];
    if (meta && !meta.google) return;
    loadedFonts[family] = true;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=" +
      encodeURIComponent(family).replace(/%20/g, "+") +
      ":wght@400;700&display=swap";
    (document.head || document.documentElement).appendChild(link);
  }

  function fontStack(family) {
    var meta = FONT_META[family];
    var gen = (meta && meta.gen) || "sans-serif";
    return '"' + family + '", talkoSS, Arial, ' + gen;
  }

  // ── Image backgrounds ─────────────────────────────────────────────────────
  // The surface rules are injected once, here, because the engine must be
  // able to paint a saved theme on any page it loads on, editor or not. The
  // page-background dim is a gradient layer over the image, not an overlay
  // element, so it can never sit on top of content.

  var IMG_CSS = [
    "html.tk-img-bg body{background-image:linear-gradient(rgba(0,0,0,var(--tk-img-bg-dim,0)),",
    "rgba(0,0,0,var(--tk-img-bg-dim,0))),var(--tk-img-bg) !important;",
    "background-size:cover;background-position:center;background-attachment:fixed;",
    "background-repeat:no-repeat;}",
    "html.tk-img-bg-tile body{background-size:auto;background-repeat:repeat;}",
    "html.tk-img-bg-pixel body{background-size:96px;background-repeat:repeat;",
    "image-rendering:pixelated;}",
    // The full-page containers each paint --tk-bg over the body; they go
    // transparent while a page image is set so it can actually be seen.
    "html.tk-img-bg .right-panel,html.tk-img-bg .chat-container{",
    "background:transparent !important;}",
    "html.tk-img-panel .left-panel{background-image:var(--tk-img-panel) !important;",
    "background-size:cover;background-position:center;}",
    "html.tk-img-panel-tile .left-panel{background-size:auto;background-repeat:repeat;}",
    "html.tk-img-panel-pixel .left-panel{background-size:96px;background-repeat:repeat;",
    "image-rendering:pixelated;}",
    "html.tk-img-chat .chat-input{background-image:var(--tk-img-chat) !important;",
    "background-size:cover;background-position:center;}",
    "html.tk-img-chat-tile .chat-input{background-size:auto;background-repeat:repeat;}",
    "html.tk-img-chat-pixel .chat-input{background-size:96px;background-repeat:repeat;",
    "image-rendering:pixelated;}",
  ].join("");

  function ensureImgStyles() {
    if (document.getElementById("tkImgStyles")) return;
    var s = document.createElement("style");
    s.id = "tkImgStyles";
    s.textContent = IMG_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function validImageSrc(src) {
    if (typeof src !== "string" || src.length > 3000000) return false;
    if (/["'\\\n\r]/.test(src)) return false;
    return /^(https?:\/\/|data:image\/)/i.test(src);
  }

  function applyImages(root, images) {
    var any = false;
    for (var i = 0; i < IMG_SLOTS.length; i++) {
      var slot = IMG_SLOTS[i];
      var val = images ? images[slot.id] : null;
      var on = !!(val && validImageSrc(val.src));
      if (on) any = true;
      root.classList.toggle("tk-img-" + slot.id, on);
      root.classList.toggle(
        "tk-img-" + slot.id + "-tile",
        on && val.fit === "tile",
      );
      root.classList.toggle(
        "tk-img-" + slot.id + "-pixel",
        on && val.fit === "pixel",
      );
      if (on) {
        root.style.setProperty("--tk-img-" + slot.id, 'url("' + val.src + '")');
        if (slot.dim) {
          var d = Number(val.dim);
          root.style.setProperty(
            "--tk-img-" + slot.id + "-dim",
            Number.isFinite(d) ? Math.max(0, Math.min(0.8, d)) : 0,
          );
        }
      } else {
        root.style.removeProperty("--tk-img-" + slot.id);
        if (slot.dim) root.style.removeProperty("--tk-img-" + slot.id + "-dim");
      }
    }
    if (any) ensureImgStyles();
  }

  // A light page background flips html.tk-light on, and the stylesheets use
  // that to re-ink chrome that was only ever drawn for dark themes (the
  // yellow room clock, cyan room type, name bars). Dark themes never get it.
  function isLightHex(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140;
  }

  function applyProfile(profile, css) {
    var root = document.documentElement;
    profile = profile || blankProfile();

    var staffThemed = false;
    var shaped = false;
    var borderw = false;
    var chatSized = false;
    for (var i = 0; i < TOKENS.length; i++) {
      var t = TOKENS[i];
      var raw = profile.tokens ? profile.tokens[t.id] : null;
      var v = null;
      if (t.kind === "range") {
        var n = Number(raw);
        if (Number.isFinite(n) && n >= t.min && n <= t.max)
          v = n + (t.unit || "");
      } else if (HEX.test(raw || "")) v = raw;
      if (v) {
        root.style.setProperty("--tk-" + t.id, v);
        if (t.staff) staffThemed = true;
        if (t.id === "radius") shaped = true;
        if (t.id === "border-width") borderw = true;
        if (t.id === "chat-size") chatSized = true;
      } else root.style.removeProperty("--tk-" + t.id);
    }
    root.classList.toggle("tk-staff-themed", staffThemed);
    root.classList.toggle("tk-shaped", shaped);
    root.classList.toggle("tk-borderw", borderw);
    root.classList.toggle("tk-chat-sized", chatSized);

    var bgTok =
      profile.tokens && HEX.test(profile.tokens.bg || "")
        ? profile.tokens.bg
        : "#202020";
    root.classList.toggle("tk-light", isLightHex(bgTok));

    for (var e = 0; e < EFFECTS.length; e++)
      if (EFFECTS[e].id)
        root.classList.toggle(
          "tk-fx-" + EFFECTS[e].id,
          profile.effect === EFFECTS[e].id,
        );

    applyImages(root, profile.images);

    var slots = ["main", "heading", "chat"];
    for (var f = 0; f < slots.length; f++) {
      var slot = slots[f];
      var fam = profile.fonts && profile.fonts[slot];
      if (fam && FONTS.indexOf(fam) > 0) {
        ensureFont(fam);
        root.style.setProperty("--tk-font-" + slot, fontStack(fam));
      } else root.style.removeProperty("--tk-font-" + slot);
    }

    var tag = document.getElementById("tkCustomCss");
    if (css && css.trim()) {
      if (!tag) {
        tag = document.createElement("style");
        tag.id = "tkCustomCss";
        (document.head || document.documentElement).appendChild(tag);
      }
      if (tag.textContent !== css) tag.textContent = css;
    } else if (tag) tag.remove();
  }

  window.ThemeEngine = {
    PAGE: PAGE,
    KEY: KEY,
    TOKENS: TOKENS,
    EFFECTS: EFFECTS,
    FONTS: FONTS,
    FONT_GROUPS: FONT_GROUPS,
    FONT_META: FONT_META,
    FONT_SLOTS: FONT_SLOTS,
    IMG_SLOTS: IMG_SLOTS,
    IMG_FITS: IMG_FITS,
    validImageSrc: validImageSrc,
    ensureFont: ensureFont,
    fontStack: fontStack,
    HEX: HEX,
    blankProfile: blankProfile,
    getState: getState,
    saveState: saveState,
    hasCustom: hasCustom,
    preview: function (profile, css) {
      applyProfile(profile, css);
    },
    revert: function () {
      var st = getState();
      applyProfile(st[PAGE], st.css);
    },
    tokenDefaults: function () {
      var out = {};
      for (var i = 0; i < TOKENS.length; i++) out[TOKENS[i].id] = TOKENS[i].def;
      return out;
    },
  };

  var st = getState();
  applyProfile(st[PAGE], st.css);
})();
