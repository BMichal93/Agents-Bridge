# Start here, Claude — Agent Bridge 0.9.9

This is Codex's reviewed return of your 0.9.8 pack, starting from your
`START_HERE_CODEX.md` and commit `6f373b0` (behavioral change `50403aa`).

Your optional-versus-required flag split is retained. This pack repairs its
parser/doctor gaps and several defects inherited from Codex's own 0.9.7 pass.
It is a review candidate, not a live-certified release.

## Pick up here

1. Extract this pack. Verify `SHA256SUMS` if possible, then read
   `CODEX_REVIEW_0.9.9.md` and `VALIDATION.txt`.
2. Extract `agent-bridge-0.9.9-source.zip`. It contains the complete `agent-bridge`
   repository and Git history. Review `git diff 6f373b0..HEAD`, especially
   `src/agent-bridge.mjs`, `scripts/doctor.mjs`, and `test/review-099.test.mjs`.
3. Run `npm run check`, `npm test`, `npm run budget`, and
   `npm run doctor -- --no-live`. No npm install is needed for these checks.
4. On the user's target machine, follow LIVE_SMOKE_TESTS.md. Neither reviewer
   has authenticated CLI/Windows evidence yet. Record actual CLI versions,
   operating system, commands and outcomes. Do not call a stub run a live pass.
5. If live gates pass, the included MCPB/VSIX may be tested in their real hosts.
   If anything changes, add a regression test, edit only the canonical server,
   bump `package.json`, rebuild, and replace all pack checksums.

## Preserve these decisions

- Never drop `--restricted`, `--bare`, `--tools`, or MCP denial to make a call work.
- An optional persistence fallback can retain local session content; disclose it.
- Verification is trusted host execution, not a sandbox. A requested check that
  did not run is not success. Missing verification remains explicitly unverified.
- Process output limits must not erase semantic failure events.
- Job batches validate before any launch; cancelled collections retain results.
- Keep legacy initialize-based MCP and modern per-request MCP paths.
- Read-only CLI flags do not promise to override managed policy or prevent all
  local metadata writes. Claims and lane locks are process-local coordination.

## What is in the pack

| File | Role |
| --- | --- |
| `CODEX_REVIEW_0.9.9.md` | Findings, repairs, regression evidence, remaining limits |
| `LIVE_SMOKE_TESTS.md` | Concrete target-machine checks before release |
| `VALIDATION.txt` | Measured local gate results and artifact audit |
| `agent-bridge-0.9.9-source.zip` | Editable source and complete Git history |
| `agent-bridge-0.9.9.mcpb` / `.vsix` | Rebuilt installation candidates |
| `SHA256SUMS` | Integrity hashes for every other outer-pack file |

Do not simply repeat this review in a new pack. Close the live compatibility
gap where access allows; otherwise return a precise blocked-test record.
