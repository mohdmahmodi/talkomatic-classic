(function () {
  "use strict";

  if (typeof socket === "undefined") return;

  var overlay,
    modalEl,
    bodyEl,
    closeBtnEl,
    footerEl = null,
    built = false,
    loaded = false;
  var tab = "community";
  var data = { community: [], mod: [] };
  var tabBtns = {};
  var gateCb = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "tkm-overlay");
    overlay.id = "tkRulesOverlay";
    var modal = el("div", "tkm-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Talkomatic Rules");
    modalEl = modal;

    var head = el("div", "tkm-head");
    var headText = el("div", "tkm-head-text");
    var title = el("div", "tkm-title");
    title.innerHTML = '<i class="fas fa-scale-balanced"></i> Talkomatic Rules';
    var sub = el(
      "div",
      "tkm-sub",
      "How this place works, and what moderators may and may not do.",
    );
    headText.appendChild(title);
    headText.appendChild(sub);

    var closeBtn = el("button", "tkm-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    closeBtnEl = closeBtn;

    head.appendChild(headText);
    head.appendChild(closeBtn);

    var tabs = el("div", "tkm-tabs");
    tabBtns.community = el("button", "tkm-tab active", "Community Rules");
    tabBtns.community.type = "button";
    tabBtns.community.addEventListener("click", function () {
      switchTo("community");
    });
    tabBtns.mod = el("button", "tkm-tab", "Moderator Rules");
    tabBtns.mod.type = "button";
    tabBtns.mod.addEventListener("click", function () {
      switchTo("mod");
    });
    tabs.appendChild(tabBtns.community);
    tabs.appendChild(tabBtns.mod);

    bodyEl = el("div", "tkm-body");

    modal.appendChild(head);
    modal.appendChild(tabs);
    modal.appendChild(bodyEl);
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
    bodyEl.scrollTop = 0;
  }

  var INTRO = {
    community:
      "Talkomatic is open to anyone, with no account and no sign-up. That only works while people can share a room with strangers they disagree with. These are the lines that keep it usable.",
    mod: "These are published so anyone can read what a moderator is supposed to do, and hold them to it. If a moderator acts outside them, report it or open an appeal.",
  };

  function render() {
    if (!bodyEl) return;
    bodyEl.textContent = "";

    bodyEl.appendChild(el("div", "tkr-intro", INTRO[tab]));

    var list = data[tab] || [];
    if (!loaded) {
      bodyEl.appendChild(el("div", "tkm-empty", "Loading rules..."));
      return;
    }
    if (!list.length) {
      bodyEl.appendChild(
        el("div", "tkm-empty", "No rules have been written yet."),
      );
      return;
    }

    var wrap = el("div", "tkr-rules");
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
    bodyEl.appendChild(wrap);
  }

  // First-visit gate: the modal cannot be dismissed until the button at the
  // bottom is pressed, and the button unlocks after a short pause so the
  // rules get read rather than clicked away.
  function setGateFooter() {
    if (footerEl) {
      footerEl.remove();
      footerEl = null;
    }
    if (!gateCb) return;
    footerEl = el("div", "tkm-gate");
    footerEl.appendChild(
      el(
        "div",
        "tkm-gate-msg",
        "Welcome to Talkomatic. Before you start chatting, please take a minute to read the rules. They apply to everyone here.",
      ),
    );
    var btn = el("button", "tkm-gate-btn");
    btn.type = "button";
    btn.disabled = true;
    var left = 5;
    var paint = function () {
      btn.textContent =
        left > 0 ? "I have read the rules (" + left + ")" : "I have read the rules";
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
    document.body.classList.add("tkm-lock");
    document.addEventListener("keydown", esc);
    render();
    if (socket.connected) socket.emit("rules get");
    else
      socket.once("connect", function () {
        socket.emit("rules get");
      });
  }

  function close() {
    if (!overlay || gateCb) return;
    overlay.classList.remove("show");
    document.body.classList.remove("tkm-lock");
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
