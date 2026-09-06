import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { client, sandbox, writeStub, SERVER, ROOT } from "./helpers.mjs";

function fixture(t, source = 'console.log("done");') {
  const dir = sandbox();
  const bin = path.join(dir, "bin");
  const codex = writeStub(bin, "codex");
  const claude = writeStub(bin, "claude");
  const script = 'if (process.argv.includes("app-server")) process.exit(0);\n' + source;
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), script);
  fs.writeFileSync(path.join(bin, "claude.stub.mjs"), script);
  const env = { HOME: dir, USERPROFILE: dir, AGENT_BRIDGE_CODEX_BIN: codex, AGENT_BRIDGE_CLAUDE_BIN: claude };
  const c = client({ ...env, AGENT_BRIDGE_VERIFY_ALLOW: "node" });
  t.after(() => c.close());
  return { dir, bin, env, c };
}

function git(repo, ...args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function repository(dir) {
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return repo;
}

test("requested verification that cannot run is a failed result", async (t) => {
  const { c } = fixture(t);
  for (const verify of ['node "unclosed', "not-allowed --version"]) {
    const result = await c.call("delegate_to_codex", { task: "t", verify });
    assert.equal(result.result.isError, true, c.text(result));
    assert.match(c.text(result), /verify skipped/);
  }
  const healthy = await c.call("ask_codex", { question: "q" });
  assert.equal(healthy.result.isError, false, "verification errors must not open the peer circuit breaker");
});

test("failed peers do not execute verification commands", async (t) => {
  const { dir, c } = fixture(t, 'console.error("peer failed"); process.exit(1);');
  fs.writeFileSync(path.join(dir, "verify.cjs"), 'require("fs").writeFileSync("verify-ran", "x");');
  const result = await c.call("delegate_to_codex", { task: "t", cwd: dir, verify: "node verify.cjs" });
  assert.equal(result.result.isError, true);
  assert.equal(fs.existsSync(path.join(dir, "verify-ran")), false);
});

test("Git fingerprints resolve root-relative paths when cwd is a subfolder", async (t) => {
  const { dir, bin, c } = fixture(t);
  const repo = repository(dir);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before\n");
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"),
    'if(process.argv.includes("app-server"))process.exit(0);\nimport fs from "node:fs"; fs.appendFileSync("../tracked.txt", "after\\n"); console.log("done");');
  const result = await c.call("delegate_to_codex", { task: "t", cwd: path.join(repo, "sub") });
  assert.match(c.text(result), / M tracked\.txt/);
});

test("Git observes staging changes even when status and worktree bytes stay the same", async (t) => {
  const { dir, bin, c } = fixture(t);
  const repo = repository(dir);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "stage one\n");
  git(repo, "add", "tracked.txt");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "worktree\n");
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), `
if(process.argv.includes("app-server"))process.exit(0);
import fs from "node:fs"; import {spawnSync} from "node:child_process";
fs.writeFileSync("tracked.txt", "stage two\\n");
spawnSync("git", ["add", "tracked.txt"]);
fs.writeFileSync("tracked.txt", "worktree\\n"); console.log("done");`);
  const result = await c.call("delegate_to_codex", { task: "t", cwd: repo });
  assert.match(c.text(result), /MM tracked\.txt/);
});

test("working-tree observations include files created by verification", async (t) => {
  const { dir, c } = fixture(t);
  const repo = repository(dir);
  fs.writeFileSync(path.join(repo, "check.cjs"), 'require("fs").writeFileSync("generated.txt", "x");');
  const result = await c.call("delegate_to_codex", { task: "t", cwd: repo, verify: "node check.cjs" });
  assert.equal(result.result.isError, false);
  assert.match(c.text(result), /\?\? generated\.txt/);
});

test("Codex event errors cannot disappear from the middle of bounded output", async (t) => {
  const { env } = fixture(t, `
console.log(JSON.stringify({type:"thread.started",thread_id:"example"}));
for(let i=0;i<100;i++)console.log(JSON.stringify({type:"item.started",padding:"x".repeat(200)}));
console.log(JSON.stringify({type:"turn.failed",error:{message:"MIDSTREAM FAILURE"}}));
for(let i=0;i<100;i++)console.log(JSON.stringify({type:"item.started",padding:"x".repeat(200)}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"partial answer"}}));`);
  const c = client({ ...env, AGENT_BRIDGE_MAX_PROCESS_OUTPUT_CHARS: "1200" });
  t.after(() => c.close());
  const result = await c.call("ask_codex", { question: "q" });
  assert.equal(result.result.isError, true);
  assert.match(c.text(result), /MIDSTREAM FAILURE/);
});

test("Codex JSONL without a final message does not claim success", async (t) => {
  const { c } = fixture(t, 'console.log(JSON.stringify({type:"thread.started",thread_id:"example"}));');
  const result = await c.call("ask_codex", { question: "q" });
  assert.equal(result.result.isError, true);
  assert.match(c.text(result), /no final message/i);
});

test("invalid job fields reject the whole batch before any job starts", async (t) => {
  const { dir, c } = fixture(t);
  const result = await c.call("start_codex_jobs", { tasks: [
    { task: "would run", cwd: dir, files: "a" },
    { task: "invalid", cwd: dir, files: 42 },
  ] });
  assert.equal(result.error?.code, -32602);
  assert.match(c.text(await c.call("collect_codex_jobs", {})), /No outstanding/);
});

test("Claude retries quoted parser diagnostics but not runtime/answer text", async (t) => {
  const { dir, bin, c } = fixture(t);
  const counter = path.join(dir, "calls");
  fs.writeFileSync(path.join(bin, "claude.stub.mjs"), `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
if(process.argv.includes("--no-session-persistence")) {
 console.error('error: unknown option "--no-session-persistence"'); process.exit(1);
}
console.log("PONG");`);
  assert.match(c.text(await c.call("ask_claude", { question: "q" })), /PONG/);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
  fs.writeFileSync(path.join(bin, "claude.stub.mjs"), `
import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x");
console.log("Answer quotes: unknown option '--no-session-persistence'"); process.exit(1);`);
  const result = await c.call("ask_claude", { question: "q" });
  assert.equal(result.result.isError, true);
  assert.equal(fs.readFileSync(counter, "utf8"), "xxx", "answer text must not trigger a second agent call");
});

async function httpFixture(t) {
  const { env } = fixture(t);
  const secret = crypto.randomBytes(24).toString("hex");
  const proc = spawn(process.execPath, [SERVER, "--http"], {
    env: { ...process.env, ...env, AGENT_BRIDGE_REMOTE_SECRET: secret, AGENT_BRIDGE_HTTP_PORT: "0" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  t.after(() => proc.kill());
  let stderr = "";
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP startup timed out: " + stderr)), 5000);
    proc.once("exit", () => { clearTimeout(timer); reject(new Error("HTTP server exited: " + stderr)); });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/http listening on 127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: `/mcp/${secret}`, method: "POST", agent,
      headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("HTTP response timed out")));
    req.end(JSON.stringify(body));
  });
  return { post, stderr: () => stderr };
}

test("malformed HTTP JSON-RPC is rejected without taking down the server", async (t) => {
  const { post } = await httpFixture(t);
  for (const body of [null, [], 7, "x", {jsonrpc:"2.0",id:{},method:"ping"}]) {
    const result = await post(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.id, null);
    assert.equal(result.body.error.code, -32600);
  }
  const ping = await post({jsonrpc:"2.0",id:1,method:"ping"});
  assert.deepEqual(ping.body.result, {});
});

test("HTTP keep-alive requests do not accumulate socket cancellation listeners", async (t) => {
  const { post, stderr } = await httpFixture(t);
  for (let id = 1; id <= 30; id++) await post({jsonrpc:"2.0",id,method:"ping"});
  assert.doesNotMatch(stderr(), /MaxListenersExceededWarning/);
});

test("HTTP unknown protocol headers cannot silently fall back to legacy", async (t) => {
  const { post } = await httpFixture(t);
  const result = await post({jsonrpc:"2.0",id:1,method:"ping"}, {"MCP-Protocol-Version":"2099-01-01"});
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, -32022);
});

test("doctor follows the real Claude optional-flag fallback", (t) => {
  const { dir, bin, env } = fixture(t);
  fs.writeFileSync(path.join(bin, "claude.stub.mjs"), `
if(process.argv.includes("--version")) {console.log("2.1.248");process.exit(0);}
if(process.argv.includes("--help")) {console.log("help");process.exit(0);}
if(process.argv.includes("--no-session-persistence")) {console.error("error: unknown option '--no-session-persistence'");process.exit(1);}
console.log("PONG");`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "doctor.mjs")], {
    env: { ...process.env, ...env, AGENT_BRIDGE_CODEX_BIN: path.join(dir, "missing-codex") },
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /optional flag fallback exercised/);
});

test("an oversized JSON event fails closed and split UTF-8 stays intact", async (t) => {
  const { bin, env } = fixture(t);
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), `
if(process.argv.includes("app-server"))process.exit(0);
console.log(JSON.stringify({type:"thread.started",thread_id:"example"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"x".repeat(5000)}}));`);
  const c = client({ ...env, AGENT_BRIDGE_MAX_PROCESS_OUTPUT_CHARS: "1200" });
  t.after(() => c.close());
  const large = await c.call("ask_codex", { question: "q" });
  assert.equal(large.result.isError, true);
  assert.match(c.text(large), /event exceeded/);
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), `
if(process.argv.includes("app-server"))process.exit(0);
const text=Buffer.from(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Zażółć gęślą jaźń 🙂"}})+"\\n");
for(const byte of text) {process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}`);
  const unicode = await c.call("ask_codex", { question: "q" });
  assert.equal(unicode.result.isError, false);
  assert.match(c.text(unicode), /Zażółć gęślą jaźń 🙂/);
});

test("cancelled collection leaves background results available for another collect", async (t) => {
  const { c, dir } = fixture(t, 'setTimeout(()=>console.log("background result"),500);');
  await c.call("start_codex_jobs", { tasks: [{task:"t",cwd:dir}] }); // id 1
  const pending = c.call("collect_codex_jobs", {}); // id 2
  c.proc.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:2}})+"\n");
  await pending;
  const result = await c.call("collect_codex_jobs", {});
  assert.match(c.text(result), /background result/);
});

test("cancelling an unknown ID does not poison a later request", async (t) => {
  const { c } = fixture(t, 'setTimeout(()=>console.log("not cancelled"),50);');
  c.proc.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:1}})+"\n");
  const result = await c.call("ask_codex", {question:"q"});
  assert.equal(result.result.isError, false);
  assert.match(c.text(result), /not cancelled/);
});

test("Git v2 parses a staged rename with spaces without losing either path", async (t) => {
  const { dir, bin, c } = fixture(t);
  const repo = repository(dir);
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), `
if(process.argv.includes("app-server"))process.exit(0);
import {spawnSync} from "node:child_process";
spawnSync("git", ["mv", "tracked.txt", "renamed file.txt"]); console.log("done");`);
  const result = await c.call("delegate_to_codex", {task:"t",cwd:repo});
  assert.match(c.text(result), /R  "renamed file\.txt" <- tracked\.txt/);
});

test("Git detects same-status mode changes and files at the hash-size boundary", async (t) => {
  const { dir, bin, c } = fixture(t);
  const repo = repository(dir);
  fs.writeFileSync(path.join(repo, "exact-limit.txt"), "a".repeat(2_000_000));
  fs.writeFileSync(path.join(repo, "above-limit.txt"), "a".repeat(2_000_001));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "large files");
  fs.appendFileSync(path.join(repo, "tracked.txt"), "dirty\n");
  // Keep both large entries dirty before the delegation and retain their sizes.
  for (const name of ["exact-limit.txt", "above-limit.txt"]) {
    const fd=fs.openSync(path.join(repo,name),"r+"); fs.writeSync(fd,Buffer.from("b"),0,1,0); fs.closeSync(fd);
  }
  fs.writeFileSync(path.join(bin, "codex.stub.mjs"), `
if(process.argv.includes("app-server"))process.exit(0);
import fs from "node:fs";
for(const name of ["exact-limit.txt","above-limit.txt"]) {
 const fd=fs.openSync(name,"r+"); fs.writeSync(fd,Buffer.from("c"),0,1,0); fs.closeSync(fd);
}
if(process.platform!=="win32")fs.chmodSync("tracked.txt",0o755);
console.log("done");`);
  const result = await c.call("delegate_to_codex", {task:"t",cwd:repo});
  assert.match(c.text(result), / M exact-limit\.txt/);
  assert.match(c.text(result), / M above-limit\.txt/);
  if(process.platform!=="win32")assert.match(c.text(result), / M tracked\.txt/);
});

test("stdio null JSON-RPC is an invalid request, then normal calls still work", async (t) => {
  const { c } = fixture(t);
  const reply = new Promise((resolve) => {
    let buffer="";
    const listen=(chunk)=>{
      buffer+=chunk;
      if(!buffer.includes("\n"))return;
      c.proc.stdout.removeListener("data",listen);
      resolve(JSON.parse(buffer.split("\n")[0]));
    };
    c.proc.stdout.on("data",listen);
  });
  c.proc.stdin.write("null\n");
  assert.equal((await reply).error.code,-32600);
  assert.equal((await c.init()).result.serverInfo.name,"agent-bridge");
});

test("the budget scenario completes verified delegations and detects small-task losses", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT,"scripts","budget.mjs"),"--files","1","--lines","40","--written","15"],
    { encoding:"utf8",timeout:15_000 });
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/Delegating costs MORE here/);
});
