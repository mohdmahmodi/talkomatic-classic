// feature-announce.js - One-time "New Feature" modal for word filter toggle
// Dismissed via cookie for 60 days.
(function () {
  var COOKIE_NAME = "tk_announce_seen";
  var COOKIE_DAYS = 60;

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
    return match ? match[2] : null;
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie =
      name + "=" + value + ";expires=" + d.toUTCString() + ";path=/";
  }

  if (getCookie(COOKIE_NAME)) return;

  var overlay = document.getElementById("featureAnnounce");
  var closeBtn = document.getElementById("featureAnnounceClose");
  if (!overlay || !closeBtn) return;

  setTimeout(function () {
    overlay.classList.add("show");
  }, 1500);

  function dismiss() {
    overlay.classList.remove("show");
    setCookie(COOKIE_NAME, "1", COOKIE_DAYS);
  }

  closeBtn.addEventListener("click", dismiss);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.classList.contains("show")) dismiss();
  });
})();
