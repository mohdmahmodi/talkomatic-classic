// public/js/theme-editor.js (v2.1) Visual theme editor drawer, scoped to the
// page it is opened on: the lobby editor styles the lobby, the room editor
// (Apps > Theme Editor) styles rooms.
(function () {
  "use strict";
  if (!window.ThemeEngine) return;

  var E = window.ThemeEngine;
  var PAGE = E.PAGE;
  var isStaff = !!(
    localStorage.getItem("talkomatic_devKey") ||
    localStorage.getItem("talkomatic_modKey")
  );

  var open = false;
  var built = false;
  var drawer, effectSel, cssBox, ioArea;
  var fontSels = {};
  var working = null;

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
  };

  var CSS =
    ".tked-drawer{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:100vw;z-index:100001;" +
    "background:#181818;border-left:2px solid #ff9800;display:none;flex-direction:column;" +
    "font-family:talkoSS,Arial,sans-serif;color:#fff;box-shadow:-8px 0 30px rgba(0,0,0,.55)}" +
    ".tked-drawer.show{display:flex}" +
    ".tked-drawer.peeking{opacity:0;pointer-events:none}" +
    ".tked-head{background:#fdf5e6;color:#000;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0}" +
    ".tked-head-t{flex:1;min-width:0}" +
    ".tked-title{font-weight:bold;font-size:15px}" +
    ".tked-subtitle{font-size:10.5px;color:#666;margin-top:1px}" +
    ".tked-peek,.tked-close{background:#000;color:#fff;border:none;border-radius:5px;width:32px;height:32px;" +
    "font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}" +
    ".tked-peek:active{background:#ff9800;color:#000}" +
    ".tked-close{font-size:20px}" +
    ".tked-body{flex:1;overflow-y:auto;padding:12px 14px 16px}" +
    ".tked-body::-webkit-scrollbar{width:8px}.tked-body::-webkit-scrollbar-thumb{background:#616161;border-radius:4px}" +
    ".tked-sec{background:#0f0f0f;border:1px solid #333;border-radius:8px;padding:10px 12px;margin-bottom:10px}" +
    ".tked-sec-t{font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1.2px;color:#ff9800;" +
    "margin-bottom:8px;display:flex;align-items:center;gap:7px}" +
    ".tked-sec-t i{font-size:11px}" +
    ".tked-presets{display:flex;gap:6px;flex-wrap:wrap}" +
    ".tked-preset{background:#000;color:#fff;border:1px solid #616161;border-radius:5px;padding:7px 13px;" +
    "font-size:12px;font-weight:bold;cursor:pointer;font-family:inherit}" +
    ".tked-preset:hover{border-color:#ff9800;color:#ff9800}" +
    ".tked-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #232323}" +
    ".tked-row:last-child{border-bottom:none}" +
    ".tked-labels{flex:1;min-width:0}" +
    ".tked-name{font-size:13px;font-weight:bold}" +
    ".tked-hint{font-size:10.5px;color:#8f8f8f;margin-top:1px;line-height:1.3}" +
    ".tked-row input[type=color]{width:42px;height:30px;padding:0;border:1px solid #616161;border-radius:6px;" +
    "background:#000;cursor:pointer;flex-shrink:0}" +
    ".tked-hex{width:72px;background:#000;color:#fff;border:1px solid #616161;border-radius:5px;" +
    "padding:6px 7px;font-size:12px;font-family:inherit;text-transform:lowercase;flex-shrink:0}" +
    ".tked-hex:focus,.tked-select:focus{outline:none;border-color:#ff9800}" +
    ".tked-select{background:#000;color:#fff;border:1px solid #616161;border-radius:5px;padding:7px 8px;" +
    "font-size:12px;font-family:inherit;max-width:150px}" +
    ".tked-range{width:110px;accent-color:#ff9800;flex-shrink:0}" +
    ".tked-rangeval{width:44px;text-align:right;font-size:12px;color:#ccc;flex-shrink:0}" +
    ".tked-adv-toggle{background:#0f0f0f;color:#ccc;border:1px dashed #616161;border-radius:8px;padding:10px;" +
    "font-size:12.5px;font-weight:bold;cursor:pointer;font-family:inherit;width:100%;margin-bottom:10px}" +
    ".tked-adv-toggle:hover{border-color:#ff9800;color:#ff9800}" +
    ".tked-css{width:100%;height:120px;background:#000;color:#c8facc;border:1px solid #616161;border-radius:5px;" +
    "padding:8px;font-size:11px;font-family:monospace;box-sizing:border-box;resize:vertical;margin-top:6px}" +
    ".tked-foot{border-top:1px solid #333;padding:10px 14px;flex-shrink:0;background:#141414}" +
    ".tked-save{width:100%;background:#ff9800;color:#000;border:none;border-radius:6px;padding:11px;" +
    "font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit}" +
    ".tked-save:hover{background:#f57c00}" +
    ".tked-actions{display:flex;gap:8px;margin-top:8px}" +
    ".tked-btn{flex:1;background:#000;color:#ccc;border:1px solid #616161;border-radius:5px;padding:8px 6px;" +
    "font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap}" +
    ".tked-btn:hover{border-color:#ff9800;color:#ff9800}" +
    ".tked-btn.danger:hover{border-color:#ff5252;color:#ff5252}" +
    ".tked-io{display:none;padding:0 14px 12px;background:#141414}" +
    ".tked-io.show{display:block}" +
    ".tked-io textarea{width:100%;height:70px;background:#000;color:#ccc;border:1px solid #616161;" +
    "border-radius:5px;padding:7px;font-size:11px;font-family:monospace;box-sizing:border-box;resize:none}" +
    ".tked-io-row{display:flex;gap:8px;margin-top:6px}" +
    ".tked-io-row .tked-btn{flex:none;padding:7px 14px}" +
    ".tked-scope{background:#0d0d0d;border-top:1px solid #333;padding:8px 14px;font-size:10.5px;" +
    "color:#8f8f8f;flex-shrink:0;line-height:1.45}" +
    ".tked-scope b{color:#ff9800}" +
    "@media (max-width:640px){" +
    ".tked-drawer{top:auto;left:0;right:0;bottom:0;width:100%;max-height:58vh;border-left:none;" +
    "border-top:2px solid #ff9800;border-radius:14px 14px 0 0}" +
    ".tked-head{border-radius:12px 12px 0 0}}";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(msg, type) {
    if (window.StaffUI && StaffUI.toast)
      StaffUI.toast(msg, { type: type || "success" });
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

  // ── Build ─────────────────────────────────────────────────────────────────

  function build() {
    if (built) return;
    built = true;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    drawer = el("div", "tked-drawer");

    var head = el("div", "tked-head");
    var headT = el("div", "tked-head-t");
    headT.appendChild(
      el("div", "tked-title", "Theme Editor - " + (PAGE === "room" ? "Rooms" : "Lobby")),
    );
    headT.appendChild(
      el("div", "tked-subtitle", "Changes preview live. Hold the eye to see the page."),
    );
    var peek = el("button", "tked-peek");
    peek.innerHTML = '<i class="fas fa-eye"></i>';
    peek.title = "Hold to preview the page";
    var peekOn = function (e) { e.preventDefault(); drawer.classList.add("peeking"); };
    var peekOff = function () { drawer.classList.remove("peeking"); };
    peek.addEventListener("mousedown", peekOn);
    peek.addEventListener("touchstart", peekOn);
    document.addEventListener("mouseup", peekOff);
    document.addEventListener("touchend", peekOff);
    var x = el("button", "tked-close", "×");
    x.addEventListener("click", function () { close(); });
    head.appendChild(headT);
    head.appendChild(peek);
    head.appendChild(x);

    var body = el("div", "tked-body");

    var secPresets = section(body, "fa-wand-magic-sparkles", "Quick start");
    var presets = el("div", "tked-presets");
    Object.keys(PRESETS).forEach(function (name) {
      var b = el("button", "tked-preset", name);
      b.addEventListener("click", function () {
        profile().tokens =
          name === "Classic" ? {} : Object.assign({}, PRESETS[name]);
        previewNow();
        syncInputs();
      });
      presets.appendChild(b);
    });
    secPresets.appendChild(presets);

    var secFx = section(body, "fa-layer-group", "Effect style");
    var fxRow = el("div", "tked-row");
    var fxLabels = el("div", "tked-labels");
    fxLabels.appendChild(el("div", "tked-name", "Surface style"));
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
      profile().effect = effectSel.value;
      previewNow();
    });
    fxRow.appendChild(fxLabels);
    fxRow.appendChild(effectSel);
    secFx.appendChild(fxRow);

    var secFonts = section(body, "fa-font", "Fonts");
    (E.FONT_SLOTS[PAGE] || []).forEach(function (slot) {
      var row = el("div", "tked-row");
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", slot.label));
      var sel = document.createElement("select");
      sel.className = "tked-select";
      E.FONTS.forEach(function (f) {
        var o = document.createElement("option");
        o.value = f;
        o.textContent = f || "Talkomatic default";
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        profile().fonts[slot.id] = sel.value;
        previewNow();
      });
      fontSels[slot.id] = sel;
      row.appendChild(labels);
      row.appendChild(sel);
      secFonts.appendChild(row);
    });

    var groupIcons = {
      Colors: "fa-palette",
      Page: "fa-display",
      Panels: "fa-table-cells-large",
      Chat: "fa-keyboard",
      Shape: "fa-shapes",
      Staff: "fa-shield-halved",
      "More shape": "fa-sliders",
      "More colors": "fa-eye-dropper",
    };
    buildGroups(body, groupIcons, function (t) { return !t.adv; });

    var advToggle = el("button", "tked-adv-toggle", "Advanced options");
    var advWrap = el("div");
    advWrap.style.display = "none";
    buildGroups(advWrap, groupIcons, function (t) { return !!t.adv; });
    var secCss = section(advWrap, "fa-code", "Custom CSS (both pages)");
    var cssHint = el("div", "tked-hint");
    cssHint.textContent =
      "For power users: raw CSS applied on the lobby AND rooms, on this device only. Not included when you publish a theme.";
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
    advToggle.addEventListener("click", function () {
      var on = advWrap.style.display === "none";
      advWrap.style.display = on ? "block" : "none";
      advToggle.textContent = on ? "Hide advanced options" : "Advanced options";
    });
    body.appendChild(advToggle);
    body.appendChild(advWrap);

    var copyBtn = el(
      "button",
      "tked-adv-toggle",
      PAGE === "room" ? "Use this look in the lobby too" : "Use this look in rooms too",
    );
    copyBtn.addEventListener("click", function () {
      working[PAGE === "room" ? "lobby" : "room"] = clone(profile());
      toast("Copied. Press Save theme to keep it.");
    });
    body.appendChild(copyBtn);

    ioArea = el("div", "tked-io");
    var ta = document.createElement("textarea");
    ta.spellcheck = false;
    var ioRow = el("div", "tked-io-row");
    var copyJson = el("button", "tked-btn", "Copy");
    copyJson.addEventListener("click", function () {
      ta.value = JSON.stringify(working);
      ta.select();
      try { navigator.clipboard.writeText(ta.value); toast("Theme copied"); } catch (e) {}
    });
    var applyJson = el("button", "tked-btn", "Apply pasted");
    applyJson.addEventListener("click", function () {
      try {
        var obj = JSON.parse(ta.value);
        if (!obj || typeof obj !== "object") throw 0;
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
        ta.value = "That did not look like a theme. Paste the JSON from Copy.";
      }
    });
    ioRow.appendChild(copyJson);
    ioRow.appendChild(applyJson);
    ioArea.appendChild(ta);
    ioArea.appendChild(ioRow);
    ioArea._ta = ta;

    var foot = el("div", "tked-foot");
    var save = el("button", "tked-save");
    save.innerHTML = '<i class="fas fa-check"></i> Save theme';
    save.addEventListener("click", function () {
      E.saveState(working);
      toast("Theme saved");
      close(true);
    });
    var actions = el("div", "tked-actions");
    var shareJson = el("button", "tked-btn");
    shareJson.innerHTML = '<i class="fas fa-code"></i> Share JSON';
    shareJson.addEventListener("click", function () {
      ioArea.classList.toggle("show");
      if (ioArea.classList.contains("show"))
        ioArea._ta.value = JSON.stringify(working);
    });
    var publish = el("button", "tked-btn");
    publish.innerHTML = '<i class="fas fa-upload"></i> Publish';
    publish.title = "Share this theme in the public Themes library";
    publish.addEventListener("click", publishTheme);
    var reset = el("button", "tked-btn danger");
    reset.innerHTML = '<i class="fas fa-rotate-left"></i> Reset';
    reset.addEventListener("click", function () {
      working[PAGE] = E.blankProfile();
      previewNow();
      syncInputs();
      toast("This page is back to classic");
    });
    actions.appendChild(shareJson);
    actions.appendChild(publish);
    actions.appendChild(reset);
    foot.appendChild(save);
    foot.appendChild(actions);

    var scope = el("div", "tked-scope");
    scope.innerHTML =
      PAGE === "room"
        ? "This styles <b>rooms</b> only. To style the lobby, use <b>Customize</b> in the lobby menu."
        : "This styles the <b>lobby</b> only. To style rooms: open a room, press <b>Apps</b> (top right), then <b>Theme Editor</b>.";

    drawer.appendChild(head);
    drawer.appendChild(body);
    drawer.appendChild(ioArea);
    drawer.appendChild(foot);
    drawer.appendChild(scope);
    document.body.appendChild(drawer);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) close();
    });
  }

  function buildGroups(parent, icons, filter) {
    var secs = {};
    tokensForPage().forEach(function (t) {
      if (!filter(t)) return;
      if (!secs[t.group])
        secs[t.group] = section(parent, icons[t.group] || "fa-circle", t.group);
      var sec = secs[t.group];
      var row = el("div", "tked-row");
      row.dataset.token = t.id;
      var labels = el("div", "tked-labels");
      labels.appendChild(el("div", "tked-name", t.label));
      labels.appendChild(el("div", "tked-hint", t.hint || ""));
      row.appendChild(labels);

      if (t.kind === "range") {
        var range = document.createElement("input");
        range.type = "range";
        range.className = "tked-range";
        range.min = t.min;
        range.max = t.max;
        range.step = 1;
        var val = el("span", "tked-rangeval", "");
        range.addEventListener("input", function () {
          profile().tokens[t.id] = Number(range.value);
          val.textContent = range.value + (t.unit || "");
          previewNow();
        });
        row.appendChild(range);
        row.appendChild(val);
      } else {
        var picker = document.createElement("input");
        picker.type = "color";
        var hex = document.createElement("input");
        hex.type = "text";
        hex.className = "tked-hex";
        hex.maxLength = 7;
        hex.spellcheck = false;
        var onPick = function (v) {
          if (!/^#[0-9a-f]{6}$/i.test(v)) return;
          profile().tokens[t.id] = v.toLowerCase();
          picker.value = v;
          hex.value = v.toLowerCase();
          previewNow();
        };
        picker.addEventListener("input", function () { onPick(picker.value); });
        hex.addEventListener("input", function () {
          var v = hex.value.trim();
          if (/^#[0-9a-f]{6}$/i.test(v)) onPick(v);
        });
        row.appendChild(picker);
        row.appendChild(hex);
      }
      sec.appendChild(row);
    });
  }

  function syncInputs() {
    var defs = E.tokenDefaults();
    var toks = profile().tokens || {};
    var byId = {};
    E.TOKENS.forEach(function (t) { byId[t.id] = t; });
    drawer.querySelectorAll(".tked-row[data-token]").forEach(function (row) {
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
    Object.keys(fontSels).forEach(function (slot) {
      fontSels[slot].value = (profile().fonts || {})[slot] || "";
    });
    if (cssBox) cssBox.value = working.css || "";
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
          "Your theme's colors, effect and fonts are shared (custom CSS is not). The name you are signed in as is shown as the author.",
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

  function openEditor() {
    build();
    working = clone(E.getState());
    working.lobby = Object.assign(E.blankProfile(), working.lobby);
    working.room = Object.assign(E.blankProfile(), working.room);
    syncInputs();
    open = true;
    drawer.classList.add("show");
  }

  function close(keep) {
    if (!open) return;
    open = false;
    drawer.classList.remove("show");
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
