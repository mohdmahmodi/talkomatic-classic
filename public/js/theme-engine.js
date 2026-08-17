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
  ];

  var FONTS = [
    "", "Inter", "Poppins", "Nunito", "Montserrat", "Lato", "Roboto Slab",
    "Merriweather", "JetBrains Mono", "Space Mono", "VT323", "Press Start 2P",
    "Orbitron", "Bebas Neue", "Comic Neue",
  ];

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
    return { tokens: {}, effect: "", fonts: {} };
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

  function saveState(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
    applyProfile(state[PAGE], state.css);
  }

  function hasCustom() {
    var st = getState();
    var p = st[PAGE];
    return (
      Object.keys(p.tokens).length > 0 || !!p.effect ||
      Object.keys(p.fonts || {}).some(function (k) { return p.fonts[k]; }) ||
      !!st.css
    );
  }

  // ── Application ───────────────────────────────────────────────────────────

  var loadedFonts = {};

  function ensureFont(family) {
    if (!family || loadedFonts[family]) return;
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
    return '"' + family + '", talkoSS, Arial, sans-serif';
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

    for (var e = 0; e < EFFECTS.length; e++)
      if (EFFECTS[e].id)
        root.classList.toggle(
          "tk-fx-" + EFFECTS[e].id,
          profile.effect === EFFECTS[e].id,
        );

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
    FONT_SLOTS: FONT_SLOTS,
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
