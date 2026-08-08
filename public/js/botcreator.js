// botcreator.js
// The Bot Creator page. The editor uses plain words, the ready-made bots go
// from easy to hard, and the test room next to the editor behaves like a
// real Talkomatic room: two textboxes, no send button, the bot reads your
// last line after you stop typing. Rules run through the real server
// interpreter (server/bots.js) even before they are saved.

/* global io, toastr */

(function () {
  "use strict";

  toastr.options = {
    positionClass: "toast-bottom-right",
    timeOut: 3500,
    escapeHtml: true,
  };

  // ── Socket ────────────────────────────────────────────────────────────────

  const socket = io({
    transports: ["websocket"],
    upgrade: false,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    withCredentials: true,
    auth: {
      devKey: localStorage.getItem("talkomatic_devKey") || undefined,
      modKey: localStorage.getItem("talkomatic_modKey") || undefined,
      deviceId:
        (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
        undefined,
    },
  });

  // ── Page state ────────────────────────────────────────────────────────────

  let me = null; // { userId, username, isDev, isMod }
  let status = null; // last "bots status" payload
  let edit = null; // the bot being edited: { id?, name, rules[] }
  let deployMode = "existing"; // or "new"
  let testDirty = true; // the test sandbox needs the current rules re-sent

  const $ = (id) => document.getElementById(id);

  // ── Ready-made bots, easiest first. Every one works as-is. ───────────────

  const TEMPLATES = [
    {
      key: "blank",
      icon: "fa-file",
      level: "easy",
      name: "Start empty",
      blurb: "One simple rule to build on.",
      bot: {
        name: "MyBot",
        rules: [
          {
            on: { type: "command", word: "hello" },
            if: [],
            do: [{ type: "say", text: "Hi {name}!" }],
          },
        ],
      },
    },
    {
      key: "dice",
      icon: "fa-dice",
      level: "easy",
      name: "Dice",
      blurb: "!roll throws a die. One rule, one action.",
      bot: {
        name: "DiceBot",
        rules: [
          {
            on: { type: "command", word: "roll" },
            if: [],
            do: [{ type: "say", text: "🎲 {name} rolls a {rand:1-6}!" }],
          },
        ],
      },
    },
    {
      key: "greeter",
      icon: "fa-hand",
      level: "easy",
      name: "Greeter",
      blurb: "Says hello and goodbye to everyone.",
      bot: {
        name: "Greeter",
        rules: [
          {
            on: { type: "join" },
            if: [],
            do: [
              { type: "wait", seconds: 1 },
              { type: "say", text: "Welcome to {room}, {name}! 👋 That makes {humans} of us." },
            ],
          },
          {
            on: { type: "leave" },
            if: [],
            do: [{ type: "say", text: "{name} left. Bye! 👋" }],
          },
        ],
      },
    },
    {
      key: "8ball",
      icon: "fa-circle-question",
      level: "easy",
      name: "Magic 8 Ball",
      blurb: "!8ball answers yes-or-no questions. Uses wait and pick.",
      bot: {
        name: "8Ball",
        rules: [
          {
            on: { type: "command", word: "8ball" },
            if: [],
            do: [
              { type: "say", text: "🎱 Shaking..." },
              { type: "wait", seconds: 2 },
              {
                type: "say",
                text: "🎱 {pick:It is certain|Without a doubt|Signs point to yes|Ask again later|Better not tell you now|Outlook not so good|Absolutely not}",
              },
            ],
          },
        ],
      },
    },
    {
      key: "quiz",
      icon: "fa-trophy",
      level: "medium",
      name: "Quiz",
      blurb: "!quiz asks, !answer checks, right answers earn points.",
      bot: {
        name: "QuizBot",
        rules: [
          {
            on: { type: "command", word: "quiz" },
            if: [],
            do: [
              { type: "say", text: "❓ What has keys but can't open doors? Answer with: !answer yourguess" },
            ],
          },
          {
            on: { type: "command", word: "answer" },
            if: [{ a: "{word1}", op: "is", b: "piano" }],
            do: [
              { type: "add", var: "points", per: "user", amount: "1" },
              { type: "say", text: "🏆 Right, {name}! A piano. You have {mymemory:points} points." },
            ],
          },
          {
            on: { type: "command", word: "answer" },
            if: [{ a: "{word1}", op: "not", b: "piano" }],
            do: [{ type: "say", text: "Nope, not \"{word1}\". Try again!" }],
          },
          {
            on: { type: "command", word: "points" },
            if: [],
            do: [{ type: "say", text: "{name} has {mymemory:points} points." }],
          },
        ],
      },
    },
    {
      key: "guess",
      icon: "fa-bullseye",
      level: "medium",
      name: "Guess the Number",
      blurb: "The whole room guesses together. First right answer wins the round.",
      bot: {
        name: "GuessBot",
        rules: [
          {
            on: { type: "command", word: "start" },
            if: [],
            do: [
              { type: "random", var: "secret", per: "bot", from: "1-100" },
              { type: "say", text: "🎯 I picked a number from 1 to 100. Anyone can guess: !guess 50" },
            ],
          },
          {
            on: { type: "command", word: "guess" },
            if: [{ a: "{memory:secret}", op: "is", b: "0" }],
            do: [{ type: "say", text: "No number picked yet. Type !start to begin a round." }],
          },
          {
            on: { type: "command", word: "guess" },
            if: [
              { a: "{word1}", op: "lt", b: "{memory:secret}" },
              { a: "{memory:secret}", op: "not", b: "0" },
            ],
            do: [{ type: "say", text: "Higher than {word1}, {name}!" }],
          },
          {
            on: { type: "command", word: "guess" },
            if: [
              { a: "{word1}", op: "gt", b: "{memory:secret}" },
              { a: "{memory:secret}", op: "not", b: "0" },
            ],
            do: [{ type: "say", text: "Lower than {word1}, {name}!" }],
          },
          {
            on: { type: "command", word: "guess" },
            if: [
              { a: "{word1}", op: "is", b: "{memory:secret}" },
              { a: "{memory:secret}", op: "not", b: "0" },
            ],
            do: [
              { type: "add", var: "wins", per: "user", amount: "1" },
              { type: "say", text: "🎉 {name} got it! It was {memory:secret}. That makes {mymemory:wins} wins. Type !start for a new round." },
              { type: "set", var: "secret", per: "bot", value: "0" },
            ],
          },
        ],
      },
    },
    {
      key: "rps",
      icon: "fa-hand-scissors",
      level: "hard",
      name: "Rock Paper Scissors",
      blurb: "!rps rock. A full game with a scoreboard, built from 9 rules.",
      bot: {
        name: "RPSBot",
        rules: [
          {
            on: { type: "command", word: "rps" },
            if: [],
            do: [{ type: "random", var: "m", per: "bot", from: "rock, paper, scissors" }],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "not", b: "rock" },
              { a: "{word1}", op: "not", b: "paper" },
              { a: "{word1}", op: "not", b: "scissors" },
            ],
            do: [{ type: "say", text: "That's not a throw, {name}. Try: !rps rock" }],
          },
          {
            on: { type: "command", word: "rps" },
            if: [{ a: "{word1}", op: "is", b: "{memory:m}" }],
            do: [{ type: "say", text: "We both throw {memory:m}. Tie! 🤝" }],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "rock" },
              { a: "{memory:m}", op: "is", b: "scissors" },
            ],
            do: [
              { type: "add", var: "wins", per: "user", amount: "1" },
              { type: "say", text: "You throw rock, I throw scissors. {name} wins! 🎉 ({mymemory:wins} wins)" },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "paper" },
              { a: "{memory:m}", op: "is", b: "rock" },
            ],
            do: [
              { type: "add", var: "wins", per: "user", amount: "1" },
              { type: "say", text: "You throw paper, I throw rock. {name} wins! 🎉 ({mymemory:wins} wins)" },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "scissors" },
              { a: "{memory:m}", op: "is", b: "paper" },
            ],
            do: [
              { type: "add", var: "wins", per: "user", amount: "1" },
              { type: "say", text: "You throw scissors, I throw paper. {name} wins! 🎉 ({mymemory:wins} wins)" },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "rock" },
              { a: "{memory:m}", op: "is", b: "paper" },
            ],
            do: [{ type: "say", text: "You throw rock, I throw paper. {bot} wins! 😎" }],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "paper" },
              { a: "{memory:m}", op: "is", b: "scissors" },
            ],
            do: [{ type: "say", text: "You throw paper, I throw scissors. {bot} wins! 😎" }],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "scissors" },
              { a: "{memory:m}", op: "is", b: "rock" },
            ],
            do: [{ type: "say", text: "You throw scissors, I throw rock. {bot} wins! 😎" }],
          },
        ],
      },
    },
    {
      key: "fishing",
      icon: "fa-fish",
      level: "hard",
      name: "Fishing",
      blurb: "!fish to cast, !coins for your money. A little economy the whole room shares.",
      bot: {
        name: "FishBot",
        rules: [
          {
            on: { type: "command", word: "fish" },
            if: [],
            do: [
              {
                type: "random",
                var: "catch",
                per: "user",
                from: "an old boot 👢, a tiny minnow, a decent perch, a fat bass, a shiny salmon, a GOLDEN KOI 🌟",
              },
              { type: "add", var: "casts", per: "user", amount: "1" },
              { type: "say", text: "{name} casts a line... 🎣" },
              { type: "wait", seconds: 2.5 },
              { type: "say", text: "...and reels in {mymemory:catch}! (cast #{mymemory:casts})" },
            ],
          },
          {
            on: { type: "command", word: "fish" },
            if: [{ a: "{mymemory:catch}", op: "is", b: "a tiny minnow" }],
            do: [{ type: "add", var: "coins", per: "user", amount: "1" }],
          },
          {
            on: { type: "command", word: "fish" },
            if: [{ a: "{mymemory:catch}", op: "is", b: "a decent perch" }],
            do: [{ type: "add", var: "coins", per: "user", amount: "2" }],
          },
          {
            on: { type: "command", word: "fish" },
            if: [{ a: "{mymemory:catch}", op: "is", b: "a fat bass" }],
            do: [{ type: "add", var: "coins", per: "user", amount: "3" }],
          },
          {
            on: { type: "command", word: "fish" },
            if: [{ a: "{mymemory:catch}", op: "is", b: "a shiny salmon" }],
            do: [{ type: "add", var: "coins", per: "user", amount: "5" }],
          },
          {
            on: { type: "command", word: "fish" },
            if: [{ a: "{mymemory:catch}", op: "has", b: "GOLDEN KOI" }],
            do: [
              { type: "add", var: "coins", per: "user", amount: "25" },
              { type: "say", text: "🌟 A GOLDEN KOI! 25 coins to {name}!" },
            ],
          },
          {
            on: { type: "command", word: "coins" },
            if: [],
            do: [{ type: "say", text: "💰 {name} has {mymemory:coins} coins from {mymemory:casts} casts." }],
          },
        ],
      },
    },
  ];

  const LEVEL_LABEL = { easy: "EASY", medium: "MEDIUM", hard: "HARD" };

  // ── Views ─────────────────────────────────────────────────────────────────

  function showView(name) {
    document
      .querySelectorAll(".bc-view")
      .forEach((v) => v.classList.remove("active"));
    document
      .querySelectorAll(".bc-nav-item")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    const el = $(name + "View");
    if (el) el.classList.add("active");
    if (name === "staff") socket.emit("staff bots list");
  }

  document.querySelectorAll(".bc-nav-item").forEach((b) =>
    b.addEventListener("click", () => {
      if (!me && b.dataset.view === "editor") return showView("gate");
      showView(b.dataset.view);
    }),
  );

  // ── Sign-in flow ──────────────────────────────────────────────────────────

  socket.on("connect", () => socket.emit("check signin status"));

  socket.on("connect_error", (err) => {
    toastr.error(err?.message || "Could not connect.");
  });

  socket.on("signin status", (s) => {
    if (!s?.isSignedIn) {
      me = null;
      showView("gate");
      return;
    }
    me = s;
    $("userChip").style.display = "";
    $("userChipName").textContent = s.username + " / " + (s.location || "");
    if (s.isDev || s.isMod) $("staffNav").style.display = "";
    socket.emit("bots status");
    socket.emit("get rooms");
    if (document.querySelector("#gateView.active")) showView("editor");
  });

  // ── Bots status: list, live card ──────────────────────────────────────────

  socket.on("bots status", (st) => {
    status = st;
    renderBotList();
    renderLive();
    renderDeployCard();
  });

  socket.on("bots error", (d) => toastr.error(d?.message || "Bot problem."));

  socket.on("bots saved", (d) => {
    toastr.success("Saved!");
    if (edit && !edit.id) edit.id = d.id;
    if (edit) $("deleteBtn").style.display = "";
  });

  socket.on("bots deployed", (d) => {
    if (d.pending) {
      toastr.info("Room made! Taking you there, your bot follows you in.");
      setTimeout(() => {
        window.location.href = "room.html?roomId=" + encodeURIComponent(d.roomId);
      }, 900);
      return;
    }
    toastr.success(`Your bot is now in "${d.roomName}".`);
    socket.emit("bots status");
  });

  socket.on("bot stopped", (d) => {
    toastr.info("Your bot came home: " + (d?.why || "stopped"));
    socket.emit("bots status");
  });

  function deployedInfo() {
    return status?.deployed || null;
  }

  function renderBotList() {
    const host = $("botList");
    host.innerHTML = "";
    const bots = status?.bots || [];
    if (!bots.length) {
      const note = document.createElement("div");
      note.className = "bc-empty-note";
      note.innerHTML =
        "Nothing here yet! Open a <b>ready-made bot</b> below to see how one works, or press <b>Make a new bot</b>.";
      host.appendChild(note);
      return;
    }
    for (const b of bots) {
      const card = document.createElement("div");
      card.className = "bc-bot-card";
      if (edit && edit.id === b.id) card.classList.add("active");
      const name = document.createElement("div");
      name.className = "bc-bot-card-name";
      if (deployedInfo()?.botId === b.id) {
        const dot = document.createElement("span");
        dot.className = "live-dot";
        name.appendChild(dot);
      }
      name.appendChild(document.createTextNode(b.name));
      const meta = document.createElement("div");
      meta.className = "bc-bot-card-meta";
      meta.textContent = b.rules.length + (b.rules.length === 1 ? " rule" : " rules");
      card.appendChild(name);
      card.appendChild(meta);
      card.addEventListener("click", () =>
        loadBot({ id: b.id, name: b.name, rules: b.rules }),
      );
      host.appendChild(card);
    }
  }

  function diffChip(level) {
    const chip = document.createElement("span");
    chip.className = "bc-diff " + level;
    chip.textContent = LEVEL_LABEL[level] || "EASY";
    return chip;
  }

  function renderExamples() {
    const host = $("exampleList");
    host.innerHTML = "";
    for (const t of TEMPLATES) {
      if (t.key === "blank") continue;
      const card = document.createElement("div");
      card.className = "bc-bot-card";
      const name = document.createElement("div");
      name.className = "bc-bot-card-name";
      const icon = document.createElement("i");
      icon.className = "fas " + t.icon;
      icon.style.color = "var(--tk-accent)";
      name.appendChild(icon);
      name.appendChild(document.createTextNode(" " + t.name));
      name.appendChild(diffChip(t.level));
      const meta = document.createElement("div");
      meta.className = "bc-bot-card-meta";
      meta.textContent = t.blurb;
      card.appendChild(name);
      card.appendChild(meta);
      card.addEventListener("click", () => {
        if (!me) return showView("gate");
        loadBot(JSON.parse(JSON.stringify({ id: null, name: t.bot.name, rules: t.bot.rules })));
        toastr.info("This is a ready-made bot. Try it, change it, then press Save to keep your copy.");
      });
      host.appendChild(card);
    }
  }
  renderExamples();

  function renderLive() {
    const d = deployedInfo();
    const card = $("liveCard");
    if (!d) {
      card.classList.remove("show");
      return;
    }
    const bot = (status?.bots || []).find((b) => b.id === d.botId);
    $("liveName").textContent = bot?.name || "Your bot";
    $("liveRoom").textContent = 'In "' + (d.roomName || d.roomId) + '"';
    const mins = Math.max(0, Math.round((Date.now() - d.since) / 60000));
    $("liveSince").textContent =
      (mins < 1 ? "Just went in" : "In there " + mins + " min") +
      (d.dropped ? " · " + d.dropped + " messages skipped (going too fast)" : "");
    card.classList.add("show");
  }

  $("liveStopBtn").addEventListener("click", () => socket.emit("bots stop"));

  // ── Template picker / editor open ─────────────────────────────────────────

  function renderTemplates() {
    const grid = $("tplGrid");
    grid.innerHTML = "";
    for (const t of TEMPLATES) {
      const el = document.createElement("div");
      el.className = "bc-tpl";
      const top = document.createElement("div");
      top.style.cssText = "display:flex;align-items:center";
      const icon = document.createElement("i");
      icon.className = "fas " + t.icon;
      top.appendChild(icon);
      top.appendChild(diffChip(t.level));
      const h = document.createElement("h4");
      h.textContent = t.name;
      const p = document.createElement("p");
      p.textContent = t.blurb;
      el.appendChild(top);
      el.appendChild(h);
      el.appendChild(p);
      el.addEventListener("click", () => {
        loadBot(JSON.parse(JSON.stringify({ id: null, name: t.bot.name, rules: t.bot.rules })));
      });
      grid.appendChild(el);
    }
  }

  $("newBotBtn").addEventListener("click", () => {
    if (!me) return showView("gate");
    if ((status?.bots || []).length >= (status?.limits?.maxSaved || 8))
      return toastr.error("You have the most bots you can keep. Delete one first.");
    edit = null;
    showView("editor");
    $("tplCard").style.display = "";
    $("editorBody").style.display = "none";
    renderTemplates();
  });

  function loadBot(bot) {
    edit = JSON.parse(JSON.stringify(bot));
    testDirty = true;
    showView("editor");
    $("tplCard").style.display = "none";
    $("editorBody").style.display = "";
    $("botName").value = edit.name || "";
    $("deleteBtn").style.display = edit.id ? "" : "none";
    resetTestRoom();
    renderRules();
    renderBotList();
    renderDeployCard();
  }

  $("botName").addEventListener("input", () => {
    if (edit) {
      edit.name = $("botName").value;
      testDirty = true;
      $("trBotName").textContent = (edit.name || "Bot") + " / Bot";
    }
  });

  // ── The rule editor ───────────────────────────────────────────────────────

  const TRIGGER_OPTIONS = [
    { v: "command", label: "someone types !command" },
    { v: "says", label: "someone says a phrase" },
    { v: "mention", label: "someone says the bot's name" },
    { v: "join", label: "someone joins the room" },
    { v: "leave", label: "someone leaves the room" },
    { v: "timer", label: "every X minutes" },
  ];

  const ACTION_OPTIONS = [
    { v: "say", label: "say something" },
    { v: "wait", label: "wait a moment" },
    { v: "set", label: "remember something" },
    { v: "add", label: "count up a memory" },
    { v: "random", label: "pick something random" },
    { v: "clear", label: "erase the bot's box" },
    { v: "leave", label: "leave the room" },
  ];

  const OP_OPTIONS = [
    { v: "is", label: "is exactly" },
    { v: "not", label: "is not" },
    { v: "gt", label: "is bigger than" },
    { v: "lt", label: "is smaller than" },
    { v: "has", label: "contains" },
  ];

  const MAGIC = [
    { tok: "{name}", desc: "who said it" },
    { tok: "{word1}", desc: "1st word after the command" },
    { tok: "{word2}", desc: "2nd word after the command" },
    { tok: "{words}", desc: "all the words after the command" },
    { tok: "{memory:coins}", desc: "a shared memory (any name)" },
    { tok: "{mymemory:coins}", desc: "that person's own memory" },
    { tok: "{rand:1-6}", desc: "random number, new every time" },
    { tok: "{pick:red|green|blue}", desc: "random choice, new every time" },
    { tok: "{bot}", desc: "the bot's name" },
    { tok: "{room}", desc: "the room's name" },
    { tok: "{humans}", desc: "how many people are here" },
    { tok: "{time}", desc: "the time right now" },
  ];

  function touch() {
    testDirty = true;
  }

  function mkSelect(options, value, onChange, cls, title) {
    const sel = document.createElement("select");
    sel.className = "bc-select" + (cls ? " " + cls : "");
    if (title) sel.title = title;
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener("change", () => {
      onChange(sel.value);
      touch();
    });
    return sel;
  }

  function mkInput(value, placeholder, onInput, cls) {
    const inp = document.createElement("input");
    inp.className = "bc-input" + (cls ? " " + cls : "");
    inp.value = value == null ? "" : value;
    inp.placeholder = placeholder || "";
    inp.addEventListener("input", () => {
      onInput(inp.value);
      touch();
    });
    return inp;
  }

  // The wand menu: inserts a magic word at the cursor so nobody has to
  // remember curly-bracket spelling. One open menu at a time.
  let openMagicMenu = null;
  function mkMagicButton(target) {
    const wrap = document.createElement("span");
    wrap.className = "bc-magic-wrap";
    const btn = document.createElement("button");
    btn.className = "bc-magic-btn";
    btn.type = "button";
    btn.title = "Put in a magic word";
    btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openMagicMenu) openMagicMenu.remove();
      const menu = document.createElement("div");
      menu.className = "bc-magic-menu";
      for (const m of MAGIC) {
        const item = document.createElement("button");
        item.className = "bc-magic-item";
        item.type = "button";
        const code = document.createElement("code");
        code.textContent = m.tok;
        const span = document.createElement("span");
        span.textContent = m.desc;
        item.appendChild(code);
        item.appendChild(span);
        item.addEventListener("click", () => {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          target.value =
            target.value.slice(0, start) + m.tok + target.value.slice(end);
          target.dispatchEvent(new Event("input", { bubbles: false }));
          target.focus();
          menu.remove();
          openMagicMenu = null;
        });
        menu.appendChild(item);
      }
      wrap.appendChild(menu);
      openMagicMenu = menu;
    });
    wrap.appendChild(btn);
    return wrap;
  }
  document.addEventListener("click", () => {
    if (openMagicMenu) {
      openMagicMenu.remove();
      openMagicMenu = null;
    }
  });

  function mkRowButtons(buttons) {
    const wrap = document.createElement("span");
    wrap.className = "bc-row-btns";
    for (const b of buttons) wrap.appendChild(b);
    return wrap;
  }

  function mkIconButton(title, icon, onClick, disabled) {
    const btn = document.createElement("button");
    btn.className = "bc-row-del";
    btn.title = title;
    btn.innerHTML = '<i class="fas ' + icon + '"></i>';
    if (disabled) btn.disabled = true;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderRules() {
    const host = $("rulesHost");
    host.innerHTML = "";
    (edit.rules || []).forEach((rule, ri) => host.appendChild(ruleCard(rule, ri)));
  }

  function ruleCard(rule, ri) {
    const card = document.createElement("div");
    card.className = "bc-rule";
    card.dataset.ri = String(ri);

    // WHEN
    const head = document.createElement("div");
    head.className = "bc-rule-head";
    const kicker = document.createElement("span");
    kicker.className = "bc-rule-kicker";
    kicker.textContent = "WHEN";
    head.appendChild(kicker);
    head.appendChild(
      mkSelect(TRIGGER_OPTIONS, rule.on.type, (v) => {
        rule.on = { type: v };
        if (v === "command") rule.on.word = "hello";
        if (v === "says") rule.on.text = "";
        if (v === "timer") rule.on.minutes = 5;
        renderRules();
      }, "w-trig"),
    );
    if (rule.on.type === "command") {
      const bang = document.createElement("span");
      bang.style.color = "var(--tk-detail)";
      bang.textContent = "!";
      head.appendChild(bang);
      head.appendChild(
        mkInput(rule.on.word, "word", (v) => (rule.on.word = v.replace(/^!/, "")), "w-word"),
      );
    } else if (rule.on.type === "says") {
      head.appendChild(mkInput(rule.on.text, "the phrase to listen for", (v) => (rule.on.text = v), "w-grow"));
    } else if (rule.on.type === "timer") {
      const n = mkInput(rule.on.minutes, "5", (v) => (rule.on.minutes = Number(v)), "w-num");
      n.type = "number";
      n.min = "2";
      n.max = "120";
      head.appendChild(n);
      const lbl = document.createElement("span");
      lbl.className = "bc-unit";
      lbl.textContent = "minutes";
      head.appendChild(lbl);
    }
    head.appendChild(
      mkRowButtons([
        mkIconButton("Throw this rule away", "fa-trash", () => {
          edit.rules.splice(ri, 1);
          touch();
          renderRules();
        }),
      ]),
    );
    card.appendChild(head);

    // ONLY IF
    const ifSec = document.createElement("div");
    ifSec.className = "bc-rule-section";
    (rule.if || []).forEach((cond, ci) => {
      const row = document.createElement("div");
      row.className = "bc-cond-row";
      const k = document.createElement("span");
      k.className = "bc-rule-kicker";
      k.textContent = ci === 0 ? "ONLY IF" : "AND";
      row.appendChild(k);
      const aInput = mkInput(cond.a, "{word1}", (v) => (cond.a = v), "w-val");
      row.appendChild(aInput);
      row.appendChild(mkMagicButton(aInput));
      row.appendChild(mkSelect(OP_OPTIONS, cond.op, (v) => (cond.op = v), "w-per"));
      row.appendChild(mkInput(cond.b, "what it should be", (v) => (cond.b = v), "w-val"));
      row.appendChild(
        mkRowButtons([
          mkIconButton("Remove this check", "fa-xmark", () => {
            rule.if.splice(ci, 1);
            touch();
            renderRules();
          }),
        ]),
      );
      ifSec.appendChild(row);
    });
    if ((rule.if || []).length < 3) {
      const addIf = document.createElement("button");
      addIf.className = "bc-mini-btn";
      addIf.innerHTML =
        '<i class="fas fa-plus"></i> check' +
        ((rule.if || []).length ? "" : " (you can skip this)");
      addIf.addEventListener("click", () => {
        if (!rule.if) rule.if = [];
        rule.if.push({ a: "{word1}", op: "is", b: "" });
        touch();
        renderRules();
      });
      ifSec.appendChild(addIf);
    }
    card.appendChild(ifSec);

    // DO
    const doSec = document.createElement("div");
    doSec.className = "bc-rule-section";
    (rule.do || []).forEach((act, ai) => {
      doSec.appendChild(actionRow(rule, act, ai));
    });
    if ((rule.do || []).length < 6) {
      const addDo = document.createElement("button");
      addDo.className = "bc-mini-btn";
      addDo.innerHTML = '<i class="fas fa-plus"></i> another thing to do';
      addDo.addEventListener("click", () => {
        rule.do.push({ type: "say", text: "" });
        touch();
        renderRules();
      });
      doSec.appendChild(addDo);
    }
    card.appendChild(doSec);

    return card;
  }

  function actionRow(rule, act, ai) {
    const row = document.createElement("div");
    row.className = "bc-act-row";
    const k = document.createElement("span");
    k.className = "bc-rule-kicker";
    k.textContent = ai === 0 ? "DO" : "THEN";
    row.appendChild(k);
    row.appendChild(
      mkSelect(ACTION_OPTIONS, act.type, (v) => {
        const idx = rule.do.indexOf(act);
        const fresh = { type: v };
        if (v === "say") fresh.text = "";
        if (v === "wait") fresh.seconds = 2;
        if (v === "set") Object.assign(fresh, { var: "prize", per: "bot", value: "" });
        if (v === "add") Object.assign(fresh, { var: "points", per: "user", amount: "1" });
        if (v === "random") Object.assign(fresh, { var: "prize", per: "bot", from: "a, b, c" });
        rule.do[idx] = fresh;
        renderRules();
      }, "w-act"),
    );

    const perSelect = (a) =>
      mkSelect(
        [
          { v: "bot", label: "shared by everyone" },
          { v: "user", label: "each person their own" },
        ],
        a.per || "bot",
        (v) => (a.per = v),
        "w-per",
        "One box for the whole room, or one box per person",
      );

    if (act.type === "say") {
      const t = document.createElement("textarea");
      t.className = "bc-input w-grow";
      t.rows = 1;
      t.maxLength = 300;
      t.placeholder = "Hi {name}!";
      t.value = act.text || "";
      t.addEventListener("input", () => {
        act.text = t.value;
        touch();
      });
      row.appendChild(t);
      row.appendChild(mkMagicButton(t));
    } else if (act.type === "wait") {
      const n = mkInput(act.seconds, "2", (v) => (act.seconds = Number(v)), "w-num");
      n.type = "number";
      n.step = "0.5";
      n.min = "0.5";
      n.max = "10";
      row.appendChild(n);
      const lbl = document.createElement("span");
      lbl.className = "bc-unit";
      lbl.textContent = "seconds";
      row.appendChild(lbl);
    } else if (act.type === "set") {
      row.appendChild(mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"));
      row.appendChild(perSelect(act));
      const eq = document.createElement("span");
      eq.className = "bc-unit";
      eq.textContent = "=";
      row.appendChild(eq);
      const vInput = mkInput(act.value, "what to write down", (v) => (act.value = v), "w-val");
      row.appendChild(vInput);
      row.appendChild(mkMagicButton(vInput));
    } else if (act.type === "add") {
      row.appendChild(mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"));
      row.appendChild(perSelect(act));
      const plus = document.createElement("span");
      plus.className = "bc-unit";
      plus.textContent = "+";
      row.appendChild(plus);
      row.appendChild(mkInput(act.amount, "1", (v) => (act.amount = v), "w-num"));
    } else if (act.type === "random") {
      row.appendChild(mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"));
      row.appendChild(perSelect(act));
      const from = document.createElement("span");
      from.className = "bc-unit";
      from.textContent = "from";
      row.appendChild(from);
      row.appendChild(
        mkInput(act.from, "red, green, blue (or 1-100)", (v) => (act.from = v), "w-grow"),
      );
    }

    // Order matters: picking a random prize has to happen ABOVE saying it.
    row.appendChild(
      mkRowButtons([
        mkIconButton("Move up", "fa-chevron-up", () => {
          rule.do.splice(ai - 1, 0, rule.do.splice(ai, 1)[0]);
          touch();
          renderRules();
        }, ai === 0),
        mkIconButton("Move down", "fa-chevron-down", () => {
          rule.do.splice(ai + 1, 0, rule.do.splice(ai, 1)[0]);
          touch();
          renderRules();
        }, ai === rule.do.length - 1),
        mkIconButton("Remove this action", "fa-xmark", () => {
          rule.do.splice(ai, 1);
          touch();
          renderRules();
        }),
      ]),
    );
    return row;
  }

  $("addRuleBtn").addEventListener("click", () => {
    if (edit.rules.length >= (status?.limits?.maxRules || 20))
      return toastr.error("That's the most rules a bot can have.");
    edit.rules.push({
      on: { type: "command", word: "hello" },
      if: [],
      do: [{ type: "say", text: "" }],
    });
    touch();
    renderRules();
  });

  // ── Save / delete ─────────────────────────────────────────────────────────

  $("saveBtn").addEventListener("click", () => {
    if (!edit) return;
    socket.emit("bots save", {
      id: edit.id || undefined,
      bot: { name: edit.name, rules: edit.rules },
    });
  });

  $("deleteBtn").addEventListener("click", () => {
    if (!edit?.id) return;
    if (!confirm(`Delete "${edit.name}" forever?`)) return;
    socket.emit("bots delete", { id: edit.id });
    edit = null;
    $("editorBody").style.display = "none";
  });

  // ── The test room ─────────────────────────────────────────────────────────
  // Behaves like room.html: you type into YOUR textbox, and after your last
  // line sits still for a moment the bot reads it, exactly like a live room.
  // The bot types into ITS textbox letter by letter. No send button exists.

  const SETTLE_MS = 1200; // a touch quicker than a live room, same idea
  let settleTimer = null;
  let lastProcessedLine = "";
  let testWaiting = null; // callback parked until "bots test ready"
  let botTimers = []; // pending say animations, cleared on bot switch

  function lastNonEmptyLine(text) {
    const lines = String(text || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (l) return l;
    }
    return "";
  }

  function ensureTest(then) {
    if (!edit) return;
    if (!testDirty) return then();
    testWaiting = then;
    socket.emit("bots test start", {
      bot: { name: edit.name, rules: edit.rules },
      keepMemory: true,
    });
  }

  socket.on("bots test ready", () => {
    testDirty = false;
    const go = testWaiting;
    testWaiting = null;
    if (go) go();
  });

  socket.on("bots test error", (d) => {
    testWaiting = null;
    setTestStatus("Problem with the rules: " + (d?.message || "something is not right."));
    toastr.error(d?.message || "Something in the rules is not right.");
  });

  function setTestStatus(text) {
    $("trStatus").textContent = text;
  }

  function resetTestRoom() {
    for (const t of botTimers) clearTimeout(t);
    botTimers = [];
    lastProcessedLine = "";
    $("trMyBox").value = "";
    $("trBotBox").textContent = "";
    $("trBotTyping").style.display = "none";
    $("trMyName").textContent = me ? me.username + " / " + (me.location || "here") : "You";
    $("trBotName").textContent = (edit?.name || "Bot") + " / Bot";
    setTestStatus(
      "Type in your box. When your last line sits still for a second, " +
        (edit?.name || "the bot") + " reads it.",
    );
  }

  $("trMyBox").addEventListener("input", () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settledLine, SETTLE_MS);
  });

  function settledLine() {
    if (!edit) return;
    const text = $("trMyBox").value;
    const line = lastNonEmptyLine(text);
    if (!line || line === lastProcessedLine) return;
    lastProcessedLine = line;
    ensureTest(() => socket.emit("bots test say", { text }));
  }

  // The bot's box works like the real one: a new message replaces what was
  // there, typed out letter by letter.
  function typeIntoBotBox(text, delayMs) {
    botTimers.push(
      setTimeout(() => {
        const box = $("trBotBox");
        $("trBotTyping").style.display = "";
        let i = 0;
        const iv = setInterval(() => {
          i = Math.min(text.length, i + 2);
          box.textContent = text.slice(0, i);
          box.scrollTop = box.scrollHeight;
          if (i >= text.length) {
            clearInterval(iv);
            $("trBotTyping").style.display = "none";
          }
        }, 30);
      }, delayMs),
    );
  }

  function markRules(indices, cls, tagText) {
    for (const ri of indices || []) {
      const card = document.querySelector('.bc-rule[data-ri="' + ri + '"]');
      if (!card) continue;
      card.classList.add(cls);
      const head = card.querySelector(".bc-rule-head");
      const tag = document.createElement("span");
      tag.className = "bc-rule-tag " + (cls === "fired" ? "ran" : "skip");
      tag.textContent = tagText;
      head.appendChild(tag);
      setTimeout(() => {
        card.classList.remove(cls);
        tag.remove();
      }, 2600);
    }
  }

  socket.on("bots test out", (d) => {
    markRules(d.fired, "fired", "ran ✓");
    markRules(
      (d.skipped || []).filter((ri) => !(d.fired || []).includes(ri)),
      "skipped",
      "checks said no",
    );

    for (const s of d.says || []) {
      if (s.clear) botTimers.push(setTimeout(() => ($("trBotBox").textContent = ""), s.delayMs));
      else typeIntoBotBox(s.text, s.delayMs);
    }

    if (d.left) setTestStatus((edit?.name || "The bot") + " left the room. Its rule told it to.");
    else if (d.about === "say" && !(d.fired || []).length && !(d.skipped || []).length)
      setTestStatus("No rule woke up for that line. Check the WHEN parts.");
    else if (d.about === "say" && !(d.says || []).length && (d.skipped || []).length && !(d.fired || []).length)
      setTestStatus("A rule heard you, but its checks said no.");
    else if (d.about === "say")
      setTestStatus("");

    renderTestMemories(d);
  });

  function renderTestMemories(d) {
    const body = $("testMemBody");
    const parts = [];
    const fmt = (obj) =>
      Object.entries(obj || {})
        .map(([k, v]) => "<b>" + esc(k) + "</b>: " + esc(String(v)))
        .join(" · ");
    if (d.memories && Object.keys(d.memories).length)
      parts.push("Shared: " + fmt(d.memories));
    if (d.myMemories && Object.keys(d.myMemories).length)
      parts.push("Yours: " + fmt(d.myMemories));
    if (d.friendMemories && Object.keys(d.friendMemories).length)
      parts.push("Testy's: " + fmt(d.friendMemories));
    body.innerHTML = parts.length ? parts.join("<br/>") : "Nothing yet.";
  }

  function esc(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  $("testJoinBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("Testy walks into the room...");
    ensureTest(() => socket.emit("bots test event", { kind: "join" }));
  });
  $("testLeaveBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("Testy walks out...");
    ensureTest(() => socket.emit("bots test event", { kind: "leave" }));
  });
  $("testTimerBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("Every timer rule goes off right now.");
    ensureTest(() => socket.emit("bots test event", { kind: "timer" }));
  });
  $("testResetBtn").addEventListener("click", () => {
    if (!edit) return;
    ensureTest(() => {
      socket.emit("bots test reset");
      setTestStatus("The bot's test memory is wiped clean.");
    });
  });

  // ── Deploy ────────────────────────────────────────────────────────────────

  function renderDeployCard() {
    const card = $("deployCard");
    const saved = edit && (status?.bots || []).some((b) => b.id === edit.id);
    card.style.display = saved ? "" : "none";
    if (!saved) return;
    const d = deployedInfo();
    const btn = $("deployBtn");
    const note = $("deployNote");
    if (d) {
      btn.disabled = true;
      note.textContent =
        d.botId === edit.id
          ? "It's out there right now! Bring it home (sidebar) to send it again."
          : "One bot out at a time. Bring the other one home first.";
    } else {
      btn.disabled = false;
      note.textContent =
        status?.enabled === false ? "Bots are switched off by the mods right now." : "";
      if (status?.enabled === false) btn.disabled = true;
    }
  }

  $("optExisting").addEventListener("click", () => setDeployMode("existing"));
  $("optNew").addEventListener("click", () => setDeployMode("new"));

  function setDeployMode(mode) {
    deployMode = mode;
    $("optExisting").classList.toggle("sel", mode === "existing");
    $("optNew").classList.toggle("sel", mode === "new");
  }

  $("roomRefresh").addEventListener("click", () => socket.emit("get rooms"));

  socket.on("initial rooms", (list) => {
    const rooms = Array.isArray(list) ? list : [];
    const sel = $("roomSelect");
    sel.innerHTML = "";
    const open = rooms.filter(
      (r) => r.type === "public" && (r.users || []).some((u) => !u.isBotUser),
    );
    if (!open.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No rooms with people right now";
      sel.appendChild(opt);
      return;
    }
    for (const r of open) {
      const users = r.users || [];
      const humans = users.filter((u) => !u.isBotUser).length;
      const bots = users.filter((u) => u.isBotUser).length;
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent =
        r.name +
        " · " +
        humans +
        (humans === 1 ? " person" : " people") +
        (bots ? ", " + bots + (bots === 1 ? " bot" : " bots") : "");
      sel.appendChild(opt);
    }
  });

  $("deployBtn").addEventListener("click", () => {
    if (!edit?.id) return;
    if (deployMode === "existing") {
      const roomId = $("roomSelect").value;
      if (!roomId) return toastr.error("Pick a room first (or make a new one).");
      socket.emit("bots deploy", { id: edit.id, roomId });
    } else {
      const name = $("newRoomName").value.trim();
      if (name.length < 3) return toastr.error("Give the new room a name (3+ letters).");
      socket.emit("bots deploy", { id: edit.id, newRoom: { name } });
    }
  });

  // ── Staff ─────────────────────────────────────────────────────────────────

  socket.on("staff bots list", (d) => {
    const body = $("staffBotsBody");
    const empty = $("staffEmpty");
    body.innerHTML = "";
    const bots = d?.bots || [];
    empty.style.display = bots.length ? "none" : "";
    if (me?.isDev) {
      $("staffMasterWrap").style.display = "";
      const btn = $("masterToggleBtn");
      btn.textContent = d?.enabled === false ? "Turn bots ON" : "Turn ALL bots OFF";
      btn.onclick = () =>
        socket.emit("staff bots toggle", { enabled: d?.enabled === false });
    }
    for (const b of bots) {
      const tr = document.createElement("tr");
      const tier = document.createElement("td");
      const chip = document.createElement("span");
      chip.className = "bc-tier-chip " + (b.tier === 2 ? "t2" : "t1");
      chip.textContent = b.tier === 2 ? "API" : "HOSTED";
      tier.appendChild(chip);
      const name = document.createElement("td");
      name.textContent = b.name || "?";
      const room = document.createElement("td");
      room.textContent = b.roomName || (b.roomId ? b.roomId : "not in a room");
      const owner = document.createElement("td");
      owner.textContent = b.owner || "-";
      const up = document.createElement("td");
      up.textContent = b.since
        ? Math.max(0, Math.round((Date.now() - b.since) / 60000)) + "m"
        : "-";
      const act = document.createElement("td");
      if (b.botUserId) {
        const kill = document.createElement("button");
        kill.className = "bc-btn danger";
        kill.innerHTML = '<i class="fas fa-power-off"></i>Kill';
        kill.addEventListener("click", () => {
          socket.emit("staff bots kill", { botUserId: b.botUserId });
          setTimeout(() => socket.emit("staff bots list"), 500);
        });
        act.appendChild(kill);
      }
      tr.appendChild(tier);
      tr.appendChild(name);
      tr.appendChild(room);
      tr.appendChild(owner);
      tr.appendChild(up);
      tr.appendChild(act);
      body.appendChild(tr);
    }
  });

  socket.on("staff action result", () => socket.emit("staff bots list"));

  // ── Misc ──────────────────────────────────────────────────────────────────

  // Live status refresh while a bot is out in a room and this tab is open.
  setInterval(() => {
    if (me && deployedInfo()) socket.emit("bots status");
  }, 5000);

  // The docs show real URLs for this deployment, not a hardcoded host.
  document
    .querySelectorAll(".js-origin")
    .forEach((el) => (el.textContent = window.location.origin));

  socket.on("error", (e) => {
    const msg = e?.error?.message;
    if (msg) toastr.error(msg);
  });
})();
