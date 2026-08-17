// public/js/games-client.js
// Mini games panel.

(function () {
  const S = window.socket;
  if (!S) return;

  const el = (t, p, c) =>
    window.StaffUI ? window.StaffUI.el(t, p, c) : basicEl(t, p, c);

  function basicEl(tag, props, children) {
    const e = document.createElement(tag);
    if (props)
      for (const k in props) {
        if (k === "class") e.className = props[k];
        else if (k === "text") e.textContent = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function")
          e.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else if (props[k] != null) e.setAttribute(k, props[k]);
      }
    if (children)
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    return e;
  }

  function masked(text) {
    const f = window.TalkomaticFilter;
    if (!f || !f.apply) return String(text == null ? "" : text);
    return f.apply(text);
  }

  function toast(msg, type) {
    if (window.StaffUI) window.StaffUI.toast(msg, { type: type || "info" });
    else if (window.toastr)
      window.toastr[type === "error" ? "error" : "info"](msg);
  }

  const DRAW_COLORS = [
    "#1b1b1b", "#e53935", "#fb8c00", "#fdd835",
    "#43a047", "#1e88e5", "#8e24aa", "#6d4c41",
  ];
  const BRUSHES = [3, 8, 18];

  const ID_RE = /^[0-9]{5,25}$/;
  const HASH_RE = /^[a-f0-9_]{8,64}$/i;

  function iconNode(icon, cls) {
    const wrap = el("span", { class: cls || "gm-icon" });
    if (!icon) return wrap;
    if (icon.image) {
      const img = el("img", { alt: "" });
      img.src = icon.image;
      img.onerror = () => img.remove();
      wrap.appendChild(img);
    } else if (icon.fa) {
      wrap.appendChild(el("i", { class: icon.fa }));
    } else {
      wrap.appendChild(document.createTextNode(icon.emoji || "🎲"));
    }
    return wrap;
  }

  function badgeFor(role) {
    if (role === "dev") {
      const b = el("span", { class: "gm-staff gm-staff-dev", title: "Talkomatic developer" });
      const crown = el("img", { alt: "" });
      crown.src = "images/icons/crown.gif";
      crown.onerror = () => crown.remove();
      b.appendChild(crown);
      b.appendChild(document.createTextNode("DEV"));
      return b;
    }
    if (role === "mod")
      return el("span", { class: "gm-staff gm-staff-mod", title: "Moderator", text: "MOD" });
    if (role === "jr")
      return el("span", { class: "gm-staff gm-staff-jr", title: "Junior moderator", text: "JR MOD" });
    return null;
  }

  function avatarNode(av, small) {
    if (!av || !ID_RE.test(av.id || "") || !HASH_RE.test(av.hash || "")) return null;
    const img = el("img", { class: "gm-pfp" + (small ? " gm-pfp-sm" : ""), alt: "" });
    img.src =
      "https://cdn.discordapp.com/avatars/" + av.id + "/" + av.hash +
      ".webp?size=64" + (av.animated ? "&animated=true" : "");
    img.onerror = () => img.remove();
    return img;
  }

  function loadingNode(text, sub) {
    const box = el("div", { class: "gm-loading" });
    box.appendChild(el("div", { class: "gm-spinner" }));
    box.appendChild(el("div", { class: "gm-loading-text", text: text || "Loading" }));
    if (sub) box.appendChild(el("div", { class: "gm-loading-sub", text: sub }));
    return box;
  }

  let overlay = null;
  let bodyEl = null;
  let stripEl = null;
  let statsEl = null;
  let isOpen = false;

  let catalog = [];
  let floor = {
    tables: [], counts: {}, pools: {}, myQueue: {}, myTables: {}, myNext: [],
  };
  let view = { name: "floor", tableId: null };
  let detail = null;
  let roomUsers = [];
  let board = null;
  let boardKey = "";
  let side = null;
  let clockTimer = null;
  let cleanupSolo = null;
  let earlyRelays = [];
  let pendingJoin = null;

  let chatOpen = readChatPref();
  let unread = 0;

  function readChatPref() {
    let saved = null;
    try {
      saved = localStorage.getItem("tk-games-chat");
    } catch (e) {
      saved = null;
    }
    if (saved === "0") return false;
    if (saved === "1") return true;
    return window.innerWidth > 720;
  }
  function setChatOpen(on) {
    chatOpen = !!on;
    if (chatOpen) unread = 0;
    try {
      localStorage.setItem("tk-games-chat", chatOpen ? "1" : "0");
    } catch (e) {
    }
    applyChat();
  }
  function applyChat() {
    if (!overlay) return;
    const split = overlay.querySelector(".gm-split");
    if (split) split.classList.toggle("gm-nochat", !chatOpen);
    const btn = overlay.querySelector("#gmChatToggle");
    if (!btn) return;
    btn.classList.toggle("gm-btn-primary", !chatOpen && unread > 0);
    btn.title = chatOpen ? "Hide the chat" : "Show the chat";
    btn.textContent = "";
    btn.appendChild(el("i", { class: "fas fa-comments" }));
    btn.appendChild(
      el("span", { class: "gm-chat-toggle-label", text: chatOpen ? "Hide chat" : "Chat" }),
    );
    if (!chatOpen && unread)
      btn.appendChild(
        el("span", { class: "gm-chat-unread", text: unread > 9 ? "9+" : String(unread) }),
      );
  }

  function myId() {
    return typeof currentUserId !== "undefined" ? currentUserId : "";
  }
  function gameById(id) {
    return catalog.find((g) => g.id === id) || null;
  }
  function nameOf(id) {
    const g = gameById(id);
    return g ? g.name : id;
  }

  // ── Shell ─────────────────────────────────────────────────────────────────

  function build() {
    overlay = el("div", { class: "gm-overlay", id: "gamesOverlay" });

    const head = el("div", { class: "gm-head" });
    const titleWrap = el("div", { class: "gm-title-wrap" });
    titleWrap.appendChild(
      el("div", { class: "gm-title" }, [
        el("i", { class: "fas fa-gamepad" }),
        "Mini Games",
      ]),
    );
    titleWrap.appendChild(
      el("div", {
        class: "gm-sub",
        text: "Play with the room. Watch, chat, and jump in when there is space.",
      }),
    );

    statsEl = el("div", { class: "gm-stats" });
    head.appendChild(titleWrap);
    head.appendChild(statsEl);
    head.appendChild(
      el("button", {
        class: "gm-close",
        "aria-label": "Close mini games",
        onclick: closePanel,
        text: "×",
      }),
    );

    stripEl = el("div", { class: "gm-strip", text: "Choose a game" });
    bodyEl = el("div", { class: "gm-body" });

    overlay.appendChild(el("div", { class: "gm-modal" }, [head, stripEl, bodyEl]));
    document.body.appendChild(overlay);
  }

  function openPanel() {
    if (!overlay) build();
    isOpen = true;
    overlay.classList.add("show");
    S.emit("games open");
    startClock();
    render();
  }

  function closePanel() {
    for (const tableId of Object.values(floor.myTables || {}))
      S.emit("games leave", { tableId });
    for (const type of Object.keys(floor.myQueue || {}))
      S.emit("games queue leave", { type });
    for (const tableId of floor.myNext || [])
      S.emit("games play next", { tableId, on: false });
    if (detail && detail.spectating)
      S.emit("games spectate", { tableId: detail.id, on: false });
    isOpen = false;
    pendingJoin = null;
    if (overlay) overlay.classList.remove("show");
    stopClock();
    view = { name: "floor", tableId: null };
    detail = null;
    teardownGameView();
  }

  function teardownGameView() {
    earlyRelays = [];
    if (cleanupSolo) {
      cleanupSolo();
      cleanupSolo = null;
    }
    if (board && board.destroy) board.destroy();
    board = null;
    boardKey = "";
    if (side && side.destroy) side.destroy();
    side = null;
  }

  function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
      if (isOpen) paintClocks();
    }, 250);
  }
  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }

  function secsLeft(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }

  function paintClocks() {
    if (!overlay) return;
    overlay.querySelectorAll("[data-deadline]").forEach((n) => {
      const left = secsLeft(Number(n.dataset.deadline));
      if (left === null) return;
      n.textContent = n.dataset.prefix
        ? n.dataset.prefix + " " + left + "s"
        : left + "s";
      n.classList.toggle("gm-urgent", left <= 5);
    });
    overlay.querySelectorAll("[data-bar-end]").forEach((n) => {
      const end = Number(n.dataset.barEnd);
      if (!end) return;
      const span = Number(n.dataset.barSpan) || 1;
      const pct = Math.max(0, Math.min(100, ((end - Date.now()) / span) * 100));
      n.style.width = pct + "%";
      n.classList.toggle("gm-bar-low", pct < 20);
    });
    if (board && board.clock) board.clock();
  }

  function render() {
    if (!isOpen || !bodyEl) return;
    if (view.name === "solo") return;
    if (view.name === "game" && detail && detail.id === view.tableId)
      renderGame();
    else renderFloor();
    paintClocks();
  }

  // ── Floor ─────────────────────────────────────────────────────────────────

  function renderStats() {
    statsEl.textContent = "";
    let playing = 0;
    let waiting = 0;
    Object.keys(floor.counts || {}).forEach((k) => {
      playing += floor.counts[k].playing || 0;
      waiting += floor.counts[k].waiting || 0;
    });
    const live = floor.tables.filter((t) => t.state === "playing").length;
    statsEl.appendChild(
      el("span", { class: "gm-chip gm-chip-live" }, [
        el("i", { class: "fas fa-circle-play" }),
        live + (live === 1 ? " game on" : " games on"),
      ]),
    );
    statsEl.appendChild(
      el("span", { class: "gm-chip" }, [
        el("i", { class: "fas fa-users" }),
        playing + " playing",
      ]),
    );
    if (waiting)
      statsEl.appendChild(
        el("span", { class: "gm-chip gm-chip-queue" }, [
          el("i", { class: "fas fa-user-clock" }),
          waiting + " up next",
        ]),
      );
  }

  function renderFloor() {
    teardownGameView();
    renderStats();
    stripEl.textContent = "Choose a game";
    bodyEl.textContent = "";
    bodyEl.className = "gm-body";

    const grid = el("div", { class: "gm-games" });
    catalog.filter((g) => !g.external).forEach((g) => grid.appendChild(gameCard(g)));
    bodyEl.appendChild(grid);

    const solos = catalog.filter((g) => g.external);
    if (solos.length) {
      bodyEl.appendChild(section("fa-user", "Play on your own"));
      const sgrid = el("div", { class: "gm-games" });
      solos.forEach((g) => sgrid.appendChild(soloCard(g)));
      bodyEl.appendChild(sgrid);
    }

    const boards = floor.tables.slice().sort((a, b) => {
      const mineA = a.seats.some((s) => s.userId === myId()) ? 0 : 1;
      const mineB = b.seats.some((s) => s.userId === myId()) ? 0 : 1;
      if (mineA !== mineB) return mineA - mineB;
      if ((a.state === "playing") !== (b.state === "playing"))
        return a.state === "playing" ? -1 : 1;
      return 0;
    });

    if (boards.length) {
      bodyEl.appendChild(
        section("fa-circle-play", "Games in this room", boards.length + ""),
      );
      const list = el("div", { class: "gm-rows" });
      boards.forEach((t) => list.appendChild(gameRow(t)));
      bodyEl.appendChild(list);
    }
  }

  function section(icon, label, badge) {
    const s = el("div", { class: "gm-section" }, [
      el("i", { class: "fas " + icon }),
      label,
    ]);
    if (badge) s.appendChild(el("span", { class: "gm-section-badge", text: badge }));
    return s;
  }

  function soloCard(g) {
    const card = el("div", { class: "gm-card gm-card-solo" });

    const top = el("div", { class: "gm-card-top" });
    top.appendChild(iconNode(g.icon, "gm-card-icon"));
    const text = el("div", { class: "gm-card-text" });
    const nameRow = el("div", { class: "gm-card-name" }, g.name);
    if (g.howTo && g.howTo.length)
      nameRow.appendChild(
        el("button", {
          class: "gm-help",
          title: "How to play",
          "aria-label": "How to play " + g.name,
          onclick: (e) => { e.stopPropagation(); showHowTo(g); },
        }, el("i", { class: "fas fa-circle-question" })),
      );
    text.appendChild(nameRow);
    text.appendChild(el("div", { class: "gm-card-blurb", text: g.blurb }));
    top.appendChild(text);
    card.appendChild(top);

    const mid = el("div", { class: "gm-card-mid" });
    mid.appendChild(
      el("button", { class: "gm-btn gm-btn-primary", text: "Play", onclick: () => openSolo(g) }),
    );
    mid.appendChild(
      el("div", { class: "gm-card-who" }, [
        el("span", { class: "gm-dot" }),
        el("span", { text: "Play on your own, any time" }),
      ]),
    );
    card.appendChild(mid);

    const foot = el("div", { class: "gm-card-foot" });
    foot.appendChild(
      el("div", { class: "gm-card-tags" }, el("span", { class: "gm-tag", text: "Solo" })),
    );
    foot.appendChild(
      el("button", {
        class: "gm-btn gm-btn-ghost gm-card-invite",
        text: "Open in a tab",
        onclick: () => window.open(g.url, "_blank", "noopener,noreferrer"),
      }),
    );
    card.appendChild(foot);
    return card;
  }

  function showHowTo(g) {
    const body = el("div", { class: "gm-howto" });
    (g.howTo || []).forEach((line, i) => {
      body.appendChild(
        el("div", { class: "gm-howto-step" }, [
          el("span", { class: "gm-howto-n", text: String(i + 1) }),
          el("span", { text: line }),
        ]),
      );
    });
    if (window.StaffUI && window.StaffUI.modal)
      window.StaffUI.modal({
        title: "How to play " + g.name,
        icon: '<i class="fas fa-circle-question"></i>',
        body,
        actions: [{ label: "Got it", kind: "primary" }],
      });
  }

  function openSolo(g) {
    teardownGameView();
    view = { name: "solo", tableId: null };
    stripEl.textContent = g.name;
    bodyEl.textContent = "";
    bodyEl.className = "gm-body gm-body-solo";

    const bar = el("div", { class: "gm-gamebar" });
    bar.appendChild(
      el("button", { class: "gm-btn gm-btn-ghost gm-back", onclick: backToFloor }, [
        el("i", { class: "fas fa-chevron-left" }),
        " Games",
      ]),
    );
    bar.appendChild(el("div", { class: "gm-turnline", text: g.blurb }));
    const acts = el("div", { class: "gm-gameacts" });
    if (g.howTo && g.howTo.length)
      acts.appendChild(
        el("button", { class: "gm-btn", text: "How to play", onclick: () => showHowTo(g) }),
      );
    acts.appendChild(
      el("button", {
        class: "gm-btn",
        text: "Open in a tab",
        onclick: () => window.open(g.url, "_blank", "noopener,noreferrer"),
      }),
    );
    bar.appendChild(acts);
    bodyEl.appendChild(bar);

    const frame = el("iframe", {
      class: "gm-solo-frame",
      title: g.name,
      src: g.url,
      allow: "autoplay",
    });
    const loading = loadingNode("Loading " + g.name);
    const wrap = el("div", { class: "gm-solo-wrap" }, [loading, frame]);
    frame.classList.add("gm-hidden");
    let done = false;
    const ready = () => {
      if (done) return;
      done = true;
      if (cleanupSolo) cleanupSolo();
      loading.remove();
      frame.classList.remove("gm-hidden");
    };
    frame.addEventListener("load", ready);
    const poll = setInterval(() => {
      if (done) return clearInterval(poll);
      try {
        if (frame.contentDocument && frame.contentDocument.readyState === "complete")
          ready();
      } catch (_) {}
    }, 150);
    const slow = setTimeout(() => {
      if (done) return;
      const sub = loading.querySelector(".gm-loading-sub");
      const msg = "Fetching this game's pictures and sounds.";
      if (sub) sub.textContent = msg;
      else loading.appendChild(el("div", { class: "gm-loading-sub", text: msg }));
    }, 2500);
    const bail = setTimeout(ready, 15000);
    cleanupSolo = () => {
      clearInterval(poll);
      clearTimeout(slow);
      clearTimeout(bail);
    };
    bodyEl.appendChild(wrap);
  }

  function gameCard(g) {
    const c = (floor.counts && floor.counts[g.id]) || {
      playing: 0, waiting: 0, live: 0, names: [],
    };
    const myPos = floor.myQueue[g.id] || 0;
    const myGame = floor.myTables[g.id] || null;

    const card = el("div", {
      class: "gm-card" + (myGame ? " gm-card-mine" : ""),
    });

    const top = el("div", { class: "gm-card-top" });
    top.appendChild(iconNode(g.icon, "gm-card-icon"));
    const text = el("div", { class: "gm-card-text" });
    const nameRow = el("div", { class: "gm-card-name" }, g.name);
    if (g.howTo && g.howTo.length)
      nameRow.appendChild(
        el("button", {
          class: "gm-help",
          "aria-label": "How to play " + g.name,
          title: "How to play",
          onclick: (e) => {
            e.stopPropagation();
            showHowTo(g);
          },
        }, el("i", { class: "fas fa-circle-question" })),
      );
    text.appendChild(nameRow);
    text.appendChild(el("div", { class: "gm-card-blurb", text: g.blurb }));
    top.appendChild(text);
    card.appendChild(top);

    const mid = el("div", { class: "gm-card-mid" });
    if (myGame) {
      mid.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Back to your game",
          onclick: () => openGame(myGame),
        }),
      );
    } else if (myPos) {
      mid.appendChild(
        el("button", {
          class: "gm-btn",
          text: "Leave the line",
          onclick: () => S.emit("games queue leave", { type: g.id }),
        }),
      );
    } else {
      mid.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: c.playing ? "Join in" : "Start a game",
          onclick: () => {
            pendingJoin = g.id;
            S.emit("games queue join", { type: g.id });
          },
        }),
      );
    }

    const line = el("div", { class: "gm-card-who" });
    if (myPos) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-wait" }));
      line.appendChild(
        el("b", {
          text: myPos === 1 ? "You are next up" : "You are #" + myPos + " in line",
        }),
      );
    } else if (c.playing) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-live" }));
      line.appendChild(
        el("b", {
          text: c.playing + (c.playing === 1 ? " playing" : " playing"),
        }),
      );
      if (c.names.length)
        line.appendChild(
          el("span", {
            class: "gm-card-names",
            text:
              c.names.slice(0, 2).join(", ") +
              (c.playing > 2 ? " +" + (c.playing - 2) : ""),
          }),
        );
    } else if (c.waiting) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-wait" }));
      line.appendChild(el("b", { text: c.waiting + " waiting to start" }));
    } else {
      line.appendChild(el("span", { class: "gm-dot" }));
      line.appendChild(el("span", { text: "Nobody playing yet" }));
    }
    mid.appendChild(line);
    card.appendChild(mid);

    const foot = el("div", { class: "gm-card-foot" });
    const tags = el("div", { class: "gm-card-tags" });
    tags.appendChild(
      el("span", {
        class: "gm-tag",
        text:
          g.minPlayers === g.maxPlayers
            ? g.minPlayers + " players"
            : "2 to " + g.maxPlayers + " players",
      }),
    );
    tags.appendChild(
      el("span", {
        class: "gm-tag",
        text: g.winnerStays ? "Winner plays on" : "Everyone at once",
      }),
    );
    foot.appendChild(tags);
    if (g.maxPlayers === 2 && g.minPlayers === 2 && !myGame)
      foot.appendChild(
        el("button", {
          class: "gm-btn gm-btn-ghost gm-card-invite",
          text: "Invite someone",
          onclick: () => showChallengePicker(g),
        }),
      );
    card.appendChild(foot);
    return card;
  }

  function gameRow(t) {
    const g = gameById(t.type);
    const seated = t.seats.some((s) => s.userId === myId());
    const row = el("div", {
      class: "gm-row gm-row-" + t.state + (seated ? " gm-row-mine" : ""),
    });
    row.appendChild(iconNode(g && g.icon, "gm-row-icon"));

    const mid = el("div", { class: "gm-row-mid" });
    const title = el("div", { class: "gm-row-title" });
    title.appendChild(el("b", { text: g ? g.name : t.type }));
    if (t.state === "playing")
      title.appendChild(el("span", { class: "gm-live", text: "LIVE" }));
    if (seated) title.appendChild(el("span", { class: "gm-yours", text: "YOURS" }));
    mid.appendChild(title);

    const who = t.seats.map((s) => s.username);
    let line;
    if (!who.length) line = "Waiting for a player";
    else if (t.reservedFor)
      line = who[0] + " invited " + t.reservedFor.username;
    else if (t.state === "playing")
      line = g && g.maxPlayers === 2 ? who.join(" vs ") : who.join(", ");
    else if (who.length === 1) line = who[0] + " is waiting for someone to join";
    else line = who.join(", ") + " are waiting to start";
    mid.appendChild(el("div", { class: "gm-row-who", text: line }));

    const meta = el("div", { class: "gm-row-meta" });
    if (t.state === "open" && t.openDeadline)
      meta.appendChild(
        el("span", {
          class: "gm-count",
          "data-deadline": String(t.openDeadline),
          "data-prefix": "starts in",
        }),
      );
    if (t.streak && t.streak.n > 1)
      meta.appendChild(
        el("span", {
          class: "gm-streak",
          text: "🔥 " + t.streak.username + " has won " + t.streak.n + " in a row",
        }),
      );
    if (t.spectators)
      meta.appendChild(
        el("span", {
          text:
            t.spectators + (t.spectators === 1 ? " watching" : " watching"),
        }),
      );
    if (meta.childNodes.length) mid.appendChild(meta);
    row.appendChild(mid);

    const acts = el("div", { class: "gm-row-acts" });
    if (seated) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Open",
          onclick: () => openGame(t.id),
        }),
      );
    } else if (t.canJoin) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: t.state === "playing" ? "Join in" : "Play",
          onclick: () => S.emit("games join table", { tableId: t.id }),
        }),
      );
    }
    if (!seated) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-ghost",
          text: "Watch",
          onclick: () => {
            S.emit("games spectate", { tableId: t.id, on: true });
            openGame(t.id);
          },
        }),
      );
    }
    row.appendChild(acts);
    return row;
  }

  function showChallengePicker(g) {
    const others = roomUsers.filter((u) => u.id !== myId());
    if (!others.length) return toast("Nobody else is in the room yet.", "info");
    const list = el("div", { class: "gm-picker" });
    let handle = null;
    others.forEach((u) => {
      list.appendChild(
        el("button", {
          class: "gm-picker-btn",
          text: u.username,
          onclick: () => {
            S.emit("games challenge", { targetUserId: u.id, type: g.id });
            if (handle && handle.close) handle.close();
          },
        }),
      );
    });
    if (window.StaffUI && window.StaffUI.modal) {
      handle = window.StaffUI.modal({
        title: "Who do you want to play " + g.name + " with?",
        body: list,
        actions: [{ label: "Cancel" }],
      });
    } else bodyEl.appendChild(list);
  }

  // ── Game view ─────────────────────────────────────────────────────────────

  function openGame(tableId) {
    view = { name: "game", tableId };
    if (!detail || detail.id !== tableId) detail = null;
    const t = floor.tables.find((x) => x.id === tableId);
    if (t && !t.seats.some((x) => x.userId === myId()))
      S.emit("games spectate", { tableId, on: true });
    if (t) stripEl.textContent = nameOf(t.type);
    if (detail) return render();
    teardownGameView();
    bodyEl.textContent = "";
    bodyEl.className = "gm-body";
    bodyEl.appendChild(
      loadingNode(
        t ? "Opening " + nameOf(t.type) : "Opening",
        "Waiting for the board",
      ),
    );
  }

  function backToFloor() {
    if (detail && detail.spectating)
      S.emit("games spectate", { tableId: detail.id, on: false });
    pendingJoin = null;
    view = { name: "floor", tableId: null };
    detail = null;
    render();
  }

  function renderGame() {
    const t = detail;
    renderStats();
    stripEl.textContent = nameOf(t.type);

    const key = t.id + ":" + t.type;
    if (key !== boardKey) {
      teardownGameView();
      bodyEl.textContent = "";
      bodyEl.className = "gm-body gm-body-game";

      const bar = el("div", { class: "gm-gamebar" });
      bar.appendChild(
        el("button", { class: "gm-btn gm-btn-ghost gm-back", onclick: backToFloor }, [
          el("i", { class: "fas fa-chevron-left" }),
          " Games",
        ]),
      );
      bar.appendChild(el("div", { class: "gm-turnline", id: "gmTurn" }));
      const help = gameById(t.type);
      if (help && help.howTo && help.howTo.length)
        bar.appendChild(
          el("button", {
            class: "gm-help gm-help-bar",
            title: "How to play",
            "aria-label": "How to play " + help.name,
            onclick: () => showHowTo(help),
          }, el("i", { class: "fas fa-circle-question" })),
        );
      bar.appendChild(
        el("button", {
          class: "gm-btn gm-btn-ghost gm-chat-toggle",
          id: "gmChatToggle",
          "aria-label": "Show or hide the game chat",
          onclick: () => setChatOpen(!chatOpen),
        }),
      );
      bar.appendChild(el("div", { class: "gm-gameacts", id: "gmActs" }));
      bodyEl.appendChild(bar);

      bodyEl.appendChild(el("div", { class: "gm-banner", id: "gmBanner" }));

      const split = el("div", { class: "gm-split" });
      const main = el("div", { class: "gm-main" });
      main.appendChild(el("div", { class: "gm-waitslot", id: "gmWait" }));
      const sideEl = el("div", { class: "gm-side" });
      split.appendChild(main);
      split.appendChild(sideEl);
      bodyEl.appendChild(split);

      const fits = t.type === "drawguess" || t.type === "flagguess";
      main.classList.toggle("gm-main-fit", fits);
      split.classList.toggle("gm-split-fit", fits);
      board = BOARDS[t.type] ? BOARDS[t.type]() : null;
      if (board) board.mount(main);
      side = makeSide();
      side.mount(sideEl);
      boardKey = key;

      const held = earlyRelays.filter((r) => r.tableId === t.id);
      earlyRelays = [];
      for (const r of held) {
        if (side && side.relay) side.relay(r);
        if (board && board.relay) board.relay(r);
      }
    }

    applyChat();
    paintBanner(t);
    paintWaiting(t);
    paintTurn(t);
    paintActs(t);
    if (board) board.update(t);
    if (side) side.update(t);
  }

  function paintWaiting(t) {
    const slot = overlay.querySelector("#gmWait");
    if (!slot) return;
    const main = slot.parentNode;
    slot.textContent = "";
    const short = t.state === "open" && !t.game && !t.reservedFor;
    main.classList.toggle("gm-main-waiting", short);
    if (short) slot.appendChild(waitingPanel(t));
  }

  function paintBanner(t) {
    const host = overlay.querySelector("#gmBanner");
    if (!host) return;
    host.textContent = "";
    const o = t.outcome;
    if (!o) {
      host.className = "gm-banner";
      return;
    }
    host.className = "gm-banner show gm-banner-" + o.kind;

    const icons = {
      win: "fa-trophy",
      loss: "fa-circle-xmark",
      draw: "fa-handshake",
      watched: "fa-flag-checkered",
      over: "fa-flag-checkered",
    };
    host.appendChild(
      el("i", { class: "fas " + (icons[o.kind] || "fa-flag-checkered") }),
    );
    const txt = el("div", { class: "gm-banner-text" });
    txt.appendChild(el("div", { class: "gm-banner-head", text: o.headline }));
    if (o.detail)
      txt.appendChild(el("div", { class: "gm-banner-sub", text: o.detail }));
    host.appendChild(txt);

    if (t.rotateAt) {
      const g = gameById(t.type);
      const nextText = g && g.winnerStays ? "next game in" : "back to games in";
      host.appendChild(
        el("div", {
          class: "gm-banner-next gm-count",
          "data-deadline": String(t.rotateAt),
          "data-prefix": nextText,
        }),
      );
    }
  }

  function statusPill(t) {
    const playing = t.state === "playing";
    if (t.seated) {
      if (playing)
        return { cls: "gm-you-playing", icon: "fa-gamepad", text: "You are playing" };
      if (t.state === "finished")
        return { cls: "gm-you-playing", icon: "fa-gamepad", text: "You are in this game" };
      return {
        cls: "gm-you-playing",
        icon: "fa-gamepad",
        text: "You are in - the game has not started yet",
      };
    }
    if (t.iAmNext)
      return {
        cls: "gm-you-next",
        icon: "fa-hand",
        text: "Watching - you have the next round",
      };
    if (t.canJoin)
      return {
        cls: "gm-you-join",
        icon: "fa-eye",
        text: "Watching - you can join in now",
      };
    if (t.canPlayNext)
      return {
        cls: "gm-you-watch",
        icon: "fa-eye",
        text: "Watching - chat, or take the next round",
      };
    return { cls: "gm-you-watch", icon: "fa-eye", text: "Watching - you can chat" };
  }

  function paintTurn(t) {
    const host = overlay.querySelector("#gmTurn");
    if (!host) return;
    host.textContent = "";

    const you = statusPill(t);
    host.appendChild(
      el("span", { class: "gm-youpill " + you.cls }, [
        el("i", { class: "fas " + you.icon }),
        " " + you.text,
      ]),
    );

    if (t.state === "finished") return;
    const g = t.game || {};

    if (t.state === "open") {
      if (t.reservedFor)
        host.appendChild(
          el("span", { text: "Waiting for " + t.reservedFor.username + " to answer" }),
        );
      else if (t.openDeadline) {
        host.appendChild(el("span", { text: "Starting soon" }));
        host.appendChild(
          el("span", {
            class: "gm-count gm-count-pill",
            "data-deadline": String(t.openDeadline),
          }),
        );
      } else
        host.appendChild(
          el("span", { text: "Waiting for another player to join" }),
        );
      return;
    }

    if (t.spectators)
      host.appendChild(
        el("span", { class: "gm-watchpill" }, [
          el("i", { class: "fas fa-eye" }),
          " " + t.spectators + " watching",
        ]),
      );

    if (t.turnDeadline && g.turnUserId) {
      const yours = g.turnUserId === myId();
      const who = t.seats.find((s) => s.userId === g.turnUserId);
      host.appendChild(
        el("span", {
          class: yours ? "gm-turn gm-turn-mine" : "gm-turn",
          text: yours
            ? "Your move"
            : "Waiting on " + (who ? who.username : "your opponent"),
        }),
      );
      host.appendChild(
        el("span", {
          class: "gm-count gm-count-pill",
          "data-deadline": String(t.turnDeadline),
        }),
      );
    }
  }

  function paintActs(t) {
    const host = overlay.querySelector("#gmActs");
    if (!host) return;
    host.textContent = "";

    if (t.seated && t.state === "finished") {
      const asked = (t.rematch || []).length;
      const wants = (t.rematch || []).indexOf(myId()) >= 0;
      const gm = gameById(t.type);
      const unanimous = !!(gm && gm.winnerStays);
      const tally = asked ? " " + asked + "/" + t.seats.length : "";
      host.appendChild(
        el("button", {
          class: wants ? "gm-btn gm-btn-primary" : "gm-btn",
          title: wants
            ? "Click again to drop out of the next round"
            : unanimous
              ? "Ask for another game"
              : "You will be in the next round. Others can still join.",
          onclick: () => S.emit("games rematch", { tableId: t.id }),
        }, [
          el("i", { class: "fas fa-rotate-right" }),
          wants
            ? unanimous
              ? " Waiting on the rest" + tally
              : " You are in for the next one" + tally
            : " Play again" + tally,
        ]),
      );
    }
    if (t.seated) {
      host.appendChild(
        el("button", {
          class: "gm-btn gm-btn-danger",
          text: t.state === "playing" ? "Give up" : "Leave game",
          onclick: () => {
            S.emit("games leave", { tableId: t.id });
            backToFloor();
          },
        }),
      );
    } else {
      if (t.canJoin)
        host.appendChild(
          el("button", {
            class: "gm-btn gm-btn-primary",
            text: "Join in",
            onclick: () => S.emit("games join table", { tableId: t.id }),
          }),
        );
      if (t.canPlayNext && !t.canJoin) {
        const n = (t.nextUp || []).length;
        host.appendChild(
          el("button", {
            class: t.iAmNext ? "gm-btn gm-btn-primary" : "gm-btn",
            title: t.iAmNext
              ? "Click again to give up your place"
              : "Take a seat as soon as this round ends",
            onclick: () =>
              S.emit("games play next", { tableId: t.id, on: !t.iAmNext }),
          }, [
            el("i", { class: "fas fa-hand" }),
            (t.iAmNext ? " You are next" : " Play next round") +
              (n ? " (" + n + ")" : ""),
          ]),
        );
      }
      host.appendChild(
        el("button", { class: "gm-btn", onclick: backToFloor }, [
          el("i", { class: "fas fa-chevron-left" }),
          " Back to games",
        ]),
      );
    }
  }

  function waitingPanel(t) {
    const g = gameById(t.type);
    const box = el("div", { class: "gm-waiting" });
    box.appendChild(el("div", { class: "gm-waiting-pulse" }));
    box.appendChild(
      el("div", {
        class: "gm-waiting-head",
        text: "You are in. Waiting for an opponent.",
      }),
    );
    const need = g && g.maxPlayers === 2 ? "one more player" : "another player";
    box.appendChild(
      el("div", {
        class: "gm-waiting-sub",
        text:
          "Your seat at " + (g ? g.name : "this game") + " is held. It starts as soon as " +
          need + " sits down. Anyone in the room can jump in, or you can ask somebody by name.",
      }),
    );
    const acts = el("div", { class: "gm-waiting-acts" });
    if (g && g.maxPlayers === 2 && g.minPlayers === 2)
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Challenge someone",
          onclick: () => showChallengePicker(g),
        }),
      );
    acts.appendChild(
      el("button", {
        class: "gm-btn",
        text: "Leave",
        onclick: () => {
          S.emit("games leave", { tableId: t.id });
          backToFloor();
        },
      }),
    );
    box.appendChild(acts);
    if (t.streak && t.streak.n > 1)
      box.appendChild(
        el("div", {
          class: "gm-waiting-streak",
          text: "You are on " + t.streak.n + " wins in a row.",
        }),
      );
    return box;
  }

  // ── Side panel: who is here, and the chat ─────────────────────────────────

  function makeSide() {
    let root, playersEl, logEl, form, input, typingEl, countEl;
    let watchHead, watchCount, watchersEl;
    let nextHead, nextCount, nextEl;
    let lastChatId = 0;
    let typingSentAt = 0;
    let stopWatching = null;
    let jumpEl, foldCaret;
    let rosterFolded = false;

    let pinned = true;
    let missed = 0;

    function nearBottom() {
      return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
    }

    function toBottom() {
      logEl.scrollTop = logEl.scrollHeight;
      requestAnimationFrame(() => {
        if (pinned) logEl.scrollTop = logEl.scrollHeight;
      });
    }

    function repin() {
      pinned = true;
      missed = 0;
      paintJump();
      toBottom();
    }

    function paintJump() {
      if (!jumpEl) return;
      jumpEl.style.display = !pinned && missed ? "" : "none";
      jumpEl.textContent = "";
      if (!pinned && missed) {
        jumpEl.appendChild(el("i", { class: "fas fa-arrow-down" }));
        jumpEl.appendChild(
          document.createTextNode(
            " " + missed + (missed === 1 ? " new message" : " new messages"),
          ),
        );
      }
    }

    function addLine(m) {
      const stick = pinned;
      let node;
      if (m.kind === "system") {
        node = el("div", {
          class: "gm-chat-sys" + (m.tone ? " gm-chat-" + m.tone : ""),
          text: m.text,
        });
      } else {
        node = el("div", {
          class:
            "gm-chat-line" +
            (m.userId === myId() ? " gm-chat-mine" : "") +
            (m.watching ? " gm-chat-watch" : ""),
        });
        const head = el("div", { class: "gm-chat-head" });
        const pfp = avatarNode(m.avatar, true);
        if (pfp) head.appendChild(pfp);
        const badge = badgeFor(m.role);
        if (badge) head.appendChild(badge);
        const who = el("span", { class: "gm-chat-who", text: m.username });
        if (m.watching)
          who.appendChild(el("i", { class: "fas fa-eye", title: "Watching" }));
        head.appendChild(who);
        node.appendChild(head);
        const body = el("span", { class: "gm-chat-text", text: masked(m.text) });
        body.dataset.raw = m.text == null ? "" : String(m.text);
        node.appendChild(body);
      }
      logEl.appendChild(node);
      while (logEl.childNodes.length > 120) logEl.removeChild(logEl.firstChild);
      if (stick) toBottom();
      else {
        missed++;
        paintJump();
      }
    }

    return {
      mount(host) {
        root = el("div", { class: "gm-sidepanel" });

        const ph = el("button", {
          class: "gm-side-head gm-side-fold",
          type: "button",
          title: "Show or hide the players",
        }, [
          el("i", { class: "fas fa-users" }),
          el("span", { text: "In this game" }),
        ]);
        countEl = el("span", { class: "gm-side-count" });
        ph.appendChild(countEl);
        foldCaret = el("i", { class: "fas fa-chevron-down gm-fold-caret" });
        ph.appendChild(foldCaret);
        root.appendChild(ph);

        playersEl = el("div", { class: "gm-players" });
        root.appendChild(playersEl);

        const setFold = (on) => {
          rosterFolded = !!on;
          playersEl.style.display = rosterFolded ? "none" : "";
          foldCaret.className =
            "fas gm-fold-caret " + (rosterFolded ? "fa-chevron-right" : "fa-chevron-down");
          try {
            localStorage.setItem("tk-games-roster", rosterFolded ? "0" : "1");
          } catch (e) {
          }
        };
        let saved = null;
        try {
          saved = localStorage.getItem("tk-games-roster");
        } catch (e) {
          saved = null;
        }
        setFold(saved === null ? window.innerWidth <= 720 : saved === "0");
        ph.addEventListener("click", () => setFold(!rosterFolded));

        nextHead = el("div", { class: "gm-side-head gm-next-head" }, [
          el("i", { class: "fas fa-hand" }),
          el("span", { text: "Up next" }),
        ]);
        nextCount = el("span", { class: "gm-side-count" });
        nextHead.appendChild(nextCount);
        root.appendChild(nextHead);
        nextEl = el("div", { class: "gm-watchers gm-nextup" });
        root.appendChild(nextEl);

        watchHead = el("div", { class: "gm-side-head gm-watch-head" }, [
          el("i", { class: "fas fa-eye" }),
          el("span", { text: "Watching" }),
        ]);
        watchCount = el("span", { class: "gm-side-count" });
        watchHead.appendChild(watchCount);
        root.appendChild(watchHead);
        watchersEl = el("div", { class: "gm-watchers" });
        root.appendChild(watchersEl);

        root.appendChild(
          el("div", { class: "gm-side-head" }, [
            el("i", { class: "fas fa-comments" }),
            el("span", { text: "Game chat" }),
          ]),
        );
        logEl = el("div", { class: "gm-chat-log" });
        logEl.addEventListener("scroll", () => {
          const now = nearBottom();
          if (now === pinned) return;
          pinned = now;
          if (pinned) missed = 0;
          paintJump();
        });
        root.appendChild(logEl);

        jumpEl = el("button", {
          class: "gm-chat-jump",
          type: "button",
          onclick: repin,
        });
        jumpEl.style.display = "none";
        root.appendChild(jumpEl);

        typingEl = el("div", { class: "gm-chat-typing" });
        root.appendChild(typingEl);

        input = el("input", {
          class: "gm-chat-input",
          type: "text",
          maxlength: "200",
          placeholder: "Say something",
          autocomplete: "off",
        });
        input.addEventListener("input", () => {
          const now = Date.now();
          if (input.value && now - typingSentAt > 2000) {
            typingSentAt = now;
            S.emit("games typing", { tableId: detail.id, on: true });
          }
        });
        form = el("form", { class: "gm-chat-form" }, [
          input,
          el("button", {
            class: "gm-btn gm-btn-primary gm-chat-send",
            type: "submit",
            "aria-label": "Send",
          }, el("i", { class: "fas fa-paper-plane" })),
        ]);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          S.emit("games chat", { tableId: detail.id, text: v });
          S.emit("games typing", { tableId: detail.id, on: false });
          typingSentAt = 0;
          input.value = "";
        });
        root.appendChild(form);
        host.appendChild(root);
        if (window.TalkomaticFilter && window.TalkomaticFilter.onChange)
          stopWatching = window.TalkomaticFilter.onChange(refilter);
      },

      destroy() {
        if (stopWatching) stopWatching();
        stopWatching = null;
      },

      relay(payload) {
        if (payload.kind === "chat" && payload.message) {
          if (payload.message.id <= lastChatId) return;
          lastChatId = payload.message.id;
          addLine(payload.message);
          if (!chatOpen && payload.message.userId !== myId()) {
            unread++;
            applyChat();
          }
        } else if (payload.kind === "typing") {
          paintTyping(payload.users || []);
        }
      },

      update(t) {
        const g = t.game || {};
        const list =
          g.players && g.players.length
            ? g.players
            : t.seats.map((s) => ({ userId: s.userId, username: s.username }));
        countEl.textContent = String(list.length);

        playersEl.textContent = "";
        list.forEach((p) => {
          const seat = t.seats.find((s) => s.userId === p.userId);
          const seatedPlayer = !!seat;
          const row = el("div", {
            class:
              "gm-player" +
              (p.userId === myId() ? " gm-player-me" : "") +
              (p.drawing || (g.turnUserId && g.turnUserId === p.userId)
                ? " gm-player-active"
                : "") +
              (p.got ? " gm-player-got" : ""),
          });
          if (p.drawing)
            row.appendChild(el("span", { class: "gm-badge", title: "Drawing", text: "✎" }));
          else if (p.mark)
            row.appendChild(
              el("span", { class: "gm-badge gm-mark-" + p.mark, text: p.mark }),
            );
          const pfp = avatarNode(seat && seat.avatar);
          if (pfp) row.appendChild(pfp);
          row.appendChild(el("span", { class: "gm-player-name", text: p.username }));
          const badge = badgeFor(seat && seat.role);
          if (badge) row.appendChild(badge);
          if (t.state === "finished" && (t.rematch || []).indexOf(p.userId) >= 0)
            row.appendChild(
              el("i", {
                class: "fas fa-rotate-right gm-wants",
                title: p.username + " wants a rematch",
              }),
            );
          if (p.noDraw && !p.drawing)
            row.appendChild(
              el("i", {
                class: "fas fa-pen-slash gm-nodraw",
                title: p.username + " would rather not draw",
              }),
            );
          if (p.got) row.appendChild(el("i", { class: "fas fa-check gm-got" }));
          if (typeof p.score === "number")
            row.appendChild(el("span", { class: "gm-player-score", text: String(p.score) }));
          else if (typeof p.count === "number")
            row.appendChild(
              el("span", { class: "gm-player-score", text: p.count + "w" }),
            );

          if (t.canVote && seatedPlayer && p.userId !== myId()) {
            const v = (t.votes || []).find((x) => x.userId === p.userId);
            const btn = el("button", {
              class: "gm-kick" + (v && v.mine ? " gm-kick-voted" : ""),
              title: "Vote to remove " + p.username,
              onclick: () =>
                S.emit("games vote remove", {
                  tableId: t.id,
                  targetUserId: p.userId,
                }),
            }, el("i", { class: "fas fa-user-slash" }));
            if (v && v.count)
              btn.appendChild(
                el("span", { class: "gm-kick-n", text: v.count + "/" + t.voteNeeded }),
              );
            row.appendChild(btn);
          }
          playersEl.appendChild(row);
        });

        const upNext = t.nextUp || [];
        nextHead.style.display = upNext.length ? "" : "none";
        nextEl.style.display = upNext.length ? "" : "none";
        nextCount.textContent = upNext.length ? String(upNext.length) : "";
        nextEl.textContent = "";
        upNext.forEach((w, i) => {
          const chip = el("div", {
            class: "gm-watcher" + (w.userId === myId() ? " gm-next-me" : ""),
          });
          chip.appendChild(el("span", { class: "gm-next-pos", text: "#" + (i + 1) }));
          const pfp = avatarNode(w.avatar, true);
          if (pfp) chip.appendChild(pfp);
          chip.appendChild(el("span", { class: "gm-watcher-name", text: w.username }));
          const badge = badgeFor(w.role);
          if (badge) chip.appendChild(badge);
          nextEl.appendChild(chip);
        });

        const watchers = t.watchers || [];
        const extra = (t.spectators || 0) - watchers.length;
        const show = watchers.length > 0;
        watchHead.style.display = show ? "" : "none";
        watchersEl.style.display = show ? "" : "none";
        watchCount.textContent = show ? String(t.spectators || watchers.length) : "";
        watchersEl.textContent = "";
        watchers.forEach((w) => {
          const chip = el("div", { class: "gm-watcher" });
          const pfp = avatarNode(w.avatar, true);
          if (pfp) chip.appendChild(pfp);
          chip.appendChild(el("span", { class: "gm-watcher-name", text: w.username }));
          const badge = badgeFor(w.role);
          if (badge) chip.appendChild(badge);
          watchersEl.appendChild(chip);
        });
        if (extra > 0)
          watchersEl.appendChild(
            el("div", { class: "gm-watcher gm-watcher-more", text: "+" + extra + " more" }),
          );

        if (!lastChatId && Array.isArray(t.chat)) {
          t.chat.forEach((m) => {
            lastChatId = Math.max(lastChatId, m.id);
            addLine(m);
          });
          repin();
        }
        paintTyping(t.typing || []);
      },
    };

    function refilter() {
      if (!logEl) return;
      logEl.querySelectorAll(".gm-chat-text").forEach((n) => {
        if (n.dataset.raw === undefined) return;
        n.textContent = masked(n.dataset.raw);
      });
    }

    function paintTyping(users) {
      if (!typingEl) return;
      if (!users.length) {
        typingEl.textContent = "";
        return;
      }
      const names = users.map((u) => u.username).filter(Boolean);
      typingEl.textContent = names.length
        ? (names.length === 1
            ? names[0] + " is typing"
            : names.slice(0, 2).join(" and ") + " are typing") + "..."
        : "Someone is typing...";
    }
  }

  // ── Boards ────────────────────────────────────────────────────────────────

  const BOARDS = {};

  BOARDS.tictactoe = function () {
    let youAre, gridEl;
    const cells = [];
    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-ttt" });
        youAre = el("div", { class: "gm-youare" });
        gridEl = el("div", { class: "gm-ttt-grid" });
        for (let i = 0; i < 9; i++) {
          const c = el("button", {
            class: "gm-ttt-cell",
            onclick: () =>
              S.emit("games move", { tableId: detail.id, move: { cell: i } }),
          });
          cells.push(c);
          gridEl.appendChild(c);
        }
        root.appendChild(youAre);
        root.appendChild(gridEl);
        stage.appendChild(root);
      },
      update(t) {
        const g = t.game;
        youAre.textContent = "";
        if (!g) {
          gridEl.classList.add("gm-idle");
          cells.forEach((c) => {
            c.textContent = "";
            c.disabled = true;
            c.className = "gm-ttt-cell";
          });
          youAre.appendChild(el("span", { text: "Waiting for a player" }));
          return;
        }
        gridEl.classList.remove("gm-idle");
        const me = g.players.find((p) => p.userId === myId());
        if (me) {
          youAre.appendChild(el("span", { text: "You are" }));
          youAre.appendChild(
            el("b", { class: "gm-mark-" + me.mark, text: me.mark }),
          );
        }
        const mine = g.turnUserId === myId() && t.state === "playing";
        gridEl.classList.toggle("gm-myturn", mine);
        for (let i = 0; i < 9; i++) {
          const v = g.board[i];
          cells[i].textContent = v || "";
          cells[i].disabled = !mine || !!v;
          cells[i].className =
            "gm-ttt-cell" +
            (v ? " gm-mark-" + v : "") +
            (g.line && g.line.indexOf(i) >= 0 ? " gm-win" : "") +
            (!v && mine ? " gm-open" : "");
        }
      },
    };
  };

  BOARDS.connect4 = function () {
    let youAre, gridEl, colBar;
    const cells = [];
    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-c4" });
        youAre = el("div", { class: "gm-youare" });
        colBar = el("div", { class: "gm-c4-cols" });
        gridEl = el("div", { class: "gm-c4-grid" });
        for (let c = 0; c < 7; c++) {
          colBar.appendChild(
            el("button", {
              class: "gm-c4-drop",
              "aria-label": "Drop in column " + (c + 1),
              onclick: () =>
                S.emit("games move", { tableId: detail.id, move: { col: c } }),
              onmouseenter: () => hover(c, true),
              onmouseleave: () => hover(c, false),
            }, el("i", { class: "fas fa-caret-down" })),
          );
        }
        for (let i = 0; i < 42; i++) {
          const cell = el("div", { class: "gm-c4-cell" }, el("span"));
          cells.push(cell);
          gridEl.appendChild(cell);
        }
        root.appendChild(youAre);
        root.appendChild(colBar);
        root.appendChild(gridEl);
        stage.appendChild(root);
      },
      update(t) {
        const g = t.game;
        youAre.textContent = "";
        const drops = colBar.querySelectorAll(".gm-c4-drop");
        if (!g) {
          cells.forEach((c) => (c.className = "gm-c4-cell"));
          drops.forEach((d) => (d.disabled = true));
          youAre.appendChild(el("span", { text: "Waiting for a player" }));
          return;
        }
        const me = g.players.find((p) => p.userId === myId());
        if (me) {
          youAre.appendChild(el("span", { text: "You are" }));
          youAre.appendChild(
            el("b", { class: "gm-disc gm-c4-" + me.mark, text: me.mark === "R" ? "red" : "yellow" }),
          );
        }
        const mine = g.turnUserId === myId() && t.state === "playing";
        gridEl.classList.toggle("gm-myturn", mine);
        gridEl.dataset.mark = me ? me.mark : "";
        drops.forEach((d, i) => {
          d.disabled = !mine || g.heights[i] >= g.rows;
        });
        const winSet = {};
        (g.line || []).forEach((p) => {
          winSet[(g.rows - 1 - p.row) * g.cols + p.col] = true;
        });
        for (let i = 0; i < g.grid.length; i++) {
          const v = g.grid[i];
          cells[i].className =
            "gm-c4-cell" + (v ? " gm-c4-" + v : "") + (winSet[i] ? " gm-win" : "");
        }
      },
    };

    function hover(col, on) {
      for (let r = 0; r < 6; r++)
        cells[r * 7 + col].classList.toggle("gm-c4-hover", on);
    }
  };

  BOARDS.flagguess = function () {
    let root, timerRow, timerNum, timerFill, roundEl, promptEl;
    let canvas, ctx, canvasBox, canvasWrap;
    let guessWrap, guessForm, guessInput, guessLabel, statusEl;
    let img = null;
    let shownToken = null;
    let ro = null;
    let focused = false;

    const ART_W = 900;
    const ART_H = 600;

    function fit() {
      if (!canvasBox || !canvasWrap) return;
      const box = canvasBox.getBoundingClientRect();
      if (!box.width) return;
      const room = box.height > 60 ? box.height : Infinity;
      const scale = Math.min(box.width / ART_W, room / ART_H);
      const w = Math.max(180, Math.floor(ART_W * scale));
      canvasWrap.style.width = w + "px";
      canvasWrap.style.height = Math.max(120, Math.floor(ART_H * scale)) + "px";
      if (root) root.style.setProperty("--gm-art-w", w + "px");
    }

    function resize() {
      if (!canvas) return;
      fit();
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      paint();
    }

    function clear() {
      if (!ctx) return;
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function paint() {
      if (!ctx) return;
      clear();
      if (!img || !img.complete || !img.naturalWidth) return;
      const s = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }

    function show(token) {
      if (token === shownToken) return;
      shownToken = token;
      img = null;
      clear();
      if (!token) return;
      const next = new Image();
      next.onload = () => {
        if (shownToken !== token) return;
        img = next;
        paint();
      };
      next.onerror = () => {
        if (shownToken !== token) return;
        clear();
        if (ctx) {
          ctx.fillStyle = "#888";
          ctx.font = Math.round(canvas.width / 26) + "px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("Flag could not load", canvas.width / 2, canvas.height / 2);
        }
      };
      next.src = "flag/" + encodeURIComponent(token) + ".png";
    }

    return {
      mount(stage) {
        root = el("div", { class: "gm-board gm-fg" });

        timerNum = el("div", { class: "gm-dg-secs" });
        timerFill = el("div", { class: "gm-dg-timefill" });
        roundEl = el("div", { class: "gm-dg-turn" });
        timerRow = el("div", { class: "gm-dg-timer" }, [
          timerNum,
          el("div", { class: "gm-dg-timebar" }, timerFill),
          roundEl,
        ]);
        root.appendChild(timerRow);

        promptEl = el("div", { class: "gm-dg-prompt gm-fg-prompt" });
        root.appendChild(promptEl);

        canvas = el("canvas", { class: "gm-fg-canvas" });
        ctx = canvas.getContext("2d");
        canvasWrap = el("div", { class: "gm-fg-canvas-wrap" }, canvas);
        canvasBox = el("div", { class: "gm-dg-canvasbox" }, canvasWrap);
        root.appendChild(canvasBox);
        clear();

        guessLabel = el("div", { class: "gm-dg-guesslabel" });
        guessInput = el("input", {
          class: "gm-dg-input",
          type: "text",
          maxlength: "40",
          placeholder: "Which country is this?",
          autocomplete: "off",
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
        });
        guessForm = el("form", { class: "gm-dg-guessform" }, [
          guessInput,
          el("button", { class: "gm-btn gm-btn-primary", type: "submit", text: "Guess" }),
        ]);
        guessForm.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = guessInput.value.trim();
          if (!v) return;
          S.emit("games move", {
            tableId: detail.id, move: { kind: "guess", text: v },
          });
          guessInput.value = "";
        });
        guessWrap = el("div", { class: "gm-dg-guesswrap" }, [guessLabel, guessForm]);
        root.appendChild(guessWrap);

        statusEl = el("div", { class: "gm-dg-status" });
        root.appendChild(statusEl);

        stage.appendChild(root);
        setTimeout(resize, 0);
        window.addEventListener("resize", resize);
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => resize());
          ro.observe(canvasBox);
        }
      },

      destroy() {
        window.removeEventListener("resize", resize);
        if (ro) ro.disconnect();
        ro = null;
        img = null;
        shownToken = null;
      },

      say(msg, good) {
        const line = el("div", {
          class: "gm-dg-flash " + (good ? "gm-good" : "gm-bad"),
          text: msg,
        });
        statusEl.insertBefore(line, statusEl.firstChild);
        setTimeout(() => line.remove(), 2400);
      },

      clock() {
        const g = detail && detail.game;
        if (!g || !g.endsAt) {
          timerRow.style.display = "none";
          return;
        }
        timerRow.style.display = "";
        const left = Math.max(0, Math.ceil((g.endsAt - Date.now()) / 1000));
        timerNum.textContent = left;
        const pct = Math.max(0, Math.min(100, ((g.endsAt - Date.now()) / g.phaseMs) * 100));
        timerFill.style.width = pct + "%";
        timerRow.classList.toggle("gm-dg-low", g.phase === "guessing" && left <= 6);
      },

      update(t) {
        const g = t.game;
        if (!g) {
          promptEl.textContent = "Getting things ready...";
          guessWrap.style.display = "none";
          timerRow.style.display = "none";
          return;
        }

        resize();
        show(g.token);

        roundEl.textContent = g.totalRounds
          ? "Flag " + Math.min(g.round + 1, g.totalRounds) + "/" + g.totalRounds
          : "";

        promptEl.textContent = "";
        if (g.phase === "opening") {
          promptEl.appendChild(
            el("span", { class: "gm-dg-waiting" }, [
              el("i", { class: "fas fa-hourglass-start" }),
              " First flag coming up",
            ]),
          );
        } else if (g.phase === "guessing") {
          promptEl.appendChild(
            el("span", { class: "gm-dg-label", text: "Name this country" }),
          );
          if (g.hint)
            promptEl.appendChild(el("span", { class: "gm-dg-hint", text: g.hint }));
        } else if (g.reveal) {
          promptEl.appendChild(el("span", { class: "gm-dg-label", text: "It was" }));
          promptEl.appendChild(el("span", { class: "gm-dg-word", text: g.reveal }));
          const n = g.guessed.length;
          promptEl.appendChild(
            el("span", {
              class: "gm-dg-label",
              text: n ? n + (n === 1 ? " got it" : " got it") : "Nobody got it",
            }),
          );
        }

        const showGuess = t.seated && g.phase === "guessing";
        guessWrap.style.display = showGuess ? "" : "none";
        if (showGuess) {
          guessLabel.textContent = "";
          if (g.canGuess) {
            guessWrap.classList.remove("gm-dg-got");
            guessLabel.appendChild(el("i", { class: "fas fa-earth-americas" }));
            guessLabel.appendChild(el("span", { text: " Type the country" }));
            guessInput.disabled = false;
            if (!focused) {
              focused = true;
              setTimeout(() => guessInput.focus(), 40);
            }
          } else {
            guessWrap.classList.add("gm-dg-got");
            guessLabel.appendChild(el("i", { class: "fas fa-circle-check" }));
            guessLabel.appendChild(el("span", { text: " Got it. Wait for the rest." }));
            guessInput.disabled = true;
          }
        }
        if (g.phase !== "guessing") focused = false;

        statusEl.textContent = "";
        if (g.phase === "guessing" && g.guessed.length) {
          const got = el("div", { class: "gm-dg-line" });
          got.appendChild(el("span", { class: "gm-dg-linelabel", text: "Got it" }));
          g.guessed.forEach((x) =>
            got.appendChild(
              el("span", { class: "gm-dg-gotchip" }, [
                el("b", { text: "#" + x.place }),
                x.username,
              ]),
            ),
          );
          statusEl.appendChild(got);
        }
        if (g.phase === "guessing" && g.waitingOn && g.waitingOn.length) {
          const wait = el("div", { class: "gm-dg-line" });
          wait.appendChild(el("span", { class: "gm-dg-linelabel", text: "Thinking" }));
          g.waitingOn.forEach((x) =>
            wait.appendChild(el("span", { class: "gm-dg-waitchip", text: x.username })),
          );
          statusEl.appendChild(wait);
        }
      },
    };
  };

  BOARDS.drawguess = function () {
    let root, timerRow, timerNum, timerFill, progEl, promptEl, choiceEl;
    let canvas, ctx, tools, guessWrap, guessHint;
    let statusEl, drawerActions, canvasBox, canvasWrap, sizesEl;
    let stageEl, lobbyEl;
    let drawing = false;
    let last = null;
    let pending = [];
    let flushTimer = null;
    let color = 0;
    let brush = 1;
    let erasing = false;
    let strokes = [];
    let painted = 0;
    let startNext = true;
    let rev = -1;
    let syncing = false;
    let palette = null;
    let papers = null;
    let bg = 0;
    let ro = null;

    const ART_W = 1280;
    const ART_H = 720;
    const BRUSH_SIZES = [5, 12, 26, 50];

    function paper() {
      return (papers && papers[bg]) || "#fdf5e6";
    }
    function inkOf(sSeg) {
      if (sSeg.e) return paper();
      return (palette && palette[sSeg.c]) || "#1b1b1b";
    }
    function clearCanvas() {
      ctx.fillStyle = paper();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    function drawSeg(sSeg) {
      ctx.strokeStyle = inkOf(sSeg);
      ctx.lineWidth = Math.max(1, (sSeg.w || 6) * (canvas.width / ART_W));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(sSeg.x0 * canvas.width, sSeg.y0 * canvas.height);
      ctx.lineTo(sSeg.x1 * canvas.width, sSeg.y1 * canvas.height);
      ctx.stroke();
    }
    function repaint() {
      clearCanvas();
      strokes.forEach(drawSeg);
      painted = strokes.length;
    }
    function fit() {
      if (!canvasBox || !canvasWrap) return;
      const box = canvasBox.getBoundingClientRect();
      if (!box.width) return;
      const room = box.height > 60 ? box.height : Infinity;
      const scale = Math.min(box.width / ART_W, room / ART_H);
      const w = Math.max(160, Math.floor(ART_W * scale));
      canvasWrap.style.width = w + "px";
      canvasWrap.style.height = Math.max(112, Math.floor(ART_H * scale)) + "px";
      if (root) root.style.setProperty("--gm-art-w", w + "px");
    }
    function resize() {
      if (!canvas) return;
      fit();
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      repaint();
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const pt = e.touches ? e.touches[0] : e;
      return {
        x: Math.max(0, Math.min(1, (pt.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (pt.clientY - r.top) / r.height)),
      };
    }
    function canDraw() {
      return !!(
        detail && detail.game && detail.game.amDrawer &&
        detail.game.phase === "drawing"
      );
    }
    function requestSync() {
      if (syncing || !detail) return;
      syncing = true;
      S.emit("games draw", { tableId: detail.id, kind: "sync" });
      setTimeout(() => { syncing = false; }, 1200);
    }
    function flush() {
      flushTimer = null;
      if (!pending.length) return;
      S.emit("games draw", { tableId: detail.id, segments: pending.splice(0, 40) });
      if (pending.length) flushTimer = setTimeout(flush, 45);
    }
    function push(seg) {
      strokes.push(seg);
      drawSeg(seg);
      painted = strokes.length;
      pending.push(seg);
      if (!flushTimer) flushTimer = setTimeout(flush, 45);
    }
    function down(e) {
      if (!canDraw()) return;
      e.preventDefault();
      drawing = true;
      startNext = true;
      last = pos(e);
    }
    function move(e) {
      if (!drawing || !canDraw()) return;
      e.preventDefault();
      const p = pos(e);
      if (Math.abs(p.x - last.x) < 0.002 && Math.abs(p.y - last.y) < 0.002) return;
      const seg = {
        x0: last.x, y0: last.y, x1: p.x, y1: p.y,
        c: color, w: BRUSH_SIZES[brush],
      };
      if (erasing) seg.e = 1;
      if (startNext) {
        seg.start = 1;
        startNext = false;
      }
      push(seg);
      last = p;
    }
    function up() {
      drawing = false;
      last = null;
    }

    function toolGroup(label, body, cls) {
      return el("div", { class: "gm-dg-grp " + cls }, [
        el("span", { class: "gm-dg-toollabel", text: label }),
        body,
      ]);
    }

    function setBrush(i) {
      brush = i;
      sizesEl.querySelectorAll(".gm-dg-size").forEach((n, j) =>
        n.classList.toggle("active", j === i),
      );
    }

    function setTool(which) {
      erasing = which === "erase";
      root.querySelectorAll(".gm-dg-tool").forEach((n) =>
        n.classList.toggle("active", n.dataset.tool === which),
      );
      canvas.classList.toggle("gm-dg-erasing", erasing);
    }

    return {
      mount(stage) {
        root = el("div", { class: "gm-board gm-dg" });

        timerNum = el("div", { class: "gm-dg-secs" });
        timerFill = el("div", { class: "gm-dg-timefill" });
        progEl = el("div", { class: "gm-dg-turn" });
        timerRow = el("div", { class: "gm-dg-timer" }, [
          timerNum,
          el("div", { class: "gm-dg-timebar" }, timerFill),
          progEl,
        ]);
        root.appendChild(timerRow);

        promptEl = el("div", { class: "gm-dg-prompt" });
        root.appendChild(promptEl);
        choiceEl = el("div", { class: "gm-dg-choices" });
        root.appendChild(choiceEl);
        drawerActions = el("div", { class: "gm-dg-draweracts" });
        root.appendChild(drawerActions);

        canvas = el("canvas", { class: "gm-dg-canvas" });
        canvasWrap = el("div", { class: "gm-dg-canvas-wrap" }, canvas);
        canvasBox = el("div", { class: "gm-dg-canvasbox" }, canvasWrap);
        ctx = canvas.getContext("2d");
        clearCanvas();

        canvas.addEventListener("mousedown", down);
        canvas.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        canvas.addEventListener("touchstart", down, { passive: false });
        canvas.addEventListener("touchmove", move, { passive: false });
        window.addEventListener("touchend", up);

        tools = el("div", { class: "gm-dg-tools" });

        const swatches = el("div", { class: "gm-dg-swatches" });
        tools._swatches = swatches;
        tools.appendChild(toolGroup("Colour", swatches, "gm-dg-grp-ink"));

        sizesEl = el("div", { class: "gm-dg-sizes" });
        BRUSH_SIZES.forEach((w, i) => {
          const b = el("button", {
            class: "gm-dg-size" + (i === brush ? " active" : ""),
            title: ["Fine", "Normal", "Thick", "Fat"][i] + " brush",
            "aria-label": "Brush size " + (i + 1),
            onclick: () => setBrush(i),
          });
          const dot = el("span");
          const px = Math.round(4 + (w / BRUSH_SIZES[BRUSH_SIZES.length - 1]) * 16);
          dot.style.width = dot.style.height = px + "px";
          b.appendChild(dot);
          sizesEl.appendChild(b);
        });
        tools.appendChild(toolGroup("Brush size", sizesEl, "gm-dg-grp-size"));

        const modes = el("div", { class: "gm-dg-modes" });
        modes.appendChild(
          el("button", {
            class: "gm-dg-tool active", "data-tool": "pen", title: "Pen",
            onclick: () => setTool("pen"),
          }, el("i", { class: "fas fa-pen" })),
        );
        modes.appendChild(
          el("button", {
            class: "gm-dg-tool", "data-tool": "erase", title: "Eraser",
            onclick: () => setTool("erase"),
          }, el("i", { class: "fas fa-eraser" })),
        );
        tools.appendChild(toolGroup("Tool", modes, "gm-dg-grp-mode"));

        const papersEl = el("div", { class: "gm-dg-papers" });
        tools._papers = papersEl;
        tools.appendChild(toolGroup("Paper", papersEl, "gm-dg-grp-paper"));

        const acts = el("div", { class: "gm-dg-toolacts" });
        acts.appendChild(
          el("button", {
            class: "gm-btn gm-btn-ghost", title: "Undo the last stroke",
            onclick: () => S.emit("games draw", { tableId: detail.id, kind: "undo" }),
          }, [el("i", { class: "fas fa-rotate-left" }), el("span", { text: "Undo" })]),
        );
        acts.appendChild(
          el("button", {
            class: "gm-btn gm-btn-ghost", title: "Clear the canvas",
            onclick: () => S.emit("games draw", { tableId: detail.id, kind: "clear" }),
          }, [el("i", { class: "fas fa-trash" }), el("span", { text: "Clear" })]),
        );
        tools.appendChild(acts);

        stageEl = el("div", { class: "gm-dg-stage" }, [tools, canvasBox]);
        root.appendChild(stageEl);

        lobbyEl = el("div", { class: "gm-dg-lobby" });
        root.appendChild(lobbyEl);

        guessHint = el("div", { class: "gm-dg-guesslabel" });
        guessWrap = el("div", { class: "gm-dg-guesswrap gm-dg-tip" }, [guessHint]);
        root.appendChild(guessWrap);

        statusEl = el("div", { class: "gm-dg-status" });
        root.appendChild(statusEl);

        stage.appendChild(root);
        setTimeout(resize, 0);
        window.addEventListener("resize", resize);
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => resize());
          ro.observe(canvasBox);
        }
        requestSync();
      },

      destroy() {
        window.removeEventListener("resize", resize);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("touchend", up);
        if (ro) ro.disconnect();
        ro = null;
        if (flushTimer) clearTimeout(flushTimer);
      },

      relay(payload) {
        if (payload.kind === "strokeBatch") {
          const segs = payload.strokes || [];
          if (detail && detail.game && detail.game.amDrawer) {
            rev = payload.rev;
            return;
          }
          if (rev >= 0 && payload.rev - segs.length !== rev) {
            rev = payload.rev;
            return requestSync();
          }
          for (const seg of segs) {
            strokes.push(seg);
            drawSeg(seg);
          }
          painted = strokes.length;
          rev = payload.rev;
        } else if (payload.kind === "stroke") {
          if (detail && detail.game && detail.game.amDrawer) {
            rev = payload.rev;
            return;
          }
          if (rev >= 0 && payload.rev - 1 !== rev) {
            rev = payload.rev;
            return requestSync();
          }
          strokes.push(payload.stroke);
          drawSeg(payload.stroke);
          painted = strokes.length;
          rev = payload.rev;
        } else if (payload.kind === "clear") {
          strokes = [];
          rev = payload.rev;
          repaint();
        } else if (payload.kind === "bg") {
          bg = payload.bg;
          rev = payload.rev;
          repaint();
          paintPapers();
        } else if (payload.kind === "strokes") {
          strokes = payload.strokes || [];
          if (typeof payload.bg === "number") bg = payload.bg;
          rev = payload.rev;
          syncing = false;
          repaint();
          paintPapers();
        }
      },

      say(msg, good) {
        const line = el("div", {
          class: "gm-dg-flash " + (good ? "gm-good" : "gm-bad"),
          text: msg,
        });
        statusEl.insertBefore(line, statusEl.firstChild);
        setTimeout(() => line.remove(), 2600);
      },

      clock() {
        const g = detail && detail.game;
        if (!g || !g.endsAt || g.phase === "waiting") {
          timerRow.style.display = "none";
          return;
        }
        timerRow.style.display = "";
        const left = Math.max(0, Math.ceil((g.endsAt - Date.now()) / 1000));
        timerNum.textContent = left;
        const pct = Math.max(0, Math.min(100, ((g.endsAt - Date.now()) / g.phaseMs) * 100));
        timerFill.style.width = pct + "%";
        const low = left <= 10;
        timerRow.classList.toggle("gm-dg-low", low);
      },

      update(t) {
        const g = t.game;
        if (!g) {
          promptEl.textContent = "Getting things ready...";
          choiceEl.textContent = "";
          tools.style.display = "none";
          guessWrap.style.display = "none";
          timerRow.style.display = "none";
          drawerActions.textContent = "";
          return;
        }
        palette = g.colors || palette;
        papers = g.backgrounds || papers;
        if (typeof g.bg === "number" && g.bg !== bg && rev <= g.rev) {
          bg = g.bg;
          repaint();
        }
        resize();
        if (rev === -1 || (g.rev > rev && !pending.length && !drawing)) requestSync();

        paintSwatches();
        paintPapers();

        progEl.textContent =
          g.totalTurns && g.phase !== "waiting"
            ? "Turn " + Math.min(g.turn + 1, g.totalTurns) + "/" + g.totalTurns
            : "";

        if (
          (g.phase === "choosing" || g.phase === "waiting") &&
          strokes.length && !g.strokeCount
        ) {
          strokes = [];
          repaint();
        }

        promptEl.textContent = "";
        choiceEl.textContent = "";
        drawerActions.textContent = "";

        const done = g.over || g.phase === "done";
        const parked = g.phase === "waiting" || done;
        stageEl.style.display = parked ? "none" : "";
        lobbyEl.style.display = parked ? "" : "none";
        promptEl.style.display = parked ? "none" : "";
        timerRow.style.display = parked ? "none" : "";
        if (parked) {
          if (done) paintFinal(t, g);
          else paintLobby(t, g);
          guessWrap.style.display = "none";
          statusEl.textContent = "";
          return;
        }

        if (g.phase === "choosing") {
          if (g.amDrawer && g.choices) {
            promptEl.appendChild(
              el("span", { class: "gm-dg-yourturn", text: "Your turn, pick a word" }),
            );
            g.choices.forEach((w, i) => {
              choiceEl.appendChild(
                el("button", {
                  class: "gm-btn gm-btn-primary gm-dg-choice",
                  text: w,
                  onclick: () =>
                    S.emit("games move", {
                      tableId: detail.id, move: { kind: "pick", index: i },
                    }),
                }),
              );
            });
            if (g.shufflesLeft > 0)
              drawerActions.appendChild(
                el("button", {
                  class: "gm-btn gm-btn-ghost gm-dg-shuffle",
                  title: "Swap all three for a different set",
                  onclick: () =>
                    S.emit("games move", { tableId: detail.id, move: { kind: "shuffle" } }),
                }, [
                  el("i", { class: "fas fa-shuffle" }),
                  " Different words (" + g.shufflesLeft + " left)",
                ]),
              );
            drawerActions.appendChild(
              el("button", {
                class: "gm-btn gm-dg-pass",
                onclick: () =>
                  S.emit("games move", { tableId: detail.id, move: { kind: "passTurn" } }),
              }, [el("i", { class: "fas fa-forward" }), " I'd rather not draw this"]),
            );
          } else {
            promptEl.appendChild(
              el("span", { text: (g.drawerName || "Someone") + " is picking a word" }),
            );
          }
        } else if (g.phase === "drawing") {
          if (g.amDrawer) {
            promptEl.appendChild(el("span", { class: "gm-dg-label", text: "You are drawing" }));
            promptEl.appendChild(el("span", { class: "gm-dg-word", text: g.word || "" }));
          } else {
            promptEl.appendChild(
              el("span", { class: "gm-dg-label", text: (g.drawerName || "Someone") + " is drawing" }),
            );
            promptEl.appendChild(el("span", { class: "gm-dg-hint", text: g.hint || "" }));
          }
        } else if (g.phase === "reveal") {
          promptEl.appendChild(el("span", { class: "gm-dg-label", text: "It was" }));
          promptEl.appendChild(el("span", { class: "gm-dg-word", text: g.reveal || "" }));
          const n = g.guessed.length;
          promptEl.appendChild(
            el("span", {
              class: "gm-dg-label",
              text: n ? n + (n === 1 ? " person got it" : " people got it") : "Nobody got it",
            }),
          );
        }

        const iDraw = g.amDrawer && g.phase === "drawing";
        tools.style.display = iDraw ? "" : "none";
        canvas.classList.toggle("gm-dg-live", iDraw);

        const showGuess = t.seated && g.phase === "drawing" && !g.amDrawer;
        guessWrap.style.display = showGuess ? "" : "none";
        if (showGuess) {
          guessHint.textContent = "";
          if (g.canGuess) {
            guessWrap.classList.remove("gm-dg-got");
            guessHint.appendChild(el("i", { class: "fas fa-lightbulb" }));
            guessHint.appendChild(
              el("span", { text: " What is it? Type your guess in the chat." }),
            );
          } else {
            guessWrap.classList.add("gm-dg-got");
            guessHint.appendChild(el("i", { class: "fas fa-circle-check" }));
            guessHint.appendChild(
              el("span", { text: " You got it. Chat while the rest catch up." }),
            );
          }
        }

        statusEl.textContent = "";
        if (g.phase === "drawing") {
          if (g.guessed.length) {
            const got = el("div", { class: "gm-dg-line" });
            got.appendChild(el("span", { class: "gm-dg-linelabel", text: "Got it" }));
            g.guessed.forEach((x) =>
              got.appendChild(
                el("span", { class: "gm-dg-gotchip" }, [
                  el("b", { text: "#" + x.place }),
                  x.username,
                ]),
              ),
            );
            statusEl.appendChild(got);
          }
          if (g.waitingOn && g.waitingOn.length) {
            const wait = el("div", { class: "gm-dg-line" });
            wait.appendChild(el("span", { class: "gm-dg-linelabel", text: "Waiting on" }));
            g.waitingOn.forEach((x) =>
              wait.appendChild(el("span", { class: "gm-dg-waitchip", text: x.username })),
            );
            if (g.canSkip && t.seated)
              wait.appendChild(
                el("button", {
                  class: "gm-btn gm-dg-skip" + (g.iSkipped ? " gm-dg-skipped" : ""),
                  title: "Move on without waiting",
                  onclick: () =>
                    S.emit("games move", { tableId: detail.id, move: { kind: "skip" } }),
                }, [
                  el("i", { class: "fas fa-forward" }),
                  g.iSkipped
                    ? " Waiting " + g.skipVotes + "/" + g.skipNeeded
                    : " Move on " + g.skipVotes + "/" + g.skipNeeded,
                ]),
              );
            statusEl.appendChild(wait);
          }
        }

        if (t.seated && !g.over) {
          const opt = el("div", { class: "gm-dg-optout" });
          opt.appendChild(
            el("button", {
              class: "gm-dg-optbtn" + (g.iNoDraw ? " active" : ""),
              onclick: () =>
                S.emit("games move", {
                  tableId: detail.id, move: { kind: "noDraw", on: !g.iNoDraw },
                }),
            }, [
              el("i", { class: g.iNoDraw ? "fas fa-check-square" : "far fa-square" }),
              g.iNoDraw ? " Sitting out the drawing" : " I'd rather not draw",
            ]),
          );
          statusEl.appendChild(opt);
        }
      },
    };

    function paintFinal(t, g) {
      lobbyEl.textContent = "";
      const card = el("div", { class: "gm-waiting gm-dg-lobbycard" });
      const ranked = (g.players || []).slice().sort((a, b) => b.score - a.score);
      const top = ranked[0];
      card.appendChild(
        el("div", {
          class: "gm-waiting-head",
          text: top && top.score ? top.username + " takes it" : "That is the lot",
        }),
      );
      const table = el("div", { class: "gm-dg-final" });
      ranked.forEach((p, i) => {
        table.appendChild(
          el("div", {
            class: "gm-dg-finalrow" + (p.userId === myId() ? " gm-dg-finalme" : ""),
          }, [
            el("span", { class: "gm-dg-finalpos", text: "#" + (i + 1) }),
            el("span", { class: "gm-dg-finalname", text: p.username }),
            el("span", { class: "gm-dg-finalpts", text: String(p.score) }),
          ]),
        );
      });
      card.appendChild(table);
      card.appendChild(
        el("div", {
          class: "gm-waiting-sub",
          text: "Ask for another game up in the bar, or head back for something else.",
        }),
      );
      lobbyEl.appendChild(card);
    }

    function paintLobby(t, g) {
      lobbyEl.textContent = "";
      const card = el("div", { class: "gm-waiting gm-dg-lobbycard" });
      card.appendChild(el("div", { class: "gm-waiting-pulse" }));
      card.appendChild(
        el("div", { class: "gm-waiting-head", text: "One more person and we start" }),
      );
      card.appendChild(
        el("div", {
          class: "gm-waiting-sub",
          text:
            "Draw & Guess needs two. Anyone in the room can join at any point, " +
            "even mid-round, so this is usually a short wait.",
        }),
      );

      const here = el("div", { class: "gm-dg-lobbyhere" });
      here.appendChild(el("span", { class: "gm-dg-linelabel", text: "Here" }));
      (t.seats || []).forEach((s) => {
        const chip = el("div", { class: "gm-dg-lobbychip" });
        const pfp = avatarNode(s.avatar, true);
        if (pfp) chip.appendChild(pfp);
        chip.appendChild(el("span", { text: s.username }));
        const badge = badgeFor(s.role);
        if (badge) chip.appendChild(badge);
        here.appendChild(chip);
      });
      card.appendChild(here);

      const others = roomUsers.filter(
        (u) => !(t.seats || []).some((s) => s.userId === u.id),
      ).length;
      card.appendChild(
        el("div", {
          class: "gm-dg-lobbyroom",
          text: others
            ? others === 1
              ? "1 other person is in the room. Your name shows as playing, so they can see where you went."
              : others +
                " other people are in the room. Your name shows as playing, so they can see where you went."
            : "Nobody else is in the room yet.",
        }),
      );

      const acts = el("div", { class: "gm-waiting-acts" });
      acts.appendChild(
        el("button", {
          class: "gm-btn",
          text: "Back to games",
          onclick: () => {
            S.emit("games leave", { tableId: t.id });
            backToFloor();
          },
        }),
      );
      card.appendChild(acts);
      lobbyEl.appendChild(card);
    }

    function paintSwatches() {
      if (!palette || !tools._swatches) return;
      const host = tools._swatches;
      if (host.childNodes.length === palette.length) return;
      host.textContent = "";
      palette.forEach((c, i) => {
        const b = el("button", {
          class: "gm-dg-swatch" + (i === color ? " active" : ""),
          "aria-label": "Colour " + (i + 1),
          onclick: () => {
            color = i;
            setTool("pen");
            host.querySelectorAll(".gm-dg-swatch").forEach((n, j) =>
              n.classList.toggle("active", j === i),
            );
          },
        });
        b.style.background = c;
        host.appendChild(b);
      });
    }

    function paintPapers() {
      if (!papers || !tools._papers) return;
      const host = tools._papers;
      host.textContent = "";
      papers.forEach((c, i) => {
        const b = el("button", {
          class: "gm-dg-paper" + (i === bg ? " active" : ""),
          "aria-label": "Background " + (i + 1),
          onclick: () =>
            S.emit("games move", { tableId: detail.id, move: { kind: "bg", index: i } }),
        });
        b.style.background = c;
        host.appendChild(b);
      });
    }
  };

  // ── Socket wiring ─────────────────────────────────────────────────────────

  function takeFloor(d) {
    floor = {
      tables: d.tables || [],
      counts: d.counts || {},
      pools: d.pools || {},
      myQueue: d.myQueue || {},
      myTables: d.myTables || {},
      myNext: d.myNext || [],
    };
  }

  S.on("games snapshot", (d) => {
    catalog = d.catalog || [];
    takeFloor(d);
    const mine = Object.values(floor.myTables || {})[0];
    if (isOpen && mine && view.name === "floor") {
      view = { name: "game", tableId: mine };
      detail = null;
    }
    render();
  });

  S.on("games shout", (d) => {
    if (!d || !d.tableId) return;
    if (isOpen && view.name === "game" && view.tableId === d.tableId) return;
    const jump = () => {
      openPanel();
      openGame(d.tableId);
    };
    if (window.StaffUI && window.StaffUI.toast) {
      const node = window.StaffUI.toast(d.text, {
        type: "info",
        title: d.name,
        timeout: 10000,
      });
      if (node) {
        node.style.cursor = "pointer";
        node.title = "Open " + d.name;
        node.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-tx")) return;
          jump();
        });
      }
      return;
    }
    if (window.toastr)
      window.toastr.info(d.text, d.name, { timeOut: 10000, onclick: jump });
  });

  let reannounce = null;

  function backToGames() {
    if (!reannounce) return;
    clearTimeout(reannounce);
    reannounce = null;
    if (!isOpen) return;
    boardKey = "";
    detail = null;
    view = { name: "floor", tableId: null };
    S.emit("games open");
    render();
  }

  S.on("connect", () => {
    if (!isOpen || reannounce) return;
    reannounce = setTimeout(backToGames, 3000);
  });
  S.on("room joined", backToGames);
  S.on("spectate joined", backToGames);

  S.on("games floor", (d) => {
    takeFloor(d);
    if (!isOpen) return;
    if (view.name === "game" && !floor.tables.some((t) => t.id === view.tableId)) {
      view = { name: "floor", tableId: null };
      detail = null;
    }
    if (pendingJoin && view.name === "floor") {
      const seat = (floor.myTables || {})[pendingJoin];
      if (seat) {
        pendingJoin = null;
        return openGame(seat);
      }
      if ((floor.myQueue || {})[pendingJoin]) {
        const live = floor.tables.filter((t) => t.type === pendingJoin);
        const t = live.find((x) => x.state === "playing") || live[live.length - 1];
        if (t) {
          pendingJoin = null;
          S.emit("games spectate", { tableId: t.id, on: true });
          return openGame(t.id);
        }
      }
    }
    render();
  });

  S.on("games table", (d) => {
    if (!d || !d.id) return;
    if (isOpen && view.name !== "game" && d.seated)
      view = { name: "game", tableId: d.id };
    if (view.tableId !== d.id) return;
    detail = d;
    render();
  });

  S.on("games relay", (d) => {
    if (!board || !detail || d.tableId !== detail.id) {
      if (view.tableId === d.tableId) {
        earlyRelays.push(d);
        if (earlyRelays.length > 40) earlyRelays.shift();
      }
      return;
    }
    if (side && side.relay) side.relay(d);
    if (board && board.relay) board.relay(d);
  });

  S.on("games feedback", (d) => {
    if (!board) return;
    if (d.accepted && board.feedbackMsg)
      board.feedbackMsg(d.accepted + "  +" + d.pts, true);
    else if (d.correct && board.say)
      board.say("Correct, +" + d.pts + " points", true);
    else if (d.close && board.say && detail && detail.type !== "drawguess")
      board.say("So close", false);
    else if (d.correct === false && board.say && detail && detail.type !== "drawguess")
      board.say(d.known ? "That is a country, but not this one" : "Not it", false);
  });

  S.on("games error", (d) => {
    const msg = (d && d.message) || "That did not work.";
    toast(msg, "error");
  });

  S.on("games timeout", (d) =>
    toast(
      "Your move ran out of time, so one was played for you." +
        (d && d.warning === 1 ? " Miss another and you lose the seat." : ""),
      "info",
    ),
  );

  S.on("games seat lost", (d) => {
    toast(
      (d.winnerName ? d.winnerName + " kept the board. " : "") +
        "Join " + nameOf(d.type) + " again to get back in.",
      "info",
    );
    if (isOpen && view.tableId === d.tableId) {
      view = { name: "floor", tableId: null };
      detail = null;
      render();
    }
  });

  S.on("games closed", (d) => {
    if (d.reason === "voted-out")
      toast("The other players voted you out of that game.", "error");
    else if (d.reason === "idle")
      toast("You missed two moves in a row, so the seat went to somebody waiting.", "info");
    if (isOpen && view.tableId === d.tableId) {
      view = { name: "floor", tableId: null };
      detail = null;
      render();
    }
  });

  S.on("games challenge", (d) => {
    const body = d.from + " wants to play " + d.gameName + " with you.";
    const answer = (yes) => {
      S.emit("games challenge respond", { id: d.id, accept: !!yes });
      if (yes) openPanel();
    };
    if (window.StaffUI && window.StaffUI.confirm) {
      window.StaffUI.confirm({
        title: "Game invite",
        message: body,
        icon: '<i class="fas fa-gamepad"></i>',
        confirmText: "Let's play",
        cancelText: "Not now",
      }).then(answer);
    } else answer(window.confirm(body));
  });

  S.on("games challenge result", (d) => {
    if (d.accepted) toast((d.by || "They") + " accepted, the game is starting.", "success");
    else if (d.expired) toast("Your invite expired.", "info");
    else toast((d.by || "They") + " passed this time.", "info");
  });

  S.on("room update", (d) => {
    if (d && Array.isArray(d.users)) roomUsers = d.users;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen) return;
    if (view.name === "game" || view.name === "solo") backToFloor();
    else closePanel();
  });

  window.TalkomaticGames = {
    open: openPanel,
    close: closePanel,
    isOpen: () => isOpen,
  };
})();
