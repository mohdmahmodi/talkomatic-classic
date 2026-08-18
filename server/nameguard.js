// server/nameguard.js
// One gate for the text that stands in for a person: usernames, locations,
// room names and bot names.

const { map: CONFUSABLES } = require("./confusables.json");

const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵ㅤ﻿ﾠ᠋-᠎​-‏‪-‮⁠-⁯︀-️]/gu;

function normalize(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fold(value) {
  return normalize(value)
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

const PUNCTUATION = new Set(" _-.',!?&#@()+*".split(""));

function allowedChar(ch) {
  if (/[a-z0-9]/.test(ch)) return true;
  if (PUNCTUATION.has(ch)) return true;
  const cp = ch.codePointAt(0);
  if (cp >= 0x1f100 && cp <= 0x1f1ff) return false;
  return /\p{Extended_Pictographic}/u.test(ch);
}

const LEET = {
  "0": "o", "1": "l", i: "l", "|": "l", "5": "s", $: "s", "2": "z",
  "8": "b", "6": "g", "4": "a", "@": "a", "3": "e", "7": "t", "+": "t",
};

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
