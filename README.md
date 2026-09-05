# agent-bridge

Hands coding work to OpenAI Codex from Claude and Copilot, and gets second
opinions from it. Install one file per host; it works until you disable it.

## Install

**Claude desktop app** - download the `.mcpb` from
[Releases](../../releases), double-click it, or drag it onto Settings >
Extensions. Toggle and configure it there.

**VS Code** - download the `.vsix`, then Extensions view, `...`, Install from
VSIX. On first activation it offers to register with the Codex and Claude Code
CLIs too, which is how those two get covered.

Requires the Codex CLI installed and signed in. Claude Code as well, for
`ask_claude`. This talks to no API itself; it runs the CLIs you already have.

## Tools

| Tool | What it does | Writes files |
| --- | --- | --- |
| `ask_codex` | Ask Codex a question | no |
| `delegate_to_codex` | Hand Codex a unit of work to carry out | yes |
| `ask_claude` | Ask Claude Code a question | no |

Each takes an `effort` of `fast`, `balanced` or `deep`, chosen from the shape of
the task and mapped to a model through `~/.agent-bridge/models.json`. Delegations
come back with Codex's summary plus `git diff --stat`, so the calling agent can
check what changed rather than trusting the summary.

Every result ends with a line like:

```
(delegate_to_codex · fast · model gpt-x-mini · 41s · Codex 5h 61% left, weekly 88% left)
```

In VS Code the same information sits in the status bar.

## Conserve mode

Flips the default so delegating becomes the normal thing rather than the
exception. Use it when you are short on Claude usage. It works by rewriting the
tool descriptions, which is the only lever that reaches the calling model's
decision, and the server notifies connected hosts so a running session picks it
up.

It is a switch, not a detection. No MCP server can see the remaining usage of the
session calling it.

## Development

```
npm run check    syntax check
npm test         full suite, spawns real processes with stub CLIs
npm run build    both bundles into dist/
```

`src/agent-bridge.mjs` is the single source; the build copies it into each
package. See [CLAUDE.md](CLAUDE.md) for the parts that will bite you.

## Honest limits

- Claude's remaining usage is not shown. There is no supported way to read it.
- Delegation saves usage only when a lot of work returns as something small you
  can verify. Work that produces a large diff you then read line by line costs
  about what writing it would have.
- Nothing locks files. Delegate work that touches different files from the ones
  you are in, or wait for the run to return.
- MCPB has no permissions model. The safety here is the sandbox flags passed to
  the CLIs, not anything the format enforces.

## Licence

MIT.
