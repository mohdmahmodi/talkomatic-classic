// server/ipredact.js
// One definition of "this reads as an IP address", for every place an
// address must not reach the person looking at it: - the staff board and
// audit log, where an address is developer-only - room textboxes, so a user
// cannot hand another user's address around Evasion is only handled where
// there is no other reading.

const DOT = "(?:\\.|\\s*[\\[({]\\s*(?:\\.|dot)\\s*[\\])}]\\s*|\\s+dot\\s+)";
const OCT = "(\\d{1,3})";

const IPV4_RE = new RegExp(
  "\\b" + OCT + DOT + OCT + DOT + OCT + DOT + OCT +
  "(?!\\d)(?:\\s*/\\s*\\d{1,2})?(?::\\d{1,5})?(?!\\d)",
  "gi",
);

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
    body = body.split("%")[0].split("/")[0];
  }
  const groups = body.split(":");
  const filled = groups.filter((g) => g !== "").length;
  if (body.includes("::")) return filled >= 2;
  return groups.length >= 5;
}

function looksLikeIp(value) {
  return (
    typeof value === "string" &&
    value.length >= 7 &&
    (value.includes(".") || value.includes(":") || /dot/i.test(value))
  );
}

function redact(value, label) {
  if (!looksLikeIp(value)) return value;
  const tag = label || DEFAULT_LABEL;
  return value
    .replace(IPV4_RE, (m, a, b, c, d) => (isIpv4(a, b, c, d) ? tag : m))
    .replace(IPV6_RE, (m) => (isIpv6(m) ? tag : m));
}

function containsIp(value) {
  return redact(value) !== value;
}

module.exports = { redact, containsIp, looksLikeIp, DEFAULT_LABEL };
