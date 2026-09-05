import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRequire = createRequire(import.meta.url);

test("the VS Code provider creates a positional stdio server definition", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-vscode-test-"));
  let provider;
  const disposables = [];

  class EventEmitter {
    event = () => {};
    fire() {}
  }
  class McpStdioServerDefinition {
    constructor(...args) {
      this.argsReceived = args;
    }
  }

  const config = {
    get(key) {
      return { defaultProject: "", conserveMode: false, codexPath: "codex", claudePath: "claude" }[key];
    },
    update: async () => {},
  };
  const vscode = {
    EventEmitter,
    McpStdioServerDefinition,
    ThemeColor: class {},
    StatusBarAlignment: { Right: 2 },
    lm: {
      registerMcpServerDefinitionProvider(_id, value) {
        provider = value;
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: tempHome } }],
      getConfiguration: () => config,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: async () => {},
    },
    window: {
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: async () => "Not now",
      showWarningMessage: async () => {},
      showQuickPick: async () => undefined,
    },
  };

  const localRequire = (name) => {
    if (name === "vscode") return vscode;
    if (name === "os") return { ...os, homedir: () => tempHome };
    if (name === "fs") return { ...fs, watch: () => ({ close() {} }) };
    return realRequire(name);
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(root, "packages", "vscode", "extension.js"), "utf8");
  vm.runInNewContext(`(function(require, module, exports) { ${source}\n})`, {
    process,
    setInterval: () => 0,
    clearInterval: () => {},
  })(
    localRequire,
    module,
    module.exports
  );

  const context = {
    extensionPath: path.join(root, "packages", "vscode"),
    extension: { packageJSON: { version: "0.9.1" } },
    subscriptions: { push: (...items) => disposables.push(...items) },
    globalState: { get: () => true, update: async () => {} },
  };
  module.exports.activate(context);
  const [definition] = provider.provideMcpServerDefinitions();
  assert.equal(definition.argsReceived[0], "Agent Bridge");
  assert.equal(definition.argsReceived[1], process.execPath);
  assert.ok(Array.isArray(definition.argsReceived[2]));
  assert.equal(definition.argsReceived[4], "0.9.1");

  for (const item of disposables) item?.dispose?.();
});
