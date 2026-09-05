/**
 * Test helpers.
 *
 * The tests drive the real server over real stdio, because the interesting
 * failures live in the transport and the process handling, not in pure
 * functions. A unit test of the argument builder would have missed every bug
 * found while building this: the failure-counter key mismatch, the truncated
 * reply on shutdown, the orphaned child process.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = path.join(ROOT, "src", "agent-bridge.mjs");
const IS_WINDOWS = process.platform === "win32";

/** A throwaway HOME so tests never read or write the real ~/.agent-bridge. */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-test-"));
  fs.mkdirSync(path.join(dir, ".agent-bridge"), { recursive: true });
  return dir;
}

/**
 * Write a stub that stands in for `codex` or `claude`.
 *
 * Two files, because the server spawns through cmd.exe on Windows and directly
 * on POSIX. Writing both and returning the extensionless path lets the same test
 * run on either.
 */
export function writeStub(dir, name, { stdout = "", stderr = "", exit = 0, sleepMs = 0, echoArgs = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, `${name}.stub.mjs`);
  fs.writeFileSync(
    js,
    `const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", run);
setTimeout(run, 500); // in case nothing is piped
let done = false;
function run() {
  if (done) return;
  done = true;
  const prompt = Buffer.concat(chunks).toString();
  setTimeout(() => {
    if (${echoArgs}) console.log("ARGS: " + process.argv.slice(2).join(" "));
    if (${JSON.stringify(stdout)}) console.log(${JSON.stringify(stdout)});
    if (${echoArgs}) console.log("PROMPT: " + prompt.split("\\n").filter(Boolean).slice(-1)[0]);
    if (${JSON.stringify(stderr)}) console.error(${JSON.stringify(stderr)});
    process.exit(${exit});
  }, ${sleepMs});
}
`
  );

  const posix = path.join(dir, name);
  fs.writeFileSync(posix, `#!/bin/sh\nexec node "${js}" "$@"\n`);
  fs.chmodSync(posix, 0o755);
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nnode "${js}" %*\r\n`);
  return IS_WINDOWS ? path.join(dir, `${name}.cmd`) : posix;
}

/** Start the server and speak JSON-RPC to it, one request at a time. */
export function client(env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let stderr = "";
  const pending = new Map();
  const notifications = [];

  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) notifications.push(msg.method);
    }
  });
  proc.stderr.on("data", (d) => (stderr += d));

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20000);
      pending.set(myId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });

  return {
    proc,
    notifications,
    stderr: () => stderr,
    send,
    async init() {
      return send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
    },
    async call(name, args) {
      const res = await send("tools/call", { name, arguments: args });
      return res;
    },
    text(res) {
      return res.result?.content?.[0]?.text ?? "";
    },
    close() {
      proc.kill();
    },
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
