(function () {
  "use strict";

  var VERSION = "6.1";
  var SHOW_AFTER_MS = 90000;
  var RETRY_MS = 30000;
  var REPEAT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
  var SHOWN_KEY = "talkomatic_popup_last_shown";
  var VERSION_KEY = "talkomatic_popup_last_version";

  var SECTIONS = [
    {
      title: "Make it yours",
      items: [
        {
          icon: "fa-palette",
          tag: "new",
          title: "Themes",
          text: "Repaint the whole site with no CSS. Press Customize in the lobby, or Apps then Theme Editor in a room. Publish yours on the Themes page and use anyone else's in a click.",
        },
        {
          icon: "fa-user-astronaut",
          tag: "new",
          title: "Profile pictures",
          text: "Pick a picture to sit next to your name in the lobby, in rooms, and on the board.",
        },
      ],
    },
    {
      title: "Things to do",
      items: [
        {
          icon: "fa-robot",
          tag: "new",
          title: "Bot Creator",
          text: "Build a bot out of rules without writing code, then send it into a room. Share it with friends and they can edit and send it too.",
        },
        {
          icon: "fa-dice",
          tag: "new",
          title: "Games in rooms",
          text: "Tic Tac Toe, Connect Four, Draw & Guess and Flag Guess, all inside the room under Apps. Popshot is there for playing on your own.",
        },
        {
          icon: "fa-pen-ruler",
          title: "Talkoboard",
          text: "A drawing board the whole room shares, with pen, shapes, text and export.",
        },
        {
          icon: "fa-layer-group",
          tag: "new",
          title: "Layers and opacity on the board",
          text: "Five shared layers, so you can sketch on one and color on another and the eraser only touches its own. Set how see-through a color is from the Color panel. Your protected area can be opened up to friends for a while.",
        },
      ],
    },
    {
      title: "Have your say",
      items: [
        {
          icon: "fa-lightbulb",
          tag: "new",
          title: "Ideas & Bugs board",
          text: "Post an idea or report something broken, vote on everyone else's, and watch the status change as they get picked up.",
        },
        {
          icon: "fa-shield-halved",
          title: "Moderator applications",
          text: "Applications open from the lobby when the team is looking. Anyone can apply.",
        },
      ],
    },
    {
      title: "Around the site",
      items: [
        {
          icon: "fa-chart-simple",
          tag: "new",
          title: "Site Stats",
          text: "See how busy Talkomatic has been, by day and by month.",
        },
        {
          icon: "fa-eye",
          title: "Spectate before joining",
          text: "Read a public room from the lobby without taking a spot in it.",
        },
        {
          icon: "fa-scale-balanced",
          title: "Rules on demand",
          text: "Type @rules in your box in any room to read the rules and what moderators may and may not do.",
        },
      ],
    },
  ];

  var overlay = null;
  var isOpen = false;
  var keyHandler = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function readCookie(name) {
    var parts = document.cookie.split(";");
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].trim();
      if (c.indexOf(name + "=") === 0) return c.slice(name.length + 1);
    }
    return null;
  }

  function writeCookie(name, value) {
    var expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + 1);
    document.cookie =
      name + "=" + value + "; expires=" + expiry.toUTCString() + "; path=/; SameSite=Lax";
  }

  function shouldShow() {
    var shown = readCookie(SHOWN_KEY);
    var version = readCookie(VERSION_KEY);
    if (!shown || !version) return true;
    if (version !== VERSION) return true;
    return Date.now() - parseInt(shown, 10) >= REPEAT_AFTER_MS;
  }

  function remember() {
    writeCookie(SHOWN_KEY, String(Date.now()));
    writeCookie(VERSION_KEY, VERSION);
  }

  function buildItem(item) {
    var row = el("div", "tku-item");
    var ico = el("div", "tku-ico");
    ico.appendChild(el("i", "fas " + item.icon));
    row.appendChild(ico);

    var body = el("div", "tku-item-body");
    var head = el("div", "tku-item-head");
    head.appendChild(el("span", "tku-item-title", item.title));
    if (item.tag) head.appendChild(el("span", "tku-tag " + item.tag, item.tag));
    body.appendChild(head);
    body.appendChild(el("p", "tku-item-text", item.text));
    row.appendChild(body);
    return row;
  }

  function build() {
    overlay = el("div", "tkm-overlay tku-overlay");
    var modal = el("div", "tkm-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "What's new in Talkomatic");

    var head = el("div", "tkm-head");
    var headText = el("div", "tkm-head-text");
    var title = el("div", "tkm-title");
    title.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> What\u2019s new';
    headText.appendChild(title);
    headText.appendChild(
      el(
        "div",
        "tkm-sub",
        "Everything added since you were last here. You can read this again any time from Update Notes in the lobby menu.",
      ),
    );
    head.appendChild(headText);

    var close = el("button", "tkm-close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", hide);
    head.appendChild(close);
    modal.appendChild(head);

    var body = el("div", "tkm-body");
    SECTIONS.forEach(function (section) {
      body.appendChild(el("div", "tku-sec-title", section.title));
      var list = el("div", "tku-list");
      section.items.forEach(function (item) {
        list.appendChild(buildItem(item));
      });
      body.appendChild(list);
    });
    modal.appendChild(body);

    var gate = el("div", "tkm-gate");
    gate.appendChild(el("div", "tkm-gate-msg", "Version " + VERSION));
    var ok = el("button", "tkm-gate-btn", "Got it");
    ok.type = "button";
    ok.addEventListener("click", hide);
    gate.appendChild(ok);
    modal.appendChild(gate);

    overlay.appendChild(modal);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hide();
    });
    document.body.appendChild(overlay);
  }

  function show() {
    if (isOpen) return;
    if (!overlay) build();
    overlay.classList.add("show");
    document.body.classList.add("tkm-lock");
    isOpen = true;
    keyHandler = function (e) {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", keyHandler);
  }

  function hide() {
    if (!isOpen) return;
    overlay.classList.remove("show");
    document.body.classList.remove("tkm-lock");
    isOpen = false;
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    remember();
  }

  function busy() {
    if (document.querySelector(".tkm-overlay.show, .an-overlay.show")) return true;
    var info = document.getElementById("roomInfoModal");
    return !!(info && info.style.display && info.style.display !== "none");
  }

  function schedule(delay) {
    if (!shouldShow()) return;
    setTimeout(function () {
      if (busy()) schedule(RETRY_MS);
      else show();
    }, delay);
  }

  function start() {
    schedule(SHOW_AFTER_MS);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();

  window.TalkomaticPopup = {
    forceShowPopup: show,
    close: hide,
    version: VERSION,
  };
})();
