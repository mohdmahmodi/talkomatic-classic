(function boot() {
  "use strict";

  if (typeof socket === "undefined") {
    window.addEventListener("talkomatic:socket", boot, { once: true });
    return;
  }

  var STORE = "talkomatic_modKey";
  var overlay = null;
  var bar = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function dateOf(ts) {
    return ts ? new Date(ts).toLocaleDateString() : "";
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.classList.remove("tkm-lock");
  }

  function show(o) {
    close();
    overlay = el("div", "tkm-overlay tkk-overlay show");
    var modal = el("div", "tkm-modal tkk-modal" + (o.tone ? " tkk-" + o.tone : ""));
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", o.title);

    var head = el("div", "tkm-head");
    var mark = el("div", "tkk-mark");
    mark.innerHTML = '<i class="fas ' + o.icon + '"></i>';
    head.appendChild(mark);
    var headText = el("div", "tkm-head-text");
    headText.appendChild(el("div", "tkm-title", o.title));
    if (o.sub) headText.appendChild(el("div", "tkm-sub", o.sub));
    head.appendChild(headText);
    modal.appendChild(head);

    var body = el("div", "tkm-body");
    (o.body || []).forEach(function (n) {
      if (n) body.appendChild(n);
    });
    modal.appendChild(body);

    var gate = el("div", "tkm-gate tkk-gate");
    o.actions.forEach(function (a) {
      var b = el("button", a.primary ? "tkm-gate-btn" : "tkk-ghost", a.label);
      b.type = "button";
      b.disabled = !!a.disabled;
      b.addEventListener("click", function () {
        if (a.onClick && a.onClick(b) === false) return;
        close();
        if (a.after) a.after();
      });
      a.el = b;
      gate.appendChild(b);
    });
    modal.appendChild(gate);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add("tkm-lock");
    var first = gate.querySelector(".tkm-gate-btn") || gate.firstChild;
    setTimeout(function () {
      if (first) first.focus();
    }, 60);
  }

  function quote(text) {
    return text ? el("div", "tkk-quote", text) : null;
  }

  function para(text, cls) {
    return el("p", "tkk-p" + (cls ? " " + cls : ""), text);
  }

  function askForm(prompt) {
    var wrap = el("div", "tkk-ask");
    wrap.appendChild(el("label", "tkk-label", prompt));
    var ta = el("textarea", "tkk-text");
    ta.maxLength = 600;
    ta.rows = 3;
    ta.placeholder = "A sentence or two is enough.";
    wrap.appendChild(ta);
    wrap.appendChild(
      el(
        "div",
        "tkk-hint",
        "A mod leader or admin reads this in the Desk and decides. You will hear back here.",
      ),
    );
    wrap.textarea = ta;
    return wrap;
  }

  var pendingSend = null;

  function requestModal(o) {
    var form = askForm(o.prompt);
    var send = {
      label: o.sendLabel,
      primary: true,
      disabled: true,
      onClick: function (btn) {
        var text = form.textarea.value.trim();
        if (text.length < 5) return false;
        btn.disabled = true;
        btn.textContent = "Sending…";
        pendingSend = { btn: btn, form: form, after: o.afterSend };
        socket.emit("staff key request", { text: text });
        return false;
      },
    };
    show({
      icon: o.icon,
      tone: o.tone,
      title: o.title,
      sub: o.sub,
      body: o.body.concat([form]),
      actions: [{ label: o.dismissLabel, after: o.afterDismiss }, send],
    });
    form.textarea.addEventListener("input", function () {
      send.el.disabled = form.textarea.value.trim().length < 5;
    });
    setTimeout(function () {
      form.textarea.focus();
    }, 80);
  }

  socket.on("staff key request result", function (d) {
    if (!pendingSend) return;
    var p = pendingSend;
    pendingSend = null;
    if (!d || !d.ok) {
      p.btn.disabled = false;
      p.btn.textContent = "Try again";
      p.form.querySelector(".tkk-hint").textContent =
        (d && d.error) || "That did not go through. Try again in a moment.";
      return;
    }
    show({
      icon: "fa-paper-plane",
      tone: "ok",
      title: "Sent to the team",
      sub: "A mod leader or admin will take a look",
      body: [
        para(
          "If they issue a new key it lands on this device by itself: the site reloads and you are signed back in. If they decide against it, their note shows up here instead.",
        ),
      ],
      actions: [{ label: "Okay", primary: true, after: p.after }],
    });
  });

  function revokedModal(d, live) {
    var auto = !!d.auto;
    var reload = live
      ? function () {
          window.location.reload();
        }
      : null;
    var body = [
      para(
        (auto ? "Automod" : "The Talkomatic team") +
          " removed your moderator key" +
          (d.removedAt ? " on " + dateOf(d.removedAt) : "") +
          ". You are back to being an ordinary user on this device.",
      ),
      quote(d.reason),
    ];
    if (auto && d.canAsk !== false)
      return requestModal({
        icon: "fa-user-xmark",
        tone: "warn",
        title: "Your moderator key was removed",
        sub: "Automod acted on its own. A person can undo it.",
        body: body,
        prompt: "If this was a mistake, tell the team what happened",
        sendLabel: "Send to the team",
        dismissLabel: "Understood",
        afterDismiss: reload,
        afterSend: reload,
      });
    body.push(
      para(
        auto
          ? "A mod leader or admin has already been asked to look at this."
          : "If you believe this was a mistake, raise it with staff.",
        "muted",
      ),
    );
    show({
      icon: "fa-user-xmark",
      tone: "warn",
      title: "Your moderator key was removed",
      sub: auto ? "Automod acted on its own" : "Decided by the team",
      body: body,
      actions: [{ label: "Understood", primary: true, after: reload }],
    });
  }

  socket.on("staff revoked", function (d) {
    localStorage.removeItem(STORE);
    revokedModal(
      Object.assign({ removedAt: Date.now(), canAsk: true }, d || {}),
      true,
    );
    setTimeout(function () {
      window.location.reload();
    }, 5 * 60 * 1000);
  });

  socket.on("staff revoked notice", function (d) {
    localStorage.removeItem(STORE);
    revokedModal(d || {}, false);
  });

  socket.on("staff key lost", function (d) {
    var label = (d && d.label) || "you";
    try {
      if (sessionStorage.getItem("tk_lost_seen")) return;
    } catch (_) {}
    requestModal({
      icon: "fa-key",
      tone: "info",
      title: "Lost your staff key?",
      sub: "This device used to sign in as " + label,
      body: [
        para(
          "There is no staff key saved here any more. If you still have another signed-in device, open Staff key & devices there and get a key for this one. Otherwise, ask the team for a new one.",
        ),
      ],
      prompt: "What happened to the key on this device?",
      sendLabel: "Ask the team",
      dismissLabel: "Not now",
      afterDismiss: function () {
        try {
          sessionStorage.setItem("tk_lost_seen", "1");
        } catch (_) {}
      },
    });
  });

  socket.on("staff key declined", function (d) {
    show({
      icon: "fa-envelope-open-text",
      tone: "info",
      title: "About your key request",
      sub: "The team has looked at it",
      body: [
        para("A mod leader or admin decided not to issue a new key right now."),
        quote(d && d.note),
      ],
      actions: [{ label: "Understood", primary: true }],
    });
  });

  socket.on("staff key restored", function () {
    window.location.reload();
  });

  function bank(token) {
    return fetch("/api/v1/staff/token", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token || "",
        deviceId: window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId,
      }),
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
    });
  }

  window.StaffKey = {
    forget: function () {
      localStorage.removeItem(STORE);
      return bank("").catch(function () {});
    },
  };

  socket.on("staff token", function (d) {
    var token = d && d.token;
    var done = function () {
      if (d && d.reload) window.location.reload();
    };
    if (!token) {
      localStorage.removeItem(STORE);
      return bank("").then(done, done);
    }
    bank(token).then(
      function () {
        localStorage.removeItem(STORE);
        done();
      },
      function () {
        localStorage.setItem(STORE, token);
        done();
      },
    );
  });

  socket.on("staff switched", function () {
    window.location.reload();
  });

  socket.on("staff moved", function (d) {
    var device = (d && d.device) || "another device";
    show({
      icon: "fa-right-left",
      tone: "info",
      title: "Your key moved to your " + device,
      sub: "One device at a time",
      body: [
        para(
          "Your staff key is now active on your " +
            device +
            ", so staff powers here are off. Switch back any time from the bar at the bottom of the page.",
        ),
        para(
          "If you did not do this yourself, sign the other device out from Staff key & devices and tell a mod leader.",
          "muted",
        ),
      ],
      actions: [
        {
          label: "Okay",
          primary: true,
          after: function () {
            window.location.reload();
          },
        },
      ],
    });
  });

  socket.on("staff standby", function (d) {
    if (bar) bar.remove();
    bar = el("div", "tkk-bar");
    var ico = el("span", "tkk-bar-ico");
    ico.innerHTML = '<i class="fas fa-key"></i>';
    bar.appendChild(ico);
    bar.appendChild(
      el(
        "span",
        "tkk-bar-text",
        "Your staff key is active on your " +
          ((d && d.device) || "other device") +
          ". Staff powers are off here until you switch.",
      ),
    );
    var btn = el("button", "tkk-bar-btn", "Use it here");
    btn.type = "button";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Switching…";
      socket.emit("staff switch device");
    });
    bar.appendChild(btn);
    document.body.appendChild(bar);
    document.body.classList.add("tkk-has-bar");
  });

  socket.on("staff key minted", function (d) {
    if (!d || !d.key) {
      if (window.toastr)
        toastr.warning(
          "Too many new keys this hour. Try again later.",
          "Slow down",
        );
      return;
    }
    var box = el("div", "tkk-keybox");
    var val = el("code", "tkk-keyval", d.key);
    box.appendChild(val);
    var copy = el("button", "tkk-copy", "Copy");
    copy.type = "button";
    copy.addEventListener("click", function () {
      var done = function () {
        copy.textContent = "Copied";
      };
      if (navigator.clipboard) navigator.clipboard.writeText(d.key).then(done, done);
      else {
        var r = document.createRange();
        r.selectNodeContents(val);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.execCommand("copy");
        done();
      }
    });
    box.appendChild(copy);
    var mins = Math.max(1, Math.round(((d.expires || 0) - Date.now()) / 60000));
    show({
      icon: "fa-mobile-screen",
      tone: "ok",
      title: "Key for another device",
      sub: "Shown once. Works once.",
      body: [
        box,
        para(
          "On the other device, open the lobby, pick Enter staff key and paste this in. It stops working after " +
            mins +
            " minutes or the moment it is used. This browser keeps its own sign-in.",
        ),
        para(
          "Two devices can hold your key, and only one is active at a time. Pasting it on the new device makes that one active.",
          "muted",
        ),
      ],
      actions: [{ label: "Done", primary: true }],
    });
  });
})();
