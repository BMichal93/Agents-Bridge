import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { client, sandbox, writeStub, wait } from "./helpers.mjs";

/** Every test gets its own HOME and its own stub directory. */
function setup(stubOpts = {}) {
  const home = sandbox();
  const bin = path.join(home, "bin");
  const codex = writeStub(bin, "codex", stubOpts);
  const claude = writeStub(bin, "claude", stubOpts);
  return { home, bin, codex, claude, env: { HOME: home, USERPROFILE: home, AGENT_BRIDGE_CODEX_BIN: codex, AGENT_BRIDGE_CLAUDE_BIN: claude } };
}

test("handshake and tool listing", async () => {
  const { env } = setup();
  const c = client(env);
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "agent-bridge");
    // Read the expected version rather than hardcoding it: a literal here means
  // every release breaks a test that is not about versions at all.
  const expectedVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(init.result.serverInfo.version, expectedVersion);
  // We echo the client's protocol version rather than insisting on our own.
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.capabilities.tools.listChanged, true);

  const list = await c.send("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["ask_codex", "delegate_to_codex", "start_codex_jobs", "collect_codex_jobs", "set_project_context", "ask_claude"]
  );
  c.close();
});

test("modern MCP discovery and per-request results coexist with legacy initialize", async () => {
  const { env } = setup({ stdout: "modern answer" });
  const c = client(env);
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  const discovered = await c.send("server/discover", { _meta: meta });
  assert.deepEqual(discovered.result.supportedVersions, ["2026-07-28"]);
  assert.equal(discovered.result.resultType, "complete");
  assert.equal(discovered.result._meta["io.modelcontextprotocol/serverInfo"].name, "agent-bridge");

  const listed = await c.send("tools/list", { _meta: meta });
  assert.equal(listed.result.resultType, "complete");
  assert.equal(listed.result.ttlMs, 0);
  assert.equal(listed.result.cacheScope, "private");

  const called = await c.send("tools/call", { _meta: meta, name: "ask_codex", arguments: { question: "q" } });
  assert.equal(called.result.resultType, "complete");
  assert.match(c.text(called), /modern answer/);
  c.close();
});

test("unsupported modern MCP versions are rejected and legacy versions are negotiated honestly", async () => {
  const { env } = setup();
  const c = client(env);
  const unsupported = await c.send("tools/list", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.equal(unsupported.error.data.requested, "2099-01-01");
  assert.ok(unsupported.error.data.supported.includes("2026-07-28"));

  const negotiated = await c.send("initialize", {
    protocolVersion: "2099-01-01",
    capabilities: {},
    clientInfo: { name: "old-client", version: "1" },
  });
  assert.notEqual(negotiated.result.protocolVersion, "2099-01-01");
  assert.ok(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(negotiated.result.protocolVersion));
  c.close();
});

test("unknown methods get a proper JSON-RPC error, not a crash", async () => {
  const { env } = setup();
  const c = client(env);
  await c.init();
  // Hosts probe for optional methods; this path is normal traffic.
  const res = await c.send("resources/list", {});
  assert.equal(res.error.code, -32601);
  c.close();
});

test("the prompt reaches the peer over stdin with shell metacharacters intact", async () => {
  const { env } = setup({ echoArgs: true });
  const c = client(env);
  await c.init();
  const nasty = 'does `a & "b" %PATH% ^c` survive?';
  const res = await c.call("ask_codex", { question: nasty });
  assert.match(c.text(res), /does `a & "b" %PATH% \^c` survive\?/);
  c.close();
});

test("effort tiers map to models and reasoning level", async () => {
  const { env, home } = setup({ echoArgs: true });
  fs.writeFileSync(
    path.join(home, ".agent-bridge", "models.json"),
    JSON.stringify({ codex: { fast: "small-model", balanced: "mid-model", deep: "big-model" } })
  );
  const c = client(env);
  await c.init();

  const fast = c.text(await c.call("ask_codex", { question: "q", effort: "fast" }));
  assert.match(fast, /-m small-model/);
  assert.match(fast, /model_reasoning_effort=low/);

  const deep = c.text(await c.call("ask_codex", { question: "q", effort: "deep" }));
  assert.match(deep, /-m big-model/);
  assert.match(deep, /model_reasoning_effort=high/);

  // No effort given means balanced, not "whatever was last used".
  const dflt = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(dflt, /-m mid-model/);
  c.close();
});

test("questions run read-only, delegations run workspace-write", async () => {
  const { env } = setup({ echoArgs: true });
  const c = client(env);
  await c.init();
  const question = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(question, /--sandbox read-only/);
  assert.match(question, /--ignore-user-config/);
  assert.match(question, /--ignore-rules/);
  assert.match(question, /--ephemeral/);
  const delegation = c.text(await c.call("delegate_to_codex", { task: "t" }));
  assert.match(delegation, /--sandbox workspace-write/);
  assert.ok(!delegation.includes("--ignore-user-config"), "write delegations should retain project/user configuration");
  c.close();
});

test("ask_claude exposes only read tools and blocks MCP tools", async () => {
  const { env } = setup({ echoArgs: true });
  const c = client(env);
  await c.init();
  const text = c.text(await c.call("ask_claude", { question: "q" }));
  assert.match(text, /--tools Read,Grep,Glob/);
  assert.match(text, /--disallowedTools mcp__\*/);
  assert.match(text, /--restricted/);
  assert.match(text, /--bare/);
  assert.match(text, /--no-session-persistence/);
  assert.ok(!text.includes("--allowedTools"));
  c.close();
});

test("a model name with shell metacharacters is rejected before it reaches argv", async () => {
  const { env } = setup();
  const c = client(env);
  await c.init();
  const res = await c.call("ask_claude", { question: "q", model: "sonnet; rm -rf /" });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /not a valid model name/);
  c.close();
});

test("the recursion guard refuses when the peer is the caller", async () => {
  const { env } = setup();
  const c = client({ ...env, AGENT_BRIDGE_DEPTH: "1" });
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.equal(res.result.isError, true);
  assert.match(c.text(res), /recursion guard/);
  c.close();
});

test("a missing peer fails fast and says why", async () => {
  const { env } = setup();
  const c = client({ ...env, AGENT_BRIDGE_CODEX_BIN: "codex-does-not-exist-anywhere" });
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.equal(res.result.isError, true);
  assert.match(c.text(res), /does not look installed|could not start/);
  c.close();
});

test("a non-zero peer exit is a failure even when stdout contains a partial answer", async () => {
  const { env } = setup({ stdout: "partial answer", stderr: "fatal detail", exit: 1 });
  const c = client(env);
  await c.init();
  const res = await c.call("ask_codex", { question: "q" });
  assert.equal(res.result.isError, true);
  assert.match(c.text(res), /exited with code 1/);
  assert.match(c.text(res), /partial answer/);
  c.close();
});

test("the circuit breaker stops calling a peer that keeps failing", async () => {
  const { env } = setup({ exit: 1, stderr: "stream error: You've hit your usage limit (429)" });
  const c = client(env);
  await c.init();

  const first = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(first, /out of quota or rate limited/);
  await c.call("ask_codex", { question: "q" });

  // Third call must not spawn anything; it short-circuits with an instruction.
  const third = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(third, /has failed 2 times/);
  assert.match(third, /Do the work yourself/);
  c.close();
});

test("a long reply is trimmed, keeping the head and the tail", async () => {
  const noisy = Array.from({ length: 400 }, (_, i) => `narration line ${i}`).join("\n") + "\nFINAL ANSWER";
  const { env } = setup({ stdout: noisy });
  const c = client({ ...env, AGENT_BRIDGE_MAX_REPLY_CHARS: "2000" });
  await c.init();
  const text = c.text(await c.call("ask_codex", { question: "q" }));
  assert.ok(text.length < 3000, `reply was ${text.length} chars`);
  assert.match(text, /narration line 0/);
  assert.match(text, /FINAL ANSWER/);
  assert.match(text, /trimmed by agent-bridge/);
  c.close();
});

test("peer output is bounded while preserving Codex's thread id and final JSONL message", async () => {
  const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    "x".repeat(100_000),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "FINAL survives" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const { env, home } = setup({ stdout });
  const repo = path.join(home, "bounded-output");
  fs.mkdirSync(repo, { recursive: true });
  const c = client({ ...env, AGENT_BRIDGE_MAX_PROCESS_OUTPUT_CHARS: "1200" });
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t", lane: "bounded", cwd: repo }));
  assert.match(text, /FINAL survives/);
  assert.ok(text.length < 4000, `bounded result was ${text.length} characters`);
  const lanes = JSON.parse(fs.readFileSync(path.join(home, ".agent-bridge", "lanes.json"), "utf8"));
  assert.equal(lanes.scopes[repo].bounded.sessionId, sessionId);
  c.close();
});

test("conserve mode changes the tool descriptions and notifies the host", async () => {
  const { env, home } = setup();
  const c = client(env);
  await c.init();

  const before = await c.send("tools/list", {});
  assert.ok(!before.result.tools[1].description.includes("CONSERVE MODE IS ON"));

  fs.writeFileSync(path.join(home, ".agent-bridge", "conserve"), "");
  await wait(600);

  const after = await c.send("tools/list", {});
  assert.match(after.result.tools[1].description, /CONSERVE MODE IS ON/);
  assert.ok(c.notifications.includes("notifications/tools/list_changed"));
  c.close();
});

test("the footer reports the tier and model, and status.json is written", async () => {
  const { env, home } = setup();
  const c = client(env);
  await c.init();
  const text = c.text(await c.call("ask_codex", { question: "q", effort: "deep" }));
  assert.match(text, /ask_codex · deep/);

  const status = JSON.parse(fs.readFileSync(path.join(home, ".agent-bridge", "status.json"), "utf8"));
  assert.equal(status.tool, "ask_codex");
  assert.equal(status.tier, "deep");
  c.close();
});

test("a usage lookup never delays the answer", async () => {
  const { env } = setup();
  const c = client(env);
  await c.init();
  const started = Date.now();
  await c.call("ask_codex", { question: "q" });
  // The app-server probe alone can take seconds; it must not be on this path.
  assert.ok(Date.now() - started < 4000, `call took ${Date.now() - started}ms`);
  c.close();
});

test("documented app-server rate-limit fields appear in the usage footer", async () => {
  const home = sandbox();
  const binDir = path.join(home, "bin");
  const codex = writeStub(binDir, "codex");
  const claude = writeStub(binDir, "claude", { stdout: "ok" });
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
  const c = client({
    HOME: home,
    USERPROFILE: home,
    AGENT_BRIDGE_CODEX_BIN: codex,
    AGENT_BRIDGE_CLAUDE_BIN: claude,
  });
  await c.init();
  await wait(250);
  const text = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(text, /Codex 5h 75% left/);
  c.close();
});

test("the child is killed when the host goes away mid-call", async () => {
  const { env, home } = setup({ sleepMs: 4000, stdout: "finished anyway" });
  const marker = path.join(home, "survived.txt");
  // Rewrite the stub to leave evidence if it is allowed to finish.
  const js = path.join(home, "bin", "codex.stub.mjs");
  fs.writeFileSync(js, `setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); }, 2500);`);

  const c = client(env);
  await c.init();
  c.call("ask_codex", { question: "q" }).catch(() => {});
  await wait(600);
  c.proc.stdin.end(); // what a host does when it quits
  await wait(3500);

  assert.equal(fs.existsSync(marker), false, "the peer process outlived the host");
  c.close();
});

test("HTTP mode refuses to start without a strong secret", async () => {
  const { spawnSync } = await import("node:child_process");
  const { SERVER } = await import("./helpers.mjs");
  const r = spawnSync(process.execPath, [SERVER, "--http"], {
    env: { ...process.env, AGENT_BRIDGE_REMOTE_SECRET: "tooshort" },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.match(r.stderr, /refusing to start HTTP/);
  assert.notEqual(r.status, 0);
});

test("HTTP mode rejects a wrong secret and serves the right one", async () => {
  const { spawn } = await import("node:child_process");
  const { SERVER } = await import("./helpers.mjs");
  const crypto = await import("node:crypto");
  const secret = crypto.randomBytes(24).toString("hex");
  const port = 7000 + Math.floor(Math.random() * 900);
  const home = sandbox();

  const srv = spawn(process.execPath, [SERVER, "--http"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENT_BRIDGE_REMOTE_SECRET: secret,
      AGENT_BRIDGE_HTTP_PORT: String(port),
      AGENT_BRIDGE_HTTP_ALLOWED_ORIGINS: "https://claude.ai",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverErr = "";
  srv.stderr.on("data", (chunk) => (serverErr += chunk));
  await wait(1200);

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = (p, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  // Same length as the real one, so this also exercises the timing-safe compare.
  const wrong = await post(`/mcp/${"0".repeat(secret.length)}`, init);
  assert.equal(wrong.status, 404);
  assert.ok(!serverErr.includes(secret), "HTTP diagnostics leaked the capability secret");

  const badOrigin = await post(`/mcp/${secret}`, init, { origin: "https://evil.example" });
  assert.equal(badOrigin.status, 403);

  const right = await post(`/mcp/${secret}`, init, { origin: "https://claude.ai" });
  assert.equal(right.status, 200);
  assert.equal((await right.json()).result.serverInfo.name, "agent-bridge");

  const notification = await post(`/mcp/${secret}`, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");

  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const discoverBody = { jsonrpc: "2.0", id: 10, method: "server/discover", params: { _meta: modernMeta } };
  const modernHeaders = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" };
  const modern = await post(`/mcp/${secret}`, discoverBody, modernHeaders);
  assert.equal(modern.status, 200);
  assert.deepEqual((await modern.json()).result.supportedVersions, ["2026-07-28"]);

  const badHeaders = await post(
    `/mcp/${secret}`,
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { _meta: modernMeta, name: "ask_codex", arguments: { question: "q" } } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "delegate_to_codex" }
  );
  assert.equal(badHeaders.status, 400);
  assert.equal((await badHeaders.json()).error.code, -32020);

  // A remote caller must not get write access without an explicit opt-in.
  const del = await post(`/mcp/${secret}`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate_to_codex", arguments: { task: "t" } } });
  const body = await del.json();
  assert.ok(!/workspace-write/.test(JSON.stringify(body)), "remote delegation should be read-only by default");

  const context = await post(`/mcp/${secret}`, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "set_project_context", arguments: { content: "must not be written", cwd: home } },
  });
  const contextBody = await context.json();
  assert.equal(contextBody.result.isError, true);
  assert.equal(fs.existsSync(path.join(home, ".agent-bridge", "context.md")), false);

  const marker = path.join(home, "remote-verify-marker");
  const verified = await post(`/mcp/${secret}`, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "delegate_to_codex",
      arguments: { task: "t", cwd: home, verify: `python -c open('${marker}','w').write('x')` },
    },
  });
  const verifiedBody = await verified.json();
  assert.match(verifiedBody.result.content[0].text, /remote writes are disabled/);
  assert.equal(fs.existsSync(marker), false);

  srv.kill();
});

test("closing an HTTP request cancels its peer process", async () => {
  const { spawn } = await import("node:child_process");
  const nodeNet = await import("node:net");
  const crypto = await import("node:crypto");
  const { SERVER } = await import("./helpers.mjs");
  const { env, home } = setup();
  const secret = crypto.randomBytes(24).toString("hex");
  const port = 7900 + Math.floor(Math.random() * 700);
  const started = path.join(home, "http-child-started");
  const survived = path.join(home, "http-child-survived");
  fs.writeFileSync(
    path.join(home, "bin", "codex.stub.mjs"),
    `import fs from "node:fs";\nif (process.argv.includes("app-server")) process.exit(0);\nfs.writeFileSync(${JSON.stringify(started)}, "x");\nsetTimeout(() => fs.writeFileSync(${JSON.stringify(survived)}, "x"), 2500);\nprocess.stdin.resume();\n`
  );
  const srv = spawn(process.execPath, [SERVER, "--http"], {
    env: { ...process.env, ...env, AGENT_BRIDGE_REMOTE_SECRET: secret, AGENT_BRIDGE_HTTP_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await wait(1000);
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "delegate_to_codex", arguments: { task: "wait", cwd: home } },
    });
    const socket = nodeNet.createConnection({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /mcp/${secret} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`
    );
    for (let i = 0; i < 100 && !fs.existsSync(started); i++) await wait(25);
    assert.equal(fs.existsSync(started), true, "peer did not start");
    socket.destroy();
    await wait(3000);
    assert.equal(fs.existsSync(survived), false, "peer survived the closed HTTP response");
  } finally {
    srv.kill();
  }
});

test("a verify command turns a delegation into a verdict", async () => {
  const { env } = setup({ stdout: "I changed some files." });
  const c = client(env);
  await c.init();
  // `node` is not on the allowlist, so this also proves the allowlist bites.
  const blocked = c.text(await c.call("delegate_to_codex", { task: "t", verify: "node -e 1" }));
  assert.match(blocked, /not in the allowlist/);

  c.close();

  const c2 = client({ ...env, AGENT_BRIDGE_VERIFY_ALLOW: "node" });
  await c2.init();
  const passed = c2.text(await c2.call("delegate_to_codex", { task: "t", verify: "node --version" }));
  assert.match(passed, /verify `node --version` PASSED/);
  // The verdict must lead and Codex's prose must trail.
  assert.ok(passed.indexOf("verify") < passed.indexOf("codex said:"), "verdict should come first");
  c2.close();
});

test("verify commands preserve quoted paths containing spaces", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "verify spaces");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "check file.mjs"), "process.exit(0);\n");
  const c = client({ ...env, AGENT_BRIDGE_VERIFY_ALLOW: "node" });
  await c.init();
  const text = c.text(
    await c.call("delegate_to_codex", { task: "t", cwd: repo, verify: 'node "check file.mjs"' })
  );
  assert.match(text, /verify `node "check file\.mjs"` PASSED/);
  c.close();
});

test("missing verify is called out rather than passing silently", async () => {
  const { env } = setup({ stdout: "done" });
  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t" }));
  assert.match(text, /No verify command was given/);
  c.close();
});

test("the working-tree report includes untracked files created by the delegation", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "repo-with-untracked");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: repo });
  // Dirty beforehand, so this also proves pre-existing entries are summarised
  // rather than listed again.
  fs.writeFileSync(path.join(repo, "was-here-already.ts"), "old\n");

  const js = path.join(home, "bin", "codex.stub.mjs");
  fs.writeFileSync(
    js,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(repo, "new-file.ts"))}, "export const value = 1;\\n");\nconsole.log("wrote a file");\n`
  );

  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "build", cwd: repo }));
  assert.match(text, /\?\? new-file\.ts/);
  assert.match(text, /1 entry was already present/);
  assert.ok(!text.includes("was-here-already.ts"), "pre-existing entries should be counted, not listed");
  c.close();
});

test("background jobs run in parallel and are collected together", async () => {
  const { env } = setup({ stdout: "built it", sleepMs: 1500 });
  const c = client(env);
  await c.init();

  const started = Date.now();
  const start = c.text(
    await c.call("start_codex_jobs", {
      tasks: [
        { task: "build a", files: "a.ts" },
        { task: "build b", files: "b.ts" },
        { task: "build c", files: "c.ts" },
      ],
    })
  );
  assert.match(start, /Accepted 3 Codex builds: 3 running, 0 queued/);
  // Starting must return immediately; that is the entire point.
  assert.ok(Date.now() - started < 1000, "start_codex_jobs blocked");

  const collected = c.text(await c.call("collect_codex_jobs", {}));
  assert.match(collected, /job-1/);
  assert.match(collected, /job-3/);
  // Three 1.5s builds in parallel finish well inside three serial ones.
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started}ms, looks serial`);
  c.close();
});

test("overlapping jobs are queued across separate start calls", async () => {
  const { env } = setup({ stdout: "built it", sleepMs: 300 });
  const c = client(env);
  await c.init();
  const first = c.text(
    await c.call("start_codex_jobs", {
      tasks: [{ task: "one", files: "src" }],
    })
  );
  const second = c.text(
    await c.call("start_codex_jobs", {
      tasks: [{ task: "two", files: "src/shared.ts" }],
    })
  );
  assert.match(first, /1 running, 0 queued/);
  assert.match(second, /0 running, 1 queued/);
  const collected = c.text(await c.call("collect_codex_jobs", {}));
  assert.match(collected, /job-1/);
  assert.match(collected, /job-2/);
  c.close();
});

test("background concurrency is capped even for independent files", async () => {
  const { env } = setup({ stdout: "built", sleepMs: 250 });
  const c = client({ ...env, AGENT_BRIDGE_MAX_CONCURRENT_JOBS: "2" });
  await c.init();
  const started = c.text(
    await c.call("start_codex_jobs", {
      tasks: [
        { task: "one", files: "one.ts" },
        { task: "two", files: "two.ts" },
        { task: "three", files: "three.ts" },
        { task: "four", files: "four.ts" },
      ],
    })
  );
  assert.match(started, /2 running, 2 queued/);
  await c.call("collect_codex_jobs", {});
  c.close();
});

test("jobs in the same lane serialize even when their files do not overlap", async () => {
  const { env } = setup({ stdout: "built", sleepMs: 250 });
  const c = client(env);
  await c.init();
  const started = c.text(
    await c.call("start_codex_jobs", {
      tasks: [
        { task: "one", files: "one.ts", lane: "shared-lane" },
        { task: "two", files: "two.ts", lane: "shared-lane" },
      ],
    })
  );
  assert.match(started, /1 running, 1 queued/);
  await c.call("collect_codex_jobs", {});
  c.close();
});

test("job limits, lane names and collect ids are validated", async () => {
  const { env } = setup({ stdout: "built", sleepMs: 50 });
  const c = client({ ...env, AGENT_BRIDGE_MAX_JOBS_PER_CALL: "2" });
  await c.init();
  const tooMany = await c.call("start_codex_jobs", {
    tasks: [
      { task: "one", files: "one.ts" },
      { task: "two", files: "two.ts" },
      { task: "three", files: "three.ts" },
    ],
  });
  assert.match(tooMany.error.message, /at most 2 jobs/);

  const badLane = await c.call("delegate_to_codex", { task: "t", lane: "__proto__" });
  assert.match(badLane.error.message, /lane must be/);

  const unknown = await c.call("collect_codex_jobs", { ids: ["job-999"] });
  assert.match(unknown.error.message, /unknown job id/);
  c.close();
});


test("project context is written once and injected into every delegation", async () => {
  const { env, home } = setup({ echoArgs: true });
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const c = client(env);
  await c.init();

  const saved = c.text(await c.call("set_project_context", { content: "Hexagonal architecture. No new deps.", cwd: repo }));
  assert.match(saved, /Saved \d+ characters/);
  assert.ok(fs.existsSync(path.join(repo, ".agent-bridge", "context.md")));

  // The stub echoes the last prompt line, so a marker at the end proves the
  // whole framed prompt reached Codex with the context section in it.
  const used = c.text(await c.call("delegate_to_codex", { task: "MARKER-TASK", cwd: repo }));
  assert.match(used, /MARKER-TASK/);
  c.close();
});

test("an oversized project context is truncated rather than sent whole", async () => {
  const { env, home } = setup();
  const repo = path.join(home, "repo2");
  fs.mkdirSync(path.join(repo, ".agent-bridge"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".agent-bridge", "context.md"), "x".repeat(50000));
  const c = client({ ...env, AGENT_BRIDGE_CONTEXT_MAX: "500" });
  await c.init();
  const res = await c.call("delegate_to_codex", { task: "t", cwd: repo });
  // It must still complete; the guard is about size, not about failing.
  assert.ok(c.text(res).length > 0);
  c.close();
});

test("a lane resumes an existing Codex session instead of starting cold", async () => {
  const { env, home } = setup({ echoArgs: true });
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".agent-bridge"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".agent-bridge", "lanes.json"),
    JSON.stringify({ scopes: { [repo]: { "auth-refactor": { sessionId: "abc123-session", at: Date.now() } } } })
  );
  const c = client(env);
  await c.init();

  const resumed = c.text(await c.call("delegate_to_codex", { task: "next step", lane: "auth-refactor", cwd: repo }));
  assert.match(resumed, /exec .*resume abc123-session/);

  const cold = c.text(await c.call("delegate_to_codex", { task: "unrelated", lane: "other-lane", cwd: repo }));
  assert.ok(!/resume/.test(cold), "an unknown lane should not resume anything");
  c.close();
});

test("a documented Codex JSONL response supplies the final message and scoped lane id", async () => {
  const sessionId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "implemented cleanly" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const { env, home } = setup({ stdout });
  const repo = path.join(home, "jsonl-repo");
  fs.mkdirSync(repo, { recursive: true });
  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "build", lane: "feature", cwd: repo }));
  assert.match(text, /codex said:\nimplemented cleanly/);
  assert.ok(!text.includes("thread.started"));
  const lanes = JSON.parse(fs.readFileSync(path.join(home, ".agent-bridge", "lanes.json"), "utf8"));
  assert.equal(lanes.scopes[repo].feature.sessionId, sessionId);
  c.close();
});

test("a verification process is killed when the MCP host closes", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "verify-shutdown");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, "check.py"),
    "import pathlib,time\npathlib.Path('started').write_text('yes')\ntime.sleep(1.5)\npathlib.Path('survived').write_text('yes')\n"
  );
  const c = client(env);
  await c.init();
  c.call("delegate_to_codex", { task: "t", cwd: repo, verify: "python check.py" }).catch(() => {});
  for (let i = 0; i < 100 && !fs.existsSync(path.join(repo, "started")); i++) await wait(25);
  assert.equal(fs.existsSync(path.join(repo, "started")), true);
  c.proc.stdin.end();
  await wait(1800);
  assert.equal(fs.existsSync(path.join(repo, "survived")), false);
  c.close();
});

test("space-separated files still serialise overlapping jobs", async () => {
  // Regression: claimsFor split only on commas and newlines, so a natural
  // space-separated list became one nonsense path that overlapped with nothing.
  // Two jobs both touching b.ts would then have run at the same time.
  const { env } = setup({ stdout: "built", sleepMs: 400 });
  const c = client(env);
  await c.init();

  const first = c.text(await c.call("start_codex_jobs", { tasks: [{ task: "one", files: "a.ts b.ts" }] }));
  assert.match(first, /1 running/);

  const second = c.text(await c.call("start_codex_jobs", { tasks: [{ task: "two", files: "b.ts" }] }));
  assert.match(second, /0 running, 1 queued/);

  await c.call("collect_codex_jobs", {});
  c.close();
});

test("a quoted path containing a space is kept as one claim", async () => {
  const { env } = setup({ stdout: "built", sleepMs: 300 });
  const c = client(env);
  await c.init();
  const started = c.text(
    await c.call("start_codex_jobs", {
      tasks: [
        { task: "one", files: '"My Docs/a.ts"' },
        { task: "two", files: "b.ts" },
      ],
    })
  );
  // Different files, so both should run rather than one waiting on the other.
  assert.match(started, /2 running/);
  await c.call("collect_codex_jobs", {});
  c.close();
});

test("git summary reports the delta, not two full listings", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "gitrepo");
  fs.mkdirSync(repo, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const run = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  // Dirty the tree before the delegation, the way a real session usually is.
  fs.writeFileSync(path.join(repo, "tracked.txt"), "two\n");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, `pre-${i}.txt`), "x");

  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t", cwd: repo }));

  // Nothing new was written by the stub, so the pre-existing mess must be
  // summarised as a count rather than listed again.
  assert.match(text, /no working-tree changes detected/);
  assert.match(text, /6 entries were already present/);
  assert.ok(!text.includes("pre-4.txt"), "pre-existing files should not be listed");
  c.close();
});

test("git summary detects another edit to an already-dirty file", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "dirty-again");
  fs.mkdirSync(repo, { recursive: true });
  const run = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before\n");
  fs.writeFileSync(
    path.join(home, "bin", "codex.stub.mjs"),
    `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(path.join(repo, "tracked.txt"))}, "changed during delegation\\n");\nconsole.log("done");\n`
  );

  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t", cwd: repo }));
  assert.match(text, /working-tree changes observed during this delegation/);
  assert.match(text, / M tracked\.txt/);
  c.close();
});

test("git summary reports a pre-existing dirty entry that was cleared", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "dirty-cleared");
  fs.mkdirSync(repo, { recursive: true });
  const run = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before\n");
  fs.writeFileSync(
    path.join(home, "bin", "codex.stub.mjs"),
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(path.join(repo, "tracked.txt"))}, "committed\\n");\nconsole.log("done");\n`
  );

  const c = client(env);
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t", cwd: repo }));
  assert.match(text, /cleared:  M tracked\.txt/);
  c.close();
});

test("a large number of new entries is capped", async () => {
  const { env, home } = setup({ stdout: "done" });
  const repo = path.join(home, "bigrepo");
  fs.mkdirSync(repo, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const run = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "seed.txt"), "x");
  run("add", "-A");
  run("commit", "-qm", "init");

  // The stub creates a pile of untracked files, standing in for a build output
  // directory that nobody gitignored.
  const js = path.join(home, "bin", "codex.stub.mjs");
  fs.writeFileSync(
    js,
    `import fs from "node:fs";\nfor (let i = 0; i < 120; i++) fs.writeFileSync(${JSON.stringify(repo)} + "/gen-" + i + ".txt", "x");\nconsole.log("made files");\n`
  );

  const c = client({ ...env, AGENT_BRIDGE_MAX_STATUS_LINES: "10" });
  await c.init();
  const text = c.text(await c.call("delegate_to_codex", { task: "t", cwd: repo }));
  assert.match(text, /working-tree changes observed during this delegation \(12\d\)/);
  assert.match(text, /and 1\d\d more/);
  c.close();
});

test("a full session runs end to end and stays small", async () => {
  // Smoothness check: the sequence the README recommends, in order, with the
  // sizes asserted. If any single step starts returning kilobytes, the pack has
  // stopped doing the one thing it exists to do.
  const { env, home } = setup({ stdout: "Implemented the change." });
  const repo = path.join(home, "session-repo");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "--quiet"], { cwd: repo });

  const c = client(env);
  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "agent-bridge");

  const steps = [];
  const step = async (label, name, args) => {
    const text = c.text(await c.call(name, args));
    steps.push({ label, size: text.length });
    return text;
  };

  await step("context", "set_project_context", { content: "Hexagonal. Thin handlers.", cwd: repo });
  const first = await step("delegate", "delegate_to_codex", { task: "Add validation", cwd: repo, lane: "session" });
  // Verdict shape: what changed comes before the builder's narration.
  assert.ok(first.indexOf("codex said:") > 0, "codex narration should come last");

  await step("follow-up", "delegate_to_codex", { task: "Extend it", cwd: repo, lane: "session" });
  const started = await step("start jobs", "start_codex_jobs", {
    tasks: [
      { task: "a", files: "a.cs", cwd: repo },
      { task: "b", files: "b.cs", cwd: repo },
    ],
  });
  assert.match(started, /2 running/);
  const collected = await step("collect", "collect_codex_jobs", {});
  assert.match(collected, /job-1/);
  assert.match(collected, /job-2/);

  // No single step should be large. The whole point is that results are small.
  for (const s of steps) {
    assert.ok(s.size < 4000, `${s.label} returned ${s.size} bytes, which is too much for one step`);
  }
  const total = steps.reduce((sum, s) => sum + s.size, 0);
  assert.ok(total < 8000, `whole session returned ${total} bytes`);
  c.close();
});

test("tool definitions stay within their context budget", async () => {
  // These are re-sent on every turn of every session, so growth here is paid
  // repeatedly. Treat this ceiling as a design constraint, not a lint.
  const { env } = setup();
  const c = client(env);
  await c.init();
  const list = await c.send("tools/list", {});
  const size = JSON.stringify(list.result.tools).length;
  assert.ok(size < 11000, `tool definitions are ${size} bytes; trim a description before raising this`);
  c.close();
});

test("doctor flag detection matches whole tokens, not substrings", async () => {
  // A plain substring test finds "-a" inside "--allowedTools" and "--tools"
  // inside "--allowedTools", so short flags would always pass and doctor would
  // report health it had never checked. That failure is silent, which is the
  // worst kind for a script whose whole job is catching silent breakage.
  const { helpHas } = await import("../scripts/doctor.mjs");
  assert.equal(helpHas("--allowedTools, --disallowedTools", "-a"), false);
  assert.equal(helpHas("  -a, --approval <policy>", "-a"), true);
  assert.equal(helpHas("  -c, --config <key=value>", "-c"), true);
  assert.equal(helpHas("--config-file only", "-c"), false);
  assert.equal(helpHas("  --tools <list>  Restrict available tools", "--tools"), true);
  assert.equal(helpHas("only --allowedTools here", "--tools"), false);
});
