#!/usr/bin/env node
/**
 * Build both installable bundles from one source file.
 *
 * The server in src/ is the only copy that is edited. Each package gets it
 * copied in at build time, and those copies are gitignored. Before this script
 * existed the file lived in three places and drifted, which is exactly the class
 * of bug that is invisible until someone installs the wrong one.
 *
 *   node scripts/build.mjs          build both into dist/
 *   node scripts/build.mjs mcpb     just the Claude Desktop bundle
 *   node scripts/build.mjs vsix     just the VS Code extension
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SERVER = path.join(ROOT, "src", "agent-bridge.mjs");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

const log = (msg) => console.log(`  ${msg}`);

/**
 * Keep every version number in step with package.json. Three manifests with
 * three hand-maintained versions is three chances to ship a bundle that reports
 * the wrong one, and the reported version is what you check first when a user
 * says it is behaving oddly.
 */
function syncVersions() {
  for (const rel of ["packages/mcpb/manifest.json", "packages/vscode/package.json"]) {
    const file = path.join(ROOT, rel);
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    if (json.version !== VERSION) {
      json.version = VERSION;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
      log(`synced ${rel} to ${VERSION}`);
    }
  }
  // The server reports its own version over the protocol, so it has to match too.
  const src = fs.readFileSync(SERVER, "utf8");
  const patched = src.replace(/const SERVER_VERSION = "\d+\.\d+\.\d+";/, `const SERVER_VERSION = "${VERSION}";`);
  if (patched !== src) {
    fs.writeFileSync(SERVER, patched);
    log(`synced src/agent-bridge.mjs to ${VERSION}`);
  }
}

function stageServer(packageDir) {
  const dir = path.join(packageDir, "server");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SERVER, path.join(dir, "agent-bridge.mjs"));
}

// ---------------------------------------------------------------------------
// Minimal zip writer
//
// A .mcpb is just a zip. Writing ~60 lines here avoids a dependency that would
// otherwise exist only to compress two files, and keeps `npm run build` working
// on a clean checkout with no install step.
// ---------------------------------------------------------------------------

function zip(entries, outFile) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const dosTime = () => {
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  };

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const { time, date } = dosTime();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
  return outFile;
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------

function buildMcpb() {
  const dir = path.join(ROOT, "packages", "mcpb");
  stageServer(dir);
  const out = path.join(DIST, `agent-bridge-${VERSION}.mcpb`);
  zip(
    [
      { name: "manifest.json", data: fs.readFileSync(path.join(dir, "manifest.json")) },
      { name: "server/agent-bridge.mjs", data: fs.readFileSync(SERVER) },
    ],
    out
  );
  log(`built ${path.relative(ROOT, out)}`);
}

function buildVsix() {
  const dir = path.join(ROOT, "packages", "vscode");
  stageServer(dir);
  // vsce is the only real dependency, and only for this half of the build. It
  // writes the vsixmanifest and content-types that VS Code requires; hand-rolling
  // those is a worse trade than one devDependency.
  execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--allow-missing-repository", "--skip-license", "--out", path.join(DIST, `agent-bridge-${VERSION}.vsix`)], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  log(`built dist/agent-bridge-${VERSION}.vsix`);
}

const what = process.argv[2];
console.log(`agent-bridge ${VERSION}`);
syncVersions();
if (!what || what === "mcpb") buildMcpb();
if (!what || what === "vsix") buildVsix();
