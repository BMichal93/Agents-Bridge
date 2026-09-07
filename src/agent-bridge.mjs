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
import { StringDecoder } from "node:string_decoder";

const IS_WINDOWS = process.platform === "win32";
const SERVER_VERSION = "0.9.9";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

// Questions come back in a minute or two. Real work takes longer, so the two
// paths get separate budgets rather than one compromise value.
const ASK_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_TIMEOUT_MS) || 300_000;
const DELEGATE_TIMEOUT_MS = Number(process.env.AGENT_BRIDGE_DELEGATE_TIMEOUT_MS) || 1_800_000;

// Everything this server returns lands in the calling agent's context window and
// stays there for the rest of the session. Offloading work to the other agent
// only pays for itself if what comes back is small, so a verbose reply gets cut
// rather than quietly costing you the savings you delegated for.
const MAX_REPLY_CHARS = Number(process.env.AGENT_BRIDGE_MAX_REPLY_CHARS) || 6000;
// Child output is bounded while the process is running, not only when its final
// reply is formatted. A noisy or malicious peer must not be able to exhaust the
// host process before MAX_REPLY_CHARS gets a chance to trim the answer.
const MAX_PROCESS_OUTPUT_CHARS = positiveInt(process.env.AGENT_BRIDGE_MAX_PROCESS_OUTPUT_CHARS, 1_000_000, 10_000_000);

// Neither CLI is told which model to use unless you say so here. Read-only
// calls isolate user configuration and may therefore use built-in defaults.
// Setting these lets you
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
const REMOTE_MODE = process.argv.includes("--http") || process.env.AGENT_BRIDGE_HTTP === "1";
const REMOTE_SECRET = process.env.AGENT_BRIDGE_REMOTE_SECRET || "";
const REMOTE_PORT = process.env.AGENT_BRIDGE_HTTP_PORT === "0" ? 0 : Number(process.env.AGENT_BRIDGE_HTTP_PORT) || 7333;
const REMOTE_HOST = process.env.AGENT_BRIDGE_HTTP_HOST || "127.0.0.1";
const REMOTE_WRITES = process.env.AGENT_BRIDGE_REMOTE_WRITES === "1";
const HTTP_ALLOWED_ORIGINS = new Set(
  (process.env.AGENT_BRIDGE_HTTP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

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
  // the working-tree report, which is appended last). The middle is narration.
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
const cancelledRequests = new Set();
const activeRequests = new Set();
const requestCancelled = () => cancelledRequests.has(requestScope.getStore());

function trackChild(child) {
  liveChildren.add(child);
  const requestId = requestScope.getStore();
  if (requestId === undefined) return;
  if (cancelledRequests.has(requestId)) {
    killTree(child);
    return;
  }
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
  // Ignore unknown/already-finished IDs; cancellation notifications must not
  // retain arbitrary IDs forever or poison a later request using the same ID.
  if (requestId === undefined || !activeRequests.has(requestId)) return;
  cancelledRequests.add(requestId);
  const children = requestChildren.get(requestId) || [];
  for (const child of children) {
    try {
      killTree(child);
    } catch {}
  }
  requestChildren.delete(requestId);
}

function clearRequest(requestId) {
  if (requestId === undefined) return;
  activeRequests.delete(requestId);
  requestChildren.delete(requestId);
  cancelledRequests.delete(requestId);
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

function codexEventCapture() {
  const fallback = boundedBuffer(MAX_PROCESS_OUTPUT_CHARS);
  const errors = boundedBuffer(Math.min(MAX_PROCESS_OUTPUT_CHARS, 20_000), 0);
  let answer = "";
  let pending = "";
  let droppingLine = false;
  let sessionId = null;
  let sawJsonEvent = false;
  let failed = false;
  const eventLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") return;
      sawJsonEvent = true;
      if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        answer = event.item.text;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        failed = true;
        const detail = event.error?.message || event.message || event.error;
        if (detail) errors.append((typeof detail === "string" ? detail : JSON.stringify(detail)) + "\n");
      }
    } catch {
      // Older Codex releases and test doubles may still emit plain text.
    }
  };
  return {
    append(chunk) {
      fallback.append(chunk);
      for (const [index, part] of chunk.split("\n").entries()) {
        if (index) {
          if (!droppingLine) eventLine(pending);
          pending = "";
          droppingLine = false;
        }
        if (droppingLine) continue;
        if (pending.length + part.length > MAX_PROCESS_OUTPUT_CHARS) {
          // Cannot safely classify a truncated JSON event. Fail closed instead
          // of pretending it was progress and potentially dropping an error.
          failed = true;
          errors.append("Codex event exceeded the process-output limit.\n");
          pending = "";
          droppingLine = true;
        } else pending += part;
      }
    },
    result() {
      if (!droppingLine) eventLine(pending);
      if (!sawJsonEvent && !failed) return { text: fallback.text().trim(), sessionId: null, failed: false, errors: "" };
      if (!answer.trim() && !failed) errors.append("Codex returned no final message.\n");
      return { text: answer.trim() || errors.text().trim(), sessionId,
        failed: failed || !answer.trim(), errors: errors.text().trim() };
    },
  };
}

function boundedBuffer(limit, headRatio = 0.25) {
  const headLimit = Math.floor(limit * headRatio);
  const tailLimit = limit - headLimit;
  let head = "";
  let tail = "";
  let total = 0;

  return {
    append(chunk) {
      let text = String(chunk);
      total += text.length;
      if (head.length < headLimit) {
        const take = Math.min(headLimit - head.length, text.length);
        head += text.slice(0, take);
        text = text.slice(take);
      }
      if (text && tailLimit) tail = (tail + text).slice(-tailLimit);
    },
    text() {
      if (total <= limit) return head + tail;
      return `${head}\n[... ${total - limit} process-output characters trimmed by agent-bridge ...]\n${tail}`;
    },
  };
}

function runAgent(bin, args, prompt, cwd, timeoutMs, { codexJson = false } = {}) {
  return new Promise((resolve) => {
    if (shuttingDown || requestCancelled()) return resolve({ ok: false, text: "Agent call cancelled before starting." });
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

    // Parse Codex events incrementally so trimming cannot erase a failure.
    // Plain-text peers keep head/tail output; stderr keeps its diagnostic tail.
    const out = codexJson ? codexEventCapture() : boundedBuffer(MAX_PROCESS_OUTPUT_CHARS, 0.25);
    const err = boundedBuffer(Math.min(MAX_PROCESS_OUTPUT_CHARS, 200_000), 0);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let hasStdout = false;
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

    child.stdout.on("data", (d) => { hasStdout ||= d.length > 0; out.append(stdoutDecoder.write(d)); });
    child.stderr.on("data", (d) => err.append(stderrDecoder.write(d)));
    child.on("error", (e) => finish({ ok: false, text: `(could not start ${bin}: ${e.message})`, raw: e.message }));
    child.on("close", (code, signal) => {
      out.append(stdoutDecoder.end());
      err.append(stderrDecoder.end());
      const parsed = codexJson ? out.result() : { text: out.text().trim(), sessionId: null, failed: false, errors: "" };
      const stderrTail = err.text().trim().split("\n").slice(-12).join("\n");
      const ok = code === 0 && !signal && !parsed.failed;
      if (ok && parsed.text) return finish({ ok: true, text: parsed.text, sessionId: parsed.sessionId });

      const reason = signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`;
      const details = [parsed.text, parsed.errors, stderrTail].filter(Boolean).join("\n");
      finish({
        ok: false,
        text: `(${bin} ${reason})${details ? `\n${details}` : ""}`,
        raw: [parsed.errors, stderrTail].filter(Boolean).join("\n") || details,
        sessionId: parsed.sessionId,
        exitCode: code,
        signal,
        hasStdout,
        stderr: err.text(),
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
function readGit(cwd, args) {
  return new Promise((resolve) => {
    if (shuttingDown || requestCancelled()) return resolve(null);
    const base = cwd || DEFAULT_CWD || process.cwd();
    const file = IS_WINDOWS ? process.env.ComSpec || "cmd.exe" : "git";
    const gitArgs = ["-c", "core.fsmonitor=false", ...args];
    const argv = IS_WINDOWS ? ["/d", "/s", "/c", "git", ...gitArgs] : gitArgs;
    const child = spawn(file, argv, { cwd: base, stdio: ["ignore", "pipe", "ignore"],
      detached: !IS_WINDOWS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    trackChild(child);
    child.stdout.setEncoding("utf8");
    let out = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      untrackChild(child);
      resolve(value);
    };
    child.stdout.on("data", (d) => {
      out += d;
      // A repository with millions of unignored files should not take its MCP
      // host down. Reporting unavailable is safer than retaining unbounded data.
      if (out.length > 5_000_000) {
        killTree(child);
        finish(null);
      }
    });
    child.on("error", () => finish(null)); // not a git repo, or no git: skip silently
    child.on("close", (code) => finish(code === 0 ? out : null));
    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, 10_000);
  });
}

async function gitSnapshot(cwd) {
  const root = await readGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  // Porcelain paths are relative to the repository root, NOT the caller's cwd.
  const base = root.replace(/\r?\n$/, "");
  const raw = await readGit(base, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  return raw === null ? null : snapshotEntries(base, raw);
}

function gitPathDisplay(value) {
  return /[\0-\x20\x7f]/.test(value) ? JSON.stringify(value) : value;
}

function fileFingerprint(base, relative) {
  const file = path.resolve(base, relative);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    if (!stat.isFile()) return `other:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    // Hash ordinary source files so a second edit to an already-dirty path is
    // visible. Large generated files use metadata to keep snapshots bounded.
    if (stat.size <= 2_000_000) {
      return `sha256:${stat.mode}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
    }
    return `large:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return "missing";
  }
}

function snapshotEntries(base, raw) {
  const records = raw.split("\0");
  const entries = new Map();
  for (let i = 0; i < records.length; ) {
    const record = records[i++];
    if (!record || record[0] === "#" || record[0] === "!") continue;
    // Porcelain v2 carries index object IDs and modes, so staging-only changes
    // remain visible even when both XY and the on-disk content are unchanged.
    const fields = { "1": 8, "2": 9, u: 10 }[record[0]];
    const match = fields ? record.match(new RegExp(`^((?:[^ ]+ ){${fields}})([\\s\\S]*)$`)) : null;
    if (!match && !record.startsWith("? ")) continue;
    const metadata = match ? match[1] : "? ";
    const status = match ? metadata.split(" ")[1].replace(/\./g, " ") : "??";
    const target = match ? match[2] : record.slice(2);
    const source = record[0] === "2" ? records[i++] || "" : "";
    const key = IS_WINDOWS ? target.toLowerCase() : target;
    entries.set(key, {
      status,
      target,
      source,
      fingerprint: `${metadata}\0${source}\0${fileFingerprint(base, target)}`,
      display: `${status} ${gitPathDisplay(target)}${source ? ` <- ${gitPathDisplay(source)}` : ""}`,
    });
  }
  return { entries };
}

// Everything this returns is spent from the caller's context window on every
// delegation, so it reports the delta rather than two full listings. A repo that
// was already dirty with thirty files used to reprint all thirty twice per call,
// which is a lot of tokens to say "nothing new here".
const MAX_STATUS_LINES = Number(process.env.AGENT_BRIDGE_MAX_STATUS_LINES) || 40;

function formatGitSummary(before, after) {
  if (after === null) return "(no git status available: not a git repository, or git is not on PATH)";
  const beforeEntries = before?.entries || new Map();
  const afterEntries = after.entries;
  const observed = [];
  let carried = 0;

  for (const [key, entry] of afterEntries) {
    const prior = beforeEntries.get(key);
    if (!prior || prior.status !== entry.status || prior.fingerprint !== entry.fingerprint) observed.push(entry.display);
    else carried++;
  }
  for (const [key, entry] of beforeEntries) {
    if (!afterEntries.has(key)) observed.push(`cleared: ${entry.display}`);
  }

  const caveat = carried
    ? `\n${carried} entr${carried === 1 ? "y was" : "ies were"} already present before this delegation and remained unchanged; omitted.`
    : "";

  if (!observed.length) {
    if (!afterEntries.size && !beforeEntries.size) return "working tree after delegation: clean";
    return `no working-tree changes detected during this delegation.${caveat}`;
  }

  const shown = observed.slice(0, MAX_STATUS_LINES);
  const hidden = observed.length - shown.length;
  return (
    `working-tree changes observed during this delegation (${observed.length}):\n${shown.join("\n")}` +
    (hidden ? `\n... and ${hidden} more (raise AGENT_BRIDGE_MAX_STATUS_LINES to see them)` : "") +
    caveat
  );
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
    // Read-only workspace sandbox plus user-config/execpolicy isolation. These
    // flags do not promise to override managed policy or sandbox external tools.
    ...(!write ? ["--ephemeral", "--ignore-user-config", "--ignore-rules"] : []),
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

async function delegateToCodexUnlocked({ task, files, constraints, acceptance, verify: verifyCommand, cwd, model, effort, allow_writes, lane }) {
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
  const verify = verifyCommand
    ? REMOTE_MODE && (!REMOTE_WRITES || allow_writes === false)
      ? { ran: false, text: "verify skipped: remote writes are disabled, so host commands are not allowed" }
      : !r.ok
      ? { ran: false, text: "verify skipped: Codex did not complete successfully" }
      : await runVerify(verifyCommand, cwd)
    : null;
  // Verification can generate files too. Report the tree actually returned to
  // the caller, not a snapshot from before its check command ran.
  const after = await gitSnapshot(cwd);
  const diff = formatGitSummary(before, after);

  // Verdict first, then what changed, then the builder's own words last. The
  // caller should be able to stop reading after two lines when it passed.
  const parts = [];
  if (verify) parts.push(verify.text);
  parts.push(diff);
  if (!verify) parts.push("No verify command was given, so nothing here confirms the change works. Inspect the working tree.");
  parts.push(`codex said:\n${r.text}`);
  return { ...r, peerOk: r.ok, ok: r.ok && (!verify || (verify.ran && verify.ok)), text: parts.join("\n\n") };
}

async function delegateToCodex(spec) {
  validateLane(spec.lane);
  return withLaneLock(spec.lane, spec.cwd, () => delegateToCodexUnlocked(spec));
}

// Two kinds of flag, and the difference decides what happens when one is
// rejected.
//
// Required flags carry the read-only guarantee. If the installed Claude Code
// does not know one of them, the guarantee cannot be established, and quietly
// running anyway would leave ask_claude looking read-only while it is not.
// That is the exact failure the --tools fix existed to remove, so these fail
// loudly instead.
//
// Optional flags are hygiene. --no-session-persistence only stops a session
// file being written; --restricted and --bare already do the isolation work.
// It is also the flag most likely to be rejected: it has been removed from the
// CLI at least once and shipped as a no-op in at least one release. Losing a
// tidy-up is not worth losing the tool for the rest of the session, so a
// rejection of one of these is retried without it and reported.
const CLAUDE_OPTIONAL_FLAGS = new Set(["--no-session-persistence"]);

/** Recognize an anchored parser diagnostic, not a quotation in an answer. */
function rejectedFlag(text = "") {
  const m = text.match(/^\s*(?:error:\s*)?(?:unknown|unrecognized|unexpected)\s+(?:option|flag|argument)[:\s]+['"`“‘]?(--?[A-Za-z0-9][-A-Za-z0-9]*)(?=['"`”’\s]|$)/i);
  return m ? m[1] : null;
}

async function askClaude({ question, cwd, model, effort }) {
  // --tools, not --allowedTools. They look interchangeable and are not:
  // --allowedTools only skips the permission prompt for the tools it names, and
  // it appends to Claude Code's default tool set rather than replacing it, so a
  // run started that way still has Edit, Write and Bash available. --tools is
  // the flag that decides which built-in tools exist at all. Restricted and bare
  // modes additionally remove settings, hooks, plugins, skills, memory and MCP.
  // `npm run doctor` exercises this exact argument combination against the
  // installed CLI because a help listing alone is not authoritative.
  const chosen = resolveEffort("claude", effort);
  const args = [
    // Restricted confines file reads to the working directories and ignores
    // user/project settings. Bare skips hooks, plugins, MCP, skills and memory.
    // The explicit tool lists remain defense in depth and document the contract.
    "--restricted",
    "--bare",
    "--no-session-persistence",
    "-p",
    "--tools",
    "Read,Grep,Glob",
    "--disallowedTools",
    "mcp__*",
    ...modelArgs("--model", model, chosen.model || CLAUDE_MODEL),
  ];

  const prompt = askFrame(question);
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  const first = await runAgent(CLAUDE_BIN, args, prompt, cwd, ASK_TIMEOUT_MS);
  if (first.ok) return first;

  // Only a pre-execution parser failure may retry. Partial answers, signals,
  // timeouts and runtime failures must never replay a potentially costly task.
  const flag = [1, 2].includes(first.exitCode) && !first.signal && !first.hasStdout
    ? rejectedFlag(first.stderr) : null;
  if (!flag) return first;

  if (!CLAUDE_OPTIONAL_FLAGS.has(flag)) {
    return {
      ...first,
      ok: false,
      text:
        `Claude Code rejected ${flag}, which is ${["--restricted", "--bare", "--tools", "--disallowedTools"].includes(flag) ? "part of ask_claude's read-only guarantee" : "a required CLI argument"}, so the call was not retried. ` +
        `--restricted requires Claude Code 2.1.248 or newer; check \`claude --version\` and upgrade. ` +
        `Answer from your own knowledge and tell the user ask_claude is unavailable on this machine.\n\n${first.text}`,
    };
  }

  const retryArgs = args.filter((a) => a !== flag);
  const remaining = deadline - Date.now();
  if (remaining <= 0 || requestCancelled()) return first;
  const second = await runAgent(CLAUDE_BIN, retryArgs, prompt, cwd, remaining);
  const note = `(agent-bridge: this Claude Code does not accept ${flag}; retried without it. The read-only flags were unaffected.)`;
  return { ...second, text: `${note}\n\n${second.text}` };
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
const SAFE_LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const laneLocks = new Map();

function validateLane(lane) {
  if (lane !== undefined && lane !== "" && (typeof lane !== "string" || !SAFE_LANE.test(lane))) {
    throw new Error("lane must be 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number");
  }
}

function loadLanes() {
  try {
    return JSON.parse(fs.readFileSync(LANES_FILE, "utf8"));
  } catch {
    return {};
  }
}

const laneScope = (cwd) => {
  const scope = path.resolve(cwd || DEFAULT_CWD || process.cwd());
  return IS_WINDOWS ? scope.toLowerCase() : scope;
};

async function withLaneLock(lane, cwd, work) {
  if (!lane) return work();
  const key = `${laneScope(cwd)}\0${lane}`;
  const prior = laneLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const tail = prior.then(() => gate);
  laneLocks.set(key, tail);
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (laneLocks.get(key) === tail) laneLocks.delete(key);
  }
}

function loadLane(lane, cwd) {
  const saved = loadLanes();
  return saved.scopes?.[laneScope(cwd)]?.[lane] || null;
}

function saveLane(lane, sessionId, cwd) {
  let temporary = "";
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const lanes = loadLanes();
    if (!lanes.scopes || typeof lanes.scopes !== "object") lanes.scopes = {};
    const scope = laneScope(cwd);
    if (!lanes.scopes[scope] || typeof lanes.scopes[scope] !== "object") lanes.scopes[scope] = {};
    lanes.scopes[scope][lane] = { sessionId, at: Date.now() };
    temporary = `${LANES_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(lanes, null, 2));
    fs.renameSync(temporary, LANES_FILE);
  } catch {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
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
// spawning a fixed CLI. The allowlist constrains the entry executable, but it is
// not a sandbox: npm scripts, npx and language runtimes can execute arbitrary
// trusted repository code with this user's privileges.
// ---------------------------------------------------------------------------

const VERIFY_ALLOWLIST = (process.env.AGENT_BRIDGE_VERIFY_ALLOW || "npm,npx,pnpm,yarn,dotnet,pytest,python,go,cargo,make,mvn,gradle,jest,vitest,tsc,eslint")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function splitCommandLine(command) {
  const parts = [];
  let value = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && command[i + 1] === '"') {
        value += '"';
        i++;
      } else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        parts.push(value);
        value = "";
        started = false;
      }
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) return { error: "verify skipped: command contains an unclosed quote" };
  if (started) parts.push(value);
  return { parts };
}

function runVerify(command, cwd) {
  return new Promise((resolve) => {
    const parsed = splitCommandLine(command.trim());
    if (parsed.error) return resolve({ ran: false, text: parsed.error });
    const parts = parsed.parts;
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
    const out = boundedBuffer(Math.min(MAX_PROCESS_OUTPUT_CHARS, 200_000), 0);
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
    child.stdout.on("data", (d) => out.append(d));
    child.stderr.on("data", (d) => out.append(d));
    child.on("error", (e) => finish({ ran: false, text: `verify could not start: ${e.message}` }));
    child.on("close", (code) => {
      const tail = out.text().trim().split("\n").slice(-15).join("\n");
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
// Run independent builds alongside the caller's coordination work.
// Start work, keep planning, collect later.
// ---------------------------------------------------------------------------

const jobs = new Map();
let jobCounter = 0;
const pendingJobs = [];
const runningClaims = new Map();
const runningLanes = new Set();
const MAX_CONCURRENT_JOBS = positiveInt(process.env.AGENT_BRIDGE_MAX_CONCURRENT_JOBS, 4, 32);
const MAX_JOBS_PER_CALL = positiveInt(process.env.AGENT_BRIDGE_MAX_JOBS_PER_CALL, 8, 64);
const MAX_OUTSTANDING_JOBS = positiveInt(process.env.AGENT_BRIDGE_MAX_OUTSTANDING_JOBS, 64, 512);

const claimPath = (base, file) => {
  const resolved = path.resolve(base, file);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
};

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
  return declared.map((file) => claimPath(base, file));
}

function claimsOverlap(left, right) {
  if (left.includes("*") || right.includes("*")) return true;
  return left.some((a) =>
    right.some((b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
  );
}

function canStart(job) {
  if (runningClaims.size >= MAX_CONCURRENT_JOBS) return false;
  if (job.laneKey && runningLanes.has(job.laneKey)) return false;
  return ![...runningClaims.values()].some((claims) => claimsOverlap(job.claims, claims));
}

function launchJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  runningClaims.set(job.id, job.claims);
  if (job.laneKey) runningLanes.add(job.laneKey);
  // A background job outlives the start_codex_jobs request by design. Detach it
  // from that request's cancellation scope; host shutdown still kills it.
  requestScope.run(undefined, () => {
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
        if (job.laneKey) runningLanes.delete(job.laneKey);
        job.resolve(job);
        pumpQueue();
      }
    })();
  });
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
  validateLane(spec.lane);
  const id = `job-${++jobCounter}`;
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  const job = {
    id,
    task: spec.task.slice(0, 80),
    status: "queued",
    spec,
    claims: claimsFor(spec),
    laneKey: spec.lane ? `${laneScope(spec.cwd)}\0${spec.lane}` : "",
    promise,
    resolve,
  };
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
      child = spawn(file, argv, { stdio: ["pipe", "pipe", "ignore"], detached: !IS_WINDOWS });
      trackChild(child);
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
      untrackChild(child);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 8000);
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 200_000) return finish(null);
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

function readTail(file, maximum = 2_000_000) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maximum);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
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
      lines = readTail(f.full).split("\n");
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
  requestScope
    .run(undefined, () => usageFromAppServer())
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
    "the bridge's configured model mapping or the CLI default when no mapping is set.",
};

const DELEGATION_INSTRUCTIONS =
  "Prefer OpenAI Codex for tool-based subagent work: ask_codex for read-only reviews, " +
  "delegate_to_codex for one implementation, or start_codex_jobs and collect_codex_jobs for background builds. " +
  "This bridge uses the local Codex CLI, not an existing ChatGPT conversation. Keep coordination and final " +
  "review with the caller. Use ask_claude when the user specifically requests Claude or a Claude-specific " +
  "perspective is needed; do not automatically switch providers on failure. Respect explicit user choices.";

const TOOLS = [
  {
    name: "ask_codex",
    peer: "Codex",
    description:
      "Preferred tool for delegated read-only analysis and reviews: ask OpenAI Codex a self-contained question. " +
      "It inspects code but does not edit the workspace. " +
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
      "Preferred tool for a single implementation subagent task: OpenAI Codex edits files in the workspace and reports " +
      "back. This is the builder half of the split: you decide the design, Codex writes the code. Use it for anything " +
      "you can specify completely, which is most implementation once the approach is settled. Keep design decisions, " +
      "anything needing conversation context, and review for yourself. Give a `verify` command whenever the repo has " +
      "one: the result comes back verdict first; assess acceptance criteria and review relevant changes before accepting. " +
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
            "Codex finishes and reports pass or fail. Give one whenever the repository has one. A pass confirms " +
            "only that command's checks; assess acceptance criteria and review the relevant changes too.",
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
      "with collect_codex_jobs when you are ready. Continue useful coordination work while these jobs run.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_JOBS_PER_CALL,
          // Short descriptions here on purpose. The full field guidance is on
          // delegate_to_codex, and repeating all of it costs several hundred
          // tokens in every session for a reader who has already seen it.
          description:
            "The pieces to build. Each entry takes the same fields as delegate_to_codex and must be a complete handoff " +
            "on its own. Declare `files` accurately: it is what decides which jobs may run at the same time.",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "What to build, as in delegate_to_codex." },
              files: {
                type: "string",
                description:
                  "Files or directories this job touches, separated by commas, newlines or spaces. Two jobs whose " +
                  "paths overlap are run one after the other. Omitting this claims the whole workspace.",
              },
              constraints: { type: "string", description: "What not to do." },
              acceptance: { type: "string", description: "How to tell it is done, in words." },
              verify: { type: "string", description: "Command proving the work, run after Codex finishes." },
              cwd: CWD_PROP,
              lane: { type: "string", description: "Thread of related builds, as in delegate_to_codex." },
              effort: EFFORT_PROP,
              model: MODEL_PROP,
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },
    run: async ({ tasks }) => {
      if (!Array.isArray(tasks) || !tasks.length) throw new Error("tasks must be a non-empty array");
      if (tasks.length > MAX_JOBS_PER_CALL) throw new Error(`at most ${MAX_JOBS_PER_CALL} jobs may be started in one call`);
      if (jobs.size + tasks.length > MAX_OUTSTANDING_JOBS) {
        throw new Error(`too many outstanding jobs; collect existing jobs before exceeding ${MAX_OUTSTANDING_JOBS}`);
      }
      for (const [index, task] of tasks.entries()) {
        if (!task || typeof task.task !== "string" || !task.task.trim()) throw new Error(`tasks[${index}].task is required`);
        validateLane(task.lane);
      }
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
      if (ids !== undefined && !Array.isArray(ids)) throw new Error("ids must be an array");
      const missing = ids?.filter((id) => !jobs.has(id)) || [];
      if (missing.length) throw new Error(`unknown job id${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
      const wanted = ids?.length ? ids.map((id) => jobs.get(id)) : [...jobs.values()];
      if (!wanted.length) return { ok: true, text: "No outstanding Codex jobs." };
      const settled = await Promise.all(wanted.map((j) => j.promise));
      if (requestCancelled()) return { ok: false, text: "Collection cancelled; job results remain available for a later collect." };
      settled.forEach((j) => jobs.delete(j.id));
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
      "Ask Claude Code for a read-only review when the user specifically requests Claude or a Claude-specific " +
      "perspective is needed. Prefer ask_codex for other delegated reviews. Do not use this as an automatic " +
      "fallback after Codex failure.",
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

const PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

function requestProtocol(msg) {
  return msg?.params?._meta?.[PROTOCOL_META_KEY] || "";
}

function isModernRequest(msg) {
  return requestProtocol(msg) === MODERN_PROTOCOL_VERSION;
}

function modernizeResult(msg, result) {
  if (!isModernRequest(msg) || !result || result.__error || msg.method === "initialize") return result;
  const modern = {
    resultType: "complete",
    ...result,
    _meta: { ...(result._meta || {}), [SERVER_INFO_META_KEY]: { name: "agent-bridge", version: SERVER_VERSION } },
  };
  if (msg.method === "tools/list") {
    modern.ttlMs = 0;
    modern.cacheScope = "private";
  }
  return modern;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (id) => typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
const rpcError = (code, message) => ({ __error: { code, message } });

function validateRequest(msg) {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" ||
      (msg.id !== undefined && !validId(msg.id))) {
    return rpcError(-32600, "invalid JSON-RPC request");
  }
  if (msg.params !== undefined && !isObject(msg.params)) return rpcError(-32602, "params must be an object");
  return null;
}

// Validate every declared field before tools run. In particular, a bad second
// job must not throw after the first one has already been accepted and launched.
function validateArguments(value, schema, label = "arguments") {
  if (schema.type === "object") {
    if (!isObject(value)) return `${label} must be an object`;
    for (const key of schema.required || []) {
      if (value[key] === undefined || (typeof value[key] === "string" && !value[key].trim())) return `${label}.${key} is required`;
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) continue;
      const error = validateArguments(value[key], child, `${label}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${label} must be an array`;
    if (schema.minItems && value.length < schema.minItems) return `${label} must be a non-empty array`;
    if (schema.maxItems && value.length > schema.maxItems) return `${label} accepts at most ${schema.maxItems} jobs`;
    for (const [index, item] of value.entries()) {
      const error = validateArguments(item, schema.items, `${label}[${index}]`);
      if (error) return error;
    }
  } else if (typeof value !== schema.type) return `${label} must be a ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${label} must be one of ${schema.enum.join(", ")}`;
  return null;
}

async function handle(msg) {
  const invalid = validateRequest(msg);
  if (invalid) return invalid;
  const protocol = requestProtocol(msg);
  if (protocol && protocol !== MODERN_PROTOCOL_VERSION && !LEGACY_PROTOCOL_VERSIONS.includes(protocol)) {
    return {
      __error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS], requested: protocol },
      },
    };
  }
  if (msg.method === "notifications/cancelled") {
    cancelRequest(msg.params?.requestId);
    return null;
  }
  // Notifications have no id and expect no reply.
  if (msg.id === undefined) return null;

  switch (msg.method) {
    case "server/discover":
      return {
        resultType: "complete",
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: false } },
        instructions: DELEGATION_INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: "private",
        _meta: { [SERVER_INFO_META_KEY]: { name: "agent-bridge", version: SERVER_VERSION } },
      };

    case "initialize":
      return {
        // Legacy MCP negotiates by echoing a supported client version, otherwise
        // selecting one the server implements. Never claim an arbitrary version.
        protocolVersion: LEGACY_PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion)
          ? msg.params.protocolVersion
          : LEGACY_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "agent-bridge", version: SERVER_VERSION },
        instructions: DELEGATION_INSTRUCTIONS,
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

      const args = msg.params?.arguments ?? {};
      const argumentError = validateArguments(args, tool.inputSchema);
      if (argumentError) return rpcError(-32602, argumentError);

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
        // A bad repository check is not evidence that the peer CLI is broken.
        if (r.peerOk ?? r.ok) failures[tool.peer] = 0;
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
      const modelShown = args.model || chosen.model || (tool.peer === "Codex" ? CODEX_MODEL : CLAUDE_MODEL) || "CLI default";
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
  let modernClient = false;
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("rejected unparseable JSON-RPC line");
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const invalid = validateRequest(msg);
    if (invalid) return send({ jsonrpc: "2.0", id: validId(msg?.id) ? msg.id : null, error: invalid.__error });
    if (msg.id !== undefined) {
      if (activeRequests.has(msg.id)) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "duplicate active request id" } });
      activeRequests.add(msg.id);
    }
    try {
      if (isModernRequest(msg)) modernClient = true;
      const result = modernizeResult(msg, await requestScope.run(msg.id, () => handle(msg)));
      if (result === null) return;
      if (result.__error) return send({ jsonrpc: "2.0", id: msg.id ?? null, error: result.__error });
      send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: String(e.message || e) } });
    } finally {
      clearRequest(msg?.id);
    }
  });
  // Modern MCP delivers list changes only through an opted-in subscription.
  // This bridge has no subscription stream, and its modern tools/list TTL is 0.
  notifyToolsChanged = () => {
    if (!modernClient) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  };
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
    let completed = false;
    let disconnected = false;
    const requestToken = Symbol("http-request");
    const cleanupListeners = () => {
      req.socket.removeListener("close", onDisconnect);
      res.removeListener("close", onDisconnect);
    };
    const onDisconnect = () => {
      if (!completed) {
        disconnected = true;
        cancelRequest(requestToken);
      }
      cleanupListeners();
    };
    const reply = (code, body) => {
      if (completed || disconnected || res.writableEnded) return;
      completed = true;
      cleanupListeners();
      if (body === undefined) {
        res.writeHead(code);
        res.end();
      } else {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    // Remove both listeners on completion; keep-alive sockets serve many calls.
    // A unique token prevents cross-client collisions of JSON-RPC IDs.
    res.once("close", onDisconnect);
    req.socket.once("close", onDisconnect);
    req.on("error", onDisconnect);

    const origin = req.headers.origin;
    if (origin && !HTTP_ALLOWED_ORIGINS.has(origin)) {
      log("rejected request with disallowed Origin");
      return reply(403, { jsonrpc: "2.0", error: { code: -32000, message: "origin not allowed" } });
    }

    // timingSafeEqual so the comparison does not leak the secret one character
    // at a time to anyone willing to measure. Lengths must match first.
    const given = Buffer.from((req.url || "").split("?")[0]);
    const want = Buffer.from(expectedPath);
    const pathOk = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!pathOk) {
      log("rejected request with invalid capability URL");
      return reply(404, { error: "not found" });
    }
    if (req.method !== "POST") return reply(405, { error: "use POST" });

    const chunks = [];
    let bodyBytes = 0;
    let tooLarge = false;
    req.on("data", (d) => {
      bodyBytes += d.length;
      if (bodyBytes > 1_000_000) tooLarge = true;
      else chunks.push(d);
    });
    req.on("end", async () => {
      if (disconnected) return;
      if (tooLarge) {
        return reply(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } });
      }
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }

      const invalid = validateRequest(msg);
      if (invalid) return reply(400, { jsonrpc: "2.0", id: validId(msg?.id) ? msg.id : null, error: invalid.__error });

      const protocol = requestProtocol(msg);
      const protocolHeader = req.headers["mcp-protocol-version"];
      if (protocolHeader && ![MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS].includes(protocolHeader)) {
        return reply(400, { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32022, message: "Unsupported protocol version" } });
      }
      const methodHeader = req.headers["mcp-method"];
      const nameHeader = req.headers["mcp-name"];
      if (protocol === MODERN_PROTOCOL_VERSION || protocolHeader === MODERN_PROTOCOL_VERSION) {
        const decodeHeader = (value) => {
          if (typeof value !== "string") return null;
          const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
          if (!encoded) return value;
          try {
            return Buffer.from(encoded[1], "base64").toString("utf8");
          } catch {
            return null;
          }
        };
        const expectedName = msg.method === "tools/call" ? msg.params?.name : undefined;
        const mismatch =
          protocolHeader !== protocol ||
          methodHeader !== msg.method ||
          (expectedName !== undefined && decodeHeader(nameHeader) !== expectedName);
        if (mismatch) {
          return reply(400, {
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32020, message: "required MCP headers do not match the request body" },
          });
        }
      }

      try {
        activeRequests.add(requestToken);
        const result = modernizeResult(msg, await requestScope.run(requestToken, () => handle(msg)));
        if (result === null) return reply(202);
        if (result.__error) {
          const status = [-32022, -32600, -32602].includes(result.__error.code) ? 400 : isModernRequest(msg) && result.__error.code === -32601 ? 404 : 200;
          return reply(status, { jsonrpc: "2.0", id: msg.id, error: result.__error });
        }
        reply(200, { jsonrpc: "2.0", id: msg.id, result });
      } catch (e) {
        reply(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e.message || e) } });
      } finally {
        clearRequest(requestToken);
      }
    });
  });

  // Loopback by default. Reaching this from a phone is the tunnel's job, and a
  // tunnel you set up on purpose is a much smaller mistake than a port you left
  // open on a hotel wifi without noticing.
  server.listen(REMOTE_PORT, REMOTE_HOST, () => {
    log(`http listening on ${REMOTE_HOST}:${server.address().port}/mcp/[redacted]`);
    log(`remote writes: ${REMOTE_WRITES ? "ENABLED" : "disabled (delegations run read-only)"}`);
    log(`browser origins: ${HTTP_ALLOWED_ORIGINS.size ? [...HTTP_ALLOWED_ORIGINS].join(", ") : "none allowed"}`);
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
