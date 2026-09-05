#!/usr/bin/env node
/**
 * Budget: measure what this pack actually costs and saves.
 *
 * The claim behind Agent Bridge is that a session lasts longer because the work
 * happens in Codex's context window instead of the caller's. That claim is worth
 * a number rather than an assertion, so this runs a realistic session against
 * stub CLIs and reports exactly how many bytes come back.
 *
 *   npm run budget
 *   npm run budget -- --files 8 --lines 220
 *
 * What is measured: the bytes this server returns, which is what lands in the
 * caller's context and is re-sent on every later turn.
 *
 * What is estimated: what the same work would have cost inline. That depends on
 * your repository, so it is computed from two numbers you can set, and both are
 * printed. Nothing here is a benchmark of Codex or Claude.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "agent-bridge.mjs");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};

// Assumptions, both adjustable, both printed in the output.
const FILES_PER_TASK = arg("files", 6); // files Claude would read to do it inline
const LINES_PER_FILE = arg("lines", 180); // average length of one of them
const LINES_WRITTEN = arg("written", 120); // lines the change itself produces
// Delegating does not make reading free. Claude still opens enough of the code
// to decide the design, and it still writes the handoff. Both are counted
// against the delegated side, because a comparison that ignores them is
// marketing rather than measurement.
const DESIGN_FILES = arg("design-files", 2);
const BYTES_PER_LINE = 42; // measured average for real source, not a guess at tokens
const TOKENS_PER_BYTE = 1 / 4; // the usual rough conversion

const tokens = (bytes) => Math.round(bytes * TOKENS_PER_BYTE);

// --- a stub Codex that behaves like a normal, slightly chatty build ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-budget-"));
const bin = path.join(home, "bin");
const repo = path.join(home, "repo");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(repo, { recursive: true });

const stubJs = path.join(bin, "codex.stub.mjs");
fs.writeFileSync(
  stubJs,
  `import fs from "node:fs";
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(path.join(repo, "Generated.cs"))}, "x\\n".repeat(${LINES_WRITTEN}));
  // Codex prints a short final message; the narration goes to stderr.
  console.log("Implemented the requested change across 3 files and added tests.");
});
`
);
fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
fs.chmodSync(path.join(bin, "codex"), 0o755);
fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\nnode "${stubJs}" %*\r\n`);

const git = (...a) => spawn("git", a, { cwd: repo, stdio: "ignore" });
await new Promise((r) => git("init", "-q").on("close", r));

// --- speak MCP to the real server -------------------------------------------
const proc = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_BRIDGE_CODEX_BIN: path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex"),
    AGENT_BRIDGE_DEFAULT_CWD: repo,
  },
  stdio: ["pipe", "pipe", "ignore"],
});

let buffer = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let id = 0;
const send = (method, params) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });

const measured = [];
let specBytes = 0;
async function measure(label, name, args) {
  // The handoff Claude writes is a real cost on the delegated side.
  specBytes += JSON.stringify(args).length;
  const res = await send("tools/call", { name, arguments: args });
  const text = res.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(res.error);
  measured.push({ label, bytes: text.length });
  return text;
}

await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "budget", version: "1" } });

const list = await send("tools/list", {});
const definitionBytes = JSON.stringify(list.result.tools).length;

// A session shaped like the one the README recommends.
await measure("set_project_context (once per repo)", "set_project_context", {
  content: "Hexagonal architecture. Handlers stay thin. No new dependencies without discussion.",
  cwd: repo,
});
await measure("delegate #1 (with verify)", "delegate_to_codex", { task: "Add validation", cwd: repo, lane: "budget", verify: "node --version" });
await measure("delegate #2 (same lane)", "delegate_to_codex", { task: "Extend validation", cwd: repo, lane: "budget", verify: "node --version" });
await measure("start_codex_jobs (3 parallel)", "start_codex_jobs", {
  tasks: [
    { task: "a", files: "a.cs", cwd: repo },
    { task: "b", files: "b.cs", cwd: repo },
    { task: "c", files: "c.cs", cwd: repo },
  ],
});
await measure("collect_codex_jobs", "collect_codex_jobs", {});

proc.kill();

// --- report ------------------------------------------------------------------
const returned = measured.reduce((sum, m) => sum + m.bytes, 0);
const delegations = 5; // two direct plus three background builds

const inlinePerTask = (FILES_PER_TASK * LINES_PER_FILE + LINES_WRITTEN) * BYTES_PER_LINE;
const inlineTotal = inlinePerTask * delegations;

// Delegated side: reading enough to design, plus the handoff, plus what comes
// back, plus the definitions that sit in every session.
const designBytes = DESIGN_FILES * LINES_PER_FILE * BYTES_PER_LINE * delegations;
const delegatedTotal = designBytes + specBytes + returned + definitionBytes;

const pad = (n) => String(n).padStart(7);
console.log("\nMeasured: bytes this server returned into the caller's context\n");
for (const m of measured) console.log(`  ${pad(m.bytes)}  ${m.label}`);
console.log(`  ${pad(definitionBytes)}  tool definitions (once per session, re-sent every turn)`);
console.log(`  ${"-".repeat(7)}`);
console.log(`  ${pad(returned + definitionBytes)}  total  (~${tokens(returned + definitionBytes)} tokens)`);

console.log(`\nEstimated, using ${FILES_PER_TASK} files read per task at ${LINES_PER_FILE} lines, ${LINES_WRITTEN} lines written\n`);
console.log(`  ${pad(inlineTotal)}  doing all ${delegations} tasks inline           (~${tokens(inlineTotal)} tokens)`);
console.log(`  ${pad(delegatedTotal)}  delegating them                    (~${tokens(delegatedTotal)} tokens)`);
console.log(`             of which ${pad(designBytes)} is reading ${DESIGN_FILES} files per task to design`);
console.log(`                      ${pad(specBytes)} is the handoffs Claude wrote`);
console.log(`                      ${pad(returned)} is what came back`);
console.log(`                      ${pad(definitionBytes)} is the tool definitions`);

const saved = inlineTotal - delegatedTotal;
const ratio = inlineTotal / delegatedTotal;
if (saved > 0) {
  console.log(`\n  Difference: ~${tokens(saved)} tokens saved, ${ratio.toFixed(1)}x less context consumed.`);
  const perTaskSaving = (inlinePerTask * delegations - (designBytes + specBytes + returned)) / delegations;
  const breakEven = Math.max(1, Math.ceil(definitionBytes / perTaskSaving));
  console.log(`  Break-even: ${breakEven} delegation${breakEven === 1 ? "" : "s"} pays for the tool definitions.`);
} else {
  console.log(`\n  Delegating costs MORE here (${tokens(-saved)} tokens). At this task size, do the work inline.`);
}

console.log(`
What this does not capture, in both directions:
  - Codex's own quota is spent. This measures Claude's context, not total cost.
  - Claude may grep rather than read whole files, which narrows the gap.
  - A delegation you have to re-read in full, or redo, wipes out its saving.
  - Small tasks lose: the handoff costs about what the code would have.
    Try --files 1 --lines 40 --written 15 to see that happen.`);

console.log(`
Why this matters more than it looks: a coding agent re-sends the whole
transcript every turn, so context spent early is paid again on every later
turn. Bytes kept out of the transcript are saved repeatedly, not once.

Change the assumptions to match your repository:
  npm run budget -- --files ${FILES_PER_TASK} --lines ${LINES_PER_FILE} --design-files ${DESIGN_FILES}
`);

fs.rmSync(home, { recursive: true, force: true });
