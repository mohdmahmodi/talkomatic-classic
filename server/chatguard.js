// server/chatguard.js
// What every line of user text has to clear before it reaches the room.

const { CONFIG, sanitizeMessage, wordFilter } = require("./state");
const ipredact = require("./ipredact");
const linkfilter = require("./linkfilter");

// For the one-shot surfaces: the board's chat line and the games feed. A room
// textbox is a live diff and cannot be rewritten in place, so it is filtered
// per reader on the way out instead.
// The word filter runs last so an address is already a placeholder by then.
// It carries entries that match the scheme of a URL, which would otherwise
// leave a row of asterisks in front of every link it was about to remove.
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
