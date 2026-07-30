// public/js/pong-client.js
// 1v1 pong overlay for rooms. Pairs with server/pong.js: the server owns the
// authoritative simulation; this client runs its OWN continuous ball physics
// (dead reckoning from the last server position + velocity, bouncing off the
// walls and the paddles as rendered) and gently corrects toward the server, so
// the ball moves at a full 60fps and never visually clips through a paddle.
// Your own paddle renders at your cursor immediately.
//
// Follows the piano/talkoboard convention: the modal is built once and
// open()/close() only toggle it, so nothing leaks across opens.

class Pong {
  constructor(socket, userId, username) {
    this.socket = socket;
    this.userId = userId;
    this.username = username;

    this.isOpen = false;
    this.meta = null; // last "pong meta"
    this.snapshots = []; // ring of "pong state", oldest first
    this.clockOffset = 0;
    this.offsetSamples = [];

    // Local ball simulation
    this.sim = { active: false, x: 640, y: 360, vx: 0, vy: 0 };
    this.trail = [];
    this.hitFlash = { left: 0, right: 0 };
    this.lastLocalBounceAt = 0;

    this.myTarget = 0.5; // 0..1, local paddle intent
    this.lastSentAt = 0;
    this.lastSentVal = -1;
    this.keys = { up: false, down: false };
    this.stageRect = null;
    this.frame = null;
    this.lastFrameAt = 0;

    this.buildUI();
    this.bindSocket();

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointer = this.onPointer.bind(this);class Pong {
  constructor(socket, userId, username) {
    this.socket = socket;
    this.userId = userId;
    this.username = username;

    this.isOpen = false;
    this.meta = null;
    this.snapshots = [];
    this.clockOffset = 0;
    this.offsetSamples = [];

    this.sim = { active: false, x: 640, y: 360, vx: 0, vy: 0 };
    this.trail = [];
    this.hitFlash = { left: 0, right: 0 };
    this.lastLocalBounceAt = 0;

    this.myTarget = 0.5;
    this.lastSentAt = 0;
    this.lastSentVal = -1;
    this.keys = { up: false, down: false };
    this.stageRect = null;
    this.frame = null;
    this.lastFrameAt = 0;

    this.buildUI();
    this.bindSocket();

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointer = this.onPointer.bind(this);
    this.onResize = this.onResize.bind(this);
    this.renderLoop = this.renderLoop.bind(this);
  }

  buildUI() {
    const root = document.createElement("div");
    root.className = "pong-app";
    root.innerHTML = `
      <div class="pong-topbar">
        <div class="pong-title"><span class="pong-title-ico">🏓</span> PONG</div>
        <div class="pong-match">
          <span class="pong-chip pong-chip-left" id="pongLeftChip">Waiting...</span>
          <span class="pong-vs">VS</span>
          <span class="pong-chip pong-chip-right" id="pongRightChip">Waiting...</span>
        </div>
        <div class="pong-actions">
          <span class="pong-watch" id="pongWatch"></span>
          <button class="pong-close" id="pongClose" aria-label="Close">×</button>
        </div>
      </div>
      <div class="pong-stage" id="pongStage">
        <canvas class="pong-canvas" id="pongCanvas"></canvas>
        <div class="pong-overlay" id="pongOverlay" style="display:none"></div>
      </div>
      <div class="pong-foot">
        <span id="pongHint">Move with the mouse, or W / S keys. Esc closes.</span>
        <span id="pongQueue"></span>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.stage = root.querySelector("#pongStage");
    this.canvas = root.querySelector("#pongCanvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.overlay = root.querySelector("#pongOverlay");
    this.leftChip = root.querySelector("#pongLeftChip");
    this.rightChip = root.querySelector("#pongRightChip");
    this.watchEl = root.querySelector("#pongWatch");
    this.queueEl = root.querySelector("#pongQueue");
    this.hintEl = root.querySelector("#pongHint");
    root.querySelector("#pongClose").addEventListener("click", () => this.close());
  }

  bindSocket() {
    this.socket.on("pong state", (s) => {
      if (!this.isOpen || !s) return;
      const now = performance.now();
      this.offsetSamples.push(s.t - now);
      if (this.offsetSamples.length > 30) this.offsetSamples.shift();
      this.clockOffset = Math.max(...this.offsetSamples);
      this.snapshots.push(s);
      if (this.snapshots.length > 6) this.snapshots.shift();
    });

    this.socket.on("pong meta", (m) => {
      if (!this.isOpen || !m) return;
      this.meta = m;
      this.updateBar();
    });

    this.socket.on("connect", () => {
      if (this.isOpen) this.socket.emit("pong open");
    });
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.meta = null;
    this.snapshots = [];
    this.offsetSamples = [];
    this.sim.active = false;
    this.trail.length = 0;
    this.myTarget = 0.5;
    this.lastSentVal = -1;
    this.root.classList.add("show");
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);
    this.stage.addEventListener("pointermove", this.onPointer);
    this.stage.addEventListener("pointerdown", this.onPointer);
    this.onResize();
    this.socket.emit("pong open");
    this.lastFrameAt = performance.now();
    this.frame = requestAnimationFrame(this.renderLoop);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.socket.emit("pong close");
    this.root.classList.remove("show");
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize);
    this.stage.removeEventListener("pointermove", this.onPointer);
    this.stage.removeEventListener("pointerdown", this.onPointer);
    cancelAnimationFrame(this.frame);
  }

  amPlayer() {
    return this.meta && (this.meta.you === "left" || this.meta.you === "right");
  }

  onKeyDown(e) {
    if (!this.isOpen) return;
    if (e.key === "Escape") return this.close();
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") this.keys.up = true;
    else if (e.key === "s" || e.key === "S" || e.key === "ArrowDown")
      this.keys.down = true;
    else return;
    e.preventDefault();
  }

  onKeyUp(e) {
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") this.keys.up = false;
    if (e.key === "s" || e.key === "S" || e.key === "ArrowDown")
      this.keys.down = false;
  }

  onPointer(e) {
    if (!this.isOpen || !this.amPlayer()) return;
    if (!this.stageRect) this.stageRect = this.canvas.getBoundingClientRect();
    const r = this.stageRect;
    if (r.height > 0)
      this.myTarget = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    e.preventDefault();
  }

  onResize() {
    const box = this.stage.getBoundingClientRect();
    const aspect = 1280 / 720;
    let w = box.width;
    let h = w / aspect;
    if (h > box.height) {
      h = box.height;
      w = h * aspect;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.stageRect = null;
    requestAnimationFrame(() => {
      this.stageRect = this.canvas.getBoundingClientRect();
    });
  }

  maybeSendTarget(now) {
    if (!this.amPlayer()) return;
    if (now - this.lastSentAt < 33) return;
    if (Math.abs(this.myTarget - this.lastSentVal) < 0.002) return;
    this.lastSentAt = now;
    this.lastSentVal = this.myTarget;
    this.socket.emit("pong target", { y: this.myTarget });
  }

  serverNow() {
    return performance.now() + this.clockOffset;
  }

  latest() {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  paddleAt(side) {
    const meta = this.meta;
    const half = meta ? meta.paddle.h / 2 : 50;
    if (meta && meta.you === side)
      return Math.max(half, Math.min(720 - half, this.myTarget * 720));
    const snaps = this.snapshots;
    if (!snaps.length) return 360;
    const key = side === "left" ? "l" : "r";
    const target = this.serverNow() - 110;
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t <= target && snaps[i + 1].t >= target) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
    return a[key] + (b[key] - a[key]) * k;
  }

  serverBallNow() {
    const s = this.latest();
    if (!s || !s.v) return null;
    const age = Math.max(0, Math.min(0.15, (this.serverNow() - s.t) / 1000));
    return {
      x: s.b[0] + s.v[0] * age,
      y: s.b[1] + s.v[1] * age,
      vx: s.v[0],
      vy: s.v[1],
    };
  }

  stepBall(dt, now) {
    const s = this.latest();
    if (!s || s.st !== "playing" || !this.meta) {
      this.sim.active = false;
      this.trail.length = 0;
      return;
    }
    const target = this.serverBallNow();
    if (!target) return;

    const still = target.vx === 0 && target.vy === 0;
    const far = Math.hypot(this.sim.x - target.x, this.sim.y - target.y) > 90;
    if (!this.sim.active || far || still) {
      this.sim.active = true;
      this.sim.x = target.x;
      this.sim.y = target.y;
      this.sim.vx = target.vx;
      this.sim.vy = target.vy;
      if (far) this.trail.length = 0;
      if (still) return;
    } else {
      const flipped =
        Math.sign(target.vx) !== Math.sign(this.sim.vx) ||
        Math.sign(target.vy) !== Math.sign(this.sim.vy);
      if (!flipped || now - this.lastLocalBounceAt > 150) {
        this.sim.vx = target.vx;
        this.sim.vy = target.vy;
      }
      if (this.serverNow() - s.t < 250) {
        const pull = Math.min(1, dt * 5);
        this.sim.x += (target.x - this.sim.x) * pull;
        this.sim.y += (target.y - this.sim.y) * pull;
      }
    }

    const R = this.meta.ballR;
    const prevX = this.sim.x;
    const prevY = this.sim.y;
    this.sim.x += this.sim.vx * dt;
    this.sim.y += this.sim.vy * dt;

    if (this.sim.y - R < 0) {
      this.sim.y = R;
      this.sim.vy = Math.abs(this.sim.vy);
    } else if (this.sim.y + R > 720) {
      this.sim.y = 720 - R;
      this.sim.vy = -Math.abs(this.sim.vy);
    }

    this.collideLocal("left", prevX, prevY, now);
    this.collideLocal("right", prevX, prevY, now);

    this.trail.push({ x: this.sim.x, y: this.sim.y });
    if (this.trail.length > 9) this.trail.shift();
  }

  collideLocal(side, prevX, prevY, now) {
    const m = this.meta;
    if (!m) return;
    const R = m.ballR;
    const face =
      side === "left"
        ? m.paddle.margin + m.paddle.w + R
        : 1280 - m.paddle.margin - m.paddle.w - R;
    const movingToward = side === "left" ? this.sim.vx < 0 : this.sim.vx > 0;
    if (!movingToward) return;
    const crossed =
      side === "left"
        ? prevX >= face && this.sim.x <= face
        : prevX <= face && this.sim.x >= face;
    if (!crossed) return;
    const span = this.sim.x - prevX;
    const t = span === 0 ? 0 : (face - prevX) / span;
    const hitY = prevY + (this.sim.y - prevY) * t;

    let padY;
    if (this.meta.you === side) {
      padY = this.paddleAt(side);
    } else {
      const s = this.latest();
      padY = side === "left" ? s.l : s.r;
    }

    const half = m.paddle.h / 2 + R;
    if (Math.abs(hitY - padY) > half) return;

    const rel = Math.max(-1, Math.min(1, (hitY - padY) / half));
    const speed = Math.min(1150, Math.hypot(this.sim.vx, this.sim.vy) * 1.045);
    const angle = rel * (Math.PI / 3);
    const dir = side === "left" ? 1 : -1;
    this.sim.vx = Math.cos(angle) * speed * dir;
    this.sim.vy = Math.sin(angle) * speed;
    this.sim.x = face;
    this.sim.y = hitY;
    this.lastLocalBounceAt = now;
    this.hitFlash[side] = 1;
  }

  renderLoop() {
    if (!this.isOpen) return;
    const now = performance.now();
    const dt = Math.min(0.016, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    if (this.keys.up || this.keys.down) {
      const dir = (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0);
      this.myTarget = Math.max(0, Math.min(1, this.myTarget + dir * dt * 1.5));
    }
    this.maybeSendTarget(now);
    this.stepBall(dt, now);
    this.hitFlash.left = Math.max(0, this.hitFlash.left - dt * 3);
    this.hitFlash.right = Math.max(0, this.hitFlash.right - dt * 3);

    this.draw();
    this.updateOverlay();
    this.frame = requestAnimationFrame(this.renderLoop);
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sx = W / 1280;
    const sy = H / 720;
    const meta = this.meta;
    const s = this.latest();

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#3a3a3a";
    ctx.lineWidth = Math.max(1, 2 * sx);
    ctx.setLineDash([10 * sy, 14 * sy]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 90 * sx, 0, Math.PI * 2);
    ctx.stroke();

    if (s) {
      ctx.textAlign = "center";
      ctx.font = "bold " + Math.round(110 * sy) + "px talkoSS, Arial, sans-serif";
      ctx.fillStyle = "rgba(255,152,0,0.28)";
      ctx.fillText(String(s.s[0]), W * 0.36, H * 0.22);
      ctx.fillStyle = "rgba(1,255,255,0.24)";
      ctx.fillText(String(s.s[1]), W * 0.64, H * 0.22);
      if (meta) {
        ctx.font = "bold " + Math.round(15 * sy) + "px talkoSS, Arial, sans-serif";
        ctx.fillStyle = "rgba(255,152,0,0.6)";
        ctx.fillText(
          meta.left ? meta.left.name : "waiting...",
          W * 0.36,
          H * 0.22 + 26 * sy,
        );
        ctx.fillStyle = "rgba(1,255,255,0.55)";
        ctx.fillText(
          meta.right ? meta.right.name : "waiting...",
          W * 0.64,
          H * 0.22 + 26 * sy,
        );
      }
    }

    if (!meta || !s) return;

    const pw = meta.paddle.w * sx;
    const ph = meta.paddle.h * sy;
    const margin = meta.paddle.margin * sx;
    const leftY = this.paddleAt("left");
    const rightY = this.paddleAt("right");

    ctx.save();
    if (this.hitFlash.left > 0) {
      ctx.shadowColor = "#ff9800";
      ctx.shadowBlur = 26 * this.hitFlash.left * sx;
    }
    ctx.fillStyle = "#ff9800";
    ctx.fillRect(margin, leftY * sy - ph / 2, pw, ph);
    ctx.restore();

    ctx.save();
    if (this.hitFlash.right > 0) {
      ctx.shadowColor = "#01ffff";
      ctx.shadowBlur = 26 * this.hitFlash.right * sx;
    }
    ctx.fillStyle = "#01ffff";
    ctx.fillRect(W - margin - pw, rightY * sy - ph / 2, pw, ph);
    ctx.restore();

    if (s.st === "playing") {
      const R = meta.ballR * sx;
      for (let i = 0; i < this.trail.length; i++) {
        const p = this.trail[i];
        const a = ((i + 1) / this.trail.length) * 0.22;
        ctx.fillStyle = "rgba(255,255,255," + a.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(p.x * sx, p.y * sy, R * (0.4 + (0.6 * (i + 1)) / this.trail.length), 0, Math.PI * 2);
        ctx.fill();
      }
      const bx = this.sim.active ? this.sim.x : s.b[0];
      const by = this.sim.active ? this.sim.y : s.b[1];
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(bx * sx, by * sy, R, 0, Math.PI * 2);
      ctx.fill();
    }

    if (s.st === "countdown" && s.cd) {
      const n = Math.max(1, Math.ceil((s.cd - this.serverNow()) / 1000));
      ctx.fillStyle = "#ff9800";
      ctx.font = "bold " + Math.round(150 * sy) + "px talkoSS, Arial, sans-serif";
      ctx.fillText(String(n), W / 2, H / 2 + 50 * sy);
      ctx.font = "bold " + Math.round(18 * sy) + "px talkoSS, Arial, sans-serif";
      ctx.fillStyle = "#cccccc";
      ctx.fillText("GET READY", W / 2, H / 2 + 90 * sy);
    }
    ctx.textAlign = "left";
  }

  chipHTML(info, side) {
    if (!info) return "Waiting...";
    let html = "";
    if (
      info.avatar &&
      /^\d{17,20}$/.test(info.avatar.id || "") &&
      /^(?:a_)?[a-f0-9]{32}$/i.test(info.avatar.hash || "")
    ) {
      html +=
        '<img class="pong-chip-pfp" alt="" src="https://cdn.discordapp.com/avatars/' +
        info.avatar.id + "/" + info.avatar.hash + '.webp?size=32">';
    }
    html += this.escape(info.name);
    if (this.meta && this.meta.you === side)
      html += ' <span class="pong-you">you</span>';
    return html;
  }

  escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  updateBar() {
    const m = this.meta;
    if (!m) return;
    this.leftChip.innerHTML = this.chipHTML(m.left, "left");
    this.rightChip.innerHTML = this.chipHTML(m.right, "right");
    this.watchEl.textContent = m.watching ? m.watching + " watching" : "";
    if (m.you === "spectator") {
      this.hintEl.textContent =
        "You are spectating. A seat opens when a round ends.";
      this.queueEl.textContent = m.queuePos
        ? "Your spot in line: #" + m.queuePos
        : "";
      this.stage.classList.remove("pong-playing");
    } else {
      this.hintEl.textContent =
        "First to " + (m.winScore || 5) + ". Move with the mouse, or W / S keys.";
      this.queueEl.textContent = "";
      this.stage.classList.add("pong-playing");
    }
  }

  updateOverlay() {
    const m = this.meta;
    const s = this.latest();
    if (!m || !s) {
      this.setOverlay("");
      return;
    }
    if (s.st === "waiting") {
      this.setOverlay(
        '<div class="pong-card"><div class="pong-card-big">Waiting for an opponent</div>' +
          '<div class="pong-card-sub">The game starts when a second player opens Pong.</div></div>',
      );
    } else if (s.st === "over") {
      const w = m.winner || {};
      const secs = Math.max(0, Math.ceil((s.nr - this.serverNow()) / 1000));
      const next = m.queue && m.queue.length ? m.queue[0] : null;
      this.setOverlay(
        '<div class="pong-card"><div class="pong-card-trophy">🏆</div>' +
          '<div class="pong-card-big">' + this.escape(w.name || "Player") + " wins!</div>" +
          '<div class="pong-card-score">' + s.s[0] + " : " + s.s[1] + "</div>" +
          '<div class="pong-card-sub">Next round in ' + secs + "s" +
          (next ? " · Up next: " + this.escape(next) : "") +
          "</div></div>",
      );
    } else {
      this.setOverlay("");
    }
  }

  setOverlay(html) {
    if (this._overlayHTML === html) return;
    this._overlayHTML = html;
    if (!html) {
      this.overlay.style.display = "none";
    } else {
      this.overlay.innerHTML = html;
      this.overlay.style.display = "flex";
    }
  }
}

window.Pong = Pong;
