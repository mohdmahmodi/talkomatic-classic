// public/js/site-stats.js
// Public "Site Stats" modal for the lobby: anonymous per-day totals from
// /api/v1/daily-stats, with back/forward date navigation.
(function () {
  "use strict";

  var API = "/api/v1/daily-stats";

  var built = false;
  var isOpen = false;
  var current = null; // "YYYY-MM-DD" being shown
  var today = null;
  var firstDate = null;
  var fetchSeq = 0;

  var overlay, body, stateEl, content, dateLabel, dateInput;
  var prevBtn, nextBtn, todayBtn;

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString("en-US");
  }

  function labelFor(date) {
    var p = date.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function shiftDate(date, days) {
    var p = date.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getUTCFullYear() +
      "-" +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate())
    );
  }

  // ── modal skeleton ────────────────────────────────────────────────────────

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "ss-overlay");
    overlay.id = "siteStatsOverlay";

    var modal = el("div", "ss-modal");

    var head = el("div", "ss-head");
    var titleWrap = el("div", "ss-title-wrap");
    var title = el("div", "ss-title");
    title.innerHTML = '<i class="fas fa-chart-column"></i> Site Stats';
    var sub = el("div", "ss-sub", "What happened on Talkomatic, day by day.");
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    var closeBtn = el("button", "ss-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);
    head.appendChild(titleWrap);
    head.appendChild(closeBtn);

    var datebar = el("div", "ss-datebar");
    prevBtn = el("button", "ss-nav");
    prevBtn.type = "button";
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.setAttribute("aria-label", "Previous day");
    prevBtn.addEventListener("click", function () {
      if (current) show(shiftDate(current, -1));
    });
    nextBtn = el("button", "ss-nav");
    nextBtn.type = "button";
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.setAttribute("aria-label", "Next day");
    nextBtn.addEventListener("click", function () {
      if (current) show(shiftDate(current, 1));
    });

    var dateWrap = el("div", "ss-date-wrap");
    dateLabel = el("span", "ss-date-label");
    dateInput = el("input", "ss-date-input");
    dateInput.type = "date";
    dateInput.setAttribute("aria-label", "Pick a date");
    dateInput.addEventListener("change", function () {
      if (dateInput.value) show(dateInput.value);
    });
    dateWrap.appendChild(dateLabel);
    dateWrap.appendChild(dateInput);

    todayBtn = el("button", "ss-today-btn", "Today");
    todayBtn.type = "button";
    todayBtn.addEventListener("click", function () {
      show(today || undefined);
    });

    datebar.appendChild(prevBtn);
    datebar.appendChild(dateWrap);
    datebar.appendChild(nextBtn);
    datebar.appendChild(todayBtn);

    body = el("div", "ss-body");
    stateEl = el("div", "ss-state", "Loading…");
    content = el("div", "ss-content");
    content.style.display = "none";
    body.appendChild(stateEl);
    body.appendChild(content);

    var foot = el(
      "div",
      "ss-foot",
      "Anonymous totals only. Days follow US Pacific time.",
    );

    modal.appendChild(head);
    modal.appendChild(datebar);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) close();
    });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function tile(value, icon, label, extraClass) {
    var t = el("div", "ss-tile" + (extraClass ? " " + extraClass : ""));
    t.appendChild(el("div", "ss-tile-val", fmtNum(value)));
    var l = el("div", "ss-tile-label");
    l.innerHTML = '<i class="fas ' + icon + '"></i>' + label;
    t.appendChild(l);
    return t;
  }

  function grid(tiles) {
    var g = el("div", "ss-grid");
    tiles.forEach(function (t) {
      g.appendChild(t);
    });
    return g;
  }

  function hourChart(byHour) {
    var wrap = el("div", "ss-chart");
    wrap.appendChild(el("div", "ss-chart-title", "Sign-ins by hour"));
    var bars = el("div", "ss-bars");
    var max = 0;
    for (var i = 0; i < 24; i++) max = Math.max(max, byHour[i] || 0);
    for (var h = 0; h < 24; h++) {
      var n = byHour[h] || 0;
      var bar = el("div", "ss-bar" + (n === 0 ? " ss-bar-zero" : ""));
      bar.style.height = max
        ? Math.max(4, Math.round((n / max) * 100)) + "%"
        : "2px";
      var ampm =
        h === 0
          ? "12am"
          : h < 12
            ? h + "am"
            : h === 12
              ? "12pm"
              : h - 12 + "pm";
      bar.title = n + (n === 1 ? " sign-in" : " sign-ins") + " at " + ampm;
      bars.appendChild(bar);
    }
    wrap.appendChild(bars);
    var axis = el("div", "ss-axis");
    ["12am", "6am", "12pm", "6pm", "11pm"].forEach(function (t) {
      axis.appendChild(el("span", null, t));
    });
    wrap.appendChild(axis);
    return wrap;
  }

  function render(data) {
    content.innerHTML = "";

    if (data.live) {
      content.appendChild(el("div", "ss-strip", "Right now"));
      content.appendChild(
        grid([
          tile(data.live.usersOnline, "fa-signal", "Users online", "ss-tile-live"),
          tile(data.live.usersInRooms, "fa-comments", "In rooms", "ss-tile-live"),
          tile(data.live.activeRooms, "fa-door-open", "Open rooms", "ss-tile-live"),
        ]),
      );
    }

    content.appendChild(
      el("div", "ss-strip", data.isToday ? "People today" : "People"),
    );
    content.appendChild(
      grid([
        tile(data.people.signIns, "fa-right-to-bracket", "Sign-ins"),
        tile(data.people.unique, "fa-users", "Different people"),
        tile(data.people.nameChanges, "fa-pen", "Name changes"),
      ]),
    );
    content.appendChild(hourChart(data.people.byHour || []));

    content.appendChild(el("div", "ss-strip", "Moderation"));
    content.appendChild(
      grid([
        tile(data.moderation.total, "fa-shield-halved", "Actions taken", "ss-tile-mod"),
        tile(data.moderation.warnings, "fa-triangle-exclamation", "Warnings", "ss-tile-mod"),
        tile(data.moderation.kicks, "fa-user-slash", "Kicks", "ss-tile-mod"),
        tile(data.moderation.bans, "fa-ban", "Bans", "ss-tile-mod"),
        tile(data.moderation.roomUpkeep, "fa-broom", "Room upkeep", "ss-tile-mod"),
        tile(data.moderation.queueWork, "fa-inbox", "Requests handled", "ss-tile-mod"),
      ]),
    );

    content.appendChild(el("div", "ss-strip", "Community"));
    content.appendChild(
      grid([
        tile(data.community.reports, "fa-flag", "Reports filed", "ss-tile-com"),
        tile(data.community.suggestions, "fa-lightbulb", "Ideas & bugs posted", "ss-tile-com"),
        tile(data.community.appeals, "fa-envelope-open-text", "Ban appeals", "ss-tile-com"),
      ]),
    );
  }

  function syncDatebar(data) {
    current = data.date;
    today = data.today;
    firstDate = data.firstDate;

    dateLabel.innerHTML = "";
    var cal = el("i", "fas fa-calendar-days");
    dateLabel.appendChild(cal);
    dateLabel.appendChild(document.createTextNode(" " + labelFor(current)));
    if (data.isToday) dateLabel.appendChild(el("span", "ss-today-chip", "TODAY"));

    dateInput.value = current;
    dateInput.min = firstDate;
    dateInput.max = today;

    prevBtn.disabled = current <= firstDate;
    nextBtn.disabled = current >= today;
    todayBtn.style.display = data.isToday ? "none" : "";
  }

  // ── data ──────────────────────────────────────────────────────────────────

  function show(date) {
    var seq = ++fetchSeq;
    stateEl.textContent = "Loading…";
    stateEl.classList.remove("ss-error");
    stateEl.style.display = "";
    content.style.display = "none";

    var url = API + (date ? "?date=" + encodeURIComponent(date) : "");
    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (seq !== fetchSeq || !data || !data.ok) {
          if (seq === fetchSeq) throw new Error("bad payload");
          return;
        }
        syncDatebar(data);
        render(data);
        stateEl.style.display = "none";
        content.style.display = "";
      })
      .catch(function () {
        if (seq !== fetchSeq) return;
        stateEl.textContent = "Could not load stats. Try again in a moment.";
        stateEl.classList.add("ss-error");
        stateEl.style.display = "";
        content.style.display = "none";
      });
  }

  // ── open / close ──────────────────────────────────────────────────────────

  function open() {
    build();
    isOpen = true;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    show(current || undefined);
  }

  function close() {
    isOpen = false;
    if (overlay) overlay.classList.remove("show");
    document.body.style.overflow = "";
  }

  function init() {
    var link = document.getElementById("siteStatsLink");
    if (link)
      link.addEventListener("click", function (e) {
        e.preventDefault();
        open();
      });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();

  window.SiteStats = { open: open, close: close };
})();
