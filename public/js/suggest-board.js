// public/js/suggest-board.js
// Ideas & Bugs board for the lobby. Loads after lobby-client.js and reuses its
// `socket`. Everyone can post, reply and vote; people can edit and delete their
// own; staff set the status. All text is escaped before the markdown-lite
// formatting is applied, so nothing a user types can become live HTML.
//
// The board carries hundreds of posts, so everything that makes one findable -
// search, the type and status filters, sorting - happens here on the whole list
// the server sends, rather than as a round trip per keystroke.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var board = null; // last "board data" payload from the server
  var sortMode = "top"; // "top" | "new"
  var expanded = {}; // post id -> replies section open
  var editing = null; // { id, replyId } currently being edited, or null
  var query = "";
  var kindFilter = "all"; // "all" | "idea" | "bug"
  var statusFilter = new Set(); // empty = every status
  var mineOnly = false;
  var built = false;
  var isOpen = false;
  var knownIds = null; // post ids already seen, so live-arriving ones can flash

  // ── helpers ───────────────────────────────────────────────────────────────

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

  // Markdown-lite: **bold** *italic* ~~strike~~ `code`. Escaped first, so the
  // only HTML that can appear is what this function itself emits.
  function renderRich(text) {
    var s = esc(text);
    s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n][^*]*?)\*/g, "<em>$1</em>");
    s = s.replace(/~~([^~\n][^~]*?)~~/g, "<s>$1</s>");
    s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  // Everything posted before the board had a title field has none, so one is
  // taken off the front of the body. Without this, 300 old posts would all show
  // a blank heading.
  function titleOf(p) {
    if (p.title) return p.title;
    // The markers come off too: a heading is plain text, so "**dark mode**"
    // would otherwise show its asterisks where the body renders it bold.
    var flat = String(p.text || "")
      .replace(/\s+/g, " ")
      .replace(/\*\*|~~|[*`]/g, "")
      .trim();
    return flat.length > 70 ? flat.slice(0, 70) + "…" : flat || "(no title)";
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

  // Role badges come only from the server-stamped role field, never from the
  // display name, so they cannot be impersonated.
  function badgeFor(role) {
    if (role === "dev") {
      var b = el("span", "sb-badge sb-badge-dev");
      var crown = el("img");
      crown.src = "images/icons/crown.gif";
      crown.alt = "";
      b.appendChild(crown);
      b.appendChild(document.createTextNode("DEV"));
      b.title = "Talkomatic developer";
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

  // Plain words on purpose. Most of the people reading this board are between
  // 10 and 16, and "Open" reads as a verb to them - "New" does not.
  var STATUS_META = {
    open: { label: "New", cls: "sb-st-open", icon: "fa-circle-dot" },
    approved: { label: "Approved", cls: "sb-st-approved", icon: "fa-check" },
    implemented: {
      label: "Built",
      cls: "sb-st-implemented",
      icon: "fa-rocket",
    },
    declined: { label: "Not doing", cls: "sb-st-declined", icon: "fa-xmark" },
  };
  var STATUS_ORDER = ["open", "approved", "implemented", "declined"];

  var KIND_META = {
    idea: { label: "Idea", cls: "sb-kind-idea", icon: "fa-lightbulb" },
    bug: { label: "Bug", cls: "sb-kind-bug", icon: "fa-bug" },
  };

  // ── modal skeleton ────────────────────────────────────────────────────────

  var overlay, listWrap, remainChip, composeArea, composeCount, postBtn;
  var previewWrap, previewBody, countWrap, searchInput, composeWrap;
  var titleInput, kindWrap, composeKind = "idea", helpPanel, filterWrap;

  var SB_ID_RE = /^\d{17,20}$/;
  var SB_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

  function discordPfp(av, small) {
    if (!av || !SB_ID_RE.test(av.id || "") || !SB_HASH_RE.test(av.hash || ""))
      return null;
    var img = el("img", "sb-pfp" + (small ? " sb-pfp-sm" : ""));
    img.alt = "";
    img.src =
      "https://cdn.discordapp.com/avatars/" +
      av.id +
      "/" +
      av.hash +
      ".webp?size=64" +
      (av.animated ? "&animated=true" : "");
    img.onerror = function () {
      img.style.display = "none";
    };
    return img;
  }

  function chipButton(label, active, onClick, extraClass) {
    var b = el(
      "button",
      "sb-chip-btn" + (active ? " active" : "") + (extraClass ? " " + extraClass : ""),
      label,
    );
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "sb-overlay");
    overlay.id = "suggestBoardOverlay";

    var modal = el("div", "sb-modal");

    // ── Header ──
    var head = el("div", "sb-head");
    var titleWrap = el("div", "sb-title-wrap");
    var title = el("div", "sb-title");
    title.innerHTML = '<i class="fas fa-lightbulb"></i> Ideas &amp; Bugs';
    var sub = el(
      "div",
      "sb-sub",
      "Suggest something, report a bug, and vote on what you want next.",
    );
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    var headBtns = el("div", "sb-head-btns");
    var helpBtn = el("button", "sb-icon-btn", "?");
    helpBtn.title = "How does this work?";
    helpBtn.setAttribute("aria-label", "How does this work?");
    helpBtn.addEventListener("click", toggleHelp);
    var closeBtn = el("button", "sb-icon-btn sb-close", "×");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    headBtns.appendChild(helpBtn);
    headBtns.appendChild(closeBtn);

    head.appendChild(titleWrap);
    head.appendChild(headBtns);

    // ── Help panel, hidden until the ? is pressed ──
    helpPanel = el("div", "sb-help");
    helpPanel.style.display = "none";
    helpPanel.innerHTML =
      "<h4>How this board works</h4>" +
      "<ul>" +
      "<li><b>Idea</b> is something you want added or changed. " +
      "<b>Bug</b> is something that is broken.</li>" +
      "<li><b>Vote</b> with the arrows. The more upvotes something has, " +
      "the more likely it gets built.</li>" +
      "<li><b>Search</b> before you post, so you can upvote an idea that is " +
      "already there instead of posting it twice.</li>" +
      "<li>Tags: <b>New</b> means nobody has looked yet. <b>Approved</b> " +
      "means we want to do it. <b>Built</b> means it is done. " +
      "<b>Not doing</b> means we decided against it.</li>" +
      "<li>You can <b>edit</b> or <b>delete</b> your own posts any time.</li>" +
      "<li>You get 3 posts a day, so make them count.</li>" +
      "</ul>";

    // ── Controls: search, then filter rows ──
    var controls = el("div", "sb-controls");

    var searchRow = el("div", "sb-search-row");
    var searchBox = el("div", "sb-search");
    searchBox.innerHTML = '<i class="fas fa-magnifying-glass"></i>';
    searchInput = el("input", "sb-search-input");
    searchInput.type = "search";
    searchInput.placeholder = "Search ideas and bugs…";
    searchInput.addEventListener("input", function () {
      query = searchInput.value.trim().toLowerCase();
      renderList();
    });
    searchBox.appendChild(searchInput);
    var newPostBtn = el("button", "sb-newpost-btn");
    newPostBtn.innerHTML = '<i class="fas fa-plus"></i> New post';
    newPostBtn.addEventListener("click", toggleCompose);
    searchRow.appendChild(searchBox);
    searchRow.appendChild(newPostBtn);

    filterWrap = el("div", "sb-filters");

    controls.appendChild(searchRow);
    controls.appendChild(filterWrap);

    // ── Composer, collapsed until "New post" is pressed ──
    composeWrap = el("div", "sb-compose-wrap");
    composeWrap.style.display = "none";
    var compose = el("div", "sb-compose");

    // Idea / Bug toggle, first thing so the rest reads in context.
    kindWrap = el("div", "sb-kind-toggle");
    var kindLabel = el("span", "sb-field-label", "This is a");
    kindWrap.appendChild(kindLabel);
    ["idea", "bug"].forEach(function (k) {
      var meta = KIND_META[k];
      var b = el("button", "sb-kind-btn sb-kind-" + k);
      b.type = "button";
      b.dataset.kind = k;
      b.innerHTML = '<i class="fas ' + meta.icon + '"></i> ' + meta.label;
      b.addEventListener("click", function () {
        composeKind = k;
        syncKindButtons();
      });
      kindWrap.appendChild(b);
    });

    titleInput = el("input", "sb-input sb-title-input");
    titleInput.type = "text";
    titleInput.maxLength = 80;
    titleInput.placeholder = "Short title, e.g. “Add a dark theme”";

    var toolbar = el("div", "sb-toolbar");
    [
      ["fa-bold", "**", "Bold"],
      ["fa-italic", "*", "Italic"],
      ["fa-strikethrough", "~~", "Strikethrough"],
      ["fa-code", "`", "Code"],
    ].forEach(function (t) {
      var b = el("button", "sb-tool");
      b.innerHTML = '<i class="fas ' + t[0] + '"></i>';
      b.title = t[2];
      b.type = "button";
      b.addEventListener("click", function () {
        wrapSelection(composeArea, t[1]);
      });
      toolbar.appendChild(b);
    });
    remainChip = el("span", "sb-remain", "");
    toolbar.appendChild(remainChip);

    composeArea = el("textarea", "sb-input");
    composeArea.maxLength = 600;
    composeArea.rows = 4;
    composeArea.placeholder =
      "Explain it a bit more. For a bug, say what you did and what happened.";
    composeArea.addEventListener("input", updateCount);

    previewWrap = el("div", "sb-preview-wrap");
    previewWrap.style.display = "none";
    var previewLabel = el("div", "sb-preview-label");
    previewLabel.innerHTML = '<i class="fas fa-eye"></i> Preview';
    previewBody = el("div", "sb-preview");
    previewWrap.appendChild(previewLabel);
    previewWrap.appendChild(previewBody);

    var composeFoot = el("div", "sb-compose-foot");
    composeCount = el("span", "sb-count", "0 / 600");
    var cancelBtn = el("button", "sb-cancel-btn", "Cancel");
    cancelBtn.addEventListener("click", toggleCompose);
    postBtn = el("button", "sb-post-btn");
    postBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
    postBtn.addEventListener("click", submitPost);
    composeFoot.appendChild(composeCount);
    composeFoot.appendChild(cancelBtn);
    composeFoot.appendChild(postBtn);

    compose.appendChild(kindWrap);
    compose.appendChild(titleInput);
    compose.appendChild(toolbar);
    compose.appendChild(composeArea);
    compose.appendChild(previewWrap);
    compose.appendChild(composeFoot);
    composeWrap.appendChild(compose);

    // ── List ──
    countWrap = el("div", "sb-count-line", "");
    listWrap = el("div", "sb-list");

    modal.appendChild(head);
    modal.appendChild(helpPanel);
    modal.appendChild(controls);
    modal.appendChild(composeWrap);
    modal.appendChild(countWrap);
    modal.appendChild(listWrap);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    syncKindButtons();

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) close();
    });

    socket.on("board data", function (data) {
      board = data || null;
      if (isOpen) render();
    });
    socket.on("board result", function (d) {
      if (!d) return;
      if (!d.ok) {
        toast(d.error || "Something went wrong.", "error");
        return;
      }
      if (d.action === "post") {
        composeArea.value = "";
        titleInput.value = "";
        updateCount();
        composeWrap.style.display = "none";
        toast("Posted. Thanks!", "success");
      }
      if (d.action === "edit") {
        editing = null;
        toast("Saved.", "success");
        renderList();
      }
      if (d.action === "delete") toast("Deleted.", "success");
    });
  }

  function syncKindButtons() {
    if (!kindWrap) return;
    kindWrap.querySelectorAll(".sb-kind-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.kind === composeKind);
    });
    if (titleInput)
      titleInput.placeholder =
        composeKind === "bug"
          ? "Short title, e.g. “Chat box scrolls to the top”"
          : "Short title, e.g. “Add a dark theme”";
  }

  function toggleHelp() {
    if (!helpPanel) return;
    helpPanel.style.display = helpPanel.style.display === "none" ? "block" : "none";
  }

  function toggleCompose() {
    if (!composeWrap) return;
    var show = composeWrap.style.display === "none";
    composeWrap.style.display = show ? "block" : "none";
    if (show && titleInput) titleInput.focus();
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
    updateCount();
  }

  function updateCount() {
    composeCount.textContent = composeArea.value.length + " / 600";
    if (composeArea.value.trim()) {
      previewWrap.style.display = "block";
      previewBody.innerHTML = renderRich(composeArea.value);
    } else {
      previewWrap.style.display = "none";
    }
  }

  function submitPost() {
    var text = composeArea.value.trim();
    var title = titleInput.value.trim();
    if (title.length < 3)
      return toast("Please add a short title first.", "error");
    if (text.length < 8)
      return toast("Please write a little more (at least 8 letters).", "error");
    socket.emit("board post", { title: title, text: text, kind: composeKind });
  }

  // ── filters ───────────────────────────────────────────────────────────────

  function renderFilters() {
    if (!filterWrap) return;
    filterWrap.textContent = "";

    var kindRow = el("div", "sb-filter-row");
    kindRow.appendChild(el("span", "sb-filter-label", "Show"));
    [
      ["all", "Everything"],
      ["idea", "Ideas"],
      ["bug", "Bugs"],
    ].forEach(function (k) {
      kindRow.appendChild(
        chipButton(k[1], kindFilter === k[0], function () {
          kindFilter = k[0];
          renderFilters();
          renderList();
        }, k[0] === "bug" ? "sb-chip-bug" : k[0] === "idea" ? "sb-chip-idea" : ""),
      );
    });

    var statusRow = el("div", "sb-filter-row");
    statusRow.appendChild(el("span", "sb-filter-label", "Status"));
    STATUS_ORDER.forEach(function (st) {
      var meta = STATUS_META[st];
      statusRow.appendChild(
        chipButton(meta.label, statusFilter.has(st), function () {
          // Nothing ticked means everything, which is what people expect from
          // a filter row that starts empty.
          if (statusFilter.has(st)) statusFilter.delete(st);
          else statusFilter.add(st);
          renderFilters();
          renderList();
        }, meta.cls),
      );
    });

    var extraRow = el("div", "sb-filter-row");
    extraRow.appendChild(el("span", "sb-filter-label", "Sort"));
    [
      ["top", "Most voted"],
      ["new", "Newest"],
    ].forEach(function (m) {
      extraRow.appendChild(
        chipButton(m[1], sortMode === m[0], function () {
          sortMode = m[0];
          renderFilters();
          renderList();
        }),
      );
    });
    extraRow.appendChild(
      chipButton("My posts", mineOnly, function () {
        mineOnly = !mineOnly;
        renderFilters();
        renderList();
      }, "sb-chip-mine"),
    );

    filterWrap.appendChild(kindRow);
    filterWrap.appendChild(statusRow);
    filterWrap.appendChild(extraRow);
  }

  function visiblePosts() {
    var posts = (board && board.posts ? board.posts : []).slice();
    posts = posts.filter(function (p) {
      if (kindFilter !== "all" && (p.kind || "idea") !== kindFilter) return false;
      if (statusFilter.size && !statusFilter.has(p.status)) return false;
      if (mineOnly && !p.mine) return false;
      if (query) {
        var hay = (
          titleOf(p) +
          " " +
          (p.text || "") +
          " " +
          (p.name || "")
        ).toLowerCase();
        if (hay.indexOf(query) === -1) return false;
      }
      return true;
    });
    if (sortMode === "top")
      posts.sort(function (a, b) {
        return b.up - b.down - (a.up - a.down) || b.at - a.at;
      });
    else
      posts.sort(function (a, b) {
        return b.at - a.at;
      });
    return posts;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!board) return;
    remainChip.textContent =
      board.remaining > 0
        ? board.remaining +
          " post" +
          (board.remaining === 1 ? "" : "s") +
          " left today"
        : "Daily post limit reached";
    remainChip.classList.toggle("sb-remain-empty", board.remaining === 0);
    postBtn.disabled = board.remaining === 0;
    renderFilters();
    renderList();
  }

  function renderList() {
    if (!listWrap) return;
    // Live updates re-render the whole list; keep the reader's place, any
    // half-typed reply, and its focus, so an arriving post never disrupts.
    var scrollTop = listWrap.scrollTop;
    var drafts = {};
    var focusPid = null;
    listWrap.querySelectorAll(".sb-reply-input input").forEach(function (inp) {
      if (inp.value) drafts[inp.dataset.pid] = inp.value;
      if (document.activeElement === inp) focusPid = inp.dataset.pid;
    });

    listWrap.textContent = "";
    var posts = visiblePosts();
    var total = (board && board.posts ? board.posts : []).length;

    if (countWrap)
      countWrap.textContent =
        posts.length === total
          ? total + (total === 1 ? " post" : " posts")
          : "Showing " + posts.length + " of " + total;

    if (!posts.length) {
      var empty = el("div", "sb-empty");
      empty.innerHTML = total
        ? '<i class="fas fa-magnifying-glass"></i><p>Nothing matches that. ' +
          "Try clearing a filter or searching for something else.</p>"
        : '<i class="fas fa-lightbulb"></i><p>Nothing here yet. Be the first!</p>';
      listWrap.appendChild(empty);
      return;
    }

    posts.forEach(function (p) {
      var card = cardFor(p);
      if (knownIds && !knownIds.has(p.id)) card.classList.add("sb-fresh");
      listWrap.appendChild(card);
    });
    knownIds = new Set(
      ((board && board.posts) || []).map(function (p) {
        return p.id;
      }),
    );

    listWrap.querySelectorAll(".sb-reply-input input").forEach(function (inp) {
      if (drafts[inp.dataset.pid]) inp.value = drafts[inp.dataset.pid];
      if (focusPid && inp.dataset.pid === focusPid) {
        inp.focus();
        inp.selectionStart = inp.selectionEnd = inp.value.length;
      }
    });
    listWrap.scrollTop = scrollTop;
  }

  // An inline editor, used for both a post and a reply.
  function editorFor(p, r) {
    var wrap = el("div", "sb-editor");
    var ta = el("textarea", "sb-input");
    ta.maxLength = r ? 300 : 600;
    ta.rows = r ? 2 : 4;
    ta.value = (r ? r.text : p.text) || "";
    var foot = el("div", "sb-editor-foot");
    var cancel = el("button", "sb-cancel-btn", "Cancel");
    cancel.addEventListener("click", function () {
      editing = null;
      renderList();
    });
    var save = el("button", "sb-post-btn", "Save");
    save.addEventListener("click", function () {
      var text = ta.value.trim();
      if (text.length < (r ? 2 : 8))
        return toast("Please write a little more.", "error");
      socket.emit("board edit", {
        id: p.id,
        replyId: r ? r.id : undefined,
        text: text,
      });
    });
    foot.appendChild(cancel);
    foot.appendChild(save);
    wrap.appendChild(ta);
    wrap.appendChild(foot);
    setTimeout(function () {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }, 0);
    return wrap;
  }

  function confirmThen(opts, go) {
    if (window.StaffUI)
      StaffUI.confirm(opts).then(function (ok) {
        if (ok) go();
      });
    else if (window.confirm(opts.message)) go();
  }

  function cardFor(p) {
    var card = el(
      "div",
      "sb-card" + (p.status !== "open" ? " sb-" + p.status : ""),
    );

    // Vote column
    var votes = el("div", "sb-votes");
    var upBtn = el(
      "button",
      "sb-vote-btn" + (p.myVote === 1 ? " active-up" : ""),
    );
    upBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
    upBtn.title = "Upvote";
    upBtn.addEventListener("click", function () {
      socket.emit("board vote", { id: p.id, dir: p.myVote === 1 ? 0 : 1 });
    });
    var score = el("div", "sb-score", String(p.up - p.down));
    score.title = p.up + " up / " + p.down + " down";
    if (p.up - p.down > 0) score.classList.add("pos");
    if (p.up - p.down < 0) score.classList.add("neg");
    var downBtn = el(
      "button",
      "sb-vote-btn" + (p.myVote === -1 ? " active-down" : ""),
    );
    downBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
    downBtn.title = "Downvote";
    downBtn.addEventListener("click", function () {
      socket.emit("board vote", { id: p.id, dir: p.myVote === -1 ? 0 : -1 });
    });
    votes.appendChild(upBtn);
    votes.appendChild(score);
    votes.appendChild(downBtn);

    // Main column
    var main = el("div", "sb-main");

    // Title line: what makes a list of 300 skimmable.
    var titleRow = el("div", "sb-card-title-row");
    var km = KIND_META[p.kind || "idea"];
    var kindChip = el("span", "sb-kind " + km.cls);
    kindChip.innerHTML = '<i class="fas ' + km.icon + '"></i> ' + km.label;
    titleRow.appendChild(kindChip);
    titleRow.appendChild(el("span", "sb-card-title", titleOf(p)));
    var st = STATUS_META[p.status];
    if (st) {
      var chip = el("span", "sb-status " + st.cls);
      chip.innerHTML = '<i class="fas ' + st.icon + '"></i> ' + st.label;
      if (p.statusBy) chip.title = "Set by " + p.statusBy;
      titleRow.appendChild(chip);
    }

    var meta = el("div", "sb-meta");
    var pfp = discordPfp(p.avatar);
    if (pfp) meta.appendChild(pfp);
    var badge = badgeFor(p.role);
    if (badge) meta.appendChild(badge);
    meta.appendChild(el("span", "sb-name", p.name || "Anonymous"));
    if (p.mine) meta.appendChild(el("span", "sb-mine", "you"));
    meta.appendChild(el("span", "sb-time", timeAgo(p.at)));
    if (p.editedAt) {
      var ed = el("span", "sb-time", "edited");
      ed.title = "Edited " + timeAgo(p.editedAt);
      meta.appendChild(ed);
    }

    main.appendChild(titleRow);
    main.appendChild(meta);

    var isEditing = editing && editing.id === p.id && !editing.replyId;
    if (isEditing) {
      main.appendChild(editorFor(p, null));
    } else {
      // Old posts have no separate title, so the body would repeat what the
      // heading already says. Show it only when it adds something.
      if (p.title || String(p.text || "").replace(/\s+/g, " ").trim().length > 70) {
        var body = el("div", "sb-text");
        body.innerHTML = renderRich(p.text);
        main.appendChild(body);
      }
    }

    var foot = el("div", "sb-foot");
    var replyToggle = el(
      "button",
      "sb-link",
      p.replyCount
        ? p.replyCount + " " + (p.replyCount === 1 ? "reply" : "replies")
        : "Reply",
    );
    replyToggle.addEventListener("click", function () {
      expanded[p.id] = !expanded[p.id];
      renderList();
    });
    foot.appendChild(replyToggle);

    // Your own post: edit and delete, whoever you are.
    if (p.mine && !isEditing) {
      var mineCtl = el("span", "sb-own-controls");
      var edit = el("button", "sb-link", "Edit");
      edit.addEventListener("click", function () {
        editing = { id: p.id };
        renderList();
      });
      var del = el("button", "sb-link sb-danger", "Delete");
      del.addEventListener("click", function () {
        confirmThen(
          {
            title: "Delete your post",
            message: "Remove this post and its replies? This cannot be undone.",
            danger: true,
            confirmText: "Delete",
          },
          function () {
            socket.emit("board delete", { id: p.id });
          },
        );
      });
      mineCtl.appendChild(edit);
      mineCtl.appendChild(del);
      foot.appendChild(mineCtl);
    }

    // Staff: set the status, and remove anything.
    if (board.canModerate) {
      var ctl = el("span", "sb-dev-controls");
      STATUS_ORDER.forEach(function (s) {
        if (p.status === s) return;
        var label =
          s === "open" ? "Reopen" : STATUS_META[s].label;
        var b = el("button", "sb-link sb-dev-link", label);
        b.title = "Mark as " + STATUS_META[s].label;
        b.addEventListener("click", function () {
          socket.emit("board status", { id: p.id, status: s });
        });
        ctl.appendChild(b);
      });
      if (!p.mine) {
        var sdel = el("button", "sb-link sb-dev-link sb-danger", "Remove");
        sdel.addEventListener("click", function () {
          confirmThen(
            {
              title: "Remove post",
              message: "Remove this post and its replies for everyone?",
              danger: true,
              confirmText: "Remove",
            },
            function () {
              socket.emit("board delete", { id: p.id });
            },
          );
        });
        ctl.appendChild(sdel);
      }
      foot.appendChild(ctl);
    }

    main.appendChild(foot);

    if (expanded[p.id]) main.appendChild(repliesFor(p));

    card.appendChild(votes);
    card.appendChild(main);
    return card;
  }

  function repliesFor(p) {
    var wrap = el("div", "sb-replies");
    (p.replies || []).forEach(function (r) {
      var row = el("div", "sb-reply");
      var meta = el("div", "sb-meta");
      var rpfp = discordPfp(r.avatar, true);
      if (rpfp) meta.appendChild(rpfp);
      var badge = badgeFor(r.role);
      if (badge) meta.appendChild(badge);
      meta.appendChild(el("span", "sb-name", r.name || "Anonymous"));
      if (r.mine) meta.appendChild(el("span", "sb-mine", "you"));
      meta.appendChild(el("span", "sb-time", timeAgo(r.at)));
      if (r.editedAt) meta.appendChild(el("span", "sb-time", "edited"));

      var editingReply =
        editing && editing.id === p.id && editing.replyId === r.id;

      if (r.mine && !editingReply) {
        var re = el("button", "sb-link sb-reply-act", "Edit");
        re.addEventListener("click", function () {
          editing = { id: p.id, replyId: r.id };
          renderList();
        });
        meta.appendChild(re);
      }
      if (r.mine || board.canModerate) {
        var del = el("button", "sb-link sb-reply-act sb-danger", "Delete");
        del.title = "Delete reply";
        del.addEventListener("click", function () {
          socket.emit("board delete", { id: p.id, replyId: r.id });
        });
        meta.appendChild(del);
      }

      row.appendChild(meta);
      if (editingReply) {
        row.appendChild(editorFor(p, r));
      } else {
        var body = el("div", "sb-text sb-reply-text");
        body.innerHTML = renderRich(r.text);
        row.appendChild(body);
      }
      wrap.appendChild(row);
    });

    var inputRow = el("div", "sb-reply-input");
    var input = el("input", "sb-input sb-input-sm");
    input.type = "text";
    input.maxLength = 300;
    input.dataset.pid = String(p.id);
    input.placeholder = "Write a reply…";
    var send = el("button", "sb-reply-send");
    send.innerHTML = '<i class="fas fa-paper-plane"></i>';
    send.title = "Send reply";
    var doSend = function () {
      var text = input.value.trim();
      if (text.length < 2) return;
      socket.emit("board reply", { id: p.id, text: text });
      input.value = "";
    };
    send.addEventListener("click", doSend);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSend();
    });
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    wrap.appendChild(inputRow);
    return wrap;
  }

  // ── open / close ──────────────────────────────────────────────────────────

  function open() {
    build();
    isOpen = true;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    socket.emit("board open");
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    editing = null;
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    socket.emit("board close");
  }

  window.SuggestBoard = { open: open, close: close };
})();
