// public/js/themes-page.js
// The Themes library page: curated featured themes (public/themes/
// featured.json, edited by hand) on top, community themes (published from
// the visual editor via /api/v1/themes) below.
(function () {
  "use strict";

  var KEY = "talkomaticThemeV2";
  var DEFS = {
    accent: "#ff9800", "accent-hover": "#f57c00", detail: "#01ffff",
    bg: "#202020", text: "#ffffff", muted: "#cccccc", border: "#616161",
    tile: "#1b1b1b", card: "#000000", cream: "#fdf5e6", "cream-text": "#000000",
  };
  var PALETTE_ORDER = ["bg", "tile", "card", "accent", "cream", "detail", "text", "chat-text"];

  if (window.toastr)
    toastr.options = { positionClass: "toast-bottom-right", timeOut: 4000 };

  function toast(msg, type) {
    if (window.toastr) toastr[type || "success"](msg);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function mergedTokens(state) {
    var room = (state && state.room && state.room.tokens) || {};
    var lobby = (state && state.lobby && state.lobby.tokens) || {};
    return Object.assign({}, room, lobby);
  }

  function tok(state, k) {
    return mergedTokens(state)[k] || DEFS[k] || "#888888";
  }

  function paletteOf(state) {
    var m = mergedTokens(state);
    var out = [];
    PALETTE_ORDER.forEach(function (k) {
      var v = m[k];
      if (typeof v === "string" && /^#/.test(v)) out.push([k, v]);
    });
    if (!out.length)
      out = [["accent", DEFS.accent], ["bg", DEFS.bg], ["text", DEFS.text]];
    return out.slice(0, 8);
  }

  function applyTheme(state, name) {
    var existing = null;
    try { existing = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    var blank = { tokens: {}, effect: "", fonts: {} };
    var next = {
      lobby: Object.assign({}, blank, state.lobby || {}),
      room: Object.assign({}, blank, state.room || {}),
      css: (existing && existing.css) || "",
    };
    localStorage.setItem(KEY, JSON.stringify(next));
    toast('"' + name + '" applied! Open the lobby to see it everywhere.');
    if (window.ThemeEngine) window.ThemeEngine.revert();
  }

  function miniPreview(state) {
    var mini = el("div", "mini");
    mini.style.background = tok(state, "bg");
    mini.innerHTML =
      '<div class="mini-strip" style="background:' + tok(state, "cream") +
      ";color:" + tok(state, "cream-text") + '">Be Known As...</div>' +
      '<div class="mini-body">' +
      '<div class="mini-title" style="color:' + tok(state, "accent") + '">General Chat</div>' +
      '<div class="mini-text" style="color:' + tok(state, "text") + '">This is how your text will look. ' +
      '<span style="color:' + tok(state, "detail") + '">Public Room</span></div>' +
      '<span class="mini-btn" style="background:' + tok(state, "card") +
      ";border:1px solid " + tok(state, "accent") + ";color:" + tok(state, "text") + '">Enter</span>' +
      "</div>";
    return mini;
  }

  function palChips(state) {
    var pal = el("div", "pal");
    paletteOf(state).forEach(function (pair) {
      var chip = el("span", "pal-chip");
      chip.innerHTML = '<i style="background:' + pair[1] + '"></i>' + esc(pair[1]);
      chip.title = pair[0];
      pal.appendChild(chip);
    });
    return pal;
  }

  // ── Featured ──────────────────────────────────────────────────────────────

  function featCard(f) {
    var card = el("div", "feat-card");
    var img = el("img", "feat-img");
    img.src = f.image || "";
    img.alt = "";
    img.onerror = function () { img.style.display = "none"; };
    var body = el("div", "feat-body");
    body.appendChild(el("div", "feat-title", esc(f.title)));
    body.appendChild(el("div", "feat-desc", esc(f.desc || "")));
    body.appendChild(el("div", "feat-by", "by " + esc(f.by || "Talkomatic")));
    var actions = el("div", "card-actions");
    var apply = el("button", "btn btn-primary", '<i class="fas fa-check"></i> Apply');
    apply.addEventListener("click", function () { applyTheme(f.state || {}, f.title); });
    actions.appendChild(apply);
    body.appendChild(actions);
    card.appendChild(img);
    card.appendChild(body);
    return card;
  }

  // ── Community ─────────────────────────────────────────────────────────────

  function commCard(t) {
    var card = el("div", "theme-card");

    var sw = el("div", "swatches");
    paletteOf(t.state).slice(0, 6).forEach(function (pair) {
      var i = document.createElement("i");
      i.style.background = pair[1];
      sw.appendChild(i);
    });
    card.appendChild(sw);

    var body = el("div", "theme-body");
    body.appendChild(el("div", "theme-title", esc(t.title)));
    body.appendChild(el("div", "theme-desc", esc(t.desc || "")));
    var when = t.at ? new Date(t.at).toLocaleDateString() : "";
    body.appendChild(
      el("div", "theme-meta", "shared by <b>" + esc(t.by || "Anonymous") + "</b> · " + when),
    );
    var actions = el("div", "card-actions");
    var apply = el("button", "btn btn-primary", '<i class="fas fa-check"></i> Apply');
    apply.addEventListener("click", function () { applyTheme(t.state || {}, t.title); });
    var details = el("button", "btn", '<i class="fas fa-eye"></i> Details');
    details.addEventListener("click", function () {
      card.classList.toggle("open");
    });
    actions.appendChild(apply);
    actions.appendChild(details);

    var staffKey =
      localStorage.getItem("talkomatic_devKey") ||
      localStorage.getItem("talkomatic_modKey");
    if (staffKey) {
      var rm = el("button", "btn", '<i class="fas fa-trash"></i> Remove');
      rm.addEventListener("click", function () {
        if (!confirm('Take down "' + (t.title || "this theme") + '" for everyone?')) return;
        fetch("/api/v1/themes/" + encodeURIComponent(t.id), {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "x-staff-key": staffKey },
        })
          .then(function (r) {
            if (r.ok) card.remove();
            else if (r.status === 403) alert("Taking down themes needs a full mod key.");
            else alert("Could not remove that theme.");
          })
          .catch(function () { alert("Could not remove that theme."); });
      });
      actions.appendChild(rm);
    }
    body.appendChild(actions);
    card.appendChild(body);

    var expand = el("div", "expand");
    expand.appendChild(palChips(t.state));
    expand.appendChild(miniPreview(t.state));
    card.appendChild(expand);
    return card;
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  fetch("themes/featured.json?v=3")
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var wrap = document.getElementById("featured");
      (Array.isArray(list) ? list : []).forEach(function (f) {
        wrap.appendChild(featCard(f));
      });
    })
    .catch(function () {});

  fetch("/api/v1/themes", { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var list = (data && data.themes) || [];
      var wrap = document.getElementById("community");
      if (!list.length) {
        document.getElementById("commEmpty").style.display = "block";
        return;
      }
      list.forEach(function (t) { wrap.appendChild(commCard(t)); });
    })
    .catch(function () {
      document.getElementById("commEmpty").style.display = "block";
    });
})();
