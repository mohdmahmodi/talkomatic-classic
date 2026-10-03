(function () {
  "use strict";

  var VERSION = "6.2";
  var SHOW_AFTER_MS = 90000;
  var RETRY_MS = 30000;
  var REPEAT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
  var SHOWN_KEY = "talkomatic_popup_last_shown";
  var VERSION_KEY = "talkomatic_popup_last_version";

  var SECTIONS = [
    {
      title: "Safechat",
      items: [
        {
          icon: "fa-shield-halved",
          tag: "new",
          title: "Normal words stay normal",
          text: "Safechat no longer stars everyday words. Cook, classes, passes, treatment, glasses, amusement and plain numbers all come through now, and so do sentences like \"the chef is typing\" and \"who are you\".",
        },
        {
          icon: "fa-user-shield",
          tag: "new",
          title: "Harder to dodge",
          text: "Spelling a word out with spaces, stretching it, doubling letters or swapping in numbers and symbols is caught far more reliably than before.",
        },
        {
          icon: "fa-keyboard",
          tag: "new",
          title: "Off means off everywhere",
          text: "If you turn Safechat off with the shield in a room, it now stays off on the Talkoboard chat, in games and on the Ideas & Bugs board too. Leave it on and everything stays filtered for you, same as before.",
        },
        {
          icon: "fa-keyboard",
          tag: "new",
          title: "No more flicker in your own box",
          text: "The word you are typing is left alone for a second, so stars no longer jump in and out while you finish it. Everyone else still sees it filtered right away.",
        },
      ],
    },
    {
      title: "On the Talkoboard",
      items: [
        {
          icon: "fa-location-crosshairs",
          tag: "new",
          title: "Find your way back",
          text: "Two new buttons at the bottom of the board: one jumps to the last thing you drew, the other takes you back to the start. Press M or 0 on a keyboard.",
        },
        {
          icon: "fa-layer-group",
          tag: "new",
          title: "Layers",
          text: "Five layers everyone shares, stacked bottom to top. Put your lineart on one and color on the one below it, and the color never goes over the lines. The eraser only rubs out the layer it is on, and you can hide layers for yourself while you work.",
        },
        {
          icon: "fa-droplet",
          title: "Opacity",
          text: "Make any color see-through from the Opacity slider in the Color panel. Works with the pen, shapes, the bucket and the eraser.",
        },
        {
          icon: "fa-image",
          title: "Trace a picture",
          text: "Put any picture from your device under the board and draw over it. Move it, resize it, flip it, fade it. Only you can see it: it never leaves your browser and it is not in saved images.",
        },
        {
          icon: "fa-lock-open",
          title: "Share your area",
          text: "Protect still keeps a patch of the board yours, and the box you can take is now twice as wide. Next to it, choose who may draw inside: only you, everyone, or the friends you tick off a list.",
        },
      ],
    },
    {
      title: "Make it yours",
      items: [
        {
          icon: "fa-heart",
          title: "Favorite themes",
          text: "Tap the heart on any theme on the Themes page and it goes in your Favorites tab, ready to apply without searching. Favorites stay yours even if the theme is later taken down.",
        },
        {
          icon: "fa-palette",
          title: "Themes",
          text: "Repaint the whole site with no CSS. Press Customize in the lobby, or Apps then Theme Editor in a room. Publish yours on the Themes page and use anyone else's in a click.",
        },
        {
          icon: "fa-user-astronaut",
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
          title: "Bot Creator",
          text: "Build a bot out of rules without writing code, then send it into a room. Share it with friends and they can edit and send it too.",
        },
        {
          icon: "fa-dice",
          title: "Games in rooms",
          text: "Tic Tac Toe, Connect Four, Draw & Guess and Flag Guess, all inside the room under Apps. Popshot is there for playing on your own.",
        },
        {
          icon: "fa-pen-ruler",
          title: "Talkoboard",
          text: "A drawing board the whole room shares, with pen, shapes, fills, protected areas and export.",
        },
      ],
    },
    {
      title: "Have your say",
      items: [
        {
          icon: "fa-lightbulb",
          title: "Ideas & Bugs board",
          text: "Post an idea or report something broken, vote on everyone else's, and watch the status change as they get picked up. Layers, opacity and favorites all came from there.",
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
