// public/js/polls.js

(function () {
  "use strict";

  if (typeof socket === "undefined") return;

  var MINUTES = [2, 3, 4, 5];
  var DEFAULT_MINUTES = 2;
  var Q_MAX = 120;
  var OPT_MAX = 40;
  var OPT_MIN = 2;
  var OPT_LIMIT = 6;
  var PLACEHOLDERS = ["Pizza or burgers?", "Movie night pick?", "Best season?", "Cats or dogs?", "What should we play?"];

  var poll = null;
  var built = false;
  var overlay = null;
  var bodyEl = null;
  var subEl = null;
  var mode = "auto";
  var draft = null;
  var changing = false;
  var sending = false;
  var tick = null;
  var announced = null;
  var tag = null;
  var formError = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function btn(cls, text, fn) {
    var b = el("button", cls, text);
    b.type = "button";
    if (fn) b.addEventListener("click", fn);
    return b;
  }

  function me() {
    return typeof currentUserId !== "undefined" ? currentUserId : "";
  }

  function signedIn() {
    return !!(me() && typeof currentRoomId !== "undefined" && currentRoomId);
  }

  function pct(n, total) {
    return total ? Math.round((n / total) * 100) : 0;
  }

  function timeLeft(p) {
    var ms = p.endsAt - Date.now();
    if (ms <= 0) return "ending";
    var m = Math.ceil(ms / 60000);
    if (ms < 60000) return "under a minute left";
    return m + " min left";
  }

  function endedText(p) {
    var e = p.ended || {};
    if (e.reason === "all") return "Everyone voted";
    if (e.reason === "timer") return "Time ran out";
    if (e.reason === "creator") return "Ended by " + (e.by || p.by.username);
    return "Ended by staff";
  }

  function build() {
    if (built) return;
    built = true;
    overlay = el("div", "tkm-overlay");
    overlay.id = "tkPollOverlay";
    var modal = el("div", "tkm-modal tkp-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Polls");

    var head = el("div", "tkm-head");
    var headText = el("div", "tkm-head-text");
    var title = el("div", "tkm-title");
    title.innerHTML = '<i class="fas fa-square-poll-vertical"></i> Polls';
    subEl = el("div", "tkm-sub", "");
    headText.appendChild(title);
    headText.appendChild(subEl);
    var closeBtn = btn("tkp-close", "", close);
    closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
    closeBtn.setAttribute("aria-label", "Close");
    head.appendChild(headText);
    head.appendChild(closeBtn);

    bodyEl = el("div", "tkm-body tkp-body");
    modal.appendChild(head);
    modal.appendChild(bodyEl);
    overlay.appendChild(modal);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) close();
    });
    document.body.appendChild(overlay);
  }

  function isOpen() {
    return !!(overlay && overlay.classList.contains("show"));
  }

  function open(view) {
    build();
    mode = view === "create" ? "create" : "auto";
    changing = false;
    hideTag();
    render();
    overlay.classList.add("show");
    document.body.classList.add("tkm-lock");
    socket.emit("poll get");
    if (!tick) tick = setInterval(onTick, 15000);
  }

  function close() {
    if (!isOpen()) return;
    if (creating()) saveDraft();
    overlay.classList.remove("show");
    document.body.classList.remove("tkm-lock");
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
  }

  function onTick() {
    if (isOpen() && poll && !poll.ended && !creating()) render();
  }

  function creating() {
    return !!(bodyEl && bodyEl.querySelector(".tkp-form"));
  }

  function render() {
    if (!bodyEl) return;
    bodyEl.innerHTML = "";
    if (poll && !poll.ended) renderPoll(poll);
    else if (mode === "create" || !poll) renderCreate();
    else renderPoll(poll);
  }

  function renderCreate() {
    subEl.textContent = "Ask the room something";
    var d = draft || { question: "", options: ["", ""], minutes: DEFAULT_MINUTES };
    draft = d;
    var form = el("div", "tkp-form");

    form.appendChild(el("div", "tkp-label", "Question"));
    var q = el("input", "tkp-input tkp-q");
    q.type = "text";
    q.maxLength = Q_MAX;
    q.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
    q.value = d.question;
    q.autocomplete = "off";
    form.appendChild(q);

    form.appendChild(el("div", "tkp-label", "Answers"));
    var list = el("div", "tkp-opts");
    form.appendChild(list);
    var add = btn("tkp-add", "Add answer", function () {
      if (d.options.length >= OPT_LIMIT) return;
      syncDraft(form);
      d.options.push("");
      drawOptions();
      var inputs = list.querySelectorAll("input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    form.appendChild(add);

    function drawOptions() {
      list.innerHTML = "";
      d.options.forEach(function (val, i) {
        var row = el("div", "tkp-opt-row");
        var inp = el("input", "tkp-input");
        inp.type = "text";
        inp.maxLength = OPT_MAX;
        inp.placeholder = "Answer " + (i + 1);
        inp.value = val;
        inp.autocomplete = "off";
        inp.addEventListener("keydown", function (e) {
          if (e.key !== "Enter") return;
          e.preventDefault();
          var inputs = list.querySelectorAll("input");
          if (i < inputs.length - 1) inputs[i + 1].focus();
          else if (d.options.length < OPT_LIMIT && inp.value.trim()) add.click();
          else submit();
        });
        row.appendChild(inp);
        if (d.options.length > OPT_MIN) {
          var x = btn("tkp-x", "×", function () {
            syncDraft(form);
            d.options.splice(i, 1);
            drawOptions();
          });
          x.setAttribute("aria-label", "Remove answer");
          row.appendChild(x);
        }
        list.appendChild(row);
      });
      add.style.display = d.options.length >= OPT_LIMIT ? "none" : "";
    }
    drawOptions();

    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var first = list.querySelector("input");
      if (first) first.focus();
    });

    form.appendChild(el("div", "tkp-label", "Ends after"));
    var seg = el("div", "tkp-seg");
    MINUTES.forEach(function (m) {
      var b = btn("tkp-seg-btn" + (m === d.minutes ? " active" : ""), m + " min", function () {
        d.minutes = m;
        seg.querySelectorAll(".tkp-seg-btn").forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
      });
      seg.appendChild(b);
    });
    form.appendChild(seg);
    form.appendChild(el("div", "tkp-hint", "Or sooner, once everyone in the room has voted."));

    var err = el("div", "tkp-err");
    form.appendChild(err);

    var foot = el("div", "tkp-foot");
    var start = btn("tkp-primary", "Start poll", submit);
    if (!signedIn()) {
      start.disabled = true;
      foot.appendChild(el("div", "tkp-status", "Join the room to start a poll."));
    }
    foot.appendChild(start);
    form.appendChild(foot);

    function submit() {
      if (sending || start.disabled) return;
      syncDraft(form);
      var question = d.question.trim();
      var options = d.options.map(function (o) {
        return o.trim();
      }).filter(Boolean);
      var seen = {};
      for (var i = 0; i < options.length; i++) {
        var k = options[i].toLowerCase();
        if (seen[k]) return fail("Two answers say the same thing.");
        seen[k] = true;
      }
      if (!question) return fail("Write a question.");
      if (options.length < OPT_MIN) return fail("Give at least 2 answers.");
      sending = true;
      start.disabled = true;
      socket.emit("poll create", { question: question, options: options, minutes: d.minutes });
      setTimeout(function () {
        sending = false;
        if (start.isConnected) start.disabled = false;
      }, 4000);
    }

    function fail(msg) {
      err.textContent = msg;
      err.classList.add("show");
    }

    formError = fail;
    bodyEl.appendChild(form);
    if (!d.question) q.focus();
  }

  function syncDraft(form) {
    if (!draft || !form) return;
    var q = form.querySelector(".tkp-q");
    if (q) draft.question = q.value;
    var inputs = form.querySelectorAll(".tkp-opts input");
    draft.options = Array.prototype.map.call(inputs, function (i) {
      return i.value;
    });
  }

  function saveDraft() {
    var form = bodyEl && bodyEl.querySelector(".tkp-form");
    if (form) syncDraft(form);
  }

  function renderPoll(p) {
    var live = !p.ended;
    subEl.textContent = live ? "Asked by " + p.by.username : "Poll over";
    var wrap = el("div", "tkp-poll");
    wrap.appendChild(el("div", "tkp-q-text", p.question));

    var voteable = live && p.canVote && (p.mine == null || changing);
    if (voteable) {
      var choices = el("div", "tkp-choices");
      p.options.forEach(function (o, i) {
        var c = btn("tkp-choice" + (p.mine === i ? " mine" : ""), "", function () {
          changing = false;
          socket.emit("poll vote", { id: p.id, option: i });
        });
        c.appendChild(el("span", "tkp-choice-text", o.text));
        if (o.count != null) c.appendChild(el("span", "tkp-choice-n", String(o.count)));
        choices.appendChild(c);
        if (o.voters && o.voters.length) choices.appendChild(voterChips(o.voters));
      });
      wrap.appendChild(choices);
      if (p.mine != null) wrap.appendChild(el("div", "tkp-hint", "Pick a new answer, or close this to keep your vote."));
    } else {
      wrap.appendChild(results(p));
    }

    var foot = el("div", "tkp-foot");
    var status = el("div", "tkp-status");
    var pill = function (t, cls) {
      status.appendChild(el("span", "tkp-pill" + (cls ? " " + cls : ""), t));
    };
    var votes = p.total === 1 ? "1 vote" : p.total + " votes";
    if (live) {
      var waiting = p.waiting != null ? p.waiting : Math.max(0, p.eligible - p.total);
      pill(votes);
      if (waiting) pill(waiting + " to go");
      pill(timeLeft(p), "time");
    } else {
      pill(endedText(p), "done");
      pill(votes);
    }
    foot.appendChild(status);
    if (live && p.mine != null && p.canVote && !changing)
      foot.appendChild(
        btn("tkp-ghost", "Change vote", function () {
          changing = true;
          render();
        }),
      );
    if (live && p.canEnd)
      foot.appendChild(
        btn("tkp-ghost tkp-end", "End poll", function () {
          socket.emit("poll end", { id: p.id });
        }),
      );
    if (!live && signedIn())
      foot.appendChild(
        btn("tkp-primary", "New poll", function () {
          mode = "create";
          render();
        }),
      );
    wrap.appendChild(foot);

    if (p.staff) wrap.appendChild(staffBox(p));
    bodyEl.appendChild(wrap);
  }

  function results(p) {
    var list = el("div", "tkp-results");
    var top = 0;
    p.options.forEach(function (o) {
      if (o.count > top) top = o.count;
    });
    var leaders = p.options.filter(function (o) {
      return o.count === top && top > 0;
    }).length;
    p.options.forEach(function (o, i) {
      var n = o.count || 0;
      var won = !!p.ended && n === top && top > 0;
      var row = el("div", "tkp-res" + (p.mine === i ? " mine" : "") + (won ? " win" : ""));
      var head = el("div", "tkp-res-top");
      var left = el("div", "tkp-res-left");
      left.appendChild(el("span", "tkp-res-text", o.text));
      if (won) left.appendChild(el("span", "tkp-chip win", leaders > 1 ? "Tie" : "Winner"));
      if (p.mine === i) left.appendChild(el("span", "tkp-chip mine", "Your vote"));
      var right = el("div", "tkp-res-right");
      right.appendChild(el("span", "tkp-pct", pct(n, p.total) + "%"));
      right.appendChild(el("span", "tkp-votes", n === 1 ? "1 vote" : n + " votes"));
      head.appendChild(left);
      head.appendChild(right);
      row.appendChild(head);
      var bar = el("div", "tkp-bar");
      var fill = el("div", "tkp-fill");
      fill.style.width = pct(n, p.total) + "%";
      bar.appendChild(fill);
      row.appendChild(bar);
      if (o.voters && o.voters.length) row.appendChild(voterChips(o.voters));
      list.appendChild(row);
    });
    return list;
  }

  function voterChips(names) {
    var v = el("div", "tkp-voters");
    names.forEach(function (name) {
      v.appendChild(el("span", "tkp-voter", name));
    });
    return v;
  }

  function staffBox(p) {
    var box = el("div", "tkp-staff");
    box.appendChild(el("div", "tkp-staff-h", "Staff view"));
    var rows = [
      ["Asked by", p.by.username],
      ["Started", new Date(p.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })],
      ["Length", p.minutes + " min"],
      ["In room", String(p.eligible)],
    ];
    if (p.ended) rows.push(["Ended", endedText(p)]);
    rows.forEach(function (r) {
      var line = el("div", "tkp-staff-row");
      line.appendChild(el("span", "tkp-staff-k", r[0]));
      line.appendChild(el("span", "tkp-staff-v", r[1]));
      box.appendChild(line);
    });
    return box;
  }

  function showTag() {
    var host = document.getElementById("appDirectoryToggle");
    if (!host) return;
    if (!tag) {
      tag = el("span", "tkp-tag", "New poll");
      host.appendChild(tag);
    }
    tag.style.display = "";
  }

  function hideTag() {
    if (tag) tag.style.display = "none";
  }

  function announce(p) {
    var body = p.by.username + " asks: " + p.question;
    if (window.TkNotify) {
      window.TkNotify.show("info", body, {
        title: "New poll",
        timeout: 12000,
        actions: [{ label: "Vote", onClick: function () { open(); } }],
      });
    } else if (window.StaffUI && window.StaffUI.toast) {
      var node = window.StaffUI.toast(body, { type: "info", title: "New poll", timeout: 12000 });
      if (node) node.addEventListener("click", function () { open(); });
    }
  }

  socket.on("poll state", function (p) {
    poll = p || null;
    if (poll && !poll.ended && poll.mine == null && poll.by.userId !== me() && announced !== poll.id) {
      announced = poll.id;
      if (!isOpen()) {
        announce(poll);
        showTag();
      }
    }
    if (!poll || poll.ended || poll.mine != null) hideTag();
    if (poll && !poll.ended) {
      sending = false;
      if (poll.by.userId === me()) draft = null;
    }
    if (isOpen()) {
      if (creating()) saveDraft();
      if (poll && !poll.ended && poll.mine == null && !changing) mode = "auto";
      render();
    }
  });

  socket.on("poll error", function (d) {
    sending = false;
    var msg = (d && d.message) || "That did not work.";
    if (creating()) {
      formError(msg);
      var b = bodyEl.querySelector(".tkp-primary");
      if (b) b.disabled = false;
    } else if (window.TkNotify) window.TkNotify.show("warning", msg);
  });

  document.addEventListener("tk-room-joined", function () {
    poll = null;
    announced = null;
    changing = false;
    hideTag();
    socket.emit("poll get");
    if (isOpen()) render();
  });

  window.TalkomaticPolls = {
    open: function () {
      open();
    },
    create: function () {
      open(poll && !poll.ended ? "auto" : "create");
    },
    close: close,
    status: function () {
      if (!poll) return null;
      if (poll.ended) return "Results";
      return poll.mine == null ? "Vote" : "Live";
    },
  };
})();
