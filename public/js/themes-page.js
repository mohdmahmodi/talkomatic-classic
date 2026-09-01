// public/js/themes-page.js
// The Themes library page: curated featured themes (public/themes/
// featured.json, edited by hand) on top, community themes below, live over
// the socket. Search covers names and creators, votes are one per browser
// and counted server-side, and vote changes stream to everyone on the page.
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

  // ── Page state ────────────────────────────────────────────────────────────

  var themes = [];
  var featured = [];
  var cardIndex = {};
  var query = "";
  var sort = "top";
  var live = false;
  var pendingVotes = {};

  var $search = document.getElementById("themeSearch");
  var $clear = document.getElementById("searchClear");
  var $community = document.getElementById("community");
  var $featured = document.getElementById("featured");
  var $count = document.getElementById("commCount");
  var $empty = document.getElementById("commEmpty");
  var $noMatch = document.getElementById("commNoMatch");
  var $sortTop = document.getElementById("sortTop");
  var $sortNew = document.getElementById("sortNew");
  var $featuredSection = document.getElementById("featuredSection");
  var $makeOwn = document.getElementById("makeOwnSection");

  // ── Socket: live list and honest votes ────────────────────────────────────

  var socket = null;
  var fellBack = false;

  function connect() {
    if (typeof io === "undefined") return fallbackLoad();
    socket = io({
      transports: ["websocket"],
      upgrade: false,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      withCredentials: true,
      auth: {
        devKey: localStorage.getItem("talkomatic_devKey") || undefined,
        modKey: localStorage.getItem("talkomatic_modKey") || undefined,
        deviceId:
          (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
          undefined,
      },
    });

    socket.on("connect", function () {
      live = true;
      socket.emit("themes open");
    });

    socket.on("themes data", function (d) {
      themes = (d && d.themes) || [];
      render();
    });

    socket.on("themes vote update", function (d) {
      if (!d) return;
      var t = findTheme(d.id);
      if (!t) return;
      t.up = d.up;
      t.down = d.down;
      paintVotes(t);
    });

    socket.on("themes result", function (d) {
      if (!d || d.action !== "vote") return;
      delete pendingVotes[d.id];
      if (!d.ok) return toast(d.error || "Could not vote.", "error");
      var t = findTheme(d.id);
      if (!t) return;
      t.up = d.up;
      t.down = d.down;
      t.myVote = d.myVote;
      paintVotes(t);
      if (sort === "top") render();
    });

    socket.on("connect_error", function () {
      live = false;
      fallbackLoad();
    });

    socket.on("disconnect", function () {
      live = false;
    });
  }

  // Banned or otherwise socket-less visitors still get the library over HTTP;
  // only voting needs the live connection.
  function fallbackLoad() {
    if (fellBack || themes.length) return;
    fellBack = true;
    fetch("/api/v1/themes", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (themes.length) return;
        themes = (data && data.themes) || [];
        render();
      })
      .catch(function () { render(); });
  }

  function findTheme(id) {
    for (var i = 0; i < themes.length; i++)
      if (themes[i].id === id) return themes[i];
    return null;
  }

  // ── Theme helpers ─────────────────────────────────────────────────────────

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

  // ── Voting ────────────────────────────────────────────────────────────────

  function sendVote(t, dir) {
    if (!live || !socket) {
      toast("Voting needs a live connection. Reload and try again.", "error");
      return;
    }
    if (pendingVotes[t.id]) return;
    pendingVotes[t.id] = true;
    setTimeout(function () { delete pendingVotes[t.id]; }, 2500);
    socket.emit("themes vote", { id: t.id, dir: dir });
  }

  function paintVotes(t) {
    var refs = cardIndex[t.id];
    if (!refs) return;
    var score = (t.up || 0) - (t.down || 0);
    refs.score.textContent = String(score);
    refs.score.className =
      "vote-score" + (score > 0 ? " pos" : score < 0 ? " neg" : "");
    refs.up.classList.toggle("on-up", t.myVote === 1);
    refs.down.classList.toggle("on-down", t.myVote === -1);
    refs.up.title = t.up + (t.up === 1 ? " upvote" : " upvotes");
    refs.down.title = t.down + (t.down === 1 ? " downvote" : " downvotes");
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
    var actions = el("div", "card-foot");
    var apply = el("button", "btn btn-primary", '<i class="fas fa-check"></i> Apply');
    apply.addEventListener("click", function () { applyTheme(f.state || {}, f.title); });
    actions.appendChild(apply);
    body.appendChild(actions);
    card.appendChild(img);
    card.appendChild(body);
    return card;
  }

  // ── Community cards ───────────────────────────────────────────────────────

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
    if (t.desc) body.appendChild(el("div", "theme-desc", esc(t.desc)));
    var when = t.at ? new Date(t.at).toLocaleDateString() : "";
    body.appendChild(
      el("div", "theme-meta", "shared by <b>" + esc(t.by || "Anonymous") + "</b> · " + when),
    );

    var foot = el("div", "card-foot");

    var votes = el("div", "votes");
    var up = el("button", "vote-btn", '<i class="fas fa-chevron-up"></i>');
    up.type = "button";
    up.setAttribute("aria-label", "Upvote");
    var score = el("span", "vote-score", "0");
    var down = el("button", "vote-btn", '<i class="fas fa-chevron-down"></i>');
    down.type = "button";
    down.setAttribute("aria-label", "Downvote");
    up.addEventListener("click", function () {
      sendVote(t, t.myVote === 1 ? 0 : 1);
    });
    down.addEventListener("click", function () {
      sendVote(t, t.myVote === -1 ? 0 : -1);
    });
    votes.appendChild(up);
    votes.appendChild(score);
    votes.appendChild(down);
    foot.appendChild(votes);

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
            if (r.ok) {
              themes = themes.filter(function (x) { return x.id !== t.id; });
              render();
            } else if (r.status === 403) alert("Taking down themes needs a full mod key.");
            else alert("Could not remove that theme.");
          })
          .catch(function () { alert("Could not remove that theme."); });
      });
      actions.appendChild(rm);
    }
    foot.appendChild(actions);
    body.appendChild(foot);
    card.appendChild(body);

    var expand = el("div", "expand");
    expand.appendChild(palChips(t.state));
    expand.appendChild(miniPreview(t.state));
    card.appendChild(expand);

    cardIndex[t.id] = { up: up, down: down, score: score };
    paintVotes(t);
    return card;
  }

  // ── Search, sort, render ──────────────────────────────────────────────────

  function matches(t) {
    if (!query) return true;
    var hay = (String(t.title || "") + " " + String(t.by || "")).toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function sorted(list) {
    var out = list.slice();
    if (sort === "top")
      out.sort(function (a, b) {
        var sa = (a.up || 0) - (a.down || 0);
        var sb = (b.up || 0) - (b.down || 0);
        return sb - sa || b.at - a.at;
      });
    else out.sort(function (a, b) { return b.at - a.at; });
    return out;
  }

  function render() {
    cardIndex = {};
    $community.textContent = "";

    var shown = sorted(themes.filter(matches));
    shown.forEach(function (t) { $community.appendChild(commCard(t)); });

    $empty.style.display = !themes.length && !query ? "block" : "none";
    $noMatch.style.display = themes.length && query && !shown.length ? "block" : "none";
    $count.textContent = themes.length
      ? query
        ? shown.length + " of " + themes.length + " themes"
        : themes.length + (themes.length === 1 ? " theme" : " themes")
      : "";

    renderFeatured();
  }

  function renderFeatured() {
    $featured.textContent = "";
    var shown = featured.filter(matches);
    shown.forEach(function (f) { $featured.appendChild(featCard(f)); });
    $featuredSection.style.display = shown.length ? "" : "none";
    $makeOwn.style.display = query ? "none" : "";
  }

  $search.addEventListener("input", function () {
    query = $search.value.trim().toLowerCase();
    $clear.style.display = query ? "block" : "none";
    render();
  });
  $clear.addEventListener("click", function () {
    $search.value = "";
    query = "";
    $clear.style.display = "none";
    render();
    $search.focus();
  });

  function setSort(which) {
    if (sort === which) return;
    sort = which;
    $sortTop.classList.toggle("active", which === "top");
    $sortNew.classList.toggle("active", which === "new");
    render();
  }
  $sortTop.addEventListener("click", function () { setSort("top"); });
  $sortNew.addEventListener("click", function () { setSort("new"); });

  // ── Load ──────────────────────────────────────────────────────────────────

  fetch("themes/featured.json?v=3")
    .then(function (r) { return r.json(); })
    .then(function (list) {
      featured = Array.isArray(list) ? list : [];
      renderFeatured();
    })
    .catch(function () {});

  connect();
  // If the socket has not delivered within a few seconds, show the HTTP copy
  // rather than a blank page; the socket list replaces it whenever it lands.
  setTimeout(function () {
    if (!themes.length) fallbackLoad();
  }, 4000);
})();
