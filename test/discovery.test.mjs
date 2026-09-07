/**
 * CLI discovery.
 *
 * The failure this guards against is environmental, not logical: the bridge is
 * started by a host whose PATH is not the shell's, so a CLI that works in a
 * terminal is invisible to the process that has to launch it. These tests run
 * the real server with a stripped PATH and a sandboxed HOME, which is the same
 * shape as a desktop app launched from a dock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { client, sandbox, writeStub, SERVER } from "./helpers.mjs";

const IS_WINDOWS = process.platform === "win32";

/**
 * A PATH carrying Node and nothing else.
 *
 * These tests are about what happens when the CLIs are NOT on PATH, and the
 * machine running them usually has at least one that is: this repository's own
 * CI has a real `claude` sitting in the same directory as `node`. Putting the
 * whole Node prefix on PATH would quietly turn every assertion into a test of
 * the runner's install. So PATH gets a directory containing one shim that
 * forwards to this Node, which the stubs need, and nothing else.
 */
function strippedPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-nopath-"));
  if (IS_WINDOWS) {
    fs.writeFileSync(path.join(dir, "node.cmd"), `@echo off\r\n"${process.execPath}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    fs.chmodSync(path.join(dir, "node"), 0o755);
  }
  return dir;
}

/** Run the server's own detection and read back what it found. */
function detect(env) {
  const result = spawnSync(process.execPath, [SERVER, "--detect"], {
    encoding: "utf8",
    timeout: 120_000,
    // A PATH with no codex and no claude on it, so only discovery can find them.
    env: { ...process.env, PATH: strippedPath(), Path: strippedPath(), ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const home = (extra = {}) => {
  const dir = sandbox();
  return { dir, env: { HOME: dir, USERPROFILE: dir, ...extra } };
};

test("a CLI that is not on PATH is found in a standard install location", () => {
  const { dir, env } = home();
  // ~/.codex/bin and ~/.claude/local are two of the places these actually land.
  writeStub(path.join(dir, ".codex", "bin"), "codex", { stdout: "codex-cli 9.9.9" });
  writeStub(path.join(dir, ".claude", "local"), "claude", { stdout: "9.9.9 (Claude Code)" });

  const report = detect(env);
  assert.equal(report.agents.codex.found, true);
  assert.equal(report.agents.claude.found, true);
  assert.match(report.agents.codex.path, /[\\/]\.codex[\\/]bin[\\/]codex/);
  assert.match(report.agents.claude.path, /[\\/]\.claude[\\/]local[\\/]claude/);
  // Verified by running it, not by trusting the path.
  assert.match(report.agents.codex.version, /9\.9\.9/);
});

test("a candidate that does not run is not reported as installed", () => {
  const { dir, env } = home();
  const bin = path.join(dir, ".codex", "bin");
  writeStub(bin, "codex", { exit: 1, stderr: "boom" });

  const report = detect(env);
  assert.equal(report.agents.codex.found, false);
  assert.equal(report.agents.codex.path, "");
  assert.ok(report.agents.codex.searched > 1, "should report how many places it looked");
});

test("a CLI bundled inside a desktop app is found and used", () => {
  const { dir, env } = home();
  const apps = path.join(dir, "apps");
  const bundle = process.platform === "darwin" ? "ChatGPT.app" : "ChatGPT";
  writeStub(path.join(apps, bundle, "Contents", "Resources", "bin"), "codex", { stdout: "codex-cli 1.0.0" });

  const report = detect({ ...env, AGENT_BRIDGE_APP_SEARCH_PATH: apps });
  assert.equal(report.agents.codex.found, true);
  assert.equal(report.agents.codex.source, "ChatGPT app");
  assert.deepEqual(
    report.agents.codex.apps.map((app) => app.name),
    ["ChatGPT"]
  );
});

test("an installed desktop app with no CLI is reported as present, not as the CLI", () => {
  const { dir, env } = home();
  const apps = path.join(dir, "apps");
  const bundle = process.platform === "darwin" ? "ChatGPT.app" : "ChatGPT";
  fs.mkdirSync(path.join(apps, bundle), { recursive: true });

  const report = detect({ ...env, AGENT_BRIDGE_APP_SEARCH_PATH: apps });
  assert.equal(report.agents.codex.found, false);
  assert.deepEqual(
    report.agents.codex.apps.map((app) => app.name),
    ["ChatGPT"],
    "the app is detected even though it provides nothing to launch"
  );
});

test("an explicit setting is used as given and never silently replaced", () => {
  const { dir, env } = home();
  // A working install exists, and must NOT be substituted for the bad setting:
  // a stale path has to fail loudly or it outlives the session.
  writeStub(path.join(dir, ".codex", "bin"), "codex", { stdout: "codex-cli 9.9.9" });

  const report = detect({ ...env, AGENT_BRIDGE_CODEX_BIN: "codex-does-not-exist-anywhere" });
  assert.equal(report.agents.codex.path, "codex-does-not-exist-anywhere");
  assert.equal(report.agents.codex.source, "configured");
});

test("a discovered path is remembered, so the next session probes nothing", async () => {
  const { dir, env } = home();
  const bin = path.join(dir, ".codex", "bin");
  writeStub(bin, "codex", { stdout: "codex-cli 9.9.9" });

  const first = detect(env);
  assert.equal(first.agents.codex.found, true);

  const cache = JSON.parse(fs.readFileSync(path.join(dir, ".agent-bridge", "discovered.json"), "utf8"));
  assert.equal(cache.codex.path, first.agents.codex.path);
  assert.match(cache.codex.version, /9\.9\.9/);

  // Prove the next session reads that file rather than searching again: move
  // the stub somewhere no search list would ever look, point the remembered
  // entry at it, and see whether a call still reaches it.
  const hidden = path.join(dir, "nowhere-in-any-search-list");
  writeStub(hidden, "codex", { stdout: "answer from the remembered path" });
  fs.writeFileSync(
    path.join(dir, ".agent-bridge", "discovered.json"),
    JSON.stringify({ codex: { path: path.join(hidden, IS_WINDOWS ? "codex.cmd" : "codex"), source: "PATH", version: "" } })
  );

  const c = client({ ...env, PATH: strippedPath(), Path: strippedPath() });
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.ok(!res.result.isError, c.text(res));
  assert.match(c.text(res), /answer from the remembered path/);
  c.close();
});

test("the remembered path is dropped once the binary is gone", async () => {
  const { dir, env } = home();
  const bin = path.join(dir, ".codex", "bin");
  writeStub(bin, "codex", { stdout: "codex-cli 9.9.9" });
  detect(env);

  fs.rmSync(bin, { recursive: true, force: true });
  const report = detect(env);
  assert.equal(report.agents.codex.found, false, "a remembered path that no longer exists is re-searched");
});

test("a delegation runs the auto-detected CLI without any path being configured", async () => {
  const { dir, env } = home();
  writeStub(path.join(dir, ".codex", "bin"), "codex", { stdout: "detected answer" });

  // No AGENT_BRIDGE_CODEX_BIN, and a PATH with no codex on it.
  const c = client({ ...env, PATH: strippedPath(), Path: strippedPath() });
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.ok(!res.result.isError, c.text(res));
  assert.match(c.text(res), /detected answer/);
  c.close();
});

test("a missing peer names the desktop app rather than leaving the caller to guess", async () => {
  const { dir, env } = home();
  const apps = path.join(dir, "apps");
  const bundle = process.platform === "darwin" ? "ChatGPT.app" : "ChatGPT";
  fs.mkdirSync(path.join(apps, bundle), { recursive: true });

  const c = client({
    ...env,
    PATH: strippedPath(),
    Path: strippedPath(),
    AGENT_BRIDGE_APP_SEARCH_PATH: apps,
  });
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.equal(res.result.isError, true);
  const text = c.text(res);
  assert.match(text, /was not found on PATH or in \d+ standard install locations/);
  assert.match(text, /ChatGPT desktop app is installed/);
  assert.match(text, /npm install -g @openai\/codex/);
  c.close();
});

test("an extra search directory can be supplied without pinning an exact binary", () => {
  const { dir, env } = home();
  const extra = path.join(dir, "elsewhere", "bin");
  writeStub(extra, "codex", { stdout: "codex-cli 9.9.9" });

  const report = detect({ ...env, AGENT_BRIDGE_CLI_SEARCH_PATH: extra });
  assert.equal(report.agents.codex.found, true);
  assert.equal(report.agents.codex.source, extra);
});

test("Windows launches an .exe directly and only shells out for .cmd shims", { skip: !IS_WINDOWS }, () => {
  // The metacharacter refusal exists for cmd.exe. A path under "Program Files
  // (x86)" is unlaunchable through the shell and perfectly fine without it,
  // which is why .exe skips the shell entirely.
  const { dir, env } = home();
  const awkward = path.join(dir, "Programs (x86)", "codex");
  fs.mkdirSync(awkward, { recursive: true });
  const stub = writeStub(awkward, "codex", { stdout: "codex-cli 9.9.9" });
  assert.ok(stub.endsWith(".cmd"));

  // The shim is right there and still cannot be launched. Detection has to say
  // that, not "not found", or the user goes hunting for a file in plain sight.
  const report = detect({ ...env, AGENT_BRIDGE_CLI_SEARCH_PATH: awkward });
  assert.equal(report.agents.codex.found, false);
  assert.equal(report.agents.codex.blocked.length, 1);
  assert.match(report.agents.codex.blocked[0], /codex\.cmd$/);
});

test("an auto-detected Codex still reports usage on the very first reply", async () => {
  // The startup warm-up deliberately does not probe for a CLI, so on a first-ever
  // session the Codex path is unknown when usage is first wanted. Resolving it
  // during the call has to re-ask, or the first reply of every new install
  // silently loses its usage figure.
  const dir = sandbox();
  const binDir = path.join(dir, ".codex", "bin");
  writeStub(binDir, "codex");
  fs.writeFileSync(
    path.join(binDir, "codex.stub.mjs"),
    `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (process.argv.includes("app-server")) {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === 1) send({ jsonrpc: "2.0", id: 1, result: {} });
    if (msg.id === 2) send({ jsonrpc: "2.0", id: 2, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } } });
  });
} else if (process.argv.includes("--version")) {
  console.log("codex-cli 9.9.9");
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    send({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
    send({ type: "item.completed", item: { type: "agent_message", text: "ok" } });
    send({ type: "turn.completed", usage: {} });
  });
}
`
  );

  // No AGENT_BRIDGE_CODEX_BIN, no remembered location, nothing on PATH.
  const c = client({ HOME: dir, USERPROFILE: dir, PATH: strippedPath(), Path: strippedPath() });
  await c.init();
  const text = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(text, /Codex 5h 75% left/);
  c.close();
});
