// server/dataexport.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { DATA_DIR } = require("./datadir");
const buffertrail = require("./buffertrail");

const WITHHELD = new Set([
  "mod-keys.json",
  "device-secret.json",
  "package.json",
  "package-lock.json",
]);
const STORE = /\.(json|jsonl|txt)$/i;
const KEY_HASH = /\b[0-9a-f]{64}\b/gi;

let table = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const body = [];
  const index = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const packed = zlib.deflateRawSync(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc32(f.data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    body.push(head, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    head.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    index.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const dir = Buffer.concat(index);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, dir, end]);
}

function flushStores() {
  for (const [file, mod] of Object.entries(require.cache)) {
    if (path.dirname(file) !== __dirname) continue;
    const flush = mod && mod.exports && mod.exports.flushSync;
    if (typeof flush !== "function") continue;
    try {
      flush();
    } catch (_) {}
  }
}

function build() {
  flushStores();
  const files = [];
  const listing = [];
  for (const name of fs.readdirSync(DATA_DIR).sort()) {
    if (!STORE.test(name) || WITHHELD.has(name)) continue;
    const full = path.join(DATA_DIR, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const data = Buffer.from(
        fs.readFileSync(full, "utf8").replace(KEY_HASH, (h) => "keyhash-" + h.slice(0, 8)),
      );
      files.push({ name: "data/" + name, data });
      listing.push(name.padEnd(28) + data.length + " bytes");
    } catch (_) {}
  }
  const live = Buffer.from(JSON.stringify(buffertrail.snapshot(), null, 2));
  files.push({ name: "live/buffer-trail.json", data: live });
  listing.push("live/buffer-trail.json".padEnd(28) + live.length + " bytes");

  const stamp = new Date().toISOString();
  files.unshift({
    name: "README.txt",
    data: Buffer.from(
      [
        "Talkomatic data export, " + stamp,
        "",
        "data/  every store in the data folder, as it is on disk.",
        "live/  what was only in memory when this was made.",
        "Left out: the staff key file and the device signing secret.",
        "Staff key hashes inside other files are cut to their first 8 characters.",
        "",
        ...listing,
        "",
      ].join("\n"),
    ),
  });
  return {
    name: "talkomatic-export-" + stamp.slice(0, 19).replace(/[:T]/g, "-") + ".zip",
    zip: zip(files),
    files: files.length,
  };
}

module.exports = { build };
