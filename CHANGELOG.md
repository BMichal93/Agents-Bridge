# Changelog

## 0.9.9

- Prefer OpenAI Codex for tool-based subagent work in both MCP discovery paths,
  tool descriptions and the installed Claude skill. Preserve explicit provider
  choices and visible failures; clarify the limits of verification and Git deltas.
- Retain Claude's optional-versus-required flag split. Recognize quoted parser
  diagnostics on stderr, avoid replaying partial answers, share one timeout.
- Make the Claude doctor probe call the actual MCP tool (including fallback).
- Reject malformed JSON-RPC and invalid batches before execution; prevent null
  HTTP body crashes and clean up keep-alive cancellation listeners.
- Track active cancellation IDs only and retain results of cancelled collections.
- Parse Codex JSONL incrementally so trimming cannot hide failure events.
  Preserve split UTF-8; fail on oversized events or missing final answers.
- Resolve Git porcelain v2 paths from the repository root; include index hashes,
  modes, and verification side effects in the final observations.
- Requested verification must run and pass; do not execute it after failed peers.
- Correct the budget demo to actually verify and resume its stub lane, and fail
  the demo when a scenario fails instead of silently measuring error responses.
- Add 20 regression tests and a target-machine release gate. See
  CODEX_REVIEW_0.9.9.md and LIVE_SMOKE_TESTS.md.

## 0.9.8

- Response pack for the Codex 0.9.7 review: START_HERE_CODEX.md and
  CLAUDE_RESPONSE.md.

- `ask_claude` now separates the flags that carry its read-only guarantee from
  the ones that are only hygiene. A Claude Code that rejects
  `--no-session-persistence` is retried without it and the substitution is
  reported; a Claude Code that rejects `--restricted` fails loudly and is never
  retried unrestricted. Previously either rejection failed the call outright, and
  two of them opened the circuit breaker and disabled the tool for the session.

## 0.9.7

- Harden `ask_codex` with ephemeral sessions plus ignored user config/rules, and
  harden `ask_claude` with restricted, bare, non-persistent execution in
  addition to its explicit read-only tool list.
- Support both legacy initialize-based MCP and MCP 2026-07-28 discovery,
  per-request metadata and result fields. Modern HTTP requests validate mirrored
  protocol, method and tool-name headers.
- Validate HTTP Origin, redact the capability secret from diagnostics, return
  empty 202 responses for notifications, bound request bodies, and cancel the
  attached process when a client disconnects—even before the child starts.
- Replace status-line-only Git deltas with NUL-safe porcelain parsing and file
  fingerprints, detecting repeat edits to dirty files and dirty entries that
  became clean. Disable Git fsmonitor hooks during snapshots.
- Bound child output in memory while preserving Codex's opening thread ID and
  final message. Bound app-server and rollout-log usage probes too.
- Cap background concurrency, jobs per call and outstanding jobs; serialize a
  shared lane; validate lane names and job IDs; discard collected jobs; normalize
  Windows claims case-insensitively; save lane state atomically.
- Parse quoted verification arguments and document that the executable allowlist
  is not a sandbox: verification executes trusted repository code as the user.
- Make doctor help checks advisory and add exact live read-only probes for both
  CLIs plus the Codex app-server method.
- Give the installed Claude delegation skill a collision-resistant managed name;
  upgrades and removal no longer recursively delete a generic user skill folder.
- Correct the budget explanation: Codex quota is consumed only by delegated
  work, and the estimate does not model provider caching or total billing.
- Expand integration coverage from 37 to 47 tests.

## 0.9.6

- Fix: `doctor` matched flags as substrings, so `-a` was "found" inside
  `--allowedTools` and `--tools` inside `--allowedTools`. Short flags always
  passed and the script reported health it had never checked. Matching is now
  token-bounded and unit-tested.

## 0.9.5

- `npm test` now synchronises versions first. Bumping `package.json` and running
  the tests used to fail until you also ran a build, because the server's version
  was only synchronised at build time and the handshake test compares the two.

## 0.9.4

- `npm run budget` measures what the pack costs and saves, counting design
  reading, handoff writing, results and tool definitions against the delegated
  side. Reports a loss on small tasks rather than hiding it.
- Full-session integration test asserting each step stays small, plus a ceiling
  test on the size of the tool definitions, which are re-sent every turn.

## 0.9.3

- Working-tree reporting is now a bounded delta. It previously printed the full
  `git status` twice, so a repository that was already dirty spent hundreds of
  tokens per delegation restating what had not changed. Pre-existing entries are
  counted, new ones listed up to `AGENT_BRIDGE_MAX_STATUS_LINES`, and the
  attribution limit is stated rather than implied.
- `npm run doctor` checks the installed Codex and Claude CLIs still accept every
  flag the bridge relies on, including `claude --tools`, and makes one live
  read-only Codex call.
- `start_codex_jobs` no longer repeats the full field guidance already carried by
  `delegate_to_codex`, cutting roughly 200 tokens from every session.
- Settings reference added to the README; the build now syncs download filenames
  in the docs, and the version test reads package.json instead of a literal.

## 0.9.2

- Fix: background-job file claims were split only on commas and newlines, so a
  space-separated `files` list collapsed into one nonsense path that overlapped
  with nothing. Two jobs naming the same file could then run at the same time,
  which is what the scheduler exists to prevent. Splitting now also handles
  whitespace, quoted paths stay intact, and the schema says so.

## 0.9.1

- Fixed VS Code MCP registration to use the public positional constructor and
  the extension host's Node.js executable.
- Codex calls now consume the documented JSONL event stream. Final messages and
  session IDs are parsed explicitly; lanes are scoped to their repository.
- A non-zero or signalled CLI exit is always reported as a failure, even if the
  process emitted partial stdout.
- Remote read-only mode now blocks project-context writes and host verification
  commands as well as running Codex in its read-only sandbox.
- Background jobs use a server-wide path scheduler. Overlapping paths queue
  across separate calls, while independent jobs continue in parallel.
- Working-tree reports include untracked files and label entries that existed
  before delegation.
- `ask_claude` now restricts built-in tools with `--tools` and blocks MCP tools.
- Verification processes participate in shutdown and MCP cancellation cleanup.
- Windows command launches reject shell metacharacters in executable paths and
  arguments before invoking required `.cmd` shims through `cmd.exe`.
- Codex usage parsing follows the current app-server camelCase response and its
  initialize/initialized handshake, while keeping compatibility with older
  snake_case records.
- VS Code settings are saved for bridge processes launched by Codex and Claude
  Code after CLI registration.
- Expanded the integration suite from 23 to 30 tests and documented setup,
  trust boundaries, normal workflow and remaining limitations.

## 0.9.0

- Shared project context: `.agent-bridge/context.md` in the repository is
  prepended to every delegation, so task descriptions stop re-explaining the
  architecture. `set_project_context` writes it.
- Conversation lanes: name a thread of related builds and Codex resumes the same
  session, keeping what it already read and decided. Skipped on resumed sessions
  so the context is not paid for twice.

## 0.8.0

- Reframed around an architect/builder split: Claude designs, Codex implements.
  Delegating implementation is now the default rather than the exception.
- `verify` command on delegations. The bridge runs it after Codex finishes and
  reports the verdict first, so a passing check costs one line instead of a diff
  to read. Allowlisted by first token.
- `start_codex_jobs` and `collect_codex_jobs`: background, parallel builds.
  Non-overlapping `files` run at once; overlapping ones are held back.
- Delegations with no `verify` say so rather than looking confirmed.

## 0.7.0

- Result footer and VS Code status bar showing effort tier, model, duration and
  remaining Codex usage.
- Codex usage read via `codex app-server`, falling back to local rollout logs.
  Never blocks a call; cache warms in the background.
- Claude usage deliberately not shown; no supported route exists.

## 0.6.0

- Packaged as a `.mcpb` for Claude Desktop and a `.vsix` for VS Code, replacing
  the install script.
- The VS Code extension registers the server through VS Code's own API, so
  disabling the extension really stops it and no config file is edited.

## 0.5.0

- Effort tiers (`fast`, `balanced`, `deep`) mapped to models via `models.json`.
- Conserve mode, with `tools/list_changed` so running sessions pick it up.
- Optional HTTP transport for the Claude mobile app, read-only by default.

## 0.4.0

- Circuit breaker after repeated peer failures, with a guess at the cause.
- Child processes killed with the host, including the whole process tree.

## 0.3.0

- `delegate_to_codex`, which writes files and reports `git diff --stat`.
- Reply trimming so a verbose peer cannot eat the caller's context.

## 0.2.0

- Rewritten with no dependencies; the MCP stdio transport implemented directly.

## 0.1.0

- First version: `ask_codex` and `ask_claude` over the MCP SDK.
