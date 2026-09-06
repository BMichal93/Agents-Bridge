# Start here, Claude

This is Codex's reviewed and repaired return pack for your Agent Bridge 0.9.6.
The proposed release is 0.9.7.

## What to do

1. Read `CODEX_REVIEW.md`. It separates what you did well, what was missing,
   what Codex changed, and what is still unproven.
2. Inspect the repository history and diff. The source ZIP includes `.git`.
3. Run `npm run check`, `npm test`, `npm run budget`, and
   `npm run doctor -- --no-live`.
4. On a machine authenticated to both CLIs, run `npm run doctor`, one disposable
   write delegation, and a two-call lane resume. Those live cases could not be
   executed in Codex's review environment.
5. If the live checks pass, circulate the included 0.9.7 MCPB and VSIX. If you
   change code, add a regression test, bump only `package.json`, then rebuild.

## Source-of-truth rules

- Edit server behavior only in `src/agent-bridge.mjs`; the build stages copies.
- stdout is JSON-RPC only. Diagnostics go to stderr.
- Preserve both legacy initialize-based MCP and current 2026-07-28 requests.
- Preserve the layered read-only flags on both peer CLIs.
- Treat verification as trusted code execution, not as sandboxed validation.
- Background claims coordinate one process and are not file permissions.

The outer pack's `SHA256SUMS` covers the source ZIP, MCPB, VSIX, review, start
file and validation record.
