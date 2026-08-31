// public/js/first-visit.js
// First visit to the lobby: everyone reads the rules, then the staff guide,
// once, before anything else. Both open in gate mode (no closing until the
// button at the bottom is pressed). The dev announcement waits until this is
// done - see announce.js.
(function () {
  "use strict";
  var KEY = "tkWelcomeDone";

  function done() {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch (e) {
      return true;
    }
  }

  function finish() {
    try {
      localStorage.setItem(KEY, "1");
    } catch (e) {}
    document.dispatchEvent(new Event("tk-welcome-done"));
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (done()) return;
    if (!window.TalkomaticRules || !window.StaffGuide) return;
    // A short beat so the lobby paints before the modal lands on it.
    setTimeout(function () {
      window.TalkomaticRules.open({
        gate: true,
        onDone: function () {
          window.StaffGuide.open({ gate: true, onDone: finish });
        },
      });
    }, 700);
  });

  window.TkFirstVisit = { done: done };
})();
