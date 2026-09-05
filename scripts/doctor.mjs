#!/usr/bin/env node
/**
 * Doctor: check this pack's assumptions against the real CLIs.
 *
 * The test suite substitutes stub executables for Codex and Claude Code. That is
 * right for testing the bridge, but it means the suite can prove nothing about
 * whether those CLIs actually accept the flags the bridge passes them. Every
 * check below is something taken from documentation or an issue thread rather
 * than from a live CLI, and every one of them is a silent breakage if it is
 * wrong: the bridge would keep working and just stop restricting, resuming or
 * reporting.
 *
 *   npm run doctor
 *
 * Nothing here writes to your repositories. The one live Codex call runs in a
 * read-only sandbox in a temporary directory and asks for a single word.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const CODEX = process.env.AGENT_BRIDGE_CODEX_BIN || "codex";
const CLAUDE = process.env.AGENT_BRIDGE_CLAUDE_BIN || "claude";
const LIVE = !process.argv.includes("--no-live");

const results = [];
const pass = (name, detail = "") => results.push({ state: "pass", name, detail });
const fail = (name, detail = "") => results.push({ state: "FAIL", name, detail });
const skip = (name, detail = "") => results.push({ state: "skip", name, detail });

function run(bin, args, { input, timeout = 60000, cwd } = {}) {
  const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : bin;
  const argv = IS_WINDOWS ? ["/d", "/s", "/c", bin, ...args] : args;
  const r = spawnSync(file, argv, { encoding: "utf8", input, timeout, cwd });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

const version = (bin) => {
  const r = run(bin, ["--version"], { timeout: 20000 });
  return r.status === 0 ? r.out.trim().split("\n")[0] : null;
};

/**
 * A flag counts as present if it appears in the CLI's own help output. Checking
 * help rather than exit codes matters because a real invocation can fail for a
 * dozen reasons that have nothing to do with the flag being tested.
 */
function helpHas(help, flag) {
  return help.includes(flag);
}

console.log("agent-bridge doctor\n");

// --- Codex -----------------------------------------------------------------
const codexVersion = version(CODEX);
if (!codexVersion) {
  skip("codex", `\`${CODEX} --version\` did not succeed, so every Codex check is skipped`);
} else {
  pass("codex present", codexVersion);

  const execHelp = run(CODEX, ["exec", "--help"], { timeout: 30000 }).out;
  const rootHelp = run(CODEX, ["--help"], { timeout: 30000 }).out;

  for (const [label, help, flag, workaround] of [
    ["codex exec --sandbox", execHelp, "--sandbox", "no workaround; delegations would lose their read-only guarantee"],
    ["codex exec --skip-git-repo-check", execHelp, "--skip-git-repo-check", "remove it and require a git repo"],
    ["codex exec --ephemeral", execHelp, "--ephemeral", "remove it; questions will leave session files behind"],
    ["codex exec --json", execHelp, "--json", "lane resumption depends on this; set AGENT_BRIDGE_CODEX_RESUME=0"],
    ["codex -a (approval policy)", rootHelp, "-a", "set AGENT_BRIDGE_CODEX_APPROVAL= (empty) to omit it"],
    ["codex -c (config override)", rootHelp, "-c", "reasoning effort per tier stops applying"],
  ]) {
    if (helpHas(help, flag)) pass(label);
    else fail(label, workaround);
  }

  const resume = run(CODEX, ["exec", "resume", "--help"], { timeout: 30000 });
  if (resume.status === 0 || /resume/i.test(resume.out)) pass("codex exec resume", "lanes will work");
  else fail("codex exec resume", "set AGENT_BRIDGE_CODEX_RESUME=0; lanes will silently cold-start");

  const appServer = run(CODEX, ["app-server", "--help"], { timeout: 30000 });
  if (appServer.status === 0 || /stdio/i.test(appServer.out)) pass("codex app-server", "usage display has its preferred source");
  else skip("codex app-server", "usage display falls back to reading session logs");

  if (!LIVE) {
    skip("codex end to end", "--no-live was passed");
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-doctor-"));
    const live = run(CODEX, ["-a", "never", "exec", "-", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"], {
      input: "Reply with exactly the word PONG and nothing else.",
      timeout: 240000,
      cwd: tmp,
    });
    if (/PONG/i.test(live.out)) pass("codex end to end", "a real read-only run answered");
    else fail("codex end to end", live.out.trim().split("\n").slice(-3).join(" | ") || "no output");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Claude Code -----------------------------------------------------------
const claudeVersion = version(CLAUDE);
if (!claudeVersion) {
  skip("claude", `\`${CLAUDE} --version\` did not succeed; ask_claude will be unavailable`);
} else {
  pass("claude present", claudeVersion);
  const help = run(CLAUDE, ["--help"], { timeout: 30000 }).out;

  // --tools is the one that matters. --allowedTools only skips permission
  // prompts and appends to the default tool set, so if --tools is gone,
  // ask_claude stops being read-only while still looking like it is.
  if (helpHas(help, "--tools")) pass("claude --tools", "ask_claude is genuinely restricted");
  else fail("claude --tools", "ask_claude would NOT be read-only; do not ship without re-checking this");

  for (const flag of ["-p", "--disallowedTools", "--model", "--append-system-prompt"]) {
    if (helpHas(help, flag)) pass(`claude ${flag}`);
    else fail(`claude ${flag}`, "the bridge passes it and the call may fail");
  }
}

// --- Node ------------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major >= 18) pass("node", process.version);
else fail("node", `${process.version}; the bridge needs 18 or newer`);

// --- report ----------------------------------------------------------------
console.log();
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.state === "pass" ? " ok " : r.state === "FAIL" ? "FAIL" : "skip";
  console.log(`  ${mark}  ${r.name.padEnd(width)}  ${r.detail}`);
}

const failures = results.filter((r) => r.state === "FAIL");
console.log(
  `\n${results.filter((r) => r.state === "pass").length} ok, ${failures.length} failed, ` +
    `${results.filter((r) => r.state === "skip").length} skipped`
);
if (failures.length) console.log("\nEach failure names its workaround. CLAUDE.md lists which assumptions were never verified live.");
process.exit(failures.length ? 1 : 0);
