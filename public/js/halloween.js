(function () {
  "use strict";

  var PREF_KEY = "tkSeasonPref";
  var MUSIC_KEY = "tkSeasonMusic";
  var IMG = "images/halloween/";
  var PAGE = /room\.html/i.test(location.pathname) ? "room" : "lobby";
  var root = document.documentElement;
  var metaTag = document.querySelector('meta[name="tk-season"]');
  var theme = metaTag ? metaTag.getAttribute("content") || "" : "";
  var reduce = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  function getPref() {
    try {
      var v = localStorage.getItem(PREF_KEY);
      if (v === "full" || v === "still" || v === "off") return v;
    } catch (e) {}
    return "full";
  }

  function setPref(v) {
    try {
      localStorage.setItem(PREF_KEY, v);
    } catch (e) {}
    sync();
  }

  function customBackdrop() {
    return (
      !!root.style.getPropertyValue("--tk-bg") ||
      root.classList.contains("tk-img-bg")
    );
  }

  function musicOn() {
    try {
      return localStorage.getItem(MUSIC_KEY) !== "off";
    } catch (e) {
      return true;
    }
  }

  function setMusic(on) {
    try {
      localStorage.setItem(MUSIC_KEY, on ? "on" : "off");
    } catch (e) {}
    syncMusic();
    paintMusicButton();
  }

  var music = null;
  var musicArmed = false;
  var musicFade = 0;
  var MUSIC_VOL = 0.22;
  var GESTURES = ["pointerdown", "keydown", "touchstart"];

  function armMusic() {
    if (musicArmed) return;
    musicArmed = true;
    var go = function () {
      musicArmed = false;
      GESTURES.forEach(function (t) {
        window.removeEventListener(t, go, true);
      });
      syncMusic();
    };
    GESTURES.forEach(function (t) {
      window.addEventListener(t, go, true);
    });
  }

  function fadeMusic(to) {
    clearInterval(musicFade);
    musicFade = setInterval(function () {
      if (!music) return clearInterval(musicFade);
      var v = music.volume + (to > music.volume ? 0.015 : -0.03);
      if ((to > music.volume && v >= to) || (to <= music.volume && v <= to)) {
        v = to;
        clearInterval(musicFade);
        if (to === 0) music.pause();
      }
      music.volume = Math.max(0, Math.min(1, v));
    }, 60);
  }

  function syncMusic() {
    if (PAGE !== "lobby") return;
    var want = isActive() && musicOn() && !document.hidden;
    if (!want) {
      if (music && !music.paused) fadeMusic(0);
      return;
    }
    if (!music) {
      music = new Audio("audio/halloween-waltz.mp3");
      music.loop = true;
      music.preload = "auto";
      music.volume = 0;
    }
    if (!music.paused) return fadeMusic(MUSIC_VOL);
    var p = music.play();
    if (p && p.then)
      p.then(function () {
        fadeMusic(MUSIC_VOL);
      }).catch(armMusic);
    else fadeMusic(MUSIC_VOL);
  }

  var HOWL = "audio/wolf-howl.mp3";

  function syncSounds() {
    if (PAGE !== "room") return;
    var on = isActive();
    ["joinSound", "leaveSound"].forEach(function (id) {
      var a = document.getElementById(id);
      if (!a) return;
      if (!a.hasAttribute("data-hw-src"))
        a.setAttribute("data-hw-src", a.getAttribute("src") || "");
      var want = on ? HOWL : a.getAttribute("data-hw-src");
      if (a.getAttribute("src") !== want) {
        a.setAttribute("src", want);
        a.load();
      }
      a.volume = on ? 0.55 : 1;
    });
  }

  function isActive() {
    return theme === "halloween" && getPref() !== "off";
  }

  function customFonts() {
    return (
      !!root.style.getPropertyValue("--tk-font-main") ||
      !!root.style.getPropertyValue("--tk-font-heading")
    );
  }

  var fontLinked = false;

  function linkFont() {
    if (fontLinked) return;
    fontLinked = true;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Creepster&display=swap";
    (document.head || root).appendChild(l);
  }

  function paintClasses() {
    var on = isActive();
    var font = on && !customFonts();
    if (font) linkFont();
    root.classList.toggle("tk-hw", on);
    root.classList.toggle("tk-hw-lobby", on && PAGE === "lobby");
    root.classList.toggle("tk-hw-font", font);
    root.classList.toggle("tk-hw-scene", on && PAGE === "lobby" && !customBackdrop());
  }

  paintClasses();

  if (window.ThemeEngine)
    ["saveState", "preview", "revert"].forEach(function (k) {
      var f = ThemeEngine[k];
      if (typeof f !== "function") return;
      ThemeEngine[k] = function () {
        var r = f.apply(this, arguments);
        paintClasses();
        return r;
      };
    });

  var SPRITES = [
    "bat0", "bat1", "bat2", "bat3", "ghost", "ghost2", "pumpkin", "jack",
    "cauldron", "skullbones", "spider", "cornerweb", "candle0", "candle1",
    "candle2", "crow0", "crow1", "crow2", "crow3", "lantern0", "lantern1",
    "lantern2", "stone1", "stone3", "catfence", "batcandle",
  ];
  var img = {};
  var masks = {};

  function loadSprites(done) {
    var left = SPRITES.length;
    SPRITES.forEach(function (n) {
      var im = new Image();
      im.onload = im.onerror = function () {
        if (--left === 0) done();
      };
      im.src = IMG + n + ".png";
      img[n] = im;
    });
  }

  function ready(n) {
    var im = img[n];
    return im && im.complete && im.naturalWidth > 0;
  }

  function glowMask(n, test) {
    if (masks[n] !== undefined) return masks[n];
    masks[n] = null;
    if (!ready(n)) return null;
    try {
      var im = img[n];
      var c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      var x = c.getContext("2d");
      x.drawImage(im, 0, 0);
      var d = x.getImageData(0, 0, c.width, c.height);
      for (var i = 0; i < d.data.length; i += 4) {
        if (!test(d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3])) {
          d.data[i + 3] = 0;
        } else {
          d.data[i] = 255;
          d.data[i + 1] = 236;
          d.data[i + 2] = 150;
        }
      }
      x.putImageData(d, 0, 0);
      masks[n] = c;
    } catch (e) {}
    return masks[n];
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  var engine = null;

  function Engine() {
    var self = this;
    this.mode = "full";
    this.layer = document.createElement("div");
    this.layer.className = "hw-layer" + (PAGE === "lobby" ? " hw-back" : "");
    this.layer.setAttribute("aria-hidden", "true");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "hw-canvas";
    this.layer.appendChild(this.canvas);
    var fog = document.createElement("div");
    fog.className = "hw-fog";
    fog.innerHTML = "<span></span><span></span>";
    this.layer.appendChild(fog);
    document.body.appendChild(this.layer);
    if (PAGE === "lobby" && !document.getElementById("hwSky")) {
      var sky = document.createElement("div");
      sky.id = "hwSky";
      sky.setAttribute("aria-hidden", "true");
      sky.innerHTML =
        '<div class="hw-stars hw-twinkle"></div><span class="hw-shoot"></span>';
      document.body.insertBefore(sky, document.body.firstChild);
    }
    this.ctx = this.canvas.getContext("2d");
    this.bats = [];
    this.ghosts = [];
    this.crawlers = [];
    this.hangers = [];
    this.bubbles = [];
    this.crows = [];
    this.timers =
      PAGE === "room"
        ? { bat: 5, ghost: 14, crawl: 9, hang: 20, crow: 30 }
        : { bat: 1.5, ghost: 4, crawl: 2, hang: 6, crow: 5 };
    this.mouse = { x: -9999, y: -9999, at: 0 };
    this.last = 0;
    this.acc = 0;
    this.t = 0;
    this.raf = 0;
    this.spiderCanvas = document.createElement("canvas");
    this.spiderCanvas.width = 34;
    this.spiderCanvas.height = 28;
    this.sctx = this.spiderCanvas.getContext("2d");
    this.onMove = function (e) {
      self.mouse.x = e.clientX;
      self.mouse.y = e.clientY;
      self.mouse.at = performance.now();
    };
    this.onResize = function () {
      self.resize();
    };
    this.onVis = function () {
      if (!document.hidden) self.kick();
    };
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVis);
    this.stageTimer = setInterval(function () {
      self.measure();
    }, 1000);
    this.resize();
  }

  Engine.prototype.destroy = function () {
    cancelAnimationFrame(this.raf);
    clearInterval(this.stageTimer);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVis);
    this.layer.remove();
    root.classList.remove("tk-hw-still");
    var sky = document.getElementById("hwSky");
    if (sky) sky.remove();
  };

  Engine.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + "px";
    this.canvas.style.height = this.h + "px";
    this.measure();
  };

  Engine.prototype.measure = function () {
    var r = { left: 0, top: 0, right: this.w, bottom: this.h };
    var el =
      PAGE === "lobby"
        ? document.querySelector(".right-panel")
        : document.querySelector(".chat-container");
    if (el) {
      var b = el.getBoundingClientRect();
      if (b.width > 120 && b.height > 120)
        r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
    if (PAGE === "room") {
      var inv = document.getElementById("inviteSection");
      if (inv) {
        var ib = inv.getBoundingClientRect();
        if (ib.height > 0 && ib.top > r.top + 100 && ib.top < r.bottom)
          r.bottom = ib.top;
      }
    }
    var lp = document.getElementById("leftPanel");
    if (PAGE === "lobby" && lp) {
      var lb = lp.getBoundingClientRect();
      if (lb.right > r.left && lb.right < r.right - 200 && lb.width > 0)
        r.left = Math.max(r.left, lb.right);
    }
    r.width = r.right - r.left;
    r.height = r.bottom - r.top;
    this.fly =
      PAGE === "lobby"
        ? { left: 0, top: 0, right: this.w, bottom: this.h, width: this.w, height: this.h }
        : r;
    r.bar = 0;
    if (PAGE === "room") {
      var ui = document.querySelector(".chat-row .user-info");
      if (ui) r.bar = Math.round(ui.getBoundingClientRect().height);
    }
    var changed =
      !this.stage ||
      Math.abs(this.stage.left - r.left) > 1 ||
      Math.abs(this.stage.width - r.width) > 1 ||
      Math.abs(this.stage.height - r.height) > 1 ||
      Math.abs(this.stage.top - r.top) > 1 ||
      this.stage.bar !== r.bar;
    this.stage = r;
    this.small = r.width < 640;
    if (changed) this.kick();
  };

  Engine.prototype.setMode = function (mode) {
    this.mode = mode;
    if (mode !== "full") {
      this.bats.length = 0;
      this.ghosts.length = 0;
      this.crawlers.length = 0;
      this.hangers.length = 0;
      this.bubbles.length = 0;
      this.crows.length = 0;
    }
    this.layer.classList.toggle("hw-still", mode !== "full");
    root.classList.toggle("tk-hw-still", mode !== "full");
    this.kick();
  };

  Engine.prototype.animated = function () {
    return this.mode === "full";
  };

  Engine.prototype.frozen = function () {
    return this.mode !== "full" && reduce.matches;
  };

  Engine.prototype.kick = function () {
    var self = this;
    cancelAnimationFrame(this.raf);
    this.last = 0;
    this.raf = requestAnimationFrame(function (ts) {
      self.frame(ts);
    });
  };

  Engine.prototype.frame = function (ts) {
    var self = this;
    if (document.hidden) return;
    var dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0;
    this.last = ts;
    this.t += dt;
    this.acc += dt;
    var moving = this.animated();
    var still = this.frozen();
    if (!still) {
      this.raf = requestAnimationFrame(function (n) {
        self.frame(n);
      });
    }
    if (still || this.acc >= 1 / 32 || dt === 0) {
      var step = this.acc;
      this.acc = 0;
      if (moving) this.update(step);
      this.draw();
    }
  };

  Engine.prototype.density = function () {
    var room = PAGE === "room";
    var base = room
      ? { bat: [22, 45], ghost: [35, 70], crawl: [25, 50], hang: [40, 80], crow: [35, 70] }
      : { bat: [6, 14], ghost: [9, 18], crawl: [7, 16], hang: [14, 26], crow: [9, 18] };
    if (this.small) {
      base.bat = [base.bat[0] * 1.6, base.bat[1] * 1.6];
      base.ghost = [base.ghost[0] * 1.6, base.ghost[1] * 1.6];
    }
    return base;
  };

  Engine.prototype.scale = function (kind) {
    var room = PAGE === "room";
    if (kind === "decor") return room || this.small ? 2 : 3;
    if (kind === "bat") return room || this.small ? pick([1, 2]) : pick([2, 2, 3]);
    if (kind === "ghost") return room || this.small ? 2 : pick([2, 3]);
    return 2;
  };

  Engine.prototype.update = function (dt) {
    var den = this.density();
    var tm = this.timers;
    var room = PAGE === "room";
    tm.bat -= dt;
    tm.ghost -= dt;
    tm.crawl -= dt;
    tm.hang -= dt;
    tm.crow -= dt;
    if (tm.crow <= 0) {
      tm.crow = rand(den.crow[0], den.crow[1]);
      if (this.crows.length < 6) this.spawnCrows(room ? pick([1, 1, 2]) : pick([1, 2, 3]));
    }
    if (tm.bat <= 0) {
      tm.bat = rand(den.bat[0], den.bat[1]);
      if (this.bats.length < 8) this.spawnBats(room ? pick([1, 1, 2]) : pick([1, 2, 2, 3, 4]));
    }
    if (tm.ghost <= 0) {
      tm.ghost = rand(den.ghost[0], den.ghost[1]);
      if (this.ghosts.length < (room ? 1 : 2)) this.spawnGhost();
    }
    if (tm.crawl <= 0) {
      tm.crawl = rand(den.crawl[0], den.crawl[1]);
      if (this.crawlers.length < (room ? 1 : 2)) this.spawnCrawler();
    }
    if (tm.hang <= 0) {
      tm.hang = rand(den.hang[0], den.hang[1]);
      if (this.hangers.length < 1) this.spawnHanger();
    }
    var m = this.mouse;
    var live = performance.now() - m.at < 4000;
    this.updateBats(dt, m, live);
    this.updateGhosts(dt, m, live);
    this.updateCrawlers(dt, m, live);
    this.updateHangers(dt);
    this.updateBubbles(dt);
    this.updateCrows(dt);
  };

  Engine.prototype.spawnCrows = function (n) {
    var s = this.fly;
    var dir = Math.random() < 0.5 ? 1 : -1;
    var room = PAGE === "room";
    var baseY = s.top + rand(0.06, room ? 0.5 : 0.36) * s.height;
    var speed = rand(130, 185);
    for (var i = 0; i < n; i++) {
      var sc = room || this.small ? 1 : pick([1, 2, 2]);
      var gap = i * rand(55, 110);
      this.crows.push({
        x: dir > 0 ? s.left - 62 * sc - gap : s.right + 4 + gap,
        y: baseY + rand(-24, 24) + i * rand(6, 20),
        dir: dir,
        vx: dir * speed * rand(0.9, 1.1),
        sc: sc,
        ph: rand(0, 6),
        flap: rand(0, 8),
        rate: rand(8, 10),
        glide: 0,
        alpha: sc === 1 ? 0.85 : 1,
      });
    }
  };

  Engine.prototype.updateCrows = function (dt) {
    var s = this.fly;
    for (var i = this.crows.length - 1; i >= 0; i--) {
      var c = this.crows[i];
      c.ph += dt;
      if (c.glide > 0) c.glide -= dt;
      else {
        c.flap += dt * c.rate;
        if (Math.random() < dt * 0.3) c.glide = rand(0.5, 1.2);
      }
      c.x += c.vx * dt;
      c.y += Math.sin(c.ph * 1.3) * 12 * dt + (c.glide > 0 ? 8 * dt : 0);
      if (c.x < s.left - 400 || c.x > s.right + 400) this.crows.splice(i, 1);
    }
  };

  var CROW_FRAMES = [0, 1, 2, 1, 3, 1, 2, 1];

  Engine.prototype.drawCrows = function () {
    for (var i = 0; i < this.crows.length; i++) {
      var c = this.crows[i];
      var fr = c.glide > 0 ? 1 : CROW_FRAMES[Math.floor(c.flap) % CROW_FRAMES.length];
      this.sprite("crow" + fr, c.x, c.y, c.sc, c.dir < 0, c.alpha);
    }
  };

  Engine.prototype.drawLantern = function () {
    var s = this.stage;
    if (PAGE === "room" || s.width < 560) return;
    var sc = this.small ? 1 : 2;
    var ctx = this.ctx;
    var ax = s.left + Math.round(s.width * 0.5);
    var top = s.top;
    var chain = 18;
    var sway = this.frozen() ? 0 : Math.sin(this.t * 1.1) * 3 * sc;
    var lx = ax + sway - 13 * sc;
    var ly = top + chain;
    ctx.fillStyle = "#3a3a40";
    var steps = Math.max(1, Math.ceil(chain / sc));
    for (var k = 0; k <= steps; k++) {
      var u = k / steps;
      ctx.fillRect(Math.round(ax + sway * u - sc / 2), Math.round(top + chain * u - sc), sc, sc);
    }
    var f = this.flicker(5.2);
    this.glow(lx + 12.5 * sc, ly + 33 * sc, 30 * sc, "255,150,50", 0.28 * f);
    var fr = this.frozen() ? 0 : Math.floor(this.t * 7) % 3;
    this.sprite("lantern" + fr, lx, ly, sc);
  };

  Engine.prototype.drawGround = function () {
    var s = this.stage;
    var ground = s.bottom - 8;
    if (PAGE === "room") {
      if (s.width < 520) return;
      var bx = s.left + 8;
      var by = s.bottom - 57 - 4;
      this.glow(bx + 34, by + 8, 30, "255,170,70", 0.3 * this.flicker(6.4));
      this.sprite("batcandle", bx, by, 1);
      return;
    }
    if (s.width < 760) return;
    var sc = this.small ? 1 : 2;
    if (s.width >= 1000) {
      this.sprite("stone3", s.left + 34 * 3 + 64 + 28, ground - 48 * sc, sc);
      this.sprite("stone1", s.left + s.width * 0.4, ground - 45 * sc, sc);
    }
    var cx = s.left + s.width * (s.width >= 1000 ? 0.55 : 0.5);
    this.sprite("catfence", cx, ground - 58 * sc, sc);
  };

  Engine.prototype.spawnBats = function (n) {
    var s = this.fly;
    var dir = Math.random() < 0.5 ? 1 : -1;
    var baseY = s.top + rand(0.08, PAGE === "room" ? 0.6 : 0.5) * s.height;
    var speed = rand(110, 190);
    for (var i = 0; i < n; i++) {
      var sc = this.scale("bat");
      this.bats.push({
        x: dir > 0 ? s.left - 60 - i * rand(40, 90) : s.right + 60 + i * rand(40, 90),
        y: baseY + rand(-40, 40),
        vx: dir * speed * rand(0.85, 1.15),
        vy: 0,
        amp: rand(10, 28),
        freq: rand(1.2, 2.4),
        ph: rand(0, 6.28),
        flap: rand(0, 6),
        rate: rand(11, 15),
        sc: sc,
        alpha: sc === 1 ? 0.75 : 1,
        scared: 0,
      });
    }
  };

  Engine.prototype.updateBats = function (dt, m, live) {
    var s = this.fly;
    for (var i = this.bats.length - 1; i >= 0; i--) {
      var b = this.bats[i];
      b.ph += dt * b.freq;
      b.flap += dt * b.rate * (b.scared > 0 ? 1.8 : 1);
      if (live) {
        var dx = b.x - m.x;
        var dy = b.y - m.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < 130 && d > 0) {
          b.scared = 1.2;
          b.vy += (dy / d) * 900 * dt;
          b.vx += (dx / d) * 300 * dt;
        }
      }
      if (b.scared > 0) b.scared -= dt;
      b.vy *= 1 - Math.min(1, dt * 1.8);
      var sp = Math.abs(b.vx);
      if (sp > 320) b.vx *= 320 / sp;
      if (sp < 80) b.vx = (b.vx < 0 ? -1 : 1) * 80;
      b.x += b.vx * dt;
      b.y += (b.vy + Math.cos(b.ph) * b.amp * b.freq) * dt;
      if (b.x < s.left - 300 || b.x > s.right + 300 || b.y < -200 || b.y > this.h + 200)
        this.bats.splice(i, 1);
    }
  };

  Engine.prototype.spawnGhost = function () {
    var s = this.fly;
    var dir = Math.random() < 0.5 ? 1 : -1;
    var sc = this.scale("ghost");
    this.ghosts.push({
      x: dir > 0 ? s.left - 40 * sc : s.right + 40 * sc,
      y: s.top + rand(0.15, 0.65) * s.height,
      vx: dir * rand(28, 48),
      ph: rand(0, 6.28),
      sc: sc,
      life: 0,
      shy: 0,
      max: PAGE === "room" ? 0.55 : 0.85,
    });
  };

  Engine.prototype.updateGhosts = function (dt, m, live) {
    var s = this.fly;
    for (var i = this.ghosts.length - 1; i >= 0; i--) {
      var g = this.ghosts[i];
      g.life += dt;
      g.ph += dt * 1.9;
      var push = 0;
      if (live) {
        var cx = g.x;
        var cy = g.y;
        var dx = cx - m.x;
        var dy = cy - m.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < 110) {
          g.shy = Math.min(1, g.shy + dt * 4);
          push = dx >= 0 ? 1 : -1;
          g.y += (dy >= 0 ? 1 : -1) * 40 * dt;
        }
      }
      if (!push) g.shy = Math.max(0, g.shy - dt * 0.8);
      var v = g.vx + push * 160 * g.shy;
      g.x += v * dt;
      if (g.x < s.left - 200 || g.x > s.right + 200) this.ghosts.splice(i, 1);
    }
  };

  Engine.prototype.spawnCrawler = function () {
    var s = this.fly;
    var side = Math.floor(Math.random() * 4);
    var x, y, ang;
    if (side === 0) {
      x = s.left - 40;
      y = s.top + rand(0.2, 0.9) * s.height;
      ang = rand(-0.6, 0.6);
    } else if (side === 1) {
      x = s.right + 40;
      y = s.top + rand(0.2, 0.9) * s.height;
      ang = Math.PI + rand(-0.6, 0.6);
    } else if (side === 2) {
      x = s.left + rand(0.15, 0.85) * s.width;
      y = s.bottom + 40;
      ang = -Math.PI / 2 + rand(-0.6, 0.6);
    } else {
      x = s.left + rand(0.15, 0.85) * s.width;
      y = s.top - 40;
      ang = Math.PI / 2 + rand(-0.6, 0.6);
    }
    this.crawlers.push({
      x: x,
      y: y,
      ang: ang,
      turn: 0,
      speed: rand(30, 52) * (PAGE === "room" ? 0.8 : 1),
      state: "walk",
      wait: rand(2, 5),
      life: 0,
      stay: rand(14, 26),
      gait: 0,
      sc: 2,
      flee: 0,
    });
  };

  Engine.prototype.updateCrawlers = function (dt, m, live) {
    var s = this.fly;
    for (var i = this.crawlers.length - 1; i >= 0; i--) {
      var c = this.crawlers[i];
      c.life += dt;
      if (live) {
        var dx = c.x - m.x;
        var dy = c.y - m.y;
        if (dx * dx + dy * dy < 100 * 100) {
          c.ang = Math.atan2(dy, dx);
          c.flee = 1.2;
          c.state = "walk";
        }
      }
      var leaving = c.life > c.stay;
      var inside =
        c.x > s.left + 30 && c.x < s.right - 30 && c.y > s.top + 30 && c.y < s.bottom - 30;
      if (c.flee <= 0) {
        if (leaving) {
          var ex = c.x - s.left < s.right - c.x ? -1 : 1;
          var want = ex < 0 ? Math.PI : 0;
          var diff = Math.atan2(Math.sin(want - c.ang), Math.cos(want - c.ang));
          c.ang += Math.max(-1.5 * dt, Math.min(1.5 * dt, diff));
        } else {
          c.turn += rand(-3, 3) * dt;
          c.turn *= 1 - Math.min(1, dt * 1.5);
          c.ang += c.turn * dt;
          if (inside === false && c.life > 3) {
            var cx = (s.left + s.right) / 2 - c.x;
            var cy = (s.top + s.bottom) / 2 - c.y;
            var to = Math.atan2(cy, cx);
            var d2 = Math.atan2(Math.sin(to - c.ang), Math.cos(to - c.ang));
            c.ang += Math.max(-2 * dt, Math.min(2 * dt, d2));
          }
        }
      }
      var sp = c.speed * (c.flee > 0 ? 4 : 1);
      if (c.flee > 0) c.flee -= dt;
      c.wait -= dt;
      if (c.state === "walk") {
        c.x += Math.cos(c.ang) * sp * dt;
        c.y += Math.sin(c.ang) * sp * dt;
        c.gait += dt * sp * 0.22;
        if (c.wait <= 0 && c.flee <= 0) {
          c.state = "pause";
          c.wait = rand(0.6, 2.2);
        }
      } else if (c.wait <= 0) {
        c.state = "walk";
        c.wait = rand(2, 5);
      }
      if (
        c.life > 4 &&
        (c.x < s.left - 80 || c.x > s.right + 80 || c.y < s.top - 80 || c.y > s.bottom + 80)
      )
        this.crawlers.splice(i, 1);
    }
  };

  Engine.prototype.webSpot = function () {
    var s = this.stage;
    var sc = this.scale("decor") - 1;
    return { x: s.right - 34 * sc, y: s.top + 30 * sc };
  };

  Engine.prototype.spawnHanger = function () {
    var s = this.stage;
    var x;
    var top = s.top + (s.bar || 0);
    if (PAGE === "lobby" && Math.random() < 0.6) {
      var w = this.webSpot();
      x = w.x;
      top = w.y;
    } else {
      x = s.left + rand(0.2, 0.8) * s.width;
    }
    this.hangers.push({
      x: x,
      top: top,
      y: top - 70,
      target: top + rand(0.18, PAGE === "room" ? 0.35 : 0.5) * s.height,
      state: "down",
      wait: 0,
      ph: rand(0, 6),
    });
  };

  Engine.prototype.updateHangers = function (dt) {
    for (var i = this.hangers.length - 1; i >= 0; i--) {
      var h = this.hangers[i];
      h.ph += dt;
      if (h.state === "down") {
        h.y += Math.max(12, (h.target - h.y) * 1.2) * dt;
        if (h.y >= h.target - 1) {
          h.state = "wait";
          h.wait = rand(4, 9);
        }
      } else if (h.state === "wait") {
        h.wait -= dt;
        h.y = h.target + Math.sin(h.ph * 1.3) * 3;
        if (h.wait <= 0) h.state = "up";
      } else {
        h.y -= 60 * dt;
        if (h.y < h.top - 80) this.hangers.splice(i, 1);
      }
    }
  };

  Engine.prototype.updateBubbles = function (dt) {
    var c = this.cauldronAt;
    if (c && Math.random() < dt * 3) {
      this.bubbles.push({
        x: c.x + rand(8, 20) * c.sc,
        y: c.y + 8 * c.sc,
        vy: rand(14, 26),
        ph: rand(0, 6),
        life: 0,
        max: rand(1.4, 2.6),
        r: Math.random() < 0.3 ? 2 : 1,
        sc: c.sc,
      });
    }
    for (var i = this.bubbles.length - 1; i >= 0; i--) {
      var b = this.bubbles[i];
      b.life += dt;
      b.ph += dt * 4;
      b.y -= b.vy * dt;
      b.x += Math.sin(b.ph) * 6 * dt;
      if (b.life > b.max + 0.25) this.bubbles.splice(i, 1);
    }
  };

  Engine.prototype.sprite = function (n, x, y, sc, flip, alpha, flipY) {
    if (!ready(n)) return;
    var im = img[n];
    var ctx = this.ctx;
    var w = im.naturalWidth * sc;
    var h = im.naturalHeight * sc;
    x = Math.round(x);
    y = Math.round(y);
    if (alpha !== undefined && alpha < 1) ctx.globalAlpha = alpha;
    if (flip || flipY) {
      ctx.save();
      ctx.translate(flip ? x + w : x, flipY ? y + h : y);
      ctx.scale(flip ? -1 : 1, flipY ? -1 : 1);
      ctx.drawImage(im, 0, 0, w, h);
      ctx.restore();
    } else ctx.drawImage(im, x, y, w, h);
    ctx.globalAlpha = 1;
  };

  Engine.prototype.glow = function (x, y, r, rgb, a) {
    var ctx = this.ctx;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(" + rgb + "," + a + ")");
    g.addColorStop(0.45, "rgba(" + rgb + "," + a * 0.35 + ")");
    g.addColorStop(1, "rgba(" + rgb + ",0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  Engine.prototype.flicker = function (seed) {
    if (this.frozen()) return 0.8;
    var t = this.t + seed;
    return (
      0.72 +
      0.13 * Math.sin(t * 7.1) +
      0.09 * Math.sin(t * 13.7 + 1.3) +
      0.06 * Math.sin(t * 23.3 + 0.4)
    );
  };

  Engine.prototype.drawWebs = function () {
    var s = this.stage;
    var room = PAGE === "room";
    var sc = room && !this.small ? 2 : this.scale("decor") - 1;
    var a = room ? 0.5 : 0.85;
    this.sprite("cornerweb", s.right - 60 * sc, s.top + (room ? s.bar + 1 : 0), sc, true, room ? 0.4 : a);
    if (room && s.width < 520)
      this.sprite("cornerweb", s.left, s.bottom - 60 * sc, sc, false, a, true);
  };

  Engine.prototype.drawCluster = function () {
    var s = this.stage;
    var sc = this.scale("decor");
    var ctx = this.ctx;
    var room = PAGE === "room";
    var ground = s.bottom - (room ? 6 : 10);
    var right = s.right - (room ? 14 : 20);
    var p2 = Math.max(1, sc - 1);
    var wide = !room && !this.small;
    var jx = right - 34 * sc - (wide ? 12 * p2 : 0);
    var jy = ground - 30 * sc;
    var f = this.flicker(0);
    var showSecond = !room || s.width > 760;
    var px = jx - 28 * p2;
    var py = ground - 30 * p2;
    var c1x = showSecond ? px - 9 * sc - 2 : jx - 9 * sc - 2;
    var c1y = ground - 22 * sc;
    this.glow(jx + 17 * sc, jy + 18 * sc, 46 * sc, "255,140,30", 0.26 * f);
    this.glow(c1x + 4.5 * sc, c1y + 5 * sc, 18 * sc, "255,190,80", 0.3 * this.flicker(2.1));
    var cf = this.frozen() ? 0 : Math.floor(this.t * 6 + 0.3) % 3;
    this.sprite("candle" + cf, c1x, c1y, sc);
    if (showSecond) this.sprite("pumpkin", px, py, p2);
    this.sprite("jack", jx, jy, sc);
    var mask = glowMask("jack", function (r, g, b, a) {
      return a > 0 && r > 200 && g > 150 && b < 140;
    });
    if (mask) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.max(0, (f - 0.55) * 1.6);
      ctx.drawImage(mask, Math.round(jx), Math.round(jy), 34 * sc, 30 * sc);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    if (wide) {
      var c2x = jx + 34 * sc + 2;
      var c2y = ground - 22 * p2;
      this.glow(c2x + 4.5 * p2, c2y + 5 * p2, 14 * p2, "255,190,80", 0.28 * this.flicker(4.7));
      this.sprite("candle" + ((cf + 1) % 3), c2x, c2y, p2);
    }
  };

  Engine.prototype.drawLeftCluster = function () {
    var s = this.stage;
    if (PAGE === "room" || s.width < 760) {
      this.cauldronAt = null;
      return;
    }
    var sc = this.scale("decor");
    var ground = s.bottom - 10;
    var cx = s.left + 30;
    var cy = ground - 37 * sc;
    this.cauldronAt = { x: cx, y: cy, sc: sc };
    var f = this.flicker(1.7);
    this.glow(cx + 14 * sc, cy + 8 * sc, 30 * sc, "120,255,80", 0.16 * f);
    this.glow(cx + 14 * sc, cy + 34 * sc, 16 * sc, "255,110,20", 0.3 * this.flicker(3.3));
    this.sprite("cauldron", cx, cy, sc);
    this.sprite("skullbones", cx + 30 * sc, ground - 24 * (sc - 1), sc - 1);
  };

  Engine.prototype.drawBubbles = function () {
    var ctx = this.ctx;
    for (var i = 0; i < this.bubbles.length; i++) {
      var b = this.bubbles[i];
      var u = b.sc;
      var x = Math.round(b.x / u) * u;
      var y = Math.round(b.y / u) * u;
      if (b.life < b.max) {
        ctx.fillStyle = "#0b1a05";
        ctx.fillRect(x - u, y - u, (b.r + 2) * u, (b.r + 2) * u);
        ctx.fillStyle = "#7dff3c";
        ctx.fillRect(x, y, b.r * u, b.r * u);
        ctx.fillStyle = "#d4ffb0";
        ctx.fillRect(x, y, u, u);
      } else {
        ctx.fillStyle = "rgba(160,255,110,0.8)";
        ctx.fillRect(x - u * 2, y, u, u);
        ctx.fillRect(x + u * 2, y, u, u);
        ctx.fillRect(x, y - u * 2, u, u);
        ctx.fillRect(x, y + u * 2, u, u);
      }
    }
  };

  Engine.prototype.drawBats = function () {
    var order = [0, 1, 2, 3, 2, 1];
    for (var i = 0; i < this.bats.length; i++) {
      var b = this.bats[i];
      var fr = order[Math.floor(b.flap) % order.length];
      this.sprite("bat" + fr, b.x - 27 * b.sc, b.y - 27 * b.sc, b.sc, false, b.alpha);
    }
  };

  Engine.prototype.drawGhosts = function () {
    for (var i = 0; i < this.ghosts.length; i++) {
      var g = this.ghosts[i];
      var s = this.fly;
      var fade = Math.min(1, g.life / 1.5);
      var edge = Math.min(g.x - s.left + 60 * g.sc, s.right - g.x + 60 * g.sc) / (90 * g.sc);
      var a = g.max * Math.max(0, Math.min(1, Math.min(fade, edge))) * (1 - g.shy * 0.45);
      var bob = Math.sin(g.ph) * 6;
      var flip = g.vx < 0;
      var n = g.shy > 0.3 ? "ghost2" : "ghost";
      var w = 30 * g.sc;
      this.sprite(n, g.x - w / 2, g.y + bob - 16 * g.sc, g.sc, flip, a);
    }
  };

  Engine.prototype.drawHangers = function () {
    var ctx = this.ctx;
    var u = 2;
    for (var i = 0; i < this.hangers.length; i++) {
      var h = this.hangers[i];
      var sway = Math.round(Math.sin(h.ph * 0.9) * 2) * u;
      var x = Math.round(h.x / u) * u;
      var top = Math.round(h.top);
      var sy = Math.round(h.y / u) * u;
      ctx.fillStyle = "rgba(225,222,235,0.75)";
      var len = sy - top + 5 * u;
      if (len > 0) {
        var steps = Math.ceil(len / u);
        for (var k = 0; k < steps; k++) {
          var off = Math.round((sway * k) / steps / u) * u;
          ctx.fillRect(x + off, top + k * u, u, u);
        }
      }
      this.sprite("spider", x + sway - 11 * u, sy, u);
    }
  };

  function plot(c, x, y) {
    c.fillRect(x, y, 1, 1);
  }

  function line(c, x0, y0, x1, y1) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    var dx = Math.abs(x1 - x0);
    var dy = -Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx + dy;
    for (var n = 0; n < 64; n++) {
      plot(c, x0, y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  function ellipse(c, cx, cy, rx, ry, fill, hi, out) {
    for (var y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (var x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        var nx = (x + 0.5 - cx) / rx;
        var ny = (y + 0.5 - cy) / ry;
        var d = nx * nx + ny * ny;
        if (d > 1) continue;
        var inner = d < 0.62;
        c.fillStyle = !inner ? out : nx + ny < -0.55 ? hi : fill;
        plot(c, x, y);
      }
    }
  }

  var LEGS = [
    { hip: 3, foot: [13, 7] },
    { hip: 2, foot: [6, 10] },
    { hip: 1, foot: [-2, 10] },
    { hip: 0, foot: [-9, 8] },
  ];

  Engine.prototype.renderSpider = function (gait, moving) {
    var c = this.sctx;
    var W = 34;
    var H = 28;
    var cx = 17;
    var cy = 14;
    c.clearRect(0, 0, W, H);
    for (var side = -1; side <= 1; side += 2) {
      for (var i = 0; i < LEGS.length; i++) {
        var L = LEGS[i];
        var grp = (i + (side > 0 ? 0 : 1)) % 2;
        var p = gait * 2 + grp * Math.PI;
        var lift = moving && Math.cos(p) > 0.2 ? 1 : 0;
        var dx = moving ? Math.sin(p) * 2.2 : 0;
        var hx = cx + L.hip;
        var hy = cy + side * 1.5;
        var fx = cx + L.foot[0] + dx;
        var fy = cy + side * L.foot[1];
        var kx = (hx + fx) / 2 + (L.foot[0] > 0 ? 1 : -1);
        var ky = fy + side * (1.5 + lift);
        c.fillStyle = "#3a3a47";
        line(c, hx, hy, kx, ky);
        line(c, kx, ky, fx, fy);
        c.fillStyle = "#8a8a9c";
        plot(c, Math.round(kx), Math.round(ky));
      }
    }
    ellipse(c, cx - 5, cy, 5.6, 4.6, "#2a2a33", "#6c6c80", "#4a4a5a");
    ellipse(c, cx + 2.2, cy, 3.4, 2.8, "#33333d", "#77778a", "#4a4a5a");
    c.fillStyle = "#d4161f";
    plot(c, cx - 6, cy);
    plot(c, cx - 5, cy);
    plot(c, cx - 7, cy);
    plot(c, cx - 6, cy - 1);
    plot(c, cx - 6, cy + 1);
    c.fillStyle = "#ff4a3a";
    plot(c, cx + 4, cy - 1);
    plot(c, cx + 4, cy + 1);
  };

  Engine.prototype.drawCrawlers = function () {
    var ctx = this.ctx;
    for (var i = 0; i < this.crawlers.length; i++) {
      var c = this.crawlers[i];
      var u = c.sc;
      this.renderSpider(c.gait, c.state === "walk");
      ctx.save();
      ctx.translate(Math.round(c.x), Math.round(c.y));
      ctx.rotate(c.ang);
      ctx.drawImage(this.spiderCanvas, -17 * u, -14 * u, 34 * u, 28 * u);
      ctx.restore();
    }
  };

  Engine.prototype.draw = function () {
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.stage) return;
    var s = PAGE === "room" ? this.stage : this.fly;
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.left, s.top, s.width, s.height);
    ctx.clip();
    this.drawWebs();
    this.drawLantern();
    this.drawHangers();
    this.drawGround();
    this.drawLeftCluster();
    this.drawBubbles();
    this.drawCluster();
    this.drawGhosts();
    this.drawCrawlers();
    this.drawCrows();
    this.drawBats();
    ctx.restore();
  };

  var menu = null;
  var buttons = [];

  function closeMenu() {
    if (menu) {
      menu.remove();
      menu = null;
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    }
  }

  function outside(e) {
    if (!menu) return;
    if (menu.contains(e.target)) return;
    for (var i = 0; i < buttons.length; i++)
      if (buttons[i].contains(e.target)) return;
    closeMenu();
  }

  function onKey(e) {
    if (e.key === "Escape") closeMenu();
  }

  var OPTIONS = [
    { id: "full", icon: "fa-ghost", label: "Animated", sub: "Decorations and creatures" },
    { id: "still", icon: "fa-image", label: "Still", sub: "Decorations, nothing moves" },
    { id: "off", icon: "fa-power-off", label: "Off", sub: "The usual Talkomatic look" },
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function optButton(icon, label, sub, on, role) {
    var b = el("button", "hw-opt" + (on ? " is-on" : ""));
    b.type = "button";
    b.setAttribute("role", role);
    b.setAttribute("aria-checked", on ? "true" : "false");
    var i = el("i", "fas " + icon + " hw-opt-ico");
    var t = el("span", "hw-opt-text");
    t.appendChild(el("span", "hw-opt-label", label));
    t.appendChild(el("span", "hw-opt-sub", sub));
    b.appendChild(i);
    b.appendChild(t);
    if (on && role === "menuitemradio") b.appendChild(el("i", "fas fa-check hw-opt-tick"));
    return b;
  }

  function openMenu(btn) {
    if (menu) {
      closeMenu();
      return;
    }
    menu = el("div", "hw-menu");
    menu.setAttribute("role", "menu");
    menu.appendChild(el("div", "hw-menu-head", "Halloween decorations"));
    var body = el("div", "hw-menu-body");
    var cur = getPref();
    OPTIONS.forEach(function (o) {
      var b = optButton(o.icon, o.label, o.sub, o.id === cur, "menuitemradio");
      b.addEventListener("click", function () {
        setPref(o.id);
        closeMenu();
      });
      body.appendChild(b);
    });
    menu.appendChild(body);
    if (PAGE === "lobby" && cur !== "off") {
      var m = musicOn();
      menu.appendChild(el("div", "hw-menu-head", "Lobby music"));
      var mbody = el("div", "hw-menu-body");
      var mb = optButton(
        m ? "fa-volume-high" : "fa-volume-xmark",
        m ? "Music on" : "Music off",
        m ? "Click to mute" : "Click to unmute",
        m,
        "menuitemcheckbox",
      );
      mb.addEventListener("click", function () {
        setMusic(!musicOn());
        closeMenu();
      });
      mbody.appendChild(mb);
      menu.appendChild(mbody);
    }
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.right - mw));
    menu.style.left = left + "px";
    menu.style.top = r.bottom + 8 + "px";
    setTimeout(function () {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  var musicBtn = null;

  function makeButton() {
    var b;
    if (PAGE === "lobby") {
      var tools = document.querySelector(".corner-tools");
      if (!tools) return null;
      b = document.createElement("a");
      b.href = "#";
      b.className = "corner-tool hw-toggle";
      tools.insertBefore(b, tools.firstChild);
    } else {
      var right = document.querySelector(".navbar-right");
      var apps = document.getElementById("appDirectoryToggle");
      if (!right) return null;
      b = document.createElement("button");
      b.type = "button";
      b.className = "mute-toggle hw-toggle";
      right.insertBefore(b, apps || right.firstChild);
    }
    b.title = "Halloween decorations";
    b.setAttribute("aria-label", "Halloween decorations");
    b.innerHTML = '<i class="fas fa-ghost"></i>';
    b.addEventListener("click", function (e) {
      e.preventDefault();
      openMenu(b);
    });
    buttons.push(b);
    return b;
  }

  function makeMusicButton() {
    var tools = document.querySelector(".corner-tools");
    if (!tools) return;
    musicBtn = document.createElement("a");
    musicBtn.href = "#";
    musicBtn.className = "corner-tool hw-music-btn";
    musicBtn.addEventListener("click", function (e) {
      e.preventDefault();
      setMusic(!musicOn());
    });
    tools.insertBefore(musicBtn, tools.firstChild);
    buttons.push(musicBtn);
  }

  function paintMusicButton() {
    if (!musicBtn) return;
    var on = musicOn();
    musicBtn.innerHTML =
      '<i class="fas ' + (on ? "fa-volume-high" : "fa-volume-xmark") + '"></i>';
    musicBtn.classList.toggle("is-off", !on);
    musicBtn.title = on ? "Mute the lobby music" : "Play the lobby music";
    musicBtn.setAttribute("aria-label", musicBtn.title);
    musicBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function syncButtons() {
    if (theme !== "halloween") {
      buttons.forEach(function (b) {
        b.remove();
      });
      buttons = [];
      musicBtn = null;
      closeMenu();
      return;
    }
    if (!buttons.length) makeButton();
    var pref = getPref();
    buttons.forEach(function (b) {
      if (b !== musicBtn) b.classList.toggle("is-off", pref === "off");
    });
    if (PAGE === "lobby") {
      if (pref === "off" && musicBtn) {
        buttons.splice(buttons.indexOf(musicBtn), 1);
        musicBtn.remove();
        musicBtn = null;
      } else if (pref !== "off" && !musicBtn) makeMusicButton();
      paintMusicButton();
    }
  }

  var started = false;

  function sync() {
    paintClasses();
    if (!started) return;
    syncButtons();
    syncSounds();
    syncMusic();
    var on = isActive();
    if (on && !engine) {
      loadSprites(function () {
        if (!engine && isActive()) {
          engine = new Engine();
          engine.setMode(getPref());
        }
      });
    } else if (!on && engine) {
      engine.destroy();
      engine = null;
    } else if (engine) engine.setMode(getPref());
  }

  function hookSocket(tries) {
    var s = window.socket || (typeof socket !== "undefined" ? socket : null);
    if (s && typeof s.on === "function") {
      s.on("season state", function (d) {
        var next = d && typeof d.theme === "string" ? d.theme : "";
        if (next === theme) return;
        theme = next;
        sync();
      });
      return;
    }
    if (tries < 40)
      setTimeout(function () {
        hookSocket(tries + 1);
      }, 250);
  }

  function start() {
    started = true;
    sync();
    hookSocket(0);
    document.addEventListener("visibilitychange", syncMusic);
    if (reduce.addEventListener)
      reduce.addEventListener("change", function () {
        sync();
      });
    window.addEventListener("storage", function (e) {
      if (
        e.key === PREF_KEY ||
        e.key === MUSIC_KEY ||
        e.key === (window.ThemeEngine && ThemeEngine.KEY)
      )
        sync();
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start);
  else start();

  window.TalkoSeason = {
    get theme() {
      return theme;
    },
    pref: getPref,
    setPref: setPref,
    refresh: sync,
  };
})();
