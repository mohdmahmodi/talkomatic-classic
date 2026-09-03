// feature-announce.js - One-time card for the personal toggles (word filter,
// hide bots). Dismissed via cookie for 60 days. The name is versioned so a
// reworded card shows once more to people who dismissed an older one. It is
// shown by first-visit.js in its turn, never on its own.
(function () {
  var COOKIE_NAME = "tk_announce_seen2";
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

  var overlay = document.getElementById("featureAnnounce");
  var closeBtn = document.getElementById("featureAnnounceClose");

  function seen() {
    return !overlay || !closeBtn || !!getCookie(COOKIE_NAME);
  }

  function show() {
    if (!seen()) overlay.classList.add("show");
  }

  function dismiss() {
    overlay.classList.remove("show");
    setCookie(COOKIE_NAME, "1", COOKIE_DAYS);
  }

  if (overlay && closeBtn) {
    closeBtn.addEventListener("click", dismiss);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("show")) dismiss();
    });
  }

  window.TkFeatureAnnounce = { seen: seen, show: show };
})();
