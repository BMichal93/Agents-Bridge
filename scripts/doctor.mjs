#!/usr/bin/env node
/**
 * Check the bridge's assumptions against the installed Codex and Claude CLIs.
 * Help output is advisory: Claude documents that `claude --help` is incomplete.
 * With live probes enabled, the doctor invokes the exact read-only argument sets
 * used by the bridge and validates Codex JSONL rather than looking for a word in
 * arbitrary output.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";
const CODEX = process.env.AGENT_BRIDGE_CODEX_BIN || "codex";
const CLAUDE = process.env.AGENT_BRIDGE_CLAUDE_BIN || "claude";
const LIVE = !process.argv.includes("--no-live");

const results = [];
const pass = (name, detail = "") => results.push({ state: "pass", name, detail });
const fail = (name, detail = "") => results.push({ state: "FAIL", name, detail });
const skip = (name, detail = "") => results.push({ state: "skip", name, detail });

function run(bin, args, { input, timeout = 60_000, cwd } = {}) {
  if (IS_WINDOWS && [bin, ...args].some((value) => /[&|<>^%!()"\r\n]/.test(value))) {
    return { status: 1, stdout: "", stderr: "unsafe Windows command argument", out: "unsafe Windows command argument" };
  }
  const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : bin;
  const argv = IS_WINDOWS ? ["/d", "/s", "/c", bin, ...args] : args;
  const result = spawnSync(file, argv, { encoding: "utf8", input, timeout, cwd, maxBuffer: 1_000_000 });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status, stdout, stderr, out: `${stdout}${stderr}` };
}

const version = (bin) => {
  const result = run(bin, ["--version"], { timeout: 20_000 });
  return result.status === 0 ? result.out.trim().split("\n")[0] : null;
};

/** Match a flag as a whole help token, never as part of another flag. */
export function helpHas(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,\`'"([])${escaped}([\\s,=\\]).'"\`]|$)`, "m").test(help);
}

function helpAdvisory(label, help, flag) {
  if (helpHas(help, flag)) pass(label, "advertised by installed CLI");
  else skip(label, "not shown in help; the live exact-argument probe is authoritative");
}

function parseCodexJsonLines(output) {
  let threadId = "";
  let answer = "";
  let failed = false;
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") answer = event.item.text || "";
      if (event.type === "turn.failed" || event.type === "error") failed = true;
    } catch {}
  }
  return { threadId, answer, failed };
}

function probeAppServer() {
  return new Promise((resolve) => {
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : CODEX;
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", CODEX, "app-server"] : ["app-server"];
    let child;
    try {
      if (IS_WINDOWS && /[&|<>^%!()"\r\n]/.test(CODEX)) return resolve({ ok: false, detail: "unsafe Windows command argument" });
      child = spawn(file, argv, { stdio: ["pipe", "pipe", "ignore"], detached: !IS_WINDOWS });
    } catch (error) {
      return resolve({ ok: false, detail: error.message });
    }
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (IS_WINDOWS) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "timed out" }), 12_000);
    child.on("error", (error) => finish({ ok: false, detail: error.message }));
    child.on("close", () => finish({ ok: false, detail: "app-server closed before replying" }));
    child.stdin.on("error", () => finish({ ok: false, detail: "app-server closed its input" }));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 200_000) return finish({ ok: false, detail: "app-server output limit exceeded" });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n");
          }
          if (msg.id === 2 && msg.result) return finish({ ok: true, detail: "account/rateLimits/read answered" });
          if (msg.id === 2 && msg.error) {
            return finish({
              ok: msg.error.code !== -32601,
              detail: msg.error.code === -32601 ? "account/rateLimits/read is not supported" : "method exists but returned an account error",
            });
          }
        } catch {}
      }
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agent-bridge-doctor", version: "1" } } }) + "\n"
    );
  });
}

// Exercise ask_claude THROUGH the shipped MCP server. Duplicating its argv here
// missed 0.9.8's optional-flag fallback and produced a false-negative doctor.
function probeClaudeBridge(cwd) {
  return new Promise((resolve) => {
    const server = fileURLToPath(new URL("../src/agent-bridge.mjs", import.meta.url));
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, AGENT_BRIDGE_HTTP: "0", AGENT_BRIDGE_DEPTH: "0",
        AGENT_BRIDGE_CODEX_BIN: CODEX, AGENT_BRIDGE_CLAUDE_BIN: CLAUDE },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    let outcome = null;
    const finish = (value) => {
      if (outcome) return;
      outcome = value;
      clearTimeout(timer);
      // Let bridge shutdown kill its own process groups before doctor returns.
      child.kill();
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "bridge probe timed out" }), 250_000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, detail: error.message }); });
    child.on("close", () => { clearTimeout(timer); resolve(outcome || { ok: false, detail: "bridge closed before replying" }); });
    child.stdin.on("error", () => finish({ ok: false, detail: "bridge input closed" }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 100_000) return finish({ ok: false, detail: "bridge output limit exceeded" });
      let nl;
      while ((nl = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, nl);
        output = output.slice(nl + 1);
        try {
          const response = JSON.parse(line);
          if (response.id !== 1) continue;
          const text = response.result?.content?.[0]?.text || response.error?.message || "no answer";
          const answer = text.replace(/^\(agent-bridge:[^\n]*\)\n\n/, "").replace(/\n\n\(ask_claude[^\n]*\)$/, "").trim();
          const ok = !response.error && !response.result?.isError && /^PONG[.!]?$/i.test(answer);
          finish({ ok, detail: ok ? "restricted bridge call answered" + (text.includes("retried without") ? "; optional flag fallback exercised" : "") : text.slice(0, 500) });
        } catch {}
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "ask_claude", arguments: { question: "Reply with exactly the word PONG and nothing else.", cwd, effort: "fast" },
    } }) + "\n");
  });
}

async function main() {
  console.log("agent-bridge doctor\n");

  const codexVersion = version(CODEX);
  if (!codexVersion) {
    skip("codex", `\`${CODEX} --version\` did not succeed, so Codex checks are skipped`);
  } else {
    pass("codex present", codexVersion);
    const execHelp = run(CODEX, ["exec", "--help"], { timeout: 30_000 }).out;
    const rootHelp = run(CODEX, ["--help"], { timeout: 30_000 }).out;
    for (const [label, help, flag] of [
      ["codex exec --sandbox", execHelp, "--sandbox"],
      ["codex exec --skip-git-repo-check", execHelp, "--skip-git-repo-check"],
      ["codex exec --ephemeral", execHelp, "--ephemeral"],
      ["codex exec --ignore-user-config", execHelp, "--ignore-user-config"],
      ["codex exec --ignore-rules", execHelp, "--ignore-rules"],
      ["codex exec --json", execHelp, "--json"],
      ["codex -a", rootHelp, "-a"],
      ["codex -c", rootHelp, "-c"],
    ]) {
      helpAdvisory(label, help, flag);
    }
    const resume = run(CODEX, ["exec", "resume", "--help"], { timeout: 30_000 });
    if (resume.status === 0 || /resume/i.test(resume.out)) pass("codex exec resume", "lane syntax is advertised");
    else skip("codex exec resume", "not advertised; set AGENT_BRIDGE_CODEX_RESUME=0 if a live lane fails");

    if (!LIVE) {
      skip("codex exact read-only run", "--no-live was passed");
      skip("codex app-server method", "--no-live was passed");
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-doctor-"));
      const args = [
        "-a", "never", "-c", "model_reasoning_effort=low", "exec", "--sandbox", "read-only",
        "--skip-git-repo-check", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-",
      ];
      const live = run(CODEX, args, {
        input: "Reply with exactly the word PONG and nothing else.",
        timeout: 240_000,
        cwd: tmp,
      });
      const parsed = parseCodexJsonLines(live.stdout);
      if (live.status === 0 && !parsed.failed && parsed.threadId && /^PONG[.!]?$/i.test(parsed.answer.trim())) {
        pass("codex exact read-only run", "JSONL, thread id and isolation flags worked");
      } else {
        fail("codex exact read-only run", live.out.trim().split("\n").slice(-4).join(" | ") || "no valid JSONL answer");
      }
      fs.rmSync(tmp, { recursive: true, force: true });

      const appServer = await probeAppServer();
      if (appServer.ok) pass("codex app-server method", appServer.detail);
      else skip("codex app-server method", `${appServer.detail}; usage display will fall back to rollout logs`);
    }
  }

  const claudeVersion = version(CLAUDE);
  if (!claudeVersion) {
    skip("claude", `\`${CLAUDE} --version\` did not succeed; ask_claude will be unavailable`);
  } else {
    pass("claude present", claudeVersion);
    const help = run(CLAUDE, ["--help"], { timeout: 30_000 }).out;
    for (const flag of ["--restricted", "--bare", "--no-session-persistence", "-p", "--tools", "--disallowedTools", "--model"]) {
      helpAdvisory(`claude ${flag}`, help, flag);
    }
    if (!LIVE) {
      skip("claude exact read-only run", "--no-live was passed");
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-doctor-claude-"));
      const live = await probeClaudeBridge(tmp);
      if (live.ok) pass("claude exact read-only run", live.detail);
      else fail("claude exact read-only run", live.detail);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 18) pass("node", process.version);
  else fail("node", `${process.version}; the bridge needs 18 or newer`);

  console.log();
  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    const mark = result.state === "pass" ? " ok " : result.state === "FAIL" ? "FAIL" : "skip";
    console.log(`  ${mark}  ${result.name.padEnd(width)}  ${result.detail}`);
  }
  const failures = results.filter((result) => result.state === "FAIL");
  console.log(
    `\n${results.filter((result) => result.state === "pass").length} ok, ${failures.length} failed, ` +
      `${results.filter((result) => result.state === "skip").length} skipped`
  );
  if (failures.length) console.log("\nA failed live probe means the installed CLI rejected the bridge's real read-only invocation.");
  process.exitCode = failures.length ? 1 : 0;
}

const RUN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (RUN) await main();
