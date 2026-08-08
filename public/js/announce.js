// public/js/announce.js
// The developer notice card. Loads after lobby-client.js and reuses its
// `socket`. One notice at a time, shown full-screen the first time somebody
// sees it and never again once they close it - until a NEWER one is posted.
//
// Everything a notice contains is written by a developer, but it is still
// escaped before the markdown is applied: the only HTML on this card is HTML
// this file emits. A notice is not a place to be relaxed about that, because
// it is the one thing every single person is shown.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var SEEN_KEY = "tkNoticeSeen"; // highest announcement id this browser has read
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
      // Highest wins, so an older notice going live again cannot un-read a
      // newer one somebody has already dealt with.
      if (id > seenId()) localStorage.setItem(SEEN_KEY, String(id));
    } catch (e) {
      /* private mode: they will be shown it again, which is the safe way round */
    }
  }

  // ── Markdown ──────────────────────────────────────────────────────────────
  // Escaped first, then a small, closed set of markup is put back. Block level
  // is handled line by line so headings, lists and quotes actually render
  // rather than arriving as literal hashes and dashes.
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
    var list = null; // "ul" | "ol" | null
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

      // Fenced code: taken verbatim, no inline markup inside.
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
        var lvl = Math.min(6, h[1].length + 1); // "#" is h2: the card owns h1
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        continue;
      }
      var q = /^&gt;\s?(.*)$/.exec(line); // ">" is escaped by now
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

  // The quick picks. Anything else comes from the reader's own emoji keyboard.
  var QUICK = ["👍", "🎉", "❤️", "🔥", "😮", "😢"];

  var bodyEl, reactRow, titleEl, kindEl, metaEl, pickerInput;
  var gotItBtn, countFill, countHint, countTimer = null;

  // How long the way out stays shut. Long enough that the card cannot be
  // clicked away on reflex, short enough that it never feels like a punishment.
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

    // A real text input, so the phone's own emoji keyboard and the desktop
    // picker both work. Nothing to build and nothing to keep up to date.
    var picker = el("div", "an-picker");
    pickerInput = el("input", "an-picker-input");
    pickerInput.type = "text";
    pickerInput.maxLength = 16;
    pickerInput.setAttribute("aria-label", "React with any emoji");
    pickerInput.placeholder = "😀";
    pickerInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        sendReaction(pickerInput.value);
      }
    });
    pickerInput.addEventListener("input", function () {
      // Emoji keyboards insert and move on, so a picked emoji sends itself.
      var v = pickerInput.value.trim();
      if (v && !/[\w\s]/.test(v)) sendReaction(v);
    });
    picker.appendChild(pickerInput);
    reactWrap.appendChild(picker);

    // The way out, held shut for a few seconds. See startCountdown for why.
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

    // Deliberately NOT click-outside-to-close: this is the one thing everybody
    // is shown, and a stray click on the backdrop dismissing it forever is how
    // people miss the notice entirely. Escape still works.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) close();
    });
  }

  // Reactions repaint from the local list FIRST and let the server confirm
  // afterwards. Waiting for the round trip made every press feel stuck, and
  // the confirmation used to re-render the whole card - re-parsing the entire
  // markdown body - to change one number.
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

  function sendReaction(raw) {
    var v = String(raw || "").trim();
    if (!v || !current) return;
    pickerInput.value = "";
    applyLocalReaction(v);
    renderReactions();
    socket.emit("announcement react", { id: current.id, emoji: v });
  }

  function renderReactions() {
    if (!reactRow) return;
    reactRow.textContent = "";
    var mine = {};
    ((current && current.reactions) || []).forEach(function (r) {
      mine[r.e] = r;
      var b = el("button", "an-react" + (r.me ? " mine" : ""));
      b.innerHTML =
        '<span class="an-react-e"></span><span class="an-react-n"></span>';
      b.querySelector(".an-react-e").textContent = r.e;
      b.querySelector(".an-react-n").textContent = String(r.n);
      b.title = (r.me ? "You and " + (r.n - 1) + " others" : r.n + " reacted") ;
      if (r.n === 1) b.title = r.me ? "You reacted" : "1 reacted";
      b.addEventListener("click", function () {
        sendReaction(r.e);
      });
      reactRow.appendChild(b);
    });
    // The quick picks that nobody has used yet, so there is always something
    // to press without opening a keyboard.
    QUICK.forEach(function (e) {
      if (mine[e]) return;
      var b = el("button", "an-react an-quick");
      b.textContent = e;
      b.title = "React " + e;
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

  // The dismiss button is held shut for a few seconds, and SAYS SO. A notice
  // everybody is shown is also a notice everybody learns to click away without
  // reading; a short wait is enough to break that reflex. The bar fills so the
  // wait is visibly finite rather than a button that mysteriously ignores you,
  // and the line underneath gives the reason instead of leaving people to
  // guess they have hit a bug.
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
        // Focus only once it can actually be used, so a keyboard user is not
        // sitting on a dead button.
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

  function open() {
    if (!current) return;
    build();
    render();
    isOpen = true;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    startCountdown();
  }

  function close() {
    if (!isOpen) return;
    // The hold applies to Escape too, or it would be the way round it.
    if (gotItBtn && gotItBtn.disabled) return;
    isOpen = false;
    stopCountdown();
    overlay.classList.remove("show");
    document.body.style.overflow = "";
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
      // Same notice, and only the counts moved: repaint the one row. Calling
      // render() here re-parsed the whole markdown body on every reaction from
      // anybody in the lobby, which is what made pressing one feel slow.
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
    if (current.id > seenId()) open();
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

  // Exposed so the lobby can offer "read it again" later if it ever wants to.
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
