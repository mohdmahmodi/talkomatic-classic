const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const FILE = path.join(DATA_DIR, "season.json");
const THEMES = ["halloween"];
const DEFAULT = "halloween";

let theme = DEFAULT;

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, "utf8"));
    theme = o && THEMES.includes(o.theme) ? o.theme : "";
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading season.json:", err);
    theme = DEFAULT;
  }
}

function get() {
  return theme;
}

async function set(next) {
  theme = THEMES.includes(next) ? next : "";
  const tmp = FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify({ theme }), "utf8");
  await fsp.rename(tmp, FILE);
  return theme;
}

load();

module.exports = { THEMES, get, set };
