// public/js/suggest-board.js
// Ideas & Bugs board for the lobby: a forum-style list with a thread view,
// a composer, sidebar filters, and markers for what happened to your posts.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var SEEN_KEY = "tkBoardSeen";
  var READ_KEY = "tkBoardRead";
  var DRAFT_KEY = "tkBoardDraft";
  var NOTICE_KEY = "tkBoardNoticeKey";
  var TITLE_MAX = 80;
  var TEXT_MAX = 600;
  var REPLY_MAX = 300;
  var READ_CAP = 200;

  var STATUS_ORDER = ["open", "approved", "implemented", "declined"];
  var STATUS = {
    open: {
      cls: "st-open",
      icon: "fa-circle-dot",
      label: { any: "New", idea: "New", bug: "New" },
    },
    approved: {
      cls: "st-approved",
      icon: "fa-check",
      label: { any: "Approved", idea: "Approved", bug: "Confirmed" },
    },
    implemented: {
      cls: "st-done",
      icon: "fa-check-double",
      label: { any: "Done", idea: "Built", bug: "Fixed" },
    },
    declined: {
      cls: "st-declined",
      icon: "fa-xmark",
      label: { any: "Declined", idea: "Not doing", bug: "Won't fix" },
    },
  };
  var KIND = {
    idea: {
      label: "Idea",
      cls: "kind-idea",
      icon: "fa-lightbulb",
      blurb: "Something to add or change",
    },
    bug: {
      label: "Bug",
      cls: "kind-bug",
      icon: "fa-bug",
      blurb: "Something that is broken",
    },
  };
  var TABS = [
    ["all", "Everything", "fa-layer-group"],
    ["idea", "Ideas", "fa-lightbulb"],
    ["bug", "Bugs", "fa-bug"],
    ["mine", "My posts", "fa-user"],
  ];
  var SORTS = [
    ["top", "Top", "fa-arrow-up-wide-short"],
    ["new", "Newest", "fa-clock"],
    ["active", "Active", "fa-comments"],
  ];

  // ── State ─────────────────────────────────────────────────────────────────

  var board = null;
  var view = { name: "list", id: null };
  var tab = "all";
  var statusFilter = new Set();
  var sortMode = "top";
  var query = "";
  var editing = null;
  var built = false;
  var isOpen = false;
  var sessionSince = 0;
  var knownIds = null;
  var readAt = lsJSON(READ_KEY) || {};
  var replyDrafts = {};
  var draft = lsJSON(DRAFT_KEY) || { kind: "idea", title: "", text: "" };
  var previewMode = false;

  var overlay, side, main, helpPanel, listEl, searchInput;

  // ── Small helpers ─────────────────────────────────────────────────────────

  function lsGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function lsSet(key, val) {
    try {
      if (val == null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch (e) {}
  }

  function lsJSON(key) {
    try {
      return JSON.parse(lsGet(key) || "null");
    } catch (e) {
      return null;
    }
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function button(className, html, onClick, label) {
    var b = el("button", className);
    b.type = "button";
    b.innerHTML = html;
    if (label) b.setAttribute("aria-label", label);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function icon(name) {
    return '<i class="fas ' + name + '"></i>';
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderRich(text) {
    var s = esc(text);
    s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n][^*]*?)\*/g, "<em>$1</em>");
    s = s.replace(/~~([^~\n][^~]*?)~~/g, "<s>$1</s>");
    s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  function plain(text) {
    return String(text || "")
      .replace(/\*\*|~~|[*`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleOf(p) {
    if (p.title) return p.title;
    var flat = plain(p.text);
    return flat.length > 70 ? flat.slice(0, 70) + "…" : flat || "(no title)";
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    if (d < 30 * 86400000) return Math.floor(d / 86400000) + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  function toast(msg, type) {
    if (window.StaffUI) StaffUI.toast(msg, { type: type || "info" });
  }

  function confirmThen(opts, go) {
    if (window.StaffUI)
      StaffUI.confirm(opts).then(function (ok) {
        if (ok) go();
      });
    else if (window.confirm(opts.message)) go();
  }

  function autogrow(ta, max) {
    var cap = max || 320;
    ta.style.height = "auto";
    ta.style.height = Math.min(cap, ta.scrollHeight) + "px";
    ta.style.overflowY = ta.scrollHeight > cap ? "auto" : "hidden";
  }

  function statusLabel(st, kind) {
    var m = STATUS[st] || STATUS.open;
    return m.label[kind] || m.label.any;
  }

  function kindOf(p) {
    return KIND[p.kind] ? p.kind : "idea";
  }

  function badgeFor(role) {
    if (role === "dev") {
      var b = el("span", "sb-badge sb-badge-dev");
      var crown = el("img");
      crown.src = "images/icons/crown.gif";
      crown.alt = "";
      b.appendChild(crown);
      b.appendChild(document.createTextNode("ADMIN"));
      b.title = "Talkomatic admin";
      return b;
    }
    if (role === "mod") {
      var m = el("span", "mod-lobby-badge", "MOD");
      m.title = "Moderator";
      return m;
    }
    if (role === "jr") {
      var j = el("span", "mod-lobby-badge mod-lobby-badge-jr", "JR MOD");
      j.title = "Junior moderator";
      return j;
    }
    return null;
  }

  var ID_RE = /^\d{17,20}$/;
  var HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

  function avatarOf(av, size) {
    var node = el("span", "sb-avatar sb-avatar-" + (size || "md"));
    var preset = Number(av && av.preset);
    var isPreset = preset >= 1 && preset <= 999 && preset % 1 === 0;
    var id = av && (av.id || av.discordId);
    if (!isPreset && !(av && ID_RE.test(id || "") && HASH_RE.test(av.hash || ""))) {
      node.classList.add("is-empty");
      node.innerHTML = icon("fa-user");
      return node;
    }
    var img = el("img");
    img.alt = "";
    img.src = isPreset
      ? "/images/pfp/" + preset + ".png"
      : "https://cdn.discordapp.com/avatars/" +
        id +
        "/" +
        av.hash +
        ".webp?size=64" +
        (av.animated ? "&animated=true" : "");
    img.onerror = function () {
      node.classList.add("is-empty");
      node.innerHTML = icon("fa-user");
    };
    node.appendChild(img);
    return node;
  }

  function myAvatar() {
    try {
      return typeof storedAvatar === "function" ? storedAvatar() : null;
    } catch (e) {
      return null;
    }
  }

  function myName() {
    try {
      return typeof currentUsername === "string" ? currentUsername : "";
    } catch (e) {
      return "";
    }
  }

  // ── Data views ────────────────────────────────────────────────────────────

  function allPosts() {
    return board && board.posts ? board.posts : [];
  }

  function postById(id) {
    var posts = allPosts();
    for (var i = 0; i < posts.length; i++) if (posts[i].id === id) return posts[i];
    return null;
  }

  function lastActivity(p) {
    var t = p.at || 0;
    (p.replies || []).forEach(function (r) {
      if (r.at > t) t = r.at;
    });
    return t;
  }

  // A post is "read" up to the moment you last opened it. Your own posts
  // start from when you last closed the board, so a reply that landed while
  // you were away shows as new; other people's threads only start counting
  // once you have opened them.
  function readSince(p) {
    var t = readAt[p.id];
    if (t != null) return t;
    return p.mine ? sessionSince : Infinity;
  }

  function unreadInfo(p) {
    var since = readSince(p);
    var replies = 0;
    var latest = 0;
    (p.replies || []).forEach(function (r) {
      if (!r.mine && r.at > since) {
        replies++;
        if (r.at > latest) latest = r.at;
      }
    });
    var status = !!(p.mine && p.status !== "open" && (p.statusAt || 0) > since);
    if (status && p.statusAt > latest) latest = p.statusAt;
    return { replies: replies, status: status, any: replies > 0 || status, latest: latest };
  }

  function markRead(id) {
    readAt[id] = Date.now();
    var keys = Object.keys(readAt);
    if (keys.length > READ_CAP) {
      keys
        .sort(function (a, b) {
          return readAt[a] - readAt[b];
        })
        .slice(0, keys.length - READ_CAP)
        .forEach(function (k) {
          delete readAt[k];
        });
    }
    lsSet(READ_KEY, JSON.stringify(readAt));
  }

  function updatesForMe() {
    return allPosts()
      .filter(function (p) {
        return p.mine;
      })
      .map(function (p) {
        return { post: p, unread: unreadInfo(p) };
      })
      .filter(function (x) {
        return x.unread.any;
      })
      .sort(function (a, b) {
        return b.unread.latest - a.unread.latest;
      });
  }

  function matchesQuery(p) {
    if (!query) return true;
    var hay = (titleOf(p) + " " + (p.text || "") + " " + (p.name || "")).toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function inTab(p) {
    if (tab === "mine") return !!p.mine;
    if (tab === "all") return true;
    return kindOf(p) === tab;
  }

  function visiblePosts() {
    var posts = allPosts().filter(function (p) {
      if (!inTab(p)) return false;
      if (statusFilter.size && !statusFilter.has(p.status)) return false;
      return matchesQuery(p);
    });
    var by =
      sortMode === "top"
        ? function (a, b) {
            return b.up - b.down - (a.up - a.down) || b.at - a.at;
          }
        : sortMode === "active"
          ? function (a, b) {
              return lastActivity(b) - lastActivity(a);
            }
          : function (a, b) {
              return b.at - a.at;
            };
    posts.sort(by);
    if (tab === "mine")
      posts.sort(function (a, b) {
        return (unreadInfo(b).any ? 1 : 0) - (unreadInfo(a).any ? 1 : 0);
      });
    return posts;
  }

  // ── Skeleton ──────────────────────────────────────────────────────────────

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "sb-overlay");
    overlay.id = "suggestBoardOverlay";

    var modal = el("div", "sb-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Ideas and Bugs board");

    var head = el("header", "sb-head");
    var titleWrap = el("div", "sb-title-wrap");
    var title = el("div", "sb-title");
    title.innerHTML = icon("fa-lightbulb") + " Ideas &amp; Bugs";
    titleWrap.appendChild(title);
    titleWrap.appendChild(
      el("div", "sb-sub", "Suggest something, report what is broken, vote on what matters."),
    );
    var headBtns = el("div", "sb-head-btns");
    headBtns.appendChild(
      button("sb-btn sb-btn-primary sb-new-btn", icon("fa-plus") + " New post", openCompose),
    );
    headBtns.appendChild(
      button("sb-icon-btn", icon("fa-question"), toggleHelp, "How does this board work?"),
    );
    headBtns.appendChild(button("sb-icon-btn sb-close", "&times;", close, "Close"));
    head.appendChild(titleWrap);
    head.appendChild(headBtns);

    helpPanel = el("div", "sb-help");
    helpPanel.hidden = true;
    helpPanel.innerHTML =
      "<h4>How this board works</h4><ul>" +
      "<li><b>Idea</b> is something you want added or changed. <b>Bug</b> is something that is broken.</li>" +
      "<li><b>Vote</b> with the arrows. The Top sort ranks posts by votes, and the most wanted things get built first.</li>" +
      "<li><b>Search before you post.</b> If it is already here, upvote it instead of posting it again.</li>" +
      "<li><b>Statuses:</b> New means nobody has looked yet. Approved or Confirmed means we want to do it. Built or Fixed means it is done. Not doing or Won't fix means we decided against it.</li>" +
      "<li><b>My posts</b> keeps everything you wrote, with a marker when someone replies or a status changes. You also get a short note in the lobby when that happens.</li>" +
      "<li>You can edit or delete your own posts any time. You get 3 posts a day.</li>" +
      "</ul>";

    var body = el("div", "sb-body");
    side = el("aside", "sb-side");
    main = el("section", "sb-main");
    body.appendChild(side);
    body.appendChild(main);

    modal.appendChild(head);
    modal.appendChild(helpPanel);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !isOpen) return;
      if (view.name !== "list") goList();
      else close();
    });

    socket.on("board data", function (data) {
      board = data || null;
      if (!isOpen) return;
      if (view.name === "thread" && !postById(view.id)) {
        goList();
        return;
      }
      render();
    });
    socket.on("board result", onResult);
  }

  function onResult(d) {
    if (!d) return;
    if (!d.ok) {
      toast(d.error || "Something went wrong.", "error");
      return;
    }
    if (d.action === "post") {
      draft = { kind: draft.kind, title: "", text: "" };
      lsSet(DRAFT_KEY, null);
      goList();
      toast("Posted. Thanks!", "success");
    }
    if (d.action === "reply") delete replyDrafts[view.id];
    if (d.action === "edit") {
      editing = null;
      toast("Saved.", "success");
      renderMain();
    }
    if (d.action === "delete") toast("Deleted.", "success");
  }

  function toggleHelp() {
    helpPanel.hidden = !helpPanel.hidden;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function goList() {
    view = { name: "list", id: null };
    editing = null;
    render();
  }

  function openThread(id) {
    view = { name: "thread", id: id };
    editing = null;
    markRead(id);
    render();
    main.scrollTop = 0;
  }

  function openCompose() {
    if (board && board.remaining === 0) {
      toast("You have used your 3 posts for today. Try again tomorrow.", "error");
      return;
    }
    view = { name: "compose", id: null };
    previewMode = false;
    render();
    main.scrollTop = 0;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!board) return;
    renderSide();
    renderMain();
  }

  function renderSide() {
    side.textContent = "";
    var posts = allPosts();
    var counts = { all: posts.length, idea: 0, bug: 0, mine: 0 };
    var unreadMine = 0;
    posts.forEach(function (p) {
      counts[kindOf(p)]++;
      if (p.mine) {
        counts.mine++;
        if (unreadInfo(p).any) unreadMine++;
      }
    });

    var nav = el("nav", "sb-nav");
    TABS.forEach(function (t) {
      var b = button(
        "sb-nav-btn" + (tab === t[0] ? " active" : ""),
        icon(t[2]) + "<span>" + t[1] + "</span>",
        function () {
          tab = t[0];
          goList();
        },
      );
      if (t[0] === "mine" && unreadMine)
        b.appendChild(el("span", "sb-nav-dot", String(unreadMine)));
      else b.appendChild(el("span", "sb-nav-count", String(counts[t[0]])));
      nav.appendChild(b);
    });
    side.appendChild(nav);

    var toggle = button(
      "sb-filters-toggle",
      icon("fa-sliders") + " Filters" + (statusFilter.size ? " (" + statusFilter.size + ")" : ""),
      function () {
        side.classList.toggle("filters-open");
      },
    );
    side.appendChild(toggle);

    var filters = el("div", "sb-side-filters");

    var statusGroup = el("div", "sb-side-group");
    var statusHead = el("div", "sb-side-head");
    statusHead.appendChild(el("span", null, "Status"));
    if (statusFilter.size)
      statusHead.appendChild(
        button("sb-link-btn", "Clear", function () {
          statusFilter.clear();
          render();
        }),
      );
    statusGroup.appendChild(statusHead);
    var labelKind = tab === "idea" || tab === "bug" ? tab : "any";
    STATUS_ORDER.forEach(function (st) {
      var n = posts.filter(function (p) {
        return inTab(p) && p.status === st;
      }).length;
      var b = button(
        "sb-check" + (statusFilter.has(st) ? " on" : ""),
        '<span class="sb-check-box">' +
          icon("fa-check") +
          "</span>" +
          '<span class="sb-dot ' +
          STATUS[st].cls +
          '"></span>' +
          "<span>" +
          esc(statusLabel(st, labelKind)) +
          "</span>" +
          '<span class="sb-side-count">' +
          n +
          "</span>",
        function () {
          if (statusFilter.has(st)) statusFilter.delete(st);
          else statusFilter.add(st);
          render();
        },
      );
      b.setAttribute("aria-pressed", statusFilter.has(st) ? "true" : "false");
      statusGroup.appendChild(b);
    });
    filters.appendChild(statusGroup);

    var sortGroup = el("div", "sb-side-group");
    var sortHead = el("div", "sb-side-head");
    sortHead.appendChild(el("span", null, "Sort by"));
    sortGroup.appendChild(sortHead);
    var seg = el("div", "sb-seg");
    SORTS.forEach(function (s) {
      var b = button(
        "sb-seg-btn" + (sortMode === s[0] ? " active" : ""),
        icon(s[2]) + "<span>" + s[1] + "</span>",
        function () {
          sortMode = s[0];
          render();
        },
      );
      b.setAttribute("aria-pressed", sortMode === s[0] ? "true" : "false");
      seg.appendChild(b);
    });
    sortGroup.appendChild(seg);
    filters.appendChild(sortGroup);

    side.appendChild(filters);
    side.appendChild(remainingChip());
  }

  function remainingChip() {
    var n = board ? board.remaining : 0;
    var chip = el(
      "div",
      "sb-remain" + (n === 0 ? " is-empty" : ""),
      n > 0 ? plural(n, "post", "posts") + " left today" : "Daily post limit reached",
    );
    return chip;
  }

  function renderMain() {
    var focusReply = false;
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains("sb-reply-input"))
      focusReply = true;
    var scrollTop = main.scrollTop;
    main.textContent = "";
    main.className = "sb-main sb-view-" + view.name;
    if (view.name === "thread") renderThread(focusReply);
    else if (view.name === "compose") renderCompose();
    else renderList();
    main.scrollTop = scrollTop;
  }

  // ── List view ─────────────────────────────────────────────────────────────

  function renderList() {
    var bar = el("div", "sb-toolbar");
    var search = el("label", "sb-search");
    search.innerHTML = icon("fa-magnifying-glass");
    searchInput = el("input", "sb-search-input");
    searchInput.type = "search";
    searchInput.value = query;
    searchInput.placeholder =
      tab === "mine" ? "Search your posts…" : "Search titles, details and names…";
    searchInput.setAttribute("aria-label", "Search the board");
    searchInput.addEventListener("input", function () {
      query = searchInput.value.trim().toLowerCase();
      fillList();
    });
    search.appendChild(searchInput);
    bar.appendChild(search);
    main.appendChild(bar);

    var updates = tab === "mine" ? [] : updatesForMe();
    if (updates.length) main.appendChild(updatesStrip(updates));

    listEl = el("div", "sb-list");
    main.appendChild(listEl);
    fillList();
  }

  function updatesStrip(updates) {
    var strip = el("section", "sb-updates");
    var head = el("div", "sb-updates-head");
    head.innerHTML =
      icon("fa-bell") +
      "<span>For you</span><span class='sb-updates-count'>" +
      updates.length +
      "</span>";
    head.appendChild(
      button("sb-link-btn", "Mark all read", function () {
        updates.forEach(function (x) {
          markRead(x.post.id);
        });
        render();
      }),
    );
    strip.appendChild(head);
    updates.slice(0, 5).forEach(function (x) {
      var p = x.post;
      var u = x.unread;
      var kind = kindOf(p);
      var row = button("sb-update-row", "", function () {
        openThread(p.id);
      });
      var what = el("span", "sb-update-what");
      var pieces = [];
      if (u.status)
        pieces.push(
          "marked <b class='" + STATUS[p.status].cls + "'>" + esc(statusLabel(p.status, kind)) + "</b>",
        );
      if (u.replies) pieces.push("<b>" + plural(u.replies, "new reply", "new replies") + "</b>");
      what.innerHTML =
        icon(u.status && !u.replies ? STATUS[p.status].icon : "fa-reply") +
        " Your " +
        KIND[kind].label.toLowerCase() +
        " <span class='sb-update-title'>" +
        esc(titleOf(p)) +
        "</span> " +
        (u.status ? "was " : "has ") +
        pieces.join(u.status && u.replies ? " and has " : "");
      row.appendChild(what);
      row.appendChild(el("span", "sb-update-time", timeAgo(u.latest)));
      strip.appendChild(row);
    });
    if (updates.length > 5)
      strip.appendChild(
        el("div", "sb-updates-more", "And " + (updates.length - 5) + " more in My posts."),
      );
    return strip;
  }

  function fillList() {
    if (!listEl) return;
    listEl.textContent = "";
    var posts = visiblePosts();
    var total = allPosts().filter(inTab).length;

    var count = el("div", "sb-count-line");
    count.textContent =
      tab === "mine"
        ? posts.length === total
          ? plural(total, "post", "posts") + " of yours"
          : "Showing " + posts.length + " of your " + plural(total, "post", "posts")
        : posts.length === total
          ? plural(total, "post", "posts")
          : "Showing " + posts.length + " of " + total;
    listEl.appendChild(count);

    if (!posts.length) {
      listEl.appendChild(emptyState(total));
      return;
    }
    posts.forEach(function (p) {
      var row = rowFor(p);
      if (knownIds && !knownIds.has(p.id)) row.classList.add("is-fresh");
      listEl.appendChild(row);
    });
    knownIds = new Set(
      allPosts().map(function (p) {
        return p.id;
      }),
    );
  }

  function emptyState(total) {
    var empty = el("div", "sb-empty");
    if (tab === "mine" && !total) {
      empty.innerHTML =
        icon("fa-pen-to-square") +
        "<p>You have not posted anything yet.</p><span>Ideas and bug reports you write show up here, along with any replies.</span>";
      empty.appendChild(
        button("sb-btn sb-btn-primary", icon("fa-plus") + " Write your first post", openCompose),
      );
    } else if (total) {
      empty.innerHTML =
        icon("fa-magnifying-glass") +
        "<p>Nothing matches that.</p><span>Try another word, or clear a filter on the left.</span>";
    } else {
      empty.innerHTML =
        icon("fa-lightbulb") + "<p>Nothing here yet.</p><span>Be the first to post.</span>";
    }
    return empty;
  }

  function kindChip(kind) {
    var k = KIND[kind] || KIND.idea;
    var chip = el("span", "sb-chip " + k.cls);
    chip.innerHTML = icon(k.icon) + " " + k.label;
    return chip;
  }

  function statusPill(p) {
    var st = STATUS[p.status] || STATUS.open;
    var pill = el("span", "sb-pill " + st.cls);
    pill.innerHTML = icon(st.icon) + " " + esc(statusLabel(p.status, kindOf(p)));
    if (p.statusBy && p.status !== "open") pill.title = "Set by " + p.statusBy;
    return pill;
  }

  function voteBlock(p, layout) {
    var wrap = el("div", "sb-vote sb-vote-" + layout);
    var score = p.up - p.down;
    var up = button(
      "sb-vote-btn" + (p.myVote === 1 ? " active-up" : ""),
      icon("fa-chevron-up"),
      function (e) {
        e.stopPropagation();
        socket.emit("board vote", { id: p.id, dir: p.myVote === 1 ? 0 : 1 });
      },
      "Upvote",
    );
    var num = el("span", "sb-score" + (score > 0 ? " pos" : score < 0 ? " neg" : ""), String(score));
    num.title = p.up + " up, " + p.down + " down";
    var down = button(
      "sb-vote-btn" + (p.myVote === -1 ? " active-down" : ""),
      icon("fa-chevron-down"),
      function (e) {
        e.stopPropagation();
        socket.emit("board vote", { id: p.id, dir: p.myVote === -1 ? 0 : -1 });
      },
      "Downvote",
    );
    wrap.appendChild(up);
    wrap.appendChild(num);
    wrap.appendChild(down);
    return wrap;
  }

  function authorLine(p, size) {
    var meta = el("div", "sb-author");
    meta.appendChild(avatarOf(p.avatar, size));
    var badge = badgeFor(p.role);
    if (badge) meta.appendChild(badge);
    meta.appendChild(el("span", "sb-name", p.name || "Anonymous"));
    if (p.mine) meta.appendChild(el("span", "sb-you", "you"));
    return meta;
  }

  function rowFor(p) {
    var unread = unreadInfo(p);
    var row = el(
      "article",
      "sb-row" + (p.status === "declined" ? " is-declined" : "") + (unread.any ? " is-unread" : ""),
    );
    row.appendChild(voteBlock(p, "col"));

    var body = el("div", "sb-row-body");
    var top = el("div", "sb-row-top");
    top.appendChild(kindChip(kindOf(p)));
    var openIt = function () {
      openThread(p.id);
    };
    if (p.title) top.appendChild(button("sb-row-title", esc(p.title), openIt));
    top.appendChild(statusPill(p));
    body.appendChild(top);

    // Older posts have no title: the text itself is the headline, so it goes
    // in full (clamped by CSS) rather than chopped into a fake title.
    var text = plain(p.text);
    if (text) {
      var excerpt = el("p", p.title ? "sb-row-snippet" : "sb-row-text", text);
      body.appendChild(excerpt);
      if (text.length > 220) body.appendChild(button("sb-read-more", "Read more", openIt));
    }

    var meta = el("div", "sb-row-meta");
    meta.appendChild(authorLine(p, "sm"));
    meta.appendChild(el("span", "sb-time", timeAgo(p.at)));
    if (p.editedAt) meta.appendChild(el("span", "sb-time", "edited"));
    var replies = el("span", "sb-replies-count" + (p.replyCount ? "" : " is-zero"));
    replies.innerHTML = icon("fa-comment") + " " + (p.replyCount || 0);
    replies.title = plural(p.replyCount || 0, "reply", "replies");
    meta.appendChild(replies);
    if (unread.replies)
      meta.appendChild(el("span", "sb-new-pill", plural(unread.replies, "new reply", "new replies")));
    if (unread.status) {
      var st = el("span", "sb-new-pill " + STATUS[p.status].cls, "");
      st.innerHTML = icon(STATUS[p.status].icon) + " " + esc(statusLabel(p.status, kindOf(p)));
      meta.appendChild(st);
    }
    body.appendChild(meta);
    row.appendChild(body);

    row.addEventListener("click", function (e) {
      if (e.target.closest("button, a, input, textarea")) return;
      openThread(p.id);
    });
    return row;
  }

  // ── Thread view ───────────────────────────────────────────────────────────

  function tabLabel() {
    for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === tab) return TABS[i][1];
    return "Everything";
  }

  function renderThread(focusReply) {
    var p = postById(view.id);
    if (!p) {
      goList();
      return;
    }
    var kind = kindOf(p);

    var bar = el("div", "sb-view-bar");
    bar.appendChild(
      button("sb-back-btn", icon("fa-arrow-left") + " " + esc(tabLabel()), goList, "Back to the list"),
    );
    var tags = el("div", "sb-view-tags");
    tags.appendChild(kindChip(kind));
    tags.appendChild(statusPill(p));
    bar.appendChild(tags);
    main.appendChild(bar);

    var post = el("article", "sb-post");
    var head = el("div", "sb-post-head");
    var who = authorLine(p, "lg");
    var when = el("span", "sb-time", timeAgo(p.at) + (p.editedAt ? " · edited" : ""));
    when.title = new Date(p.at).toLocaleString();
    who.appendChild(when);
    head.appendChild(who);
    var isEditing = editing && editing.id === p.id && !editing.replyId;
    if (p.mine && !isEditing) {
      var own = el("div", "sb-own");
      own.appendChild(
        button("sb-ghost-btn", icon("fa-pen") + " Edit", function () {
          editing = { id: p.id };
          renderMain();
        }),
      );
      own.appendChild(
        button("sb-ghost-btn is-danger", icon("fa-trash") + " Delete", function () {
          confirmThen(
            {
              title: "Delete your post",
              message: "Remove this post and its replies? This cannot be undone.",
              danger: true,
              confirmText: "Delete",
            },
            function () {
              socket.emit("board delete", { id: p.id });
              goList();
            },
          );
        }),
      );
      head.appendChild(own);
    }
    post.appendChild(head);

    if (p.title) post.appendChild(el("h2", "sb-post-title", p.title));
    if (isEditing) post.appendChild(editorFor(p, null));
    else {
      var body = el("div", "sb-text" + (p.title ? "" : " sb-text-lead"));
      body.innerHTML = renderRich(p.text);
      post.appendChild(body);
    }

    var foot = el("div", "sb-post-foot");
    foot.appendChild(voteBlock(p, "row"));
    var rc = el("span", "sb-replies-count");
    rc.innerHTML = icon("fa-comment") + " " + plural(p.replyCount || 0, "reply", "replies");
    foot.appendChild(rc);
    post.appendChild(foot);

    if (p.status !== "open") {
      var note = el("div", "sb-status-note");
      note.appendChild(statusPill(p));
      note.appendChild(
        el(
          "span",
          null,
          "Marked by " +
            (p.statusBy || "staff") +
            (p.statusAt ? " · " + timeAgo(p.statusAt) : ""),
        ),
      );
      post.appendChild(note);
    }

    if (board.canModerate) post.appendChild(modBar(p));
    main.appendChild(post);

    var replies = el("section", "sb-replies");
    var rh = el("h3", "sb-replies-head", plural(p.replyCount || 0, "Reply", "Replies"));
    replies.appendChild(rh);
    if (!(p.replies || []).length)
      replies.appendChild(el("p", "sb-replies-empty", "No replies yet. Start the conversation."));
    (p.replies || []).forEach(function (r) {
      replies.appendChild(replyRow(p, r));
    });
    main.appendChild(replies);
    main.appendChild(replyBox(p, focusReply));
  }

  function modBar(p) {
    var kind = kindOf(p);
    var bar = el("div", "sb-mod-bar");
    bar.appendChild(el("span", "sb-mod-label", "Staff"));
    var seg = el("div", "sb-seg");
    STATUS_ORDER.forEach(function (st) {
      var b = button(
        "sb-seg-btn " + STATUS[st].cls + (p.status === st ? " active" : ""),
        icon(STATUS[st].icon) + "<span>" + esc(statusLabel(st, kind)) + "</span>",
        function () {
          if (p.status !== st) socket.emit("board status", { id: p.id, status: st });
        },
      );
      b.setAttribute("aria-pressed", p.status === st ? "true" : "false");
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    if (!p.mine)
      bar.appendChild(
        button("sb-ghost-btn is-danger", icon("fa-trash") + " Remove", function () {
          confirmThen(
            {
              title: "Remove post",
              message: "Remove this post and its replies for everyone?",
              danger: true,
              confirmText: "Remove",
            },
            function () {
              socket.emit("board delete", { id: p.id });
              goList();
            },
          );
        }),
      );
    return bar;
  }

  function replyRow(p, r) {
    var row = el("div", "sb-reply");
    row.appendChild(avatarOf(r.avatar, "md"));
    var body = el("div", "sb-reply-body");
    var meta = el("div", "sb-reply-meta");
    var badge = badgeFor(r.role);
    if (badge) meta.appendChild(badge);
    meta.appendChild(el("span", "sb-name", r.name || "Anonymous"));
    if (r.mine) meta.appendChild(el("span", "sb-you", "you"));
    meta.appendChild(el("span", "sb-time", timeAgo(r.at) + (r.editedAt ? " · edited" : "")));
    var editingReply = editing && editing.id === p.id && editing.replyId === r.id;
    var acts = el("span", "sb-reply-acts");
    if (r.mine && !editingReply)
      acts.appendChild(
        button("sb-link-btn", "Edit", function () {
          editing = { id: p.id, replyId: r.id };
          renderMain();
        }),
      );
    if ((r.mine || board.canModerate) && !editingReply)
      acts.appendChild(
        button("sb-link-btn is-danger", "Delete", function () {
          socket.emit("board delete", { id: p.id, replyId: r.id });
        }),
      );
    if (acts.childNodes.length) meta.appendChild(acts);
    body.appendChild(meta);
    if (editingReply) body.appendChild(editorFor(p, r));
    else {
      var text = el("div", "sb-text sb-reply-text");
      text.innerHTML = renderRich(r.text);
      body.appendChild(text);
    }
    row.appendChild(body);
    return row;
  }

  function replyBox(p, focusReply) {
    var box = el("div", "sb-reply-box");
    box.appendChild(avatarOf(myAvatar(), "md"));
    var form = el("div", "sb-reply-form");
    var ta = el("textarea", "sb-input sb-reply-input");
    ta.rows = 1;
    ta.maxLength = REPLY_MAX;
    ta.placeholder = "Write a reply…";
    ta.value = replyDrafts[p.id] || "";
    ta.setAttribute("aria-label", "Your reply");
    var foot = el("div", "sb-reply-foot");
    var hint = el("span", "sb-hint", "Enter to send · Shift+Enter for a new line");
    var count = el("span", "sb-count", ta.value.length + " / " + REPLY_MAX);
    var send = button("sb-btn sb-btn-primary sb-send-btn", icon("fa-paper-plane") + " Reply", doSend);
    function sync() {
      replyDrafts[p.id] = ta.value;
      count.textContent = ta.value.length + " / " + REPLY_MAX;
      autogrow(ta, 200);
    }
    function doSend() {
      var text = ta.value.trim();
      if (text.length < 2) return toast("Write a little more first.", "error");
      socket.emit("board reply", { id: p.id, text: text });
    }
    ta.addEventListener("input", sync);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    foot.appendChild(hint);
    foot.appendChild(count);
    foot.appendChild(send);
    form.appendChild(ta);
    form.appendChild(foot);
    box.appendChild(form);
    setTimeout(function () {
      autogrow(ta, 200);
      if (focusReply) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
      }
    }, 0);
    return box;
  }

  function editorFor(p, r) {
    var wrap = el("div", "sb-editor");
    var ta = el("textarea", "sb-input");
    ta.maxLength = r ? REPLY_MAX : TEXT_MAX;
    ta.rows = r ? 2 : 4;
    ta.value = (r ? r.text : p.text) || "";
    ta.addEventListener("input", function () {
      autogrow(ta, 320);
    });
    var foot = el("div", "sb-editor-foot");
    foot.appendChild(
      button("sb-btn", "Cancel", function () {
        editing = null;
        renderMain();
      }),
    );
    foot.appendChild(
      button("sb-btn sb-btn-primary", "Save", function () {
        var text = ta.value.trim();
        if (text.length < (r ? 2 : 8)) return toast("Write a little more first.", "error");
        socket.emit("board edit", { id: p.id, replyId: r ? r.id : undefined, text: text });
      }),
    );
    wrap.appendChild(ta);
    wrap.appendChild(foot);
    setTimeout(function () {
      autogrow(ta, 320);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 0);
    return wrap;
  }

  // ── Composer ──────────────────────────────────────────────────────────────

  function saveDraft() {
    lsSet(DRAFT_KEY, draft.title || draft.text ? JSON.stringify(draft) : null);
  }

  function renderCompose() {
    var bar = el("div", "sb-view-bar");
    bar.appendChild(button("sb-back-btn", icon("fa-arrow-left") + " Back", goList, "Back to the list"));
    bar.appendChild(el("h2", "sb-view-title", "New post"));
    main.appendChild(bar);

    var form = el("div", "sb-compose");

    var kindField = el("div", "sb-field");
    kindField.appendChild(el("label", "sb-label", "What is it?"));
    var kinds = el("div", "sb-kind-pick");
    var kindBtns = {};
    Object.keys(KIND).forEach(function (k) {
      var b = button(
        "sb-kind-opt " + KIND[k].cls + (draft.kind === k ? " active" : ""),
        icon(KIND[k].icon) + "<span><b>" + KIND[k].label + "</b>" + KIND[k].blurb + "</span>",
        function () {
          draft.kind = k;
          saveDraft();
          Object.keys(kindBtns).forEach(function (x) {
            kindBtns[x].classList.toggle("active", x === k);
            kindBtns[x].setAttribute("aria-pressed", x === k ? "true" : "false");
          });
          syncPlaceholders();
        },
      );
      b.setAttribute("aria-pressed", draft.kind === k ? "true" : "false");
      kindBtns[k] = b;
      kinds.appendChild(b);
    });
    kindField.appendChild(kinds);
    form.appendChild(kindField);

    var titleField = el("div", "sb-field");
    var titleHead = el("div", "sb-label-row");
    titleHead.appendChild(el("label", "sb-label", "Title"));
    var titleCount = el("span", "sb-count", draft.title.length + " / " + TITLE_MAX);
    titleHead.appendChild(titleCount);
    titleField.appendChild(titleHead);
    var titleInput = el("input", "sb-input sb-title-input");
    titleInput.type = "text";
    titleInput.maxLength = TITLE_MAX;
    titleInput.value = draft.title;
    titleInput.addEventListener("input", function () {
      draft.title = titleInput.value;
      titleCount.textContent = draft.title.length + " / " + TITLE_MAX;
      saveDraft();
    });
    titleField.appendChild(titleInput);
    form.appendChild(titleField);

    var textField = el("div", "sb-field");
    var textHead = el("div", "sb-label-row");
    textHead.appendChild(el("label", "sb-label", "Details"));
    var tabs = el("div", "sb-seg sb-seg-sm");
    var writeTab = button("sb-seg-btn" + (previewMode ? "" : " active"), "Write", function () {
      previewMode = false;
      renderMain();
    });
    var previewTab = button("sb-seg-btn" + (previewMode ? " active" : ""), "Preview", function () {
      previewMode = true;
      renderMain();
    });
    tabs.appendChild(writeTab);
    tabs.appendChild(previewTab);
    textHead.appendChild(tabs);
    textField.appendChild(textHead);

    var textArea = el("textarea", "sb-input sb-compose-text");
    textArea.maxLength = TEXT_MAX;
    textArea.rows = 5;
    textArea.value = draft.text;
    var textCount = el("span", "sb-count", draft.text.length + " / " + TEXT_MAX);

    if (previewMode) {
      var preview = el("div", "sb-preview");
      preview.innerHTML = draft.text.trim()
        ? renderRich(draft.text)
        : "<span class='sb-preview-empty'>Nothing to preview yet.</span>";
      textField.appendChild(preview);
    } else {
      var tools = el("div", "sb-format-bar");
      [
        ["fa-bold", "**", "Bold"],
        ["fa-italic", "*", "Italic"],
        ["fa-strikethrough", "~~", "Strikethrough"],
        ["fa-code", "`", "Code"],
      ].forEach(function (t) {
        var b = button("sb-format-btn", icon(t[0]), function () {
          wrapSelection(textArea, t[1]);
          draft.text = textArea.value;
          textCount.textContent = draft.text.length + " / " + TEXT_MAX;
          saveDraft();
        }, t[2]);
        b.title = t[2];
        tools.appendChild(b);
      });
      tools.appendChild(textCount);
      textField.appendChild(tools);
      textArea.addEventListener("input", function () {
        draft.text = textArea.value;
        textCount.textContent = draft.text.length + " / " + TEXT_MAX;
        autogrow(textArea, 360);
        saveDraft();
      });
      textField.appendChild(textArea);
    }
    var help = el("p", "sb-field-help");
    textField.appendChild(help);
    form.appendChild(textField);

    function syncPlaceholders() {
      var bug = draft.kind === "bug";
      titleInput.placeholder = bug
        ? "Short and specific, e.g. “Chat box jumps to the top”"
        : "Short and specific, e.g. “Add a dark theme”";
      textArea.placeholder = bug
        ? "What did you do, what happened, and what did you expect? Which device or browser?"
        : "What would it do, and why would it help?";
      help.textContent = bug
        ? "Good bug reports say what you did, what happened, and what you expected instead."
        : "Say what it would do and why it would help. Search first: if it is already here, upvote it.";
    }
    syncPlaceholders();

    var foot = el("div", "sb-compose-foot");
    var who = el("div", "sb-posting-as");
    who.appendChild(avatarOf(myAvatar(), "sm"));
    who.appendChild(
      el("span", null, myName() ? "Posting as " + myName() : "Sign in from the lobby to post"),
    );
    foot.appendChild(who);
    var right = el("div", "sb-compose-actions");
    right.appendChild(remainingChip());
    right.appendChild(
      button("sb-btn is-danger", "Discard", function () {
        if (!draft.title && !draft.text) return goList();
        confirmThen(
          {
            title: "Discard this draft",
            message: "Throw away the title and text you have written?",
            danger: true,
            confirmText: "Discard",
          },
          function () {
            draft = { kind: draft.kind, title: "", text: "" };
            saveDraft();
            goList();
          },
        );
      }),
    );
    right.appendChild(
      button("sb-btn sb-btn-primary", icon("fa-paper-plane") + " Post", submitPost),
    );
    foot.appendChild(right);
    form.appendChild(foot);
    main.appendChild(form);

    form.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitPost();
      }
    });
    setTimeout(function () {
      if (!previewMode) autogrow(textArea, 360);
      if (!draft.title) titleInput.focus();
    }, 0);
  }

  function wrapSelection(ta, marker) {
    var s = ta.selectionStart || 0;
    var e = ta.selectionEnd || 0;
    var v = ta.value;
    var sel = v.slice(s, e) || "text";
    ta.value = v.slice(0, s) + marker + sel + marker + v.slice(e);
    ta.focus();
    ta.selectionStart = s + marker.length;
    ta.selectionEnd = s + marker.length + sel.length;
  }

  function submitPost() {
    var title = draft.title.trim();
    var text = draft.text.trim();
    if (title.length < 3) return toast("Add a short title first.", "error");
    if (text.length < 8) return toast("Write a little more in the details (at least 8 letters).", "error");
    socket.emit("board post", { title: title, text: text, kind: draft.kind });
  }

  // ── Lobby: badges on the button, and a note when something happened ──────

  function lastSeen() {
    return Number(lsGet(SEEN_KEY)) || 0;
  }

  function markSeen() {
    lsSet(SEEN_KEY, String(Date.now()));
  }

  var BADGES = [
    { key: "approved", cls: "sb-nb-approved", icon: "fa-check", one: "post approved", many: "posts approved" },
    { key: "declined", cls: "sb-nb-declined", icon: "fa-xmark", one: "post declined", many: "posts declined" },
    { key: "replies", cls: "sb-nb-reply", icon: "fa-comment", one: "new reply", many: "new replies" },
  ];

  function renderBadges(counts) {
    var link = document.getElementById("suggestBoxLink");
    if (!link) return;
    var host = link.querySelector(".sb-notif");
    if (!host) {
      host = el("span", "sb-notif");
      link.appendChild(host);
    }
    host.textContent = "";
    if (!counts) return;
    var words = [];
    BADGES.forEach(function (b) {
      var n = counts[b.key] || 0;
      if (!n) return;
      var pill = el("span", "sb-nb " + b.cls);
      pill.innerHTML = icon(b.icon) + n;
      pill.title = n + " " + (n === 1 ? b.one : b.many);
      host.appendChild(pill);
      words.push(pill.title);
    });
    link.title = words.length ? words.join(", ") : "";
    link.classList.toggle("has-notif", words.length > 0);
  }

  function describeUpdate(i) {
    var what = (KIND[i.kind] || KIND.idea).label.toLowerCase();
    var name = "“" + i.title + "”";
    if (i.decided)
      return (
        "Your " +
        what +
        " " +
        name +
        " was marked " +
        statusLabel(i.status, i.kind) +
        (i.newReplies ? " and has " + plural(i.newReplies, "new reply", "new replies") : "") +
        "."
      );
    return plural(i.newReplies, "new reply", "new replies") + " on your " + what + " " + name + ".";
  }

  // One quiet toast per batch of news, never repeated for the same batch, and
  // never while the board itself is open. Clicking it opens My posts.
  function maybeNotice(counts) {
    if (!counts || !counts.items || !counts.items.length || isOpen || !window.StaffUI) return;
    var key = counts.items
      .map(function (i) {
        return i.id + ":" + i.latest;
      })
      .join(",");
    if (lsGet(NOTICE_KEY) === key) return;
    lsSet(NOTICE_KEY, key);
    var lines = counts.items.slice(0, 2).map(describeUpdate);
    var extra = counts.items.length - 2;
    var msg = lines.join(" ") + (extra > 0 ? " And " + extra + " more." : "") + " Click to open.";
    var t = StaffUI.toast(msg, { type: "info", title: "News on your posts", timeout: 12000 });
    if (!t) return;
    t.classList.add("sb-toast");
    t.addEventListener("click", function (e) {
      if (e.target.closest(".tk-tx")) return;
      var x = t.querySelector(".tk-tx");
      if (x) x.click();
      open("mine");
    });
  }

  function refreshBadges() {
    socket.emit("board badges", { since: lastSeen() });
  }

  socket.on("board badges", function (counts) {
    renderBadges(counts);
    maybeNotice(counts);
  });

  if (socket.connected) refreshBadges();
  socket.on("connect", refreshBadges);

  // ── Open / close ──────────────────────────────────────────────────────────

  function open(startTab) {
    build();
    if (startTab) tab = startTab;
    sessionSince = lastSeen();
    view = { name: "list", id: null };
    isOpen = true;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    socket.emit("board open");
    markSeen();
    renderBadges(null);
    if (board) render();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    editing = null;
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    socket.emit("board close");
    markSeen();
    refreshBadges();
  }

  window.SuggestBoard = { open: open, close: close };
})();
