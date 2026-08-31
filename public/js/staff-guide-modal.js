// public/js/staff-guide-modal.js
// The public explainer for staff ranks: what each badge means, what that
// person can do, and what they hand up the ladder. Opened from the lobby
// header (About | Rules | Staff). Content is static and written for users,
// not staff - the staff version lives in mod.html's Guide tab.
(function () {
  "use strict";

  var overlay,
    modalEl,
    listEl,
    closeBtnEl,
    footerEl = null,
    built = false;
  var tab = "jr";
  var tabBtns = {};
  var gateCb = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var RANKS = {
    jr: {
      name: "Junior mod",
      badge: "JR MOD",
      color: "#c08bff",
      icon: "fa-user-shield",
      tagline:
        "The first pair of hands. Everything a junior holds is reversible, so they can act fast without anybody paying for a mistake.",
      can: [
        "Warn people, and kick them - a kick comes with a ban from that one room.",
        "Wipe what somebody has typed, for everyone in the room.",
        "Reset a rule-breaking name, location, or profile picture.",
        "Rename, lock, or slow-mode a room, and clear its Talkoboard.",
        "Answer reports: every report reaches them, and their warning or kick can settle it.",
      ],
      handsUp: [
        "Anything that outlasts the room: blocking a person from the site is a full-mod call.",
        "Closing a room entirely.",
        "Ban appeals, and repeat offenders who shrug off kicks.",
        'If a junior says "I\'m getting a full mod", that is the system working - not a brush-off.',
      ],
      notes: [
        "They cannot ban you from the site, and they cannot act on other staff.",
        "Nobody on staff sees your IP address - the server handles addresses, people never read them.",
      ],
    },
    full: {
      name: "Full mod",
      badge: "MOD",
      color: "#5aa9ff",
      icon: "fa-shield-halved",
      tagline:
        "The rank that makes things stick. Full mods hold the tools that reach past a single room.",
      can: [
        "Everything a junior can.",
        "Block a person from the whole site: an hour, a day, a week, or permanently.",
        "Block someone who broke the rules and left before staff arrived.",
        "Close a room that has gone bad, and check on public rooms when reports come in.",
        "Read and answer ban appeals, and clear false reports out of the queue.",
        "Stop a misbehaving bot, and take down a community theme.",
      ],
      handsUp: [
        "Lifting a permanent block - a full mod can place one, but only an admin can undo it.",
        "Blocking whole networks at once.",
        "Who joins the team and who gets promoted - that is the mod leader's job.",
      ],
      notes: [
        "They are told to use the shortest block that works, and let it expire, rather than reaching for the big one out of habit.",
      ],
    },
    lead: {
      name: "Mod leader",
      badge: "LEADER",
      color: "#77dd77",
      icon: "fa-user-tie",
      tagline:
        "Runs the mod team itself. Everything a full mod has, plus the people.",
      can: [
        "Everything a full mod can.",
        "Opens and closes mod applications, reads them, and approves new juniors.",
        "Promotes juniors to full mods - and demotes - based on their record.",
        "Reads any junior or full mod's complete action history, and the automatic flags raised on it.",
        "Removes a mod's key, with a written reason the person sees.",
      ],
      handsUp: [
        "Leader keys themselves, and anything about admins, are admin decisions.",
        "Lifting permanent blocks and the site-wide tools stay with admins.",
      ],
      notes: [
        "Every staff action is logged permanently, and leaders and admins are the ones who read those records. Reporting a moderator works exactly like reporting anyone else.",
      ],
    },
    admin: {
      name: "Admin",
      badge: "ADMIN",
      color: "#ff5468",
      icon: "fa-screwdriver-wrench",
      tagline:
        "The people who run the site. In a room they glow red and carry a crown.",
      can: [
        "Everything a mod leader can, on anyone except another admin.",
        "Lifts permanent blocks, and decides the appeals that need one lifted.",
        "Grants every kind of staff key, including mod leaders.",
        "Site-wide things: announcements, the rules, features, maintenance.",
      ],
      handsUp: [],
      notes: [
        "Even admins never see a raw IP address. Nobody on the site does.",
        "Admins answer for their actions like everyone else - every action they take is in the same permanent log.",
      ],
    },
  };

  var ORDER = ["jr", "full", "lead", "admin"];

  function styles() {
    if (document.getElementById("tkStaffGuideStyles")) return;
    var s = document.createElement("style");
    s.id = "tkStaffGuideStyles";
    s.textContent = [
      ".tksg-tabs{display:flex;gap:8px;padding:12px 24px 0;flex-shrink:0;flex-wrap:wrap;}",
      ".tksg-tab{background:var(--tk-tile);color:var(--tk-muted);border:1px solid transparent;",
      "border-radius:5px;padding:9px 14px;font-size:13px;font-weight:bold;font-family:inherit;",
      "cursor:pointer;transition:background-color .15s ease,color .15s ease;}",
      ".tksg-tab:hover{background:var(--tk-tile-hover);color:var(--tk-text);}",
      ".tksg-tab.active{background:var(--tk-card);}",
      ".tksg-intro{margin:14px 24px 0;padding:12px 14px;border-radius:6px;background:var(--tk-tile);",
      "color:var(--tk-muted);font-size:13px;line-height:1.6;flex-shrink:0;}",
      ".tksg-intro b{color:var(--tk-text);}",
      ".tksg-badge{display:inline-block;font-size:9px;font-weight:bold;padding:1px 6px;",
      "border-radius:8px;letter-spacing:.5px;vertical-align:middle;color:#0d1117;}",
      ".tksg-head-card{background:var(--room-background-color,#000);border:1px solid var(--tk-border);",
      "border-radius:6px;padding:14px 16px;margin:14px 0 10px;}",
      ".tksg-rank-name{font-size:17px;font-weight:bold;display:flex;align-items:center;gap:10px;}",
      ".tksg-tagline{margin:7px 0 0;color:var(--tk-muted);font-size:13.5px;line-height:1.6;}",
      ".tksg-card{background:var(--room-background-color,#000);border:1px solid var(--tk-border);",
      "border-radius:6px;padding:13px 16px;margin-bottom:10px;}",
      ".tksg-sec{font-size:11px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;",
      "margin-bottom:8px;display:flex;align-items:center;gap:7px;}",
      ".tksg-card ul{margin:0;padding-left:19px;color:var(--tk-muted);font-size:13.5px;line-height:1.65;}",
      ".tksg-card li{margin-bottom:5px;}",
      ".tksg-card li:last-child{margin-bottom:0;}",
      ".tksg-gate{flex-shrink:0;display:flex;align-items:center;gap:14px;flex-wrap:wrap;",
      "padding:13px 24px;border-top:1px solid var(--tk-border);background:var(--tk-tile);}",
      ".tksg-gate-msg{flex:1;min-width:200px;color:var(--tk-text);font-size:13px;line-height:1.55;}",
      ".tksg-gate-btn{background:var(--tk-accent);color:#1a1a1a;border:none;border-radius:5px;",
      "padding:10px 20px;font-size:14px;font-weight:bold;font-family:inherit;cursor:pointer;}",
      ".tksg-gate-btn:disabled{background:var(--tk-tile-hover);color:var(--tk-muted);cursor:default;}",
    ].join("");
    document.head.appendChild(s);
  }

  function badgeEl(rank) {
    var b = el("span", "tksg-badge", rank.badge);
    b.style.background = rank.color;
    return b;
  }

  function build() {
    if (built) return;
    built = true;
    styles();

    overlay = el("div", "sb-overlay");
    overlay.id = "tkStaffGuideOverlay";
    var modal = el("div", "sb-modal");
    modalEl = modal;

    var head = el("div", "sb-head");
    var titleWrap = el("div", "sb-title-wrap");
    var title = el("div", "sb-title");
    title.innerHTML = '<i class="fas fa-user-shield"></i> Who\'s who on staff';
    var sub = el(
      "div",
      "sb-sub",
      "What each badge means, what that person can do for you, and who handles what.",
    );
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    var headBtns = el("div", "sb-head-btns");
    var closeBtn = el("button", "sb-icon-btn sb-close", "×");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    headBtns.appendChild(closeBtn);
    closeBtnEl = closeBtn;
    head.appendChild(titleWrap);
    head.appendChild(headBtns);

    var intro = el("div", "tksg-intro");
    intro.appendChild(
      document.createTextNode(
        "Staff carry a badge the site draws next to their name: ",
      ),
    );
    ORDER.forEach(function (key, i) {
      intro.appendChild(badgeEl(RANKS[key]));
      intro.appendChild(
        document.createTextNode(i < ORDER.length - 1 ? "  " : ""),
      );
    });
    var intro2 = el("span");
    intro2.innerHTML =
      ". Their box in a room glows the same color. The badge <b>cannot be typed or faked</b>: a name that merely claims to be staff is not staff. Anything a rank cannot handle, it hands to the rank above, so being told \"I'll get a full mod\" is the ladder working.";
    intro.appendChild(intro2);

    var tabs = el("div", "tksg-tabs");
    ORDER.forEach(function (key) {
      var r = RANKS[key];
      var b = el("button", "tksg-tab", r.name);
      b.type = "button";
      b.addEventListener("click", function () {
        switchTo(key);
      });
      tabBtns[key] = b;
      tabs.appendChild(b);
    });

    listEl = el("div", "sb-list");

    modal.appendChild(head);
    modal.appendChild(intro);
    modal.appendChild(tabs);
    modal.appendChild(listEl);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
  }

  function paintTabs() {
    ORDER.forEach(function (key) {
      var b = tabBtns[key];
      var on = key === tab;
      b.classList.toggle("active", on);
      b.style.color = on ? RANKS[key].color : "";
      b.style.borderColor = on ? RANKS[key].color : "transparent";
    });
  }

  function section(rank, iconName, label, items) {
    if (!items || !items.length) return null;
    var card = el("div", "tksg-card");
    var h = el("div", "tksg-sec");
    h.style.color = rank.color;
    h.innerHTML = '<i class="fas ' + iconName + '"></i> ' + label;
    card.appendChild(h);
    var ul = el("ul");
    items.forEach(function (t) {
      ul.appendChild(el("li", null, t));
    });
    card.appendChild(ul);
    return card;
  }

  function render() {
    if (!listEl) return;
    paintTabs();
    listEl.textContent = "";
    var r = RANKS[tab];

    var headCard = el("div", "tksg-head-card");
    var nm = el("div", "tksg-rank-name");
    nm.style.color = r.color;
    nm.innerHTML = '<i class="fas ' + r.icon + '"></i> ' + r.name + " ";
    nm.appendChild(badgeEl(r));
    headCard.appendChild(nm);
    headCard.appendChild(el("p", "tksg-tagline", r.tagline));
    listEl.appendChild(headCard);

    var can = section(r, "fa-check", "What they can do", r.can);
    if (can) listEl.appendChild(can);
    var up = section(
      r,
      "fa-arrow-up",
      "What they hand up the ladder",
      r.handsUp,
    );
    if (up) listEl.appendChild(up);
    var notes = section(r, "fa-circle-info", "Good to know", r.notes);
    if (notes) listEl.appendChild(notes);
  }

  function switchTo(which) {
    if (tab === which) return;
    tab = which;
    render();
  }

  // First-visit gate: the modal cannot be dismissed until the button at the
  // bottom is pressed, and the button unlocks after a short pause so the
  // page gets read rather than clicked away.
  function setGateFooter() {
    if (footerEl) {
      footerEl.remove();
      footerEl = null;
    }
    if (!gateCb) return;
    footerEl = el("div", "tksg-gate");
    footerEl.appendChild(
      el(
        "div",
        "tksg-gate-msg",
        "One more thing: this is who runs Talkomatic. Knowing what each badge means makes it easier to get help when you need it.",
      ),
    );
    var btn = el("button", "tksg-gate-btn");
    btn.type = "button";
    btn.disabled = true;
    var left = 5;
    var paint = function () {
      btn.textContent = left > 0 ? "I understand (" + left + ")" : "I understand";
    };
    paint();
    var t = setInterval(function () {
      left--;
      paint();
      if (left <= 0) {
        clearInterval(t);
        btn.disabled = false;
      }
    }, 1000);
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      var cb = gateCb;
      gateCb = null;
      setGateFooter();
      if (closeBtnEl) closeBtnEl.style.display = "";
      close();
      if (cb) cb();
    });
    footerEl.appendChild(btn);
    modalEl.appendChild(footerEl);
  }

  function open(opts) {
    build();
    gateCb = opts && opts.gate ? opts.onDone || function () {} : null;
    if (closeBtnEl) closeBtnEl.style.display = gateCb ? "none" : "";
    setGateFooter();
    overlay.classList.add("show");
    document.addEventListener("keydown", esc);
    render();
  }

  function close() {
    if (!overlay || gateCb) return;
    overlay.classList.remove("show");
    document.removeEventListener("keydown", esc);
  }

  function esc(e) {
    if (e.key === "Escape") close();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var link = document.getElementById("staffGuideLink");
    if (link)
      link.addEventListener("click", function (e) {
        e.preventDefault();
        open();
      });
  });

  window.StaffGuide = { open: open, close: close };
})();
