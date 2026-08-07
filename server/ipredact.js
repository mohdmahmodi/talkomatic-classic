// server/ipredact.js
// One definition of "this reads as an IP address", for every place an address
// must not reach the person looking at it:
//
//   - the staff board and audit log, where an address is developer-only
//   - room textboxes, so a user cannot hand another user's address around
//
// Evasion is only handled where there is no other reading. "192[.]168[.]1[.]1"
// and "192 dot 168 dot 1 dot 1" are never anything else, so they are caught.
// "1 . 2 . 3 . 4" is deliberately left alone: a numbered list looks exactly the
// same, and mangling one mid-sentence is a worse bug than missing an evader who
// could have spelled the numbers out in words anyway.

// A dot. Bare ones must sit tight against the digits; the defanged and the
// spelled-out forms may be spaced, because nothing else is written that way.
const DOT = "(?:\\.|\\s*[\\[({]\\s*(?:\\.|dot)\\s*[\\])}]\\s*|\\s+dot\\s+)";
const OCT = "(\\d{1,3})";

// Trailing "/24" and ":8080" are swallowed with the address so a redaction
// never leaves a bare port sitting next to the placeholder.
const IPV4_RE = new RegExp(
  "\\b" + OCT + DOT + OCT + DOT + OCT + DOT + OCT +
  "(?!\\d)(?:\\s*/\\s*\\d{1,2})?(?::\\d{1,5})?(?!\\d)",
  "gi",
);

// Hex groups and colons, plus the wrappers a written address carries: brackets
// (and the port that follows them), a zone id, a prefix length. Which of these
// are actually addresses is decided in isIpv6 rather than here - the shapes
// that need catching are hard to tell from a clock in a pattern alone.
const IPV6_RE =
  /\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}\]?(?:%[0-9a-z_.-]{1,20})?(?:\/\d{1,3})?(?::\d{1,5})?/gi;

const DEFAULT_LABEL = "[ip redacted]";

function isIpv4(a, b, c, d) {
  return +a <= 255 && +b <= 255 && +c <= 255 && +d <= 255;
}

function isIpv6(token) {
  let body = token;
  if (body[0] === "[") {
    const close = body.indexOf("]");
    body = close === -1 ? body.slice(1) : body.slice(1, close);
  } else {
    // No brackets means no way to tell a port from another group, so only the
    // zone and the prefix come off.
    body = body.split("%")[0].split("/")[0];
  }
  const groups = body.split(":");
  const filled = groups.filter((g) => g !== "").length;
  // A clock ("1:52:08") is three groups and does not compress, so it survives.
  // An address either compresses and still names two groups, or writes out
  // enough of them that nothing else looks the same. Bare "::" is not an
  // address and neither is "::1", which is every machine's own loopback.
  if (body.includes("::")) return filled >= 2;
  return groups.length >= 5;
}

// Cheap gate so most text is answered without running either pattern. This
// sits on the room chat path, once per batch of keystrokes per speaker.
// No digit test: "abcd:ef::beef" is all letters and still an address.
function looksLikeIp(value) {
  return (
    typeof value === "string" &&
    value.length >= 7 &&
    (value.includes(".") || value.includes(":") || /dot/i.test(value))
  );
}

// Replaces every address in `value` with `label`. Returns non-strings and
// empty strings untouched, so callers can pass a nullable field straight in.
function redact(value, label) {
  if (!looksLikeIp(value)) return value;
  const tag = label || DEFAULT_LABEL;
  return value
    .replace(IPV4_RE, (m, a, b, c, d) => (isIpv4(a, b, c, d) ? tag : m))
    .replace(IPV6_RE, (m) => (isIpv6(m) ? tag : m));
}

// For inputs that are rejected rather than rewritten. A username or a room
// name cannot be shown as a placeholder - the roster and the lobby have to
// stay readable - so those are refused at the door instead.
function containsIp(value) {
  return redact(value) !== value;
}

module.exports = { redact, containsIp, looksLikeIp, DEFAULT_LABEL };
