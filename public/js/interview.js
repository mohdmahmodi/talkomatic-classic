(function () {
  "use strict";
  if (window.TkInterview) return;
  var sock = typeof socket !== "undefined" ? socket : window.socket;
  if (!sock) return;

  var data = null;
  var isOpen = false;
  var built = false;
  var overlay, modal, subEl, stripEl, appBox, logEl, typingEl, footEl, errEl;
  var input = null;
  var sendBtn = null;
  var countEl = null;
  var footSig = null;
  var logSig = null;
  var appSig = null;
  var lastSent = null;
  var appOpen = false;
  var draft = "";
  var typingUntil = 0;
  var typingName = "";
  var typingTimer = null;
  var errTimer = null;
  var lastTypeSent = 0;
  var lastMsgToast = 0;
  var pill = null;
  var pillBadge = null;
  var picker = null;
  var MAX = 600;
  var REACTIONS = ["👍", "❤️", "😂", "🎉", "🤔", "👀", "✅", "🙏"];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function icon(fa) {
    var i = document.createElement("i");
    i.className = "fas " + fa;
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  function toast(message, opts) {
    if (window.StaffUI) return StaffUI.toast(message, opts || {});
    return null;
  }

  function clock(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function dayKey(ts) {
    var d = new Date(ts || 0);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }

  function dayLabel(ts) {
    var now = Date.now();
    if (dayKey(ts) === dayKey(now)) return "Today";
    if (dayKey(ts) === dayKey(now - 86400000)) return "Yesterday";
    try {
      return new Date(ts).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    } catch (_) {
      return new Date(ts).toDateString();
    }
  }

  function draftKey() {
    return "talkomatic_interviewDraft";
  }

  function saveDraft() {
    try {
      if (draft && data) sessionStorage.setItem(draftKey(), JSON.stringify({ appId: data.appId, text: draft }));
      else sessionStorage.removeItem(draftKey());
    } catch (_) {}
  }

  function loadDraft() {
    try {
      var d = JSON.parse(sessionStorage.getItem(draftKey()) || "null");
      if (d && data && d.appId === data.appId && typeof d.text === "string") draft = d.text;
    } catch (_) {}
  }

  function visible() {
    return document.visibilityState !== "hidden";
  }

  function unreadCount() {
    if (!data) return 0;
    var n = 0;
    for (var i = data.messages.length - 1; i >= 0; i--) {
      var m = data.messages[i];
      if (m.ts <= (data.seen || 0)) break;
      if (m.from === "staff") n++;
    }
    return n;
  }

  function lastStaff(list) {
    for (var i = list.length - 1; i >= 0; i--) if (list[i].from === "staff") return list[i];
    return null;
  }

  function canWrite() {
    return !!data && data.status === "open";
  }

  function markSeen() {
    if (!data || !isOpen || !visible()) return;
    var ls = lastStaff(data.messages);
    if (!ls || ls.ts <= (data.seen || 0)) return;
    data.seen = ls.ts;
    sock.emit("interview seen");
    updatePill();
  }

  function buildPill() {
    if (pill || !document.body) return;
    pill = el("button", "iv-pill" + (document.getElementById("toggleInvite") ? " in-room" : ""));
    pill.type = "button";
    pill.setAttribute("aria-label", "Open your mod interview");
    pill.appendChild(icon("fa-comments"));
    pill.appendChild(el("span", "iv-pill-t", "Mod interview"));
    pillBadge = el("span", "iv-pill-b");
    pill.appendChild(pillBadge);
    pill.addEventListener("click", open);
    document.body.appendChild(pill);
  }

  function updatePill() {
    var n = unreadCount();
    var show = !!data && !isOpen && (data.status === "open" || n > 0);
    if (!show) {
      if (pill) pill.classList.remove("show");
      return;
    }
    buildPill();
    if (!pill) return;
    pill.classList.add("show");
    pillBadge.textContent = n > 9 ? "9+" : String(n);
    pillBadge.style.display = n ? "" : "none";
    pill.classList.toggle("unread", n > 0);
    pill.title = n
      ? n === 1
        ? "1 new message from staff"
        : n + " new messages from staff"
      : "Your interview is open";
  }

  function build() {
    if (built) return;
    built = true;
    overlay = el("div", "iv-overlay");
    modal = el("div", "iv-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Mod interview");

    var head = el("div", "iv-head");
    var tw = el("div", "iv-title-wrap");
    var title = el("div", "iv-title");
    title.appendChild(icon("fa-user-shield"));
    title.appendChild(document.createTextNode("Mod interview"));
    tw.appendChild(title);
    subEl = el("div", "iv-sub", "");
    tw.appendChild(subEl);
    head.appendChild(tw);
    var x = el("button", "iv-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    head.appendChild(x);
    modal.appendChild(head);

    stripEl = el("div", "iv-strip", "");
    modal.appendChild(stripEl);

    appBox = el("div", "iv-app");
    modal.appendChild(appBox);

    logEl = el("div", "iv-log");
    logEl.setAttribute("aria-live", "polite");
    modal.appendChild(logEl);

    typingEl = el("div", "iv-typing", "");
    modal.appendChild(typingEl);

    errEl = el("div", "iv-err", "");
    modal.appendChild(errEl);

    footEl = el("div", "iv-foot");
    modal.appendChild(footEl);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !isOpen) return;
      if (picker) return closePicker();
      if (document.querySelector(".tk-backdrop")) return;
      close();
    });
    document.addEventListener("click", function (e) {
      if (picker && !picker.contains(e.target)) closePicker();
    });
  }

  function paintHead() {
    var sent = "";
    try {
      sent = new Date(data.startedAt).toLocaleDateString(undefined, { day: "numeric", month: "long" });
    } catch (_) {}
    subEl.textContent = "With the Talkomatic staff" + (sent ? " · started " + sent : "");
    var text;
    var cls = "iv-strip";
    if (data.decision === "approved") {
      text = data.offer ? "Application approved. Open the lobby to accept the role." : "Application approved";
      cls += " ok";
    } else if (data.decision === "rejected") {
      text = "Application declined";
      cls += " no";
    } else if (data.decision === "withdrawn") {
      text = "You turned down the role";
    } else if (data.status === "open") {
      text = "Interview in progress";
      cls += " live";
    } else {
      text = "Interview ended. Your application is still being reviewed.";
    }
    stripEl.className = cls;
    stripEl.textContent = text;
  }

  function paintApp() {
    var sig = JSON.stringify([data.appId, appOpen, data.answers]);
    if (sig === appSig) return;
    appSig = sig;
    appBox.textContent = "";
    var tog = el("button", "iv-app-h");
    tog.type = "button";
    tog.setAttribute("aria-expanded", appOpen ? "true" : "false");
    tog.appendChild(icon("fa-file-signature"));
    tog.appendChild(el("span", "iv-app-t", "Your application"));
    tog.appendChild(icon(appOpen ? "fa-chevron-up" : "fa-chevron-down"));
    tog.addEventListener("click", function () {
      appOpen = !appOpen;
      paintApp();
    });
    appBox.appendChild(tog);
    if (!appOpen) return;
    var a = data.answers || {};
    var body = el("div", "iv-app-b");
    var row = function (label, text) {
      var r = el("div", "iv-app-r");
      r.appendChild(el("div", "iv-app-l", label));
      r.appendChild(el("div", "iv-app-v" + (text ? "" : " none"), text || "Not given"));
      body.appendChild(r);
    };
    row("Why you want to moderate", a.why);
    row("Moderated before", a.experience);
    row("Usually online", a.availability);
    appBox.appendChild(body);
  }

  function reactionRow(m) {
    var list = m.reactions || [];
    var mayReact = canWrite() && m.from === "staff";
    if (!list.length) return null;
    var wrap = el("div", "iv-rx");
    list.forEach(function (r) {
      var c = el("button", "iv-rx-c" + (r.me ? " mine" : ""));
      c.type = "button";
      c.appendChild(el("span", "iv-rx-e", r.e));
      c.appendChild(el("span", "iv-rx-n", String(r.n)));
      if (mayReact)
        c.addEventListener("click", function (e) {
          e.stopPropagation();
          sock.emit("interview react", { id: m.id, e: r.e });
        });
      else c.disabled = true;
      wrap.appendChild(c);
    });
    return wrap;
  }

  function closePicker() {
    if (picker) picker.remove();
    picker = null;
  }

  function openPicker(anchor, m) {
    closePicker();
    picker = el("div", "iv-pick");
    REACTIONS.forEach(function (e) {
      var b = el("button", "iv-pick-b", e);
      b.type = "button";
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        sock.emit("interview react", { id: m.id, e: e });
        closePicker();
      });
      picker.appendChild(b);
    });
    modal.appendChild(picker);
    var mr = modal.getBoundingClientRect();
    var ar = anchor.getBoundingClientRect();
    var left = ar.left - mr.left;
    var top = ar.bottom - mr.top + 6;
    if (left + picker.offsetWidth > mr.width - 8) left = mr.width - picker.offsetWidth - 8;
    if (left < 8) left = 8;
    if (top + picker.offsetHeight > mr.height - 8) top = ar.top - mr.top - picker.offsetHeight - 6;
    picker.style.left = Math.round(left) + "px";
    picker.style.top = Math.round(top) + "px";
  }

  function paintLog(fresh) {
    var sig = JSON.stringify([
      data.appId,
      data.status,
      data.decision,
      data.staffSeen,
      canWrite(),
      (data.messages || []).map(function (m) {
        return [m.id, m.text, m.by, m.chip, (m.reactions || []).map(function (r) { return [r.e, r.n, r.me]; })];
      }),
      dayKey(Date.now()),
    ]);
    if (!fresh && sig === logSig) return;
    logSig = sig;
    var atBottom = fresh || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
    var prevTop = logEl.scrollTop;
    logEl.textContent = "";

    var intro = el("div", "iv-intro");
    intro.appendChild(icon("fa-circle-info"));
    intro.appendChild(
      el(
        "div",
        null,
        "Staff ask their questions here, and only staff can read your replies. You can close this window. The chat stays open, and you get a notice when staff write.",
      ),
    );
    logEl.appendChild(intro);

    var msgs = data.messages || [];
    var myLast = -1;
    for (var i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].from === "me") {
        myLast = i;
        break;
      }
    var lastKey = null;
    var lastTs = 0;
    var lastDay = null;
    msgs.forEach(function (m, idx) {
      var day = dayKey(m.ts);
      if (day !== lastDay) {
        logEl.appendChild(el("div", "iv-day", dayLabel(m.ts)));
        lastDay = day;
        lastKey = null;
      }
      if (m.from === "system") {
        var s = el("div", "iv-sys", m.text + " · " + clock(m.ts));
        logEl.appendChild(s);
        lastKey = null;
        return;
      }
      var mine = m.from === "me";
      var key = mine ? "me" : "s:" + m.by;
      var grouped = key === lastKey && m.ts - lastTs < 5 * 60 * 1000;
      lastKey = key;
      lastTs = m.ts;
      var row = el("div", "iv-m " + (mine ? "me" : "staff") + (grouped ? " grouped" : ""));
      if (!mine) {
        var gut = el("div", "iv-gut");
        if (!grouped) {
          var face = el("span", "iv-face");
          face.appendChild(icon("fa-user-shield"));
          gut.appendChild(face);
        }
        row.appendChild(gut);
      }
      var stack = el("div", "iv-stack");
      if (!grouped) {
        var who = el("div", "iv-who");
        if (!mine) {
          who.appendChild(el("span", "iv-name", m.by || "Talkomatic staff"));
          who.appendChild(el("span", "iv-chip" + (m.chip === "ADMIN" ? " admin" : ""), m.chip || "STAFF"));
        } else {
          who.appendChild(el("span", "iv-name me", "You"));
        }
        who.appendChild(el("span", "iv-time", clock(m.ts)));
        stack.appendChild(who);
      }
      var bw = el("div", "iv-bw");
      bw.appendChild(el("div", "iv-bub", m.text));
      if (canWrite() && !mine) {
        var add = el("button", "iv-add");
        add.type = "button";
        add.title = "React";
        add.setAttribute("aria-label", "React");
        add.appendChild(icon("fa-face-smile"));
        add.addEventListener("click", function (e) {
          e.stopPropagation();
          openPicker(add, m);
        });
        bw.appendChild(add);
      }
      stack.appendChild(bw);
      var rx = reactionRow(m);
      if (rx) stack.appendChild(rx);
      if (idx === myLast && data.staffSeen >= m.ts) stack.appendChild(el("div", "iv-seen", "Seen"));
      row.appendChild(stack);
      logEl.appendChild(row);
    });

    if (atBottom)
      requestAnimationFrame(function () {
        logEl.scrollTop = logEl.scrollHeight;
      });
    else logEl.scrollTop = prevTop;
  }

  function paintTyping() {
    var on = typingUntil > Date.now() && canWrite();
    typingEl.textContent = on ? typingName + " is typing" : "";
  }

  function showErr(msg) {
    errEl.textContent = msg || "";
    errEl.classList.toggle("show", !!msg);
    clearTimeout(errTimer);
    if (msg)
      errTimer = setTimeout(function () {
        errEl.textContent = "";
        errEl.classList.remove("show");
      }, 5000);
  }

  function sizeInput() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.max(44, Math.min(input.scrollHeight + 4, 140)) + "px";
    var left = MAX - input.value.length;
    countEl.textContent = left <= 100 ? left + " left" : "";
  }

  function send() {
    if (!input || !canWrite()) return;
    var text = input.value.trim();
    if (!text) return;
    sock.emit("interview send", { text: text });
    lastSent = { appId: data.appId, text: text };
    draft = "";
    saveDraft();
    input.value = "";
    lastTypeSent = 0;
    sizeInput();
    input.focus();
  }

  function paintFoot() {
    var sig = canWrite() ? "w" : "r:" + data.decision + ":" + data.status;
    if (sig === footSig) return;
    footSig = sig;
    footEl.textContent = "";
    input = null;
    sendBtn = null;
    if (!canWrite()) {
      var msg =
        data.decision === "approved"
          ? data.offer
            ? "Your application was approved. Go to the lobby to accept or turn down the role."
            : "This interview is closed."
          : data.decision === "rejected"
            ? "Your application was declined. You can apply again later from the lobby."
            : data.decision === "withdrawn"
              ? "This interview is closed."
              : "Staff ended the interview. You get a popup here when there is a decision.";
      var closed = el("div", "iv-closed");
      closed.appendChild(icon("fa-lock"));
      closed.appendChild(el("span", null, msg));
      footEl.appendChild(closed);
      return;
    }
    var comp = el("div", "iv-comp");
    input = el("textarea", "iv-input");
    input.rows = 1;
    input.maxLength = MAX;
    input.placeholder = "Write your answer";
    input.setAttribute("aria-label", "Write your answer");
    input.value = draft;
    input.addEventListener("input", function () {
      draft = input.value;
      saveDraft();
      sizeInput();
      var now = Date.now();
      if (input.value.trim() && now - lastTypeSent > 1500) {
        lastTypeSent = now;
        sock.emit("interview typing");
      }
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    countEl = el("span", "iv-count", "");
    sendBtn = el("button", "iv-send");
    sendBtn.type = "button";
    sendBtn.appendChild(icon("fa-paper-plane"));
    sendBtn.appendChild(el("span", null, "Send"));
    sendBtn.addEventListener("click", send);
    comp.appendChild(input);
    comp.appendChild(countEl);
    comp.appendChild(sendBtn);
    footEl.appendChild(comp);
    footEl.appendChild(el("div", "iv-hint", "Enter sends. Shift+Enter starts a new line."));
    requestAnimationFrame(sizeInput);
  }

  function paint(fresh) {
    if (!built || !data) return;
    paintHead();
    paintApp();
    paintLog(fresh);
    paintTyping();
    paintFoot();
  }

  function open() {
    if (!data) {
      sock.emit("interview get");
      return;
    }
    build();
    closePicker();
    isOpen = true;
    footSig = null;
    appSig = null;
    overlay.classList.add("show");
    sock.emit("interview window", { open: true });
    paint(true);
    updatePill();
    markSeen();
    if (input && window.matchMedia && window.matchMedia("(hover: hover)").matches)
      setTimeout(function () {
        if (input) input.focus();
      }, 60);
  }

  function close() {
    if (!overlay) return;
    closePicker();
    overlay.classList.remove("show");
    if (isOpen) sock.emit("interview window", { open: false });
    isOpen = false;
    updatePill();
  }

  function notify(notice, prev) {
    var kind = notice && notice.kind;
    if (!kind || !data) return;
    if (kind === "invite") {
      toast("Staff have a few questions about your mod application.", {
        type: "info",
        title: "Mod interview",
        timeout: 20000,
        actions: [{ label: "Open chat", onClick: open }],
      });
      return;
    }
    if (kind === "reopened") {
      if (isOpen && visible()) return;
      toast("Staff reopened your interview. You can reply again.", {
        type: "info",
        title: "Mod interview",
        timeout: 12000,
        actions: [{ label: "Open chat", onClick: open }],
      });
      return;
    }
    if (kind === "ended") {
      if (isOpen) return;
      toast("Staff ended your interview. Your application is still being reviewed.", {
        type: "info",
        title: "Interview ended",
        timeout: 9000,
      });
      return;
    }
    if (kind === "decision") {
      if (window.ModApply) {
        close();
        return;
      }
      if (data.decision === "approved")
        toast("Open the lobby to accept the role.", {
          type: "success",
          title: "Application approved",
          timeout: 0,
          actions: [
            {
              label: "Go to the lobby",
              onClick: function () {
                window.location.href = "/";
              },
            },
          ],
        });
      else if (data.decision === "rejected")
        toast("Your mod application was declined. You can apply again later.", {
          type: "info",
          title: "Application declined",
          timeout: 12000,
        });
      return;
    }
    if (kind === "message") {
      if (isOpen && visible()) return;
      var fresh = lastStaff(data.messages);
      var had = prev && lastStaff(prev.messages || []);
      if (!fresh || (had && had.id === fresh.id)) return;
      var now = Date.now();
      if (now - lastMsgToast < 15000) return;
      lastMsgToast = now;
      var text = String(fresh.text || "");
      toast((fresh.by || "Talkomatic staff") + ": " + (text.length > 140 ? text.slice(0, 139) + "…" : text), {
        type: "info",
        title: "Mod interview",
        timeout: 12000,
        actions: [{ label: "Reply", onClick: open }],
      });
    }
  }

  sock.on("interview", function (d) {
    var prev = data;
    if (lastSent && d && d.has && (d.messages || []).some(function (m) { return m.from === "me" && m.text === lastSent.text; }))
      lastSent = null;
    data = d && d.has ? d : null;
    if (data && Array.isArray(data.reactions) && data.reactions.length) REACTIONS = data.reactions;
    if (data && prev && prev.appId !== data.appId) {
      draft = "";
      appOpen = false;
    }
    if (data && !prev && !draft) loadDraft();
    if (data && typingUntil && prev) {
      var a = lastStaff(prev.messages || []);
      var b = lastStaff(data.messages);
      if (b && (!a || a.id !== b.id)) typingUntil = 0;
    }
    if (!data) {
      close();
      updatePill();
      return;
    }
    if (isOpen) {
      paint(false);
      markSeen();
      if (data.status === "open" && (!prev || prev.status !== "open"))
        sock.emit("interview window", { open: true });
    }
    updatePill();
    notify(d.notice, prev);
    try {
      window.dispatchEvent(new CustomEvent("talkomatic:interview", { detail: data }));
    } catch (_) {}
  });

  sock.on("interview typing", function (d) {
    typingName = (d && d.name) || "Talkomatic staff";
    typingUntil = Date.now() + 4000;
    if (!isOpen) return;
    paintTyping();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(paintTyping, 4100);
  });

  sock.on("interview error", function (d) {
    var msg = (d && d.error) || "Could not send that.";
    if (lastSent && input && !input.value && data && lastSent.appId === data.appId) {
      input.value = lastSent.text;
      draft = lastSent.text;
      saveDraft();
      sizeInput();
    }
    lastSent = null;
    if (isOpen) showErr(msg);
    else toast(msg, { type: "error" });
  });

  sock.on("connect", function () {
    sock.emit("interview get");
    if (isOpen) sock.emit("interview window", { open: true });
  });

  document.addEventListener("visibilitychange", function () {
    if (isOpen && visible()) markSeen();
  });

  if (sock.connected) sock.emit("interview get");

  window.TkInterview = {
    open: open,
    close: close,
    state: function () {
      return data;
    },
  };
})();
