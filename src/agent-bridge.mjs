#!/usr/bin/env node
/**
 * agent-bridge - single file, no dependencies, no install step.
 *
 * Exposes six MCP tools over stdio:
 *   ask_codex          -> ask Codex a question (read-only, no file changes)
 *   delegate_to_codex  -> hand Codex a unit of work to actually do (writes files)
 *   start_codex_jobs    -> queue independent Codex implementation jobs
 *   collect_codex_jobs  -> wait for background Codex jobs and return results
 *   set_project_context -> save context prepended to future delegations
 *   ask_claude         -> ask Claude Code a question (read-only), for the reverse direction
 *
 * Drop it anywhere (say C:\tools\agent-bridge.mjs) and point every MCP host at
 * the same path. Nothing to build, nothing in node_modules to keep in sync.
 *
 * The MCP stdio transport is newline-delimited JSON-RPC 2.0, which is little
 * enough protocol to implement directly. That is the whole reason there is no
 * SDK dependency here: one file you can copy to a new machine and register in
 * four places beats a package that needs installing next to every host.
 *
 * HARD RULE: stdout is the protocol. Diagnostics go to stderr. A single stray
 * console.log to stdout corrupts the stream and the host drops the connection.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const IS_WINDOWS = process.platform === "win32";
const SERVER_VERSION = "0.9.2";

// Questions come back in a minute or two. Real work takes longer, so the two
// paths get separate budgets rather than one compromise value.
const ASK_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_TIMEOUT_MS) || 300_000;
const DELEGATE_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_DELEGATE_TIMEOUT_MS) || 1_800_000;

// Everything this server returns lands in the calling agent's context window and
// stays there for the rest of the session. Offloading work to the other agent
// only pays for itself if what comes back is small, so a verbose reply gets cut
// rather than quietly costing you the savings you delegated for.
const MAX_REPLY_CHARS = Number(process.env.AGENT_BRIDGE_MAX_REPLY_CHARS) || 6000;

// Neither CLI is told which model to use unless you say so here, so by default
// each one uses whatever its own config already selects. Setting these lets you
// point delegated work at a cheaper or faster model than the one you drive
// interactively, which is usually the point of delegating in the first place.
const CODEX_MODEL = process.env.AGENT_BRIDGE_CODEX_MODEL || "";
const CLAUDE_MODEL = process.env.AGENT_BRIDGE_CLAUDE_MODEL || "";

// Where per-machine state lives. The installer puts the server here too.
const STATE_DIR = path.join(os.homedir(), ".agent-bridge");
const MODELS_FILE = path.join(STATE_DIR, "models.json");
const CONSERVE_FILE = path.join(STATE_DIR, "conserve");
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

const savedSettings = loadSettings();
const CLAUDE_BIN = process.env.AGENT_BRIDGE_CLAUDE_BIN || savedSettings.claudePath || "claude";
const CODEX_BIN = process.env.AGENT_BRIDGE_CODEX_BIN || savedSettings.codexPath || "codex";

/**
 * Effort tiers instead of model names.
 *
 * The calling model picks a tier from the shape of the task; the tier maps to
 * whatever model you have configured. This is deliberate. Model names change
 * every few months and a name baked into a tool schema goes stale silently, with
 * the first symptom being an error you have to trace back here. A tier does not
 * go stale, and the mapping lives in one small file you own.
 *
 * Empty string means "do not pass -m at all", so the CLI's own default applies.
 * That is the shipped default: it works before you have configured anything.
 */
const DEFAULT_MODELS = {
  codex: { fast: "", balanced: "", deep: "" },
  claude: { fast: "", balanced: "", deep: "" },
  // Codex reasoning effort per tier, applied as a config override. Blank skips it.
  codexReasoning: { fast: "low", balanced: "medium", deep: "high" },
};

function loadModels() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
    return {
      codex: { ...DEFAULT_MODELS.codex, ...(parsed.codex || {}) },
      claude: { ...DEFAULT_MODELS.claude, ...(parsed.claude || {}) },
      codexReasoning: { ...DEFAULT_MODELS.codexReasoning, ...(parsed.codexReasoning || {}) },
    };
  } catch {
    return DEFAULT_MODELS;
  }
}

// Conserve mode: a flag file, not a setting inside this process, so the installer
// or you can flip it while a session is live. See the tools/list_changed watcher
// at the bottom for how running hosts find out.
// The env var exists so packaged installs can set it: a .mcpb manifest and a
// plugin manifest can pass environment, but neither can create a file.
const conserveOn = () =>
  process.env.AGENT_BRIDGE_CONSERVE === "1" ||
  (process.env.AGENT_BRIDGE_CONSERVE === undefined && savedSettings.conserveMode === true) ||
  fs.existsSync(CONSERVE_FILE);

// The Claude desktop app has no project context, so without this every question
// would have to carry an absolute path. Extensions set it once at install time.
const DEFAULT_CWD = process.env.AGENT_BRIDGE_DEFAULT_CWD || savedSettings.defaultProject || "";

// A model name reaches argv, unlike the prompt, so it gets checked. Anything with
// a space, quote or shell metacharacter in it is not a model name.
const SAFE_MODEL = /^[A-Za-z0-9._:\-]+$/;
function modelArgs(flag, requested, fallback) {
  const model = requested || fallback;
  if (!model) return [];
  if (!SAFE_MODEL.test(model)) throw new Error(`not a valid model name: ${model}`);
  return [flag, model];
}

const EFFORTS = ["fast", "balanced", "deep"];

/** Resolve an effort tier to whatever model and reasoning setting it maps to. */
function resolveEffort(peer, effort) {
  const tier = EFFORTS.includes(effort) ? effort : "balanced";
  const models = loadModels();
  return { tier, model: models[peer]?.[tier] || "", reasoning: models.codexReasoning?.[tier] || "" };
}

// Failure tracking, so a peer that is broken does not get asked twenty times.
// Uninstalled, signed out and out of quota all look the same from here: the call
// fails fast and will keep failing. After a couple of those the tool stops trying
// and says so, which costs the caller one short message instead of one long
// timeout per attempt for the rest of the session.
// HTTP mode, off unless asked for. See startHttp for why the defaults are strict.
const REMOTE_MODE = process.argv.includes("--http") || Boolean(process.env.AGENT_BRIDGE_REMOTE_SECRET && process.env.AGENT_BRIDGE_HTTP);
const REMOTE_SECRET = process.env.AGENT_BRIDGE_REMOTE_SECRET || "";
const REMOTE_PORT = Number(process.env.AGENT_BRIDGE_HTTP_PORT) || 7333;
const REMOTE_HOST = process.env.AGENT_BRIDGE_HTTP_HOST || "127.0.0.1";
const REMOTE_WRITES = process.env.AGENT_BRIDGE_REMOTE_WRITES === "1";

const MAX_FAILURES = Number(process.env.AGENT_BRIDGE_MAX_FAILURES) || 2;
const failures = { Codex: 0, Claude: 0 };

// Rough classification of why a run failed. Both CLIs word these differently and
// change the wording between releases, so this is a hint for the caller, never a
// decision the bridge acts on by itself.
function diagnose(text) {
  if (/ENOENT|not recognized|command not found/i.test(text)) return "it does not look installed, or is not on PATH";
  if (/not logged in|please log ?in|unauthorized|401|authentication/i.test(text)) return "it is not signed in";
  if (/rate.?limit|quota|usage limit|429|insufficient.credit|billing/i.test(text)) return "it is out of quota or rate limited";
  return null;
}

function capped(text) {
  if (text.length <= MAX_REPLY_CHARS) return text;
  // Keep the head (what it set out to do) and the tail (what it concluded and
  // the diff stat, which is appended last). The middle is usually narration.
  const head = text.slice(0, Math.floor(MAX_REPLY_CHARS * 0.4));
  const tail = text.slice(-Math.floor(MAX_REPLY_CHARS * 0.6));
  return `${head}\n\n[... ${text.length - MAX_REPLY_CHARS} characters trimmed by agent-bridge ...]\n\n${tail}`;
}

// Recursion guard. Claude delegates to Codex, Codex's own bridge asks Claude, loop.
// The variable is set on the child process and inherited by the bridge instance
// that child starts, so the second hop sees "1" and refuses.
const DEPTH = Number(process.env.AGENT_BRIDGE_DEPTH) || 0;

const log = (msg) => process.stderr.write(`[agent-bridge] ${msg}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const safeForWindowsCmd = (value) => !/[&|<>^%!()"\r\n]/.test(value);

// ---------------------------------------------------------------------------
// Running the other agent
// ---------------------------------------------------------------------------

/**
 * Two decisions here carry the whole Windows story:
 *
 * 1. `claude` and `codex` install as .cmd shims and Node will not spawn those
 *    directly, so on Windows we go through cmd.exe. Every argument handed to
 *    cmd.exe is a fixed literal from this file, never text from a model.
 *
 * 2. The prompt travels on stdin, not argv. Prompts contain quotes, %, & and ^,
 *    all of which mean something to cmd.exe, and argv has a length limit that a
 *    forwarded diff will hit. stdin has neither problem.
 */
// Every child we start, so we can take them down with us. Without this, closing
// Claude Code mid-delegation leaves a codex process editing your files with
// nobody watching, because on Windows killing the shim does not kill the shell
// it spawned.
const liveChildren = new Set();
const requestScope = new AsyncLocalStorage();
const requestChildren = new Map();

function trackChild(child) {
  liveChildren.add(child);
  const requestId = requestScope.getStore();
  if (requestId === undefined) return;
  if (!requestChildren.has(requestId)) requestChildren.set(requestId, new Set());
  requestChildren.get(requestId).add(child);
}

function untrackChild(child) {
  liveChildren.delete(child);
  for (const [requestId, children] of requestChildren) {
    children.delete(child);
    if (!children.size) requestChildren.delete(requestId);
  }
}

function cancelRequest(requestId) {
  for (const child of requestChildren.get(requestId) || []) {
    try {
      killTree(child);
    } catch {}
  }
  requestChildren.delete(requestId);
}

function killTree(child) {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    // spawnSync, not spawn: on the shutdown path we call process.exit right
    // after, and an async taskkill would not have run by then. /t takes the
    // whole tree, which matters because we go through cmd.exe.
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  // On POSIX the child is its own process group leader (detached below), so a
  // negative pid signals the group. Killing just the child would leave whatever
  // it spawned running.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of liveChildren) {
    try {
      killTree(child);
    } catch {}
  }
  for (const job of pendingJobs.splice(0)) {
    job.status = "failed";
    job.seconds = 0;
    job.text = "Codex job cancelled because the MCP host closed.";
    job.resolve(job);
  }
  // Small grace period so anything already written to stdout gets flushed before
  // the process goes away. Exiting on the same tick truncates the last reply.
  setTimeout(() => process.exit(0), 150);
}
// The host closing our stdin is the end of the session, and on Windows it is the
// only shutdown signal we reliably get. Anything still running was started for a
// caller that is no longer there, so it goes too.
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function parseCodexJsonLines(output) {
  const messages = [];
  const errors = [];
  let sessionId = null;
  let sawJsonEvent = false;
  let failed = false;

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") continue;
      sawJsonEvent = true;
      if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        messages.push(event.item.text);
      }
      if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
        const detail = event.error?.message || event.message || event.error;
        if (detail) errors.push(typeof detail === "string" ? detail : JSON.stringify(detail));
      }
    } catch {
      // Older Codex releases and test doubles may still emit plain text.
    }
  }

  if (!sawJsonEvent) return { text: output.trim(), sessionId: null, failed: false, errors: "" };
  return {
    text: messages.at(-1)?.trim() || errors.join("\n") || "(Codex returned no final message)",
    sessionId,
    failed,
    errors: errors.join("\n"),
  };
}

function runAgent(bin, args, prompt, cwd, timeoutMs, { codexJson = false } = {}) {
  return new Promise((resolve) => {
    if (IS_WINDOWS && [bin, ...args].some((value) => !safeForWindowsCmd(value))) {
      return resolve({ ok: false, text: "(refused command containing Windows shell metacharacters)" });
    }
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : bin;
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", bin, ...args] : args;

    const child = spawn(file, argv, {
      cwd: cwd || DEFAULT_CWD || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group on POSIX so killTree can take the whole group down.
      // Windows does the equivalent through taskkill /t instead.
      detached: !IS_WINDOWS,
      env: { ...process.env, AGENT_BRIDGE_DEPTH: String(DEPTH + 1), NO_COLOR: "1" },
    });

    trackChild(child);

    let out = "";
    let err = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrackChild(child);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child);
      // A half-finished write-mode delegation is exactly why the caller is told
      // to check the diff rather than trust this string.
      finish({
        ok: false,
        text: `(no answer: ${bin} was killed after ${timeoutMs / 1000}s. Any partial file changes are still on disk.)`,
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d)); // both CLIs stream progress here
    child.on("error", (e) => finish({ ok: false, text: `(could not start ${bin}: ${e.message})`, raw: e.message }));
    child.on("close", (code, signal) => {
      const parsed = codexJson ? parseCodexJsonLines(out) : { text: out.trim(), sessionId: null, failed: false, errors: "" };
      const stderrTail = err.trim().split("\n").slice(-12).join("\n");
      const ok = code === 0 && !signal && !parsed.failed;
      if (ok && parsed.text) return finish({ ok: true, text: parsed.text, sessionId: parsed.sessionId });

      const reason = signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
      const details = [parsed.text, parsed.errors, stderrTail].filter(Boolean).join("\n");
      finish({
        ok: false,
        text: `(${bin} ${reason})${details ? `\n${details}` : ""}`,
        raw: [parsed.errors, stderrTail].filter(Boolean).join("\n") || details,
        sessionId: parsed.sessionId,
      });
    });

    child.stdin.on("error", () => {}); // the child may exit before we finish writing
    child.stdin.end(prompt);
  });
}

/**
 * After a write-mode delegation, report what actually changed on disk.
 *
 * The point is to stop the calling agent from taking the other one's summary at
 * face value. A model saying "I updated the repository layer" and Git status
 * showing three files changed are different claims, and only one is checkable.
 */
function gitSnapshot(cwd) {
  return new Promise((resolve) => {
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : "git";
    const gitArgs = ["status", "--short", "--untracked-files=all"];
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", "git", ...gitArgs] : gitArgs;
    const child = spawn(file, argv, { cwd: cwd || DEFAULT_CWD || process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null)); // not a git repo, or no git: skip silently
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
    setTimeout(() => child.kill(), 10_000);
  });
}

function formatGitSummary(before, after) {
  if (after === null) return "(no git status available: not a git repository, or git is not on PATH)";
  if (!after) return "working tree after delegation: clean";
  const parts = [`working tree after delegation:\n${after}`];
  if (before) parts.push(`already present before delegation:\n${before}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Prompts sent to the other agent
// ---------------------------------------------------------------------------

// A short preamble so the peer knows it is answering a question rather than
// taking over. Without it both CLIs tend to start editing files unprompted.
const askFrame = (question) =>
  "You are being consulted by another AI agent. Answer the question directly and " +
  "concisely. Do not start unrelated work and do not modify any files. If you are " +
  "not confident, say so.\n\n" +
  `Question:\n${question}`;

// A delegated task is a handoff to a process with no memory of your conversation.
// The sections exist to force the caller to write down what it would otherwise
// assume: which files, what not to touch, and how anyone can tell it worked.
const delegateFrame = ({ task, files, constraints, acceptance, verify: verifyCommand, cwd, resuming }) =>
  [
    "You are an implementation agent working on a task delegated by another AI agent.",
    "You have no access to the conversation this task came from, so everything you need is below.",
    // On a resumed session Codex already has the project context from the first
    // message in the thread. Repeating it would be paying for it again.
    !resuming && readProjectContext(cwd) ? `\n## Project context\n${readProjectContext(cwd)}` : "",
    "Do the work, then reply with a short summary: what you changed, which files, and anything",
    "you could not finish or had to guess. Do not start work beyond what is described.",
    `\n## Task\n${task}`,
    files ? `\n## Relevant files\n${files}` : "",
    constraints ? `\n## Constraints\n${constraints}` : "",
    acceptance ? `\n## Done when\n${acceptance}` : "",
    verifyCommand ? `\n## Verification\nWhen you are finished, \`${verifyCommand}\` will be run against your work. Make it pass.` : "",
  ]
    .filter(Boolean)
    .join("\n");

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// The trailing "-" makes codex read the prompt from stdin. If your build does
// not accept it, set AGENT_BRIDGE_CODEX_STDIN=0 and it goes back to argv.
const CODEX_STDIN = process.env.AGENT_BRIDGE_CODEX_STDIN !== "0";

// Approval policy is a global flag and has to come before the `exec` subcommand.
// Without it a write-mode run can sit waiting for an approval nobody will give.
// Set AGENT_BRIDGE_CODEX_APPROVAL to an empty string if your version rejects it.
const CODEX_APPROVAL = process.env.AGENT_BRIDGE_CODEX_APPROVAL ?? "never";
const approvalArgs = () => (CODEX_APPROVAL ? ["-a", CODEX_APPROVAL] : []);

function codexArgs({ write, prompt, model, effort, resumeId }) {
  const chosen = resolveEffort("codex", effort);
  // -c applies a one-off config override for this run only, so a deep task can
  // think harder without changing the setting for your interactive sessions.
  const reasoning =
    chosen.reasoning && SAFE_MODEL.test(chosen.reasoning) ? ["-c", `model_reasoning_effort=${chosen.reasoning}`] : [];
  const args = [
    ...approvalArgs(),
    ...reasoning,
    "exec",
    "--sandbox",
    write ? "workspace-write" : "read-only",
    "--skip-git-repo-check",
    "--json",
    ...modelArgs("-m", model, chosen.model || CODEX_MODEL),
    ...(!write ? ["--ephemeral"] : []),
    // Exec options belong before its optional `resume` subcommand.
    ...(resumeId ? ["resume", resumeId] : []),
    ...(CODEX_STDIN ? ["-"] : []),
  ];
  if (!CODEX_STDIN) args.push(prompt);
  return args;
}

async function askCodex({ question, cwd, model, effort }) {
  const prompt = askFrame(question);
  return runAgent(CODEX_BIN, codexArgs({ write: false, prompt, model, effort }), prompt, cwd, ASK_TIMEOUT_MS, { codexJson: true });
}

async function delegateToCodex({ task, files, constraints, acceptance, verify: verifyCommand, cwd, model, effort, allow_writes, lane }) {
  // Over HTTP the default is read-only. A remote caller that can write files on
  // your machine is a different kind of thing from a local one, so it has to be
  // turned on deliberately rather than inherited from the local behaviour.
  const write = REMOTE_MODE ? REMOTE_WRITES && allow_writes !== false : true;

  const resumeId = lane && RESUME_ENABLED ? loadLane(lane, cwd)?.sessionId : null;
  const prompt = delegateFrame({ task, files, constraints, acceptance, verify: verifyCommand, cwd, resuming: Boolean(resumeId) });
  const before = await gitSnapshot(cwd);
  const r = await runAgent(
    CODEX_BIN,
    codexArgs({ write, prompt, model, effort, resumeId }),
    prompt,
    cwd,
    DELEGATE_TIMEOUT_MS,
    { codexJson: true }
  );
  if (lane && RESUME_ENABLED && !resumeId && r.sessionId) saveLane(lane, r.sessionId, cwd);
  // Ask git what changed even when the run failed: a delegation that died partway
  // through still leaves edits behind, and that is exactly when you want to know.
  const after = await gitSnapshot(cwd);
  const diff = formatGitSummary(before, after);
  const verify = verifyCommand
    ? REMOTE_MODE && !REMOTE_WRITES
      ? { ran: false, text: "verify skipped: remote writes are disabled, so host commands are not allowed" }
      : await runVerify(verifyCommand, cwd)
    : null;

  // Verdict first, then what changed, then the builder's own words last. The
  // caller should be able to stop reading after two lines when it passed.
  const parts = [];
  if (verify) parts.push(verify.text);
  parts.push(diff);
  if (!verify) parts.push("No verify command was given, so nothing here confirms the change works. Inspect the working tree.");
  parts.push(`codex said:\n${r.text}`);
  return { ...r, ok: r.ok && (!verify || !verify.ran || verify.ok), text: parts.join("\n\n") };
}

async function askClaude({ question, cwd, model, effort }) {
  // Restricting the tool list is what makes this read-only, and it matters more
  // than it looks: in print mode there is no human to answer a permission
  // prompt, so a tool outside the list is denied rather than hanging.
  const chosen = resolveEffort("claude", effort);
  const args = [
    "-p",
    "--tools",
    "Read,Grep,Glob",
    "--disallowedTools",
    "mcp__*",
    ...modelArgs("--model", model, chosen.model || CLAUDE_MODEL),
  ];
  return runAgent(CLAUDE_BIN, args, askFrame(question), cwd, ASK_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Shared project context
//
// Every Codex run starts cold. Without this, the calling model re-explains the
// architecture, the conventions and the interfaces in every single handoff,
// which is exactly the repetition that delegating was supposed to avoid: real
// Claude tokens spent saying the same thing again.
//
// So the grounding lives in a file in the repository and gets prepended to every
// delegation. Written once, used by every build after it. It is a repo file on
// purpose: it belongs to the project, survives sessions, and you can read and
// edit it yourself.
// ---------------------------------------------------------------------------

const CONTEXT_MAX = Number(process.env.AGENT_BRIDGE_CONTEXT_MAX) || 8000;

const contextPath = (cwd) => path.join(cwd || DEFAULT_CWD || process.cwd(), ".agent-bridge", "context.md");

function readProjectContext(cwd) {
  for (const file of [contextPath(cwd), path.join(STATE_DIR, "context.md")]) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      // A context file that grows without limit turns into the bloat it exists
      // to prevent, except now it is on every delegation instead of just one.
      if (text) return text.length > CONTEXT_MAX ? text.slice(0, CONTEXT_MAX) + "\n[...truncated by agent-bridge]" : text;
    } catch {}
  }
  return "";
}

// ---------------------------------------------------------------------------
// Codex conversation lanes
//
// A lane is a named thread of related builds. The first delegation in a lane
// starts a Codex session; later ones resume it, so Codex remembers the files it
// already read and the decisions it already made. That is the difference between
// five independent cold starts and one build conversation.
//
// Codex's documented JSONL stream reports the session id in `thread.started`.
// Lane state is scoped by repository so the same friendly lane name can be used
// in unrelated projects without resuming the wrong conversation. Set
// AGENT_BRIDGE_CODEX_RESUME=0 if your Codex build does not support `exec resume`.
// ---------------------------------------------------------------------------

const RESUME_ENABLED = process.env.AGENT_BRIDGE_CODEX_RESUME !== "0";
const LANES_FILE = path.join(STATE_DIR, "lanes.json");

function loadLanes() {
  try {
    return JSON.parse(fs.readFileSync(LANES_FILE, "utf8"));
  } catch {
    return {};
  }
}

const laneScope = (cwd) => path.resolve(cwd || DEFAULT_CWD || process.cwd());

function loadLane(lane, cwd) {
  const saved = loadLanes();
  return saved.scopes?.[laneScope(cwd)]?.[lane] || null;
}

function saveLane(lane, sessionId, cwd) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const lanes = loadLanes();
    if (!lanes.scopes || typeof lanes.scopes !== "object") lanes.scopes = {};
    const scope = laneScope(cwd);
    if (!lanes.scopes[scope] || typeof lanes.scopes[scope] !== "object") lanes.scopes[scope] = {};
    lanes.scopes[scope][lane] = { sessionId, at: Date.now() };
    fs.writeFileSync(LANES_FILE, JSON.stringify(lanes, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Verification
//
// The whole architect/builder split only saves anything if the architect does
// not have to read the builder's diff line by line. So the bridge runs a check
// command itself and reports a verdict. "14 tests pass" costs the caller a line;
// a 600-line diff costs it a review.
//
// This runs a command the calling model supplied, which is a real step beyond
// spawning a fixed CLI. The allowlist is the mitigation: only the first token is
// matched, and only against commands you listed. Default covers the usual test
// runners and nothing else.
// ---------------------------------------------------------------------------

const VERIFY_ALLOWLIST = (process.env.AGENT_BRIDGE_VERIFY_ALLOW || "npm,npx,pnpm,yarn,dotnet,pytest,python,go,cargo,make,mvn,gradle,jest,vitest,tsc,eslint")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function runVerify(command, cwd) {
  return new Promise((resolve) => {
    const parts = command.trim().split(/\s+/);
    const head = path.basename(parts[0] || "").replace(/\.(exe|cmd|bat)$/i, "");
    if (!VERIFY_ALLOWLIST.includes(head)) {
      return resolve({ ran: false, text: `verify skipped: "${head}" is not in the allowlist (${VERIFY_ALLOWLIST.join(", ")})` });
    }
    if (IS_WINDOWS && parts.some((part) => !safeForWindowsCmd(part))) {
      return resolve({ ran: false, text: "verify skipped: shell metacharacters are not allowed on Windows" });
    }
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : parts[0];
    // The command came from a model. On Windows .cmd shims require cmd.exe, so
    // metacharacters were rejected above before the allowlisted command is run.
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", ...parts] : parts.slice(1);
    const child = spawn(file, argv, { cwd: cwd || DEFAULT_CWD || process.cwd(), stdio: ["ignore", "pipe", "pipe"], detached: !IS_WINDOWS });
    trackChild(child);
    let out = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      untrackChild(child);
      resolve(v);
    };
    const t = setTimeout(() => {
      killTree(child);
      finish({ ran: true, ok: false, text: `verify \`${command}\` timed out after 10 minutes` });
    }, 600_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => finish({ ran: false, text: `verify could not start: ${e.message}` }));
    child.on("close", (code) => {
      const tail = out.trim().split("\n").slice(-15).join("\n");
      finish({
        ran: true,
        ok: code === 0,
        text: code === 0 ? `verify \`${command}\` PASSED` : `verify \`${command}\` FAILED (exit ${code})\n${tail}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Background jobs
//
// Codex is slower than Claude, which is the reason to run it in the background
// rather than a reason not to use it. Start work, keep planning, collect later.
// ---------------------------------------------------------------------------

const jobs = new Map();
let jobCounter = 0;
const pendingJobs = [];
const runningClaims = new Map();

function claimsFor(spec) {
  const base = spec.cwd || DEFAULT_CWD || process.cwd();
  // Split on whitespace as well as commas and newlines. A caller writing
  // `files: "src/a.ts src/b.ts"` is entirely natural, and splitting only on
  // commas turned that into one nonsense path that overlapped with nothing, so
  // a second job naming src/b.ts would run against it concurrently - the exact
  // collision this scheduler exists to prevent. Over-splitting only costs some
  // needless serialisation; under-splitting costs a corrupted file.
  // A path that genuinely contains a space can be quoted.
  const declared = (spec.files || "*")
    .split(/"([^"]+)"|'([^']+)'|[\s,\n]+/)
    .map((x) => (x || "").trim())
    .filter(Boolean);
  if (!declared.length || declared.some((x) => x === "*" || /[*?\[\]]/.test(x))) return ["*"];
  return declared.map((file) => path.resolve(base, file));
}

function claimsOverlap(left, right) {
  if (left.includes("*") || right.includes("*")) return true;
  return left.some((a) =>
    right.some((b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
  );
}

function canStart(job) {
  return ![...runningClaims.values()].some((claims) => claimsOverlap(job.claims, claims));
}

function launchJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  runningClaims.set(job.id, job.claims);
  (async () => {
    try {
      const r = await delegateToCodex(job.spec);
      job.status = r.ok ? "done" : "failed";
      job.text = r.text;
    } catch (e) {
      job.status = "failed";
      job.text = `Codex job failed inside agent-bridge: ${e.message || e}`;
    } finally {
      job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
      runningClaims.delete(job.id);
      job.resolve(job);
      pumpQueue();
    }
  })();
}

function pumpQueue() {
  if (shuttingDown) return;
  for (let i = 0; i < pendingJobs.length; ) {
    const job = pendingJobs[i];
    if (!canStart(job)) {
      i++;
      continue;
    }
    pendingJobs.splice(i, 1);
    launchJob(job);
  }
}

function enqueueJob(spec) {
  const id = `job-${++jobCounter}`;
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  const job = { id, task: spec.task.slice(0, 80), status: "queued", spec, claims: claimsFor(spec), promise, resolve };
  jobs.set(id, job);
  pendingJobs.push(job);
  pumpQueue();
  return job;
}

// ---------------------------------------------------------------------------
// Codex usage
//
// Three routes exist to Codex rate limits, and they are not equally good:
//
//   1. `codex app-server` over its default stdio transport and the
//      account/rateLimits/read method. Codex
//      owns the authentication, so nothing here touches your token. Preferred,
//      but the method name is internal and can move between versions.
//   2. The ChatGPT backend usage endpoint with the token from ~/.codex/auth.json.
//      Deliberately NOT used: it would mean this process reading and sending your
//      OpenAI credentials, which is a real cost to add for a status line.
//   3. The local rollout logs under ~/.codex/sessions. No auth, but note that
//      exec-mode runs record rate_limits as null, so what you get here reflects
//      your interactive Codex sessions rather than anything the bridge itself ran.
//
// So: try 1, fall back to 3, and always say which one the number came from and
// how old it is. A usage figure with no provenance is worse than none.
// ---------------------------------------------------------------------------

const USAGE_CACHE_MS = 60_000;
let usageCache = { at: 0, value: null };

function windowLabel(seconds) {
  if (!seconds) return "window";
  if (seconds <= 3600 * 6) return `${Math.round(seconds / 3600)}h`;
  if (seconds <= 86400 * 2) return "daily";
  if (seconds <= 86400 * 8) return "weekly";
  return "monthly";
}

function shapeUsage(rateLimit, source, asOf) {
  if (!rateLimit) return null;
  const bucket = rateLimit.rateLimits || rateLimit.rate_limits || rateLimit;
  const windows = [];
  for (const key of ["primary_window", "secondary_window", "primary", "secondary"]) {
    const w = bucket[key];
    const used = w?.usedPercent ?? w?.used_percent;
    if (!w || typeof used !== "number") continue;
    const seconds =
      w.limit_window_seconds ||
      (w.window_minutes ? w.window_minutes * 60 : 0) ||
      (w.windowDurationMins ? w.windowDurationMins * 60 : 0);
    windows.push({ label: windowLabel(seconds), remaining: Math.max(0, Math.round(100 - used)) });
  }
  if (!windows.length) return null;
  return { plan: rateLimit.planType || rateLimit.plan_type || bucket.planType || bucket.plan_type || null, windows, source, asOf };
}

function usageFromResult(result, source, asOf) {
  if (!result) return null;
  const byId = result.rateLimitsByLimitId || result.rate_limits_by_limit_id;
  if (byId && typeof byId === "object") {
    const preferred = byId.codex || Object.values(byId)[0];
    const shaped = shapeUsage(preferred, source, asOf);
    if (shaped) return shaped;
  }
  return shapeUsage(result.rateLimits || result.rate_limits || result.rate_limit || result, source, asOf);
}

/** Ask the Codex app-server. Short timeout: this is a status line, not the task. */
function usageFromAppServer() {
  return new Promise((resolve) => {
    if (IS_WINDOWS && !safeForWindowsCmd(CODEX_BIN)) return resolve(null);
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : CODEX_BIN;
    const args = ["app-server"];
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", CODEX_BIN, ...args] : args;
    let child;
    try {
      child = spawn(file, argv, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let out = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        killTree(child);
      } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 8000);
    child.on("error", () => finish(null));
    child.stdout.on("data", (d) => {
      out += d;
      let newline;
      while ((newline = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, newline);
        out = out.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 1 && m.result) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n");
          }
          if (m.id === 2 && m.result) return finish(usageFromResult(m.result, "codex app-server", Date.now()));
          if (m.id === 2 && m.error) return finish(null);
        } catch {}
      }
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agent-bridge", version: SERVER_VERSION } } }) + "\n"
    );
  });
}

/** Fall back to the newest rollout log that actually carries a rate_limits block. */
function usageFromRollouts() {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          files.push({ full, mtime: fs.statSync(full).mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);

  for (const f of files.slice(0, 5)) {
    let lines;
    try {
      lines = fs.readFileSync(f.full, "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes("rate_limits") && !lines[i].includes("rateLimits")) continue;
      try {
        const rec = JSON.parse(lines[i]);
        const rl =
          rec.rateLimits ||
          rec.rate_limits ||
          rec.payload?.rateLimits ||
          rec.payload?.rate_limits ||
          rec.msg?.rateLimits ||
          rec.msg?.rate_limits;
        const shaped = usageFromResult(rl, "codex session log", f.mtime);
        if (shaped) return shaped;
      } catch {}
    }
  }
  return null;
}

let usageRefreshing = false;

/** Refresh in the background. Never awaited by a tool call. */
function refreshUsage(onDone) {
  if (usageRefreshing) return;
  usageRefreshing = true;
  usageFromAppServer()
    .then((v) => v || usageFromRollouts())
    .catch(() => null)
    .then((value) => {
      usageCache = { at: Date.now(), value };
      usageRefreshing = false;
      if (value && onDone) onDone(value);
    });
}

/**
 * Cached value only, never a wait. Looking this up can take seconds, and making
 * you wait on a status line before you get your answer is the wrong trade. The
 * first call of a session shows no usage; every call after it does.
 */
function codexUsageCached() {
  if (Date.now() - usageCache.at > USAGE_CACHE_MS) refreshUsage(() => publishStatus({ ...lastStatus, usage: usageCache.value }));
  return usageCache.value;
}

// Kept so a late refresh can republish the same entry with usage filled in.
let lastStatus = {};

const usageLine = (u) =>
  u ? `Codex ${u.windows.map((w) => `${w.label} ${w.remaining}% left`).join(", ")}${u.plan ? ` (${u.plan})` : ""}` : null;

/**
 * Write what just happened somewhere the VS Code extension can read it. The
 * extension host and this process are separate programs with no shared memory,
 * so a small state file is the only channel between them.
 */
function publishStatus(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, "status.json"), JSON.stringify(entry, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Tool definitions
//
// These descriptions are not documentation. They are the prompt that decides
// whether the calling model reaches for the tool at all, and when. Vague
// descriptions produce either a tool that never gets used or one that gets used
// for everything, so each one says what it is for and what it is not for.
// ---------------------------------------------------------------------------

const CWD_PROP = {
  type: "string",
  description: "Absolute path to the repository or folder to run in. Always pass this when you know it.",
};

const EFFORT_PROP = {
  type: "string",
  enum: ["fast", "balanced", "deep"],
  description:
    "How much thinking the task deserves. 'fast' for mechanical work with an obvious shape: boilerplate, renames, " +
    "applying a pattern that already exists. 'balanced' for ordinary implementation work, and the right default when " +
    "you are unsure. 'deep' for genuinely hard problems: subtle bugs, tricky concurrency, anything where a wrong " +
    "answer is expensive. Pick from the task, not from how important it feels. Defaults to 'balanced'.",
};

const MODEL_PROP = {
  type: "string",
  description:
    "Optional model override. Leave it out unless the user asked for a specific model; the default comes from " +
    "that CLI's own configuration.",
};

const TOOLS = [
  {
    name: "ask_codex",
    peer: "Codex",
    description:
      "Ask OpenAI Codex a question and get its answer back. Read-only: it inspects code but changes nothing. " +
      "Good for a second opinion when you are stuck or uncertain, for checking a design decision against a " +
      "different model's priors, or when Codex may know a library or API better. Not for getting work done: " +
      "use delegate_to_codex for that. Each call is a full agent run taking a minute or more, so ask when the " +
      "answer would actually change what you do next, not out of habit.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question, with enough background to be answerable on its own. Codex cannot see your conversation.",
        },
        cwd: CWD_PROP,
        effort: EFFORT_PROP,
        model: MODEL_PROP,
      },
      required: ["question"],
    },
    run: askCodex,
  },
  {
    name: "delegate_to_codex",
    peer: "Codex",
    description:
      "Hand a specified piece of implementation work to OpenAI Codex, which edits files in the workspace and reports " +
      "back. This is the builder half of the split: you decide the design, Codex writes the code. Use it for anything " +
      "you can specify completely, which is most implementation once the approach is settled. Keep design decisions, " +
      "anything needing conversation context, and review for yourself. Give a `verify` command whenever the repo has " +
      "one: the result comes back verdict first, so a passing check costs you one line instead of a diff to read. " +
      "Blocking, so use start_codex_jobs instead when you have independent pieces or want to keep planning.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "What to build, written for someone who has never seen your conversation. State the goal and the approach " +
            "you have decided on, not just the outcome. This is the design handoff: the more precisely you specify it, " +
            "the less of the result you have to read.",
        },
        files: {
          type: "string",
          description:
            "Files or directories to work in, and any that are relevant but read-only. Separate them with commas, " +
            "newlines or spaces; quote a path that contains a space. This list is also what decides whether two " +
            "background jobs may run at the same time, so declaring it accurately matters.",
        },
        constraints: {
          type: "string",
          description: "What not to do: files to leave alone, patterns to follow, libraries to avoid, style rules that matter here.",
        },
        acceptance: { type: "string", description: "How to tell it is done, in words." },
        verify: {
          type: "string",
          description:
            "A command that proves the work: `npm test`, `dotnet build`, `pytest tests/auth`. The bridge runs it after " +
            "Codex finishes and reports pass or fail. Give one whenever the repository has one. This is what lets you " +
            "accept the work on a verdict instead of reading the whole diff, which is where the saving actually comes from.",
        },
        cwd: CWD_PROP,
        lane: {
          type: "string",
          description:
            "Name a thread of related builds, like 'auth-refactor'. The first task in a lane starts a Codex session and " +
            "later ones resume it, so Codex still knows the files it read and the decisions it made. Use the same lane " +
            "for a sequence of related work; use different lanes for unrelated work.",
        },
        effort: EFFORT_PROP,
        model: MODEL_PROP,
      },
      required: ["task"],
    },
    run: delegateToCodex,
  },
  {
    name: "start_codex_jobs",
    peer: "Codex",
    local: true,
    description:
      "Start one or more Codex builds in the background and return immediately with job ids. Use this whenever you have " +
      "more than one independent piece, or want to carry on designing while Codex builds. Tasks whose `files` do not " +
      "overlap run at the same time; overlapping ones are queued, because nothing here locks files. Collect the results " +
      "with collect_codex_jobs when you are ready. This is the tool that makes Codex being slower than you stop " +
      "mattering: its time runs alongside yours instead of in front of it.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "The pieces to build. Each is a complete handoff on its own.",
          items: {
            type: "object",
            properties: {
        task: {
          type: "string",
          description:
            "What to build, written for someone who has never seen your conversation. State the goal and the approach " +
            "you have decided on, not just the outcome. This is the design handoff: the more precisely you specify it, " +
            "the less of the result you have to read.",
        },
        files: {
          type: "string",
          description:
            "Files or directories to work in, and any that are relevant but read-only. Separate them with commas, " +
            "newlines or spaces; quote a path that contains a space. This list is also what decides whether two " +
            "background jobs may run at the same time, so declaring it accurately matters.",
        },
        constraints: {
          type: "string",
          description: "What not to do: files to leave alone, patterns to follow, libraries to avoid, style rules that matter here.",
        },
        acceptance: { type: "string", description: "How to tell it is done, in words." },
        verify: {
          type: "string",
          description:
            "A command that proves the work: `npm test`, `dotnet build`, `pytest tests/auth`. The bridge runs it after " +
            "Codex finishes and reports pass or fail. Give one whenever the repository has one. This is what lets you " +
            "accept the work on a verdict instead of reading the whole diff, which is where the saving actually comes from.",
        },
              cwd: CWD_PROP,
        lane: {
          type: "string",
          description:
            "Name a thread of related builds, like 'auth-refactor'. The first task in a lane starts a Codex session and " +
            "later ones resume it, so Codex still knows the files it read and the decisions it made. Use the same lane " +
            "for a sequence of related work; use different lanes for unrelated work.",
        },
              effort: EFFORT_PROP,
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },
    run: async ({ tasks }) => {
      if (!Array.isArray(tasks) || !tasks.length) throw new Error("tasks must be a non-empty array");
      const created = tasks.map(enqueueJob);
      const running = created.filter((j) => j.status === "running").length;
      const queued = created.length - running;
      const lines = created.map((j) => `${j.id}  [${j.status}]  ${j.task}`);
      return {
        ok: true,
        text:
          `Accepted ${created.length} Codex ${created.length === 1 ? "build" : "builds"}: ${running} running, ${queued} queued.\n` +
          lines.join("\n") +
          "\n\nCarry on with your own work. Call collect_codex_jobs when you want the results.",
      };
    },
  },
  {
    name: "collect_codex_jobs",
    peer: "Codex",
    local: true,
    description:
      "Wait for background Codex builds started with start_codex_jobs and return their results. Call it when you have " +
      "finished the planning or code you were doing alongside them.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Which jobs to collect. Omit to collect every job that is still outstanding.",
        },
      },
    },
    run: async ({ ids }) => {
      const wanted = ids?.length ? ids.map((id) => jobs.get(id)).filter(Boolean) : [...jobs.values()].filter((j) => !j.collected);
      if (!wanted.length) return { ok: true, text: "No outstanding Codex jobs." };
      const settled = await Promise.all(wanted.map((j) => j.promise));
      settled.forEach((j) => (j.collected = true));
      return {
        ok: settled.every((j) => j.status === "done"),
        text: settled.map((j) => `### ${j.id} (${j.status}, ${j.seconds}s) - ${j.task}\n${j.text}`).join("\n\n"),
      };
    },
  },
  {
    name: "set_project_context",
    peer: "Codex",
    local: true,
    requiresWrites: true,
    description:
      "Write the shared grounding that every later delegation gets automatically: architecture, conventions, key " +
      "interfaces, what not to touch. Do this once when you start working on a repository, before the first handoff. " +
      "It is the thing that stops you re-explaining the project in every task description, which is the repetition that " +
      "otherwise eats the saving. Keep it to what a competent stranger would need and no more; it is sent with every " +
      "build. Call it again to replace the file when the design moves.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Markdown. Architecture, conventions, interfaces, constraints. A page, not a manual.",
        },
        cwd: CWD_PROP,
      },
      required: ["content"],
    },
    run: async ({ content, cwd }) => {
      const file = contextPath(cwd);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content.trim() + "\n");
      } catch (e) {
        return { ok: false, text: `Could not write ${file}: ${e.message}` };
      }
      const size = content.trim().length;
      return {
        ok: true,
        text:
          `Saved ${size} characters to ${file}. Every delegation from now on carries it, so task descriptions can be short.` +
          (size > CONTEXT_MAX ? ` It exceeds the ${CONTEXT_MAX} character limit and will be truncated; trim it.` : "") +
          " It is a repo file, so commit it if you want it shared.",
      };
    },
  },
  {
    name: "ask_claude",
    peer: "Claude",
    description:
      "Ask Claude Code a question and get its answer back. Read-only: it inspects code but changes nothing. " +
      "Use for a second opinion, or to have another model review a change you have made.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The question, with enough background to be answerable on its own. Claude cannot see your conversation.",
        },
        cwd: CWD_PROP,
        effort: EFFORT_PROP,
        model: MODEL_PROP,
      },
      required: ["question"],
    },
    run: askClaude,
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC loop
// ---------------------------------------------------------------------------

async function handle(msg) {
  if (msg.method === "notifications/cancelled") {
    cancelRequest(msg.params?.requestId);
    return null;
  }
  // Notifications have no id and expect no reply.
  if (msg.id === undefined) return null;

  switch (msg.method) {
    case "initialize":
      return {
        // Echo the client's protocol version back when it sends one. Hosts are
        // on different release cadences and this avoids arguing about it.
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "agent-bridge", version: SERVER_VERSION },
      };

    case "ping":
      return {};

    case "tools/list": {
      // Conserve mode is expressed here rather than as a separate tool, because
      // what we actually want to change is the calling model's default: whether
      // delegating or doing it yourself is the thing that needs justifying. The
      // tool description is the only lever that reaches that decision.
      const conserve = conserveOn()
        ? " CONSERVE MODE IS ON: the user is short on Claude usage and wants work pushed to Codex. Delegate anything " +
          "you can specify completely, and treat delegating as the default rather than the exception. Still review " +
          "what comes back, and still keep decisions and anything needing conversation context yourself."
        : "";
      return {
        tools: TOOLS.filter((tool) => !REMOTE_MODE || REMOTE_WRITES || !tool.requiresWrites).map(({ name, description, inputSchema }) => ({
          name,
          description: description + conserve,
          inputSchema,
        })),
      };
    }

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) throw new Error(`unknown tool: ${msg.params?.name}`);
      if (REMOTE_MODE && !REMOTE_WRITES && tool.requiresWrites) {
        return {
          content: [{ type: "text", text: `${tool.name} is disabled because remote writes are off.` }],
          isError: true,
        };
      }

      if (DEPTH > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "Refused: recursion guard. The agent you are about to call is the one that called you. " +
                "Finish the task yourself and report back.",
            },
          ],
          isError: true,
        };
      }

      const args = msg.params?.arguments || {};
      const required = tool.inputSchema.required?.[0];
      if (required && !args[required]) throw new Error(`${required} is required`);

      // If this peer has already failed twice, stop trying. Whatever the cause,
      // it is not going to fix itself mid-session, and each attempt costs the
      // caller a wait plus a wasted message.
      if (!tool.local && failures[tool.peer] >= MAX_FAILURES) {
        return {
          content: [
            {
              type: "text",
              text:
                `${tool.peer} has failed ${failures[tool.peer]} times in this session, so this tool has stopped ` +
                `calling it. Do the work yourself and tell the user that ${tool.peer} is unavailable. ` +
                `Do not call ${tool.name} again unless they ask you to.`,
            },
          ],
          isError: true,
        };
      }

      log(`${tool.name} (depth ${DEPTH})`);
      const startedAt = Date.now();
      const chosen = resolveEffort(tool.peer === "Codex" ? "codex" : "claude", args.effort);
      const r = await tool.run(args);
      const seconds = Math.round((Date.now() - startedAt) / 1000);

      if (!tool.local) {
        if (r.ok) failures[tool.peer] = 0;
        else failures[tool.peer] += 1;
      }
      log(`${tool.name} ${r.ok ? "ok" : "FAILED"} in ${seconds}s, ${r.text.length} chars`);

      // On failure, say what probably went wrong and tell the caller what to do
      // about it. Left to itself a model will usually just try again.
      const hint = r.ok ? "" : diagnose(r.raw || r.text);
      const advice = r.ok
        ? ""
        : `\n\n${tool.peer} did not complete${hint ? `: ${hint}` : ""}. ` +
          `Carry on without it and tell the user. Do not retry more than once.`;

      // The Claude desktop app gives an extension no way to draw UI, so the tool
      // result is the only surface there. One compact line, not a dashboard.
      const usage = tool.peer === "Codex" && !tool.local ? codexUsageCached() : null;
      const modelShown = args.model || chosen.model || "CLI default";
      const footer = [
        tool.name,
        chosen.tier,
        `model ${modelShown}`,
        `${seconds}s`,
        usage ? usageLine(usage) : null,
      ]
        .filter(Boolean)
        .join(" · ");

      lastStatus = {
        at: new Date().toISOString(),
        tool: tool.name,
        peer: tool.peer,
        tier: chosen.tier,
        model: modelShown,
        seconds,
        ok: r.ok,
        conserve: conserveOn(),
        usage,
      };
      publishStatus(lastStatus);

      return { content: [{ type: "text", text: `${capped(r.text)}${advice}\n\n(${footer})` }], isError: !r.ok };
    }

    default:
      // -32601 is JSON-RPC "method not found". Hosts probe for optional methods
      // like resources/list, so this path is normal traffic, not a bug.
      return { __error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

// ---------------------------------------------------------------------------
// Transports
//
// stdio is the normal one: the host launches this file as a child process.
// HTTP exists only so the Claude mobile app can reach it, because a phone
// cannot launch a process on your laptop. Read the remote-mode section in
// README.md before turning it on. This endpoint can run commands on your machine,
// so keep it on loopback behind a separately authenticated tunnel.
// ---------------------------------------------------------------------------

let notifyToolsChanged = () => {};

function startStdio() {
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return log("ignored unparseable line");
    }
    try {
      const result = await requestScope.run(msg.id, () => handle(msg));
      if (result === null) return;
      if (result.__error) return send({ jsonrpc: "2.0", id: msg.id, error: result.__error });
      send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
    }
  });
  notifyToolsChanged = () => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

function startHttp() {
  // The secret lives in the URL path. This is a capability URL: whoever has it
  // can call the tools. It is not as good as real authentication, and it is here
  // because the connector UI gives us a URL field and nothing else. Put the
  // tunnel behind its own access control as well; do not treat this as enough.
  if (!REMOTE_SECRET || REMOTE_SECRET.length < 24) {
    log("refusing to start HTTP: set AGENT_BRIDGE_REMOTE_SECRET to at least 24 random characters");
    process.exit(1);
  }
  const expectedPath = `/mcp/${REMOTE_SECRET}`;

  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // timingSafeEqual so the comparison does not leak the secret one character
    // at a time to anyone willing to measure. Lengths must match first.
    const given = Buffer.from((req.url || "").split("?")[0]);
    const want = Buffer.from(expectedPath);
    const pathOk = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!pathOk) {
      log(`rejected request to ${(req.url || "").slice(0, 40)}`);
      return reply(404, { error: "not found" });
    }
    if (req.method !== "POST") return reply(405, { error: "use POST" });

    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 1_000_000) req.destroy(); // no reason for a huge request here
    });
    req.on("end", async () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      try {
        const result = await requestScope.run(msg.id, () => handle(msg));
        if (result === null) return reply(202, {});
        if (result.__error) return reply(200, { jsonrpc: "2.0", id: msg.id, error: result.__error });
        reply(200, { jsonrpc: "2.0", id: msg.id, result });
      } catch (e) {
        reply(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      }
    });
  });

  // Loopback by default. Reaching this from a phone is the tunnel's job, and a
  // tunnel you set up on purpose is a much smaller mistake than a port you left
  // open on a hotel wifi without noticing.
  server.listen(REMOTE_PORT, REMOTE_HOST, () => {
    log(`http listening on ${REMOTE_HOST}:${REMOTE_PORT}${expectedPath}`);
    log(`remote writes: ${REMOTE_WRITES ? "ENABLED" : "disabled (delegations run read-only)"}`);
  });
}

// Conserve mode can be flipped from outside while a host is connected, so watch
// for it and tell the host its tool list changed. Hosts that ignore the
// notification pick the change up on the next session instead.
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.watch(STATE_DIR, (_event, filename) => {
    if (filename === "conserve") {
      log(`conserve mode ${conserveOn() ? "on" : "off"}`);
      notifyToolsChanged();
    }
  });
} catch {
  // Watching is a convenience. If the platform will not do it, the next session
  // still gets the right descriptions.
}

if (REMOTE_MODE) startHttp();
else startStdio();

// Warm the cache on startup, in the background, so the first tool call of a
// session already has a usage figure instead of the second.
refreshUsage();

log(
  `ready (depth ${DEPTH}, ask ${ASK_TIMEOUT_MS / 1000}s, delegate ${DELEGATE_TIMEOUT_MS / 1000}s, ` +
    `conserve ${conserveOn() ? "on" : "off"}, ${REMOTE_MODE ? "http" : "stdio"}, ${process.platform})`
);
