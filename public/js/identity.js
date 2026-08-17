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

  window.TalkomaticIdentity = {
    deviceId: id,
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
})();
