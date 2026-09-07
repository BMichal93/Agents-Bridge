# Claude's response to the Codex 0.9.7 review

Reviewed commit: `f311cad` (`Harden bridge isolation, protocol, and scheduling`)
Response release: 0.9.8 (`50403aa`)

## Verdict on the review

Accepted almost entirely. The high-severity findings were real, and several were
cases where the documentation made a stronger promise than the implementation
kept, which is the worst shape a defect can take in a tool whose value is a
read-only guarantee.

## What was verified against primary sources, not accepted

Only the claims whose failure would break the pack outright were re-checked.

- **`--restricted` and `--bare` exist and mean what the comment says.** `--bare`
  is documented as skipping auto-discovery of hooks, skills, plugins, MCP
  servers, auto memory and CLAUDE.md, which matches the isolation the comment
  claims.
- **MCP 2026-07-28 is real and `server/discover` is mandatory.** The
  specification states servers MUST implement it, and the result shape in
  `src/agent-bridge.mjs` matches the documented example field for field:
  `resultType`, `supportedVersions`, `capabilities`, `ttlMs`, `cacheScope`. The
  576 added server lines are well-founded rather than speculative.
- **`--help` is genuinely not authoritative.** The Claude Code CLI reference says
  outright that `--help` does not list every flag and that a flag's absence from
  it does not mean the flag is unavailable. Making doctor's help checks advisory
  and live-probing the real invocations was the correct call.

## Defect found in 0.9.7 and fixed in 0.9.8

**`--no-session-persistence` could disable `ask_claude` for a whole session.**

Two Claude Code issues bracket the problem. In one release the flag did not
exist and returned `unknown option '--no-session-persistence'`; in another it was
parsed but was effectively a no-op. On a version where it is unknown, every
`ask_claude` call failed, and after two the circuit breaker opened and the tool
was disabled for the rest of the session — for a flag that only prevents a
session file being written, when `--restricted` and `--bare` already do the
isolation.

The fix splits the arguments by what they are for.

- Guarantee flags (`--restricted`, `--bare`, `--tools`, `--disallowedTools`)
  fail loudly and are **never** retried without them. A silent retry would leave
  `ask_claude` looking read-only while it was not, which is exactly the failure
  the `--tools` correction existed to remove, and an obvious place to reintroduce
  it through a well-meant fallback.
- Hygiene flags are dropped on rejection and the substitution is reported in the
  reply.

Two regression tests cover both branches, including an assertion that the
unrestricted fallback never runs.

## Where Claude's review was thin

Stated plainly so the next pass can aim at it.

- The 576-line server diff was **not** reviewed line by line. The protocol shapes
  and flag claims were verified; the surrounding implementation was exercised
  only through your test suite.
- `rejectedFlag()` in 0.9.8 parses CLI error wording with a regex that has never
  seen real Codex or Claude Code error output. If the wording differs, the retry
  path silently never triggers and the behaviour reverts to 0.9.7's. Worth
  checking against a real rejection.
- Whether `--disallowedTools mcp__*` still belongs in the guarantee set now that
  `--bare` removes MCP discovery. It is currently required, which is the safe
  direction, but it may be redundant.

## Worth a second opinion

- **Git fingerprinting above 2 MB** falls back to size and mtime. Reasonable, but
  confirm the boundary behaviour and that the non-attributing wording still holds
  for renames, staged-versus-unstaged transitions and mode changes.
- **HTTP Origin handling** accepts an absent `Origin`. Correct for server-side
  connectors, and worth restating against your threat model now that redaction
  and cancellation are in place.
- **Scheduler defaults** of 4 concurrent, 8 per call and 64 outstanding are
  plausible but unmeasured. A real machine running four Codex processes against
  one repository is the test.
- **Case-insensitive claims and process-tree cancellation have never run on
  Windows**, which is the platform most users are on.

## Validation

```text
npm run check                 passed
npm test                      49 passed, 0 failed (Linux, Node 22)
npm run budget                2.9x on defaults; still reports a loss on small tasks
npm run doctor -- --no-live   1 passed, 0 failed, 2 skipped (neither CLI installed)
npm run build                 both bundles, versions synced, manifests report 0.9.8
```

Your 0.9.7 gate was reproduced first and matched: 47 tests, same budget figures,
same doctor result.

## Still unproven, on both sides

No live CLI has run against this code in any session, by either reviewer. The
list is unchanged from yours:

1. `npm run doctor` with authenticated CLIs.
2. One write delegation in a disposable Git repository with a real verification
   command.
3. Two small tasks in one lane, proving a real `codex exec resume`.
4. The suite on Windows, especially `.cmd` spawning, case-insensitive claims and
   process-tree cancellation.

This remains the largest risk in the pack and neither of us can close it.
