# Agent Bridge

Hands coding work to OpenAI Codex from Claude and Copilot, and gets second
opinions from it. Install, and it works until you disable it.

## What you get

| Tool | What it does | Writes files |
| --- | --- | --- |
| `ask_codex` | Ask Codex a question | no |
| `delegate_to_codex` | Hand Codex a unit of work to carry out | yes |
| `ask_claude` | Ask Claude Code a question | no |

Each takes an `effort` of `fast`, `balanced` or `deep`, chosen from the task.
Delegations come back with Codex's summary plus `git diff --stat`, so the calling
agent can check what actually changed instead of trusting the summary.

## Requirements

The Codex CLI installed and signed in. Claude Code too, if you want `ask_claude`.
This extension does not talk to any API itself; it runs the CLIs you already have.

## Settings

- **Default project** - folder Codex runs in when a request does not name one.
  Blank uses the open workspace.
- **Conserve mode** - makes delegating the default rather than the exception. Turn
  it on when you are short on Claude usage. There is a command for it too.
- **Codex path / Claude path** - only needed if they are not on your PATH.

## Codex and Claude Code

VS Code starts and stops the MCP server with this extension, so disabling the
extension really does turn it off and no config file is edited. The Codex and
Claude Code CLIs keep their own config and cannot be reached that way, so the
extension offers once to register there as well. Undo with **Agent Bridge: Remove
from Codex and Claude Code**.

## What it does not do

- It cannot see how much Claude usage you have left. No MCP server can; nothing in
  the protocol exposes it. Conserve mode is a switch you flip, not a detection.
- It does not retry silently or fall back to another provider. If Codex is
  uninstalled, signed out or out of quota, the call fails fast with the likely
  reason, and after two failures in a session it stops calling it at all.
- It has no permissions model beyond the sandboxes it passes to the CLIs. Codex
  runs read-only for questions and `workspace-write` for delegations.
