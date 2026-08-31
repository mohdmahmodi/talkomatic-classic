// botcreator.js
// The Bot Creator page, in two screens.

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

  // ── Page state ────────────────────────────────────────────────────────────

  let me = null;
  let status = null;
  let edit = null;
  let dirty = false;
  let deployMode = "existing";
  let testDirty = true;

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
        location: "the door",
        rules: [
          {
            on: { type: "join" },
            if: [],
            do: [
              { type: "wait", seconds: 1 },
              {
                type: "say",
                text: "Welcome to {room}, {name}! 👋 That makes {humans} of us.",
              },
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
      key: "admin",
      icon: "fa-user-shield",
      level: "easy",
      name: "Admin commands",
      blurb: "Owner-only controls: !say, !clear, !gohome. Only you can use them.",
      bot: {
        name: "AdminBot",
        location: "on duty",
        rules: [
          {
            on: { type: "command", word: "admin" },
            who: "owner",
            if: [],
            do: [
              {
                type: "say",
                text: "My admin commands (only {owner} can use these):{newline}{ownercommands}",
              },
            ],
          },
          {
            on: { type: "command", word: "say" },
            who: "owner",
            if: [],
            do: [{ type: "say", text: "{words}" }],
          },
          {
            on: { type: "command", word: "clear" },
            who: "owner",
            if: [],
            do: [{ type: "clear" }],
          },
          {
            on: { type: "command", word: "gohome" },
            who: "owner",
            if: [],
            do: [
              { type: "say", text: "Off I go. 👋" },
              { type: "wait", seconds: 1.5 },
              { type: "leave" },
            ],
          },
          {
            on: { type: "command", word: "help" },
            if: [],
            do: [{ type: "say", text: "I only take orders from {owner}." }],
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
      key: "math",
      icon: "fa-calculator",
      level: "easy",
      name: "Calculator",
      blurb: "!double 7 and !half 40. Shows the math actions.",
      bot: {
        name: "MathBot",
        rules: [
          {
            on: { type: "command", word: "double" },
            if: [],
            do: [
              { type: "set", var: "n", per: "bot", value: "{word1}" },
              { type: "add", var: "n", per: "bot", amount: "2", op: "mul" },
              { type: "say", text: "{word1} doubled is {memory:n}!" },
            ],
          },
          {
            on: { type: "command", word: "half" },
            if: [],
            do: [
              { type: "set", var: "n", per: "bot", value: "{word1}" },
              { type: "add", var: "n", per: "bot", amount: "2", op: "div" },
              { type: "say", text: "Half of {word1} is {memory:n}." },
            ],
          },
        ],
      },
    },
    {
      key: "notebook",
      icon: "fa-book-open",
      level: "medium",
      name: "Notebook",
      blurb:
        "!remember pizza extra cheese, !recall pizza, !forget pizza. Memories picked by name.",
      bot: {
        name: "NoteBot",
        rules: [
          {
            on: { type: "command", word: "remember" },
            if: [{ a: "{word2}", op: "not", b: "" }],
            do: [
              {
                type: "set",
                var: "note_{word1}",
                per: "bot",
                value: "{words2}",
              },
              { type: "say", text: '📝 Noted. Ask me with "!recall {word1}".' },
            ],
          },
          {
            on: { type: "command", word: "remember" },
            if: [{ a: "{word2}", op: "is", b: "" }],
            do: [
              {
                type: "say",
                text: "Tell me the name and the note: !remember pizza extra cheese",
              },
            ],
          },
          {
            on: { type: "command", word: "recall" },
            if: [{ a: "{word1}", op: "not", b: "" }],
            do: [
              {
                type: "say",
                text: "📖 {word1}: {memory:note_{word1}|I have no note called {word1}.}",
              },
            ],
          },
          {
            on: { type: "command", word: "forget" },
            if: [{ a: "{word1}", op: "not", b: "" }],
            do: [
              { type: "set", var: "note_{word1}", per: "bot", value: "" },
              { type: "say", text: "🗑️ Forgot {word1}." },
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
              {
                type: "say",
                text: "❓ What has keys but can't open doors? Answer with: !answer yourguess",
              },
            ],
          },
          {
            on: { type: "command", word: "answer" },
            if: [{ a: "{word1}", op: "is", b: "piano" }],
            do: [
              { type: "add", var: "points", per: "user", amount: "1" },
              {
                type: "say",
                text: "🏆 Right, {name}! A piano. You have {mymemory:points} points.",
              },
            ],
          },
          {
            on: { type: "command", word: "answer" },
            if: [{ a: "{word1}", op: "not", b: "piano" }],
            do: [{ type: "say", text: 'Nope, not "{word1}". Try again!' }],
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
      blurb:
        "The whole room guesses together. First right answer wins the round.",
      bot: {
        name: "GuessBot",
        rules: [
          {
            on: { type: "command", word: "start" },
            if: [],
            do: [
              { type: "random", var: "secret", per: "bot", from: "1-100" },
              {
                type: "say",
                text: "🎯 I picked a number from 1 to 100. Anyone can guess: !guess 50",
              },
            ],
          },
          {
            on: { type: "command", word: "guess" },
            if: [{ a: "{memory:secret}", op: "is", b: "0" }],
            do: [
              {
                type: "say",
                text: "No number picked yet. Type !start to begin a round.",
              },
            ],
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
              {
                type: "say",
                text: "🎉 {name} got it! It was {memory:secret}. That makes {mymemory:wins} wins. Type !start for a new round.",
              },
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
            do: [
              {
                type: "random",
                var: "m",
                per: "bot",
                from: "rock, paper, scissors",
              },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "not", b: "rock" },
              { a: "{word1}", op: "not", b: "paper" },
              { a: "{word1}", op: "not", b: "scissors" },
            ],
            do: [
              {
                type: "say",
                text: "That's not a throw, {name}. Try: !rps rock",
              },
            ],
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
              {
                type: "say",
                text: "You throw rock, I throw scissors. {name} wins! 🎉 ({mymemory:wins} wins)",
              },
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
              {
                type: "say",
                text: "You throw paper, I throw rock. {name} wins! 🎉 ({mymemory:wins} wins)",
              },
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
              {
                type: "say",
                text: "You throw scissors, I throw paper. {name} wins! 🎉 ({mymemory:wins} wins)",
              },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "rock" },
              { a: "{memory:m}", op: "is", b: "paper" },
            ],
            do: [
              {
                type: "say",
                text: "You throw rock, I throw paper. {bot} wins! 😎",
              },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "paper" },
              { a: "{memory:m}", op: "is", b: "scissors" },
            ],
            do: [
              {
                type: "say",
                text: "You throw paper, I throw scissors. {bot} wins! 😎",
              },
            ],
          },
          {
            on: { type: "command", word: "rps" },
            if: [
              { a: "{word1}", op: "is", b: "scissors" },
              { a: "{memory:m}", op: "is", b: "rock" },
            ],
            do: [
              {
                type: "say",
                text: "You throw scissors, I throw rock. {bot} wins! 😎",
              },
            ],
          },
        ],
      },
    },
    {
      key: "fishing",
      icon: "fa-fish",
      level: "hard",
      name: "Fishing",
      blurb:
        "!fish to cast, !coins for your money. A little economy the whole room shares.",
      bot: {
        name: "FishBot",
        location: "the lake",
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
              {
                type: "say",
                text: "...and reels in {mymemory:catch}! (cast #{mymemory:casts})",
              },
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
            do: [
              {
                type: "say",
                text: "💰 {name} has {mymemory:coins} coins from {mymemory:casts} casts.",
              },
            ],
          },
        ],
      },
    },
  ];

  const LEVEL_LABEL = { easy: "EASY", medium: "MEDIUM", hard: "HARD" };

  // ── Vocabulary ────────────────────────────────────────────────────────────

  const TRIGGER_OPTIONS = [
    { v: "command", label: "someone types a command" },
    { v: "says", label: "someone says a phrase" },
    { v: "mention", label: "someone says the bot's name" },
    { v: "join", label: "someone joins the room" },
    { v: "leave", label: "someone leaves the room" },
    { v: "arrive", label: "the bot arrives in the room" },
    { v: "timer", label: "every X minutes" },
  ];

  const PREFIX_RE = /^[!?.,;:~#$%^&*+=/\\<>@|-]{1,2}$/;

  const WHO_OPTIONS = [
    { v: "", label: "anyone can trigger it" },
    { v: "owner", label: "admins only (me + bot managers)" },
  ];

  const ACTION_OPTIONS = [
    { v: "say", label: "say something", desc: "The bot types into its box" },
    {
      v: "append",
      label: "add a line below",
      desc: "Keeps what it said, writes underneath",
    },
    { v: "wait", label: "wait a moment", desc: "Pause before the next thing" },
    { v: "set", label: "remember something", desc: "Write a value into a memory" },
    {
      v: "add",
      label: "change a memory",
      desc: "Add, take away, multiply or divide it",
    },
    {
      v: "random",
      label: "pick something random",
      desc: "Choices or a number range, into a memory",
    },
    {
      v: "repeat",
      label: "repeat everything above",
      desc: "Runs the blocks above it again, up to 5 times",
    },
    { v: "clear", label: "erase the bot's box", desc: "Wipe what it wrote" },
    { v: "leave", label: "leave the room", desc: "The bot goes home" },
  ];

  const OP_OPTIONS = [
    { v: "is", label: "is exactly" },
    { v: "not", label: "is not" },
    { v: "gt", label: "is bigger than" },
    { v: "lt", label: "is smaller than" },
    { v: "has", label: "contains" },
  ];

  const MATH_OPTIONS = [
    { v: "add", label: "add" },
    { v: "sub", label: "take away" },
    { v: "mul", label: "multiply by" },
    { v: "div", label: "divide by" },
  ];

  const MAGIC = [
    { tok: "{name}", desc: "who said it" },
    { tok: "{word1}", desc: "1st word after the command" },
    { tok: "{word2}", desc: "2nd word after the command (up to {word8})" },
    { tok: "{words}", desc: "all the words after the command" },
    { tok: "{words2}", desc: "everything from the 2nd word on (up to {words8})" },
    { tok: "{memory:coins}", desc: "the room's shared memory (any name)" },
    { tok: "{mymemory:coins}", desc: "that person's own memory (any name)" },
    {
      tok: "{memory:note_{word1}}",
      desc: "a memory picked by name at runtime, from what they typed",
    },
    {
      tok: "{memory:coins|nothing yet}",
      desc: "a memory with your own text when nothing is stored",
    },
    { tok: "{rand:1-6}", desc: "random number, new every time" },
    { tok: "{pick:red|green|blue}", desc: "random choice, new every time" },
    { tok: "{newline}", desc: "start a new line mid-message" },
    { tok: "{commands}", desc: "every public command this bot has, one per line" },
    { tok: "{ownercommands}", desc: "every admin-only command, one per line" },
    { tok: "{prefix}", desc: "the bot's command prefix (like !)" },
    { tok: "{owner}", desc: "who runs the bot (you)" },
    { tok: "{runtime}", desc: "how long the bot has been in the room" },
    { tok: "{bot}", desc: "the bot's name" },
    { tok: "{room}", desc: "the room's name" },
    { tok: "{humans}", desc: "how many people are here" },
    { tok: "{time}", desc: "the time right now" },
  ];

  // ── Memories, visually ────────────────────────────────────────────────────

  let lastField = null;

  function fieldQualifies(el) {
    return !!(
      el &&
      el.closest &&
      el.closest("#rulesHost") &&
      ((el.matches("input.bc-input") && el.type !== "number") ||
        el.matches("textarea.bc-input"))
    );
  }

  document.addEventListener("focusin", (e) => {
    if (fieldQualifies(e.target)) lastField = e.target;
  });
  document.addEventListener("pointerdown", (e) => {
    if (fieldQualifies(e.target)) lastField = e.target;
  });

  function collectMemories() {
    const found = new Map();
    if (!edit) return [];
    for (const m of edit._memories || [])
      if (!found.has(m.name)) found.set(m.name, m.per);
    for (const r of edit.rules || []) {
      const texts = [];
      for (const a of r.do || []) {
        if (
          (a.type === "set" || a.type === "add" || a.type === "random") &&
          a.var &&
          !found.has(String(a.var).toLowerCase())
        )
          found.set(
            String(a.var).toLowerCase(),
            a.per === "user" ? "user" : "bot",
          );
        if (a.text) texts.push(a.text);
        if (a.value) texts.push(a.value);
        if (a.amount) texts.push(a.amount);
        if (a.from) texts.push(a.from);
      }
      for (const c of r.if || []) texts.push(c.a || "", c.b || "");
      for (const t of texts) {
        const re = /\{(memory|mymemory):([a-z0-9_]{1,20})\}/gi;
        let m;
        while ((m = re.exec(t))) {
          const nm = m[2].toLowerCase();
          if (!found.has(nm))
            found.set(nm, m[1].toLowerCase() === "mymemory" ? "user" : "bot");
        }
      }
    }
    return [...found].map(([name, per]) => ({ name, per }));
  }

  function memToken(m) {
    return (m.per === "user" ? "{mymemory:" : "{memory:") + m.name + "}";
  }

  function memKindLabel(per) {
    return per === "user" ? "each person's own" : "everyone's";
  }

  function insertIntoField(tok) {
    const t = fieldQualifies(document.activeElement)
      ? document.activeElement
      : lastField && document.body.contains(lastField)
        ? lastField
        : null;
    if (!t) {
      toastr.info("Click into a say or check box first, then click the memory.");
      return false;
    }
    const start = t.selectionStart ?? t.value.length;
    const end = t.selectionEnd ?? t.value.length;
    t.value = t.value.slice(0, start) + tok + t.value.slice(end);
    t.dispatchEvent(new Event("input", { bubbles: false }));
    t.focus();
    return true;
  }

  function openNewMemory() {
    const box = openModal(false);
    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-brain"></i> Make a memory';
    const p = document.createElement("p");
    p.textContent =
      "A memory is a labelled box the bot keeps, like coins or points. Pick a name and who it belongs to. Give it a value with a remember or change block; say it back by clicking the chip into a say box.";
    box.appendChild(h);
    box.appendChild(p);
    const inp = document.createElement("input");
    inp.className = "bc-input";
    inp.style.width = "100%";
    inp.maxLength = 20;
    inp.placeholder = "coins";
    box.appendChild(inp);
    const kinds = document.createElement("div");
    kinds.style.marginTop = "10px";
    let per = "user";
    const mkKind = (v, t, d) => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "bc-choice" + (per === v ? " sel" : "");
      const b = document.createElement("b");
      b.textContent = t;
      const s = document.createElement("span");
      s.textContent = d;
      c.appendChild(b);
      c.appendChild(s);
      c.addEventListener("click", () => {
        per = v;
        [...kinds.children].forEach((el) => el.classList.remove("sel"));
        c.classList.add("sel");
      });
      kinds.appendChild(c);
    };
    mkKind(
      "user",
      "Each person their own",
      "Sara's coins and Omar's coins are different boxes. For points and scores.",
    );
    mkKind(
      "bot",
      "One for everyone",
      "A single box the whole room shares. For a quiz answer or a group total.",
    );
    box.appendChild(kinds);
    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const cancel = document.createElement("button");
    cancel.className = "bc-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeModal);
    const make = document.createElement("button");
    make.className = "bc-btn primary";
    make.textContent = "Make it";
    make.addEventListener("click", () => {
      const name = inp.value.trim().toLowerCase().replace(/^\{|\}$/g, "");
      if (!/^[a-z0-9_]{1,20}$/i.test(name))
        return toastr.error("Memory names are 1-20 letters, digits or _.");
      if (!edit._memories) edit._memories = [];
      if (!collectMemories().some((m) => m.name === name))
        edit._memories.push({ name, per });
      closeModal();
      renderMemories();
      toastr.success(
        name +
          " is ready. Click into a text box, then click the chip to use it.",
      );
    });
    btns.appendChild(cancel);
    btns.appendChild(make);
    box.appendChild(btns);
    setTimeout(() => inp.focus(), 30);
  }

  function renderMemories() {
    const host = document.getElementById("palMemHost");
    if (!host) return;
    host.innerHTML = "";
    const mems = collectMemories();
    for (const m of mems) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bc-pal-blk p-mem";
      chip.title =
        "Click to drop " +
        memToken(m) +
        " into the box you were typing in";
      chip.innerHTML = '<i class="fas fa-brain"></i>';
      const label = document.createElement("span");
      label.className = "bc-pal-label";
      label.textContent = m.name + " · " + memKindLabel(m.per);
      chip.appendChild(label);
      chip.addEventListener("pointerdown", (e) => e.preventDefault());
      chip.addEventListener("click", () => insertIntoField(memToken(m)));
      host.appendChild(chip);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "bc-mini-btn";
    add.style.width = "100%";
    add.innerHTML = '<i class="fas fa-plus"></i> new memory';
    add.addEventListener("click", openNewMemory);
    host.appendChild(add);
  }

  function maxRules() {
    return status?.limits?.maxRules || 200;
  }

  function maxActs() {
    return status?.limits?.maxActions || 20;
  }

  function maxConds() {
    return status?.limits?.maxConditions || 10;
  }

  function sayLen() {
    return status?.limits?.sayLength || 1000;
  }

  function freshRule() {
    return {
      on: { type: "command", word: "hello" },
      if: [],
      do: [{ type: "say", text: "" }],
    };
  }

  function freshAction(v) {
    const fresh = { type: v };
    if (v === "say" || v === "append") fresh.text = "";
    if (v === "wait") fresh.seconds = 2;
    if (v === "set")
      Object.assign(fresh, { var: "prize", per: "bot", value: "" });
    if (v === "add")
      Object.assign(fresh, { var: "points", per: "user", amount: "1", op: "add" });
    if (v === "random")
      Object.assign(fresh, { var: "prize", per: "bot", from: "a, b, c" });
    if (v === "repeat") fresh.times = 2;
    return fresh;
  }

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
    document.body.classList.remove("bc-test-open");
    if (name === "staff") socket.emit("staff bots list");
  }

  document.querySelectorAll(".bc-nav-item").forEach((b) =>
    b.addEventListener("click", () => {
      if (!me && b.dataset.view === "home") return showView("gate");
      showView(b.dataset.view);
    }),
  );

  // ── Sign-in flow ──────────────────────────────────────────────────────────

  let connLost = false;
  let triedAutoSignin = false;

  socket.on("connect", () => {
    connLost = false;
    triedAutoSignin = false;
    socket.emit("check signin status");
    renderLive();
  });

  socket.on("disconnect", () => {
    connLost = true;
    renderLive();
  });

  socket.on("connect_error", (err) => {
    if (!connLost) toastr.error(err?.message || "Could not connect.");
    connLost = true;
    renderLive();
    setTimeout(() => {
      if (!socket.connected) socket.connect();
    }, 2500);
  });

  socket.on("signin status", (s) => {
    if (!s?.isSignedIn) {
      const savedName = localStorage.getItem("talkomaticUsername");
      if (savedName && !triedAutoSignin) {
        triedAutoSignin = true;
        socket.emit("join lobby", {
          username: savedName,
          location:
            localStorage.getItem("talkomaticLocation") || "On The Web",
        });
        return;
      }
      me = null;
      status = null;
      renderHome();
      showView("gate");
      return;
    }
    me = s;
    $("userChip").style.display = "";
    $("userChipName").textContent = s.username + " / " + (s.location || "");
    if (s.isDev || (s.isMod && (s.modLevel || 1) >= 2))
      $("staffNav").style.display = "";
    socket.emit("bots status");
    if (document.querySelector("#gateView.active")) showView("home");
  });

  // ── Bots status ───────────────────────────────────────────────────────────

  socket.on("bots status", (st) => {
    status = st;
    if (pendingReloadId) {
      const rb =
        (st.bots || []).find((x) => x.id === pendingReloadId) ||
        (st.shared || []).find((x) => x.id === pendingReloadId);
      pendingReloadId = null;
      if (rb && edit?.id === rb.id)
        loadBot({
          id: rb.id,
          name: rb.name,
          location: rb.location || "Bot",
          prefix: rb.prefix || "!",
          rules: rb.rules,
          updatedAt: rb.updatedAt,
          shared: edit.shared,
          sharedBy: edit.sharedBy,
        });
    }
    renderHome();
    renderEditorChrome();
    refreshManagersModal();
    refreshHistoryModal();
    renderNewsTab();
    maybeShowNews();
  });

  function deployedInfo() {
    return status?.deployed || null;
  }

  // ── Modals (one at a time) ────────────────────────────────────────────────

  function closeModal() {
    document.querySelectorAll(".bc-modal-back").forEach((el) => el.remove());
  }

  function openModal(wide) {
    closeModal();
    const back = document.createElement("div");
    back.className = "bc-modal-back";
    const box = document.createElement("div");
    box.className = "bc-modal" + (wide ? " wide" : "");
    back.appendChild(box);
    back.addEventListener("click", (e) => {
      if (e.target === back) closeModal();
    });
    document.body.appendChild(back);
    return box;
  }

  function infoModal(title, body) {
    const box = openModal(false);
    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-circle-info"></i> ';
    h.appendChild(document.createTextNode(title));
    const p = document.createElement("p");
    p.textContent = body;
    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const ok = document.createElement("button");
    ok.className = "bc-btn primary";
    ok.textContent = "OK";
    ok.addEventListener("click", closeModal);
    btns.appendChild(ok);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(btns);
  }

  const DEPLOY_HELP = {
    room_full: {
      title: "That room is full",
      body: "Every seat is taken. Pick another room, or make a brand new one and your bot will follow you in.",
    },
    room_bots_full: {
      title: "No bot seats left there",
      body: "Rooms get 1 bot seat for every 5 people they can hold, up to 5. That room's bot seats are taken, so pick another room or a bigger one.",
    },
    room_empty: {
      title: "Nobody is in that room",
      body: "Bots need at least one person to talk to, or they walk right back out. Join the room first, or pick one with people in it.",
    },
    room_gone: {
      title: "That room closed",
      body: "It emptied out and Talkomatic cleaned it up. The list has been refreshed, pick another one.",
    },
    room_locked: {
      title: "That room is locked",
      body: "The room is not letting anyone new in right now, bots included.",
    },
    room_banned: {
      title: "That room said no",
      body: "This bot was removed from that room, so it cannot go back in there. Any other room will still take it.",
    },
    already_running: {
      title: "One bot at a time",
      body: "You already have a bot out in a room. Bring it home first, then send this one.",
    },
    bots_off: {
      title: "Bots are off right now",
      body: "The moderators switched bots off for everyone. Try again later.",
    },
    busy: {
      title: "Too many bots right now",
      body: "The server is already running its limit of bots. Try again in a little while.",
    },
    maintenance: {
      title: "Maintenance in progress",
      body: "Talkomatic is being worked on. Try again in a few minutes.",
    },
  };

  socket.on("bots error", (d) => {
    const help = d?.code && DEPLOY_HELP[d.code];
    if (help) {
      socket.emit("get rooms");
      infoModal(help.title, help.body);
      return;
    }
    if (edit && document.querySelector("#editorView.active")) {
      setSaveNote("err", d?.message || "That could not be saved.");
      return;
    }
    toastr.error(d?.message || "Bot problem.");
  });

  socket.on("bots saved", (d) => {
    dirty = false;
    if (edit && !edit.id) edit.id = d.id;
    if (edit && d.updatedAt) edit.baseUpdatedAt = d.updatedAt;
    setSaveNote("ok", "Saved ✓");
    saveDraftNow();
    renderEditorChrome();
  });

  socket.on("bots deployed", (d) => {
    if (d.pending) {
      closeModal();
      toastr.info("Room made! Taking you there, your bot follows you in.");
      setTimeout(() => {
        window.location.href =
          "room.html?roomId=" + encodeURIComponent(d.roomId);
      }, 900);
      return;
    }
    closeModal();
    toastr.success(`Your bot is now in "${d.roomName}".`);
    socket.emit("bots status");
  });

  socket.on("bot stopped", (d) => {
    toastr.info("Your bot came home: " + (d?.why || "stopped"));
    socket.emit("bots status");
  });

  // ── Home ──────────────────────────────────────────────────────────────────

  function renderHome() {
    renderBotList();
    renderLive();
    renderContinue();
  }

  function renderBotList() {
    const host = $("botList");
    host.innerHTML = "";
    const bots = status?.bots || [];
    const shared = status?.shared || [];
    if (!bots.length && !shared.length) {
      const note = document.createElement("div");
      note.className = "bc-empty-note";
      note.innerHTML =
        "Nothing here yet! Press <b>Start from an idea</b> up there, or open a <b>ready-made bot</b> below to see how one works.";
      host.appendChild(note);
      appendRedeemButton(host);
      return;
    }
    for (const b of bots) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "bc-bot-card";
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
      meta.textContent =
        b.rules.length +
        (b.rules.length === 1 ? " rule" : " rules") +
        " · " +
        (b.location || "Bot") +
        (b.managers && b.managers.length
          ? " · shared with " + b.managers.length
          : "");
      card.appendChild(name);
      card.appendChild(meta);
      if (b.lastStop && deployedInfo()?.botId !== b.id) {
        const mins = Math.round((Date.now() - b.lastStop.at) / 60000);
        if (mins < 48 * 60) {
          const ago =
            mins < 1
              ? "just now"
              : mins < 60
                ? mins + " min ago"
                : Math.round(mins / 60) + "h ago";
          const stop = document.createElement("div");
          stop.className = "bc-bot-card-meta";
          stop.textContent = "came home " + ago + ": " + b.lastStop.why;
          card.appendChild(stop);
        }
      }
      card.addEventListener("click", () =>
        loadBot({
          id: b.id,
          name: b.name,
          location: b.location || "Bot",
          prefix: b.prefix || "!",
          rules: b.rules,
          updatedAt: b.updatedAt,
        }),
      );
      host.appendChild(card);
    }
    for (const b of shared) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "bc-bot-card";
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
      meta.textContent =
        b.rules.length +
        (b.rules.length === 1 ? " rule" : " rules") +
        " · shared by " +
        b.sharedBy;
      card.appendChild(name);
      card.appendChild(meta);
      card.addEventListener("click", () =>
        loadBot({
          id: b.id,
          name: b.name,
          location: b.location || "Bot",
          prefix: b.prefix || "!",
          rules: b.rules,
          updatedAt: b.updatedAt,
          shared: true,
          sharedBy: b.sharedBy,
        }),
      );
      host.appendChild(card);
    }
    appendRedeemButton(host);
  }

  function appendRedeemButton(host) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bc-btn";
    btn.style.marginTop = "8px";
    btn.innerHTML = '<i class="fas fa-user-group"></i> Add a shared bot';
    btn.title = "Enter a code another user gave you to co-manage their bot";
    btn.addEventListener("click", openRedeemModal);
    host.appendChild(btn);
  }

  function openRedeemModal() {
    const box = openModal(false);
    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-user-group"></i> Add a shared bot';
    const p = document.createElement("p");
    p.textContent =
      "If another user gave you their bot's share code, enter it here. You " +
      "become a manager: you can edit the bot, send it to rooms, and use " +
      "its admin commands, but only the owner can delete it.";
    const input = document.createElement("input");
    input.className = "bc-input";
    input.placeholder = "BOT-XXXXXXXX";
    input.maxLength = 20;
    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const cancel = document.createElement("button");
    cancel.className = "bc-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeModal);
    const add = document.createElement("button");
    add.className = "bc-btn primary";
    add.textContent = "Add bot";
    add.addEventListener("click", () => {
      const code = input.value.trim();
      if (!code) return;
      socket.emit("bots invite redeem", { code });
    });
    btns.appendChild(cancel);
    btns.appendChild(add);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(input);
    box.appendChild(btns);
    input.focus();
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
      const card = document.createElement("button");
      card.type = "button";
      card.className = "bc-bot-card";
      const name = document.createElement("div");
      name.className = "bc-bot-card-name";
      const icon = document.createElement("i");
      icon.className = "fas " + t.icon;
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
        loadTemplate(t);
        toastr.info(
          "This is a ready-made bot. Try it, change it, then press Save to keep your copy.",
        );
      });
      host.appendChild(card);
    }
  }
  renderExamples();

  function loadTemplate(t) {
    loadBot(
      JSON.parse(
        JSON.stringify({
          id: null,
          name: t.bot.name,
          location: t.bot.location || "Bot",
          rules: t.bot.rules,
        }),
      ),
    );
  }

  function renderLive() {
    const host = $("liveHost");
    if (!host) return;
    host.innerHTML = "";
    const d = deployedInfo();
    if (!d) return;
    const bot = (status?.bots || []).find((b) => b.id === d.botId);
    const bar = document.createElement("div");
    bar.className = "bc-live";
    bar.innerHTML =
      '<i class="fas fa-circle-play"></i><b></b><span class="bc-live-meta"></span>';
    bar.querySelector("b").textContent = bot?.name || "Your bot";
    if (connLost) {
      bar.querySelector(".bc-live-meta").textContent =
        "reconnecting to Talkomatic... its true status shows in a moment";
      host.appendChild(bar);
      return;
    }
    const mins = Math.max(0, Math.round((Date.now() - d.since) / 60000));
    bar.querySelector(".bc-live-meta").textContent =
      'is live in "' +
      (d.roomName || d.roomId) +
      '" · ' +
      (mins < 1 ? "just went in" : mins + " min") +
      (d.dropped ? " · " + d.dropped + " messages skipped" : "");
    const stop = document.createElement("button");
    stop.className = "bc-btn danger";
    stop.innerHTML = '<i class="fas fa-stop"></i>Bring it home';
    stop.addEventListener("click", () => {
      if (!socket.connected)
        return toastr.info("Reconnecting... try again in a moment.");
      socket.emit("bots stop");
    });
    bar.appendChild(stop);
    host.appendChild(bar);
  }

  // ── Drafts: nothing typed here is ever lost ───────────────────────────────

  let draftTimer = null;

  function saveDraftNow() {
    if (!edit) return;
    try {
      localStorage.setItem(
        "bc_draft",
        JSON.stringify({
          id: edit.id || null,
          name: edit.name,
          location: edit.location,
          prefix: edit.prefix || "!",
          rules: edit.rules,
          shared: edit.shared || undefined,
          baseUpdatedAt: edit.baseUpdatedAt || null,
          at: Date.now(),
        }),
      );
    } catch (e) {}
  }

  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, 600);
  }

  window.addEventListener("beforeunload", saveDraftNow);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") saveDraftNow();
  });

  function readDraft() {
    try {
      const d = JSON.parse(localStorage.getItem("bc_draft"));
      return d && Array.isArray(d.rules) && d.rules.length ? d : null;
    } catch (e) {
      return null;
    }
  }

  function renderContinue() {
    const host = $("continueHost");
    host.innerHTML = "";
    const d = readDraft();
    if (!d) return;
    if (edit && document.querySelector("#editorView.active")) return;
    const bar = document.createElement("div");
    bar.className = "bc-continue";
    const mins = Math.max(0, Math.round((Date.now() - (d.at || 0)) / 60000));
    bar.innerHTML =
      '<i class="fas fa-pen-ruler"></i><b></b><span class="bc-live-meta"></span>';
    bar.querySelector("b").textContent = d.name || "Unnamed bot";
    bar.querySelector(".bc-live-meta").textContent =
      "you were working on this " +
      (mins < 1 ? "moments ago" : mins < 60 ? mins + " min ago" : "a while ago");
    const open = document.createElement("button");
    open.className = "bc-btn primary";
    open.innerHTML = '<i class="fas fa-arrow-right"></i>Keep going';
    open.addEventListener("click", () =>
      loadBot({ id: d.id, name: d.name, location: d.location, rules: d.rules }),
    );
    const drop = document.createElement("button");
    drop.className = "bc-row-del";
    drop.title = "Forget this draft";
    drop.innerHTML = '<i class="fas fa-xmark"></i>';
    drop.addEventListener("click", () => {
      localStorage.removeItem("bc_draft");
      renderContinue();
    });
    bar.appendChild(open);
    bar.appendChild(drop);
    host.appendChild(bar);
  }

  $("newBlankBtn").addEventListener("click", () => {
    if (!me) return showView("gate");
    loadTemplate(TEMPLATES[0]);
  });

  // ── Editor open / chrome ──────────────────────────────────────────────────

  function loadBot(bot) {
    edit = JSON.parse(JSON.stringify(bot));
    if (!edit.location) edit.location = "Bot";
    if (!edit.prefix) edit.prefix = "!";
    if (edit.baseUpdatedAt == null) edit.baseUpdatedAt = edit.updatedAt || null;
    dirty = false;
    testDirty = true;
    saveDraftNow();
    showView("editor");
    $("botName").value = edit.name || "";
    $("botLocation").value = edit.location;
    $("botPrefix").value = edit.prefix;
    setSaveNote("", "");
    updateNamePreview();
    resetTestRoom();
    renderRules();
    renderEditorChrome();
  }

  function botHeaderText() {
    return (edit?.name || "Bot") + " / " + (edit?.location || "Bot");
  }

  function updateNamePreview() {
    $("trBotName").textContent = botHeaderText();
  }

  function renderEditorChrome() {
    if (!edit) return;
    $("deleteBtn").style.display = edit.id && !edit.shared ? "" : "none";
    $("managersBtn").style.display = edit.id && !edit.shared ? "" : "none";
    $("historyBtn").style.display = edit.id ? "" : "none";
    const d = deployedInfo();
    const label = $("deployOpenLabel");
    if (d && d.botId === edit.id) label.textContent = "Live · manage";
    else label.textContent = "Send to a room";
  }

  $("backHomeBtn").addEventListener("click", () => {
    showView("home");
    renderHome();
  });

  $("botName").addEventListener("input", () => {
    if (!edit) return;
    edit.name = $("botName").value;
    touch();
    updateNamePreview();
  });

  $("botLocation").addEventListener("input", () => {
    if (!edit) return;
    edit.location = $("botLocation").value;
    touch();
    updateNamePreview();
  });

  $("botPrefix").addEventListener("input", () => {
    if (!edit) return;
    edit.prefix = $("botPrefix").value.trim();
    touch();
    renderRules();
  });

  $("testToggleBtn").addEventListener("click", () => {
    if (window.innerWidth <= 1250)
      document.body.classList.toggle("bc-test-open");
    else document.body.classList.toggle("bc-test-hidden");
  });

  $("testCloseBtn").addEventListener("click", () =>
    document.body.classList.remove("bc-test-open"),
  );

  // ── Saving: the bar tells you exactly what is missing ─────────────────────

  function setSaveNote(kind, text) {
    const el = $("saveNote");
    el.className = "bc-save-note" + (kind ? " " + kind : "");
    el.textContent = text;
  }

  function touch() {
    dirty = true;
    testDirty = true;
    setSaveNote("dirty", "Unsaved changes");
    saveDraftSoon();
  }

  function validateLocal() {
    if (!edit) return { ok: false, msg: "Nothing to save yet." };
    if ((edit.name || "").trim().length < 2)
      return { ok: false, msg: "Give the bot a name first (2-14 characters)." };
    if (!(edit.rules || []).length)
      return { ok: false, msg: "The bot needs at least one rule." };
    if (edit.prefix && edit.prefix !== "!" && !PREFIX_RE.test(edit.prefix))
      return {
        ok: false,
        msg: "The command prefix is 1-2 symbols, like ! or ? or >> (no letters or spaces).",
      };
    for (let ri = 0; ri < edit.rules.length; ri++) {
      const r = edit.rules[ri];
      const n = "Rule " + (ri + 1);
      if (r.on.type === "command") {
        const w = String(r.on.word || "")
          .trim()
          .replace(/^[!?.,;:~#$%^&*+=/\\<>@|-]+/, "");
        if (/\s/.test(w))
          return {
            ok: false,
            ri,
            msg:
              n +
              ": a command is ONE word, like !test. What people type after it comes out as {word1}, {word2}...",
          };
        if (!/^[a-z0-9]{1,16}$/i.test(w))
          return {
            ok: false,
            ri,
            msg: n + ": the command needs a word (letters or digits), like !roll.",
          };
      }
      if (r.on.type === "says" && !String(r.on.text || "").trim())
        return { ok: false, ri, msg: n + ': "someone says" needs a phrase to listen for.' };
      if (r.on.type === "timer") {
        const m = Math.round(Number(r.on.minutes));
        if (!Number.isFinite(m) || m < 2 || m > 120)
          return { ok: false, ri, msg: n + ": timers run every 2-120 minutes." };
      }
      if (!(r.do || []).length)
        return { ok: false, ri, msg: n + " has nothing to do. Add a block from the palette." };
      for (const a of r.do) {
        if ((a.type === "say" || a.type === "append") && !String(a.text || "").trim())
          return { ok: false, ri, msg: n + ": a say block is empty. Write the message, or remove the block." };
        if (a.type === "set" || a.type === "add" || a.type === "random") {
          const nm = String(a.var || "").trim();
          const stripped = nm.replace(/\{[^{}]*\}/g, "x");
          const ok = nm.includes("{")
            ? nm.length <= 60 && /^[a-z0-9_x]+$/i.test(stripped)
            : /^[a-z0-9_]{1,20}$/i.test(nm);
          if (!ok)
            return {
              ok: false,
              ri,
              msg:
                n +
                ": memory names are 1-20 letters, digits or _, and may include a placeholder like note_{word1}.",
            };
        }
        if (a.type === "random" && !String(a.from || "").trim())
          return { ok: false, ri, msg: n + ": the random block needs choices (a, b, c) or a range like 1-100." };
      }
      const repeats = r.do.filter((a) => a.type === "repeat");
      if (repeats.length > 1)
        return { ok: false, ri, msg: n + ": one repeat block per rule." };
      if (r.do[0] && r.do[0].type === "repeat")
        return {
          ok: false,
          ri,
          msg: n + ": put the blocks to repeat ABOVE the repeat block.",
        };
    }
    return { ok: true };
  }

  function flashRule(ri) {
    const card = document.querySelector('.bc-rule[data-ri="' + ri + '"]');
    if (!card) return;
    if (card.classList.contains("collapsed")) {
      const rule = edit.rules[ri];
      if (rule) delete rule._folded;
      renderRules();
      return flashRule(ri);
    }
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 2400);
  }

  $("saveBtn").addEventListener("click", () => {
    if (!edit) return;
    if (!socket.connected)
      return setSaveNote(
        "err",
        "Reconnecting to Talkomatic... try again in a moment. Your work is kept as a draft.",
      );
    const v = validateLocal();
    if (!v.ok) {
      setSaveNote("err", v.msg);
      if (typeof v.ri === "number") flashRule(v.ri);
      return;
    }
    setSaveNote("", "Saving...");
    socket.emit("bots save", {
      id: edit.id || undefined,
      baseUpdatedAt: edit.baseUpdatedAt || undefined,
      bot: {
        name: edit.name,
        location: edit.location,
        prefix: edit.prefix || "!",
        rules: edit.rules,
      },
    });
  });

  $("deleteBtn").addEventListener("click", () => {
    if (!edit?.id) return;
    if (!confirm(`Delete "${edit.name}" forever?`)) return;
    socket.emit("bots delete", { id: edit.id });
    localStorage.removeItem("bc_draft");
    edit = null;
    showView("home");
  });

  // ── Managers: share a bot with other users ────────────────────────────────

  $("managersBtn").addEventListener("click", () => {
    if (edit?.id && !edit.shared) openManagersModal(edit.id);
  });

  function openManagersModal(botId) {
    const b = (status?.bots || []).find((x) => x.id === botId);
    if (!b) return;
    const box = openModal(false);
    box.id = "bcManagersBox";
    box.dataset.botId = botId;

    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-user-group"></i> ';
    h.appendChild(document.createTextNode("Managers of " + b.name));
    box.appendChild(h);

    const p = document.createElement("p");
    p.textContent =
      "Managers can edit this bot, send it to rooms, and use its " +
      "admin-only commands in rooms. Only you can delete it, remove " +
      "managers, or hand it over.";
    box.appendChild(p);

    const codeRow = document.createElement("div");
    codeRow.className = "bc-modal-btns";
    codeRow.style.justifyContent = "flex-start";
    if (b.inviteCode) {
      const code = document.createElement("code");
      code.textContent = b.inviteCode;
      code.style.cssText =
        "padding:6px 10px;background:rgba(255,255,255,.08);border-radius:4px;letter-spacing:1px;";
      codeRow.appendChild(code);
      const copy = document.createElement("button");
      copy.className = "bc-btn";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        navigator.clipboard
          .writeText(b.inviteCode)
          .then(() => toastr.success("Code copied. Send it to your friend."))
          .catch(() => {});
      });
      codeRow.appendChild(copy);
      const revoke = document.createElement("button");
      revoke.className = "bc-btn danger";
      revoke.textContent = "Revoke code";
      revoke.addEventListener("click", () =>
        socket.emit("bots invite revoke", { id: botId }),
      );
      codeRow.appendChild(revoke);
    } else {
      const gen = document.createElement("button");
      gen.className = "bc-btn primary";
      gen.innerHTML = '<i class="fas fa-key"></i> Make a share code';
      gen.addEventListener("click", () =>
        socket.emit("bots invite create", { id: botId }),
      );
      codeRow.appendChild(gen);
      const hint = document.createElement("span");
      hint.className = "bc-bot-card-meta";
      hint.textContent = "Anyone with the code becomes a manager.";
      codeRow.appendChild(hint);
    }
    box.appendChild(codeRow);

    const list = document.createElement("div");
    list.style.marginTop = "12px";
    const managers = b.managers || [];
    if (!managers.length) {
      const none = document.createElement("div");
      none.className = "bc-bot-card-meta";
      none.textContent = "Nobody manages this bot with you yet.";
      list.appendChild(none);
    }
    for (const m of managers) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:6px 0;";
      const who = document.createElement("span");
      who.textContent = m.name;
      who.style.flex = "1";
      row.appendChild(who);
      const transfer = document.createElement("button");
      transfer.className = "bc-btn";
      transfer.textContent = "Make owner";
      transfer.addEventListener("click", () => {
        if (
          confirm(
            `Hand "${b.name}" to ${m.name} for good? You stay on as a manager.`,
          )
        )
          socket.emit("bots transfer", { id: botId, ref: m.ref });
      });
      row.appendChild(transfer);
      const remove = document.createElement("button");
      remove.className = "bc-btn danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () =>
        socket.emit("bots manager remove", { id: botId, ref: m.ref }),
      );
      row.appendChild(remove);
      list.appendChild(row);
    }
    box.appendChild(list);

    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const done = document.createElement("button");
    done.className = "bc-btn primary";
    done.textContent = "Done";
    done.addEventListener("click", closeModal);
    btns.appendChild(done);
    box.appendChild(btns);
  }

  function refreshManagersModal() {
    const open = document.getElementById("bcManagersBox");
    if (!open) return;
    const botId = open.dataset.botId;
    if ((status?.bots || []).some((b) => b.id === botId))
      openManagersModal(botId);
    else closeModal();
  }

  // ── History: who made it, who did what, and earlier versions ─────────────

  function agoText(ts) {
    if (!ts) return "";
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  $("historyBtn").addEventListener("click", () => {
    if (edit?.id) openHistoryModal(edit.id);
  });

  function openHistoryModal(botId) {
    const own = (status?.bots || []).find((x) => x.id === botId);
    const b = own || (status?.shared || []).find((x) => x.id === botId);
    if (!b) return;
    const isOwn = !!own;
    const box = openModal(true);
    box.id = "bcHistoryBox";
    box.dataset.botId = botId;

    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-clock-rotate-left"></i> ';
    h.appendChild(document.createTextNode("History of " + b.name));
    box.appendChild(h);

    const whoBits = [];
    whoBits.push("Made by " + (b.createdBy || (isOwn ? "you" : b.sharedBy)));
    whoBits.push("Owned by " + (isOwn ? "you" : b.sharedBy));
    if (b.managers && b.managers.length)
      whoBits.push(
        "Managers: " + b.managers.map((m) => m.name).join(", "),
      );
    const who = document.createElement("p");
    who.textContent = whoBits.join(" · ");
    box.appendChild(who);

    const log = document.createElement("div");
    log.style.cssText = "max-height:220px;overflow-y:auto;margin-top:4px;";
    const entries = b.history || [];
    if (!entries.length) {
      const none = document.createElement("div");
      none.className = "bc-bot-card-meta";
      none.textContent =
        "Nothing recorded yet. Saves, managers joining, and restores will show up here.";
      log.appendChild(none);
    }
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "bc-bot-card-meta";
      row.style.padding = "3px 0";
      row.textContent =
        (e.by || "someone") +
        " " +
        (e.action || "did something") +
        (e.rules ? " (" + e.rules + " rules)" : "") +
        " · " +
        agoText(e.at);
      log.appendChild(row);
    }
    box.appendChild(log);

    const versions = b.versions || [];
    if (versions.length) {
      const vh = document.createElement("p");
      vh.style.marginTop = "12px";
      vh.textContent = isOwn
        ? "Earlier versions - restore one if an edit went wrong:"
        : "Earlier versions (only the owner can restore):";
      box.appendChild(vh);
      for (const v of versions) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:4px 0;";
        const label = document.createElement("span");
        label.className = "bc-bot-card-meta";
        label.style.flex = "1";
        label.textContent =
          (v.name || b.name) +
          " · " +
          v.rules +
          (v.rules === 1 ? " rule" : " rules") +
          " · by " +
          (v.by || "someone") +
          " · " +
          agoText(v.at);
        row.appendChild(label);
        if (isOwn) {
          const btn = document.createElement("button");
          btn.className = "bc-btn";
          btn.textContent = "Restore";
          btn.addEventListener("click", () => {
            if (
              confirm(
                "Put the bot back the way it was " +
                  agoText(v.at) +
                  "? The current version is kept in this list.",
              )
            )
              socket.emit("bots restore", { id: botId, at: v.at });
          });
          row.appendChild(btn);
        }
        box.appendChild(row);
      }
    }

    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const done = document.createElement("button");
    done.className = "bc-btn primary";
    done.textContent = "Done";
    done.addEventListener("click", closeModal);
    btns.appendChild(done);
    box.appendChild(btns);
  }

  function refreshHistoryModal() {
    const open = document.getElementById("bcHistoryBox");
    if (!open) return;
    const botId = open.dataset.botId;
    const exists =
      (status?.bots || []).some((x) => x.id === botId) ||
      (status?.shared || []).some((x) => x.id === botId);
    if (exists) openHistoryModal(botId);
    else closeModal();
  }

  socket.on("bots restored", (d) => {
    toastr.success("Restored. The bot is back the way it was.");
    if (edit?.id === d.id) pendingReloadId = d.id;
  });

  let pendingReloadId = null;

  socket.on("bots redeemed", (d) => {
    closeModal();
    toastr.success(
      `"${d.name}" was shared with you` +
        (d.sharedBy ? " by " + d.sharedBy : "") +
        ". It is in your bot list now.",
    );
  });

  socket.on("bots transferred", (d) => {
    closeModal();
    toastr.success("The bot now belongs to " + (d.to || "them") + ".");
    if (edit?.id === d.id) edit.shared = true;
    renderEditorChrome();
  });

  // ── Import / export: carry a bot between devices as a file ────────────────

  $("exportBotBtn").addEventListener("click", () => {
    if (!edit) return;
    const payload = {
      format: "talkomatic-bot",
      version: 1,
      bot: {
        name: edit.name || "Unnamed bot",
        location: edit.location || "Bot",
        prefix: edit.prefix || "!",
        rules: edit.rules || [],
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const safe =
      (edit.name || "bot")
        .replace(/[^\w\- ]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase() || "bot";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = safe + ".talkobot.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toastr.success("Bot saved as a file. Import it on your other device.");
  });

  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = ".json,application/json";
  importInput.style.display = "none";
  document.body.appendChild(importInput);

  $("importBotBtn").addEventListener("click", () => {
    if (!me) return showView("gate");
    importInput.value = "";
    importInput.click();
  });

  importInput.addEventListener("change", () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (e) {
        return toastr.error("That file could not be read as a bot file.");
      }
      const bot =
        data && data.format === "talkomatic-bot" && data.bot
          ? data.bot
          : data && Array.isArray(data.rules)
            ? data
            : null;
      if (!bot || !Array.isArray(bot.rules) || !bot.rules.length)
        return toastr.error("That file does not contain a bot.");
      if (bot.rules.length > 200)
        return toastr.error("That file has too many rules to be a real bot.");
      try {
        loadBot({
          id: null,
          name:
            typeof bot.name === "string" && bot.name.trim()
              ? bot.name.slice(0, 14)
              : "Imported bot",
          location:
            typeof bot.location === "string" && bot.location.trim()
              ? bot.location.slice(0, 20)
              : "Bot",
          prefix:
            typeof bot.prefix === "string" && bot.prefix.trim()
              ? bot.prefix.slice(0, 2)
              : "!",
          rules: bot.rules,
        });
        toastr.info(
          "Bot imported. Look it over, then press Save to keep it on this device.",
        );
      } catch (e) {
        toastr.error("That bot file is damaged or from an unknown version.");
      }
    };
    reader.readAsText(file);
  });

  // ── The palette ───────────────────────────────────────────────────────────

  const PAL_ITEMS = [
    { group: "RULES" },
    {
      kind: "pal-rule",
      cls: "p-when",
      label: "WHEN · new rule",
      help: {
        title: "WHEN starts every rule",
        text: "It is the moment that wakes your bot up: a !command, a phrase, someone joining, or a timer. Drag it between rules, or click to add one at the end.",
        ex: "WHEN someone types !roll",
      },
    },
    {
      kind: "pal-cond",
      cls: "p-if",
      label: "ONLY IF · a check",
      help: {
        title: "A test the rule must pass",
        text: "The rule only runs when the check is true. Compare a magic word or a memory against a value. Up to 3 per rule; skipping checks is fine.",
        ex: "ONLY IF {word1} is exactly banana",
      },
    },
    { group: "THINGS TO DO" },
    {
      kind: "pal-act",
      av: "say",
      cls: "p-do",
      label: "say something",
      help: {
        title: "The bot types a message",
        text: "It replaces what was in its box, letter by letter. Magic words get swapped in (the ✨ button lists them). Enter makes a new line.",
        ex: 'say "Hi {name}!"',
      },
    },
    {
      kind: "pal-act",
      av: "append",
      cls: "p-do",
      label: "add a line below",
      help: {
        title: "Say without erasing",
        text: "Writes on a new line UNDER what the bot already said, instead of replacing its box. A greeter can stack arrivals; a game can keep its board up.",
        ex: "hello mohd welcome!\nxyerv just left!",
      },
    },
    {
      kind: "pal-act",
      av: "wait",
      cls: "p-do",
      label: "wait a moment",
      help: {
        title: "A pause between blocks",
        text: "Half a second to 10 seconds. Timing makes jokes work: announce, wait, answer.",
        ex: 'say "Shaking..." / wait 2 seconds / say the answer',
      },
    },
    {
      kind: "pal-act",
      av: "set",
      cls: "p-do",
      label: "remember something",
      help: {
        title: "Write into a memory",
        text: "A labelled box the bot keeps. Shared by everyone, or one per person. Say it back later with {memory:name} or {mymemory:name}.",
        ex: "remember prize = {word1}",
      },
    },
    {
      kind: "pal-act",
      av: "add",
      cls: "p-do",
      label: "change a memory",
      help: {
        title: "Do math on a memory",
        text: "Add, take away, multiply or divide it by a number (or a magic word). Points, coins, doubling: all this one block.",
        ex: "change coins add 5",
      },
    },
    {
      kind: "pal-act",
      av: "random",
      cls: "p-do",
      label: "pick something random",
      help: {
        title: "Random, into a memory",
        text: "Give it choices or a number range. The pick lands in a memory so later blocks and checks can read it.",
        ex: "pick m from rock, paper, scissors",
      },
    },
    {
      kind: "pal-act",
      av: "repeat",
      cls: "p-do",
      label: "repeat everything above",
      help: {
        title: "Run the blocks above again",
        text: "Everything above this block runs 2-5 times in total. One per rule, and it cannot be the first block.",
        ex: 'say "hip hip hooray!" / repeat 3 times in total',
      },
    },
    {
      kind: "pal-act",
      av: "clear",
      cls: "p-do",
      label: "erase the bot's box",
      help: {
        title: "Wipe the bot's textbox",
        text: "Clears what the bot last said, like a person deleting their text.",
        ex: "say the secret / wait 3 seconds / erase the box",
      },
    },
    {
      kind: "pal-act",
      av: "leave",
      cls: "p-do",
      label: "leave the room",
      help: {
        title: "The bot goes home",
        text: "Usually behind a check, like a goodbye password only you know.",
        ex: "ONLY IF {word1} is exactly goodnight, then leave",
      },
    },
    { group: "MEMORIES" },
    { memhost: true },
    { group: "READY COMBOS" },
    {
      kind: "pal-combo",
      cls: "p-do",
      label: "a random answer",
      actions: [
        { type: "say", text: "{pick:Yes!|No way.|Maybe...|Ask me tomorrow.}" },
      ],
      help: {
        title: "One say, different every time",
        text: "A say block prefilled with {pick}. Change the choices to yours, split with the | line.",
        ex: 'say "{pick:Yes!|No way.|Maybe...}"',
      },
    },
    {
      kind: "pal-combo",
      cls: "p-do",
      label: "a dice roll",
      actions: [{ type: "say", text: "🎲 {name} rolls a {rand:1-6}!" }],
      help: {
        title: "A fresh number every time",
        text: "A say block prefilled with {rand:1-6}. Any range works: {rand:1-100}.",
        ex: 'say "🎲 {name} rolls a {rand:1-6}!"',
      },
    },
    {
      kind: "pal-combo",
      cls: "p-do",
      label: "a point + announcement",
      actions: [
        { type: "add", var: "points", per: "user", amount: "1", op: "add" },
        { type: "say", text: "🏆 {name} now has {mymemory:points} points!" },
      ],
      help: {
        title: "Two blocks: score, then say it",
        text: "Gives the person 1 point in their own memory and announces the total. The start of any game.",
        ex: "change points add 1 / say the total",
      },
    },
  ];

  let openHelpPop = null;

  function closeHelpPop() {
    if (openHelpPop) {
      openHelpPop.remove();
      openHelpPop = null;
    }
  }

  function showHelpPop(anchor, help) {
    closeHelpPop();
    const pop = document.createElement("div");
    pop.className = "bc-help-pop";
    const b = document.createElement("b");
    b.textContent = help.title;
    const p = document.createElement("p");
    p.textContent = help.text;
    pop.appendChild(b);
    pop.appendChild(p);
    if (help.ex) {
      const code = document.createElement("code");
      code.textContent = help.ex;
      pop.appendChild(code);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.top, window.innerHeight - pop.offsetHeight - 12);
    pop.style.left = Math.min(r.right + 8, window.innerWidth - 282) + "px";
    pop.style.top = Math.max(8, top) + "px";
    openHelpPop = pop;
  }

  document.addEventListener("click", closeHelpPop);

  function lastRuleOrComplain() {
    const rule = edit.rules[edit.rules.length - 1];
    if (!rule) toastr.error("Add a rule first.");
    return rule || null;
  }

  function paletteSpec(item) {
    if (item.kind === "pal-rule")
      return {
        kind: "pal-rule",
        el: null,
        label: item.label,
        cls: item.cls,
        clickAdd: () => {
          if (edit.rules.length >= maxRules())
            return toastr.error("That's the most rules a bot can have.");
          edit.rules.push(freshRule());
          touch();
          renderRules();
          const cards = document.querySelectorAll(".bc-rule");
          cards[cards.length - 1]?.scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        },
      };
    if (item.kind === "pal-cond")
      return {
        kind: "pal-cond",
        el: null,
        label: item.label,
        cls: item.cls,
        clickAdd: () => {
          const rule = lastRuleOrComplain();
          if (!rule) return;
          if ((rule.if || []).length >= maxConds())
            return toastr.error("At most " + maxConds() + " checks per rule.");
          if (!rule.if) rule.if = [];
          rule.if.push({ a: "{word1}", op: "is", b: "" });
          touch();
          renderRules();
        },
      };
    if (item.kind === "pal-combo")
      return {
        kind: "pal-combo",
        actions: item.actions,
        el: null,
        label: item.label,
        cls: item.cls,
        clickAdd: () => {
          const rule = lastRuleOrComplain();
          if (!rule) return;
          if (rule.do.length + item.actions.length > maxActs())
            return toastr.error("At most " + maxActs() + " actions per rule.");
          rule.do.push(...JSON.parse(JSON.stringify(item.actions)));
          touch();
          renderRules();
        },
      };
    return {
      kind: "pal-act",
      av: item.av,
      el: null,
      label: item.label,
      cls: item.cls,
      clickAdd: () => {
        const rule = lastRuleOrComplain();
        if (!rule) return;
        if (rule.do.length >= maxActs())
          return toastr.error("At most " + maxActs() + " actions per rule.");
        rule.do.push(freshAction(item.av));
        touch();
        renderRules();
      },
    };
  }

  function renderPalette() {
    const host = $("paletteHost");
    host.innerHTML = "";
    for (const item of PAL_ITEMS) {
      if (item.group) {
        const g = document.createElement("div");
        g.className = "bc-pal-group";
        g.textContent = item.group;
        host.appendChild(g);
        continue;
      }
      if (item.memhost) {
        const mh = document.createElement("div");
        mh.id = "palMemHost";
        host.appendChild(mh);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bc-pal-blk " + item.cls;
      b.innerHTML = '<i class="fas fa-grip-vertical"></i>';
      const label = document.createElement("span");
      label.className = "bc-pal-label";
      label.textContent = item.label;
      b.appendChild(label);
      if (item.help) {
        const q = document.createElement("button");
        q.type = "button";
        q.className = "bc-pal-help";
        q.title = "What does this do?";
        q.innerHTML = '<i class="fas fa-circle-question"></i>';
        q.addEventListener("pointerdown", (e) => e.stopPropagation());
        q.addEventListener("click", (e) => {
          e.stopPropagation();
          showHelpPop(b, item.help);
        });
        b.appendChild(q);
      }
      b.addEventListener("pointerdown", (e) => beginDrag(e, paletteSpec(item)));
      host.appendChild(b);
    }
  }
  renderPalette();

  // ── Drag and drop ─────────────────────────────────────────────────────────

  let drag = null;

  function mkGrip() {
    const g = document.createElement("span");
    g.className = "bc-grip";
    g.innerHTML = '<i class="fas fa-grip-vertical"></i>';
    g.title = "Drag to move";
    return g;
  }

  function beginDrag(e, spec) {
    if (e.button !== undefined && e.button !== 0) return;
    if (drag) return;
    e.preventDefault();
    drag = Object.assign({}, spec, {
      sx: e.clientX,
      sy: e.clientY,
      started: false,
      ghost: null,
      line: null,
      target: null,
    });
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", cancelDrag);
  }

  function startGhost() {
    drag.started = true;
    let ghost;
    if (drag.el) {
      ghost = drag.el.cloneNode(true);
      ghost.style.width =
        Math.min(360, drag.el.getBoundingClientRect().width) + "px";
      drag.el.classList.add("drag-src");
      if (drag.kind === "rule") drag.el.closest(".bc-rule")?.classList.add("drag-src");
    } else {
      ghost = document.createElement("div");
      ghost.className = "bc-pal-blk " + (drag.cls || "p-do");
      ghost.textContent = drag.label || "";
      ghost.style.width = "220px";
    }
    ghost.classList.add("bc-ghost");
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    const line = document.createElement("div");
    line.className = "bc-drop-line";
    line.style.display = "none";
    document.body.appendChild(line);
    drag.line = line;
    document.body.classList.add("bc-dragging");
  }

  function onDragMove(e) {
    if (!drag) return;
    if (!drag.started) {
      if (
        Math.abs(e.clientX - drag.sx) < 6 &&
        Math.abs(e.clientY - drag.sy) < 6
      )
        return;
      startGhost();
    }
    drag.ghost.style.left = e.clientX + 12 + "px";
    drag.ghost.style.top = e.clientY + 10 + "px";

    const main = document.querySelector(".bc-main");
    if (e.clientY < 110) main.scrollBy(0, -14);
    else if (e.clientY > window.innerHeight - 70) main.scrollBy(0, 14);

    const t = computeTarget(e.clientX, e.clientY);
    drag.target = t;
    if (t) {
      drag.line.style.display = "";
      drag.line.style.left = t.line.x + "px";
      drag.line.style.top = t.line.y + "px";
      drag.line.style.width = t.line.w + "px";
      drag.line.classList.toggle("invalid", !t.valid);
      drag.ghost.classList.toggle("invalid", !t.valid);
    } else {
      drag.line.style.display = "none";
      drag.ghost.classList.remove("invalid");
    }
  }

  function computeTarget(x, y) {
    const host = $("rulesHost");
    if (!host || !edit) return null;

    if (drag.kind === "rule" || drag.kind === "pal-rule") {
      const cards = [...host.querySelectorAll(".bc-rule")];
      const hostRect = host.getBoundingClientRect();
      if (x < hostRect.left - 80 || x > hostRect.right + 80) return null;
      let idx = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          idx = i;
          break;
        }
      }
      let ly;
      if (!cards.length) ly = hostRect.top + 6;
      else if (idx === 0) ly = cards[0].getBoundingClientRect().top - 9;
      else if (idx >= cards.length)
        ly = cards[cards.length - 1].getBoundingClientRect().bottom + 9;
      else ly = cards[idx].getBoundingClientRect().top - 9;
      const valid =
        drag.kind === "rule" ? true : edit.rules.length < maxRules();
      return {
        scope: "rules",
        idx,
        line: { x: hostRect.left, w: Math.min(760, hostRect.width), y: ly },
        valid,
      };
    }

    const wantDo =
      drag.kind === "act" ||
      drag.kind === "pal-act" ||
      drag.kind === "pal-combo";
    const cards = [...host.querySelectorAll(".bc-rule")];
    let best = null;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.classList.contains("collapsed")) continue;
      const rect = card.getBoundingClientRect();
      if (x < rect.left - 60 || x > rect.right + 60) continue;
      const dist =
        y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (best == null || dist < best.dist) best = { i, card, dist };
    }
    if (!best || best.dist > 90) return null;
    const ri = Number(best.card.dataset.ri);
    const rule = edit.rules[ri];
    if (!rule) return null;

    const rows = [
      ...best.card.querySelectorAll(wantDo ? ".blk-do" : ".blk-if"),
    ];
    let idx = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    const cardRect = best.card.getBoundingClientRect();
    let ly;
    if (!rows.length) {
      const anchor =
        (wantDo
          ? best.card.querySelector(".bc-blk-adders")
          : best.card.querySelector(".blk-do") ||
            best.card.querySelector(".bc-blk-adders")) ||
        best.card.querySelector(".blk-when");
      const ar = anchor.getBoundingClientRect();
      ly = anchor.classList.contains("blk-when") ? ar.bottom + 3 : ar.top - 4;
    } else if (idx >= rows.length)
      ly = rows[rows.length - 1].getBoundingClientRect().bottom + 3;
    else ly = rows[idx].getBoundingClientRect().top - 4;

    let valid = true;
    if (wantDo) {
      if (drag.kind === "pal-combo") {
        if (rule.do.length + drag.actions.length > maxActs()) valid = false;
      } else {
        const adding = drag.kind === "pal-act" || drag.ri !== ri;
        if (adding && rule.do.length >= maxActs()) valid = false;
      }
    } else {
      const adding = drag.kind === "pal-cond" || drag.ri !== ri;
      if (adding && (rule.if || []).length >= maxConds()) valid = false;
    }
    return {
      scope: wantDo ? "do" : "if",
      ri,
      idx,
      line: { x: cardRect.left + 16, w: cardRect.width - 16, y: ly },
      valid,
    };
  }

  function cleanupDrag() {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", cancelDrag);
    document.body.classList.remove("bc-dragging");
    if (drag?.ghost) drag.ghost.remove();
    if (drag?.line) drag.line.remove();
    document
      .querySelectorAll(".drag-src")
      .forEach((el) => el.classList.remove("drag-src"));
  }

  function cancelDrag() {
    cleanupDrag();
    drag = null;
  }

  function endDrag() {
    const d = drag;
    cleanupDrag();
    drag = null;
    if (!d) return;
    if (!d.started) {
      if (d.clickAdd) d.clickAdd();
      return;
    }
    const t = d.target;
    if (!t || !t.valid) return;
    applyDrop(d, t);
    touch();
    renderRules();
  }

  function applyDrop(d, t) {
    if (t.scope === "rules") {
      if (d.kind === "pal-rule") {
        edit.rules.splice(t.idx, 0, freshRule());
        return;
      }
      const [r] = edit.rules.splice(d.ri, 1);
      let at = t.idx;
      if (at > d.ri) at--;
      edit.rules.splice(at, 0, r);
      return;
    }
    if (t.scope === "do") {
      const to = edit.rules[t.ri].do;
      if (d.kind === "pal-act") {
        to.splice(t.idx, 0, freshAction(d.av));
        return;
      }
      if (d.kind === "pal-combo") {
        to.splice(t.idx, 0, ...JSON.parse(JSON.stringify(d.actions)));
        return;
      }
      const from = edit.rules[d.ri].do;
      const [a] = from.splice(d.idx, 1);
      let at = t.idx;
      if (t.ri === d.ri && at > d.idx) at--;
      to.splice(at, 0, a);
      return;
    }
    if (t.scope === "if") {
      const rule = edit.rules[t.ri];
      if (!rule.if) rule.if = [];
      if (d.kind === "pal-cond") {
        rule.if.splice(t.idx, 0, { a: "{word1}", op: "is", b: "" });
        return;
      }
      const from = edit.rules[d.ri].if;
      const [c] = from.splice(d.idx, 1);
      let at = t.idx;
      if (t.ri === d.ri && at > d.idx) at--;
      rule.if.splice(at, 0, c);
    }
  }

  // ── Small builders shared by the rule cards ───────────────────────────────

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
      const mine = collectMemories().map((m) => ({
        tok: memToken(m),
        desc: "your memory: " + m.name + " (" + memKindLabel(m.per) + ")",
      }));
      for (const m of [...mine, ...MAGIC]) {
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

  function openMenu(anchorWrap, items, onPick) {
    if (openMagicMenu) openMagicMenu.remove();
    const menu = document.createElement("div");
    menu.className = "bc-magic-menu left";
    for (const it of items) {
      const item = document.createElement("button");
      item.className = "bc-magic-item";
      item.type = "button";
      const b = document.createElement("b");
      b.textContent = it.label;
      const span = document.createElement("span");
      span.textContent = it.desc || "";
      item.appendChild(b);
      item.appendChild(document.createElement("br"));
      item.appendChild(span);
      item.addEventListener("click", () => {
        menu.remove();
        openMagicMenu = null;
        onPick(it.v);
      });
      menu.appendChild(item);
    }
    anchorWrap.appendChild(menu);
    openMagicMenu = menu;
  }

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

  function mkChip(text) {
    const chip = document.createElement("span");
    chip.className = "bc-blk-chip";
    chip.textContent = text;
    return chip;
  }

  function ruleSummary(rule) {
    const on = rule.on || {};
    let t = "";
    if (on.type === "command") t = "!" + (on.word || "?");
    else if (on.type === "says") t = '"' + (on.text || "...") + '"';
    else if (on.type === "mention") t = "its name is said";
    else if (on.type === "join") t = "someone joins";
    else if (on.type === "leave") t = "someone leaves";
    else if (on.type === "timer") t = "every " + (on.minutes || "?") + " min";
    const checks = (rule.if || []).length;
    const acts = (rule.do || []).length;
    return (
      t +
      (rule.who === "owner" ? " · admin only" : "") +
      " · " +
      (checks ? checks + (checks === 1 ? " check · " : " checks · ") : "") +
      acts +
      (acts === 1 ? " thing it does" : " things it does")
    );
  }

  // ── The rule cards ────────────────────────────────────────────────────────

  function renderRules() {
    const host = $("rulesHost");
    host.innerHTML = "";
    (edit.rules || []).forEach((rule, ri) =>
      host.appendChild(ruleCard(rule, ri)),
    );
    renderMemories();
  }

  function ruleCard(rule, ri) {
    const card = document.createElement("div");
    card.className = "bc-rule";
    if (rule._folded) card.classList.add("collapsed");
    card.dataset.ri = String(ri);

    const head = document.createElement("div");
    head.className = "bc-blk blk-when bc-rule-head";
    const grip = mkGrip();
    grip.addEventListener("pointerdown", (e) =>
      beginDrag(e, { kind: "rule", ri, el: head }),
    );
    head.appendChild(grip);
    head.appendChild(mkChip("WHEN"));
    head.appendChild(
      mkSelect(
        TRIGGER_OPTIONS,
        rule.on.type,
        (v) => {
          rule.on = { type: v };
          if (v === "command") rule.on.word = "hello";
          if (v === "says") rule.on.text = "";
          if (v === "timer") {
            rule.on.minutes = 5;
            delete rule.who;
          }
          if (v === "arrive") delete rule.who;
          renderRules();
        },
        "w-trig",
      ),
    );
    if (rule.on.type === "command") {
      const bang = document.createElement("span");
      bang.className = "bc-unit bc-bang";
      bang.textContent = (edit && edit.prefix) || "!";
      head.appendChild(bang);
      head.appendChild(
        mkInput(
          rule.on.word,
          "word",
          (v) => (rule.on.word = v.replace(/^[!?.,;:~#$%^&*+=/\\<>@|-]+/, "")),
          "w-word",
        ),
      );
    } else if (rule.on.type === "says") {
      head.appendChild(
        mkInput(
          rule.on.text,
          "the phrase to listen for",
          (v) => (rule.on.text = v),
          "w-grow",
        ),
      );
    } else if (rule.on.type === "timer") {
      const n = mkInput(
        rule.on.minutes,
        "5",
        (v) => (rule.on.minutes = Number(v)),
        "w-num",
      );
      n.type = "number";
      n.min = "2";
      n.max = "120";
      head.appendChild(n);
      const lbl = document.createElement("span");
      lbl.className = "bc-unit";
      lbl.textContent = "minutes";
      head.appendChild(lbl);
    }

    if (rule.on.type !== "timer" && rule.on.type !== "arrive") {
      head.appendChild(
        mkSelect(
          WHO_OPTIONS,
          rule.who === "owner" ? "owner" : "",
          (v) => {
            if (v === "owner") rule.who = "owner";
            else delete rule.who;
            renderRules();
          },
          "w-per",
          "Admin commands: pick “only me” and this rule ignores everyone but you",
        ),
      );
    }

    const summary = document.createElement("span");
    summary.className = "bc-rule-summary";
    summary.textContent = ruleSummary(rule);
    head.appendChild(summary);

    head.appendChild(
      mkRowButtons([
        mkIconButton(
          rule._folded ? "Open this rule" : "Fold this rule away",
          rule._folded ? "fa-caret-right" : "fa-caret-down",
          () => {
            rule._folded = !rule._folded;
            renderRules();
          },
        ),
        mkIconButton("Make a copy of this rule", "fa-copy", () => {
          if (edit.rules.length >= maxRules())
            return toastr.error("That's the most rules a bot can have.");
          const copy = JSON.parse(JSON.stringify(rule));
          delete copy._folded;
          edit.rules.splice(ri + 1, 0, copy);
          touch();
          renderRules();
        }),
        mkIconButton("Throw this rule away", "fa-trash", () => {
          edit.rules.splice(ri, 1);
          touch();
          renderRules();
        }),
      ]),
    );
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "bc-rule-body";

    (rule.if || []).forEach((cond, ci) => {
      const row = document.createElement("div");
      row.className = "bc-blk blk-if";
      const g = mkGrip();
      g.addEventListener("pointerdown", (e) =>
        beginDrag(e, { kind: "cond", ri, idx: ci, el: row }),
      );
      row.appendChild(g);
      row.appendChild(mkChip(ci === 0 ? "ONLY IF" : "AND"));
      const aInput = mkInput(cond.a, "{word1}", (v) => (cond.a = v), "w-val");
      row.appendChild(aInput);
      row.appendChild(mkMagicButton(aInput));
      row.appendChild(
        mkSelect(OP_OPTIONS, cond.op, (v) => (cond.op = v), "w-per"),
      );
      const bInput = mkInput(
        cond.b,
        "what it should be",
        (v) => (cond.b = v),
        "w-val",
      );
      row.appendChild(bInput);
      row.appendChild(mkMagicButton(bInput));
      row.appendChild(
        mkRowButtons([
          mkIconButton("Remove this check", "fa-xmark", () => {
            rule.if.splice(ci, 1);
            touch();
            renderRules();
          }),
        ]),
      );
      body.appendChild(row);
    });

    (rule.do || []).forEach((act, ai) => {
      body.appendChild(actionRow(rule, ri, act, ai));
    });

    const adders = document.createElement("div");
    adders.className = "bc-blk-adders";
    if ((rule.if || []).length < maxConds()) {
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
      adders.appendChild(addIf);
    }
    if ((rule.do || []).length < maxActs()) {
      const wrap = document.createElement("span");
      wrap.className = "bc-magic-wrap";
      const addDo = document.createElement("button");
      addDo.className = "bc-mini-btn";
      addDo.innerHTML = '<i class="fas fa-plus"></i> another thing to do';
      addDo.addEventListener("click", (e) => {
        e.stopPropagation();
        openMenu(wrap, ACTION_OPTIONS, (v) => {
          rule.do.push(freshAction(v));
          touch();
          renderRules();
        });
      });
      wrap.appendChild(addDo);
      adders.appendChild(wrap);
    }
    body.appendChild(adders);
    card.appendChild(body);

    return card;
  }

  function actionRow(rule, ri, act, ai) {
    const row = document.createElement("div");
    row.className = "bc-blk blk-do";
    const g = mkGrip();
    g.addEventListener("pointerdown", (e) =>
      beginDrag(e, { kind: "act", ri, idx: ai, el: row }),
    );
    row.appendChild(g);
    row.appendChild(mkChip(ai === 0 ? "DO" : "THEN"));
    row.appendChild(
      mkSelect(
        ACTION_OPTIONS,
        act.type,
        (v) => {
          const idx = rule.do.indexOf(act);
          rule.do[idx] = freshAction(v);
          renderRules();
        },
        "w-act",
      ),
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

    if (act.type === "say" || act.type === "append") {
      const t = document.createElement("textarea");
      t.className = "bc-input w-grow w-say";
      t.rows = 2;
      t.maxLength = sayLen();
      t.placeholder =
        act.type === "append"
          ? "Also, {name} arrived! (written under what it already said)"
          : "Hi {name}! (press Enter for a new line)";
      t.value = act.text || "";
      const grow = () => {
        t.style.height = "auto";
        t.style.height = Math.min(160, Math.max(52, t.scrollHeight)) + "px";
      };
      t.addEventListener("input", () => {
        act.text = t.value;
        grow();
        touch();
      });
      requestAnimationFrame(grow);
      row.appendChild(t);
      row.appendChild(mkMagicButton(t));
    } else if (act.type === "wait") {
      const n = mkInput(
        act.seconds,
        "2",
        (v) => (act.seconds = Number(v)),
        "w-num",
      );
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
      row.appendChild(
        mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"),
      );
      row.appendChild(perSelect(act));
      const eq = document.createElement("span");
      eq.className = "bc-unit";
      eq.textContent = "=";
      row.appendChild(eq);
      const vInput = mkInput(
        act.value,
        "what to write down",
        (v) => (act.value = v),
        "w-val",
      );
      row.appendChild(vInput);
      row.appendChild(mkMagicButton(vInput));
    } else if (act.type === "add") {
      row.appendChild(
        mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"),
      );
      row.appendChild(perSelect(act));
      row.appendChild(
        mkSelect(
          MATH_OPTIONS,
          act.op || "add",
          (v) => (act.op = v),
          "w-math",
          "Add, take away, multiply or divide",
        ),
      );
      const amt = mkInput(act.amount, "1", (v) => (act.amount = v), "w-num");
      row.appendChild(amt);
      row.appendChild(mkMagicButton(amt));
    } else if (act.type === "random") {
      row.appendChild(
        mkInput(act.var, "memory name", (v) => (act.var = v), "w-mem"),
      );
      row.appendChild(perSelect(act));
      const from = document.createElement("span");
      from.className = "bc-unit";
      from.textContent = "from";
      row.appendChild(from);
      row.appendChild(
        mkInput(
          act.from,
          "red, green, blue (or 1-100)",
          (v) => (act.from = v),
          "w-grow",
        ),
      );
    } else if (act.type === "repeat") {
      row.appendChild(
        mkSelect(
          [
            { v: "2", label: "2 times" },
            { v: "3", label: "3 times" },
            { v: "4", label: "4 times" },
            { v: "5", label: "5 times" },
          ],
          String(act.times || 2),
          (v) => (act.times = Number(v)),
          "w-math",
          "How many times the blocks above run in total",
        ),
      );
      const lbl = document.createElement("span");
      lbl.className = "bc-unit";
      lbl.textContent = "in total";
      row.appendChild(lbl);
    }

    row.appendChild(
      mkRowButtons([
        mkIconButton("Remove this block", "fa-xmark", () => {
          rule.do.splice(ai, 1);
          touch();
          renderRules();
        }),
      ]),
    );
    return row;
  }

  $("addRuleBtn").addEventListener("click", () => {
    if (edit.rules.length >= maxRules())
      return toastr.error("That's the most rules a bot can have.");
    edit.rules.push(freshRule());
    touch();
    renderRules();
  });

  // ── The wizard: from an idea to a working bot in three questions ─────────

  const WIZ_WHEN = [
    {
      v: "command",
      t: "Someone types a !command",
      d: "Like !roll or !joke. Words typed after it become {word1}, {word2}...",
      extra: "word",
      label: "The command word (no ! needed)",
      ph: "roll",
    },
    {
      v: "says",
      t: "Someone says a phrase",
      d: 'Anywhere in their line. "pizza" wakes it up.',
      extra: "text",
      label: "The phrase to listen for",
      ph: "pizza",
    },
    {
      v: "mention",
      t: "Someone says the bot's name",
      d: '"hey FishBot..." and it answers.',
    },
    {
      v: "join",
      t: "Someone walks into the room",
      d: "Perfect for a welcome bot.",
    },
    {
      v: "timer",
      t: "Every few minutes, on its own",
      d: "A clock. No person needed. Shortest is 2 minutes.",
      extra: "minutes",
      label: "How many minutes between messages",
      ph: "10",
    },
  ];

  const WIZ_DO = [
    {
      v: "fixed",
      t: "Say a message",
      d: "Always the same answer. Magic words like {name} work.",
    },
    {
      v: "random",
      t: "Say something different each time",
      d: "You give the choices, it picks one at random.",
    },
    {
      v: "points",
      t: "Give points and report them",
      d: "Each person gets their own score. The start of any game.",
    },
  ];

  function openWizard() {
    const state = { step: 1, when: null, extra: "", doKind: null, name: "" };
    renderWizard(state);
  }

  function renderWizard(state) {
    const box = openModal(true);

    const step = document.createElement("div");
    step.className = "bc-wiz-step";
    step.textContent = "STEP " + state.step + " OF 3";
    box.appendChild(step);

    const h = document.createElement("h3");
    const p = document.createElement("p");
    box.appendChild(h);
    box.appendChild(p);

    const choicesHost = document.createElement("div");
    box.appendChild(choicesHost);

    const extraHost = document.createElement("div");
    extraHost.className = "bc-wiz-extra";
    box.appendChild(extraHost);

    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    box.appendChild(btns);

    const mkBtn = (label, primary, onClick) => {
      const b = document.createElement("button");
      b.className = "bc-btn" + (primary ? " primary" : "");
      b.textContent = label;
      b.addEventListener("click", onClick);
      btns.appendChild(b);
      return b;
    };

    const renderExtra = () => {
      extraHost.innerHTML = "";
      const sel = WIZ_WHEN.find((w) => w.v === state.when);
      if (state.step !== 1 || !sel || !sel.extra) return;
      const lbl = document.createElement("label");
      lbl.className = "bc-label";
      lbl.textContent = sel.label;
      const inp = document.createElement("input");
      inp.className = "bc-input";
      inp.style.width = "100%";
      inp.placeholder = sel.ph;
      inp.value = state.extra;
      if (sel.extra === "minutes") inp.type = "number";
      inp.addEventListener("input", () => (state.extra = inp.value));
      extraHost.appendChild(lbl);
      extraHost.appendChild(inp);
      setTimeout(() => inp.focus(), 30);
    };

    const renderChoices = (list, getSel, setSel) => {
      choicesHost.innerHTML = "";
      for (const it of list) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "bc-choice" + (getSel() === it.v ? " sel" : "");
        const b = document.createElement("b");
        b.textContent = it.t;
        const s = document.createElement("span");
        s.textContent = it.d;
        c.appendChild(b);
        c.appendChild(s);
        c.addEventListener("click", () => {
          setSel(it.v);
          [...choicesHost.children].forEach((el) => el.classList.remove("sel"));
          c.classList.add("sel");
          renderExtra();
        });
        choicesHost.appendChild(c);
      }
    };

    if (state.step === 1) {
      h.textContent = "When should your bot speak up?";
      p.textContent = "Pick the moment that wakes it up. You can add more rules later.";
      renderChoices(
        WIZ_WHEN,
        () => state.when,
        (v) => (state.when = v),
      );
      renderExtra();
      mkBtn("Cancel", false, closeModal);
      mkBtn("Next", true, () => {
        if (!state.when) return toastr.error("Pick one to continue.");
        const sel = WIZ_WHEN.find((w) => w.v === state.when);
        if (sel.extra === "word" && !/^[a-z0-9]{1,16}$/i.test(state.extra.trim().replace(/^!/, "")))
          return toastr.error("Type the command word, like roll.");
        if (sel.extra === "text" && !state.extra.trim())
          return toastr.error("Type the phrase to listen for.");
        if (sel.extra === "minutes") {
          const m = Math.round(Number(state.extra));
          if (!Number.isFinite(m) || m < 2 || m > 120)
            return toastr.error("Minutes are 2-120.");
        }
        state.step = 2;
        renderWizard(state);
      });
    } else if (state.step === 2) {
      h.textContent = "What should it do?";
      p.textContent = "This becomes the DO part of your first rule. You can change everything after.";
      renderChoices(
        WIZ_DO,
        () => state.doKind,
        (v) => (state.doKind = v),
      );
      mkBtn("Back", false, () => {
        state.step = 1;
        renderWizard(state);
      });
      mkBtn("Next", true, () => {
        if (!state.doKind) return toastr.error("Pick one to continue.");
        state.step = 3;
        renderWizard(state);
      });
    } else {
      h.textContent = "Name your bot";
      p.textContent = "2-14 characters. Everyone sees it with a BOT badge.";
      const inp = document.createElement("input");
      inp.className = "bc-input";
      inp.style.width = "100%";
      inp.maxLength = 14;
      inp.placeholder = "MyBot";
      inp.value = state.name;
      inp.addEventListener("input", () => (state.name = inp.value));
      choicesHost.appendChild(inp);
      setTimeout(() => inp.focus(), 30);
      mkBtn("Back", false, () => {
        state.step = 2;
        renderWizard(state);
      });
      mkBtn("Build it", true, () => {
        const name = state.name.trim() || "MyBot";
        if (name.length < 2) return toastr.error("2-14 characters.");
        closeModal();
        loadBot(buildWizardBot(state, name));
        toastr.success("Built! Try it in the test room, then press Save.");
      });
    }
  }

  function buildWizardBot(state, name) {
    const on = { type: state.when };
    if (state.when === "command")
      on.word = state.extra.trim().replace(/^!/, "").toLowerCase();
    if (state.when === "says") on.text = state.extra.trim();
    if (state.when === "timer") on.minutes = Math.round(Number(state.extra));

    let doList;
    if (state.doKind === "random") {
      doList = [
        { type: "say", text: "{pick:Yes!|No way.|Maybe...|Ask me tomorrow.}" },
      ];
    } else if (state.doKind === "points") {
      doList = [
        { type: "add", var: "points", per: "user", amount: "1", op: "add" },
        { type: "say", text: "🏆 {name} now has {mymemory:points} points!" },
      ];
    } else {
      doList = [
        {
          type: "say",
          text:
            state.when === "join"
              ? "Welcome to {room}, {name}! 👋"
              : "Hello {name}!",
        },
      ];
    }
    return { id: null, name, location: "Bot", rules: [{ on, if: [], do: doList }] };
  }

  $("wizardBtn").addEventListener("click", () => {
    if (!me) return showView("gate");
    openWizard();
  });

  // ── The test room ─────────────────────────────────────────────────────────

  const SETTLE_MS = 1200;
  let settleTimer = null;
  let prevLine = "";
  let lineDirty = false;
  let testWaiting = null;
  let botTimers = [];

  function lastNonEmptyLine(text) {
    const lines = String(text || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (l) return l;
    }
    return "";
  }

  function lastLineKey(text) {
    const lines = String(text || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (l) return i + ":" + l;
    }
    return "";
  }

  function ensureTest(then) {
    if (!edit) return;
    if (!testDirty) return then();
    testWaiting = then;
    socket.emit("bots test start", {
      bot: {
        name: edit.name,
        location: edit.location,
        prefix: edit.prefix || "!",
        rules: edit.rules,
      },
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
    setTestStatus(
      "Problem with the rules: " + (d?.message || "something is not right."),
    );
    toastr.error(d?.message || "Something in the rules is not right.");
  });

  function setTestStatus(text) {
    $("trStatus").textContent = text;
  }

  function resetTestRoom() {
    for (const t of botTimers) clearTimeout(t);
    botTimers = [];
    prevLine = "";
    lineDirty = false;
    $("trMyBox").value = "";
    $("trBotBox").textContent = "";
    $("trBotTyping").style.display = "none";
    $("trMyName").textContent = me
      ? me.username + " / " + (me.location || "here")
      : "You";
    $("trBotName").textContent = botHeaderText();
    setTestStatus(
      "Type in your box. When your last line sits still for a second, " +
        (edit?.name || "the bot") +
        " reads it.",
    );
  }

  $("trMyBox").addEventListener("input", () => {
    const key = lastLineKey($("trMyBox").value);
    if (key !== prevLine) lineDirty = true;
    prevLine = key;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settledLine, SETTLE_MS);
  });

  function settledLine() {
    if (!edit || !lineDirty) return;
    lineDirty = false;
    const text = $("trMyBox").value;
    if (!lastNonEmptyLine(text)) return;
    ensureTest(() => socket.emit("bots test say", { text }));
  }

  function typeIntoBotBox(text, delayMs, append) {
    botTimers.push(
      setTimeout(() => {
        const box = $("trBotBox");
        $("trBotTyping").style.display = "";
        const base = append && box.textContent ? box.textContent + "\n" : "";
        const full = base + text;
        let i = base.length;
        const iv = setInterval(() => {
          i = Math.min(full.length, i + 2);
          box.textContent = full.slice(0, i);
          box.scrollTop = box.scrollHeight;
          if (i >= full.length) {
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
      head.insertBefore(tag, head.querySelector(".bc-row-btns"));
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
      if (s.clear)
        botTimers.push(
          setTimeout(() => ($("trBotBox").textContent = ""), s.delayMs),
        );
      else typeIntoBotBox(s.text, s.delayMs, s.append);
    }

    if (d.left)
      setTestStatus(
        (edit?.name || "The bot") + " left the room. Its rule told it to.",
      );
    else if (
      d.about === "say" &&
      !(d.fired || []).length &&
      !(d.skipped || []).length
    )
      setTestStatus("No rule woke up for that line. Check the WHEN parts.");
    else if (
      d.about === "say" &&
      !(d.says || []).length &&
      (d.skipped || []).length &&
      !(d.fired || []).length
    )
      setTestStatus("A rule heard you, but its checks said no.");
    else if (d.about === "say") setTestStatus("");

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
      parts.push("TestBot's: " + fmt(d.friendMemories));
    body.innerHTML = parts.length ? parts.join("<br/>") : "Nothing yet.";
  }

  function esc(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  $("testJoinBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("TestBot walks into the room...");
    ensureTest(() => socket.emit("bots test event", { kind: "join" }));
  });
  $("testLeaveBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("TestBot walks out...");
    ensureTest(() => socket.emit("bots test event", { kind: "leave" }));
  });
  $("testTimerBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("Every timer rule goes off right now.");
    ensureTest(() => socket.emit("bots test event", { kind: "timer" }));
  });
  $("testArriveBtn").addEventListener("click", () => {
    if (!edit) return;
    setTestStatus("The bot lands in the room...");
    ensureTest(() => socket.emit("bots test event", { kind: "arrive" }));
  });
  $("testResetBtn").addEventListener("click", () => {
    if (!edit) return;
    ensureTest(() => {
      socket.emit("bots test reset");
      setTestStatus("The bot's test memory is wiped clean.");
    });
  });

  // ── Deploy: a modal with the room list and plain answers ─────────────────

  function botSeats(capacity) {
    return Math.max(1, Math.min(5, Math.floor((capacity || 5) / 5)));
  }

  $("deployOpenBtn").addEventListener("click", () => {
    if (!edit) return;
    openDeployModal();
  });

  function openDeployModal() {
    const box = openModal(true);
    const d = deployedInfo();

    const h = document.createElement("h3");
    h.innerHTML = '<i class="fas fa-rocket"></i> ';
    box.appendChild(h);

    if (d) {
      const mine = d.botId === edit.id;
      h.appendChild(
        document.createTextNode(
          mine ? (edit.name || "Your bot") + " is live" : "One bot at a time",
        ),
      );
      const p = document.createElement("p");
      p.textContent = mine
        ? 'It is in "' + (d.roomName || d.roomId) + '" right now. Bring it home to edit and send it again.'
        : "Another of your bots is out in a room. Bring it home first, then send this one.";
      box.appendChild(p);
      const btns = document.createElement("div");
      btns.className = "bc-modal-btns";
      const stop = document.createElement("button");
      stop.className = "bc-btn danger";
      stop.innerHTML = '<i class="fas fa-stop"></i>Bring it home';
      stop.addEventListener("click", () => {
        socket.emit("bots stop");
        closeModal();
      });
      const cancel = document.createElement("button");
      cancel.className = "bc-btn";
      cancel.textContent = "Close";
      cancel.addEventListener("click", closeModal);
      btns.appendChild(stop);
      btns.appendChild(cancel);
      box.appendChild(btns);
      return;
    }

    h.appendChild(document.createTextNode("Send " + (edit.name || "the bot") + " to a room"));

    const saved = (status?.bots || []).some((b) => b.id === edit.id);
    const p = document.createElement("p");
    p.textContent = saved
      ? "Rooms have bot seats by size: 1 for every 5 people they can hold. The bot runs while you are on Talkomatic."
      : "Save the bot first, then send it in. Unsaved changes never leave this page.";
    box.appendChild(p);

    if (!saved || dirty) {
      const warn = document.createElement("p");
      warn.style.color = "var(--tk-accent)";
      warn.textContent = !saved
        ? "This bot is not saved yet. Press Save, then come back."
        : "You have unsaved changes. The room gets the last SAVED version.";
      box.appendChild(warn);
    }

    const optA = document.createElement("div");
    optA.className = "bc-deploy-opt" + (deployMode === "existing" ? " sel" : "");
    optA.innerHTML =
      '<h4><i class="fas fa-door-open"></i>A room that exists</h4>' +
      '<div class="bc-room-row"><select class="bc-select" id="roomSelect"></select>' +
      '<button class="bc-btn" id="roomRefresh" title="Look again"><i class="fas fa-rotate"></i></button></div>' +
      '<div class="bc-deploy-note">The bot takes a seat right away and starts listening.</div>';
    const optB = document.createElement("div");
    optB.className = "bc-deploy-opt" + (deployMode === "new" ? " sel" : "");
    optB.innerHTML =
      '<h4><i class="fas fa-plus"></i>A brand new room</h4>' +
      '<input class="bc-input" id="newRoomName" maxlength="25" placeholder="Name the room" style="width:100%" />' +
      '<div class="bc-deploy-note">The room opens, you go in first, and your bot walks in right behind you.</div>';
    box.appendChild(optA);
    box.appendChild(optB);

    const setMode = (m) => {
      deployMode = m;
      optA.classList.toggle("sel", m === "existing");
      optB.classList.toggle("sel", m === "new");
    };
    optA.addEventListener("click", () => setMode("existing"));
    optB.addEventListener("click", () => setMode("new"));

    const btns = document.createElement("div");
    btns.className = "bc-modal-btns";
    const send = document.createElement("button");
    send.className = "bc-btn primary";
    send.innerHTML = '<i class="fas fa-rocket"></i>Send it in';
    send.disabled = !saved || status?.enabled === false;
    send.addEventListener("click", () => {
      if (deployMode === "existing") {
        const roomId = box.querySelector("#roomSelect").value;
        if (!roomId)
          return toastr.error("Pick a room first (or make a new one).");
        socket.emit("bots deploy", { id: edit.id, roomId });
      } else {
        const name = box.querySelector("#newRoomName").value.trim();
        if (name.length < 3)
          return toastr.error("Give the new room a name (3+ letters).");
        socket.emit("bots deploy", { id: edit.id, newRoom: { name } });
      }
    });
    const cancel = document.createElement("button");
    cancel.className = "bc-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeModal);
    btns.appendChild(send);
    btns.appendChild(cancel);
    box.appendChild(btns);

    if (status?.enabled === false) {
      const off = document.createElement("p");
      off.style.color = "var(--tk-error)";
      off.textContent = "Bots are switched off by the mods right now.";
      box.appendChild(off);
    }

    box.querySelector("#roomRefresh").addEventListener("click", (e) => {
      e.stopPropagation();
      socket.emit("get rooms");
    });
    socket.emit("get rooms");
  }

  socket.on("initial rooms", (list) => {
    const sel = document.getElementById("roomSelect");
    if (!sel) return;
    const rooms = Array.isArray(list) ? list : [];
    const prev = sel.value;
    sel.innerHTML = "";
    const pub = rooms.filter((r) => r.type === "public");
    if (!pub.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No public rooms right now. Make a new one!";
      sel.appendChild(opt);
      return;
    }
    const rows = pub.map((r) => {
      const users = r.users || [];
      const humans = users.filter((u) => !u.isBotUser).length;
      const bots = users.filter((u) => u.isBotUser).length;
      const cap = r.capacity || 5;
      const seats = botSeats(cap);
      let why = "";
      if (r.allowBots === false) why = "no bots allowed";
      else if (r.locked) why = "locked";
      else if (!humans) why = "empty";
      else if (r.isFull) why = "full";
      else if (bots >= seats) why = "no bot seats left";
      return { r, humans, bots, seats, why };
    });
    rows.sort((a, b) => (a.why ? 1 : 0) - (b.why ? 1 : 0));
    for (const row of rows) {
      const opt = document.createElement("option");
      opt.value = row.r.id;
      opt.textContent =
        row.r.name +
        " · " +
        row.humans +
        (row.humans === 1 ? " person" : " people") +
        " · " +
        row.bots +
        "/" +
        row.seats +
        (row.seats === 1 ? " bot" : " bots") +
        (row.why ? " (" + row.why + ")" : "");
      if (row.why) opt.disabled = true;
      sel.appendChild(opt);
    }
    const keep = [...sel.options].find((o) => o.value === prev && !o.disabled);
    if (keep) sel.value = prev;
    else {
      const first = [...sel.options].find((o) => !o.disabled);
      if (first) sel.value = first.value;
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
      btn.textContent =
        d?.enabled === false ? "Turn bots ON" : "Turn ALL bots OFF";
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

  // ── What's new ────────────────────────────────────────────────────────────

  const NEWS_VERSION = 9;
  const NEWS = [
    'Share a bot with friends: the new share button in the editor makes a code. Anyone who enters it under "Add a shared bot" becomes a manager - they can edit the bot, send it to rooms, and use its admin-only commands in rooms, exactly like you. Only you can delete the bot, remove managers, or hand ownership over. The clock button shows the bot\'s history (who made it, who saved what), the last 5 versions are kept with one-click restore for the owner, and nobody can accidentally overwrite anyone else\'s save.',
    "Custom command prefixes: the little box next to your bot's name sets the symbol people type before commands. Keep ! or pick ? . ~ >> or any 1-2 symbols. {commands} lists them with the right prefix, and {prefix} says what it is.",
    'Bots now say hello: when a bot lands in a room it introduces itself and lists its public commands, so people know it exists. Want your own greeting? Add a rule with the new "the bot arrives in the room" trigger and it replaces the built-in hello completely. Want silence? Make an arrive rule with only a wait block. Preview it with the "Bot arrives" button in the Test room.',
    "Memories can now be picked by name at runtime: {memory:note_{word1}} reads whatever the first word names, and a memory block can WRITE to note_{word1} too. So !remember pizza extra cheese saves it, and !recall pizza reads it back. Add |your own text for when nothing is stored: {memory:note_{word1}|I have no note about that}. {words2} grabs everything from the 2nd word on, and writing an empty value forgets a memory.",
    'Admin commands: every rule now has a "who can trigger it" choice. Pick "only me (admin)" and that rule ignores everyone but you, matched by your session, not your name. New magic words {owner} and {ownercommands}, and an "Admin commands" ready-made bot to start from.',
    "The For coders page is now the real manual: every socket event documented, tokens that renew themselves, working Node and Python bots to copy, and answers for the classic \"my bot vanished\" mysteries.",
    "Automod no longer stars out what bots say for everyone: it is each viewer's own choice now, exactly like for people. Turn your filter off, see the real text.",
    "The small limits are gone: up to 200 rules, 20 blocks per rule, 1000-letter says, 20 saved bots. Build the whole game.",
    'New "add a line below" block: says WITHOUT erasing, so a greeter can stack arrivals and a game can keep its board up.',
    "New repeat block (runs everything above it again, up to 5 times) and magic words {commands} (your command list, one per line) and {runtime}.",
    "Your bot list now says why a bot came home, like its owner leaving Talkomatic. That was most \"timers don't work\" reports: bots go home about a minute after you leave, so long timers never got to ring.",
    "Rooms have a bot button next to Apps: anyone can hide bots from their own view (the bot still runs).",
  ];

  const CHANGELOG = [
    {
      title: "Sharing your bot",
      icon: "fa-user-group",
      items: [
        "The share button in the editor (next to Delete) opens the Managers dialog: make a share code, copy it, revoke it whenever you like.",
        'Your friend presses "Add a shared bot" on the home screen and enters the code. The bot appears in their list marked "shared by you", and they become a manager (up to 5 per bot).',
        'Managers can edit the bot\'s rules, send it to a room, stop it, and use its "admins only" commands in rooms - the bot recognises them by their device, never by their name.',
        "Only the owner can delete the bot, hand out or revoke the code, remove a manager, or transfer ownership (Make owner - you stay on as a manager).",
        "One bot in play per stable: while a shared bot is out, neither the owner nor its managers can send another copy.",
        "Edits made while the bot is out in a room apply the next time it is deployed, same as your own edits.",
        "Every shared bot keeps a history: who made it, every save with who saved it, managers joining or being removed, transfers and restores. The clock button in the editor shows it to the whole group.",
        "The last 5 versions are kept automatically. If an edit wrecks the bot, the owner opens History and restores any earlier version with one click - the wrecked version stays in the list too, so nothing is ever lost.",
        "Nobody can silently overwrite anyone: saving over a version somebody else saved after you opened the bot is stopped with a clear message - reopen the bot from your list to catch up, then make your change.",
      ],
    },
    {
      title: "Command prefixes",
      icon: "fa-terminal",
      items: [
        "The small box beside the bot's name sets its command prefix: 1-2 symbols, like ! (the default), ?, ., ~, or >>.",
        "Every command rule uses it: with prefix ? a rule on the word roll fires on ?roll. Nothing else about the rule changes.",
        "Type the word with or without the prefix in the rule; the editor and the server both strip it for you.",
        "{commands} and {ownercommands} list commands with the right prefix, and the new {prefix} magic word prints the prefix itself.",
        "Old bots keep ! without any change; the prefix travels with Export, Import, and shared bots.",
      ],
    },
    {
      title: "Bots say hello",
      icon: "fa-door-open",
      items: [
        "When a bot lands in a room it now introduces itself: a short hello plus up to 6 of its public commands, so people know what to type.",
        'To write your own greeting, add a rule with the "the bot arrives in the room" trigger. Your rule replaces the built-in hello completely, and you can use every block and magic word in it ({commands}, {room}, memories, waits).',
        "Nobody triggered an arrive rule, so {name} is empty there; {bot}, {room} and {humans} all work.",
        "Want the bot to arrive silently, like before? Make an arrive rule with only a wait block in it.",
        'Preview the whole thing with the new "Bot arrives" button in the Test room.',
        "This runs once per deploy, when the bot walks in - not when people join later (that is still the \"someone joins the room\" trigger).",
      ],
    },
    {
      title: "Memories by name",
      icon: "fa-book-open",
      items: [
        "A memory block's name can include placeholders: set note_{word1} = {words2} stores whatever they typed under a name of their choosing.",
        "{memory:note_{word1}} reads it back: the name inside resolves first, then the memory is looked up. Works for {mymemory:...} too.",
        "Add |your own fallback for when nothing is stored: {memory:note_{word1}|I have no note about that}.",
        "{words2} up to {words8}: everything from that word on, so !remember pizza extra cheese splits into the name and the note.",
        "Writing an empty value forgets the memory and frees its slot, so a !forget command is one set block.",
        "Names settle to letters, digits and _ (spaces become _), 20 letters max. Everything works in the Test room.",
      ],
    },
    {
      title: "Admin commands",
      icon: "fa-user-shield",
      items: [
        'Every rule has a "who can trigger it" dropdown: anyone (the default, exactly as before) or only me (admin).',
        "Admin-only rules ignore everyone but the person who deployed the bot and the bot's managers, matched by session and device, never by name.",
        "{ownercommands} lists your admin commands; {commands} now lists only the public ones. {owner} is your name.",
        'A ready-made "Admin commands" bot: !say, !clear, !gohome, !admin, all owner-only.',
        "In the Test room you count as the owner, so admin rules fire when you test them; Testy cannot trigger them.",
        "Existing bots are untouched: no dropdown flipped, no behavior changed.",
      ],
    },
    {
      title: "The limits, out of the way",
      icon: "fa-unlock",
      items: [
        "Rules per bot: was 20, now 200.",
        "Blocks per rule: was 6, now 20.",
        "Letters per say: was 300, now 1000.",
        "Checks per rule: was 3, now 10.",
        "Saved bots: was 8, now 20.",
      ],
    },
    {
      title: "New blocks and magic words",
      icon: "fa-cubes",
      items: [
        '"add a line below" says WITHOUT erasing: stack greetings, keep a game board up.',
        "repeat runs everything above it again, up to 5 times in total.",
        '"change a memory" can add, take away, multiply and divide.',
        "{commands} lists every !command one per line, {runtime} says how long the bot has been in its room, {newline} breaks a line mid-say.",
      ],
    },
    {
      title: "In rooms",
      icon: "fa-door-open",
      items: [
        "Commands fire anywhere in your line: please !roll works too. No pressing Enter first.",
        "Automod is each viewer's own choice for bot text, exactly like for people. No stars baked in for everyone.",
        "Rooms fit more bots as they grow: 1 bot seat per 5 people, up to 5.",
        "The robot button next to Apps hides bots from your own view; the bot keeps running.",
        "Bots wear a gray BOT tag in the room and the lobby, and can have their own location: FishBot / the lake.",
      ],
    },
    {
      title: "The editor",
      icon: "fa-hammer",
      items: [
        "Drag blocks and whole rules by their grip dots, even between rules.",
        "Memories are chips in the palette: make one, click it into a box. No curly brackets to type.",
        "Start from an idea builds a working bot from three questions.",
        "Saving points at exactly what is missing. Drafts survive closing the tab.",
      ],
    },
    {
      title: "For coders",
      icon: "fa-code",
      items: [
        "The whole bot API is documented on the For coders tab now: tokens, connecting, rooms, the diff protocol, and every event both ways.",
        "Two complete bots to copy, one in Node and one in Python. Both run as-is and were tested against a live server.",
        "A token helper that renews itself when the token expires or a server restart forgets it.",
        "Why bots \"randomly\" disconnect, explained and fixed: the inactivity check, restarts, room closures, all of it in one section.",
        "Code blocks have syntax colors and a copy button.",
      ],
    },
    {
      title: "Fixes",
      icon: "fa-wrench",
      items: [
        "Typing the same command twice in a row works, in rooms and in the test room.",
        "The page survives Talkomatic updates: it reconnects, signs back in, and shows your bot's true status.",
        "Your bot list says why a bot came home. Timers work; bots go home about a minute after their owner leaves Talkomatic.",
      ],
    },
  ];

  function renderNewsTab() {
    const host = $("newsTabHost");
    if (!host) return;
    host.innerHTML = "";

    const numbers = document.createElement("div");
    numbers.className = "bc-card";
    const nh = document.createElement("div");
    nh.className = "bc-card-head";
    nh.innerHTML = '<i class="fas fa-ruler"></i>The numbers today';
    const nb = document.createElement("div");
    nb.className = "bc-card-body";
    const grid = document.createElement("div");
    grid.className = "bc-limits";
    const row = (label, oldVal, nowVal) => {
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("span");
      if (oldVal != null) {
        const o = document.createElement("span");
        o.className = "old";
        o.textContent = String(oldVal);
        v.appendChild(o);
      }
      const b = document.createElement("b");
      b.textContent = String(nowVal);
      v.appendChild(b);
      grid.appendChild(l);
      grid.appendChild(v);
    };
    row("Rules per bot", 20, maxRules());
    row("Blocks per rule", 6, maxActs());
    row("Checks per rule", 3, maxConds());
    row("Letters per say", 300, sayLen());
    row("Bots you can keep saved", 8, status?.limits?.maxSaved || 20);
    row("Bots running per person", null, 1);
    row("Bot seats in a room", null, "1 per 5 people, up to 5");
    row("Timers", null, "every 2-120 minutes");
    row("Message pace", null, "about one per 1.5 seconds");
    const note = document.createElement("p");
    note.className = "bc-sec-note";
    note.style.marginTop = "12px";
    note.textContent =
      "The pace is the only ceiling that protects rooms from spam; everything else is there to build with.";
    nb.appendChild(grid);
    nb.appendChild(note);
    numbers.appendChild(nh);
    numbers.appendChild(nb);
    host.appendChild(numbers);

    for (const group of CHANGELOG) {
      const card = document.createElement("div");
      card.className = "bc-card";
      const h = document.createElement("div");
      h.className = "bc-card-head";
      h.innerHTML = '<i class="fas ' + group.icon + '"></i>';
      h.appendChild(document.createTextNode(group.title));
      const b = document.createElement("div");
      b.className = "bc-card-body";
      const ul = document.createElement("ul");
      ul.className = "bc-news-list";
      for (const it of group.items) {
        const li = document.createElement("li");
        li.textContent = it;
        ul.appendChild(li);
      }
      b.appendChild(ul);
      card.appendChild(h);
      card.appendChild(b);
      host.appendChild(card);
    }
  }
  renderNewsTab();

  let newsChecked = false;

  function maybeShowNews() {
    if (newsChecked || !status) return;
    newsChecked = true;
    const seen = Number(localStorage.getItem("bc_news_seen") || 0);
    if (seen >= NEWS_VERSION) return;
    if (!(status.bots || []).length) {
      localStorage.setItem("bc_news_seen", String(NEWS_VERSION));
      return;
    }
    const host = $("newsHost");
    const card = document.createElement("div");
    card.className = "bc-card bc-news";
    const head = document.createElement("div");
    head.className = "bc-card-head";
    head.innerHTML = '<i class="fas fa-bullhorn"></i>New since your last visit';
    const bodyEl = document.createElement("div");
    bodyEl.className = "bc-card-body";
    const ul = document.createElement("ul");
    ul.className = "bc-news-list";
    for (const n of NEWS) {
      const li = document.createElement("li");
      li.textContent = n;
      ul.appendChild(li);
    }
    const note = document.createElement("p");
    note.className = "bc-news-note";
    note.textContent =
      "Bots you already saved keep working exactly as before. The full list, with all the numbers, lives in the What's new tab up top.";
    const got = document.createElement("button");
    got.className = "bc-btn primary";
    got.innerHTML = '<i class="fas fa-check"></i>Got it';
    got.addEventListener("click", () => {
      localStorage.setItem("bc_news_seen", String(NEWS_VERSION));
      card.remove();
    });
    bodyEl.appendChild(ul);
    bodyEl.appendChild(note);
    bodyEl.appendChild(got);
    card.appendChild(head);
    card.appendChild(bodyEl);
    host.appendChild(card);
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  setInterval(() => {
    if (me && deployedInfo()) socket.emit("bots status");
  }, 5000);

  // ── For coders: copy buttons + syntax colors ──────────────────────────────

  document.querySelectorAll("#apiView .bc-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.closest(".bc-codebox")?.querySelector("pre code");
      if (!code) return;
      const done = () => {
        btn.classList.add("copied");
        btn.innerHTML = '<i class="fas fa-check"></i>Copied';
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = '<i class="fas fa-copy"></i>Copy';
        }, 1600);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code.textContent).then(done, done);
      } else {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("copy");
        sel.removeAllRanges();
        done();
      }
    });
  });

  if (window.Prism) Prism.highlightAll();

  socket.on("error", (e) => {
    const msg = e?.error?.message;
    if (msg) toastr.error(msg);
  });
})();
