(function () {
  "use strict";

  if (typeof socket === "undefined") return;

  var overlay,
    listEl,
    built = false,
    loaded = false;
  var tab = "community";
  var data = { community: [], mod: [] };
  var tabBtns = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function styles() {
    if (document.getElementById("tkRulesStyles")) return;
    var s = document.createElement("style");
    s.id = "tkRulesStyles";
    s.textContent = [
      ".tkr-tabs{display:flex;gap:8px;padding:12px 24px 0;flex-shrink:0;flex-wrap:wrap;}",
      ".tkr-tab{background:var(--tk-tile);color:var(--tk-muted);border:1px solid transparent;",
      "border-radius:5px;padding:9px 16px;font-size:13px;font-weight:bold;font-family:inherit;",
      "cursor:pointer;transition:background-color .15s ease,color .15s ease;}",
      ".tkr-tab:hover{background:var(--tk-tile-hover);color:var(--tk-text);}",
      ".tkr-tab.active{background:var(--tk-card);color:var(--primary,var(--tk-accent));",
      "border-color:var(--primary,var(--tk-accent));}",
      ".tkr-intro{margin:14px 24px 0;padding:12px 14px;border-radius:6px;background:var(--tk-tile);",
      "var(--tk-accent));color:var(--tk-muted);font-size:13px;line-height:1.55;}",
      ".tkr-rule{background:var(--room-background-color,#000);border:1px solid var(--tk-border);",
      "border-radius:6px;padding:14px 16px;margin-bottom:10px;}",
      ".tkr-rule-top{display:flex;align-items:baseline;gap:10px;}",
      ".tkr-num{flex:none;color:var(--primary,var(--tk-accent));font-weight:bold;font-size:13px;min-width:22px;}",
      ".tkr-title{color:var(--tk-text);font-weight:bold;font-size:15px;line-height:1.35;}",
      ".tkr-body{margin:7px 0 0 32px;color:var(--tk-muted);font-size:13.5px;line-height:1.6;}",
      ".tkr-why{margin:9px 0 0 32px;padding-left:11px;border-left:2px solid var(--tk-border);",
      "color:var(--tk-dim,#9aa3ae);font-size:12.5px;line-height:1.55;font-style:italic;}",
      ".tkr-lvl{flex:none;margin-left:auto;font-size:10px;font-weight:bold;letter-spacing:.5px;",
      "text-transform:uppercase;padding:2px 7px;border-radius:9px;white-space:nowrap;}",
      ".tkr-lvl-jr{background:rgba(171,71,188,.18);color:#ce93d8;}",
      ".tkr-lvl-full{background:rgba(0,188,212,.16);color:#4dd0e1;}",
      ".tkr-lvl-leader{background:rgba(0,255,65,.14);color:#00ff41;}",
      ".tkr-empty{color:var(--tk-muted);text-align:center;padding:40px 0;font-size:14px;}",
      "@media (max-width:640px){.tkr-body,.tkr-why{margin-left:0;}}",
    ].join("");
    document.head.appendChild(s);
  }

  function build() {
    if (built) return;
    built = true;
    styles();

    overlay = el("div", "sb-overlay");
    overlay.id = "tkRulesOverlay";
    var modal = el("div", "sb-modal");

    var head = el("div", "sb-head");
    var titleWrap = el("div", "sb-title-wrap");
    var title = el("div", "sb-title");
    title.innerHTML = '<i class="fas fa-scale-balanced"></i> Talkomatic Rules';
    var sub = el(
      "div",
      "sb-sub",
      "How this place works, and what moderators may and may not do.",
    );
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    var headBtns = el("div", "sb-head-btns");
    var closeBtn = el("button", "sb-icon-btn sb-close", "×");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    headBtns.appendChild(closeBtn);

    head.appendChild(titleWrap);
    head.appendChild(headBtns);

    var tabs = el("div", "tkr-tabs");
    tabBtns.community = el("button", "tkr-tab active", "Community Rules");
    tabBtns.community.type = "button";
    tabBtns.community.addEventListener("click", function () {
      switchTo("community");
    });
    tabBtns.mod = el("button", "tkr-tab", "Moderator Rules");
    tabBtns.mod.type = "button";
    tabBtns.mod.addEventListener("click", function () {
      switchTo("mod");
    });
    tabs.appendChild(tabBtns.community);
    tabs.appendChild(tabBtns.mod);

    listEl = el("div", "sb-list");

    modal.appendChild(head);
    modal.appendChild(tabs);
    modal.appendChild(listEl);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
  }

  function switchTo(which) {
    if (tab === which) return;
    tab = which;
    tabBtns.community.classList.toggle("active", which === "community");
    tabBtns.mod.classList.toggle("active", which === "mod");
    render();
  }

  var INTRO = {
    community:
      "Talkomatic is open to anyone, with no account and no sign-up. That only works while people can share a room with strangers they disagree with. These are the lines that keep it usable.",
    mod: "These are published so anyone can read what a moderator is supposed to do, and hold them to it. If a moderator acts outside them, report it or open an appeal.",
  };

  function render() {
    if (!listEl) return;
    listEl.textContent = "";

    var intro = el("div", "tkr-intro", INTRO[tab]);
    listEl.appendChild(intro);

    var list = data[tab] || [];
    if (!loaded) {
      listEl.appendChild(el("div", "tkr-empty", "Loading rules..."));
      return;
    }
    if (!list.length) {
      listEl.appendChild(
        el("div", "tkr-empty", "No rules have been written yet."),
      );
      return;
    }

    var wrap = el("div");
    wrap.style.marginTop = "14px";
    list.forEach(function (r, i) {
      var card = el("div", "tkr-rule");

      var top = el("div", "tkr-rule-top");
      top.appendChild(el("span", "tkr-num", String(i + 1) + "."));
      top.appendChild(el("span", "tkr-title", r.title || ""));
      if (
        tab === "mod" &&
        (r.level === "jr" || r.level === "full" || r.level === "leader")
      ) {
        top.appendChild(
          el(
            "span",
            "tkr-lvl tkr-lvl-" + r.level,
            r.level === "jr"
              ? "Jr mod"
              : r.level === "full"
                ? "Full mod"
                : "Mod leader",
          ),
        );
      }
      card.appendChild(top);

      if (r.body) card.appendChild(el("p", "tkr-body", r.body));
      if (r.why) card.appendChild(el("p", "tkr-why", "Why: " + r.why));
      wrap.appendChild(card);
    });
    listEl.appendChild(wrap);
  }

  function open() {
    build();
    overlay.classList.add("show");
    document.addEventListener("keydown", esc);
    render();
    if (socket.connected) socket.emit("rules get");
    else
      socket.once("connect", function () {
        socket.emit("rules get");
      });
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("show");
    document.removeEventListener("keydown", esc);
  }

  function esc(e) {
    if (e.key === "Escape") close();
  }

  socket.on("rules data", function (d) {
    if (!d) return;
    data.community = Array.isArray(d.community) ? d.community : [];
    data.mod = Array.isArray(d.mod) ? d.mod : [];
    loaded = true;
    if (overlay && overlay.classList.contains("show")) render();
  });

  document.addEventListener("DOMContentLoaded", function () {
    var link = document.getElementById("rulesLink");
    if (link)
      link.addEventListener("click", function (e) {
        e.preventDefault();
        open();
      });
  });

  window.TalkomaticRules = { open: open, close: close };
})();
