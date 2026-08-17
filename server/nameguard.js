// server/nameguard.js
// One gate for the text that stands in for a person: usernames, locations,
// room names and bot names.

const { map: CONFUSABLES } = require("./confusables.json");

const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵ㅤ﻿ﾠ᠋-᠎​-‏‪-‮⁠-⁯︀-️]/gu;

// NFKC folds the styled alphabets back to the letters they read as, so a name
// pasted out of a fancy-text generator is stored as its plain text rather than
// refused.
function normalize(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// What the allowlist is tested against. Diacritics come off for the test only,
// so Jose and José both pass and the name keeps its accents.
function fold(value) {
  return normalize(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

const PUNCTUATION = new Set(" _-.',!?&#@()+*".split(""));

// Pictographs are allowed because a picture cannot be mistaken for a letter.
// The enclosed alphanumerics are the exception and are not: that block is
// where the circled letters and the regional-indicator flags live, and both
// spell words.
function allowedChar(ch) {
  if (/[a-z0-9]/.test(ch)) return true;
  if (PUNCTUATION.has(ch)) return true;
  const cp = ch.codePointAt(0);
  if (cp >= 0x1f100 && cp <= 0x1f1ff) return false;
  return /\p{Extended_Pictographic}/u.test(ch);
}

// The digit-for-letter swaps a person reads straight through and Unicode does
// not carry, because 1 is genuinely not the same shape as i. Applied on top of
// the confusable set, and only ever to decide whether a name is impersonating
// a reserved one.
const LEET = {
  "0": "o", "1": "l", i: "l", "|": "l", "5": "s", $: "s", "2": "z",
  "8": "b", "6": "g", "4": "a", "@": "a", "3": "e", "7": "t", "+": "t",
};

// UTS #39 skeleton: every character replaced by the representative of its
// confusable set, so two names that read the same collapse to one string. Case
// is folded first, because the Unicode data carries some of these mappings on
// the lowercase letter only. For comparison, never for display.
function skeleton(value) {
  const flat = normalize(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  let out = "";
  for (const ch of flat)
    for (const c of CONFUSABLES[ch] || ch) out += LEET[c] || c;
  return out.replace(/[^a-z0-9]+/g, "");
}

function looksLike(a, b) {
  const sa = skeleton(a);
  return !!sa && sa === skeleton(b);
}

// Returns the name to store, or the reason it cannot be used.
function check(value, opts) {
  const name = normalize(value);
  if (!name) return { ok: false, reason: "empty" };
  const folded = fold(name);
  for (const ch of folded)
    if (!allowedChar(ch)) return { ok: false, reason: "character", at: ch };
  for (const reserved of (opts && opts.reserved) || [])
    if (looksLike(name, reserved))
      return { ok: false, reason: "reserved", like: reserved };
  return { ok: true, name };
}

module.exports = { normalize, fold, skeleton, looksLike, check };
