// public/js/mod.js
// Talkomatic moderation dashboard.

(function () {
  const socket = io({
    transports: ["websocket"],
    upgrade: false,
    auth: {
      devKey: localStorage.getItem("talkomatic_devKey") || undefined,
      modKey: localStorage.getItem("talkomatic_modKey") || undefined,
      deviceId:
        (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
        undefined,
      app: "modlog",
    },
  });

  if (window.TalkoDesk) window.TalkoDesk.init(socket);
  // The rule picker in StaffUI reads the community rules over this socket.
  window.socket = socket;

  const $ = (id) => document.getElementById(id);
  const loadingEl = $("loading");
  const deniedEl = $("denied");
  const appEl = $("app");
  const listEl = $("list");
  const searchEl = $("search");
  const meEl = $("meInfo");
  const rosterEl = $("roster");
  const focusBar = $("focusBar");
  const feedNote = $("feedNote");

  let entries = [];
  const commentsByRef = new Map();
  let me = null;
  let authorized = false;
  let tab = "activity";
  let feedFilter = "all";
  let query = "";
  let focusUid = null;
  let unreadNotifs = 0;
  let applicationsList = [];
  let appsPage = 0;
  let appsFilter = "pending";
  let appsQuery = "";
  let applicationsOpen = true;
  const APPS_PAGE = 8;
  let reportsList = [];
  let appealsList = [];
  let suggestionsList = [];

  const PACIFIC_FMT = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (_) {
      return null;
    }
  })();
  function startOfPacificDay(now = Date.now()) {
    if (!PACIFIC_FMT) return 0;
    try {
      const partsAt = (t) =>
        PACIFIC_FMT.formatToParts(new Date(t)).reduce(
          (a, p) => ((a[p.type] = p.value), a),
          {},
        );
      const offsetAt = (t) => {
        const p = partsAt(t);
        return (
          Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
          Math.floor(t / 1000) * 1000
        );
      };
      const today = partsAt(now);
      const localMidnight = Date.UTC(+today.year, +today.month - 1, +today.day);
      let guess = localMidnight - offsetAt(now);
      guess = localMidnight - offsetAt(guess);
      return guess;
    } catch (_) {
      return 0;
    }
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  function weekDayStarts(now = Date.now()) {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const s = startOfPacificDay(now - i * DAY_MS);
      if (!out.length || s !== out[out.length - 1]) out.push(s);
    }
    return out;
  }
  let weekDays = weekDayStarts();
  let dayIndex = weekDays.length - 1;
  let dayStart = weekDays[dayIndex];
  function dayEnd() {
    return dayIndex < weekDays.length - 1 ? weekDays[dayIndex + 1] : Infinity;
  }
  const isToday = () => dayIndex === weekDays.length - 1;

  function pacificParts(ts, opts) {
    try {
      return new Intl.DateTimeFormat(
        "en-US",
        Object.assign({ timeZone: "America/Los_Angeles" }, opts),
      ).format(new Date(ts));
    } catch (_) {
      return "";
    }
  }
  const pacificDayLabel = (ts = Date.now()) =>
    pacificParts(ts, { weekday: "long", month: "long", day: "numeric" }) ||
    "today";

  const DOM_CAP = 250;
  let pendingNew = [];
  let flushTimer = null;

  const CAT = {
    security: {
      color: "#ff5468",
      icon: "fa-user-secret",
      label:
        "Security: a staff key used from a new IP, or from several IPs at once",
    },
    destructive: {
      color: "#ff5468",
      icon: "fa-triangle-exclamation",
      label: "Destructive: kick, ban, IP block, close, nuke, freeze, wipe",
    },
    moderation: {
      color: "#ffb454",
      icon: "fa-gavel",
      label: "Moderation: warn, rename, lock, slow, clear board",
    },
    broadcast: {
      color: "#5aa9ff",
      icon: "fa-bullhorn",
      label: "Broadcast: megaphone, ticker, spotlight, party",
    },
    config: {
      color: "#c08bff",
      icon: "fa-sliders",
      label: "Config and roles: flags, room size, maintenance, grant or revoke",
    },
    signin: {
      color: "#57d9a3",
      icon: "fa-right-to-bracket",
      label: "Identity: a user signed in",
    },
    namechange: {
      color: "#ffb454",
      icon: "fa-user-pen",
      label: "Identity: a name changed or was reset",
    },
    notification: {
      color: "#ff9800",
      icon: "fa-bell",
      label:
        "Inbox: reports, appeals, applications, and abuse flags, each at the level that handles it",
    },
    other: {
      color: "#6b7080",
      icon: "fa-circle-info",
      label: "Other: spectate, staff login, mod note",
    },
  };

  function categorize(e) {
    if (e.type === "security") return "security";
    if (e.type === "notification") return "notification";
    if (e.type === "identity")
      return e.event === "signin" ? "signin" : "namechange";
    const a = (e.action || "").toLowerCase();
    if (/kick|ban|ip block|close room|nuke|freeze|wipe/.test(a))
      return "destructive";
    if (/warn|rename|lock|slow mode|clear board/.test(a)) return "moderation";
    if (/megaphone|ticker|spotlight|party/.test(a)) return "broadcast";
    if (
      /flag|maintenance|grant mod|revoke mod|blacklist|unblock|room size|make mod/.test(
        a,
      )
    )
      return "config";
    return "other";
  }

  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  };
  function span(cls, text) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }
  function icon(faClass, cls) {
    const i = document.createElement("i");
    i.className = "fas " + faClass + (cls ? " " + cls : "");
    return i;
  }
  function divc(cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    return d;
  }
  function emptyBox(faClass, text) {
    const e = divc("empty");
    e.appendChild(icon(faClass));
    e.appendChild(document.createTextNode(text));
    return e;
  }
  function initialOf(name) {
    return (
      String(name || "?")
        .trim()
        .charAt(0) || "?"
    ).toUpperCase();
  }
  function parseTarget(target) {
    const m = /^user:(.*)\(([^)]*)\)$/.exec(target || "");
    return m ? { name: m[1], uid: m[2] } : null;
  }
  function uref(name, uid) {
    const s = span("uref", name);
    if (uid) {
      s.dataset.uid = uid;
      s.title = "Trace this user";
      s.addEventListener("click", () => {
        setFocus(uid);
        switchTab("activity");
      });
    }
    return s;
  }
  // One set of plain words for the snapshot grades, used on the record, the
  // activity cards and the help page alike.
  const GRADE_LABEL = {
    corroborated: "backed up",
    reported: "reported by users",
    unverifiable: "nothing captured",
    contradicted: "nothing behind it",
    none: "no snapshot",
  };
  const GRADE_HELP = {
    corroborated:
      "What they had typed, their history, or an earlier step by staff supports this action.",
    reported: "Other users had reported or disliked them shortly before.",
    unverifiable:
      "Nothing was captured that confirms or contradicts it. In live typing the line may already have been gone.",
    contradicted:
      "A heavy punishment with an empty or clean box, no reports, no earlier step by anyone, and no reason written.",
    none: "From before snapshots existed. Never counted in anything.",
  };
  function gradeLabel(grade) {
    return GRADE_LABEL[grade] || GRADE_LABEL.none;
  }

  function writeupNode(j) {
    const box = divc("writeup");
    (window.StaffUI ? StaffUI.writeupLines(j) : []).forEach((line) =>
      box.appendChild(span("wu-line", line)),
    );
    return box;
  }

  function kvRow(k, v, vClass, uid) {
    if (v == null || v === "") return null;
    const row = divc("kv");
    row.appendChild(span("k", k));
    const val =
      typeof v === "object"
        ? v
        : uid
          ? uref(String(v), uid)
          : span(null, String(v));
    val.classList.add("v");
    if (vClass) val.classList.add(vClass);
    row.appendChild(val);
    return row;
  }
  function addKv(parent, k, v, vClass, uid) {
    const row = kvRow(k, v, vClass, uid);
    if (row) parent.appendChild(row);
  }

  const ROLE_CHIP = {
    dev: ["dev", "ADMIN"],
    lead: ["l3", "LEADER"],
    mod: ["l2", "MOD"],
    jr: ["l1", "JR MOD"],
  };
  function whoWithRole(name, role, uid) {
    const wrap = span("whorole");
    wrap.appendChild(uid ? uref(String(name), uid) : span(null, String(name)));
    const chip = ROLE_CHIP[role];
    if (chip) {
      wrap.appendChild(document.createTextNode(" "));
      wrap.appendChild(span("chip " + chip[0], chip[1]));
    }
    return wrap;
  }
  function staffLine(role) {
    if (role === "dev") return "yes - admin";
    if (role === "lead") return "yes - mod leader";
    if (role === "mod") return "yes - full moderator";
    if (role === "jr") return "yes - junior moderator";
    if (role) return "yes - " + role;
    return "no - ordinary user";
  }
  function searchable(e) {
    const base = [
      e.role,
      e.label,
      e.action,
      e.event,
      e.target,
      e.room,
      e.ip,
      e.details,
      e.username,
      e.prevUsername,
      e.userId,
      e.by,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const cmts = (commentsByRef.get(e.id) || [])
      .map((c) => c.text)
      .join(" ")
      .toLowerCase();
    return base + " " + cmts;
  }
  function matchesFocus(e, uid) {
    if (e.type === "identity") return e.userId === uid;
    if (e.type === "action") {
      const t = parseTarget(e.target);
      return t && t.uid === uid;
    }
    return false;
  }
  function passes(e) {
    const ts = e.ts || 0;
    if (dayStart && ts < dayStart) return false;
    if (ts >= dayEnd()) return false;
    if (feedFilter !== "all" && e.type !== feedFilter) return false;
    if (focusUid && !matchesFocus(e, focusUid)) return false;
    if (query && !searchable(e).includes(query)) return false;
    return true;
  }

  function buildCard(e) {
    const cat = categorize(e);
    const card = document.createElement("div");
    card.className = "entry cat-" + cat;
    card.dataset.id = e.id;

    const top = divc("e-top");
    const ico = divc("ico");
    ico.appendChild(icon(CAT[cat].icon));
    top.appendChild(ico);
    const head = divc("e-head");
    const title = divc("e-title");

    if (e.type === "security") {
      title.appendChild(span("chip dev", "ALERT"));
      title.appendChild(document.createTextNode(" "));
      title.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      title.appendChild(document.createTextNode(" "));
      title.appendChild(
        span(
          "act",
          e.kind === "concurrent"
            ? "key in use from multiple IPs"
            : "key used from a new IP",
        ),
      );
    } else if (e.type === "action") {
      title.appendChild(
        span(
          "chip " + (e.role === "dev" ? "dev" : "mod"),
          (e.role || "?").toUpperCase(),
        ),
      );
      title.appendChild(document.createTextNode(" "));
      title.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      title.appendChild(document.createTextNode(" "));
      title.appendChild(span("act", e.action || "?"));
    } else if (e.type === "notification") {
      title.appendChild(span("chip mod", (e.kind || "notice").toUpperCase()));
      title.appendChild(document.createTextNode(" "));
      if (e.by || e.label) {
        title.appendChild(span("who", e.by || e.label));
        title.appendChild(document.createTextNode(" "));
      }
      title.appendChild(
        span(
          "act",
          e.kind === "abuse"
            ? "possible mod abuse"
            : e.kind === "application"
              ? "mod application"
              : e.kind === "suggestion"
                ? "feature suggestion"
                : "user report",
        ),
      );
    } else {
      title.appendChild(uref(e.username || "?", e.userId));
      const evt =
        e.event === "rename"
          ? "changed name"
          : e.event === "forced-rename"
            ? "force-renamed by staff"
            : "signed in";
      title.appendChild(document.createTextNode(" "));
      title.appendChild(span("act", evt));
    }
    head.appendChild(title);
    const when = divc("e-when");
    when.textContent = relTime(e.ts) || fmtTime(e.ts);
    when.title = fmtTime(e.ts);
    head.appendChild(when);
    top.appendChild(head);
    if (me && me.role === "dev" && e.id) {
      const del = document.createElement("button");
      del.className = "e-del";
      del.type = "button";
      del.title = "Delete this entry";
      del.appendChild(icon("fa-trash"));
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteActivity([e]);
      });
      top.appendChild(del);
    }
    card.appendChild(top);

    const body = divc("e-body");
    if (e.type === "security") {
      addKv(body, "Key", e.label);
      addKv(body, "Role", e.role);
      addKv(body, "Kind", e.kind === "concurrent" ? "same key, several IPs" : "new IP");
      addKv(body, "IP", e.ip, "ip");
      addKv(body, "When", fmtTime(e.ts), "dimv");
    } else if (e.type === "action") {
      const t = parseTarget(e.target);
      if (t) {
        addKv(body, "Target", uref(t.name, t.uid));
        addKv(body, "Target id", t.uid, "dimv", t.uid);
      } else {
        addKv(body, "Target", e.target);
      }
      addKv(body, "Room", e.room, "dimv");
      addKv(body, "Staff", e.label, "dimv");
      addKv(body, "Staff IP", e.ip, "ip");
      addKv(body, "When", fmtTime(e.ts), "dimv");
      if (e.receipt) {
        const r = e.receipt;
        if (r.text && !/text before wipe/.test(e.details || ""))
          addKv(body, "They had typed", r.text, "quote");
        addKv(body, "Snapshot", gradeLabel(r.grade), "grade-" + r.grade);
        if (r.reports && r.reports.hour)
          addKv(body, "Reports", r.reports.hour + " in the hour before", "dimv");
        if (r.dislikes) addKv(body, "Dislikes", String(r.dislikes), "dimv");
        if (r.prior && r.prior.length)
          addKv(
            body,
            "Before this",
            r.prior.map((p) => p.action + " by " + p.by).join(", "),
            "dimv",
          );
      }
      if (e.justify && e.justify.at)
        addKv(body, "Write-up", writeupNode(e.justify));
      else if (e.justify && e.justify.required)
        addKv(body, "Write-up", "not written yet", "warnv");
    } else if (e.type === "notification") {
      const tn = parseTarget(e.target);
      if (tn) {
        addKv(body, "About", whoWithRole(tn.name, e.targetRole, tn.uid));
        addKv(body, "Their id", tn.uid, "dimv", tn.uid);
      } else if (e.target) {
        addKv(body, "About", e.target);
      }
      if (e.target) addKv(body, "Staff", staffLine(e.targetRole), "dimv");
      addKv(body, "Their IP", e.targetIp, "ip");

      const raiser = e.by || e.label;
      const raiserRole = e.by ? e.byRole : e.role || e.byRole;
      if (raiser) {
        addKv(
          body,
          "Raised by",
          whoWithRole(raiser, raiserRole, e.byUserId || null),
        );
        addKv(body, "Raiser id", e.byUserId, "dimv", e.byUserId || null);
        addKv(body, "Raiser staff", staffLine(raiserRole), "dimv");
        addKv(body, "Raiser IP", e.ip, "ip");
      }
      addKv(body, "Room", e.room, "dimv");
      addKv(
        body,
        "Reports",
        e.reports ? e.reports + " recently" : null,
        "dimv",
      );
      addKv(body, "When", fmtTime(e.ts), "dimv");
    } else {
      addKv(body, "Was", e.prevUsername, "dimv");
      addKv(body, "Location", e.location, "dimv");
      addKv(
        body,
        "Was at",
        e.prevLocation && e.prevLocation !== e.location ? e.prevLocation : null,
        "dimv",
      );
      addKv(body, "Their IP", e.ip, "ip");
      addKv(body, "User id", e.userId, "dimv", e.userId);
      addKv(body, "Room", e.room, "dimv");
      addKv(body, "By", e.by, "dimv");
      addKv(body, "When", fmtTime(e.ts), "dimv");
    }
    if (body.childNodes.length) card.appendChild(body);

    const detailText =
      e.details || e.detail || (e.type === "notification" ? e.text : null);
    if (detailText) {
      const d = document.createElement("div");
      d.className = "detail";
      d.textContent = detailText;
      card.appendChild(d);
    }

    const thread = document.createElement("div");
    thread.className = "comments";
    thread.style.display = "none";
    card.appendChild(thread);
    (commentsByRef.get(e.id) || []).forEach((c) => appendComment(card, c));

    const box = document.createElement("div");
    box.className = "cmtbox";
    const input = document.createElement("input");
    input.placeholder = "Add a note or ask a question";
    input.maxLength = 500;
    const send = document.createElement("button");
    send.className = "btn sm";
    send.appendChild(icon("fa-paper-plane"));
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      socket.emit("audit comment", { entryId: e.id, text });
      input.value = "";
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
    });
    box.appendChild(input);
    box.appendChild(send);
    card.appendChild(box);

    return card;
  }

  async function deleteActivity(list) {
    const ids = list.map((e) => e.id).filter(Boolean);
    if (!ids.length) return;
    const many = ids.length > 1;
    if (window.StaffUI) {
      const ok = await StaffUI.confirm({
        title: many ? "Delete " + ids.length + " entries" : "Delete entry",
        message: many
          ? "Remove these " +
            ids.length +
            " entries from the activity board and the Desk. This cannot be undone."
          : "Remove this entry from the activity board and the Desk. This cannot be undone.",
        danger: true,
        confirmText: "Delete",
      });
      if (!ok) return;
    }
    socket.emit("staff delete activity", { ids });
  }

  function dropEntries(ids) {
    const gone = new Set(ids.map(Number));
    if (!gone.size) return;
    entries = entries.filter((e) => !gone.has(Number(e.id)));
    pendingNew = pendingNew.filter((e) => !gone.has(Number(e.id)));
    for (const id of gone) commentsByRef.delete(id);
    gone.forEach((id) => {
      const card = listEl.querySelector('.entry[data-id="' + id + '"]');
      if (card) card.remove();
    });
    renderDayPicker();
    if (tab === "activity") renderActivity();
  }

  function appendComment(card, c) {
    const thread = card.querySelector(".comments");
    if (!thread) return;
    thread.style.display = "block";
    const row = document.createElement("div");
    row.className = "cmt";
    row.appendChild(
      span(
        "cwho " + (c.role === "dev" ? "dev" : "mod"),
        (c.label || "?") + ":",
      ),
    );
    row.appendChild(span("ctext", c.text));
    row.appendChild(span("cwhen", fmtTime(c.ts)));
    thread.appendChild(row);
  }

  let activityToken = 0;
  function renderActivity() {
    pendingNew = [];
    listEl.textContent = "";
    renderDayPicker();
    const token = ++activityToken;
    const matches = entries.filter((e) => e.type !== "comment" && passes(e));
    if (matches.length === 0) {
      feedNote.classList.add("hidden");
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-inbox"));
      empty.appendChild(document.createTextNode("No matching entries."));
      listEl.appendChild(empty);
      return;
    }
    const shown = matches.slice(-DOM_CAP);
    updateFeedNote(matches.length);
    let i = shown.length - 1;
    (function chunk() {
      if (token !== activityToken) return;
      for (let n = 0; i >= 0 && n < 40; i--, n++)
        listEl.appendChild(buildCard(shown[i]));
      if (i >= 0) requestAnimationFrame(chunk);
    })();
  }

  function updateFeedNote(total) {
    if (total > DOM_CAP) {
      feedNote.classList.remove("hidden");
      feedNote.textContent =
        "Showing the latest " +
        DOM_CAP +
        " of " +
        total +
        " matching entries. Use search to narrow down.";
    } else {
      feedNote.classList.add("hidden");
    }
  }

  function updateDayLabel() {
    const el = $("dayLabel");
    if (!el) return;
    el.textContent =
      pacificDayLabel(dayStart) +
      (isToday() ? " (today)" : "") +
      ", 12:00am to 11:59pm Pacific";
  }

  function countForDay(i) {
    const from = weekDays[i];
    const to = i < weekDays.length - 1 ? weekDays[i + 1] : Infinity;
    let n = 0;
    for (const e of entries) {
      if (e.type === "comment") continue;
      const ts = e.ts || 0;
      if (ts < from || ts >= to) continue;
      if (feedFilter !== "all" && e.type !== feedFilter) continue;
      if (focusUid && !matchesFocus(e, focusUid)) continue;
      if (query && !searchable(e).includes(query)) continue;
      n++;
    }
    return n;
  }

  function renderDayPicker() {
    const host = $("dayPicker");
    if (!host) return;
    host.textContent = "";
    weekDays.forEach((start, i) => {
      const b = document.createElement("button");
      b.className = "daybtn" + (i === dayIndex ? " active" : "");
      b.type = "button";
      const top = span("dayname", pacificParts(start, { weekday: "short" }));
      const mid = span("daynum", pacificParts(start, { month: "numeric", day: "numeric" }));
      const n = countForDay(i);
      const bot = span("daycount" + (n ? "" : " zero"), n ? String(n) : "-");
      b.appendChild(top);
      b.appendChild(mid);
      b.appendChild(bot);
      b.title =
        pacificDayLabel(start) +
        " - " +
        (n === 1 ? "1 entry" : n + " entries") +
        (i === weekDays.length - 1 ? " (today, still live)" : "");
      b.addEventListener("click", () => selectDay(i));
      host.appendChild(b);
    });
  }

  function setCompact(on) {
    document.body.classList.toggle("compact", !!on);
    try {
      localStorage.setItem("talkomatic_modCompact", on ? "1" : "0");
    } catch (_) {
    }
    const seg = $("viewSeg");
    if (seg)
      seg.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", (b.dataset.view === "compact") === !!on),
      );
  }
  (function initCompact() {
    let saved = "0";
    try {
      saved = localStorage.getItem("talkomatic_modCompact") || "0";
    } catch (_) {
      saved = "0";
    }
    setCompact(saved === "1");
    const seg = $("viewSeg");
    if (seg)
      seg.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () =>
          setCompact(b.dataset.view === "compact"),
        ),
      );
  })();

  function selectDay(i) {
    const next = Math.max(0, Math.min(weekDays.length - 1, i));
    if (next === dayIndex) return;
    dayIndex = next;
    dayStart = weekDays[dayIndex];
    updateDayLabel();
    renderActivity();
  }

  function checkDayRollover() {
    const fresh = weekDayStarts();
    if (fresh[fresh.length - 1] === weekDays[weekDays.length - 1]) return;
    const wasReading = weekDays[dayIndex];
    weekDays = fresh;
    const stillThere = weekDays.indexOf(wasReading);
    dayIndex = stillThere >= 0 ? stillThere : weekDays.length - 1;
    dayStart = weekDays[dayIndex];
    entries = entries.filter((e) => (e.ts || 0) >= weekDays[0]);
    commentsByRef.clear();
    for (const e of entries)
      if (e.type === "comment" && e.refId) {
        if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
        commentsByRef.get(e.refId).push(e);
      }
    updateDayLabel();
    renderDayPicker();
    if (tab === "activity") renderActivity();
  }
  setInterval(checkDayRollover, 30000);

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 450);
  }
  function flushPending() {
    if (tab !== "activity") {
      pendingNew = [];
      return;
    }
    const toShow = pendingNew.filter(passes);
    pendingNew = [];
    if (toShow.length === 0) return;
    const empty = listEl.querySelector(".empty");
    if (empty) empty.remove();
    for (let i = 0; i < toShow.length; i++) {
      listEl.insertBefore(buildCard(toShow[i]), listEl.firstChild);
    }
    let cards = listEl.querySelectorAll(".entry");
    for (let i = cards.length - 1; i >= DOM_CAP; i--) cards[i].remove();
    const totalMatches = entries.filter(
      (e) => e.type !== "comment" && passes(e),
    ).length;
    updateFeedNote(totalMatches);
    renderDayPicker();
  }

  function setFocus(uid) {
    focusUid = uid || null;
    if (!focusUid) {
      focusBar.classList.add("hidden");
      focusBar.textContent = "";
      renderActivity();
      return;
    }
    const s = userSummary(focusUid);
    focusBar.classList.remove("hidden");
    focusBar.textContent = "";
    focusBar.appendChild(icon("fa-crosshairs"));
    focusBar.appendChild(span(null, " Tracing "));
    focusBar.appendChild(span("mono", focusUid));
    const sum = span("sum");
    sum.appendChild(document.createTextNode("   names: "));
    sum.appendChild(boldList(s.names));
    sum.appendChild(document.createTextNode("   locations: "));
    sum.appendChild(boldList(s.locations));
    sum.appendChild(document.createTextNode("   IPs: "));
    sum.appendChild(boldList(s.ips));
    sum.appendChild(document.createTextNode("   actions against them: "));
    const b = document.createElement("b");
    b.textContent = String(s.actionsAgainst);
    sum.appendChild(b);
    focusBar.appendChild(sum);
    // Act straight from the trace: works whether they are online or long
    // gone, and without anybody having reported them first.
    const act = span("focus-actions");
    const traced = {
      targetUserId: focusUid,
      name: s.names.length ? s.names[0] : null,
      online: false,
    };
    const mkFocusBtn = (label, fa, fn) => {
      const btn = document.createElement("button");
      btn.className = "btn sm";
      btn.appendChild(icon(fa));
      btn.appendChild(document.createTextNode(" " + label));
      btn.addEventListener("click", fn);
      return btn;
    };
    act.appendChild(
      mkFocusBtn("Warn", "fa-triangle-exclamation", () => warnReported(traced)),
    );
    if (viewerIsFullMod())
      act.appendChild(
        mkFocusBtn("IP block", "fa-ban", () => openReportBanMenu(traced)),
      );
    focusBar.appendChild(act);
    const clear = document.createElement("button");
    clear.className = "btn sm";
    clear.appendChild(icon("fa-xmark"));
    clear.appendChild(document.createTextNode(" Clear"));
    clear.addEventListener("click", () => setFocus(null));
    focusBar.appendChild(clear);
    renderActivity();
  }
  function boldList(arr) {
    const b = document.createElement("b");
    b.textContent = arr.length ? arr.join(", ") : "none";
    return b;
  }
  function userSummary(uid) {
    const names = new Set(),
      ips = new Set(),
      locations = new Set();
    let actionsAgainst = 0;
    for (const e of entries) {
      if (e.type === "identity" && e.userId === uid) {
        if (e.username) names.add(e.username);
        if (e.prevUsername) names.add(e.prevUsername);
        if (e.ip) ips.add(e.ip);
        if (e.location) locations.add(e.location);
        if (e.prevLocation) locations.add(e.prevLocation);
      } else if (e.type === "action") {
        const t = parseTarget(e.target);
        if (t && t.uid === uid) actionsAgainst++;
      }
    }
    return {
      names: [...names],
      ips: [...ips],
      locations: [...locations],
      actionsAgainst,
    };
  }

  function renderRoster(roster) {
    rosterEl.textContent = "";
    if (!roster) return;
    const d = document.createElement("b");
    d.textContent = "Devs: ";
    d.style.color = "var(--red)";
    rosterEl.appendChild(d);
    rosterEl.appendChild(
      document.createTextNode((roster.devs || []).join(", ") || "none"),
    );
    const m = document.createElement("b");
    m.textContent = "      Mods: ";
    m.style.color = "var(--orange)";
    rosterEl.appendChild(m);
    rosterEl.appendChild(
      document.createTextNode((roster.mods || []).join(", ") || "none"),
    );
  }

  function renderLegend() {
    const legendEl = $("legend");
    legendEl.textContent = "";
    Object.keys(CAT).forEach((cat) => {
      const row = document.createElement("div");
      row.className = "leg";
      const ic = icon(CAT[cat].icon, "leg-ic");
      ic.style.color = CAT[cat].color;
      row.appendChild(ic);
      const b = document.createElement("b");
      b.textContent = CAT[cat].label;
      row.appendChild(b);
      legendEl.appendChild(row);
    });
  }

  let bans = [];
  let banHistory = [];
  let bansTimer = null;
  let bansQuery = "";
  let bansFilter = "all";
  const openBanKeys = new Set();
  let banHistQuery = "";
  let banHistFilter = "all";
  function fmtRemaining(b) {
    if (b.permanent) return null;
    const ms = (b.expiry || 0) - Date.now();
    if (ms <= 0) return "expiring";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
    return pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
  }
  function openBanDurationMenu(b) {
    if (!window.StaffUI) return;
    const durs = [
      {
        label: "1 hour",
        value: "1h",
        icon: '<i class="fas fa-clock"></i>',
        desc: "Ends 1 hour from now",
      },
      {
        label: "24 hours",
        value: "24h",
        icon: '<i class="fas fa-clock"></i>',
        desc: "Ends 24 hours from now",
      },
      {
        label: "7 days",
        value: "7d",
        icon: '<i class="fas fa-calendar-week"></i>',
        desc: "Ends 7 days from now",
      },
      {
        label: "Permanent",
        value: "permanent",
        icon: '<i class="fas fa-ban"></i>',
        desc: "Never expires",
      },
    ];
    StaffUI.menu({
      title: "Change ban duration",
      icon: '<i class="fas fa-hourglass-half"></i>',
      subtitle: (b.label || b.ip || "This block") + " · re-timed from now",
      groups: [
        {
          items: durs.map((d) => ({
            icon: d.icon,
            label: d.label,
            desc: d.desc,
            danger: d.value === "permanent",
            onClick: () =>
              socket.emit("dev set block duration", {
                ref: b.ref,
                duration: d.value,
              }),
          })),
        },
      ],
    });
  }

  async function editBanMessage(b) {
    if (!window.StaffUI) return;
    const reason = await StaffUI.prompt({
      title: "Ban message",
      icon: '<i class="fas fa-comment"></i>',
      subtitle: "Shown to them on the ban screen when they try to connect",
      fields: [
        {
          name: "value",
          label: "Message (optional)",
          type: "textarea",
          value: b.reason || "",
          placeholder:
            "e.g. Banned for repeated harassment. Contact staff to appeal.",
          maxLength: 500,
        },
      ],
      confirmText: "Save message",
    });
    if (reason == null) return;
    socket.emit("dev set block message", {
      ref: b.ref,
      reason: String(reason).trim(),
    });
  }

  function banSearchable(b) {
    return [
      b.label,
      b.by,
      b.reason,
      b.ip,
      b.did,
      ...(b.users || []).flatMap((u) => [u.name, u.id]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function groupBans(list) {
    const byDid = new Map();
    const byName = new Map();
    const solos = [];
    for (const b of list) {
      if (b.did) {
        if (!byDid.has(b.did)) byDid.set(b.did, []);
        byDid.get(b.did).push(b);
      } else if (b.label) {
        const k = b.label.trim().toLowerCase();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(b);
      } else {
        solos.push([b]);
      }
    }
    for (const [nameKey, blocks] of [...byName]) {
      for (const g of byDid.values()) {
        if (g.some((x) => (x.label || "").trim().toLowerCase() === nameKey)) {
          g.push(...blocks);
          byName.delete(nameKey);
          break;
        }
      }
    }
    const groups = [...byDid.values(), ...byName.values(), ...solos];
    groups.forEach((g) => g.sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    const newest = (g) => Math.max(...g.map((x) => x.ts || 0));
    groups.sort((a, b) => newest(b) - newest(a));
    return groups;
  }

  function buildBlockRow(b, isDev, showIp) {
    const row = divc("blockrow");
    const kind = b.kind || "ip";
    const tag = span("btag " + (kind === "id" ? "uid" : kind));
    tag.textContent = kind === "id" ? "ID" : kind === "range" ? "RANGE" : "IP";
    row.appendChild(tag);
    const addrText = showIp
      ? kind === "id"
        ? String(b.ip || "").replace(/^id:/, "")
        : b.ip
      : null;
    const addr = span("addr" + (addrText ? "" : " dim"));
    addr.textContent =
      addrText || (kind === "id" ? "client id" : "address hidden");
    row.appendChild(addr);

    const pill = span("pill " + (b.permanent ? "perm" : "live"));
    pill.dataset.ref = b.ref || "";
    pill.textContent = b.permanent
      ? "Permanent"
      : fmtRemaining(b) || "expiring";
    row.appendChild(pill);

    const mkIcon = (fa, titleText, danger, fn) => {
      const btn = document.createElement("button");
      btn.className = "ibtn" + (danger ? " danger" : "");
      btn.title = titleText;
      btn.appendChild(icon(fa));
      btn.addEventListener("click", fn);
      return btn;
    };
    if (isDev) {
      row.appendChild(
        mkIcon("fa-hourglass-half", "Change duration", false, () =>
          openBanDurationMenu(b),
        ),
      );
      row.appendChild(
        mkIcon(
          "fa-comment",
          b.reason ? "Edit message" : "Add message",
          false,
          () => editBanMessage(b),
        ),
      );
    }
    if (viewerIsFullMod()) {
      if (b.permanent && !isDev) {
        const lock = span("ibtn locked");
        lock.title = "Permanent: only an admin can lift this";
        lock.appendChild(icon("fa-lock"));
        row.appendChild(lock);
      } else {
        row.appendChild(
          mkIcon("fa-unlock", "Unban this one", true, () =>
            confirmUnban([b], showIp),
          ),
        );
      }
    }
    return row;
  }

  async function confirmUnban(blocks, showIp, name) {
    const send = () =>
      blocks.forEach((b) =>
        socket.emit("dev unblock ip", { ip: b.ip, ref: b.ref }),
      );
    if (!window.StaffUI) return send();
    const many = blocks.length > 1;
    const who = name || blocks.map((b) => b.label).find(Boolean) || "this user";
    const ok = await StaffUI.confirm({
      title: many ? "Unban " + blocks.length + " blocks" : "Unban",
      message: many
        ? "Lift every block covering " +
          who +
          " (" +
          blocks.length +
          " in total)? They can connect again straight away."
        : "Unblock " +
          who +
          (showIp && blocks[0].ip ? " (" + blocks[0].ip + ")" : "") +
          "?",
      danger: many,
      confirmText: many ? "Unban all" : "Unban",
    });
    if (ok) send();
  }

  function buildBanRow(blocks, isDev, showIp) {
    const anyPerm = blocks.some((b) => b.permanent);
    const first = blocks[0];
    const name = blocks.map((b) => b.label).find(Boolean) || null;
    const did = blocks.map((b) => b.did).find(Boolean) || null;
    const maxBans = Math.max(...blocks.map((b) => b.bans || 0));
    const key = did || name || first.ref;

    const wrap = divc("banrow-wrap");
    const row = document.createElement("button");
    row.className = "banrow" + (anyPerm ? " perm" : "");
    row.type = "button";
    row.setAttribute("aria-expanded", "false");

    const chev = divc("br-chev");
    chev.appendChild(icon("fa-chevron-right"));
    row.appendChild(chev);

    const av = divc("avatar br-av");
    av.style.background = anyPerm ? "var(--red)" : "var(--amber)";
    if (name) av.textContent = initialOf(name);
    else av.appendChild(icon(did ? "fa-fingerprint" : "fa-globe"));
    row.appendChild(av);

    const whoCell = divc("br-who");
    whoCell.appendChild(
      span("br-name", name || (did ? "Unnamed account" : "No account on file")),
    );
    const sub = divc("br-sub");
    if (did) sub.appendChild(span("mono", did.slice(0, 18) + "…"));
    else if (showIp && first.ip) sub.appendChild(span("mono", first.ip));
    whoCell.appendChild(sub);
    row.appendChild(whoCell);

    const blocksCell = divc("br-blocks");
    const kinds = [...new Set(blocks.map((b) => b.kind || "ip"))];
    const n = span("br-count", String(blocks.length));
    blocksCell.appendChild(n);
    blocksCell.appendChild(
      span("br-unit", blocks.length === 1 ? "block" : "blocks"),
    );
    kinds.forEach((k) => {
      const t = span("btag " + (k === "id" ? "uid" : k));
      t.textContent = k === "id" ? "ID" : k === "range" ? "RANGE" : "IP";
      blocksCell.appendChild(t);
    });
    if (maxBans >= 2) {
      const rep = span("bc-repeat");
      rep.appendChild(icon("fa-rotate-right"));
      rep.appendChild(document.createTextNode(" " + maxBans + "x"));
      rep.title = "Banned " + maxBans + " times over the life of this list";
      blocksCell.appendChild(rep);
    }
    row.appendChild(blocksCell);

    const bys = [...new Set(blocks.map((b) => b.by).filter(Boolean))];
    row.appendChild(span("br-by", bys.join(", ") || "unknown"));

    const when = span("br-when", first.ts ? relTime(first.ts) : "");
    if (first.ts) when.title = fmtTime(first.ts);
    row.appendChild(when);

    const endCell = span("br-ends");
    if (anyPerm) {
      const p = span("pill perm", "Permanent");
      endCell.appendChild(p);
    } else {
      const longest = blocks.reduce((m, b) =>
        (b.expiry || 0) > (m.expiry || 0) ? b : m,
      );
      const p = span("pill live", fmtRemaining(longest) || "expiring");
      p.dataset.ref = longest.ref || "";
      endCell.appendChild(p);
    }
    row.appendChild(endCell);
    wrap.appendChild(row);

    const detail = divc("bandetail");
    detail.hidden = true;
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const rows = divc("blocks");
      blocks.forEach((b) => rows.appendChild(buildBlockRow(b, isDev, showIp)));
      detail.appendChild(rows);

      const withMsg = blocks.find((b) => b.reason);
      const msg = divc("bc-msg" + (withMsg ? "" : " none"));
      msg.appendChild(span("lbl", "Message shown to them"));
      msg.appendChild(
        document.createTextNode(
          withMsg
            ? withMsg.reason
            : "No message set. They see a generic ban screen.",
        ),
      );
      detail.appendChild(msg);

      const seen = new Map();
      blocks.forEach((b) =>
        (b.users || []).forEach((u) => {
          const k = u.id || u.name || "?";
          if (!seen.has(k)) seen.set(k, u);
        }),
      );
      if (seen.size) {
        const box = divc("bc-msg");
        box.appendChild(span("lbl", "Seen accounts (" + seen.size + ")"));
        box.appendChild(
          document.createTextNode(
            [...seen.values()]
              .map((u) => u.name || "Unknown")
              .slice(0, 12)
              .join(", "),
          ),
        );
        detail.appendChild(box);
      }
      if (did) {
        const idLine = divc("bc-idline mono");
        idLine.textContent = "id: " + did;
        detail.appendChild(idLine);
      }

      if (!viewerIsFullMod()) return;
      const foot = divc("bandetail-foot");
      const liftable = viewerIsDev()
        ? blocks
        : blocks.filter((b) => !b.permanent);
      const held = blocks.length - liftable.length;
      if (liftable.length) {
        const unbanAll = document.createElement("button");
        unbanAll.className = "btn sm danger";
        unbanAll.appendChild(icon("fa-unlock"));
        unbanAll.appendChild(
          document.createTextNode(
            liftable.length > 1 ? " Unban all " + liftable.length : " Unban",
          ),
        );
        unbanAll.addEventListener("click", () =>
          confirmUnban(liftable, showIp, name),
        );
        foot.appendChild(unbanAll);
      }
      if (held) {
        const note = span("dim");
        note.appendChild(icon("fa-lock"));
        note.appendChild(
          document.createTextNode(
            held === 1
              ? " 1 permanent block, admin-only to lift"
              : ` ${held} permanent blocks, admin-only to lift`,
          ),
        );
        foot.appendChild(note);
      }
      detail.appendChild(foot);
    };

    row.addEventListener("click", () => {
      const open = detail.hidden;
      if (open) build();
      detail.hidden = !open;
      row.classList.toggle("open", open);
      row.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) openBanKeys.add(key);
      else openBanKeys.delete(key);
    });
    if (openBanKeys.has(key)) {
      build();
      detail.hidden = false;
      row.classList.add("open");
      row.setAttribute("aria-expanded", "true");
    }
    wrap.appendChild(detail);
    return wrap;
  }

  function renderBans() {
    const wrap = $("bansList");
    const isDev = me && me.role === "dev";
    const showIp = !!(me && me.mainDev);
    wrap.textContent = "";
    $("bansBadge").textContent = String(bans.length);
    $("bansSub").textContent = bans.length
      ? bans.length + " active block" + (bans.length === 1 ? "" : "s")
      : "No active blocks";
    if (bans.length === 0) {
      wrap.appendChild(
        emptyBox("fa-circle-check", "Nobody is currently blocked."),
      );
      return;
    }
    let list = bans.slice();
    if (bansFilter === "perm") list = list.filter((b) => b.permanent);
    else if (bansFilter === "temp") list = list.filter((b) => !b.permanent);
    else if (bansFilter === "id")
      list = list.filter((b) => b.kind === "id" || b.did);
    if (bansQuery)
      list = list.filter((b) => banSearchable(b).includes(bansQuery));
    if (!list.length) {
      wrap.appendChild(
        emptyBox("fa-filter-circle-xmark", "No blocks match your filter."),
      );
      return;
    }
    const groups = groupBans(list);
    const head = divc("banhead");
    [
      "",
      "",
      "Who",
      "Blocks",
      "Placed by",
      "Banned",
      "Ends",
    ].forEach((h) => head.appendChild(span(null, h)));
    wrap.appendChild(head);
    groups.forEach((g) => wrap.appendChild(buildBanRow(g, isDev, showIp)));
    const note = divc("bantotal");
    note.textContent =
      groups.length +
      (groups.length === 1 ? " person" : " people") +
      "  ·  " +
      list.length +
      (list.length === 1 ? " block" : " blocks");
    wrap.appendChild(note);
    startBanTimer();
  }
  function startBanTimer() {
    if (bansTimer) return;
    bansTimer = setInterval(() => {
      if (tab !== "bans") return;
      let anyLive = false;
      document.querySelectorAll("#bansList .pill[data-ref]").forEach((pill) => {
        const b = bans.find((x) => x.ref === pill.dataset.ref);
        if (!b || b.permanent) return;
        anyLive = true;
        pill.textContent = fmtRemaining(b) || "expiring";
      });
      if (!anyLive) {
        clearInterval(bansTimer);
        bansTimer = null;
      }
    }, 1000);
  }

  function renderBanHistory() {
    const wrap = $("banHistoryList");
    if (!wrap) return;
    wrap.textContent = "";
    const sub = $("banHistSub");
    if (sub)
      sub.textContent = banHistory.length
        ? banHistory.length +
          " recent event" +
          (banHistory.length === 1 ? "" : "s")
        : "No ban activity yet";
    if (!banHistory.length) {
      wrap.appendChild(
        emptyBox("fa-clock-rotate-left", "No ban or unban activity yet."),
      );
      return;
    }
    const activeKeys = new Set(bans.map((b) => b.ip).filter(Boolean));
    let list = banHistory.slice();
    if (banHistFilter !== "all")
      list = list.filter((e) => e.action === banHistFilter);
    if (banHistQuery)
      list = list.filter((e) =>
        [e.name, e.by, e.reason, e.ip, e.duration]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(banHistQuery),
      );
    if (!list.length) {
      wrap.appendChild(
        emptyBox("fa-filter-circle-xmark", "No history matches your filter."),
      );
      return;
    }
    list.forEach((e) => {
      const isUnban = e.action === "unban";
      const row = divc("bhrow " + (isUnban ? "unban" : "ban"));
      const ic = divc("bh-ic");
      ic.appendChild(icon(isUnban ? "fa-unlock" : "fa-ban"));
      row.appendChild(ic);

      const main = divc("bh-main");
      const line = divc("bh-line");
      const who = document.createElement("b");
      who.textContent = e.by || "A staff member";
      line.appendChild(who);
      line.appendChild(document.createTextNode(" "));
      line.appendChild(
        span(
          isUnban ? "verb-unban" : "verb-ban",
          isUnban ? "unbanned" : "banned",
        ),
      );
      line.appendChild(document.createTextNode(" "));
      const target = document.createElement("b");
      target.textContent =
        e.name || (e.ip ? String(e.ip).replace(/^id:/, "") : "a user");
      line.appendChild(target);
      if (!isUnban && e.duration) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(span(null, durationLabel(e.duration)));
      }
      main.appendChild(line);

      const s = divc("bh-sub");
      if (e.kind === "id" || e.kind === "range") {
        const tag = span("btag " + (e.kind === "id" ? "uid" : "range"));
        tag.textContent = e.kind === "id" ? "ID BAN" : "RANGE";
        s.appendChild(tag);
      }
      if (e.ip)
        s.appendChild(span("ip", String(e.ip).replace(/^id:/, "id ")));
      if (e.reason) s.appendChild(span(null, '"' + e.reason + '"'));
      if (!isUnban && e.ip && activeKeys.has(e.ip)) {
        const st = span("stchip active");
        st.textContent = "ACTIVE";
        s.appendChild(st);
      }
      if (s.childNodes.length) main.appendChild(s);
      row.appendChild(main);

      const when = span("bh-when", relTime(e.at));
      when.title = fmtTime(e.at);
      row.appendChild(when);

      wrap.appendChild(row);
    });
  }

  let modKeys = [];
  let formerMods = [];
  let modsFilter = "all";
  function lastSeenMeta(ts) {
    if (!ts) return { text: "Never connected", cls: "dim" };
    const ms = Date.now() - ts;
    const day = 86400000;
    let cls = "fresh";
    if (ms >= 7 * day) cls = "cold";
    else if (ms >= day) cls = "stale";
    return { text: relTime(ts), cls };
  }
  function modStat(k, v, vCls, title) {
    const s = divc("mc-stat");
    s.appendChild(span("mc-k", k));
    const val = span("mc-v" + (vCls ? " " + vCls : ""), v);
    if (title) val.title = title;
    s.appendChild(val);
    return s;
  }
  function isActiveStaff(m) {
    return m.online || (m.lastSeen && Date.now() - m.lastSeen < 7 * 86400000);
  }
  const RANKS = {
    dev: { chip: "chip dev", name: "ADMIN", color: "var(--red)" },
    l3: { chip: "chip l3", name: "LEADER", color: "var(--lead)" },
    l2: { chip: "chip l2", name: "MOD L2", color: "var(--blue)" },
    l1: { chip: "chip l1", name: "MOD L1", color: "var(--purple)" },
  };
  const rankForLevel = (level) =>
    (level || 1) >= 3 ? "l3" : (level || 1) >= 2 ? "l2" : "l1";
  function buildStaffRoster() {
    const online = new Set((sessionData.sessions || []).map((s) => s.hash));
    const activityByHash = new Map(
      (sessionData.history || []).map((h) => [h.hash, h]),
    );
    const roster = [];
    for (const h of sessionData.history || []) {
      if (h.role !== "dev") continue;
      const last = Math.max(0, ...(h.ips || []).map((x) => x.last || 0));
      roster.push({
        rank: "dev",
        label: h.label || "dev",
        hash: h.hash,
        lastSeen: last || null,
        networks: (h.ips || []).length,
        online: online.has(h.hash),
      });
    }
    for (const k of modKeys) {
      const act = activityByHash.get(k.hash);
      roster.push({
        rank: rankForLevel(k.level),
        label: k.label || "mod",
        hash: k.hash,
        lastSeen: k.lastSeen || null,
        networks:
          k.networks != null ? k.networks : act ? (act.ips || []).length : 0,
        grantedBy: k.grantedBy || null,
        grantedAt: k.grantedAt || null,
        online: k.online != null ? !!k.online : online.has(k.hash),
        key: k,
      });
    }
    return roster;
  }

  function buildModCard(m) {
    const rank = RANKS[m.rank] || RANKS.l2;
    const card = divc("modcard rank-" + m.rank);

    const top = divc("mc-top");
    const av = divc("avatar");
    av.style.background = rank.color;
    av.textContent = initialOf(m.label);
    top.appendChild(av);
    const title = divc("mc-title");
    title.appendChild(span("nm", m.label || "staff"));
    title.appendChild(span(rank.chip, rank.name));
    top.appendChild(title);
    const active = isActiveStaff(m);
    const dot = span(
      "live-dot " + (m.online ? "on" : active ? "idle" : "off"),
    );
    dot.appendChild(
      document.createTextNode(
        m.online ? "Online now" : active ? "Active" : "Inactive",
      ),
    );
    top.appendChild(dot);
    card.appendChild(top);

    const grid = divc("mc-grid");
    const ls = lastSeenMeta(m.lastSeen);
    grid.appendChild(
      modStat(
        "Last seen",
        ls.text,
        ls.cls,
        m.lastSeen ? fmtTime(m.lastSeen) : null,
      ),
    );
    grid.appendChild(
      modStat(
        "Networks",
        m.networks ? String(m.networks) : "None yet",
        m.networks ? null : "dim",
        "Distinct addresses this key has connected from",
      ),
    );
    if (m.rank === "dev") {
      grid.appendChild(modStat("Granted by", "Server owner", "dim"));
    } else {
      grid.appendChild(
        modStat(
          "Granted by",
          m.grantedBy || "Unknown",
          m.grantedBy ? null : "dim",
        ),
      );
      grid.appendChild(
        modStat(
          "Granted",
          m.grantedAt ? relTime(m.grantedAt) : "Unknown",
          m.grantedAt ? null : "dim",
          m.grantedAt ? fmtTime(m.grantedAt) : null,
        ),
      );
    }
    grid.appendChild(
      modStat("Key", m.hash ? m.hash.slice(0, 12) + "…" : "?", "mono"),
    );
    card.appendChild(grid);

    const actions = divc("mc-actions");
    // Every mod can open their own record (without its flags); reading other
    // people's records stays with leaders and admins.
    const isOwnRow =
      !viewerIsDev() &&
      m.rank !== "dev" &&
      !!(me && me.label) &&
      String(m.label || "").toLowerCase() === me.label.toLowerCase();
    const canSeeRecord =
      viewerIsOps() ||
      isOwnRow ||
      (m.rank !== "dev" &&
        (viewerIsDev() || (viewerIsLeader() && m.rank !== "l3")));
    if (canSeeRecord) {
      const histBtn = document.createElement("button");
      histBtn.className = "btn sm";
      histBtn.appendChild(icon("fa-clock-rotate-left"));
      histBtn.appendChild(
        document.createTextNode(isOwnRow ? " My record" : " Their record"),
      );
      histBtn.title = isOwnRow
        ? "Everything you have ever done as a mod"
        : "Everything " + (m.label || "this person") + " has ever done";
      histBtn.addEventListener("click", () => openModHistory(m));
      actions.appendChild(histBtn);
    }

    const canManageKey =
      m.key && (viewerIsDev() || (viewerIsLeader() && (m.key.level || 1) < 3));
    if (canManageKey) {
      const k = m.key;
      const lvl = k.level >= 3 ? 3 : k.level === 1 ? 1 : 2;
      const LEVEL_NAMES = {
        1: "Junior mod (L1)",
        2: "Full mod (L2)",
        3: "Mod leader (L3)",
      };
      const maxLevel = viewerIsDev() ? 3 : 2;
      const steps = [];
      if (lvl < maxLevel) steps.push(lvl + 1);
      if (lvl > 1) steps.push(lvl - 1);
      for (const toLevel of steps) {
        const up = toLevel > lvl;
        const levelBtn = document.createElement("button");
        levelBtn.className = "btn sm";
        levelBtn.appendChild(icon(up ? "fa-arrow-up" : "fa-arrow-down"));
        levelBtn.appendChild(
          document.createTextNode(
            (up ? " Promote to " : " Demote to ") +
              (toLevel === 3 ? "Leader" : "L" + toLevel),
          ),
        );
        levelBtn.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: (up ? "Promote to " : "Demote to ") + LEVEL_NAMES[toLevel],
              message:
                'Set "' + (k.label || "mod") + '" to ' + LEVEL_NAMES[toLevel] + "?",
              confirmText: up ? "Promote" : "Demote",
            });
            if (!ok) return;
          }
          socket.emit("dev set mod level", { hash: k.hash, level: toLevel });
        });
        actions.appendChild(levelBtn);
      }

      const revoke = document.createElement("button");
      revoke.className = "btn sm danger";
      revoke.appendChild(icon("fa-user-xmark"));
      revoke.appendChild(document.createTextNode(" Remove from staff"));
      revoke.addEventListener("click", async () => {
        if (!window.StaffUI) return;
        const r = await StaffUI.prompt({
          title: "Remove " + (k.label || "mod") + " from staff",
          icon: '<i class="fas fa-user-xmark"></i>',
          message:
            'Their key stops working at once and "' +
            (k.label || "mod") +
            '" drops off the roster. They stay in the ' +
            "list below as a former moderator, with this reason attached.",
          fields: [
            {
              name: "reason",
              label: "Why are they no longer a moderator?",
              type: "textarea",
              placeholder:
                "e.g. Stepped down. / Inactive for months. / Banned users out of a grudge.",
              required: true,
              maxLength: 300,
            },
          ],
          danger: true,
          confirmText: "Remove from staff",
        });
        if (r && r.reason && r.reason.trim())
          socket.emit("dev revoke mod", {
            hash: k.hash,
            reason: r.reason.trim(),
          });
      });
      actions.appendChild(revoke);
    }
    card.appendChild(actions);
    return card;
  }

  // ── One staff member's whole record ──────────────────────────────────────
  const RECORD_PAGE = 50;
  let PROMOTION_AT = 1000;
  let recordCtx = null;

  function openModHistory(m, opts) {
    const o = opts || {};
    recordCtx = {
      label: m.label,
      role: m.rank === "dev" ? "dev" : "mod",
      modLevel:
        m.rank === "l1" ? 1 : m.rank === "l2" ? 2 : m.rank === "l3" ? 3 : 0,
      offset: o.offset || 0,
      group: o.group || null,
      targetUid: o.targetUid || null,
      caseFilter: o.caseFilter || "all",
      caseOffset: o.caseOffset || 0,
      mineOnly: !!(o.keepHost && recordCtx && recordCtx.mineOnly),
      tab: o.keepHost && recordCtx ? recordCtx.tab : null,
      host: o.keepHost && recordCtx ? recordCtx.host : null,
    };
    socket.emit("staff get mod history", {
      label: recordCtx.label,
      role: recordCtx.role,
      offset: recordCtx.offset,
      limit: RECORD_PAGE,
      group: recordCtx.group,
      targetUid: recordCtx.targetUid,
      caseFilter: recordCtx.caseFilter,
      caseOffset: recordCtx.caseOffset,
    });
  }

  function refineRecord(patch) {
    if (!recordCtx) return;
    const rank =
      recordCtx.role === "dev"
        ? "dev"
        : recordCtx.modLevel === 1
          ? "l1"
          : "l2";
    openModHistory(
      { label: recordCtx.label, rank },
      Object.assign(
        {
          offset: 0,
          group: recordCtx.group,
          targetUid: recordCtx.targetUid,
          caseFilter: recordCtx.caseFilter,
          caseOffset: recordCtx.caseOffset,
          keepHost: true,
        },
        patch,
      ),
    );
  }

  function spanLabel(from, to) {
    const ms = Math.max(0, (to || Date.now()) - (from || Date.now()));
    const d = Math.floor(ms / 86400000);
    if (d >= 60) return Math.floor(d / 30) + " months";
    if (d >= 14) return Math.floor(d / 7) + " weeks";
    if (d >= 1) return d + (d === 1 ? " day" : " days");
    return "today";
  }

  function statTile(n, label, title) {
    const t = divc("mh-tot");
    t.appendChild(span("mh-n", String(n)));
    t.appendChild(span("mh-l", label));
    if (title) t.title = title;
    return t;
  }

  const REC_GROUP = {
    users: { icon: "fa-user-shield", label: "Acting on users" },
    queues: { icon: "fa-inbox", label: "Clearing queues" },
    talking: { icon: "fa-comments", label: "Talking to users" },
    rooms: { icon: "fa-door-open", label: "Looking after rooms" },
    records: { icon: "fa-note-sticky", label: "Record keeping" },
    admin: { icon: "fa-sliders", label: "Server and roles" },
    passive: { icon: "fa-eye", label: "Not counted as work" },
    other: { icon: "fa-circle-info", label: "Not yet classified" },
  };

  function splitAction(action) {
    const s = String(action || "?");
    const i = s.indexOf(" (");
    if (i === -1 || !s.endsWith(")")) return { verb: s, note: null };
    return { verb: s.slice(0, i), note: s.slice(i + 2, -1) };
  }

  function parseRoomTag(tag) {
    const s = String(tag || "");
    if (!s.startsWith("room:")) return null;
    const body = s.slice(5);
    const open = body.lastIndexOf("(");
    const close = body.lastIndexOf(")");
    if (open === -1 || close < open) return { name: body, id: null };
    return { name: body.slice(0, open), id: body.slice(open + 1, close) };
  }

  // ── The record: who, how it reads, the evidence, the cases ─────────────
  function rankName(isDev, modLevel) {
    if (isDev) return "Admin";
    if (modLevel >= 3) return "Mod leader";
    if (modLevel === 1) return "Junior moderator";
    return "Moderator";
  }

  function sectionHead(title, sub) {
    const head = divc("mh-lhead");
    head.appendChild(span("mh-lt", title));
    if (sub) head.appendChild(span("mh-ls", sub));
    return head;
  }

  function foldSection(title, sub, body, open) {
    const det = document.createElement("details");
    det.className = "mh-fold";
    det.open = !!open;
    const sum = document.createElement("summary");
    sum.appendChild(span("mh-lt", title));
    if (sub) sum.appendChild(span("mh-ls", sub));
    det.appendChild(sum);
    det.appendChild(body);
    return det;
  }

  function elapsedLabel(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min";
    const h = Math.round(m / 60);
    if (h < 48) return h + " h";
    return Math.round(h / 24) + " days";
  }

  function gradeTag(grade) {
    const g = GRADE_LABEL[grade] ? grade : "none";
    const t = span("mh-grade g-" + g, GRADE_LABEL[g]);
    t.title = GRADE_HELP[g];
    return t;
  }

  function recordHeader(h, isDev, ctx) {
    const head = divc("mh-head");
    const av = divc("mh-avatar");
    av.textContent = initialOf(h.label);
    head.appendChild(av);
    const text = divc("mh-htext");
    const name = divc("mh-hname");
    name.appendChild(span("mh-hlabel", h.label || "Staff"));
    name.appendChild(
      span(
        "mh-rank r-" + (isDev ? "dev" : "l" + (ctx.modLevel || 2)),
        rankName(isDev, ctx.modLevel),
      ),
    );
    text.appendChild(name);
    if (h.summary) text.appendChild(span("mh-hsummary", h.summary));
    const facts = divc("mh-hfacts");
    if (h.first) {
      const f = span(null, "First action " + relTime(h.first));
      f.title = fmtTime(h.first);
      facts.appendChild(f);
    }
    if (h.last) {
      const l = span(null, "Last action " + relTime(h.last));
      l.title = fmtTime(h.last);
      facts.appendChild(l);
    }
    facts.appendChild(span(null, (h.total || 0) + " logged in total"));
    text.appendChild(facts);
    head.appendChild(text);
    return head;
  }

  // The numbers mods like to see, unchanged in meaning: work on people is the
  // headline, everything else is context.
  function numbersRow(h, isDev) {
    const row = divc("mh-sum");
    if (!isDev) {
      const lead = statTile(
        h.onUsers || 0,
        "actions on people",
        "Warnings, kicks, wipes, bans, renames: anything that landed on a person. Promotion looks at this number.",
      );
      lead.classList.add("lead");
      row.appendChild(lead);
    }
    row.appendChild(
      statTile(h.casesTotal || 0, "cases", "One person, one sitting, everyone involved"),
    );
    row.appendChild(
      statTile(h.distinctTargets || 0, "people", "Different people they acted on"),
    );
    row.appendChild(
      statTile(
        (h.useful || 0) - (h.onUsers || 0),
        "rooms, queues, notes",
        "Real work where nobody was moderated: room tidying, review queues, notes",
      ),
    );
    row.appendChild(
      statTile(
        h.first ? spanLabel(h.first, h.last) : "-",
        "active for",
        h.first ? "First action " + fmtTime(h.first) : null,
      ),
    );
    row.appendChild(
      statTile(
        h.last ? relTime(h.last) : "never",
        "last action",
        h.last ? fmtTime(h.last) : null,
      ),
    );
    return row;
  }

  // One paragraph in plain words, then the same thing as a strip of colour.
  function snapshotLine(h) {
    const q = h.quality;
    if (!q) return null;
    const box = divc("mh-sect mh-snap");
    box.appendChild(sectionHead("What the snapshots say", "last 30 days"));
    if (!q.total) {
      box.appendChild(
        span(
          "mh-qnote",
          "No snapshots yet. A snapshot of what was on screen is saved with every action on a person from now on, so this fills in as they work.",
        ),
      );
      return box;
    }
    const c = q.counts;
    const team = h.team || {};
    const n = (x, one, many) => x + " " + (x === 1 ? one : many);
    const parts = [
      n(c.corroborated + c.reported, "action", "actions") +
        " out of " +
        q.total +
        " had something behind " +
        (c.corroborated + c.reported === 1 ? "it" : "them") +
        ": what the person had typed, their history, or reports from other users.",
    ];
    if (c.unverifiable)
      parts.push(n(c.unverifiable, "could", "could") + " not be checked either way.");
    parts.push(
      c.contradicted
        ? n(c.contradicted, "heavy punishment", "heavy punishments") + " had nothing behind it at all."
        : "No heavy punishment stood on its own.",
    );
    if (q.overturned)
      parts.push(
        n(q.overturned, "punishment was", "punishments were") + " overturned by somebody else.",
      );
    parts.push(
      team.enough
        ? "Across the team at this rank, about " +
            team.contradictedPct +
            "% of actions have nothing behind them."
        : "Not enough people at this rank yet to compare with.",
    );
    box.appendChild(span("mh-snaptext", parts.join(" ")));

    const bar = divc("mh-snapbar");
    const legend = divc("mh-snaplegend");
    ["corroborated", "reported", "unverifiable", "contradicted"].forEach((k) => {
      if (!c[k]) return;
      const seg = divc("mh-snapseg g-" + k);
      seg.style.width = Math.round((c[k] / q.total) * 100) + "%";
      seg.title = c[k] + " " + GRADE_LABEL[k];
      bar.appendChild(seg);
      const l = span("mh-snapkey g-" + k, c[k] + " " + GRADE_LABEL[k]);
      l.title = GRADE_HELP[k];
      legend.appendChild(l);
    });
    box.appendChild(bar);
    box.appendChild(legend);
    box.appendChild(
      span(
        "mh-qnote",
        "This is about what was captured at the moment, never about the moderator. Actions from before snapshots existed are not counted.",
      ),
    );
    return box;
  }

  // Overview, Cases, Actions, People. The chosen tab is remembered.
  function recordTabs(tabs, ctx) {
    let current = ctx.tab;
    try {
      current = current || localStorage.getItem("talkomatic_recordTab") || "overview";
    } catch (_) {
      current = current || "overview";
    }
    if (!tabs.some((t) => t.key === current)) current = tabs[0].key;
    const wrap = divc("mh-tabbed");
    const bar = divc("mh-tabs");
    const show = (key) => {
      ctx.tab = key;
      try {
        localStorage.setItem("talkomatic_recordTab", key);
      } catch (_) {}
      tabs.forEach((t) => {
        t.pane.hidden = t.key !== key;
        t.button.classList.toggle("on", t.key === key);
      });
    };
    tabs.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mh-tab";
      b.appendChild(document.createTextNode(t.label));
      if (t.count != null) b.appendChild(span("mh-tabn", String(t.count)));
      b.addEventListener("click", () => show(t.key));
      t.button = b;
      bar.appendChild(b);
    });
    wrap.appendChild(bar);
    tabs.forEach((t) => wrap.appendChild(t.pane));
    show(current);
    return wrap;
  }

  // ── How this works: the record explained for the people it is about ─────
  function helpBlock(title, lines) {
    const sect = divc("rh-sect");
    sect.appendChild(span("rh-title", title));
    lines.forEach((l) => {
      if (Array.isArray(l)) {
        const ul = document.createElement("ul");
        ul.className = "rh-list";
        l.forEach((item) => {
          const li = document.createElement("li");
          if (Array.isArray(item)) {
            li.appendChild(span("rh-term", item[0]));
            li.appendChild(document.createTextNode(" " + item[1]));
          } else li.textContent = item;
          ul.appendChild(li);
        });
        sect.appendChild(ul);
      } else sect.appendChild(span("rh-p", l));
    });
    return sect;
  }

  function openRecordHelp() {
    if (!window.StaffUI) return;
    const body = divc("rh-wrap");
    body.appendChild(
      helpBlock("What changed", [
        "Your record used to be a list of actions and a total. It now also keeps a snapshot of what was on screen when you acted on somebody: what they had typed, whether other users had reported them, what staff had already done to them, and who arrived in the room first.",
        "Nothing about how you moderate has to change. The point is that a good call now looks like a good call, instead of looking like a number.",
      ]),
    );
    body.appendChild(
      helpBlock("Why", [
        "A total cannot tell a careful mod from a fast one. Two people can both have 400 actions, and one of them warned first, read the room and was right every time. The old record could not show that. This one can, because the evidence travels with each action.",
        "It works in your favour just as much as it works against anyone. If you ban somebody on sight because they typed a slur, the snapshot shows the slur.",
      ]),
    );
    body.appendChild(
      helpBlock("The tabs", [
        [
          ["Overview", "the numbers you know, one plain sentence about the snapshots, and anything worth a look."],
          ["Cases", "one person, one sitting, everyone involved. Click a case to see the snapshot behind each step."],
          ["Actions", "everything you did, newest first, with counts by type at the top. Same as before, with the snapshot text on each row."],
          ["People", "who you acted on, including other names the same person has used."],
        ],
      ]),
    );
    body.appendChild(
      helpBlock("The words on a snapshot", [
        [
          [GRADE_LABEL.corroborated + ":", GRADE_HELP.corroborated],
          [GRADE_LABEL.reported + ":", GRADE_HELP.reported],
          [GRADE_LABEL.unverifiable + ":", GRADE_HELP.unverifiable + " This is not held against you."],
          [GRADE_LABEL.contradicted + ":", GRADE_HELP.contradicted + " A few of these happen to everyone. A pattern is worth a conversation."],
          [GRADE_LABEL.none + ":", GRADE_HELP.none],
        ],
      ]),
    );
    body.appendChild(
      helpBlock("How a case ends", [
        [
          ["went quiet:", "they stayed online for half an hour and nobody had to act again. A warning that worked."],
          ["left:", "they were gone within half an hour."],
          ["came back:", "they rejoined after being kicked, the number of times shown."],
          ["banned:", "the last step was a ban or a block."],
          ["evaded the ban:", "the evasion watch caught them coming back afterwards."],
          ["acted on again:", "somebody had to act on the same person within a day."],
          ["appeal open, declined, overturned:", "what happened to the appeal. Overturned means somebody else lifted the block."],
        ],
      ]),
    );
    body.appendChild(
      helpBlock("Things worth a look", [
        "These are prompts, not verdicts. Each one says what tripped it, shows the rows it was built from, and says what an innocent explanation would look like. Leaders and admins read them; nothing happens automatically.",
        "You can see every flag on your own record. If one is wrong, open the case and add a note saying why. Whoever reviews it reads your note next to the evidence.",
      ]),
    );
    body.appendChild(
      helpBlock("What is expected of you", [
        [
          "Pick the rule whenever you ban or block somebody. The dialog asks for it and the server will not place the block without it.",
          "After a 7-day or permanent block, write it up: what they did, the rule, what was tried first, and why this length. The block is already in place while you write. If a write-up sits unwritten, your next long block waits until it is done, and after a day the leads are told.",
          "You cannot decide an appeal about a block you placed yourself. You can still talk in the thread.",
        ],
      ]),
    );
    body.appendChild(
      helpBlock("What went away", [
        [
          "Appeal replies no longer count as \"hits\" on a person. The abuse alert once fired on a mod for answering an appeal ten times.",
          "The old \"no warning first\" flag only knew about your own history with a person. The new one knows what every staff member did, what the person had typed, and which rules skip the warning.",
          "\"Not yet classified\" is gone. Appeal chats, bot kills and suggestion work now sit in proper buckets.",
          "Nothing from before snapshots is graded. Old actions are shown, never scored.",
        ],
      ]),
    );
    body.appendChild(
      helpBlock("What it is not", [
        "It is not a score and there is no leaderboard for it. Actions on people is still the promotion number, exactly as before. Snapshots and cases exist so that number can be trusted.",
      ]),
    );
    StaffUI.modal({
      title: "How records work",
      icon: '<i class="fas fa-circle-question"></i>',
      subtitle: "Snapshots, cases, write-ups, and what the words mean",
      wide: true,
      body,
      actions: [{ label: "Got it", kind: "primary", onClick: () => {} }],
    });
  }

  const OUTCOME_LABEL = {
    quiet: "went quiet",
    left: "left",
    "came back": "came back",
    banned: "banned",
    evaded: "evaded the ban",
    "re-actioned": "acted on again",
    "appeal open": "appeal open",
    upheld: "appeal declined",
    overturned: "overturned",
    lifted: "lifted by the issuer",
    unknown: "no presence data",
  };

  function outcomeChip(o) {
    const kind = (o && o.kind) || "unknown";
    let text = OUTCOME_LABEL[kind] || kind;
    if (kind === "came back") text += " x" + (o.n || 1);
    if (o && o.by && ["overturned", "re-actioned", "upheld"].includes(kind))
      text += " by " + o.by;
    return span("mh-outcome o-" + kind.replace(/\s+/g, "-"), text);
  }

  function pref(name, key) {
    const s = span("uref pref", name);
    s.title = "Open this person";
    s.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openPerson(key);
    });
    return s;
  }

  function receiptFacts(r) {
    const facts = divc("mc-facts");
    const fact = (k, v) => {
      if (v == null || v === "") return;
      const f = divc("mc-fact");
      f.appendChild(span("k", k));
      f.appendChild(span("v", String(v)));
      facts.appendChild(f);
    };
    fact(
      "They had typed",
      r.text
        ? '"' + r.text + '"' + (r.textWiped ? " (they had already cleared it)" : "")
        : r.origin === "offline"
          ? "acted on from outside a room"
          : "nothing, the box was empty",
    );
    if (r.trail && r.trail.length)
      fact("Earlier lines", r.trail.map((t) => '"' + t.text + '"').join("   "));
    if (r.reports && r.reports.hour)
      fact(
        "Reports in the hour before",
        r.reports.hour +
          (r.reports.reporters > 1 ? " from " + r.reports.reporters + " people" : ""),
      );
    if (r.dislikes) fact("Dislikes at the time", r.dislikes);
    if (r.prior && r.prior.length)
      fact(
        "Before this",
        r.prior.map((p) => p.action + " by " + p.by + ", " + relTime(p.at)).join("; "),
      );
    if (r.room)
      fact(
        "Room",
        r.room.name +
          ": " +
          r.room.occupants +
          " in, " +
          r.room.staff +
          " staff" +
          (r.room.joins5m >= 5 ? ", " + r.room.joins5m + " joins in 5 min" : ""),
      );
    if (r.actor && r.actor.joinedAt && r.target && r.target.joinedAt)
      fact(
        "Who arrived first",
        r.actor.joinedAt > r.target.joinedAt
          ? "they did, " + elapsedLabel(r.actor.joinedAt - r.target.joinedAt) + " before the moderator"
          : "the moderator, " + elapsedLabel(r.target.joinedAt - r.actor.joinedAt) + " before them",
      );
    if (r.reason && (r.reason.text || r.reason.rule))
      fact("Reason given", r.reason.text || "Rule " + r.reason.rule);
    const auto = [];
    if (r.auto && r.auto.words) auto.push("filtered words");
    if (r.auto && r.auto.links) auto.push("a link");
    if (r.auto && r.auto.ip) auto.push("an address");
    if (auto.length) fact("Filters found", auto.join(", "));
    const person = [];
    if (r.person && r.person.evader) person.push("flagged for ban evasion");
    if (r.person && r.person.autoBlocked) person.push("auto-blocked");
    if (r.person && r.person.bot) person.push("a bot");
    if (r.person && r.person.bans) person.push(r.person.bans + " earlier bans on this network");
    if (person.length) fact("Person", person.join(", "));
    return facts;
  }

  function stepDetail(s) {
    const row = divc("mc-sdetail");
    const head = divc("mc-shead");
    head.appendChild(span("mc-sact" + (s.heavy ? " heavy" : ""), s.action));
    head.appendChild(span("mc-sby", "by " + s.by));
    const t = span("mc-swhen", relTime(s.ts));
    t.title = fmtTime(s.ts);
    head.appendChild(t);
    head.appendChild(gradeTag(s.grade));
    row.appendChild(head);
    if (s.receipt) row.appendChild(receiptFacts(s.receipt));
    else row.appendChild(span("mc-none", "No snapshot. This action is from before snapshots existed."));
    if (s.justify && s.justify.at) row.appendChild(writeupNode(s.justify));
    else if (s.justify && s.justify.required)
      row.appendChild(span("mc-missing", "Write-up required and not written yet."));
    return row;
  }

  function noteLine(k, note) {
    const l = divc("mc-note");
    l.appendChild(span("k", k + ", " + note.by + ", " + relTime(note.at)));
    l.appendChild(span("v", note.text));
    return l;
  }

  function paintCaseNotes(card, caseId, notes) {
    const box = card.querySelector(".mc-notes");
    if (!box) return;
    box.innerHTML = "";
    const n = notes || {};
    if (n.mod) box.appendChild(noteLine("Their note", n.mod));
    if (n.reviewer) box.appendChild(noteLine("Reviewer", n.reviewer));
  }

  async function addCaseNote(c, h) {
    const mine = !!h.selfView;
    const existing = (c.notes || {})[mine ? "mod" : "reviewer"];
    const res = await StaffUI.prompt({
      title: mine ? "Your note on this case" : "Reviewer note",
      icon: '<i class="fas fa-pen"></i>',
      message: mine
        ? "Whoever reviews your record reads this beside the evidence. One note per case; writing again replaces it."
        : "Shown to the moderator on their own record as well as to other reviewers.",
      fields: [
        {
          name: "value",
          label: "Note",
          type: "textarea",
          maxLength: 300,
          value: existing ? existing.text : "",
          placeholder: "What the evidence does not show.",
        },
      ],
      confirmText: "Save note",
    });
    if (res == null) return;
    socket.emit("staff case note", {
      caseId: c.id,
      label: h.label,
      role: h.role || "mod",
      text: res,
    });
  }

  function caseDetail(c, h) {
    const body = divc("mc-detail");
    c.steps.forEach((s) => body.appendChild(stepDetail(s)));
    const acts = divc("mc-actions");
    const btn = (label, faIcon, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mh-fbtn";
      b.appendChild(icon(faIcon));
      b.appendChild(document.createTextNode(" " + label));
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        fn();
      });
      return b;
    };
    if (viewerIsFullMod())
      acts.appendChild(btn("Open person", "fa-user", () => openPerson(c.personId)));
    if (c.outcome && c.outcome.appealId)
      acts.appendChild(btn("Open appeal", "fa-scale-balanced", () => openAppealChat(c.outcome.appealId)));
    if (h.selfView || h.canReview)
      acts.appendChild(btn("Note", "fa-pen", () => addCaseNote(c, h)));
    body.appendChild(acts);
    return body;
  }

  function caseCard(c, h) {
    const card = divc("mc-case");
    card.dataset.case = c.id;

    const top = divc("mc-top");
    const who = divc("mc-who");
    who.appendChild(pref(c.names[0] || "?", c.personId));
    c.names.slice(1).forEach((n) => who.appendChild(span("mc-aka", "aka " + n)));
    top.appendChild(who);
    const meta = divc("mc-meta");
    c.rooms.forEach((r) => meta.appendChild(span("mc-room", r)));
    if (c.endTs > c.startTs) meta.appendChild(span("mc-dur", elapsedLabel(c.endTs - c.startTs)));
    const when = span("mc-when", relTime(c.startTs));
    when.title = fmtTime(c.startTs);
    meta.appendChild(when);
    top.appendChild(meta);
    card.appendChild(top);

    const ladder = divc("mc-ladder");
    c.steps.forEach((s, i) => {
      if (i) ladder.appendChild(span("mc-then", "then"));
      const other = s.by !== h.label;
      ladder.appendChild(
        span(
          "mc-step" + (s.heavy ? " heavy" : "") + (other ? " other" : ""),
          s.action + (other ? " (" + s.by + ")" : ""),
        ),
      );
    });
    ladder.appendChild(outcomeChip(c.outcome));
    card.appendChild(ladder);

    const shown =
      c.steps.find((s) => s.receipt && s.receipt.text) || c.steps.find((s) => s.receipt);
    if (shown) {
      const line = divc("mc-quote");
      line.appendChild(
        span(
          "mc-q",
          shown.receipt.text
            ? '"' + shown.receipt.text + '"'
            : shown.receipt.origin === "offline"
              ? "acted on from outside a room"
              : "box empty, no reports",
        ),
      );
      line.appendChild(gradeTag(shown.grade));
      card.appendChild(line);
    }
    const wu = c.steps.find((s) => s.justify && s.justify.at);
    if (wu) card.appendChild(span("mc-why", "Why: " + (wu.justify.fields.did || "")));
    if (c.steps.some((s) => s.justify && s.justify.required && !s.justify.at))
      card.appendChild(span("mc-missing", "No write-up yet"));

    card.appendChild(divc("mc-notes"));
    paintCaseNotes(card, c.id, c.notes);

    const body = divc("mc-body");
    body.hidden = true;
    card.appendChild(body);
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("button, textarea, .uref")) return;
      if (body.hidden && !body.childNodes.length) body.appendChild(caseDetail(c, h));
      body.hidden = !body.hidden;
      card.classList.toggle("open", !body.hidden);
    });
    return card;
  }

  function pager(offset, limit, total, go) {
    if (total <= limit) return null;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.floor(offset / limit) + 1;
    const box = divc("mh-pager");
    const mk = (label, faIcon, atEnd, disabled, target) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.disabled = disabled;
      if (!atEnd) b.appendChild(icon(faIcon));
      b.appendChild(document.createTextNode(label));
      if (atEnd) b.appendChild(icon(faIcon));
      if (!disabled) b.addEventListener("click", () => go(Math.max(0, target)));
      return b;
    };
    box.appendChild(mk(" Newer", "fa-chevron-left", false, offset === 0, offset - limit));
    box.appendChild(
      span(
        null,
        offset + 1 + "-" + Math.min(offset + limit, total) + " of " + total + "  (page " + page + " of " + pages + ")",
      ),
    );
    box.appendChild(mk("Older ", "fa-chevron-right", true, offset + limit >= total, offset + limit));
    return box;
  }

  function casesSection(h) {
    const sect = divc("mh-sect mh-cases");
    sect.appendChild(
      sectionHead(
        "Cases",
        h.casesTotal
          ? h.casesTotal +
              " in total" +
              (h.casesMatched !== h.casesTotal ? ", " + h.casesMatched + " matching" : "")
          : "none yet",
      ),
    );
    sect.appendChild(
      span(
        "mh-qnote",
        "One case is one person, one sitting, every staff member involved. Click a case to see the snapshot behind each step.",
      ),
    );
    const filters = divc("mh-cfilters");
    [
      ["all", "All"],
      ["heavy", "Heavy"],
      ["contradicted", "Contradicted"],
      ["contested", "Contested"],
    ].forEach(([k, l]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mh-fchip" + ((h.caseFilter || "all") === k ? " on" : "");
      b.textContent = l;
      b.addEventListener("click", () => refineRecord({ caseFilter: k, caseOffset: 0 }));
      filters.appendChild(b);
    });
    const mine = document.createElement("button");
    mine.type = "button";
    mine.className = "mh-fchip" + (recordCtx && recordCtx.mineOnly ? " on" : "");
    mine.textContent = "Mine only";
    mine.title = "Hide steps taken by other staff";
    mine.addEventListener("click", () => {
      recordCtx.mineOnly = !recordCtx.mineOnly;
      mine.classList.toggle("on", recordCtx.mineOnly);
      sect.classList.toggle("mine", recordCtx.mineOnly);
    });
    filters.appendChild(mine);
    sect.appendChild(filters);
    if (recordCtx && recordCtx.mineOnly) sect.classList.add("mine");

    const list = divc("mc-list");
    (h.cases || []).forEach((c) => list.appendChild(caseCard(c, h)));
    if (!h.cases || !h.cases.length)
      list.appendChild(
        span(
          "mh-none",
          h.caseFilter && h.caseFilter !== "all"
            ? "No cases match that filter."
            : "No cases yet. Cases appear once they act on somebody.",
        ),
      );
    sect.appendChild(list);
    const pg = pager(h.caseOffset || 0, h.casePage || 25, h.casesMatched || 0, (o) =>
      refineRecord({ caseOffset: o }),
    );
    if (pg) sect.appendChild(pg);
    return sect;
  }

  // Consecutive spectates and the replies on one appeal fold into one row
  // each, so the log reads as work rather than as noise.
  function foldKind(e) {
    const base = String(e.action || "").toLowerCase();
    if (base.startsWith("spectate") || base.startsWith("unspectate")) return "spectate";
    if (base === "reply to appeal") return "appeal";
    return null;
  }

  function foldEntries(list) {
    const out = [];
    for (const e of list) {
      const kind = foldKind(e);
      const prev = out[out.length - 1];
      if (
        kind &&
        prev &&
        prev.fold &&
        prev.fold.kind === kind &&
        (kind !== "appeal" || prev.target === e.target)
      ) {
        prev.fold.items.push(e);
        continue;
      }
      out.push(kind ? { ...e, fold: { kind, items: [e] } } : e);
    }
    return out;
  }

  function foldedRow(e) {
    const items = e.fold.items;
    const first = items[items.length - 1];
    const last = items[0];
    const det = document.createElement("details");
    det.className = "mh-row mh-folded";
    const sum = document.createElement("summary");
    const ic = divc("ico g-" + (e.group || "other"));
    ic.appendChild(icon(e.fold.kind === "appeal" ? "fa-comments" : "fa-eye"));
    sum.appendChild(ic);
    const main = divc("mh-main");
    const top = divc("mh-top");
    if (e.fold.kind === "appeal") {
      const t = parseTarget(e.target);
      top.appendChild(span("mh-act", items.length + " replies on " + (t ? t.name : "an") + " appeal"));
    } else {
      const rooms = new Set(items.map((x) => (parseRoomTag(x.room) || {}).name).filter(Boolean));
      top.appendChild(
        span(
          "mh-act",
          "watched " + rooms.size + (rooms.size === 1 ? " room" : " rooms") + " over " + elapsedLabel(last.ts - first.ts),
        ),
      );
    }
    const when = span("mh-when", relTime(last.ts));
    when.title = fmtTime(first.ts) + " to " + fmtTime(last.ts);
    top.appendChild(when);
    main.appendChild(top);
    sum.appendChild(main);
    det.appendChild(sum);
    const inner = divc("mh-list mh-inner");
    items.forEach((x) => inner.appendChild(recordRow({ ...x, fold: null })));
    det.appendChild(inner);
    return det;
  }

  // ── One person, everything staff know ────────────────────────────────────
  function openPerson(key) {
    if (!key) return;
    socket.emit("staff get person", { key: String(key) });
  }

  function personList(title, rows, empty) {
    const sect = divc("mh-sect");
    sect.appendChild(sectionHead(title, rows.length ? rows.length + "" : null));
    const list = divc("mh-plist");
    if (!rows.length) list.appendChild(span("mh-none", empty));
    rows.forEach((r) => list.appendChild(r));
    sect.appendChild(list);
    return sect;
  }

  function plainRow(main, sub, when) {
    const row = divc("mh-prow");
    const text = divc("mh-ptext");
    text.appendChild(span("mh-pmain", main));
    if (sub) text.appendChild(span("mh-psub", sub));
    row.appendChild(text);
    if (when) {
      const w = span("mh-when", relTime(when));
      w.title = fmtTime(when);
      row.appendChild(w);
    }
    return row;
  }

  async function pinPerson(p, a, b, together) {
    const res = await StaffUI.prompt({
      title: together ? "Same person" : "Not the same person",
      icon: '<i class="fas fa-link"></i>',
      message: together
        ? "Join these two devices into one person. Their cases, reports and bans read as one history from now on."
        : "Split these two devices. They stay apart whatever the addresses say.",
      fields: [{ name: "value", label: "Why", type: "textarea", maxLength: 300, required: true }],
      confirmText: together ? "Join them" : "Keep them apart",
    });
    if (res == null) return;
    socket.emit("staff pin person", { key: p.key, a, b, together, reason: res });
  }

  function renderPerson(p) {
    if (!window.StaffUI || !p) return;
    const wrap = divc("mh-wrap");

    const head = divc("mh-head");
    const av = divc("mh-avatar");
    av.textContent = initialOf(p.names[0] || "?");
    head.appendChild(av);
    const text = divc("mh-htext");
    const name = divc("mh-hname");
    name.appendChild(span("mh-hlabel", p.names[0] || "Unknown"));
    if (p.blocked) name.appendChild(span("mh-rank r-blocked", "blocked"));
    if (p.evader) name.appendChild(span("mh-rank r-evader", "flagged for evasion"));
    text.appendChild(name);
    if (p.names.length > 1)
      text.appendChild(span("mh-hsummary", "Also known as " + p.names.slice(1).join(", ")));
    const facts = divc("mh-hfacts");
    facts.appendChild(
      span(
        null,
        p.standalone
          ? "No device record. Only what the log says about this id."
          : p.devices.length + (p.devices.length === 1 ? " device" : " devices"),
      ),
    );
    if (p.first) facts.appendChild(span(null, "First seen " + relTime(p.first)));
    if (p.last) facts.appendChild(span(null, "Last seen " + relTime(p.last)));
    text.appendChild(facts);
    head.appendChild(text);
    wrap.appendChild(head);

    wrap.appendChild(
      personList(
        "Cases",
        (p.cases || []).map((c) => caseCard(c, { label: null, selfView: false, canReview: false })),
        "Nobody on staff has acted on this person.",
      ),
    );

    if (p.devices.length) {
      const rows = p.devices.map((d, i) => {
        const row = plainRow(
          (d.name || "no name") + "  " + d.id,
          d.addresses + " addresses, " + d.networks + " networks" + (d.evader ? ", flagged for evasion" : ""),
          d.last,
        );
        if (p.canPin && i > 0) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "mh-fbtn";
          b.textContent = "Not the same person";
          b.addEventListener("click", () => pinPerson(p, p.devices[0].id, d.id, false));
          row.appendChild(b);
        }
        return row;
      });
      const edges = (p.edges || []).map((e) =>
        plainRow("Joined: " + e.a + " and " + e.b, "Tier " + e.tier + ": " + e.why),
      );
      wrap.appendChild(personList("Devices, and why they are one person", rows.concat(edges), ""));
    }

    if (p.sameNetwork && p.sameNetwork.length)
      wrap.appendChild(
        personList(
          "On the same network, not joined",
          p.sameNetwork.map((n) => {
            const row = plainRow((n.name || "no name") + "  " + n.id, n.net ? n.net : "shares a network with them", n.last);
            if (p.canPin && p.devices.length) {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "mh-fbtn";
              b.textContent = "Same person";
              b.addEventListener("click", () => pinPerson(p, p.devices[0].id, n.id, true));
              row.appendChild(b);
            }
            return row;
          }),
          "",
        ),
      );

    wrap.appendChild(
      foldSection(
        "Reports about them",
        (p.reports || []).length + "",
        (() => {
          const list = divc("mh-plist");
          (p.reports || []).forEach((r) =>
            list.appendChild(
              plainRow(
                (r.category || "report") + " by " + (r.by || "somebody") + (r.reason ? ": " + r.reason : ""),
                r.text ? '"' + r.text + '"' + (r.wiped ? " (wiped just before the report)" : "") : null,
                r.at,
              ),
            ),
          );
          if (!(p.reports || []).length) list.appendChild(span("mh-none", "No reports."));
          return list;
        })(),
      ),
    );

    wrap.appendChild(
      foldSection(
        "Appeals",
        (p.appeals || []).length + "",
        (() => {
          const list = divc("mh-plist");
          (p.appeals || []).forEach((a) =>
            list.appendChild(
              plainRow(
                (a.status === "resolved" ? a.resolution || "decided" : "open") + ", block by " + (a.banBy || "staff") + (a.banPermanent ? " (permanent)" : ""),
                a.reviewedBy ? "decided by " + a.reviewedBy : null,
                a.at,
              ),
            ),
          );
          if (!(p.appeals || []).length) list.appendChild(span("mh-none", "No appeals."));
          return list;
        })(),
      ),
    );

    wrap.appendChild(
      foldSection(
        "Bans and unbans",
        (p.bans || []).length + "",
        (() => {
          const list = divc("mh-plist");
          (p.bans || []).forEach((b) =>
            list.appendChild(
              plainRow(
                b.action + (b.duration ? " " + b.duration : "") + " by " + (b.by || "staff") + " (" + b.kind + ")",
                b.reason || null,
                b.at,
              ),
            ),
          );
          if (!(p.bans || []).length) list.appendChild(span("mh-none", "Never banned."));
          return list;
        })(),
      ),
    );

    StaffUI.modal({
      title: p.names[0] || "Person",
      icon: '<i class="fas fa-user"></i>',
      subtitle: p.standalone ? "one id" : p.devices.length + " devices, " + (p.cases || []).length + " cases",
      xwide: true,
      body: wrap,
      actions: [{ label: "Close", kind: "primary", onClick: () => {} }],
    });
  }

  // ── Worth a look ────────────────────────────────────────────────────────
  const FLAG_LEVEL = {
    concern: { label: "Concern", icon: "fa-triangle-exclamation" },
    look: { label: "Look", icon: "fa-circle-exclamation" },
    notice: { label: "Notice", icon: "fa-circle-info" },
    reviewed: { label: "Reviewed", icon: "fa-circle-check" },
  };

  function evidenceTable(f) {
    const wrap = divc("mh-ev");
    (f.evidence || []).forEach((e) => {
      const row = divc("mh-evrow");
      const when = span("mh-evwhen", relTime(e.ts));
      when.title = fmtTime(e.ts);
      row.appendChild(when);
      const mid = divc("mh-evmain");
      const top = divc("mh-evtop");
      top.appendChild(span("mh-evact", e.action || "?"));
      if (e.target) {
        top.appendChild(icon("fa-arrow-right", "mh-arrow"));
        top.appendChild(uref(e.target, e.targetId));
      }
      mid.appendChild(top);
      if (e.room) mid.appendChild(span("mh-evroom", e.room));
      if (e.note) mid.appendChild(span("mh-evnote", e.note));
      if (e.quote) mid.appendChild(span("mh-quote", '"' + e.quote + '"'));
      row.appendChild(mid);
      if (e.grade) row.appendChild(gradeTag(e.grade));
      if (e.gap) row.appendChild(span("mh-evgap", e.gap));
      wrap.appendChild(row);
    });
    if (!wrap.childNodes.length)
      wrap.appendChild(span("mh-fbody", "No rows recorded for this one."));
    return wrap;
  }

  function flagRow(f, h) {
    const row = divc("mh-flag " + (f.level || "notice"));
    const meta = FLAG_LEVEL[f.level] || FLAG_LEVEL.notice;

    const head = divc("mh-fhrow");
    head.appendChild(span("mh-flevel " + f.level, meta.label));
    head.appendChild(span("mh-fname", f.title));
    row.appendChild(head);

    row.appendChild(span("mh-fbody", f.detail));
    if (f.innocent)
      row.appendChild(span("mh-finnocent", "Innocent if: " + f.innocent));

    if (f.reviewed) {
      const r = span(
        "mh-freviewed",
        (f.recurredSince ? "Happened again since " : "Reviewed by ") +
          (f.recurredSince
            ? fmtTime(f.recurredSince) + ", after " + f.reviewed.by + " cleared it"
            : f.reviewed.by + " on " + fmtTime(f.reviewed.at)) +
          (f.reviewed.note ? '  "' + f.reviewed.note + '"' : ""),
      );
      row.appendChild(r);
    }

    const acts = divc("mh-factions");
    const n = (f.evidence || []).length;
    if (n) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mh-fbtn";
      btn.appendChild(icon("fa-list"));
      btn.appendChild(document.createTextNode(" Show me (" + n + ")"));
      let table = null;
      btn.addEventListener("click", () => {
        if (table) {
          table.remove();
          table = null;
          btn.lastChild.textContent = " Show me (" + n + ")";
          return;
        }
        table = evidenceTable(f);
        row.appendChild(table);
        btn.lastChild.textContent = " Hide";
      });
      acts.appendChild(btn);
    }

    if (h.canReview) {
      const rb = document.createElement("button");
      rb.type = "button";
      rb.className = "mh-fbtn";
      const asleep = f.level === "reviewed";
      rb.appendChild(icon(asleep ? "fa-bell" : "fa-circle-check"));
      rb.appendChild(
        document.createTextNode(asleep ? " Wake this up" : " Mark reviewed"),
      );
      rb.addEventListener("click", async () => {
        const base = {
          label: h.label,
          role: h.role || "mod",
          key: f.key,
          offset: h.offset,
          limit: h.limit,
          group: h.group,
          targetUid: h.targetUid,
        };
        if (asleep) return socket.emit("staff review flag", { ...base, clear: true });
        const res = await StaffUI.prompt({
          title: "Mark reviewed",
          icon: '<i class="fas fa-circle-check"></i>',
          message:
            "This stops the flag shouting on " +
            (h.label || "this record") +
            ". It wakes back up on its own if the same thing happens again after today.",
          fields: [
            {
              name: "note",
              label: "What did you find?",
              type: "textarea",
              placeholder: "Checked the log - they were bans firing together.",
              maxLength: 300,
            },
          ],
        });
        if (res) socket.emit("staff review flag", { ...base, note: res.note });
      });
      acts.appendChild(rb);
    }
    if (acts.childNodes.length) row.appendChild(acts);
    return row;
  }

  function recordFlags(h) {
    const all = h.flags || [];
    const live = all.filter((f) => f.level !== "reviewed");
    const asleep = all.filter((f) => f.level === "reviewed");

    if (!all.length) {
      if (!h.total) return null;
      const ok = divc("mh-flags clear");
      const head = divc("mh-fhead");
      head.appendChild(icon("fa-circle-check"));
      head.appendChild(span("mh-ftitle", "Nothing odd about the shape of this record"));
      ok.appendChild(head);
      ok.appendChild(
        span(
          "mh-fbody",
          "No padding, no bursts, no one person taking all the attention. This is a check on how the actions are spread, not on whether each one was right.",
        ),
      );
      return ok;
    }

    const worst = live.length ? live[0].level : "reviewed";
    const box = divc("mh-flags " + worst);
    const head = divc("mh-fhead");
    head.appendChild(icon((FLAG_LEVEL[worst] || FLAG_LEVEL.notice).icon));
    head.appendChild(
      span(
        "mh-ftitle",
        live.length
          ? "Worth a look before trusting the total"
          : "All quiet - everything here has been reviewed",
      ),
    );
    box.appendChild(head);

    const shown = live.slice(0, 3);
    const rest = live.slice(3);
    shown.forEach((f) => box.appendChild(flagRow(f, h)));

    const more = rest.concat(asleep);
    if (more.length) {
      const det = document.createElement("details");
      det.className = "mh-fmore";
      const sum = document.createElement("summary");
      const quiet = rest.length
        ? rest.length + (rest.length === 1 ? " quieter signal" : " quieter signals")
        : "";
      const slept = asleep.length
        ? asleep.length + " already reviewed"
        : "";
      sum.textContent = [quiet, slept].filter(Boolean).join(", ");
      det.appendChild(sum);
      more.forEach((f) => det.appendChild(flagRow(f, h)));
      box.appendChild(det);
    }
    return box;
  }

  // ── Promotion ───────────────────────────────────────────────────────────
  function recordPromotion(h, modLevel) {
    if (modLevel !== 1) return null;
    const on = h.onUsers || 0;
    const at = h.promotionAt || PROMOTION_AT;
    const clean = !(h.flags || []).some((f) => f.level === "concern");
    if (on >= at && clean) {
      const p = divc("mh-promote");
      p.appendChild(icon("fa-arrow-up"));
      const txt = divc("mh-ptext");
      txt.appendChild(
        span(
          "mh-ptitle",
          (h.label || "This junior mod") + " has earned a look at full mod",
        ),
      );
      txt.appendChild(
        span(
          "mh-pbody",
          on +
            " actions on actual users as a junior, of which " +
            (h.core || 0) +
            " were kicks, warnings and buffer wipes. Full mods can place bans and IP blocks, close rooms, and work the review queues. Read the log below first - the number is a prompt to look, not a qualification. Promoting is a mod leader's decision.",
        ),
      );
      p.appendChild(txt);
      return p;
    }
    const p = divc("mh-progress");
    const bar = divc("mh-bar");
    const fill = divc("mh-fill");
    fill.style.width = Math.min(100, Math.round((on / at) * 100)) + "%";
    bar.appendChild(fill);
    p.appendChild(
      span(
        "mh-plabel",
        on +
          " of " +
          at +
          " actions on users towards a promotion review" +
          (on >= at ? ", but see the flags above" : ""),
      ),
    );
    p.appendChild(bar);
    return p;
  }

  // ── Who they acted on ───────────────────────────────────────────────────
  function recordTargets(h) {
    const people = h.people || h.targets || [];
    if (!people.length) return null;
    const list = divc("mh-tlist");
    people.forEach((t) => {
      const key = t.uid || t.name;
      const row = divc(
        "mh-trow" + (recordCtx && recordCtx.targetUid === key ? " on" : ""),
      );
      row.title = "Show only what they did to " + t.name;
      row.appendChild(span("mh-tn", String(t.n)));
      const who = divc("mh-twho");
      const name = divc("mh-tname");
      name.appendChild(span(null, t.name));
      (t.aka || []).forEach((n) => name.appendChild(span("mc-aka", "aka " + n)));
      who.appendChild(name);
      who.appendChild(
        span(
          "mh-tacts",
          t.actions.map((a) => a.n + " " + a.action).join("  ·  ") +
            (t.devices > 1 ? "  ·  " + t.devices + " devices" : ""),
        ),
      );
      row.appendChild(who);
      if (viewerIsFullMod()) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "mh-fbtn";
        open.textContent = "Person";
        open.title = "Everything staff know about this person";
        open.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openPerson(t.personId || key);
        });
        row.appendChild(open);
      }
      row.addEventListener("click", () =>
        refineRecord({
          targetUid: recordCtx && recordCtx.targetUid === key ? null : key,
          group: null,
        }),
      );
      list.appendChild(row);
    });
    return list;
  }

  // ── One line of the log ─────────────────────────────────────────────────
  function recordRow(e) {
    if (e.fold && e.fold.items.length > 1) return foldedRow(e);
    const row = divc("mh-row");
    const g = REC_GROUP[e.group] || REC_GROUP.other;
    const ic = divc("ico g-" + (e.group || "other"));
    ic.title = g.label;
    ic.appendChild(icon(g.icon));
    row.appendChild(ic);

    const main = divc("mh-main");
    const top = divc("mh-top");
    const parts = splitAction(e.action);
    top.appendChild(span("mh-act", parts.verb));

    const t = parseTarget(e.target);
    if (t) {
      top.appendChild(icon("fa-arrow-right", "mh-arrow"));
      top.appendChild(uref(t.name, t.uid));
    } else if (e.target) {
      top.appendChild(icon("fa-arrow-right", "mh-arrow"));
      top.appendChild(span("v", e.target));
    }

    const when = span("mh-when", relTime(e.ts));
    when.title = fmtTime(e.ts);
    top.appendChild(when);
    main.appendChild(top);

    const meta = divc("mh-meta");
    const room = parseRoomTag(e.room);
    if (room) {
      const r = span("mh-in");
      r.appendChild(icon("fa-door-open"));
      r.appendChild(document.createTextNode(" " + room.name));
      if (room.id) r.title = "Room " + room.id;
      meta.appendChild(r);
    }
    if (parts.note) meta.appendChild(span("mh-was", parts.note));
    if (e.ip) meta.appendChild(span("ipv", e.ip));
    if (meta.childNodes.length) main.appendChild(meta);

    if (e.details) main.appendChild(span("mh-det", e.details));
    if (e.receipt) {
      const line = divc("mh-receipt");
      if (e.receipt.text && !/text before wipe/.test(e.details || ""))
        line.appendChild(span("mh-quote", '"' + e.receipt.text + '"'));
      line.appendChild(gradeTag(e.receipt.grade));
      main.appendChild(line);
    }
    if (e.justify && e.justify.at) main.appendChild(writeupNode(e.justify));
    else if (e.justify && e.justify.required)
      main.appendChild(span("mc-missing", "No write-up yet"));
    row.appendChild(main);
    return row;
  }

  function dayKey(ts) {
    const d = new Date(ts || 0);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }
  function dayLabel(ts) {
    const d = new Date(ts || 0);
    const today = new Date();
    if (dayKey(ts) === dayKey(today.getTime())) return "Today";
    const y = new Date(today.getTime() - 86400000);
    if (dayKey(ts) === dayKey(y.getTime())) return "Yesterday";
    try {
      return d.toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
    } catch (_) {
      return d.toDateString();
    }
  }

  function renderModHistory(h) {
    if (!window.StaffUI || !h) return;
    if (h.promotionAt) PROMOTION_AT = h.promotionAt;
    if (!recordCtx) {
      recordCtx = {
        label: h.label,
        role: h.role || "mod",
        modLevel: h.role === "dev" ? 0 : 2,
        offset: h.offset || 0,
        group: null,
        targetUid: null,
        host: null,
      };
    }
    const ctx = recordCtx;
    if (recordCtx) {
      recordCtx.group = h.group || null;
      recordCtx.targetUid = h.targetUid || null;
      recordCtx.offset = h.offset || 0;
    }
    const isDev = h.role === "dev";
    const wrap = divc("mh-wrap");

    wrap.appendChild(recordHeader(h, isDev, ctx));

    const overview = divc("mh-pane");
    overview.appendChild(numbersRow(h, isDev));
    const flags = recordFlags(h);
    if (flags) overview.appendChild(flags);
    const snap = snapshotLine(h);
    if (snap) overview.appendChild(snap);
    const promo = h.selfView ? null : recordPromotion(h, ctx.modLevel);
    if (promo) overview.appendChild(promo);

    if (!h.total) {
      overview.appendChild(
        span(
          "mh-none",
          "No recorded actions yet. Either they are new, or they have not used any staff powers.",
        ),
      );
      wrap.appendChild(overview);
      return mountRecord(h, wrap, isDev, ctx);
    }

    const casesPane = divc("mh-pane");
    casesPane.appendChild(casesSection(h));

    const gsect = divc("mh-groups");
    const gwrap = gsect;
    (h.groups || []).forEach((g) => {
      const box = divc("mh-group g-" + g.key);
      const head = divc("mh-ghead");
      head.appendChild(span("mh-gname", g.label));
      head.appendChild(span("mh-gn", String(g.n)));
      box.appendChild(head);
      if (g.blurb) box.appendChild(span("mh-gblurb", g.blurb));
      const chips = divc("mh-counts");
      g.actions.forEach((c) => {
        const chip = divc("mh-chip");
        chip.appendChild(span("n", String(c.n)));
        chip.appendChild(span("a", c.action));
        chips.appendChild(chip);
      });
      box.appendChild(chips);
      gwrap.appendChild(box);
    });
    const log = divc("mh-pane mh-log mh-loghead");
    log.appendChild(sectionHead("What they spend their time on", "whole time as staff"));
    log.appendChild(gsect);
    log.appendChild(sectionHead("Everything they did", "last " + h.windowDays + " days"));

    const peoplePane = divc("mh-pane");
    peoplePane.appendChild(
      sectionHead(
        "Who they acted on",
        h.distinctTargets === 1 ? "one person, ever" : h.distinctTargets + " different people",
      ),
    );
    peoplePane.appendChild(recordTargets(h) || span("mh-none", "Nobody yet."));

    if (ctx.group || ctx.targetUid || ctx.offset) ctx.tab = "actions";
    wrap.appendChild(
      recordTabs(
        [
          { key: "overview", label: "Overview", pane: overview },
          { key: "cases", label: "Cases", count: h.casesTotal || 0, pane: casesPane },
          { key: "actions", label: "Actions", count: h.total || 0, pane: log },
          { key: "people", label: "People", count: h.distinctTargets || 0, pane: peoplePane },
        ],
        ctx,
      ),
    );

    const filters = divc("mh-filters");
    const chip = (label, group) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mh-fchip" + ((ctx.group || null) === group ? " on" : "");
      b.textContent = label;
      b.addEventListener("click", () => refineRecord({ group }));
      return b;
    };
    filters.appendChild(chip("Everything", null));
    (h.groups || []).forEach((g) => filters.appendChild(chip(g.label, g.key)));
    if (recordCtx && recordCtx.targetUid) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "mh-fchip on clear";
      const name =
        (h.targets || []).find(
          (t) => (t.uid || t.name) === recordCtx.targetUid,
        ) || {};
      clear.textContent = "only " + (name.name || "one user") + "  ×";
      clear.title = "Show everyone again";
      clear.addEventListener("click", () => refineRecord({ targetUid: null }));
      filters.appendChild(clear);
    }
    log.appendChild(filters);

    const list = divc("mh-list");
    let lastDay = null;
    foldEntries(h.entries || []).forEach((e) => {
      const k = dayKey(e.ts);
      if (k !== lastDay) {
        lastDay = k;
        list.appendChild(span("mh-day", dayLabel(e.ts)));
      }
      list.appendChild(recordRow(e));
    });
    if (!h.entries || !h.entries.length)
      list.appendChild(
        span(
          "mh-none",
          ctx.group || ctx.targetUid
            ? "Nothing matching that filter in the last " + h.windowDays + " days."
            : "Nothing in the last " + h.windowDays + " days.",
        ),
      );
    log.appendChild(list);

    const shown = h.windowMatched != null ? h.windowMatched : h.windowTotal;
    if (shown > h.limit) {
      const pages = Math.max(1, Math.ceil(shown / h.limit));
      const page = Math.floor(h.offset / h.limit) + 1;
      const pager = divc("mh-pager");
      const mk = (label, faIcon, atEnd, disabled, target) => {
        const b = document.createElement("button");
        b.className = "btn sm";
        b.disabled = disabled;
        if (!atEnd) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode(label));
        if (atEnd) b.appendChild(icon(faIcon));
        if (!disabled)
          b.addEventListener("click", () =>
            refineRecord({ offset: Math.max(0, target) }),
          );
        return b;
      };
      pager.appendChild(
        mk(" Newer", "fa-chevron-left", false, h.offset === 0, h.offset - h.limit),
      );
      pager.appendChild(
        span(
          null,
          h.offset +
            1 +
            "-" +
            Math.min(h.offset + h.limit, shown) +
            " of " +
            shown +
            "  (page " +
            page +
            " of " +
            pages +
            ")",
        ),
      );
      pager.appendChild(
        mk(
          "Older ",
          "fa-chevron-right",
          true,
          h.offset + h.limit >= shown,
          h.offset + h.limit,
        ),
      );
      log.appendChild(pager);
    }
    if (h.total > h.windowTotal)
      log.appendChild(
        span(
          "mh-note",
          "The list covers the last " +
            h.windowDays +
            " days. The figures above are for their whole time as staff and never reset.",
        ),
      );

    return mountRecord(h, wrap, isDev, ctx);
  }

  function mountRecord(h, wrap, isDev, ctx) {
    const rank = isDev
      ? "Admin"
      : ctx.modLevel >= 3
        ? "Mod leader"
        : ctx.modLevel === 1
          ? "Junior moderator"
          : "Moderator";
    const subtitle = isDev
      ? rank + "  ·  " + h.total + " actions logged"
      : rank +
        "  ·  " +
        (h.onUsers || 0) +
        " on users  ·  " +
        h.total +
        " logged in total";

    const open = recordCtx && recordCtx.host;
    if (open && open.isConnected) {
      const body = open.parentNode;
      const card = open.closest(".tk-card");
      const sub = card && card.querySelector(".tk-sub");
      if (sub) sub.textContent = subtitle;
      body.replaceChild(wrap, open);
      recordCtx.host = wrap;
      const anchor = wrap.querySelector(".mh-loghead");
      if (anchor)
        body.scrollTop +=
          anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
      else body.scrollTop = 0;
      return;
    }

    const actions = [
      {
        label: "How this works",
        kind: "ghost",
        onClick: () => {
          openRecordHelp();
          return false;
        },
      },
    ];
    if (h.canExport)
      actions.push({
        label: "Export JSON",
        kind: "ghost",
        onClick: () => {
          socket.emit("staff export record", { label: h.label, role: h.role || "mod" });
          return false;
        },
      });
    actions.push({ label: "Close", kind: "primary", onClick: () => {} });
    StaffUI.modal({
      title: h.selfView ? "Your record" : (h.label || "Staff") + "'s record",
      icon: '<i class="fas fa-clock-rotate-left"></i>',
      subtitle,
      xwide: true,
      body: wrap,
      actions,
      onClose: () => {
        recordCtx = null;
      },
    });
    if (recordCtx) recordCtx.host = wrap;
  }

  function buildFormerCard(f) {
    const card = divc("modcard former");

    const top = divc("mc-top");
    const av = divc("avatar");
    av.style.background = "var(--dim2)";
    av.textContent = initialOf(f.label);
    top.appendChild(av);
    const title = divc("mc-title");
    title.appendChild(span("nm", f.label || "staff"));
    title.appendChild(
      span(
        "chip former",
        f.level >= 3 ? "WAS LEADER" : f.level === 1 ? "WAS MOD L1" : "WAS MOD L2",
      ),
    );
    top.appendChild(title);
    top.appendChild(span("former-tag", "No longer a moderator"));
    card.appendChild(top);

    const why = divc("former-why");
    why.appendChild(span("former-why-k", "Why"));
    why.appendChild(
      span("former-why-v" + (f.reason ? "" : " dim"), f.reason || "Not given"),
    );
    card.appendChild(why);

    const grid = divc("mc-grid");
    grid.appendChild(
      modStat(
        "Removed",
        f.removedAt ? relTime(f.removedAt) : "Unknown",
        f.removedAt ? null : "dim",
        f.removedAt ? fmtTime(f.removedAt) : null,
      ),
    );
    grid.appendChild(
      modStat("Removed by", f.removedBy || "Unknown", f.removedBy ? null : "dim"),
    );
    grid.appendChild(
      modStat("Was granted by", f.grantedBy || "Unknown", f.grantedBy ? null : "dim"),
    );
    grid.appendChild(
      modStat(
        "Held the key",
        f.grantedAt && f.removedAt
          ? Math.max(1, Math.round((f.removedAt - f.grantedAt) / 86400000)) +
              " days"
          : "Unknown",
        f.grantedAt && f.removedAt ? null : "dim",
      ),
    );
    card.appendChild(grid);

    const actions = divc("mc-actions");
    const canSeeFormerRecord =
      viewerIsOps() ||
      viewerIsDev() ||
      (viewerIsLeader() && (f.level || 1) < 3);
    if (canSeeFormerRecord) {
      const histBtn = document.createElement("button");
      histBtn.className = "btn sm";
      histBtn.appendChild(icon("fa-clock-rotate-left"));
      histBtn.appendChild(document.createTextNode(" Their record"));
      histBtn.title =
        "Everything " + (f.label || "this person") + " did as staff";
      histBtn.addEventListener("click", () =>
        openModHistory({ label: f.label, rank: rankForLevel(f.level) }),
      );
      actions.appendChild(histBtn);
    }

    if (viewerIsLeader()) {
      const back = document.createElement("button");
      back.className = "btn sm";
      back.appendChild(icon("fa-rotate-left"));
      back.appendChild(document.createTextNode(" Give the key back"));
      back.title = "Issue a new key under this exact label, record and all";
      back.addEventListener("click", async () => {
        if (!window.StaffUI) return;
        const r = await StaffUI.prompt({
          title: "Give " + (f.label || "them") + " a key again",
          icon: '<i class="fas fa-rotate-left"></i>',
          message:
            'A new key under the same label, so everything "' +
            (f.label || "this person") +
            '" did before still shows up on their record.' +
            (viewerIsDev()
              ? ""
              : " They come back as a junior (L1); promote them once they are settled."),
          fields: viewerIsDev()
            ? [
                {
                  name: "level",
                  label: "Level",
                  type: "select",
                  value: f.level >= 3 ? "3" : f.level === 1 ? "1" : "2",
                  options: [
                    { value: "1", label: "Junior mod (L1) - limited" },
                    { value: "2", label: "Full mod (L2) - all powers" },
                    { value: "3", label: "Mod leader (L3) - runs the team" },
                  ],
                },
              ]
            : [],
          confirmText: "Generate key",
        });
        if (r)
          socket.emit("dev grant mod", {
            label: f.label,
            level: Number(r.level) || 1,
          });
      });
      actions.appendChild(back);
    }

    card.appendChild(actions);
    return card;
  }

  const goneStaff = () => formerMods.filter((f) => !f.returned);

  function renderMods() {
    const wrap = $("modsList");
    if (!wrap) return;
    wrap.textContent = "";
    const roster = buildStaffRoster();
    const gone = goneStaff();
    $("modsBadge").textContent = String(modKeys.length);
    const onlineCount = roster.filter((m) => m.online).length;
    $("modsSub").textContent = roster.length
      ? roster.length +
        " staff  ·  " +
        onlineCount +
        " online now" +
        (gone.length ? "  ·  " + gone.length + " former" : "")
      : "No staff yet";

    if (modsFilter === "former") {
      if (!gone.length) {
        wrap.appendChild(
          emptyBox("fa-user-xmark", "Nobody has been removed from staff."),
        );
        return;
      }
      gone.forEach((f) => wrap.appendChild(buildFormerCard(f)));
      return;
    }

    let list = roster;
    if (["dev", "l3", "l2", "l1"].includes(modsFilter))
      list = roster.filter((m) => m.rank === modsFilter);
    else if (modsFilter === "active") list = roster.filter(isActiveStaff);
    else if (modsFilter === "inactive")
      list = roster.filter((m) => !isActiveStaff(m));
    const order = { dev: 0, l3: 1, l2: 2, l1: 3 };
    list = list
      .slice()
      .sort(
        (a, b) =>
          order[a.rank] - order[b.rank] ||
          (b.lastSeen || 0) - (a.lastSeen || 0),
      );
    if (!list.length) {
      wrap.appendChild(
        emptyBox(
          "fa-user-shield",
          roster.length
            ? "No staff match this filter."
            : "No moderators yet. Grant one above.",
        ),
      );
      return;
    }
    list.forEach((m) => wrap.appendChild(buildModCard(m)));

    if (modsFilter === "all" && gone.length) {
      const div = divc("mods-divider");
      div.appendChild(icon("fa-user-xmark"));
      div.appendChild(span("md-t", "No longer moderators"));
      div.appendChild(
        span(
          "md-s",
          "Off the roster. Their record stays readable.",
        ),
      );
      wrap.appendChild(div);
      gone.forEach((f) => wrap.appendChild(buildFormerCard(f)));
    }
  }
  async function grantMod() {
    if (!window.StaffUI) return;
    const r = await StaffUI.prompt({
      title: "Grant a mod key",
      icon: '<i class="fas fa-user-shield"></i>',
      message:
        "Pick a label so this key can be told apart in the log and list. Junior (L1) mods can kick and warn but cannot ban or IP-block - promote them later once they've proven themselves.",
      fields: [
        {
          name: "value",
          label: "Label (a name or handle)",
          type: "text",
          placeholder: "e.g. Zacki",
          required: true,
          maxLength: 40,
        },
        {
          name: "level",
          label: "Level",
          type: "select",
          value: "1",
          options: [
            { value: "1", label: "Junior mod (L1) - limited" },
            { value: "2", label: "Full mod (L2) - all powers" },
            { value: "3", label: "Mod leader (L3) - runs the team" },
          ],
        },
      ],
      confirmText: "Generate key",
    });
    if (r && r.value)
      socket.emit("dev grant mod", { label: r.value, level: Number(r.level) });
  }

  const REPORT_CATS = {
    spam: { label: "Spam", color: "var(--blue)", icon: "fa-inbox" },
    harassment: {
      label: "Harassment",
      color: "var(--amber)",
      icon: "fa-hand-back-fist",
    },
    hate: { label: "Hate speech", color: "var(--red)", icon: "fa-skull" },
    nsfw: { label: "NSFW", color: "var(--purple)", icon: "fa-image" },
    impersonation: {
      label: "Impersonation",
      color: "var(--blue)",
      icon: "fa-mask",
    },
    threats: {
      label: "Threats",
      color: "var(--red)",
      icon: "fa-triangle-exclamation",
    },
    modabuse: {
      label: "Mod abuse",
      color: "var(--orange)",
      icon: "fa-user-shield",
    },
    other: { label: "Other", color: "var(--dim)", icon: "fa-circle-info" },
  };
  const reportCat = (k) => REPORT_CATS[k] || REPORT_CATS.other;
  const durationLabel = (d) =>
    d === "1h"
      ? "1 hour"
      : d === "24h"
        ? "24 hours"
        : d === "7d"
          ? "7 days"
          : d === "permanent"
            ? "permanently"
            : d;
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // Every block names the rule it enforces. Returns the reason string the
  // server expects, or null when the person backed out.
  async function ensureRule(reason, title) {
    const note = String(reason || "").trim();
    if (/^Rule \d+\b/.test(note)) return note;
    if (!window.StaffUI) return null;
    const field = await StaffUI.communityRuleField({ required: true });
    if (!field) return null;
    const res = await StaffUI.prompt({
      title,
      icon: '<i class="fas fa-ban"></i>',
      message: "Which rule are they being blocked under?",
      fields: [field],
      danger: true,
      confirmText: title,
    });
    if (!res) return null;
    return StaffUI.ruleReason(res.rule, note);
  }

  async function banReported(r, duration) {
    const go = (reason) =>
      socket.emit("staff ip block", {
        targetUserId: r.targetUserId,
        duration,
        reason: reason || "",
      });
    if (!window.StaffUI) return go("");
    const fields = [];
    const ruleField = await StaffUI.communityRuleField({ required: true });
    if (ruleField) fields.push(ruleField);
    fields.push({
      name: "value",
      label: "Reason (optional, saved to the ban list)",
      type: "textarea",
      placeholder: "e.g. Repeated harassment after warnings.",
      maxLength: 500,
    });
    StaffUI.prompt({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      message:
        "Block this user " +
        durationLabel(duration) +
        "? The block covers their device and the network their address sits on (IPv6 /64, IPv4 /24)" +
        (r.online
          ? ". They are disconnected immediately."
          : ". They are offline; the block uses their last known address."),
      fields,
      danger: true,
      confirmText: "Block " + durationLabel(duration),
    }).then((res) => {
      if (res != null) go(StaffUI.ruleReason(res.rule, res.value));
    });
  }
  function dismissReport(r) {
    socket.emit("staff dismiss report", { targetUserId: r.targetUserId });
    reportsList = reportsList.filter((x) => x.targetUserId !== r.targetUserId);
    renderReports();
  }
  function openReportBanMenu(r) {
    if (!window.StaffUI) return banReported(r, "24h");
    const durs = [
      { label: "1 hour", value: "1h", icon: '<i class="fas fa-clock"></i>' },
      { label: "24 hours", value: "24h", icon: '<i class="fas fa-clock"></i>' },
      {
        label: "7 days",
        value: "7d",
        icon: '<i class="fas fa-calendar-week"></i>',
      },
    ];
    if (viewerIsFullMod())
      durs.push({
        label: "Permanent",
        value: "permanent",
        icon: '<i class="fas fa-ban"></i>',
      });
    StaffUI.menu({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      subtitle: r.online
        ? "Pick a duration"
        : "Offline; uses their last known address",
      groups: [
        {
          items: durs.map((d) => ({
            icon: d.icon,
            label: d.label,
            danger: true,
            onClick: () => banReported(r, d.value),
          })),
        },
      ],
    });
  }

  function banDurationOptions() {
    const durations = [
      { value: "1h", label: "1 hour" },
      { value: "24h", label: "24 hours" },
      { value: "7d", label: "7 days" },
    ];
    if (viewerIsFullMod())
      durations.push({ value: "permanent", label: "Permanent" });
    return durations;
  }

  function openBanIpDialog() {
    if (!window.StaffUI) return;
    StaffUI.prompt({
      title: "Ban an IP or range",
      icon: '<i class="fas fa-ban"></i>',
      subtitle: "Blocks the address right away",
      message:
        "Anyone currently connected behind this is disconnected on the spot, and new connections are refused until the ban ends. They see your message on the ban screen.",
      fields: [
        {
          name: "ip",
          label: "Addresses and ranges",
          type: "textarea",
          rows: 7,
          required: true,
          placeholder:
            "203.0.113.7\n151.57.212.0/24\n2601:c4:4200:4890::/64",
          help: "One per line, or separated by commas, so a list can be pasted straight in. A plain address blocks the whole network it sits on (IPv6 /64, IPv4 /24). Anything written CIDR-style is used at the size you wrote, so /32 pins one exact IPv4 address. Everything on the list gets the same duration and message.",
        },
        {
          name: "duration",
          label: "Duration",
          type: "select",
          options: banDurationOptions(),
          value: "24h",
        },
        {
          name: "reason",
          label: "Message shown to them (optional)",
          type: "textarea",
          maxLength: 500,
          placeholder: "e.g. Ban evasion. Appeal from the ban screen.",
        },
      ],
      confirmText: "Place block",
    }).then(async (v) => {
      if (!v || !v.ip || !v.ip.trim()) return;
      const reason = await ensureRule(v.reason, "Place block");
      if (!reason) return;
      socket.emit("staff ban ip", {
        ip: v.ip.trim(),
        duration: v.duration || "24h",
        reason,
      });
    });
  }

  function openBanIdDialog() {
    if (!window.StaffUI) return;
    StaffUI.prompt({
      title: "Ban an ID",
      icon: '<i class="fas fa-fingerprint"></i>',
      subtitle: "Blocks a client id, whatever address it moves to",
      message:
        "Use this for someone who keeps coming back from new addresses. Paste the id shown on their report, appeal, or ban card. They are disconnected right away and see the normal ban screen.",
      fields: [
        {
          name: "id",
          label: "Client id or user id",
          type: "text",
          required: true,
          placeholder: "e.g. 1d9a444c-b844-4a7b-b55c-04c6810fb7bd",
        },
        {
          name: "duration",
          label: "Duration",
          type: "select",
          options: banDurationOptions(),
          value: "7d",
        },
        {
          name: "reason",
          label: "Message shown to them (optional)",
          type: "textarea",
          maxLength: 500,
          placeholder: "e.g. Ban evasion. Appeal from the ban screen.",
        },
      ],
      confirmText: "Ban ID",
    }).then(async (v) => {
      if (!v || !v.id || !v.id.trim()) return;
      const reason = await ensureRule(v.reason, "Ban ID");
      if (!reason) return;
      socket.emit("staff ban ip", {
        ip: v.id.trim(),
        duration: v.duration || "7d",
        reason,
      });
    });
  }

  async function warnReported(r) {
    if (!window.StaffUI)
      return socket.emit("staff warn user", { targetUserId: r.targetUserId });
    const msg = await StaffUI.prompt({
      title: "Warn " + (r.name || "user"),
      icon: '<i class="fas fa-triangle-exclamation"></i>',
      subtitle: r.online
        ? "They will see it right away"
        : "Saved until they next come online",
      confirmText: "Send warning",
      fields: [
        {
          name: "value",
          label: "Message (optional)",
          placeholder: "Please follow the Talkomatic rules.",
          maxLength: 1000,
        },
      ],
    });
    if (msg == null) return;
    socket.emit("staff warn user", {
      targetUserId: r.targetUserId,
      message: String(msg).trim(),
    });
  }

  function renderReports() {
    const wrap = $("reportsList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("reportsBadge");
    if (badge) badge.textContent = String(reportsList.length);
    const sub = $("reportsSub");
    if (sub)
      sub.textContent = reportsList.length
        ? reportsList.length +
          " reported user" +
          (reportsList.length === 1 ? "" : "s")
        : "No reports yet";
    if (!reportsList.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-flag"));
      empty.appendChild(document.createTextNode("No reports right now."));
      wrap.appendChild(empty);
      return;
    }

    reportsList.forEach((r) => {
      const hot = r.distinct >= 3;
      const card = document.createElement("div");
      card.className = "report-card" + (hot ? " hot" : "");

      const head = document.createElement("div");
      head.className = "rc-head";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background = hot ? "var(--red)" : "var(--orange)";
      av.textContent = initialOf(r.name);
      head.appendChild(av);

      const idCol = document.createElement("div");
      idCol.className = "rc-id";
      idCol.appendChild(span("rc-kicker", "Reported user"));
      const rNameNode = uref(r.name || "user", r.targetUserId);
      rNameNode.classList.add("nm");
      idCol.appendChild(rNameNode);
      const meta = document.createElement("div");
      meta.className = "rc-meta";
      if (r.location) {
        const loc = span(null, "");
        loc.appendChild(icon("fa-location-dot"));
        loc.appendChild(document.createTextNode(" " + r.location));
        meta.appendChild(loc);
      }
      const cnt = span("rbadge " + (hot ? "count" : "warm"));
      cnt.appendChild(icon("fa-user-group"));
      cnt.appendChild(
        document.createTextNode(
          " " + r.distinct + (r.distinct === 1 ? " reporter" : " reporters"),
        ),
      );
      meta.appendChild(cnt);
      const st = span("rbadge " + (r.online ? "on" : "off"));
      st.appendChild(icon(r.online ? "fa-circle" : "fa-moon"));
      st.appendChild(
        document.createTextNode(
          " " +
            (r.online
              ? r.roomName
                ? "in " + r.roomName
                : "online"
              : "offline"),
        ),
      );
      meta.appendChild(st);
      if (r.last)
        meta.appendChild(span(null, "last report " + relTime(r.last)));
      idCol.appendChild(meta);
      if (r.targetDeviceId || r.ip) {
        const idLine = span("mono", "");
        if (r.targetDeviceId)
          idLine.appendChild(document.createTextNode("id: " + r.targetDeviceId));
        if (r.ip) {
          if (r.targetDeviceId)
            idLine.appendChild(document.createTextNode("   "));
          idLine.appendChild(document.createTextNode("IP: "));
          idLine.appendChild(span("ip", r.ip));
        }
        idCol.appendChild(idLine);
      }
      head.appendChild(idCol);
      card.appendChild(head);

      const catEntries = Object.entries(r.categories || {}).sort(
        (a, b) => b[1] - a[1],
      );
      if (catEntries.length) {
        const cats = document.createElement("div");
        cats.className = "rc-cats";
        cats.appendChild(span("lead", "Reported for"));
        catEntries.forEach(([k, v]) => {
          const c = reportCat(k);
          const tag = document.createElement("span");
          tag.className = "ctag";
          tag.style.color = c.color;
          tag.appendChild(icon(c.icon));
          tag.appendChild(document.createTextNode(" " + c.label));
          tag.appendChild(span("n", " x" + v));
          cats.appendChild(tag);
        });
        card.appendChild(cats);
      }

      const snapEntry = (r.reasons || []).find(
        (x) => x.targetText && x.targetText.trim(),
      );
      const typedSnap = snapEntry && snapEntry.targetText;
      const typedBox = divc("rc-typed");
      const typedLbl = divc("lbl");
      typedLbl.appendChild(icon("fa-keyboard"));
      typedLbl.appendChild(
        document.createTextNode(
          snapEntry && snapEntry.targetTextWiped
            ? " Their chat box when reported (wiped just before the report)"
            : " Their chat box when reported",
        ),
      );
      typedBox.appendChild(typedLbl);
      const typedTxt = divc("txt" + (typedSnap ? "" : " none"));
      typedTxt.textContent = typedSnap
        ? typedSnap
        : "Nothing captured - their chat box was empty.";
      typedBox.appendChild(typedTxt);
      card.appendChild(typedBox);

      const reasons = r.reasons || [];
      const logHead = document.createElement("div");
      logHead.className = "report-log-head";
      logHead.textContent = "Who reported (" + reasons.length + ")";
      card.appendChild(logHead);
      const log = document.createElement("div");
      log.className = "report-log";
      reasons.forEach((rr) => {
        const c = reportCat(rr.category);
        const item = document.createElement("div");
        item.className = "rlog";
        item.appendChild(span("rl-av", initialOf(rr.by || "?")));
        const m = document.createElement("div");
        m.className = "rl-main";
        const top = document.createElement("div");
        top.className = "rl-top";
        top.appendChild(span("rl-by", rr.by || "Someone"));
        top.appendChild(span("rl-said", "reported for"));
        const cat = span("rl-cat", c.label);
        cat.style.color = c.color;
        cat.style.borderColor = c.color;
        top.appendChild(cat);
        if (rr.at) top.appendChild(span("rl-when", relTime(rr.at)));
        m.appendChild(top);
        m.appendChild(
          span(
            "rl-reason" + (rr.reason ? "" : " none"),
            rr.reason || "No note left",
          ),
        );
        item.appendChild(m);
        log.appendChild(item);
      });
      card.appendChild(log);

      const foot = document.createElement("div");
      foot.className = "rc-foot";
      const mkBtn = (label, faIcon, danger, fn) => {
        const b = document.createElement("button");
        b.className = "btn sm" + (danger ? " danger" : "");
        if (faIcon) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode((faIcon ? " " : "") + label));
        b.addEventListener("click", fn);
        return b;
      };
      foot.appendChild(
        mkBtn("Warn", "fa-triangle-exclamation", false, () => warnReported(r)),
      );
      if (r.online)
        foot.appendChild(
          mkBtn("Kick", "fa-door-open", false, () =>
            socket.emit("staff kick", { targetUserId: r.targetUserId, ban: false }),
          ),
        );
      if (viewerIsFullMod()) {
        if (r.online || r.canBanOffline)
          foot.appendChild(
            mkBtn("IP block", "fa-ban", true, () => openReportBanMenu(r)),
          );
        else
          foot.appendChild(
            span("note", "Offline with no address on file, cannot block."),
          );
      }
      foot.appendChild(span("spacer"));
      if (viewerIsFullMod()) {
        const discard = mkBtn("Discard", "fa-xmark", false, () =>
          dismissReport(r),
        );
        discard.classList.add("rc-discard");
        discard.title = "Clear this report as false or already handled";
        foot.appendChild(discard);
      }
      if (me && me.role === "dev") {
        const del = mkBtn("Delete", "fa-trash", true, () => deleteReport(r));
        del.title = "Remove this report entirely, leaving no record";
        foot.appendChild(del);
      }
      card.appendChild(foot);

      wrap.appendChild(card);
    });
  }

  async function deleteReport(r) {
    if (window.StaffUI) {
      const ok = await StaffUI.confirm({
        title: "Delete report",
        message:
          "Remove every report against " +
          (r.name || "this user") +
          " from the board and the Desk. Nothing is recorded. This cannot be undone.",
        danger: true,
        confirmText: "Delete",
      });
      if (!ok) return;
    }
    socket.emit("staff delete report", { targetUserId: r.targetUserId });
  }

  function appealStatusMeta(a) {
    if (a.status === "resolved") {
      if (a.resolution === "lifted")
        return { badge: "on", icon: "fa-unlock", label: "BAN LIFTED" };
      return { badge: "off", icon: "fa-circle-xmark", label: "DISMISSED" };
    }
    return { badge: "warm", icon: "fa-scale-balanced", label: "OPEN" };
  }
  function untilLabel(ts) {
    const ms = (ts || 0) - Date.now();
    if (ms <= 0) return "ended";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return "ends in " + d + "d " + h + "h";
    if (h > 0) return "ends in " + h + "h " + m + "m";
    return "ends in " + m + "m";
  }
  function resolveAppeal(a, decision, note, barFuture) {
    socket.emit("staff resolve appeal", {
      id: a.id,
      decision,
      note: note || "",
      barFuture: !!barFuture,
    });
  }

  // ── The appeal conversation ──────────────────────────────────────────────
  const appealDrafts = new Map();
  const appealReplyTo = new Map();
  let appealChat = null;

  function openAppealChat(id) {
    if (!window.StaffUI) return;
    const a = appealsList.find((x) => x.id === id);
    if (!a) return;

    const wrap = divc("apm");
    const log = divc("apm-log");
    wrap.appendChild(log);
    const replyHost = divc("apm-replyhost");
    wrap.appendChild(replyHost);
    const foot = divc("apm-foot");
    wrap.appendChild(foot);

    const ctrl = StaffUI.modal({
      title: (a.name || "A banned user") + "'s appeal",
      icon: '<i class="fas fa-scale-balanced"></i>',
      subtitle: appealSubtitle(a),
      wide: true,
      body: wrap,
      actions: [{ label: "Close", kind: "ghost", onClick: () => {} }],
      onClose: () => {
        appealChat = null;
      },
    });

    appealChat = { id, ctrl, log, replyHost, foot, wrap };
    paintAppealChat();
  }

  function appealSubtitle(a) {
    const bits = [];
    bits.push(a.banPermanent ? "Permanent ban" : "Temporary ban");
    if (a.banBy) bits.push("by " + a.banBy);
    if (a.banReason) bits.push('"' + a.banReason + '"');
    bits.push(a.stillBlocked ? "still blocked" : "not blocked");
    return bits.join("  ·  ");
  }

  function paintAppealChat() {
    if (!appealChat) return;
    const a = appealsList.find((x) => x.id === appealChat.id);
    if (!a) return;
    const { log, replyHost, foot } = appealChat;

    const atBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight < 60 ||
      !log.childNodes.length;
    log.textContent = "";

    const msgs = a.messages || [];
    if (!msgs.length) log.appendChild(span("apm-empty", "Nothing said yet."));
    let lastKey = null;
    let lastTs = 0;
    msgs.forEach((m) => {
      if (m.from === "system") {
        log.appendChild(span("apm-sys", m.text));
        lastKey = null;
        return;
      }
      const mine = m.from === "staff";
      const key = mine ? "staff:" + (m.by || "?") : "user";
      const grouped = key === lastKey && m.ts - lastTs < 5 * 60 * 1000;
      lastKey = key;
      lastTs = m.ts;

      const row = divc(
        "apm-m " + (mine ? "staff" : "user") + (grouped ? " grouped" : ""),
      );
      const gut = divc("apm-gut");
      if (!grouped) {
        const av = divc(
          "avatar apm-av" + (mine ? (m.role === "dev" ? " dev" : " mod") : " banned"),
        );
        av.textContent = initialOf(mine ? m.by || "S" : a.name || "?");
        av.title = mine
          ? (m.by || "Staff") + (m.role === "dev" ? " (admin)" : " (moderator)")
          : (a.name || "This user") + " - the banned user";
        gut.appendChild(av);
      }
      row.appendChild(gut);

      const stack = divc("apm-stack");
      if (!grouped) {
        const who = divc("apm-who");
        who.appendChild(
          span("apm-name", mine ? m.by || "Staff" : a.name || "Banned user"),
        );
        who.appendChild(
          span(
            "chip " + (mine ? (m.role === "dev" ? "dev" : "l2") : "banned"),
            mine ? (m.role === "dev" ? "ADMIN" : "MOD") : "BANNED",
          ),
        );
        const t = span("apm-t", relTime(m.ts));
        t.title = fmtTime(m.ts);
        who.appendChild(t);
        stack.appendChild(who);
      }
      const bub = divc("apm-bub");
      if (m.reply) {
        const q = divc("apm-quote");
        q.textContent =
          (m.reply.from === "staff" ? m.reply.by || "Staff" : a.name || "Them") +
          ": " +
          m.reply.text;
        bub.appendChild(q);
      }
      const txt = document.createElement("div");
      txt.textContent = m.text || "";
      bub.appendChild(txt);
      if (a.status === "open" && viewerIsFullMod()) {
        bub.classList.add("clickable");
        bub.title = "Click to reply to this";
        bub.addEventListener("click", () => {
          appealReplyTo.set(a.id, {
            id: m.id,
            by: mine ? m.by || "Staff" : a.name || "Them",
            text: String(m.text || "").slice(0, 90),
          });
          paintAppealChat();
          if (appealChat && appealChat.input) appealChat.input.focus();
        });
      }
      stack.appendChild(bub);
      row.appendChild(stack);
      log.appendChild(row);
    });
    if (atBottom) log.scrollTop = log.scrollHeight;

    replyHost.textContent = "";
    foot.textContent = "";
    appealChat.input = null;

    if (a.status !== "open") {
      foot.appendChild(
        span(
          "apm-closed",
          a.resolution === "lifted"
            ? "Ban lifted" + (a.reviewedBy ? " by " + cleanReviewer(a.reviewedBy) : "") + "."
            : "Appeal declined" +
                (a.reviewedBy ? " by " + cleanReviewer(a.reviewedBy) : "") +
                ". The ban stays in place.",
        ),
      );
      if (a.resolution !== "lifted" && viewerIsFullMod()) {
        const acts = divc("apm-acts");
        const re = document.createElement("button");
        re.className = "btn sm";
        re.appendChild(icon("fa-rotate-left"));
        re.appendChild(document.createTextNode(" Reopen this appeal"));
        re.title = "Put it back on the board and give them their reply box back";
        re.addEventListener("click", async () => {
          const r = await StaffUI.prompt({
            title: "Reopen this appeal",
            icon: '<i class="fas fa-rotate-left"></i>',
            message:
              "It goes back on the board and they can write again. Say why, so the next person reading it knows what changed.",
            fields: [
              {
                name: "note",
                label: "Why (optional, they see this)",
                type: "textarea",
                maxLength: 300,
                placeholder: "e.g. The log does not back up the report.",
              },
            ],
            confirmText: "Reopen",
          });
          if (r == null) return;
          socket.emit("staff appeal reopen", {
            id: a.id,
            note: (r.note || "").trim(),
          });
        });
        acts.appendChild(re);
        foot.appendChild(acts);
      }
      return;
    }
    if (!viewerIsFullMod()) {
      foot.appendChild(span("apm-closed", "Full mods and up answer appeals."));
      return;
    }

    if (a.locked) {
      const note = divc("apm-locked");
      note.appendChild(icon("fa-lock"));
      note.appendChild(
        document.createTextNode(
          " Chat ended" +
            (a.lockedBy ? " by " + a.lockedBy : "") +
            ". They cannot write. You still can.",
        ),
      );
      replyHost.appendChild(note);
    }

    const rt = appealReplyTo.get(a.id);
    if (rt) {
      const bar = divc("ap-replybar");
      bar.appendChild(icon("fa-reply"));
      bar.appendChild(span("ap-replybar-t", "Replying to " + rt.by + ": " + rt.text));
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ap-replybar-x";
      x.textContent = "×";
      x.addEventListener("click", () => {
        appealReplyTo.delete(a.id);
        paintAppealChat();
      });
      bar.appendChild(x);
      replyHost.appendChild(bar);
    }

    const comp = divc("ap-comp");
    const ta = document.createElement("textarea");
    ta.className = "ap-input";
    ta.maxLength = 1000;
    ta.rows = 2;
    ta.placeholder = "Ask them what happened...";
    ta.value = appealDrafts.get(a.id) || "";
    ta.addEventListener("input", () => appealDrafts.set(a.id, ta.value));
    const send = () => {
      const text = ta.value.trim();
      if (!text) return;
      socket.emit("staff appeal reply", {
        id: a.id,
        text,
        replyTo: rt ? rt.id : undefined,
      });
      appealDrafts.delete(a.id);
      appealReplyTo.delete(a.id);
      ta.value = "";
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    comp.appendChild(ta);
    const sendBtn = document.createElement("button");
    sendBtn.className = "btn sm primary";
    sendBtn.appendChild(icon("fa-paper-plane"));
    sendBtn.appendChild(document.createTextNode(" Send"));
    sendBtn.addEventListener("click", send);
    comp.appendChild(sendBtn);
    foot.appendChild(comp);
    appealChat.input = ta;

    const acts = divc("apm-acts");
    const mk = (label, faIcon, cls, fn) => {
      const b = document.createElement("button");
      b.className = "btn sm" + (cls ? " " + cls : "");
      b.appendChild(icon(faIcon));
      b.appendChild(document.createTextNode(" " + label));
      b.addEventListener("click", fn);
      acts.appendChild(b);
    };
    mk(
      a.locked ? "Reopen chat" : "End chat",
      a.locked ? "fa-lock-open" : "fa-lock",
      "",
      () => socket.emit("staff appeal lock", { id: a.id, locked: !a.locked }),
    );
    if (me && me.role === "dev" && a.stillBlocked)
      mk("Lift the ban", "fa-unlock", "primary", async () => {
        const ok = await StaffUI.confirm({
          title: "Lift ban",
          message:
            "Unblock " + (a.name || "this user") + " and accept their appeal?",
          confirmText: "Lift ban",
        });
        if (ok) resolveAppeal(a, "lift");
      });
    mk("Decline", "fa-xmark", "danger", async () => {
      const r = await StaffUI.prompt({
        title: "Decline this appeal",
        icon: '<i class="fas fa-xmark"></i>',
        message:
          "The ban stays in place. Whatever you write here is the last thing they read on their ban screen.",
        fields: [
          {
            name: "note",
            label: "Message to them (optional)",
            type: "textarea",
            maxLength: 300,
          },
          {
            name: "bar",
            type: "checkbox",
            label: "Do not let them appeal again",
            help: "Final. They cannot file another appeal for this or any future ban, until an admin allows it again.",
          },
        ],
        danger: true,
        confirmText: "Decline appeal",
      });
      if (r != null) resolveAppeal(a, "dismiss", (r.note || "").trim(), !!r.bar);
    });
    foot.appendChild(acts);
  }

  function renderAppeals() {
    const wrap = $("appealsList");
    if (!wrap) return;
    wrap.textContent = "";
    const open = appealsList.filter((a) => a.status === "open");
    const badge = $("appealsBadge");
    if (badge) badge.textContent = String(open.length);
    const sub = $("appealsSub");
    if (sub)
      sub.textContent = open.length
        ? open.length +
          " open appeal" +
          (open.length === 1 ? "" : "s") +
          (appealsList.length > open.length
            ? "  ·  " + appealsList.length + " total"
            : "")
        : appealsList.length
          ? "No open appeals  ·  " + appealsList.length + " resolved"
          : "No appeals yet";
    if (!appealsList.length) {
      wrap.appendChild(emptyBox("fa-scale-balanced", "No ban appeals yet."));
      return;
    }
    const isDev = me && me.role === "dev";

    appealsList.forEach((a) => {
      const sm = appealStatusMeta(a);
      const card = divc(
        "appealcard" + (a.status === "resolved" ? " resolved" : ""),
      );

      const head = divc("ap-head");
      const av = divc("avatar");
      av.style.background = a.status === "open" ? "var(--amber)" : "var(--line)";
      av.textContent = initialOf(a.name);
      head.appendChild(av);
      const idc = divc("ap-id");
      idc.appendChild(span("ap-kicker", "Appealing user"));
      // No name on file at all: the client id still identifies them.
      const shown =
        a.name || (a.deviceId ? "Client " + a.deviceId.slice(0, 8) : "Unknown user");
      let nameNode;
      if (a.userId) {
        nameNode = uref(shown, a.userId);
        nameNode.classList.add("nm");
      } else {
        nameNode = span("nm", shown);
      }
      idc.appendChild(nameNode);
      (a.knownAs || []).forEach((n) => idc.appendChild(span("mc-aka", "aka " + n)));
      const meta = divc("ap-meta");
      const stb = span("rbadge " + sm.badge);
      stb.appendChild(icon(sm.icon));
      stb.appendChild(document.createTextNode(" " + sm.label));
      meta.appendChild(stb);
      if (a.reopenedBy) {
        const re = span("rbadge warm");
        re.appendChild(icon("fa-rotate-left"));
        re.appendChild(
          document.createTextNode(" reopened by " + a.reopenedBy),
        );
        meta.appendChild(re);
      }
      const blk = span("rbadge " + (a.stillBlocked ? "off" : "on"));
      blk.appendChild(icon(a.stillBlocked ? "fa-ban" : "fa-unlock"));
      blk.appendChild(
        document.createTextNode(
          a.stillBlocked ? " Still blocked" : " Not blocked",
        ),
      );
      meta.appendChild(blk);
      if (a.at) {
        const t = span(null, "appealed " + relTime(a.at));
        t.title = fmtTime(a.at);
        meta.appendChild(t);
      }
      idc.appendChild(meta);
      head.appendChild(idc);
      card.appendChild(head);

      const grid = divc("ap-grid");

      const contest = divc("ap-box contest");
      const cl = divc("lbl");
      cl.appendChild(icon("fa-ban"));
      cl.appendChild(document.createTextNode(" Ban they are contesting"));
      contest.appendChild(cl);
      const cv = divc("val");
      const banBits = [];
      banBits.push(
        a.banPermanent
          ? "Permanent ban"
          : "Temporary ban" +
              (a.banExpiry ? " (" + untilLabel(a.banExpiry) + ")" : ""),
      );
      if (a.banBy) banBits.push("by " + a.banBy);
      const banLine = document.createElement("div");
      banLine.textContent = banBits.join("  ·  ");
      cv.appendChild(banLine);
      const reasonLine = document.createElement("div");
      reasonLine.style.marginTop = "5px";
      reasonLine.style.color = "var(--dim)";
      reasonLine.textContent = a.banReason
        ? "Reason: " + a.banReason
        : "No ban reason on file.";
      cv.appendChild(reasonLine);
      contest.appendChild(cv);
      grid.appendChild(contest);

      const chatBox = divc("ap-box ap-open");
      const cl2 = divc("lbl");
      cl2.appendChild(icon("fa-comments"));
      cl2.appendChild(document.createTextNode(" Conversation"));
      if (a.waiting) cl2.appendChild(span("ap-waiting", "waiting on you"));
      chatBox.appendChild(cl2);
      const last = (a.messages || [])[(a.messages || []).length - 1];
      const preview = divc("ap-prev");
      preview.textContent = last
        ? (last.from === "staff"
            ? (last.by || "Staff") + ": "
            : last.from === "user"
              ? (a.name || "Them") + ": "
              : "") + String(last.text || "").slice(0, 120)
        : "Nothing said yet.";
      chatBox.appendChild(preview);
      const openBtn = document.createElement("button");
      openBtn.className = "btn sm primary";
      openBtn.appendChild(icon("fa-comments"));
      openBtn.appendChild(
        document.createTextNode(
          " Open the conversation" +
            (a.messages && a.messages.length
              ? " (" + a.messages.length + ")"
              : ""),
        ),
      );
      openBtn.addEventListener("click", () => openAppealChat(a.id));
      chatBox.appendChild(openBtn);
      grid.appendChild(chatBox);
      card.appendChild(grid);

      const foot = divc("ap-foot");
      const info = divc("ap-info");
      if (a.status === "resolved") {
        info.appendChild(
          span(
            null,
            (a.resolution === "lifted" ? "Ban lifted" : "Dismissed") +
              (a.reviewedBy ? " by " + cleanReviewer(a.reviewedBy) : "") +
              (a.reviewedAt ? " · " + relTime(a.reviewedAt) : ""),
          ),
        );
      }
      if (a.barId) {
        const b = span("ap-barred");
        b.appendChild(icon("fa-ban"));
        b.appendChild(
          document.createTextNode(
            " No further appeals" +
              (a.barredBy ? " · set by " + a.barredBy : "") +
              (a.barredAt ? " · " + relTime(a.barredAt) : ""),
          ),
        );
        info.appendChild(b);
      }
      if (a.deviceId || a.ip) {
        const idLine = span("mono", "");
        if (a.deviceId)
          idLine.appendChild(document.createTextNode("id: " + a.deviceId));
        if (a.ip) {
          if (a.deviceId) idLine.appendChild(document.createTextNode("   "));
          idLine.appendChild(document.createTextNode("IP: "));
          idLine.appendChild(span("ip", a.ip));
        }
        info.appendChild(idLine);
      }
      foot.appendChild(info);

      if (a.barId && isDev) {
        const allow = document.createElement("button");
        allow.className = "btn sm";
        allow.appendChild(icon("fa-rotate-left"));
        allow.appendChild(document.createTextNode(" Allow appeals again"));
        allow.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Allow appeals again",
              message:
                "Let " +
                (a.name || "this user") +
                " file appeals again. The ban itself is not affected.",
              confirmText: "Allow",
            });
            if (!ok) return;
          }
          socket.emit("staff appeal unbar", { barId: a.barId, name: a.name });
        });
        foot.appendChild(allow);
      }

      if (a.status === "open" && viewerIsFullMod()) {
        const actions = divc("ap-actions");
        if (isDev && a.stillBlocked) {
          const lift = document.createElement("button");
          lift.className = "btn sm primary";
          lift.appendChild(icon("fa-unlock"));
          lift.appendChild(document.createTextNode(" Lift ban"));
          lift.addEventListener("click", async () => {
            if (window.StaffUI) {
              const ok = await StaffUI.confirm({
                title: "Lift ban",
                message:
                  "Unblock " +
                  (a.name || "this user") +
                  "'s IP and accept their appeal?",
                confirmText: "Lift ban",
              });
              if (!ok) return;
            }
            resolveAppeal(a, "lift");
          });
          actions.appendChild(lift);
        }
        const lock = document.createElement("button");
        lock.className = "btn sm";
        lock.appendChild(icon(a.locked ? "fa-lock-open" : "fa-lock"));
        lock.appendChild(
          document.createTextNode(a.locked ? " Reopen chat" : " End chat"),
        );
        lock.title = a.locked
          ? "Let them write again"
          : "Stop them writing. The appeal stays open and you still decide it.";
        lock.addEventListener("click", async () => {
          if (!a.locked && window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "End this chat",
              message:
                "They will not be able to send any more messages. The appeal stays open and you still decide it.",
              confirmText: "End chat",
            });
            if (!ok) return;
          }
          socket.emit("staff appeal lock", { id: a.id, locked: !a.locked });
        });
        actions.appendChild(lock);

        const dismiss = document.createElement("button");
        dismiss.className = "btn sm danger";
        dismiss.appendChild(icon("fa-xmark"));
        dismiss.appendChild(document.createTextNode(" Decline"));
        dismiss.addEventListener("click", async () => {
          if (!window.StaffUI) return resolveAppeal(a, "dismiss");
          const r = await StaffUI.prompt({
            title: "Decline this appeal",
            icon: '<i class="fas fa-xmark"></i>',
            message:
              "The ban stays in place. Whatever you write here is the last thing they read on their ban screen.",
            fields: [
              {
                name: "note",
                label: "Message to them (optional)",
                type: "textarea",
                maxLength: 300,
                placeholder: "e.g. The chat log backs up the report. Try again in a week.",
              },
              {
                name: "bar",
                type: "checkbox",
                label: "Do not let them appeal again",
                help: "Final. They cannot file another appeal for this or any future ban, until an admin allows it again.",
              },
            ],
            danger: true,
            confirmText: "Decline appeal",
          });
          if (r == null) return;
          resolveAppeal(a, "dismiss", (r.note || "").trim(), !!r.bar);
        });
        actions.appendChild(dismiss);
        foot.appendChild(actions);
      }
      if (isDev) {
        const del = document.createElement("button");
        del.className = "btn sm danger";
        del.appendChild(icon("fa-trash"));
        del.appendChild(document.createTextNode(" Delete"));
        del.title = "Remove this appeal and its whole conversation";
        del.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Delete this appeal",
              message:
                "The appeal and its whole conversation are removed for good. They can file a fresh one afterwards.",
              confirmText: "Delete",
              danger: true,
            });
            if (!ok) return;
          }
          socket.emit("staff appeal delete", { id: a.id });
        });
        let host = foot.querySelector(".ap-actions");
        if (!host) {
          host = divc("ap-actions");
          foot.appendChild(host);
        }
        host.appendChild(del);
      }
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  function resolveSuggestion(s, decision) {
    socket.emit("staff resolve suggestion", { id: s.id, decision });
  }

  function renderSuggestions() {
    const wrap = $("suggestionsList");
    if (!wrap) return;
    wrap.textContent = "";
    const open = suggestionsList.filter((s) => s.status === "open");
    const badge = $("suggestionsBadge");
    if (badge) badge.textContent = String(open.length);
    const sub = $("suggestionsSub");
    if (sub)
      sub.textContent = open.length
        ? open.length +
          " open suggestion" +
          (open.length === 1 ? "" : "s") +
          (suggestionsList.length > open.length
            ? "  ·  " + suggestionsList.length + " total"
            : "")
        : suggestionsList.length
          ? "No open suggestions  ·  " + suggestionsList.length + " reviewed"
          : "No suggestions yet";
    if (!suggestionsList.length) {
      wrap.appendChild(emptyBox("fa-lightbulb", "No suggestions yet."));
      return;
    }

    suggestionsList.forEach((s) => {
      const card = divc(
        "appealcard" + (s.status === "resolved" ? " resolved" : ""),
      );

      const head = divc("ap-head");
      const av = divc("avatar");
      av.style.background = s.status === "open" ? "var(--amber)" : "var(--line)";
      av.textContent = initialOf(s.name);
      head.appendChild(av);
      const idc = divc("ap-id");
      idc.appendChild(span("ap-kicker", "Suggested by"));
      let nameNode;
      if (s.userId) {
        nameNode = uref(s.name || "user", s.userId);
        nameNode.classList.add("nm");
      } else {
        nameNode = span("nm", s.name || "A user");
      }
      idc.appendChild(nameNode);
      const meta = divc("ap-meta");
      if (s.at) {
        const t = span(null, "sent " + relTime(s.at));
        t.title = fmtTime(s.at);
        meta.appendChild(t);
      }
      idc.appendChild(meta);
      head.appendChild(idc);
      card.appendChild(head);

      const box = divc("ap-box");
      const bl = divc("lbl");
      bl.appendChild(icon("fa-lightbulb"));
      bl.appendChild(document.createTextNode(" Suggestion"));
      box.appendChild(bl);
      const bv = divc("val" + (s.text ? "" : " none"));
      bv.textContent = s.text || "No text.";
      box.appendChild(bv);
      card.appendChild(box);

      const foot = divc("ap-foot");
      const info = divc("ap-info");
      if (s.status === "resolved") {
        info.appendChild(
          span(
            null,
            (s.resolution === "approved" ? "Approved" : "Declined") +
              (s.reviewedBy ? " by " + cleanReviewer(s.reviewedBy) : "") +
              (s.reviewedAt ? " · " + relTime(s.reviewedAt) : ""),
          ),
        );
      }
      foot.appendChild(info);

      if (s.status === "open" && viewerIsFullMod()) {
        const actions = divc("ap-actions");
        const approve = document.createElement("button");
        approve.className = "btn sm primary";
        approve.appendChild(icon("fa-check"));
        approve.appendChild(document.createTextNode(" Approve"));
        approve.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Approve suggestion",
              message: "Mark this suggestion as approved?",
              confirmText: "Approve",
            });
            if (!ok) return;
          }
          resolveSuggestion(s, "approve");
        });
        actions.appendChild(approve);
        const decline = document.createElement("button");
        decline.className = "btn sm danger";
        decline.appendChild(icon("fa-xmark"));
        decline.appendChild(document.createTextNode(" Decline"));
        decline.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Decline suggestion",
              danger: true,
              message: "Decline this suggestion?",
              confirmText: "Decline",
            });
            if (!ok) return;
          }
          resolveSuggestion(s, "decline");
        });
        actions.appendChild(decline);
        foot.appendChild(actions);
      }
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  function appStatusMeta(status) {
    if (status === "approved")
      return {
        cls: "st-approved",
        badge: "on",
        icon: "fa-circle-check",
        av: "var(--green)",
      };
    if (status === "rejected")
      return {
        cls: "st-rejected",
        badge: "off",
        icon: "fa-circle-xmark",
        av: "#3a3f4a",
      };
    if (status === "withdrawn")
      return {
        cls: "st-rejected",
        badge: "off",
        icon: "fa-hand",
        av: "#3a3f4a",
      };
    return {
      cls: "st-pending",
      badge: "warm",
      icon: "fa-hourglass-half",
      av: "var(--orange)",
    };
  }
  function cleanReviewer(s) {
    s = String(s || "");
    const i = s.indexOf(":");
    return (i >= 0 ? s.slice(i + 1) : s) || s;
  }
  function qaBlock(ic, label, text) {
    const b = divc("qa");
    const q = divc("qa-q");
    q.appendChild(icon(ic));
    q.appendChild(document.createTextNode(" " + label));
    b.appendChild(q);
    const a = divc("qa-a" + (text ? "" : " none"));
    a.textContent = text || "Not provided";
    b.appendChild(a);
    return b;
  }
  function buildPager(page, pages, onGo) {
    const pager = divc("pager");
    const mk = (label, faIcon, atEnd, disabled, target) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.disabled = disabled;
      if (!atEnd) b.appendChild(icon(faIcon));
      b.appendChild(document.createTextNode(label));
      if (atEnd) b.appendChild(icon(faIcon));
      if (!disabled) b.addEventListener("click", () => onGo(target));
      return b;
    };
    pager.appendChild(
      mk(" Prev", "fa-chevron-left", false, page === 0, page - 1),
    );
    pager.appendChild(span(null, "Page " + (page + 1) + " of " + pages));
    pager.appendChild(
      mk("Next ", "fa-chevron-right", true, page >= pages - 1, page + 1),
    );
    return pager;
  }

  function buildAppCard(a) {
    const sm = appStatusMeta(a.status);
    const card = divc("appcard " + sm.cls);

    const head = divc("ac-head");
    const av = divc("avatar");
    av.style.background = sm.av;
    av.textContent = initialOf(a.username);
    head.appendChild(av);
    const idc = divc("ac-id");
    idc.appendChild(span("ac-kicker", "Mod applicant"));
    idc.appendChild(span("ac-name", a.username || "Anonymous"));
    const meta = divc("ac-meta");
    const badge = span("rbadge " + sm.badge);
    badge.appendChild(icon(sm.icon));
    badge.appendChild(
      document.createTextNode(" " + (a.status || "pending").toUpperCase()),
    );
    meta.appendChild(badge);
    const hasDiscord = !!(a.discord || a.discordId);
    const dbadge = span("rbadge " + (hasDiscord ? "on" : "off"));
    dbadge.appendChild(icon(hasDiscord ? "fa-check" : "fa-xmark"));
    dbadge.appendChild(
      document.createTextNode(
        a.discord ? " @" + a.discord : hasDiscord ? " Discord linked" : " No Discord",
      ),
    );
    dbadge.title = hasDiscord
      ? "Search this in the Talkomatic Discord. If you approve them, give them the site mod role there."
      : a.answers && a.answers.hasDiscord === false
        ? "They said they do not have Discord. That is allowed; decisions reach them on the site."
        : "This applicant gave no Discord account.";
    meta.appendChild(dbadge);
    if (a.answers && a.answers.agreed) {
      const abadge = span("rbadge on");
      abadge.appendChild(icon("fa-file-signature"));
      abadge.appendChild(document.createTextNode(" 14+ & terms"));
      abadge.title = "Confirmed they are 14 or older and agreed to the moderator terms.";
      meta.appendChild(abadge);
    }
    if (a.submittedAt) {
      const t = span(null, "applied " + relTime(a.submittedAt));
      t.title = fmtTime(a.submittedAt);
      meta.appendChild(t);
    }
    idc.appendChild(meta);
    head.appendChild(idc);
    card.appendChild(head);

    const qa = divc("ac-qa");
    qa.appendChild(
      qaBlock(
        "fa-circle-question",
        "Why they want to help",
        (a.answers && a.answers.why) || "",
      ),
    );
    if (a.answers && a.answers.experience !== undefined)
      qa.appendChild(
        qaBlock(
          "fa-clipboard-list",
          "Past moderation experience",
          a.answers.experience || "",
        ),
      );
    qa.appendChild(
      qaBlock(
        "fa-clock",
        "Availability",
        (a.answers && a.answers.availability) || "",
      ),
    );
    card.appendChild(qa);

    const foot = divc("ac-foot");
    const info = divc("ac-info");
    if (a.status !== "pending" && (a.reviewedBy || a.reviewedAt || a.reason)) {
      const rline = span(null, "");
      rline.appendChild(
        document.createTextNode(
          (a.status === "approved"
            ? "Approved"
            : a.status === "withdrawn"
              ? "Approved, then turned down by the applicant. Reviewed"
              : "Rejected") + " ",
        ),
      );
      if (a.reviewedBy) {
        rline.appendChild(document.createTextNode("by "));
        const b = document.createElement("b");
        b.textContent = cleanReviewer(a.reviewedBy);
        rline.appendChild(b);
      }
      if (a.reviewedAt) {
        const w = span(null, " · " + relTime(a.reviewedAt));
        w.title = fmtTime(a.reviewedAt);
        rline.appendChild(w);
      }
      info.appendChild(rline);
      if (a.reason) info.appendChild(span(null, "Reason: " + a.reason));
      if (a.status === "approved")
        info.appendChild(
          span(
            null,
            a.claimed ? "Role accepted" : "Waiting for them to accept the role",
          ),
        );
    }
    if (a.discord || a.discordId) {
      const bits = [];
      if (a.discord) bits.push("@" + a.discord);
      if (a.discordId) bits.push("id " + a.discordId);
      const dLine = span("mono", "discord: " + bits.join("  ·  "));
      dLine.title = "Search this in the Talkomatic Discord server";
      info.appendChild(dLine);
    }
    if (a.deviceId || a.ip) {
      const idLine = span("mono", "");
      if (a.deviceId)
        idLine.appendChild(document.createTextNode("id: " + a.deviceId));
      if (a.ip) {
        if (a.deviceId) idLine.appendChild(document.createTextNode("   "));
        idLine.appendChild(document.createTextNode("IP: "));
        idLine.appendChild(span("ip", a.ip));
      }
      info.appendChild(idLine);
    }
    foot.appendChild(info);

    if (a.status === "pending" && viewerIsLeader()) {
      const actions = divc("ac-actions");
      const approve = document.createElement("button");
      approve.className = "btn sm primary";
      approve.appendChild(icon("fa-check"));
      approve.appendChild(document.createTextNode(" Approve (L1)"));
      approve.addEventListener("click", async () => {
        let msg = "";
        if (window.StaffUI) {
          msg = await StaffUI.prompt({
            title: "Approve application",
            icon: '<i class="fas fa-check"></i>',
            subtitle: a.username || "this user",
            message:
              "Approve " +
              (a.username || "this user") +
              " as a junior (L1) moderator? They get a mod key right away." +
              (a.discord || a.discordId
                ? " Remember to give " +
                  (a.discord ? "@" + a.discord : "them") +
                  " the site mod role in the Talkomatic Discord so they can reach the rest of the team."
                : " They gave no Discord, so there is no way to reach them off-site."),
            fields: [
              {
                name: "value",
                label: "Message to the applicant (optional, they will see it)",
                type: "text",
                maxLength: 300,
              },
            ],
            confirmText: "Approve",
          });
          if (msg === null) return;
        }
        socket.emit("mod application review", {
          id: a.id,
          decision: "approve",
          reason: msg || "",
        });
      });
      const reject = document.createElement("button");
      reject.className = "btn sm danger";
      reject.appendChild(icon("fa-xmark"));
      reject.appendChild(document.createTextNode(" Reject"));
      reject.addEventListener("click", async () => {
        let reason = "";
        if (window.StaffUI) {
          reason = await StaffUI.prompt({
            title: "Reject application",
            icon: '<i class="fas fa-xmark"></i>',
            subtitle: a.username || "this user",
            fields: [
              {
                name: "value",
                label: "Message to the applicant (optional, they will see it)",
                type: "text",
                maxLength: 300,
              },
            ],
            confirmText: "Reject",
          });
          if (reason === null) return;
        }
        socket.emit("mod application review", {
          id: a.id,
          decision: "reject",
          reason: reason || "",
        });
      });
      actions.appendChild(approve);
      actions.appendChild(reject);
      foot.appendChild(actions);
    }
    card.appendChild(foot);
    return card;
  }

  function renderApplicationsToggle() {
    const btn = $("appsToggle");
    if (!btn) return;
    const canToggle = viewerIsLeader();
    btn.style.display = canToggle ? "" : "none";
    if (!canToggle) return;
    btn.innerHTML = applicationsOpen
      ? '<i class="fas fa-lock"></i> Close applications'
      : '<i class="fas fa-lock-open"></i> Open applications';
    btn.classList.toggle("danger", applicationsOpen);
    btn.title = applicationsOpen
      ? "Stop accepting new moderator applications"
      : "Resume accepting new moderator applications";
  }

  function renderApps() {
    const wrap = $("appsList");
    if (!wrap) return;
    renderApplicationsToggle();
    wrap.textContent = "";
    const pending = applicationsList.filter((a) => a.status === "pending");
    const badge = $("appsBadge");
    if (badge) badge.textContent = String(pending.length);
    const sub = $("appsSub");
    if (sub) {
      sub.textContent = pending.length
        ? pending.length +
          " awaiting review" +
          (applicationsList.length > pending.length
            ? "  ·  " + applicationsList.length + " total"
            : "")
        : applicationsList.length
          ? "No applications awaiting review  ·  " +
            applicationsList.length +
            " total"
          : "No applications yet";
      if (!applicationsOpen) sub.textContent += "  ·  CLOSED to new applications";
    }

    if (applicationsList.length === 0) {
      wrap.appendChild(emptyBox("fa-user-pen", "No applications yet."));
      return;
    }

    let list = applicationsList.slice();
    if (appsFilter !== "all")
      list = list.filter((a) =>
        appsFilter === "rejected"
          ? a.status === "rejected" || a.status === "withdrawn"
          : (a.status || "pending") === appsFilter,
      );
    if (appsQuery)
      list = list.filter((a) =>
        [
          a.username,
          a.answers && a.answers.why,
          a.answers && a.answers.experience,
          a.answers && a.answers.availability,
          a.reason,
          a.reviewedBy,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(appsQuery),
      );

    if (list.length === 0) {
      wrap.appendChild(
        emptyBox(
          "fa-filter-circle-xmark",
          appsQuery
            ? "No applications match your search."
            : "No " +
                (appsFilter === "all" ? "" : appsFilter + " ") +
                "applications.",
        ),
      );
      return;
    }

    const pages = Math.max(1, Math.ceil(list.length / APPS_PAGE));
    if (appsPage >= pages) appsPage = pages - 1;
    if (appsPage < 0) appsPage = 0;
    const start = appsPage * APPS_PAGE;
    list
      .slice(start, start + APPS_PAGE)
      .forEach((a) => wrap.appendChild(buildAppCard(a)));
    if (pages > 1)
      wrap.appendChild(
        buildPager(appsPage, pages, (p) => {
          appsPage = p;
          renderApps();
        }),
      );
  }

  let sessionData = { sessions: [], history: [] };

  function netKeyOf(ip) {
    const s = String(ip || "");
    if (s.indexOf(":") === -1) return { key: s, label: s, v6: false };
    let head = s.split("::")[0].split(":").filter(Boolean);
    if (head.length < 4) {
      const tail = (s.split("::")[1] || "").split(":").filter(Boolean);
      const missing = 8 - head.length - tail.length;
      head = head.concat(new Array(Math.max(0, missing)).fill("0"), tail);
    }
    const prefix = head.slice(0, 4).join(":");
    return { key: "v6:" + prefix, label: prefix + "::/64", v6: true };
  }

  function groupNetworks(entries) {
    const groups = new Map();
    for (const e of entries) {
      const ip = typeof e === "string" ? e : e && e.ip;
      if (!ip) continue;
      const meta = typeof e === "string" ? {} : e;
      const nk = netKeyOf(ip);
      if (!groups.has(nk.key))
        groups.set(nk.key, {
          label: nk.label,
          v6: nk.v6,
          ips: [],
          last: 0,
          count: 0,
        });
      const g = groups.get(nk.key);
      g.ips.push(ip);
      g.count += meta.count || 1;
      if (meta.last && meta.last > g.last) g.last = meta.last;
    }
    return [...groups.values()].sort((a, b) => b.last - a.last);
  }

  function netRow(g) {
    const row = divc("netrow");
    row.appendChild(span("net", g.v6 && g.ips.length > 1 ? g.label : g.ips[0]));
    if (g.ips.length > 1)
      row.appendChild(span("cnt", g.ips.length + " addresses"));
    if (g.last) {
      const t = span("lastseen", "last " + relTime(g.last));
      t.title = fmtTime(g.last);
      row.appendChild(t);
    }
    if (g.ips.length > 1) {
      const btn = document.createElement("button");
      btn.className = "net-expand";
      btn.textContent = "show all";
      const list = divc("netlist");
      g.ips.forEach((ip) => list.appendChild(span("one", ip)));
      btn.addEventListener("click", () => {
        const open = row.classList.toggle("open");
        btn.textContent = open ? "hide" : "show all";
      });
      row.appendChild(btn);
      row.appendChild(list);
    }
    return row;
  }

  function sessKeyCard(label, role, groups, pill, hiddenCount) {
    const card = divc("sesscard");
    const top = divc("sess-top");
    const av = divc("avatar");
    av.style.background = role === "dev" ? "var(--red)" : "var(--orange)";
    av.textContent = initialOf(label);
    top.appendChild(av);
    const title = divc("sess-title");
    title.appendChild(document.createTextNode(label || "?"));
    title.appendChild(
      span(
        "chip " + (role === "dev" ? "dev" : "mod"),
        (role || "?").toUpperCase(),
      ),
    );
    top.appendChild(title);
    if (pill) top.appendChild(pill);
    card.appendChild(top);
    const nets = divc("sess-nets");
    if (!groups.length) {
      nets.appendChild(
        span(
          "cnt",
          hiddenCount == null
            ? "No addresses recorded yet."
            : hiddenCount +
              (hiddenCount === 1 ? " address" : " addresses") +
              " on file. The addresses themselves are not shown.",
        ),
      );
    } else groups.forEach((g) => nets.appendChild(netRow(g)));
    card.appendChild(nets);
    return card;
  }

  function emptyCard(wrap, ic, text) {
    const e = document.createElement("div");
    e.className = "empty";
    e.appendChild(icon(ic));
    e.appendChild(document.createTextNode(text));
    wrap.appendChild(e);
  }
  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : /s$/.test(word) ? "es" : "s");
  }

  function keyRank(h) {
    if (h.role === "dev") return "dev";
    const lvl = h.level || 1;
    return lvl >= 3 ? "l3" : lvl >= 2 ? "l2" : "l1";
  }

  // What the network history means, in one sentence, plus the pill it gets.
  function netStatus(h, live) {
    const n = h.network || { level: "ok", v4Count: 0, v6Count: 0, windowDays: 7 };
    if (h.removed) return { pill: "off", label: "Removed", text: "This key no longer works." };
    const liveNets = live ? groupNetworks(live.ips || []).length || live.ipCount || 1 : 0;
    if (liveNets > 1)
      return {
        pill: "perm",
        label: liveNets + " networks at once",
        text: "Connected from " + liveNets + " different networks right now. Two people may be holding this key.",
        cls: "cold",
      };
    switch (n.level) {
      case "review":
      case "revoke":
        return {
          pill: "perm",
          label: n.v4Count + " networks",
          text: n.v4Count + " network families in " + n.windowDays + " days. A phone on the move does this, a shared key does too. Worth a look.",
          cls: "cold",
        };
      case "warn":
        return {
          pill: "warn",
          label: "2 networks",
          text: "Two network families in " + n.windowDays + " days. Keep an eye on it.",
          cls: "stale",
        };
      case "mixed":
        return { pill: "mixed", label: "IPv4 + IPv6", text: "One connection speaking IPv4 and IPv6. Nothing to do." };
      default:
        return { pill: "live", label: "OK", text: "All use comes from one network.", cls: "fresh" };
    }
  }

  function keyCard(h, online, live) {
    const rankKey = keyRank(h);
    const rank = RANKS[rankKey] || RANKS.l2;
    const st = netStatus(h, live);
    const card = divc("modcard rank-" + rankKey + (h.removed ? " former" : ""));

    const top = divc("mc-top");
    const av = divc("avatar");
    av.style.background = rank.color;
    av.textContent = initialOf(h.label);
    top.appendChild(av);
    const title = divc("mc-title");
    title.appendChild(span("nm", h.label || "?"));
    title.appendChild(span(rank.chip, rank.name));
    top.appendChild(title);
    const dot = span("live-dot " + (online ? "on" : "off"));
    dot.appendChild(document.createTextNode(online ? "Online now" : "Offline"));
    top.appendChild(dot);
    card.appendChild(top);

    const grid = divc("mc-grid");
    const status = divc("mc-stat");
    status.appendChild(span("mc-k", "Status"));
    const sv = span("mc-v");
    sv.appendChild(span("pill " + st.pill, st.label));
    sv.title = st.text;
    status.appendChild(sv);
    grid.appendChild(status);
    if (live) grid.appendChild(modStat("Open tabs", String(live.sessionCount || 1)));
    if (h.profile && h.profile.name) grid.appendChild(modStat("Signs in as", h.profile.name));
    const ls = h.lastSeen ? lastSeenMeta(h.lastSeen) : null;
    grid.appendChild(
      modStat("Last seen", ls ? ls.text : "Never", ls ? ls.cls : "dim", h.lastSeen ? fmtTime(h.lastSeen) : null),
    );
    const nets = h.network ? h.network.v4Count + h.network.v6Count : h.ipCount || 0;
    grid.appendChild(modStat("Networks", nets ? String(nets) : "None yet", nets ? null : "dim", "Network families used in the last 7 days"));
    const devs = (h.devices || []).length;
    grid.appendChild(modStat("Devices", devs ? String(devs) : "None yet", devs ? null : "dim", "Browsers this key has been used in"));
    grid.appendChild(
      modStat("Typed in", plural(h.entered || 0, "time"), h.entered ? null : "dim", h.enteredLast ? "Last typed in " + fmtTime(h.enteredLast) : "Times the key was typed into the staff box"),
    );
    if (h.removed)
      grid.appendChild(
        modStat(
          "Removed",
          (h.removed.at ? relTime(h.removed.at) : "Unknown") + (h.removed.by ? " by " + h.removed.by : "") + (h.removed.reason ? ". " + h.removed.reason : ""),
          "cold",
          h.removed.at ? fmtTime(h.removed.at) : null,
        ),
      );
    card.appendChild(grid);

    const note = divc("mc-note");
    note.textContent = st.text;
    card.appendChild(note);

    const actions = divc("mc-actions");
    const toggle = document.createElement("button");
    toggle.className = "btn sm";
    toggle.appendChild(icon("fa-network-wired"));
    toggle.appendChild(document.createTextNode(" Networks and devices"));
    toggle.addEventListener("click", () => {
      const open = card.classList.toggle("open");
      toggle.lastChild.textContent = open ? " Hide networks and devices" : " Networks and devices";
    });
    actions.appendChild(toggle);
    if (h.actHash && !h.removed) {
      const rm = document.createElement("button");
      rm.className = "btn sm danger";
      rm.appendChild(icon("fa-user-slash"));
      rm.appendChild(document.createTextNode(" Remove key"));
      rm.addEventListener("click", async () => {
        if (!window.StaffUI) return;
        const v = await StaffUI.prompt({
          title: "Remove " + (h.label || "this") + "'s key",
          icon: '<i class="fas fa-user-slash"></i>',
          message: "The key stops working everywhere at once. They are told why.",
          fields: [{ name: "reason", label: "Reason", type: "text", required: true, placeholder: "e.g. key shared with someone else" }],
          confirmText: "Remove key",
        });
        if (!v || !v.reason) return;
        socket.emit("dev revoke mod", { hash: h.actHash, reason: v.reason.trim() });
        setTimeout(() => socket.emit("dev get sessions"), 600);
      });
      actions.appendChild(rm);
    }
    card.appendChild(actions);

    const det = divc("mc-details");
    const nh = span("mc-k", "Networks");
    det.appendChild(nh);
    const groups = groupNetworks(h.ips || []);
    if (groups.length) groups.forEach((g) => det.appendChild(netRow(g)));
    else
      det.appendChild(
        span(
          "mc-v dim",
          h.ipCount ? plural(h.ipCount, "address") + " on file." : "No addresses recorded yet.",
        ),
      );
    det.appendChild(span("mc-k", "Devices"));
    if ((h.devices || []).length) {
      const list = divc("devlist");
      for (const d of h.devices) {
        const chip = divc("devchip");
        chip.appendChild(span("id", d.id));
        chip.appendChild(span("sub", "seen " + plural(d.count || 1, "time") + ", last " + relTime(d.last)));
        if (d.ips && d.ips.length) chip.appendChild(span("sub", d.ips.join(", ")));
        else if (d.ipCount) chip.appendChild(span("sub", plural(d.ipCount, "address")));
        list.appendChild(chip);
      }
      det.appendChild(list);
    } else det.appendChild(span("mc-v dim", "No devices recorded yet."));
    card.appendChild(det);
    return card;
  }

  function renderSessions() {
    const active = $("sessionsActive");
    const hist = $("sessionsHistory");
    const removed = $("sessionsRemoved");
    const sessions = sessionData.sessions || [];
    const history = sessionData.history || [];
    const byHash = new Map(history.map((h) => [h.hash, h]));
    const onlineSet = new Set(sessions.map((s) => s.hash));
    const watch = history.filter(
      (h) => !h.removed && h.network && ["warn", "review", "revoke"].includes(h.network.level),
    ).length;
    $("sessionsBadge").textContent = String(sessions.length);
    $("sessionsSub").textContent =
      (sessions.length ? plural(sessions.length, "key") + " connected" : "No staff connected right now") +
      (watch ? ", " + watch + " worth a look" : "");

    active.textContent = "";
    if (!sessions.length)
      emptyCard(active, "fa-plug-circle-xmark", "No staff are connected right now.");
    for (const s of sessions) {
      const h = byHash.get(s.hash) || {
        hash: s.hash,
        label: s.label,
        role: s.role,
        ips: s.ips,
        ipCount: s.ipCount,
        devices: [],
      };
      active.appendChild(keyCard(h, true, s));
    }

    const current = history.filter((h) => !h.removed);
    const gone = history.filter((h) => h.removed);
    hist.textContent = "";
    if (!current.length) emptyCard(hist, "fa-clock-rotate-left", "No key history yet.");
    current
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .forEach((h) => hist.appendChild(keyCard(h, onlineSet.has(h.hash))));
    removed.textContent = "";
    if (!gone.length) emptyCard(removed, "fa-user-check", "No keys have been removed.");
    gone
      .sort((a, b) => ((b.removed && b.removed.at) || 0) - ((a.removed && a.removed.at) || 0))
      .forEach((h) => removed.appendChild(keyCard(h, false)));
  }

  // ── Allowed link domains ──────────────────────────────────────────────────
  let allowedLinkHosts = [];

  socket.on("dev link whitelist", (d) => {
    allowedLinkHosts = Array.isArray(d && d.hosts) ? d.hosts : [];
    renderLinkAllowList();
  });

  function linkAllowRow(host) {
    const card = divc("modcard link-allow-row");
    const top = divc("mc-top");
    const title = divc("mc-title");
    title.appendChild(icon("fa-link"));
    title.appendChild(span("nm", host));
    top.appendChild(title);
    top.appendChild(
      span("covers", "covers " + host + " and www." + host + ", no other subdomains"),
    );
    card.appendChild(top);
    const actions = divc("mc-actions");
    const rm = document.createElement("button");
    rm.className = "btn sm danger";
    rm.appendChild(icon("fa-trash"));
    rm.appendChild(document.createTextNode(" Remove"));
    rm.addEventListener("click", async () => {
      if (window.StaffUI) {
        const ok = await StaffUI.confirm({
          title: "Stop allowing " + host,
          message: 'Links to "' + host + '" will be removed from chat again.',
          confirmText: "Remove",
        });
        if (!ok) return;
      }
      socket.emit("dev link whitelist remove", { host });
    });
    actions.appendChild(rm);
    card.appendChild(actions);
    return card;
  }

  function renderLinkAllowList() {
    const list = $("linkAllowList");
    if (!list) return;
    list.innerHTML = "";
    if (!allowedLinkHosts.length) {
      list.appendChild(
        emptyBox(
          "fa-link-slash",
          "No domains allowed. Every link is removed from chat.",
        ),
      );
      return;
    }
    allowedLinkHosts.forEach((h) => list.appendChild(linkAllowRow(h)));
  }

  function submitLinkAllow() {
    const input = $("linkAllowInput");
    if (!input) return;
    const v = input.value.trim();
    if (!v) return;
    socket.emit("dev link whitelist add", { host: v });
    input.value = "";
  }

  const linkAllowAddBtn = $("linkAllowAdd");
  if (linkAllowAddBtn)
    linkAllowAddBtn.addEventListener("click", submitLinkAllow);
  const linkAllowInputEl = $("linkAllowInput");
  if (linkAllowInputEl)
    linkAllowInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitLinkAllow();
      }
    });

  function switchTab(name) {
    tab = name;
    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.toggle("active", n.dataset.tab === name));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));
    const panel = $("tab-" + name);
    if (panel) panel.classList.add("active");
    if (name === "activity") flushPending();
    if (name === "bans") {
      socket.emit("dev list blocks");
      socket.emit("staff get ban history");
      startBanTimer();
    }
    if (name === "mods") {
      socket.emit("dev list mod keys");
      socket.emit("dev get sessions");
    }
    if (name === "sessions") socket.emit("dev get sessions");
    if (name === "announce") socket.emit("announcement list");
    if (name === "links") socket.emit("dev link whitelist");
    if (name === "rules") socket.emit("rules get");
    if (name === "applications") socket.emit("mod applications list");
    if (name === "reports") socket.emit("staff get reports");
    if (name === "appeals") socket.emit("staff get appeals");
    if (name === "suggestions") socket.emit("staff get suggestions");
    if (window.innerWidth <= 860) document.body.classList.add("nav-closed");
  }
  function updateNotifBadge() {
    const b = document.getElementById("notifCount");
    if (!b) return;
    b.textContent = unreadNotifs > 0 ? String(unreadNotifs) : "";
    b.style.display = unreadNotifs > 0 ? "" : "none";
  }

  const viewerIsDev = () => !!(me && me.role === "dev");
  const viewerIsFullMod = () =>
    viewerIsDev() || !!(me && (me.modLevel || 1) >= 2);
  const viewerIsLeader = () =>
    viewerIsDev() || !!(me && (me.modLevel || 1) >= 3);
  const viewerIsOps = () => !!(me && me.mainDev);

  let diagInstalled = false;
  function installDiag() {
    if (diagInstalled || !viewerIsOps()) return;
    diagInstalled = true;
    const send = (kind, o) =>
      socket.emit("diag apply", Object.assign({ kind }, o || {}));
    window.__diag = {
      lag: (ms, o) => send("lag", Object.assign({ ms: ms || 800 }, o || {})),
      self: (ms, o) =>
        send("lag", Object.assign({ ms: ms || 800, scope: { self: true } }, o)),
      room: (id, ms, o) =>
        send("lag", Object.assign({ ms: ms || 800, scope: { room: id } }, o)),
      drop: (o) => socket.emit("diag drop", o || {}),
      hold: (secs, o) =>
        socket.emit("diag drop", Object.assign({ hold: secs || 10 }, o)),
      close: () => socket.emit("diag gate", { open: false }),
      open: () => socket.emit("diag gate", { open: true }),
      clear: () => socket.emit("diag clear"),
      status: () => socket.emit("diag status"),
    };
    socket.on("diag status", (s) => console.log("[diag]", s));
  }

  function readOnlyNote(panelId, text) {
    const panel = $(panelId);
    if (!panel) return;
    const existing = panel.querySelector(".ro-note");
    if (viewerIsFullMod()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const note = divc("ro-note");
    note.appendChild(icon("fa-eye"));
    note.appendChild(document.createTextNode(" " + text));
    const strip = panel.querySelector(".strip");
    if (strip && strip.nextSibling)
      panel.insertBefore(note, strip.nextSibling);
    else panel.insertBefore(note, panel.firstChild);
  }

  function applyRoleGating() {
    document.querySelectorAll(".nav-item[data-dev]").forEach((n) => {
      n.style.display = viewerIsDev() ? "" : "none";
    });
    document.querySelectorAll(".nav-item[data-lead]").forEach((n) => {
      n.style.display = viewerIsLeader() ? "" : "none";
    });
    document.querySelectorAll(".nav-item[data-min2]").forEach((n) => {
      n.style.display = viewerIsFullMod() ? "" : "none";
    });

    // Leaders get the announcements tab as an emergency path; the warning
    // above the composer is for them, so admins never see it.
    const lw = $("anLeaderWarn");
    if (lw) lw.style.display = viewerIsLeader() && !viewerIsDev() ? "" : "none";

    const gated = [
      ["grantMod", viewerIsDev()],
      ["appsToggle", viewerIsLeader()],
    ];
    gated.forEach(([id, ok]) => {
      const el = $(id);
      if (el) el.style.display = ok ? "" : "none";
    });
    ["banIpBtn", "banIdBtn"].forEach((id) => {
      const el = $(id);
      if (el) el.style.display = viewerIsFullMod() ? "" : "none";
    });

    readOnlyNote(
      "tab-reports",
      "You can warn and kick from here. Discarding a report and IP blocking are full-mod actions.",
    );
    readOnlyNote(
      "tab-mods",
      "Anyone on staff can read the roster. Applications, promotions, and key removals belong to mod leaders; leader keys themselves are an admin decision.",
    );

    renderApplicationsToggle();
  }

  function loadBoards() {
    [
      "dev list blocks",
      "staff get ban history",
      "mod applications list",
      "staff get reports",
      "staff get appeals",
      "dev list mod keys",
      "dev get sessions",
    ].forEach((ev) => socket.emit(ev));
  }

  const guideHelp = $("guideRecordHelp");
  if (guideHelp) guideHelp.addEventListener("click", openRecordHelp);

  socket.on("connect", () => {
    socket.emit("staff get audit", { limit: 20000 });
    loadBoards();
  });

  socket.on("audit snapshot", (data) => {
    authorized = true;
    loadingEl.classList.add("hidden");
    deniedEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    if (Array.isArray(data && data.days) && data.days.length) {
      const wasReading = weekDays[dayIndex];
      weekDays = data.days;
      const stillThere = weekDays.indexOf(wasReading);
      dayIndex = stillThere >= 0 ? stillThere : weekDays.length - 1;
    } else if (data && data.dayStart) {
      weekDays = [data.dayStart];
      dayIndex = 0;
    }
    dayStart = weekDays[dayIndex];
    updateDayLabel();
    entries = (Array.isArray(data && data.entries) ? data.entries : []).filter(
      (e) => e.type !== "writeup",
    );
    commentsByRef.clear();
    for (const e of entries)
      if (e.type === "comment" && e.refId) {
        if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
        commentsByRef.get(e.refId).push(e);
      }
    me = data && data.me;
    if (me) {
      meEl.textContent = "";
      meEl.appendChild(
        span(
          "chip " + (me.role === "dev" ? "dev" : "mod"),
          (me.role || "staff").toUpperCase(),
        ),
      );
      meEl.appendChild(document.createTextNode(" " + (me.label || "")));
    }
    installDiag();
    applyRoleGating();
    renderRoster(data && data.roster);
    renderLegend();
    renderDayPicker();
    renderActivity();

  });

  socket.on("audit entry", (e) => {
    if (!e) return;
    entries.push(e);
    if (
      e.type === "notification" &&
      !(tab === "activity" && feedFilter === "notification")
    ) {
      unreadNotifs++;
      updateNotifBadge();
    }
    if (e.type === "comment" && e.refId) {
      if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
      commentsByRef.get(e.refId).push(e);
      const card = listEl.querySelector('.entry[data-id="' + e.refId + '"]');
      if (card) appendComment(card, e);
      return;
    }
    if (e.type === "writeup" && e.refId) {
      attachWriteup(e);
      return;
    }
    pendingNew.push(e);
    scheduleFlush();
  });

  // A write-up arrives as its own entry pointing at the block it explains.
  // The block's card gets the text; the write-up row itself is never shown.
  function attachWriteup(w) {
    const block = entries.find((x) => x.id === w.refId);
    if (!block) return;
    const j = block.justify || (block.justify = { required: true });
    if (w.amend) j.addenda = (j.addenda || []).concat([{ text: w.text, at: w.ts }]);
    else Object.assign(j, { fields: w.fields, rule: w.rule, at: w.ts, by: w.label });
    const card = listEl.querySelector('.entry[data-id="' + block.id + '"]');
    if (card) card.replaceWith(buildCard(block));
  }

  socket.on("audit removed", (d) => {
    if (d && Array.isArray(d.ids)) dropEntries(d.ids);
  });

  socket.on("dev blocks", (list) => {
    bans = Array.isArray(list) ? list : [];
    renderBans();
    renderBanHistory();
  });

  socket.on("staff ban history", (list) => {
    banHistory = Array.isArray(list) ? list : [];
    renderBanHistory();
  });

  socket.on("dev mod keys", (list) => {
    modKeys = Array.isArray(list) ? list : [];
    renderMods();
  });

  socket.on("dev former mods", (list) => {
    formerMods = Array.isArray(list) ? list : [];
    renderMods();
  });

  socket.on("mod applications", (list) => {
    applicationsList = Array.isArray(list) ? list : [];
    renderApps();
  });

  socket.on("applications state", (d) => {
    applicationsOpen = !d || d.open !== false;
    renderApplicationsToggle();
    renderApps();
  });

  socket.on("staff reports", (list) => {
    reportsList = Array.isArray(list) ? list : [];
    renderReports();
  });

  socket.on("staff appeals", (list) => {
    appealsList = Array.isArray(list) ? list : [];
    renderAppeals();
    paintAppealChat();
  });

  socket.on("staff suggestions", (list) => {
    suggestionsList = Array.isArray(list) ? list : [];
    renderSuggestions();
  });

  socket.on("staff mod history", (h) => renderModHistory(h));

  socket.on("staff record export", (d) => {
    if (!d || !d.record) return;
    const name =
      "record-" +
      String(d.label || "staff").replace(/[^a-z0-9]+/gi, "-").toLowerCase() +
      "-" +
      new Date().toISOString().slice(0, 10) +
      ".json";
    const blob = new Blob([JSON.stringify(d.record, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (window.StaffUI)
      StaffUI.toast("Saved as " + name, { type: "success", title: "Record exported" });
  });

  socket.on("staff case note", (d) => {
    if (!d || !recordCtx) return;
    const card = document.querySelector('.mc-case[data-case="' + d.caseId + '"]');
    if (card) paintCaseNotes(card, d.caseId, d.notes);
  });

  socket.on("staff person", (p) => renderPerson(p));

  socket.on("dev sessions", (data) => {
    sessionData = data || { sessions: [], history: [] };
    renderSessions();
    renderMods();
  });

  socket.on("dev mod granted", (d) => {
    if (!d || !d.key || !window.StaffUI) return;
    const w = document.createElement("div");
    const p1 = document.createElement("p");
    p1.textContent =
      "New " +
      (d.level >= 3 ? "leader (L3)" : d.level === 1 ? "junior (L1)" : "full (L2)") +
      ' mod key for "' +
      (d.label || "mod") +
      '". Copy it now: it is shown once and never stored.';
    const code = document.createElement("div");
    code.className = "mono";
    code.style.cssText =
      "background:#000;border:1px solid #333;padding:10px;margin:10px 0;word-break:break-all;border-radius:6px;color:#ff9800;";
    code.textContent = d.key;
    w.appendChild(p1);
    w.appendChild(code);
    StaffUI.modal({
      title: "Mod key created",
      icon: '<i class="fas fa-key"></i>',
      body: w,
      actions: [
        {
          label: "Copy key",
          kind: "primary",
          onClick: () => {
            try {
              navigator.clipboard.writeText(d.key);
            } catch (_) {}
          },
        },
        { label: "Done", onClick: () => {} },
      ],
    });
  });

  socket.on("staff action result", (d) => {
    if (d && window.StaffUI) StaffUI.actionToast(d);
  });

  const showDenied = () => {
    if (authorized) return;
    loadingEl.classList.add("hidden");
    appEl.classList.add("hidden");
    deniedEl.classList.remove("hidden");
  };
  socket.on("error", (e) => {
    if (!authorized) return showDenied();
    const msg = (e && e.error && e.error.message) || (e && e.message) || null;
    if (msg && window.StaffUI) StaffUI.toast(msg, { type: "error" });
  });
  socket.on("connect_error", showDenied);
  let waited = 0;
  const waitTimer = setInterval(() => {
    if (authorized) return clearInterval(waitTimer);
    waited += 2500;
    if (!socket.connected) {
      if (waited >= 10000) {
        clearInterval(waitTimer);
        showDenied();
      }
      return;
    }
    const p = loadingEl.querySelector("p");
    if (p)
      p.textContent =
        waited >= 15000
          ? "Still loading. The server is busy; this can take a moment on a large log."
          : "Verifying your staff key.";
  }, 2500);

  let pendingStaffKey = null;
  async function openStaffKeyEntry() {
    if (!window.StaffUI) return;
    const key = await StaffUI.prompt({
      title: "Staff access",
      icon: '<i class="fas fa-key"></i>',
      subtitle: "Enter your dev or mod key",
      message: "Verified on the server, then saved to this browser.",
      fields: [
        {
          name: "value",
          label: "Staff key",
          type: "password",
          placeholder: "paste your key",
          required: true,
        },
      ],
      confirmText: "Unlock",
    });
    if (key) {
      pendingStaffKey = key;
      socket.emit("staff validate key", { key });
    }
  }
  socket.on("staff key result", (d) => {
    if (!d || !d.role) {
      if (window.StaffUI)
        StaffUI.toast(
          d && d.throttled
            ? "Too many attempts. Wait a few minutes."
            : "That key was not recognized.",
          { type: "error" },
        );
      pendingStaffKey = null;
      return;
    }
    if (d.role === "dev")
      localStorage.setItem("talkomatic_devKey", pendingStaffKey);
    else localStorage.setItem("talkomatic_modKey", pendingStaffKey);
    pendingStaffKey = null;
    if (window.StaffUI)
      StaffUI.toast("Key accepted. Reloading.", { type: "success" });
    setTimeout(() => window.location.reload(), 1000);
  });

  $("enterKeyBtn") &&
    $("enterKeyBtn").addEventListener("click", openStaffKeyEntry);
  $("navToggle").addEventListener("click", () =>
    document.body.classList.toggle("nav-closed"),
  );
  $("navBackdrop").addEventListener("click", () =>
    document.body.classList.add("nav-closed"),
  );
  document
    .querySelectorAll(".nav-item")
    .forEach((n) =>
      n.addEventListener("click", () => switchTab(n.dataset.tab)),
    );
  $("bansRefresh").addEventListener("click", () => {
    socket.emit("dev list blocks");
    socket.emit("staff get ban history");
  });
  $("banIpBtn") && $("banIpBtn").addEventListener("click", openBanIpDialog);
  $("banIdBtn") && $("banIdBtn").addEventListener("click", openBanIdDialog);

  let banSearchDebounce = null;
  $("banSearch") &&
    $("banSearch").addEventListener("input", () => {
      clearTimeout(banSearchDebounce);
      banSearchDebounce = setTimeout(() => {
        bansQuery = $("banSearch").value.trim().toLowerCase();
        renderBans();
      }, 200);
    });
  document.querySelectorAll("#banSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#banSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      bansFilter = btn.dataset.b || "all";
      renderBans();
    });
  });

  let banHistDebounce = null;
  $("banHistSearch") &&
    $("banHistSearch").addEventListener("input", () => {
      clearTimeout(banHistDebounce);
      banHistDebounce = setTimeout(() => {
        banHistQuery = $("banHistSearch").value.trim().toLowerCase();
        renderBanHistory();
      }, 200);
    });
  document.querySelectorAll("#banHistSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#banHistSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      banHistFilter = btn.dataset.h || "all";
      renderBanHistory();
    });
  });

  document.querySelectorAll("#modsSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#modsSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      modsFilter = btn.dataset.m || "all";
      renderMods();
    });
  });
  $("modsRefresh").addEventListener("click", () => {
    socket.emit("dev list mod keys");
    socket.emit("dev get sessions");
  });
  $("sessionsRefresh") &&
    $("sessionsRefresh").addEventListener("click", () =>
      socket.emit("dev get sessions"),
    );
  $("grantMod").addEventListener("click", grantMod);
  $("appsRefresh") &&
    $("appsRefresh").addEventListener("click", () =>
      socket.emit("mod applications list"),
    );
  $("appsToggle") &&
    $("appsToggle").addEventListener("click", () =>
      socket.emit("dev set applications open", { open: !applicationsOpen }),
    );
  $("reportsRefresh") &&
    $("reportsRefresh").addEventListener("click", () =>
      socket.emit("staff get reports"),
    );
  $("appealsRefresh") &&
    $("appealsRefresh").addEventListener("click", () =>
      socket.emit("staff get appeals"),
    );
  $("suggestionsRefresh") &&
    $("suggestionsRefresh").addEventListener("click", () =>
      socket.emit("staff get suggestions"),
    );
  document.querySelectorAll("#appsSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#appsSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      appsFilter = btn.dataset.s || "pending";
      appsPage = 0;
      renderApps();
    });
  });
  let appsSearchDebounce = null;
  $("appsSearch") &&
    $("appsSearch").addEventListener("input", () => {
      clearTimeout(appsSearchDebounce);
      appsSearchDebounce = setTimeout(() => {
        appsQuery = $("appsSearch").value.trim().toLowerCase();
        appsPage = 0;
        renderApps();
      }, 200);
    });

  let searchDebounce = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = searchEl.value.trim().toLowerCase();
      renderActivity();
    }, 200);
  });
  document.querySelectorAll("#filterSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#filterSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      feedFilter = btn.dataset.f;
      if (feedFilter === "notification") {
        unreadNotifs = 0;
        updateNotifBadge();
      }
      renderActivity();
    });
  });

  if (window.innerWidth > 860) document.body.classList.remove("nav-closed");

  // ── Rules (dev only) ──────────────────────────────────────────────────────
  let rulesData = { community: [], mod: [] };
  let rulesDraft = null;
  let rulesSection = "community";
  let rulesDirty = false;

  function rulesMarkDirty() {
    rulesDirty = true;
    const btn = $("rulesSave");
    if (btn) btn.classList.add("primary");
  }

  function renderRules() {
    const wrap = $("rulesList");
    if (!wrap) return;
    wrap.textContent = "";
    if (!rulesDraft) {
      wrap.appendChild(emptyBox("fa-scale-balanced", "Loading rules..."));
      return;
    }
    if (!rulesDraft.length) {
      wrap.appendChild(
        emptyBox("fa-scale-balanced", "No rules in this section yet."),
      );
      return;
    }

    rulesDraft.forEach((rule, i) => {
      const card = divc("rl-card");

      const head = divc("rl-head");
      head.appendChild(span("rl-num", String(i + 1)));

      if (rulesSection === "mod") {
        const sel = document.createElement("select");
        sel.className = "rl-lvl";
        [
          ["all", "All moderators"],
          ["jr", "Junior only"],
          ["full", "Full mods only"],
          ["leader", "Mod leaders only"],
        ].forEach(([v, label]) => {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = label;
          if ((rule.level || "all") === v) o.selected = true;
          sel.appendChild(o);
        });
        sel.addEventListener("change", () => {
          rule.level = sel.value;
          rulesMarkDirty();
        });
        head.appendChild(sel);
      }

      const acts = divc("rl-actions");
      const mkBtn = (faClass, title, onClick, extraCls) => {
        const b = document.createElement("button");
        b.className = "btn sm" + (extraCls ? " " + extraCls : "");
        b.title = title;
        b.setAttribute("aria-label", title);
        b.appendChild(icon(faClass));
        b.addEventListener("click", onClick);
        return b;
      };
      acts.appendChild(
        mkBtn("fa-arrow-up", "Move up", () => {
          if (i === 0) return;
          [rulesDraft[i - 1], rulesDraft[i]] = [rulesDraft[i], rulesDraft[i - 1]];
          rulesMarkDirty();
          renderRules();
        }),
      );
      acts.appendChild(
        mkBtn("fa-arrow-down", "Move down", () => {
          if (i >= rulesDraft.length - 1) return;
          [rulesDraft[i + 1], rulesDraft[i]] = [rulesDraft[i], rulesDraft[i + 1]];
          rulesMarkDirty();
          renderRules();
        }),
      );
      acts.appendChild(
        mkBtn(
          "fa-trash",
          "Delete this rule",
          async () => {
            if (window.StaffUI) {
              const go = await StaffUI.confirm({
                title: "Delete rule",
                danger: true,
                confirmText: "Delete",
                message:
                  'Remove "' +
                  (rule.title || "this rule") +
                  '"? It disappears from the lobby when you save.',
              });
              if (!go) return;
            }
            rulesDraft.splice(i, 1);
            rulesMarkDirty();
            renderRules();
          },
          "danger",
        ),
      );
      head.appendChild(acts);
      card.appendChild(head);

      const field = (labelText, key, rows, placeholder) => {
        card.appendChild(
          Object.assign(document.createElement("label"), {
            className: "rl-lbl",
            textContent: labelText,
          }),
        );
        const input = document.createElement(rows ? "textarea" : "input");
        input.className = "rl-field";
        if (rows) input.rows = rows;
        else input.type = "text";
        input.value = rule[key] || "";
        input.placeholder = placeholder || "";
        input.addEventListener("input", () => {
          rule[key] = input.value;
          input.classList.add("rl-dirty");
          rulesMarkDirty();
        });
        card.appendChild(input);
      };

      field("Rule", "title", 0, "One line, said plainly");
      field("What it means", "body", 3, "What somebody may and may not do");
      field(
        "Why",
        "why",
        2,
        "The reason behind it, so it can be applied to cases nobody wrote down",
      );

      wrap.appendChild(card);
    });
  }

  function loadRulesSection() {
    rulesDraft = (rulesData[rulesSection] || []).map((r) => ({ ...r }));
    rulesDirty = false;
    renderRules();
  }

  socket.on("rules data", (d) => {
    if (!d) return;
    rulesData.community = Array.isArray(d.community) ? d.community : [];
    rulesData.mod = Array.isArray(d.mod) ? d.mod : [];
    loadRulesSection();
  });

  document.querySelectorAll("#rulesSeg button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sec = btn.dataset.sec;
      if (sec === rulesSection) return;
      if (rulesDirty && window.StaffUI) {
        const go = await StaffUI.confirm({
          title: "Unsaved changes",
          danger: true,
          confirmText: "Discard",
          message:
            "You have edits in this section that have not been saved. Switching discards them.",
        });
        if (!go) return;
      }
      document
        .querySelectorAll("#rulesSeg button")
        .forEach((b) => b.classList.toggle("active", b === btn));
      rulesSection = sec;
      loadRulesSection();
    });
  });

  $("rulesAdd") &&
    $("rulesAdd").addEventListener("click", () => {
      if (!rulesDraft) return;
      const blank = { title: "", body: "", why: "" };
      if (rulesSection === "mod") blank.level = "all";
      rulesDraft.push(blank);
      rulesMarkDirty();
      renderRules();
      const wrap = $("rulesList");
      const last = wrap && wrap.lastElementChild;
      if (last) {
        last.scrollIntoView({ behavior: "smooth", block: "center" });
        const first = last.querySelector(".rl-field");
        if (first) first.focus();
      }
    });

  $("rulesSave") &&
    $("rulesSave").addEventListener("click", () => {
      if (!rulesDraft) return;
      const list = rulesDraft.filter(
        (r) => (r.title || "").trim() || (r.body || "").trim(),
      );
      socket.emit("dev set rules", { section: rulesSection, list });
      rulesDirty = false;
    });

  $("rulesReload") &&
    $("rulesReload").addEventListener("click", () => socket.emit("rules get"));

  $("rulesReset") &&
    $("rulesReset").addEventListener("click", async () => {
      if (window.StaffUI) {
        const go = await StaffUI.confirm({
          title: "Restore the default rules",
          danger: true,
          confirmText: "Restore",
          message:
            "This replaces every rule in the " +
            rulesSection +
            " section with the set the server ships with. Anything written here is lost.",
        });
        if (!go) return;
      }
      socket.emit("dev reset rules", { section: rulesSection });
    });

  // ── Announcements ─────────────────────────────────────────────────────────
  const anEsc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function anInline(s) {
    return s
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, alt, src) =>
        '<img src="' + anEsc(src) + '" alt="' + anEsc(alt) + '" loading="lazy">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, href) =>
        '<a href="' + anEsc(href) + '" target="_blank" rel="noopener noreferrer">' +
        txt + "</a>")
      .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~\n][^~]*?)~~/g, "<s>$1</s>");
  }

  function anMarkdown(src) {
    const lines = anEsc(String(src || "")).split("\n");
    const out = [];
    let list = null;
    let inCode = false;
    let code = [];
    const closeList = () => {
      if (list) {
        out.push("</" + list + ">");
        list = null;
      }
    };
    for (const raw of lines) {
      if (/^\s*```/.test(raw)) {
        if (inCode) {
          out.push("<pre><code>" + code.join("\n") + "</code></pre>");
          code = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        code.push(raw);
        continue;
      }
      const line = raw.trim();
      if (!line) {
        closeList();
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        closeList();
        out.push("<hr>");
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        const lvl = Math.min(6, h[1].length + 1);
        out.push("<h" + lvl + ">" + anInline(h[2]) + "</h" + lvl + ">");
        continue;
      }
      const q = /^&gt;\s?(.*)$/.exec(line);
      if (q) {
        closeList();
        out.push("<blockquote>" + anInline(q[1]) + "</blockquote>");
        continue;
      }
      const ul = /^[-*+]\s+(.*)$/.exec(line);
      if (ul) {
        if (list !== "ul") {
          closeList();
          out.push("<ul>");
          list = "ul";
        }
        out.push("<li>" + anInline(ul[1]) + "</li>");
        continue;
      }
      const ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (ol) {
        if (list !== "ol") {
          closeList();
          out.push("<ol>");
          list = "ol";
        }
        out.push("<li>" + anInline(ol[1]) + "</li>");
        continue;
      }
      closeList();
      out.push("<p>" + anInline(line) + "</p>");
    }
    if (inCode && code.length)
      out.push("<pre><code>" + code.join("\n") + "</code></pre>");
    closeList();
    return out.join("");
  }

  let anEditingId = null;

  function anSyncCount() {
    const body = $("anBody");
    const c = $("anCount");
    if (body && c) c.textContent = body.value.length + " / 4000";
  }

  function anResetForm() {
    anEditingId = null;
    if ($("anTitle")) $("anTitle").value = "";
    if ($("anFrom")) $("anFrom").value = "";
    if ($("anBody")) $("anBody").value = "";
    if ($("anKind")) $("anKind").value = "notice";
    if ($("anPreview")) $("anPreview").style.display = "none";
    if ($("anCancelEdit")) $("anCancelEdit").style.display = "none";
    if ($("anPost"))
      $("anPost").innerHTML = '<i class="fas fa-paper-plane"></i> Post notice';
    anSyncCount();
  }

  function anRenderList(items) {
    const wrap = $("anList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("announceBadge");
    const liveCount = (items || []).filter((a) => a.live).length;
    if (badge) {
      badge.textContent = String(liveCount);
      badge.style.display = liveCount ? "" : "none";
    }
    if (!items || !items.length) {
      const e = document.createElement("div");
      e.className = "an-empty";
      e.textContent = "Nothing posted yet.";
      wrap.appendChild(e);
      return;
    }
    const showingId = (items.find((a) => a.live) || {}).id;
    items.forEach((a) => {
      const item = document.createElement("div");
      item.className = "an-item" + (a.id === showingId ? " showing" : "");

      const head = document.createElement("div");
      head.className = "an-item-head";
      const kindTag = document.createElement("span");
      kindTag.className = "an-tag " + a.kind;
      kindTag.textContent =
        a.kind === "update" ? "Update" : a.kind === "alert" ? "Important" : "Notice";
      head.appendChild(kindTag);
      const title = document.createElement("span");
      title.className = "an-item-title";
      title.textContent = a.title;
      head.appendChild(title);
      const state = document.createElement("span");
      if (a.id === showingId) {
        state.className = "an-tag live";
        state.textContent = "Showing now";
      } else if (a.live) {
        state.className = "an-tag hidden";
        state.textContent = "Superseded";
        state.title = "Live, but a newer notice is the one people see.";
      } else {
        state.className = "an-tag hidden";
        state.textContent = "Hidden";
      }
      head.appendChild(state);
      item.appendChild(head);

      const meta = document.createElement("div");
      meta.className = "an-item-meta";
      meta.textContent =
        (a.by || "?") +
        " · " +
        new Date(a.at).toLocaleString() +
        (a.editedAt ? " · edited" : "");
      item.appendChild(meta);

      if (a.reactions && a.reactions.length) {
        const rr = document.createElement("div");
        rr.className = "an-item-reacts";
        a.reactions.forEach((r) => {
          const chip = document.createElement("span");
          chip.className = "an-item-react";
          const e = document.createElement("span");
          e.textContent = r.e;
          const n = document.createElement("b");
          n.textContent = String(r.n);
          chip.appendChild(e);
          chip.appendChild(n);
          rr.appendChild(chip);
        });
        item.appendChild(rr);
      }

      // Leaders manage only mod-side notices; an admin's notice is read-only
      // to them (the server refuses it too, this just keeps the UI honest).
      const canManage = viewerIsDev() || a.byRole !== "dev";
      if (!canManage) {
        const ro = document.createElement("div");
        ro.className = "an-item-meta";
        ro.innerHTML =
          '<i class="fas fa-lock"></i> Posted by an admin. Only admins can change it.';
        item.appendChild(ro);
        const preview0 = document.createElement("div");
        preview0.className = "an-preview-box";
        preview0.style.marginTop = "10px";
        preview0.innerHTML = anMarkdown(a.body);
        item.appendChild(preview0);
        wrap.appendChild(item);
        return;
      }

      const acts = document.createElement("div");
      acts.className = "an-item-actions";
      const mk = (label, icon, fn, cls) => {
        const b = document.createElement("button");
        b.className = "btn sm" + (cls ? " " + cls : "");
        b.innerHTML = '<i class="fas ' + icon + '"></i> ' + label;
        b.addEventListener("click", fn);
        acts.appendChild(b);
        return b;
      };
      mk("Edit", "fa-pen", () => {
        anEditingId = a.id;
        $("anKind").value = a.kind;
        $("anTitle").value = a.title;
        $("anFrom").value = a.by || "";
        $("anBody").value = a.body;
        $("anCancelEdit").style.display = "";
        $("anPost").innerHTML = '<i class="fas fa-check"></i> Save changes';
        anSyncCount();
        $("anTitle").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      mk(a.live ? "Hide" : "Show", a.live ? "fa-eye-slash" : "fa-eye", () => {
        socket.emit("announcement live", { id: a.id, live: !a.live });
      });
      mk("Delete", "fa-trash", () => {
        const go = () => socket.emit("announcement delete", { id: a.id });
        if (window.StaffUI)
          StaffUI.confirm({
            title: "Delete notice",
            message:
              "Remove it from the history for good? Hiding it is usually enough.",
            danger: true,
            confirmText: "Delete",
          }).then((ok) => ok && go());
        else go();
      }, "danger");
      item.appendChild(acts);

      const preview = document.createElement("div");
      preview.className = "an-preview-box";
      preview.style.marginTop = "10px";
      preview.innerHTML = anMarkdown(a.body);
      item.appendChild(preview);

      wrap.appendChild(item);
    });
  }

  socket.on("announcement list", (d) => anRenderList((d && d.items) || []));
  socket.on("announcement result", (d) => {
    if (!d) return;
    if (!d.ok) {
      if (window.StaffUI)
        StaffUI.toast(d.error || "Could not save that.", { type: "error" });
      return;
    }
    if (d.action === "post" || d.action === "edit") {
      anResetForm();
      if (window.StaffUI)
        StaffUI.toast(d.action === "post" ? "Notice posted." : "Saved.", {
          type: "success",
        });
    }
  });

  if ($("anBody")) {
    $("anBody").addEventListener("input", anSyncCount);
    $("anPreviewBtn").addEventListener("click", () => {
      const box = $("anPreview");
      const show = box.style.display === "none";
      box.style.display = show ? "block" : "none";
      if (show) box.innerHTML = anMarkdown($("anBody").value);
    });
    $("anCancelEdit").addEventListener("click", anResetForm);
    $("anPost").addEventListener("click", () => {
      const payload = {
        kind: $("anKind").value,
        title: $("anTitle").value.trim(),
        body: $("anBody").value.trim(),
        by: ($("anFrom") && $("anFrom").value.trim()) || "",
      };
      if (payload.title.length < 3)
        return StaffUI && StaffUI.toast("Give it a title first.", { type: "error" });
      if (payload.body.length < 3)
        return StaffUI && StaffUI.toast("Write something in the body.", { type: "error" });
      if (anEditingId) {
        payload.id = anEditingId;
        socket.emit("announcement edit", payload);
        return;
      }
      const go = () => socket.emit("announcement post", payload);
      if (window.StaffUI)
        StaffUI.confirm({
          title: "Post this notice?",
          message: viewerIsDev()
            ? "Everyone in the lobby sees it full-screen, once, until they close it."
            : "This goes to every single person on the site, full screen. Leaders should only post when it is genuinely needed and no admin is available. Sure?",
          confirmText: "Post it",
        }).then((ok) => ok && go());
      else go();
    });
    anSyncCount();
  }

  window.addEventListener("beforeunload", () => {
    try {
      socket.emit("staff stop audit");
    } catch (_) {}
  });
})();
