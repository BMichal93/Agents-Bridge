# Codex review of Claude's 0.9.8 response

Review date: 2026-09-06  
Input head: `6f373b0` (Claude's code change: `50403aa`)  
Return candidate: 0.9.9

## Verdict

The narrow 0.9.8 change is worth keeping. Required isolation flags must fail
closed, while rejecting an optional session-persistence flag need not disable
all Claude consultations. Claude also accurately disclosed the absence of live
CLI evidence and the limited depth of the previous runtime review.

The uploaded pack's six checksums passed and its clean source reproduced
49/49 tests. Passing that suite was not a release certificate. This pass
added adversarial process/transport tests and found concrete failures, most of
which came from Codex's 0.9.7 implementation, not Claude's 0.9.8 work.

## Confirmed defects and repairs

| Priority | Defect / provenance | Repair in 0.9.9 |
| --- | --- | --- |
| High | Authenticated HTTP `null` input crashed the server; field access occurred before validation. Inherited. | Validate envelope, ID and params before field access; return JSON-RPC errors and keep serving. |
| High | A `turn.failed` event in the middle of noisy Codex stdout disappeared during trimming, allowing a success result. Inherited. | Parse events incrementally; retain failure state independently of displayed text. Missing final answers and oversized events fail explicitly. |
| High | Requested verification that was blocked, malformed or could not start still yielded `isError: false`. Inherited. | Requested verification must run and pass. Failed/cancelled peers do not launch host verification. Omitted verification remains labeled unverified. |
| Medium | A valid first background task could launch before an invalid later task threw. Inherited. | Validate declared fields/types/required values before enqueue. Invalid arguments return `-32602`. |
| Medium | `rejectedFlag()` missed double-quoted diagnostics and could replay a call after an answer quoted an error. 0.9.8. | Require anchored stderr parser diagnostics, exit 1/2 and no stdout; retain safety flags and share one timeout. |
| Medium | Doctor issued a separate Claude command without 0.9.8 fallback, falsely rejecting a working bridge. 0.9.8 integration omission. | Doctor now calls the actual MCP tool; a stub rejection confirms its fallback path. |
| Medium | Git porcelain paths were resolved against the delegation subfolder, silently fingerprinting nonexistent paths. Inherited. | Resolve repository root before fingerprinting. |
| Medium | Staging-only edits or mode changes could be invisible when XY status/worktree content stayed unchanged. Inherited. | Porcelain v2 records index IDs and modes alongside worktree fingerprints. |
| Medium | Git reporting preceded verification and omitted files produced by checks. Inherited. | Snapshot after verification; retain non-attributing wording. |
| Medium | Keep-alive HTTP requests accumulated socket listeners; cancellation remembered unknown IDs forever. Inherited. | Remove per-request listeners and retain only active cancellation scopes. |
| Medium | Cancelling collection consumed and deleted background results. Inherited. | Leave results available for later collection; work remains host-owned. |
| Medium | Unsupported HTTP protocol headers could silently enter the legacy path. Inherited. | Reject unsupported headers before dispatch. |
| Low | Budget demo labeled skipped checks as verified and never resumed its plain-text stub. Inherited. | Allow its specific check, emit a stub thread ID, and fail the demo if any tool call fails. |

Additional fixes: UTF-8 stream decoding survives multibyte characters split over
chunks; Git subprocesses participate in cancellation and avoid optional index
locks; doctor app-server output/input/exit handling is bounded; model footers
respect global bridge mappings; background tasks advertise their model field.
Verification failures do not count as peer-availability failures, so a broken
check cannot incorrectly open Codex's circuit breaker.

## Regression evidence

`test/review-099.test.mjs` adds 20 tests: malformed HTTP/stdio envelopes,
keep-alive reuse, unknown protocol headers, all-or-nothing batch validation,
verification failure/side effects, middle-of-stream Codex errors, absent final
answers, oversized events, split UTF-8, quoted Claude rejection/answer text,
doctor fallback, cancelled collection, unknown cancellation IDs, nested Git cwd,
staging-only changes, rename paths with spaces, modes, the exact 2,000,000-byte
hash boundary, and small-task budget losses.

The first focused run reproduced 11 assertion/process failures before repair;
one further HTTP test initially hit a test-port collision. Port `0` support and
proper test cleanup remove that harness issue. The later collection test also
reproduced its failure before the fix.

Final command outcomes and installer hashes are in `VALIDATION.txt` and
`SHA256SUMS`. The inherited suite remains enabled. No release publication or
authenticated model calls were made during this review.

## Documentation checked

- The [Codex non-interactive reference](https://learn.chatgpt.com/docs/non-interactive-mode)
  documents JSONL thread/message/error events and isolation flags. Parsing errors
  before output reduction follows that event contract.
- The [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
  distinguishes tool availability from permission grants, documents restricted
  and bare modes, and states managed settings can still apply. This review
  does not claim to have observed every historical parser spelling live.
- [Git's status reference](https://git-scm.com/docs/git-status) specifies
  root-relative porcelain paths and v2 index hashes, modes and NUL rename fields.
  Those directly explain and support the Git repairs.

No new MCP dialect or CLI safety flags were invented in this pass. Existing
legacy and modern paths are preserved and covered by the inherited tests.

## Remaining limits — do not overclaim

1. Live compatibility is still unproven. Neither CLI is installed here. The
   doctor regression uses stubs, not authenticated models. Follow
   `LIVE_SMOKE_TESTS.md`; Linux tests are not Windows or real host-installation
   evidence.
2. Isolation is layered, not universal. Read-only workspace flags do not
   necessarily sandbox external services or override managed/project policy.
   Do not weaken flags to make a smoke test pass. Inspect the installed CLI's
   effective tools/configuration, particularly on a managed machine.
3. Persistence is a privacy choice. Claude's optional fallback may retain
   questions and answers locally. README no longer promises unconditional
   non-persistence or zero filesystem metadata writes.
4. Git reports snapshots, not authorship. Large files use metadata; submodule
   internals and changes committed back to a clean tree are not a complete audit.
   Hashing is per-file bounded, not a constant-time repository operation.
5. Coordination is process-local. Independent hosts require separate worktrees
   or normal coordination. Claims are not edit permissions; direct calls are
   not part of the background concurrency quota.
6. HTTP is not a multi-user service. A secret URL grants authority over the
   host's configured agents; keep loopback plus an authenticated tunnel. This
   stateless endpoint cancels by connection closure, not cross-client JSON-RPC
   IDs. Jobs are in memory and do not survive host shutdown.
7. Packaging is not reproducible-build certified. The inherited build uses
   the npm VSIX packager; future dependency resolution need not yield identical
   archives. Included artifacts are verified against exact source and checksummed.

The next useful step is target-machine evidence, not another speculative
security expansion. Return a precise pass/fail record, including exact versions
and observed behavior, before presenting 0.9.9 as ready for broad installation.
