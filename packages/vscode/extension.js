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

const serverPath = (context) => path.join(context.extensionPath, "server", "agent-bridge.mjs");

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
