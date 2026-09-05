# Changelog

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
