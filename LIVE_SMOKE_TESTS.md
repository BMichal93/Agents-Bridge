# Target-machine release gate

Use a disposable Git repository, an authenticated Codex CLI, and the intended
MCP host. Claude Code CLI is optional unless certifying `ask_claude` or using
Claude Code as the calling host; Claude Desktop-to-Codex does not require it.
Do not paste tokens or session files into the return pack.
Do not install CLIs, change managed policy, expose an HTTP port or enable remote
writes without the user's agreement. Keep the candidate unreleased until the
relevant checks pass.

## 1. Basic compatibility

Record OS, Node version, `codex --version`, and `claude --version` when applicable.
Run `npm run check`, `npm test`, and `npm run doctor` from extracted source.
Doctor may consume a small amount of model quota. Inspect individual results,
not just exit code: absent CLIs are skipped, never counted as live passes.

Required: Codex read-only JSONL passes and required safety flags remain present.
If certifying `ask_claude`, its bridge call must also answer. An optional persistence fallback is
permitted only with its warning. A usage-display failure need not block
delegation, but record it separately.

## 2. Read-only review

Ask the calling host to delegate a small review without naming a provider.
Confirm an actual `ask_codex` tool invocation in its tool trace. Repeat with two
independent implementation tasks and confirm `start_codex_jobs` and collection.
This checks whether the host follows the advertised preference; the bridge
cannot enforce selection of the host's native subagents. An explicit request
for a Claude review should still permit `ask_claude`.

Register the candidate with the host you intend to use. In the disposable repo,
create a harmless text file and record Git status before asking `ask_codex`
to explain it. Repeat with `ask_claude` only if certifying that optional path.
Verify each tested tool answers without modifying project files.
Also inspect the installed CLI's effective tools/configuration: clean Git status
does not prove there were no external side effects.

## 3. Verified write and lane resume

Prepare `package.json` in the disposable repo:

```json
{"private":true,"scripts":{"test":"node verify.cjs"}}
```

Prepare `verify.cjs`:

```js
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert.ok(["READY\n", "RESUMED\n"].includes(fs.readFileSync("bridge-smoke.txt", "utf8")));
```

Commit the fixture. Using the host's `delegate_to_codex` tool, call:

```json
{
  "task": "The project codename is BIRCH. Create bridge-smoke.txt containing READY followed by one newline. Do not alter the fixture or other files.",
  "cwd": "REPLACE_WITH_ABSOLUTE_DISPOSABLE_REPO_PATH",
  "files": "bridge-smoke.txt",
  "constraints": "Leave package.json and verify.cjs unchanged.",
  "acceptance": "Only bridge-smoke.txt is added; npm test passes.",
  "verify": "npm test",
  "lane": "live-smoke"
}
```

Then use the same cwd/lane/files/verify fields with this task:

> Replace bridge-smoke.txt with RESUMED followed by one newline. Leave the
> fixtures unchanged. In the answer, recall the project codename from the first
> task in this lane.

Required: both checks pass, output remains concise, the second run resumes the
same recorded thread (inspect local invocation evidence), and file contents
match. Recalling BIRCH is useful corroboration, not proof by itself.
If resume fails, record it; `AGENT_BRIDGE_CODEX_RESUME=0` is a documented fallback,
not a live-resume pass.

## 4. Failure and cancellation

- Ask for a harmless task with `verify` set to `node --version` using the default
  verification allowlist. It must return a skipped-check error, not success.
  Do not expand the allowlist just to pass this negative test.
- Start two small non-overlapping background jobs, collect, and inspect both
  results. Same-lane jobs should serialize.
- Cancel a long read-only call in the host. Confirm its peer process tree exits.
  Repeat on Windows if Windows is the deployment target.
- If HTTP is intended, test loopback only: wrong secret rejected, disallowed
  Origin rejected, valid request works, disconnect stops direct work.
  Do not expose the endpoint publicly for a smoke test.

## 5. Installer acceptance and return record

Test MCPB in Claude Desktop and/or VSIX in VS Code for the intended installation.
Mark an untested host as blocked or out of scope; do not claim both are certified.
Restart pre-existing CLI sessions after registration. Confirm the server reports
0.9.9 and unrelated existing skills/settings remain intact.

Return a matrix: test name, pass/fail/blocked, OS/CLI versions, observed result,
and any artifact/commit changes. Keep test projects and personal paths out of the
pack. Do not include credentials, complete CLI session logs, or capability URLs.
