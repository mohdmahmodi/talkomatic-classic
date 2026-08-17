// Talkomatic Lobby Menu Functionality
// ----------------------------------------------------------------------------
// This JavaScript file handles the functionality for the left-side panel
// (menu) in the Talkomatic lobby page.

const leftPanel = document.getElementById("leftPanel");
const toggleButton = document.getElementById("toggleButton");
const hideMenuButton = document.getElementById("hideMenuButton");

const roomInfoModal = document.getElementById("roomInfoModal");
const learnMoreBtn = document.querySelector(".learn-more");
const closeRoomInfoBtn = document.querySelector(".close-modal");

function toggleLeftPanel() {
  leftPanel.classList.toggle("open");
  toggleButton.style.opacity = leftPanel.classList.contains("open") ? "0" : "1";
}

function hideLeftPanel() {
  leftPanel.classList.remove("open");
  setTimeout(() => {
    toggleButton.style.opacity = "1";
  }, 300);
}

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

function handleOutsideClick(event) {
  const isClickInside =
    leftPanel.contains(event.target) || toggleButton.contains(event.target);
  if (!isClickInside && leftPanel.classList.contains("open")) {
    hideLeftPanel();
  }
}

document.addEventListener("click", handleOutsideClick);
window.addEventListener("resize", handleResize);
hideMenuButton.addEventListener("click", hideLeftPanel);
toggleButton.addEventListener("click", toggleLeftPanel);

function init() {
  if (window.innerWidth <= 992) {
    toggleButton.style.opacity = "1";
  }
}

function openRoomInfoModal() {
  roomInfoModal.style.display = "flex";
  roomInfoModal.offsetHeight;
  roomInfoModal.classList.add("show");
}

function closeRoomInfoModal() {
  roomInfoModal.classList.remove("show");
  setTimeout(() => {
    roomInfoModal.style.display = "none";
  }, 300);
}

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

let dbPromise;
async function initDB() {
  dbPromise = idb.openDB("talkomatic-themes", 2, {
    upgrade(db, oldVersion, newVersion, transaction) {
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

document.addEventListener("DOMContentLoaded", async () => {
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

  await initDB();
  const saved = await getCurrentTheme();
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

init();
