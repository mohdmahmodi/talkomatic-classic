// piano-client.js v2.0 - Multiplayer Piano for Talkomatic
//

class Piano {
  constructor(socketRef, userId, username, opts) {
    this.socket = socketRef;
    this.userId = userId;
    this.username = username || "Anonymous";
    opts = opts || {};
    this.isStaff = !!(opts.isDev || opts.isMod);
    this.isOpen = false;
    this.mode = "room";

    // ── Audio graph ─────────────────────────────────────────────────────
    this.audioCtx = null;
    this.busIn = null;
    this.master = null;
    this.dry = null;
    this.wet = null;
    this.convolver = null;
    this.buffers = new Map();
    this.voices = new Map();
    this.sustain = false;
    this.volume = 0.85;
    this.samplesReady = false;
    this.loadingSamples = false;
    this.MAX_VOICES = 64;

    // ── Sound settings (synth/mixer) ────────────────────────────────────
    this.instrument = "piano";
    this.waveform = "triangle";
    this.attack = 0.01;
    this.release = 0.35;
    this.reverbOn = true;
    this.reverbAmount = 0.28;

    this.SAMPLE_NAMES = {
      21: "A0", 24: "C1", 27: "Ds1", 30: "Fs1", 33: "A1", 36: "C2",
      39: "Ds2", 42: "Fs2", 45: "A2", 48: "C3", 51: "Ds3", 54: "Fs3",
      57: "A3", 60: "C4", 63: "Ds4", 66: "Fs4", 69: "A4", 72: "C5",
      75: "Ds5", 78: "Fs5", 81: "A5", 84: "C6", 87: "Ds6", 90: "Fs6",
      93: "A6", 96: "C7", 99: "Ds7", 102: "Fs7", 105: "A7", 108: "C8",
    };
    this.sampleMidis = Object.keys(this.SAMPLE_NAMES).map(Number);
    this.nearest = [];
    for (let i = 0; i < 88; i++) {
      const midi = 21 + i;
      let best = this.sampleMidis[0];
      let bd = Infinity;
      for (const s of this.sampleMidis) {
        const d = Math.abs(s - midi);
        if (d < bd) { bd = d; best = s; }
      }
      this.nearest[i] = best;
    }

    // ── Input state ─────────────────────────────────────────────────────
    this.downKeys = new Set();
    this.pointerKey = new Map();
    this.kbKeys = new Map();
    this.octaveBase = 48;
    this.KEY_VELOCITY = 0.72;

    // ── Network batching ────────────────────────────────────────────────
    this.noteBuf = [];
    this.bufStart = 0;
    this.flushTimer = null;
    this.NOTE_FLUSH = 55;

    this.keyHolders = new Map();
    this.keyEls = new Array(88);
    this._dirtyKeys = new Set();
    this._visualRaf = null;
    this.MAX_LIGHT_MS = 12000;

    // ── Flood protection (one fast player must not lag the whole room) ───
    this._renderWin = { t: 0, n: 0 };
    this.MAX_RENDER_NOTES_PER_SEC = 240;
    this._selfWin = { t: 0, n: 0 };
    this.MAX_SELF_NOTES_PER_SEC = 360;
    this._sweepTimer = null;

    // ── Cursors (desktop single-row only) ───────────────────────────────
    this.cursors = new Map();
    this.cursorT = 0;
    this.CURSOR_INTERVAL = 40;
    this.CURSOR_RENDER_DELAY = 60;
    this.CURSOR_TIMEOUT = 3000;
    this._cursorRaf = null;
    this.isMultiRow = false;

    // ── Crown / mutes / participants ────────────────────────────────────
    this.crown = null;
    this.crownName = null;
    this.onlyOwner = false;
    this.mutedSet = new Set();
    this.selfMuted = false;
    this.participants = new Map();
    this.localMuted = new Set();

    // ── Chat ────────────────────────────────────────────────────────────
    this.chatNodes = [];
    this.MAX_CHAT_MESSAGES = 80;
    this.chatTimestamps = [];
    this.CHAT_MIN_INTERVAL = 1000;
    this.CHAT_BURST_WINDOW = 30000;
    this.CHAT_BURST_MAX = 10;
    this.chatCooldownActive = false;

    // ── MIDI ────────────────────────────────────────────────────────────
    this.midiAccess = null;
    this.midiCount = 0;

    this._savedChat = null;

    // ── Layout tunables (structure can't live in CSS) ───────────────────
    this.MOBILE_BREAKPOINT = 820;
    this._resizeRaf = null;

    this.buildModal();
    this.renderKeyboard();
    this.bindGlobalEvents();
    this.setupSocketListeners();
    this.applyMode();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  ic(name) {
    const i = document.createElement("i");
    i.className = "fas fa-" + name;
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  btn(cls, iconName, text, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    if (iconName) b.appendChild(this.ic(iconName));
    if (text) {
      const s = this.el("span", null, text);
      if (iconName) s.style.marginLeft = "6px";
      b.appendChild(s);
    }
    if (title) b.title = title;
    return b;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  ensureAudio() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.audioCtx = ctx;
      this.busIn = ctx.createGain();
      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.dry.gain.value = 1;
      this.wet.gain.value = this.reverbOn ? this.reverbAmount : 0;
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this.buildReverbImpulse(ctx, 2.2, 2.6);
      this.comp = ctx.createDynamicsCompressor();
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.busIn.connect(this.dry);
      this.dry.connect(this.master);
      this.busIn.connect(this.convolver);
      this.convolver.connect(this.wet);
      this.wet.connect(this.master);
      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);
      if (this.instrument === "piano") this.loadSamples();
    }
    if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(() => {});
  }

  buildReverbImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  async loadSamples() {
    if (this.samplesReady || this.loadingSamples || !this.audioCtx) return;
    this.loadingSamples = true;
    if (this.loadingEl && this.instrument === "piano")
      this.loadingEl.classList.add("show");
    const ctx = this.audioCtx;
    const entries = Object.entries(this.SAMPLE_NAMES);
    await Promise.all(
      entries.map(async ([midi, name]) => {
        try {
          const resp = await fetch(`/audio/piano/${name}.mp3`);
          if (!resp.ok) return;
          const arr = await resp.arrayBuffer();
          const buf = await new Promise((res, rej) => {
            const p = ctx.decodeAudioData(arr, res, rej);
            if (p && p.then) p.then(res, rej);
          });
          this.buffers.set(parseInt(midi, 10), buf);
        } catch (_) {
        }
      }),
    );
    this.samplesReady = this.buffers.size > 0;
    this.loadingSamples = false;
    if (this.loadingEl) this.loadingEl.classList.remove("show");
  }

  noteFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  playVoice(owner, index, velocity) {
    if (!this.audioCtx) return;
    const key = owner + "#" + index;
    const ex = this.voices.get(key);
    if (ex) this._fade(ex, 0.04);
    const voice =
      this.instrument === "synth"
        ? this._playSynth(index, velocity)
        : this._playSample(index, velocity);
    if (!voice) return;
    voice.owner = owner;
    voice.index = index;
    voice.t = this.audioCtx.currentTime;
    voice.pedal = false;
    this.voices.set(key, voice);
    if (voice.src) {
      voice.src.onended = () => {
        if (this.voices.get(key) === voice) this.voices.delete(key);
      };
    }
    if (this.voices.size > this.MAX_VOICES) this._stealOldest();
  }

  _playSample(index, velocity) {
    if (!this.samplesReady) return null;
    const sMidi = this.nearest[index];
    const buf = this.buffers.get(sMidi);
    if (!buf) return null;
    const ctx = this.audioCtx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (21 + index - sMidi) / 12);
    const g = ctx.createGain();
    g.gain.value = Math.max(0.05, Math.min(1, velocity || 0.6)) * 0.9;
    src.connect(g);
    g.connect(this.busIn);
    try { src.start(); } catch (_) {}
    return { src, g };
  }

  _playSynth(index, velocity) {
    const ctx = this.audioCtx;
    const freq = this.noteFreq(21 + index);
    const g = ctx.createGain();
    const now = ctx.currentTime;
    const peak = Math.max(0.04, Math.min(1, velocity || 0.6)) * 0.42;
    const a = Math.max(0.005, this.attack);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.7), now + a + 0.25);
    const o1 = ctx.createOscillator();
    o1.type = this.waveform;
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = this.waveform;
    o2.frequency.value = freq;
    o2.detune.value = 7;
    o1.connect(g);
    o2.connect(g);
    g.connect(this.busIn);
    try { o1.start(); o2.start(); } catch (_) {}
    return { oscs: [o1, o2], g };
  }

  releaseVoice(owner, index) {
    const key = owner + "#" + index;
    const voice = this.voices.get(key);
    if (!voice) return;
    if (owner === "self" && this.sustain) {
      voice.pedal = true;
      return;
    }
    this._fade(voice, voice.oscs ? Math.max(0.05, this.release) : 0.28);
    this.voices.delete(key);
  }

  setSustain(on) {
    on = !!on;
    if (this.sustain === on) return;
    this.sustain = on;
    if (this.sustainBtn) this.sustainBtn.classList.toggle("on", on);
    if (!on) {
      for (const [key, v] of this.voices) {
        if (v.owner === "self" && v.pedal) {
          this._fade(v, v.oscs ? Math.max(0.05, this.release) : 0.28);
          this.voices.delete(key);
        }
      }
    }
  }

  _fade(voice, time) {
    try {
      const now = this.audioCtx.currentTime;
      const g = voice.g.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + time);
      if (voice.src) voice.src.stop(now + time + 0.04);
      if (voice.oscs) voice.oscs.forEach((o) => { try { o.stop(now + time + 0.04); } catch (_) {} });
    } catch (_) {}
  }

  _stealOldest() {
    let oldestKey = null;
    let oldestT = Infinity;
    for (const [key, v] of this.voices) {
      if (v.t < oldestT) { oldestT = v.t; oldestKey = key; }
    }
    if (oldestKey) {
      this._fade(this.voices.get(oldestKey), 0.05);
      this.voices.delete(oldestKey);
    }
  }

  panic() {
    for (const [, v] of this.voices) this._fade(v, 0.06);
    this.voices.clear();
    this.keyHolders.clear();
    this._dirtyKeys.clear();
    if (this._visualRaf != null) {
      cancelAnimationFrame(this._visualRaf);
      this._visualRaf = null;
    }
    for (const el of this.keyEls) {
      if (el) { el.classList.remove("pressed"); el.style.removeProperty("--press"); }
    }
  }

  setReverb(on, amount) {
    this.reverbOn = !!on;
    if (typeof amount === "number") this.reverbAmount = amount;
    if (this.wet) this.wet.gain.value = this.reverbOn ? this.reverbAmount : 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  canPlay() {
    if (this.mode === "solo") return true;
    if (this.selfMuted) return false;
    if (this.onlyOwner && this.crown !== this.userId && !this.isStaff) return false;
    return true;
  }

  pressKey(index, velocity) {
    if (index < 0 || index > 87) return;
    if (!this.canPlay()) { this.flashLocked(); return; }
    if (this.downKeys.has(index)) return;
    this.downKeys.add(index);
    this.lightKey(index, true, "self");
    this.bouncePlayer(this.userId);
    this.bufferNote(index, velocity, false);
    if (this._allowSelfSound()) {
      this.ensureAudio();
      this.playVoice("self", index, velocity);
    }
  }

  _allowSelfSound() {
    const now = this._now();
    if (now - this._selfWin.t >= 1000) this._selfWin = { t: now, n: 0 };
    return ++this._selfWin.n <= this.MAX_SELF_NOTES_PER_SEC;
  }

  releaseKey(index) {
    if (!this.downKeys.has(index)) return;
    this.downKeys.delete(index);
    this.releaseVoice("self", index);
    this.lightKey(index, false, "self");
    this.bufferNote(index, null, true);
  }

  flashLocked() {
    if (this.keyboardWrap) {
      this.keyboardWrap.classList.remove("shake");
      void this.keyboardWrap.offsetWidth;
      this.keyboardWrap.classList.add("shake");
    }
    this.showHint(
      this.selfMuted
        ? "You have been muted"
        : "The crown holder locked the piano",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  bufferNote(index, velocity, isOff) {
    if (this.mode === "solo") return;
    const now = (window.performance || Date).now();
    if (this.noteBuf.length === 0) this.bufStart = now;
    const ev = { n: index, d: Math.max(0, Math.round(now - this.bufStart)) };
    if (isOff) ev.s = 1;
    else ev.v = Math.round((velocity || 0.6) * 1000) / 1000;
    this.noteBuf.push(ev);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushNotes(), this.NOTE_FLUSH);
    }
  }

  flushNotes() {
    if (this.noteBuf.length === 0) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      return;
    }
    const notes = this.noteBuf.splice(0);
    this.socket.emit("piano notes", { notes });
  }

  handleRemoteNotes(data) {
    if (!data || data.userId === this.userId || !Array.isArray(data.notes)) return;
    if (!this.isOpen || this.mode === "solo") return;
    const owner = data.userId;
    this.ensureAudio();
    const now = this._now();
    if (now - this._renderWin.t >= 1000) this._renderWin = { t: now, n: 0 };
    for (const ev of data.notes) {
      if (!ev || typeof ev.n !== "number") continue;
      const idx = ev.n | 0;
      if (idx < 0 || idx > 87) continue;
      if (ev.s === 1) {
        this.releaseVoice(owner, idx);
        this.lightKey(idx, false, owner);
        continue;
      }
      this.lightKey(idx, true, owner);
      this.bouncePlayer(owner);
      if (this.localMuted.has(owner)) continue;
      if (++this._renderWin.n > this.MAX_RENDER_NOTES_PER_SEC) continue;
      this.playVoice(owner, idx, ev.v);
    }
  }

  _now() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  noteColor(index) {
    return `hsl(${((21 + index) % 12) * 30}, 85%, 58%)`;
  }

  pressColor(index) {
    const holders = this.keyHolders.get(index);
    if (!holders || holders.size === 0) return null;
    let owner = null;
    let latest = -1;
    for (const [o, t] of holders) {
      if (t >= latest) { latest = t; owner = o; }
    }
    return this.userColor(owner === "self" ? this.userId : owner);
  }

  lightKey(index, on, owner) {
    owner = owner || "self";
    let holders = this.keyHolders.get(index);
    if (!holders) { holders = new Map(); this.keyHolders.set(index, holders); }
    if (on) holders.set(owner, this._now());
    else holders.delete(owner);
    this._dirtyKeys.add(index);
    if (this._visualRaf == null) {
      this._visualRaf = requestAnimationFrame(() => {
        this._visualRaf = null;
        this._flushVisuals();
      });
    }
  }

  _flushVisuals() {
    for (const idx of this._dirtyKeys) {
      const el = this.keyEls[idx];
      if (!el) continue;
      const holders = this.keyHolders.get(idx);
      if (holders && holders.size > 0) {
        el.style.setProperty("--press", this.pressColor(idx) || this.noteColor(idx));
        if (!el.classList.contains("pressed")) el.classList.add("pressed");
      } else {
        el.classList.remove("pressed");
        el.style.removeProperty("--press");
      }
    }
    this._dirtyKeys.clear();
  }

  _sweepStuck() {
    const now = this._now();
    let dirty = false;
    for (const [idx, holders] of this.keyHolders) {
      for (const [owner, t] of holders) {
        if (owner === "self" && this.downKeys.has(idx)) continue;
        if (now - t > this.MAX_LIGHT_MS) {
          holders.delete(owner);
          this._dirtyKeys.add(idx);
          dirty = true;
        }
      }
    }
    if (dirty && this._visualRaf == null) {
      this._visualRaf = requestAnimationFrame(() => {
        this._visualRaf = null;
        this._flushVisuals();
      });
    }
    const ctxNow = this.audioCtx ? this.audioCtx.currentTime : 0;
    for (const [key, v] of this.voices) {
      if (ctxNow - v.t > 30) { this._fade(v, 0.2); this.voices.delete(key); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  buildModal() {
    this.modal = this.el("div", "mpp-overlay");
    this.modal.id = "pianoModal";
    const container = this.el("div", "mpp-container");

    container.appendChild(this.buildHeader());

    // ── Stage ───────────────────────────────────────────────────────────
    const stage = this.el("div", "mpp-stage");

    this.chatEl = this.buildChat();
    stage.appendChild(this.chatEl);

    const center = this.el("div", "mpp-center");
    center.appendChild(this.buildToolbar());
    this.keyboardWrap = this.el("div", "mpp-keyboard-wrap");
    center.appendChild(this.keyboardWrap);
    stage.appendChild(center);

    stage.appendChild(this.buildNowPlaying());

    this.cursorLayer = this.el("div", "mpp-cursor-layer");

    this.hintEl = this.el("div", "mpp-hint");
    stage.appendChild(this.hintEl);
    this.loadingEl = this.el("div", "mpp-loading");
    this.loadingEl.appendChild(this.ic("circle-notch"));
    this.loadingEl.lastChild.classList.add("fa-spin");
    this.loadingEl.appendChild(this.el("span", null, " Loading piano…"));
    stage.appendChild(this.loadingEl);

    container.appendChild(stage);

    this.soundPanel = this.buildSoundPanel();
    this.helpPanel = this.buildHelpPanel();
    this.peoplePanel = this.buildPeoplePanel();
    container.appendChild(this.soundPanel);
    container.appendChild(this.helpPanel);
    container.appendChild(this.peoplePanel);

    this.modal.appendChild(container);
    document.body.appendChild(this.modal);
  }

  buildHeader() {
    const header = this.el("div", "mpp-header");

    const left = this.el("div", "mpp-head-left");
    const brand = this.el("div", "mpp-brand");
    brand.appendChild(this.ic("music"));
    brand.appendChild(this.el("span", null, "Piano"));
    left.appendChild(brand);

    const seg = this.el("div", "mpp-segment");
    this.modeRoomBtn = this.el("button", "mpp-seg-btn active", "Room");
    this.modeRoomBtn.type = "button";
    this.modeSoloBtn = this.el("button", "mpp-seg-btn", "Solo");
    this.modeSoloBtn.type = "button";
    this.modeRoomBtn.addEventListener("click", () => this.setMode("room"));
    this.modeSoloBtn.addEventListener("click", () => this.setMode("solo"));
    seg.appendChild(this.modeRoomBtn);
    seg.appendChild(this.modeSoloBtn);
    left.appendChild(seg);

    const right = this.el("div", "mpp-head-right");

    this.soundBtn = this.btn("mpp-hbtn", "sliders", "Sound", "Sound & synth settings");
    this.soundBtn.addEventListener("click", (e) => { e.stopPropagation(); this.togglePanel("sound"); });

    this.helpBtn = this.btn("mpp-hbtn", "circle-question", "Help", "How to play");
    this.helpBtn.addEventListener("click", (e) => { e.stopPropagation(); this.togglePanel("help"); });

    this.peopleBtn = this.btn("mpp-hbtn", "users", null, "People here");
    this.peopleBtn.addEventListener("click", (e) => { e.stopPropagation(); this.togglePanel("people"); });

    const vol = this.el("div", "mpp-vol");
    vol.appendChild(this.ic("volume-high"));
    this.volInput = this.el("input");
    this.volInput.type = "range";
    this.volInput.min = "0";
    this.volInput.max = "100";
    this.volInput.value = String(Math.round(this.volume * 100));
    this.volInput.title = "Volume";
    this.volInput.addEventListener("input", (e) => {
      this.volume = parseInt(e.target.value, 10) / 100;
      if (this.master) this.master.gain.value = this.volume;
    });
    vol.appendChild(this.volInput);

    right.appendChild(this.soundBtn);
    right.appendChild(this.helpBtn);
    right.appendChild(this.peopleBtn);
    right.appendChild(vol);

    if (navigator.requestMIDIAccess) {
      this.midiBtn = this.btn("mpp-hbtn mpp-icon-only", "plug", null, "Connect a MIDI keyboard");
      this.midiBtn.addEventListener("click", () => this.initMidi());
      right.appendChild(this.midiBtn);
    }

    this.closeBtn = this.btn("mpp-hbtn mpp-close", "xmark", null, "Close");
    this.closeBtn.addEventListener("click", () => this.close());
    right.appendChild(this.closeBtn);

    header.appendChild(left);
    header.appendChild(right);
    return header;
  }

  buildToolbar() {
    const bar = this.el("div", "mpp-toolbar");

    const oct = this.el("div", "mpp-tgroup");
    oct.appendChild(this.el("span", "mpp-tlabel", "Octave"));
    const down = this.btn("mpp-tbtn", "minus", null, "Octave down");
    down.addEventListener("click", () => this.shiftOctave(-12));
    this.octaveLabel = this.el("span", "mpp-oct-val", "C3");
    const up = this.btn("mpp-tbtn", "plus", null, "Octave up");
    up.addEventListener("click", () => this.shiftOctave(12));
    oct.appendChild(down);
    oct.appendChild(this.octaveLabel);
    oct.appendChild(up);
    bar.appendChild(oct);

    this.sustainBtn = this.btn("mpp-tbtn mpp-sustain", "shoe-prints", "Sustain", "Hold notes (Space, or a MIDI pedal)");
    this.sustainBtn.addEventListener("mousedown", (e) => { e.preventDefault(); this.setSustain(true); });
    this.sustainBtn.addEventListener("mouseup", () => this.setSustain(false));
    this.sustainBtn.addEventListener("mouseleave", () => this.setSustain(false));
    this.sustainBtn.addEventListener("click", () => this.showHint("Tip: hold Space for sustain"));
    bar.appendChild(this.sustainBtn);

    this.crownWrap = this.el("div", "mpp-tgroup mpp-crown-wrap");
    this.crownBtn = this.btn("mpp-tbtn", "crown", "Claim", "Room crown");
    this.crownBtn.style.display = this.isStaff ? "" : "none";
    this.crownBtn.addEventListener("click", () => this.onCrownButton());
    this.lockBtn = this.btn("mpp-tbtn mpp-lock", "lock-open", null, "Only the crown holder can play");
    this.lockBtn.addEventListener("click", () => this.toggleLock());
    this.crownLabel = this.el("span", "mpp-crown-label");
    this.crownWrap.appendChild(this.crownBtn);
    this.crownWrap.appendChild(this.lockBtn);
    this.crownWrap.appendChild(this.crownLabel);
    bar.appendChild(this.crownWrap);

    return bar;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  isBlack(midi) {
    const pc = midi % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
  }

  computeRows() {
    const w = window.innerWidth || document.documentElement.clientWidth;
    if (w > this.MOBILE_BREAKPOINT) return [[0, 87]];
    return [
      [0, 21],
      [22, 43],
      [44, 65],
      [66, 87],
    ];
  }

  renderKeyboard() {
    if (!this.keyboardWrap) return;
    const rows = this.computeRows();
    this.isMultiRow = rows.length > 1;

    this.keyboardWrap.textContent = "";
    this.keyEls = new Array(88);
    this.keyboardWrap.classList.toggle("multi", this.isMultiRow);

    for (const [start, end] of rows) {
      const row = this.el("div", "mpp-row");
      this.renderRow(row, start, end);
      this.keyboardWrap.appendChild(row);
    }

    if (!this.isMultiRow) {
      this.keyboardEl = this.keyboardWrap.querySelector(".mpp-row");
      if (this.keyboardEl) this.keyboardEl.appendChild(this.cursorLayer);
    } else {
      this.keyboardEl = null;
      if (this.cursorLayer.parentNode) this.cursorLayer.parentNode.removeChild(this.cursorLayer);
    }

    for (const [idx, holders] of this.keyHolders) {
      if (holders.size > 0 && this.keyEls[idx]) {
        this.keyEls[idx].style.setProperty("--press", this.pressColor(idx) || this.noteColor(idx));
        this.keyEls[idx].classList.add("pressed");
      }
    }
  }

  renderRow(rowEl, start, end) {
    const whiteRow = this.el("div", "mpp-white-row");
    const blackLayer = this.el("div", "mpp-black-layer");

    let totalWhite = 0;
    for (let i = start; i <= end; i++) if (!this.isBlack(21 + i)) totalWhite++;
    const wpc = (100 / totalWhite).toFixed(4);

    let whitesSoFar = 0;
    for (let i = start; i <= end; i++) {
      const midi = 21 + i;
      const black = this.isBlack(midi);
      const key = this.el("div", "mpp-key " + (black ? "mpp-black" : "mpp-white"));
      key.dataset.idx = String(i);
      if (black) {
        const center = (whitesSoFar * (100 / totalWhite)).toFixed(4);
        key.style.left = `calc(${center}% - (var(--mpp-black-key-width) * ${wpc}%) / 2)`;
        key.style.width = `calc(var(--mpp-black-key-width) * ${wpc}%)`;
        blackLayer.appendChild(key);
      } else {
        if (midi % 12 === 0) {
          key.appendChild(
            this.el("span", "mpp-key-label", "C" + (Math.floor(midi / 12) - 1)),
          );
        }
        whiteRow.appendChild(key);
        whitesSoFar++;
      }
      this.keyEls[i] = key;
      this.bindKey(key, i);
    }

    rowEl.appendChild(whiteRow);
    rowEl.appendChild(blackLayer);
  }

  bindKey(el, i) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.ensureAudio();
      this.pressFromPointer(i, e);
    });
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse" && this.pointerKey.has(e.pointerId)) {
        this.pressFromPointer(i, e);
      }
    });
  }

  pressFromPointer(i, e) {
    const prev = this.pointerKey.get(e.pointerId);
    if (prev === i) return;
    if (prev != null) this.releaseKey(prev);
    this.pointerKey.set(e.pointerId, i);
    this.pressKey(i, this.velocityFromPointer(i, e));
  }

  releasePointer(id) {
    const idx = this.pointerKey.get(id);
    if (idx != null) this.releaseKey(idx);
    this.pointerKey.delete(id);
  }

  velocityFromPointer(i, e) {
    const el = this.keyEls[i];
    if (!el) return this.KEY_VELOCITY;
    const r = el.getBoundingClientRect();
    let f = (e.clientY - r.top) / Math.max(1, r.height);
    f = Math.max(0, Math.min(1, f));
    return 0.42 + 0.58 * f;
  }

  onStagePointerMove(e) {
    if (this.isMultiRow || this.mode === "solo" || !this.keyboardEl) return;
    const now = Date.now();
    if (now - this.cursorT < this.CURSOR_INTERVAL) return;
    this.cursorT = now;
    const r = this.keyboardEl.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return;
    this.socket.emit("piano cursor", {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  buildChat() {
    const chat = this.el("div", "mpp-chat");
    this.chatLog = this.el("div", "mpp-chat-log");
    const inputWrap = this.el("div", "mpp-chat-input-wrap");
    this.chatInput = this.el("input", "mpp-chat-input");
    this.chatInput.type = "text";
    this.chatInput.placeholder = "Say something…";
    this.chatInput.maxLength = 200;
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = this.chatInput.value.trim();
        if (v) this.sendChat(v);
        this.chatInput.value = "";
        this.chatInput.blur();
        chat.classList.remove("active");
      } else if (e.key === "Escape") {
        this.chatInput.value = "";
        this.chatInput.blur();
        chat.classList.remove("active");
        e.preventDefault();
      }
      e.stopPropagation();
    });
    this.chatInput.addEventListener("focus", () => chat.classList.add("active"));
    inputWrap.appendChild(this.chatInput);
    chat.appendChild(this.chatLog);
    chat.appendChild(inputWrap);
    return chat;
  }

  canSendChat() {
    const now = Date.now();
    this.chatTimestamps = this.chatTimestamps.filter((t) => now - t < this.CHAT_BURST_WINDOW);
    if (this.chatTimestamps.length >= this.CHAT_BURST_MAX) {
      const wait = Math.ceil((this.CHAT_BURST_WINDOW - (now - this.chatTimestamps[0])) / 1000);
      this.systemChat(`Slow down! Try again in ${wait}s`);
      return false;
    }
    if (this.chatTimestamps.length > 0) {
      const last = this.chatTimestamps[this.chatTimestamps.length - 1];
      if (now - last < this.CHAT_MIN_INTERVAL) { this.systemChat("Sending too fast"); return false; }
    }
    this.chatTimestamps.push(now);
    return true;
  }

  sendChat(text) {
    if (!this.canSendChat()) return;
    this.socket.emit("piano chat", { text });
  }

  systemChat(text) {
    if (this.chatCooldownActive) return;
    this.chatCooldownActive = true;
    const msg = this.el("div", "mpp-chat-msg mpp-chat-system");
    msg.appendChild(this.el("span", "mpp-chat-text", text));
    this._appendChat(msg);
    setTimeout(() => { this.chatCooldownActive = false; }, 1000);
  }

  applyFilter(text) {
    try {
      if (
        typeof wordFilterEnabled !== "undefined" && wordFilterEnabled &&
        typeof clientWordFilter !== "undefined" && clientWordFilter && clientWordFilter.ready
      ) {
        return clientWordFilter.filterText(text);
      }
    } catch (_) {}
    return text;
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
      this.participants.set(data.userId, { username: data.username });

    const isSelf = data.userId === this.userId;
    const col = this.userColor(data.userId);
    const msg = this.el("div", "mpp-chat-msg" + (isSelf ? " mpp-chat-self" : ""));
    const name = this.el("span", "mpp-chat-name", data.username || "User");
    name.style.color = col;
    const text = this.el("span", "mpp-chat-text", " " + this.applyFilter(data.text));
    msg.appendChild(name);
    msg.appendChild(text);
    this._appendChat(msg);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  togglePanel(which) {
    const map = { sound: this.soundPanel, help: this.helpPanel, people: this.peoplePanel };
    const target = map[which];
    if (!target) return;
    const show = !target.classList.contains("show");
    for (const p of Object.values(map)) if (p) p.classList.remove("show");
    if (show) {
      target.classList.add("show");
      if (which === "people") this.renderParticipants();
    }
  }

  closePanels() {
    [this.soundPanel, this.helpPanel, this.peoplePanel].forEach((p) => {
      if (p) p.classList.remove("show");
    });
  }

  segControl(options, current, onPick) {
    const wrap = this.el("div", "mpp-segment mpp-seg-wide");
    const btns = [];
    options.forEach((opt) => {
      const b = this.el("button", "mpp-seg-btn" + (opt.value === current ? " active" : ""), opt.label);
      b.type = "button";
      b.addEventListener("click", () => {
        btns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        onPick(opt.value);
      });
      btns.push(b);
      wrap.appendChild(b);
    });
    return wrap;
  }

  sliderRow(label, min, max, step, value, fmt, onInput) {
    const row = this.el("div", "mpp-field");
    const head = this.el("div", "mpp-field-head");
    head.appendChild(this.el("span", "mpp-field-label", label));
    const val = this.el("span", "mpp-field-val", fmt(value));
    head.appendChild(val);
    const input = this.el("input", "mpp-slider");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      val.textContent = fmt(v);
      onInput(v);
    });
    row.appendChild(head);
    row.appendChild(input);
    return row;
  }

  buildSoundPanel() {
    const panel = this.el("div", "mpp-panel mpp-sound-panel");
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(this.el("div", "mpp-panel-head", "Sound"));

    const f1 = this.el("div", "mpp-field");
    f1.appendChild(this.el("span", "mpp-field-label", "Instrument"));
    f1.appendChild(
      this.segControl(
        [{ label: "Grand Piano", value: "piano" }, { label: "Synth", value: "synth" }],
        this.instrument,
        (v) => this.setInstrument(v),
      ),
    );
    panel.appendChild(f1);

    this.synthBox = this.el("div", "mpp-synth-box");

    const wf = this.el("div", "mpp-field");
    wf.appendChild(this.el("span", "mpp-field-label", "Waveform"));
    wf.appendChild(
      this.segControl(
        [
          { label: "Sine", value: "sine" },
          { label: "Tri", value: "triangle" },
          { label: "Saw", value: "sawtooth" },
          { label: "Square", value: "square" },
        ],
        this.waveform,
        (v) => { this.waveform = v; },
      ),
    );
    this.synthBox.appendChild(wf);

    this.synthBox.appendChild(
      this.sliderRow("Attack", 0, 0.5, 0.005, this.attack, (v) => `${Math.round(v * 1000)} ms`, (v) => { this.attack = v; }),
    );
    this.synthBox.appendChild(
      this.sliderRow("Release", 0.05, 2, 0.05, this.release, (v) => `${v.toFixed(2)} s`, (v) => { this.release = v; }),
    );
    panel.appendChild(this.synthBox);

    const rev = this.el("div", "mpp-field");
    const revHead = this.el("div", "mpp-field-head");
    revHead.appendChild(this.el("span", "mpp-field-label", "Reverb"));
    const revToggle = this.el("button", "mpp-toggle" + (this.reverbOn ? " on" : ""), this.reverbOn ? "On" : "Off");
    revToggle.type = "button";
    revToggle.addEventListener("click", () => {
      this.setReverb(!this.reverbOn);
      revToggle.classList.toggle("on", this.reverbOn);
      revToggle.textContent = this.reverbOn ? "On" : "Off";
    });
    revHead.appendChild(revToggle);
    rev.appendChild(revHead);
    rev.appendChild(
      this.sliderRow("Amount", 0, 0.6, 0.02, this.reverbAmount, (v) => `${Math.round((v / 0.6) * 100)}%`, (v) => this.setReverb(this.reverbOn, v)),
    );
    panel.appendChild(rev);

    this.synthBox.style.display = this.instrument === "synth" ? "" : "none";
    return panel;
  }

  setInstrument(v) {
    this.instrument = v;
    if (this.synthBox) this.synthBox.style.display = v === "synth" ? "" : "none";
    if (v === "piano") { this.ensureAudio(); this.loadSamples(); }
  }

  buildHelpPanel() {
    const panel = this.el("div", "mpp-panel mpp-help-panel");
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(this.el("div", "mpp-panel-head", "How to play"));
    const body = this.el("div", "mpp-help-body");
    const entries = [
      ["Playing", "Click or tap the keys, or use your computer keyboard. The bottom letter row (z x c v b n m) plays the lower octave and the top row (q w e r t y u) the higher one. On phones the keyboard splits into rows so every note is reachable."],
      ["Octave  -  /  +", "Shifts which notes your computer keyboard plays, up or down an octave. The label (e.g. C3) is the current starting note. Mouse and touch always play the exact key you press."],
      ["Sustain", "Holds notes after you let go, like a piano's right pedal. Hold the Spacebar, press and hold the Sustain button, or use a MIDI pedal. The button glows while it is on."],
      ["Sound", "Switch between the sampled Grand Piano and a Synth. For the synth you can choose the waveform and shape Attack, Release and Reverb."],
      ["Volume", "Your master output level. It only changes what you hear."],
      ["Solo / Room", "Solo is private practice - no one hears you and you do not hear them. Room plays together with everyone in the Talkomatic room."],
      ["Crown", "Claim the crown to own the piano. As owner you can lock it so only you play, or drop it to free it for someone else. Staff can take the crown."],
      ["People", "Everyone at the piano. Staff can mute a player so their notes stop sounding for the room."],
      ["MIDI", "Click the plug to connect a MIDI keyboard for velocity-sensitive playing, including its sustain pedal."],
    ];
    for (const [title, text] of entries) {
      const item = this.el("div", "mpp-help-item");
      item.appendChild(this.el("h4", "mpp-help-title", title));
      item.appendChild(this.el("p", "mpp-help-text", text));
      body.appendChild(item);
    }
    panel.appendChild(body);
    return panel;
  }

  buildPeoplePanel() {
    const panel = this.el("div", "mpp-panel mpp-people-panel");
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.appendChild(this.el("div", "mpp-panel-head", "People here"));
    this.peopleList = this.el("div", "mpp-people-list");
    panel.appendChild(this.peopleList);
    return panel;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  onCrownButton() {
    if (!this.isStaff) {
      this.showHint("Only staff can hold the crown");
      return;
    }
    const mine = this.crown && this.crown === this.userId;
    if (mine) this.socket.emit("piano crown drop");
    else this.socket.emit("piano crown claim");
  }

  toggleLock() {
    if (this.crown !== this.userId && !this.isStaff) return;
    this.socket.emit("piano set lock", { onlyOwner: !this.onlyOwner });
  }

  handleCrown(meta) {
    if (!meta) return;
    this.crown = meta.crown || null;
    this.crownName = meta.crownName || null;
    this.onlyOwner = !!meta.onlyOwner;
    this.updateCrownUI();
    this.updateCanPlayUI();
    this.renderParticipants();
  }

  updateCrownUI() {
    if (!this.crownBtn) return;
    const mine = this.crown && this.crown === this.userId;
    this.crownBtn.lastChild.textContent = !this.crown ? "Claim" : mine ? "Drop" : "Take";
    this.crownBtn.classList.toggle("mpp-has-crown", !!mine);

    if (!this.crown) {
      this.crownBtn.style.display = this.isStaff ? "" : "none";
      this.lockBtn.style.display = "none";
      this.crownLabel.textContent = "";
    } else if (mine) {
      this.crownBtn.style.display = "";
      this.lockBtn.style.display = "";
      this.crownLabel.textContent = "You";
    } else {
      this.crownBtn.style.display = this.isStaff ? "" : "none";
      this.lockBtn.style.display = this.isStaff ? "" : "none";
      this.crownLabel.textContent = this.crownName || "Owner";
    }

    this.lockBtn.classList.toggle("on", this.onlyOwner);
    const i = this.lockBtn.querySelector("i");
    if (i) i.className = "fas fa-" + (this.onlyOwner ? "lock" : "lock-open");
    this.lockBtn.title = this.onlyOwner
      ? "Only the crown holder can play (click to unlock)"
      : "Anyone can play (click to lock to the crown holder)";
  }

  updateCanPlayUI() {
    const locked = !this.canPlay();
    if (this.keyboardWrap) this.keyboardWrap.classList.toggle("locked", locked);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  handleParticipants(data) {
    if (!data || !Array.isArray(data.participants)) return;
    for (const p of data.participants) {
      if (p && p.userId) this.participants.set(p.userId, { username: p.username });
    }
    this.renderParticipants();
  }

  handleUserStatus(data) {
    if (!data || !data.userId) return;
    if (data.open) {
      this.participants.set(data.userId, { username: data.username || "User" });
    } else {
      this.participants.delete(data.userId);
      this.removeRemoteCursor(data.userId);
      this.dropUserVoices(data.userId);
    }
    this.renderParticipants();
  }

  handleMuted(data) {
    if (!data || !Array.isArray(data.muted)) return;
    this.mutedSet = new Set(data.muted);
    const nowMuted = this.mutedSet.has(this.userId);
    if (nowMuted && !this.selfMuted) this.showHint("You have been muted");
    this.selfMuted = nowMuted;
    this.updateCanPlayUI();
    this.renderParticipants();
  }

  muteUser(uid, mute) {
    this.socket.emit("piano mute user", { targetUserId: uid, mute });
  }

  toggleLocalMute(uid) {
    if (!uid || uid === this.userId) return;
    if (this.localMuted.has(uid)) {
      this.localMuted.delete(uid);
    } else {
      this.localMuted.add(uid);
      this.dropUserVoices(uid);
    }
    this.renderParticipants();
  }

  renderParticipants() {
    if (!this.peopleList) return;
    this.peopleList.textContent = "";
    const rows = [{ userId: this.userId, username: this.username, self: true }];
    for (const [uid, info] of this.participants) {
      if (uid === this.userId) continue;
      rows.push({ userId: uid, username: info.username || "User" });
    }
    if (this.peopleBtn) this.peopleBtn.dataset.count = String(rows.length);

    for (const r of rows) {
      const row = this.el("div", "mpp-person");
      const avatar = this.el("span", "mpp-person-avatar",
        (r.username || "?").trim().charAt(0).toUpperCase() || "?");
      avatar.style.background = this.userColor(r.userId);
      const name = this.el("span", "mpp-person-name", r.username + (r.self ? " (you)" : ""));
      row.appendChild(avatar);
      row.appendChild(name);

      if (this.crown && this.crown === r.userId) {
        const crown = this.el("span", "mpp-person-crown");
        crown.appendChild(this.ic("crown"));
        crown.title = "Has the crown";
        row.appendChild(crown);
      }
      if (this.mutedSet.has(r.userId)) {
        const m = this.el("span", "mpp-person-muted");
        m.appendChild(this.ic("volume-xmark"));
        m.title = "Muted";
        row.appendChild(m);
      }
      if (!r.self) {
        const lm = this.localMuted.has(r.userId);
        const b = this.btn("mpp-person-btn mpp-local-mute" + (lm ? " on" : ""),
          lm ? "ear-deaf" : "ear-listen", null,
          lm ? "Muted for you - click to hear" : "Mute for you only");
        b.addEventListener("click", (e) => { e.stopPropagation(); this.toggleLocalMute(r.userId); });
        row.appendChild(b);
      }
      if (this.isStaff && !r.self) {
        const muted = this.mutedSet.has(r.userId);
        const b = this.btn("mpp-person-btn" + (muted ? " on" : ""),
          muted ? "volume-high" : "volume-xmark", null, muted ? "Unmute (room)" : "Mute (room)");
        b.addEventListener("click", (e) => { e.stopPropagation(); this.muteUser(r.userId, !muted); });
        row.appendChild(b);
      }
      this.peopleList.appendChild(row);
    }
    this.renderNowPlaying();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  buildNowPlaying() {
    this.nowPlaying = this.el("div", "mpp-nowplaying");
    this.npChips = new Map();
    return this.nowPlaying;
  }

  renderNowPlaying() {
    if (!this.nowPlaying) return;
    const rows = [{ userId: this.userId, username: this.username, self: true }];
    for (const [uid, info] of this.participants) {
      if (uid === this.userId) continue;
      rows.push({ userId: uid, username: (info && info.username) || "User" });
    }
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.userId);
      let chip = this.npChips.get(r.userId);
      if (!chip) {
        const el = this.el("div", "mpp-np-chip");
        const name = this.el("span", "mpp-np-name");
        el.appendChild(name);
        chip = { el, name, last: 0 };
        this.npChips.set(r.userId, chip);
      }
      const bg = this.userColor(r.userId);
      chip.el.style.background = bg;
      chip.name.style.color = this._inkFor(bg);
      chip.name.textContent = r.username + (r.self ? " (you)" : "");
      chip.el.classList.toggle("mpp-np-crown", !!this.crown && this.crown === r.userId);
      this.nowPlaying.appendChild(chip.el);
    }
    for (const [uid, chip] of this.npChips) {
      if (!seen.has(uid)) {
        if (chip.el.parentNode) chip.el.parentNode.removeChild(chip.el);
        this.npChips.delete(uid);
      }
    }
  }

  bouncePlayer(userId) {
    if (!this.npChips) return;
    const chip = this.npChips.get(userId);
    if (!chip) return;
    const now = this._now();
    if (now - chip.last < 90) return;
    chip.last = now;
    chip.el.classList.remove("bounce");
    void chip.el.offsetWidth;
    chip.el.classList.add("bounce");
  }

  dropUserVoices(uid) {
    for (const [key, v] of this.voices) {
      if (v.owner === uid) { this._fade(v, 0.18); this.voices.delete(key); }
    }
    for (const [idx, holders] of this.keyHolders) {
      if (holders.has(uid)) this.lightKey(idx, false, uid);
    }
  }

  onUserLeft(uid) {
    if (!uid) return;
    this.participants.delete(uid);
    this.removeRemoteCursor(uid);
    this.dropUserVoices(uid);
    this.renderParticipants();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  updateRemoteCursor(d) {
    if (!d || d.userId === this.userId || this.isMultiRow || !this.keyboardEl) return;
    if (d.username) this.participants.set(d.userId, { username: d.username });
    let c = this.cursors.get(d.userId);
    if (!c) {
      const elc = this.el("div", "mpp-remote-cursor");
      const dot = this.el("div", "mpp-cursor-dot");
      dot.style.background = this.userColor(d.userId);
      const label = this.el("span", "mpp-cursor-label", d.username || "User");
      elc.appendChild(dot);
      elc.appendChild(label);
      this.cursorLayer.appendChild(elc);
      c = { el: elc, buf: [], lastSeen: 0 };
      this.cursors.set(d.userId, c);
    }
    const x = Math.max(0, Math.min(1, d.x));
    const y = Math.max(0, Math.min(1, d.y));
    const now = this._now();
    c.buf.push({ t: now, x, y });
    if (c.buf.length > 120) c.buf.splice(0, c.buf.length - 120);
    c.lastSeen = now;
    this._ensureCursorLoop();
  }

  _ensureCursorLoop() {
    if (this._cursorRaf == null && this.isOpen && !this.isMultiRow) {
      this._cursorRaf = requestAnimationFrame(() => this._cursorFrame());
    }
  }

  _cursorFrame() {
    this._cursorRaf = null;
    if (!this.isOpen || this.isMultiRow || !this.keyboardEl) return;
    const now = this._now();
    const renderTime = now - this.CURSOR_RENDER_DELAY;
    const rect = this.keyboardEl.getBoundingClientRect();
    let live = false;
    for (const [, c] of this.cursors) {
      if (now - c.lastSeen > this.CURSOR_TIMEOUT) {
        if (c.el.style.display !== "none") c.el.style.display = "none";
        continue;
      }
      live = true;
      const pos = this._sampleCursor(c.buf, renderTime);
      if (pos) {
        c.el.style.transform = `translate(${pos.x * rect.width}px, ${pos.y * rect.height}px)`;
        if (c.el.style.display !== "block") c.el.style.display = "block";
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
      const a = buf[i - 1], b = buf[i];
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
      if (buf[i].t <= renderTime) lo = i; else break;
    }
    const drop = Math.min(lo, Math.max(0, buf.length - 2));
    if (drop > 0) buf.splice(0, drop);
  }

  removeRemoteCursor(uid) {
    const c = this.cursors.get(uid);
    if (c) {
      if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
      this.cursors.delete(uid);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  setMode(mode) {
    if (mode !== "room" && mode !== "solo") return;
    if (mode === this.mode && this._modeApplied) return;
    const prev = this.mode;
    this.mode = mode;
    this.applyMode();
    if (!this.isOpen) return;
    if (mode === "solo" && prev !== "solo") {
      this.socket.emit("piano close");
      this.setRoomStatus(false);
      for (const [k, v] of this.voices) {
        if (v.owner !== "self") { this._fade(v, 0.12); this.voices.delete(k); }
      }
      for (const uid of [...this.cursors.keys()]) this.removeRemoteCursor(uid);
      this.closePanels();
    } else if (mode === "room" && prev !== "room") {
      this.socket.emit("piano open");
      this.setRoomStatus(true);
    }
  }

  applyMode() {
    this._modeApplied = true;
    const room = this.mode === "room";
    if (this.modeRoomBtn) this.modeRoomBtn.classList.toggle("active", room);
    if (this.modeSoloBtn) this.modeSoloBtn.classList.toggle("active", !room);
    if (this.crownWrap) this.crownWrap.style.display = room ? "" : "none";
    if (this.peopleBtn) this.peopleBtn.style.display = room ? "" : "none";
    if (this.chatEl) this.chatEl.style.display = room ? "" : "none";
    if (this.nowPlaying) this.nowPlaying.style.display = room ? "" : "none";
    this.updateCanPlayUI();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  codeMap() {
    return {
      KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
      KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
      Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
      KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
      Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
      KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
      BracketLeft: 29, Equal: 30, BracketRight: 31,
    };
  }

  isTypingTarget(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  }

  bindGlobalEvents() {
    this._codeMap = this.codeMap();

    this._onKeyDown = (e) => {
      if (!this.isOpen) return;
      if (this.isTypingTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Escape") {
        if (this.soundPanel.classList.contains("show") || this.helpPanel.classList.contains("show") || this.peoplePanel.classList.contains("show")) {
          this.closePanels();
        } else { this.close(); }
        return;
      }
      if (e.code === "Enter") {
        e.preventDefault();
        if (this.mode !== "solo" && this.chatInput) {
          if (this.chatEl) this.chatEl.classList.add("active");
          this.chatInput.focus();
        }
        return;
      }
      if (e.code === "Space") { e.preventDefault(); this.setSustain(true); return; }
      if (e.code === "ArrowUp" || e.code === "ArrowRight") { e.preventDefault(); this.shiftOctave(12); return; }
      if (e.code === "ArrowDown" || e.code === "ArrowLeft") { e.preventDefault(); this.shiftOctave(-12); return; }
      const off = this._codeMap[e.code];
      if (off == null) return;
      e.preventDefault();
      if (e.repeat) return;
      if (this.kbKeys.has(e.code)) return;
      const idx = this.octaveBase + off - 21;
      if (idx < 0 || idx > 87) return;
      this.kbKeys.set(e.code, idx);
      this.pressKey(idx, this.KEY_VELOCITY);
    };

    this._onKeyUp = (e) => {
      if (e.code === "Space") { this.setSustain(false); return; }
      if (this.kbKeys.has(e.code)) {
        const idx = this.kbKeys.get(e.code);
        this.kbKeys.delete(e.code);
        this.releaseKey(idx);
      }
    };

    this._onPointerUp = (e) => this.releasePointer(e.pointerId);
    this._onPointerCancel = (e) => this.releasePointer(e.pointerId);
    this._onDocClick = (e) => {
      const panels = [
        [this.soundPanel, this.soundBtn],
        [this.helpPanel, this.helpBtn],
        [this.peoplePanel, this.peopleBtn],
      ];
      for (const [panel, b] of panels) {
        if (panel && panel.classList.contains("show") &&
            !panel.contains(e.target) && b && !b.contains(e.target)) {
          panel.classList.remove("show");
        }
      }
    };
    this._onDocPointerDown = (e) => {
      if (!this.chatEl || !this.chatEl.classList.contains("active")) return;
      if (this.chatEl.contains(e.target)) return;
      this.chatEl.classList.remove("active");
    };
    this._onResize = () => {
      if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = requestAnimationFrame(() => {
        const wantMulti = (window.innerWidth || 9999) <= this.MOBILE_BREAKPOINT;
        if (wantMulti !== this.isMultiRow) this.renderKeyboard();
      });
    };

    this._onWheel = (e) => {
      if (!this.isOpen || this.mode === "solo" || !this.chatEl || !this.chatLog)
        return;
      if (!this.chatEl.classList.contains("active")) return;
      const cr = this.chatEl.getBoundingClientRect();
      if (
        e.clientX < cr.left || e.clientX > cr.right ||
        e.clientY < cr.top || e.clientY > cr.bottom
      )
        return;
      const log = this.chatLog;
      if (log.scrollHeight <= log.clientHeight) return;
      log.scrollTop += e.deltaY;
      e.preventDefault();
    };

    document.addEventListener("keydown", this._onKeyDown);
    document.addEventListener("keyup", this._onKeyUp);
    document.addEventListener("pointerup", this._onPointerUp);
    document.addEventListener("pointercancel", this._onPointerCancel);
    document.addEventListener("click", this._onDocClick);
    document.addEventListener("pointerdown", this._onDocPointerDown, true);
    window.addEventListener("resize", this._onResize);
    document.addEventListener("wheel", this._onWheel, { passive: false });

    if (this.keyboardWrap)
      this.keyboardWrap.addEventListener("pointermove", (e) => this.onStagePointerMove(e));
  }

  shiftOctave(delta) {
    const next = this.octaveBase + delta;
    if (next < 12 || next > 96) return;
    this.octaveBase = next;
    this.updateOctaveLabel();
  }

  updateOctaveLabel() {
    if (this.octaveLabel)
      this.octaveLabel.textContent = "C" + (Math.floor(this.octaveBase / 12) - 1);
  }

  initMidi() {
    if (!navigator.requestMIDIAccess) { this.showHint("MIDI is not supported in this browser"); return; }
    navigator.requestMIDIAccess().then((access) => {
      this.midiAccess = access;
      const refresh = () => {
        let count = 0;
        access.inputs.forEach((inp) => { inp.onmidimessage = (m) => this.onMidi(m); count++; });
        this.midiCount = count;
        if (this.midiBtn) this.midiBtn.classList.toggle("on", count > 0);
        this.showHint(count > 0
          ? `MIDI: ${count} device${count > 1 ? "s" : ""} connected`
          : "MIDI ready - plug in a keyboard");
      };
      refresh();
      access.onstatechange = () => refresh();
    }).catch(() => this.showHint("Could not access MIDI"));
  }

  onMidi(m) {
    const data = m.data;
    if (!data || data.length < 2) return;
    const cmd = data[0] & 0xf0;
    const d1 = data[1];
    const d2 = data.length > 2 ? data[2] : 0;
    if (cmd === 0xb0 && d1 === 64) { this.setSustain(d2 >= 64); return; }
    const idx = d1 - 21;
    if (idx < 0 || idx > 87) return;
    if (cmd === 0x90 && d2 > 0) this.pressKey(idx, d2 / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.releaseKey(idx);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  userColor(uid) {
    let h = 0;
    const s = String(uid || "x");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360}, 72%, 62%)`;
  }

  _inkFor(bg) {
    let r, g, b;
    if (bg[0] === "#") {
      const n = parseInt(bg.slice(1), 16);
      r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
    } else {
      const m = bg.match(/hsl\(\s*([\d.]+)[, ]+([\d.]+)%[, ]+([\d.]+)%/i);
      if (!m) return "#15131c";
      [r, g, b] = this._hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    }
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 150 ? "#15131c" : "#ffffff";
  }

  _hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [
      Math.round(hue2rgb(h + 1 / 3) * 255),
      Math.round(hue2rgb(h) * 255),
      Math.round(hue2rgb(h - 1 / 3) * 255),
    ];
  }

  showHint(text) {
    if (!this.hintEl) return;
    this.hintEl.textContent = text;
    this.hintEl.classList.add("show");
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.hintEl.classList.remove("show"), 1900);
  }

  setRoomStatus(on) {
    if (typeof socket === "undefined" || !socket) return;
    try {
      if (on) {
        if (this._savedChat == null)
          this._savedChat = typeof selfRawText === "string" ? selfRawText : "";
        socket.emit("chat update", {
          diff: {
            type: "full-replace",
            text: "Playing the Piano - open Apps > Piano to join",
          },
        });
      } else if (this._savedChat != null) {
        socket.emit("chat update", {
          diff: { type: "full-replace", text: this._savedChat },
        });
        this._savedChat = null;
      }
    } catch (_) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  setupSocketListeners() {
    this.socket.on("piano notes", (d) => this.handleRemoteNotes(d));
    this.socket.on("piano cursor", (d) => this.updateRemoteCursor(d));
    this.socket.on("piano chat", (d) => this.addChatMessage(d));
    this.socket.on("piano crown", (d) => this.handleCrown(d));
    this.socket.on("piano muted", (d) => this.handleMuted(d));
    this.socket.on("piano participants", (d) => this.handleParticipants(d));
    this.socket.on("piano user status", (d) => this.handleUserStatus(d));
    this.socket.on("user left", (uid) => this.onUserLeft(uid));

    this.socket.on("disconnect", () => this.panic());
    this.socket.on("connect", () => {
      if (this.isOpen && this.mode === "room") this.socket.emit("piano open");
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.renderKeyboard();
    this.renderNowPlaying();
    this.modal.classList.add("show");
    this.ensureAudio();
    if (typeof chatInput !== "undefined" && chatInput && chatInput.blur) chatInput.blur();
    if (this.mode === "room") {
      this.socket.emit("piano open");
      this.setRoomStatus(true);
    }
    if (!this._sweepTimer) this._sweepTimer = setInterval(() => this._sweepStuck(), 1000);
    this.showHint("Click keys or use your keyboard. Need help? Tap Help.");
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.modal.classList.remove("show");
    this.closePanels();
    for (const idx of [...this.downKeys]) this.releaseKey(idx);
    this.setSustain(false);
    this.panic();
    this.downKeys.clear();
    this.kbKeys.clear();
    this.pointerKey.clear();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    if (this._cursorRaf != null) { cancelAnimationFrame(this._cursorRaf); this._cursorRaf = null; }
    if (this.chatEl) this.chatEl.classList.remove("active");
    this.noteBuf = [];
    if (this.mode === "room") this.socket.emit("piano close");
    this.setRoomStatus(false);
    if (typeof chatInput !== "undefined" && chatInput)
      setTimeout(() => chatInput.focus && chatInput.focus(), 50);
  }

  destroy() {
    if (this.isOpen) this.close();
    document.removeEventListener("keydown", this._onKeyDown);
    document.removeEventListener("keyup", this._onKeyUp);
    document.removeEventListener("pointerup", this._onPointerUp);
    document.removeEventListener("pointercancel", this._onPointerCancel);
    document.removeEventListener("click", this._onDocClick);
    document.removeEventListener("pointerdown", this._onDocPointerDown, true);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("wheel", this._onWheel);
    if (this._cursorRaf != null) { cancelAnimationFrame(this._cursorRaf); this._cursorRaf = null; }
    if (this.modal && this.modal.parentNode) this.modal.parentNode.removeChild(this.modal);
  }
}

window.Piano = Piano;
