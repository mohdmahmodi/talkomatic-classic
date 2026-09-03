// public/js/mod-apply.js
// Moderator application form, status view, and decision popups for the lobby.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var built = false;
  var isFormOpen = false;
  var overlay, errEl, submitBtn;
  var whyInput, whyCount, expInput, availInput;
  var discordInput, discordFieldWrap, noDiscordLine;
  var ageBox, termsBox, ageRow, termsRow;
  var hasDiscordChoice = null;
  var discordBtns = {};

  var myStatus = null;
  var appsOpen = true;
  var decisionIsOpen = false;
  var reloadWhenClosed = false;

  var SEEN_KEY = "talkomatic_appDecisionSeen";
  var DECISION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  var WHY_MIN = 20;
  var WHY_MAX = 500;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(msg, type) {
    if (window.StaffUI) StaffUI.toast(msg, { type: type || "info" });
  }

  function viewerIsStaff() {
    try {
      return !!(currentUserIsDev || currentUserIsMod);
    } catch (_) {
      return false;
    }
  }

  // ── The application form ──────────────────────────────────────────────────

  function strip(text) {
    return el("div", "ma-strip", text);
  }

  function fieldLabel(text, required, extra) {
    var l = el("label", "ma-label");
    l.appendChild(document.createTextNode(text + " "));
    if (required) l.appendChild(el("span", "ma-req-star", "*"));
    else l.appendChild(el("span", "ma-optional", "(optional)"));
    if (extra) l.appendChild(extra);
    return l;
  }

  function reqRow(icon, html, ok) {
    var row = el("div", "ma-req-row" + (ok ? " ok" : ""));
    var i = el("i", "fas " + icon);
    row.appendChild(i);
    var t = el("span");
    t.innerHTML = html;
    row.appendChild(t);
    return row;
  }

  function checkRow(labelText) {
    var row = el("label", "ma-check-row");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    row.appendChild(cb);
    row.appendChild(el("span", null, labelText));
    return { row: row, box: cb };
  }

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "ma-overlay");
    var modal = el("div", "ma-modal");

    var head = el("div", "ma-head");
    var titleWrap = el("div", "ma-title-wrap");
    var title = el("div", "ma-title");
    title.innerHTML = '<i class="fas fa-user-shield"></i> Moderator Application';
    var sub = el(
      "div",
      "ma-sub",
      "Talkomatic takes on a small number of volunteers to help keep rooms friendly.",
    );
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    var closeBtn = el("button", "ma-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    head.appendChild(titleWrap);
    head.appendChild(closeBtn);

    var body = el("div", "ma-body");

    // The role
    body.appendChild(strip("The role"));
    var roleSec = el("div", "ma-section");
    roleSec.appendChild(
      el(
        "p",
        "ma-intro",
        "Junior moderators are regular members with a few extra tools. It is a volunteer role: there is no pay, and it can be taken back at any time.",
      ),
    );
    var cols = el("div", "ma-cols");
    var can = el("div", "ma-col ma-col-can");
    can.appendChild(el("div", "ma-col-title", "As a junior mod you can"));
    var canList = el("ul");
    [
      "Warn and kick people who break the rules",
      "Clear what someone has typed",
      "Reset a bad name, location or picture",
      "Rename, lock or slow down a room",
    ].forEach(function (t) {
      canList.appendChild(el("li", null, t));
    });
    can.appendChild(canList);
    var cant = el("div", "ma-col ma-col-cant");
    cant.appendChild(el("div", "ma-col-title", "Stays with full mods and devs"));
    var cantList = el("ul");
    [
      "Bans and IP blocks",
      "Reviewing appeals and applications",
      "Promotions (trusted juniors can be promoted by a dev later)",
    ].forEach(function (t) {
      cantList.appendChild(el("li", null, t));
    });
    cant.appendChild(cantList);
    cols.appendChild(can);
    cols.appendChild(cant);
    roleSec.appendChild(cols);
    body.appendChild(roleSec);

    // Before you apply
    body.appendChild(strip("Before you apply"));
    var reqSec = el("div", "ma-section");
    var reqs = el("div", "ma-req");
    reqs.appendChild(
      reqRow(
        "fa-cake-candles",
        "<b>You must be 14 or older.</b> You will be asked to confirm this below.",
      ),
    );
    reqs.appendChild(
      reqRow(
        "fa-circle-check",
        "<b>You need to be an established member:</b> at least a month on Talkomatic and twelve hours of active time in rooms. You already meet this, which is why you can see this form.",
        true,
      ),
    );
    reqs.appendChild(
      reqRow(
        "fa-scale-balanced",
        "<b>Not every application is accepted.</b> The team is kept small on purpose. Being turned down is not a punishment, and you can apply again later.",
      ),
    );
    reqs.appendChild(
      reqRow(
        "fa-hourglass-half",
        "<b>Reviews are done by hand</b>, so a decision can take a few days. When it is made, you get a popup here on the site.",
      ),
    );
    reqSec.appendChild(reqs);
    body.appendChild(reqSec);

    // Your application
    body.appendChild(strip("Your application"));
    var formSec = el("div", "ma-section");

    var whyField = el("div", "ma-field");
    whyCount = el("span", "ma-count", "0 / " + WHY_MAX);
    whyField.appendChild(
      fieldLabel("Why do you want to moderate?", true, whyCount),
    );
    whyInput = el("textarea", "ma-input");
    whyInput.maxLength = WHY_MAX;
    whyInput.rows = 4;
    whyInput.placeholder =
      "What made you apply, and how would you handle things like spam or an argument between two people?";
    whyInput.addEventListener("input", function () {
      whyCount.textContent = whyInput.value.length + " / " + WHY_MAX;
      whyCount.classList.toggle(
        "bad",
        whyInput.value.trim().length > 0 &&
          whyInput.value.trim().length < WHY_MIN,
      );
      whyInput.classList.remove("bad");
    });
    whyField.appendChild(whyInput);
    formSec.appendChild(whyField);

    var expField = el("div", "ma-field");
    expField.appendChild(
      fieldLabel("Have you moderated anywhere before?", false),
    );
    expInput = el("textarea", "ma-input");
    expInput.maxLength = 300;
    expInput.rows = 2;
    expInput.placeholder =
      "For example Discord servers, forums or games. If you have not, leave this empty.";
    expField.appendChild(expInput);
    formSec.appendChild(expField);

    var availField = el("div", "ma-field");
    availField.appendChild(fieldLabel("When are you usually online?", false));
    availInput = el("input", "ma-input");
    availInput.type = "text";
    availInput.maxLength = 120;
    availInput.placeholder = "e.g. weekday evenings, Europe";
    availField.appendChild(availInput);
    availField.appendChild(
      el(
        "div",
        "ma-help",
        "So we know what times of day you would actually be around.",
      ),
    );
    formSec.appendChild(availField);
    body.appendChild(formSec);

    // Discord
    body.appendChild(strip("Discord"));
    var discSec = el("div", "ma-section");
    var note = el("div", "ma-discord-note");
    note.innerHTML =
      "<b>Discord is not required.</b> If you have it, the team can reach you there and give you the mod role in the Talkomatic Discord server. If you do not have it, you can still apply. Decisions and staff messages show up right here on the site.";
    discSec.appendChild(note);

    var toggleRow = el("div", "ma-toggle-row");
    toggleRow.appendChild(
      el("span", "ma-toggle-label", "Do you have a Discord account?"),
    );
    var yesBtn = el("button", "ma-toggle-btn");
    yesBtn.type = "button";
    yesBtn.innerHTML = '<i class="fab fa-discord"></i> I have Discord';
    var noBtn = el("button", "ma-toggle-btn ma-toggle-no", "No Discord");
    noBtn.type = "button";
    yesBtn.addEventListener("click", function () {
      setDiscordChoice(true);
    });
    noBtn.addEventListener("click", function () {
      setDiscordChoice(false);
    });
    toggleRow.appendChild(yesBtn);
    toggleRow.appendChild(noBtn);
    discordBtns = { yes: yesBtn, no: noBtn };
    discSec.appendChild(toggleRow);

    discordFieldWrap = el("div", "ma-field");
    discordFieldWrap.style.display = "none";
    discordFieldWrap.appendChild(fieldLabel("Your Discord username", true));
    discordInput = el("input", "ma-input");
    discordInput.type = "text";
    discordInput.maxLength = 40;
    discordInput.placeholder = "e.g. zacki";
    discordInput.addEventListener("input", function () {
      discordInput.classList.remove("bad");
    });
    discordFieldWrap.appendChild(discordInput);
    discordFieldWrap.appendChild(
      el(
        "div",
        "ma-help",
        "Your @username, not your display name. Join the Talkomatic Discord server so we can find you.",
      ),
    );
    discSec.appendChild(discordFieldWrap);

    noDiscordLine = el("div", "ma-no-discord-line");
    noDiscordLine.style.display = "none";
    noDiscordLine.innerHTML =
      '<i class="fas fa-check"></i>No problem. Leave Discord out and everything happens here on the site.';
    discSec.appendChild(noDiscordLine);
    body.appendChild(discSec);

    // Terms
    body.appendChild(strip("Moderator terms"));
    var termsSec = el("div", "ma-section");
    var terms = el("div", "ma-terms");
    var ol = el("ol");
    [
      "Moderating Talkomatic is volunteering. It is not a job, and there is no pay.",
      "Junior moderators can warn and kick people, clear what someone has typed, reset a bad name, location or picture, and rename, lock or slow a room. Bans stay with full moderators and up.",
      "Use the tools on rule-breaking, not on people you dislike or argue with. If you are part of an argument, step back and let another moderator handle it.",
      "Every moderator action is logged and the team leaders and admins read the logs. Misusing the tools loses you the role, and serious cases get banned like anyone else.",
      "Your moderator key is yours alone. Never share it or show it on stream. A key used by two people is revoked automatically.",
      "Decisions by admins and moderators are final. If you disagree with one, raise it with staff, not in a room.",
      "The team can take the role back at any time, with or without a stated reason.",
    ].forEach(function (t) {
      ol.appendChild(el("li", null, t));
    });
    terms.appendChild(ol);
    termsSec.appendChild(terms);

    var age = checkRow("I am 14 years old or older.");
    ageRow = age.row;
    ageBox = age.box;
    var agree = checkRow("I have read the terms above and I agree to them.");
    termsRow = agree.row;
    termsBox = agree.box;
    ageBox.addEventListener("change", function () {
      ageRow.classList.remove("bad");
    });
    termsBox.addEventListener("change", function () {
      termsRow.classList.remove("bad");
    });
    termsSec.appendChild(ageRow);
    termsSec.appendChild(termsRow);
    body.appendChild(termsSec);

    // Footer
    var foot = el("div", "ma-foot");
    errEl = el("div", "ma-err", "");
    var cancelBtn = el("button", "ma-cancel-btn", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", close);
    submitBtn = el("button", "ma-submit-btn");
    submitBtn.type = "button";
    submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit application';
    submitBtn.addEventListener("click", submitForm);
    foot.appendChild(errEl);
    foot.appendChild(cancelBtn);
    foot.appendChild(submitBtn);

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isFormOpen) close();
    });
  }

  function setDiscordChoice(v) {
    hasDiscordChoice = v;
    discordBtns.yes.classList.toggle("active", v === true);
    discordBtns.no.classList.toggle("active", v === false);
    discordFieldWrap.style.display = v === true ? "" : "none";
    noDiscordLine.style.display = v === false ? "" : "none";
    showErr("");
    if (v === true) discordInput.focus();
  }

  function showErr(msg) {
    if (errEl) errEl.textContent = msg || "";
  }

  function fail(msg, focusEl, rowEl) {
    showErr(msg);
    if (focusEl) {
      focusEl.classList.add("bad");
      focusEl.focus();
      focusEl.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (rowEl) {
      rowEl.classList.add("bad");
      rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function submitForm() {
    showErr("");
    var why = whyInput.value.trim();
    if (why.length < WHY_MIN)
      return fail(
        "Tell us a bit more about why you want to moderate (at least " +
          WHY_MIN +
          " characters).",
        whyInput,
      );
    if (hasDiscordChoice === null)
      return fail(
        'Please answer the Discord question: pick "I have Discord" or "No Discord".',
      );
    var discord = "";
    if (hasDiscordChoice) {
      discord = discordInput.value
        .trim()
        .replace(/^@+/, "")
        .replace(/[^A-Za-z0-9._-]/g, "");
      if (discord.length < 2)
        return fail(
          'Enter your Discord username, or pick "No Discord" instead.',
          discordInput,
        );
    }
    if (!ageBox.checked)
      return fail(
        "You must confirm you are 14 or older to apply.",
        null,
        ageRow,
      );
    if (!termsBox.checked)
      return fail(
        "Please read the moderator terms and tick the agreement box.",
        null,
        termsRow,
      );
    submitBtn.disabled = true;
    socket.emit("mod application submit", {
      why: why,
      experience: expInput.value.trim(),
      availability: availInput.value.trim(),
      hasDiscord: !!hasDiscordChoice,
      discord: discord,
      age14: true,
      agree: true,
    });
  }

  function resetForm() {
    whyInput.value = "";
    whyCount.textContent = "0 / " + WHY_MAX;
    whyCount.classList.remove("bad");
    whyInput.classList.remove("bad");
    expInput.value = "";
    availInput.value = "";
    discordInput.value = "";
    discordInput.classList.remove("bad");
    hasDiscordChoice = null;
    discordBtns.yes.classList.remove("active");
    discordBtns.no.classList.remove("active");
    discordFieldWrap.style.display = "none";
    noDiscordLine.style.display = "none";
    ageBox.checked = false;
    termsBox.checked = false;
    ageRow.classList.remove("bad");
    termsRow.classList.remove("bad");
    showErr("");
    submitBtn.disabled = false;
  }

  function showClosedNotice() {
    var body = el("div", "ma-closed");
    body.appendChild(
      el(
        "p",
        null,
        "We are not taking on new moderators at the moment. The team is full for now, so applications are paused.",
      ),
    );
    body.appendChild(
      el(
        "p",
        null,
        "When they open again, the tag on “Apply to be a mod” in the lobby changes from Closed to Open and this button opens the form.",
      ),
    );
    var note = el("p", "ma-closed-note");
    note.appendChild(el("span", "ma-note-label", "Please note"));
    note.appendChild(
      el(
        "div",
        null,
        "Do not ask staff for mod in the rooms. It does not get you in any sooner, and it makes an application less likely to be accepted later.",
      ),
    );
    body.appendChild(note);
    StaffUI.modal({
      title: "Applications are closed",
      subtitle: "Not accepting new moderators right now",
      icon: '<i class="fas fa-lock"></i>',
      body: body,
      actions: [{ label: "Got it", kind: "primary", onClick: function () {} }],
    });
  }

  function openForm() {
    if (!window.StaffUI) return;
    if (appsOpen === false) {
      showClosedNotice();
      return;
    }
    var act = window.TalkomaticIdentity && window.TalkomaticIdentity.activity;
    if (!act || !act.active) {
      showActivityGate(act);
      return;
    }
    build();
    resetForm();
    overlay.classList.add("show");
    isFormOpen = true;
  }

  function close() {
    if (overlay) overlay.classList.remove("show");
    isFormOpen = false;
  }

  function fmtMin(m) {
    m = Math.floor(m);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60);
    var r = m % 60;
    return r ? h + "h " + r + "m" : h + "h";
  }

  function showActivityGate(act) {
    var need = (act && act.need) || { memberDays: 30, activeMinutes: 720 };
    var have = {
      memberDays: (act && act.ageDays) || 0,
      activeMinutes: (act && act.activeMinutes) || 0,
    };
    var body = el("div", "ma-gate");
    body.appendChild(
      el(
        "p",
        "ma-gate-intro",
        "Moderator applications are open to members who have been around for a while. Once you reach both marks below, the form unlocks on its own.",
      ),
    );
    var row = function (icon, label, desc, haveText, h, w) {
      var done = h >= w;
      var r = el("div", "ma-gate-row" + (done ? " done" : ""));
      var top = el("div", "ma-gate-top");
      var l = el("span", "ma-gate-label");
      l.innerHTML =
        '<i class="fas ' + (done ? "fa-circle-check" : icon) + '"></i>' + label;
      top.appendChild(l);
      top.appendChild(el("span", "ma-gate-count", done ? "Done" : haveText));
      r.appendChild(top);
      r.appendChild(el("div", "ma-gate-desc", desc));
      var bar = el("div", "ma-gate-bar");
      var fill = el("div", "ma-gate-fill");
      fill.style.width = Math.round((Math.min(h, w) / w) * 100) + "%";
      bar.appendChild(fill);
      r.appendChild(bar);
      return r;
    };
    body.appendChild(
      row(
        "fa-calendar-days",
        "Time as a member",
        "Counted from the first day this browser visited Talkomatic.",
        Math.min(have.memberDays, need.memberDays) +
          " of " +
          need.memberDays +
          " days",
        have.memberDays,
        need.memberDays,
      ),
    );
    body.appendChild(
      row(
        "fa-stopwatch",
        "Active time in rooms",
        "Counts while you are in a room with the tab in front. Time away, idle or in a hidden tab does not count.",
        fmtMin(Math.min(have.activeMinutes, need.activeMinutes)) +
          " of " +
          fmtMin(need.activeMinutes),
        have.activeMinutes,
        need.activeMinutes,
      ),
    );
    body.appendChild(
      el(
        "div",
        "ma-gate-note",
        "Both count up on their own while you chat. There is nothing to request and nobody to ask. Come back once both are met.",
      ),
    );
    StaffUI.modal({
      title: "Apply to be a mod",
      subtitle: "Open to established members",
      icon: '<i class="fas fa-user-shield"></i>',
      body: body,
      actions: [{ label: "Got it", kind: "primary", onClick: function () {} }],
    });
  }

  // ── Status view ───────────────────────────────────────────────────────────

  var STATUS_META = {
    pending: {
      color: "#ffb454",
      fa: "fa-hourglass-half",
      title: "Application under review",
    },
    approved: {
      color: "#57d9a3",
      fa: "fa-circle-check",
      title: "Application approved",
    },
    rejected: {
      color: "#ff5468",
      fa: "fa-circle-xmark",
      title: "Application declined",
    },
    revoked: {
      color: "#ff5468",
      fa: "fa-user-slash",
      title: "Moderator access revoked",
    },
    withdrawn: {
      color: "#8d8d8d",
      fa: "fa-hand",
      title: "Role turned down",
    },
  };

  function staffMsgBox(text, color) {
    var note = el("div", "ma-staff-msg");
    var nl = el("div", "ma-staff-msg-label", "Message from staff");
    nl.style.color = color;
    var nt = el("div", "ma-staff-msg-text", text);
    note.appendChild(nl);
    note.appendChild(nt);
    return note;
  }

  function byLine(by) {
    var line = el("div", "ma-by-line");
    line.appendChild(document.createTextNode("Decision by "));
    var b = document.createElement("b");
    b.textContent = by;
    line.appendChild(b);
    return line;
  }

  function showStatus() {
    var st = myStatus;
    if (!st || !st.has) return openForm();
    if (!window.StaffUI) return;
    if (st.status === "approved" && st.offer) return showAcceptance(st);
    var m = STATUS_META[st.status] || STATUS_META.pending;
    var body = document.createElement("div");
    var p = document.createElement("p");
    p.style.margin = "0 0 6px";
    p.textContent =
      st.status === "approved"
        ? "Your application was accepted and you took the role. Reload the page if your mod tools are not showing yet."
        : st.status === "rejected"
          ? "Your application was reviewed and declined this time. You can apply again below."
          : st.status === "revoked"
            ? "Your moderator access has been revoked. If you would like to help out again, you can apply again below."
            : st.status === "withdrawn"
              ? "You turned down the junior moderator role. If you change your mind, you can apply again below."
              : "Your application is in the queue. A mod leader will review it soon. Thanks for your patience.";
    body.appendChild(p);
    if (st.submittedAt) {
      var s = document.createElement("p");
      s.style.cssText = "margin:6px 0 0;color:#8d8d8d;font-size:13px;";
      s.textContent = "Submitted " + new Date(st.submittedAt).toLocaleString();
      body.appendChild(s);
    }
    if (st.reason && st.status !== "revoked")
      body.appendChild(staffMsgBox(st.reason, m.color));
    if (st.by && (st.status === "approved" || st.status === "rejected"))
      body.appendChild(byLine(st.by));
    var actions = [
      { label: "Close", kind: "primary", onClick: function () {} },
    ];
    if (
      st.status === "rejected" ||
      st.status === "revoked" ||
      st.status === "withdrawn"
    )
      actions.unshift({
        label: "Apply again",
        onClick: function () {
          openForm();
        },
      });
    StaffUI.modal({
      title: m.title,
      icon: '<i class="fas ' + m.fa + '" style="color:' + m.color + '"></i>',
      body: body,
      actions: actions,
    });
  }

  // ── Decision popups ───────────────────────────────────────────────────────
  // A declined application shows once. An approved one is an offer: it comes
  // back every visit until the applicant accepts it or turns it down.

  function maybeShowDecision(st) {
    if (!st || !st.has) return;
    if (st.status === "approved") {
      if (st.offer) showAcceptance(st);
      return;
    }
    if (st.status !== "rejected" || !st.reviewedAt) return;
    var key = st.status + ":" + st.reviewedAt;
    var seen = null;
    try {
      seen = localStorage.getItem(SEEN_KEY);
    } catch (_) {}
    if (seen === key) return;
    if (!st.live && Date.now() - st.reviewedAt > DECISION_WINDOW_MS) return;
    try {
      localStorage.setItem(SEEN_KEY, key);
    } catch (_) {}
    showDeclined(st);
  }

  function showDeclined(st) {
    if (!window.StaffUI) return;
    close();
    var m = STATUS_META.rejected;
    var body = document.createElement("div");
    var p = document.createElement("p");
    p.style.margin = "0 0 6px";
    p.textContent =
      "Your moderator application was reviewed and declined this time. This is not a punishment, and you can apply again later.";
    body.appendChild(p);
    if (st.reason) body.appendChild(staffMsgBox(st.reason, m.color));
    if (st.by) body.appendChild(byLine(st.by));
    decisionIsOpen = true;
    StaffUI.modal({
      title: "Application declined",
      icon: '<i class="fas ' + m.fa + '" style="color:' + m.color + '"></i>',
      body: body,
      onClose: function () {
        decisionIsOpen = false;
      },
      actions: [{ label: "Close", kind: "primary", onClick: function () {} }],
    });
  }

  // ── Accepting the role ────────────────────────────────────────────────────

  var acceptDialog = null;

  function rulesButton(label, tab, onOpen) {
    var b = el("button", "ma-accept-link");
    b.type = "button";
    b.innerHTML = '<i class="fas fa-book-open"></i>' + label;
    b.addEventListener("click", function () {
      if (window.TalkomaticRules) onOpen(tab);
    });
    return b;
  }

  function showAcceptance(st, state) {
    if (!window.StaffUI) return;
    if (acceptDialog) return;
    close();
    var m = STATUS_META.approved;
    var body = el("div", "ma-accept");
    body.appendChild(
      el(
        "p",
        "ma-accept-lead",
        "Your application was reviewed and accepted. Welcome to the team.",
      ),
    );
    if (st.reason) body.appendChild(staffMsgBox(st.reason, m.color));
    if (st.by) body.appendChild(byLine(st.by));

    var sec = el("div", "ma-accept-section");
    sec.appendChild(el("div", "ma-accept-title", "Before you take the role"));
    sec.appendChild(
      el(
        "p",
        null,
        "Junior moderators follow the same rules as everyone else, plus the moderator rules. Read both, then confirm below. The role is voluntary, and it can be handed back or taken back at any time.",
      ),
    );
    var links = el("div", "ma-accept-links");
    var openRules = function (tab) {
      next = "rules";
      savedAgreed = check.box.checked;
      dialog.close();
      TalkomaticRules.open({
        tab: tab,
        onClose: function () {
          showAcceptance(st, { agreed: savedAgreed });
        },
      });
    };
    links.appendChild(rulesButton("Talkomatic rules", "community", openRules));
    links.appendChild(rulesButton("Moderator rules", "mod", openRules));
    sec.appendChild(links);

    var check = checkRow(
      "I have read and understand the Talkomatic rules and the moderator rules.",
    );
    check.box.checked = !!(state && state.agreed);
    var err = el("div", "ma-err", "");
    check.box.addEventListener("change", function () {
      check.row.classList.remove("bad");
      err.textContent = "";
    });
    sec.appendChild(check.row);
    sec.appendChild(err);
    body.appendChild(sec);
    body.appendChild(
      el(
        "p",
        "ma-accept-note",
        "Not ready, or changed your mind? You can turn the role down. That is not held against you, and you can apply again later.",
      ),
    );

    var next = null;
    var savedAgreed = false;
    var busy = false;
    var dialog = StaffUI.modal({
      title: "Application approved",
      subtitle: "Read the rules, then accept the role",
      icon: '<i class="fas ' + m.fa + '" style="color:' + m.color + '"></i>',
      body: body,
      onClose: function () {
        decisionIsOpen = false;
        acceptDialog = null;
        if (next === "welcome") showWelcome();
        else if (next !== "rules" && reloadWhenClosed) window.location.reload();
      },
      actions: [
        {
          label: "Turn down",
          kind: "ghost",
          onClick: function () {
            if (busy) return false;
            StaffUI.confirm({
              title: "Turn down the role",
              message:
                "You will not get the moderator key. You can apply again another time if you change your mind.",
              confirmText: "Turn it down",
            }).then(function (ok) {
              if (!ok || busy) return;
              busy = true;
              socket.emit("mod application accept", { accept: false });
            });
            return false;
          },
        },
        {
          label: "Accept the role",
          kind: "primary",
          onClick: function () {
            if (busy) return false;
            if (!check.box.checked) {
              check.row.classList.add("bad");
              err.textContent =
                "Tick the box to confirm you have read both sets of rules.";
              return false;
            }
            busy = true;
            acceptBtn.disabled = true;
            acceptBtn.textContent = "Setting you up…";
            socket.emit("mod application accept", { accept: true, agree: true });
            return false;
          },
        },
      ],
    });
    var acceptBtn = dialog.card.querySelector(".tk-primary");
    decisionIsOpen = true;
    acceptDialog = {
      finish: function (what) {
        next = what;
        dialog.close();
      },
      reset: function () {
        busy = false;
        acceptBtn.disabled = false;
        acceptBtn.textContent = "Accept the role";
      },
    };
  }

  function showWelcome() {
    if (!window.StaffUI) return;
    decisionIsOpen = true;
    StaffUI.modal({
      title: "Welcome to the team",
      icon: '<i class="fas fa-user-shield" style="color:#57d9a3"></i>',
      body: "You are now a junior moderator. Your key is saved in this browser, and the page reloads when you close this to switch on your mod tools. Take it slow, ask a full mod when you are unsure, and use the tools on rule-breaking only.",
      onClose: function () {
        decisionIsOpen = false;
        if (reloadWhenClosed) window.location.reload();
      },
      actions: [{ label: "Let's go", kind: "primary", onClick: function () {} }],
    });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  socket.on("mod application status", function (d) {
    myStatus = d && d.has ? d : null;
    if (myStatus) maybeShowDecision(myStatus);
  });

  socket.on("applications state", function (d) {
    appsOpen = !d || d.open !== false;
  });

  socket.on("mod application accept result", function (d) {
    if (!d) return;
    if (!d.ok) {
      toast(d.error || "Could not do that right now.", "error");
      if (acceptDialog) acceptDialog.reset();
      return;
    }
    if (d.accepted) {
      if (acceptDialog) acceptDialog.finish("welcome");
      else showWelcome();
      return;
    }
    myStatus = { has: true, status: "withdrawn" };
    if (acceptDialog) acceptDialog.finish(null);
    toast("You turned down the role. You can apply again any time.", "info");
  });

  socket.on("mod application result", function (d) {
    if (!d) return;
    if (submitBtn) submitBtn.disabled = false;
    if (d.ok) {
      close();
      myStatus = { has: true, status: "pending", submittedAt: Date.now() };
      if (window.StaffUI)
        StaffUI.modal({
          title: "Application sent",
          icon: '<i class="fas fa-paper-plane" style="color:#57d9a3"></i>',
          body: "Your application is in. Staff review each application by hand, which can take a few days. You get a popup here when a decision is made, and you can check on it any time from the lobby.",
          actions: [{ label: "OK", kind: "primary", onClick: function () {} }],
        });
    } else if (isFormOpen) {
      showErr(d.error || "Could not send your application.");
    } else {
      toast(d.error || "Could not send your application.", "error");
    }
  });

  window.ModApply = {
    open: function () {
      if (viewerIsStaff()) {
        toast("You're already staff.", "info");
        return;
      }
      if (myStatus && myStatus.has) {
        socket.emit("mod application status");
        showStatus();
      } else openForm();
    },
    decisionOpen: function () {
      return decisionIsOpen;
    },
    reloadOnClose: function () {
      reloadWhenClosed = true;
    },
  };
})();
