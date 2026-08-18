// server/chatguard.js
// What every line of user text has to clear before it reaches the room.

const { CONFIG, sanitizeMessage, wordFilter } = require("./state");
const ipredact = require("./ipredact");
const linkfilter = require("./linkfilter");

function clean(text, limit) {
  let out = sanitizeMessage(String(text == null ? "" : text));
  if (limit) out = out.slice(0, limit);
  if (ipredact.looksLikeIp(out)) out = ipredact.redact(out);
  if (linkfilter.looksLikeLink(out)) out = linkfilter.redact(out);
  if (CONFIG.FEATURES.ENABLE_WORD_FILTER) {
    try {
      out = wordFilter.filterText(out);
    } catch (_) {}
  }
  return out;
}

module.exports = { clean };
