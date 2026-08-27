// public/js/site-stats.js
// Public "Site Stats" modal for the lobby: anonymous per-day and per-month
// totals from /api/v1/daily-stats and /api/v1/monthly-stats, with
// back/forward navigation and a date picker.
(function () {
  "use strict";

  var DAY_API = "/api/v1/daily-stats";
  var MONTH_API = "/api/v1/monthly-stats";

  var MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  var built = false;
  var isOpen = false;
  var mode = "day"; // "day" | "month"
  var currentDate = null; // "YYYY-MM-DD"
  var currentMonth = null; // "YYYY-MM"
  var today = null;
  var firstDate = null;
  var thisMonth = null;
  var firstMonth = null;
  var fetchSeq = 0;

  var overlay, body, stateEl, content, dateLabel, dateInput;
  var prevBtn, nextBtn, todayBtn, dayModeBtn, monthModeBtn;

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

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function dayLabelFor(date) {
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

  function monthLabelFor(month) {
    var p = month.split("-").map(Number);
    return MONTH_NAMES[p[1] - 1] + " " + p[0];
  }

  function shortDayFor(date) {
    var p = date.split("-").map(Number);
    return MONTH_NAMES[p[1] - 1].slice(0, 3) + " " + p[2];
  }

  function shiftDate(date, days) {
    var p = date.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return (
      d.getUTCFullYear() +
      "-" +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate())
    );
  }

  function shiftMonth(month, months) {
    var p = month.split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + months, 1));
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1);
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

    var modeWrap = el("div", "ss-mode");
    dayModeBtn = el("button", "ss-mode-btn active", "Day");
    dayModeBtn.type = "button";
    dayModeBtn.addEventListener("click", function () {
      setMode("day");
    });
    monthModeBtn = el("button", "ss-mode-btn", "Month");
    monthModeBtn.type = "button";
    monthModeBtn.addEventListener("click", function () {
      setMode("month");
    });
    modeWrap.appendChild(dayModeBtn);
    modeWrap.appendChild(monthModeBtn);

    prevBtn = el("button", "ss-nav");
    prevBtn.type = "button";
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.setAttribute("aria-label", "Previous");
    prevBtn.addEventListener("click", function () {
      if (mode === "day" && currentDate) show(shiftDate(currentDate, -1));
      else if (mode === "month" && currentMonth)
        show(shiftMonth(currentMonth, -1));
    });
    nextBtn = el("button", "ss-nav");
    nextBtn.type = "button";
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.setAttribute("aria-label", "Next");
    nextBtn.addEventListener("click", function () {
      if (mode === "day" && currentDate) show(shiftDate(currentDate, 1));
      else if (mode === "month" && currentMonth)
        show(shiftMonth(currentMonth, 1));
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
      show(mode === "day" ? today || undefined : thisMonth || undefined);
    });

    datebar.appendChild(modeWrap);
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

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    dayModeBtn.classList.toggle("active", mode === "day");
    monthModeBtn.classList.toggle("active", mode === "month");
    if (mode === "day") {
      show(currentDate || today || undefined);
    } else {
      var m =
        currentMonth ||
        (currentDate ? currentDate.slice(0, 7) : null) ||
        thisMonth;
      show(m || undefined);
    }
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

  function liveSection(live) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("div", "ss-strip", "Right now"));
    frag.appendChild(
      grid([
        tile(live.usersOnline, "fa-signal", "Users online", "ss-tile-live"),
        tile(live.usersInRooms, "fa-comments", "In rooms", "ss-tile-live"),
        tile(live.activeRooms, "fa-door-open", "Open rooms", "ss-tile-live"),
      ]),
    );
    return frag;
  }

  function moderationSection(m) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("div", "ss-strip", "Moderation"));
    frag.appendChild(
      grid([
        tile(m.total, "fa-shield-halved", "Actions taken", "ss-tile-mod"),
        tile(m.warnings, "fa-triangle-exclamation", "Warnings", "ss-tile-mod"),
        tile(m.kicks, "fa-user-slash", "Kicks", "ss-tile-mod"),
        tile(m.bans, "fa-ban", "Bans", "ss-tile-mod"),
        tile(m.roomUpkeep, "fa-broom", "Room upkeep", "ss-tile-mod"),
        tile(m.queueWork, "fa-inbox", "Requests handled", "ss-tile-mod"),
      ]),
    );
    return frag;
  }

  function communitySection(c) {
    var frag = document.createDocumentFragment();
    frag.appendChild(el("div", "ss-strip", "Community"));
    frag.appendChild(
      grid([
        tile(c.reports, "fa-flag", "Reports filed", "ss-tile-com"),
        tile(c.suggestions, "fa-lightbulb", "Ideas & bugs posted", "ss-tile-com"),
        tile(c.appeals, "fa-envelope-open-text", "Ban appeals", "ss-tile-com"),
      ]),
    );
    return frag;
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

  function dayChart(days, todayStr) {
    var wrap = el("div", "ss-chart");
    wrap.appendChild(el("div", "ss-chart-title", "Sign-ins by day"));
    var bars = el("div", "ss-bars");
    var max = 0;
    days.forEach(function (d) {
      if (d.date <= todayStr) max = Math.max(max, d.signIns || 0);
    });
    days.forEach(function (d) {
      var future = d.date > todayStr;
      var n = d.signIns || 0;
      var bar = el(
        "div",
        "ss-bar" +
          (future ? " ss-bar-future" : n === 0 ? " ss-bar-zero" : ""),
      );
      bar.style.height =
        !future && max && n
          ? Math.max(4, Math.round((n / max) * 100)) + "%"
          : "2px";
      bar.title = future
        ? shortDayFor(d.date) + ": not yet"
        : shortDayFor(d.date) +
          ": " +
          n +
          (n === 1 ? " sign-in, " : " sign-ins, ") +
          (d.unique || 0) +
          (d.unique === 1 ? " person" : " people");
      bars.appendChild(bar);
    });
    wrap.appendChild(bars);
    var axis = el("div", "ss-axis");
    var last = days.length;
    [1, 8, 15, 22, last].forEach(function (t) {
      axis.appendChild(el("span", null, String(t)));
    });
    wrap.appendChild(axis);
    return wrap;
  }

  function renderDay(data) {
    content.innerHTML = "";
    if (data.live) content.appendChild(liveSection(data.live));
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
    content.appendChild(moderationSection(data.moderation));
    content.appendChild(communitySection(data.community));
  }

  function renderMonth(data) {
    content.innerHTML = "";
    if (data.live) content.appendChild(liveSection(data.live));
    content.appendChild(
      el(
        "div",
        "ss-strip",
        data.isCurrentMonth ? "People this month" : "People",
      ),
    );
    content.appendChild(
      grid([
        tile(data.people.signIns, "fa-right-to-bracket", "Sign-ins"),
        tile(data.people.unique, "fa-users", "Different people"),
        tile(data.people.nameChanges, "fa-pen", "Name changes"),
      ]),
    );
    content.appendChild(dayChart(data.days || [], data.today || ""));
    content.appendChild(moderationSection(data.moderation));
    content.appendChild(communitySection(data.community));
  }

  function syncDatebarDay(data) {
    currentDate = data.date;
    today = data.today;
    firstDate = data.firstDate;
    thisMonth = today.slice(0, 7);
    if (!firstMonth) firstMonth = firstDate.slice(0, 7);

    dateLabel.innerHTML = "";
    dateLabel.appendChild(el("i", "fas fa-calendar-days"));
    dateLabel.appendChild(
      document.createTextNode(" " + dayLabelFor(currentDate)),
    );
    if (data.isToday)
      dateLabel.appendChild(el("span", "ss-today-chip", "TODAY"));

    setDateInput("date", currentDate, firstDate, today);

    prevBtn.disabled = currentDate <= firstDate;
    nextBtn.disabled = currentDate >= today;
    todayBtn.textContent = "Today";
    todayBtn.style.display = data.isToday ? "none" : "";
  }

  function syncDatebarMonth(data) {
    currentMonth = data.month;
    thisMonth = data.thisMonth;
    firstMonth = data.firstMonth;
    today = data.today;
    if (!firstDate) firstDate = firstMonth + "-01";

    dateLabel.innerHTML = "";
    dateLabel.appendChild(el("i", "fas fa-calendar-days"));
    dateLabel.appendChild(
      document.createTextNode(" " + monthLabelFor(currentMonth)),
    );
    if (data.isCurrentMonth)
      dateLabel.appendChild(el("span", "ss-today-chip", "THIS MONTH"));

    setDateInput("month", currentMonth, firstMonth, thisMonth);

    prevBtn.disabled = currentMonth <= firstMonth;
    nextBtn.disabled = currentMonth >= thisMonth;
    todayBtn.textContent = "This month";
    todayBtn.style.display = data.isCurrentMonth ? "none" : "";
  }

  function setDateInput(type, value, min, max) {
    dateInput.type = type;
    // Browsers without native month pickers fall back to a text input, which
    // is useless here, so hide it and leave the arrows.
    var supported = dateInput.type === type;
    dateInput.style.display = supported ? "" : "none";
    if (!supported) return;
    dateInput.min = min;
    dateInput.max = max;
    dateInput.value = value;
  }

  // ── data ──────────────────────────────────────────────────────────────────

  function show(key) {
    var seq = ++fetchSeq;
    var forMonth = mode === "month";
    var hasContent = content.style.display !== "none";

    if (hasContent) {
      content.classList.add("ss-refreshing");
    } else {
      stateEl.textContent = "Loading…";
      stateEl.classList.remove("ss-error");
      stateEl.style.display = "";
    }

    var url = forMonth
      ? MONTH_API + (key ? "?month=" + encodeURIComponent(key) : "")
      : DAY_API + (key ? "?date=" + encodeURIComponent(key) : "");
    fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (seq !== fetchSeq) return;
        if (!data || !data.ok) throw new Error("bad payload");
        // Ignore a stale response if the mode changed mid-flight.
        if (forMonth !== (mode === "month")) return;
        if (forMonth) {
          syncDatebarMonth(data);
          renderMonth(data);
        } else {
          syncDatebarDay(data);
          renderDay(data);
        }
        content.classList.remove("ss-refreshing");
        stateEl.style.display = "none";
        content.style.display = "";
      })
      .catch(function () {
        if (seq !== fetchSeq) return;
        content.classList.remove("ss-refreshing");
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
    show(mode === "day" ? currentDate || undefined : currentMonth || undefined);
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
