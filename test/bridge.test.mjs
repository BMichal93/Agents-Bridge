import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
  // We echo the client's protocol version rather than insisting on our own.
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.capabilities.tools.listChanged, true);

  const list = await c.send("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["ask_codex", "delegate_to_codex", "ask_claude"]
  );
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
  assert.match(fast, /model_reasoning_effort="low"/);

  const deep = c.text(await c.call("ask_codex", { question: "q", effort: "deep" }));
  assert.match(deep, /-m big-model/);
  assert.match(deep, /model_reasoning_effort="high"/);

  // No effort given means balanced, not "whatever was last used".
  const dflt = c.text(await c.call("ask_codex", { question: "q" }));
  assert.match(dflt, /-m mid-model/);
  c.close();
});

test("questions run read-only, delegations run workspace-write", async () => {
  const { env } = setup({ echoArgs: true });
  const c = client(env);
  await c.init();
  assert.match(c.text(await c.call("ask_codex", { question: "q" })), /--sandbox read-only/);
  assert.match(c.text(await c.call("delegate_to_codex", { task: "t" })), /--sandbox workspace-write/);
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
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENT_BRIDGE_REMOTE_SECRET: secret, AGENT_BRIDGE_HTTP_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await wait(1200);

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = (p, body) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // Same length as the real one, so this also exercises the timing-safe compare.
  const wrong = await post(`/mcp/${"0".repeat(secret.length)}`, init);
  assert.equal(wrong.status, 404);

  const right = await post(`/mcp/${secret}`, init);
  assert.equal(right.status, 200);
  assert.equal((await right.json()).result.serverInfo.name, "agent-bridge");

  // A remote caller must not get write access without an explicit opt-in.
  const del = await post(`/mcp/${secret}`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate_to_codex", arguments: { task: "t" } } });
  const body = await del.json();
  assert.ok(!/workspace-write/.test(JSON.stringify(body)), "remote delegation should be read-only by default");

  srv.kill();
});
