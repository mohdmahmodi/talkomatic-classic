// server/rules.js
// The written rules: what users agree to, and what moderators are held to.
// Both sets are PUBLIC. A moderator rule people cannot read is not a rule
// anybody can hold a moderator to, and most complaints about staff are really
// complaints that nobody could tell what staff were allowed to do.
//
// Devs edit them from the dashboard; everyone reads them from the lobby. The
// defaults below ship with the server, so a fresh install is never ruleless -
// load() only fills in a section that has never been written.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "rules.json");

const MAX_RULES = 60; // per section
const MAX_TITLE = 120;
const MAX_BODY = 900;

// Which moderators a rule is aimed at. "all" is the default and covers both.
const LEVELS = ["all", "jr", "full"];

// ── Defaults ────────────────────────────────────────────────────────────────
// Every rule is one plain sentence of instruction plus a "why". The why is not
// decoration: a rule people understand the reason for is one they can apply to
// a situation nobody wrote down.

const DEFAULT_COMMUNITY = [
  {
    title: "Talkomatic is open to everyone",
    body:
      "No account, no invite, no age gate. People here come from everywhere and will not share your opinions, humour, or language. You do not have to like everyone in a room, but you do have to let them be in it.",
    why: "An open platform only stays open if people are not driven out of it.",
  },
  {
    title: "Do not harass people",
    body:
      "Do not follow someone from room to room, pile on with others, bring up things they asked you to drop, or keep going after they have disengaged. A single heated exchange is an argument. Repeating it, or organising it, is harassment.",
    why: "The difference between an argument and harassment is whether the other person is able to walk away from it.",
  },
  {
    title: "Hate speech is not tolerated",
    body:
      "Attacking people over race, ethnicity, nationality, religion, disability, gender, or sexuality is not allowed. This applies whether it is meant seriously, as a joke, as copypasta, or as a username.",
    why: "This is not about strong language. It is about telling a group of people they do not belong here, which is the one thing an open platform cannot allow.",
  },
  {
    title: "Never post personal information",
    body:
      "Do not post anyone's real name, address, workplace, school, phone number, IP address, or photographs, and do not press others to reveal them. This covers guessing publicly at who someone is. It applies to information you found elsewhere, and it applies in every room.",
    why: "Talkomatic is anonymous on purpose. Stripping someone's anonymity is the one thing said here that can follow them home, and it cannot be undone.",
  },
  {
    title: "Do not impersonate moderators or staff",
    body:
      "Do not claim to be a moderator, developer, or admin. Do not pick a name or use wording designed to read as staff. Do not threaten people with warnings, kicks, or bans you cannot issue. Real staff carry a badge the site draws for them; you cannot type one.",
    why: "If anybody can pretend to be staff, then a real warning from staff means nothing and people stop trusting it.",
  },
  {
    title: "Do not impersonate other users",
    body:
      "Do not take a name in order to pass yourself off as someone else, put words in their mouth, or damage how people see them.",
    why: "Names are the only identity anyone has here, so borrowing one takes away the only thing another person has.",
  },
  {
    title: "Keep sexual content out of public rooms",
    body:
      "Public rooms are shared with people who did not choose to see it, and you cannot know who is reading. Keep explicit text and links out of them.",
    why: "Anyone can walk into a public room without warning, including people who should not see that.",
  },
  {
    title: "Do not spam or flood",
    body:
      "Do not paste walls of text, repeat lines to push other people's writing off the screen, or run bots to fill a room.",
    why: "Everyone types into the same screen at the same time, so flooding does not just annoy the room, it takes the room away from everybody in it.",
  },
  {
    title: "Nothing illegal",
    body:
      "No sexual content involving minors, no credible threats of violence, no malware or phishing links, no content that is a crime to share. There is no warning step for this.",
    why: "This is handled outside of moderation, not inside it.",
  },
  {
    title: "The word filter is your setting, not the rule",
    body:
      "Talkomatic filters language automatically and you may switch that off for yourself. Turning it off does not mean anything goes, and leaving it on does not make abuse acceptable. Swearing on its own is not a punishable offence here.",
    why: "The filter decides what you are comfortable reading. These rules decide how you may treat people. They are separate questions.",
  },
  {
    title: "Private and semi-private rooms belong to the people in them",
    body:
      "What happens in a room you made private is between the people you let in, and moderators do not patrol them. Two things still hold everywhere: nothing illegal, and no posting of personal information. Anyone inside a private room can still report what happens in it.",
    why: "A private room a moderator can wander into is not private, so the only way it works is that reports come from inside.",
  },
  {
    title: "Report instead of fighting back",
    body:
      "Use the report button on the person's row rather than retaliating. Say what happened plainly. Reports go to staff with the room and the recent context attached.",
    why: "Retaliating leaves staff two people to sort out instead of one, and it usually costs you the benefit of the doubt.",
  },
  {
    title: "If you are banned, you can appeal",
    body:
      "Ban appeals are read by a human. Explain what happened and what you would do differently. Repeating the same appeal, or opening new ones, does not speed it up.",
    why: "Moderators get things wrong sometimes, and an appeal is how that gets found and fixed.",
  },
];

const DEFAULT_MOD = [
  {
    level: "all",
    title: "Swearing is not a reason to ban anybody",
    body:
      "Talkomatic filters language automatically, and every user decides whether to run that filter. Somebody swearing, with the filter on or off, is not moderation work and is not evidence of anything. Act on what is being done to a person: harassment, hate speech, personal information, threats, spam.",
    why: "The filter already handles language. Your job is conduct. Banning for words is the single fastest way to lose the room's trust.",
  },
  {
    level: "all",
    title: "Stay out of private and semi-private rooms",
    body:
      "Do not join, spectate, or act in a private or semi-private room because of what is being said inside it. The only things that bring you in are a report from someone who is in that room, or illegal content. Being able to see a room does not make it yours to police.",
    why: "People chose that room to get away from the public lobby. A private room staff can walk into is not private, and we would rather lose a rule-break than lose that.",
  },
  {
    level: "all",
    title: "Use the smallest tool that ends it",
    body:
      "Warn before you kick. Kick before you block. Reach for a longer block only when a shorter one has already failed. A kick is a full stop in a conversation, not a punishment.",
    why: "Most trouble stops at the first sign that somebody is watching, and an over-reaction turns a small problem into a grudge.",
  },
  {
    level: "all",
    title: "Never moderate a fight you are in",
    body:
      "If you are part of the argument, or the person has been going at you, hand it to another moderator. Being right does not make it yours to act on.",
    why: "Nobody can tell the difference between a fair action and a personal one when you were in the fight, including you.",
  },
  {
    level: "all",
    title: "Say why, every time",
    body:
      "Fill in the reason on every warning, kick, and block. Write it for two readers: the person receiving it, and the developer who will read it months later without any memory of the day.",
    why: "An action with no reason cannot be defended when it is questioned, and it will be questioned.",
  },
  {
    level: "all",
    title: "Your key is yours alone",
    body:
      "Never share your moderator key, never paste it anywhere, and never let somebody borrow it. If the same key is used from two places at once the system pulls it automatically, and it does not ask first.",
    why: "The key is the only thing tying an action to a person. Shared keys make the record meaningless.",
  },
  {
    level: "all",
    title: "Do not claim powers you do not have",
    body:
      "Do not tell people you can ban them if you cannot, and do not present yourself as a developer. If something needs a level above yours, say so and pass it on.",
    why: "Overstating what you can do is the same trust problem as a user impersonating staff, and it is worse coming from real staff.",
  },
  {
    level: "all",
    title: "Everything you do is recorded",
    body:
      "Every privileged action is written to the audit log with your label, the target, and your reason, and it stays in your record. This is normal and it applies to every moderator including developers.",
    why: "The record is what makes it safe to hand these tools out at all. It protects you from an accusation just as much as it catches misuse.",
  },
  {
    level: "jr",
    title: "Junior moderators: what you hold",
    body:
      "You can warn and kick, and you can read everything: reports, appeals, applications, the ban list, the staff roster, and any moderator's record. You cannot IP block, close a room, spectate, discard a report, or decide an appeal or an application. Those need a full moderator.",
    why: "You start with the tools that are reversible and none of the ones that are not, which is how you learn the job without anybody paying for a mistake.",
  },
  {
    level: "jr",
    title: "Junior moderators: escalate rather than guess",
    body:
      "When something needs more than a warning or a kick, leave it and call a full moderator or a developer. Do not improvise a substitute, and do not lean on somebody else to run the action for you without telling them what it is.",
    why: "A handover with the facts attached is worth more than a fast decision made by the person with the fewest tools.",
  },
  {
    level: "full",
    title: "Full moderators: what you hold",
    body:
      "Everything a junior has, plus IP blocks of 1 hour, 24 hours, or 7 days, closing a room, spectating, discarding reports, resolving appeals, and reviewing moderator applications. Lifting a ban, granting or revoking keys, permanent blocks, and the site-wide tools stay with developers.",
    why: "Anything that cannot be undone by the person who did it sits one level above them on purpose.",
  },
  {
    level: "full",
    title: "Full moderators: blocks are temporary by default",
    body:
      "Pick the shortest block that will actually work, and let it expire rather than reaching for the next tier out of habit. If a case genuinely needs to be permanent, that is a developer's call and you should hand it over with your reasoning.",
    why: "A temporary block that works costs nothing to get wrong. A permanent one removes somebody from an anonymous platform they can simply rejoin, so it mostly punishes the people who play fair.",
  },
  {
    level: "full",
    title: "Full moderators: do not rule on your own ban",
    body:
      "When an appeal comes in against a block you placed, pass it to another full moderator or a developer wherever there is one available. Read the record before you decide any appeal, not just the appeal text.",
    why: "Reviewing yourself is not a review, and the person appealing can tell.",
  },
  {
    level: "all",
    title: "Answer appeals, do not sit on them",
    body:
      "An appeal that is never answered reads as contempt, and it is the complaint that reaches developers most often. Decide it, or say plainly that it is being passed up.",
    why: "People accept a no far more often than they accept silence.",
  },
  {
    level: "all",
    title: "How mod abuse is watched",
    body:
      "The system watches each key for patterns: a burst of actions in five minutes, a heavy hour, a run that is mostly kicks, the same person hit repeatedly, or a spray across many people at once. It never punishes anybody by itself. It raises one flag with your recent actions attached and a human reads it.",
    why: "Told in advance, it is a safety net. Discovered later, it feels like surveillance, so it is written down here.",
  },
  {
    level: "all",
    title: "What actually counts as abuse",
    body:
      "Using the tools to win an argument, punishing somebody for disliking you, acting inside private rooms, running actions for a friend, sharing your key, or hunting one person across rooms. Being flagged is not an accusation. Any of these, once confirmed, costs you the key.",
    why: "The tools were handed to you to protect other people. Turning them on people is the only thing here that cannot be trained out.",
  },
  {
    level: "all",
    title: "Your record counts work done on people",
    body:
      "The record ranks actions that landed on a person, because that is what moderating is. Tidying rooms and clearing queues is genuinely useful and is counted separately. Nothing you say in staff chat counts as work.",
    why: "A number that can be raised without helping anybody would be worth nothing, so it is not one.",
  },
  {
    level: "all",
    title: "Do not pad your record",
    body:
      "Do not manufacture actions, split one action into several, or work through a queue without reading it. Quiet weeks are fine and nobody is chased for them.",
    why: "Padding is visible in the log to anybody who looks, and it is read as dishonesty rather than eagerness.",
  },
];

// ── Store ───────────────────────────────────────────────────────────────────

let store = {
  community: [],
  mod: [],
  updatedAt: 0,
  updatedBy: null,
  // Set the first time defaults are written. Persisted, so a dev who
  // deliberately empties a section does not get it re-seeded on the next boot.
  seeded: false,
};
let seq = 0;
let saveTimer = null;

function clean(str, max) {
  return typeof str === "string" ? str.trim().slice(0, max) : "";
}

function nextId() {
  return "r" + ++seq;
}

// Normalise one rule off the wire. Anything unrecognised is dropped rather
// than stored, so the editor cannot smuggle extra fields into the file.
function normalise(raw, isMod) {
  const title = clean(raw && raw.title, MAX_TITLE);
  const body = clean(raw && raw.body, MAX_BODY);
  const why = clean(raw && raw.why, MAX_BODY);
  if (!title && !body) return null;
  const out = { id: clean(raw && raw.id, 24) || nextId(), title, body, why };
  if (isMod) {
    const lvl = clean(raw && raw.level, 8);
    out.level = LEVELS.includes(lvl) ? lvl : "all";
  }
  return out;
}

function seed(list, isMod) {
  return list.map((r) => normalise(r, isMod)).filter(Boolean);
}

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (o && typeof o === "object") {
      store.community = Array.isArray(o.community)
        ? seed(o.community, false)
        : [];
      store.mod = Array.isArray(o.mod) ? seed(o.mod, true) : [];
      store.updatedAt = o.updatedAt || 0;
      store.updatedBy = o.updatedBy || null;
      store.seeded = !!o.seeded;
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading rules.json:", err);
  }
  // First boot only: fill both sections from the shipped defaults so a fresh
  // install is never ruleless. After that the file is the authority, empty
  // sections included.
  if (!store.seeded) {
    store.community = seed(DEFAULT_COMMUNITY, false);
    store.mod = seed(DEFAULT_MOD, true);
    store.seeded = true;
    saveSoon();
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("rules save failed:", e);
    }
  }, 1000);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("rules flush failed:", e);
  }
}

// What the lobby modal reads. Both sections, because the moderator rules being
// public is the point of them.
function publicRules() {
  return {
    community: store.community.map((r) => ({ ...r })),
    mod: store.mod.map((r) => ({ ...r })),
    updatedAt: store.updatedAt || 0,
  };
}

// Replace a whole section. The editor sends the list it is showing, so a
// reorder, an edit, and a delete are all the same write.
function setSection(section, list, byLabel) {
  if (section !== "community" && section !== "mod") return { ok: false };
  if (!Array.isArray(list)) return { ok: false };
  const isMod = section === "mod";
  const next = list
    .slice(0, MAX_RULES)
    .map((r) => normalise(r, isMod))
    .filter(Boolean);
  store[section] = next;
  store.updatedAt = Date.now();
  store.updatedBy = clean(byLabel, 40) || null;
  saveSoon();
  return { ok: true, count: next.length };
}

// Put a section back to what the server shipped with, for when an edit went
// wrong and nobody has the original text to hand.
function resetSection(section, byLabel) {
  if (section === "community")
    return setSection("community", DEFAULT_COMMUNITY, byLabel);
  if (section === "mod") return setSection("mod", DEFAULT_MOD, byLabel);
  return { ok: false };
}

load();

module.exports = {
  publicRules,
  setSection,
  resetSection,
  flushSync,
  LEVELS,
};
