// public/js/first-visit.js
// New people are walked in one card per room visit, inside the room, instead
// of being stopped at the lobby door: the rules first, then the automod and
// bot switches, then the staff guide. Each card shows once, never two in a
// row, and only after the room has loaded around them.
(function () {
  "use strict";
  var RULES = "tkWelcomeDone";
  var GUIDE = "tkStaffGuideDone";

  function flag(key) {
    try {
      return localStorage.getItem(key) === "1";
    } catch (e) {
      return true;
    }
  }
  function mark(key) {
    try {
      localStorage.setItem(key, "1");
    } catch (e) {}
  }

  var steps = [
    {
      due: function () {
        return !flag(RULES) && !!window.TalkomaticRules;
      },
      show: function () {
        window.TalkomaticRules.open({
          gate: true,
          onDone: function () {
            mark(RULES);
            document.dispatchEvent(new Event("tk-welcome-done"));
          },
        });
      },
    },
    {
      due: function () {
        return !!window.TkFeatureAnnounce && !window.TkFeatureAnnounce.seen();
      },
      show: function () {
        window.TkFeatureAnnounce.show();
      },
    },
    {
      due: function () {
        return !flag(GUIDE) && !!window.StaffGuide;
      },
      show: function () {
        window.StaffGuide.open({
          gate: true,
          onDone: function () {
            mark(GUIDE);
          },
        });
      },
    },
  ];

  var shown = false;
  document.addEventListener("tk-room-joined", function () {
    if (shown) return;
    var step = steps.find(function (s) {
      return s.due();
    });
    if (!step) return;
    shown = true;
    setTimeout(step.show, 1200);
  });

  window.TkFirstVisit = {
    done: function () {
      return flag(RULES);
    },
  };
})();
