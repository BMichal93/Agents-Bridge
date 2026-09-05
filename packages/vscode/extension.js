/**
 * Agent Bridge - VS Code extension.
 *
 * Two jobs:
 *
 * 1. Hand the bridge MCP server to VS Code's chat agent through
 *    registerMcpServerDefinitionProvider. This is the part that makes install
 *    and disable work the way you expect: VS Code starts and stops the server
 *    with the extension, so disabling the extension really does turn it off,
 *    and no config file anywhere on your machine is edited.
 *
 * 2. Optionally register the same server with the Codex and Claude Code CLIs,
 *    which have their own config and cannot be reached through the extension
 *    host. That part does write to their config, so it is opt-in and there is a
 *    command to undo it.
 */

const vscode = require("vscode");
const path = require("path");
const os = require("os");
const fs = require("fs");
const cp = require("child_process");

const SERVER_NAME = "agent-bridge";
const OFFERED_KEY = "agentBridge.offeredCliSetup";

const STATE_DIR = path.join(os.homedir(), ".agent-bridge");

/**
 * Where the server runs from.
 *
 * VS Code installs extensions into a version-stamped folder and deletes the old
 * one on update, so `.../mbudziszewski.agent-bridge-0.7.0/server/...` is a path
 * that breaks the next time this extension updates. VS Code itself is fine with
 * that because it asks us for the path each time it starts the server. The Codex
 * and Claude Code CLIs are not: they store whatever path they were given, so
 * pointing them at the extension folder would leave two silently broken configs
 * after every update.
 *
 * So the server is copied to a stable location on each activation, and that is
 * the path everything gets told about. Copying every time also means an extension
 * update actually updates the copy the CLIs use.
 */
function serverPath(context) {
  const bundled = path.join(context.extensionPath, "server", "agent-bridge.mjs");
  const stable = path.join(STATE_DIR, "agent-bridge.mjs");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.copyFileSync(bundled, stable);
    return stable;
  } catch {
    // If the copy fails, running from the extension folder is better than not
    // running at all. VS Code will still work; the CLIs may break on update.
    return bundled;
  }
}

/**
 * The delegation policy, installed as a Claude Code skill.
 *
 * The tools alone do not produce sensible delegation. A model that can see
 * `delegate_to_codex` still has to decide when reaching for it beats doing the
 * work, and without something written down it mostly does everything itself. As a
 * skill rather than a CLAUDE.md block, it loads when a task looks delegable
 * instead of costing context every session.
 */
const SKILL = `---
name: delegating-to-codex
description: Decide what to hand to OpenAI Codex and what to keep. Use when the agent-bridge tools (ask_codex, delegate_to_codex) are available and a task might be worth delegating - wide mechanical refactors, boilerplate, test scaffolding - or when the user asks to push work to Codex or save Claude usage.
---

## Working with Codex

**Delegate when** the work is mechanical and well specified, separable from what
you are doing, you can write it down completely, and - most important - the result
is cheap to check relative to the work. Delegating saves usage only when a lot of
work returns as something small you can verify: a passing test command, a diff
stat you can scan. Work that returns a large diff you then read line by line costs
about what writing it would have, plus the round trip.

Put a concrete command in \`acceptance\` and tell Codex to run it and report the
outcome, so you get a verdict instead of a diff to audit.

**Ask Codex** when you are genuinely uncertain about a design decision, stuck on a
bug after a real attempt, or it plausibly knows a library better than you.

**Keep it yourself** when it needs conversation context that would be lossy to
write out, when it is an architecture or product decision, when it is small enough
that you would finish it in the time a round trip takes, or when you are already
mid-change.

**After every delegation** read the \`git diff --stat\` that comes back. If it is
empty, nothing was written whatever the summary said. Read the actual diff of
anything you build on. Do not loop more than twice on one task.

**Say what you are doing** before a delegation: one line on what you are handing
off and what you are keeping, so the user can stop you.

**Do not delegate by default.** It is worth it less often than it sounds.
`;

const skillPath = () => path.join(os.homedir(), ".claude", "skills", "delegating-to-codex", "SKILL.md");

/** Config values, resolved fresh each time so changing a setting takes effect. */
function env() {
  const cfg = vscode.workspace.getConfiguration("agentBridge");
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  return {
    AGENT_BRIDGE_DEFAULT_CWD: cfg.get("defaultProject") || workspace,
    AGENT_BRIDGE_CONSERVE: cfg.get("conserveMode") ? "1" : "0",
    AGENT_BRIDGE_CODEX_BIN: cfg.get("codexPath") || "codex",
    AGENT_BRIDGE_CLAUDE_BIN: cfg.get("claudePath") || "claude",
  };
}

/** Run a CLI. Windows needs cmd.exe because both CLIs install as .cmd shims. */
function run(bin, args) {
  const isWindows = process.platform === "win32";
  const file = isWindows ? process.env.ComSpec || "cmd.exe" : bin;
  const argv = isWindows ? ["/d", "/s", "/c", bin, ...args] : args;
  const r = cp.spawnSync(file, argv, { encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

const cliInstalled = (bin) => run(bin, ["--version"]).ok;

function applyToClis(context, enable) {
  const cfg = vscode.workspace.getConfiguration("agentBridge");
  const target = serverPath(context);
  const done = [];
  const skipped = [];

  const hosts = [
    { label: "Codex", bin: cfg.get("codexPath") || "codex", add: ["mcp", "add", SERVER_NAME, "--", "node", target], remove: ["mcp", "remove", SERVER_NAME] },
    { label: "Claude Code", bin: cfg.get("claudePath") || "claude", add: ["mcp", "add", SERVER_NAME, "-s", "user", "--", "node", target], remove: ["mcp", "remove", SERVER_NAME, "-s", "user"] },
  ];

  for (const host of hosts) {
    if (!cliInstalled(host.bin)) {
      skipped.push(host.label);
      continue;
    }
    const r = run(host.bin, enable ? host.add : host.remove);
    // Removing something that was never there is a success from our side.
    if (r.ok || (!enable && /not found|no mcp server/i.test(r.out))) done.push(host.label);
    else skipped.push(`${host.label} (${r.out.split("\n").slice(-1)[0].slice(0, 80)})`);

    // Claude Code gets the delegation policy too. Without it the tools are
    // present but nothing tells Claude when to reach for them, which in practice
    // means it rarely does.
    if (host.label === "Claude Code") {
      try {
        if (enable) {
          fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
          fs.writeFileSync(skillPath(), SKILL);
        } else if (fs.existsSync(skillPath())) {
          fs.rmSync(path.dirname(skillPath()), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  const verb = enable ? "Enabled for" : "Removed from";
  if (done.length) vscode.window.showInformationMessage(`Agent Bridge: ${verb} ${done.join(" and ")}.`);
  if (skipped.length) vscode.window.showWarningMessage(`Agent Bridge: skipped ${skipped.join(", ")}.`);
}

/**
 * Status bar.
 *
 * The MCP server runs as a separate process that VS Code spawns, so it cannot
 * touch this UI directly. It writes a small state file after each call and this
 * watches it. That is the whole mechanism, and it is why the bar shows the last
 * run rather than live progress.
 */
function setUpStatusBar(context) {
  const stateFile = path.join(os.homedir(), ".agent-bridge", "status.json");
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  item.command = "agentBridge.showStatus";
  context.subscriptions.push(item);

  const render = () => {
    let s = null;
    try {
      s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {}

    const conserve = vscode.workspace.getConfiguration("agentBridge").get("conserveMode");
    if (!s) {
      item.text = conserve ? "$(arrow-swap) Bridge: conserve" : "$(arrow-swap) Bridge";
      item.tooltip = "Agent Bridge is loaded. Nothing delegated yet this session.";
      item.show();
      return;
    }

    // Show the tightest window, because that is the one that runs out first.
    const tight = s.usage?.windows?.slice().sort((a, b) => a.remaining - b.remaining)[0];
    item.text = tight
      ? `$(arrow-swap) Codex ${tight.label} ${tight.remaining}%${conserve ? " · conserve" : ""}`
      : `$(arrow-swap) Bridge${conserve ? " · conserve" : ""}`;

    const lines = [
      `Last: ${s.tool} (${s.tier}) on ${s.model}, ${s.seconds}s, ${s.ok ? "ok" : "failed"}`,
      s.usage
        ? `Codex usage: ${s.usage.windows.map((w) => `${w.label} ${w.remaining}% left`).join(", ")}` +
          `${s.usage.plan ? ` on ${s.usage.plan}` : ""}`
        : "Codex usage: unavailable",
      s.usage ? `Source: ${s.usage.source}, read ${new Date(s.usage.asOf).toLocaleString()}` : "",
      "",
      "Claude usage is not shown: no supported way to read it from a tool.",
      conserve ? "Conserve mode is ON - delegating is the default." : "Conserve mode is off.",
      "Click to change.",
    ].filter(Boolean);

    item.tooltip = lines.join("\n");
    // Warn only on the tightest window, and only when it is genuinely low.
    item.backgroundColor =
      tight && tight.remaining <= 10 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    item.show();
  };

  render();
  // fs.watch on the directory rather than the file: editors and writers often
  // replace files rather than modifying them, which breaks a watch on the path.
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const watcher = fs.watch(path.dirname(stateFile), (_e, name) => {
      if (name === "status.json") render();
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {}

  const poll = setInterval(render, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  return render;
}

function activate(context) {
  const changed = new vscode.EventEmitter();
  const renderStatus = setUpStatusBar(context);

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("agent-bridge.servers", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => [
        new vscode.McpStdioServerDefinition({
          label: "Agent Bridge",
          command: "node",
          args: [serverPath(context)],
          env: env(),
          version: context.extension.packageJSON.version,
        }),
      ],
    })
  );

  // A settings change alters the environment the server runs with, so tell VS
  // Code the definition is stale rather than leaving it on the old values until
  // the next window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentBridge")) {
        changed.fire();
        renderStatus();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentBridge.enableForClis", () => applyToClis(context, true)),
    vscode.commands.registerCommand("agentBridge.disableForClis", () => applyToClis(context, false)),
    vscode.commands.registerCommand("agentBridge.showStatus", async () => {
      const cfg = vscode.workspace.getConfiguration("agentBridge");
      const conserve = cfg.get("conserveMode");
      const pick = await vscode.window.showQuickPick(
        [
          { label: conserve ? "Turn conserve mode off" : "Turn conserve mode on", id: "conserve" },
          { label: "Enable for Codex and Claude Code", id: "enable" },
          { label: "Remove from Codex and Claude Code", id: "disable" },
          { label: "Open Agent Bridge settings", id: "settings" },
        ],
        { title: "Agent Bridge" }
      );
      if (pick?.id === "conserve") await vscode.commands.executeCommand("agentBridge.toggleConserve");
      if (pick?.id === "enable") applyToClis(context, true);
      if (pick?.id === "disable") applyToClis(context, false);
      if (pick?.id === "settings") vscode.commands.executeCommand("workbench.action.openSettings", "agentBridge");
    }),
    vscode.commands.registerCommand("agentBridge.toggleConserve", async () => {
      const cfg = vscode.workspace.getConfiguration("agentBridge");
      const next = !cfg.get("conserveMode");
      await cfg.update("conserveMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        next
          ? "Agent Bridge: conserve mode on. Delegating to Codex is now the default rather than the exception."
          : "Agent Bridge: conserve mode off."
      );
    })
  );

  // Offer the CLI setup once, on first activation, and never nag again. The
  // extension host reaches VS Code's own chat; the CLIs are separate programs
  // with separate config, so this is the only way to cover them, and writing to
  // another program's config without asking is not something to do quietly.
  if (!context.globalState.get(OFFERED_KEY)) {
    context.globalState.update(OFFERED_KEY, true);
    const present = [];
    const cfg = vscode.workspace.getConfiguration("agentBridge");
    if (cliInstalled(cfg.get("codexPath") || "codex")) present.push("Codex");
    if (cliInstalled(cfg.get("claudePath") || "claude")) present.push("Claude Code");
    if (present.length) {
      vscode.window
        .showInformationMessage(
          `Agent Bridge is active in VS Code. Also enable it for ${present.join(" and ")}?`,
          "Enable",
          "Not now"
        )
        .then((choice) => {
          if (choice === "Enable") applyToClis(context, true);
        });
    }
  }
}

// Nothing to tear down: VS Code stops the MCP server with the extension. The CLI
// entries are deliberately left alone, because deactivate also fires when you
// simply close the window, and silently unregistering then would be worse than
// leaving an entry you can remove with one command.
function deactivate() {}

module.exports = { activate, deactivate };
