// public/js/announce.js
// The developer notice card.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var SEEN_KEY = "tkNoticeSeen";
  var current = null;
  var overlay = null;
  var built = false;
  var isOpen = false;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function seenId() {
    try {
      return Number(localStorage.getItem(SEEN_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function markSeen(id) {
    try {
      if (id > seenId()) localStorage.setItem(SEEN_KEY, String(id));
    } catch (e) {
    }
  }

  // ── Markdown ──────────────────────────────────────────────────────────────
  function inline(s) {
    return s
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, function (m, alt, src) {
        return '<img src="' + esc(src) + '" alt="' + esc(alt) + '" loading="lazy">';
      })
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, txt, href) {
        return (
          '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
          txt +
          "</a>"
        );
      })
      .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~\n][^~]*?)~~/g, "<s>$1</s>");
  }

  function renderMarkdown(src) {
    var lines = esc(String(src || "")).split("\n");
    var out = [];
    var list = null;
    var inCode = false;
    var code = [];

    function closeList() {
      if (list) {
        out.push("</" + list + ">");
        list = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];

      if (/^\s*```/.test(raw)) {
        if (inCode) {
          out.push("<pre><code>" + code.join("\n") + "</code></pre>");
          code = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(raw);
        continue;
      }

      var line = raw.trim();

      if (!line) {
        closeList();
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        closeList();
        out.push("<hr>");
        continue;
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        var lvl = Math.min(6, h[1].length + 1);
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        continue;
      }
      var q = /^&gt;\s?(.*)$/.exec(line);
      if (q) {
        closeList();
        out.push("<blockquote>" + inline(q[1]) + "</blockquote>");
        continue;
      }
      var ul = /^[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + inline(ul[1]) + "</li>");
        continue;
      }
      var ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + inline(ol[1]) + "</li>");
        continue;
      }
      closeList();
      out.push("<p>" + inline(line) + "</p>");
    }
    if (inCode && code.length)
      out.push("<pre><code>" + code.join("\n") + "</code></pre>");
    closeList();
    return out.join("");
  }

  // ── The card ──────────────────────────────────────────────────────────────

  var KIND_META = {
    update: { label: "Update", icon: "fa-rocket", cls: "an-update" },
    notice: { label: "Notice", icon: "fa-bullhorn", cls: "an-notice" },
    alert: { label: "Important", icon: "fa-triangle-exclamation", cls: "an-alert" },
  };

  // Must match REACTION_EMOJIS in server/announcements.js.
  var REACTIONS = ["👍", "😄", "❤️", "🎉"];

  var bodyEl, reactRow, titleEl, kindEl, metaEl;
  var gotItBtn, countFill, countHint, countTimer = null;

  var HOLD_SECONDS = 4;

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "an-overlay");
    overlay.id = "announceOverlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "announceTitle");

    var card = el("div", "an-card");

    var head = el("div", "an-head");
    kindEl = el("span", "an-kind");
    titleEl = el("h1", "an-title");
    titleEl.id = "announceTitle";
    metaEl = el("div", "an-meta");
    var headText = el("div", "an-head-text");
    headText.appendChild(kindEl);
    headText.appendChild(titleEl);
    headText.appendChild(metaEl);
    head.appendChild(headText);

    bodyEl = el("div", "an-body");

    var foot = el("div", "an-foot");
    var reactWrap = el("div", "an-react-wrap");
    reactRow = el("div", "an-reacts");
    reactWrap.appendChild(reactRow);

    var closeWrap = el("div", "an-close-wrap");
    gotItBtn = el("button", "an-close-btn");
    gotItBtn.appendChild(el("span", "an-close-label", "Got it"));
    countFill = el("span", "an-close-fill");
    gotItBtn.appendChild(countFill);
    gotItBtn.addEventListener("click", function () {
      if (gotItBtn.disabled) return;
      close();
    });
    closeWrap.appendChild(gotItBtn);
    countHint = el("div", "an-close-hint", "");
    closeWrap.appendChild(countHint);

    foot.appendChild(reactWrap);
    foot.appendChild(closeWrap);

    card.appendChild(head);
    card.appendChild(bodyEl);
    card.appendChild(foot);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) close();
    });
  }

  function applyLocalReaction(emoji) {
    if (!current) return;
    var list = current.reactions || (current.reactions = []);
    var found = null;
    for (var i = 0; i < list.length; i++)
      if (list[i].e === emoji) {
        found = list[i];
        break;
      }
    if (found) {
      if (found.me) {
        found.n--;
        found.me = false;
        if (found.n <= 0) list.splice(list.indexOf(found), 1);
      } else {
        found.n++;
        found.me = true;
      }
    } else {
      list.push({ e: emoji, n: 1, me: true });
    }
    list.sort(function (a, b) {
      return b.n - a.n || (a.e < b.e ? -1 : 1);
    });
  }

  var lastReactAt = 0;

  function sendReaction(raw) {
    var v = String(raw || "").trim();
    if (!v || !current) return;
    if (REACTIONS.indexOf(v) === -1) return;
    // The server drops reactions faster than 400ms apart without a word; if
    // we rendered those optimistically the next broadcast would revert them.
    var now = Date.now();
    if (now - lastReactAt < 450) return;
    lastReactAt = now;
    applyLocalReaction(v);
    renderReactions();
    socket.emit("announcement react", { id: current.id, emoji: v });
  }

  function renderReactions() {
    if (!reactRow) return;
    reactRow.textContent = "";
    var byEmoji = {};
    ((current && current.reactions) || []).forEach(function (r) {
      byEmoji[r.e] = r;
    });
    REACTIONS.forEach(function (e) {
      var r = byEmoji[e];
      var n = r ? r.n : 0;
      var b = el("button", "an-react" + (r && r.me ? " mine" : ""));
      b.appendChild(el("span", "an-react-e", e));
      if (n > 0) b.appendChild(el("span", "an-react-n", String(n)));
      b.title = !n
        ? "React " + e
        : r.me
          ? n === 1
            ? "You reacted"
            : "You and " + (n - 1) + " others"
          : n + " reacted";
      b.addEventListener("click", function () {
        sendReaction(e);
      });
      reactRow.appendChild(b);
    });
  }

  function render() {
    if (!current) return;
    var meta = KIND_META[current.kind] || KIND_META.notice;
    kindEl.className = "an-kind " + meta.cls;
    kindEl.innerHTML = '<i class="fas ' + meta.icon + '"></i> ' + meta.label;
    titleEl.textContent = current.title;
    var when = new Date(current.at).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    metaEl.textContent = "From " + (current.by || "Talkomatic") + " · " + when;
    bodyEl.innerHTML = renderMarkdown(current.body);
    renderReactions();
  }

  function startCountdown() {
    if (!gotItBtn) return;
    stopCountdown();
    var left = HOLD_SECONDS;
    gotItBtn.disabled = true;
    gotItBtn.setAttribute("aria-disabled", "true");
    var paint = function () {
      var done = HOLD_SECONDS - left;
      countFill.style.width = Math.round((done / HOLD_SECONDS) * 100) + "%";
      gotItBtn.querySelector(".an-close-label").textContent =
        left > 0 ? "Got it (" + left + ")" : "Got it";
      countHint.textContent =
        left > 0 ? "Have a read first - one moment." : "You are all caught up.";
    };
    paint();
    countTimer = setInterval(function () {
      left--;
      paint();
      if (left <= 0) {
        stopCountdown();
        gotItBtn.disabled = false;
        gotItBtn.removeAttribute("aria-disabled");
        countFill.style.width = "100%";
        try {
          gotItBtn.focus();
        } catch (e) {}
      }
    }, 1000);
  }

  function stopCountdown() {
    if (countTimer) clearInterval(countTimer);
    countTimer = null;
  }

  var lockedScrollY = 0;

  function lockBody() {
    lockedScrollY = window.scrollY || 0;
    document.body.style.position = "fixed";
    document.body.style.top = -lockedScrollY + "px";
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
  }

  function unlockBody() {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    document.body.style.overflow = "";
    window.scrollTo(0, lockedScrollY);
  }

  function open() {
    if (!current) return;
    build();
    render();
    isOpen = true;
    overlay.classList.add("show");
    lockBody();
    startCountdown();
  }

  function close() {
    if (!isOpen) return;
    if (gotItBtn && gotItBtn.disabled) return;
    isOpen = false;
    stopCountdown();
    overlay.classList.remove("show");
    unlockBody();
    if (current) markSeen(current.id);
  }

  socket.on("announcement current", function (a) {
    var prev = current;
    current = a || null;
    if (!current) {
      if (isOpen) close();
      return;
    }
    if (isOpen) {
      var sameNotice =
        prev &&
        prev.id === current.id &&
        prev.title === current.title &&
        prev.body === current.body &&
        prev.kind === current.kind;
      if (sameNotice) renderReactions();
      else render();
      return;
    }
    if (current.id > seenId()) {
      // On a first visit to the lobby the rules and staff read-through goes
      // first; the notice waits its turn instead of stacking on top.
      var welcomePending = false;
      try {
        welcomePending =
          !!document.getElementById("staffGuideLink") &&
          localStorage.getItem("tkWelcomeDone") !== "1";
      } catch (e) {}
      if (welcomePending)
        document.addEventListener(
          "tk-welcome-done",
          function () {
            if (current && !isOpen) open();
          },
          { once: true },
        );
      else open();
    }
  });

  socket.on("announcement result", function (d) {
    if (d && !d.ok && window.StaffUI)
      StaffUI.toast(d.error || "Something went wrong.", { type: "error" });
  });

  function ask() {
    socket.emit("announcement current");
  }
  if (socket.connected) ask();
  socket.on("connect", ask);

  window.Announcement = {
    open: function () {
      if (current) open();
    },
    close: close,
    has: function () {
      return !!current;
    },
  };
})();
