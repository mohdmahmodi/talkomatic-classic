// talkoboard.js v3.3 - Collaborative whiteboard for Talkomatic
//

class Talkoboard {
  constructor(socketRef, userId, username, staff) {
    this.socket = socketRef;
    this.userId = userId;
    this.username = username || "Anonymous";
    this.isOpen = false;
    this.isStaff = !!(staff && (staff.isDev || staff.isMod));
    this.watching = !!(staff && staff.watching);
    this.inspectActive = false;
    this._modCard = null;
    this._modTapAt = null;
    this.barredUntil = 0;

    // ── Canvas state ────────────────────────────────────────────────
    this.canvas = null;
    this.ctx = null;
    this.drawing = false;
    this.lastPoint = null;

    // ── Infinite canvas: pan & zoom ─────────────────────────────────
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isPanning = false;
    this.panStart = null;
    this.MIN_ZOOM = 0.01;
    this.MAX_ZOOM = 1e9;
    this._redrawRaf = null;
    this._gesturing = false;

    // Render origin: world coords of the view centre, subtracted from all
    // geometry before it reaches the canvas. Canvas paths are float32
    // internally, so at deep zoom the raw world*zoom numbers lose enough
    // precision to visibly break; small re-centred numbers do not.
    this._rox = 0;
    this._roy = 0;
    // Above this many device px of local coordinate, a stroke is drawn via
    // the clipping renderer instead of trusting float32 with huge numbers.
    this.CLIP_DEVICE_LIMIT = 1e6;
    // The canvas matrix itself breaks down somewhere past scale 1e7 (Skia is
    // float32 inside), so the ctx never scales beyond this; the rest of the
    // zoom is pre-multiplied into the geometry in JS doubles.
    this.SAFE_CANVAS_SCALE = 1e6;
    this._rs = 1;

    // ── Completed strokes (for redraw on pan/zoom) ──────────────────
    this.strokes = [];

    // ── Current local stroke being drawn ────────────────────────────
    this.currentStroke = null;

    // ── Remote active strokes: userId → stroke object ───────────────
    this.remoteActiveStrokes = new Map();

    // ── Tools ───────────────────────────────────────────────────────
    this.color = "#000000";
    this.size = 3;
    this.eraser = false;
    this.panMode = false;
    this.tool = "pen";
    this.SHAPES = ["line", "rect", "ellipse", "triangle"];
    this.shapeStart = null;
    this.preview = null;
    this.fillShapes = false;

    // ── Claimed areas ───────────────────────────────────────────────
    this.claims = [];

    // ── Gradient brush (null = solid color) ─────────────────────────
    this.gradient = null;
    this.GRADIENT_PERIOD = 28;
    this.gradientPresets = [
      { name: "Rainbow", stops: ["#ff0000", "#ff9800", "#ffeb3b", "#21d07a", "#2196f3", "#9c27b0"] },
      { name: "Sunset", stops: ["#ff512f", "#f09819", "#ffd200"] },
      { name: "Ocean", stops: ["#2193b0", "#6dd5ed", "#21d07a"] },
      { name: "Neon", stops: ["#00f260", "#0575e6"] },
      { name: "Fire", stops: ["#f12711", "#f5af19"] },
      { name: "Candy", stops: ["#ee0979", "#ff6a00", "#ffd200"] },
    ];

    // ── Undo / redo (your own strokes, synced to everyone) ──────────
    this.undoStack = [];
    this.redoStack = [];
    this._strokeSeq = 0;

    // ── Color tools ─────────────────────────────────────────────────
    this.palette = [
      "#000000",
      "#ffffff",
      "#9e9e9e",
      "#e74c3c",
      "#ff9800",
      "#ffd54f",
      "#8bc34a",
      "#1abc9c",
      "#2196f3",
      "#3f51b5",
      "#9b59b6",
      "#ec407a",
    ];
    this.recentColors = [];
    this.MAX_RECENT = 8;
    this.eyedropperActive = false;

    // ── Other users' live colors (adopt a teammate's color) ─────────
    this.peerColors = new Map();
    this.peerNames = new Map();

    // ── Network batching ────────────────────────────────────────────
    this.pointBuffer = [];
    this.flushTimer = null;
    this.FLUSH_INTERVAL = 25;

    // ── Point simplification ────────────────────────────────────────
    this.MIN_POINT_DISTANCE_SQ = 2.25;

    // ── Live cursors (entity interpolation) ──────
    this.remoteCursors = new Map();
    this.cursorThrottle = 0;
    this.CURSOR_SEND_INTERVAL = 45;
    this.CURSOR_RENDER_DELAY = 80;
    this.CURSOR_TIMEOUT = 3000;
    this._cursorRaf = null;

    // ── Chat (closable panel docked bottom-right) ───────────────────
    this.chatNodes = [];
    this.MAX_CHAT_MESSAGES = 60;
    this.chatOpen = false;
    this.chatUnread = 0;

    // ── Chat rate limiting ──────────────────────────────────────────
    this.chatTimestamps = [];
    this.CHAT_MIN_INTERVAL = 1000;
    this.CHAT_BURST_WINDOW = 30000;
    this.CHAT_BURST_MAX = 10;
    this.chatCooldownActive = false;

    // ── Saved chat text ─────────────────────────────────────────────
    this.savedChatText = "";

    // ── Display dimensions (set in resizeCanvas) ────────────────────
    this.displayWidth = 0;
    this.displayHeight = 0;
    this.dpr = 1;

    // ── Build everything ────────────────────────────────────────────
    this.modal = null;
    this.buildModal();
    this.setupSocketListeners();
    this.registerBotApi();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  registerBotApi() {
    window.talkoboardInstance = this;
    if (window.TalkoboardBots) return;

    const live = () => window.talkoboardInstance || null;
    let seq = 0;

    const api = {
      version: 1,

      limits: {
        maxPointsPerStroke: 5000,
        maxRingsPerStroke: 256,
        addsPerWindow: 8,
        windowMs: 6000,
        cooldownMs: 15000,
        maxStrokesOnBoard: 2000,
        sizeRange: [1, 50],
      },

      get board() {
        return live();
      },
      get socket() {
        const b = live();
        return b ? b.socket : null;
      },
      get isOpen() {
        const b = live();
        return !!(b && b.isOpen);
      },

      view() {
        const b = live();
        if (!b) return null;
        return {
          zoom: b.zoom,
          panX: b.panX,
          panY: b.panY,
          width: b.displayWidth,
          height: b.displayHeight,
          canvas: b.canvas,
          toWorld: (sx, sy) => b.screenToWorld(sx, sy),
          toScreen: (wx, wy) => b.worldToScreen(wx, wy),
          centre: () => b.screenToWorld(b.displayWidth / 2, b.displayHeight / 2),
        };
      },

      claims() {
        const b = live();
        return b ? b.claims.slice() : [];
      },

      draw(input) {
        const b = live();
        if (!b || !input || !Array.isArray(input.points) || !input.points.length)
          return null;
        const stroke = {
          id: input.id || "bot:" + Date.now().toString(36) + ":" + seq++,
          owner: b.userId,
          points: input.points,
          color: input.color || "#000000",
          size: input.size == null ? 3 : input.size,
          eraser: !!input.eraser,
          gradient: input.gradient || null,
          fill: !!input.fill,
          rings: input.rings || null,
          sharp: !!input.sharp,
        };
        b.strokes.push(stroke);
        if (b.isOpen) b.redraw();
        b.socket.emit("board stroke add", { stroke: b.strokePayload(stroke) });
        return stroke.id;
      },

      erase(id) {
        const b = live();
        if (!b || !id) return false;
        b.strokes = b.strokes.filter((s) => s.id !== id);
        if (b.isOpen) b.redraw();
        b.socket.emit("board stroke remove", { id });
        return true;
      },

      send(strokes, onProgress) {
        const list = Array.isArray(strokes) ? strokes.slice() : [];
        const ids = [];
        const PER = 6;
        const GAP = 6500;
        return new Promise((resolve) => {
          const step = () => {
            if (!live()) return resolve(ids);
            for (const s of list.splice(0, PER)) {
              const id = api.draw(s);
              if (id) ids.push(id);
            }
            if (onProgress) onProgress(ids.length, ids.length + list.length);
            if (list.length) setTimeout(step, GAP);
            else resolve(ids);
          };
          step();
        });
      },

      on(event, fn) {
        const b = live();
        if (b) b.socket.on(event, fn);
        return api;
      },
    };

    window.TalkoboardBots = api;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  canSendChat() {
    const now = Date.now();

    this.chatTimestamps = this.chatTimestamps.filter(
      (t) => now - t < this.CHAT_BURST_WINDOW,
    );

    if (this.chatTimestamps.length >= this.CHAT_BURST_MAX) {
      const oldest = this.chatTimestamps[0];
      const waitSec = Math.ceil(
        (this.CHAT_BURST_WINDOW - (now - oldest)) / 1000,
      );
      this.showChatRateWarning(`Slow down! Try again in ${waitSec}s`);
      return false;
    }

    if (this.chatTimestamps.length > 0) {
      const last = this.chatTimestamps[this.chatTimestamps.length - 1];
      if (now - last < this.CHAT_MIN_INTERVAL) {
        this.showChatRateWarning("Sending too fast");
        return false;
      }
    }

    this.chatTimestamps.push(now);
    return true;
  }

  showChatRateWarning(text) {
    if (this.chatCooldownActive) return;
    this.chatCooldownActive = true;

    const msg = document.createElement("div");
    msg.className = "tb-chat-msg tb-chat-system";
    const span = document.createElement("span");
    span.className = "tb-chat-text";
    span.textContent = text;
    msg.appendChild(span);
    this._appendChat(msg);

    setTimeout(() => {
      this.chatCooldownActive = false;
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  makeBtn(className, label, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    if (label != null) b.innerHTML = label;
    if (title) b.title = title;
    return b;
  }

  buildModal() {
    this.modal = document.createElement("div");
    this.modal.id = "talkoboardModal";
    this.modal.className = "tb-overlay";

    const container = document.createElement("div");
    container.className = "tb-container";

    // ── Header / Toolbar ────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "tb-header";

    const toolbar = document.createElement("div");
    toolbar.className = "tb-toolbar";

    // ── Group: the tools ────────────────────────────────────────────
    const drawGroup = document.createElement("div");
    drawGroup.className = "tb-group";
    this.toolBtns = {};

    const tool = (name, icon, title) => {
      const b = this.makeBtn(
        "tb-tool-btn tb-icon-btn" + (name === "pen" ? " active" : ""),
        '<i class="fas ' + icon + '"></i>',
        title,
      );
      b.addEventListener("click", () => this.setTool(name));
      this.toolBtns[name] = b;
      drawGroup.appendChild(b);
      return b;
    };

    this.panBtn = tool("pan", "fa-hand", "Move (drag to pan)");
    this.penBtn = tool("pen", "fa-pen", "Pen");
    this.eraserBtn = tool("eraser", "fa-eraser", "Eraser");

    const shapeGroup = document.createElement("div");
    shapeGroup.className = "tb-group";
    const shape = (name, icon, title) => {
      const b = this.makeBtn(
        "tb-tool-btn tb-icon-btn",
        '<i class="fas ' + icon + '"></i>',
        title,
      );
      b.addEventListener("click", () => this.setTool(name));
      this.toolBtns[name] = b;
      shapeGroup.appendChild(b);
      return b;
    };
    shape("line", "fa-slash", "Line - hold Shift to snap the angle");
    shape("rect", "fa-square", "Rectangle - hold Shift for a square");
    shape("ellipse", "fa-circle", "Ellipse - hold Shift for a circle");
    shape("triangle", "fa-play", "Triangle");
    this.toolBtns.triangle.querySelector("i").style.transform = "rotate(-90deg)";
    shape("bucket", "fa-fill-drip", "Fill a closed area with the current color");

    this.fillBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn off",
      '<i class="fas fa-square-full"></i>',
      "Draw shapes filled in",
    );
    this.fillBtn.addEventListener("click", () =>
      this.setFillShapes(!this.fillShapes),
    );
    shapeGroup.appendChild(this.fillBtn);

    const areaGroup = document.createElement("div");
    areaGroup.className = "tb-group";
    const areaBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-vector-square"></i>',
      "Claim an area - drag a box only you can draw in",
    );
    areaBtn.addEventListener("click", () => this.setTool("claim"));
    this.toolBtns.claim = areaBtn;
    areaGroup.appendChild(areaBtn);
    this.releaseBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-square-xmark"></i>',
      "Give your area back",
    );
    this.releaseBtn.addEventListener("click", () =>
      this.socket.emit("board unclaim", {}),
    );
    this.releaseBtn.style.display = "none";
    areaGroup.appendChild(this.releaseBtn);

    if (this.isStaff) {
      this.inspectBtn = this.makeBtn(
        "tb-tool-btn tb-icon-btn tb-mod-btn",
        '<i class="fas fa-user-shield"></i>',
        "Mod tools - tap a drawing to see who made it",
      );
      this.inspectBtn.addEventListener("click", () => this.setTool("inspect"));
      this.toolBtns.inspect = this.inspectBtn;
    }

    // ── Group: color ────────────────────────────────────────────────
    const colorGroup = document.createElement("div");
    colorGroup.className = "tb-group";

    this.colorBtn = document.createElement("button");
    this.colorBtn.type = "button";
    this.colorBtn.className = "tb-color-btn";
    this.colorBtn.title = "Colors";
    this.colorSwatch = document.createElement("span");
    this.colorSwatch.className = "tb-color-current";
    this.colorSwatch.style.background = this.color;
    const colorCaret = document.createElement("span");
    colorCaret.className = "tb-color-caret";
    colorCaret.innerHTML = '<i class="fas fa-caret-down"></i>';
    this.colorBtn.appendChild(this.colorSwatch);
    this.colorBtn.appendChild(colorCaret);
    this.colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleColorPanel();
    });

    colorGroup.appendChild(this.colorBtn);

    // ── Group: size ─────────────────────────────────────────────────
    const sizeWrap = document.createElement("div");
    sizeWrap.className = "tb-group tb-size-wrap";
    this.sizeDot = document.createElement("span");
    this.sizeDot.className = "tb-size-dot";
    this.sizeInput = document.createElement("input");
    this.sizeInput.type = "range";
    this.sizeInput.min = "1";
    this.sizeInput.max = "30";
    this.sizeInput.value = String(this.size);
    this.sizeInput.title = "Brush size";
    this.sizeLabel = document.createElement("span");
    this.sizeLabel.className = "tb-size-label";
    this.sizeLabel.textContent = String(this.size);
    sizeWrap.appendChild(this.sizeDot);
    sizeWrap.appendChild(this.sizeInput);
    sizeWrap.appendChild(this.sizeLabel);
    this.sizeInput.addEventListener("input", (e) => {
      this.size = parseInt(e.target.value);
      this.sizeLabel.textContent = String(this.size);
      this.updateSizeDot();
      this.updateCursor();
    });
    this.updateSizeDot();

    // ── Group: undo / redo ──────────────────────────────────────────
    const historyGroup = document.createElement("div");
    historyGroup.className = "tb-group";
    this.undoBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-rotate-left"></i>',
      "Undo (Ctrl+Z)",
    );
    this.redoBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-rotate-right"></i>',
      "Redo (Ctrl+Y)",
    );
    this.undoBtn.addEventListener("click", () => this.undo());
    this.redoBtn.addEventListener("click", () => this.redo());
    historyGroup.appendChild(this.undoBtn);
    historyGroup.appendChild(this.redoBtn);

    const modGroup = document.createElement("div");
    modGroup.className = "tb-group tb-mod-group";
    if (this.inspectBtn) modGroup.appendChild(this.inspectBtn);

    toolbar.appendChild(drawGroup);
    toolbar.appendChild(shapeGroup);
    toolbar.appendChild(areaGroup);
    toolbar.appendChild(colorGroup);
    toolbar.appendChild(sizeWrap);
    toolbar.appendChild(historyGroup);
    if (this.inspectBtn) toolbar.appendChild(modGroup);

    // ── Header right: save + zoom + close ───────────────────────────
    const headerRight = document.createElement("div");
    headerRight.className = "tb-header-right";

    this.saveBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-download"></i>',
      "Save as image",
    );
    this.saveBtn.addEventListener("click", () => this.exportBoard());
    headerRight.appendChild(this.saveBtn);

    const zoomWrap = document.createElement("div");
    zoomWrap.className = "tb-group tb-zoom-wrap";
    const zoomOut = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-magnifying-glass-minus"></i>',
      "Zoom out",
    );
    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "tb-zoom-label";
    this.zoomLabel.textContent = "100%";
    const zoomIn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-magnifying-glass-plus"></i>',
      "Zoom in",
    );
    const zoomReset = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-expand"></i>',
      "Reset view (100%)",
    );
    const fitBtn = this.makeBtn(
      "tb-tool-btn tb-icon-btn",
      '<i class="fas fa-arrows-to-dot"></i>',
      "Fit drawing to screen",
    );
    zoomOut.addEventListener("click", () => this.adjustZoom(-0.15));
    zoomIn.addEventListener("click", () => this.adjustZoom(0.15));
    zoomReset.addEventListener("click", () => this.resetView());
    fitBtn.addEventListener("click", () => this.fitToView());
    zoomWrap.appendChild(zoomOut);
    zoomWrap.appendChild(this.zoomLabel);
    zoomWrap.appendChild(zoomIn);
    zoomWrap.appendChild(zoomReset);
    zoomWrap.appendChild(fitBtn);

    const closeBtn = this.makeBtn(
      "tb-close",
      '<i class="fas fa-xmark"></i>',
      "Close",
    );
    closeBtn.addEventListener("click", () => this.close());

    headerRight.appendChild(zoomWrap);
    headerRight.appendChild(closeBtn);

    const brand = document.createElement("div");
    brand.className = "tb-brand";
    brand.innerHTML = '<i class="fas fa-palette"></i><span>Talkoboard</span>';

    header.appendChild(brand);
    header.appendChild(toolbar);
    header.appendChild(headerRight);

    // ── Canvas area ─────────────────────────────────────────────────
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "tb-canvas-wrap";

    this.canvas = document.createElement("canvas");
    this.canvas.id = "tbCanvas";
    this.ctx = this.canvas.getContext("2d");

    this.cursorLayer = document.createElement("div");
    this.cursorLayer.className = "tb-cursor-layer";

    canvasWrap.appendChild(this.canvas);
    canvasWrap.appendChild(this.cursorLayer);

    this.buildColorPanel(canvasWrap);

    this.hintEl = document.createElement("div");
    this.hintEl.className = "tb-hint";
    canvasWrap.appendChild(this.hintEl);

    this.canvasWrap = canvasWrap;

    // ── Chat panel ──────────────────────────────────────────────────
    this.buildChat(canvasWrap);

    // ── Assemble ────────────────────────────────────────────────────
    container.appendChild(header);
    container.appendChild(canvasWrap);
    this.modal.appendChild(container);
    document.body.appendChild(this.modal);

    this.updateUndoRedoButtons();
    this.bindCanvasEvents();
  }

  // ── Color panel ──────────────────────────────────────────────────
  buildColorPanel(parent) {
    const panel = document.createElement("div");
    panel.className = "tb-color-panel";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());

    const presetTitle = document.createElement("div");
    presetTitle.className = "tb-pop-title";
    presetTitle.textContent = "Palette";
    const presetGrid = document.createElement("div");
    presetGrid.className = "tb-swatch-grid";
    for (const c of this.palette) {
      presetGrid.appendChild(this.makeSwatch(c, c));
    }

    const customRow = document.createElement("div");
    customRow.className = "tb-custom-row";

    const customLabel = document.createElement("label");
    customLabel.className = "tb-custom-pick";
    customLabel.title = "Pick any color";
    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = this.color;
    const customText = document.createElement("span");
    customText.textContent = "Custom";
    customLabel.appendChild(document.createElement("i")).className =
      "fas fa-palette";
    customLabel.appendChild(this.colorInput);
    customLabel.appendChild(customText);
    this.colorInput.addEventListener("input", (e) =>
      this.setColor(e.target.value, false),
    );
    this.colorInput.addEventListener("change", (e) =>
      this.addRecentColor(e.target.value),
    );

    this.eyedropperBtn = document.createElement("button");
    this.eyedropperBtn.type = "button";
    this.eyedropperBtn.className = "tb-eyedropper";
    this.eyedropperBtn.title = "Take a color off the board";
    this.eyedropperBtn.innerHTML =
      '<i class="fas fa-eye-dropper"></i><span>Pick up</span>';
    this.eyedropperBtn.addEventListener("click", () =>
      this.activateEyedropper(),
    );

    customRow.appendChild(customLabel);
    customRow.appendChild(this.eyedropperBtn);

    const gradTitle = document.createElement("div");
    gradTitle.className = "tb-pop-title";
    gradTitle.textContent = "Gradients";
    const gradRow = document.createElement("div");
    gradRow.className = "tb-swatch-row tb-gradient-row";
    this.gradientEls = [];
    for (const g of this.gradientPresets) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "tb-swatch tb-gradient-swatch";
      sw.title = g.name;
      sw.style.background =
        "linear-gradient(135deg, " + g.stops.join(", ") + ")";
      sw.addEventListener("click", () => this.setGradient(g.stops));
      gradRow.appendChild(sw);
      this.gradientEls.push({ el: sw, stops: g.stops });
    }

    const recentTitle = document.createElement("div");
    recentTitle.className = "tb-pop-title";
    recentTitle.textContent = "Recent";
    this.recentRow = document.createElement("div");
    this.recentRow.className = "tb-swatch-row";

    const usersTitle = document.createElement("div");
    usersTitle.className = "tb-pop-title";
    usersTitle.textContent = "People here";
    this.usersRow = document.createElement("div");
    this.usersRow.className = "tb-swatch-row tb-users-row";

    panel.appendChild(presetTitle);
    panel.appendChild(presetGrid);
    panel.appendChild(customRow);
    panel.appendChild(gradTitle);
    panel.appendChild(gradRow);
    panel.appendChild(recentTitle);
    panel.appendChild(this.recentRow);
    panel.appendChild(usersTitle);
    panel.appendChild(this.usersRow);

    this.colorPanel = panel;
    parent.appendChild(panel);

    this.renderRecentColors();
    this.renderUserColors();
  }

  makeSwatch(color, title, onClick) {
    const s = document.createElement("button");
    s.type = "button";
    s.className = "tb-swatch";
    s.style.background = color;
    if (title) s.title = title;
    s.addEventListener("click", () =>
      onClick ? onClick() : this.setColor(color),
    );
    return s;
  }

  toggleColorPanel(force) {
    const open =
      force != null ? force : !this.colorPanel.classList.contains("show");
    this.colorPanel.classList.toggle("show", open);
    this.colorBtn.classList.toggle("active", open);
    if (open) {
      this.renderRecentColors();
      this.renderUserColors();
    }
  }

  renderRecentColors() {
    if (!this.recentRow) return;
    this.recentRow.innerHTML = "";
    if (this.recentColors.length === 0) {
      const empty = document.createElement("span");
      empty.className = "tb-pop-empty";
      empty.textContent = "No recent colors";
      this.recentRow.appendChild(empty);
      return;
    }
    for (const c of this.recentColors) {
      this.recentRow.appendChild(this.makeSwatch(c, c));
    }
  }

  renderUserColors() {
    if (!this.usersRow) return;
    this.usersRow.innerHTML = "";
    const entries = [];
    for (const [uid, color] of this.peerColors) {
      if (uid === this.userId) continue;
      entries.push({ uid, color, name: this.peerNames.get(uid) || "User" });
    }
    if (entries.length === 0) {
      const empty = document.createElement("span");
      empty.className = "tb-pop-empty";
      empty.textContent = "No one else is drawing yet";
      this.usersRow.appendChild(empty);
      return;
    }
    for (const e of entries) {
      const wrap = document.createElement("button");
      wrap.type = "button";
      wrap.className = "tb-user-swatch";
      wrap.title = `Use ${e.name}'s color`;
      const dot = document.createElement("span");
      dot.className = "tb-swatch";
      dot.style.background = e.color;
      const name = document.createElement("span");
      name.className = "tb-user-name";
      name.textContent = e.name;
      wrap.appendChild(dot);
      wrap.appendChild(name);
      wrap.addEventListener("click", () => this.setColor(e.color, true));
      this.usersRow.appendChild(wrap);
    }
  }

  // ── Chat (closable panel, bottom-right) ──────────────────────────
  buildChat(parent) {
    const chat = document.createElement("div");
    chat.className = "tb-chat";

    this.chatFab = document.createElement("button");
    this.chatFab.type = "button";
    this.chatFab.className = "tb-chat-fab";
    this.chatFab.title = "Open chat";
    this.chatFab.innerHTML =
      '<i class="fas fa-comment-dots"></i><span class="tb-chat-badge"></span>';
    this.chatFab.addEventListener("click", () => this.openChat());

    const panel = document.createElement("div");
    panel.className = "tb-chat-panel";

    const bar = document.createElement("div");
    bar.className = "tb-chat-bar";
    const title = document.createElement("span");
    title.className = "tb-chat-title";
    title.innerHTML = '<i class="fas fa-comment-dots"></i><span>Chat</span>';
    const closeChatBtn = document.createElement("button");
    closeChatBtn.type = "button";
    closeChatBtn.className = "tb-chat-close-btn";
    closeChatBtn.title = "Hide chat";
    closeChatBtn.innerHTML = '<i class="fas fa-xmark"></i>';
    closeChatBtn.addEventListener("click", () => this.closeChat());
    bar.appendChild(title);
    bar.appendChild(closeChatBtn);

    this.chatLog = document.createElement("div");
    this.chatLog.className = "tb-chat-log";

    const inputRow = document.createElement("div");
    inputRow.className = "tb-chat-input-row";
    this.chatInput = document.createElement("input");
    this.chatInput.type = "text";
    this.chatInput.className = "tb-chat-input";
    this.chatInput.placeholder = "Say something…";
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitChat();
      else if (e.key === "Escape") {
        this.closeChat();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    this.chatSendBtn = document.createElement("button");
    this.chatSendBtn.type = "button";
    this.chatSendBtn.className = "tb-chat-send";
    this.chatSendBtn.title = "Send";
    this.chatSendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    this.chatSendBtn.addEventListener("click", () => this.submitChat());
    inputRow.appendChild(this.chatInput);
    inputRow.appendChild(this.chatSendBtn);

    panel.appendChild(bar);
    panel.appendChild(this.chatLog);
    panel.appendChild(inputRow);

    chat.appendChild(panel);
    chat.appendChild(this.chatFab);

    this.chatEl = chat;
    parent.appendChild(chat);
  }

  submitChat() {
    const text = this.chatInput.value.trim();
    if (!text) return;
    this.sendChat(text);
    this.chatInput.value = "";
  }

  openChat() {
    this.chatOpen = true;
    this.chatEl.classList.add("open");
    this.chatUnread = 0;
    this.updateChatBadge();
    setTimeout(() => this.chatInput && this.chatInput.focus(), 30);
    if (this.chatLog) this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  closeChat() {
    this.chatOpen = false;
    this.chatEl.classList.remove("open");
    if (this.chatInput) this.chatInput.blur();
  }

  updateChatBadge() {
    if (this.chatFab) this.chatFab.classList.toggle("has-unread", this.chatUnread > 0);
  }

  bindCanvasEvents() {
    this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointerleave", (e) => this.onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));

    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length < 2) e.preventDefault();
      },
      { passive: false },
    );
    this.canvas.addEventListener("touchmove", (e) => e.preventDefault(), {
      passive: false,
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        this.adjustZoom(delta, e);
      },
      { passive: false },
    );

    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.isPanning = true;
        this.panStart = {
          x: e.clientX,
          y: e.clientY,
          px: this.panX,
          py: this.panY,
        };
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (this.isPanning && this.panStart) {
        this.panX = this.panStart.px + (e.clientX - this.panStart.x);
        this.panY = this.panStart.py + (e.clientY - this.panStart.y);
        this.scheduleRedraw();
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 1) this.isPanning = false;
    });

    let gesture = null;
    this.canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          this._abortCurrentStroke();
          this._gesturing = true;
          this.isPanning = true;
          gesture = this.touchGesture(e.touches);
        }
      },
      { passive: true },
    );
    this.canvas.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && gesture) {
          const g = this.touchGesture(e.touches);
          this.panX += g.cx - gesture.cx;
          this.panY += g.cy - gesture.cy;
          if (gesture.dist > 0 && g.dist > 0) {
            const rect = this.canvas.getBoundingClientRect();
            const ax = g.cx - rect.left,
              ay = g.cy - rect.top;
            const oldZoom = this.zoom;
            const nz = Math.min(
              this.MAX_ZOOM,
              Math.max(this.MIN_ZOOM, oldZoom * (g.dist / gesture.dist)),
            );
            this.panX = ax - (ax - this.panX) * (nz / oldZoom);
            this.panY = ay - (ay - this.panY) * (nz / oldZoom);
            this.zoom = nz;
            this.updateZoomLabel();
          }
          gesture = g;
          this.scheduleRedraw();
        }
      },
      { passive: true },
    );
    const endGesture = (e) => {
      if (gesture && (!e.touches || e.touches.length < 2)) {
        gesture = null;
        this.isPanning = false;
        this._gesturing = false;
      }
    };
    this.canvas.addEventListener("touchend", endGesture, { passive: true });
    this.canvas.addEventListener("touchcancel", endGesture, { passive: true });

    this.canvas.addEventListener("pointerdown", () => {
      this.toggleColorPanel(false);
    });

    this._escHandler = (e) => {
      if (e.key !== "Escape" || !this.isOpen) return;
      if (this.isTypingTarget(e.target) && e.target !== this.chatInput) return;
      if (this.colorPanel.classList.contains("show")) {
        this.toggleColorPanel(false);
        return;
      }
      if (this.chatOpen) {
        this.closeChat();
        return;
      }
      this.close();
    };
    document.addEventListener("keydown", this._escHandler);

    this._undoKeyHandler = (e) => {
      if (!this.isOpen) return;
      if (this.isTypingTarget(e.target)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        this.redo();
      }
    };
    document.addEventListener("keydown", this._undoKeyHandler);

    this._spaceDown = false;
    this._spaceHandler = (e) => {
      if (!this.isOpen) return;
      if (this.isTypingTarget(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        this._spaceDown = e.type === "keydown";
        this.updateCursor();
      }
    };
    document.addEventListener("keydown", this._spaceHandler);
    document.addEventListener("keyup", this._spaceHandler);

    this._resizeHandler = () => {
      if (this.isOpen) {
        this.resizeCanvas();
        this.redraw();
      }
    };
    window.addEventListener("resize", this._resizeHandler);
  }

  isTypingTarget(t) {
    return !!(
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    );
  }

  touchGesture(touches) {
    const a = touches[0],
      b = touches[1];
    const dx = b.clientX - a.clientX,
      dy = b.clientY - a.clientY;
    return {
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
      dist: Math.hypot(dx, dy),
    };
  }

  scheduleRedraw() {
    if (this._redrawRaf != null) return;
    this._redrawRaf = requestAnimationFrame(() => {
      this._redrawRaf = null;
      this.redraw();
    });
  }

  _abortCurrentStroke() {
    if (this.shapeStart || this.preview) {
      this.shapeStart = null;
      this.preview = null;
      this.scheduleRedraw();
    }
    if (!this.drawing && !this.currentStroke) return;
    const s = this.currentStroke;
    this.drawing = false;
    this.lastPoint = null;
    this.currentStroke = null;
    this.pointBuffer = [];
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (s) {
      this.socket.emit("board stroke end");
      this.socket.emit("board stroke remove", { id: s.id });
    }
    this.redraw();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  setTool(name) {
    this.tool = name;
    this.panMode = name === "pan";
    this.eraser = name === "eraser";
    this.inspectActive = name === "inspect";
    this.shapeStart = null;
    this.preview = null;
    for (const [tool, btn] of Object.entries(this.toolBtns || {}))
      if (btn) btn.classList.toggle("active", tool === name);
    if (this.inspectActive)
      this.showHint("Mod tools: tap a drawing to see who made it");
    else this.closeModCard();
    if (name === "bucket") this.showHint("Tap inside a closed shape to fill it");
    if (this.fillBtn)
      this.fillBtn.classList.toggle(
        "off",
        !["rect", "ellipse", "triangle"].includes(name),
      );
    this.updateCursor();
  }

  setFillShapes(on) {
    this.fillShapes = !!on;
    if (this.fillBtn) this.fillBtn.classList.toggle("active", this.fillShapes);
    if (this.fillShapes && !["rect", "ellipse", "triangle"].includes(this.tool))
      this.setTool("rect");
  }

  setEraser(on) {
    this.setTool(on ? "eraser" : "pen");
  }

  setColor(color, addRecent) {
    if (!color) return;
    this.color = color;
    this.gradient = null;
    this.colorSwatch.style.background = color;
    if (this.colorInput) this.colorInput.value = this.normalizeHex(color);
    if (this.eraser || this.panMode || this.inspectActive) this.setTool("pen");
    this.updateSizeDot();
    this.updateCursor();
    this.updateGradientSelection();
    if (addRecent) this.addRecentColor(color);
  }

  setGradient(stops) {
    if (!Array.isArray(stops) || stops.length < 2) return;
    this.gradient = stops.slice();
    this.colorSwatch.style.background =
      "linear-gradient(135deg, " + stops.join(", ") + ")";
    if (this.eraser || this.panMode || this.inspectActive) this.setTool("pen");
    this.updateSizeDot();
    this.updateGradientSelection();
  }

  addRecentColor(color) {
    if (!color) return;
    const hex = color.toLowerCase();
    this.recentColors = this.recentColors.filter(
      (c) => c.toLowerCase() !== hex,
    );
    this.recentColors.unshift(color);
    if (this.recentColors.length > this.MAX_RECENT)
      this.recentColors = this.recentColors.slice(0, this.MAX_RECENT);
    this.renderRecentColors();
  }

  updateSizeDot() {
    if (!this.sizeDot) return;
    const d = Math.max(4, Math.min(22, this.size + 3));
    this.sizeDot.style.width = d + "px";
    this.sizeDot.style.height = d + "px";
    this.sizeDot.style.background = this.eraser
      ? "#bbb"
      : this.gradient
        ? "linear-gradient(135deg, " + this.gradient.join(", ") + ")"
        : this.color;
  }

  // ── Gradient helpers ────────────────────────────────────────────
  hexToRgb(hex) {
    const h = this.normalizeHex(hex).slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  lerpColor(a, b, t) {
    const pa = this.hexToRgb(a);
    const pb = this.hexToRgb(b);
    return this.rgbToHex(
      Math.round(pa.r + (pb.r - pa.r) * t),
      Math.round(pa.g + (pb.g - pa.g) * t),
      Math.round(pa.b + (pb.b - pa.b) * t),
    );
  }

  sampleGradient(stops, t) {
    if (!stops || stops.length === 0) return "#000000";
    if (stops.length === 1) return stops[0];
    t = Math.max(0, Math.min(1, t));
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    return this.lerpColor(stops[i], stops[i + 1], seg - i);
  }

  strokeSegmentColor(stroke, i) {
    if (!stroke.gradient || stroke.gradient.length < 2) return stroke.color;
    const p = this.GRADIENT_PERIOD;
    return this.sampleGradient(stroke.gradient, (i % p) / p);
  }

  updateGradientSelection() {
    if (!this.gradientEls) return;
    for (const { el, stops } of this.gradientEls) {
      const on =
        this.gradient && stops.join(",") === this.gradient.join(",");
      el.classList.toggle("active", !!on);
    }
  }

  normalizeHex(color) {
    if (typeof color !== "string") return "#000000";
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return (
        "#" +
        color
          .slice(1)
          .split("")
          .map((c) => c + c)
          .join("")
      );
    }
    return "#000000";
  }

  rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  // ── Eyedropper ──────────────────────────────────────────────────
  async activateEyedropper() {
    this.toggleColorPanel(false);
    if (window.EyeDropper) {
      try {
        const ed = new window.EyeDropper();
        const res = await ed.open();
        if (res && res.sRGBHex) this.setColor(res.sRGBHex, true);
      } catch (_) {
      }
      return;
    }
    this.eyedropperActive = true;
    this.canvas.style.cursor = "copy";
    this.showHint("Tap the board to pick a color");
  }

  deactivateEyedropper() {
    this.eyedropperActive = false;
    this.updateCursor();
  }

  sampleCanvasColor(e) {
    try {
      const rect = this.canvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * this.dpr);
      const y = Math.round((e.clientY - rect.top) * this.dpr);
      const d = this.ctx.getImageData(x, y, 1, 1).data;
      if (d[3] === 0) return "#ffffff";
      return this.rgbToHex(d[0], d[1], d[2]);
    } catch (_) {
      return null;
    }
  }

  // ── Hit testing (staff "who drew this") ─────────────────────────
  strokeAt(pt) {
    if (!pt) return null;
    const candidates = this.strokes.concat([
      ...this.remoteActiveStrokes.values(),
    ]);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const s = candidates[i];
      if (!s || !s.points || !s.points.length) continue;
      if (s.fill && this.pointInFilled(s, pt)) return s;
      const tol = Math.max((s.size || 3) / 2, 6 / this.zoom);
      if (this.strokeHit(s, pt, tol)) return s;
    }
    return null;
  }

  pointInFilled(stroke, pt) {
    const rings =
      Array.isArray(stroke.rings) && stroke.rings.length
        ? stroke.rings
        : [stroke.points];
    let inside = false;
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (
          a.y > pt.y !== b.y > pt.y &&
          pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
        )
          inside = !inside;
      }
    }
    return inside;
  }

  strokeHit(stroke, pt, tol) {
    const pts = stroke.points;
    const tol2 = tol * tol;
    if (pts.length === 1) {
      const dx = pts[0].x - pt.x;
      const dy = pts[0].y - pt.y;
      return dx * dx + dy * dy <= tol2;
    }
    for (let i = 1; i < pts.length; i++) {
      if (this.distToSegmentSq(pt, pts[i - 1], pts[i]) <= tol2) return true;
    }
    return false;
  }

  distToSegmentSq(p, a, b) {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + t * vx);
    const dy = p.y - (a.y + t * vy);
    return dx * dx + dy * dy;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  isShapeTool(name) {
    return this.SHAPES.includes(name || this.tool);
  }

  foreignClaimAt(pt) {
    if (!pt || this.isStaff) return null;
    for (const c of this.claims) {
      if (c.owner === this.userId) continue;
      if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h)
        return c;
    }
    return null;
  }

  blockedByClaim(pt) {
    const c = this.foreignClaimAt(pt);
    if (!c) return false;
    this.showHint("That is " + (c.name || "someone") + "'s area");
    return true;
  }

  segmentHitsRect(a, b, r) {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return true;
  }

  claimCrossed(a, b) {
    if (this.isStaff) return null;
    for (const c of this.claims) {
      if (c.owner === this.userId) continue;
      if (this.segmentHitsRect(a, b, c)) return c;
    }
    return null;
  }

  setClaims(list) {
    this.claims = Array.isArray(list) ? list : [];
    const mine = this.claims.some((c) => c.owner === this.userId);
    if (this.releaseBtn) this.releaseBtn.style.display = mine ? "" : "none";
    if (this.isOpen) this.scheduleRedraw();
  }

  constrainPoint(a, b, kind, shift) {
    if (!shift) return b;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (kind === "line") {
      const ang = Math.atan2(dy, dx);
      const step = Math.PI / 4;
      const snapped = Math.round(ang / step) * step;
      const len = Math.hypot(dx, dy);
      return { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: a.x + Math.sign(dx || 1) * side,
      y: a.y + Math.sign(dy || 1) * side,
    };
  }

  shapePoints(kind, a, b) {
    const pts = [];
    if (kind === "line") return [a, b];
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    if (kind === "rect")
      return [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
        { x: x0, y: y0 },
      ];
    if (kind === "triangle")
      return [
        { x: (x0 + x1) / 2, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
        { x: (x0 + x1) / 2, y: y0 },
      ];
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
    }
    return pts;
  }

  commitShape(kind, a, b, shift) {
    const end = this.constrainPoint(a, b, kind, shift);
    if (Math.hypot(end.x - a.x, end.y - a.y) < 2) return;
    const pts = this.shapePoints(kind, a, end);
    for (let i = 0; i < pts.length; i++) {
      const hit = this.claimCrossed(pts[i], pts[i + 1] || pts[i]);
      if (hit)
        return this.showHint("That is " + (hit.name || "someone") + "'s area");
    }
    const closedShape =
      kind === "rect" || kind === "ellipse" || kind === "triangle";
    if (closedShape && this.fillShapes && !this.isStaff) {
      for (const c of this.claims) {
        if (c.owner === this.userId) continue;
        const mid = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
        if (this.pointInFilled({ points: pts }, mid))
          return this.showHint("That is " + (c.name || "someone") + "'s area");
      }
    }
    const closed = kind === "rect" || kind === "ellipse" || kind === "triangle";
    const stroke = {
      id: this.nextStrokeId(),
      owner: this.userId,
      points: this.shapePoints(kind, a, end),
      color: this.color,
      size: this.worldBrushSize(),
      eraser: false,
      gradient: this.gradient ? this.gradient.slice() : null,
      fill: closed && this.fillShapes,
      sharp: kind !== "ellipse",
    };
    this.addOwnStroke(stroke);
  }

  strokePayload(stroke) {
    return {
      id: stroke.id,
      points: stroke.points,
      color: stroke.color,
      size: stroke.size,
      eraser: stroke.eraser,
      gradient: stroke.gradient || null,
      fill: !!stroke.fill,
      rings: stroke.rings || null,
      sharp: !!stroke.sharp,
    };
  }

  addOwnStroke(stroke) {
    this.strokes.push(stroke);
    this.undoStack.push(stroke.id);
    this.redoStack = [];
    this.updateUndoRedoButtons();
    this.socket.emit("board stroke add", { stroke: this.strokePayload(stroke) });
    this.scheduleRedraw();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  bucketFill(screenPt) {
    const dpr = this.dpr;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W || !H) return;
    const sx = Math.round(screenPt.x * dpr);
    const sy = Math.round(screenPt.y * dpr);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;

    this.redraw();

    let img;
    try {
      img = this.ctx.getImageData(0, 0, W, H);
    } catch (_) {
      return this.showHint("Cannot read the board to fill it");
    }
    const px = img.data;
    const at = (x, y) => (y * W + x) * 4;
    const seed = at(sx, sy);
    const sr = px[seed];
    const sg = px[seed + 1];
    const sb = px[seed + 2];
    const TOL = 32 * 32 * 3;

    const mask = new Uint8Array(W * H);
    const stack = [sx, sy];
    let touchedEdge = false;
    let filled = 0;
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (mask[i]) continue;
      const o = i * 4;
      const dr = px[o] - sr;
      const dg = px[o + 1] - sg;
      const db = px[o + 2] - sb;
      if (dr * dr + dg * dg + db * db > TOL) continue;
      mask[i] = 1;
      filled++;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchedEdge = true;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }

    if (!filled) return;
    if (touchedEdge)
      return this.showHint("That area is not closed - the paint would run out");

    const rings = this.traceMask(mask, W, H);
    if (!rings.length) return this.showHint("Nothing to fill there");

    const toWorld = (p) => ({
      x: (p.x / dpr - this.panX) / this.zoom,
      y: (p.y / dpr - this.panY) / this.zoom,
    });
    let out = rings
      .map((r) => this.simplifyRing(r, 1.2).map(toWorld))
      .filter((r) => r.length >= 3);
    if (!out.length) return this.showHint("Nothing to fill there");
    out.sort((a, b) => b.length - a.length);
    let total = out.reduce((n, r) => n + r.length, 0);
    if (total > 1400) {
      out = out.map((r) => this.simplifyRing(r, 3 / this.zoom));
      total = out.reduce((n, r) => n + r.length, 0);
    }

    this.addOwnStroke({
      id: this.nextStrokeId(),
      owner: this.userId,
      points: out[0],
      rings: out,
      color: this.color,
      size: 1,
      eraser: false,
      gradient: null,
      fill: true,
    });
  }

  traceMask(mask, W, H) {
    const edges = new Map();
    const key = (x, y) => x + "," + y;
    const add = (x1, y1, x2, y2) => edges.set(key(x1, y1), [x2, y2]);
    const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        if (!on(x, y - 1)) add(x, y, x + 1, y);
        if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!on(x - 1, y)) add(x, y + 1, x, y);
      }
    }

    const rings = [];
    while (edges.size) {
      const startKey = edges.keys().next().value;
      const ring = [];
      let k = startKey;
      while (true) {
        const next = edges.get(k);
        if (!next) break;
        edges.delete(k);
        const [x, y] = k.split(",");
        ring.push({ x: +x, y: +y });
        k = key(next[0], next[1]);
        if (k === startKey) break;
        if (ring.length > 200000) break;
      }
      if (ring.length >= 4) rings.push(ring);
    }
    return rings;
  }

  simplifyRing(ring, eps) {
    if (ring.length < 4) return ring;
    const straight = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const a = straight[straight.length - 1];
      const b = ring[i];
      const c = ring[i + 1];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross !== 0) straight.push(b);
    }
    straight.push(ring[ring.length - 1]);
    return this.douglasPeucker(straight, eps);
  }

  douglasPeucker(pts, eps) {
    if (pts.length < 3) return pts;
    let worst = 0;
    let idx = 0;
    const a = pts[0];
    const b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = this.distToSegmentSq(pts[i], a, b);
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (worst <= eps * eps) return [a, b];
    const left = this.douglasPeucker(pts.slice(0, idx + 1), eps);
    const right = this.douglasPeucker(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  barredMinutes() {
    return Math.max(1, Math.round((this.barredUntil - Date.now()) / 60000));
  }

  isBarred() {
    if (this.barredUntil && this.barredUntil <= Date.now()) this.barredUntil = 0;
    return !!this.barredUntil;
  }

  isBarredForDrawing() {
    if (!this.isBarred()) return false;
    this.showHint(
      "You are off the board for another " + this.barredMinutes() + " minutes",
    );
    return true;
  }

  closeModCard() {
    if (this._modCard) {
      this._modCard.remove();
      this._modCard = null;
    }
  }

  openModCard(info) {
    this.closeModCard();
    if (!this.isStaff) return;

    const name = info.username || this.peerNames.get(info.userId) || "Someone";
    const card = document.createElement("div");
    card.className = "tb-modcard";
    this._modCard = card;

    const head = document.createElement("div");
    head.className = "tb-modcard-h";
    const who = document.createElement("div");
    who.className = "tb-modcard-who";
    const nm = document.createElement("span");
    nm.className = "tb-modcard-n";
    nm.textContent = name;
    who.appendChild(nm);
    const sub = document.createElement("span");
    sub.className = "tb-modcard-s";
    sub.textContent = info.present ? "drew this" : "drew this, and has left";
    who.appendChild(sub);
    head.appendChild(who);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tb-modcard-x";
    x.title = "Close";
    x.innerHTML = '<i class="fas fa-xmark"></i>';
    x.addEventListener("click", () => this.closeModCard());
    head.appendChild(x);
    card.appendChild(head);

    const act = (cls, icon, label, note, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tb-modcard-b " + cls;
      b.innerHTML =
        '<i class="fas ' +
        icon +
        '"></i><span class="tb-modcard-bt"></span><span class="tb-modcard-bn"></span>';
      b.querySelector(".tb-modcard-bt").textContent = label;
      b.querySelector(".tb-modcard-bn").textContent = note;
      b.addEventListener("click", fn);
      card.appendChild(b);
      return b;
    };

    const arm = (b, confirmLabel, fn) => {
      let armed = false;
      const text = b.querySelector(".tb-modcard-bt");
      const was = text.textContent;
      b.addEventListener("click", () => {
        if (armed) return fn();
        armed = true;
        b.classList.add("armed");
        text.textContent = confirmLabel;
        setTimeout(() => {
          if (!armed || !b.isConnected) return;
          armed = false;
          b.classList.remove("armed");
          text.textContent = was;
        }, 3000);
      });
    };

    const wipe = act(
      "danger",
      "fa-eraser",
      "Erase everything they drew",
      "Only theirs. Everyone else's stays.",
      () => {},
    );
    arm(wipe, "Erase it all? Press again", () => {
      this.socket.emit("board wipe user", { userId: info.userId });
      this.closeModCard();
    });

    if (this.claims.some((c) => c.owner === info.userId)) {
      act(
        "",
        "fa-square-xmark",
        "Take their area away",
        "The fence goes. Anybody can draw there again.",
        () => {
          this.socket.emit("board unclaim", { owner: info.userId });
          this.closeModCard();
        },
      );
    }

    const barred = info.barredUntil && info.barredUntil > Date.now();
    if (barred) {
      act(
        "",
        "fa-rotate-left",
        "Let them back in",
        "They can draw again straight away.",
        () => {
          this.socket.emit("board bar user", {
            userId: info.userId,
            allow: true,
          });
          this.closeModCard();
        },
      );
    } else if (info.present) {
      const kick = act(
        "danger",
        "fa-ban",
        "Take them off the board",
        "Ten minutes. They stay in the room.",
        () => {},
      );
      arm(kick, "Take their pen? Press again", () => {
        this.socket.emit("board bar user", { userId: info.userId });
        this.closeModCard();
      });
    }

    this.modal.appendChild(card);
    const mr = this.modal.getBoundingClientRect();
    const at = this._modTapAt || {
      x: mr.left + mr.width / 2,
      y: mr.top + mr.height / 2,
    };
    let left = at.x - mr.left + 12;
    let top = at.y - mr.top + 12;
    if (left + card.offsetWidth > mr.width - 10)
      left = mr.width - card.offsetWidth - 10;
    if (left < 10) left = 10;
    if (top + card.offsetHeight > mr.height - 10)
      top = at.y - mr.top - card.offsetHeight - 12;
    if (top < 10) top = 10;
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
  }

  showHint(text) {
    if (!this.hintEl) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.add("show");
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => {
      this.hintEl.classList.remove("show");
    }, 1800);
  }

  // ── Peer color/name tracking ────────────────────────────────────
  notePeerColor(userId, color) {
    if (!userId || userId === this.userId || !color) return;
    if (this.peerColors.get(userId) === color) return;
    this.peerColors.set(userId, color);
    if (this.colorPanel && this.colorPanel.classList.contains("show"))
      this.renderUserColors();
  }

  notePeerName(userId, name) {
    if (!userId || userId === this.userId || !name) return;
    if (this.peerNames.get(userId) === name) return;
    this.peerNames.set(userId, name);
    if (this.colorPanel && this.colorPanel.classList.contains("show"))
      this.renderUserColors();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  nextStrokeId() {
    this._strokeSeq += 1;
    return `${this.userId}:${this._strokeSeq}`;
  }

  undo() {
    if (this.undoStack.length === 0) return;
    const id = this.undoStack.pop();
    const idx = this.strokes.findIndex((s) => s.id === id);
    if (idx === -1) {
      this.updateUndoRedoButtons();
      return;
    }
    const [stroke] = this.strokes.splice(idx, 1);
    this.redoStack.push(stroke);
    this.socket.emit("board stroke remove", { id });
    this.redraw();
    this.updateUndoRedoButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const stroke = this.redoStack.pop();
    this.strokes.push(stroke);
    this.undoStack.push(stroke.id);
    this.socket.emit("board stroke add", { stroke: this.strokePayload(stroke) });
    this.redraw();
    this.updateUndoRedoButtons();
  }

  updateUndoRedoButtons() {
    if (this.undoBtn)
      this.undoBtn.classList.toggle("disabled", this.undoStack.length === 0);
    if (this.redoBtn)
      this.redoBtn.classList.toggle("disabled", this.redoStack.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  open() {
    if (this.isOpen) return;
    if (this.isBarred()) {
      if (window.toastr)
        toastr.warning(
          "You are off the board for another " +
            this.barredMinutes() +
            " minutes.",
          "Board",
        );
      return;
    }
    this.isOpen = true;
    this.modal.classList.add("show");
    this.resizeCanvas();
    this.redraw();
    this.updateCursor();
    this.updateUndoRedoButtons();

    this.socket.emit("board open");

    this.savedChatText = typeof selfRawText === "string" ? selfRawText : "";
    if (typeof socket !== "undefined") {
      socket.emit("chat update", {
        diff: {
          type: "full-replace",
          text: "Using Talkoboard. Open Apps (top right) > Talkoboard to join!",
        },
      });
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;

    if (this.drawing) {
      this.flush();
      this.socket.emit("board stroke end");
      if (this.currentStroke) {
        this.strokes.push(this.currentStroke);
        this.undoStack.push(this.currentStroke.id);
        this.redoStack = [];
        this.currentStroke = null;
      }
      this.drawing = false;
      this.lastPoint = null;
      this.updateUndoRedoButtons();
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this._cursorRaf != null) {
      cancelAnimationFrame(this._cursorRaf);
      this._cursorRaf = null;
    }
    if (this._redrawRaf != null) {
      cancelAnimationFrame(this._redrawRaf);
      this._redrawRaf = null;
    }
    this.closeChat();
    this.closeModCard();

    this.toggleColorPanel(false);
    this.deactivateEyedropper();
    this.modal.classList.remove("show");
    this.socket.emit("board close");

    if (typeof socket !== "undefined") {
      socket.emit("chat update", {
        diff: { type: "full-replace", text: this.savedChatText },
      });
    }

    if (typeof chatInput !== "undefined" && chatInput) {
      setTimeout(() => chatInput.focus(), 50);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  resizeCanvas() {
    const wrap = this.canvasWrap;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";

    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
    this.dpr = dpr;
  }

  updateCursor() {
    if (!this.canvas) return;
    if (this.eyedropperActive) {
      this.canvas.style.cursor = "copy";
      return;
    }
    if (this.inspectActive) {
      this.canvas.style.cursor = "help";
      return;
    }
    if (this.tool === "bucket") {
      this.canvas.style.cursor = "cell";
      return;
    }
    if (this.tool === "claim") {
      this.canvas.style.cursor = "crosshair";
      return;
    }
    this.canvas.style.cursor =
      this._spaceDown || this.panMode ? "grab" : "crosshair";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.panX) / this.zoom,
      y: (sy - this.panY) / this.zoom,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: wx * this.zoom + this.panX,
      y: wy * this.zoom + this.panY,
    };
  }

  getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return this.screenToWorld(sx, sy);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  formatZoom() {
    const z = this.zoom;
    if (z < 10) return Math.round(z * 100) + "%";
    if (z < 1000) return Math.round(z) + "×";
    if (z < 1e6) return (z / 1000).toPrecision(3).replace(/\.?0+$/, "") + "k×";
    if (z < 1e9) return (z / 1e6).toPrecision(3).replace(/\.?0+$/, "") + "M×";
    return (z / 1e9).toPrecision(3).replace(/\.?0+$/, "") + "B×";
  }

  updateZoomLabel() {
    this.zoomLabel.textContent = this.formatZoom();
  }

  adjustZoom(delta, e) {
    const oldZoom = this.zoom;
    this.zoom = Math.min(
      this.MAX_ZOOM,
      Math.max(this.MIN_ZOOM, this.zoom * Math.pow(1.32, delta / 0.15)),
    );

    if (e) {
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX || rect.width / 2) - rect.left;
      const my = (e.clientY || rect.height / 2) - rect.top;
      this.panX = mx - (mx - this.panX) * (this.zoom / oldZoom);
      this.panY = my - (my - this.panY) * (this.zoom / oldZoom);
    }

    this.updateZoomLabel();
    this.scheduleRedraw();
  }

  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.updateZoomLabel();
    this.redraw();
  }

  fitToView() {
    const all = [...this.strokes];
    for (const [, s] of this.remoteActiveStrokes) all.push(s);
    if (this.currentStroke) all.push(this.currentStroke);

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of all) {
      if (!s.points) continue;
      const r = (s.size || 1) / 2 + 2;
      for (const p of s.points) {
        if (p.x - r < minX) minX = p.x - r;
        if (p.y - r < minY) minY = p.y - r;
        if (p.x + r > maxX) maxX = p.x + r;
        if (p.y + r > maxY) maxY = p.y + r;
      }
    }
    if (!isFinite(minX)) {
      this.showHint("Nothing to fit yet");
      return;
    }

    const pad = 60;
    const bw = Math.max(1e-9, maxX - minX);
    const bh = Math.max(1e-9, maxY - minY);
    const z = Math.min(
      this.MAX_ZOOM,
      Math.max(
        this.MIN_ZOOM,
        Math.min(
          (this.displayWidth - pad * 2) / bw,
          (this.displayHeight - pad * 2) / bh,
        ),
      ),
    );
    this.zoom = z;
    this.panX = this.displayWidth / 2 - ((minX + maxX) / 2) * z;
    this.panY = this.displayHeight / 2 - ((minY + maxY) / 2) * z;
    this.updateZoomLabel();
    this.redraw();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  exportBoard() {
    const all = [...this.strokes];
    for (const [, s] of this.remoteActiveStrokes) all.push(s);
    if (this.currentStroke) all.push(this.currentStroke);

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of all) {
      if (!s.points) continue;
      const r = s.size / 2 + 2;
      for (const p of s.points) {
        if (p.x - r < minX) minX = p.x - r;
        if (p.y - r < minY) minY = p.y - r;
        if (p.x + r > maxX) maxX = p.x + r;
        if (p.y + r > maxY) maxY = p.y + r;
      }
    }
    if (!isFinite(minX)) {
      this.showHint("Nothing to save yet");
      return;
    }

    const pad = 28;
    const worldW = maxX - minX + pad * 2;
    const worldH = maxY - minY + pad * 2;
    const MAX_DIM = 4096;
    const scale = Math.min(2, MAX_DIM / worldW, MAX_DIM / worldH);
    const W = Math.max(1, Math.round(worldW * scale));
    const H = Math.max(1, Math.round(worldH * scale));

    const layer = document.createElement("canvas");
    layer.width = W;
    layer.height = H;
    const lctx = layer.getContext("2d");
    lctx.scale(scale, scale);
    lctx.translate(pad - minX, pad - minY);
    const prevRox = this._rox,
      prevRoy = this._roy,
      prevRs = this._rs;
    this._rox = 0;
    this._roy = 0;
    this._rs = 1;
    for (const s of this.strokes) this.renderStrokeSmooth(lctx, s);
    for (const [, s] of this.remoteActiveStrokes) this.renderStrokeSmooth(lctx, s);
    if (this.currentStroke) this.renderStrokeSmooth(lctx, this.currentStroke);
    this._rox = prevRox;
    this._roy = prevRoy;
    this._rs = prevRs;

    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const octx = out.getContext("2d");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, W, H);
    octx.drawImage(layer, 0, 0);

    const done = (url, revoke) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = "talkoboard.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.showHint("Saved board image");
    };
    if (out.toBlob) {
      out.toBlob((blob) => {
        if (blob) done(URL.createObjectURL(blob), true);
        else done(out.toDataURL("image/png"), false);
      }, "image/png");
    } else {
      done(out.toDataURL("image/png"), false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  redraw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const w = this.displayWidth;
    const h = this.displayHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    const centre = this.screenToWorld(w / 2, h / 2);
    this._rox = centre.x;
    this._roy = centre.y;
    const S = Math.min(this.zoom, this.SAFE_CANVAS_SCALE);
    this._rs = this.zoom / S;

    ctx.save();
    ctx.translate(
      this.panX + this._rox * this.zoom,
      this.panY + this._roy * this.zoom,
    );
    ctx.scale(S, S);

    const view = this.viewWorldRect();

    for (const stroke of this.strokes) {
      this.renderStrokeCulled(ctx, stroke, view);
    }

    for (const [, stroke] of this.remoteActiveStrokes) {
      this.renderStrokeCulled(ctx, stroke, view);
    }

    if (this.currentStroke) {
      this.renderStrokeCulled(ctx, this.currentStroke, view);
    }

    for (const c of this.claims) this.renderClaim(ctx, c);

    if (this.preview) {
      if (this.preview.claim) {
        this.renderClaim(ctx, {
          owner: this.userId,
          x: Math.min(this.preview.a.x, this.preview.b.x),
          y: Math.min(this.preview.a.y, this.preview.b.y),
          w: Math.abs(this.preview.b.x - this.preview.a.x),
          h: Math.abs(this.preview.b.y - this.preview.a.y),
        });
        ctx.restore();
        return;
      }
      this.renderStrokeSmooth(ctx, {
        points: this.shapePoints(
          this.preview.kind,
          this.preview.a,
          this.preview.b,
        ),
        color: this.color,
        size: this.worldBrushSize(),
        eraser: false,
        gradient: this.gradient,
        fill:
          this.fillShapes &&
          ["rect", "ellipse", "triangle"].includes(this.preview.kind),
        sharp: this.preview.kind !== "ellipse",
      });
    }

    ctx.restore();
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  viewWorldRect() {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.displayWidth, this.displayHeight);
    return {
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    };
  }

  strokeBB(s) {
    const pts = s.points || [];
    if (s._bb && s._bbN === pts.length) return s._bb;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const scan = (arr) => {
      for (const p of arr) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    };
    if (Array.isArray(s.rings) && s.rings.length)
      for (const r of s.rings) scan(r);
    else scan(pts);
    s._bb = { minX, minY, maxX, maxY };
    s._bbN = pts.length;
    return s._bb;
  }

  renderStrokeCulled(ctx, stroke, view) {
    if (!stroke.points || !stroke.points.length) return;
    const bb = this.strokeBB(stroke);
    const pad = (stroke.size || 1) / 2 + 4 / this.zoom;
    if (
      bb.maxX + pad < view.minX ||
      bb.minX - pad > view.maxX ||
      bb.maxY + pad < view.minY ||
      bb.minY - pad > view.maxY
    )
      return;
    // Far corners turn into device-pixel numbers float32 cannot hold; those
    // strokes get clipped in JS (doubles) before the canvas sees them.
    const far = Math.max(
      Math.abs(bb.minX - this._rox),
      Math.abs(bb.maxX - this._rox),
      Math.abs(bb.minY - this._roy),
      Math.abs(bb.maxY - this._roy),
    );
    if (far * this.zoom > this.CLIP_DEVICE_LIMIT) {
      this.renderStrokeClipped(ctx, stroke, view);
      return;
    }
    this.renderStrokeSmooth(ctx, stroke);
  }

  clipSegToRect(a, b, r) {
    let t0 = 0,
      t1 = 1;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - r.minX, r.maxX - a.x, a.y - r.minY, r.maxY - a.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return null;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
    return [
      { x: a.x + t0 * dx, y: a.y + t0 * dy },
      { x: a.x + t1 * dx, y: a.y + t1 * dy },
    ];
  }

  clipRingToRect(ring, r) {
    const clipHalf = (pts, inside, intersect) => {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i];
        const prev = pts[(i + pts.length - 1) % pts.length];
        const cin = inside(cur),
          pin = inside(prev);
        if (cin) {
          if (!pin) out.push(intersect(prev, cur));
          out.push(cur);
        } else if (pin) {
          out.push(intersect(prev, cur));
        }
      }
      return out;
    };
    const ix = (a, b, x) => {
      const t = (x - a.x) / (b.x - a.x);
      return { x, y: a.y + (b.y - a.y) * t };
    };
    const iy = (a, b, y) => {
      const t = (y - a.y) / (b.y - a.y);
      return { x: a.x + (b.x - a.x) * t, y };
    };
    let out = ring;
    out = clipHalf(out, (p) => p.x >= r.minX, (a, b) => ix(a, b, r.minX));
    if (!out.length) return out;
    out = clipHalf(out, (p) => p.x <= r.maxX, (a, b) => ix(a, b, r.maxX));
    if (!out.length) return out;
    out = clipHalf(out, (p) => p.y >= r.minY, (a, b) => iy(a, b, r.minY));
    if (!out.length) return out;
    out = clipHalf(out, (p) => p.y <= r.maxY, (a, b) => iy(a, b, r.maxY));
    return out;
  }

  distPointToSeg(p, a, b) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
          )
        : 0;
    const px = a.x + t * dx - p.x,
      py = a.y + t * dy - p.y;
    return Math.hypot(px, py);
  }

  renderStrokeClipped(ctx, stroke, view) {
    const z = this.zoom;
    const rox = this._rox,
      roy = this._roy,
      k = this._rs;
    const halfW = (stroke.size || 1) / 2;
    const padCap = this.CLIP_DEVICE_LIMIT / z;
    const padWorld = Math.min(halfW, padCap) + 40 / z;
    const rect = {
      minX: view.minX - padWorld,
      minY: view.minY - padWorld,
      maxX: view.maxX + padWorld,
      maxY: view.maxY + padWorld,
    };

    if (stroke.fill && !stroke.eraser) {
      const rings =
        Array.isArray(stroke.rings) && stroke.rings.length
          ? stroke.rings
          : [stroke.points];
      const path = new Path2D();
      let any = false;
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        const cl = this.clipRingToRect(ring, rect);
        if (cl.length < 3) continue;
        any = true;
        path.moveTo((cl[0].x - rox) * k, (cl[0].y - roy) * k);
        for (let i = 1; i < cl.length; i++)
          path.lineTo((cl[i].x - rox) * k, (cl[i].y - roy) * k);
        path.closePath();
      }
      if (any) {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = stroke.color;
        ctx.fill(path, "evenodd");
        ctx.restore();
      }
      if (!(stroke.size > 1)) return;
    }

    const pts = stroke.points;
    if (!pts || pts.length < 2) return;

    // When the brush is wider than the clip pad allows, a segment whose
    // centreline misses the padded rect can still paint the whole view (you
    // are zoomed deep inside the fat stroke). Detect that and flood the view.
    let coverAll = false;
    if (halfW > padCap) {
      const centre = { x: rox, y: roy };
      for (let i = 1; i < pts.length; i++) {
        if (this.distPointToSeg(centre, pts[i - 1], pts[i]) <= halfW) {
          coverAll = true;
          break;
        }
      }
    }
    ctx.save();
    ctx.globalCompositeOperation = stroke.eraser
      ? "destination-out"
      : "source-over";
    if (coverAll) {
      const fx = (rect.minX - rox) * k,
        fy = (rect.minY - roy) * k;
      ctx.fillStyle = stroke.eraser
        ? "rgba(0,0,0,1)"
        : stroke.gradient && stroke.gradient.length
          ? this.strokeSegmentColor(stroke, 1)
          : stroke.color;
      ctx.fillRect(
        fx,
        fy,
        (rect.maxX - rect.minX) * k,
        (rect.maxY - rect.minY) * k,
      );
      ctx.restore();
      return;
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = (stroke.size || 1) * k;
    const grad =
      !stroke.eraser && stroke.gradient && stroke.gradient.length >= 2;
    if (!grad) ctx.strokeStyle = stroke.color;
    if (!grad) ctx.beginPath();
    let open = false;
    for (let i = 1; i < pts.length; i++) {
      const seg = this.clipSegToRect(pts[i - 1], pts[i], rect);
      if (!seg) continue;
      if (grad) {
        ctx.strokeStyle = this.strokeSegmentColor(stroke, i);
        ctx.beginPath();
        ctx.moveTo((seg[0].x - rox) * k, (seg[0].y - roy) * k);
        ctx.lineTo((seg[1].x - rox) * k, (seg[1].y - roy) * k);
        ctx.stroke();
      } else {
        ctx.moveTo((seg[0].x - rox) * k, (seg[0].y - roy) * k);
        ctx.lineTo((seg[1].x - rox) * k, (seg[1].y - roy) * k);
        open = true;
      }
    }
    if (!grad && open) ctx.stroke();
    ctx.restore();
  }

  renderStrokeSmooth(ctx, stroke) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) return;

    if (stroke.fill && !stroke.eraser) {
      this.renderFilled(ctx, stroke);
      return;
    }

    if (stroke.sharp) {
      this.renderStrokeSharp(ctx, stroke);
      return;
    }

    if (!stroke.eraser && stroke.gradient && stroke.gradient.length >= 2) {
      this.renderStrokeGradient(ctx, stroke);
      return;
    }

    const ox = this._rox,
      oy = this._roy,
      k = this._rs;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.size * k;

    if (stroke.eraser) {
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color;
    }

    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(
        (pts[0].x - ox) * k,
        (pts[0].y - oy) * k,
        (stroke.size / 2) * k,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = stroke.eraser ? "rgba(0,0,0,1)" : stroke.color;
      ctx.fill();
    } else if (pts.length === 2) {
      ctx.beginPath();
      ctx.moveTo((pts[0].x - ox) * k, (pts[0].y - oy) * k);
      ctx.lineTo((pts[1].x - ox) * k, (pts[1].y - oy) * k);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo((pts[0].x - ox) * k, (pts[0].y - oy) * k);

      for (let i = 1; i < pts.length - 1; i++) {
        const mx = ((pts[i].x + pts[i + 1].x) * 0.5 - ox) * k;
        const my = ((pts[i].y + pts[i + 1].y) * 0.5 - oy) * k;
        ctx.quadraticCurveTo((pts[i].x - ox) * k, (pts[i].y - oy) * k, mx, my);
      }

      const last = pts[pts.length - 1];
      ctx.lineTo((last.x - ox) * k, (last.y - oy) * k);
      ctx.stroke();
    }

    ctx.restore();
  }

  renderStrokeGradient(ctx, stroke) {
    const pts = stroke.points;
    ctx.save();
    if (pts.length === 1) {
      const k = this._rs;
      ctx.lineWidth = stroke.size * k;
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(
        (pts[0].x - this._rox) * k,
        (pts[0].y - this._roy) * k,
        (stroke.size / 2) * k,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = this.strokeSegmentColor(stroke, 0);
      ctx.fill();
    } else {
      this.renderGradientPieces(ctx, stroke, 1);
    }
    ctx.restore();
  }

  renderGradientPieces(ctx, stroke, from) {
    const pts = stroke.points;
    const n = pts.length;
    if (n < 2) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const ox = this._rox,
      oy = this._roy,
      k = this._rs;
    ctx.lineWidth = stroke.size * k;
    ctx.globalCompositeOperation = "source-over";
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    if (n === 2) {
      ctx.strokeStyle = this.strokeSegmentColor(stroke, 1);
      ctx.beginPath();
      ctx.moveTo((pts[0].x - ox) * k, (pts[0].y - oy) * k);
      ctx.lineTo((pts[1].x - ox) * k, (pts[1].y - oy) * k);
      ctx.stroke();
      return;
    }
    const startI = Math.max(1, from);
    for (let i = startI; i <= n - 2; i++) {
      const s = i === 1 ? pts[0] : mid(pts[i - 1], pts[i]);
      const e = mid(pts[i], pts[i + 1]);
      ctx.strokeStyle = this.strokeSegmentColor(stroke, i);
      ctx.beginPath();
      ctx.moveTo((s.x - ox) * k, (s.y - oy) * k);
      ctx.quadraticCurveTo(
        (pts[i].x - ox) * k,
        (pts[i].y - oy) * k,
        (e.x - ox) * k,
        (e.y - oy) * k,
      );
      ctx.stroke();
    }
    const fs = mid(pts[n - 2], pts[n - 1]);
    ctx.strokeStyle = this.strokeSegmentColor(stroke, n - 1);
    ctx.beginPath();
    ctx.moveTo((fs.x - ox) * k, (fs.y - oy) * k);
    ctx.lineTo((pts[n - 1].x - ox) * k, (pts[n - 1].y - oy) * k);
    ctx.stroke();
  }

  renderClaim(ctx, c) {
    const mine = c.owner === this.userId;
    const z = this.zoom;
    const ox = this._rox,
      oy = this._roy;

    const view = this.viewWorldRect();
    const margin = 24 / z;
    if (
      c.x + c.w + margin < view.minX ||
      c.x - margin > view.maxX ||
      c.y + c.h + margin < view.minY ||
      c.y - margin > view.maxY
    )
      return;

    const k = this._rs;
    ctx.save();
    ctx.setLineDash([(8 / z) * k, (6 / z) * k]);
    ctx.lineWidth = (1.5 / z) * k;
    ctx.strokeStyle = mine ? "#ff9800" : "#8d8d8d";

    const far = Math.max(
      Math.abs(c.x - ox),
      Math.abs(c.x + c.w - ox),
      Math.abs(c.y - oy),
      Math.abs(c.y + c.h - oy),
    );
    if (far * z > this.CLIP_DEVICE_LIMIT) {
      // Deep zoom inside/near a huge claim: draw its border edges clipped so
      // the canvas never sees float32-breaking numbers.
      const pad = 40 / z;
      const rect = {
        minX: view.minX - pad,
        minY: view.minY - pad,
        maxX: view.maxX + pad,
        maxY: view.maxY + pad,
      };
      const corners = [
        { x: c.x, y: c.y },
        { x: c.x + c.w, y: c.y },
        { x: c.x + c.w, y: c.y + c.h },
        { x: c.x, y: c.y + c.h },
      ];
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const seg = this.clipSegToRect(corners[i], corners[(i + 1) % 4], rect);
        if (!seg) continue;
        ctx.moveTo((seg[0].x - ox) * k, (seg[0].y - oy) * k);
        ctx.lineTo((seg[1].x - ox) * k, (seg[1].y - oy) * k);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.strokeRect((c.x - ox) * k, (c.y - oy) * k, c.w * k, c.h * k);
    ctx.setLineDash([]);

    const label =
      (mine ? "Your area" : (c.name || "Someone") + "'s area") +
      (c.away ? " (away)" : "");
    const pad = (4 / z) * k;
    ctx.font = "bold " + (11 / z) * k + "px sans-serif";
    const w = ctx.measureText(label).width + pad * 2;
    const h = (16 / z) * k;
    ctx.fillStyle = mine ? "#ff9800" : "#5a5a5a";
    ctx.fillRect((c.x - ox) * k, (c.y - oy) * k - h, w, h);
    ctx.fillStyle = mine ? "#000000" : "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, (c.x - ox) * k + pad, (c.y - oy) * k - h / 2);
    ctx.restore();
  }

  renderStrokeSharp(ctx, stroke) {
    const pts = stroke.points;
    ctx.save();
    ctx.globalCompositeOperation = stroke.eraser
      ? "destination-out"
      : "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 6;
    const ox = this._rox,
      oy = this._roy,
      k = this._rs;
    ctx.lineWidth = stroke.size * k;
    ctx.strokeStyle = stroke.color;
    ctx.beginPath();
    ctx.moveTo((pts[0].x - ox) * k, (pts[0].y - oy) * k);
    for (let i = 1; i < pts.length; i++)
      ctx.lineTo((pts[i].x - ox) * k, (pts[i].y - oy) * k);
    if (pts.length === 1)
      ctx.lineTo((pts[0].x - ox) * k + (0.01 / this.zoom) * k, (pts[0].y - oy) * k);
    ctx.stroke();
    ctx.restore();
  }

  renderFilled(ctx, stroke) {
    const rings =
      Array.isArray(stroke.rings) && stroke.rings.length
        ? stroke.rings
        : [stroke.points];
    const ox = this._rox,
      oy = this._roy,
      k = this._rs;
    const path = new Path2D();
    for (const ring of rings) {
      if (!ring || ring.length < 3) continue;
      path.moveTo((ring[0].x - ox) * k, (ring[0].y - oy) * k);
      for (let i = 1; i < ring.length; i++)
        path.lineTo((ring[i].x - ox) * k, (ring[i].y - oy) * k);
      path.closePath();
    }
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = stroke.color;
    ctx.fill(path, "evenodd");
    if (stroke.size > 1) {
      ctx.lineWidth = stroke.size * k;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = stroke.color;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  drawSegmentsIncremental(stroke, fromIndex) {
    if (!this.isOpen) return;
    const pts = stroke.points;
    if (fromIndex >= pts.length) return;

    const ctx = this.ctx;
    const dpr = this.dpr;

    const centre = this.screenToWorld(
      this.displayWidth / 2,
      this.displayHeight / 2,
    );
    this._rox = centre.x;
    this._roy = centre.y;
    const S = Math.min(this.zoom, this.SAFE_CANVAS_SCALE);
    this._rs = this.zoom / S;
    const ox = this._rox,
      oy = this._roy,
      k = this._rs;

    // A remote stroke far outside a deep-zoomed view would hand the canvas
    // float32-breaking numbers; let the full redraw cull/clip it instead.
    const start = Math.max(0, fromIndex);
    let far = 0;
    for (let i = Math.max(0, start - 2); i < pts.length; i++) {
      const d = Math.max(Math.abs(pts[i].x - ox), Math.abs(pts[i].y - oy));
      if (d > far) far = d;
    }
    if (far * this.zoom > this.CLIP_DEVICE_LIMIT) {
      this.scheduleRedraw();
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(this.panX + ox * this.zoom, this.panY + oy * this.zoom);
    ctx.scale(S, S);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = stroke.size * k;

    if (stroke.eraser) {
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color;
    }

    if (!stroke.eraser && stroke.gradient && stroke.gradient.length >= 2) {
      this.renderGradientPieces(ctx, stroke, Math.max(1, start - 2));
      ctx.restore();
      return;
    }

    ctx.beginPath();
    ctx.moveTo((pts[start].x - ox) * k, (pts[start].y - oy) * k);
    for (let i = start + 1; i < pts.length; i++) {
      ctx.lineTo((pts[i].x - ox) * k, (pts[i].y - oy) * k);
    }
    ctx.stroke();

    ctx.restore();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  onPointerDown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    if (this.eyedropperActive) {
      const c = this.sampleCanvasColor(e);
      if (c) this.setColor(c, true);
      this.deactivateEyedropper();
      return;
    }

    if (this.inspectActive) {
      this.closeModCard();
      const hit = this.strokeAt(this.getCanvasPoint(e));
      if (!hit) {
        this.showHint("Nothing there - tap on a drawing");
        return;
      }
      if (hit.owner === this.userId) {
        this.showHint("That one is yours");
        return;
      }
      this._modTapAt = { x: e.clientX, y: e.clientY };
      this.showHint("Checking...");
      this.socket.emit("board who drew", { id: hit.id });
      return;
    }

    if (this.panMode || this._spaceDown || e.button === 1) {
      this.isPanning = true;
      this.panStart = {
        x: e.clientX,
        y: e.clientY,
        px: this.panX,
        py: this.panY,
      };
      this.canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button !== 0) return;

    if (this.isBarredForDrawing()) return;

    if (this.tool === "claim") {
      this.shapeStart = this.getCanvasPoint(e);
      this.preview = null;
      return;
    }

    if (this.blockedByClaim(this.getCanvasPoint(e))) return;

    if (this.tool === "bucket") {
      const rect = this.canvas.getBoundingClientRect();
      this.bucketFill({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      return;
    }

    if (this.isShapeTool()) {
      this.shapeStart = this.getCanvasPoint(e);
      this.preview = null;
      return;
    }

    this.startStrokeAt(this.getCanvasPoint(e));
  }

  // The size slider is in screen pixels at the moment you paint: a size-3 pen
  // looks 3px wide at any zoom, so zooming deep in gives finer world detail.
  worldBrushSize() {
    return this.size / this.zoom;
  }

  startStrokeAt(pt) {
    this.drawing = true;
    this._penLifted = false;
    this.lastPoint = pt;

    const id = this.nextStrokeId();
    const gradient = this.eraser ? null : this.gradient;
    const size = this.worldBrushSize();
    this.currentStroke = {
      id,
      owner: this.userId,
      points: [pt],
      color: this.color,
      size,
      eraser: this.eraser,
      gradient,
    };

    this.socket.emit("board stroke start", {
      id,
      point: pt,
      color: this.color,
      size,
      eraser: this.eraser,
      gradient,
    });

    this.pointBuffer = [];
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL);
    }
  }

  liftPenAtFence() {
    this.flush();
    this.socket.emit("board stroke end");
    if (this.currentStroke) {
      this.strokes.push(this.currentStroke);
      this.undoStack.push(this.currentStroke.id);
      this.redoStack = [];
      this.updateUndoRedoButtons();
      this.currentStroke = null;
    }
    this.drawing = false;
    this._penLifted = true;
  }

  onPointerMove(e) {
    if (this._gesturing) return;

    this.sendCursorPosition(e);

    if (this.isPanning && this.panStart) {
      this.panX = this.panStart.px + (e.clientX - this.panStart.x);
      this.panY = this.panStart.py + (e.clientY - this.panStart.y);
      this.scheduleRedraw();
      return;
    }

    if (this.shapeStart) {
      const end = this.constrainPoint(
        this.shapeStart,
        this.getCanvasPoint(e),
        this.tool,
        e.shiftKey,
      );
      this.preview = {
        kind: this.tool === "claim" ? "rect" : this.tool,
        a: this.shapeStart,
        b: end,
        claim: this.tool === "claim",
      };
      this.scheduleRedraw();
      return;
    }

    if (this.drawing || this._penLifted) {
      const pt = this.getCanvasPoint(e);
      const from = this.lastPoint || pt;
      if (this.claimCrossed(from, pt)) {
        if (this.drawing) {
          this.liftPenAtFence();
          const c = this.foreignClaimAt(pt) || this.claimCrossed(from, pt);
          this.showHint("That is " + ((c && c.name) || "someone") + "'s area");
        }
        this.lastPoint = pt;
        return;
      }
      if (this._penLifted) {
        this._penLifted = false;
        this.startStrokeAt(pt);
        return;
      }
    }

    if (!this.drawing) return;
    e.preventDefault();

    const pt = this.getCanvasPoint(e);

    if (this.currentStroke && this.currentStroke.points.length > 0) {
      const last =
        this.currentStroke.points[this.currentStroke.points.length - 1];
      const dx = pt.x - last.x;
      const dy = pt.y - last.y;
      // Screen-space threshold: world distances shrink with zoom, so the
      // comparison has to shrink too or deep-zoom strokes lose every point.
      const zz = this.zoom * this.zoom;
      if ((dx * dx + dy * dy) * zz < this.MIN_POINT_DISTANCE_SQ) return;
    }

    if (this.currentStroke) {
      this.currentStroke.points.push(pt);
      this.drawSegmentsIncremental(
        this.currentStroke,
        this.currentStroke.points.length - 2,
      );
    }
    this.lastPoint = pt;

    this.pointBuffer.push(pt);
  }

  onPointerUp(e) {
    this._penLifted = false;

    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
      this.updateCursor();
      return;
    }

    if (this.shapeStart) {
      const start = this.shapeStart;
      const end = this.getCanvasPoint(e);
      this.shapeStart = null;
      this.preview = null;
      if (this.tool === "claim") {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        if (w >= 20 && h >= 20)
          this.socket.emit("board claim", { x, y, w, h });
        this.scheduleRedraw();
        return;
      }
      this.commitShape(this.tool, start, end, e.shiftKey);
      this.scheduleRedraw();
      return;
    }

    if (!this.drawing) return;
    this.drawing = false;
    this.lastPoint = null;

    this.flush();

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.socket.emit("board stroke end");

    if (this.currentStroke) {
      this.strokes.push(this.currentStroke);
      this.undoStack.push(this.currentStroke.id);
      this.redoStack = [];
      this.updateUndoRedoButtons();
      this.currentStroke = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  flush() {
    if (this.pointBuffer.length === 0) return;
    const points = this.pointBuffer.splice(0);
    this.socket.emit("board stroke move", { points });
  }

  sendCursorPosition(e) {
    const now = Date.now();
    if (now - this.cursorThrottle < this.CURSOR_SEND_INTERVAL) return;
    this.cursorThrottle = now;
    const pt = this.getCanvasPoint(e);
    if (this.watching) return;
    this.socket.emit("board cursor", { x: pt.x, y: pt.y });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  handleRemoteStrokeStart(data) {
    if (data.userId === this.userId) return;

    const stroke = {
      id: data.id,
      owner: data.userId,
      points: [data.point],
      color: data.color || "#000000",
      size: data.size || 3,
      eraser: !!data.eraser,
      gradient:
        Array.isArray(data.gradient) && data.gradient.length >= 2
          ? data.gradient
          : null,
    };

    if (!stroke.eraser) this.notePeerColor(data.userId, stroke.color);

    this.finalizeRemoteStroke(data.userId);

    this.remoteActiveStrokes.set(data.userId, stroke);

    if (this.isOpen) {
      const ctx = this.ctx;
      const dpr = this.dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.translate(this.panX, this.panY);
      ctx.scale(this.zoom, this.zoom);

      ctx.beginPath();
      ctx.arc(data.point.x, data.point.y, stroke.size / 2, 0, Math.PI * 2);
      if (stroke.eraser) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,1)";
      } else {
        ctx.fillStyle = stroke.gradient
          ? this.strokeSegmentColor(stroke, 0)
          : stroke.color;
      }
      ctx.fill();
      ctx.restore();
    }
  }

  handleRemoteStrokeMove(data) {
    if (data.userId === this.userId) return;

    const stroke = this.remoteActiveStrokes.get(data.userId);
    if (!stroke) return;

    const prevLen = stroke.points.length;
    for (const p of data.points) {
      stroke.points.push(p);
    }

    if (this.isOpen && prevLen > 0) {
      this.drawSegmentsIncremental(stroke, prevLen - 1);
    }
  }

  handleRemoteStrokeEnd(data) {
    if (data.userId === this.userId) return;
    this.finalizeRemoteStroke(data.userId);
  }

  handleRemoteStrokeRemove(data) {
    if (!data || !data.id) return;
    const idx = this.strokes.findIndex((s) => s.id === data.id);
    if (idx !== -1) this.strokes.splice(idx, 1);
    if (this.isOpen) this.redraw();
  }

  handleRemoteStrokeAdd(data) {
    if (!data || data.userId === this.userId) return;
    const s = data.stroke;
    if (!s || !s.points || s.points.length === 0) return;
    if (s.id && this.strokes.some((x) => x.id === s.id)) return;
    this.strokes.push(s);
    if (!s.eraser) this.notePeerColor(data.userId, s.color);
    if (this.isOpen) this.redraw();
  }

  finalizeRemoteStroke(userId) {
    const stroke = this.remoteActiveStrokes.get(userId);
    if (stroke && stroke.points.length > 0) {
      this.strokes.push(stroke);
    }
    this.remoteActiveStrokes.delete(userId);
  }

  handleBoardState(data) {
    this.strokes = [];
    this.remoteActiveStrokes.clear();
    this.setClaims(data.claims);

    if (data.strokes && Array.isArray(data.strokes)) {
      for (const s of data.strokes) {
        if (s && s.points && s.points.length > 0) {
          this.strokes.push(s);
          if (s.owner && !s.eraser) this.notePeerColor(s.owner, s.color);
        }
      }
    }

    if (data.active && typeof data.active === "object") {
      for (const [uid, s] of Object.entries(data.active)) {
        if (uid !== this.userId && s && s.points && s.points.length > 0) {
          this.remoteActiveStrokes.set(uid, s);
          if (!s.eraser) this.notePeerColor(uid, s.color);
        }
      }
    }

    if (this.isOpen) this.redraw();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  _now() {
    return window.performance && performance.now
      ? performance.now()
      : Date.now();
  }

  updateRemoteCursor(data) {
    let cursor = this.remoteCursors.get(data.userId);

    if (!cursor) {
      const el = document.createElement("div");
      el.className = "tb-remote-cursor";

      const dot = document.createElement("div");
      dot.className = "tb-cursor-dot";

      const label = document.createElement("span");
      label.className = "tb-cursor-label";
      label.textContent = data.username || "User";

      el.appendChild(dot);
      el.appendChild(label);
      this.cursorLayer.appendChild(el);

      cursor = { el, dot, buf: [], lastSeen: 0, username: data.username };
      this.remoteCursors.set(data.userId, cursor);
    }

    const col = this.peerColors.get(data.userId);
    if (col && cursor.dot) cursor.dot.style.background = col;

    const now = this._now();
    cursor.buf.push({ t: now, x: data.x, y: data.y });
    if (cursor.buf.length > 120) cursor.buf.splice(0, cursor.buf.length - 120);
    cursor.lastSeen = now;
    this._ensureCursorLoop();
  }

  _ensureCursorLoop() {
    if (this._cursorRaf == null && this.isOpen) {
      this._cursorRaf = requestAnimationFrame(() => this._cursorFrame());
    }
  }

  _cursorFrame() {
    this._cursorRaf = null;
    if (!this.isOpen) return;
    const now = this._now();
    const renderTime = now - this.CURSOR_RENDER_DELAY;
    let live = false;
    for (const [, c] of this.remoteCursors) {
      if (now - c.lastSeen > this.CURSOR_TIMEOUT) {
        if (c.el.style.display !== "none") c.el.style.display = "none";
        continue;
      }
      live = true;
      const pos = this._sampleCursor(c.buf, renderTime);
      if (pos) {
        const s = this.worldToScreen(pos.x, pos.y);
        const visible =
          s.x >= -60 && s.x <= this.displayWidth + 60 &&
          s.y >= -60 && s.y <= this.displayHeight + 60;
        if (visible) {
          c.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
          if (c.el.style.display !== "block") c.el.style.display = "block";
        } else if (c.el.style.display !== "none") {
          c.el.style.display = "none";
        }
      }
      this._pruneCursorBuf(c.buf, renderTime);
    }
    if (live) this._cursorRaf = requestAnimationFrame(() => this._cursorFrame());
  }

  _sampleCursor(buf, renderTime) {
    const n = buf.length;
    if (n === 0) return null;
    if (n === 1 || renderTime <= buf[0].t) return { x: buf[0].x, y: buf[0].y };
    for (let i = n - 1; i > 0; i--) {
      const a = buf[i - 1],
        b = buf[i];
      if (a.t <= renderTime && renderTime <= b.t) {
        const span = b.t - a.t;
        const f = span > 0 ? (renderTime - a.t) / span : 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    const b = buf[n - 1];
    return { x: b.x, y: b.y };
  }

  _pruneCursorBuf(buf, renderTime) {
    let lo = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].t <= renderTime) lo = i;
      else break;
    }
    const drop = Math.min(lo, Math.max(0, buf.length - 2));
    if (drop > 0) buf.splice(0, drop);
  }

  removeRemoteCursor(userId) {
    const cursor = this.remoteCursors.get(userId);
    if (cursor) {
      if (cursor.el.parentNode) cursor.el.parentNode.removeChild(cursor.el);
      this.remoteCursors.delete(userId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  sendChat(text) {
    if (!this.canSendChat()) return;
    this.socket.emit("board chat", { text });
  }

  nameColor(userId) {
    const known = this.peerColors.get(userId);
    if (known) return this.readableColor(known);
    let h = 0;
    const s = String(userId || "x");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360}, 65%, 38%)`;
  }

  readableColor(color) {
    const hex = this.normalizeHex(color);
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255,
      g = (n >> 8) & 255,
      b = n & 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum <= 0.5) return color;
    const rn = r / 255,
      gn = g / 255,
      bn = b / 255;
    const max = Math.max(rn, gn, bn),
      min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0,
      sat = 0;
    if (d !== 0) {
      sat = d / (1 - Math.abs(2 * l - 1));
      if (max === rn) h = ((((gn - bn) / d) % 6) + 6) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
    }
    const nl = Math.min(l, 0.4);
    return `hsl(${Math.round(h)}, ${Math.round(sat * 100)}%, ${Math.round(nl * 100)}%)`;
  }

  _appendChat(node) {
    const log = this.chatLog;
    const nearBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    this.chatNodes.push(node);
    log.appendChild(node);
    while (this.chatNodes.length > this.MAX_CHAT_MESSAGES) {
      const old = this.chatNodes.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  addChatMessage(data) {
    if (!data || typeof data.text !== "string") return;
    if (data.userId && data.username)
      this.notePeerName(data.userId, data.username);

    const isSelf = data.userId === this.userId;
    const col = isSelf ? "#c25e00" : this.nameColor(data.userId);

    const msg = document.createElement("div");
    msg.className = "tb-chat-msg" + (isSelf ? " tb-chat-self" : "");

    const name = document.createElement("span");
    name.className = "tb-chat-name";
    name.textContent = data.username || "User";
    name.style.color = col;

    const text = document.createElement("span");
    text.className = "tb-chat-text";
    text.textContent = " " + data.text;

    msg.appendChild(name);
    msg.appendChild(text);
    this._appendChat(msg);

    if (!this.chatOpen && data.userId !== this.userId) {
      this.chatUnread++;
      this.updateChatBadge();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  setupSocketListeners() {
    // ── Stroke lifecycle (v2) ────────────────────────────────────────
    this.socket.on("board stroke start", (data) =>
      this.handleRemoteStrokeStart(data),
    );
    this.socket.on("board stroke move", (data) =>
      this.handleRemoteStrokeMove(data),
    );
    this.socket.on("board stroke end", (data) =>
      this.handleRemoteStrokeEnd(data),
    );

    // ── Undo / redo sync (v3) ───────────────────────────────────────
    this.socket.on("board stroke remove", (data) =>
      this.handleRemoteStrokeRemove(data),
    );
    this.socket.on("board stroke add", (data) =>
      this.handleRemoteStrokeAdd(data),
    );

    // ── Full state sync ─────────────────────────────────────────────
    this.socket.on("board state", (data) => this.handleBoardState(data));

    // ── Staff: answer to "who drew this" ────────────────────────────
    this.socket.on("board stroke author", (data) => {
      if (!data) return;
      if (data.unknown || !data.userId)
        return this.showHint("Nothing on record for that one");
      if (data.username) this.notePeerName(data.userId, data.username);
      this.openModCard(data);
    });

    this.socket.on("board user wiped", (data) => {
      if (!data || !data.userId) return;
      const before = this.strokes.length;
      this.strokes = this.strokes.filter((s) => s.owner !== data.userId);
      this.remoteActiveStrokes.delete(data.userId);
      if (data.userId === this.userId) {
        this.undoStack = [];
        this.redoStack = [];
        this.currentStroke = null;
        this.drawing = false;
        this.updateUndoRedoButtons();
        this.showHint("A moderator erased your drawings");
      } else if (before !== this.strokes.length) {
        const name = this.peerNames.get(data.userId);
        this.showHint(
          name
            ? "Erased everything " + name + " drew"
            : "A moderator erased someone's drawings",
        );
      }
      if (this.isOpen) this.redraw();
    });

    this.socket.on("board barred", (data) => {
      this.barredUntil = (data && data.until) || Date.now() + 10 * 60 * 1000;
      if (this.currentStroke) {
        this.strokes = this.strokes.filter((s) => s !== this.currentStroke);
        this.currentStroke = null;
      }
      this.drawing = false;
      this.lastPoint = null;
      const msg =
        "A moderator has taken you off the board for " +
        this.barredMinutes() +
        " minutes.";
      if (this.isOpen) {
        this.showHint(msg);
        setTimeout(() => this.close(), 1600);
      } else if (window.toastr) {
        toastr.warning(msg, "Board");
      }
    });

    this.socket.on("board too fast", (data) => {
      const id = data && data.id;
      if (id) {
        this.strokes = this.strokes.filter((s) => s.id !== id);
        this.undoStack = this.undoStack.filter((x) => x !== id);
        this.updateUndoRedoButtons();
        this.scheduleRedraw();
      }
      this.showHint(
        (data && data.message) || "Too many shapes at once - give it a second",
      );
    });

    // ── Claimed areas ────────────────────────────────────────────────
    this.socket.on("board claims", (d) => this.setClaims(d && d.claims));

    this.socket.on("board claim result", (d) => {
      if (!d) return;
      this.showHint(
        d.ok ? "This area is yours now" : d.message || "Cannot claim that",
      );
      if (d.ok) this.setTool("pen");
    });

    this.socket.on("board blocked", (d) => {
      const id = d && d.id;
      if (id) {
        this.strokes = this.strokes.filter((s) => s.id !== id);
        this.undoStack = this.undoStack.filter((x) => x !== id);
        this.updateUndoRedoButtons();
        this.scheduleRedraw();
      }
      this.showHint("That is " + ((d && d.name) || "someone") + "'s area");
    });

    this.socket.on("board allowed", () => {
      this.barredUntil = 0;
      if (window.toastr) toastr.info("You can draw on the board again.", "Board");
    });

    // ── Clear ────────────────────────────────────────────────────────
    this.socket.on("board clear", () => {
      this.strokes = [];
      this.currentStroke = null;
      this.remoteActiveStrokes.clear();
      this.undoStack = [];
      this.redoStack = [];
      this.updateUndoRedoButtons();
      if (this.isOpen) this.redraw();
    });

    // ── Cursors ──────────────────────────────────────────────────────
    this.socket.on("board cursor", (data) => {
      if (data.userId === this.userId) return;
      this.notePeerName(data.userId, data.username);
      this.updateRemoteCursor(data);
    });

    // ── Chat ─────────────────────────────────────────────────────────
    this.socket.on("board chat", (data) => {
      this.addChatMessage(data);
    });

    // ── User left room ──────────────────────────────────────────────
    this.socket.on("user left", (userId) => {
      this.removeRemoteCursor(userId);
      this.finalizeRemoteStroke(userId);
      this.peerColors.delete(userId);
      this.peerNames.delete(userId);
      if (this.colorPanel && this.colorPanel.classList.contains("show"))
        this.renderUserColors();
    });

    this.socket.on("board user status", (data) => {
      if (!data.open) {
        this.removeRemoteCursor(data.userId);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════

  destroy() {
    if (this.isOpen) this.close();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this._cursorRaf != null) {
      cancelAnimationFrame(this._cursorRaf);
      this._cursorRaf = null;
    }
    if (this._redrawRaf != null) {
      cancelAnimationFrame(this._redrawRaf);
      this._redrawRaf = null;
    }
    document.removeEventListener("keydown", this._escHandler);
    document.removeEventListener("keydown", this._undoKeyHandler);
    document.removeEventListener("keydown", this._spaceHandler);
    document.removeEventListener("keyup", this._spaceHandler);
    window.removeEventListener("resize", this._resizeHandler);
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}

window.Talkoboard = Talkoboard;
