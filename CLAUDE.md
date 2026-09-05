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

`src/agent-bridge.mjs` is the only copy that gets edited. The build copies it into
each package; those copies are gitignored. If you find yourself editing a file
under `packages/*/server/`, stop, that change will be overwritten.

## Commands

```
npm run check      syntax check both JS entry points
npm test           full suite, ~30s, spawns real processes
npm run build      both bundles into dist/
npm run build mcpb just the Claude Desktop bundle
```

Bumping a version means editing `package.json` only. The build syncs it into both
manifests and into the server's `serverInfo`.

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
calls start returning nothing, compare the `args` arrays against `codex exec
--help` and `claude --help` before looking anywhere else. `codex exec -` for
reading the prompt from stdin is the flag most worth checking; `AGENT_BRIDGE_CODEX_STDIN=0`
falls back to argv.

**Tool descriptions are the prompt.** They are what decides whether the calling
model reaches for a tool and when. Editing them is a behaviour change, not a docs
change. Conserve mode works entirely by rewriting them.

**Kill the tree, not the child.** `taskkill /t` on Windows, a negative pid on
POSIX. Killing only the direct child leaves an agent editing files with nobody
watching. There is a test for this; keep it passing.

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
- **Enforce permissions.** MCPB has no permissions model and neither does this.
  The safety is the sandbox flags passed to the CLIs, nothing structural.

## Unverified

- `codex app-server`'s `account/rateLimits/read` is an internal method name and
  may move. There is a fallback, and failure is silent by design.
- `codex -a never` and `-c model_reasoning_effort=...` are taken from Codex docs
  and issue threads, not tested against a live CLI here. Both are behind env vars
  that can drop them.
- The Codex desktop app reportedly shares MCP config with the Codex CLI. Sources
  conflict. The CLI and IDE extension are certain; the desktop app is not.
