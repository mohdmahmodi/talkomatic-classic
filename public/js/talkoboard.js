// talkoboard.js v4.0 - Collaborative whiteboard for Talkomatic
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
    this.MIN_ZOOM = 1e-5;
    this.MAX_ZOOM = 1e9;
    this.wheelMode = "zoom";
    try {
      if (localStorage.getItem("tb_wheel") === "pan") this.wheelMode = "pan";
    } catch (_) {}
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
    this.addSystemChat(text);
    setTimeout(() => {
      this.chatCooldownActive = false;
    }, 1000);
  }

  makeBtn(className, label, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    if (label != null) b.innerHTML = label;
    if (title) b.title = title;
    return b;
  }

  icon(name) {
    return '<i class="fas ' + name + '"></i>';
  }

  // One full-screen canvas with the controls floating over it: name and close
  // top left, tools top centre, chat and save top right, zoom and history
  // bottom left. Phones move the tools to the bottom edge.
  buildModal() {
    this.modal = document.createElement("div");
    this.modal.id = "talkoboardModal";
    this.modal.className = "tb-overlay";

    const stage = document.createElement("div");
    stage.className = "tb-stage";
    this.canvas = document.createElement("canvas");
    this.canvas.id = "tbCanvas";
    this.ctx = this.canvas.getContext("2d");
    this.cursorLayer = document.createElement("div");
    this.cursorLayer.className = "tb-cursor-layer";
    stage.appendChild(this.canvas);
    stage.appendChild(this.cursorLayer);
    this.canvasWrap = stage;

    const panel = (cls) => {
      const p = document.createElement("div");
      p.className = "tb-panel " + cls;
      p.addEventListener("pointerdown", (e) => e.stopPropagation());
      return p;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "tb-sep";
      return s;
    };
    this.toolBtns = {};
    const tool = (name, fa, title, cls) => {
      const b = this.makeBtn("tb-btn" + (cls ? " " + cls : ""), this.icon(fa), title);
      b.addEventListener("click", () => this.setTool(name));
      this.toolBtns[name] = b;
      return b;
    };

    const brand = panel("tb-brand");
    brand.innerHTML = this.icon("fa-paintbrush") + "<span>Talkoboard</span>";
    this.saveBtn = this.makeBtn("tb-btn", this.icon("fa-download"), "Save as image");
    this.saveBtn.addEventListener("click", () => this.togglePop("save"));
    brand.appendChild(this.saveBtn);

    const tools = panel("tb-tools");
    this.panBtn = tool("pan", "fa-hand", "Move around (H, or hold Space)");
    this.penBtn = tool("pen", "fa-pen", "Pen (P)");
    this.eraserBtn = tool("eraser", "fa-eraser", "Eraser (E)");
    const shapes = [
      tool("line", "fa-slash", "Line (L), Shift snaps the angle"),
      tool("rect", "fa-square", "Rectangle (R), Shift for a square"),
      tool("ellipse", "fa-circle", "Ellipse (O), Shift for a circle"),
      tool("triangle", "fa-play", "Triangle (T)"),
    ];
    shapes[3].querySelector("i").style.transform = "rotate(-90deg)";
    this.fillBtn = this.makeBtn("tb-btn off", this.icon("fa-fill"), "Filled shapes");
    this.fillBtn.addEventListener("click", () => this.setFillShapes(!this.fillShapes));
    const bucket = tool("bucket", "fa-fill-drip", "Fill a closed area (B)");
    const claim = tool("claim", "fa-vector-square", "Claim an area only you can draw in");
    this.releaseBtn = this.makeBtn("tb-btn", this.icon("fa-square-xmark"), "Give your area back");
    this.releaseBtn.addEventListener("click", () => this.socket.emit("board unclaim", {}));
    this.releaseBtn.style.display = "none";

    this.colorBtn = this.makeBtn("tb-btn tb-color-btn", "", "Color (C)");
    this.colorSwatch = document.createElement("span");
    this.colorSwatch.className = "tb-color-current";
    this.colorSwatch.style.background = this.color;
    this.colorBtn.appendChild(this.colorSwatch);
    this.colorBtn.addEventListener("click", () => this.togglePop("color"));

    this.sizeBtn = this.makeBtn("tb-btn tb-size-btn", "", "Brush size (S)");
    this.sizeDot = document.createElement("span");
    this.sizeDot.className = "tb-size-dot";
    this.sizeBtn.appendChild(this.sizeDot);
    this.sizeBtn.addEventListener("click", () => this.togglePop("size"));

    const drawTools = [
      this.penBtn,
      this.eraserBtn,
      sep(),
      ...shapes,
      this.fillBtn,
      bucket,
      sep(),
      claim,
      this.releaseBtn,
      sep(),
      this.colorBtn,
      this.sizeBtn,
    ];
    tools.appendChild(this.panBtn);
    for (const el of drawTools) tools.appendChild(el);
    if (this.isStaff) {
      this.inspectBtn = tool(
        "inspect",
        "fa-user-shield",
        "Mod tools: tap a drawing to see who made it",
        "tb-mod-btn",
      );
      tools.appendChild(sep());
      tools.appendChild(this.inspectBtn);
    }

    const actions = panel("tb-actions");
    this.chatFab = this.makeBtn(
      "tb-btn",
      this.icon("fa-comment") + '<span class="tb-chat-badge"></span>',
      "Chat",
    );
    this.chatFab.addEventListener("click", () =>
      this.chatOpen ? this.closeChat() : this.openChat(),
    );
    const closeBtn = this.makeBtn("tb-btn", this.icon("fa-xmark"), "Close (Esc)");
    closeBtn.addEventListener("click", () => this.close());
    actions.appendChild(this.chatFab);
    actions.appendChild(closeBtn);

    const view = panel("tb-zoom");
    const zoomOut = this.makeBtn("tb-btn", this.icon("fa-minus"), "Zoom out (- or Ctrl+-)");
    this.zoomLabel = this.makeBtn("tb-zoom-label", "100%", "Back to 100% (0)");
    const zoomIn = this.makeBtn("tb-btn", this.icon("fa-plus"), "Zoom in (+ or Ctrl++)");
    const fitBtn = this.makeBtn("tb-btn", this.icon("fa-expand"), "Fit the drawing on screen (F)");
    zoomOut.addEventListener("click", () => this.adjustZoom(-0.15));
    zoomIn.addEventListener("click", () => this.adjustZoom(0.15));
    this.zoomLabel.addEventListener("click", () => this.resetView());
    fitBtn.addEventListener("click", () => this.fitToView());
    this.wheelBtn = this.makeBtn("tb-btn", "", "");
    this.wheelBtn.addEventListener("click", () =>
      this.setWheelMode(this.wheelMode === "zoom" ? "pan" : "zoom"),
    );
    for (const el of [zoomOut, this.zoomLabel, zoomIn, sep(), fitBtn, this.wheelBtn])
      view.appendChild(el);
    this.setWheelMode(this.wheelMode);

    const history = panel("tb-history");
    this.undoBtn = this.makeBtn("tb-btn", this.icon("fa-rotate-left"), "Undo (Ctrl+Z)");
    this.redoBtn = this.makeBtn("tb-btn", this.icon("fa-rotate-right"), "Redo (Ctrl+Y)");
    this.undoBtn.addEventListener("click", () => this.undo());
    this.redoBtn.addEventListener("click", () => this.redo());
    history.appendChild(this.undoBtn);
    history.appendChild(this.redoBtn);

    this.watchHide = drawTools.concat([history]);

    this.hintEl = document.createElement("div");
    this.hintEl.className = "tb-hint";

    for (const el of [stage, brand, tools, actions, view, history, this.hintEl])
      this.modal.appendChild(el);
    this.pops = {};
    this.buildColorPanel(this.modal);
    this.colorPanel.classList.add("tb-pop");
    this.pops.color = { panel: this.colorPanel, btn: this.colorBtn };
    this.buildSizePanel(this.modal);
    this.buildSavePanel(this.modal);
    this.buildChat(this.modal);
    document.body.appendChild(this.modal);

    this.updateUndoRedoButtons();
    this.bindCanvasEvents();
    this.setTool("pen");
    this.setWatching(this.watching);
  }

  // Flips between drawing and read-only watching in place - the same board
  // instance survives being moved to spectating (AFK) and joining back.
  setWatching(on) {
    this.watching = !!on;
    for (const el of this.watchHide || [])
      if (el) el.style.display = this.watching ? "none" : "";
    if (this.watching) this.setTool("pan");
    else this.setClaims(this.claims);
  }

  buildSizePanel(parent) {
    const panel = document.createElement("div");
    panel.className = "tb-pop tb-size-panel";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    const title = document.createElement("div");
    title.className = "tb-pop-title";
    title.textContent = "Brush size";
    const row = document.createElement("div");
    row.className = "tb-size-row";
    this.sizeInput = document.createElement("input");
    this.sizeInput.type = "range";
    this.sizeInput.min = "1";
    this.sizeInput.max = "30";
    this.sizeInput.addEventListener("input", (e) => this.setSize(+e.target.value));
    this.sizeLabel = document.createElement("span");
    this.sizeLabel.className = "tb-size-label";
    row.appendChild(this.sizeInput);
    row.appendChild(this.sizeLabel);
    const presets = document.createElement("div");
    presets.className = "tb-size-presets";
    this.sizePresetEls = [];
    for (const n of [2, 4, 8, 14, 22]) {
      const b = this.makeBtn("tb-size-preset", "", n + " px");
      const dot = document.createElement("span");
      dot.style.width = dot.style.height = Math.min(22, n + 3) + "px";
      b.appendChild(dot);
      b.addEventListener("click", () => this.setSize(n));
      presets.appendChild(b);
      this.sizePresetEls.push({ el: b, n });
    }
    panel.appendChild(title);
    panel.appendChild(row);
    panel.appendChild(presets);
    parent.appendChild(panel);
    this.pops.size = { panel, btn: this.sizeBtn };
    this.setSize(this.size);
  }

  buildSavePanel(parent) {
    const panel = document.createElement("div");
    panel.className = "tb-pop tb-save-panel";
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    const title = document.createElement("div");
    title.className = "tb-pop-title";
    title.textContent = "Save as PNG";
    panel.appendChild(title);
    const option = (fa, label, note, mode) => {
      const b = this.makeBtn(
        "tb-save-opt",
        this.icon(fa) + "<span><b>" + label + "</b><small>" + note + "</small></span>",
      );
      b.addEventListener("click", () => {
        this.closePops();
        this.exportBoard(mode);
      });
      panel.appendChild(b);
    };
    option("fa-crop-simple", "What I can see", "This view, at twice the resolution", "view");
    option("fa-image", "The whole board", "Everything anyone drew, fitted into one image", "all");
    parent.appendChild(panel);
    this.pops.save = { panel, btn: this.saveBtn };
  }

  // Popovers hang off their toolbar button; opening one closes the rest.
  togglePop(name, force) {
    const pop = this.pops[name];
    if (!pop) return;
    const open = force != null ? !!force : !pop.panel.classList.contains("show");
    this.closePops();
    if (!open) return;
    pop.panel.classList.add("show");
    pop.btn.classList.add("active");
    if (name === "color") {
      this.renderRecentColors();
      this.renderUserColors();
    }
  }

  closePops() {
    for (const p of Object.values(this.pops || {})) {
      p.panel.classList.remove("show");
      p.btn.classList.remove("active");
    }
  }

  popOpen() {
    return Object.values(this.pops || {}).some((p) =>
      p.panel.classList.contains("show"),
    );
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
    this.togglePop("color", force);
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

  // ── Chat: a light panel docked on the right, a sheet on phones ───
  buildChat(parent) {
    const chat = document.createElement("div");
    chat.className = "tb-chat";
    chat.addEventListener("pointerdown", (e) => e.stopPropagation());

    const bar = document.createElement("div");
    bar.className = "tb-chat-bar";
    const title = document.createElement("span");
    title.className = "tb-chat-title";
    title.textContent = "Chat";
    const closeChatBtn = this.makeBtn("tb-btn", this.icon("fa-xmark"), "Hide chat");
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
    this.chatInput.placeholder = "Say something";
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submitChat();
      else if (e.key === "Escape") {
        this.closeChat();
        e.preventDefault();
      }
      e.stopPropagation();
    });
    this.chatSendBtn = this.makeBtn("tb-chat-send", this.icon("fa-paper-plane"), "Send");
    this.chatSendBtn.addEventListener("click", () => this.submitChat());
    inputRow.appendChild(this.chatInput);
    inputRow.appendChild(this.chatSendBtn);

    chat.appendChild(bar);
    chat.appendChild(this.chatLog);
    chat.appendChild(inputRow);
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
    this.closePops();
    this.chatOpen = true;
    this.chatEl.classList.add("open");
    this.chatFab.classList.add("active");
    this.chatUnread = 0;
    this.updateChatBadge();
    setTimeout(() => this.chatInput && this.chatInput.focus(), 30);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  closeChat() {
    this.chatOpen = false;
    this.chatEl.classList.remove("open");
    this.chatFab.classList.remove("active");
    this.chatInput.blur();
  }

  updateChatBadge() {
    const badge = this.chatFab.querySelector(".tb-chat-badge");
    badge.textContent = this.chatUnread > 9 ? "9+" : String(this.chatUnread);
    this.chatFab.classList.toggle("has-unread", this.chatUnread > 0);
  }

  bindCanvasEvents() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      this.closePops();
      this.onPointerDown(e);
    });
    c.addEventListener("pointermove", (e) => this.onPointerMove(e));
    for (const ev of ["pointerup", "pointerleave", "pointercancel"])
      c.addEventListener(ev, (e) => this.onPointerUp(e));

    c.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length < 2) e.preventDefault();
      },
      { passive: false },
    );
    c.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

    // A mouse wheel clicks in notches; a trackpad streams small deltas on
    // both axes. Notches zoom, trackpad scrolling moves the board, and a
    // pinch or Ctrl+wheel always zooms. Zoom scales with the delta, so a
    // gentle swipe gives a gentle zoom instead of a fixed jump per event.
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const pinch = e.ctrlKey || e.metaKey;
        const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40);
        if (pinch || (notch && this.wheelMode === "zoom")) return this.wheelZoom(e, pinch);
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        this.panX -= dx;
        this.panY -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        this.viewChanged();
      },
      { passive: false },
    );

    // Middle mouse drags the view from any tool.
    c.addEventListener("mousedown", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.isPanning || !this.panStart) return;
      this.panX = this.panStart.px + (e.clientX - this.panStart.x);
      this.panY = this.panStart.py + (e.clientY - this.panStart.y);
      this.viewChanged();
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 1) this.isPanning = false;
    });

    // Two fingers pan and pinch; a stroke in progress is dropped.
    let gesture = null;
    c.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 2) return;
        this._abortCurrentStroke();
        this._gesturing = true;
        this.isPanning = true;
        gesture = this.touchGesture(e.touches);
      },
      { passive: true },
    );
    c.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 2 || !gesture) return;
        const g = this.touchGesture(e.touches);
        this.panX += g.cx - gesture.cx;
        this.panY += g.cy - gesture.cy;
        if (gesture.dist > 0 && g.dist > 0) {
          const rect = c.getBoundingClientRect();
          this.zoomAt(this.zoom * (g.dist / gesture.dist), g.cx - rect.left, g.cy - rect.top);
        }
        gesture = g;
        this.viewChanged();
      },
      { passive: true },
    );
    const endGesture = (e) => {
      if (!gesture || (e.touches && e.touches.length >= 2)) return;
      gesture = null;
      this.isPanning = false;
      this._gesturing = false;
    };
    c.addEventListener("touchend", endGesture, { passive: true });
    c.addEventListener("touchcancel", endGesture, { passive: true });

    this._escHandler = (e) => {
      if (e.key !== "Escape" || !this.isOpen) return;
      if (this.isTypingTarget(e.target) && e.target !== this.chatInput) return;
      if (this.popOpen()) return this.closePops();
      if (this.chatOpen) return this.closeChat();
      this.close();
    };
    document.addEventListener("keydown", this._escHandler);

    const KEYS = {
      h: "pan",
      p: "pen",
      e: "eraser",
      l: "line",
      r: "rect",
      o: "ellipse",
      t: "triangle",
      b: "bucket",
    };
    this._keyHandler = (e) => {
      if (!this.isOpen || this.isTypingTarget(e.target) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === "z" && !e.shiftKey) this.undo();
        else if (k === "y" || (k === "z" && e.shiftKey)) this.redo();
        else if (k === "=" || k === "+") this.adjustZoom(0.15);
        else if (k === "-") this.adjustZoom(-0.15);
        else if (k === "0") this.resetView();
        else return;
        return e.preventDefault();
      }
      if (this.watching && (KEYS[k] || k === "c" || k === "s")) return;
      if (KEYS[k]) this.setTool(KEYS[k]);
      else if (k === "c") this.togglePop("color");
      else if (k === "s") this.togglePop("size");
      else if (k === "f") this.fitToView();
      else if (k === "=" || k === "+") this.adjustZoom(0.15);
      else if (k === "-") this.adjustZoom(-0.15);
      else if (k === "0") this.resetView();
      else if (k === " ") {
        this._spaceDown = true;
        this.updateCursor();
      } else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", this._keyHandler);
    this._keyUpHandler = (e) => {
      if (e.key !== " " || !this.isOpen) return;
      this._spaceDown = false;
      this.updateCursor();
    };
    document.addEventListener("keyup", this._keyUpHandler);

    this._resizeHandler = () => {
      if (!this.isOpen) return;
      this.resizeCanvas();
      this.redraw();
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
    // Watching is read-only: pan (plus the staff inspector) is all there is.
    // The server drops a spectator's strokes anyway; without this the canvas
    // still drew them locally, which read as "spectators can draw".
    if (this.watching && name !== "pan" && !(name === "inspect" && this.isStaff))
      name = "pan";
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

  setSize(n) {
    this.size = Math.max(1, Math.min(30, Math.round(n) || 1));
    if (this.sizeInput) this.sizeInput.value = String(this.size);
    if (this.sizeLabel) this.sizeLabel.textContent = this.size + " px";
    for (const p of this.sizePresetEls || [])
      p.el.classList.toggle("active", p.n === this.size);
    this.updateSizeDot();
    this.updateCursor();
  }

  updateSizeDot() {
    if (!this.sizeDot) return;
    const d = Math.max(4, Math.min(20, this.size + 2));
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

  // Mirrored sweep: t runs 0 -> 1 -> 0 over two periods, so the gradient
  // folds back on itself instead of snapping from the last color to the first.
  gradientT(i) {
    const p = this.GRADIENT_PERIOD;
    const c = ((i % (2 * p)) + 2 * p) % (2 * p);
    return c <= p ? c / p : (2 * p - c) / p;
  }

  strokeSegmentColor(stroke, i) {
    if (!stroke.gradient || stroke.gradient.length < 2) return stroke.color;
    return this.sampleGradient(stroke.gradient, this.gradientT(i));
  }

  // A two-stop canvas gradient across one drawn piece, from the previous
  // sample color to this one, so the color blends inside the piece rather
  // than stepping flat from piece to piece.
  segmentGradientStyle(ctx, stroke, i, x0, y0, x1, y1) {
    const a = this.strokeSegmentColor(stroke, i - 1);
    const b = this.strokeSegmentColor(stroke, i);
    if (a === b || (x0 === x1 && y0 === y1)) return b;
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
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

    clearTimeout(this._settleTimer);
    this.closePops();
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
    if (z < 0.1) return parseFloat((z * 100).toPrecision(2)) + "%";
    if (z < 10) return Math.round(z * 100) + "%";
    if (z < 1000) return Math.round(z) + "×";
    if (z < 1e6) return (z / 1000).toPrecision(3).replace(/\.?0+$/, "") + "k×";
    if (z < 1e9) return (z / 1e6).toPrecision(3).replace(/\.?0+$/, "") + "M×";
    return (z / 1e9).toPrecision(3).replace(/\.?0+$/, "") + "B×";
  }

  updateZoomLabel() {
    this.zoomLabel.textContent = this.formatZoom();
  }

  zoomAt(nz, ax, ay) {
    nz = Math.min(this.MAX_ZOOM, Math.max(this.MIN_ZOOM, nz));
    this.panX = ax - (ax - this.panX) * (nz / this.zoom);
    this.panY = ay - (ay - this.panY) * (nz / this.zoom);
    this.zoom = nz;
    this.updateZoomLabel();
  }

  wheelZoom(e, pinch) {
    const rect = this.canvas.getBoundingClientRect();
    const dy = Math.max(-150, Math.min(150, e.deltaY));
    const factor = Math.exp(-dy * (pinch ? 0.01 : 0.0028));
    this.zoomAt(this.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
    this.viewChanged();
  }

  setWheelMode(mode) {
    this.wheelMode = mode === "pan" ? "pan" : "zoom";
    try {
      localStorage.setItem("tb_wheel", this.wheelMode);
    } catch (_) {}
    if (!this.wheelBtn) return;
    const zoom = this.wheelMode === "zoom";
    this.wheelBtn.innerHTML = this.icon(zoom ? "fa-magnifying-glass" : "fa-arrows-up-down-left-right");
    this.wheelBtn.title = zoom
      ? "Scrolling zooms. Click to make it move the board instead. Ctrl+scroll, pinch, + and - always zoom."
      : "Scrolling moves the board. Click to make it zoom instead. Ctrl+scroll, pinch, + and - always zoom.";
  }

  adjustZoom(delta, e) {
    const rect = this.canvas.getBoundingClientRect();
    const ax = e && e.clientX != null ? e.clientX - rect.left : this.displayWidth / 2;
    const ay = e && e.clientY != null ? e.clientY - rect.top : this.displayHeight / 2;
    this.zoomAt(this.zoom * Math.pow(1.32, delta / 0.15), ax, ay);
    this.viewChanged();
  }

  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.updateZoomLabel();
    this.redraw();
  }

  allStrokes() {
    const all = this.strokes.slice();
    for (const [, s] of this.remoteActiveStrokes) all.push(s);
    if (this.currentStroke) all.push(this.currentStroke);
    return all;
  }

  boundsOf(strokes) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const s of strokes) {
      if (!s.points || !s.points.length) continue;
      const bb = this.strokeBB(s);
      const r = (s.size || 1) / 2 + 2;
      minX = Math.min(minX, bb.minX - r);
      minY = Math.min(minY, bb.minY - r);
      maxX = Math.max(maxX, bb.maxX + r);
      maxY = Math.max(maxY, bb.maxY + r);
    }
    if (!isFinite(minX)) return null;
    return {
      minX,
      minY,
      maxX,
      maxY,
      w: Math.max(1e-9, maxX - minX),
      h: Math.max(1e-9, maxY - minY),
    };
  }

  fitToView() {
    const bb = this.boundsOf(this.allStrokes());
    if (!bb) return this.showHint("Nothing to fit yet");
    const pad = 60;
    const z = Math.min(
      this.MAX_ZOOM,
      Math.max(
        this.MIN_ZOOM,
        Math.min((this.displayWidth - pad * 2) / bb.w, (this.displayHeight - pad * 2) / bb.h),
      ),
    );
    this.zoom = z;
    this.panX = this.displayWidth / 2 - ((bb.minX + bb.maxX) / 2) * z;
    this.panY = this.displayHeight / 2 - ((bb.minY + bb.maxY) / 2) * z;
    this.updateZoomLabel();
    this.redraw();
  }

  // Runs fn with another view in place, then puts the real one back.
  withView(v, fn) {
    const keep = [this.panX, this.panY, this.zoom, this.displayWidth, this.displayHeight];
    [this.panX, this.panY, this.zoom, this.displayWidth, this.displayHeight] = [
      v.panX,
      v.panY,
      v.zoom,
      v.w,
      v.h,
    ];
    try {
      fn();
    } finally {
      [this.panX, this.panY, this.zoom, this.displayWidth, this.displayHeight] = keep;
    }
  }

  // "view" saves the screen as it is, at double resolution. "all" fits every
  // stroke into one image, so one huge doodle far off in a corner shrinks
  // everything else; that is why the view save is offered first.
  exportBoard(mode) {
    const all = this.allStrokes();
    if (!all.length) return this.showHint("Nothing to save yet");
    let v;
    if (mode === "all") {
      const bb = this.boundsOf(all);
      const pad = 40;
      const long = Math.max(bb.w, bb.h);
      const zoom = Math.min((4096 - pad * 2) / long, Math.max(2, 1600 / long));
      v = {
        zoom,
        panX: pad - bb.minX * zoom,
        panY: pad - bb.minY * zoom,
        w: Math.ceil(bb.w * zoom + pad * 2),
        h: Math.ceil(bb.h * zoom + pad * 2),
        dpr: 1,
      };
    } else {
      v = {
        zoom: this.zoom,
        panX: this.panX,
        panY: this.panY,
        w: this.displayWidth,
        h: this.displayHeight,
        dpr: 2,
      };
    }
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(v.w * v.dpr));
    out.height = Math.max(1, Math.round(v.h * v.dpr));
    this.withView(v, () => this.paint(out.getContext("2d"), v.dpr, v.w, v.h, true));

    const finish = (url, revoke) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = "talkoboard.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.showHint("Saved");
    };
    if (out.toBlob)
      out.toBlob(
        (b) => (b ? finish(URL.createObjectURL(b), true) : finish(out.toDataURL("image/png"))),
        "image/png",
      );
    else finish(out.toDataURL("image/png"));
  }

  // Dragging and zooming move the last painted frame with a CSS transform and
  // paint properly once the gesture pauses, so the view keeps up however many
  // strokes are on the board.
  viewChanged() {
    const p = this._painted;
    if (!p) return this.scheduleRedraw();
    const s = this.zoom / p.zoom;
    if (s > 4 || s < 0.25) return this.redraw();
    this.canvas.style.transform = `translate(${this.panX - p.panX * s}px, ${this.panY - p.panY * s}px) scale(${s})`;
    this._viewTransformed = true;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this.redraw(), 80);
    this._ensureCursorLoop();
  }

  redraw() {
    clearTimeout(this._settleTimer);
    this.canvas.style.transform = "";
    this._viewTransformed = false;
    this._painted = { panX: this.panX, panY: this.panY, zoom: this.zoom };
    this.paint(this.ctx, this.dpr, this.displayWidth, this.displayHeight, false);
  }

  // Dots every 1, 2 or 5 world units times a power of ten, whichever lands
  // between 28 and 70 screen px, so the grid reads the same at any zoom.
  paintGrid(ctx, w, h) {
    const p = Math.pow(10, Math.floor(Math.log10(28 / this.zoom)));
    const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s * this.zoom >= 28);
    const sp = step * this.zoom;
    const ox = ((this.panX % sp) + sp) % sp;
    const oy = ((this.panY % sp) + sp) % sp;
    ctx.fillStyle = "#d5d7dc";
    for (let x = ox; x < w; x += sp)
      for (let y = oy; y < h; y += sp) ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  paint(ctx, dpr, w, h, plain) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    if (!plain) this.paintGrid(ctx, w, h);

    const centre = this.screenToWorld(w / 2, h / 2);
    this._rox = centre.x;
    this._roy = centre.y;
    const S = Math.min(this.zoom, this.SAFE_CANVAS_SCALE);
    this._rs = this.zoom / S;

    ctx.save();
    ctx.translate(this.panX + this._rox * this.zoom, this.panY + this._roy * this.zoom);
    ctx.scale(S, S);

    const view = this.viewWorldRect();
    for (const stroke of this.strokes) this.renderStrokeCulled(ctx, stroke, view);
    for (const [, stroke] of this.remoteActiveStrokes)
      this.renderStrokeCulled(ctx, stroke, view);
    if (this.currentStroke) this.renderStrokeCulled(ctx, this.currentStroke, view);

    if (!plain) {
      for (const c of this.claims) this.renderClaim(ctx, c);
      if (this.preview) this.renderPreview(ctx);
    }
    ctx.restore();
  }

  renderPreview(ctx) {
    const p = this.preview;
    if (p.claim)
      return this.renderClaim(ctx, {
        owner: this.userId,
        x: Math.min(p.a.x, p.b.x),
        y: Math.min(p.a.y, p.b.y),
        w: Math.abs(p.b.x - p.a.x),
        h: Math.abs(p.b.y - p.a.y),
      });
    this.renderStrokeSmooth(ctx, {
      points: this.shapePoints(p.kind, p.a, p.b),
      color: this.color,
      size: this.worldBrushSize(),
      eraser: false,
      gradient: this.gradient,
      fill: this.fillShapes && ["rect", "ellipse", "triangle"].includes(p.kind),
      sharp: p.kind !== "ellipse",
    });
  }

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
        const gx0 = (seg[0].x - rox) * k,
          gy0 = (seg[0].y - roy) * k;
        const gx1 = (seg[1].x - rox) * k,
          gy1 = (seg[1].y - roy) * k;
        ctx.strokeStyle = this.segmentGradientStyle(
          ctx,
          stroke,
          i,
          gx0,
          gy0,
          gx1,
          gy1,
        );
        ctx.beginPath();
        ctx.moveTo(gx0, gy0);
        ctx.lineTo(gx1, gy1);
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
      const x0 = (pts[0].x - ox) * k,
        y0 = (pts[0].y - oy) * k;
      const x1 = (pts[1].x - ox) * k,
        y1 = (pts[1].y - oy) * k;
      ctx.strokeStyle = this.segmentGradientStyle(ctx, stroke, 1, x0, y0, x1, y1);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      return;
    }
    const startI = Math.max(1, from);
    for (let i = startI; i <= n - 2; i++) {
      const s = i === 1 ? pts[0] : mid(pts[i - 1], pts[i]);
      const e = mid(pts[i], pts[i + 1]);
      const sx = (s.x - ox) * k,
        sy = (s.y - oy) * k;
      const ex = (e.x - ox) * k,
        ey = (e.y - oy) * k;
      ctx.strokeStyle = this.segmentGradientStyle(ctx, stroke, i, sx, sy, ex, ey);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo((pts[i].x - ox) * k, (pts[i].y - oy) * k, ex, ey);
      ctx.stroke();
    }
    const fs = mid(pts[n - 2], pts[n - 1]);
    const fx0 = (fs.x - ox) * k,
      fy0 = (fs.y - oy) * k;
    const fx1 = (pts[n - 1].x - ox) * k,
      fy1 = (pts[n - 1].y - oy) * k;
    ctx.strokeStyle = this.segmentGradientStyle(
      ctx,
      stroke,
      n - 1,
      fx0,
      fy0,
      fx1,
      fy1,
    );
    ctx.beginPath();
    ctx.moveTo(fx0, fy0);
    ctx.lineTo(fx1, fy1);
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
    if (this._viewTransformed) return this.scheduleRedraw();
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
      this.viewChanged();
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

    if (this.isOpen && !this._viewTransformed) {
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
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    this.chatNodes.push(node);
    log.appendChild(node);
    while (this.chatNodes.length > this.MAX_CHAT_MESSAGES) {
      const old = this.chatNodes.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  avatarNode(data) {
    const url =
      typeof avatarSrc === "function" && data.avatar ? avatarSrc(data.avatar, 64) : null;
    const el = document.createElement(url ? "img" : "span");
    el.className = "tb-msg-avatar";
    if (url) {
      el.src = url;
      el.alt = "";
      el.onerror = () => (el.style.visibility = "hidden");
    } else {
      el.textContent = (data.username || "?").trim().charAt(0).toUpperCase();
      el.style.background = this.nameColor(data.userId);
    }
    return el;
  }

  flairNode(role) {
    if (role === "dev") {
      const img = document.createElement("img");
      img.className = "tb-flair-crown";
      img.src = "images/icons/crown.gif";
      img.alt = "Dev";
      return img;
    }
    const level = { lead: 3, mod: 2, jr: 1 }[role];
    if (!level) return null;
    if (typeof createModBadge === "function") return createModBadge(level);
    const b = document.createElement("span");
    b.className = "mod-badge";
    b.textContent = role === "lead" ? "LEADER" : role === "jr" ? "JR MOD" : "MOD";
    return b;
  }

  addSystemChat(text) {
    const msg = document.createElement("div");
    msg.className = "tb-msg system";
    msg.textContent = text;
    this._appendChat(msg);
  }

  addChatMessage(data) {
    if (!data || typeof data.text !== "string") return;
    if (data.userId && data.username) this.notePeerName(data.userId, data.username);
    const mine = data.userId === this.userId;

    const msg = document.createElement("div");
    msg.className = "tb-msg" + (mine ? " mine" : "");
    msg.appendChild(this.avatarNode(data));

    const body = document.createElement("div");
    body.className = "tb-msg-body";
    const head = document.createElement("div");
    head.className = "tb-msg-head";
    const name = document.createElement("span");
    name.className = "tb-msg-name";
    name.textContent = data.username || "User";
    name.style.color = mine ? "#c25e00" : this.nameColor(data.userId);
    head.appendChild(name);
    const flair = this.flairNode(data.role);
    if (flair) head.appendChild(flair);
    const time = document.createElement("span");
    time.className = "tb-msg-time";
    time.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    head.appendChild(time);
    const text = document.createElement("div");
    text.className = "tb-msg-text";
    text.textContent = data.text;
    body.appendChild(head);
    body.appendChild(text);
    msg.appendChild(body);
    this._appendChat(msg);

    if (!this.chatOpen && !mine) {
      this.chatUnread++;
      this.updateChatBadge();
    }
  }

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
    clearTimeout(this._settleTimer);
    document.removeEventListener("keydown", this._escHandler);
    document.removeEventListener("keydown", this._keyHandler);
    document.removeEventListener("keyup", this._keyUpHandler);
    window.removeEventListener("resize", this._resizeHandler);
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}

window.Talkoboard = Talkoboard;
