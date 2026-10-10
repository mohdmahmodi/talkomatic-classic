// server/browser.js

const SYSTEMS = [
  ["iOS", /iPhone|iPad|iPod/],
  ["Android", /Android/],
  ["ChromeOS", /CrOS/],
  ["Windows", /Windows/],
  ["Mac", /Mac OS X|Macintosh/],
  ["Linux", /Linux/],
];

const BROWSERS = [
  ["Edge", /Edg\/|EdgiOS\//],
  ["Opera", /OPR\/|OPiOS\/|OPT\/|Opera/],
  ["Firefox", /Firefox\/|FxiOS\//],
  ["Chrome", /Chrome\/|CriOS\//],
  ["Safari", /Safari\//],
];

const HOSTS = [
  ["Messenger", /FBAN\/Messenger|FB_IAB\/MESSENGER/],
  ["Facebook", /FBAN\/|FBAV\/|FB_IAB\//],
  ["Instagram", /Instagram/],
  ["Threads", /Barcelona/],
  ["TikTok", /TikTok|BytedanceWebview|musical_ly/],
  ["Snapchat", /Snapchat/],
  ["X", /Twitter/],
  ["Reddit", /Reddit/],
  ["Pinterest", /Pinterest/],
  ["LinkedIn", /LinkedInApp/],
  ["WhatsApp", /WhatsApp/],
  ["Telegram", /Telegram/],
  ["WeChat", /MicroMessenger/],
  ["Line", /\bLine\//],
  ["the Google app", /GSA\//],
];

const SIGNIN_FLOOD = /^Automod: signed in /;

function first(list, s) {
  const hit = list.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

function describe(ua) {
  const s = String(ua || "");
  const os = first(SYSTEMS, s);
  const host = first(HOSTS, s);
  const webview = os === "iOS" ? !/Safari\//.test(s) : os === "Android" && /; ?wv\)/.test(s);
  const embedded = !!s && (!!host || webview);
  return { os, host, embedded, app: embedded ? null : first(BROWSERS, s) };
}

function label(ua) {
  const s = String(ua || "");
  if (!s) return "none sent";
  const b = describe(s);
  const on = b.os ? " on " + b.os : "";
  if (b.embedded) return (b.host ? b.host + "'s built-in browser" : "a built-in browser inside another app") + on;
  if (b.app) return b.app + on;
  return "not a known browser (" + s.replace(/[\d.]+/g, "").slice(0, 40).trim() + ")";
}

function embeddedHint(ua, reason, hasCookie) {
  if (hasCookie || !SIGNIN_FLOOD.test(reason || "")) return null;
  const b = describe(ua);
  return b.os === "iOS" && b.embedded ? { app: b.host } : null;
}

module.exports = { describe, label, embeddedHint };
