# Agent Bridge 0.9.1 handoff

This document records the Codex review and resulting fixes so Claude can resume
work without reconstructing the analysis.

## Intended product

Agent Bridge is a local MCP server. Claude Code or Claude Desktop can invoke it
to run OpenAI Codex non-interactively. Codex and VS Code can invoke its
`ask_claude` tool for a read-only second opinion from Claude Code. Authentication
stays inside the respective CLIs.

The primary division of work is:

- Claude keeps conversation context, decides the design and prepares a precise
  handoff.
- Codex implements the settled task inside its workspace sandbox.
- Agent Bridge runs a caller-supplied verification command, reports Git status
  and returns Codex's short final message.
- Claude assesses the verdict and unexpected changes before continuing.

The bridge does not control an existing ChatGPT or Claude chat window and does
not automatically transfer chat history.

## Review findings and fixes

| Review finding in 0.9.0 | Fix in 0.9.1 | Regression coverage |
| --- | --- | --- |
| VS Code passed an object to a positional MCP constructor | Use `new McpStdioServerDefinition(label, command, args, env, version)` with `process.execPath` | Syntax check plus package inspection |
| Remote read-only mode still ran verification and `set_project_context` writes | Skip host verification, hide and reject write-required tools unless `AGENT_BRIDGE_REMOTE_WRITES=1` | HTTP integration test verifies neither marker is written |
| Non-zero CLI exits with stdout looked successful | Check exit code, signal and JSONL failure events; preserve partial diagnostics | Non-zero process with partial stdout returns `isError: true` |
| Lane IDs were guessed incorrectly from rollout filenames and shared globally | Parse `thread.started.thread_id` from Codex JSONL and store lanes beneath the absolute repository path | JSONL and repository-scoped lane tests |
| File overlap was checked only inside one start request and overlapping work was discarded | Add a server-wide scheduler with normalized parent/child overlap detection and a real queue | Separate start calls targeting `src` and `src/shared.ts` run serially |
| `ask_claude --allowedTools` did not actually restrict available tools | Use `--tools Read,Grep,Glob` and `--disallowedTools mcp__*` | Argument integration test |
| `git diff --stat HEAD` omitted untracked files and blurred pre-existing work | Capture `git status --short --untracked-files=all` before and after; label the earlier state | Untracked-file integration test |
| Verification children survived host shutdown | Track verification children with other spawned process trees | Marker test confirms verification is killed |
| Windows `.cmd` launching could interpret model-supplied verification metacharacters | Reject Windows shell metacharacters after checking the executable allowlist | Windows CI must retain the existing metacharacter test and add coverage for verification when practical |
| Usage parser expected outdated snake_case fields and incomplete initialization | Complete initialize/initialized handshake and parse current camelCase plus legacy snake_case | App-server stub exposes current response fields and footer reports 75% |
| The server advertised version 0.6.0 | Introduce one `SERVER_VERSION` constant and make the build synchronize that exact declaration | Handshake asserts 0.9.1 |
| CLI-launched bridge processes lost VS Code path and conserve settings | Persist non-secret extension settings to `~/.agent-bridge/settings.json` | Code path documented; suitable for a VS Code-host test later |

## Files changed

- `src/agent-bridge.mjs`: process results, JSONL, lanes, job scheduler, Git
  status, remote permissions, usage parsing, cancellation and version.
- `packages/vscode/extension.js`: correct MCP constructor and persisted settings.
- `packages/vscode/package.json` and `packages/mcpb/manifest.json`: version and
  description.
- `scripts/build.mjs`: exact version synchronization.
- `test/bridge.test.mjs`: regression suite.
- `README.md`, `packages/vscode/README.md`, `CLAUDE.md`, `CHANGELOG.md`: setup,
  maintenance and release documentation.

## Validation performed

```text
npm run check
npm test
```

The suite passes 30 tests on Linux. Tests drive the real MCP server over stdio
and HTTP while substituting local stub executables for Codex and Claude. They do
not consume either provider's quota.

Before publishing, run the same suite on Windows through GitHub Actions and do
three manual smoke tests on a machine with authenticated CLIs:

1. Install the VSIX and confirm VS Code lists all six Agent Bridge tools.
2. From Claude Code, delegate a small change with `verify` and a `lane`, then
   delegate a follow-up with the same lane.
3. From Codex, invoke `ask_claude` and confirm Claude can inspect the repository
   but cannot edit or call MCP tools.

## Remaining limits

- Direct blocking delegations are not scheduled against each other. Use
  `start_codex_jobs` for coordinated concurrent work.
- Git can distinguish entries already present before delegation, but it cannot
  perfectly attribute additional edits to a file that was already dirty.
- Verification accepts a command plus whitespace-separated arguments; it is not
  a shell and intentionally does not implement pipes, redirection or compound
  commands.
- HTTP mode uses a capability secret in the URL and is intended to sit behind a
  separately authenticated tunnel. Keep it off when it is not needed.
- Codex usage display is best-effort. It never blocks task completion.

## Suggested next decision

Keep 0.9.1 focused on reliable Claude-to-Codex delegation. If fully symmetric
implementation delegation is desired later, design `delegate_to_claude` as a
separate feature with explicit Claude permission flags, matching remote-mode
controls and its own write-path tests. Do not turn `ask_claude` into a write tool
silently because callers rely on its read-only contract.
