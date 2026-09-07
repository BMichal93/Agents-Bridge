# Agent Bridge

Agent Bridge lets Claude, Codex and VS Code cooperate through local MCP tools.
Claude can delegate a self-contained implementation to the signed-in Codex CLI;
Codex and VS Code can ask the signed-in Claude Code CLI for a read-only review.

## Requirements

- Node.js 18 or newer
- Codex CLI installed and signed in
- Claude Code 2.1.248 or newer, installed and signed in, for `ask_claude`

The extension sends no API requests and reads no authentication tokens. It
launches your existing CLIs, which retain ownership of authentication.

## Setup

Install the VSIX, then accept the one-time prompt to enable Agent Bridge for the
Codex and Claude Code CLIs. Existing CLI sessions must be restarted. The command
palette also provides commands to enable, remove, configure and inspect the
bridge.

## Tools

| Tool | Purpose |
| --- | --- |
| `ask_codex` | Read-only Codex question or review |
| `delegate_to_codex` | One workspace-writing Codex implementation |
| `start_codex_jobs` | Concurrent builds with overlap queueing |
| `collect_codex_jobs` | Collect background results |
| `set_project_context` | Save repository context used by later handoffs |
| `ask_claude` | Restricted, bare Claude Code review with read-only built-in tools |

Give delegations a complete task, exact files, constraints, acceptance criteria,
a verification command and a lane name. Results place the verification verdict
first, followed by bounded working-tree observations. Fingerprints detect edits
to already-dirty files as well as new, cleared and untracked entries. Background
jobs are capped at four concurrent processes by default and same-lane work is
serialized.

Verification executes trusted repository commands with your user privileges;
the executable allowlist is not a security sandbox.

Settings configured in VS Code are saved for bridge processes later launched by
the CLIs. Disabling the VS Code extension stops its VS Code MCP server; use
**Agent Bridge: Remove from Codex and Claude Code** to remove persistent CLI
registrations.

The full setup guide, security behavior and limitations are in the repository
README.
