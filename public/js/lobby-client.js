// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  lobby-client.js - Talkomatic Lobby Client                                ║
// ║  Server statistics, anti-spam lobby sorting, lobby visibility             ║
// ║                                                                           ║
// ║  PATCHED (June 2026 anniversary batch):                                   ║
// ║  • FIX #4: Access codes are NEVER placed in redirect URLs anymore.        ║
// ║    The server validates the code and stores it in the session BEFORE      ║
// ║    emitting "room joined" / "room created", so the room page joins        ║
// ║    via the session - no ?accessCode= in the address bar, history,         ║
// ║    or analytics. The lastUsedAccessCode variable has been removed         ║
// ║    entirely since it only existed to build those URLs.                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// ============================================================================
// 1. CUSTOM MODAL SYSTEM (IIFE to avoid conflicts)
// ============================================================================
(function () {
  // Only initialize once to avoid duplicate event listeners
  if (window.modalFunctionsInitialized) {
    console.log("Custom modal already initialized");
    return;
  }
  window.modalFunctionsInitialized = true;

  // Get modal elements
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

  // Define the modal functions - make private to this scope
  function showModal(title, message, options = {}) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;

    // Reset modal state
    modalInputContainer.style.display = "none";
    modalInput.value = "";
    modalInputError.style.display = "none";
    modalInputError.textContent = "";

    // Configure input if needed
    if (options.showInput) {
      modalInputContainer.style.display = "block";
      modalInput.placeholder = options.inputPlaceholder || "";
      modalInput.setAttribute("maxLength", options.maxLength || "6");
      modalInput.focus();
    }

    // Configure buttons
    modalCancelBtn.textContent = options.cancelText || "Cancel";
    modalConfirmBtn.textContent = options.confirmText || "Confirm";

    // Show/hide cancel button
    modalCancelBtn.style.display =
      options.showCancel !== false ? "block" : "none";

    // Store callback
    currentModalCallback = options.callback || null;

    // Show modal
    customModal.classList.add("show");

    // Prevent background scrolling
    document.body.style.overflow = "hidden";
  }

  function hideCustomModal() {
    customModal.classList.remove("show");
    document.body.style.overflow = "";
    currentModalCallback = null;
  }

  // Expose public methods to window
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
            return false; // Prevent modal from closing
          }
        }
        callback(confirmed, inputValue);
        return true;
      },
    });
  };

  // Event listeners for modal
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

  // Close modal when clicking outside the content
  customModal.addEventListener("click", (e) => {
    if (e.target === customModal) {
      hideCustomModal();
    }
  });

  // Validate input for numbers only
  modalInput.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, "");
  });

  // Close modal with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && customModal.classList.contains("show")) {
      hideCustomModal();
    }
  });

  // Enter key in input field triggers confirm button
  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      modalConfirmBtn.click();
    }
  });
})();

// ============================================================================
// 2. STATS FOR NERDS MODAL
// ============================================================================
class StatsModal {
  constructor() {
    this.modal = document.getElementById("statsModal");
    this.closeButton = document.getElementById("statsModalClose");
    this.refreshButton = document.getElementById("modalRefreshButton");
    this.isOpen = false;
    this.lastUpdateTime = null;

    // Modal content sections
    this.loadingSection = document.getElementById("statsLoadingSection");
    this.errorSection = document.getElementById("statsErrorSection");
    this.contentSection = document.getElementById("statsContentSection");

    // Stats display elements
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
// 3. CONNECTION STATUS INDICATOR
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
// 4. SOCKET.IO INITIALIZATION
// ============================================================================

// Socket.io initialization with robust connection settings
const socket = io({
  // WebSocket only, matching the server. No long-poll handshake first.
  transports: ["websocket"],
  upgrade: false,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 20000,
  autoConnect: true,
  withCredentials: true,
  auth: {
    devKey: localStorage.getItem("talkomatic_devKey") || undefined,
    modKey: localStorage.getItem("talkomatic_modKey") || undefined,
    deviceId:
      (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
      undefined,
  },
});
// Restart countdown + reconnect overlay (returns the user to a fresh lobby).
if (window.TalkomaticConnection) window.TalkomaticConnection.attach(socket);
// The Desk (staff chat) rides the same socket; it stays dormant for non-staff.
if (window.TalkoDesk) window.TalkoDesk.init(socket);

// ============================================================================
// 5. DOM REFERENCES & STATE
// ============================================================================

// DOM elements
const logForm = document.getElementById("logform");
const createRoomForm = document.getElementById("lobbyForm");
const roomListContainer = document.querySelector(".roomList");
const dynamicRoomList = document.getElementById("dynamicRoomList");
const usernameInput = logForm.querySelector('input[placeholder="Your Name"]');
const locationInput = logForm.querySelector(
  'input[placeholder="Location (optional)"]',
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

// Variables
let currentUsername = "";
let currentLocation = "";
let currentUserId = null;
let isSignedIn = false;
let connectionRetryCount = 0;
const MAX_RETRIES = 3;
const MAX_USERNAME_LENGTH = 15;
const MAX_LOCATION_LENGTH = 20;
const MAX_ROOM_NAME_LENGTH = 25;
// How many people a room can hold, picked on the slider. The ceiling depends on
// what the person holds and lives in roomSizeCeiling() below; the server clamps
// to the same numbers, so a hand-sent value cannot open a 50-seat room.
const ROOM_SIZE_MIN = 5;
let devLobbyCodes = {};
let statsModal = null;
let currentUserIsDev = false;
let currentUserIsMod = false;
let currentUserModLevel = 0; // 0 = not a mod, 1 = junior, 2 = full

// ============================================================================
// 6. SIGN-IN HELPERS
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
  createRoomForm.classList.remove("hidden");

  if (shouldPersist) {
    localStorage.setItem("talkomaticUsername", currentUsername);
    localStorage.setItem("talkomaticLocation", currentLocation);
  }
}

// ── Discord avatar (pfp) ────────────────────────────────────────────────────
// Only a validated snowflake id + CDN hash are stored and sent; the image URL
// is rebuilt from those two, so no arbitrary URL can ever be injected.
const PFP_ID_RE = /^\d{17,20}$/;
const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

function storedAvatar() {
  try {
    if (localStorage.getItem("talkomaticPfpEnabled") !== "1") return null;
    const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
    if (c && PFP_ID_RE.test(c.discordId) && PFP_HASH_RE.test(c.hash))
      return { discordId: c.discordId, hash: c.hash, animated: !!c.animated };
  } catch (e) {}
  return null;
}

function avatarUrl(av, size) {
  const id = av.discordId || av.id;
  if (!PFP_ID_RE.test(id || "") || !PFP_HASH_RE.test(av.hash || "")) return null;
  return (
    "https://cdn.discordapp.com/avatars/" + id + "/" + av.hash +
    ".webp?size=" + (size || 64) + (av.animated ? "&animated=true" : "")
  );
}

// Fetch the profile from pfpgrab and cache the hash briefly. Images always
// come straight from Discord's CDN; only the hash lookup goes to pfpgrab.
// `fresh` skips every cache layer - used when retrying an account that
// previously had no picture, so a just-added avatar shows up immediately.
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
    // Remember the miss so the next attempt for this ID bypasses caches
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
// 7. SOCKET CONNECTION EVENTS
// ============================================================================

socket.on("connect", () => {
  console.log("Socket connected successfully");
  connectionRetryCount = 0;
  updateConnectionStatus();
});

socket.on("disconnect", (reason) => {
  console.log(`Socket disconnected: ${reason}`);
  updateConnectionStatus();

  if (reason === "io server disconnect") {
    socket.connect();
  }
});

socket.on("connect_error", (error) => {
  // IP block: the server attaches ban details. Show a clear ban screen with a
  // live countdown (or a permanent notice) instead of retrying forever.
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

  if (connectionRetryCount < MAX_RETRIES) {
    connectionRetryCount++;
    console.log(
      `Retrying connection (${connectionRetryCount}/${MAX_RETRIES})...`,
    );

    if (socket.disconnected) {
      setTimeout(() => {
        console.log("Attempting reconnection with clean session...");
        socket.io.opts.query = { clean: "true" };
        socket.connect();
      }, 1000 * connectionRetryCount);
    }
  } else {
    window.showErrorModal(
      "Unable to connect to the server. Please refresh the page and try again.",
      "SERVER_ERROR",
    );
  }
});

socket.on("reconnect", (attemptNumber) => {
  console.log(`Reconnected after ${attemptNumber} attempts`);
  updateConnectionStatus();
  checkSignInStatus();
});

// Staff warning, including any queued while the user was offline (delivered on
// connect). Shown as a prominent toast in the lobby.
socket.on("staff warning", (data) => {
  const msg = (data && data.message) || "Please follow the Talkomatic rules.";
  if (window.toastr)
    toastr.warning(msg, "Staff warning", { timeOut: 12000, closeButton: true });
});

// One active tab per browser session: if another tab takes over this identity,
// pause this tab instead of letting two tabs fight over one identity.
let tabSuperseded = false;
function showTabSupersededOverlay() {
  if (tabSuperseded) return;
  tabSuperseded = true;
  try {
    socket.io.opts.reconnection = false;
    socket.disconnect();
  } catch (_) {}
  if (!document.getElementById("supersededStyles")) {
    const st = document.createElement("style");
    st.id = "supersededStyles";
    st.textContent = `
      #supersededOverlay{position:fixed;inset:0;z-index:1000002;background:#0a0a0a;
        display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;}
      #supersededOverlay .ss-card{max-width:460px;width:100%;background:#181818;border:1px solid #616161;
        border-radius:10px;padding:36px 30px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6);}
      #supersededOverlay .ss-icon{font-size:52px;color:#ff9800;margin-bottom:16px;}
      #supersededOverlay h1{color:#ff9800;font-size:24px;margin:0 0 10px;}
      #supersededOverlay p{color:#dddddd;font-size:15px;line-height:1.6;margin:0 0 22px;}
      #supersededOverlay button{background:#ff9800;color:#000;border:none;border-radius:6px;
        padding:12px 26px;font-size:15px;font-weight:bold;cursor:pointer;font-family:inherit;}
      #supersededOverlay button:hover{background:#ffb74d;}
    `;
    document.head.appendChild(st);
  }
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

  // Themed to match the rest of Talkomatic (talkoSS, #202020/#000/#616161 with
  // the #ff9800 orange accent). The accent strips are squared (radius 0).
  if (!document.getElementById("banScreenStyles")) {
    const style = document.createElement("style");
    style.id = "banScreenStyles";
    style.textContent = `
      /* Talkomatic's own language: flat #202020 behind, black cards, thin
         #333 lines, a cream section strip with a coloured icon, orange fills.
         Square corners throughout, same as the dashboard. */
      #banScreen{position:fixed;inset:0;z-index:1000001;background:#202020;
        display:flex;align-items:flex-start;justify-content:center;padding:20px 16px;
        overflow:auto;font-family:talkoSS,Arial,sans-serif;}
      #banScreen .ban-card{max-width:620px;width:100%;background:#000;
        border:1px solid #616161;border-radius:0;text-align:left;
        overflow:hidden;margin:auto;}
      #banScreen .ban-hd{background:#fdf5e6;color:#000;padding:13px 16px;
        display:flex;align-items:center;gap:11px;}
      #banScreen .ban-icon{font-size:17px;color:#c62828;}
      #banScreen h1{color:#000;font-size:16px;margin:0;font-weight:bold;letter-spacing:.2px;flex:1;}
      #banScreen .ban-hd-sub{font-size:12px;color:#5f5346;font-weight:bold;}
      #banScreen .ban-body{padding:16px;display:flex;flex-direction:column;gap:14px;}
      #banScreen .ban-sub{color:#dcdcdc;font-size:14px;line-height:1.6;margin:0;}
      #banScreen .ban-meta{display:flex;flex-wrap:wrap;gap:7px;margin:0;}
      #banScreen .ban-chip{display:inline-flex;align-items:center;gap:7px;background:#1b1b1b;
        border:1px solid #333;border-radius:0;padding:6px 10px;font-size:12.5px;color:#c3c3c3;}
      #banScreen .ban-chip i{color:#ff9800;font-size:11px;}
      #banScreen .ban-chip b{color:#fff;font-weight:bold;}
      /* Section strip, the same one the dashboard uses to open a block. */
      #banScreen .ban-strip{background:#1b1b1b;border:1px solid #333;
        border-left:3px solid #ff9800;border-radius:0;padding:11px 13px;margin:0;
        text-align:left;}
      #banScreen .ban-strip .lbl{color:#ff9800;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.8px;font-weight:bold;margin-bottom:5px;display:flex;align-items:center;gap:7px;}
      #banScreen .ban-strip .txt{color:#e6e6e6;font-size:14px;line-height:1.55;
        white-space:pre-wrap;word-break:break-word;}
      #banScreen .ban-timer{background:#1b1b1b;border:1px solid #333;border-radius:0;
        padding:13px;margin:0;display:flex;align-items:center;justify-content:space-between;gap:12px;}
      #banScreen .ban-timer-label{color:#8d8d8d;font-size:10.5px;text-transform:uppercase;
        letter-spacing:.8px;}
      #banScreen .ban-timer-value{color:#fff;font-size:26px;font-weight:bold;
        font-variant-numeric:tabular-nums;font-family:'Courier New',monospace;}
      #banScreen .ban-perm{display:inline-flex;align-items:center;gap:8px;background:#1b1b1b;
        border:1px solid #333;border-left:3px solid #ff5468;color:#ff5468;
        font-weight:bold;font-size:13px;padding:11px 13px;border-radius:0;
        text-transform:uppercase;letter-spacing:.8px;margin:0;}
      /* The appeal panel is its own card, the way the dashboard and the
         suggestion board stack sections. */
      #banScreen .ban-appeal{background:#0d0d0d;border:1px solid #333;padding:0;text-align:left;}
      #banScreen .ban-appeal-h{background:#1b1b1b;border-bottom:1px solid #333;
        color:#fff;font-size:13px;font-weight:bold;margin:0;padding:10px 13px;
        display:flex;align-items:center;gap:8px;letter-spacing:.2px;}
      #banScreen .ban-appeal-h i{color:#ff9800;font-size:12px;}
      #banScreen .ban-appeal-p{color:#9a9a9a;font-size:12.5px;line-height:1.6;
        margin:0;padding:11px 13px 0;}
      #banScreen textarea#banAppealText{width:calc(100% - 26px);min-height:74px;resize:vertical;
        background:#000;color:#fff;border:1px solid #616161;border-radius:0;padding:10px 11px;
        font-family:talkoSS,Arial,sans-serif;font-size:13.5px;line-height:1.5;
        box-sizing:border-box;margin:11px 13px 0;display:block;}
      #banScreen textarea#banAppealText:focus{outline:none;border-color:#ff9800;}
      #banScreen .ban-appeal-row{display:flex;align-items:center;gap:11px;
        padding:10px 13px 13px;flex-wrap:wrap;}
      #banScreen button#banAppealSend{display:inline-flex;align-items:center;gap:8px;
        background:#ff9800;color:#000;border:none;border-radius:0;padding:9px 16px;
        font-size:13px;font-weight:bold;cursor:pointer;font-family:inherit;}
      #banScreen button#banAppealSend:hover{background:#ffad33;}
      #banScreen button#banAppealSend:disabled{opacity:.6;cursor:default;}
      #banScreen .ban-appeal-msg{font-size:12.5px;line-height:1.5;}
      #banScreen .ban-appeal-msg.ok{color:#57d9a3;}
      #banScreen .ban-appeal-msg.err{color:#ff5468;}
      #banScreen .ban-appeal-done{background:#1b1b1b;border:none;
        border-left:3px solid #57d9a3;border-radius:0;padding:13px;color:#d7f3e7;font-size:13.5px;
        line-height:1.55;text-align:left;display:flex;gap:10px;align-items:flex-start;margin:11px 13px 13px;}
      #banScreen .ban-appeal-done i{color:#57d9a3;margin-top:2px;}
      /* ── The appeal conversation ──
         Bubbles: staff on the left with their face and rank, you on the right.
         Nobody should have to work out who they are talking to. */
      #banScreen .ac-log{background:#000;border-top:1px solid #333;border-bottom:1px solid #333;
        padding:12px 13px;max-height:340px;overflow-y:auto;display:flex;flex-direction:column;
        scrollbar-width:thin;scrollbar-color:#3d3d3d transparent;}
      #banScreen .ac-log::-webkit-scrollbar{width:7px;}
      #banScreen .ac-log::-webkit-scrollbar-thumb{background:#3d3d3d;border-radius:4px;}
      #banScreen .ac-m{display:flex;flex-direction:column;gap:4px;max-width:88%;margin-top:12px;}
      #banScreen .ac-m:first-child{margin-top:0;}
      #banScreen .ac-m.user{align-self:flex-end;align-items:flex-end;}
      #banScreen .ac-m.staff{align-self:flex-start;}
      #banScreen .ac-who{font-size:11px;color:#8d8d8d;font-weight:bold;
        display:flex;align-items:center;gap:7px;}
      /* Who you are talking to: face, name, rank. */
      #banScreen .ac-av{position:relative;flex:none;width:26px;height:26px;border-radius:50%;
        overflow:hidden;background:#2b5e9e;color:#fff;font-size:11px;font-weight:bold;
        display:flex;align-items:center;justify-content:center;}
      #banScreen .ac-av.dev{background:#a3323f;}
      #banScreen .ac-av-i{position:absolute;inset:0;display:flex;align-items:center;
        justify-content:center;}
      /* Taken out once the picture is really there: a transparent avatar does
         not cover the letter, so the initial showed through its gaps. */
      #banScreen .ac-av.has-pic .ac-av-i{display:none;}
      #banScreen .ac-av img{position:absolute;inset:0;width:100%;height:100%;
        object-fit:cover;display:block;}
      #banScreen .ac-name{color:#fff;font-size:12.5px;}
      #banScreen .ac-rank{font-size:9.5px;font-weight:bold;letter-spacing:.5px;
        text-transform:uppercase;color:#5aa9ff;border:1px solid #5aa9ff;padding:1px 5px;}
      #banScreen .ac-rank.dev{color:#ff5468;border-color:#ff5468;}
      #banScreen .ac-b{background:#262626;padding:9px 12px;border-radius:12px 12px 12px 3px;
        font-size:13.5px;line-height:1.55;color:#ededed;white-space:pre-wrap;
        word-break:break-word;text-align:left;max-width:100%;}
      #banScreen .ac-m.user .ac-b{background:#7a4d05;color:#fff;border-radius:12px 12px 3px 12px;}
      #banScreen .ac-q{font-size:11.5px;color:rgba(255,255,255,.6);
        border-left:2px solid rgba(255,255,255,.3);
        padding-left:7px;margin-bottom:5px;display:block;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
      #banScreen .ac-t{font-size:10.5px;color:#6f6f6f;}
      #banScreen .ac-sys{align-self:center;max-width:100%;text-align:center;font-size:12px;
        color:#9a9a9a;background:#1b1b1b;border:1px solid #333;padding:6px 11px;
        line-height:1.5;margin-top:12px;}
      #banScreen .ac-reply{display:flex;align-items:center;gap:8px;background:#1b1b1b;
        border-left:3px solid #ff9800;padding:7px 10px;margin:11px 13px 0;
        font-size:12.5px;color:#c3c3c3;text-align:left;}
      #banScreen .ac-reply span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap;}
      #banScreen .ac-reply button{background:none;border:none;color:#8d8d8d;cursor:pointer;
        font-size:14px;padding:0 4px;font-family:inherit;}
      #banScreen .ac-rbtn{background:none;border:none;color:#6f6f6f;cursor:pointer;
        font-size:11px;font-family:inherit;padding:0;text-decoration:underline;}
      #banScreen .ac-rbtn:hover{color:#ff9800;}
      #banScreen .ac-closed{background:#1b1b1b;border-left:3px solid #616161;padding:11px 13px;
        margin:11px 13px 13px;font-size:12.5px;color:#9a9a9a;line-height:1.55;text-align:left;}
      #banScreen .ban-foot{padding-top:2px;display:flex;flex-direction:column;
        align-items:flex-start;gap:10px;}
      #banScreen .ban-discord{display:inline-flex;align-items:center;gap:9px;background:#5865f2;
        color:#fff;text-decoration:none;font-size:13px;font-weight:bold;padding:9px 16px;
        border-radius:0;transition:background .2s;}
      #banScreen .ban-discord:hover{background:#4752c4;}
      #banScreen .ban-note{color:#8d8d8d;font-size:12px;margin:0;line-height:1.55;}
      @media (max-width:520px){
        #banScreen{padding:0;}
        #banScreen .ban-card{border:none;min-height:100%;}
        #banScreen .ac-m{max-width:96%;}
      }
    `;
    document.head.appendChild(style);
  }

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

  // Reason is staff-entered free text: render via textContent, never as HTML.
  if (info.reason) {
    const rc = document.getElementById("banReason");
    const rt = document.getElementById("banReasonText");
    if (rc && rt) {
      rt.textContent = info.reason;
      rc.style.display = "block";
    }
  }

  // Who placed the ban (and when), built with textContent so the staff label is
  // never treated as HTML. Hidden when the server did not record it.
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

  // ── On-site appeal: the IP block only refuses sockets, so this HTTP POST
  // still reaches the server. Keyed server-side by the banned IP. ──
  const deviceIdOf = () =>
    (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
    undefined;

  // Everything below draws the conversation with staff. It is polled rather
  // than pushed: while blocked, this browser's socket is refused at the door,
  // so HTTP is the only channel there is.
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

  // The moderator's picture, rebuilt from the validated snowflake + hash the
  // server stores - the same rule the rooms use, never a raw URL from data.
  // Falls back to their initial, so there is always a face on the message.
  const PFP_ID_RE = /^\d{17,20}$/;
  const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;
  const banAvatarSeen = new Set();
  function appealFace(m) {
    const wrap = document.createElement("span");
    wrap.className = "ac-av" + (m.role === "dev" ? " dev" : "");
    // The initial goes underneath and stays there. The picture covers it, so
    // a redraw or a CDN hiccup can never leave an empty circle - which is how
    // faces were disappearing mid-conversation.
    const letter = document.createElement("span");
    letter.className = "ac-av-i";
    letter.textContent = (m.by || "S").trim().charAt(0).toUpperCase();
    wrap.appendChild(letter);
    // The lobby's own builder, so an animated picture animates here too.
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
      wrap.classList.add("has-pic"); // drop the letter behind it
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
        // A name, a rank and a face. Somebody appealing a ban is talking to a
        // person, and every part of this is what makes that obvious.
        who.appendChild(appealFace(m));
        const nm = document.createElement("span");
        nm.className = "ac-name";
        nm.textContent = m.by || "Staff";
        who.appendChild(nm);
        const rank = document.createElement("span");
        const isDev = m.role === "dev";
        rank.className = "ac-rank" + (isDev ? " dev" : "");
        rank.textContent = isDev
          ? "Developer"
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
      // Answering a specific question is the difference between a chat and
      // two people talking past each other.
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
        // Only redraw when something actually changed, so a reply being typed
        // is never wiped by a poll landing mid-sentence.
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
          // Filed, or one is already open or decided for this ban: either way
          // the conversation is what they should be looking at.
          if (d && (d.ok || d.code === "already" || d.code === "decided"))
            return pollIntoChat(true);
          sendBtn.disabled = false;
          sendBtn.innerHTML = prev;
          msgEl.classList.add("err");
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

  // Fetch the thread and switch the panel over to the conversation. On the
  // first load there may not be one yet, and that is not an error - the form
  // simply stays as it is.
  function pollIntoChat(justSent) {
    const q = deviceIdOf() ? "?deviceId=" + encodeURIComponent(deviceIdOf()) : "";
    return fetch("/api/v1/appeal" + q, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ok && d.has) return startAppealChat(d);
        if (justSent)
          showAppealDone("Appeal submitted. A staff member will review it.");
      })
      .catch(() => {
        if (justSent)
          showAppealDone("Appeal submitted. A staff member will review it.");
      });
  }

  // An appeal filed earlier (or in another tab) opens straight into the chat,
  // so a moderator's question is not sitting unread behind a "submitted" note.
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

  // Poll for an early lift (a dev accepting the appeal, unblocking the IP, or
  // shortening the ban). The socket stays refused while blocked, so this checks
  // over plain HTTP and reloads the moment the ban is gone. It also re-checks
  // immediately when the tab is focused, so coming back feels instant.
  let banLifted = false;
  const checkLifted = () => {
    if (banLifted || document.hidden) return;
    fetch("/api/v1/ban-status", { credentials: "same-origin", cache: "no-store" })
      // Only trust a real 200 response. A 429/5xx has no reliable ban state, and
      // its error body carries no `banned` field - which previously read as
      // falsy and was mistaken for "unbanned", firing a reload that re-polled,
      // re-tripped the limiter, and looped every ~20-30s. Require an EXPLICIT
      // banned:false before declaring the ban lifted.
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (banLifted || !d || typeof d.banned !== "boolean" || d.banned)
          return;
        banLifted = true;
        // The lobby reads this once after the reload to welcome the user back.
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
// 8. FORM HANDLERS
// ============================================================================

// Show/hide access code field
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
  const newLocation =
    locationInput.value.trim().slice(0, MAX_LOCATION_LENGTH) || "On The Web";

  if (newUsername) {
    localStorage.setItem("talkomaticUsername", newUsername);
    localStorage.setItem("talkomaticLocation", newLocation);

    // Discord avatar: resolve the entered ID before joining so the avatar is
    // part of this sign-in. A lookup failure never blocks signing in.
    const pfpEnable = document.getElementById("pfpEnable");
    const pfpIdInput = document.getElementById("pfpDiscordId");
    if (pfpEnable && pfpEnable.checked) {
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
          // If this exact ID previously had no picture, bypass caches so a
          // freshly added Discord avatar is found right away.
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
      createRoomForm.classList.remove("hidden");
    }

    currentUsername = newUsername;
    currentLocation = newLocation;
    isSignedIn = true;

    emitJoinLobby(currentUsername, currentLocation);

    showRoomList();
  } else {
    window.showErrorModal("Please enter a username.");
  }
});

// Pfp form wiring: checkbox reveals the ID input; both restore from storage.
function updatePfpPreview() {
  const img = document.getElementById("pfpPreview");
  if (!img) return;
  const av = storedAvatar();
  const url = av && avatarUrl(av, 32);
  if (url) {
    img.src = url;
    img.style.display = "inline-block";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
  }
}

(function initPfpControls() {
  const box = document.getElementById("pfpEnable");
  const input = document.getElementById("pfpDiscordId");
  const body = document.getElementById("pfpBody");
  const helpBtn = document.getElementById("pfpHelpBtn");
  const help = document.getElementById("pfpHelp");
  if (!box || !input) return;
  const card = document.querySelector(".pfp-card");
  const sync = () => {
    if (body) body.style.display = box.checked ? "block" : "none";
    if (!box.checked && help) help.style.display = "none";
    if (card) card.classList.toggle("pfp-on", box.checked);
  };
  box.addEventListener("change", sync);
  if (helpBtn && help)
    helpBtn.addEventListener("click", () => {
      help.style.display = help.style.display === "none" ? "block" : "none";
    });
  try {
    if (localStorage.getItem("talkomaticPfpEnabled") === "1") box.checked = true;
    const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
    if (c && PFP_ID_RE.test(c.discordId)) input.value = c.discordId;
  } catch (e) {}
  sync();
  updatePfpPreview();

  // People change their Discord picture: refresh the stored hash shortly
  // after load and push the new one to the server if it differs. If the
  // account lost its avatar, turn the feature off cleanly.
  setTimeout(async () => {
    if (localStorage.getItem("talkomaticPfpEnabled") !== "1") return;
    const before = storedAvatar();
    if (!before) return;
    try {
      const after = await resolveAvatar(before.discordId);
      if (after.hash !== before.hash) {
        updatePfpPreview();
        if (currentUsername)
          emitJoinLobby(currentUsername, currentLocation || "On The Web");
      }
    } catch (e) {
      localStorage.removeItem("talkomaticPfpEnabled");
      localStorage.removeItem("talkomaticPfp");
      updatePfpPreview();
      if (box) box.checked = false;
      sync();
      if (currentUsername)
        emitJoinLobby(currentUsername, currentLocation || "On The Web");
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
  // The slider, clamped here and again on the server. The ceiling has to be
  // the LEVEL's, not a fixed 10: this clamp is what was quietly cutting a
  // staff member's 50 back down to 10 after the slider had offered it.
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

    // FIX #4: The access code is sent to the server ONLY in this socket
    // event. The server validates it and stores it in the session before
    // confirming, so the redirect URL never needs to carry it.
    // No layout here any more: every room starts vertical, and the button in
    // the room's top right switches it for whoever presses it.
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
// 9. ROOM JOIN / CREATE FLOW
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

// FIX #4: Redirect with roomId ONLY. The server has already validated and
// stored the access code in the session (it awaits the session save before
// emitting this event), so room.html joins via the session - the code never
// touches the URL, browser history, or analytics.
socket.on("room joined", (data) => {
  window.location.href = `/room.html?roomId=${data.roomId}`;
});

// FIX #4: Same for room creation - roomId only.
socket.on("room created", (roomId) => {
  window.location.href = `/room.html?roomId=${roomId}`;
});

// ============================================================================
// 10. SIGN-IN STATUS & SIGN-OUT
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
    createRoomForm.classList.remove("hidden");

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

  createRoomForm.classList.add("hidden");
  signInMessage.style.display = "block";
  roomListContainer.style.display = "none";

  if (socket.connected) {
    socket.emit("leave lobby");
  }
}

// ============================================================================
// 11. LOBBY ROOM LIST
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
      const jr = (user.modLevel || 2) === 1;
      const mb = document.createElement("span");
      mb.className = jr
        ? "mod-lobby-badge mod-lobby-badge-jr"
        : "mod-lobby-badge";
      mb.textContent = jr ? "JR MOD" : "MOD";
      mb.title = jr ? "Junior moderator (level 1)" : "Moderator";
      userDiv.appendChild(mb);
    }

    // Bots wear the same gray flair here as in the room itself.
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
    const locSpan = document.createElement("span");
    locSpan.className = "user-loc";
    locSpan.textContent = ` / ${user.location}`;
    userDiv.appendChild(locSpan);

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

  // Enter plus a spectate eye for public rooms. Spectate is read-only and works
  // even when the room is full; semi-private rooms are left out so the access
  // code isn't bypassed.
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

  // Per-room staff controls; spotlight stays dev-only.
  if (currentUserIsDev || (currentUserIsMod && currentUserModLevel >= 2)) {
    const devRow = document.createElement("div");
    devRow.className = "lobby-dev-controls";

    // Public rooms already have the everyone-eye next to Enter; a spectate
    // button appears here only for the rooms that eye does not cover.
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
// 12. ANTI-SPAM: ACTIVITY-BASED ROOM SORTING
// ============================================================================

function sortRoomsByActivity(rooms) {
  return rooms.slice().sort((a, b) => {
    // Spotlighted ("Official") rooms are always pinned to the top
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
// 13. INITIALIZATION
// ============================================================================

// How far the room size slider goes, by what the signed-in person holds. The
// server clamps whatever actually arrives (newRoomCapacity), so this is only
// about not offering a number that would be silently cut back down.
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
  sizeEl.dispatchEvent(new Event("input")); // keep the number above it in step

  // Redraw the tick labels. Every value fits under the slider at 10 and
  // nothing like it at 50, so the scale becomes evenly spaced markers.
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

  // The room size slider, with the number above it kept in step.
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

  // Guard the optional stats button: it was removed from the lobby menu, so
  // getElementById returns null. Without this guard the throw aborts the rest
  // of initLobby - including the Update Notes binding below.
  const statsBtn = document.getElementById("statsForNerdsButton");
  if (statsBtn)
    statsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (statsModal) {
        statsModal.open();
      }
    });

  // Update Notes: re-open the update popup (popup.js) on demand.
  const updateNotesBtn = document.getElementById("updateNotesButton");
  if (updateNotesBtn)
    updateNotesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.TalkomaticPopup) window.TalkomaticPopup.forceShowPopup();
    });

  setTimeout(() => {
    const savedUsername = localStorage.getItem("talkomaticUsername");
    const savedLocation = localStorage.getItem("talkomaticLocation");

    if (savedUsername) {
      currentUsername = savedUsername;
      currentLocation = savedLocation || "On The Web";
      isSignedIn = true;

      usernameInput.value = currentUsername;
      locationInput.value = currentLocation;

      setSignedInButtonState();
      createRoomForm.classList.remove("hidden");

      emitJoinLobby(savedUsername, savedLocation || "On The Web");
      showRoomList();
    } else {
      const guestDigits = Math.floor(10000 + Math.random() * 90000);
      const guestUsername = `Guest${guestDigits}`;
      const guestLocation = "Earth";

      usernameInput.value = guestUsername;
      locationInput.value = guestLocation;

      localStorage.setItem("talkomaticUsername", guestUsername);
      localStorage.setItem("talkomaticLocation", guestLocation);

      currentUsername = guestUsername;
      currentLocation = guestLocation;
      isSignedIn = true;

      setSignedInButtonState();
      createRoomForm.classList.remove("hidden");

      emitJoinLobby(guestUsername, guestLocation);
      showRoomList();
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
// 14. DEV / STAFF UI (lobby) - built on the shared StaffUI kit. The server
// validates the dev key on every action; this layer is presentation only.
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
  // Moderators get a panel here too. Without one they had no way to reach
  // their own key or the dashboard from the lobby.
  btn.innerHTML = currentUserIsDev
    ? '<i class="fas fa-screwdriver-wrench"></i> Dev Panel'
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
    title: "Dev panel",
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
        ],
      },
    ],
  });
}

// The lobby panel for moderators. Devs get openDevPanel with the global tools;
// a mod's global surface is their record and their key.
function openModLobbyPanel() {
  if (!window.StaffUI) return;
  StaffUI.panel({
    title: "Mod panel",
    icon: '<i class="fas fa-shield-halved"></i>',
    subtitle:
      currentUserModLevel >= 2 ? "Full mod (L2)" : "Junior mod (L1)",
    onHelp: () => StaffUI.help(currentUserModLevel >= 2 ? "mod" : "jr"),
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
        ],
      },
    ],
  });
}

// Show the staff key this browser is signed in with. Kept hidden behind a
// click, because it is the only proof of role: anyone who reads it over your
// shoulder becomes you.
function myKeyItem() {
  return {
    icon: '<i class="fas fa-key"></i>',
    label: "Show my staff key",
    desc: "Reveal and copy the key this browser uses",
    onClick: () => openMyKey(),
  };
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
        (devKey ? "developer" : "moderator") +
        " key this browser is signed in with. Treat it like a password: it is the only proof of your role, so never paste it anywhere public or share it, not even with other staff. If it leaks, tell a developer and it will be revoked.",
    }),
  );

  // The reveal lives in the body, not the footer: footer buttons close the
  // modal, and hiding it again should not mean reopening the whole thing.
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
      text: `New ${data.level === 1 ? "junior (L1)" : "full (L2)"} mod key for "${data.label}". This is shown ONCE, so copy it now and send it to them.`,
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

// Per-key actions: promote/demote level or revoke. Opened from the manage list.
function openModKeyActions(k) {
  if (!window.StaffUI) return;
  const toLevel = k.level === 1 ? 2 : 1;
  StaffUI.menu({
    title: k.label,
    icon: '<i class="fas fa-user-shield"></i>',
    subtitle: `Level ${k.level === 1 ? 1 : 2} · key ${k.hash.slice(0, 12)}…`,
    groups: [
      {
        items: [
          {
            icon:
              toLevel === 2
                ? '<i class="fas fa-arrow-up"></i>'
                : '<i class="fas fa-arrow-down"></i>',
            label:
              toLevel === 2
                ? "Promote to full mod (L2)"
                : "Demote to junior (L1)",
            desc:
              toLevel === 2
                ? "Grant ban + IP block powers"
                : "Limit to junior powers",
            onClick: async () => {
              const ok = await StaffUI.confirm({
                title: toLevel === 2 ? "Promote to L2" : "Demote to L1",
                message:
                  toLevel === 2
                    ? `Give "${k.label}" full (level 2) powers?`
                    : `Limit "${k.label}" to junior (level 1) powers?`,
                confirmText: toLevel === 2 ? "Promote" : "Demote",
              });
              if (ok)
                socket.emit("dev set mod level", {
                  hash: k.hash,
                  level: toLevel,
                });
            },
          },
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
        label: `${k.label} - ${k.level === 1 ? "L1" : "L2"}`,
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
  const items = blocks.length
    ? blocks.map((b) => ({
        icon: '<i class="fas fa-ban"></i>',
        label: (b.label ? b.label + "  " : "") + b.ip,
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
              message:
                "Unblock " +
                (b.label ? b.label + " (" + b.ip + ")" : b.ip) +
                "?",
              confirmText: "Unblock",
            })
          )
            socket.emit("dev unblock ip", { ip: b.ip });
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
            icon: flags.puzzleEnabled
              ? '<i class="fas fa-puzzle-piece"></i>'
              : '<i class="fas fa-ban"></i>',
            label: `Puzzle app: ${flags.puzzleEnabled ? "ON" : "OFF"}`,
            desc: "Show or hide the in-room jigsaw puzzle",
            onClick: () =>
              socket.emit("dev set flags", {
                puzzleEnabled: !flags.puzzleEnabled,
              }),
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

socket.on("staff revoked", () => {
  localStorage.removeItem("talkomatic_modKey");
  currentUserIsMod = false;
  currentUserModLevel = 0;
  lobbyNotify("Your mod key was revoked.", "warning", { timeout: 6000 });
  setTimeout(() => window.location.reload(), 1500);
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
  lobbyNotify(
    d.level === 2
      ? "You've been promoted to Moderator (full)! Reloading…"
      : "You've been made a Junior Moderator! Reloading…",
    "success",
    { title: "You are now a mod", timeout: 4000 },
  );
  setTimeout(() => window.location.reload(), 1600);
});
socket.on("staff level changed", (d) => {
  if (!d) return;
  currentUserModLevel = d.level === 1 ? 1 : 2;
  lobbyNotify(
    currentUserModLevel >= 2
      ? "You are now a full (level 2) moderator."
      : "Your moderator level is now junior (level 1).",
    "info",
    { timeout: 6000 },
  );
});
// Device identity: stash the activity summary for later features (mod
// applications) and warn once if this browser's id had to be restored from
// a backup layer because localStorage was cleared.
socket.on("identity status", (d) => {
  if (window.TalkomaticIdentity) window.TalkomaticIdentity.activity = d || null;
});
// Staff-only live alerts (reports, mod-abuse flags), pushed by the server only
// to qualifying staff sockets.
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

// Key entry is reachable from the "Staff Access" link in the lobby menu, by
// opening the lobby with #staff in the URL, or via the deep link from mod.html.
const staffLoginLink = document.getElementById("staffLoginLink");
if (staffLoginLink)
  staffLoginLink.addEventListener("click", (e) => {
    e.preventDefault();
    // Already signed in as staff: jump straight to the dashboard (mod.html is
    // exempt from the single-tab guard). Otherwise open the key-entry box.
    if (currentUserIsDev || currentUserIsMod)
      window.open("/mod.html", "_blank");
    else openStaffKeyEntry();
  });

// The latest mod-application status for this browser (pending / approved /
// rejected), pushed by the server on connect and on demand. Lets the lobby
// menu offer "Check status" with the reviewer's note instead of "Become a
// moderator" once a person has applied.
let myAppStatus = null;
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

// Restyle the lobby link: a colored status dot + "Check status" once an
// application exists, otherwise the plain "Become a moderator". Staff never see
// this link (updateStaffLink hides it), so only restyle it for non-staff.
function updateModApplyLink() {
  const link = document.getElementById("modApplyLink");
  if (!link || currentUserIsDev || currentUserIsMod) return;
  if (myAppStatus && myAppStatus.has && APP_STATUS_META[myAppStatus.status]) {
    const m = APP_STATUS_META[myAppStatus.status];
    link.innerHTML =
      '<i class="fas fa-circle" style="color:' +
      m.color +
      '"></i> Check status';
  } else {
    link.innerHTML = '<i class="fas fa-user-pen"></i> Become a moderator';
  }
}

// The status modal: a colored icon (amber pending, red denied, green approved)
// and the reviewer's message if they left one.
function showAppStatus() {
  const st = myAppStatus;
  if (!st || !st.has) return openModApply();
  if (!window.StaffUI) return;
  const m = APP_STATUS_META[st.status] || APP_STATUS_META.pending;
  const body = document.createElement("div");
  const p = document.createElement("p");
  p.style.margin = "0 0 6px";
  p.textContent =
    st.status === "approved"
      ? "Good news - your application was approved. Your moderator access is delivered to this browser automatically; reload if you do not see it yet."
      : st.status === "rejected"
        ? "Your application was reviewed and not approved this time."
        : st.status === "revoked"
          ? "Your moderator access has been revoked. If you would like to help out again, you can apply again below."
          : "Your application is in the queue. A developer or full moderator will review it soon. Thanks for your patience.";
  body.appendChild(p);
  if (st.submittedAt) {
    const s = document.createElement("p");
    s.style.cssText = "margin:6px 0 0;color:#8d8d8d;font-size:13px;";
    s.textContent = "Submitted " + new Date(st.submittedAt).toLocaleString();
    body.appendChild(s);
  }
  // Reviewer note rendered via textContent (never HTML), squared orange-style
  // strip matching the rest of the staff UI. Never shown for a revoked status
  // (its note would be the old approval message, which no longer applies).
  if (st.reason && st.status !== "revoked") {
    const note = document.createElement("div");
    note.style.cssText =
      "margin-top:14px;padding:11px 13px;background:#161616;border:1px solid #333;border-left:3px solid " +
      m.color +
      ";border-radius:0;text-align:left;";
    const nl = document.createElement("div");
    nl.style.cssText =
      "font-size:11px;text-transform:uppercase;letter-spacing:.6px;font-weight:bold;margin-bottom:5px;color:" +
      m.color +
      ";";
    nl.textContent = "Message from staff";
    const nt = document.createElement("div");
    nt.style.cssText =
      "color:#e6e6e6;font-size:14px;line-height:1.5;white-space:pre-wrap;";
    nt.textContent = st.reason;
    note.appendChild(nl);
    note.appendChild(nt);
    body.appendChild(note);
  }
  const actions = [{ label: "Close", kind: "primary", onClick: () => {} }];
  if (st.status === "rejected" || st.status === "revoked")
    actions.unshift({ label: "Apply again", onClick: () => openModApply() });
  StaffUI.modal({
    title: m.title,
    icon: '<i class="fas ' + m.fa + '" style="color:' + m.color + '"></i>',
    body: body,
    actions: actions,
  });
}

// Mod application (active members only; the server re-checks "active").
async function openModApply() {
  if (currentUserIsDev || currentUserIsMod) {
    lobbyNotify("You're already staff.", "info");
    return;
  }
  if (!window.StaffUI) return;
  const act = window.TalkomaticIdentity && window.TalkomaticIdentity.activity;
  if (!act || !act.active) {
    const need = (act && act.need) || { days: 2, minutes: 15, acts: 10 };
    const have = {
      days: (act && act.days) || 0,
      minutes: (act && act.minutes) || 0,
      acts: (act && act.acts) || 0,
    };
    const body = document.createElement("div");
    const p = document.createElement("p");
    p.textContent =
      "Moderator applications open up once you are an active member. Keep chatting across a few days and this unlocks automatically. Your progress:";
    body.appendChild(p);
    const list = document.createElement("div");
    list.style.cssText = "margin-top:12px;font-size:14px;line-height:2.1;";
    const line = (label, h, w) => {
      const row = document.createElement("div");
      const done = h >= w;
      row.textContent =
        (done ? "✓ " : "• ") +
        label +
        ": " +
        Math.min(h, w) +
        " of " +
        w;
      row.style.color = done ? "#57d9a3" : "#cfd3da";
      return row;
    };
    list.appendChild(line("Days visited", have.days, need.days));
    list.appendChild(line("Active minutes", have.minutes, need.minutes));
    list.appendChild(line("Chat activity", have.acts, need.acts));
    body.appendChild(list);
    StaffUI.modal({
      title: "Become a moderator",
      icon: '<i class="fas fa-user-clock"></i>',
      body: body,
      actions: [{ label: "Got it", kind: "primary", onClick: () => {} }],
    });
    return;
  }
  const r = await StaffUI.prompt({
    title: "Apply to moderate",
    icon: '<i class="fas fa-user-pen"></i>',
    subtitle: "Junior moderators help keep rooms friendly",
    message:
      "If approved you get the junior moderator role: you can warn and kick, clear what someone has typed, reset a bad name, location or profile picture, and rename, lock or slow a room. Bans and IP blocks stay with full mods. Misuse loses the role; trusted juniors may be promoted later by a dev.\n\nLink your Discord picture and join the Talkomatic Discord before applying. We can only reach you there, applicants we can reach are much likelier to be accepted, and once approved you get the site mod role in the server so you can talk to the other moderators and the devs.",
    fields: [
      {
        name: "why",
        label: "Why do you want to help moderate?",
        type: "textarea",
        maxLength: 500,
        required: true,
        placeholder: "Tell us a little about yourself…",
      },
      {
        name: "discord",
        label: "Your Discord username",
        type: "text",
        maxLength: 40,
        required: true,
        placeholder: "e.g. zacki",
        help: "So we can find you in the Talkomatic Discord and give you the mod role if you are accepted. Your @username, not your display name.",
      },
      {
        name: "availability",
        label: "When are you usually online? (optional)",
        type: "text",
        maxLength: 120,
        placeholder: "e.g. evenings, UTC",
      },
    ],
    confirmText: "Send application",
  });
  if (r && r.why)
    socket.emit("mod application submit", {
      why: r.why,
      availability: r.availability,
      discord: r.discord,
    });
}
const modApplyLink = document.getElementById("modApplyLink");
if (modApplyLink)
  modApplyLink.addEventListener("click", (e) => {
    e.preventDefault();
    // Already applied? Show their status. Otherwise open the apply form.
    if (myAppStatus && myAppStatus.has) {
      socket.emit("mod application status"); // refresh in case it changed
      showAppStatus();
    } else openModApply();
  });
socket.on("mod application result", (d) => {
  if (!d) return;
  if (d.ok) {
    lobbyNotify(
      "Application sent! Staff will review it. Thanks for stepping up.",
      "success",
      { timeout: 7000 },
    );
    // Reflect the pending state on the menu link right away.
    myAppStatus = { has: true, status: "pending", submittedAt: Date.now() };
    updateModApplyLink();
  } else
    lobbyNotify(d.error || "Could not send your application.", "error", {
      timeout: 7000,
    });
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
    // Community board modal (suggest-board.js); old prompt is the fallback.
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

// The server pushes this on connect (if an application exists) and on request.
socket.on("mod application status", (d) => {
  myAppStatus = d && d.has ? d : null;
  updateModApplyLink();
  // A live review (the user is in the lobby when staff decide) gets a one-time
  // notification, the same way a lifted ban does. The on-connect push has no
  // `live` flag, so a page load never re-toasts an old decision. The full
  // reviewer message is always available behind the "Check status" link.
  if (d && d.live && d.has) {
    if (d.status === "approved")
      lobbyNotify("Your moderator application was approved!", "success", {
        timeout: 10000,
      });
    else if (d.status === "rejected")
      lobbyNotify(
        "Your moderator application was declined." +
          (d.reason ? " Reason: " + d.reason : " Open Check status for details."),
        "info",
        { timeout: 12000 },
      );
  }
});

// Reflect the server-proven staff role in the menu link: "Staff Access" becomes
// "Mod Dashboard" for mods and "Dev Dashboard" for devs once a key validates.
function updateStaffLink() {
  const link = document.getElementById("staffLoginLink");
  if (link) {
    if (currentUserIsDev)
      link.innerHTML = '<i class="fas fa-gauge-high"></i> Dev Dashboard';
    else if (currentUserIsMod)
      link.innerHTML = '<i class="fas fa-gauge-high"></i> Mod Dashboard';
    else link.innerHTML = '<i class="fas fa-key"></i> Staff Access';
  }
  // Staff do not apply to be a mod, so hide the apply link for them.
  const applyLink = document.getElementById("modApplyLink");
  if (applyLink) {
    applyLink.style.display =
      currentUserIsDev || currentUserIsMod ? "none" : "";
    // Reflect any known application status ("Check status" + colored dot).
    updateModApplyLink();
  }
}
updateStaffLink();
// If the ban screen just reloaded us because a ban was lifted, welcome the user
// back once. The flag is set on the ban screen right before it reloads.
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

// Lobby staff styles (badges, spotlight, dev button, ticker / maintenance bars)
(function injectLobbyStaffStyles() {
  const css = `
    .mod-lobby-badge{display:inline-block;background:#00bcd4;color:#003;font-size:8px;font-weight:bold;padding:1px 4px;border-radius:6px;margin:0 4px;letter-spacing:.5px;vertical-align:middle;}
    .mod-lobby-badge.mod-lobby-badge-jr{background:#ab47bc;color:#fff;}
    .bot-lobby-badge{display:inline-block;background:var(--bot-flair,#9aa3ae);color:#16191d;font-size:8px;font-weight:bold;padding:1px 4px;border-radius:6px;margin:0 4px 0 0;letter-spacing:.5px;vertical-align:middle;}
    .official-badge{display:inline-block;background:#ffd700;color:#3a2c00;font-size:9px;font-weight:bold;padding:1px 6px;border-radius:8px;margin-right:6px;letter-spacing:.5px;}
    .room.spotlight-room{border:1px solid #ffd700 !important;box-shadow:0 0 0 1px rgba(255,215,0,.25) inset;}
    .lobby-dev-controls{display:flex;gap:6px;margin-top:6px;}
    .lobby-dev-btn{flex:1;background:#000;color:#ff9800;border:1px solid #616161;border-radius:4px;padding:6px 7px;font-size:11px;cursor:pointer;font-weight:bold;font-family:inherit;transition:all .2s ease;}
    .lobby-dev-btn:hover{border-color:#ff9800;background:#ff9800;color:#000;}
    #devPanelButton{position:fixed;bottom:16px;right:16px;z-index:99990;background:#000;color:#ffffff;border:1px solid #ff9800;border-radius:4px;padding:10px 16px;font-size:13px;font-weight:bold;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5);transition:all .2s ease;}
    #devPanelButton:hover{background:#ff9800;color:#000;}
    #lobbyTickerBar{position:fixed;top:0;left:0;right:0;z-index:99980;background:#ff9800;color:#1a1206;text-align:center;font-size:13px;font-weight:700;padding:7px 16px;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;}
    #lobbyMaintenanceBar{position:fixed;bottom:0;left:0;right:0;z-index:99980;background:#5c2d91;color:#fff;text-align:center;font-size:13px;font-weight:700;padding:7px 16px;box-sizing:border-box;}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();
