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

Start the current return review from `START_HERE_CLAUDE.md` and
`CODEX_REVIEW_0.9.9.md`. Earlier reviews/responses are preserved as history.

The user's preferred subagent provider is ChatGPT/Codex through Agent Bridge
tools: `ask_codex` for review, `delegate_to_codex` for one build, or
`start_codex_jobs` / `collect_codex_jobs` for background work. This uses the local
Codex CLI. Keep orchestration and acceptance review with the caller; respect
explicit provider choices and report tool failures without silent fallback.

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

**CLI flags drift.** Both Codex and Claude Code change flags between releases.
Claude explicitly documents that `claude --help` omits some flags, so help is an
advisory, not a compatibility test. Run `npm run doctor`: its Claude probe calls
the actual MCP tool (including fallback); Codex probes the baseline argv. Codex calls request JSONL with `--json`;
`thread.started` supplies the lane session ID and the last completed
`agent_message` supplies returned text. Keep the plain-text fallback for old
releases and test doubles.

**Read-only means configuration isolation too.** `ask_codex` combines a read-only
sandbox with `--ephemeral --ignore-user-config --ignore-rules`. These are not a
universal external-tool sandbox or a managed-policy override. `ask_claude` combines
`--restricted --bare --no-session-persistence` with an explicit read-only tool
list and MCP denial. Do not weaken one layer because another appears redundant.
Restricted mode requires Claude Code 2.1.248 or newer.

**MCP has two eras.** Legacy clients initialize and negotiate a supported
version. MCP 2026-07-28 uses per-request metadata and `server/discover`, and
modern results require `resultType`; list results also require cache metadata.
HTTP mirrors protocol, method and name into headers that must match the body.
Keep both paths and their integration tests unless client support is deliberately
dropped.

**Tool descriptions are the prompt.** They are what decides whether the calling
model reaches for a tool and when. Editing them is a behaviour change, not a docs
change. Conserve mode works entirely by rewriting them.

**Kill the tree, not the child.** `taskkill /t` on Windows, a negative pid on
POSIX. Killing only the direct child leaves an agent editing files with nobody
watching. There is a test for this; keep it passing.

## The verify path runs a model-supplied command

`delegate_to_codex` and the job tools accept a `verify` command and the bridge
runs it. Only the first token is matched against `AGENT_BRIDGE_VERIFY_ALLOW`.
That is not a sandbox: npm scripts, npx and language runtimes can execute
arbitrary trusted repository code with the user's privileges. POSIX starts the
executable directly. Windows `.cmd` shims require `cmd.exe`, so every token
containing a shell metacharacter is rejected. Quoted arguments are tokenized
without invoking a shell. If you widen this, keep all controls and the warning.

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
  after two failures in a session the tool stops calling it. The single documented
  optional-flag compatibility retry below is the exception; it keeps the same provider.
- **Provide a general permissions system.** The bridge applies fixed safety
  boundaries: CLI sandboxes, a verification allowlist and stricter remote-mode
  behavior. It does not implement user identities or per-tool authorization.

## Required flags versus hygiene flags

`ask_claude` splits its arguments in two. `--restricted`, `--bare`, `--tools` and
`--disallowedTools` carry the read-only guarantee: if the installed CLI rejects
one, the call fails loudly and is never retried without it, because a silent
retry would leave the tool looking read-only while it was not. Everything in
`CLAUDE_OPTIONAL_FLAGS` is hygiene and is dropped on rejection with a note in the
reply.

Only an anchored parser error on stderr with exit 1/2 and no stdout qualifies
for the one optional retry. Do not infer rejection from an answer quoting an
error, or retry after a signal/timeout. Both attempts share one time budget.
Dropping persistence hygiene may retain sensitive prompts locally; document it.

## 0.9.9 regression invariants

- Parse JSON-RPC envelopes before accessing fields; malformed HTTP bodies must
  return errors without killing the server. Validate job batches before launch.
- Track active cancellation scopes only, clean up HTTP keep-alive listeners,
  and preserve background results when collection is cancelled.
- Parse Codex JSONL incrementally, before output trimming. Errors survive noisy
  streams; oversized events and absent final messages fail explicitly.
- Git porcelain v2 paths resolve from the repository root; include index object
  IDs and modes. Take the final snapshot after verification.
- A requested verification that never ran is not success. Do not launch verify
  after a failed/cancelled peer or when remote writes are disabled.

`--no-session-persistence` is in the optional set for a reason: it has been
removed from the CLI at least once and shipped as a no-op in another release,
and it contributes nothing to isolation that `--restricted` and `--bare` do not
already provide. Put a new flag in the required set only if losing it would
weaken the contract.

## Unverified against a live CLI

The suite substitutes stub executables, so it proves the bridge's behaviour and
nothing about whether the real CLIs accept these. `npm run doctor` runs the exact
read-only invocations and probes the app-server method. Run it after installing
and after either CLI updates. It deliberately does not make a write-mode call or
resume a real lane.

- A real write-mode Codex delegation. Doctor stays read-only by design.
- A real `codex exec resume`. Doctor checks its advertised syntax and validates
  `thread.started.thread_id` in a cold JSONL run, but does not spend a second
  agent call resuming it. `AGENT_BRIDGE_CODEX_RESUME=0` disables lanes.
- Windows behavior beyond CI.
- The Codex desktop app reportedly shares MCP config with the Codex CLI. Sources
  conflict. The CLI and IDE extension are certain; the desktop app is not.

## Output is spent from the caller's context

Everything a tool returns occupies the caller's context on later turns, so size
is a feature, not a detail. Child output is bounded while it runs, replies are
trimmed again to `AGENT_BRIDGE_MAX_REPLY_CHARS`, working-tree reporting is a
fingerprinted bounded delta rather than two full listings, the project context is capped, and `start_codex_jobs`
deliberately carries short field descriptions because the full guidance is
already on `delegate_to_codex`. Tool definitions alone cost roughly 2300 tokens
per session, and a test fails if they pass 11000 bytes. Before adding prose to a
description, weigh it against that, and run `npm run budget` to see the effect on
a whole session.


## Coordination and remote access

Background job claims are process-wide and use normalized absolute paths
(case-folded on Windows). A directory overlaps its descendants. Missing paths
and globs claim the entire workspace. A global concurrency cap and outstanding
queue cap bound resource use, and jobs sharing a lane serialize even when their
files differ. Claims are scheduling declarations, not edit permissions or
cross-process locks. Queued jobs must resolve as failures during shutdown;
otherwise they can start after the host has disappeared.

HTTP capability secrets must never appear in diagnostics. Validate Origin before
processing a browser request, validate modern MCP headers against the body, and
treat a closed connection as cancellation even when it closes before the peer
process starts. A background job is intentionally detached from its initiating
request's cancellation scope but remains owned by host shutdown.

`AGENT_BRIDGE_REMOTE_WRITES=0` applies to every direct write path, not only the
Codex sandbox. Project-context writes are hidden and rejected, and verification
commands are skipped. Any new tool that writes outside Codex must set
`requiresWrites: true` and receive a remote-mode test.
