// ============================================================================
// Talkomatic Lobby Menu Functionality
// ----------------------------------------------------------------------------
// This JavaScript file handles the functionality for the left-side panel (menu)
// in the Talkomatic lobby page. It includes toggle functionality to open/close
// the menu, handles responsiveness for different screen sizes, and listens for
// clicks outside the menu to close it.
//
// Key Functionalities:
// - Toggling the left panel (menu) open/closed.
// - Hiding the menu on larger screens.
// - Detecting clicks outside the menu to close it.
// - Handling window resize events to ensure proper behavior across devices.
// ============================================================================

// DOM Element References
const leftPanel = document.getElementById("leftPanel");
const toggleButton = document.getElementById("toggleButton");
const hideMenuButton = document.getElementById("hideMenuButton");

// Modal functionality
const roomInfoModal = document.getElementById("roomInfoModal");
const learnMoreBtn = document.querySelector(".learn-more");
const closeRoomInfoBtn = document.querySelector(".close-modal");

/**
 * Toggles the left panel open/closed state
 */
function toggleLeftPanel() {
  leftPanel.classList.toggle("open");
  toggleButton.style.opacity = leftPanel.classList.contains("open") ? "0" : "1";
}

/**
 * Hides the left panel
 */
function hideLeftPanel() {
  leftPanel.classList.remove("open");
  setTimeout(() => {
    toggleButton.style.opacity = "1";
  }, 300);
}

/**
 * Handles window resize events
 */
function handleResize() {
  if (window.innerWidth > 992) {
    leftPanel.classList.remove("open");
    toggleButton.style.opacity = "0";
    hideMenuButton.style.display = "none";
  } else {
    if (!leftPanel.classList.contains("open")) {
      toggleButton.style.opacity = "1";
    }
    hideMenuButton.style.display = "block";
  }
}

/**
 * Handles clicks outside the left panel to close it
 * @param {Event} event - The click event
 */
function handleOutsideClick(event) {
  const isClickInside =
    leftPanel.contains(event.target) || toggleButton.contains(event.target);
  if (!isClickInside && leftPanel.classList.contains("open")) {
    hideLeftPanel();
  }
}

// Event Listeners for the panel
document.addEventListener("click", handleOutsideClick);
window.addEventListener("resize", handleResize);
hideMenuButton.addEventListener("click", hideLeftPanel);
toggleButton.addEventListener("click", toggleLeftPanel);

/**
 * Initial Setup
 */
function init() {
  if (window.innerWidth <= 992) {
    toggleButton.style.opacity = "1";
  }
}

/**
 * Opens the room info modal with a fade-in animation
 */
function openRoomInfoModal() {
  roomInfoModal.style.display = "flex";
  // Trigger reflow
  roomInfoModal.offsetHeight;
  roomInfoModal.classList.add("show");
}

/**
 * Closes the room info modal with a fade-out animation
 */
function closeRoomInfoModal() {
  roomInfoModal.classList.remove("show");
  setTimeout(() => {
    roomInfoModal.style.display = "none";
  }, 300);
}

// Event listeners for room info modal
learnMoreBtn.addEventListener("click", (e) => {
  e.preventDefault();
  openRoomInfoModal();
});
closeRoomInfoBtn.addEventListener("click", closeRoomInfoModal);
roomInfoModal.addEventListener("click", (e) => {
  if (e.target === roomInfoModal) {
    closeRoomInfoModal();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && roomInfoModal.classList.contains("show")) {
    closeRoomInfoModal();
  }
});

/**
 * Helper: setCookie
 * Sets a cookie with given name, value, and expiration in days
 */
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = "expires=" + d.toUTCString();
  document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

/**
 * Helper: getCookie
 * Returns the cookie value or an empty string if not found
 */
function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(";");
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i].trim();
    if (c.indexOf(nameEQ) === 0) {
      return c.substring(nameEQ.length, c.length);
    }
  }
  return "";
}

let dbPromise;
async function initDB() {
  dbPromise = idb.openDB("talkomatic-themes", 2, {
    upgrade(db, oldVersion, newVersion, transaction) {
      // Check before creating rather than trusting oldVersion. A browser whose
      // database was left half-upgraded reports an old version while already
      // holding the store, and createObjectStore then throws ConstraintError,
      // which aborts the whole upgrade transaction and leaves themes broken
      // with an AbortError in the console on every load.
      if (!db.objectStoreNames.contains("themes")) {
        const store = db.createObjectStore("themes", { keyPath: "id" });
        store.createIndex("by-date", "dateAdded");
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    },
  });
}

async function getCurrentTheme() {
  const db = await dbPromise;
  return db.get("settings", "currentTheme");
}

/**
 * One community invite toast (Discord, Reddit). Sticky until dismissed, and
 * dismissing it remembers that choice for 14 days under its own cookie so the
 * two are independent.
 */
function showCommunityInvite({ cookie, title, blurb, cta, color, url }) {
  if (getCookie(cookie) === "true") return null;

  // Sticky until closed. newestOnTop is set explicitly rather than inherited:
  // assigning to toastr.options replaces the whole object, so anything left
  // out here falls back to the library default instead of what the page set.
  toastr.options = {
    closeButton: true,
    newestOnTop: true,
    positionClass: "toast-top-right",
    timeOut: 0,
    extendedTimeOut: 0,
    tapToDismiss: false,
    preventDuplicates: false,
    showDuration: 300,
    hideDuration: 300,
    showEasing: "swing",
    hideEasing: "linear",
    showMethod: "fadeIn",
    hideMethod: "fadeOut",
  };

  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "8px";

  const desc = document.createElement("div");
  desc.textContent = blurb;
  container.appendChild(desc);

  const button = document.createElement("button");
  button.className = "toast-cta";
  button.textContent = cta;
  button.style.backgroundColor = color;
  button.style.color = "#FFF";
  button.style.border = "none";
  button.style.padding = "6px 12px";
  button.style.borderRadius = "4px";
  button.style.cursor = "pointer";
  button.style.fontWeight = "bold";
  container.appendChild(button);

  // Listeners do NOT survive the trip through Toastr as HTML, so they are
  // attached to the LIVE toast below instead.
  const $toast = toastr.info(container.outerHTML, title);
  if (!$toast) return null;

  // ".toast-cta", not "button": find("button") also matched the X, so closing
  // the toast opened the link as well and it read as un-closable.
  $toast.find(".toast-cta").on("click", function (e) {
    e.stopPropagation();
    window.open(url, "_blank", "noopener");
  });

  // Clicking the body opens the link too; the X and the CTA are excluded so
  // they keep their own behaviour.
  $toast.on("click", function (e) {
    if ($(e.target).closest(".toast-close-button, .toast-cta").length) return;
    window.open(url, "_blank", "noopener");
  });

  $toast.find(".toast-close-button").on("click", function () {
    setCookie(cookie, "true", 14);
  });

  return $toast;
}

/**
 * The two community invites. Discord is shown first so that, with newestOnTop,
 * Reddit lands above it.
 */
function showCommunityInvites() {
  showCommunityInvite({
    cookie: "dismissedDiscordInvite",
    title: "Join Our Discord!",
    blurb:
      "For community help, support, bug reports, or just to meet others!",
    cta: "Join Discord",
    color: "#5865F2",
    url: "https://discord.gg/N7tJznESrE",
  });
  showCommunityInvite({
    cookie: "dismissedRedditInvite",
    title: "Join Our Subreddit!",
    blurb: "Share ideas, read announcements, and see what others are making.",
    cta: "Join Reddit",
    color: "#FF4500",
    url: "https://www.reddit.com/r/talkomatic/",
  });
}

// Run after DOM is fully loaded
document.addEventListener("DOMContentLoaded", async () => {
  // Basic Toastr options (some overridden above)
  toastr.options = {
    closeButton: true,
    newestOnTop: true,
    positionClass: "toast-top-right",
    timeOut: 0,
    extendedTimeOut: 0,
    tapToDismiss: true,
    preventDuplicates: false,
    showDuration: 300,
    hideDuration: 300,
    showEasing: "swing",
    hideEasing: "linear",
    showMethod: "fadeIn",
    hideMethod: "fadeOut",
  };

  // Show the community invites after a brief delay
  setTimeout(() => {
    showCommunityInvites();
  }, 2000);

  await initDB();
  const saved = await getCurrentTheme();
  // Migration: the World Cup 2026 theme was retired and its files removed. Users
  // who had it selected have its CSS stored locally (which also points at the
  // now-deleted worldcup.png background). Reset them to the default theme so no
  // stale event styling or broken background image lingers.
  const isRetiredWcTheme =
    saved &&
    ((saved.name && /world\s*cup/i.test(saved.name)) ||
      (saved.content && /world cup 2026/i.test(saved.content)));
  if (isRetiredWcTheme) {
    try {
      const db = await dbPromise;
      await db.delete("settings", "currentTheme");
    } catch (_) {}
  } else if (
    saved &&
    saved.content &&
    // A custom token theme from the visual editor takes precedence over the
    // old full-CSS gallery themes (their literal colors would fight it).
    !localStorage.getItem("talkomaticThemeTokens") &&
    !localStorage.getItem("talkomaticThemeV2")
  ) {
    const styleEl = document.createElement("style");
    (document.head || document.getElementsByTagName("head")[0]).appendChild(
      styleEl,
    );
    if (styleEl.styleSheet) {
      styleEl.styleSheet.cssText = saved.content;
    } else {
      styleEl.appendChild(document.createTextNode(saved.content));
    }
  }
});

// Run initial setup
init();
