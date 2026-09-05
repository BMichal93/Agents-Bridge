# Agent Bridge 0.9.6 handoff to Codex

Return leg of the review that produced 0.9.1. This records what Claude verified,
what it changed, and what remains unproven, so the analysis does not have to be
reconstructed.

## Verification of the 0.9.1 findings

Both findings that carried real risk were checked against current sources rather
than accepted:

- **`--tools` versus `--allowedTools`.** Confirmed. `--allowedTools` only skips
  permission prompts and appends to Claude Code's default tool set rather than
  replacing it, so the previous `ask_claude` was not read-only despite a comment
  claiming it was. The 0.9.1 fix is correct. The stale comment explaining the old
  reasoning has now been replaced.
- **`McpStdioServerDefinition` constructor.** Confirmed positional
  `(label, command, args, env, version)`. Worth recording why the bug existed:
  the official VS Code MCP guide shows an object-literal example that every type
  reference contradicts. Do not "fix" this back by following that page.

## Defects found and fixed since 1b8145e

| Defect | Why it mattered | Fix and coverage |
| --- | --- | --- |
| `claimsFor` split `files` only on commas and newlines | `files: "a.ts b.ts"` became one nonsense path overlapping nothing, so a second job naming `b.ts` ran concurrently — the exact collision the scheduler exists to prevent | Split on whitespace too, quoted paths kept whole; two regression tests |
| Working tree printed in full, twice, per delegation | On a repository already dirty with thirty files, every call reprinted all thirty and that text then rode along in the caller's context for the rest of the session. Worst defect in the pack, on a product whose purpose is context economy | Bounded delta with pre-existing entries counted and the attribution limit stated; `AGENT_BRIDGE_MAX_STATUS_LINES`; dirty-tree and flood tests |
| `doctor.mjs` flag detection used substring matching | `-a` matched inside `--allowedTools` and `--tools` inside `--allowedTools`, so short flags always passed and the script reported health it had never checked. Silent, in a tool whose only job is catching silent breakage | Token-bounded matching, `helpHas` exported and unit-tested |
| Version synced only at build time | Bumping `package.json` and running `npm test` failed until you also ran a build, because the handshake test compares the two | `pretest` runs `--sync-only` |
| Version asserted as a literal in tests | Every release broke a test that is not about versions | Reads `package.json` |
| README documented 2 of 20 environment variables; download filenames pinned to a version that had already moved | Install instructions were wrong on arrival | Settings reference added; build syncs doc filenames |
| `start_codex_jobs` repeated the whole field guidance already on `delegate_to_codex` | Roughly 200 tokens per session for a reader that had already seen it | Condensed; ceiling test on total definition size |

## New tooling

- **`npm run doctor`** checks every flag the bridge depends on against the
  installed CLIs and makes one live read-only Codex call. This is the preflight
  that the stub suite structurally cannot provide.
- **`npm run budget`** runs a scripted session against stubs and reports the
  bytes returned, compared with doing the same work inline. The delegated side is
  charged for design reading, the handoff, the results and the tool definitions.
  On default assumptions that is 2.9x less of Claude's context. An earlier
  version of this tool reported 21x by ignoring those costs; the methodology was
  corrected rather than the number kept.

## Validation performed

```text
npm run check      passed
npm test           37 passed, 0 failed  (Linux, Node 22)
npm run build      both bundles, versions synced
npm run budget     2.9x on defaults; correctly reports a loss on small tasks
npm run doctor     runs, skips both CLIs (neither installed in this environment)
```

## Unproven

**No live CLI has run against this code at any point.** The suite substitutes
stub executables, which is right for testing the bridge and proves nothing about
the CLIs. Specifically unverified: `claude --tools`, `codex exec resume` and the
`thread.started.thread_id` JSONL field, `codex -a never`,
`-c model_reasoning_effort`, and `codex app-server`'s `account/rateLimits/read`.
`npm run doctor` checks all of them. Running it is the most valuable thing a
reviewer with authenticated CLIs can do.

Also unproven: Windows behaviour beyond CI, and whether the Codex desktop app
shares MCP configuration with the Codex CLI, where sources still conflict.

## Deliberate non-goals

Do not add these without a separate decision:

- Reading Claude's remaining usage. No supported route exists; conserve mode is
  a manual switch on purpose. A scraped version would be a confident wrong number
  at exactly the moment someone is deciding whether to delegate.
- Reading the OpenAI token from `~/.codex/auth.json`. Usage comes from
  `codex app-server` or local session logs precisely so this process never
  handles credentials.
- Making `ask_claude` a write tool. Callers rely on its read-only contract.
- Retrying or falling back to another provider. Failures stay visible.
