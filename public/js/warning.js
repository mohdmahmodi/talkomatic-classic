(function boot() {
  "use strict";

  if (typeof socket === "undefined") {
    window.addEventListener("talkomatic:socket", boot, { once: true });
    return;
  }

  var queue = [];
  var overlay = null;
  var current = null;
  var shown = null;
  var msgEl = null,
    ruleWrap,
    ruleTitleEl,
    ruleBodyEl,
    insteadWrap,
    insteadEl,
    msgWrap,
    msgLabelEl;
  var timeEl = null;
  var agreeEl = null;
  var okEl = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function whenText(at) {
    if (!at) return "";
    var mins = Math.round((Date.now() - at) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }

  function build() {
    overlay = el("div", "tkm-overlay tkw-overlay");
    var modal = el("div", "tkm-modal");
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Warning from the Talkomatic team");

    var head = el("div", "tkm-head");
    var headText = el("div", "tkm-head-text");
    var title = el("div", "tkm-title");
    title.innerHTML =
      '<i class="fas fa-triangle-exclamation"></i> You have been warned';
    headText.appendChild(title);
    headText.appendChild(
      el(
        "div",
        "tkm-sub",
        "A moderator on the Talkomatic team sent you this. Read it, then tick the box to carry on.",
      ),
    );
    head.appendChild(headText);
    modal.appendChild(head);

    var body = el("div", "tkm-body");
    ruleWrap = el("div", "tkw-part");
    ruleWrap.appendChild(el("div", "tkw-label", "The rule"));
    ruleTitleEl = el("div", "tkw-rule-title");
    ruleBodyEl = el("div", "tkw-message");
    ruleWrap.appendChild(ruleTitleEl);
    ruleWrap.appendChild(ruleBodyEl);
    body.appendChild(ruleWrap);
    insteadWrap = el("div", "tkw-part");
    insteadWrap.appendChild(el("div", "tkw-label", "What to do instead"));
    insteadEl = el("div", "tkw-message");
    insteadWrap.appendChild(insteadEl);
    body.appendChild(insteadWrap);
    msgWrap = el("div", "tkw-part");
    msgLabelEl = el("div", "tkw-label", "What the moderator said");
    msgWrap.appendChild(msgLabelEl);
    msgEl = el("div", "tkw-message");
    msgWrap.appendChild(msgEl);
    body.appendChild(msgWrap);
    timeEl = el("div", "tkw-when");
    body.appendChild(timeEl);
    body.appendChild(
      el(
        "div",
        "tkw-next",
        "Warnings stay on your record. Carrying on after one usually ends in a kick or a ban, so take a moment before you go back.",
      ),
    );
    modal.appendChild(body);

    var gate = el("div", "tkm-gate");
    var agree = el("label", "tkw-agree");
    agreeEl = document.createElement("input");
    agreeEl.type = "checkbox";
    agree.appendChild(agreeEl);
    agree.appendChild(
      el(
        "span",
        null,
        "I have read this and I will not do it again.",
      ),
    );
    gate.appendChild(agree);

    okEl = el("button", "tkm-gate-btn", "Back to Talkomatic");
    okEl.type = "button";
    okEl.disabled = true;
    agreeEl.addEventListener("change", function () {
      okEl.disabled = !agreeEl.checked;
    });
    okEl.addEventListener("click", accept);
    gate.appendChild(okEl);
    modal.appendChild(gate);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function render() {
    var rule = current.rule;
    ruleWrap.style.display = rule ? "" : "none";
    if (rule) {
      ruleTitleEl.textContent = "Rule " + rule.n + ": " + rule.title;
      ruleBodyEl.textContent = rule.body || "";
      ruleBodyEl.style.display = rule.body ? "" : "none";
    }
    insteadWrap.style.display = current.instead ? "" : "none";
    insteadEl.textContent = current.instead || "";
    var structured = !!(rule || current.instead);
    var note = structured ? current.note : current.message;
    msgWrap.style.display = note ? "" : "none";
    msgLabelEl.textContent = structured ? "From the moderator" : "What the moderator said";
    msgEl.textContent = note || "";
    timeEl.textContent = whenText(current.at);
    timeEl.style.display = current.at ? "" : "none";
    agreeEl.checked = false;
    okEl.disabled = true;
  }

  function open() {
    if (!current) {
      if (!queue.length) return;
      current = queue.shift();
    }
    var rebuilt = !overlay || !document.body.contains(overlay);
    if (rebuilt) {
      overlay = null;
      build();
    }
    var fresh = rebuilt || shown !== current;
    if (fresh) {
      render();
      shown = current;
    }
    overlay.classList.add("show");
    document.body.classList.add("tkm-lock");
    if (fresh)
      setTimeout(function () {
        agreeEl.focus();
      }, 60);
  }

  function accept() {
    if (!current || !agreeEl.checked) return;
    socket.emit("warning ack", { id: current.id });
    current = null;
    shown = null;
    if (queue.length) return open();
    overlay.classList.remove("show");
    document.body.classList.remove("tkm-lock");
  }

  socket.on("staff warning", function (data) {
    var message = (data && data.message) || "Please follow the room rules.";
    if (!data || !data.id) {
      if (window.toastr) toastr.warning(message, "Staff warning");
      return;
    }
    if (current && current.id === data.id) return open();
    if (!queue.some(function (w) { return w.id === data.id; }))
      queue.push({
        id: data.id,
        message: message,
        rule: data.rule && data.rule.title ? data.rule : null,
        instead: data.instead || "",
        note: data.note || "",
        at: data.at || 0,
      });
    open();
  });
})();
