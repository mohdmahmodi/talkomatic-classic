// server/audit.js
// Accountability log. Records two kinds of events for the staff board
// (mod.html), keeps an in-memory ring buffer for fast reads, persists to
// audit-log.jsonl, and live-broadcasts to subscribed staff sockets:
//
//   type "action"   - a privileged staff action (who, what, target, room, IP)
//   type "identity" - a user signing in or changing their username (IP +
//                     old/new name) so any name can always be traced back
//
// Staff actions are ALSO mirrored to the human-readable modlog.txt (the file
// named in the v4 spec) for plain forensics.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { state } = require("./state");

const { DATA_DIR } = require("./datadir");

const AUDIT_PATH = path.join(DATA_DIR, "audit-log.jsonl");
const MODLOG_PATH = path.join(DATA_DIR, "modlog.txt");

let entries = []; // append-only history, oldest first
let seq = 0;
// userId -> { username, location } - last known identity, to detect changes
const lastIdentity = new Map();

function io() {
  return state.io;
}

// An address can arrive in a free-text field as easily as in `ip`. An IP ban
// logs the address it blocked as the action's TARGET, and a ban reason can
// name one in passing. Stripping only the dedicated fields left both of those
// on screen for every moderator - which is how the whole block list was
// readable from the activity feed.
//
// The matcher is shared with room chat (server/ipredact.js) so there is one
// answer to "is this an address"; only the placeholder differs. Deliberately
// greedy: over-redacting a version number costs nothing, leaking an address
// costs a user their approximate location.
const ipredact = require("./ipredact");

const HIDDEN = "[ip hidden]";

function maskIps(value) {
  return ipredact.redact(value, HIDDEN);
}

// IP addresses are dev-only. Mods get every field except the raw addresses.
const MASKED_FIELDS = ["target", "details", "text"];

function redactForMod(entry) {
  const copy = Object.assign({}, entry);
  delete copy.ip;
  delete copy.targetIp;
  for (const f of MASKED_FIELDS)
    if (copy[f] != null) copy[f] = maskIps(copy[f]);
  return copy;
}

function broadcast(entry) {
  if (!io()) return;
  const masked = redactForMod(entry);
  for (const [, s] of io().sockets.sockets) {
    if (!s.auditSub) continue;
    if (s.isDev) {
      s.emit("audit entry", entry);
      continue;
    }
    if (!s.isMod) continue;
    // Key security alerts concern dev/mod keys and IPs, so they are dev-only.
    if (entry.devOnly) continue;
    // Some entries (mod-abuse flags, reports) are for full (level 2) mods +.
    if (entry.minLevel && (s.modLevel || 2) < entry.minLevel) continue;
    s.emit("audit entry", masked);
  }
}

let writeChain = Promise.resolve();

function enqueueWrite(fn) {
  writeChain = writeChain
    .then(fn)
    .catch((e) => console.error("audit io failed:", e));
  return writeChain;
}

function persist(entry) {
  enqueueWrite(async () => {
    await fsp.appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n");
  });
}

function push(entry) {
  entry.id = ++seq;
  entries.push(entry);
  persist(entry);
  broadcast(entry);
  return entry;
}

// A privileged staff action. Mirrors one line to modlog.txt.
function recordAction({ roleTag, label, action, target, room, ip, details }) {
  const ts = Date.now();
  push({
    ts,
    type: "action",
    role: roleTag || "?",
    label: label || roleTag || "?",
    action: action || "?",
    target: target || null,
    room: room || null,
    ip: ip || null,
    details: details || null,
  });
  const line =
    [
      new Date(ts).toISOString(),
      `${roleTag || "?"}:${label || roleTag || "?"}`,
      action || "?",
      target || "-",
      room || "-",
      details ? `(${details})` : "",
    ]
      .join(" | ")
      .trimEnd() + "\n";
  fsp.appendFile(MODLOG_PATH, line).catch(() => {});
}

// A user picking or changing their displayed identity. Deduped: no entry if
// nothing changed. `event` is "signin" the first time, "rename" on a change.
function recordIdentity({ userId, username, location, ip }) {
  if (!userId || !username) return;
  const prev = lastIdentity.get(userId);
  let event = "signin";
  let prevUsername = null;
  let prevLocation = null;
  if (prev) {
    if (prev.username === username && prev.location === location) return;
    event = "rename";
    prevUsername = prev.username;
    prevLocation = prev.location;
  }
  lastIdentity.set(userId, { username, location });
  push({
    ts: Date.now(),
    type: "identity",
    event,
    userId,
    username,
    location: location || null,
    prevUsername,
    prevLocation,
    ip: ip || null,
  });
}

// Staff forced a user's name to Anonymous - log it and reset the baseline.
function recordForcedRename({ userId, from, ip, by, room }) {
  const prevLoc = lastIdentity.get(userId)?.location || null;
  lastIdentity.set(userId, { username: "Anonymous", location: prevLoc });
  push({
    ts: Date.now(),
    type: "identity",
    event: "forced-rename",
    userId,
    username: "Anonymous",
    prevUsername: from || null,
    location: prevLoc,
    ip: ip || null,
    by: by || null,
    room: room || null,
  });
}

// A staff-key security alert: a dev/mod key used from an IP it has never
// connected from, or active from multiple IPs at once. These are the signals
// of a shared or leaked key. Dev-only (involves keys + raw IPs).
function recordKeyAlert({ role, label, ip, kind, detail }) {
  push({
    ts: Date.now(),
    type: "security",
    devOnly: true,
    role: role || "?",
    label: label || role || "?",
    kind: kind || "alert", // "new-ip" | "concurrent"
    ip: ip || null,
    detail: detail || null,
  });
}

// A staff notification: a user report, or a possible mod-abuse flag. Shown in
// the dashboard feed AND pushed as a live toast to qualifying staff so it isn't
// missed. Default visibility is full (level 2) mods + devs; never junior mods.
// `ip` is whoever raised it, `targetIp` whoever it is about. Both are stripped
// for mods by redactForMod, same as anywhere else, but recording them means a
// dev reading a report in the feed does not have to go and look them up.
function recordNotification({
  kind, label, role, text, target, room, by, minLevel,
  ip, targetIp, targetUserId, byUserId, reports, byRole, targetRole,
  // The same event in fields rather than a sentence, for the Desk's #queues
  // cards. Never stored on the audit entry: the log stays a log.
  card,
}) {
  const lvl = minLevel === 1 ? 1 : 2;
  const entry = push({
    ts: Date.now(),
    type: "notification",
    minLevel: lvl,
    kind: kind || "notice",
    role: role || null,
    label: label || null,
    text: text || null,
    target: target || null,
    room: room || null,
    by: by || null,
    byUserId: byUserId || null,
    targetUserId: targetUserId || null,
    // Staff status as the server knows it, so the board never has to guess
    // from a username. Explicitly null when they are an ordinary user.
    byRole: byRole || null,
    targetRole: targetRole || null,
    ip: ip || null,
    targetIp: targetIp || null,
    reports: reports || null,
  });
  notifyStaffToast(text || "New staff notification", lvl);
  // Every queue event flows through here, so this one hook feeds the Desk's
  // #queues channel: reports, appeals, applications, suggestions, abuse
  // flags. The Desk applies the same audience rules (minLevel, junior mods
  // see reports only) when it fans the card out.
  try {
    require("./staffchat").systemQueues(kind || "notice", text || "", {
      minLevel: lvl,
      card: card || null,
    });
  } catch (_) {}
  return entry;
}

// Live toast to qualifying staff regardless of whether the dashboard is open,
// so reports and abuse flags surface even to staff sitting in a room or lobby.
// The toast carries the same sentence the feed does, so it gets the same mask:
// a mod-abuse flag lists the actions that tripped it, and an IP block's target
// is the address itself.
function notifyStaffToast(text, minLevel) {
  if (!io()) return;
  const masked = maskIps(text);
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev) {
      s.emit("staff notice", { text });
      continue;
    }
    if (s.isMod && (s.modLevel || 2) >= (minLevel || 2))
      s.emit("staff notice", { text: masked });
  }
}

// A staff comment attached to an existing log entry (discussion / "why?").
function recordComment({ entryId, role, label, text, ip }) {
  if (!entryId || !text) return;
  push({
    ts: Date.now(),
    type: "comment",
    refId: entryId,
    role: role || "mod",
    label: label || role || "mod",
    text,
    ip: ip || null,
  });
}

// Midnight in Los Angeles, as a UTC timestamp. The dashboard shows one Pacific
// day at a time so every staff member is looking at the same window whatever
// timezone they are in. Uses Intl rather than a fixed offset so the switch
// between PST and PDT is handled for us.
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
  if (!PACIFIC_FMT) return 0; // no Intl: show everything rather than nothing
  try {
    const partsAt = (t) =>
      PACIFIC_FMT.formatToParts(new Date(t)).reduce(
        (a, p) => ((a[p.type] = p.value), a),
        {},
      );
    // How far the Pacific wall clock sits from UTC at a given instant.
    const offsetAt = (t) => {
      const p = partsAt(t);
      return (
        Date.UTC(
          +p.year,
          +p.month - 1,
          +p.day,
          +p.hour,
          +p.minute,
          +p.second,
        ) -
        Math.floor(t / 1000) * 1000
      );
    };
    const today = partsAt(now);
    const localMidnight = Date.UTC(+today.year, +today.month - 1, +today.day);
    // Convert local midnight to a real instant. The offset can change during
    // the day (the two DST switchovers), so resolve with the offset that is
    // actually in force at midnight, not the one in force right now.
    let guess = localMidnight - offsetAt(now);
    guess = localMidnight - offsetAt(guess);
    return guess;
  } catch (_) {
    return 0;
  }
}

// The last `n` Pacific midnights, oldest first, ending with today's. Each one
// is resolved on its own rather than by subtracting 24h repeatedly, so the two
// daylight-saving switchover days do not drag the whole week an hour out.
const DAY_MS = 24 * 60 * 60 * 1000;
function pacificDayStarts(n = 7, now = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = startOfPacificDay(now - i * DAY_MS);
    if (!out.length || start !== out[out.length - 1]) out.push(start);
  }
  return out;
}

function recent(limit = 500, includeIp = true, modLevel = 2, since = 0) {
  const n = Math.max(1, Number(limit) || 500);
  let slice;
  if (since > 0) {
    // Walk back from the newest entry until we leave the window or hit the
    // cap, so a long history is never copied wholesale just to be filtered
    // away. This runs on every dashboard connect.
    let i = entries.length - 1;
    let taken = 0;
    while (i >= 0 && (entries[i].ts || 0) >= since && taken < n) {
      i--;
      taken++;
    }
    slice = entries.slice(i + 1);
  } else {
    slice = entries.slice(-n);
  }
  // Devs see everything; mods get IP-redacted entries with dev-only ones and
  // anything above their level removed.
  if (includeIp) return slice;
  return slice
    .filter((e) => !e.devOnly && (!e.minLevel || modLevel >= e.minLevel))
    .map(redactForMod);
}

// Action strings carry their parameters ("ip block 24h", "rename (was Bob)",
// "grant mod L1"). Strip those so the per-moderator tally groups the same kind
// of action together instead of splitting it across every variation.
//
// The bracket is cut from the first "(" to the end rather than matched as a
// pair: room and user names contain brackets of their own, so a paired match on
// `rename room (was Ha(ha))` left a stray ")" behind and split one action into
// two separate tallies.
function baseAction(action) {
  return String(action || "?")
    .replace(/\s*\([\s\S]*$/, "")
    .replace(/\s+(1h|24h|7d|permanent)\b/gi, "")
    .replace(/\s+L\d+\b/gi, "")
    .replace(/\s+\d+$/, "")
    .trim()
    .toLowerCase();
}

// Which bucket an action belongs to.
//
// Membership is by exact action name, not by prefix. Prefix matching used to
// file `rename room` under "Acting on users" because the list had `rename` in
// it, which quietly inflated the one number promotion is judged on: a mod who
// renamed rooms all day read as a mod who had handled people all day.
//
// "passive" is deliberately separate: watching a room or unlocking the panel is
// not moderation work, and counting it would make a lurker look busier than
// somebody actually answering reports.
const ACTION_GROUPS = [
  {
    key: "users",
    label: "Acting on users",
    blurb: "Landed on a person. This is what moderating actually is.",
    actions: [
      "kick", "kick+ban", "wipe buffer", "warn",
      "ban", "ban ip", "ip block", "unblock ip",
      "rename", "reset location", "turn pfp off", "allow pfp",
      "freeze", "unfreeze", "piano mute", "piano unmute",
    ],
  },
  {
    key: "queues",
    label: "Clearing queues",
    blurb: "Worked through reports, appeals, applications and suggestions.",
    actions: [
      "dismiss report", "dismiss appeal", "lift ban",
      "approve mod application", "reject mod application", "review application",
      "approve suggestion", "decline suggestion",
      "suggestion approved", "suggestion declined", "suggestion done",
      "delete board post", "delete board reply",
      "purge invites", "undo invite purge",
      "open applications", "close applications",
    ],
  },
  {
    key: "rooms",
    label: "Looking after rooms",
    blurb: "Tidied a room. Useful, but nobody was moderated.",
    actions: [
      "lock room", "unlock room", "slow mode on", "slow mode off",
      "close room", "rename room", "clear board",
      // Board tools are aimed at a person, but they are cheap and instantly
      // repeatable - a mod could draw and wipe all afternoon. They count as
      // work done, and deliberately NOT toward the promotion number.
      "wipe board drawings", "remove from board", "allow back on board",
      "release board area",
      "spotlight on", "spotlight off", "set room size", "party mode",
    ],
  },
  {
    key: "records",
    label: "Record keeping",
    blurb: "Notes and block copy. Bookkeeping, not enforcement.",
    actions: [
      "set note", "clear note", "set block message", "set block duration",
    ],
  },
  {
    key: "admin",
    label: "Server and roles",
    blurb: "Server-wide switches and staff roles.",
    actions: [
      "grant mod", "revoke mod", "set mod level", "grant mod to user",
      "set mod level for user", "revoke mod from user",
      "megaphone", "set ticker", "maintenance on", "maintenance off",
      "set flags", "nuke all rooms", "clear blacklist",
      "review flag", "unreview flag",
    ],
  },
  {
    key: "passive",
    label: "Not counted as work",
    blurb: "Watching and signing in. Real, but not a workload.",
    actions: ["spectate", "unspectate", "staff key entered", "staff login", "staff logout"],
  },
];

// baseAction -> group key, built once.
const GROUP_BY_ACTION = new Map();
for (const g of ACTION_GROUPS)
  for (const a of g.actions) GROUP_BY_ACTION.set(a, g.key);

const GROUP_LABEL = new Map(ACTION_GROUPS.map((g) => [g.key, g.label]));

// Anything new that has not been added to a bucket yet. Kept out of "Acting on
// users" on purpose: an unrecognised action must never silently pad the number
// a promotion is decided on.
function groupOf(action) {
  return GROUP_BY_ACTION.get(baseAction(action)) || "other";
}

// The three actions a junior moderator has, and the only ones they can use to
// build a record. Broken out so the record can say plainly how much of somebody
// is the day-to-day job rather than the powers that came with a level.
const CORE_USER_ACTIONS = new Set(["kick", "wipe buffer", "warn"]);

// Anything that is not passive counts as something happening. It is NOT the
// promotion number - see onUsers in historyFor.
function isUsefulAction(action) {
  return groupOf(action) !== "passive";
}

// Switches that can be flipped back and forth. Flipping one and immediately
// flipping it back is two log lines and zero moderation, so a record full of
// them is the clearest sign somebody is padding a total.
const TOGGLE_PAIRS = new Map([
  ["lock room", "unlock room"],
  ["unlock room", "lock room"],
  ["slow mode on", "slow mode off"],
  ["slow mode off", "slow mode on"],
  ["spotlight on", "spotlight off"],
  ["spotlight off", "spotlight on"],
  ["freeze", "unfreeze"],
  ["unfreeze", "freeze"],
  ["turn pfp off", "allow pfp"],
  ["allow pfp", "turn pfp off"],
  ["piano mute", "piano unmute"],
  ["piano unmute", "piano mute"],
  ["maintenance on", "maintenance off"],
  ["maintenance off", "maintenance on"],
]);

// How much a flip-and-flip-back counts for, by how fast it was undone. A flat
// window scored "locked the room while I sort this out" the same as farming;
// the gap IS the evidence, so it sets the weight.
const TOGGLE_WEIGHTS = [
  [5 * 1000, 1],
  [30 * 1000, 0.6],
  [2 * 60 * 1000, 0.3],
  [5 * 60 * 1000, 0.1],
];
const TOGGLE_WINDOW_MS = 5 * 60 * 1000;

function toggleWeight(gap) {
  for (const [limit, w] of TOGGLE_WEIGHTS) if (gap <= limit) return w;
  return 0;
}

// Actions that arrive together as ONE decision. Banning somebody fires kick,
// ban and ip block from a single button; counting that as three actions three
// seconds apart is what made a considered ban read as a toolbar being mashed.
const COMBOS = [
  ["kick", "kick+ban", "ban", "ban ip", "ip block", "wipe buffer"],
  ["warn", "wipe buffer"],
  ["rename", "reset location", "turn pfp off", "allow pfp"],
];
const COMBO_WINDOW_MS = 20 * 1000;

function sameDecision(a, b, gap) {
  if (gap > COMBO_WINDOW_MS) return false;
  if (a === b) return false; // the same action twice is a repeat, not a combo
  return COMBOS.some((c) => c.includes(a) && c.includes(b));
}

// Being kicked removes you from the room, and staff can only kick somebody who
// is currently in one. So a second kick on the same person is not a moderator
// leaning on them - it is proof that person came back. Repetition of these is
// never counted against anybody; it is reported separately, as what it is.
const REQUIRES_REJOIN = new Set(["kick", "kick+ban"]);

// A run of actions on one person with less than this between them is one
// sitting, however many log lines it produced.
const INCIDENT_GAP_MS = 10 * 60 * 1000;
const RAPID_GAP_MS = 5 * 1000; // back-to-back, faster than reading a room

// Punishments that are supposed to come after something milder.
const HEAVY = new Set(["ban", "ban ip", "ip block", "kick+ban"]);
const MILD = new Set(["warn", "kick", "wipe buffer"]);
const UNDO = new Map([
  ["ban", "lift ban"],
  ["ban ip", "unblock ip"],
  ["ip block", "unblock ip"],
  ["kick+ban", "lift ban"],
]);
const UNDO_ACTIONS = new Set(UNDO.values());

// Pull the display name and id back out of the "user:Name(id)" / "room:Name(id)"
// strings logStaff writes. Names can contain brackets, so anchor on the LAST
// "(" rather than the first.
function splitTag(tag, prefix) {
  const s = String(tag || "");
  if (!s.startsWith(prefix)) return null;
  const body = s.slice(prefix.length);
  const open = body.lastIndexOf("(");
  const close = body.lastIndexOf(")");
  if (open === -1 || close < open) return { name: body, id: null };
  return { name: body.slice(0, open), id: body.slice(open + 1, close) };
}

const parseUserTag = (t) => splitTag(t, "user:");
const parseRoomTag = (t) => splitTag(t, "room:");

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// How much work on actual users a junior should have behind them before a
// developer is asked to look at full mod. It is a prompt to go and read the
// record, never an entitlement, and only actions in the "users" group count -
// renaming rooms and writing notes cannot carry somebody to it.
const PROMOTION_AT = 1000;

// Reads a staff member's whole record and works out both what they did and
// whether the shape of it should worry anybody.
//
// The tallies are lifetime and never move. The listed entries cover the last 30
// days, are filterable by group or by who they landed on, and are paged, so a
// moderator with tens of thousands of actions cannot hang the page.
function historyFor(label, role, opts = {}) {
  const want = String(label || "");
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  const wantGroup = opts.group ? String(opts.group) : null;
  const wantTarget = opts.targetUid ? String(opts.targetUid) : null;
  const empty = {
    label: want, role: role || null, total: 0, useful: 0, onUsers: 0, core: 0,
    counts: [], groups: [], targets: [], flags: [], entries: [],
    offset, limit, windowTotal: 0, windowMatched: 0, windowDays: 30,
    promotionAt: PROMOTION_AT, group: wantGroup, targetUid: wantTarget,
  };
  if (!want) return empty;

  const counts = new Map();
  const groupTotals = new Map();
  const targets = new Map(); // uid -> { uid, name, n, actions: Map }
  const recent = [];
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  let total = 0;
  let useful = 0;
  let onUsers = 0;
  let core = 0;
  let first = null;
  let last = null;

  // The actions themselves, kept so the shape analysis below can show its
  // working. Capped so a moderator with a hundred thousand entries cannot make
  // this pass expensive; the newest are the ones worth reading anyway.
  const acts = [];
  const ACTS_CAP = 6000;

  for (const e of entries) {
    if (e.type !== "action") continue;
    if (e.label !== want) continue;
    if (role && e.role && e.role !== role) continue;

    total++;
    if (first == null) first = e.ts;
    last = e.ts;

    const base = baseAction(e.action);
    const group = groupOf(e.action);
    counts.set(base, (counts.get(base) || 0) + 1);
    groupTotals.set(group, (groupTotals.get(group) || 0) + 1);
    if (group !== "passive") useful++;
    if (group === "users") {
      onUsers++;
      if (CORE_USER_ACTIONS.has(base)) core++;
    }

    const tgt = parseUserTag(e.target);
    const room = parseRoomTag(e.room);
    const ts = e.ts || 0;

    // Who they have actually pointed their powers at.
    if (group === "users" && tgt) {
      const key = tgt.id || "name:" + tgt.name;
      let t = targets.get(key);
      if (!t) {
        t = { uid: tgt.id || null, name: tgt.name, n: 0, actions: new Map() };
        targets.set(key, t);
      }
      t.name = tgt.name; // keep the most recent name they were logged under
      t.n++;
      t.actions.set(base, (t.actions.get(base) || 0) + 1);
    }

    acts.push({
      ts,
      base,
      group,
      action: e.action,
      targetId: tgt ? tgt.id || tgt.name : null,
      targetName: tgt ? tgt.name : null,
      roomId: room ? room.id || room.name : null,
      roomName: room ? room.name : null,
    });
    if (acts.length > ACTS_CAP) acts.shift();

    if (ts >= cutoff) recent.push({ ...e, base, group });
  }

  recent.reverse(); // newest first

  const groups = ACTION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    blurb: g.blurb,
    n: groupTotals.get(g.key) || 0,
    actions: [...counts.entries()]
      .filter(([a]) => groupOf(a) === g.key)
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
  })).filter((g) => g.n > 0);

  // Anything the buckets above do not know about yet, so a new action is
  // visible in the record instead of disappearing.
  const otherActions = [...counts.entries()]
    .filter(([a]) => groupOf(a) === "other")
    .map(([action, n]) => ({ action, n }))
    .sort((a, b) => b.n - a.n);
  if (otherActions.length)
    groups.push({
      key: "other",
      label: "Not yet classified",
      blurb: "New actions that have not been sorted into a bucket.",
      n: otherActions.reduce((s, c) => s + c.n, 0),
      actions: otherActions,
    });

  const topTargets = [...targets.values()]
    .sort((a, b) => b.n - a.n)
    .map((t) => ({
      uid: t.uid,
      name: t.name,
      n: t.n,
      actions: [...t.actions.entries()]
        .map(([action, n]) => ({ action, n }))
        .sort((a, b) => b.n - a.n),
    }));

  const filtered = recent.filter((e) => {
    if (wantGroup && e.group !== wantGroup) return false;
    if (wantTarget) {
      const t = parseUserTag(e.target);
      if (!t || (t.id || t.name) !== wantTarget) return false;
    }
    return true;
  });

  return {
    label: want,
    role: role || null,
    total,
    useful,
    onUsers,
    core,
    passive: groupTotals.get("passive") || 0,
    first,
    last,
    groups,
    targets: topTargets.slice(0, 10),
    distinctTargets: targets.size,
    flags: buildFlags(acts, { role: role || "mod", label: want }),
    promotionAt: PROMOTION_AT,
    counts: [...counts.entries()]
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
    windowDays: 30,
    windowTotal: recent.length,
    windowMatched: filtered.length,
    group: wantGroup,
    targetUid: wantTarget,
    offset,
    limit,
    entries: filtered.slice(offset, offset + limit),
  };
}

// ── Reading the shape of a record ─────────────────────────────────────────
//
// Every signal below scores 0-100 and carries the entries that produced it, so
// the panel can show its working instead of asserting a number. They are
// prompts to go and read the log, never verdicts: each one states what would
// make it innocent, because the reader needs to know what they are checking.

// Collapse actions that arrived together into single decisions. Everything
// downstream counts decisions, not log lines.
function toDecisions(acts) {
  const out = [];
  for (const a of acts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.targetId &&
      prev.targetId === a.targetId &&
      sameDecision(prev.base, a.base, a.ts - prev.lastTs)
    ) {
      prev.parts.push(a.base);
      prev.lastTs = a.ts;
      continue;
    }
    out.push({
      ts: a.ts,
      lastTs: a.ts,
      base: a.base,
      group: a.group,
      action: a.action,
      targetId: a.targetId,
      targetName: a.targetName,
      roomId: a.roomId,
      roomName: a.roomName,
      parts: [a.base],
    });
  }
  return out;
}

// Runs of decisions against one person with short gaps: one sitting, however
// many entries it produced.
function toIncidents(decisions) {
  const open = new Map(); // targetId -> incident
  const done = [];
  for (const d of decisions) {
    if (d.group !== "users" || !d.targetId) continue;
    const cur = open.get(d.targetId);
    if (cur && d.ts - cur.endTs <= INCIDENT_GAP_MS) {
      cur.steps.push(d);
      cur.endTs = d.lastTs;
      cur.rooms.add(d.roomId || "?");
      continue;
    }
    if (cur) done.push(cur);
    open.set(d.targetId, {
      targetId: d.targetId,
      name: d.targetName,
      startTs: d.ts,
      endTs: d.lastTs,
      steps: [d],
      rooms: new Set([d.roomId || "?"]),
    });
  }
  for (const inc of open.values()) done.push(inc);
  return done;
}

const relGap = (ms) => {
  if (ms < 1000) return "same second";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  return Math.round(m / 60) + "h";
};

// One evidence row, as the panel renders it.
const ev = (d, gap, note) => ({
  ts: d.ts,
  action: d.parts && d.parts.length > 1 ? d.parts.join(" + ") : d.action || d.base,
  target: d.targetName || null,
  targetId: d.targetId || null,
  room: d.roomName || null,
  gap: gap == null ? null : relGap(gap),
  note: note || null,
});

const levelFor = (score) =>
  score >= 70 ? "concern" : score >= 40 ? "look" : "notice";

// ── Reviewed flags ────────────────────────────────────────────────────────
// A developer who has read the log and is satisfied can put a flag to sleep.
// Without this, a known-good moderator trips the same false alarm forever and
// the whole panel learns to be ignored - which is worse than no panel.
//
// Sleep is not permanent: the review remembers when it was made, and anything
// the moderator does AFTER that date wakes the flag back up, louder.
const FLAG_REVIEWS_PATH = path.join(DATA_DIR, "flag-reviews.json");
let flagReviews = {}; // "role:label:key" -> { by, at, note }

const reviewKey = (role, label, key) =>
  (role || "mod") + ":" + (label || "?") + ":" + key;

function loadFlagReviews() {
  try {
    flagReviews = JSON.parse(fs.readFileSync(FLAG_REVIEWS_PATH, "utf8")) || {};
  } catch (err) {
    if (err.code !== "ENOENT") console.error("flag reviews load failed:", err);
    flagReviews = {};
  }
}

function saveFlagReviews() {
  enqueueWrite(async () => {
    const tmp = FLAG_REVIEWS_PATH + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(flagReviews, null, 2), "utf8");
    await fsp.rename(tmp, FLAG_REVIEWS_PATH);
  });
}

function reviewFlag({ role, label, key, by, note }) {
  if (!label || !key) return null;
  const rec = { by: by || "dev", at: Date.now(), note: String(note || "").slice(0, 300) };
  flagReviews[reviewKey(role, label, key)] = rec;
  saveFlagReviews();
  return rec;
}

function clearFlagReview({ role, label, key }) {
  if (!label || !key) return false;
  const k = reviewKey(role, label, key);
  if (!flagReviews[k]) return false;
  delete flagReviews[k];
  saveFlagReviews();
  return true;
}

function applyReview(signal, who) {
  const rec = flagReviews[reviewKey(who.role, who.label, signal.key)];
  if (!rec) return signal;
  const newest = (signal.evidence || []).reduce(
    (m, e) => Math.max(m, e.ts || 0),
    0,
  );
  // Nothing new since it was looked at: put it to sleep.
  if (newest <= rec.at)
    return {
      ...signal,
      level: "reviewed",
      reviewed: rec,
      counts: false,
    };
  // It happened again afterwards. That is a stronger signal than the first time.
  return {
    ...signal,
    score: Math.min(100, signal.score + 15),
    level: levelFor(Math.min(100, signal.score + 15)),
    recurredSince: rec.at,
    reviewed: rec,
    counts: true,
  };
}

function buildFlags(acts, who) {
  const signals = [];
  const decisions = toDecisions(acts);
  const incidents = toIncidents(decisions);
  const work = decisions.filter((d) => d.group !== "passive");
  const userWork = decisions.filter((d) => d.group === "users");
  const roomWork = decisions.filter((d) => d.group === "rooms");
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  const add = (s) => {
    const score = Math.max(0, Math.min(100, Math.round(s.score)));
    if (score >= 15) signals.push({ ...s, score, level: levelFor(score) });
  };

  // ── Switches flipped and flipped straight back ──
  {
    const used = new Set();
    const pairs = [];
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const opposite = TOGGLE_PAIRS.get(a.base);
      if (!opposite) continue;
      const scope = a.roomId || a.targetId;
      for (let j = i - 1; j >= 0; j--) {
        const p = acts[j];
        if (a.ts - p.ts > TOGGLE_WINDOW_MS) break;
        if (used.has(j) || p.base !== opposite) continue;
        if ((p.roomId || p.targetId) !== scope) continue;
        const gap = a.ts - p.ts;
        const w = toggleWeight(gap);
        if (w > 0) {
          used.add(j);
          used.add(i);
          pairs.push({ a, p, gap, w });
        }
        break;
      }
    }
    const weighted = pairs.reduce((s, x) => s + x.w, 0);
    if (weighted >= 2) {
      const instant = pairs.filter((x) => x.gap <= 5000).length;
      const share = pct(pairs.length * 2, roomWork.length + userWork.length);
      add({
        key: "toggles",
        // Rate-led, so a busy moderator is not punished for volume: what
        // matters is how much of their room work is flipping and unflipping.
        score: share * 2 + Math.min(25, weighted),
        title:
          pairs.length +
          " switches flipped and flipped straight back" +
          (instant ? ", " + instant + " within five seconds" : ""),
        detail:
          "Locking a room and unlocking it seconds later is two entries in the log and no moderation at all. " +
          (share >= 8 ? "That is about " + share + "% of their room and user work. " : ""),
        innocent:
          "Locking a room while you deal with something and unlocking it after is normal. The ones undone within a few seconds are the ones to read.",
        evidence: pairs
          .sort((x, y) => x.gap - y.gap)
          .slice(0, 12)
          .map((x) =>
            ev(x.a, x.gap, x.p.base + " then " + x.a.base + " in " + relGap(x.gap)),
          ),
      });
    }
  }

  // ── Somebody leaned on ──
  // Kicks are excluded on purpose: staff can only kick a person who is in the
  // room, and a kick removes them, so a second kick proves they came back. That
  // is reported below as its own, non-accusing observation.
  {
    // Check every part of a decision, not just the one it was filed under: a
    // "wipe buffer + kick" carries a kick even though its base is the wipe.
    const hasKick = (d) => d.parts.some((p) => REQUIRES_REJOIN.has(p));
    const hounded = incidents.filter(
      (inc) => inc.steps.filter((d) => !hasKick(d)).length >= 3,
    );
    if (hounded.length) {
      const worst = hounded
        .slice()
        .sort((a, b) => b.steps.length - a.steps.length)[0];
      const rate = pct(hounded.length, Math.max(1, incidents.length));
      add({
        key: "hounding",
        score: rate * 1.2 + Math.min(30, hounded.length * 2),
        title:
          hounded.length +
          (hounded.length === 1 ? " sitting where" : " sittings where") +
          " one person was worked over repeatedly",
        detail:
          "Worst was " +
          worst.steps.length +
          " actions on " +
          worst.name +
          " across " +
          relGap(Math.max(1000, worst.endTs - worst.startTs)) +
          ". Kicks are not counted here, because being kicked twice means they came back.",
        innocent:
          "Somebody who will not stop can need several passes. Check whether they were warned, and whether it escalated to a ban rather than going round again.",
        evidence: worst.steps
          .slice(0, 12)
          .map((d, i) =>
            ev(d, i === 0 ? null : d.ts - worst.steps[i - 1].lastTs),
          ),
      });
    }
  }

  // ── They kept coming back ──
  // Not a fault. It is the single most useful thing the old "repeats" number
  // was accidentally measuring, and it reads as training, not suspicion.
  {
    const returns = incidents
      .map((inc) => ({
        inc,
        kicks: inc.steps.filter((d) =>
          d.parts.some((p) => REQUIRES_REJOIN.has(p)),
        ).length,
      }))
      .filter((x) => x.kicks >= 3)
      .sort((a, b) => b.kicks - a.kicks);
    if (returns.length) {
      const banned = returns.filter((x) =>
        x.inc.steps.some((d) => HEAVY.has(d.base)),
      ).length;
      const unresolved = returns.length - banned;
      if (unresolved > 0)
        add({
          key: "returning",
          score: Math.min(38, 15 + unresolved * 4),
          title:
            unresolved +
            (unresolved === 1 ? " person kept" : " people kept") +
            " coming back after being kicked",
          detail:
            "Worst was " +
            returns[0].inc.name +
            ", kicked " +
            returns[0].kicks +
            " times in one sitting. Kicking the same person over and over without escalating usually means the tool being used is the wrong one.",
          innocent:
            "This is not a mark against them - it is a prompt. A junior who cannot ban may have had no other option, in which case the gap is in their level, not their judgement.",
          evidence: returns
            .slice(0, 8)
            .map((x) =>
              ev(
                x.inc.steps[x.inc.steps.length - 1],
                x.inc.endTs - x.inc.startTs,
                x.kicks + " kicks on " + x.inc.name + ", no ban",
              ),
            ),
        });
    }
  }

  // ── Bursts ──
  {
    const fast = [];
    for (let i = 1; i < work.length; i++) {
      const gap = work[i].ts - work[i - 1].lastTs;
      if (gap < RAPID_GAP_MS) fast.push({ d: work[i], gap });
    }
    const share = pct(fast.length, Math.max(1, work.length));
    if (fast.length >= 8 && share >= 25) {
      const differentTargets = new Set(
        fast.map((f) => f.d.targetId).filter(Boolean),
      ).size;
      add({
        key: "bursts",
        score: Math.min(100, (share - 15) * 2.2),
        title: share + "% of their decisions came within five seconds of the last",
        detail:
          "Counted after related actions are folded together, so a ban firing kick, ban and block at once is one decision here, not three." +
          (differentTargets > 3
            ? " These landed on " + differentTargets + " different people."
            : ""),
        innocent:
          "Clearing several people out of one room at once looks exactly like this. If the targets differ each time, it is a raid being handled, not a toolbar being mashed.",
        evidence: fast.slice(0, 12).map((f) => ev(f.d, f.gap)),
      });
    }
  }

  // ── One person taking all the attention ──
  {
    const byTarget = new Map();
    for (const inc of incidents)
      byTarget.set(inc.targetId, {
        name: inc.name,
        n: (byTarget.get(inc.targetId)?.n || 0) + 1,
        rooms: new Set([
          ...(byTarget.get(inc.targetId)?.rooms || []),
          ...inc.rooms,
        ]),
      });
    const ranked = [...byTarget.entries()].sort((a, b) => b[1].n - a[1].n);
    const top = ranked[0];
    if (top && incidents.length >= 8) {
      const share = pct(top[1].n, incidents.length);
      if (share >= 35)
        add({
          key: "focus",
          score: Math.min(100, (share - 20) * 2),
          title:
            share +
            "% of the times they acted on somebody, it was " +
            top[1].name,
          detail:
            top[1].n +
            " separate sittings with the same person, across " +
            top[1].rooms.size +
            (top[1].rooms.size === 1 ? " room." : " different rooms."),
          innocent:
            "One genuinely persistent problem user can dominate a record honestly. Read the reasons on the warnings - if there are none, that is the answer.",
          evidence: incidents
            .filter((i) => i.targetId === top[0])
            .slice(-10)
            .map((i) =>
              ev(i.steps[0], null, i.steps.length + " actions in this sitting"),
            ),
        });
    }
  }

  // ── Following somebody between rooms ──
  // Bumping into the same nuisance in four rooms once each is breadth of work,
  // not pursuit. Pursuit is a SMALL number of people, met repeatedly, in room
  // after room - so it needs both a room spread and repeat sittings, and it
  // stops meaning anything once it is true of lots of people.
  {
    const perTarget = new Map();
    for (const d of userWork) {
      if (!d.targetId || !d.roomId) continue;
      if (!perTarget.has(d.targetId))
        perTarget.set(d.targetId, { name: d.targetName, rooms: new Set(), n: 0 });
      const t = perTarget.get(d.targetId);
      t.rooms.add(d.roomId);
      t.n++;
    }
    const sittings = new Map();
    for (const inc of incidents)
      sittings.set(inc.targetId, (sittings.get(inc.targetId) || 0) + 1);

    const followed = [...perTarget.entries()]
      .filter(
        ([id, v]) => v.rooms.size >= 4 && (sittings.get(id) || 0) >= 4,
      )
      .sort((a, b) => b[1].rooms.size - a[1].rooms.size);

    // True of many people at once? Then it is just how this moderator works.
    if (followed.length >= 1 && followed.length <= 3)
      add({
        key: "following",
        score: 25 + followed[0][1].rooms.size * 7,
        title:
          followed[0][1].name +
          " was sought out across " +
          followed[0][1].rooms.size +
          " different rooms",
        detail:
          (sittings.get(followed[0][0]) || 0) +
          " separate sittings with them, in room after room." +
          (followed.length > 1
            ? " " + (followed.length - 1) + " other person like this."
            : ""),
        innocent:
          "A user causing the same trouble everywhere they go produces this honestly. The question is who arrived first.",
        evidence: userWork
          .filter((d) => d.targetId === followed[0][0])
          .slice(-12)
          .map((d) => ev(d)),
      });
  }

  // ── Punishment with no process ──
  {
    const seen = new Map(); // targetId -> saw a mild action first
    const cold = [];
    for (const d of decisions) {
      if (!d.targetId) continue;
      if (d.parts.some((p) => MILD.has(p))) seen.set(d.targetId, true);
      if (d.parts.some((p) => HEAVY.has(p)) && !seen.get(d.targetId)) cold.push(d);
      if (d.parts.some((p) => HEAVY.has(p))) seen.set(d.targetId, true);
    }
    const heavyTotal = decisions.filter((d) =>
      d.parts.some((p) => HEAVY.has(p)),
    ).length;
    if (cold.length >= 3 && pct(cold.length, Math.max(1, heavyTotal)) >= 50)
      add({
        key: "noprocess",
        score: Math.min(100, 25 + cold.length * 5),
        title:
          cold.length +
          " bans or blocks with no warning or kick first",
        detail:
          "Out of " +
          heavyTotal +
          " heavy punishments, these went straight to the strongest tool available with nothing milder on record for that person.",
        innocent:
          "Some things do not deserve a warning, and a moderator arriving mid-raid will not stop to issue one. Read the reasons attached.",
        evidence: cold.slice(-12).map((d) => ev(d)),
      });
  }

  // ── Undone punishments ──
  {
    const pending = new Map();
    const reversals = [];
    for (const d of decisions) {
      if (!d.targetId) continue;
      for (const p of d.parts) {
        if (UNDO_ACTIONS.has(p)) {
          const key = d.targetId + "|" + p;
          const orig = pending.get(key);
          if (orig && d.ts - orig.ts <= 24 * 60 * 60 * 1000) {
            reversals.push({ orig, undo: d, gap: d.ts - orig.ts });
            pending.delete(key);
          }
        }
        if (UNDO.has(p)) pending.set(d.targetId + "|" + UNDO.get(p), d);
      }
    }
    const heavyCount = decisions.filter((d) =>
      d.parts.some((p) => HEAVY.has(p)),
    ).length;
    if (reversals.length >= 2)
      add({
        key: "reversals",
        score: 25 + pct(reversals.length, Math.max(1, heavyCount)),
        title: reversals.length + " punishments undone within a day",
        detail:
          "A ban or block placed and then lifted shortly after, on the same person.",
        innocent:
          "Catching your own mistake quickly is exactly what you want from a moderator. A pattern of it means something else.",
        evidence: reversals
          .slice(-10)
          .map((r) => ev(r.undo, r.gap, "undone after " + relGap(r.gap))),
      });
  }

  // ── All the work in short daily bursts ──
  {
    const byDay = new Map();
    for (const d of work) {
      const k = new Date(d.ts).toDateString();
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(d);
    }
    const busy = [...byDay.entries()].filter(([, v]) => v.length >= 10);
    if (busy.length >= 3) {
      const tight = busy.filter(
        ([, v]) => v[v.length - 1].ts - v[0].ts < 15 * 60 * 1000,
      );
      if (pct(tight.length, busy.length) >= 60)
        add({
          key: "sessions",
          score: 20 + pct(tight.length, busy.length) * 0.7,
          title:
            tight.length +
            " days where a whole day of actions happened inside fifteen minutes",
          detail:
            "On " +
            tight.length +
            " of their " +
            busy.length +
            " busy days, everything logged arrived in one short sitting rather than across a shift.",
          innocent:
            "A moderator who only signs on when they are called will look exactly like this, and that is a perfectly good way to help.",
          evidence: tight
            .slice(-8)
            .map(([day, v]) =>
              ev(
                v[0],
                v[v.length - 1].ts - v[0].ts,
                day + ": " + v.length + " actions in " +
                  relGap(Math.max(1000, v[v.length - 1].ts - v[0].ts)),
              ),
            ),
        });
    }
  }

  // ── A record with nobody in it ──
  if (userWork.length === 0 && work.length >= 40)
    add({
      key: "nousers",
      score: 45,
      title: "No actions on users at all",
      detail:
        work.length +
        " logged actions, not one of which landed on a person. This record is built entirely out of rooms, notes and settings.",
      innocent:
        "Somebody who genuinely only tidies rooms is doing real work - it just is not the work promotion is judged on.",
      evidence: work.slice(-10).map((d) => ev(d)),
    });

  // Rank, mark reviewed, and hand back the strongest first.
  signals.sort((a, b) => b.score - a.score);
  return signals.map((s) => applyReview(s, who));
}

// Every staff member's workload in one pass, for the leaderboard and for
// spotting a junior who has earned a look at promotion. The ranking is by work
// done on users, so a record padded with room tidying does not climb it.
function leaderboard() {
  const by = new Map(); // "role:label" -> stats
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  for (const e of entries) {
    if (e.type !== "action" || !e.label) continue;
    const key = (e.role || "mod") + ":" + e.label;
    let s = by.get(key);
    if (!s) {
      s = {
        label: e.label, role: e.role || "mod",
        total: 0, useful: 0, recentUseful: 0, onUsers: 0, recentOnUsers: 0,
        queues: 0, rooms: 0, records: 0, passive: 0, last: null,
      };
      by.set(key, s);
    }
    s.total++;
    s.last = e.ts;
    const g = groupOf(e.action);
    if (g !== "passive") {
      s.useful++;
      if ((e.ts || 0) >= cutoff) s.recentUseful++;
    }
    if (g === "users") {
      s.onUsers++;
      if ((e.ts || 0) >= cutoff) s.recentOnUsers++;
    } else if (g === "queues") s.queues++;
    else if (g === "rooms") s.rooms++;
    else if (g === "records") s.records++;
    else if (g === "passive") s.passive++;
  }
  return [...by.values()].sort(
    (a, b) => b.onUsers - a.onUsers || b.useful - a.useful,
  );
}

function setAuditSub(socket, on) {
  if (socket) socket.auditSub = !!on;
}

// Hydrate the ring buffer (and identity baselines) from disk at boot.
function load() {
  try {
    const raw = fs.readFileSync(AUDIT_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    entries = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    seq = entries.reduce((m, e) => Math.max(m, e.id || 0), 0);
    for (const e of entries) {
      if (e.type === "identity" && e.userId)
        lastIdentity.set(e.userId, {
          username: e.username,
          location: e.location,
        });
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("audit load failed:", err);
    entries = [];
  }
}

load();
loadFlagReviews();

module.exports = {
  recordAction,
  recordIdentity,
  recordForcedRename,
  recordKeyAlert,
  recordNotification,
  recordComment,
  recent,
  redactForMod,
  maskIps,
  historyFor,
  leaderboard,
  isUsefulAction,
  PROMOTION_AT,
  reviewFlag,
  clearFlagReview,
  startOfPacificDay,
  pacificDayStarts,
  setAuditSub,
  load,
};
