// public/js/theme-editor.js (v3) Visual theme editor: a draggable floating
// panel over the live page. The page itself is the preview. Scoped to the
// page it is opened on: the lobby editor styles the lobby, the room editor
// (Apps > Theme Editor) styles rooms. Panel chrome styles live in
// stylesheets/theme-editor.css.
(function () {
  "use strict";
  if (!window.ThemeEngine) return;

  var E = window.ThemeEngine;
  var PAGE = E.PAGE;
  var POS_KEY = "tkedPanelPos";
  var isStaff = !!(
    localStorage.getItem("talkomatic_devKey") ||
    localStorage.getItem("talkomatic_modKey")
  );

  var open = false;
  var built = false;
  var panel, bodyEl, effectSel, cssBox, ioTa, undoBtn, pickBtn, contrastEl;
  var genAccent, genBg;
  var fontBtns = {};
  var tabBtns = {};
  var pages = {};
  var working = null;
  var history = [];
  var lastPushAt = 0;
  var lastPushKey = "";

  // ── Small helpers ─────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(msg, type) {
    if (window.StaffUI && StaffUI.toast)
      StaffUI.toast(msg, { type: type || "success" });
    else if (window.toastr) toastr[type || "success"](msg);
  }

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function profile() {
    return working[PAGE];
  }

  function previewNow() {
    E.preview(profile(), working.css);
  }

  // ── Color math ────────────────────────────────────────────────────────────

  function hexRgb(hex) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbHex(r, g, b) {
    var to = function (n) {
      n = Math.max(0, Math.min(255, Math.round(n)));
      return (n < 16 ? "0" : "") + n.toString(16);
    };
    return "#" + to(r) + to(g) + to(b);
  }

  function rgbHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hslHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var t = function (x) {
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return rgbHex(t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255);
  }

  function luminance(hex) {
    var c = hexRgb(hex);
    var f = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  function colorDist(a, b) {
    return (
      Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
    );
  }

  // ── Undo ──────────────────────────────────────────────────────────────────

  function pushHistory(key) {
    var now = Date.now();
    if (key === lastPushKey && now - lastPushAt < 500) return;
    lastPushKey = key;
    lastPushAt = now;
    history.push(JSON.stringify(working));
    if (history.length > 60) history.shift();
    if (undoBtn) undoBtn.disabled = false;
  }

  function undo() {
    if (!history.length) return;
    working = JSON.parse(history.pop());
    lastPushKey = "";
    previewNow();
    syncInputs();
    if (undoBtn) undoBtn.disabled = !history.length;
  }

  // ── Presets ───────────────────────────────────────────────────────────────

  var PRESETS = {
    Classic: {},
    Midnight: {
      accent: "#4da3ff", "accent-hover": "#2b8ae6", detail: "#7fffd4",
      bg: "#101418", text: "#e8eef4", muted: "#9fb0c0", border: "#3a4a5a",
      panel: "#2a3440", tile: "#161d24", "tile-hover": "#1f2933",
      card: "#0a0e12", cream: "#dbe4ee", "cream-text": "#000000",
      "chat-text": "#4da3ff", "chat-bg": "#05070a",
    },
    Mocha: {
      accent: "#f2cdcd", "accent-hover": "#eba0ac", detail: "#89dceb",
      bg: "#313244", text: "#cdd6f4", muted: "#a6adc8", border: "#585b70",
      panel: "#45475a", tile: "#1e1e2e", "tile-hover": "#313244",
      card: "#11111b", cream: "#f5e0dc", "cream-text": "#11111b",
      "chat-text": "#f2cdcd", "chat-bg": "#11111b",
    },
    Terminal: {
      accent: "#33ff66", "accent-hover": "#22cc55", detail: "#33ffcc",
      bg: "#0a0f0a", text: "#c8facc", muted: "#7fbf8a", border: "#245c2e",
      panel: "#142814", tile: "#0f1a0f", "tile-hover": "#1a2e1a",
      card: "#050a05", cream: "#9dfa9d", "cream-text": "#032003",
      "chat-text": "#33ff66", "chat-bg": "#000000",
    },
    Daylight: {
      accent: "#e07b00", "accent-hover": "#c96e00", detail: "#0088aa",
      bg: "#f2ede3", text: "#1a1a1a", muted: "#4a4a4a", border: "#b8b0a0",
      panel: "#d8d0c0", tile: "#e6e0d2", "tile-hover": "#ddd5c5",
      card: "#fffdf7", cream: "#2e2a24", "cream-text": "#ffffff",
      "chat-text": "#b35f00", "chat-bg": "#fffdf7", "input-bg": "#ffffff",
    },
    Grape: {
      accent: "#b388ff", "accent-hover": "#9a6fe8", detail: "#64ffda",
      bg: "#171221", text: "#efe9ff", muted: "#b6a9d6", border: "#4d3f6b",
      panel: "#3a2f52", tile: "#120e1a", "tile-hover": "#241c33",
      card: "#0b0812", cream: "#e8ddff", "cream-text": "#1a1030",
      "chat-text": "#b388ff", "chat-bg": "#0b0812",
    },
  };

  var DOT_KEYS = ["bg", "tile", "accent", "cream"];

  // Picking a preset is picking a whole look, so the effect resets with it;
  // Terminal brings the CRT glow along.
  var PRESET_EFFECTS = { Terminal: "crt" };

  // ── Palette generator: a full coherent theme from accent + background ─────

  function generatePalette(accent, bg) {
    var a = rgbHsl(hexRgb(accent));
    var b = rgbHsl(hexRgb(bg));
    var dark = b.l < 50;
    var t = {};
    var sat = Math.min(b.s, 30);

    t.accent = accent;
    t["accent-hover"] = hslHex(a.h, a.s, a.l + (a.l > 55 ? -10 : 10));
    t.detail = hslHex(a.h + 150, Math.max(a.s, 60), dark ? 62 : 40);
    t.bg = bg;

    if (dark) {
      t.card = hslHex(b.h, sat, Math.max(1, b.l * 0.35));
      t.tile = hslHex(b.h, sat, Math.max(2, b.l * 0.8));
      t["tile-hover"] = hslHex(b.h, sat, b.l + 5);
      t.panel = hslHex(b.h, sat, b.l + 16);
      t.border = hslHex(b.h, Math.min(sat, 18), b.l + 26);
      t.text = hslHex(b.h, 12, 94);
      t.muted = hslHex(b.h, 10, 74);
      t.cream = hslHex(a.h, Math.min(a.s, 45), 90);
      t["cream-text"] = "#000000";
      t["chat-bg"] = t.card;
      t["chat-text"] = accent;
      t["input-bg"] = "#ffffff";
    } else {
      t.card = hslHex(b.h, Math.min(b.s, 40), Math.min(99, b.l + 6));
      t.tile = hslHex(b.h, sat, b.l - 5);
      t["tile-hover"] = hslHex(b.h, sat, b.l - 10);
      t.panel = hslHex(b.h, sat, b.l - 14);
      t.border = hslHex(b.h, Math.min(sat, 20), b.l - 32);
      t.text = hslHex(b.h, 15, 10);
      t.muted = hslHex(b.h, 10, 32);
      t.cream = hslHex(a.h, 22, 16);
      t["cream-text"] = "#ffffff";
      t["chat-bg"] = t.card;
      t["chat-text"] = hslHex(a.h, Math.max(a.s, 50), Math.min(a.l, 38));
      t["input-bg"] = "#ffffff";
    }
    return t;
  }

  function updateContrast() {
    if (!contrastEl) return;
    var defs = E.tokenDefaults();
    var toks = profile().tokens || {};
    var text = toks.text || defs.text;
    var bg = toks.bg || defs.bg;
    var ratio = contrast(text, bg);
    var r = Math.round(ratio * 10) / 10;
    if (ratio < 4.5) {
      contrastEl.className = "tked-contrast warn";
      contrastEl.textContent =
        "Text on background contrast is " + r + ":1. Below 4.5:1 it gets hard to read.";
    } else {
      contrastEl.className = "tked-contrast ok";
      contrastEl.textContent = "Text on background contrast: " + r + ":1. Readable.";
    }
  }

  // ── Panel build ───────────────────────────────────────────────────────────

  function tokensForPage() {
    return E.TOKENS.filter(function (t) {
      if (t.pages && t.pages.indexOf(PAGE) === -1) return false;
      if (t.staff && !isStaff) return false;
      return true;
    });
  }

  function section(parent, icon, title) {
    var sec = el("div", "tked-sec");
    var head = el("div", "tked-sec-t");
    head.innerHTML = '<i class="fas ' + icon + '"></i>' + title;
    sec.appendChild(head);
    parent.appendChild(sec);
    return sec;
  }

  function build() {
    if (built) return;
    built = true;

    panel = el("div", "tked-panel");

    // Header (drag handle)
    var head = el("div", "tked-head");
    var headT = el("div", "tked-head-t");
    headT.appendChild(
      el("div", "tked-title", "Theme Editor - " + (PAGE === "room" ? "Rooms" : "Lobby")),
    );
    headT.appendChild(
      el(
        "div",
        "tked-subtitle",
        isMobile()
          ? "The page updates live as you change things."
          : "Drag me anywhere. The page updates live.",
      ),
    );
    pickBtn = el("button", "tked-hbtn");
    pickBtn.innerHTML = '<i class="fas fa-crosshairs"></i>';
    pickBtn.title = "Pick an element on the page to find its color setting";
    pickBtn.addEventListener("click", togglePick);
    undoBtn = el("button", "tked-hbtn");
    undoBtn.innerHTML = '<i class="fas fa-rotate-left"></i>';
    undoBtn.title = "Undo (Ctrl+Z)";
    undoBtn.disabled = true;
    undoBtn.addEventListener("click", undo);
    var collapseBtn = el("button", "tked-hbtn");
    collapseBtn.innerHTML = '<i class="fas fa-minus"></i>';
    collapseBtn.title = "Collapse";
    collapseBtn.addEventListener("click", function () {
      panel.classList.toggle("collapsed");
      collapseBtn.innerHTML = panel.classList.contains("collapsed")
        ? '<i class="fas fa-up-right-and-down-left-from-center"></i>'
        : '<i class="fas fa-minus"></i>';
    });
    var x = el("button", "tked-hbtn", "×");
    x.style.fontSize = "17px";
    x.title = "Close without saving";
    x.addEventListener("click", function () { close(); });
    head.appendChild(headT);
    head.appendChild(pickBtn);
    head.appendChild(undoBtn);
    head.appendChild(collapseBtn);
    head.appendChild(x);
    makeDraggable(head);

    // Tabs
    var tabs = el("div", "tked-tabs");
    [["quick", "Quick"], ["colors", "Colors"], ["style", "Style"], ["more", "More"]].forEach(
      function (pair) {
        var b = el("button", "tked-tab", pair[1]);
        b.addEventListener("click", function () { showTab(pair[0]); });
        tabBtns[pair[0]] = b;
        tabs.appendChild(b);
      },
    );

    bodyEl = el("div", "tked-body");
    // A fixed-position font popup would drift from its button when the body
    // scrolls under it; just close it.
    bodyEl.addEventListener("scroll", closeAnyFontPop);
    pages.quick = el("div", "tked-page");
    pages.colors = el("div", "tked-page");
    pages.style = el("div", "tked-page");
    pages.more = el("div", "tked-page");
    bodyEl.appendChild(pages.quick);
    bodyEl.appendChild(pages.colors);
    bodyEl.appendChild(pages.style);
    bodyEl.appendChild(pages.more);

    buildQuick(pages.quick);
    buildColors(pages.colors);
    buildStyle(pages.style);
    buildMore(pages.more);

    // Footer
    var foot = el("div", "tked-foot");
    var save = el("button", "tked-save");
    save.innerHTML = '<i class="fas fa-check"></i> Save theme';
    save.addEventListener("click", function () {
      if (!E.saveState(working))
        return toast(
          "Could not save: the images make this theme too big for browser storage. Use smaller images.",
          "error",
        );
      toast("Theme saved");
      close(true);
    });
    var actions = el("div", "tked-actions");
    var publish = el("button", "tked-btn");
    publish.innerHTML = '<i class="fas fa-upload"></i> Publish';
    publish.title = "Share this theme in the public Themes library";
    publish.addEventListener("click", publishTheme);
    var reset = el("button", "tked-btn danger");
    reset.innerHTML = '<i class="fas fa-eraser"></i> Reset page';
    reset.addEventListener("click", function () {
      pushHistory("reset");
      working[PAGE] = E.blankProfile();
      previewNow();
      syncInputs();
      toast("This page is back to classic");
    });
    actions.appendChild(publish);
    actions.appendChild(reset);
    foot.appendChild(save);
    foot.appendChild(actions);

    var scope = el("div", "tked-scope");
    scope.innerHTML =
      PAGE === "room"
        ? "Styles <b>rooms</b> only. For the lobby: use <b>Customize</b> in the lobby menu."
        : "Styles the <b>lobby</b> only. For rooms: open a room, press <b>Apps</b>, then <b>Theme Editor</b>.";

    panel.appendChild(head);
    panel.appendChild(tabs);
    panel.appendChild(bodyEl);
    panel.appendChild(foot);
    panel.appendChild(scope);
    document.body.appendChild(panel);

    restorePos();
    showTab("quick");

    document.addEventListener("keydown", onKey);
  }

  function showTab(which) {
    Object.keys(pages).forEach(function (k) {
      pages[k].classList.toggle("active", k === which);
      tabBtns[k].classList.toggle("active", k === which);
    });
    bodyEl.scrollTop = 0;
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === "Escape") {
      if (closeAnyFontPop()) return;
      if (picking) return exitPick();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      e.preventDefault();
      undo();
    }
  }

  // ── Quick tab ─────────────────────────────────────────────────────────────

  function buildQuick(root) {
    var secPresets = section(root, "fa-wand-magic-sparkles", "Presets");
    var grid = el("div", "tked-presets");
    Object.keys(PRESETS).forEach(function (name) {
      var b = el("button", "tked-preset");
      var dots = el("span", "tked-dots");
      var defs = E.tokenDefaults();
      DOT_KEYS.forEach(function (k) {
        var i = document.createElement("i");
        i.style.background = PRESETS[name][k] || defs[k];
        dots.appendChild(i);
      });
      b.appendChild(dots);
      b.appendChild(document.createTextNode(name));
      b.addEventListener("click", function () {
        pushHistory("preset");
        profile().tokens =
          name === "Classic" ? {} : Object.assign({}, PRESETS[name]);
        profile().effect = PRESET_EFFECTS[name] || "";
        previewNow();
        syncInputs();
      });
      grid.appendChild(b);
    });
    secPresets.appendChild(grid);

    var secGen = section(root, "fa-hat-wizard", "Theme builder");
    var hint = el("div", "tked-hint");
    hint.textContent =
      "Pick two colors and everything else is matched for you: panels, text, borders, strips. Then fine-tune in Colors.";
    secGen.appendChild(hint);

    var rowA = el("div", "tked-gen-row");
    rowA.appendChild(el("div", "tked-name", "Accent color"));
    genAccent = document.createElement("input");
    genAccent.type = "color";
    genAccent.value = "#ff9800";
    rowA.appendChild(genAccent);
    secGen.appendChild(rowA);

    var rowB = el("div", "tked-gen-row");
    rowB.appendChild(el("div", "tked-name", "Background"));
    genBg = document.createElement("input");
    genBg.type = "color";
    genBg.value = "#202020";
    rowB.appendChild(genBg);
    secGen.appendChild(rowB);

    var go = el("button", "tked-gen-btn");
    go.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Build my theme';
    go.addEventListener("click", function () {
      pushHistory("generate");
      profile().tokens = generatePalette(genAccent.value, genBg.value);
      previewNow();
      syncInputs();
      toast("Theme built. Fine-tune it in the Colors tab.");
    });
    secGen.appendChild(go);

    contrastEl = el("div", "tked-contrast");
    secGen.appendChild(contrastEl);
  }

  // ── Colors tab ────────────────────────────────────────────────────────────

  var GROUP_ICONS = {
    Colors: "fa-palette",
    Page: "fa-display",
    Panels: "fa-table-cells-large",
    Chat: "fa-keyboard",
    Staff: "fa-shield-halved",
    "More colors": "fa-eye-dropper",
  };

  function buildColors(root) {
    var secs = {};
    tokensForPage().forEach(function (t) {
      if (t.kind === "range") return;
      var g = t.group;
      if (!secs[g]) secs[g] = section(root, GROUP_ICONS[g] || "fa-circle", g);
      var row = el("div", "tked-row");
      row.dataset.token = t.id;
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", t.label));
      labels.appendChild(el("div", "tked-hint", t.hint || ""));
      row.appendChild(labels);

      var picker = document.createElement("input");
      picker.type = "color";
      var hex = document.createElement("input");
      hex.type = "text";
      hex.className = "tked-hex";
      hex.maxLength = 7;
      hex.spellcheck = false;
      var onPick = function (v) {
        if (!/^#[0-9a-f]{6}$/i.test(v)) return;
        pushHistory("tok:" + t.id);
        profile().tokens[t.id] = v.toLowerCase();
        picker.value = v;
        hex.value = v.toLowerCase();
        previewNow();
        updateContrast();
      };
      picker.addEventListener("input", function () { onPick(picker.value); });
      hex.addEventListener("input", function () {
        var v = hex.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) onPick(v);
      });
      row.appendChild(picker);
      row.appendChild(hex);
      secs[g].appendChild(row);
    });
  }

  // ── Style tab: effect, shape, fonts ───────────────────────────────────────

  function buildStyle(root) {
    var secFx = section(root, "fa-layer-group", "Surface style");
    var fxRow = el("div", "tked-row");
    var fxLabels = el("div", "tked-labels");
    fxLabels.appendChild(el("div", "tked-name", "Effect"));
    fxLabels.appendChild(
      el("div", "tked-hint", "Glass, brutal or soft looks for panels and cards"),
    );
    effectSel = document.createElement("select");
    effectSel.className = "tked-select";
    E.EFFECTS.forEach(function (fx) {
      var o = document.createElement("option");
      o.value = fx.id;
      o.textContent = fx.label;
      effectSel.appendChild(o);
    });
    effectSel.addEventListener("change", function () {
      pushHistory("effect");
      profile().effect = effectSel.value;
      previewNow();
    });
    fxRow.appendChild(fxLabels);
    fxRow.appendChild(effectSel);
    secFx.appendChild(fxRow);

    buildImages(root);

    var secShape = section(root, "fa-shapes", "Shape & size");
    tokensForPage().forEach(function (t) {
      if (t.kind !== "range") return;
      var row = el("div", "tked-row");
      row.dataset.token = t.id;
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", t.label));
      labels.appendChild(el("div", "tked-hint", t.hint || ""));
      var range = document.createElement("input");
      range.type = "range";
      range.className = "tked-range";
      range.min = t.min;
      range.max = t.max;
      range.step = 1;
      var val = el("span", "tked-rangeval", "");
      range.addEventListener("input", function () {
        pushHistory("tok:" + t.id);
        profile().tokens[t.id] = Number(range.value);
        val.textContent = range.value + (t.unit || "");
        previewNow();
      });
      row.appendChild(labels);
      row.appendChild(range);
      row.appendChild(val);
      secShape.appendChild(row);
    });

    var secFonts = section(root, "fa-font", "Fonts");
    var fhint = el("div", "tked-hint");
    fhint.textContent =
      "Google fonts load automatically. Each entry is drawn in its own font.";
    secFonts.appendChild(fhint);
    (E.FONT_SLOTS[PAGE] || []).forEach(function (slot) {
      var row = el("div", "tked-row");
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", slot.label));
      row.appendChild(labels);
      row.appendChild(fontDropdown(slot.id));
      secFonts.appendChild(row);
    });
  }

  // ── Image backgrounds (device-only, stripped when publishing) ─────────────

  var imgRows = {};

  function imagesFor() {
    if (!profile().images) profile().images = {};
    return profile().images;
  }

  function setImage(slotId, patch) {
    pushHistory("img:" + slotId);
    var imgs = imagesFor();
    if (patch === null) delete imgs[slotId];
    else imgs[slotId] = Object.assign({ fit: "cover", dim: 0 }, imgs[slotId], patch);
    previewNow();
    syncImages();
  }

  // Small files (pixel art) are kept byte for byte; big photos are scaled
  // down so one wallpaper cannot blow the browser storage the theme lives in.
  function readImageFile(file, cb) {
    if (!file || !/^image\//.test(file.type)) return cb(null);
    var fr = new FileReader();
    fr.onload = function () {
      var uri = fr.result;
      if (typeof uri !== "string") return cb(null);
      if (uri.length <= 400000) return cb(uri);
      var img = new Image();
      img.onload = function () {
        var max = 1400;
        var k = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        var out = c.toDataURL("image/jpeg", 0.82);
        cb(out.length <= 1600000 ? out : null);
      };
      img.onerror = function () { cb(null); };
      img.src = uri;
    };
    fr.readAsDataURL(file);
  }

  async function askImageUrl(slotId) {
    var url = null;
    if (window.StaffUI && StaffUI.prompt) {
      var fields = await StaffUI.prompt({
        title: "Image from a link",
        icon: '<i class="fas fa-link"></i>',
        message: "Paste a direct image link (ends in .png, .jpg, .gif...).",
        fields: [
          { name: "url", label: "Image URL", type: "text", maxLength: 2000, required: true, placeholder: "https://..." },
        ],
        confirmText: "Use image",
      });
      url = fields && fields.url;
    } else {
      url = prompt("Image URL (https://...):");
    }
    if (!url) return;
    url = url.trim();
    if (!E.validImageSrc(url) || url.indexOf("http") !== 0)
      return toast("That does not look like an image link.", "error");
    setImage(slotId, { src: url });
  }

  function buildImages(root) {
    var sec = section(root, "fa-image", "Image backgrounds");
    var hint = el("div", "tked-hint");
    hint.textContent =
      "Images stay on this device: publishing a theme shares colors, effect and fonts only. Share as text in More keeps them.";
    sec.appendChild(hint);

    E.IMG_SLOTS.filter(function (slot) {
      return !slot.pages || slot.pages.indexOf(PAGE) !== -1;
    }).forEach(function (slot) {
      var wrap = el("div", "tked-img-row");
      var top = el("div", "tked-img-top");
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", slot.label));
      labels.appendChild(el("div", "tked-hint", slot.hint || ""));
      var thumb = el("div", "tked-thumb");
      top.appendChild(labels);
      top.appendChild(thumb);
      wrap.appendChild(top);

      var btns = el("div", "tked-img-btns");
      var file = document.createElement("input");
      file.type = "file";
      file.accept = "image/*";
      file.style.display = "none";
      file.addEventListener("change", function () {
        var f = file.files && file.files[0];
        file.value = "";
        readImageFile(f, function (uri) {
          if (!uri)
            return toast("That image is too big. Try one under about 1 MB.", "error");
          setImage(slot.id, { src: uri });
        });
      });
      var up = el("button", "tked-btn slim");
      up.innerHTML = '<i class="fas fa-upload"></i> Upload';
      up.addEventListener("click", function () { file.click(); });
      var lnk = el("button", "tked-btn slim");
      lnk.innerHTML = '<i class="fas fa-link"></i> Link';
      lnk.addEventListener("click", function () { askImageUrl(slot.id); });
      var rm = el("button", "tked-btn slim danger");
      rm.innerHTML = '<i class="fas fa-xmark"></i>';
      rm.title = "Remove image";
      rm.addEventListener("click", function () { setImage(slot.id, null); });
      btns.appendChild(file);
      btns.appendChild(up);
      btns.appendChild(lnk);
      btns.appendChild(rm);
      wrap.appendChild(btns);

      var opts = el("div", "tked-img-opts");
      var fitSel = document.createElement("select");
      fitSel.className = "tked-select";
      [
        ["cover", "Fill the space"],
        ["tile", "Tile (repeat)"],
        ["pixel", "Tile big (pixel art)"],
      ].forEach(function (pair) {
        var o = document.createElement("option");
        o.value = pair[0];
        o.textContent = pair[1];
        fitSel.appendChild(o);
      });
      fitSel.addEventListener("change", function () {
        setImage(slot.id, { fit: fitSel.value });
      });
      opts.appendChild(fitSel);

      var dimRange = null, dimVal = null;
      if (slot.dim) {
        dimRange = document.createElement("input");
        dimRange.type = "range";
        dimRange.className = "tked-range";
        dimRange.min = 0;
        dimRange.max = 70;
        dimRange.step = 5;
        dimRange.title = "Darken the image so text stays readable";
        dimVal = el("span", "tked-rangeval", "");
        dimRange.addEventListener("input", function () {
          setImage(slot.id, { dim: Number(dimRange.value) / 100 });
        });
        opts.appendChild(dimRange);
        opts.appendChild(dimVal);
      }
      wrap.appendChild(opts);

      imgRows[slot.id] = {
        thumb: thumb,
        opts: opts,
        rm: rm,
        fitSel: fitSel,
        dimRange: dimRange,
        dimVal: dimVal,
      };
      sec.appendChild(wrap);
    });
  }

  function syncImages() {
    var imgs = profile().images || {};
    Object.keys(imgRows).forEach(function (slotId) {
      var r = imgRows[slotId];
      var val = imgs[slotId];
      var on = !!(val && val.src);
      r.thumb.style.backgroundImage = on ? 'url("' + val.src + '")' : "";
      r.thumb.classList.toggle("set", on);
      r.thumb.textContent = on ? "" : "None";
      r.opts.style.display = on ? "" : "none";
      r.rm.style.display = on ? "" : "none";
      if (on) {
        r.fitSel.value = val.fit || "cover";
        if (r.dimRange) {
          var d = Math.round((Number(val.dim) || 0) * 100);
          r.dimRange.value = d;
          r.dimVal.textContent = d + "%";
        }
      }
    });
  }

  // Custom font picker: button opens a searchable list, entries rendered in
  // their own font (loaded lazily as they scroll into view).
  var openFontPop = null;

  function closeAnyFontPop() {
    if (openFontPop) {
      openFontPop.classList.remove("show");
      openFontPop = null;
      return true;
    }
    return false;
  }

  function fontDropdown(slotId) {
    var dd = el("div", "tked-fontdd");
    var btn = el("button", "tked-font-btn", "Talkomatic default");
    var pop = el("div", "tked-font-pop");
    var search = document.createElement("input");
    search.className = "tked-font-search";
    search.type = "search";
    search.placeholder = "Search fonts...";
    var list = el("div", "tked-font-list");
    pop.appendChild(search);
    pop.appendChild(list);
    dd.appendChild(btn);
    dd.appendChild(pop);
    fontBtns[slotId] = btn;

    var observer = null;
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var fam = en.target.dataset.font;
            if (fam) E.ensureFont(fam);
            observer.unobserve(en.target);
          });
        },
        { root: list },
      );
    }

    function item(name) {
      var b = el("button", "tked-font-item", name || "Talkomatic default");
      if (name) {
        b.dataset.font = name;
        b.style.fontFamily = E.fontStack(name);
        if (observer) observer.observe(b);
        else E.ensureFont(name);
      }
      b.addEventListener("click", function () {
        pushHistory("font:" + slotId);
        profile().fonts[slotId] = name;
        setFontButton(slotId, name);
        previewNow();
        closeAnyFontPop();
      });
      return b;
    }

    function fill(q) {
      list.textContent = "";
      q = (q || "").toLowerCase();
      if (!q) list.appendChild(item(""));
      E.FONT_GROUPS.forEach(function (g) {
        var hits = g.fonts.filter(function (f) {
          return f.name.toLowerCase().indexOf(q) !== -1;
        });
        if (!hits.length) return;
        list.appendChild(el("div", "tked-font-group", g.label));
        hits.forEach(function (f) {
          var it = item(f.name);
          if ((profile().fonts || {})[slotId] === f.name) it.classList.add("on");
          list.appendChild(it);
        });
      });
    }

    search.addEventListener("input", function () { fill(search.value); });
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var was = openFontPop === pop;
      closeAnyFontPop();
      if (was) return;
      fill("");
      search.value = "";
      var r = btn.getBoundingClientRect();
      pop.style.left =
        Math.max(8, Math.min(window.innerWidth - 228, r.right - 220)) + "px";
      var below = window.innerHeight - r.bottom - 12;
      if (below > 200 || below > r.top - 12) {
        pop.style.top = r.bottom + 4 + "px";
        pop.style.bottom = "auto";
        pop.style.maxHeight = Math.max(120, Math.min(280, below)) + "px";
      } else {
        pop.style.bottom = window.innerHeight - r.top + 4 + "px";
        pop.style.top = "auto";
        pop.style.maxHeight = Math.max(120, Math.min(280, r.top - 12)) + "px";
      }
      pop.classList.add("show");
      openFontPop = pop;
      search.focus();
    });
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    return dd;
  }

  function setFontButton(slotId, name) {
    var btn = fontBtns[slotId];
    if (!btn) return;
    btn.textContent = name || "Talkomatic default";
    if (name) {
      E.ensureFont(name);
      btn.style.fontFamily = E.fontStack(name);
    } else btn.style.fontFamily = "";
  }

  document.addEventListener("click", function () { closeAnyFontPop(); });

  // ── More tab ──────────────────────────────────────────────────────────────

  function buildMore(root) {
    var copyBtn = el(
      "button",
      "tked-wide-btn",
      PAGE === "room" ? "Use this look in the lobby too" : "Use this look in rooms too",
    );
    copyBtn.addEventListener("click", function () {
      pushHistory("copy");
      working[PAGE === "room" ? "lobby" : "room"] = clone(profile());
      toast("Copied. Press Save theme to keep it.");
    });
    root.appendChild(copyBtn);

    var secShare = section(root, "fa-code", "Share as text");
    var shint = el("div", "tked-hint");
    shint.textContent =
      "Copy your whole theme as text to share it, or paste somebody else's here.";
    secShare.appendChild(shint);
    ioTa = document.createElement("textarea");
    ioTa.spellcheck = false;
    var ioWrap = el("div", "tked-io");
    ioWrap.appendChild(ioTa);
    var ioRow = el("div", "tked-io-row");
    var copyJson = el("button", "tked-btn", "Copy theme");
    copyJson.addEventListener("click", function () {
      ioTa.value = JSON.stringify(working);
      ioTa.select();
      try { navigator.clipboard.writeText(ioTa.value); toast("Theme copied"); } catch (e) {}
    });
    var applyJson = el("button", "tked-btn", "Apply pasted");
    applyJson.addEventListener("click", function () {
      try {
        var obj = JSON.parse(ioTa.value);
        if (!obj || typeof obj !== "object") throw 0;
        pushHistory("paste");
        working = Object.assign(
          { lobby: E.blankProfile(), room: E.blankProfile(), css: "" },
          obj,
        );
        working.lobby = Object.assign(E.blankProfile(), working.lobby);
        working.room = Object.assign(E.blankProfile(), working.room);
        previewNow();
        syncInputs();
        toast("Theme applied, press Save theme to keep it");
      } catch (e) {
        ioTa.value = "That did not look like a theme. Paste the text from Copy theme.";
      }
    });
    ioRow.appendChild(copyJson);
    ioRow.appendChild(applyJson);
    ioWrap.appendChild(ioRow);
    secShare.appendChild(ioWrap);

    var secCss = section(root, "fa-terminal", "Custom CSS (power users)");
    var cssHint = el("div", "tked-hint");
    cssHint.textContent =
      "Raw CSS applied on the lobby AND rooms, on this device only. Not included when you publish a theme.";
    secCss.appendChild(cssHint);
    cssBox = document.createElement("textarea");
    cssBox.className = "tked-css";
    cssBox.spellcheck = false;
    cssBox.placeholder = ".external-links a { text-transform: uppercase; }";
    cssBox.addEventListener("input", function () {
      working.css = cssBox.value;
      previewNow();
    });
    secCss.appendChild(cssBox);
  }

  // ── Dragging ──────────────────────────────────────────────────────────────

  function isMobile() {
    return window.matchMedia("(max-width: 640px)").matches;
  }

  function clampPos(x, y) {
    var w = panel.offsetWidth || 340;
    return {
      x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - 48, y)),
    };
  }

  function setPos(x, y) {
    var p = clampPos(x, y);
    panel.style.left = p.x + "px";
    panel.style.top = p.y + "px";
    panel.style.right = "auto";
  }

  function restorePos() {
    if (isMobile()) return;
    try {
      var p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && typeof p.x === "number" && typeof p.y === "number") setPos(p.x, p.y);
    } catch (e) {}
  }

  function makeDraggable(handle) {
    var startX, startY, origX, origY, dragging = false;
    handle.addEventListener("pointerdown", function (e) {
      if (isMobile()) return;
      if (e.target.closest("button")) return;
      dragging = true;
      var r = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origX = r.left;
      origY = r.top;
      document.body.classList.add("tked-dragging");
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      setPos(origX + (e.clientX - startX), origY + (e.clientY - startY));
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("tked-dragging");
      var r = panel.getBoundingClientRect();
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
      } catch (e) {}
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // ── Pick from page: click anything to find the setting that colors it ─────

  var picking = false;
  var pickBox = null;
  var pickTag = null;

  function pickCandidates() {
    var defs = E.tokenDefaults();
    var toks = profile().tokens || {};
    return tokensForPage()
      .filter(function (t) { return t.kind !== "range"; })
      .map(function (t) {
        var v = toks[t.id] || defs[t.id];
        return { t: t, rgb: hexRgb(v) };
      });
  }

  function cssColorToRgb(s) {
    var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(s || "");
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  function effectiveBg(node) {
    var n = node;
    while (n && n !== document.documentElement) {
      var c = cssColorToRgb(getComputedStyle(n).backgroundColor);
      if (c) return c;
      n = n.parentElement;
    }
    return cssColorToRgb(getComputedStyle(document.body).backgroundColor);
  }

  function bestToken(rgb, preferText) {
    if (!rgb) return null;
    var best = null, bestD = Infinity;
    pickCandidates().forEach(function (c) {
      var d = colorDist(rgb, c.rgb);
      // Identical values (black text vs black cards) tie; break the tie
      // toward text-ish tokens when we are matching a text color.
      if (preferText && c.t.id.indexOf("text") !== -1) d -= 1;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    });
    return best && bestD <= 90 ? best.t : null;
  }

  function pickTargets(elUnder) {
    var bg = bestToken(effectiveBg(elUnder));
    var textTok = null;
    if (elUnder.textContent && elUnder.textContent.trim()) {
      textTok = bestToken(cssColorToRgb(getComputedStyle(elUnder).color), true);
    }
    if (textTok && bg && textTok.id === bg.id) textTok = null;
    return { bg: bg, text: textTok };
  }

  function onPickMove(e) {
    var under = elUnderPoint(e.clientX, e.clientY);
    if (!under || panel.contains(under)) {
      pickBox.style.display = "none";
      return;
    }
    var r = under.getBoundingClientRect();
    pickBox.style.display = "block";
    pickBox.style.left = r.left + "px";
    pickBox.style.top = r.top + "px";
    pickBox.style.width = r.width + "px";
    pickBox.style.height = r.height + "px";
    var t = pickTargets(under);
    var label = t.bg ? t.bg.label : "";
    if (t.text) label += (label ? " · " : "") + t.text.label + " (text)";
    pickTag.textContent = label || "No matching setting";
    pickTag.classList.toggle("below", r.top < 34);
  }

  function elUnderPoint(x, y) {
    pickBox.style.display = "none";
    var n = document.elementFromPoint(x, y);
    return n;
  }

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var under = elUnderPoint(e.clientX, e.clientY);
    if (!under || panel.contains(under)) return;
    var t = pickTargets(under);
    exitPick();
    if (!t.bg && !t.text) {
      toast("No color setting matches that element.", "error");
      return;
    }
    showTab("colors");
    panel.classList.remove("collapsed");
    var first = null;
    [t.bg, t.text].forEach(function (tok) {
      if (!tok) return;
      var row = pages.colors.querySelector('.tked-row[data-token="' + tok.id + '"]');
      if (!row) return;
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
      if (!first) first = row;
    });
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function togglePick() {
    if (picking) exitPick();
    else enterPick();
  }

  function enterPick() {
    if (picking) return;
    picking = true;
    pickBtn.classList.add("active");
    if (!pickBox) {
      pickBox = el("div", "tked-pick-box");
      pickTag = el("div", "tked-pick-tag");
      pickBox.appendChild(pickTag);
      document.body.appendChild(pickBox);
    }
    document.body.classList.add("tked-picking");
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("click", onPickClick, true);
  }

  function exitPick() {
    if (!picking) return;
    picking = false;
    pickBtn.classList.remove("active");
    document.body.classList.remove("tked-picking");
    if (pickBox) pickBox.style.display = "none";
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("click", onPickClick, true);
  }

  // ── Sync inputs from working state ────────────────────────────────────────

  function syncInputs() {
    var defs = E.tokenDefaults();
    var toks = profile().tokens || {};
    var byId = {};
    E.TOKENS.forEach(function (t) { byId[t.id] = t; });
    panel.querySelectorAll(".tked-row[data-token]").forEach(function (row) {
      var id = row.dataset.token;
      var t = byId[id] || {};
      if (t.kind === "range") {
        var n = Number(toks[id]);
        if (!Number.isFinite(n)) n = t.def;
        var range = row.querySelector(".tked-range");
        var val = row.querySelector(".tked-rangeval");
        if (range) range.value = n;
        if (val) val.textContent = n + (t.unit || "");
        return;
      }
      var v = toks[id] || defs[id] || "#000000";
      if (/^#[0-9a-f]{3}$/i.test(v))
        v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      var picker = row.querySelector("input[type=color]");
      var hex = row.querySelector(".tked-hex");
      if (picker) picker.value = v;
      if (hex) hex.value = v.toLowerCase();
    });
    if (effectSel) effectSel.value = profile().effect || "";
    Object.keys(fontBtns).forEach(function (slot) {
      setFontButton(slot, (profile().fonts || {})[slot] || "");
    });
    if (cssBox) cssBox.value = working.css || "";
    if (genAccent) genAccent.value = toks.accent || defs.accent;
    if (genBg) genBg.value = toks.bg || defs.bg;
    syncImages();
    updateContrast();
  }

  // ── Publish to the Themes library ─────────────────────────────────────────

  async function publishTheme() {
    var fields;
    if (window.StaffUI && StaffUI.prompt) {
      fields = await StaffUI.prompt({
        title: "Publish to the Themes library",
        icon: '<i class="fas fa-upload"></i>',
        subtitle: "Everyone can browse and apply it",
        message:
          "Your theme's colors, effect and fonts are shared (custom CSS and images are not). The name you are signed in as is shown as the author.",
        fields: [
          { name: "title", label: "Theme name", type: "text", maxLength: 40, required: true, placeholder: "Sunset Glass" },
          { name: "desc", label: "Short description", type: "textarea", maxLength: 160, placeholder: "Warm orange glass with rounded corners" },
        ],
        confirmText: "Publish",
      });
      if (!fields) return;
    } else {
      var title = prompt("Theme name:");
      if (!title) return;
      fields = { title: title, desc: "" };
    }
    var state = clone(working);
    delete state.css;
    if (state.lobby) delete state.lobby.images;
    if (state.room) delete state.room.images;
    try {
      var res = await fetch("/api/v1/themes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          title: fields.title,
          desc: fields.desc || "",
          state: state,
          deviceId:
            (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
            undefined,
        }),
      });
      var body = await res.json().catch(function () { return null; });
      if (res.ok && body && body.ok) toast("Published! Find it on the Themes page.");
      else toast((body && (body.error && body.error.message || body.message)) || "Could not publish.", "error");
    } catch (e) {
      toast("Could not publish.", "error");
    }
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function openEditor() {
    build();
    working = clone(E.getState());
    working.lobby = Object.assign(E.blankProfile(), working.lobby);
    working.room = Object.assign(E.blankProfile(), working.room);
    history = [];
    if (undoBtn) undoBtn.disabled = true;
    syncInputs();
    open = true;
    panel.classList.add("show");
    panel.classList.remove("collapsed");
  }

  function close(keep) {
    if (!open) return;
    open = false;
    exitPick();
    closeAnyFontPop();
    panel.classList.remove("show");
    if (keep !== true) E.revert();
  }

  window.ThemeEditor = { open: openEditor, close: close };

  var link = document.getElementById("themeEditorLink");
  if (link)
    link.addEventListener("click", function (e) {
      e.preventDefault();
      openEditor();
    });
})();
