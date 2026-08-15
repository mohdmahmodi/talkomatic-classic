// public/js/games-client.js
// Mini games panel. Talks to server/games over the room socket, no second
// connection.
//
// Two views. The floor picks a game and shows what is happening in the room.
// The game view is a split: the board on the left, players and chat on the
// right, stacking on a phone.
//
// Boards are objects with mount/update so a state push never rebuilds the DOM
// under a focused input or wipes the drawing canvas. The chat log and the
// board both patch in place for the same reason.

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

  // Other people's words are masked here, per viewer, using the room's own
  // filter and its on/off switch. The server sends what was actually typed.
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

  // A game icon is { emoji }, { fa } or { image }, so a new game can use
  // whichever it has to hand.
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

  // Staff flair, matching the room's own badges. Roles are stamped by the
  // server from the room record, so these cannot be faked from a client.
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

  // Shared loading state. Some of the standalone games pull a few hundred KB
  // of images and audio, so a blank panel reads as broken.
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
  let side = null; // players + chat controller for the open game
  let clockTimer = null;
  let cleanupSolo = null; // timers for a solo game's loading state
  let earlyRelays = []; // relays that landed before the board was ready
  let pendingJoin = null; // a game we just pressed play on, awaiting a board

  // The chat can be folded away to give the board the room, which is the
  // difference between playable and cramped on a phone. Remembered per device,
  // and starts folded on a small screen.
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
      /* private mode, the toggle just will not stick */
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
    // Deliberately no click-outside-to-close: people were losing a game they
    // were in the middle of by clicking next to the panel.
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

  // Closing the panel gives up everything you were holding. Keeping the seat
  // meant somebody could shut the panel, walk off, and go on blocking the
  // rotation with a name nobody could reach and a room textbox still saying
  // they were playing. Escape steps back to the floor instead of closing, so
  // there is still a way out of a board that does not cost you the game.
  function closePanel() {
    for (const tableId of Object.values(floor.myTables || {}))
      S.emit("games leave", { tableId });
    for (const type of Object.keys(floor.myQueue || {}))
      S.emit("games queue leave", { type });
    // Any claim on a next round goes back too, whichever board it was on.
    for (const tableId of floor.myNext || [])
      S.emit("games play next", { tableId, on: false });
    // Give the watch slot back, otherwise the count keeps counting you.
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
    // Boards with their own clock paint it themselves, four times a second.
    if (board && board.clock) board.clock();
  }

  function render() {
    if (!isOpen || !bodyEl) return;
    if (view.name === "solo") return; // the frame owns the body until they go back
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

    // One list, not two. Splitting boards into "happening now" and "waiting to
    // start" made people read the same game twice and work out which half they
    // wanted; the row itself already says which it is. Boards you are sitting
    // at come first, since that is what you are most likely looking for.
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

  // Standalone games under public/games. Same three row card as the rest.
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

  // Solo games run in their own frame inside the panel, so the room socket and
  // the chat behind it stay put.
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
    // The load event waits on every last image and script, and some of these
    // games pull a big library from a CDN. Watch readyState too so the spinner
    // clears the moment the game is actually usable.
    const poll = setInterval(() => {
      if (done) return clearInterval(poll);
      try {
        if (frame.contentDocument && frame.contentDocument.readyState === "complete")
          ready();
      } catch (_) {}
    }, 150);
    // Say something rather than sitting on a bare spinner.
    const slow = setTimeout(() => {
      if (done) return;
      const sub = loading.querySelector(".gm-loading-sub");
      const msg = "Fetching this game's pictures and sounds.";
      if (sub) sub.textContent = msg;
      else loading.appendChild(el("div", { class: "gm-loading-sub", text: msg }));
    }, 2500);
    // Belt and braces: never leave a spinner up for ever.
    const bail = setTimeout(ready, 15000);
    cleanupSolo = () => {
      clearInterval(poll);
      clearTimeout(slow);
      clearTimeout(bail);
    };
    bodyEl.appendChild(wrap);
  }

  // One column, three rows: who it is, what you do, what it costs you.
  // The icon sits inline with the title rather than owning a column, which is
  // what squashed the text into a ribbon before.
  function gameCard(g) {
    const c = (floor.counts && floor.counts[g.id]) || {
      playing: 0, waiting: 0, live: 0, names: [],
    };
    const myPos = floor.myQueue[g.id] || 0;
    const myGame = floor.myTables[g.id] || null;

    const card = el("div", {
      class: "gm-card" + (myGame ? " gm-card-mine" : ""),
    });

    // Row 1: icon, name, description
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

    // Row 2: the action, and who is in there right now
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
          // Remembered so the floor can walk us into the board as soon as one
          // exists. Pressing play and being left on the list wondering whether
          // anything happened was the confusing part.
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

    // Row 3: the small print, and inviting somebody by name
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

    // Names, not "seats". A person reads names.
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
    // If we are not playing in it, looking at it means watching it, so the
    // count is honest and the chat works without a second click.
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
    pendingJoin = null; // they changed their mind, do not drag them back in
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

      // Draw & Guess sizes itself to the space rather than scrolling, on a
      // phone as well as a desktop. So does anything else on a canvas.
      const fits =
        t.type === "drawguess" || t.type === "flagguess" || t.type === "pong";
      main.classList.toggle("gm-main-fit", fits);
      split.classList.toggle("gm-split-fit", fits);
      board = BOARDS[t.type] ? BOARDS[t.type]() : null;
      if (board) board.mount(main);
      side = makeSide();
      side.mount(sideEl);
      boardKey = key;

      // Replay anything that arrived while this was being built.
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
    // Only when the board itself cannot run yet, never mid-match.
    const short = t.state === "open" && !t.game && !t.reservedFor;
    main.classList.toggle("gm-main-waiting", short);
    if (short) slot.appendChild(waitingPanel(t));
  }

  // The result, said plainly and at full width. Nobody should have to work out
  // whether they won from a timer in the corner.
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

  // Where you stand, in words, before anything else on the bar. "Waiting" and
  // "watching" on their own left people unsure whether they were in the game
  // at all, so this always says which one you are and what you can do next.
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

    if (t.state === "finished") return; // the banner is saying the rest
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
      // The count shows as soon as anybody asks, not only once you have. Not
      // seeing that the other person was already waiting on you was the whole
      // reason this button felt dead.
      const asked = (t.rematch || []).length;
      const wants = (t.rematch || []).indexOf(myId()) >= 0;
      const gm = gameById(t.type);
      // In the timed games everyone who asks plays on and the board stays open
      // for anybody else, so this is not a vote and must not read like one.
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
      // Watching a round you cannot join yet: claim a seat for the next one
      // rather than having to spot the moment it ends and race for it.
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

  // Shown in place of the board while a game is short of players, so somebody
  // who started one sits at their own board instead of watching a queue number.
  function waitingPanel(t) {
    const g = gameById(t.type);
    const box = el("div", { class: "gm-waiting" });
    box.appendChild(el("div", { class: "gm-waiting-pulse" }));
    // Says plainly that they are already in it. "Waiting" on its own read as
    // if they were queuing for a seat rather than sitting in one.
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

    // Whether the log follows new messages. Measuring "am I at the bottom?" at
    // the moment a line arrives was not enough: one tall line with an avatar is
    // most of the threshold, and a picture finishing loading after the line was
    // added moved the floor out from under it. So the state is tracked from the
    // person's own scrolling instead, and the jump happens after layout.
    let pinned = true;
    let missed = 0;

    function nearBottom() {
      return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
    }

    function toBottom() {
      logEl.scrollTop = logEl.scrollHeight;
      // Again next frame, so an avatar or an emote that changes the height
      // after paint cannot leave the newest line half off the bottom.
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

    // Only shown when they have scrolled up and something arrived meanwhile.
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
        // Avatar, badge and name live in one cell so the grid stays two
        // columns and a long message wraps under itself, not around the name.
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
        // Keep what was actually said so flipping the filter can re-render it
        // without asking the server again.
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

        // The roster folds away. On a phone it was taking a third of the panel
        // and leaving the chat a slot to type into, so it starts folded there.
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
            /* private mode: it just will not stick */
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
        // Follow the newest message unless they have deliberately scrolled up
        // to read something. Their own scrolling is what decides it.
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

      // Appended live so the log never jumps while you are reading it.
      relay(payload) {
        if (payload.kind === "chat" && payload.message) {
          if (payload.message.id <= lastChatId) return;
          lastChatId = payload.message.id;
          addLine(payload.message);
          // Folded away, so say how much is piling up behind the button.
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
        // Player list. Draw & Guess carries its own richer roster.
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
          // Who has already asked for another game, so nobody is left guessing
          // whether the other side is still there.
          if (t.state === "finished" && (t.rematch || []).indexOf(p.userId) >= 0)
            row.appendChild(
              el("i", {
                class: "fas fa-rotate-right gm-wants",
                title: p.username + " wants a rematch",
              }),
            );
          // Sitting out the drawing shows here rather than in the chat, which
          // is where it used to be until people found the switch.
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

          // Vote somebody out, only ever offered to the people playing.
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

        // Who has claimed a seat for the next round. Shown to the people
        // playing too, so a winner knows somebody is waiting on them.
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

        // Who is watching. Names, not just a number, so the room can see who
        // turned up. Anyone watching can talk in the chat below.
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

        // Backfill history the first time this game opens.
        if (!lastChatId && Array.isArray(t.chat)) {
          t.chat.forEach((m) => {
            lastChatId = Math.max(lastChatId, m.id);
            addLine(m);
          });
          repin(); // opening a game always lands on the newest message
        }
        paintTyping(t.typing || []);
      },
    };

    // The filter toggle flipped while this panel was open: repaint what is
    // already on screen from the raw text we kept.
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

  // Pong --------------------------------------------------------------------
  // This board simulates the match. It does not replay one.
  //
  // The oldest rule in netcode is that you see yourself in the present and
  // everybody else in the past. The board this replaces drew EVERYTHING in the
  // past - your own paddle included - on a clock deliberately held ~100ms
  // behind the server so there were always two snapshots either side of the
  // render moment to interpolate between. Two complaints followed from that
  // one decision, and neither was ever going to be tuned away:
  //
  //   - The paddle answered your hand a tenth of a second late. That is the
  //     "laggy" feeling, and it was not a symptom of anything. It was the
  //     design, working.
  //   - It was drawn by sampling a locally generated history THROUGH that
  //     clock, and the clock ran at anywhere from 0.75x to 1.5x real speed to
  //     stay locked to the server. So the paddle on screen sped up and slowed
  //     down several times a second while the hand moved evenly. That is the
  //     jitter, and it got worse the further away the server was.
  //
  // So the local paddle is now driven by the hand and by nothing else, at the
  // present instant, and the network never moves it. The ball is simulated
  // here as well, off the server's own rules and constants, so it bounces off
  // your paddle exactly where you can see your paddle - which is what stops it
  // reading as passing straight through. Only the opponent's paddle is still a
  // network object, because it is somebody else's hand and there is nothing to
  // predict it from.
  //
  // The server still decides every point; nothing here is trusted. When it
  // disagrees, the correction goes into the simulation immediately and the
  // size of the jump goes into a visual offset that glides away over a few
  // frames. So the ball is always on the server's path, and is never seen
  // moving onto it. Correct the physics now, smooth the picture after - that
  // split is the only subtle thing in here, and it is how Rocket League does
  // it too.
  //
  // There is no render buffer here any more, and no render clock. Both existed
  // only to have snapshots either side of the drawing moment, and nothing is
  // drawn from snapshots now.
  const PG_CHEERS = ["👏", "🔥", "😱", "😂", "💪", "🎉"];
  const PG_SEND_MS = 20; // paddle intent sampled at fifty a second
  // A snapshot describes a moment that has already gone by the time it lands,
  // so it gets rolled forward to now before it is used. Past this the roll is
  // guesswork stacked on guesswork and the snapshot is taken at face value.
  const PG_MAX_AGE = 400;
  // The opponent's paddle is dead reckoned this far past the last word we had
  // on it and no further. It is somebody else's hand: it can change its mind
  // at any moment, and a long guess about a hand is just a wrong answer with
  // more confidence behind it.
  const PG_OPP_LEAD = 110;
  // A disagreement bigger than this is not a correction, it is a different
  // rally - rebuild from the server rather than glide onto it.
  const PG_BALL_SNAP = 16;
  // How fast the visual offset that hides a correction bleeds away. Two frames
  // at 60fps to lose 90% of it: fast enough that the ball is never visibly off
  // its true path, slow enough that no single frame contains a jump.
  const PG_OFF_BLEED = 0.04;
  // The clock is a decaying high water mark and this is how fast it gives
  // ground, per snapshot: about a third of a millisecond, ten a second. It is
  // only ever correcting for two machines' clocks running at fractionally
  // different rates, and being wrong about that in a hurry is worse than being
  // wrong about it slowly.
  const PG_OFF_DECAY = 0.35;
  // ?pongdebug=1 turns on the ghost paddle and a corner readout. Chasing this
  // by description alone cost several rounds of guessing at things that were
  // not wrong; the numbers that would have settled it in one message are the
  // frame rate, whether the local paddle is being driven by the hand or by the
  // wire, and how often the ball is being corrected.
  // Toggled by the button under the court, remembered between visits, and
  // still settable from the URL. Public on purpose: it costs nothing and it
  // means anybody reporting "it feels laggy" can report numbers instead.
  let PG_DEBUG =
    /pongdebug/.test(location.search + location.hash) ||
    (function () {
      try {
        return localStorage.getItem("tk-pong-debug") === "1";
      } catch (_) {
        return false;
      }
    })();

  BOARDS.pong = function () {
    let root, canvas, ctx, courtBox, wrapEl, floatEl;
    let nameL, nameR, ptsL, ptsR, midEl, rallyEl;
    let matchKey = "";
    let padsEl, cheerEl, lineupEl, hintEl, dbgBtn, copyEl, saveEl;
    let ro = null, raf = null, sendTimer = null;
    let cssFont = "sans-serif";

    // Court geometry AND the bounce constants come off the wire, so none of the
    // rules are written down twice.
    let C = {
      w: 200, h: 120, wall: 4, paddleW: 2.4, paddleH: 22, ballR: 1.9,
      paddleSpeed: 320, keySpeed: 260, maxSpeed: 175, baseSpeed: 70,
      speedStep: 1.05, bounceMax: Math.PI / 3, spin: 0.14, spinCap: 175, minVy: 0.06,
    };
    let target = 7;
    let mySide = -1;
    let players = [];

    let last = null; // newest snapshot: scores, phase, serve clock
    let offset = 0, bestOff = 0, haveOffset = false;

    // The simulation. This is the match as far as this browser is concerned,
    // and it is what gets drawn.
    const sim = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, past: false, phase: "serve", ok: false };
    // Where the ball has been, in server time, so an arriving snapshot can be
    // compared against the same moment rather than against the present one.
    const simHist = [];
    // The gap between where the ball was drawn and where it turned out to be.
    // Carried and bled out rather than applied, so a correction is never a jump.
    let offX = 0, offY = 0;

    // Both paddles. The local one is driven by the hand; the other by the wire.
    const padY = [null, null];
    const padPrev = [null, null];
    const padVy = [0, 0];
    // Every position the server has reported for each paddle, with the moment
    // it belongs to. The one that is not ours is drawn from these by sitting
    // between two of them - so it is only ever shown somewhere it has actually
    // been, which is the whole reason it cannot fly about.
    const netBuf = [[], []];
    const netY = [null, null]; // newest reported, for the ghost
    // How far in the past the far paddle is drawn: enough to keep a real
    // sample on both sides of the drawing moment. Measured, because guessing
    // low means holding still constantly and guessing high is needless lag on
    // the one paddle that has any.
    let netDelay = 50;
    let gapMax = 20, lateMax = 12;

    let myWant = null, myDir = 0;
    let sentY = null, sentDir = 0, lastSentAt = 0;
    let seq = 0;
    let upHeld = false, downHeld = false;

    let shake = 0, lastPaint = 0;
    let dbgFrames = 0, dbgAt = 0, dbgFps = 0, dbgFix = 0, dbgRate = 0;
    let dbgFixSum = 0, dbgHard = 0, dbgHardRate = 0, dbgErr = 0, dbgGap = 0;
    // A rolling flight recorder. Always on, four samples a second, about three
    // minutes deep. Costs nothing and means a report is a paste rather than a
    // description - which is what the last several rounds of this needed.
    const rec = [];
    // Every crossing of the ball over this player's own paddle plane, with
    // the exact geometry and the verdict. The one moment 4Hz sampling can
    // never catch, and the only moment that decides a point.
    const xing = [];
    let recAt = 0, recT0 = 0;
    let needScore = false; // a frame changed the score; redraw the scoreline
    const rings = [];
    let hitGlow = [0, 0], sideFlash = [0, 0];

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    function serverNow() {
      return Date.now() + offset;
    }

    // Do I drive my own paddle this frame?
    //
    // This used to also require detail.state === "playing" and detail.seated.
    // Both come off a table snapshot that is only sent on discrete events -
    // somebody joining, a match starting - while the game itself runs at 30Hz.
    // So for any stretch where that snapshot was stale, missing or simply
    // hadn't arrived yet, this returned false and the paddle SILENTLY fell
    // through to the network path: drawn interpolated in the past, at the far
    // end of a round trip. Which is precisely the lag being reported, and the
    // readout caught it saying WIRE mid-rally.
    //
    // mySide comes off the game view itself, in the same payload as the court,
    // so it moves with the game rather than alongside it. And nothing here is
    // trusted anyway: realtimeInput on the server refuses input from anyone
    // who is not seated at a table that is actually playing. There is no
    // reason for this end to second-guess that, and a great deal of harm in
    // getting it wrong.
    function canControl() {
      return mySide >= 0;
    }

    // Kept only so the recorder can say which condition WOULD have blocked
    // control, if we ever have to ask this question again.
    function controlWhy() {
      if (mySide < 0) return "noseat";
      if (!detail) return "nodetail";
      if (!detail.seated) return "notseated";
      if (detail.state !== "playing") return "state:" + detail.state;
      return "ok";
    }

    // A new match, or sitting down at one we were watching. Everything here
    // describes a game that no longer exists, and left alone the simulation
    // would fly the previous ball across the new court until the first
    // snapshot caught up with it.
    //
    // The intent numbering deliberately does NOT restart. A new match starts
    // the server's side of it back at zero, and an intent still in the wire
    // from the old match lands on that and sets it to whatever that intent was
    // numbered. If this browser had gone back to one, everything it sent
    // afterwards would look older than that and be refused as a stale
    // reorder - a paddle that never moves again for the whole match. Counting
    // on past it costs nothing and cannot collide.
    function reset() {
      last = null;
      sim.ok = false;
      sim.past = false;
      sim.phase = "serve";
      simHist.length = 0;
      rings.length = 0;
      offX = offY = 0;
      padY[0] = padY[1] = null;
      padPrev[0] = padPrev[1] = null;
      padVy[0] = padVy[1] = 0;
      netY[0] = netY[1] = null;
      netBuf[0].length = 0;
      netBuf[1].length = 0;
      hitGlow[0] = hitGlow[1] = 0;
      myWant = null;
      myDir = 0;
      sentY = null;
      sentDir = 0;
      upHeld = downHeld = false;
    }

    // ── Clock ──
    // Only one thing still needs the server's clock: working out how old a
    // snapshot is, so it can be rolled forward to now and compared against the
    // right moment. Nothing is drawn against it any more.
    //
    // The quickest snapshot to arrive is the one that spent least time in the
    // wire, so its offset is the closest thing to where the server's clock
    // actually is. Held as a decaying high water mark rather than a maximum
    // over a window: a window is hostage to its single luckiest sample and
    // holds a stale answer until that sample ages out.
    function noteClock(t) {
      const off = t - Date.now();
      if (!haveOffset) {
        bestOff = off;
        offset = off;
        haveOffset = true;
        return;
      }
      if (off > bestOff) bestOff = off;
      else bestOff -= PG_OFF_DECAY;
      // Slewed, never assigned, so it cannot step.
      offset += clamp(bestOff - offset, -1.5, 1.5);
    }

    function ageOf(t) {
      return clamp(serverNow() - t, 0, PG_MAX_AGE);
    }

    // ── The simulation ──
    // The server's rules, run here. bounceSim is a line for line port of
    // bounce() in server/games/pong.js, off the same constants, which is why
    // those constants travel on the wire with the court.

    function paddleAt(i, k) {
      const a = padPrev[i], b = padY[i];
      if (a == null || b == null) return b == null ? a : b;
      return a + (b - a) * k;
    }

    function bounceSim(idx, py, quiet) {
      const off = clamp((sim.y - py) / (C.paddleH / 2), -1, 1);
      const speed = Math.min(C.maxSpeed, sim.speed * C.speedStep);
      const away = idx === 0 ? 1 : -1;

      let vx = Math.cos(off * C.bounceMax) * speed * away;
      let vy =
        Math.sin(off * C.bounceMax) * speed +
        clamp(padVy[idx], -C.spinCap, C.spinCap) * C.spin;

      const mag = Math.hypot(vx, vy) || speed;
      vx = (vx / mag) * speed;
      vy = (vy / mag) * speed;

      const minVx = Math.cos(C.bounceMax) * speed;
      if (Math.abs(vx) < minVx) {
        vx = away * minVx;
        vy = Math.sign(vy || 1) * Math.sqrt(Math.max(0, speed * speed - vx * vx));
      }
      const minVy = speed * C.minVy;
      if (Math.abs(vy) < minVy) {
        const tip = off !== 0 ? Math.sign(off) : sim.vy !== 0 ? Math.sign(sim.vy) : 1;
        vy = tip * minVy;
        vx = away * Math.sqrt(Math.max(0, speed * speed - vy * vy));
      }

      sim.speed = speed;
      sim.vx = vx;
      sim.vy = vy;
      sim.x =
        idx === 0
          ? C.wall + C.paddleW + C.ballR + 0.01
          : C.w - C.wall - C.paddleW - C.ballR - 0.01;
      if (!quiet) {
        hitGlow[idx] = 1;
        ring(sim.x, sim.y, false);
        shake = Math.max(shake, 0.7);
      }
    }

    // One swept step. Walked to the first thing it actually touches rather
    // than sampled, because at full speed the ball covers more ground in a
    // frame than a paddle is thick and sampling would put it through one.
    //
    // quiet suppresses the flashes: a roll forward is catching up on time that
    // has already happened, and firing a bounce for it would light the court up
    // for something the player watched a moment ago.
    function stepBall(dt, quiet) {
      if (!sim.ok || sim.phase !== "live" || dt <= 0) return;
      const r = C.ballR;
      const lp = C.wall + C.paddleW + r;
      const rp = C.w - C.wall - C.paddleW - r;
      let left = dt;
      let guard = 0;
      while (left > 1e-6 && guard++ < 8) {
        let span = left;
        let hit = null;

        if (sim.vy < 0) {
          const t = (r - sim.y) / sim.vy;
          if (t >= 0 && t < span) { span = t; hit = "wall"; }
        } else if (sim.vy > 0) {
          const t = (C.h - r - sim.y) / sim.vy;
          if (t >= 0 && t < span) { span = t; hit = "wall"; }
        }

        // Once it is behind a paddle that plane is finished with for this
        // point, or the crossing keeps solving at zero and the loop spins.
        if (!sim.past) {
          if (sim.vx < 0) {
            const t = (lp - sim.x) / sim.vx;
            if (t >= 0 && t < span) { span = t; hit = 0; }
          } else if (sim.vx > 0) {
            const t = (rp - sim.x) / sim.vx;
            if (t >= 0 && t < span) { span = t; hit = 1; }
          }
        }

        sim.x += sim.vx * span;
        sim.y += sim.vy * span;
        left -= span;

        if (hit === "wall") {
          sim.vy = -sim.vy;
          sim.y = clamp(sim.y, r, C.h - r);
          if (!quiet) ring(sim.x, sim.y, false);
          continue;
        }
        if (hit === 0 || hit === 1) {
          // Both paddles are settled here, off the position each one is drawn
          // at. That keeps the picture honest at both ends: the ball bounces
          // off a paddle you can see, and goes past one you can see it miss.
          //
          // A version of this waited on the far face instead, on the grounds
          // that the opponent's paddle is only known in the past and guessing
          // its angle is a guess. True, but the cure was worse: the ball
          // visibly stopped dead at their paddle for a downlink, then jumped,
          // and when they had missed it stalled there and a point appeared out
          // of nowhere. The far end is a whole court away from the person
          // playing, the server corrects it within one snapshot, and a wrong
          // angle out there is cheaper than the ball hitching every rally.
          // Where the paddle had got to when the ball crossed, not where it
          // ended the frame. A paddle covers more than its own thickness in a
          // frame, so testing the end position turns fair edge hits into
          // misses - the same reason the server keeps yPrev.
          const py = paddleAt(hit, dt > 0 ? clamp((dt - left) / dt, 0, 1) : 1);
          const returned =
            py != null && Math.abs(sim.y - py) <= C.paddleH / 2 + C.ballR;
          // The crossing journal. "It hit my paddle dead centre and they got
          // the point" cannot be adjudicated from 4Hz samples, so the moment
          // itself is recorded: what this simulation ruled, exactly where the
          // ball and the paddle were, and how far the DRAWN ball (sim plus
          // the gliding correction offset) was from the simulated one. When
          // a score lands moments later, takeFrame stamps the outcome on it.
          if (hit === mySide && !quiet) {
            xing.push({
              at: performance.now(),
              t: recT0 ? Math.round(performance.now() - recT0) : 0,
              ruled: returned ? "RETURN" : "MISS",
              by: Math.round(sim.y * 10) / 10,
              offY: Math.round(offY * 10) / 10,
              py: py == null ? null : Math.round(py * 10) / 10,
              srv: netY[hit] == null ? null : Math.round(netY[hit] * 10) / 10,
              miss: py == null ? null :
                Math.round(Math.max(0,
                  Math.abs(sim.y - py) - (C.paddleH / 2 + C.ballR)) * 10) / 10,
              out: "",
            });
            while (xing.length > 40) xing.shift();
          }
          if (returned) bounceSim(hit, py, quiet);
          else sim.past = true;
          continue;
        }
      }
      // Off the end of the court: the ball just keeps going. Whether that is a
      // point is the server's call and it will say so in a moment.
    }

    // My paddle. The hand, the speed cap, and nothing else - no network term
    // anywhere in here, which is the entire point.
    function stepMine(dt) {
      const i = mySide;
      if (i < 0 || padY[i] == null) return;
      let want = padY[i];
      // Same split the server makes: pointing at a spot means go there, and
      // holding a key means travel at a speed you can steer.
      let rate = C.paddleSpeed;
      if (myDir) {
        want = padY[i] + myDir * C.h;
        rate = C.keySpeed || C.paddleSpeed;
      } else if (myWant != null) want = myWant;
      const room = rate * dt;
      const ny = clamp(
        padY[i] + clamp(want - padY[i], -room, room),
        C.paddleH / 2,
        C.h - C.paddleH / 2,
      );
      padVy[i] = dt > 0 ? (ny - padY[i]) / dt : 0;
      padY[i] = ny;
    }

    // Somebody else's paddle. Drawn a little way in the past, BETWEEN two
    // positions the server actually reported, and never one step beyond the
    // newest one.
    //
    // The version this replaces dead reckoned it forward instead, off a
    // velocity worked out from two snapshots 33ms apart. That velocity is
    // almost pure noise: a hand that moves five units between two snapshots
    // reads as 150 units a second, which threw the paddle sixteen units past
    // where anybody had ever seen it, and then the next snapshot whipped it
    // back. That is the opponent "flying around", and it was not the network -
    // it was this function guessing.
    //
    // A hand cannot be predicted. There is no keypress to run forward and no
    // model of what somebody is about to do. So this does not try: between two
    // real samples it interpolates, past the newest one it holds still and
    // waits. Holding is honest and looks like a paddle that stopped, which is
    // usually exactly what happened.
    function netAt2(i, tt) {
      const b = netBuf[i];
      if (!b.length) return null;
      if (tt <= b[0].t) return b[0].y;
      for (let k = b.length - 1; k > 0; k--) {
        if (b[k - 1].t <= tt && tt <= b[k].t) {
          const span = b[k].t - b[k - 1].t;
          const q = span > 0 ? clamp((tt - b[k - 1].t) / span, 0, 1) : 1;
          return b[k - 1].y + (b[k].y - b[k - 1].y) * q;
        }
      }
      return b[b.length - 1].y; // past the newest sample: hold, do not guess
    }

    function stepNet(i, dt) {
      const want = netAt2(i, serverNow() - netDelay);
      if (want == null) return;
      if (padY[i] == null) {
        padY[i] = want;
        padVy[i] = 0;
        return;
      }
      // Interpolation between real samples is smooth already; this only takes
      // the edge off the moment fresh data arrives after a hold.
      const room = C.paddleSpeed * dt * 1.6;
      const ny = clamp(
        padY[i] + clamp(want - padY[i], -room, room),
        C.paddleH / 2,
        C.h - C.paddleH / 2,
      );
      padVy[i] = dt > 0 ? (ny - padY[i]) / dt : 0;
      padY[i] = ny;
    }

    function stepAll(dt) {
      padPrev[0] = padY[0];
      padPrev[1] = padY[1];
      for (let i = 0; i < 2; i++) {
        if (i === mySide && canControl()) stepMine(dt);
        else stepNet(i, dt);
      }
      stepBall(dt, false);
      const at = serverNow();
      if (!simHist.length || at > simHist[simHist.length - 1].t)
        simHist.push({ t: at, x: sim.x, y: sim.y, vx: sim.vx, vy: sim.vy });
      while (simHist.length > 120) simHist.shift();
    }

    // Where the ball is actually drawn: the simulation, plus the offset that
    // is still gliding off from the last correction.
    //
    // The offset is cosmetic, and it is not allowed to tell a lie about the
    // one thing this whole board exists to show. Nudging the ball a couple of
    // units to smooth a correction can nudge it BEHIND the face of a paddle it
    // has not actually passed, and a ball drawn inside a paddle is exactly the
    // picture people mean when they say it went straight through. Measured, it
    // was most of them: only a handful of the crossings behind a covering
    // paddle were real misses, the rest were this. So the smoothing may move
    // the ball anywhere it likes except through something.
    function drawnBall() {
      let x = sim.x + offX;
      if (!sim.past)
        x = clamp(
          x,
          C.wall + C.paddleW + C.ballR,
          C.w - C.wall - C.paddleW - C.ballR,
        );
      return { x, y: clamp(sim.y + offY, C.ballR, C.h - C.ballR) };
    }

    // Null, not a guess, when the history does not reach back that far.
    //
    // This used to hand back the oldest entry it had for any moment before it,
    // and that is a different ball at a different time being passed off as the
    // right one. Every hardSet empties this history, so the very next snapshot
    // - which describes a moment one downlink ago - got compared against the
    // ball as it is NOW, and the several units the ball had travelled in
    // between were read as an error and corrected. A wrong correction, on
    // every rebuild. That is the ball jitter, and it is worse the further away
    // the server is, because the gap it invents is exactly the downlink.
    function simAt(tt) {
      if (simHist.length < 2) return null;
      if (tt < simHist[0].t) return null;
      for (let i = simHist.length - 1; i >= 0; i--) {
        if (simHist[i].t > tt) continue;
        const a = simHist[i], b = simHist[i + 1];
        if (!b) return a;
        const span = b.t - a.t;
        if (span <= 0) return a;
        const k = clamp((tt - a.t) / span, 0, 1);
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          vx: a.vx,
          vy: a.vy,
        };
      }
      return simHist[0];
    }

    // ── Snapshots ──
    // Not drawn. Used to correct.

    // Take the server's word entirely and roll it forward to now.
    function hardSet(f) {
      // Only a mid-rally rebuild is trouble worth counting. Between points the
      // ball is deliberately reset from every snapshot, and counting those had
      // the report shouting "rebuilt 60/s" on every serve of a healthy match.
      if (f.ph === "live") dbgHard++;
      sim.x = f.b[0];
      sim.y = f.b[1];
      sim.vx = f.b[2];
      sim.vy = f.b[3];
      sim.speed = f.sp || C.baseSpeed;
      sim.phase = f.ph;
      sim.past =
        f.b[0] < C.wall + C.paddleW || f.b[0] > C.w - C.wall - C.paddleW;
      sim.ok = true;
      simHist.length = 0;
      stepBall(ageOf(f.t) / 1000, true);
    }

    function takeFrame(f) {
      if (!f || !Array.isArray(f.b) || !Array.isArray(f.p)) return;
      if (last && f.t <= last.t) return; // out of order or a repeat
      noteClock(f.t);

      const scored = last && (f.s[0] !== last.s[0] || f.s[1] !== last.s[1]);
      const turned = !last || f.ph !== last.ph;

      // How far apart the snapshots are, and how unevenly they land. The far
      // paddle has to be drawn far enough back that one gap plus that
      // unevenness still leaves a real sample on the far side of the drawing
      // moment, or it spends its time held still at the newest one.
      //
      // Both are decaying high water marks: a window maximum is hostage to its
      // single worst sample and holds a stale answer until that ages out.
      const gap = last ? f.t - last.t : 0;
      if (gap > 0) gapMax = Math.max(gap, gapMax * 0.99);
      lateMax = Math.max(
        clamp(serverNow() - f.t, 0, 300),
        lateMax * 0.97,
      );
      // Floor of 30: at 60Hz snapshots the gap term is ~17ms, so a healthy
      // link settles near the floor and the far paddle is a frame or two back
      // instead of three.
      netDelay = clamp(gapMax + lateMax * 0.5 + 8, 30, 150);

      for (let i = 0; i < 2; i++) {
        netY[i] = f.p[i];
        const b = netBuf[i];
        if (!b.length || f.t > b[b.length - 1].t) b.push({ t: f.t, y: f.p[i] });
        while (b.length > 48) b.shift();
        if (padY[i] == null || (i === mySide && !canControl())) padY[i] = f.p[i];
      }

      if (scored) {
        // Stamp the outcome on the crossing it belongs to, so the journal
        // reads "ruled RETURN ... point against you" when the two disagree.
        const side0Scored = f.s[0] !== (last ? last.s[0] : 0);
        const against =
          mySide >= 0 && (side0Scored ? mySide === 1 : mySide === 0);
        for (let i = xing.length - 1; i >= 0; i--) {
          if (performance.now() - xing[i].at > 900) break;
          if (!xing[i].out) {
            xing[i].out = (against ? "POINT AGAINST YOU" : "you scored") +
              ", server ball y " + f.b[1];
            break;
          }
        }
        fire({ k: "point", side: side0Scored ? 1 : 0 });
        // Repaint the scoreline HERE, off the frame that carries the new score.
        //
        // It used to be repainted only from update(), which runs on a "games
        // table" event - and scoring a point does not send one. It pushes a
        // chat line and nothing else. So the number above the court sat on the
        // old score until some unrelated event happened to refresh the table,
        // which is why people said someone had scored and "didn't even get a
        // point". The score was right on the server the whole time; this end
        // was simply never told to redraw it.
        needScore = true;
      }
      absorb(f, scored || turned);
      last = f;
    }

    // Where the server says the ball is, against where this simulation had it
    // at that same moment. In steady play the two agree to a hair, because
    // both are running identical arithmetic from the same starting point, and
    // this does nothing at all.
    function absorb(f, rebuild) {
      if (!sim.ok || rebuild || f.ph !== "live") {
        const wasX = sim.x, wasY = sim.y, had = sim.ok;
        hardSet(f);
        // A point or a serve is meant to be a discontinuity, so let it be one.
        // Anything else glides.
        if (had && !rebuild) {
          offX = clamp(offX + (wasX - sim.x), -40, 40);
          offY = clamp(offY + (wasY - sim.y), -40, 40);
        } else {
          offX = 0;
          offY = 0;
        }
        return;
      }

      const then = simAt(f.t);
      if (!then) return;

      // Same path, or different ones? Velocity is the tell. If the signs
      // disagree, one of us bounced and the other did not, and no amount of
      // nudging a position will reconcile that - the server is right and this
      // simulation has to be rebuilt from it.
      const sameWay =
        Math.sign(then.vx) === Math.sign(f.b[2]) &&
        Math.sign(then.vy) === Math.sign(f.b[3]);
      const ex = f.b[0] - then.x;
      const ey = f.b[1] - then.y;

      if (!sameWay || Math.hypot(ex, ey) > PG_BALL_SNAP) {
        const wasX = sim.x, wasY = sim.y;
        hardSet(f);
        offX = clamp(offX + (wasX - sim.x), -40, 40);
        offY = clamp(offY + (wasY - sim.y), -40, 40);
        return;
      }

      if (Math.abs(ex) < 0.02 && Math.abs(ey) < 0.02) return;
      // Correct the simulation this instant, and hand the size of the step to
      // the offset so that the picture does not contain it. The ball is on the
      // server's path from now, and was never seen moving onto it.
      dbgFix++;
      dbgFixSum += Math.hypot(ex, ey);
      sim.x += ex;
      sim.y += ey;
      offX = clamp(offX - ex, -40, 40);
      offY = clamp(offY - ey, -40, 40);
      sim.speed = f.sp || sim.speed;
      for (const h of simHist) {
        h.x += ex;
        h.y += ey;
      }
    }

    // ── Input ──
    // Never a position. Where the paddle would like to be, capped at the far
    // end by the same speed everybody else gets.

    // Number every intent as it goes out. Nothing here reads the number back -
    // this paddle is not corrected against the server any more - but the
    // SERVER reads it, and refuses anything that arrives out of order. Without
    // that, a pair of intents overtaking each other in the wire leaves the
    // server chasing the older of the two, which shows up at this end as the
    // paddle you are not looking at twitching backwards.
    function note() {
      return ++seq;
    }

    function pump() {
      if (!canControl() || !detail) return;
      const now = performance.now();
      // Somebody camping a corner sends nothing for as long as they hold it,
      // and the server reads a long silence as an empty chair. A heartbeat
      // twice a second costs nothing and keeps that honest.
      const stale = now - lastSentAt > 2000;
      if (myDir !== sentDir || (stale && myDir)) {
        sentDir = myDir;
        sentY = null;
        lastSentAt = now;
        const it = { d: myDir, r: last ? last.t : 0 };
        it.n = note();
        S.emit("games input", { tableId: detail.id, input: it });
        return;
      }
      if (myDir || myWant == null) return;
      if (!stale && sentY != null && Math.abs(myWant - sentY) < 0.2) return;
      sentY = myWant;
      lastSentAt = now;
      const it = { y: Math.round(myWant * 10) / 10, r: last ? last.t : 0 };
      it.n = note();
      S.emit("games input", { tableId: detail.id, input: it });
    }

    function aimAt(clientY) {
      if (!canControl() || !canvas) return;
      const r = canvas.getBoundingClientRect();
      if (!r.height) return;
      myDir = 0;
      upHeld = downHeld = false;
      myWant = clamp(
        ((clientY - r.top) / r.height) * C.h,
        C.paddleH / 2,
        C.h - C.paddleH / 2,
      );
    }

    // A mouse reports far faster than the screen refreshes, and every one of
    // those was going out as its own message. That blew straight through the
    // server's input cap, and the messages it dropped were the newest ones, so
    // the paddle simply stopped following the hand for the rest of the second.
    //
    // Gated on elapsed time rather than handed to a timer: this way the send
    // still happens on the event that caused it, which is as early as it can
    // possibly go out, and the rate is bounded all the same.
    function onPointer(e) {
      if (e.type === "pointerdown") {
        if (canvas.setPointerCapture) {
          try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        }
        if (e.pointerType !== "mouse") e.preventDefault();
      }
      aimAt(e.clientY);
      if (performance.now() - lastSentAt >= PG_SEND_MS) pump();
    }

    function onKey(e) {
      if (!canControl()) return;
      const el0 = e.target;
      const tag = (el0 && el0.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (el0 && el0.isContentEditable))
        return;
      const k = e.key;
      const up = k === "ArrowUp" || k === "w" || k === "W";
      const down = k === "ArrowDown" || k === "s" || k === "S";
      if (!up && !down) return;
      e.preventDefault();
      const on = e.type === "keydown";
      if (up) upHeld = on;
      else downHeld = on;
      myDir = upHeld && !downHeld ? -1 : downHeld && !upHeld ? 1 : 0;
      if (myDir) myWant = null;
      pump();
    }

    function nudge(d) {
      if (!canControl()) return;
      myDir = d;
      myWant = null;
      pump();
    }

    // ── Sizing ──

    function fit() {
      if (!courtBox || !wrapEl) return;
      const box = courtBox.getBoundingClientRect();
      if (!box.width) return;
      // On a wide screen the court box is handed a height to fill and the
      // court has to fit inside it. On a phone it is the court that gives the
      // box its height, so measuring the box back would just lock in whatever
      // it happened to be last time. Which of the two is decided in the
      // stylesheet, so read it from there rather than guessing at a width.
      const grows = getComputedStyle(courtBox).flexGrow !== "0";
      let room = grows && box.height > 80 ? box.height : Infinity;
      // And however the layout got here, the court never eats the whole phone:
      // the chat and the controls under it have to stay reachable.
      room = Math.min(room, Math.max(180, window.innerHeight * 0.62));
      const scale = Math.min(box.width / C.w, room / C.h);
      wrapEl.style.width = Math.max(240, Math.floor(C.w * scale)) + "px";
      wrapEl.style.height = Math.max(144, Math.floor(C.h * scale)) + "px";
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
    }

    // ── Painting ──

    function colors() {
      const cs = root ? getComputedStyle(root) : null;
      const v = (n, d) => {
        const got = cs ? cs.getPropertyValue(n).trim() : "";
        return got || d;
      };
      return {
        mine: v("--tk-accent", "#ff9800"),
        theirs: "#5ec8f2",
        text: v("--tk-text", "#f0f0f0"),
        muted: v("--tk-muted", "#8a8a8a"),
      };
    }
    let COL = null;

    function ring(x, y, big) {
      rings.push({ x, y, at: performance.now(), big: !!big });
      if (rings.length > 12) rings.shift();
    }

    function fire(ev) {
      if (ev.k === "hit") {
        hitGlow[ev.side] = 1;
        ring(ev.x, ev.y, false);
        shake = Math.max(shake, 0.7);
      } else if (ev.k === "wall") {
        ring(ev.x, ev.y, false);
      } else if (ev.k === "point") {
        sideFlash[ev.side] = 1;
        shake = Math.max(shake, 2.2);
        ring(ev.side === 0 ? C.w * 0.06 : C.w * 0.94, C.h / 2, true);
      }
    }

    function paint(nowMs) {
      if (!ctx || !canvas.width) return;
      if (!COL) COL = colors();
      const dt = Math.min(0.05, (nowMs - lastPaint) / 1000) || 0.016;
      lastPaint = nowMs;
      if (needScore) {
        needScore = false;
        if (detail) paintScore(detail);
      }

      if (mySide >= 0 && netY[mySide] != null && padY[mySide] != null)
        dbgGap = Math.abs(netY[mySide] - padY[mySide]);
      if (!recT0) recT0 = nowMs;
      if (nowMs - recAt > 250) {
        recAt = nowMs;
        rec.push({
          t: Math.round(nowMs - recT0),
          f: dbgFps,
          s: canControl() ? "H" : "W",
          w: controlWhy(),
          g: Math.round(dbgGap * 10) / 10,
          d: Math.round(netDelay),
          o: Math.round(offset),
          e: Math.round(dbgErr * 10) / 10,
          h: dbgHardRate,
          p: sim.phase,
          // Whether a match was actually running and whether this browser was
          // in it. Without these the report cannot tell "sat waiting for an
          // opponent" from "seated mid-rally with the paddle on the wire",
          // and it counted ten seconds of waiting as 42% lag.
          m: detail && detail.state === "playing" ? 1 : 0,
          q: detail && detail.seated ? 1 : 0,
          c: last ? last.s[0] + "-" + last.s[1] : "",
          // Age of the newest snapshot. In a healthy stretch this sits at a
          // frame or two; a stall shows up here directly instead of having to
          // be inferred from the gap ramping while everything else flatlines.
          a: last ? Math.max(0, Math.round(serverNow() - last.t)) : -1,
        });
        while (rec.length > 720) rec.shift();
      }

      const cw = canvas.width, chh = canvas.height;
      const sc = cw / C.w;
      const newest = last;

      // The whole match moves on one frame of real time. Your paddle answers
      // the hand in this frame, the ball is walked forward against it, and
      // neither waits on anything from the network.
      stepAll(dt);

      // Decay everything that is on its way out.
      const fade = Math.pow(0.02, dt / 0.18);
      hitGlow[0] *= fade;
      hitGlow[1] *= fade;
      sideFlash[0] *= fade;
      sideFlash[1] *= fade;
      shake *= Math.pow(0.02, dt / 0.12);
      const bleed = Math.pow(PG_OFF_BLEED, dt / 0.12);
      offX *= bleed;
      offY *= bleed;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0b0b0e";
      ctx.fillRect(0, 0, cw, chh);

      if (shake > 0.02)
        ctx.translate(
          (Math.random() - 0.5) * shake * sc,
          (Math.random() - 0.5) * shake * sc,
        );

      // The half that just conceded lights up, so a point is unmissable even
      // if you were looking at the chat.
      for (let i = 0; i < 2; i++) {
        if (sideFlash[i] < 0.01) continue;
        ctx.fillStyle = "rgba(255,255,255," + (sideFlash[i] * 0.09).toFixed(3) + ")";
        ctx.fillRect(i === 0 ? 0 : cw / 2, 0, cw / 2, chh);
      }

      // Centre line.
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.lineWidth = Math.max(1, 0.7 * sc);
      ctx.setLineDash([3 * sc, 3.6 * sc]);
      ctx.beginPath();
      ctx.moveTo(cw / 2, 0);
      ctx.lineTo(cw / 2, chh);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!newest) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return;
      }

      const pw = C.paddleW * sc;
      const ph = C.paddleH * sc;

      // The ghost. Where the server has your paddle, which is always a little
      // behind where you have it, because your intent takes an uplink to get
      // there.
      //
      // Diagnostic only, behind ?pongdebug=1. It was briefly on for everyone,
      // and that was a mistake: the gap it draws is proportional to paddle
      // speed, so at 460 u/s an ordinary quick movement opens a gap of twenty
      // units for a moment and a second translucent paddle flickers behind
      // your real one every time you move. A player cannot act on that, and
      // "there are two paddles and one of them is jumping about" is not a
      // clearer story than the one it was meant to explain.
      if (PG_DEBUG && mySide >= 0 && canControl() && netY[mySide] != null && padY[mySide] != null) {
        const drift = netY[mySide] - padY[mySide];
        if (Math.abs(drift) > 4) {
          ctx.globalAlpha = Math.min(0.5, (Math.abs(drift) - 4) / 16);
          ctx.strokeStyle = COL.mine;
          ctx.lineWidth = Math.max(1, 0.5 * sc);
          roundRect(
            ctx,
            (mySide === 0 ? C.wall : C.w - C.wall - C.paddleW) * sc,
            netY[mySide] * sc - ph / 2,
            pw,
            ph,
            pw / 2,
          );
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // Paddles.
      for (let i = 0; i < 2; i++) {
        if (padY[i] == null) continue;
        const x = (i === 0 ? C.wall : C.w - C.wall - C.paddleW) * sc;
        const y = padY[i] * sc - ph / 2;
        const mine = i === mySide;
        ctx.fillStyle = mine ? COL.mine : COL.theirs;
        if (hitGlow[i] > 0.02) {
          ctx.shadowBlur = 18 * hitGlow[i];
          ctx.shadowColor = mine ? COL.mine : COL.theirs;
        }
        ctx.fillRect(x, y, pw, ph);
        ctx.shadowBlur = 0;
      }

      const shown = drawnBall();
      const exact = { x: shown.x, y: shown.y, vx: sim.vx, vy: sim.vy };
      const bx = shown.x * sc;
      const by = shown.y * sc;
      const br = C.ballR * sc;

      if (sim.phase === "live") {
        // A short trail behind the ball, so at full speed the eye has
        // something to follow instead of a dot that teleports. Sampled back
        // along the velocity in time, so a slow ball barely smears and a fast
        // one leaves a proper streak.
        for (let i = 1; i <= 4; i++) {
          const back = i * 0.011;
          ctx.fillStyle = "rgba(255,255,255," + (0.2 - i * 0.04).toFixed(3) + ")";
          ctx.beginPath();
          ctx.arc(
            bx - exact.vx * back * sc,
            by - exact.vy * back * sc,
            br * (1 - i * 0.15),
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      }

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();

      // Impact rings.
      for (let i = rings.length - 1; i >= 0; i--) {
        const age = (nowMs - rings[i].at) / (rings[i].big ? 520 : 300);
        if (age >= 1) {
          rings.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = "rgba(255,255,255," + ((1 - age) * 0.5).toFixed(3) + ")";
        ctx.lineWidth = Math.max(1, 0.6 * sc);
        ctx.beginPath();
        ctx.arc(
          rings[i].x * sc,
          rings[i].y * sc,
          (C.ballR + age * (rings[i].big ? 22 : 8)) * sc,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }

      // Serve countdown, on the court where the ball is about to be.
      if (newest.ph === "serve" && newest.sa) {
        const left = Math.max(0, newest.sa - serverNow());
        const secs = Math.ceil(left / 1000);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.font = "bold " + Math.round(chh * 0.3) + "px " + cssFont;
        ctx.fillText(secs > 0 ? String(secs) : "GO", cw / 2, chh / 2);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "bold " + Math.round(chh * 0.075) + "px " + cssFont;
        const to = players[newest.to];
        ctx.fillText(
          to ? "serving to " + to.username : "serving",
          cw / 2,
          chh / 2 + chh * 0.22,
        );
      }

      // A link stall, made visible. Real match logs show second-long
      // stretches where no snapshot arrives at all; the opponent's paddle is
      // honestly frozen for that whole time and whatever happens at their end
      // of the court is decided without you watching. Silence reads as the
      // game lying about a hit. A warning turns the same moment into "my
      // connection blipped", which is the truth, and tells the player which
      // points not to trust.
      if (detail && detail.state === "playing") {
        const stall = serverNow() - newest.t;
        if (stall > 400) {
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.font = "bold " + Math.round(chh * 0.055) + "px " + cssFont;
          ctx.fillStyle = "rgba(255,138,122,0.9)";
          ctx.fillText(
            "⚠ connection " + (stall / 1000).toFixed(1) + "s",
            cw / 2,
            chh * 0.03,
          );
        }
      }

      // Measured whether or not the readout is showing. The flight recorder
      // runs always, and it reads these; when this arithmetic lived inside the
      // readout every report sent with the readout off said fps 0 and the one
      // number that would have told us about a struggling machine was missing.
      dbgFrames++;
      if (nowMs - dbgAt > 500) {
        dbgFps = Math.round((dbgFrames * 1000) / (nowMs - dbgAt));
        dbgRate = Math.round((dbgFix * 1000) / (nowMs - dbgAt));
        dbgHardRate = Math.round((dbgHard * 1000) / (nowMs - dbgAt));
        dbgErr = dbgFix ? dbgFixSum / dbgFix : 0;
        dbgFrames = 0;
        dbgFix = 0;
        dbgFixSum = 0;
        dbgHard = 0;
        dbgAt = nowMs;
      }

      if (PG_DEBUG) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // The gap between your paddle and the server's copy of it. THIS is
        // the number that matters: everything the other player sees, and every
        // hit-or-miss ruling, is made against the server's copy. A gap of more
        // than a paddle height is why a clean return can be scored against
        // you. The old readout counted "corrections" instead, which fired on
        // every snapshot no matter how healthy things were and said nothing.
        const mine = canControl();
        ctx.font = "bold " + Math.round(chh * 0.042) + "px " + cssFont;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, cw * 0.46, chh * 0.28);
        const bad = dbgGap > C.paddleH;
        ctx.fillStyle = bad ? "#FF8A7A" : "#7CFC9B";
        [
          dbgFps + " fps    paddle: " + (mine ? "HAND (local)" : "WIRE (network)"),
          "server's copy of your paddle is " +
            dbgGap.toFixed(0) + "u behind (" + (dbgGap / C.paddleH).toFixed(1) +
            " paddle-heights)" + (bad ? "  <-- TOO FAR" : ""),
          "ball off the server by " + dbgErr.toFixed(1) + "u, rebuilt " + dbgHardRate + "/s",
          "far paddle drawn " + Math.round(netDelay) +
            "ms back, clock offset " + Math.round(offset) + "ms (normal)",
        ].forEach((line, i) => {
          ctx.fillText(line, chh * 0.02, chh * 0.02 + i * chh * 0.06);
        });
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    function roundRect(c, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rr, y);
      c.arcTo(x + w, y, x + w, y + h, rr);
      c.arcTo(x + w, y + h, x, y + h, rr);
      c.arcTo(x, y + h, x, y, rr);
      c.arcTo(x, y, x + w, y, rr);
      c.closePath();
    }

    function loop(nowMs) {
      raf = requestAnimationFrame(loop);
      paint(nowMs);
    }

    // ── The report ──
    // Written to be pasted into a message, so it leads with the answers to the
    // questions that actually get asked and keeps the raw trace short.

    function pct(a, q) {
      if (!a.length) return 0;
      const s = a.slice().sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(s.length * q))];
    }

    function statsText(full) {
      if (!rec.length) return "pong: nothing recorded yet";
      const L = [];
      const secs = (rec[rec.length - 1].t / 1000).toFixed(0);
      // Only moments where a match was running and this browser was seated in
      // it can say anything about lag. Waiting for an opponent and watching
      // from the rail both have no seat BY DESIGN, and counting them here is
      // how ten seconds of waiting once read as "42% of the time on the wire"
      // in a match that was actually healthy end to end.
      const live = rec.filter((r) => r.m && r.q);
      const base = live.length ? live : rec;
      const wire = live.filter((r) => r.s === "W");
      const gaps = live.filter((r) => r.s === "H").map((r) => r.g);
      const fps = base.map((r) => r.f).filter((x) => x > 0);
      const why = {};
      for (const r of wire) why[r.w] = (why[r.w] || 0) + 1;
      const hand = live.length
        ? (100 - (wire.length / live.length) * 100).toFixed(0)
        : null;

      // The first line is the whole verdict, sized to survive being pasted
      // into a chat that cuts messages short. Everything under it is detail.
      L.push(
        "=== PONG " + secs + "s === " +
          (hand == null
            ? "no match played"
            : "hand " + hand + "%, gap med " + pct(gaps, 0.5) + "u p90 " +
              pct(gaps, 0.9) + "u") +
          ", fps " + pct(fps, 0.5) +
          ", ball " + pct(base.map((r) => r.e), 0.5) + "u" +
          ", farpad " + pct(base.map((r) => r.d), 0.5) + "ms",
      );
      L.push("recorded " + secs + "s over " + rec.length + " samples, " +
        live.length + " in a live match, " + (rec.length - live.length) +
        " waiting or watching (not counted below)");
      L.push("");
      if (hand == null) {
        L.push("No seated in-match time in this recording, so there are no");
        L.push("paddle numbers to report. Play a point and press the button again.");
      } else {
        L.push("PADDLE DRIVEN BY YOUR HAND: " + hand + "% of in-match time");
        if (wire.length)
          L.push("  on the wire instead " + wire.length + " samples, reasons: " +
            Object.keys(why).map((k) => k + " x" + why[k]).join(", "));
        L.push("");
        L.push("SERVER'S COPY OF YOUR PADDLE, how far behind yours (units, paddle is " +
          C.paddleH + " tall)");
        L.push("  median " + pct(gaps, 0.5) + "   90th " + pct(gaps, 0.9) +
          "   worst " + pct(gaps, 0.999));
      }
      L.push("");
      L.push("FRAME RATE   median " + pct(fps, 0.5) + "   worst " + pct(fps, 0.02));
      L.push("BALL         off the server by " +
        pct(base.map((r) => r.e), 0.5) + "u median, " +
        pct(base.map((r) => r.e), 0.9) + "u at the 90th; rebuilt " +
        pct(base.map((r) => r.h), 0.5) + "/s median, " +
        pct(base.map((r) => r.h), 0.95) + "/s worst");
      L.push("FAR PADDLE   drawn " + pct(base.map((r) => r.d), 0.5) +
        "ms back (median), " + pct(base.map((r) => r.d), 0.95) + "ms worst");
      L.push("CLOCK OFFSET " + rec[rec.length - 1].o +
        "ms (a plain clock difference, not a fault)");
      L.push("SPEEDS       pointer " + C.paddleSpeed + " key " +
        (C.keySpeed || "?") + " u/s, court " + C.w + "x" + C.h);
      L.push("");
      L.push("CONTROL CHANGES (in-match only, when the paddle changed hands)");
      let prev = null, n = 0;
      for (const r of live) {
        // Deliberately NOT keyed on the phase: serve/live flips every point
        // and drowns the one transition anybody cares about.
        const k = r.s + r.w;
        if (k !== prev) {
          prev = k;
          if (n++ < 40)
            L.push("  " + (r.t / 1000).toFixed(1) + "s  " +
              (r.s === "H" ? "HAND" : "WIRE") + "  " + r.w + "  " + r.p +
              "  gap " + r.g + "u");
        }
      }
      L.push("");
      L.push("CROSSINGS AT YOUR OWN PADDLE (every one, with the on-screen geometry)");
      if (!xing.length) L.push("  none recorded");
      for (const x of xing)
        L.push("  " + (x.t / 1000).toFixed(1) + "s " + x.ruled +
          (x.ruled === "MISS" && x.miss != null ? " by " + x.miss + "u" : "") +
          "  ball y " + x.by +
          (x.offY ? " (drawn " + (x.offY > 0 ? "+" : "") + x.offY + ")" : "") +
          "  your paddle " + x.py + "  server's copy " + x.srv +
          (x.out ? "  -> " + x.out : ""));
      L.push("");
      L.push("PER-SECOND TRACE  sec score src fps gap farpad snapAge ballErr rebuilds phase");
      let lastSec = -1;
      for (const r of rec) {
        const sec = Math.floor(r.t / 1000);
        if (sec === lastSec) continue;
        lastSec = sec;
        L.push("  " + sec + " " + (r.c || "-") + " " +
          (r.m && r.q ? r.s : "idle") + " " + r.f + " " + r.g + " " + r.d +
          " " + (r.a == null ? "-" : r.a) + " " + r.e + " " + r.h + " " + r.p);
      }
      if (full) {
        L.push("");
        L.push("RAW SAMPLES (250ms)  t fps src why gap farpad snapAge offset ballErr rebuilds phase match seated score");
        for (const r of rec)
          L.push("  " + (r.t / 1000).toFixed(2) + " " + r.f + " " + r.s + " " +
            r.w + " " + r.g + " " + r.d + " " + (r.a == null ? "-" : r.a) +
            " " + r.o + " " + r.e + " " + r.h +
            " " + r.p + " " + r.m + " " + r.q + " " + (r.c || "-"));
      }
      return L.join("\n");
    }

    function copyStats() {
      const text = statsText();
      const done = () => {
        if (!copyEl) return;
        copyEl.textContent = "✅";
        setTimeout(() => { if (copyEl) copyEl.textContent = "📋"; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
      } else fallback(text, done);
    }

    // The full log as a file. Chat cuts long messages short, which is how
    // every report pasted mid-match arrived missing the half that mattered.
    // A file cannot be truncated by a textbox, so this is the one to share
    // when somebody actually needs the numbers.
    function saveStats() {
      const blob = new Blob([statsText(true)], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "pong-log-" +
        new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 200);
      if (saveEl) {
        saveEl.textContent = "✅";
        setTimeout(() => { if (saveEl) saveEl.textContent = "💾"; }, 1200);
      }
    }

    // Clipboard access is refused outside a secure context and in some
    // embedded views, and a report nobody can copy is no report at all.
    function fallback(text, done) {
      const ta = el("textarea", { class: "gm-pg-dump" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch (_) {
        /* leave it on screen to copy by hand */
      }
      setTimeout(() => ta.remove(), 100);
    }

    // ── Cheers ──

    function cheer(emoji) {
      if (!detail) return;
      S.emit("games cheer", { tableId: detail.id, emoji });
    }

    function floatCheer(c) {
      if (!floatEl) return;
      while (floatEl.childNodes.length > 16) floatEl.removeChild(floatEl.firstChild);
      const node = el("span", { class: "gm-pg-cheer" }, [
        el("i", { text: c.emoji }),
        el("b", { text: c.username || "" }),
      ]);
      node.style.left = (8 + Math.random() * 78).toFixed(1) + "%";
      floatEl.appendChild(node);
      setTimeout(() => {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 2400);
    }

    // ── Chrome around the court ──

    function paintScore(t) {
      const g = t.game;
      const s = (last && last.s) || (g ? g.frame.s : [0, 0]);
      const left = players[0], right = players[1];
      nameL.textContent = left ? left.username : "Waiting";
      nameR.textContent = right ? right.username : "Waiting";
      nameL.className = "gm-pg-name" + (mySide === 0 ? " gm-pg-you" : "");
      nameR.className = "gm-pg-name" + (mySide === 1 ? " gm-pg-you" : "");
      ptsL.textContent = String(s[0]);
      ptsR.textContent = String(s[1]);
      ptsL.classList.toggle("gm-pg-lead", s[0] > s[1]);
      ptsR.classList.toggle("gm-pg-lead", s[1] > s[0]);

      const matchPoint =
        t.state === "playing" && (s[0] === target - 1 || s[1] === target - 1);
      midEl.textContent = matchPoint ? "match point" : "first to " + target;
      midEl.classList.toggle("gm-pg-mp", matchPoint);

      const r = last ? last.r : 0;
      rallyEl.textContent = r >= 4 ? r + " shot rally" : "";
    }

    // Winner stays, so the interesting question for everybody watching is who
    // is next. The floor already tracks that; this puts it under the court
    // where it is actually being asked.
    function paintLineup(t) {
      lineupEl.textContent = "";
      const queued = (floor.pools && floor.pools.pong) || 0;
      if (t.streak && t.streak.n > 1)
        lineupEl.appendChild(
          el("span", { class: "gm-pg-champ" }, [
            el("i", { class: "fas fa-crown" }),
            " " + t.streak.username + " on " + t.streak.n + " straight",
          ]),
        );
      const next = t.nextUp || [];
      if (next.length) {
        lineupEl.appendChild(el("span", { class: "gm-pg-lbl", text: "Up next" }));
        next.slice(0, 5).forEach((n, i) => {
          lineupEl.appendChild(
            el("span", {
              class: "gm-pg-queued" + (n.userId === myId() ? " gm-pg-you" : ""),
              text: (i + 1) + ". " + n.username,
            }),
          );
        });
        if (next.length > 5)
          lineupEl.appendChild(
            el("span", { class: "gm-pg-lbl", text: "+" + (next.length - 5) + " more" }),
          );
      } else if (t.state === "playing") {
        lineupEl.appendChild(
          el("span", {
            class: "gm-pg-lbl",
            text: "Nobody is waiting. The winner keeps the board.",
          }),
        );
      }
      if (queued)
        lineupEl.appendChild(
          el("span", {
            class: "gm-pg-lbl",
            text:
              queued === 1
                ? "1 more waiting in the room"
                : queued + " more waiting in the room",
          }),
        );
    }

    function paintHint(t) {
      if (t.seated)
        hintEl.textContent =
          "Move with the mouse, a finger on the court, or W and S. The edge of your paddle is the sharp angle.";
      else
        hintEl.textContent =
          "Watching. Cheer them on, or take the next round from the bar above.";
      padsEl.style.display = t.seated ? "" : "none";
    }

    return {
      mount(stage) {
        root = el("div", { class: "gm-board gm-pg" });
        cssFont = getComputedStyle(document.body).fontFamily || "sans-serif";

        nameL = el("span", { class: "gm-pg-name" });
        nameR = el("span", { class: "gm-pg-name" });
        ptsL = el("span", { class: "gm-pg-pts", text: "0" });
        ptsR = el("span", { class: "gm-pg-pts", text: "0" });
        midEl = el("span", { class: "gm-pg-to" });
        rallyEl = el("span", { class: "gm-pg-rally" });
        root.appendChild(
          el("div", { class: "gm-pg-scoreline" }, [
            el("div", { class: "gm-pg-team" }, [nameL, ptsL]),
            el("div", { class: "gm-pg-mid" }, [midEl, rallyEl]),
            el("div", { class: "gm-pg-team gm-pg-team-r" }, [ptsR, nameR]),
          ]),
        );

        canvas = el("canvas", { class: "gm-pg-canvas" });
        ctx = canvas.getContext("2d");
        floatEl = el("div", { class: "gm-pg-float" });
        wrapEl = el("div", { class: "gm-pg-wrap" }, [canvas, floatEl]);
        courtBox = el("div", { class: "gm-pg-courtbox" }, wrapEl);
        root.appendChild(courtBox);

        canvas.addEventListener("pointerdown", onPointer);
        canvas.addEventListener("pointermove", onPointer);

        padsEl = el("div", { class: "gm-pg-pads" }, [
          el("button", {
            class: "gm-pg-pad",
            "aria-label": "Move paddle up",
            onpointerdown: () => nudge(-1),
            onpointerup: () => nudge(0),
            onpointerleave: () => nudge(0),
          }, el("i", { class: "fas fa-caret-up" })),
          el("button", {
            class: "gm-pg-pad",
            "aria-label": "Move paddle down",
            onpointerdown: () => nudge(1),
            onpointerup: () => nudge(0),
            onpointerleave: () => nudge(0),
          }, el("i", { class: "fas fa-caret-down" })),
        ]);

        cheerEl = el("div", { class: "gm-pg-cheers" });
        PG_CHEERS.forEach((e) =>
          cheerEl.appendChild(
            el("button", {
              class: "gm-pg-cheer-btn",
              "aria-label": "Cheer " + e,
              text: e,
              onclick: () => cheer(e),
            }),
          ),
        );
        // Connection readout, on a button rather than a URL flag: needing a
        // reload to see it meant it was never on at the moment something
        // actually went wrong.
        dbgBtn = el("button", {
          class: "gm-pg-cheer-btn gm-pg-stats",
          title: "Show connection stats",
          "aria-label": "Show or hide connection stats",
          text: "📶",
          onclick: () => {
            PG_DEBUG = !PG_DEBUG;
            try {
              localStorage.setItem("tk-pong-debug", PG_DEBUG ? "1" : "0");
            } catch (_) {}
            dbgBtn.classList.toggle("gm-pg-on", PG_DEBUG);
          },
        });
        if (PG_DEBUG) dbgBtn.classList.add("gm-pg-on");
        cheerEl.appendChild(dbgBtn);

        // Copy the recording. Always available, whether or not the readout is
        // showing - the recorder runs regardless, so this works even if the
        // trouble happened before anybody thought to turn anything on.
        copyEl = el("button", {
          class: "gm-pg-cheer-btn gm-pg-stats",
          title: "Copy connection report",
          "aria-label": "Copy connection report to the clipboard",
          text: "📋",
          onclick: copyStats,
        });
        cheerEl.appendChild(copyEl);

        // Download the whole recording, raw samples included, as a text file.
        saveEl = el("button", {
          class: "gm-pg-cheer-btn gm-pg-stats",
          title: "Download full connection log",
          "aria-label": "Download the full connection log as a text file",
          text: "💾",
          onclick: saveStats,
        });
        cheerEl.appendChild(saveEl);

        root.appendChild(el("div", { class: "gm-pg-under" }, [padsEl, cheerEl]));

        lineupEl = el("div", { class: "gm-pg-lineup" });
        root.appendChild(lineupEl);
        hintEl = el("div", { class: "gm-pg-hint" });
        root.appendChild(hintEl);

        stage.appendChild(root);

        document.addEventListener("keydown", onKey);
        document.addEventListener("keyup", onKey);
        sendTimer = setInterval(pump, PG_SEND_MS);
        setTimeout(resize, 0);
        window.addEventListener("resize", resize);
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => resize());
          ro.observe(courtBox);
        }
        raf = requestAnimationFrame(loop);
      },

      destroy() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        if (sendTimer) clearInterval(sendTimer);
        sendTimer = null;
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("keyup", onKey);
        window.removeEventListener("resize", resize);
        if (ro) ro.disconnect();
        ro = null;
        reset();
      },

      relay(d) {
        if (d.kind === "frame") takeFrame(d.f);
        else if (d.kind === "cheer") floatCheer(d);
      },

      update(t) {
        const g = t.game;
        if (g && g.court) {
          const grew = C.w !== g.court.w || C.h !== g.court.h;
          C = g.court;
          target = g.target || 7;
          players = g.players || [];
          const was = mySide;
          mySide = typeof g.mySide === "number" ? g.mySide : -1;

          // Anything that makes the last match's snapshots meaningless: a new
          // match at this board, or sitting down at one we were watching. Left
          // alone, the old buffer would fly the previous ball across the new
          // court for a fifth of a second.
          const key = t.id + ":" + t.matchNumber;
          if (key !== matchKey || was !== mySide) {
            matchKey = key;
            reset();
          }
          if (g.frame) takeFrame(g.frame);
          if (grew) resize();
        } else if (!g) {
          matchKey = "";
          players = t.seats.map((s) => ({ userId: s.userId, username: s.username }));
          mySide = -1;
          reset();
        }
        paintScore(t);
        paintLineup(t);
        paintHint(t);
        COL = null; // themes can change under us, so re-read on the next paint
      },
    };
  };

  // Tic Tac Toe -------------------------------------------------------------
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

  // Connect Four ------------------------------------------------------------
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

  // Word Race ---------------------------------------------------------------
  BOARDS.wordrace = function () {
    let gridEl, form, input, feedback, mineEl, scoreEl, barFill, finalEl, timerEl;
    const tiles = [];
    let focused = false;

    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-wr" });

        const timerRow = el("div", { class: "gm-wr-timer" });
        timerEl = el("span", { class: "gm-count gm-wr-secs" });
        timerRow.appendChild(timerEl);
        barFill = el("div", { class: "gm-wr-bar-fill" });
        timerRow.appendChild(el("div", { class: "gm-wr-bar" }, barFill));
        root.appendChild(timerRow);

        gridEl = el("div", { class: "gm-wr-grid" });
        for (let i = 0; i < 16; i++) {
          const tile = el("div", { class: "gm-wr-tile" });
          tiles.push(tile);
          gridEl.appendChild(tile);
        }
        root.appendChild(gridEl);

        scoreEl = el("div", { class: "gm-wr-score" });
        root.appendChild(scoreEl);

        input = el("input", {
          class: "gm-wr-input",
          type: "text",
          maxlength: "16",
          placeholder: "type a word and press enter",
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: "false",
        });
        form = el("form", { class: "gm-wr-form" }, [
          input,
          el("button", { class: "gm-btn gm-btn-primary", type: "submit", text: "Add" }),
        ]);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const w = input.value.trim();
          if (!w) return;
          S.emit("games move", { tableId: detail.id, move: { word: w } });
          input.value = "";
        });
        root.appendChild(form);

        feedback = el("div", { class: "gm-wr-feedback" });
        root.appendChild(feedback);
        mineEl = el("div", { class: "gm-wr-mine" });
        root.appendChild(mineEl);
        finalEl = el("div", { class: "gm-wr-final" });
        root.appendChild(finalEl);
        stage.appendChild(root);
      },
      feedbackMsg(msg, good) {
        feedback.textContent = msg;
        feedback.className = "gm-wr-feedback " + (good ? "gm-good" : "gm-bad");
        clearTimeout(feedback._t);
        feedback._t = setTimeout(() => {
          feedback.textContent = "";
          feedback.className = "gm-wr-feedback";
        }, 1600);
      },
      update(t) {
        const g = t.game;
        if (!g) {
          gridEl.classList.add("gm-idle");
          form.style.display = "none";
          return;
        }
        gridEl.classList.remove("gm-idle");
        for (let i = 0; i < 16; i++) tiles[i].textContent = g.grid[i] || "";

        if (!g.over && g.endsAt) {
          barFill.dataset.barEnd = String(g.endsAt);
          barFill.dataset.barSpan = String(g.durationMs);
          timerEl.dataset.deadline = String(g.endsAt);
          barFill.parentNode.parentNode.style.display = "";
        } else {
          delete barFill.dataset.barEnd;
          delete timerEl.dataset.deadline;
          barFill.parentNode.parentNode.style.display = "none";
        }

        scoreEl.textContent = "";
        scoreEl.appendChild(el("span", { class: "gm-wr-pts", text: String(g.myScore || 0) }));
        scoreEl.appendChild(
          el("span", {
            class: "gm-wr-pts-label",
            text: " points from " + g.myWords.length + (g.myWords.length === 1 ? " word" : " words"),
          }),
        );

        const live = !g.over && t.state === "playing" && t.seated;
        form.style.display = live ? "" : "none";
        if (live && !focused) {
          focused = true;
          setTimeout(() => input.focus(), 30);
        }

        mineEl.textContent = "";
        g.myWords
          .slice()
          .reverse()
          .forEach((w) => {
            mineEl.appendChild(
              el("span", { class: "gm-wr-word" }, [
                el("b", { text: w.word }),
                el("i", { text: "+" + w.pts }),
              ]),
            );
          });

        finalEl.textContent = "";
        if (g.over && g.finalScores) {
          finalEl.appendChild(section("fa-trophy", "Final scores"));
          g.finalScores.forEach((s, i) => {
            const row = el("div", {
              class: "gm-wr-rank" + (i === 0 ? " gm-first" : ""),
            });
            row.appendChild(
              el("div", { class: "gm-wr-rank-head" }, [
                el("span", { class: "gm-wr-pos", text: "#" + (i + 1) }),
                el("span", { class: "gm-wr-who", text: s.username }),
                el("span", { class: "gm-wr-total", text: String(s.score) }),
              ]),
            );
            const words = el("div", { class: "gm-wr-list" });
            s.words.forEach((w) => {
              words.appendChild(
                el("span", { class: "gm-wr-word" + (w.dup ? " gm-dup" : "") }, [
                  el("b", { text: w.word }),
                  el("i", { text: w.dup ? "both found it" : "+" + w.pts }),
                ]),
              );
            });
            row.appendChild(words);
            finalEl.appendChild(row);
          });
          finalEl.appendChild(
            el("div", {
              class: "gm-wr-possible",
              text: "There were " + g.possible + " words hiding in that grid.",
            }),
          );
        }
      },
    };
  };

  // Draw & Guess ------------------------------------------------------------
  // Guess the Flag ----------------------------------------------------------
  // The flag is painted onto a canvas from an image that is never put in the
  // document, and its url is an opaque per-round token rather than a country
  // code. Nothing in the page names the country until the round is revealed.
  BOARDS.flagguess = function () {
    let root, timerRow, timerNum, timerFill, roundEl, promptEl;
    let canvas, ctx, canvasBox, canvasWrap;
    let guessWrap, guessForm, guessInput, guessLabel, statusEl;
    let img = null;
    let shownToken = null;
    let ro = null;
    let focused = false;

    // 3:2 is the commonest flag shape. The canvas keeps it at every size and
    // letterboxes anything squarer or longer, so Nepal and Switzerland are not
    // stretched into something unrecognisable.
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
      // The guess box lines up with the flag rather than running the whole
      // width of the panel, which looked enormous next to a small flag.
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
      // Contain, not cover: a flag cropped to fill the box is a different flag.
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
      // Deliberately never appended to the document: the only thing in the
      // page is the canvas, so there is no src for anybody to read.
      next.onload = () => {
        if (shownToken !== token) return; // a newer round already started
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
    // Revision the server stamps on each canvas change. Local strokes are drawn
    // optimistically and counted here too, so a state push arriving while a
    // batch is still in flight cannot roll the canvas back.
    let rev = -1;
    let syncing = false;
    let palette = null;
    let papers = null;
    let bg = 0;
    let ro = null;

    // The drawing is a fixed 16:9 board, not whatever shape the window happens
    // to be. Everyone gets the same picture at a different scale, and a brush
    // is the same fraction of it on a phone and a desktop.
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
    // Largest 1000x700 box that fits the space we were given. Keeping the shape
    // fixed is the whole point: a circle drawn on a desktop is still a circle
    // on a phone, and the hit test below stays a plain proportion.
    function fit() {
      if (!canvasBox || !canvasWrap) return;
      const box = canvasBox.getBoundingClientRect();
      if (!box.width) return;
      // A column layout leaves the height open, so size from the width there.
      const room = box.height > 60 ? box.height : Infinity;
      const scale = Math.min(box.width / ART_W, room / ART_H);
      const w = Math.max(160, Math.floor(ART_W * scale));
      canvasWrap.style.width = w + "px";
      canvasWrap.style.height = Math.max(112, Math.floor(ART_H * scale)) + "px";
      // Keeps the guess box the same width as the drawing it belongs to.
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

    // A titled block in the rail. Same shape for ink, brush, tool and paper.
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

        // One header row: seconds, bar, turn counter.
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

        // Toolbar: every group titled, so nobody has to guess what a row of
        // small squares is for.
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
          // Sized off the real brush width so the buttons read as a scale.
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

        // Toolbar sits beside the canvas on a wide screen and drops underneath
        // on a narrow one, so the drawing gets as much room as possible.
        stageEl = el("div", { class: "gm-dg-stage" }, [tools, canvasBox]);
        root.appendChild(stageEl);

        // Shown instead of the stage while the game is parked. An empty canvas
        // next to "waiting for someone" told nobody anything.
        lobbyEl = el("div", { class: "gm-dg-lobby" });
        root.appendChild(lobbyEl);

        // No guess box: the chat feed is the guess box. A second field under
        // the canvas asked people to decide which one to type in and took
        // space the drawing wanted. This line just says where to type.
        guessHint = el("div", { class: "gm-dg-guesslabel" });
        guessWrap = el("div", { class: "gm-dg-guesswrap gm-dg-tip" }, [guessHint]);
        root.appendChild(guessWrap);

        statusEl = el("div", { class: "gm-dg-status" });
        root.appendChild(statusEl);

        stage.appendChild(root);
        setTimeout(resize, 0);
        window.addEventListener("resize", resize);
        // Hiding the chat or the toolbar changes the space without the window
        // moving, so watch the box itself rather than only the window.
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
          // A gap means we missed something, so take a fresh copy rather than
          // letting the canvases drift apart.
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

        // Nothing to draw on: waiting for company, or the game is done and the
        // canvas has already been wiped. Either way an empty board taking half
        // the screen tells nobody anything, so it goes.
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

        // Where to type, and whether they still need to.
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

        // Who has it, who we are still waiting on, and the nudge button.
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

        // A standing opt-out, always available to a seated player.
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

    // The end of a game. The canvas is already wiped by this point, so the
    // board shows the table instead of a blank sheet of paper.
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

    // The parked state, given the whole board. One headline, who is already
    // here, and the two things you can actually do about it.
    function paintLobby(t, g) {
      lobbyEl.textContent = "";
      // Same card as the pre-start one, so the two waits do not look like two
      // different screens bolted together.
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
    // Back from a reconnect: if we still hold a game, drop straight back into
    // it instead of leaving a dead board on screen.
    const mine = Object.values(floor.myTables || {})[0];
    if (isOpen && mine && view.name === "floor") {
      view = { name: "game", tableId: mine };
      detail = null;
    }
    render();
  });

  // "Word Race just started" to the whole room. The server already rations
  // these to one per game type every few minutes; this side only makes sure it
  // is a click-to-join and never lands on top of the panel you are already in.
  S.on("games shout", (d) => {
    if (!d || !d.tableId) return;
    if (isOpen && view.name === "game" && view.tableId === d.tableId) return;
    const jump = () => {
      openPanel();
      openGame(d.tableId);
    };
    if (window.StaffUI && window.StaffUI.toast) {
      // The helper has no click handler of its own, so wire the returned node.
      const node = window.StaffUI.toast(d.text, {
        type: "info",
        title: d.name,
        timeout: 10000,
      });
      if (node) {
        node.style.cursor = "pointer";
        node.title = "Open " + d.name;
        node.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-tx")) return; // the dismiss button
          jump();
        });
      }
      return;
    }
    if (window.toastr)
      window.toastr.info(d.text, d.name, { timeOut: 10000, onclick: jump });
  });

  // A dropped connection leaves the panel showing a board the server no longer
  // knows we are looking at, and a restart wipes every table outright.
  //
  // Re-announcing the moment the socket is back is too early: the room page
  // rejoins on its own clock, so the server would still have no room to look
  // the floor up in. Wait for the rejoin, then step back into the games list.
  // If the table survived, the snapshot below puts us straight back on it.
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
    // The fallback covers a spectator, or a rejoin that never acknowledges.
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
    // Just pressed play: go to the board rather than leaving them reading the
    // list. A seat is best, but a place in the line still means watching the
    // game they asked to play, which is where they wanted to be.
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
    // Landed before the board is up: keep it and replay on mount, otherwise a
    // mid round joiner never sees the drawing already on the canvas.
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
    // "So close" is fine when the answer is one of two hundred countries. It
    // is a giveaway when the answer is a single drawn word, so Draw & Guess
    // never says it, and never posts the near miss either.
    else if (d.close && board.say && detail && detail.type !== "drawguess")
      board.say("So close", false);
    // "known" means they typed a real country, just the wrong one. Worth
    // saying, because it separates a near miss from a typo.
    else if (d.correct === false && board.say && detail && detail.type !== "drawguess")
      board.say(d.known ? "That is a country, but not this one" : "Not it", false);
  });

  S.on("games error", (d) => {
    const msg = (d && d.message) || "That did not work.";
    if (board && board.feedbackMsg && detail && detail.type === "wordrace")
      board.feedbackMsg(msg, false);
    else toast(msg, "error");
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
    // Step back rather than closing outright, so Escape mid-game is recoverable.
    if (view.name === "game" || view.name === "solo") backToFloor();
    else closePanel();
  });

  window.TalkomaticGames = {
    open: openPanel,
    close: closePanel,
    isOpen: () => isOpen,
  };
})();
