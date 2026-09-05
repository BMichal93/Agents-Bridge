# agent-bridge

An MCP server that lets Claude and Copilot hand coding work to OpenAI Codex, plus
the two bundles that install it.

## Layout

```
src/agent-bridge.mjs        the MCP server. One file, zero dependencies.
packages/mcpb/              Claude Desktop bundle (manifest.json)
packages/vscode/            VS Code extension (package.json, extension.js)
scripts/build.mjs           copies src/ into both packages and packs them
test/                       node:test suite, drives the real server over stdio
```

`src/agent-bridge.mjs` is the only server copy that gets edited. The build copies it into
each package; those copies are gitignored. If you find yourself editing a file
under `packages/*/server/`, stop, that change will be overwritten.

## Commands

```
npm run check      syntax check both JS entry points
npm test           full suite, ~30s, spawns real processes
npm run build      both bundles into dist/
npm run build mcpb just the Claude Desktop bundle
```

Bumping a version means editing `package.json` only. `npm test` and `npm run
build` both synchronise it into the manifests, the docs' download filenames and
the server's `SERVER_VERSION`, so the order you run them in does not matter.

## Things that will bite you

**stdout belongs to the protocol.** Every diagnostic goes to stderr. One stray
`console.log` corrupts the JSON-RPC stream and the host silently drops the
connection.

**Windows spawning.** `claude` and `codex` install as `.cmd` shims, which Node
cannot spawn directly, so on Windows everything goes through `cmd.exe /d /s /c`.
Every argument handed to cmd.exe must be a literal from the source, never text
from a model.

**The prompt goes on stdin, never argv.** Prompts contain quotes, `%`, `&` and
`^`, all meaningful to cmd.exe, and argv has a length limit a forwarded diff will
hit. The only free-form value that reaches argv is `model`, and it is checked
against `^[A-Za-z0-9._:-]+$` first. Do not add a second one without the same
check.

**CLI flags drift.** Both Codex and Claude Code change flags between releases. If
calls fail, compare the `args` arrays against `codex exec --help` and `claude
--help`. Codex calls request JSONL with `--json`; `thread.started` supplies the
lane session ID and the last completed `agent_message` supplies returned text.
Keep the plain-text fallback for old releases and test doubles.

**Tool descriptions are the prompt.** They are what decides whether the calling
model reaches for a tool and when. Editing them is a behaviour change, not a docs
change. Conserve mode works entirely by rewriting them.

**Kill the tree, not the child.** `taskkill /t` on Windows, a negative pid on
POSIX. Killing only the direct child leaves an agent editing files with nobody
watching. There is a test for this; keep it passing.

## The verify path runs a model-supplied command

`delegate_to_codex` and the job tools accept a `verify` command and the bridge
runs it. That is a step beyond spawning a fixed CLI, so only the first token is
matched against `AGENT_BRIDGE_VERIFY_ALLOW`. POSIX starts the executable directly.
Windows `.cmd` shims require `cmd.exe`, so every token containing a shell
metacharacter is rejected. If you widen this, keep both controls.

## Testing philosophy

The tests drive the real server over real stdio with stub CLIs, rather than unit
testing pure functions. Every bug found while building this lived in the
transport or the process handling: a failure-counter keyed on the wrong string, a
reply truncated by an eager `process.exit`, an orphaned grandchild. A unit test of
the argument builder would have caught none of them.

Each test gets its own temporary `HOME`, so nothing reads or writes the real
`~/.agent-bridge`.

## What this deliberately does not do

- **Read Claude's remaining usage.** No supported route exists; nothing in MCP
  exposes the calling session's budget. Conserve mode is a switch the user flips,
  not a detection. Do not add a scraped version without labelling it as a guess in
  the UI.
- **Read the OpenAI token from `~/.codex/auth.json`.** Codex usage comes from
  `codex app-server` (Codex owns the auth) or the local rollout logs. Going
  through the token would mean this process handling credentials, which is too
  much for a status line.
- **Retry or fall back to another provider.** A failed peer fails visibly, and
  after two failures in a session the tool stops calling it.
- **Provide a general permissions system.** The bridge applies fixed safety
  boundaries: CLI sandboxes, a verification allowlist and stricter remote-mode
  behavior. It does not implement user identities or per-tool authorization.

## Unverified against a live CLI

The suite substitutes stub executables, so it proves the bridge's behaviour and
nothing about whether the real CLIs accept these. **`npm run doctor` checks every
item on this list**; run it after installing and after either CLI updates.

- `claude --tools`. This is the one that matters. `--allowedTools` only skips
  permission prompts and appends to the default tool set, so if `--tools` ever
  goes away, `ask_claude` stops being read-only while still looking like it is.
- `codex exec resume` and the `thread.started.thread_id` field in the JSONL
  stream. Lanes depend on both; `AGENT_BRIDGE_CODEX_RESUME=0` disables them.
- `codex -a never` and `-c model_reasoning_effort=...`, both behind env vars that
  can drop them.
- `codex app-server`'s `account/rateLimits/read` is an internal method name and
  may move. There is a fallback and failure is silent by design.
- The Codex desktop app reportedly shares MCP config with the Codex CLI. Sources
  conflict. The CLI and IDE extension are certain; the desktop app is not.

## Output is spent from the caller's context

Everything a tool returns is re-sent on every later turn of the caller's session,
so size is a feature, not a detail. Replies are trimmed to
`AGENT_BRIDGE_MAX_REPLY_CHARS`, working-tree reporting is a bounded delta rather
than two full listings, the project context is capped, and `start_codex_jobs`
deliberately carries short field descriptions because the full guidance is
already on `delegate_to_codex`. Tool definitions alone cost roughly 2300 tokens
per session, and a test fails if they pass 11000 bytes. Before adding prose to a
description, weigh it against that, and run `npm run budget` to see the effect on
a whole session.


## Coordination and remote access

Background job claims are server-wide and use normalized absolute paths. A
directory overlaps its descendants. Missing paths and globs claim the entire
workspace. Preserve that conservative behavior when changing the scheduler.
Queued jobs must resolve as failures during shutdown; otherwise they can start
after the host has disappeared.

`AGENT_BRIDGE_REMOTE_WRITES=0` applies to every direct write path, not only the
Codex sandbox. Project-context writes are hidden and rejected, and verification
commands are skipped. Any new tool that writes outside Codex must set
`requiresWrites: true` and receive a remote-mode test.
