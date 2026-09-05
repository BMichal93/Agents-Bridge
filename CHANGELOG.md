# Changelog

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
