// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ lobby-client.js - Talkomatic Lobby Client ║ ║ Server statistics,
// anti-spam lobby sorting, lobby visibility ║ ║ ║ ║ PATCHED (June 2026
// anniversary batch): ║ ║ • FIX #4: Access codes are NEVER placed in
// redirect URLs anymore.

// ============================================================================
// ============================================================================
(function () {
  if (window.modalFunctionsInitialized) {
    console.log("Custom modal already initialized");
    return;
  }
  window.modalFunctionsInitialized = true;

  const customModal = document.getElementById("customModal");
  const modalTitle = document.getElementById("modalTitle");
  const modalMessage = document.getElementById("modalMessage");
  const modalInput = document.getElementById("modalInput");
  const modalInputContainer = document.getElementById("modalInputContainer");
  const modalInputError = document.getElementById("modalInputError");
  const modalCancelBtn = document.getElementById("modalCancelBtn");
  const modalConfirmBtn = document.getElementById("modalConfirmBtn");
  const closeModalBtn = document.querySelector(".close-modal-btn");

  let currentModalCallback = null;

  function showModal(title, message, options = {}) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;

    modalInputContainer.style.display = "none";
    modalInput.value = "";
    modalInputError.style.display = "none";
    modalInputError.textContent = "";

    if (options.showInput) {
      modalInputContainer.style.display = "block";
      modalInput.placeholder = options.inputPlaceholder || "";
      modalInput.setAttribute("maxLength", options.maxLength || "6");
      modalInput.focus();
    }

    modalCancelBtn.textContent = options.cancelText || "Cancel";
    modalConfirmBtn.textContent = options.confirmText || "Confirm";

    modalCancelBtn.style.display =
      options.showCancel !== false ? "block" : "none";

    currentModalCallback = options.callback || null;

    customModal.classList.add("show");

    document.body.style.overflow = "hidden";
  }

  function hideCustomModal() {
    customModal.classList.remove("show");
    document.body.style.overflow = "";
    currentModalCallback = null;
  }

  const ERROR_CODES = {
    VALIDATION_ERROR: "Validation Error",
    SERVER_ERROR: "Server Error",
    UNAUTHORIZED: "Unauthorized",
    NOT_FOUND: "Not Found",
    RATE_LIMITED: "Rate Limited",
    ROOM_FULL: "Room Full",
    ACCESS_DENIED: "Access Denied",
    BAD_REQUEST: "Bad Request",
    FORBIDDEN: "Forbidden",
    CIRCUIT_OPEN: "Circuit Open",
    AFK_WARNING: "AFK Warning",
    AFK_TIMEOUT: "AFK Timeout",
  };

  window.showErrorModal = function (message, title) {
    showModal(ERROR_CODES[title] ?? "Error", message, {
      showCancel: false,
      confirmText: "OK",
    });
  };

  window.showInfoModal = function (message) {
    showModal("Information", message, {
      showCancel: false,
      confirmText: "OK",
    });
  };

  window.showConfirmModal = function (message, callback) {
    showModal("Confirmation", message, {
      confirmText: "Yes",
      cancelText: "No",
      callback: callback,
    });
  };

  window.showInputModal = function (title, message, options, callback) {
    showModal(title, message, {
      showInput: true,
      inputPlaceholder: options.placeholder || "",
      maxLength: options.maxLength || "6",
      confirmText: options.confirmText || "Submit",
      callback: (confirmed, inputValue) => {
        if (confirmed && options.validate) {
          const validationResult = options.validate(inputValue);
          if (validationResult !== true) {
            modalInputError.textContent = validationResult;
            modalInputError.style.display = "block";
            return false;
          }
        }
        callback(confirmed, inputValue);
        return true;
      },
    });
  };

  modalConfirmBtn.addEventListener("click", () => {
    if (currentModalCallback) {
      const shouldClose = currentModalCallback(true, modalInput.value);
      if (shouldClose !== false) {
        hideCustomModal();
      }
    } else {
      hideCustomModal();
    }
  });

  modalCancelBtn.addEventListener("click", () => {
    if (currentModalCallback) {
      currentModalCallback(false);
    }
    hideCustomModal();
  });

  closeModalBtn.addEventListener("click", hideCustomModal);

  customModal.addEventListener("click", (e) => {
    if (e.target === customModal) {
      hideCustomModal();
    }
  });

  modalInput.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, "");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && customModal.classList.contains("show")) {
      hideCustomModal();
    }
  });

  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      modalConfirmBtn.click();
    }
  });
})();

// ============================================================================
// ============================================================================
class StatsModal {
  constructor() {
    this.modal = document.getElementById("statsModal");
    this.closeButton = document.getElementById("statsModalClose");
    this.refreshButton = document.getElementById("modalRefreshButton");
    this.isOpen = false;
    this.lastUpdateTime = null;

    this.loadingSection = document.getElementById("statsLoadingSection");
    this.errorSection = document.getElementById("statsErrorSection");
    this.contentSection = document.getElementById("statsContentSection");

    this.elements = {
      rooms: document.getElementById("modalStatsRooms"),
      users: document.getElementById("modalStatsUsers"),
      version: document.getElementById("modalStatsVersion"),
      uptime: document.getElementById("modalStatsUptime"),
      utilizationPercentage: document.getElementById(
        "modalUtilizationPercentage",
      ),
      utilizationFill: document.getElementById("modalUtilizationFill"),
      public: document.getElementById("modalStatsPublic"),
      semiPrivate: document.getElementById("modalStatsSemiPrivate"),
      private: document.getElementById("modalStatsPrivate"),
      lastUpdated: document.getElementById("modalLastUpdated"),
      refreshIndicator: document.getElementById("modalRefreshIndicator"),
    };

    this.init();
  }

  init() {
    this.closeButton.addEventListener("click", () => this.close());
    this.refreshButton.addEventListener("click", () => this.fetchStats());

    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) {
        this.close();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        this.close();
      }
    });
  }

  async open() {
    this.isOpen = true;
    this.modal.classList.add("show");
    document.body.style.overflow = "hidden";

    this.showLoading();
    await this.fetchStats();
  }

  close() {
    this.isOpen = false;
    this.modal.classList.remove("show");
    document.body.style.overflow = "";
  }

  showLoading() {
    this.loadingSection.style.display = "block";
    this.errorSection.style.display = "none";
    this.contentSection.style.display = "none";
  }

  showError() {
    this.loadingSection.style.display = "none";
    this.errorSection.style.display = "block";
    this.contentSection.style.display = "none";
  }

  showContent() {
    this.loadingSection.style.display = "none";
    this.errorSection.style.display = "none";
    this.contentSection.style.display = "block";
  }

  async fetchStats() {
    try {
      if (this.isOpen) {
        this.showLoading();
      }

      const [healthResponse, configResponse] = await Promise.all([
        fetch("/api/v1/health", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }),
        fetch("/api/v1/config", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }).catch(() => null),
      ]);

      if (!healthResponse.ok) {
        throw new Error(
          `HTTP ${healthResponse.status}: ${healthResponse.statusText}`,
        );
      }

      const healthData = await healthResponse.json();
      const configData =
        configResponse && configResponse.ok
          ? await configResponse.json()
          : null;

      this.updateStatsDisplay(healthData, configData);
      this.setConnectionStatus(true);

      if (this.isOpen) {
        this.showContent();
      }
    } catch (error) {
      console.error("Error fetching server stats:", error);
      this.setConnectionStatus(false);

      if (this.isOpen) {
        this.showError();
      }
    }
  }

  updateStatsDisplay(healthData, configData) {
    const stats = healthData.roomStatistics || {};

    this.elements.rooms.textContent = `${stats.totalRooms || 0}/${
      stats.currentLimit || 15
    }`;
    this.elements.users.textContent = stats.totalUsers || 0;
    this.elements.version.textContent = healthData.version || "Unknown";

    const uptime = healthData.uptime || 0;
    this.elements.uptime.textContent = this.formatUptime(uptime);

    const utilization = stats.utilizationPercentage || 0;
    this.elements.utilizationPercentage.textContent = `${utilization}%`;
    this.elements.utilizationFill.style.width = `${Math.min(utilization, 100)}%`;

    if (stats.roomTypes) {
      this.elements.public.textContent = stats.roomTypes.public || 0;
      this.elements.semiPrivate.textContent =
        stats.roomTypes["semi-private"] || 0;
      this.elements.private.textContent = stats.roomTypes.private || 0;
    }

    this.lastUpdateTime = new Date();
    this.elements.lastUpdated.textContent = `Last updated ${this.formatTime(
      this.lastUpdateTime,
    )}`;
  }

  setConnectionStatus(connected) {
    if (connected) {
      this.elements.refreshIndicator.classList.remove("offline");
    } else {
      this.elements.refreshIndicator.classList.add("offline");
    }
  }

  formatTime(date) {
    return date.toLocaleTimeString("en-US", {
      hour12: true,
      hour: "numeric",
      minute: "2-digit",
    });
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }
}

// ============================================================================
// ============================================================================

const connectionStatus = document.createElement("div");
connectionStatus.id = "connectionStatus";
connectionStatus.style.position = "fixed";
connectionStatus.style.bottom = "10px";
connectionStatus.style.right = "10px";
connectionStatus.style.padding = "5px 10px";
connectionStatus.style.borderRadius = "5px";
connectionStatus.style.fontSize = "12px";
connectionStatus.style.fontWeight = "bold";
connectionStatus.style.zIndex = "1000";
document.body.appendChild(connectionStatus);

function updateConnectionStatus() {
  if (socket.connected) {
    connectionStatus.textContent = "Connected";
    connectionStatus.style.backgroundColor = "#070707";
    connectionStatus.style.color = "white";
  } else {
    connectionStatus.textContent = "Disconnected";
    connectionStatus.style.backgroundColor = "#F44336";
    connectionStatus.style.color = "white";
  }
}

// ============================================================================
// ============================================================================

const socket = io({
  transports: ["websocket"],
  upgrade: false,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true,
  withCredentials: true,
  auth: {
    devKey: localStorage.getItem("talkomatic_devKey") || undefined,
    modKey: localStorage.getItem("talkomatic_modKey") || undefined,
    staffHidden: localStorage.getItem("talkomatic_devHidden") || undefined,
    deviceId:
      (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
      undefined,
  },
});
if (window.TalkomaticConnection) window.TalkomaticConnection.attach(socket);
if (window.TalkoDesk) window.TalkoDesk.init(socket);

// ============================================================================
// ============================================================================

const logForm = document.getElementById("logform");
const createRoomForm = document.getElementById("lobbyForm");
const createRoomHeading = document.querySelector(".createRoom");
function setCreateRoomVisible(show) {
  createRoomForm.classList.toggle("hidden", !show);
  if (createRoomHeading) createRoomHeading.classList.toggle("hidden", !show);
}
const roomListContainer = document.querySelector(".roomList");
const dynamicRoomList = document.getElementById("dynamicRoomList");
const usernameInput = logForm.querySelector('input[placeholder="Your Name"]');
const locationInput = logForm.querySelector(
  'input[placeholder="Location - On The Web"]',
);
const roomNameInput = createRoomForm.querySelector(
  'input[placeholder="Room Name"]',
);
const goChatButton = createRoomForm.querySelector(".go-chat-button");
const signInButton = logForm.querySelector('button[type="submit"]');
const signInMessage = document.getElementById("signInMessage");
const noRoomsMessage = document.getElementById("noRoomsMessage");
const accessCodeInput = document.getElementById("accessCodeInput");
const roomTypeRadios = document.querySelectorAll('input[name="roomType"]');

let currentUsername = "";
let currentLocation = "";
let currentUserId = null;
let isSignedIn = false;
const MAX_USERNAME_LENGTH = 15;
const MAX_LOCATION_LENGTH = 20;
const MAX_ROOM_NAME_LENGTH = 25;

function isGuestUsername(name) {
  if (typeof name !== "string") return true;
  const n = name.trim();
  if (!n) return true;
  if (n.length < 3 || (n.match(/[\p{L}\p{N}]/gu) || []).length < 2) return true;
  return (
    /^guest[\s._-]*[0-9a-f]*$/i.test(n) || /^(anonymous|someone|unknown)$/i.test(n)
  );
}
const ROOM_SIZE_MIN = 5;
let devLobbyCodes = {};
let statsModal = null;
let currentUserIsDev = false;
let currentUserIsMod = false;
let currentUserModLevel = 0;

// ============================================================================
// ============================================================================

function checkSignInStatus() {
  if (socket.connected) {
    socket.emit("check signin status");
  } else {
    socket.once("connect", () => {
      socket.emit("check signin status");
    });
  }
}

function setSignedInButtonState() {
  while (signInButton.firstChild) {
    signInButton.removeChild(signInButton.firstChild);
  }
  signInButton.appendChild(document.createTextNode("Change "));

  const img = document.createElement("img");
  img.src = "images/icons/pencil.png";
  img.alt = "Arrow";
  img.classList.add("arrow-icon");
  signInButton.appendChild(img);
}

function setSignInState(username, location, shouldPersist = true) {
  currentUsername = username;
  currentLocation = location;
  isSignedIn = true;

  usernameInput.value = currentUsername;
  locationInput.value = currentLocation;
  setSignedInButtonState();
  setCreateRoomVisible(true);

  if (shouldPersist) {
    localStorage.setItem("talkomaticUsername", currentUsername);
    localStorage.setItem("talkomaticLocation", currentLocation);
  }
}

// ── Discord avatar (pfp) ────────────────────────────────────────────────────
const PFP_ID_RE = /^\d{17,20}$/;
const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

function presetNumber(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : 0;
}

function presetUrl(n) {
  return "/images/pfp/" + n + ".png";
}

function storedPreset() {
  try {
    return presetNumber(localStorage.getItem("talkomaticPresetPfp"));
  } catch (e) {
    return 0;
  }
}

function storedAvatar() {
  const preset = storedPreset();
  if (preset) return { preset };
  try {
    if (localStorage.getItem("talkomaticPfpEnabled") !== "1") return null;
    const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
    if (c && PFP_ID_RE.test(c.discordId) && PFP_HASH_RE.test(c.hash))
      return { discordId: c.discordId, hash: c.hash, animated: !!c.animated };
  } catch (e) {}
  return null;
}

function avatarUrl(av, size) {
  if (!av) return null;
  const preset = presetNumber(av.preset);
  if (preset) return presetUrl(preset);
  const id = av.discordId || av.id;
  if (!PFP_ID_RE.test(id || "") || !PFP_HASH_RE.test(av.hash || "")) return null;
  return (
    "https://cdn.discordapp.com/avatars/" + id + "/" + av.hash +
    ".webp?size=" + (size || 64) + (av.animated ? "&animated=true" : "")
  );
}

async function resolveAvatar(discordId, fresh) {
  if (!fresh) {
    try {
      const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
      if (
        c && c.discordId === discordId &&
        Date.now() - (c.fetchedAt || 0) < 10 * 60 * 1000
      )
        return c;
    } catch (e) {}
  }
  const res = await fetch(
    "https://pfpgrab.com/api/v1/users/" + discordId + "?size=64" +
      (fresh ? "&_=" + Date.now() : ""),
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && body.error && body.error.code;
    throw new Error(
      code === "user_not_found"
        ? "No Discord account has that ID."
        : code === "rate_limited"
          ? "Avatar service is busy, try again in a minute."
          : "Could not look up that Discord ID.",
    );
  }
  if (!body || !body.avatar || body.avatar.is_default || !body.avatar.hash) {
    localStorage.setItem("talkomaticPfpMiss", discordId);
    throw new Error("That Discord account has no profile picture set.");
  }
  localStorage.removeItem("talkomaticPfpMiss");
  const av = {
    discordId,
    hash: body.avatar.hash,
    animated: !!body.avatar.animated,
    fetchedAt: Date.now(),
  };
  localStorage.setItem("talkomaticPfp", JSON.stringify(av));
  return av;
}

function emitJoinLobby(username, location) {
  const payload = {
    username,
    location,
    avatar: storedAvatar(),
  };

  if (socket.connected) {
    socket.emit("join lobby", payload);
  } else {
    socket.once("connect", () => {
      socket.emit("join lobby", payload);
    });
  }
}

// ============================================================================
// ============================================================================

socket.on("connect", () => {
  console.log("Socket connected successfully");
  updateConnectionStatus();
});

socket.on("disconnect", (reason) => {
  console.log(`Socket disconnected: ${reason}`);
  updateConnectionStatus();

  if (reason === "io server disconnect") {
    socket.connect();
  }
});

// Reconnection itself is socket.io's job (endless, backed-off attempts set
// up top); the shared connection overlay tells the user when an outage
// outlives its grace period.
socket.on("connect_error", (error) => {
  if (error?.data?.banned) {
    try {
      socket.io.opts.reconnection = false;
      socket.disconnect();
    } catch (_) {}
    showBanScreen(error.data);
    return;
  }
  console.error("Connection error:", error);
  updateConnectionStatus();
});

socket.on("reconnect", (attemptNumber) => {
  console.log(`Reconnected after ${attemptNumber} attempts`);
  updateConnectionStatus();
  checkSignInStatus();
});

socket.on("staff warning", (data) => {
  const msg = (data && data.message) || "Please follow the Talkomatic rules.";
  if (window.toastr)
    toastr.warning(msg, "Staff warning", { timeOut: 12000, closeButton: true });
});

let tabSuperseded = false;
function showTabSupersededOverlay() {
  if (tabSuperseded) return;
  tabSuperseded = true;
  try {
    socket.io.opts.reconnection = false;
    socket.disconnect();
  } catch (_) {}
  const ov = document.createElement("div");
  ov.id = "supersededOverlay";
  ov.innerHTML =
    '<div class="ss-card">' +
    '<div class="ss-icon"><i class="fas fa-window-restore"></i></div>' +
    "<h1>This tab is paused</h1>" +
    "<p>Talkomatic is now open in another tab. Only one tab can be active at a time, so this one was paused.</p>" +
    '<button id="ssUseHere">Use this tab</button>' +
    "</div>";
  document.body.appendChild(ov);
  const btn = document.getElementById("ssUseHere");
  if (btn) btn.addEventListener("click", () => window.location.reload());
}
socket.on("session superseded", showTabSupersededOverlay);

// ── Ban screen: big, clear, with a live countdown or a permanent notice ───────
let banScreenShown = false;
function showBanScreen(info) {
  if (banScreenShown) return;
  banScreenShown = true;
  const DISCORD = "https://discord.gg/N7tJznESrE";

  const permanent = !!info.permanent;
  const timerHtml = permanent
    ? '<div class="ban-perm"><i class="fas fa-ban"></i> Permanent ban</div>'
    : '<div class="ban-timer"><div class="ban-timer-label">Time remaining</div>' +
      '<div class="ban-timer-value" id="banCountdown">--:--:--</div></div>';
  const foot =
    '<div class="ban-foot">' +
    '<a class="ban-discord" href="' +
    DISCORD +
    '" target="_blank" rel="noopener noreferrer">' +
    '<i class="fab fa-discord"></i> Talkomatic Discord</a>' +
    '<p class="ban-note">' +
    (permanent ? "" : "This page updates itself the moment your ban ends. ") +
    "Every appeal is read by a person." +
    "</p>" +
    "</div>";

  const overlay = document.createElement("div");
  overlay.id = "banScreen";
  overlay.innerHTML =
    '<div class="ban-card">' +
    '<div class="ban-hd">' +
    '<i class="fas fa-gavel ban-icon"></i>' +
    "<h1>Access blocked</h1>" +
    '<span class="ban-hd-sub">Talkomatic</span>' +
    "</div>" +
    '<div class="ban-body">' +
    '<p class="ban-sub">' +
    (permanent
      ? "A moderator has permanently blocked your access to Talkomatic."
      : "A moderator has temporarily blocked your access to Talkomatic.") +
    "</p>" +
    '<div class="ban-meta" id="banMeta"></div>' +
    '<div class="ban-strip" id="banReason" style="display:none">' +
    '<div class="lbl"><i class="fas fa-comment-dots"></i> Reason from staff</div>' +
    '<div class="txt" id="banReasonText"></div>' +
    "</div>" +
    timerHtml +
    '<div class="ban-appeal" id="banAppealWrap">' +
    '<div class="ban-appeal-h"><i class="fas fa-scale-balanced"></i> Appeal this ban</div>' +
    '<p class="ban-appeal-p">Think this was a mistake? Say what happened. A moderator reads it and can ask you questions here.</p>' +
    '<textarea id="banAppealText" maxlength="1000" placeholder="Explain why this ban should be lifted..."></textarea>' +
    '<div class="ban-appeal-row">' +
    '<button id="banAppealSend"><i class="fas fa-paper-plane"></i> Send appeal</button>' +
    '<span class="ban-appeal-msg" id="banAppealMsg"></span>' +
    "</div>" +
    "</div>" +
    foot +
    "</div>" +
    "</div>";
  document.body.appendChild(overlay);

  if (info.reason) {
    const rc = document.getElementById("banReason");
    const rt = document.getElementById("banReasonText");
    if (rc && rt) {
      rt.textContent = info.reason;
      rc.style.display = "block";
    }
  }

  const meta = document.getElementById("banMeta");
  if (meta) {
    const addChip = (faClass, label, value) => {
      const chip = document.createElement("span");
      chip.className = "ban-chip";
      const i = document.createElement("i");
      i.className = faClass;
      chip.appendChild(i);
      chip.appendChild(document.createTextNode(" " + label + " "));
      const b = document.createElement("b");
      b.textContent = value;
      chip.appendChild(b);
      meta.appendChild(chip);
    };
    if (info.by) addChip("fas fa-user-shield", "Banned by", String(info.by));
    if (info.bannedAt) {
      let when = "";
      try {
        when = new Date(info.bannedAt).toLocaleDateString();
      } catch (_) {
        when = "";
      }
      if (when) addChip("fas fa-calendar-day", "Banned on", when);
    }
  }

  const deviceIdOf = () =>
    (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
    undefined;

  let appealState = null;
  let appealReplyTo = null;
  let appealPollTimer = null;

  const fmtClock = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  };

  const PFP_ID_RE = /^\d{17,20}$/;
  const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;
  const banAvatarSeen = new Set();
  function appealFace(m) {
    const wrap = document.createElement("span");
    wrap.className = "ac-av" + (m.role === "dev" ? " dev" : "");
    const letter = document.createElement("span");
    letter.className = "ac-av-i";
    letter.textContent = (m.by || "S").trim().charAt(0).toUpperCase();
    wrap.appendChild(letter);
    const url = avatarUrl(m.avatar || {}, 64);
    if (!url) return wrap;
    const img = document.createElement("img");
    img.loading = "eager";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    let retried = false;
    img.addEventListener("load", () => {
      banAvatarSeen.add(url);
      wrap.classList.add("has-pic");
    });
    img.addEventListener("error", () => {
      if (banAvatarSeen.has(url) && !retried) {
        retried = true;
        setTimeout(() => {
          img.src = url + "&r=1";
        }, 400);
        return;
      }
      img.remove();
      wrap.classList.remove("has-pic");
    });
    img.src = url;
    wrap.appendChild(img);
    return wrap;
  }

  function showAppealDone(text, heading) {
    const wrap = document.getElementById("banAppealWrap");
    if (!wrap) return;
    wrap.textContent = "";
    const h = document.createElement("div");
    h.className = "ban-appeal-h";
    const hi = document.createElement("i");
    hi.className = "fas fa-scale-balanced";
    h.appendChild(hi);
    h.appendChild(document.createTextNode(" " + (heading || "Appeal")));
    wrap.appendChild(h);
    const p = document.createElement("p");
    p.className = "ban-appeal-p";
    p.textContent = text;
    wrap.appendChild(p);
  }

  function showAppealBarred() {
    showAppealDone(
      "Appeals are closed for this account. A previous appeal was declined and " +
        "the decision was final, so no further appeals can be filed.",
      "Appeal closed",
    );
  }

  function renderAppealChat() {
    const wrap = document.getElementById("banAppealWrap");
    if (!wrap || !appealState || !appealState.has) return;
    const d = appealState;
    wrap.textContent = "";

    const h = document.createElement("div");
    h.className = "ban-appeal-h";
    const hi = document.createElement("i");
    hi.className = "fas fa-scale-balanced";
    h.appendChild(hi);
    h.appendChild(document.createTextNode(" Your appeal"));
    wrap.appendChild(h);

    const p = document.createElement("p");
    p.className = "ban-appeal-p";
    p.textContent =
      d.status === "resolved"
        ? d.resolution === "lifted"
          ? "This appeal was accepted."
          : "This appeal was declined."
        : d.locked
          ? "Staff ended this chat. Your appeal is still being reviewed."
          : "A staff member will read this and may ask you questions. Answer here.";
    wrap.appendChild(p);

    const log = document.createElement("div");
    log.className = "ac-log";
    for (const m of d.messages || []) {
      if (m.from === "system") {
        const s = document.createElement("div");
        s.className = "ac-sys";
        s.textContent = m.text;
        log.appendChild(s);
        continue;
      }
      const row = document.createElement("div");
      row.className = "ac-m " + (m.from === "user" ? "user" : "staff");
      const who = document.createElement("div");
      who.className = "ac-who";
      if (m.from === "user") {
        who.textContent = "You";
      } else {
        who.appendChild(appealFace(m));
        const nm = document.createElement("span");
        nm.className = "ac-name";
        nm.textContent = m.by || "Staff";
        who.appendChild(nm);
        const rank = document.createElement("span");
        const isDev = m.role === "dev";
        rank.className = "ac-rank" + (isDev ? " dev" : "");
        rank.textContent = isDev
          ? "Admin"
          : m.level === 1
            ? "Moderator"
            : "Moderator";
        who.appendChild(rank);
      }
      row.appendChild(who);
      const b = document.createElement("div");
      b.className = "ac-b";
      if (m.reply) {
        const q = document.createElement("span");
        q.className = "ac-q";
        q.textContent =
          (m.reply.from === "user" ? "You" : m.reply.by || "Staff") +
          ": " +
          m.reply.text;
        b.appendChild(q);
      }
      b.appendChild(document.createTextNode(m.text || ""));
      row.appendChild(b);
      const foot = document.createElement("div");
      foot.className = "ac-t";
      foot.textContent = fmtClock(m.ts);
      if (d.canWrite && m.from === "staff") {
        foot.appendChild(document.createTextNode("  "));
        const rb = document.createElement("button");
        rb.className = "ac-rbtn";
        rb.type = "button";
        rb.textContent = "reply";
        rb.addEventListener("click", () => {
          appealReplyTo = { id: m.id, by: m.by || "Staff", text: m.text || "" };
          renderAppealChat();
          const ta = document.getElementById("banAppealText");
          if (ta) ta.focus();
        });
        foot.appendChild(rb);
      }
      row.appendChild(foot);
      log.appendChild(row);
    }
    wrap.appendChild(log);
    log.scrollTop = log.scrollHeight;

    if (!d.canWrite) {
      const closed = document.createElement("div");
      closed.className = "ac-closed";
      closed.textContent =
        d.status === "resolved"
          ? "This appeal is closed. Any moderator can reopen it if they think it deserves another look, and this page will say so. If your ban is still in place, the Discord link below is the next stop."
          : d.awaitingReply
            ? "Sent. Staff will read it and reply here - you will be able to write again once they have. Adding more now would only push your appeal down the queue."
            : "You cannot send any more messages here. Staff will still read what you have written.";
      wrap.appendChild(closed);
      return;
    }

    if (appealReplyTo) {
      const r = document.createElement("div");
      r.className = "ac-reply";
      const s = document.createElement("span");
      s.textContent =
        "Replying to " + appealReplyTo.by + ": " + appealReplyTo.text;
      r.appendChild(s);
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "Cancel the reply";
      x.addEventListener("click", () => {
        appealReplyTo = null;
        renderAppealChat();
      });
      r.appendChild(x);
      wrap.appendChild(r);
    }

    const ta = document.createElement("textarea");
    ta.id = "banAppealText";
    ta.maxLength = 1000;
    ta.placeholder = "Write a reply...";
    ta.style.marginTop = "10px";
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendAppealMessage();
      }
    });
    wrap.appendChild(ta);

    const row = document.createElement("div");
    row.className = "ban-appeal-row";
    const btn = document.createElement("button");
    btn.id = "banAppealSend";
    const bi = document.createElement("i");
    bi.className = "fas fa-paper-plane";
    btn.appendChild(bi);
    btn.appendChild(document.createTextNode(" Send"));
    btn.addEventListener("click", sendAppealMessage);
    row.appendChild(btn);
    const msg = document.createElement("span");
    msg.className = "ban-appeal-msg";
    msg.id = "banAppealMsg";
    row.appendChild(msg);
    if (d.left <= 5) {
      const left = document.createElement("span");
      left.className = "ban-appeal-msg";
      left.style.color = "#8d8d8d";
      left.textContent = d.left + " message" + (d.left === 1 ? "" : "s") + " left";
      row.appendChild(left);
    }
    wrap.appendChild(row);
  }

  const APPEAL_ERRORS = {
    locked: "Staff ended this chat. You cannot send any more messages.",
    closed: "This appeal has already been decided.",
    too_short: "Please write a little more.",
    too_many: "You have sent the maximum number of messages on this appeal.",
    slow_down: "One moment - wait a few seconds between messages.",
    wait_reply:
      "You have already written. Wait for staff to reply before sending another message.",
    barred: "Appeals are closed for this account.",
    no_appeal: "Your appeal could not be found. Try refreshing the page.",
  };

  function sendAppealMessage() {
    const ta = document.getElementById("banAppealText");
    const msgEl = document.getElementById("banAppealMsg");
    const btn = document.getElementById("banAppealSend");
    if (!ta || !btn) return;
    const text = (ta.value || "").trim();
    if (msgEl) {
      msgEl.className = "ban-appeal-msg";
      msgEl.textContent = "";
    }
    if (text.length < 2) {
      if (msgEl) {
        msgEl.classList.add("err");
        msgEl.textContent = "Please write a little more.";
      }
      return;
    }
    btn.disabled = true;
    fetch("/api/v1/appeal/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        message: text,
        deviceId: deviceIdOf(),
        replyTo: appealReplyTo ? appealReplyTo.id : undefined,
      }),
    })
      .then((r) => r.json().catch(() => ({ ok: false })))
      .then((d) => {
        if (d && d.ok && d.has) {
          appealState = d;
          appealReplyTo = null;
          renderAppealChat();
          return;
        }
        btn.disabled = false;
        if (msgEl) {
          msgEl.classList.add("err");
          msgEl.textContent =
            APPEAL_ERRORS[d && d.code] || "Could not send that. Try again.";
        }
        if (d && (d.code === "locked" || d.code === "closed")) pollAppeal();
      })
      .catch(() => {
        btn.disabled = false;
        if (msgEl) {
          msgEl.classList.add("err");
          msgEl.textContent = "Could not send that. Try again.";
        }
      });
  }

  function pollAppeal() {
    if (document.hidden) return;
    const q = deviceIdOf() ? "?deviceId=" + encodeURIComponent(deviceIdOf()) : "";
    fetch("/api/v1/appeal" + q, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !d.ok || !d.has) return;
        const sig =
          d.messages.length + "|" + d.status + "|" + (d.locked ? 1 : 0);
        const old = appealState
          ? appealState.messages.length +
            "|" +
            appealState.status +
            "|" +
            (appealState.locked ? 1 : 0)
          : "";
        appealState = d;
        if (sig !== old) {
          const ta = document.getElementById("banAppealText");
          const draft = ta ? ta.value : "";
          renderAppealChat();
          const ta2 = document.getElementById("banAppealText");
          if (ta2 && draft) ta2.value = draft;
        }
      })
      .catch(() => {});
  }

  function startAppealChat(payload) {
    appealState = payload;
    appealReplyTo = null;
    renderAppealChat();
    if (!appealPollTimer) appealPollTimer = setInterval(pollAppeal, 10000);
  }
  const sendBtn = document.getElementById("banAppealSend");
  if (sendBtn)
    sendBtn.addEventListener("click", () => {
      const ta = document.getElementById("banAppealText");
      const msgEl = document.getElementById("banAppealMsg");
      if (!ta || !msgEl) return;
      const text = (ta.value || "").trim();
      msgEl.className = "ban-appeal-msg";
      msgEl.textContent = "";
      if (text.length < 3) {
        msgEl.classList.add("err");
        msgEl.textContent = "Please write a little more.";
        return;
      }
      sendBtn.disabled = true;
      const prev = sendBtn.innerHTML;
      sendBtn.textContent = "Sending...";
      fetch("/api/v1/appeal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message: text, deviceId: deviceIdOf() }),
      })
        .then((r) => r.json().catch(() => ({ ok: false })))
        .then((d) => {
          if (d && (d.ok || d.code === "already" || d.code === "decided"))
            return pollIntoChat(true);
          sendBtn.disabled = false;
          sendBtn.innerHTML = prev;
          msgEl.classList.add("err");
          if (d && d.code === "barred") return showAppealBarred();
          if (d && d.code === "too_short")
            msgEl.textContent = "Please write a little more.";
          else if (d && d.code === "not_banned")
            msgEl.textContent =
              "Your ban may have already ended. Try refreshing the page.";
          else msgEl.textContent = "Could not send your appeal. Please try again.";
        })
        .catch(() => {
          sendBtn.disabled = false;
          sendBtn.innerHTML = prev;
          msgEl.classList.add("err");
          msgEl.textContent = "Could not send your appeal. Please try again.";
        });
    });

  function pollIntoChat(justSent) {
    const q = deviceIdOf() ? "?deviceId=" + encodeURIComponent(deviceIdOf()) : "";
    return fetch("/api/v1/appeal" + q, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ok && d.barred && !d.has) return showAppealBarred();
        if (d && d.ok && d.has) return startAppealChat(d);
        if (justSent)
          showAppealDone("Appeal submitted. A staff member will review it.");
      })
      .catch(() => {
        if (justSent)
          showAppealDone("Appeal submitted. A staff member will review it.");
      });
  }

  pollIntoChat(false);

  if (!permanent && info.expiry) {
    const tick = () => {
      const el = document.getElementById("banCountdown");
      if (!el) return;
      const remaining = info.expiry - Date.now();
      if (remaining <= 0) {
        el.textContent = "00:00:00";
        window.location.reload();
        return;
      }
      el.textContent = formatBanRemaining(remaining);
    };
    tick();
    setInterval(tick, 1000);
  }

  let banLifted = false;
  const checkLifted = () => {
    if (banLifted || document.hidden) return;
    fetch("/api/v1/ban-status", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (banLifted || !d || typeof d.banned !== "boolean" || d.banned)
          return;
        banLifted = true;
        try {
          sessionStorage.setItem("tk_ban_lifted", "1");
        } catch (_) {}
        const sub = document.querySelector("#banScreen .ban-sub");
        if (sub) {
          sub.textContent =
            "Good news - your ban has been lifted. Reloading...";
          sub.style.color = "#57d9a3";
        }
        setTimeout(() => window.location.reload(), 1200);
      })
      .catch(() => {});
  };
  setInterval(checkLifted, 20000);
  document.addEventListener("visibilitychange", checkLifted);
}

function formatBanRemaining(ms) {
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  return (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
}

socket.on("dev lobby context", (codes) => {
  devLobbyCodes = codes || {};
});

// ============================================================================
// ============================================================================

roomTypeRadios.forEach((radio) => {
  radio.addEventListener("change", (e) => {
    if (e.target.value === "semi-private") {
      accessCodeInput.style.display = "block";
    } else {
      accessCodeInput.style.display = "none";
    }
  });
});

logForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const newUsername = usernameInput.value.trim().slice(0, MAX_USERNAME_LENGTH);
  const newLocation = (locationInput.value.trim() || "On The Web").slice(
    0,
    MAX_LOCATION_LENGTH,
  );

  if (!newUsername) {
    window.showErrorModal("Please enter a username.");
    return;
  }
  if (
    newUsername.length < 3 ||
    (newUsername.match(/[\p{L}\p{N}]/gu) || []).length < 2
  ) {
    window.showErrorModal(
      "Usernames need at least 3 characters, mostly letters or numbers.",
    );
    return;
  }
  if (newLocation.length < 3) {
    window.showErrorModal(
      "Locations need at least 3 characters. Leave it blank for On The Web.",
    );
    return;
  }
  if (isGuestUsername(newUsername)) {
    window.showErrorModal(
      "Guest names are not allowed. Please choose a username.",
    );
    return;
  }

  {
    localStorage.setItem("talkomaticUsername", newUsername);
    localStorage.setItem("talkomaticLocation", newLocation);

    const master = document.getElementById("pfpMasterEnable");
    const pfpIdInput = document.getElementById("pfpDiscordId");
    const source = document.querySelector(".pfp-seg-btn.active");
    const wantsDiscord =
      master && master.checked && source && source.dataset.source === "discord";
    if (wantsDiscord) {
      const rawId = (pfpIdInput ? pfpIdInput.value : "").trim();
      if (!PFP_ID_RE.test(rawId)) {
        lobbyNotify(
          "That does not look like a Discord user ID (17-20 digits).",
          "error",
          { timeout: 6000 },
        );
        localStorage.removeItem("talkomaticPfpEnabled");
      } else {
        try {
          const fresh = localStorage.getItem("talkomaticPfpMiss") === rawId;
          await resolveAvatar(rawId, fresh);
          localStorage.setItem("talkomaticPfpEnabled", "1");
        } catch (err) {
          localStorage.removeItem("talkomaticPfpEnabled");
          lobbyNotify(err.message || "Could not load that avatar.", "error", {
            timeout: 6000,
          });
        }
      }
    } else {
      localStorage.removeItem("talkomaticPfpEnabled");
    }
    updatePfpPreview();

    if (currentUsername) {
      signInButton.textContent = "Changed";
      setTimeout(() => {
        setSignedInButtonState();
      }, 2000);
    } else {
      setSignedInButtonState();
      setCreateRoomVisible(true);
    }

    currentUsername = newUsername;
    currentLocation = newLocation;
    isSignedIn = true;

    emitJoinLobby(currentUsername, currentLocation);

    showRoomList();
  }
});

function updatePfpPreview() {
  const img = document.getElementById("pfpPreview");
  if (!img) return;
  // Same precedence as storedAvatar: a chosen preset wins over Discord.
  let url = null;
  const preset = storedPreset();
  if (preset) {
    url = presetUrl(preset);
  } else {
    try {
      if (localStorage.getItem("talkomaticPfpEnabled") === "1") {
        const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
        if (c && PFP_ID_RE.test(c.discordId) && PFP_HASH_RE.test(c.hash))
          url = avatarUrl(
            { discordId: c.discordId, hash: c.hash, animated: !!c.animated },
            32,
          );
      }
    } catch (e) {}
  }
  if (url) {
    img.src = url;
    img.style.display = "inline-block";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
  }
}

(function initPfpControls() {
  const master = document.getElementById("pfpMasterEnable");
  const body = document.getElementById("pfpCardBody");
  const segButtons = Array.from(document.querySelectorAll(".pfp-seg-btn"));
  const presetPane = document.getElementById("presetPane");
  const discordPane = document.getElementById("discordPane");
  const grid = document.getElementById("presetGrid");
  const input = document.getElementById("pfpDiscordId");
  const helpBtn = document.getElementById("pfpHelpBtn");
  const help = document.getElementById("pfpHelp");
  if (!master || !grid || !input) return;

  let available = null;
  let building = false;

  const activeSource = () => {
    const btn = segButtons.find((b) => b.classList.contains("active"));
    return btn ? btn.dataset.source : "preset";
  };

  const setSource = (source) => {
    for (const b of segButtons) {
      const on = b.dataset.source === source;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    if (presetPane)
      presetPane.style.display = source === "preset" ? "" : "none";
    if (discordPane)
      discordPane.style.display = source === "discord" ? "" : "none";
    if (source !== "discord" && help) help.style.display = "none";
  };

  const paint = () => {
    const chosen = storedPreset();
    const opts = grid.querySelectorAll(".preset-opt");
    let first = true;
    for (const btn of opts) {
      const on = Number(btn.dataset.preset) === chosen;
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.tabIndex = on || (!chosen && first) ? 0 : -1;
      first = false;
    }
    if (body) body.style.display = master.checked ? "block" : "none";
    updatePfpPreview();
  };

  const choose = (n) => {
    localStorage.setItem("talkomaticPresetPfp", String(n));
    localStorage.removeItem("talkomaticPfpEnabled");
    paint();
  };

  const addOption = (n) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-opt";
    btn.dataset.preset = String(n);
    btn.setAttribute("role", "radio");
    btn.title = "Picture " + n;
    btn.setAttribute("aria-label", "Profile picture " + n);
    const img = document.createElement("img");
    img.src = presetUrl(n);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => btn.remove();
    btn.appendChild(img);
    btn.addEventListener("click", () => choose(n));
    grid.appendChild(btn);
  };

  const build = async () => {
    if (building || grid.querySelector(".preset-opt")) return;
    building = true;
    grid.textContent = "";
    if (!available) {
      try {
        const res = await fetch("/api/v1/avatars");
        const body2 = res.ok ? await res.json() : null;
        if (body2 && Array.isArray(body2.presets)) available = body2.presets;
      } catch (e) {}
    }
    building = false;
    if (!available || !available.length) {
      grid.textContent = "Pictures could not be loaded. Try again in a moment.";
      grid.className = "preset-grid preset-empty";
      return;
    }
    grid.className = "preset-grid";
    for (const n of available) if (presetNumber(n)) addOption(n);
    const keep = storedPreset();
    if (keep && available.indexOf(keep) === -1)
      localStorage.setItem("talkomaticPresetPfp", String(available[0]));
    paint();
  };

  const ensurePresetChosen = async () => {
    await build();
    const keep = storedPreset();
    const pick =
      keep && (!available || available.indexOf(keep) !== -1)
        ? keep
        : available && available.length
          ? available[0]
          : 0;
    if (pick) choose(pick);
    else paint();
  };

  for (const btn of segButtons) {
    btn.addEventListener("click", async () => {
      if (btn.classList.contains("active")) return;
      setSource(btn.dataset.source);
      if (btn.dataset.source === "preset") {
        localStorage.removeItem("talkomaticPfpEnabled");
        await ensurePresetChosen();
      } else {
        localStorage.removeItem("talkomaticPresetPfp");
        paint();
      }
    });
  }

  master.addEventListener("change", async () => {
    if (master.checked) {
      if (activeSource() === "preset") await ensurePresetChosen();
    } else {
      localStorage.removeItem("talkomaticPresetPfp");
      localStorage.removeItem("talkomaticPfpEnabled");
    }
    paint();
  });

  if (helpBtn && help)
    helpBtn.addEventListener("click", () => {
      help.style.display = help.style.display === "none" ? "block" : "none";
    });

  try {
    const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
    if (c && PFP_ID_RE.test(c.discordId)) input.value = c.discordId;
  } catch (e) {}

  let savedDiscord = false;
  try {
    savedDiscord = localStorage.getItem("talkomaticPfpEnabled") === "1";
  } catch (e) {}
  if (storedPreset()) {
    master.checked = true;
    setSource("preset");
    build();
  } else if (savedDiscord) {
    master.checked = true;
    setSource("discord");
  } else {
    setSource("preset");
  }
  paint();

  setTimeout(async () => {
    if (localStorage.getItem("talkomaticPfpEnabled") !== "1") return;
    const before = storedAvatar();
    if (!before || !before.discordId) return;
    try {
      const after = await resolveAvatar(before.discordId);
      if (after.hash !== before.hash) {
        updatePfpPreview();
        if (currentUsername)
          emitJoinLobby(currentUsername, currentLocation || "");
      }
    } catch (e) {
      localStorage.removeItem("talkomaticPfpEnabled");
      localStorage.removeItem("talkomaticPfp");
      master.checked = false;
      paint();
      if (currentUsername)
        emitJoinLobby(currentUsername, currentLocation || "");
    }
  }, 4000);
})();

goChatButton.addEventListener("click", () => {
  if (!socket.connected) {
    window.showErrorModal(
      "Not connected to server. Please wait for connection or refresh the page.",
      "SERVER_ERROR",
    );
    return;
  }

  const roomName = roomNameInput.value.trim().slice(0, MAX_ROOM_NAME_LENGTH);
  const roomType = document.querySelector(
    'input[name="roomType"]:checked',
  )?.value;
  const sizeEl = document.getElementById("roomSizeSlider");
  const maxSize = Math.max(
    ROOM_SIZE_MIN,
    Math.min(roomSizeCeiling(), Number(sizeEl?.value) || ROOM_SIZE_MIN),
  );
  const accessCode = accessCodeInput.querySelector("input").value;
  const allowBots =
    document.querySelector('input[name="allowBots"]:checked')?.value !== "no";

  if (roomName && roomType) {
    if (roomType === "semi-private") {
      if (!accessCode || accessCode.length !== 6 || !/^\d+$/.test(accessCode)) {
        window.showErrorModal(
          "Please enter a valid 6-digit access code for the semi-private room.",
        );
        return;
      }
    }

    socket.emit("create room", {
      name: roomName,
      type: roomType,
      maxSize,
      accessCode,
      allowBots,
    });
  } else {
    window.showErrorModal("Please fill in all room details.");
  }
});

dynamicRoomList.addEventListener("click", (e) => {
  if (e.target.classList.contains("enter-button") && !e.target.disabled) {
    if (!socket.connected) {
      window.showErrorModal(
        "Not connected to server. Please wait for connection or refresh the page.",
        "SERVER_ERROR",
      );
      return;
    }

    const roomElement = e.target.closest(".room");
    const roomId = roomElement.dataset.roomId;
    const roomType = roomElement.dataset.roomType;

    if (roomType === "semi-private") {
      promptAccessCode(roomId);
    } else {
      joinRoom(roomId);
    }
  }
});

// ============================================================================
// ============================================================================

function promptAccessCode(roomId) {
  window.showInputModal(
    "Access Code Required",
    "Please enter the 6-digit access code for this room:",
    {
      placeholder: "6-digit code",
      maxLength: "6",
      validate: (value) => {
        if (!value) return "Access code is required";
        if (value.length !== 6 || !/^\d+$/.test(value)) {
          return "Invalid access code. Please enter a 6-digit number.";
        }
        return true;
      },
    },
    (confirmed, accessCode) => {
      if (confirmed && accessCode) {
        joinRoom(roomId, accessCode);
      }
    },
  );
}

function joinRoom(roomId, accessCode = null) {
  if (!socket.connected) {
    window.showErrorModal(
      "Not connected to server. Please wait for connection or refresh the page.",
      "SERVER_ERROR",
    );
    return;
  }

  socket.emit("join room", { roomId, accessCode });
}

socket.on("access code required", () => {
  const roomId = new URLSearchParams(window.location.search).get("roomId");
  promptAccessCode(roomId);
});

socket.on("room joined", (data) => {
  window.location.href = `/room.html?roomId=${data.roomId}`;
});

socket.on("room created", (roomId) => {
  window.location.href = `/room.html?roomId=${roomId}`;
});

// ============================================================================
// ============================================================================

socket.on("signin status", (data) => {
  currentUserIsDev = !!data.isDev;
  currentUserIsMod = !!data.isMod;
  currentUserModLevel = data.modLevel || 0;
  if (currentUserIsDev || currentUserIsMod) ensureDevPanelButton();
  updateStaffLink();
  applyRoomSizeCeiling();
  if (data.isSignedIn) {
    currentUsername = data.username;
    currentLocation = data.location;
    currentUserId = data.userId;
    isSignedIn = true;

    usernameInput.value = currentUsername;
    locationInput.value = currentLocation;

    localStorage.setItem("talkomaticUsername", currentUsername);
    localStorage.setItem("talkomaticLocation", currentLocation);

    setSignedInButtonState();
    setCreateRoomVisible(true);

    showRoomList();
  } else {
    signInMessage.style.display = "block";
    roomListContainer.style.display = "none";
  }
});

function signOut() {
  localStorage.removeItem("talkomaticUsername");
  localStorage.removeItem("talkomaticLocation");

  currentUsername = "";
  currentLocation = "";
  currentUserId = null;
  isSignedIn = false;
  usernameInput.value = "";
  locationInput.value = "";

  while (signInButton.firstChild) {
    signInButton.removeChild(signInButton.firstChild);
  }
  signInButton.appendChild(document.createTextNode("Sign In"));

  setCreateRoomVisible(false);
  signInMessage.style.display = "block";
  roomListContainer.style.display = "none";

  if (socket.connected) {
    socket.emit("leave lobby");
  }
}

// ============================================================================
// ============================================================================

socket.on("lobby update", (rooms) => {
  updateLobby(rooms);
});

socket.on("error", (error) => {
  console.log(error);
  window.showErrorModal(
    (error.error.replaceDefaultText ? "" : `An error occurred: `) +
      error.error.message,
    error.error.code,
  );
});

function getJoinableCount(room) {
  if (!room) return 0;
  if (typeof room.userCount === "number") return room.userCount;
  if (!Array.isArray(room.users)) return 0;
  return room.users.filter((user) => !user?.isDev).length;
}

function createRoomElement(room) {
  const roomElement = document.createElement("div");
  roomElement.classList.add("room");
  roomElement.dataset.roomId = room.id;
  roomElement.dataset.roomType = room.type;
  if (room.spotlight) roomElement.classList.add("spotlight-room");

  const joinableCount = getJoinableCount(room);
  const capacity = room.capacity || 5;
  const isFull = !!room.isFull || joinableCount >= capacity;

  const enterButton = document.createElement("button");
  enterButton.classList.add("enter-button");
  if (isFull) {
    enterButton.textContent = "Full";
    enterButton.disabled = true;
    roomElement.classList.add("full");
  } else {
    enterButton.textContent = "Enter";
  }

  const roomTop = document.createElement("div");
  roomTop.classList.add("room-top");

  const roomInfo = document.createElement("div");
  roomInfo.classList.add("room-info");

  const roomNameDiv = document.createElement("div");
  roomNameDiv.classList.add("room-name");
  roomNameDiv.textContent = `${room.name} (${joinableCount}/${capacity} People)`;
  if (room.spotlight) {
    const star = document.createElement("span");
    star.className = "official-badge";
    star.textContent = "★ OFFICIAL";
    roomNameDiv.prepend(star);
  }

  const roomDetailsDiv = document.createElement("div");
  roomDetailsDiv.classList.add("room-details");
  roomDetailsDiv.textContent = `${getRoomTypeDisplay(room.type)} Room`;

  const usersDetailDiv = document.createElement("div");
  usersDetailDiv.classList.add("users-detail");

  (room.users || []).forEach((user, index) => {
    const userDiv = document.createElement("div");

    const userNumberSpan = document.createElement("span");
    userNumberSpan.classList.add("user-number");
    userNumberSpan.textContent = `${index + 1}.`;

    const userNameSpan = document.createElement("span");
    userNameSpan.classList.add("user-name");
    userNameSpan.textContent = user.username;

    userDiv.appendChild(userNumberSpan);

    if (user.isDev && !user.isHidden) {
      const crown = document.createElement("img");
      crown.src = "images/icons/crown.gif";
      crown.alt = "";
      crown.className = "dev-lobby-badge";
      userDiv.appendChild(crown);
    }

    if (user.isMod && !user.isDev && !user.isHidden) {
      const lvl = user.modLevel || 1;
      const mb = document.createElement("span");
      mb.className =
        lvl >= 3
          ? "mod-lobby-badge mod-lobby-badge-lead"
          : lvl === 1
            ? "mod-lobby-badge mod-lobby-badge-jr"
            : "mod-lobby-badge";
      mb.textContent = lvl >= 3 ? "LEADER" : lvl === 1 ? "JR MOD" : "MOD";
      mb.title =
        lvl >= 3
          ? "Mod Leader (L3)"
          : lvl === 1
            ? "Junior Moderator (L1)"
            : "Moderator (L2)";
      userDiv.appendChild(mb);
    }

    if (user.isBotUser) {
      userDiv.classList.add("bot-lobby-user");
      const bb = document.createElement("span");
      bb.className = "bot-lobby-badge";
      bb.textContent = "BOT";
      bb.title = user.botOwner ? "Bot, run by " + user.botOwner : "Automated user";
      userDiv.appendChild(bb);
    }

    if (user.avatar) {
      const url = avatarUrl(user.avatar, 32);
      if (url) {
        const pfp = document.createElement("img");
        pfp.className = "lobby-pfp";
        pfp.alt = "";
        pfp.src = url;
        pfp.onerror = () => (pfp.style.display = "none");
        userDiv.appendChild(pfp);
      }
    }

    userDiv.appendChild(userNameSpan);
    if (user.location) {
      const locSpan = document.createElement("span");
      locSpan.className = "user-loc";
      locSpan.textContent = ` / ${user.location}`;
      userDiv.appendChild(locSpan);
    }

    if (user.isAfk) {
      userDiv.classList.add("afk-lobby-user");
      const afkSpan = document.createElement("span");
      afkSpan.className = "user-afk";
      afkSpan.textContent = " (AFK)";
      afkSpan.title = "Away from keyboard";
      userDiv.appendChild(afkSpan);
    }

    usersDetailDiv.appendChild(userDiv);
  });

  roomInfo.appendChild(roomNameDiv);
  roomInfo.appendChild(roomDetailsDiv);

  if (devLobbyCodes[room.id]) {
    const codeDiv = document.createElement("div");
    codeDiv.className = "dev-access-code";
    codeDiv.textContent = "\uD83D\uDD11 " + devLobbyCodes[room.id];
    roomInfo.appendChild(codeDiv);
  }

  roomInfo.appendChild(usersDetailDiv);

  roomTop.appendChild(roomInfo);

  const roomActions = document.createElement("div");
  roomActions.className = "room-actions";
  roomActions.appendChild(enterButton);
  if (room.type === "public") {
    const spectateEye = document.createElement("button");
    spectateEye.type = "button";
    spectateEye.className = "spectate-button";
    spectateEye.innerHTML = '<i class="fas fa-eye"></i>';
    spectateEye.title = "Spectate (read-only)";
    spectateEye.setAttribute("aria-label", "Spectate this room");
    spectateEye.addEventListener("click", (e) => {
      e.stopPropagation();
      window.location.href = `/room.html?roomId=${room.id}&spectate=1`;
    });
    roomActions.appendChild(spectateEye);
  }
  roomElement.appendChild(roomActions);
  roomElement.appendChild(roomTop);

  if (currentUserIsDev || (currentUserIsMod && currentUserModLevel >= 2)) {
    const devRow = document.createElement("div");
    devRow.className = "lobby-dev-controls";

    if (currentUserIsDev && room.type !== "public") {
      const spectateBtn = document.createElement("button");
      spectateBtn.type = "button";
      spectateBtn.className = "lobby-dev-btn";
      spectateBtn.innerHTML = '<i class="fas fa-eye"></i> Spectate';
      spectateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.location.href = `/room.html?roomId=${room.id}&spectate=1`;
      });
      devRow.appendChild(spectateBtn);
    }

    if (currentUserIsDev) {
      const spotBtn = document.createElement("button");
      spotBtn.type = "button";
      spotBtn.className = "lobby-dev-btn";
      spotBtn.textContent = room.spotlight ? "★ Unspotlight" : "★ Spotlight";
      spotBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        socket.emit("staff spotlight", {
          roomId: room.id,
          on: !room.spotlight,
        });
      });
      devRow.appendChild(spotBtn);
    }

    if (devRow.childNodes.length) roomElement.appendChild(devRow);
  }

  return roomElement;
}

function getRoomTypeDisplay(type) {
  switch (type) {
    case "public":
      return "Public";
    case "semi-private":
      return "Semi-Private";
    case "private":
      return "Private";
    default:
      return type;
  }
}

// ============================================================================
// ============================================================================

function sortRoomsByActivity(rooms) {
  return rooms.slice().sort((a, b) => {
    if (!!a.spotlight !== !!b.spotlight) return a.spotlight ? -1 : 1;

    const aCount = getJoinableCount(a);
    const bCount = getJoinableCount(b);

    if (aCount !== bCount) {
      return bCount - aCount;
    }

    const aActivity = a.lastChatActivity || 0;
    const bActivity = b.lastChatActivity || 0;
    if (aActivity !== bActivity) {
      return bActivity - aActivity;
    }

    const aCreated = a.createdAt || 0;
    const bCreated = b.createdAt || 0;
    return bCreated - aCreated;
  });
}

function updateLobby(rooms) {
  dynamicRoomList.innerHTML = "";
  const publicRooms = rooms.filter((room) => room.type !== "private");

  if (publicRooms.length === 0) {
    noRoomsMessage.style.display = "block";
    dynamicRoomList.style.display = "none";
  } else {
    noRoomsMessage.style.display = "none";
    dynamicRoomList.style.display = "block";

    const sortedRooms = sortRoomsByActivity(publicRooms);
    sortedRooms.forEach((room) => {
      const roomElement = createRoomElement(room);
      dynamicRoomList.appendChild(roomElement);
    });
  }
}

function showRoomList() {
  signInMessage.style.display = "none";
  roomListContainer.style.display = "block";

  if (socket.connected) {
    socket.emit("get rooms");
  } else {
    socket.once("connect", () => {
      socket.emit("get rooms");
    });
  }
}

// ============================================================================
// ============================================================================

const ROOM_SIZE_CEILING = { user: 10, jr: 15, mod: 25, dev: 50 };

function roomSizeCeiling() {
  if (currentUserIsDev) return ROOM_SIZE_CEILING.dev;
  if (currentUserIsMod)
    return currentUserModLevel >= 2
      ? ROOM_SIZE_CEILING.mod
      : ROOM_SIZE_CEILING.jr;
  return ROOM_SIZE_CEILING.user;
}

function applyRoomSizeCeiling() {
  const sizeEl = document.getElementById("roomSizeSlider");
  if (!sizeEl) return;
  const max = roomSizeCeiling();
  if (Number(sizeEl.max) === max) return;
  const min = Number(sizeEl.min) || 5;
  sizeEl.max = String(max);
  if (Number(sizeEl.value) > max) sizeEl.value = String(max);
  sizeEl.dispatchEvent(new Event("input"));

  const scale = document.querySelector(".size-scale");
  if (!scale) return;
  const marks = [];
  for (let i = 0; i < 6; i++)
    marks.push(Math.round(min + ((max - min) * i) / 5));
  scale.innerHTML = "";
  for (const m of [...new Set(marks)]) {
    const span = document.createElement("span");
    span.textContent = String(m);
    scale.appendChild(span);
  }
}

function initLobby() {
  document.querySelector('input[name="roomType"][value="public"]').checked =
    true;

  const sizeEl = document.getElementById("roomSizeSlider");
  const sizeOut = document.getElementById("roomSizeValue");
  if (sizeEl && sizeOut) {
    const showSize = () => {
      sizeOut.textContent = sizeEl.value;
    };
    sizeEl.addEventListener("input", showSize);
    showSize();
  }

  statsModal = new StatsModal();

  const statsBtn = document.getElementById("statsForNerdsButton");
  if (statsBtn)
    statsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (statsModal) {
        statsModal.open();
      }
    });

  const updateNotesBtn = document.getElementById("updateNotesButton");
  if (updateNotesBtn)
    updateNotesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.TalkomaticPopup) window.TalkomaticPopup.forceShowPopup();
    });

  setTimeout(() => {
    const savedUsername = localStorage.getItem("talkomaticUsername");
    const savedLocation = localStorage.getItem("talkomaticLocation");

    if (savedUsername && !isGuestUsername(savedUsername)) {
      currentUsername = savedUsername;
      currentLocation = savedLocation || "";
      isSignedIn = true;

      usernameInput.value = currentUsername;
      locationInput.value = currentLocation;

      setSignedInButtonState();
      setCreateRoomVisible(true);

      emitJoinLobby(savedUsername, savedLocation || "");
      showRoomList();
    } else {
      if (savedUsername) localStorage.removeItem("talkomaticUsername");
      usernameInput.value = "";
      locationInput.value = savedLocation || "";
      isSignedIn = false;
      setCreateRoomVisible(false);
      signInMessage.style.display = "block";
    }
  }, 500);

  updateConnectionStatus();
}

window.addEventListener("load", () => {
  initLobby();
});

socket.on("initial rooms", (rooms) => {
  updateLobby(rooms);
});

window.addEventListener("beforeunload", () => {
  if (statsModal) {
    statsModal.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════

let manageKeysOpen = false;
let blocksOpen = false;
let blocksCtrl = null;

function lobbyNotify(message, type, opts) {
  if (window.StaffUI)
    window.StaffUI.toast(
      message,
      Object.assign({ type: type || "info" }, opts || {}),
    );
}

function ensureDevPanelButton() {
  if (document.getElementById("devPanelButton")) return;
  const btn = document.createElement("button");
  btn.id = "devPanelButton";
  btn.type = "button";
  btn.innerHTML = currentUserIsDev
    ? '<i class="fas fa-screwdriver-wrench"></i> Admin Panel'
    : '<i class="fas fa-shield-halved"></i> Mod Panel';
  btn.title = currentUserIsDev ? "Dev tools" : "Mod tools";
  btn.addEventListener("click", () =>
    currentUserIsDev ? openDevPanel() : openModLobbyPanel(),
  );
  document.body.appendChild(btn);
}

function openDevPanel() {
  if (!window.StaffUI) return;
  StaffUI.panel({
    title: "Admin panel",
    icon: '<i class="fas fa-screwdriver-wrench"></i>',
    subtitle: "Global staff tools",
    wide: true,
    onHelp: () => StaffUI.help("dev"),
    groups: [
      {
        title: "Moderators",
        items: [
          {
            icon: '<i class="fas fa-user-plus"></i>',
            label: "Grant mod key…",
            desc: "Create a key for a new mod (shown once)",
            onClick: async () => {
              const r = await StaffUI.prompt({
                title: "Grant mod key",
                icon: '<i class="fas fa-user-plus"></i>',
                message:
                  "Junior (L1) mods can kick and warn but cannot ban or IP-block. Promote them to full (L2) later from the Manage list.",
                fields: [
                  {
                    name: "value",
                    label: "Mod's name / label",
                    placeholder: "e.g. Alice",
                    required: true,
                    maxLength: 40,
                  },
                  {
                    name: "level",
                    label: "Level",
                    type: "select",
                    value: "1",
                    options: [
                      { value: "1", label: "Junior mod (L1) - limited" },
                      { value: "2", label: "Full mod (L2) - all powers" },
                      { value: "3", label: "Mod leader (L3) - runs the team" },
                    ],
                  },
                ],
                confirmText: "Generate key",
              });
              if (r && r.value)
                socket.emit("dev grant mod", {
                  label: r.value,
                  level: Number(r.level),
                });
            },
          },
          {
            icon: '<i class="fas fa-list"></i>',
            label: "Manage / revoke mod keys…",
            desc: "List current mods and revoke instantly",
            onClick: () => {
              manageKeysOpen = true;
              socket.emit("dev list mod keys");
            },
          },
        ],
      },
      {
        title: "Broadcast",
        items: [
          {
            icon: '<i class="fas fa-newspaper"></i>',
            label: "Lobby ticker…",
            desc: "Editable banner at the top of the lobby",
            onClick: async () => {
              const msg = await StaffUI.prompt({
                title: "Lobby ticker",
                icon: '<i class="fas fa-newspaper"></i>',
                fields: [
                  {
                    name: "value",
                    label: "Ticker message (blank to clear)",
                    type: "textarea",
                    maxLength: 200,
                  },
                ],
                confirmText: "Set ticker",
              });
              if (msg !== null) socket.emit("dev set ticker", { message: msg });
            },
          },
          {
            icon: '<i class="fas fa-tower-broadcast"></i>',
            label: "Megaphone everywhere…",
            desc: "Announcement to all rooms + lobby",
            onClick: async () => {
              const msg = await StaffUI.prompt({
                title: "Megaphone (everywhere)",
                icon: '<i class="fas fa-tower-broadcast"></i>',
                fields: [
                  {
                    name: "value",
                    label: "Announcement",
                    type: "textarea",
                    maxLength: 300,
                    required: true,
                  },
                ],
                confirmText: "Broadcast",
              });
              if (msg)
                socket.emit("staff megaphone", { scope: "all", message: msg });
            },
          },
        ],
      },
      {
        title: "Server",
        items: [
          {
            icon: '<i class="fas fa-flag"></i>',
            label: "Feature flags…",
            desc: "Word filter / room creation / limit",
            onClick: () => socket.emit("dev get flags"),
          },
          {
            icon: '<i class="fas fa-screwdriver-wrench"></i>',
            label: "Maintenance mode (toggle)",
            desc: "Pause new rooms + joins",
            onClick: () => socket.emit("dev set maintenance", {}),
          },
          {
            icon: '<i class="fas fa-fire-extinguisher"></i>',
            label: "Clear bot blacklist",
            desc: "Lift all bot-blacklist entries",
            onClick: async () => {
              if (
                await StaffUI.confirm({
                  title: "Clear blacklist",
                  message: "Clear the entire bot blacklist?",
                })
              )
                socket.emit("dev clear blacklist");
            },
          },
          {
            icon: '<i class="fas fa-unlock"></i>',
            label: "Blocked IPs…",
            desc: "See who is blocked and unblock them",
            onClick: () => {
              blocksOpen = true;
              socket.emit("dev list blocks");
            },
          },
          {
            icon: '<i class="fas fa-bomb"></i>',
            label: "NUKE all rooms",
            danger: true,
            desc: "Emergency clear of every room",
            onClick: async () => {
              const r = await StaffUI.prompt({
                title: "Nuke all rooms",
                icon: '<i class="fas fa-bomb"></i>',
                danger: true,
                message:
                  "Clears EVERY room and removes ALL users. Type NUKE to confirm.",
                fields: [
                  {
                    name: "value",
                    label: "Type NUKE",
                    placeholder: "NUKE",
                    required: true,
                  },
                ],
                confirmText: "NUKE",
              });
              if (r && r.trim().toUpperCase() === "NUKE")
                socket.emit("staff nuke", { confirm: true });
              else if (r != null)
                lobbyNotify("Nuke cancelled. The text did not match.", "info");
            },
          },
        ],
      },
      {
        title: "Records",
        items: [
          {
            icon: '<i class="fas fa-clipboard"></i>',
            label: "Open Mod Dashboard",
            desc: "Every staff action + identity change",
            onClick: () => window.open("/mod.html", "_blank"),
          },
          myKeyItem(),
          removeKeyItem(),
        ],
      },
    ],
  });
}

function openModLobbyPanel() {
  if (!window.StaffUI) return;
  StaffUI.panel({
    title: "Mod panel",
    icon: '<i class="fas fa-shield-halved"></i>',
    subtitle:
      currentUserModLevel >= 3
        ? "Mod Leader (L3)"
        : currentUserModLevel >= 2
          ? "Full mod (L2)"
          : "Junior mod (L1)",
    onHelp: () =>
      StaffUI.help(
        currentUserModLevel >= 3
          ? "leader"
          : currentUserModLevel >= 2
            ? "mod"
            : "jr",
      ),
    groups: [
      {
        title: "Records",
        items: [
          {
            icon: '<i class="fas fa-clipboard"></i>',
            label: "Open Mod Dashboard",
            desc: "Every staff action, and your own record",
            onClick: () => window.open("/mod.html", "_blank"),
          },
          myKeyItem(),
          removeKeyItem(),
        ],
      },
    ],
  });
}

function myKeyItem() {
  return {
    icon: '<i class="fas fa-key"></i>',
    label: "Show my staff key",
    desc: "Reveal and copy the key this browser uses",
    onClick: () => openMyKey(),
  };
}

function removeKeyItem() {
  return {
    icon: '<i class="fas fa-key"></i>',
    label: "Remove my staff key",
    danger: true,
    desc: "Forget it here and go back to being an ordinary user",
    onClick: () => removeMyKey(),
  };
}

async function removeMyKey() {
  if (!window.StaffUI) return;
  const devKey = localStorage.getItem("talkomatic_devKey");
  const modKey = localStorage.getItem("talkomatic_modKey");
  if (!devKey && !modKey) {
    lobbyNotify("This browser has no staff key saved.", "info");
    return;
  }

  const ok = await StaffUI.confirm({
    title: "Remove your staff key",
    icon: '<i class="fas fa-key"></i>',
    danger: true,
    subtitle: "This browser only",
    message:
      "This browser will forget your " +
      (devKey ? "admin" : "moderator") +
      " key and you will go back to being an ordinary user here. The key itself is not revoked and still works everywhere else, so make sure you have a copy before you do this: getting back in means pasting it again with Enter staff key. If you think the key has leaked, tell an admin instead so it can be properly revoked.",
    confirmText: "Remove key",
  });
  if (!ok) return;

  localStorage.removeItem("talkomatic_devKey");
  localStorage.removeItem("talkomatic_modKey");
  lobbyNotify("Staff key removed from this browser. Reloading...", "success", {
    title: "Key removed",
  });
  setTimeout(() => window.location.reload(), 1200);
}

function openMyKey() {
  if (!window.StaffUI) return;
  const devKey = localStorage.getItem("talkomatic_devKey");
  const modKey = localStorage.getItem("talkomatic_modKey");
  const key = devKey || modKey;
  const wrap = StaffUI.el("div");

  if (!key) {
    wrap.appendChild(
      StaffUI.el("p", {
        text: "This browser has no staff key saved. If you were given one, paste it in with Enter staff key and it will be remembered here.",
      }),
    );
    StaffUI.modal({
      title: "Your staff key",
      icon: '<i class="fas fa-key"></i>',
      body: wrap,
      actions: [{ label: "Close", kind: "primary", onClick: () => {} }],
    });
    return;
  }

  wrap.appendChild(
    StaffUI.el("p", {
      text:
        "This is the " +
        (devKey ? "admin" : "moderator") +
        " key this browser is signed in with. Treat it like a password: it is the only proof of your role, so never paste it anywhere public or share it, not even with other staff. If it leaks, tell an admin and it will be revoked.",
    }),
  );

  const box = StaffUI.el("div", { class: "tk-keybox" });
  const shown = StaffUI.el("div", { class: "tk-keyval", text: "•".repeat(28) });
  const eye = StaffUI.el("button", { class: "tk-btn tk-keyeye", text: "Show" });
  let visible = false;
  eye.addEventListener("click", (e) => {
    e.preventDefault();
    visible = !visible;
    shown.textContent = visible ? key : "•".repeat(28);
    shown.classList.toggle("revealed", visible);
    eye.textContent = visible ? "Hide" : "Show";
  });
  box.appendChild(shown);
  box.appendChild(eye);
  wrap.appendChild(box);

  StaffUI.modal({
    title: "Your staff key",
    icon: '<i class="fas fa-key"></i>',
    subtitle: "Keep it to yourself",
    body: wrap,
    actions: [
      {
        label: "Copy key",
        onClick: () => {
          StaffUI.copy(key);
          lobbyNotify(
            "Your staff key is on the clipboard. Paste it somewhere safe, and clear your clipboard afterwards.",
            "success",
            { title: "Copied" },
          );
        },
      },
      { label: "Done", kind: "primary", onClick: () => {} },
    ],
  });
}

// ── Mod key results ──────────────────────────────────────────────────────────
socket.on("dev mod granted", (data) => {
  if (!data || !data.key || !window.StaffUI) return;
  const cmd = `localStorage.setItem('talkomatic_modKey','${data.key}')`;
  const wrap = StaffUI.el("div");
  wrap.appendChild(
    StaffUI.el("p", {
      text: `New ${data.level >= 3 ? "leader (L3)" : data.level === 1 ? "junior (L1)" : "full (L2)"} mod key for "${data.label}". This is shown ONCE, so copy it now and send it to them.`,
    }),
  );
  const input = StaffUI.el("input", {
    class: "tk-input",
    type: "text",
    readonly: "readonly",
    value: data.key,
  });
  input.addEventListener("focus", () => input.select());
  wrap.appendChild(input);
  wrap.appendChild(
    StaffUI.el("p", {
      class: "tk-help",
      text: "They activate it by running this in their browser console, then reloading:",
    }),
  );
  const code = StaffUI.el("div", {
    style:
      "font-family:monospace;font-size:11px;color:#ffd700;background:#0e0f12;border:1px solid #23262e;border-radius:7px;padding:8px;word-break:break-all;margin-top:4px;",
  });
  code.textContent = cmd;
  wrap.appendChild(code);
  StaffUI.modal({
    title: "Mod key granted",
    icon: '<i class="fas fa-key"></i>',
    wide: true,
    body: wrap,
    actions: [
      {
        label: "Copy key",
        kind: "ghost",
        onClick: () => {
          StaffUI.copy(data.key);
          lobbyNotify("Key copied.", "success");
          return false;
        },
      },
      {
        label: "Copy command",
        kind: "ghost",
        onClick: () => {
          StaffUI.copy(cmd);
          lobbyNotify("Command copied.", "success");
          return false;
        },
      },
      { label: "Done", kind: "primary", onClick: () => {} },
    ],
  });
});

function openModKeyActions(k) {
  if (!window.StaffUI) return;
  const lvl = k.level >= 3 ? 3 : k.level === 1 ? 1 : 2;
  const LEVEL_NAMES = {
    1: "junior mod (L1)",
    2: "full mod (L2)",
    3: "mod leader (L3)",
  };
  const steps = [];
  if (lvl < 3) steps.push(lvl + 1);
  if (lvl > 1) steps.push(lvl - 1);
  StaffUI.menu({
    title: k.label,
    icon: '<i class="fas fa-user-shield"></i>',
    subtitle: `Level ${lvl} · key ${k.hash.slice(0, 12)}…`,
    groups: [
      {
        items: [
          ...steps.map((toLevel) => {
            const up = toLevel > lvl;
            return {
              icon: up
                ? '<i class="fas fa-arrow-up"></i>'
                : '<i class="fas fa-arrow-down"></i>',
              label: (up ? "Promote to " : "Demote to ") + LEVEL_NAMES[toLevel],
              desc: up ? "Move them up a level" : "Move them down a level",
              onClick: async () => {
                const ok = await StaffUI.confirm({
                  title:
                    (up ? "Promote to " : "Demote to ") + LEVEL_NAMES[toLevel],
                  message: `Set "${k.label}" to ${LEVEL_NAMES[toLevel]}?`,
                  confirmText: up ? "Promote" : "Demote",
                });
                if (ok)
                  socket.emit("dev set mod level", {
                    hash: k.hash,
                    level: toLevel,
                  });
              },
            };
          }),
          {
            icon: '<i class="fas fa-user-xmark"></i>',
            label: "Revoke mod key",
            desc: "Remove their access instantly",
            danger: true,
            onClick: async () => {
              const ok = await StaffUI.confirm({
                title: "Revoke mod",
                message: `Revoke "${k.label}"? They are downgraded instantly.`,
                danger: true,
                confirmText: "Revoke",
              });
              if (ok) socket.emit("dev revoke mod", { hash: k.hash });
            },
          },
        ],
      },
    ],
    onHelp: () => StaffUI.help("dev"),
  });
}

socket.on("dev mod keys", (keys) => {
  if (!manageKeysOpen || !window.StaffUI) return;
  const list = Array.isArray(keys) ? keys : [];
  const items = list.length
    ? list.map((k) => ({
        icon: '<i class="fas fa-user-shield"></i>',
        label: `${k.label} - ${k.level >= 3 ? "L3" : k.level === 1 ? "L1" : "L2"}`,
        desc: "key " + k.hash.slice(0, 12) + "…",
        keepOpen: true,
        onClick: () => openModKeyActions(k),
      }))
    : [
        {
          icon: "·",
          label: "No mod keys yet",
          desc: "Use Grant mod key to create one",
        },
      ];
  StaffUI.menu({
    title: "Mod keys",
    icon: '<i class="fas fa-list"></i>',
    subtitle: `${list.length} active`,
    groups: [{ items }],
    onHelp: () => StaffUI.help("dev"),
  });
});

socket.on("dev blocks", (list) => {
  if (!blocksOpen || !window.StaffUI) return;
  const blocks = Array.isArray(list) ? list : [];
  const fmtExpiry = (b) => {
    if (b.permanent) return "permanent";
    if (!b.expiry) return "active";
    const mins = Math.round((b.expiry - Date.now()) / 60000);
    if (mins <= 0) return "expiring";
    if (mins < 60) return mins + " min left";
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + " hr left";
    return Math.round(hrs / 24) + " days left";
  };
  const nameOf = (b) =>
    b.label ||
    b.ip ||
    (b.kind === "id" ? "a client id" : b.kind === "range" ? "a range" : "an address");
  const items = blocks.length
    ? blocks.map((b) => ({
        icon: '<i class="fas fa-ban"></i>',
        label: nameOf(b),
        desc:
          fmtExpiry(b) +
          (b.by ? "  •  blocked by " + b.by : "") +
          (b.reason ? "  •  " + b.reason : "") +
          "  •  tap to unblock",
        danger: true,
        keepOpen: true,
        onClick: async () => {
          if (
            await StaffUI.confirm({
              title: "Unblock",
              message: "Unblock " + nameOf(b) + "?",
              confirmText: "Unblock",
            })
          )
            socket.emit("dev unblock ip", { ip: b.ip, ref: b.ref });
        },
      }))
    : [
        {
          icon: "·",
          label: "No blocked IPs",
          desc: "Nobody is currently blocked",
        },
      ];
  if (blocksCtrl) blocksCtrl.close();
  blocksCtrl = StaffUI.menu({
    title: "Blocked IPs",
    icon: '<i class="fas fa-unlock"></i>',
    subtitle: blocks.length + " active",
    groups: [{ items }],
  });
});

socket.on("dev flags", (flags) => {
  if (!flags || !window.StaffUI) return;
  StaffUI.menu({
    title: "Feature flags",
    icon: '<i class="fas fa-flag"></i>',
    subtitle: "Live server configuration",
    groups: [
      {
        items: [
          {
            icon: flags.wordFilter
              ? '<i class="fas fa-circle-check"></i>'
              : '<i class="fas fa-ban"></i>',
            label: `Word filter (global): ${flags.wordFilter ? "ON" : "OFF"}`,
            desc: "Toggle the global word filter",
            onClick: () =>
              socket.emit("dev set flags", { wordFilter: !flags.wordFilter }),
          },
          {
            icon: flags.roomCreation
              ? '<i class="fas fa-circle-check"></i>'
              : '<i class="fas fa-ban"></i>',
            label: `Room creation: ${flags.roomCreation ? "ON" : "OFF"}`,
            desc: "Allow users to create rooms",
            onClick: () =>
              socket.emit("dev set flags", {
                roomCreation: !flags.roomCreation,
              }),
          },
          {
            icon: '<i class="fas fa-hashtag"></i>',
            label: `Room limit: ${flags.baseMaxRooms}`,
            desc: "How many rooms can exist at once",
            onClick: async () => {
              const v = await StaffUI.prompt({
                title: "Room limit",
                fields: [
                  {
                    name: "value",
                    label: "Base room limit",
                    type: "number",
                    value: String(flags.baseMaxRooms),
                    required: true,
                  },
                ],
              });
              const n = parseInt(v, 10);
              if (Number.isFinite(n))
                socket.emit("dev set flags", { baseMaxRooms: n });
            },
          },
          {
            icon: '<i class="fas fa-users"></i>',
            label: `Max room size: ${flags.maxRoomCapacity} people`,
            desc: "How many users fit in one room (2 to 50)",
            onClick: async () => {
              const v = await StaffUI.prompt({
                title: "Max room size",
                icon: '<i class="fas fa-users"></i>',
                message: "How many people can be in a single room (2 to 50)?",
                fields: [
                  {
                    name: "value",
                    label: "Max users per room",
                    type: "number",
                    value: String(flags.maxRoomCapacity),
                    required: true,
                  },
                ],
              });
              const n = parseInt(v, 10);
              if (Number.isFinite(n))
                socket.emit("dev set flags", { maxRoomCapacity: n });
            },
          },
          {
            icon: flags.maintenance
              ? '<i class="fas fa-screwdriver-wrench"></i>'
              : '<i class="fas fa-circle-check"></i>',
            label: `Maintenance: ${flags.maintenance ? "ON" : "OFF"}`,
            desc: "Toggle maintenance mode",
            onClick: () => socket.emit("dev set maintenance", {}),
          },
        ],
      },
    ],
  });
});

socket.on("staff action result", (data) => {
  if (!data) return;
  if (window.StaffUI) StaffUI.actionToast(data);
  else
    lobbyNotify(
      (data.ok ? "Done: " : "Failed: ") + data.action,
      data.ok ? "success" : "error",
    );
});

function revokedNoticeBody(reason, removedAt) {
  const wrap = document.createElement("div");
  const p1 = document.createElement("p");
  p1.textContent =
    "The Talkomatic team has removed your moderator key" +
    (removedAt ? " on " + new Date(removedAt).toLocaleDateString() : "") +
    ".";
  wrap.appendChild(p1);
  if (reason) {
    const q = document.createElement("p");
    q.style.cssText =
      "border-left:3px solid #ff5468;padding:8px 10px;background:rgba(255,84,104,.08);border-radius:0 6px 6px 0;";
    q.textContent = "Reason: " + reason;
    wrap.appendChild(q);
  }
  const p2 = document.createElement("p");
  p2.style.cssText = "color:#8d8d8d;font-size:12px;";
  p2.textContent =
    "You are back to being an ordinary user. If you believe this was a mistake, raise it with staff.";
  wrap.appendChild(p2);
  return wrap;
}

socket.on("staff revoked", (d) => {
  localStorage.removeItem("talkomatic_modKey");
  currentUserIsMod = false;
  currentUserModLevel = 0;
  const reason = d && d.reason;
  if (window.StaffUI && StaffUI.modal && reason) {
    StaffUI.modal({
      title: "You are no longer a moderator",
      icon: '<i class="fas fa-user-xmark"></i>',
      body: revokedNoticeBody(reason, Date.now()),
      actions: [
        {
          label: "Understood",
          kind: "primary",
          onClick: () => window.location.reload(),
        },
      ],
    });
    setTimeout(() => window.location.reload(), 60000);
  } else {
    lobbyNotify("Your mod key was revoked.", "warning", { timeout: 6000 });
    setTimeout(() => window.location.reload(), 1500);
  }
});

socket.on("staff revoked notice", (d) => {
  localStorage.removeItem("talkomatic_modKey");
  if (window.StaffUI && StaffUI.modal) {
    StaffUI.modal({
      title: "You are no longer a moderator",
      icon: '<i class="fas fa-user-xmark"></i>',
      body: revokedNoticeBody(d && d.reason, d && d.removedAt),
      actions: [{ label: "Understood", kind: "primary", onClick: () => {} }],
    });
  } else {
    lobbyNotify(
      "Your moderator key was removed" +
        (d && d.reason ? ": " + d.reason : "."),
      "warning",
      { title: "You are no longer a moderator", timeout: 12000 },
    );
  }
});

// ── Staff key entry (no console needed) ──────────────────────────────────────
let pendingStaffKey = null;
async function openStaffKeyEntry() {
  if (!window.StaffUI) return;
  const key = await StaffUI.prompt({
    title: "Staff access",
    icon: '<i class="fas fa-key"></i>',
    subtitle: "Enter your dev or mod key",
    message:
      "All keys are verified, logged, and monitored on our servers. Sharing your key with anyone will result in a permanent ban from Talkomatic.",
    fields: [
      {
        name: "value",
        label: "Staff key",
        type: "password",
        placeholder: "paste your key",
        required: true,
      },
    ],
    confirmText: "Unlock",
  });
  if (key) {
    pendingStaffKey = key;
    socket.emit("staff validate key", { key });
  }
}
socket.on("staff key result", (d) => {
  if (!d || !d.role) {
    lobbyNotify(
      d && d.throttled
        ? "Too many attempts. Wait a few minutes."
        : "That key was not recognized.",
      "error",
    );
    pendingStaffKey = null;
    return;
  }
  if (d.role === "dev")
    localStorage.setItem("talkomatic_devKey", pendingStaffKey);
  else localStorage.setItem("talkomatic_modKey", pendingStaffKey);
  pendingStaffKey = null;
  lobbyNotify(
    `Key accepted. You are ${d.role}${d.label ? " (" + d.label + ")" : ""}. Reloading…`,
    "success",
  );
  setTimeout(() => window.location.reload(), 1200);
});
socket.on("you are now mod", (d) => {
  if (!d || !d.key) return;
  localStorage.setItem("talkomatic_modKey", d.key);
  if (window.ModApply && ModApply.decisionOpen()) {
    // The approval popup is on screen; reload when the user closes it.
    ModApply.reloadOnClose();
    return;
  }
  lobbyNotify(
    d.level >= 3
      ? "You've been made a Mod Leader! Reloading…"
      : d.level === 2
        ? "You've been promoted to Moderator (full)! Reloading…"
        : "You've been made a Junior Moderator! Reloading…",
    "success",
    { title: "You are now a mod", timeout: 4000 },
  );
  setTimeout(() => window.location.reload(), 1600);
});
socket.on("staff level changed", (d) => {
  if (!d) return;
  currentUserModLevel = d.level >= 3 ? 3 : d.level === 1 ? 1 : 2;
  lobbyNotify(
    currentUserModLevel >= 3
      ? "You are now a mod leader (level 3)."
      : currentUserModLevel >= 2
        ? "You are now a full (level 2) moderator."
        : "Your moderator level is now junior (level 1).",
    "info",
    { timeout: 6000 },
  );
});
socket.on("identity status", (d) => {
  if (window.TalkomaticIdentity) window.TalkomaticIdentity.activity = d || null;
});
socket.on("staff notice", (d) => {
  if (d && d.text && typeof lobbyNotify === "function")
    lobbyNotify(d.text, "warning", { title: "Staff alert", timeout: 8000 });
});

(function warnIfIdentityRestored() {
  if (typeof lobbyNotify !== "function" || !window.TalkomaticIdentity) return;
  const warn = () => {
    if (window.TalkomaticIdentity && window.TalkomaticIdentity.restored)
      lobbyNotify(
        "This browser's saved data looks cleared. Your stats are tied to this browser - keep its data to keep them.",
        "warning",
        { timeout: 9000 },
      );
  };
  if (window.TalkomaticIdentity.restored) warn();
  else if (window.TalkomaticIdentity.ready)
    window.TalkomaticIdentity.ready.then(warn);
})();

const staffLoginLink = document.getElementById("staffLoginLink");
if (staffLoginLink)
  staffLoginLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (currentUserIsDev || currentUserIsMod)
      window.open("/mod.html", "_blank");
    else openStaffKeyEntry();
  });

let myAppStatus = null;
let applicationsOpen = null;
const APP_STATUS_META = {
  pending: {
    color: "#ffb454",
    fa: "fa-hourglass-half",
    title: "Application under review",
  },
  approved: {
    color: "#57d9a3",
    fa: "fa-circle-check",
    title: "Application approved",
  },
  rejected: {
    color: "#ff5468",
    fa: "fa-circle-xmark",
    title: "Application not approved",
  },
  revoked: {
    color: "#ff5468",
    fa: "fa-user-slash",
    title: "Moderator access revoked",
  },
};

function updateModApplyLink() {
  const link = document.getElementById("modApplyLink");
  if (!link || currentUserIsDev || currentUserIsMod) return;
  const closed = applicationsOpen === false;
  const mine = !!(myAppStatus && myAppStatus.has);
  link.style.display = closed && !mine ? "none" : "";
  if (closed && !mine) return;
  if (mine && APP_STATUS_META[myAppStatus.status]) {
    const m = APP_STATUS_META[myAppStatus.status];
    link.innerHTML =
      '<i class="fas fa-circle" style="color:' +
      m.color +
      '"></i> Check status';
  } else {
    link.innerHTML = '<i class="fas fa-user-pen"></i> Apply to be a mod';
  }
}

// The application form, status view, and decision popups live in mod-apply.js.
const modApplyLink = document.getElementById("modApplyLink");
if (modApplyLink)
  modApplyLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.ModApply) ModApply.open();
  });
socket.on("mod application result", (d) => {
  if (!d || !d.ok) return;
  myAppStatus = { has: true, status: "pending", submittedAt: Date.now() };
  updateModApplyLink();
});

async function openSuggestBox() {
  if (!window.StaffUI) return;
  const r = await StaffUI.prompt({
    title: "Suggest a feature",
    icon: '<i class="fas fa-lightbulb"></i>',
    subtitle: "Tell us what to build next",
    message:
      "Got an idea for Talkomatic? Send it here and the team will take a look.",
    fields: [
      {
        name: "text",
        label: "Your suggestion",
        type: "textarea",
        maxLength: 500,
        required: true,
        placeholder: "What should we add or change?",
      },
    ],
    confirmText: "Send",
  });
  if (r && r.text) socket.emit("suggestion submit", { text: r.text });
}
const suggestBoxLink = document.getElementById("suggestBoxLink");
if (suggestBoxLink)
  suggestBoxLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (window.SuggestBoard) window.SuggestBoard.open();
    else openSuggestBox();
  });
socket.on("suggestion result", (d) => {
  if (!d) return;
  if (d.ok)
    lobbyNotify("Thanks! Your suggestion was sent.", "success", {
      timeout: 6000,
    });
  else
    lobbyNotify(d.error || "Could not send your suggestion.", "error", {
      timeout: 6000,
    });
});

socket.on("applications state", (d) => {
  applicationsOpen = !d || d.open !== false;
  updateModApplyLink();
});

socket.on("mod application status", (d) => {
  myAppStatus = d && d.has ? d : null;
  updateModApplyLink();
});

function updateStaffLink() {
  const link = document.getElementById("staffLoginLink");
  if (link) {
    const isStaff = currentUserIsDev || currentUserIsMod;
    const icon = isStaff ? "fa-gauge-high" : "fa-key";
    const label = currentUserIsDev
      ? "Admin Dashboard"
      : currentUserIsMod
        ? "Mod Dashboard"
        : "Staff Access";
    link.innerHTML =
      '<i class="fas ' + icon + '"></i><span>' +
      (isStaff ? "Dashboard" : "Staff") +
      "</span>";
    link.title = label;
    link.setAttribute("aria-label", label);
  }
  const applyLink = document.getElementById("modApplyLink");
  if (applyLink) {
    applyLink.style.display =
      currentUserIsDev || currentUserIsMod ? "none" : "";
    updateModApplyLink();
  }
}
updateStaffLink();
try {
  if (sessionStorage.getItem("tk_ban_lifted")) {
    sessionStorage.removeItem("tk_ban_lifted");
    setTimeout(() => {
      if (window.toastr)
        toastr.success(
          "Your ban has been lifted. Welcome back to Talkomatic!",
          "Unbanned",
          { timeOut: 9000, closeButton: true },
        );
    }, 1200);
  }
} catch (_) {}
if (window.location.hash === "#staff") setTimeout(openStaffKeyEntry, 700);
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#staff") openStaffKeyEntry();
});

// ── Lobby ticker bar ─────────────────────────────────────────────────────────
function setLobbyTicker(message) {
  let bar = document.getElementById("lobbyTickerBar");
  if (!message) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "lobbyTickerBar";
    document.body.appendChild(bar);
  }
  bar.textContent = message;
}
socket.on("lobby ticker", (data) =>
  setLobbyTicker((data && data.message) || ""),
);

socket.on("megaphone", (data) => {
  if (data && data.message)
    lobbyNotify(data.message, "warning", {
      title: "Announcement",
      fullWidth: true,
      timeout: 14000,
    });
});

socket.on("maintenance status", (data) => {
  let bar = document.getElementById("lobbyMaintenanceBar");
  if (data && data.enabled) {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "lobbyMaintenanceBar";
      bar.textContent =
        "Maintenance mode: creating rooms and joining are paused.";
      document.body.appendChild(bar);
    }
  } else if (bar) {
    bar.remove();
  }
});
