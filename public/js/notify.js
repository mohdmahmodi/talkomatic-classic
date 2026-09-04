// public/js/notify.js
// One notification style for the whole site, built on ModernNotify. Every
// toast path ends up here: StaffUI.toast, the old toastr calls, and the
// lobby and room notify helpers.
(function () {
  "use strict";
  if (!window.ModernNotify) return;

  var ICONS = {
    success: '<i class="fas fa-circle-check"></i>',
    error: '<i class="fas fa-circle-exclamation"></i>',
    warning: '<i class="fas fa-triangle-exclamation"></i>',
    info: '<i class="fas fa-circle-info"></i>',
  };
  var STICKY_MS = 10 * 60 * 1000;

  ModernNotify.init({
    position: "top-right",
    theme: "dark",
    animationStyle: "slide",
    slideDirection: "right",
    width: "340px",
    duration: 5000,
    maxNotifications: 4,
    showProgressBar: true,
    pauseOnHover: true,
    closeOnClick: false,
    customIcons: ICONS,
  });

  // Errors stay until dismissed. Everything else lingers in proportion to
  // how much there is to read.
  function durationFor(type, text, title) {
    if (type === "error") return 0;
    var words = String((title || "") + " " + (text || ""))
      .trim()
      .split(/\s+/).length;
    return Math.min(14000, Math.max(4500, 2200 + words * 380));
  }

  function show(type, message, opts) {
    var o = opts || {};
    if (!ICONS[type]) type = "info";
    var text = String(message == null ? "" : message);
    var timeout = o.timeout != null ? o.timeout : durationFor(type, text, o.title);
    var sticky = timeout === 0;
    var options = {
      duration: sticky ? STICKY_MS : timeout,
      showProgressBar: !sticky,
    };
    if (o.title) options.title = String(o.title);
    if (o.actions && o.actions.length)
      options.actions = o.actions.map(function (a) {
        return {
          text: a.label || a.text,
          onClick: function (n) {
            if (typeof a.onClick === "function") a.onClick(n);
            n.close();
          },
        };
      });
    if (typeof o.onClick === "function") {
      options.closeOnClick = true;
      options.onClick = o.onClick;
    }
    var n = ModernNotify[type](text, options);
    if (!n || !n.element) return n;
    if (!o.title) n.element.classList.add("tk-untitled");
    if (o.onClick) n.element.classList.add("tk-clickable");
    if (o.fullWidth) {
      n.element.classList.add("tk-wide");
      n.element.style.width = "560px";
      n.element.style.maxWidth = "calc(100vw - 28px)";
    }
    return n;
  }

  function typed(type) {
    return function (message, opts) {
      return show(type, message, opts);
    };
  }

  window.TkNotify = {
    show: show,
    success: typed("success"),
    error: typed("error"),
    warning: typed("warning"),
    info: typed("info"),
    dismissAll: function () {
      ModernNotify.dismissAll();
    },
  };

  // The toastr surface the older pages still call: toastr.type(message,
  // title, { timeOut, onclick }). timeOut 0 keeps toastr's meaning of sticky.
  function fromToastr(type) {
    return function (message, title, o) {
      o = o || {};
      return show(type, message, {
        title: title,
        timeout: o.timeOut != null ? o.timeOut : undefined,
        onClick: typeof o.onclick === "function" ? o.onclick : undefined,
      });
    };
  }

  window.toastr = {
    options: {},
    success: fromToastr("success"),
    error: fromToastr("error"),
    warning: fromToastr("warning"),
    info: fromToastr("info"),
    clear: function () {
      ModernNotify.dismissAll();
    },
    remove: function () {
      ModernNotify.dismissAll();
    },
  };
})();
