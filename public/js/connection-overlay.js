// public/js/connection-overlay.js
// Full-screen overlay for connection events.
(function () {
  "use strict";
  var restarting = false;
  var reconnectTimer = null;
  var buttonsTimer = null;
  var retryTimer = null;
  var rejoinInPlace = false;
  var everConnected = false;

  // Most drops (wifi roam, phone tab unfreeze, laptop wake) heal on the first
  // reconnect attempt, a second or two in. The overlay is for outages that
  // outlive that, not a flash on every blip. Armed once per outage: resetting
  // it on every failed attempt would keep pushing it out forever.
  var GRACE_DROP = 5000;
  var GRACE_FIRST = 2500;

  function armOverlay(delay) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      showReconnecting();
    }, delay);
  }

  function disarmOverlay() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function styles() {
    if (document.getElementById("tkConnStyles")) return;
    var st = document.createElement("style");
    st.id = "tkConnStyles";
    st.textContent =
      "#tkConnOverlay{position:fixed;inset:0;z-index:1000003;background:rgba(8,8,8,.92);" +
      "display:none;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;}" +
      "#tkConnOverlay .tk-conn-box{max-width:440px;width:100%;background:#181818;border:1px solid #616161;" +
      "border-radius:10px;padding:34px 28px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6);}" +
      "#tkConnOverlay .tk-conn-title{color:#ff9800;font-size:23px;font-weight:bold;margin:0 0 8px;}" +
      "#tkConnOverlay .tk-conn-msg{color:#ddd;font-size:15px;line-height:1.5;margin:0;}" +
      "#tkConnOverlay .tk-conn-msg b{color:#fff;font-size:20px;}" +
      "#tkConnOverlay .tk-conn-bar{height:6px;background:#333;border-radius:4px;overflow:hidden;margin-top:16px;}" +
      "#tkConnOverlay .tk-conn-bar span{display:block;height:100%;width:0;background:#ff9800;transition:width 1s linear;}" +
      "#tkConnOverlay .tk-conn-spinner{width:42px;height:42px;border:4px solid #333;border-top-color:#ff9800;" +
      "border-radius:50%;margin:0 auto 16px;animation:tkConnSpin 1s linear infinite;}" +
      "#tkConnOverlay .tk-conn-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px;}" +
      "#tkConnOverlay button{background:#ff9800;color:#000;border:none;border-radius:5px;" +
      "padding:10px 18px;font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;}" +
      "#tkConnOverlay button.tk-conn-ghost{background:transparent;color:#ddd;border:1px solid #616161;}" +
      "@keyframes tkConnSpin{to{transform:rotate(360deg);}}";
    document.head.appendChild(st);
  }

  function overlay() {
    var o = document.getElementById("tkConnOverlay");
    if (!o) {
      o = document.createElement("div");
      o.id = "tkConnOverlay";
      document.body.appendChild(o);
    }
    return o;
  }

  function showRestart(seconds) {
    restarting = true;
    styles();
    var total = seconds || 5;
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-title">Talkomatic is updating</div>' +
      '<div class="tk-conn-msg">Returning you to the lobby in <b id="tkConnN">' +
      total +
      "</b> seconds…</div>" +
      '<div class="tk-conn-bar"><span id="tkConnBar"></span></div></div>';
    o.style.display = "flex";
    var n = total;
    (function tick() {
      var nEl = document.getElementById("tkConnN");
      var bar = document.getElementById("tkConnBar");
      if (nEl) nEl.textContent = String(Math.max(0, n));
      if (bar) bar.style.width = 100 * (1 - n / total) + "%";
      if (n <= 0) {
        window.location.href = "/";
        return;
      }
      n--;
      setTimeout(tick, 1000);
    })();
  }

  function actionButton(label, ghost, onClick) {
    var b = document.createElement("button");
    b.textContent = label;
    if (ghost) b.className = "tk-conn-ghost";
    b.addEventListener("click", onClick);
    return b;
  }

  function showOutdated() {
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box">' +
      '<div class="tk-conn-title">Talkomatic has been updated</div>' +
      '<div class="tk-conn-msg">This tab is still running the old version and ' +
      "a refresh did not replace it. Hold Shift and press refresh, or clear " +
      "this site's cache.</div>" +
      '<div class="tk-conn-actions"></div></div>';
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Try again", false, function () {
        try {
          sessionStorage.removeItem("tk-build-reload");
        } catch (e) {
        }
        window.location.reload();
      }),
    );
    o.style.display = "flex";
  }

  function showReconnecting() {
    if (restarting) return;
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-spinner"></div>' +
      '<div class="tk-conn-title">Reconnecting…</div>' +
      '<div class="tk-conn-msg">Lost connection to Talkomatic. Trying to reconnect…</div>' +
      '<div class="tk-conn-actions"></div></div>';
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Refresh", false, function () {
        window.location.reload();
      }),
    );
    actions.appendChild(
      actionButton("Return to lobby", true, function () {
        window.location.href = "/";
      }),
    );
    o.style.display = "flex";
  }

  function showUpdating() {
    restarting = true;
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-spinner"></div>' +
      '<div class="tk-conn-title">Talkomatic is updating</div>' +
      '<div class="tk-conn-msg">Reconnecting you to your room. Hold tight, ' +
      "this only takes a moment.</div>" +
      '<div class="tk-conn-actions" style="display:none"></div></div>';
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Rejoin room", false, function () {
        window.location.reload();
      }),
    );
    actions.appendChild(
      actionButton("Return to lobby", true, function () {
        window.location.href = "/";
      }),
    );
    o.style.display = "flex";
    clearTimeout(buttonsTimer);
    buttonsTimer = setTimeout(function () {
      actions.style.display = "";
    }, 5000);
  }

  function hide() {
    if (restarting) return;
    clearTimeout(buttonsTimer);
    var o = document.getElementById("tkConnOverlay");
    if (o) o.style.display = "none";
  }

  function recovered() {
    disarmOverlay();
    clearTimeout(buttonsTimer);
    restarting = false;
    var o = document.getElementById("tkConnOverlay");
    if (o) o.style.display = "none";
  }

  window.TalkomaticConnection = {
    attach: function (socket, opts) {
      if (!socket) return;
      rejoinInPlace = !!(opts && opts.rejoinInPlace);
      socket.on("server build", function (d) {
        var theirs = d && d.id;
        if (!theirs) return;
        var tag = document.querySelector('meta[name="tk-build"]');
        var ours = tag && tag.getAttribute("content");
        if (!ours || ours === theirs) return;
        var tried = null;
        try {
          tried = sessionStorage.getItem("tk-build-reload");
        } catch (e) {
          tried = null;
        }
        if (tried === theirs) return showOutdated();
        try {
          sessionStorage.setItem("tk-build-reload", theirs);
        } catch (e) {
        }
        window.location.reload();
      });
      socket.on("server restarting", function (d) {
        if (rejoinInPlace) showUpdating();
        else showRestart((d && d.seconds) || 5);
      });
      socket.on("disconnect", function (reason) {
        if (restarting || reason === "io client disconnect") return;
        armOverlay(GRACE_DROP);
      });
      socket.on("connect_error", function (err) {
        if (restarting || (err && err.data && err.data.banned)) return;
        armOverlay(everConnected ? GRACE_DROP : GRACE_FIRST);
        // A middleware denial ("Too many connections") is final to socket.io:
        // it stops trying on its own. Keep knocking until a slot frees up,
        // unless something (ban, superseded tab) turned reconnection off.
        if (!socket.active && !retryTimer) {
          retryTimer = setTimeout(function () {
            retryTimer = null;
            if (socket.disconnected && socket.io.opts.reconnection !== false)
              socket.connect();
          }, 4000);
        }
      });
      socket.on("connect", function () {
        everConnected = true;
        disarmOverlay();
        clearTimeout(retryTimer);
        retryTimer = null;
        if (rejoinInPlace) return;
        restarting = false;
        hide();
      });
    },
    recovered: recovered,
  };
})();
