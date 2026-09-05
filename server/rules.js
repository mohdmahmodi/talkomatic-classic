// server/rules.js
// The written rules: what users agree to, and what moderators are held to.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "rules.json");

const MAX_RULES = 60;
const MAX_TITLE = 120;
const MAX_BODY = 900;

const LEVELS = ["all", "jr", "full", "leader"];

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_COMMUNITY = [
  {
    title: "Talkomatic is open to everyone",
    body:
      "No account, no invite, no sign-up. People arrive here from everywhere, and they will not share your opinions, your humour, or your language. You do not have to like everyone in a room, but you do have to let them be in it.",
    why: "An open platform only stays open if people are not driven out of it.",
    response: "A warning first. A 6-hour block if it carries on.",
    block: "6h",
  },
  {
    title: "You must be 13 or older to use Talkomatic",
    body:
      "Talkomatic is for people aged 13 and up, and anyone under 18 should be here with the permission of a parent or legal guardian. Nobody on the site will ask your age, and you should not offer it. If you tell us you are under 13, you will be removed and your access blocked, and you are welcome back the day you meet the requirement. A parent or guardian who believes a child under 13 is using Talkomatic can reach us on Discord and we will remove the child's access.",
    why: "The law does not allow a site like this to serve children under 13, and an anonymous room full of strangers is no place for a child anyway.",
    response: "Removed and blocked permanently, with underage as the reason. Appeal the day you meet the requirement.",
    block: "permanent",
  },
  {
    title: "Do not harass people",
    body:
      "Do not follow someone from room to room, pile on with others against them, drag up things they asked you to drop, or keep going after they have walked away. One heated exchange is an argument. Repeating it, or organising it, is harassment.",
    why: "The difference between an argument and harassment is whether the other person is able to walk away from it.",
    response: "A warning first. A 1-day block if it continues, and a week if it starts up again after that.",
    block: "24h",
  },
  {
    title: "Hate speech is not tolerated",
    body:
      "Attacks on people over race, ethnicity, nationality, caste, religion, disability, illness, age, gender, gender identity, or sexual orientation are not allowed, and neither are the slurs for any of them. That holds whether it is meant seriously, dressed up as a joke, pasted as copypasta, spelt so the filter misses it, or worn as a username.",
    why: "This is not about strong language. It is about telling a group of people they do not belong here, which is the one thing an open platform cannot allow.",
    response: "No warning. A 1-week block the first time, permanent the second.",
    block: "7d",
  },
  {
    title: "Never post personal information",
    body:
      "Do not post anyone's real name, address, workplace, school, phone number, IP address, or photograph, and do not press anyone to reveal them. Guessing publicly at who somebody is counts too. It applies to information you found somewhere else, and it applies in every room on the site. It covers your own details as well: keep them to yourself, and be suspicious of anyone who asks for them, because staff never will.",
    why: "Talkomatic is anonymous on purpose. Stripping someone's anonymity is the one thing said here that can follow them home, and it cannot be undone.",
    response: "The text is wiped and a 1-week block follows. Permanent when it was done to hurt somebody.",
    block: "7d",
  },
  {
    title: "Do not impersonate moderators or staff",
    body:
      "Do not claim to be a moderator, a mod leader, or an admin. Do not pick a name or use wording built to read as staff, and do not threaten people with warnings, kicks, or bans you cannot issue. Real staff carry a badge the site draws for them; you cannot type one.",
    why: "If anybody can pretend to be staff, then a real warning from staff means nothing and people stop trusting it.",
    response: "Renamed and warned. A 1-day block if they keep at it.",
    block: "24h",
  },
  {
    title: "Do not impersonate other users",
    body:
      "Do not take a name to pass yourself off as someone else, to put words in their mouth, or to damage how people see them.",
    why: "Names are the only identity anyone has here, so borrowing one takes away the only thing another person has.",
    response: "Renamed and warned. A 6-hour block if they keep at it.",
    block: "6h",
  },
  {
    title: "Keep sexual content out of public rooms",
    body:
      "A public room is shared with people who did not choose to see it, and you cannot know who is reading. Keep explicit text and links out of it. Directing sexual content at a minor is never allowed anywhere on the site, public or private.",
    why: "Anyone can walk into a public room without warning, including people who should never see that.",
    response: "Wiped and kicked. A 1-day block if it continues or was aimed at somebody.",
    block: "24h",
  },
  {
    title: "Do not spam or flood",
    body:
      "Do not paste walls of text, repeat lines to push other people's writing off the screen, or run bots to fill a room.",
    why: "Everyone types onto the same screen at the same time, so flooding does not just annoy the room, it takes the room away from everybody in it.",
    response: "Wiped and kicked. A 6-hour block if it continues, a day for bots.",
    block: "6h",
  },
  {
    title: "Nothing illegal",
    body:
      "No sexual content involving minors and no sexual messages sent to them, no credible threats of violence, no malware or phishing links, and nothing that is a crime to share. There is no warning step for any of this.",
    why: "This is handled outside of moderation, not inside it.",
    response: "No warning. Permanent.",
    block: "permanent",
  },
  {
    title: "The word filter is your setting, not the rule",
    body:
      "Talkomatic filters language automatically, and you can switch that off for yourself. Turning it off does not mean anything goes, and leaving it on does not make abuse acceptable. Swearing on its own is not a punishable offence here. Spelling a slur or a threat so the filter misses it is still the slur or the threat, and pasting filtered words over and over to get past people who keep the filter on is spam.",
    why: "The filter decides what you are comfortable reading. These rules decide how you may treat people. They are separate questions.",
    response: "Nothing on its own. Swearing is not punished. Slurs, threats and floods are handled under rules 3, 4 and 9.",
    block: "none",
  },
  {
    title: "Private and semi-private rooms belong to the people in them",
    body:
      "What happens in a room you made private is between the people you let in, and moderators do not patrol it. Three things still hold everywhere on the site: nothing illegal, no posting of personal information, and the age requirement. Anyone inside a private room can still report what happens there.",
    why: "A private room a moderator can wander into is not private, so the only way it works is that reports come from inside.",
    response: "Nothing on its own. A report from inside the room is handled under whichever rule it breaks.",
    block: "none",
  },
  {
    title: "Report instead of fighting back",
    body:
      "Use the report button on the person's row instead of retaliating, and say what happened plainly. The report reaches staff with the room and the recent context attached.",
    why: "Retaliating leaves staff two people to sort out instead of one, and it usually costs you the benefit of the doubt.",
    response: "Nothing on its own. Retaliation that turns into harassment is handled under rule 3. A false report gets a warning.",
    block: "none",
  },
  {
    title: "If you are banned, you can appeal",
    body:
      "Ban appeals are read by a human, and never by the moderator who placed the block. Explain what happened and what you would do differently. Repeating the same appeal, or opening new ones, does not speed anything up.",
    why: "Moderators get things wrong sometimes, and an appeal is how that gets found and fixed.",
    response: "Nothing on its own. The appeal is the answer to a block, not a rule you can break.",
    block: "none",
  },
  {
    title: "A block is a block",
    body:
      "Do not come back on another device, browser, or connection to get around a block. The site notices. Getting around a block starts it again at the next length up, and a second time makes it permanent. If you think the block was wrong, appeal it from the ban screen instead.",
    why: "A block only means something if it holds. If it could be walked around, the people who play fair would be the only ones it ever kept out.",
    response: "No warning. The block starts again at the next length up. A second time, permanent.",
    block: "7d",
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
      "Warn before you kick. Kick before you block. Reach for a longer block only when a shorter one has already failed. A kick is a full stop in a conversation, not a punishment. When you pick a rule in the block dialog it suggests the usual length for a first offence; that is a starting point, and the reason you write is where you say why you went longer or shorter.",
    why: "Most trouble stops at the first sign that somebody is watching, and an over-reaction turns a small problem into a grudge.",
  },
  {
    level: "all",
    title: "Underage users are removed, not warned",
    body:
      "When somebody clearly states they are under 13, act on it: remove them with the standard underage notice, and a full moderator places a permanent block with underage as the recorded reason. Only a clear statement counts. A guess from how somebody types is not a disclosure, and another user calling somebody a child is not one either. Never ask anybody their age, never ask for proof, and never collect anything beyond the normal log: no names, no schools, no photos, ever. If they come back, treat it as ordinary ban evasion. The block can be appealed the day they meet the age requirement.",
    why: "The law sets this one, not us. And the one way staff can make it worse is by questioning a child for personal details, so we never do.",
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
    title: "Act on what you can see",
    body:
      "A report is a lead, not a verdict. Act on what the site captured: the snapshot when you act, the quote on the report card, the trail of what they typed. Somebody telling you what happened is a reason to look, not a reason to block. If you cannot see it, take the step you can undo, warn, write a note so the next mod knows, and watch. Somebody being annoying, disagreeing with you, or swearing is never a reason for a block. The Desk's #playbook says what to do in the situations that come up.",
    why: "A block built on somebody's word cannot be defended in an appeal, and the person it lands on can tell.",
  },
  {
    level: "all",
    title: "Say why, every time",
    body:
      "Every ban and block names the rule it enforces, and the site will not place one without it. Fill in the reason on warnings and kicks too, written for two readers: the person receiving it, and whoever reads your record months later with no memory of the day. A block of a week or longer also needs a write-up: what they did, the rule, what was tried first, and why that length. The block goes in first and the write-up follows while it is fresh.",
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
      "Do not tell people you can ban them if you cannot, and do not present yourself as an admin. If something needs a level above yours, say so and pass it on.",
    why: "Overstating what you can do is the same trust problem as a user impersonating staff, and it is worse coming from real staff.",
  },
  {
    level: "all",
    title: "Everything you do is recorded",
    body:
      "Every privileged action is written to the audit log with your label, the target, and your reason, and it stays in your record. Every action on a person also saves a snapshot of what was on screen at that moment: what they had typed, whether they had been reported, what staff had already done. This is normal and it applies to every moderator including admins.",
    why: "The record is what makes it safe to hand these tools out at all. It protects you from an accusation just as much as it catches misuse.",
  },
  {
    level: "all",
    title: "You can read your own record",
    body:
      "Your record shows you everything a mod leader sees about you, flags included. If a flag is wrong, open the case and add a note saying what the snapshot does not show. Whoever reviews it reads your note next to the evidence. The record is not a score and there is no leaderboard for it.",
    why: "You cannot answer what you cannot see, and a review nobody can answer is not a review.",
  },
  {
    level: "jr",
    title: "Junior moderators: what you hold",
    body:
      "You can warn, kick, and bar a user from the room you kicked them out of, run the room itself (rename, lock, slow mode, clear the board), and work the report queue: every report reaches you, and a warning or a kick from you settles it. You cannot IP block, close a room, discard a report, or see the ban list, appeals, or applications. Those need a full moderator.",
    why: "You start with the tools that are reversible and none of the ones that are not, which is how you learn the job without anybody paying for a mistake.",
  },
  {
    level: "jr",
    title: "Junior moderators: escalate rather than guess",
    body:
      "When something needs more than a warning or a kick, leave it and call a full moderator or an admin. Do not improvise a substitute, and do not lean on somebody else to run the action for you without telling them what it is. For an underage disclosure, kick with the standard notice and call a full moderator to place the block.",
    why: "A handover with the facts attached is worth more than a fast decision made by the person with the fewest tools.",
  },
  {
    level: "full",
    title: "Full moderators: what you hold",
    body:
      "Everything a junior has, plus IP blocks from 1 hour to 1 month, or permanent, closing a room, spectating public rooms, discarding reports, resolving appeals, killing bots, and taking down community themes. Lifting a permanent block, wide range bans, applications and promotions, and the site-wide tools sit above you.",
    why: "Anything that cannot be undone by the person who did it sits one level above them on purpose.",
  },
  {
    level: "full",
    title: "Full moderators: blocks are temporary by default",
    body:
      "Pick the shortest block that will actually work, and let it expire rather than reaching for the next tier out of habit. Permanent is yours to place, but only an admin can lift it, so treat it as writing something you personally cannot erase. Underage removals are the standing exception: those are always made permanent.",
    why: "A temporary block that works costs nothing to get wrong. A permanent one removes somebody from an anonymous platform they can simply rejoin, so it mostly punishes the people who play fair.",
  },
  {
    level: "full",
    title: "Full moderators: do not rule on your own ban",
    body:
      "The site will not let you decide an appeal against a block you placed; another full moderator or an admin does that, and you can still reply in the thread. Before you decide anybody's appeal, read the case behind the block, the snapshot and the write-up, not just the appeal text.",
    why: "Reviewing yourself is not a review, and the person appealing can tell.",
  },
  {
    level: "leader",
    title: "Mod leaders: what you hold",
    body:
      "Everything a full moderator has, plus the team itself: opening and closing applications, approving applicants as juniors, declining them, promoting between L1 and L2, removing junior and full mod keys with a written reason, bringing former mods back as juniors, and reading any junior or full mod's record and abuse flags. Leader keys, ban lifts, and the platform tools stay with admins.",
    why: "Somebody has to own who is on the team and how they are doing, and it should be a person whose own record is on the line, not just whoever happens to hold an admin key.",
  },
  {
    level: "leader",
    title: "Mod leaders: promote from evidence, not friendship",
    body:
      "Approve applicants as juniors and promote from the record: the on-users number, how they handled reports, what their flags look like once read in context. Do not hand a key to a friend who has not applied, and do not promote to settle an argument. Every grant, promotion, and removal you make is logged with your name and shows in your own record.",
    why: "The whole ladder only means something if the person running it treats it as evidence-based. One friendship promotion undoes months of the team taking it seriously.",
  },
  {
    level: "all",
    title: "Answer appeals, do not sit on them",
    body:
      "An appeal that is never answered reads as contempt, and it is the complaint that reaches admins most often. Decide it, or say plainly that it is being passed up.",
    why: "People accept a no far more often than they accept silence.",
  },
  {
    level: "all",
    title: "How mod abuse is watched",
    body:
      "The system watches each key for patterns: a burst of decisions on people inside five minutes, several passes at the same person, a spray across many people at once, or heavy punishments with nothing behind them in the snapshot. Appeal replies and queue work never count. It never punishes anybody by itself. It raises one flag with your recent actions attached, and a mod leader or an admin reads it.",
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
      "The record counts actions that landed on a person, because that is what moderating is. Tidying rooms, clearing queues and talking people through appeals is genuinely useful and is counted separately. Nothing you say in staff chat counts as work.",
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

// The playbook: what to do in the situations that actually come up, what
// counts as proof, and what not to do. Staff only. Written as the usual way,
// never the only way.
const DEFAULT_PLAYBOOK = [
  {
    title: "Somebody is being annoying",
    do: "Nothing, or say something. Annoying is not a rule. If the room is done with them, the room can dislike-vote. If it turns into harassment, that is rule 3 and a different situation.",
    proof: "None, because nothing happens.",
    dont: "Kick or block somebody for being loud, weird, boring, or wrong.",
    length: "none",
  },
  {
    title: "Swearing, filter on or off",
    do: "Nothing. The filter is each person's own setting.",
    proof: "None.",
    dont: "Treat a swear word as evidence of anything.",
    length: "none",
  },
  {
    title: "Somebody reports harassment",
    do: "Read the quote on the report card first. It was captured from the other person's box the moment the report was sent, so it counts even if the box is clean now. If you can see it, warn. If it carries on, 1 day.",
    proof: "The quote on the report, the snapshot when you act, or two reports from different people about the same thing.",
    dont: "Block on the reporter's word alone. A report is a lead, not a verdict.",
    length: "24h",
  },
  {
    title: "Somebody says their address, school or number was posted",
    do: "Look for it: the box, the trail, the quote on the report. If it is there, wipe first, because the wipe saves what it wiped, then a 1-week block. If you cannot see it anywhere, warn them under rule 5, write a note on their record so the next mod knows, and watch.",
    proof: "The text itself, somewhere the site captured it.",
    dont: "Ask the reporter for the details so you can check them. Staff never collect personal information; you would be doing what the rule forbids.",
    length: "7d",
  },
  {
    title: "Someone says they are under 13",
    do: "Only a clear statement from the person themselves counts. Kick with the underage notice; a full mod places the permanent block with underage as the reason.",
    proof: "Their own words, in the snapshot or the trail.",
    dont: "Act because another user said so, guess from how they type, or ask anyone's age.",
    length: "permanent",
  },
  {
    title: "Hate speech or slurs",
    do: "A 1-week block, no warning. Spelt past the filter still counts.",
    proof: "The snapshot. The filter usually catches it for you.",
    dont: "Confuse strong language aimed at nobody with an attack on a group of people.",
    length: "7d",
  },
  {
    title: "Spam or flooding",
    do: "Wipe and kick. 6 hours if they come back and do it again. A bot doing it: kill the bot, and its maker is banned with it.",
    proof: "The snapshot shows the wall.",
    dont: "Block a whole range for one flooder. The range hits the neighbours.",
    length: "6h",
  },
  {
    title: "Sexual content in a public room",
    do: "Wipe and kick. 1 day if it continues or was aimed at somebody. If a minor is involved, that is rule 10: permanent, and tell an admin.",
    proof: "The snapshot, or the quote on the report.",
    dont: "Leave it on screen while you decide.",
    length: "24h",
  },
  {
    title: "Pretending to be staff",
    do: "Reset their name and warn. 1 day if they keep at it.",
    proof: "The name or the line itself.",
    dont: "Argue about it in the room. Real staff have the badge.",
    length: "24h",
  },
  {
    title: "They came back after a block",
    do: "The site usually flags it. Block again, one step longer. Second time, permanent.",
    proof: "The evasion alert, or the person view joining the new device to the old one.",
    dont: "Block on a hunch because a new name turned up. If the person view does not join them, they are not joined.",
    length: "7d",
  },
  {
    title: "A raid: several people at once",
    do: "Kick and room-ban fast, lock the room if you need to, 1-day blocks. The snapshots cover you. Write-ups come after; they wait for you, the raid does not.",
    proof: "The snapshots, taken for you.",
    dont: "Skip the write-ups afterwards.",
    length: "24h",
  },
  {
    title: "They are arguing with you",
    do: "Hand it to another mod. Ask in #help. Being right does not make it yours.",
    proof: "Not yours to weigh.",
    dont: "Act while you are in it.",
    length: "none",
  },
  {
    title: "Somebody wants their friend or their enemy banned",
    do: "Look at what you can see, and only that. Nobody is blocked for asking.",
    proof: "The same as anything else: the snapshot.",
    dont: "Run actions for anybody.",
    length: "none",
  },
  {
    title: "A report about a private room",
    do: "Only a report from inside the room brings you in, and only for the three things that hold everywhere: illegal content, personal information, the age rule.",
    proof: "The quote on the report.",
    dont: "Join or spectate the room to check.",
    length: "none",
  },
  {
    title: "Threats of violence, or somebody talking about hurting themselves",
    do: "A credible threat is rule 10: permanent, and tell an admin straight away. Somebody who sounds like they might hurt themselves: be kind, do not moderate them, and tell an admin.",
    proof: "The snapshot.",
    dont: "Play counsellor, or ban somebody for being in a bad place.",
    length: "permanent",
  },
  {
    title: "You are not sure",
    do: "Take the step you can undo: warn or kick. Write a note. Ask in #l2 or #help. Come back to it.",
    proof: "If you are not sure you have it, you do not have it.",
    dont: "Pick a long block to be safe. Long is not safe for the person on the other end.",
    length: "none",
  },
  {
    title: "Before a permanent block",
    do: "Outside a raid, underage, illegal content and evasion, ask in #l2 first. A second pair of eyes takes a minute and saves an appeal.",
    proof: "The snapshot plus the history in the person view.",
    dont: "Make somebody permanent because a shorter block failed once. That is what 1 month is for.",
    length: "permanent",
  },
];

// ── Store ───────────────────────────────────────────────────────────────────

let store = {
  community: [],
  mod: [],
  playbook: [],
  updatedAt: 0,
  updatedBy: null,
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

// A community rule carries the usual response for a first offence: a sentence
// everyone can read, and the block length the ban dialog starts from. The
// moderator can always pick a different length.
const BLOCKS = ["", "none", "1h", "6h", "24h", "3d", "7d", "30d", "permanent"];

function normalise(raw, isMod) {
  const title = clean(raw && raw.title, MAX_TITLE);
  const body = clean(raw && raw.body, MAX_BODY);
  const why = clean(raw && raw.why, MAX_BODY);
  if (!title && !body) return null;
  const out = { id: clean(raw && raw.id, 24) || nextId(), title, body, why };
  if (isMod) {
    const lvl = clean(raw && raw.level, 8);
    out.level = LEVELS.includes(lvl) ? lvl : "all";
  } else {
    out.response = clean(raw && raw.response, 240);
    const block = clean(raw && raw.block, 12);
    out.block = BLOCKS.includes(block) ? block : "";
  }
  return out;
}

function seed(list, isMod) {
  return list.map((r) => normalise(r, isMod)).filter(Boolean);
}

const LENGTHS = ["none", "1h", "6h", "24h", "3d", "7d", "30d", "permanent"];

function normalisePlay(raw) {
  const title = clean(raw && raw.title, MAX_TITLE);
  if (!title) return null;
  const length = clean(raw && raw.length, 12);
  return {
    id: clean(raw && raw.id, 24) || nextId(),
    title,
    do: clean(raw && raw.do, MAX_BODY),
    proof: clean(raw && raw.proof, MAX_BODY),
    dont: clean(raw && raw.dont, MAX_BODY),
    length: LENGTHS.includes(length) ? length : "none",
  };
}

function seedPlay(list) {
  return list.map(normalisePlay).filter(Boolean);
}

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (o && typeof o === "object") {
      store.community = Array.isArray(o.community)
        ? seed(o.community, false)
        : [];
      store.mod = Array.isArray(o.mod) ? seed(o.mod, true) : [];
      store.playbook = Array.isArray(o.playbook) ? seedPlay(o.playbook) : [];
      store.updatedAt = o.updatedAt || 0;
      store.updatedBy = o.updatedBy || null;
      store.seeded = !!o.seeded;
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading rules.json:", err);
  }
  if (!store.seeded) {
    store.community = seed(DEFAULT_COMMUNITY, false);
    store.mod = seed(DEFAULT_MOD, true);
    store.seeded = true;
    saveSoon();
  }
  // The playbook arrived after the first seed, so an existing store gets it
  // without anyone having to press reset.
  if (!store.playbook.length) {
    store.playbook = seedPlay(DEFAULT_PLAYBOOK);
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

const SECTIONS = ["community", "mod", "playbook"];

// The playbook is for staff. Everything else is public.
function publicRules(opts) {
  const out = {
    community: store.community.map((r) => ({ ...r })),
    mod: store.mod.map((r) => ({ ...r })),
    updatedAt: store.updatedAt || 0,
  };
  if (opts && opts.staff) out.playbook = store.playbook.map((r) => ({ ...r }));
  return out;
}

function setSection(section, list, byLabel) {
  if (!SECTIONS.includes(section)) return { ok: false };
  if (!Array.isArray(list)) return { ok: false };
  const next = list
    .slice(0, MAX_RULES)
    .map((r) =>
      section === "playbook" ? normalisePlay(r) : normalise(r, section === "mod"),
    )
    .filter(Boolean);
  store[section] = next;
  store.updatedAt = Date.now();
  store.updatedBy = clean(byLabel, 40) || null;
  saveSoon();
  return { ok: true, count: next.length };
}

function resetSection(section, byLabel) {
  if (section === "community")
    return setSection("community", DEFAULT_COMMUNITY, byLabel);
  if (section === "mod") return setSection("mod", DEFAULT_MOD, byLabel);
  if (section === "playbook")
    return setSection("playbook", DEFAULT_PLAYBOOK, byLabel);
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
