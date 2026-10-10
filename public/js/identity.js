(function () {
  "use strict";
  var LS_KEY = "talkomatic_did";
  var CK_KEY = "tk_did";
  var DB_NAME = "talkomatic";
  var STORE = "kv";
  var DB_KEY = "did";

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function valid(id) {
    return typeof id === "string" && /^[a-f0-9-]{8,64}$/i.test(id);
  }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }
  function writeCookie(name, val) {
    try {
      document.cookie =
        name +
        "=" +
        encodeURIComponent(val) +
        "; max-age=31536000; path=/; SameSite=Lax";
    } catch (e) {}
  }
  function lsGet() {
    try {
      return localStorage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }
  function lsSet(v) {
    try {
      localStorage.setItem(LS_KEY, v);
    } catch (e) {}
  }

  var lsId = lsGet();
  var ckId = readCookie(CK_KEY);
  if (!valid(lsId)) lsId = null;
  if (!valid(ckId)) ckId = null;

  var freshly = false;
  var id = lsId || ckId;
  if (!id) {
    id = uuid();
    freshly = true;
  }
  lsSet(id);
  writeCookie(CK_KEY, id);

  var restored = !lsId && !!ckId;

  var buildTag = document.querySelector('meta[name="tk-build"]');
  window.TalkomaticIdentity = {
    deviceId: id,
    build: (buildTag && buildTag.getAttribute("content")) || null,
    restored: restored,
    activity: null,
    ready: null,
  };

  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          try {
            req.result.createObjectStore(STORE);
          } catch (e) {}
        };
        req.onsuccess = function () {
          res(req.result);
        };
        req.onerror = function () {
          rej(req.error);
        };
      } catch (e) {
        rej(e);
      }
    });
  }
  function idbGet(db) {
    return new Promise(function (res) {
      try {
        var r = db.transaction(STORE, "readonly").objectStore(STORE).get(DB_KEY);
        r.onsuccess = function () {
          res(r.result || null);
        };
        r.onerror = function () {
          res(null);
        };
      } catch (e) {
        res(null);
      }
    });
  }
  function idbPut(db, val) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, DB_KEY);
        tx.oncomplete = function () {
          res(true);
        };
        tx.onerror = function () {
          res(false);
        };
      } catch (e) {
        res(false);
      }
    });
  }

  window.TalkomaticIdentity.ready = (function () {
    if (!("indexedDB" in window)) return Promise.resolve(id);
    return idbOpen()
      .then(function (db) {
        return idbGet(db).then(function (dbId) {
          if (valid(dbId)) {
            if (freshly && dbId !== id) {
              id = dbId;
              lsSet(dbId);
              writeCookie(CK_KEY, dbId);
              window.TalkomaticIdentity.deviceId = dbId;
              window.TalkomaticIdentity.restored = true;
            } else if (!freshly && dbId !== id) {
              return idbPut(db, id);
            }
          } else {
            return idbPut(db, id);
          }
        });
      })
      .catch(function () {})
      .then(function () {
        return window.TalkomaticIdentity.deviceId;
      });
  })();

  var DETAILS_VERSION = 1;
  var detailsPromise = null;

  function digest(text) {
    var a = 0x811c9dc5;
    var b = 0x01000193;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619) >>> 0;
      b = Math.imul(b ^ c, 2246822519) >>> 0;
    }
    return ("0000000" + a.toString(16)).slice(-8) + ("0000000" + b.toString(16)).slice(-8);
  }

  function canvasDetails() {
    var out = { hash: null, noisy: false };
    try {
      var test = document.createElement("canvas");
      test.width = 8;
      test.height = 8;
      var tc = test.getContext("2d");
      tc.fillStyle = "rgb(123,45,67)";
      tc.fillRect(0, 0, 8, 8);
      var px = tc.getImageData(0, 0, 8, 8).data;
      for (var i = 0; i < px.length; i += 4)
        if (px[i] !== 123 || px[i + 1] !== 45 || px[i + 2] !== 67 || px[i + 3] !== 255) out.noisy = true;

      var draw = function () {
        var c = document.createElement("canvas");
        c.width = 220;
        c.height = 60;
        var x = c.getContext("2d");
        x.textBaseline = "alphabetic";
        x.fillStyle = "#f60";
        x.fillRect(100, 1, 62, 20);
        x.fillStyle = "#069";
        x.font = "15px Arial, sans-serif";
        x.fillText("Talkomatic <canvas> 1.0 😃", 2, 15);
        x.fillStyle = "rgba(102, 204, 0, 0.7)";
        x.font = "17px Times, serif";
        x.fillText("Talkomatic <canvas> 1.0", 4, 40);
        x.globalCompositeOperation = "multiply";
        x.fillStyle = "rgb(255,0,255)";
        x.beginPath();
        x.arc(40, 40, 18, 0, Math.PI * 2, true);
        x.fill();
        x.fillStyle = "rgb(0,255,255)";
        x.beginPath();
        x.arc(60, 40, 18, 0, Math.PI * 2, true);
        x.fill();
        return c.toDataURL();
      };
      var one = draw();
      var two = draw();
      if (one !== two) out.noisy = true;
      out.hash = digest(one);
    } catch (e) {}
    return out;
  }

  function graphicsDetails() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return null;
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      var vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      try {
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (e) {}
      return String(vendor || "").slice(0, 80) + "|" + String(renderer || "").slice(0, 160);
    } catch (e) {
      return null;
    }
  }

  function render(build, length) {
    return new Promise(function (res) {
      var done = false;
      var finish = function (v) {
        if (done) return;
        done = true;
        res(v);
      };
      setTimeout(function () {
        finish(null);
      }, 1500);
      try {
        var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return finish(null);
        var ctx = new Ctx(1, length, 44100);
        build(ctx);
        ctx.oncomplete = function (e) {
          try {
            finish(e.renderedBuffer.getChannelData(0));
          } catch (err) {
            finish(null);
          }
        };
        var p = ctx.startRendering();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {
        finish(null);
      }
    });
  }

  function audioDetails() {
    var out = { hash: null, noisy: false };
    return render(function (ctx) {
      var osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = 10000;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50;
      comp.knee.value = 40;
      comp.ratio.value = 12;
      comp.attack.value = 0;
      comp.release.value = 0.25;
      osc.connect(comp);
      comp.connect(ctx.destination);
      osc.start(0);
    }, 5000)
      .then(function (data) {
        if (!data) return null;
        var sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
        out.hash = digest(String(sum));
        if (!window.ConstantSourceNode) return null;
        return render(function (ctx) {
          var src = ctx.createConstantSource();
          src.offset.value = 1;
          src.connect(ctx.destination);
          src.start(0);
        }, 256);
      })
      .then(function (flat) {
        if (flat) for (var i = 0; i < flat.length; i++) if (flat[i] !== 1) out.noisy = true;
        return out;
      })
      .catch(function () {
        return out;
      });
  }

  function modelDetails() {
    try {
      var uad = navigator.userAgentData;
      if (!uad || !uad.getHighEntropyValues) return Promise.resolve(null);
      return new Promise(function (res) {
        setTimeout(function () {
          res(null);
        }, 1000);
        uad
          .getHighEntropyValues(["model", "platformVersion"])
          .then(function (v) {
            res(String(v.model || "").slice(0, 40) + "|" + String(v.platformVersion || "").slice(0, 20));
          })
          .catch(function () {
            res(null);
          });
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function details() {
    if (detailsPromise) return detailsPromise;
    var d = { v: DETAILS_VERSION };
    try {
      d.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      d.tz = null;
    }
    try {
      d.offset = new Date().getTimezoneOffset();
      d.langs = (navigator.languages || [navigator.language || ""]).slice(0, 6).join(",");
      d.screen = [screen.width, screen.height].sort().join("x");
      d.depth = screen.colorDepth || null;
      d.ratio = window.devicePixelRatio || null;
      d.cores = navigator.hardwareConcurrency || null;
      d.memory = navigator.deviceMemory || null;
      d.touch = navigator.maxTouchPoints || 0;
      d.platform = String(navigator.platform || "").slice(0, 30);
      d.shield = !!navigator.brave;
      d.driven = navigator.webdriver === true;
    } catch (e) {}
    var cv = canvasDetails();
    d.canvas = cv.hash;
    d.canvasNoisy = cv.noisy;
    d.graphics = graphicsDetails();
    detailsPromise = Promise.all([audioDetails(), modelDetails()])
      .then(function (r) {
        d.audio = r[0] ? r[0].hash : null;
        d.audioNoisy = r[0] ? r[0].noisy : false;
        d.model = r[1];
        return d;
      })
      .catch(function () {
        return d;
      });
    return detailsPromise;
  }

  window.TalkomaticIdentity.report = function (socket) {
    if (!socket || socket.__detailsBound) return;
    socket.__detailsBound = true;
    var send = function () {
      details().then(function (d) {
        try {
          socket.emit("client details", d);
        } catch (e) {}
      });
    };
    socket.on("connect", send);
    if (socket.connected) send();
  };
})();
