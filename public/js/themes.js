// Themes.js - Polished version with uploaded theme saving

// DOM Elements
const curatedContent = document.getElementById("curatedContent");
const importContent = document.getElementById("importContent");
const themeGrid = document.getElementById("themeGrid");

const curatedThemesButton = document.getElementById("curatedThemesButton");
const importThemeButton = document.getElementById("importThemeButton");

const quickImportInput = document.getElementById("quickImportInput");
const quickApplyButton = document.getElementById("quickApplyButton");
const importThemeInput = document.getElementById("importThemeInput");
const themeNameInput = document.getElementById("themeNameInput");
const importApplyButton = document.getElementById("importApplyButton");
const importThumbnailInput = document.getElementById("importThumbnailInput");
const thumbnailPreview = document.getElementById("thumbnailPreview");
const removeThumbnail = document.getElementById("removeThumbnail");

const themeModal = document.getElementById("themeModal");
const modalThemeNameInput = document.getElementById("modalThemeNameInput");
const modalCancelButton = document.getElementById("modalCancelButton");
const modalSaveButton = document.getElementById("modalSaveButton");

const searchInput = document.getElementById("searchTheme");

let quickThemeContent = "";
let importThemeContent = "";
let importThumbnailContent = "";
let pendingSaveData = null;

toastr.options = {
  closeButton: true,
  debug: false,
  newestOnTop: true,
  progressBar: true,
  positionClass: "toast-bottom-right",
  preventDuplicates: true,
  showDuration: "300",
  hideDuration: "1000",
  timeOut: "2500",
  extendedTimeOut: "1000",
  showEasing: "swing",
  hideEasing: "linear",
  showMethod: "fadeIn",
  hideMethod: "fadeOut",
};

// =================================================================
// =================================================================

let dbPromise;
async function initDB() {
  dbPromise = idb.openDB('talkomatic-themes', 2, {
    upgrade(db, oldVersion, newVersion, transaction) {
      if (oldVersion < 1) {
        const store = db.createObjectStore('themes', { keyPath: 'id' });
        store.createIndex('by-date', 'dateAdded');
      }
      if (oldVersion < 2) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    }
  });
}

async function getUploadedThemes() {
  const db = await dbPromise;
  return (await db.getAllFromIndex('themes', 'by-date'))
    .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
}

async function addUploadedTheme(name, content, thumbnail = "") {
  const db = await dbPromise;
  const theme = {
    id: Date.now(),
    name,
    content,
    thumbnail,
    dateAdded: new Date().toISOString()
  };
  await db.put('themes', theme);
  return theme;
}

async function deleteUploadedTheme(id) {
  const db = await dbPromise;
  await db.delete('themes', id);
}


async function setCurrentTheme(name, content) {
  const db = await dbPromise;
  if (!db.objectStoreNames.contains('settings')) {
    console.error('Settings store missing! DB schema didn’t upgrade.');
    return;
  }
  await db.put('settings', {
    key: 'currentTheme',
    name,
    content,
    dateSaved: new Date().toISOString()
  });
}

async function getCurrentTheme() {
  const db = await dbPromise;
  return await db.get('settings', 'currentTheme');
}

// =================================================================
// =================================================================

function createThemeCard(theme) {
  const card = document.createElement("div");
  card.className = "theme-card";

  if (theme.type === "uploaded") {
    card.dataset.uploadedId = theme.id;
    card.innerHTML = `
      <div class="theme-badge uploaded">
        <i class="fas fa-upload"></i> Uploaded
      </div>
      ${theme.thumbnail
        ? `<img src="${theme.thumbnail}" alt="${theme.name}" class="theme-thumbnail"/>`
        : `<div class="imported-thumbnail">IMPORTED</div>`
      }
      <div class="theme-name">${theme.name}</div>
      <div class="theme-author">You</div>
    `;
  } else {
    card.dataset.file = theme.file || "";
    card.innerHTML = `
      <div class="theme-badge ${theme.badge === "official" ? "official" : "user-made"}">
        <i class="fas fa-${theme.badge === "official" ? "star" : "users"}"></i>
        ${theme.badge === "official" ? "Official" : "User-made"}
      </div>
      <img src="${theme.thumbnail}" alt="${theme.name}" class="theme-thumbnail">
      <div class="theme-name">${theme.name}</div>
      <div class="theme-author">${theme.author}</div>
    `;
  }

  return card;
}

async function renderThemes() {
  const curatedCards = themeGrid.querySelectorAll(
    ".theme-card:not([data-uploaded-id])"
  );
  themeGrid.innerHTML = "";

  curatedCards.forEach((card) => themeGrid.appendChild(card));

  const uploadedThemes = await getUploadedThemes();
  uploadedThemes.forEach((t) => {
    const card = createThemeCard({ type: 'uploaded', ...t });
    themeGrid.appendChild(card);
  });
}

// =================================================================
// =================================================================

function showCuratedThemes() {
  curatedContent.style.display = "block";
  importContent.style.display = "none";

  curatedThemesButton.classList.add("active");
  importThemeButton.classList.remove("active");
}

function showImportThemes() {
  curatedContent.style.display = "none";
  importContent.style.display = "block";

  curatedThemesButton.classList.remove("active");
  importThemeButton.classList.add("active");
}

// =================================================================
// =================================================================

async function applyTheme(themeContent, themeName = "theme") {
  try {
    await setCurrentTheme(themeName, themeContent);
    toastr.success(
      `${themeName} applied! Return to lobby to see changes.`,
      "Theme Applied"
    );
  } catch (error) {
    console.error("Error applying theme to IndexedDB:", error);
    toastr.error("Failed to apply theme. Please try again.", "Error");
  }
}

async function applyCuratedTheme(filename, themeName, cardElement) {
  try {
    cardElement.style.opacity = "0.7";

    if (filename === "") {
      await applyTheme("", "Default Theme");
    } else {
      const response = await fetch(`themes/${filename}`);

      if (!response.ok) {
        throw new Error(`Failed to load theme: ${response.statusText}`);
      }

      const themeContent = await response.text();
      await applyTheme(themeContent, themeName);
    }

    cardElement.animate(
      [
        {
          transform: "scale(1)",
          backgroundColor: "var(--card-background-color)",
        },
        { transform: "scale(1.02)", backgroundColor: "rgba(76, 175, 80, 0.2)" },
        {
          transform: "scale(1)",
          backgroundColor: "var(--card-background-color)",
        },
      ],
      {
        duration: 500,
        easing: "ease-out",
      }
    );
  } catch (error) {
    console.error("Error applying curated theme:", error);
    toastr.error(`Failed to load ${themeName}`, "Error");
  } finally {
    cardElement.style.opacity = "1";
  }
}

async function applyUploadedTheme(themeId, cardElement) {
  const themes = await getUploadedThemes();
  const theme = themes.find((t) => t.id === themeId);

  if (theme) {
    cardElement.style.opacity = "0.7";
    await applyTheme(theme.content, theme.name);

    cardElement.animate(
      [
        {
          transform: "scale(1)",
          backgroundColor: "var(--card-background-color)",
        },
        { transform: "scale(1.02)", backgroundColor: "rgba(76, 175, 80, 0.2)" },
        {
          transform: "scale(1)",
          backgroundColor: "var(--card-background-color)",
        },
      ],
      {
        duration: 500,
        easing: "ease-out",
      }
    );

    setTimeout(() => (cardElement.style.opacity = "1"), 500);
  }
}

function readFileContent(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("No file selected"));
      return;
    }

    if (!file.name.toLowerCase().endsWith(".css")) {
      reject(new Error("Please select a valid CSS file"));
      return;
    }

    if (file.size > 1024 * 1024) {
      reject(new Error("File too large (max 1MB)"));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

// =================================================================
// =================================================================

function showThemeModal(themeContent, defaultName = "") {
  pendingSaveData = { content: themeContent };
  modalThemeNameInput.value = defaultName;
  themeModal.classList.add("show");
  modalThemeNameInput.focus();
}

function hideThemeModal() {
  themeModal.classList.remove("show");
  pendingSaveData = null;
  modalThemeNameInput.value = "";
}

async function saveThemeFromModal() {
  const themeName = modalThemeNameInput.value.trim();

  if (!themeName) {
    toastr.warning("Please enter a theme name", "Name Required");
    modalThemeNameInput.focus();
    return;
  }

  if (pendingSaveData) {
    const newTheme = addUploadedTheme(themeName, pendingSaveData.content);
    renderThemes();
    await applyTheme(pendingSaveData.content, themeName);
    hideThemeModal();

    toastr.success(`Theme "${themeName}" saved and applied!`, "Success");
  }
}

// =================================================================
// =================================================================

curatedThemesButton.addEventListener("click", showCuratedThemes);
importThemeButton.addEventListener("click", showImportThemes);

quickImportInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];

  try {
    quickThemeContent = await readFileContent(file);
    quickApplyButton.disabled = false;
    quickApplyButton.innerHTML = `<i class="fas fa-palette"></i> Apply "${file.name}"`;
    toastr.info(`File "${file.name}" ready`, "File Loaded");
  } catch (error) {
    quickThemeContent = "";
    quickApplyButton.disabled = true;
    quickApplyButton.innerHTML = '<i class="fas fa-palette"></i> Apply Theme';
    toastr.error(error.message, "File Error");
  }
});

quickApplyButton.addEventListener("click", () => {
  if (quickThemeContent) {
    const fileName =
      quickImportInput.files[0]?.name.replace(".css", "") || "Quick Theme";
    showThemeModal(quickThemeContent, fileName);

    quickImportInput.value = "";
    quickThemeContent = "";
    quickApplyButton.disabled = true;
    quickApplyButton.innerHTML = '<i class="fas fa-palette"></i> Apply Theme';
  }
});

importThemeInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];

  try {
    importThemeContent = await readFileContent(file);
    if (!themeNameInput.value) {
      themeNameInput.value = file.name.replace(".css", "");
    }
    updateImportButton();
    toastr.info(`File "${file.name}" loaded`, "Ready to Save");
  } catch (error) {
    importThemeContent = "";
    updateImportButton();
    toastr.error(error.message, "File Error");
  }
});

importThumbnailInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importThumbnailContent = reader.result;
    thumbnailPreview.src = reader.result;
    thumbnailPreview.style.display = 'block';
    removeThumbnail.style.display = 'inline-block';

    updateImportButton();
  };
  reader.readAsDataURL(file);
});

removeThumbnail.addEventListener('click', (e) => {
  e.preventDefault();

  importThumbnailInput.value = '';
  importThumbnailContent = '';
  thumbnailPreview.src = '';
  thumbnailPreview.style.display = 'none';
  removeThumbnail.style.display = 'none';

  updateImportButton();
  toastr.info('Thumbnail removed', 'Removed');
});

themeNameInput.addEventListener("input", updateImportButton);

function updateImportButton() {
  const hasCSS = !!importThemeContent;
  const hasName = !!themeNameInput.value.trim();
  importApplyButton.disabled = !(hasCSS && hasName);
}

importApplyButton.addEventListener("click", () => {
  const name = themeNameInput.value.trim();
  if (importThemeContent && name) {
    addUploadedTheme(name, importThemeContent, importThumbnailContent).then(() => {
      renderThemes();
      applyTheme(importThemeContent, name);

      importThemeInput.value = '';
      importThumbnailInput.value = '';
      themeNameInput.value = '';
      thumbnailPreview.style.display = 'none';
      importThemeContent = importThumbnailContent = '';
      updateImportButton();
      toastr.success(`Theme "${name}" saved and applied!`, "Success");
    });
  }
});

modalCancelButton.addEventListener("click", hideThemeModal);
modalSaveButton.addEventListener("click", saveThemeFromModal);

modalThemeNameInput.addEventListener("keypress", (event) => {
  if (event.key === "Enter") {
    saveThemeFromModal();
  } else if (event.key === "Escape") {
    hideThemeModal();
  }
});

themeModal.addEventListener("click", (event) => {
  if (event.target === themeModal) {
    hideThemeModal();
  }
});

searchInput.addEventListener("input", (event) => {
  const searchTerm = event.target.value.toLowerCase().trim();
  const themeCards = document.querySelectorAll(".theme-card");
  let visibleCount = 0;

  themeCards.forEach((card) => {
    const themeName =
      card.querySelector(".theme-name")?.textContent?.toLowerCase() || "";
    const themeAuthor =
      card.querySelector(".theme-author")?.textContent?.toLowerCase() || "";

    if (themeName.includes(searchTerm) || themeAuthor.includes(searchTerm)) {
      card.style.display = "block";
      visibleCount++;
    } else {
      card.style.display = "none";
    }
  });

  if (searchTerm && visibleCount === 0) {
    toastr.warning(`No themes found for "${event.target.value}"`, "No Results");
  }
});

document.addEventListener("click", (event) => {
  const themeCard = event.target.closest(".theme-card");

  if (themeCard && curatedContent.style.display !== "none") {
    if (themeCard.dataset.uploadedId) {
      const themeId = parseInt(themeCard.dataset.uploadedId);
      applyUploadedTheme(themeId, themeCard);
    }
    else if (themeCard.dataset.file !== undefined) {
      const filename = themeCard.dataset.file;
      const themeName =
        themeCard.querySelector(".theme-name")?.textContent || "Theme";
      applyCuratedTheme(filename, themeName, themeCard);
    }
  }
});

document.addEventListener("contextmenu", (event) => {
  const themeCard = event.target.closest(".theme-card");

  if (themeCard && themeCard.dataset.uploadedId) {
    event.preventDefault();

    const themeName =
      themeCard.querySelector(".theme-name")?.textContent || "this theme";
    if (confirm(`Delete "${themeName}"?`)) {
      const themeId = parseInt(themeCard.dataset.uploadedId);
      deleteUploadedTheme(themeId);
      renderThemes();
      toastr.info(`Theme "${themeName}" deleted`, "Deleted");
    }
  }
});

// =================================================================
// =================================================================

document.addEventListener("DOMContentLoaded", () => {
  initDB().then(() => {
    showCuratedThemes();
    renderThemes();
    updateImportButton();
  });

  setTimeout(() => {
    toastr.info(
      "Choose a theme to customize your Talkomatic experience!",
      "Welcome"
    );
  }, 500);

  console.log("Talkomatic Themes initialized");
});