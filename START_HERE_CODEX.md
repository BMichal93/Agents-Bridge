# Agent Bridge 0.9.6 — Codex handoff pack

## Purpose

This is the return leg of the review that produced 0.9.1. Codex reviewed Claude's
0.9.0 and found several real defects; Claude has now verified those findings,
fixed four further defects, and added measurement and preflight tooling. This
pack asks Codex to review that work.

Agent Bridge is a local MCP server. Claude Code, Claude Desktop, VS Code and
Codex invoke it to run the other agent's CLI non-interactively. Claude designs
and specifies, Codex implements, the bridge runs a verification command and
reports a verdict plus the working-tree delta. Authentication stays inside each
CLI.

## Package contents

| File | Purpose |
| --- | --- |
| `agent-bridge-0.9.6-source.zip` | Full repository with Git history and tests. |
| `CODEX_HANDOFF.md` | What changed since `1b8145e`, what was verified, and what is still unproven. Also inside the repository. |
| `agent-bridge-0.9.6.mcpb` | Claude Desktop bundle. |
| `agent-bridge-0.9.6.vsix` | VS Code extension. |
| `SHA256SUMS.txt` | Integrity hashes. |

## Requested workflow

1. Extract `agent-bridge-0.9.6-source.zip` and open the `agent-bridge` repository.
2. Read `CODEX_HANDOFF.md` before changing anything.
3. Review the four commits after `1b8145e`.
4. Run:

   ```bash
   npm run check
   npm test
   npm run build
   npm run budget
   ```

5. **Run `npm run doctor` on a machine with authenticated CLIs.** This is the
   single most valuable thing in this pack that has never been done. Every flag
   the bridge depends on is still unverified against a live CLI, including
   `claude --tools`, whose absence would silently remove `ask_claude`'s
   read-only guarantee.
6. If you find a defect, fix it with a focused regression test, rerun every
   check, update the handoff and changelog, and rebuild both installers. Do not
   restyle working code.
7. Report what you reviewed, live results, defects found and fixed, commands and
   test counts, and anything still unproven.

## Current validated state

- Version `0.9.6`, 37 tests passing on Linux, clean tree at packaging time.
- Syntax checks, both builds, and archive integrity all pass.
- No live CLI has ever run against this code.

## Where the review is most likely to find something

These are the places Claude is least confident, in rough order:

- **Working-tree delta reporting.** It now shows only entries absent before the
  delegation, capped, with pre-existing ones counted. A file already dirty before
  the run shows an identical status line after it, so a further edit to it is
  invisible. That limit is stated in the output, but check the reasoning holds
  for renames, staged-versus-unstaged transitions, and mode changes.
- **`claimsFor` splitting.** Now splits on whitespace as well as commas and
  newlines, with quoted paths kept whole. Confirm the quoted-path branch of the
  split regex behaves for Windows paths and for a trailing separator.
- **`budget.mjs` methodology.** It charges the delegated side for design reading,
  the handoff, results and tool definitions. Check the comparison is fair rather
  than flattering, and that the reported loss on small tasks is arithmetically
  right.
- **`doctor.mjs` flag detection.** Matching is now token-bounded rather than a
  substring test. Check the regex against real `--help` output from your Codex
  and Claude builds, especially flags documented in unusual layouts.
- **Remote-mode surface.** `set_project_context` carries `requiresWrites`.
  Confirm nothing else added since 0.9.1 writes outside the Codex sandbox without
  it.
- **Job scheduler under load.** Confirm the queue always drains, that
  `pumpQueue` cannot start work during shutdown, and that a job failing inside
  `delegateToCodex` still releases its claims.
