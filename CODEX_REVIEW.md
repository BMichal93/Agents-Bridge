# Codex review of Claude's Agent Bridge 0.9.6

> Historical 0.9.7 review. Several runtime defects and overbroad guarantees here
> are corrected in CODEX_REVIEW_0.9.9.md; use that file for the current verdict.

Date: 2026-09-05  
Reviewed commit: `6ff0395` (`Doctor flag detection, and the Codex handoff pack`)  
Repair release: 0.9.7

## Verdict

Claude's 0.9.6 work was substantive and reproducible: the 37-test baseline was
green, the file-claim splitter, bounded status output, version pretest sync,
budget tool, and token-bounded doctor checks all existed as described. The pack
was not ready to circulate unchanged, however, because several documented
guarantees were stronger than their implementation—especially read-only
isolation, HTTP secrecy/origin handling, Git attribution, child-output bounds,
and job resource limits.

0.9.7 closes those gaps and adds a regression test for each material behavior.

## Findings and repairs

| Severity | Gap in 0.9.6 | Why it mattered | 0.9.7 repair |
| --- | --- | --- | --- |
| High | `ask_claude` removed write tools but still loaded user/project customizations | Hooks, plugins or other configured behavior could have side effects despite the read-only label | Add `--restricted --bare --no-session-persistence`, retain `--tools Read,Grep,Glob` and MCP denial; require Claude Code 2.1.248+ |
| High | `ask_codex` used a read-only workspace sandbox but retained user MCP/config/rules | A configured external tool could create side effects outside the workspace contract | Add `--ephemeral --ignore-user-config --ignore-rules` for read-only calls only |
| High | HTTP startup and rejection diagnostics included the capability URL/secret | Logs could turn a local diagnostic into a reusable remote credential | Redact the path completely and test that the random secret never appears |
| High | HTTP did not validate `Origin` | Browser DNS-rebinding protection is a protocol requirement | Reject any present Origin unless it exactly matches `AGENT_BRIDGE_HTTP_ALLOWED_ORIGINS`; absent Origin remains valid for server connectors |
| High | A disconnected HTTP client left its delegated process running | Work could continue after the caller disappeared; two HTTP clients could also reuse the same JSON-RPC ID | Give every HTTP request a unique cancellation scope, remember early cancellation, and kill the full process tree on disconnect |
| High | Peer and verification output accumulated without limit | Final reply trimming happened too late to prevent host-process memory exhaustion | Bound capture during execution, keeping Codex's opening thread event and final agent message |
| Medium | Git compared only status text | A second edit to an already-dirty file was invisible, and a dirty file becoming clean was incorrectly hidden | Parse `git status --porcelain=v1 -z`, fingerprint dirty files, report new/changed/cleared observations, and use non-attributing wording |
| Medium | Git status could invoke a configured fsmonitor hook | A supposedly observational snapshot could execute repository-configured behavior | Force `core.fsmonitor=false` for bridge snapshots |
| Medium | Background jobs had no concurrency or queue bound | One tool call—or repeated calls—could spawn or retain an arbitrary number of jobs | Default to 4 concurrent, 8 per call and 64 outstanding, with hard caps and runtime/schema validation |
| Medium | Same-lane jobs could run concurrently | Both could cold-start or race the persisted lane state | Serialize lanes per repository, validate lane names, and save lane state atomically |
| Medium | Collected jobs stayed in memory and unknown IDs were ignored | Long sessions leaked job records and typos looked like success | Delete collected jobs and return a clear error for unknown IDs |
| Medium | MCP initialization echoed any requested version | The server claimed protocol versions it did not implement | Negotiate only supported legacy versions and reject unsupported per-request versions with `-32022` |
| Medium | The bridge implemented only the legacy MCP lifecycle | Current clients use 2026-07-28 discovery and per-request metadata | Add `server/discover`, modern result/cache fields, current version errors, and modern HTTP header validation while keeping legacy clients |
| Medium | Verification split only on whitespace | Quoted paths failed even though commands were launched without a shell | Add a small quote-aware tokenizer and regression coverage |
| Medium | The VS Code extension owned a generic Claude skill directory and removed it recursively | A same-named user skill—or files added beside the managed skill—could be overwritten/deleted | Use `agent-bridge-delegating-to-codex`, mark managed content, migrate only recognizable legacy content, and delete only the managed file |
| Low | Doctor treated help output as authoritative and checked an unused Claude flag | Claude documents that `--help` does not list every flag, so false failures were possible | Make help advisory; live-probe the exact read-only Codex and Claude invocations and the app-server method |
| Low | Budget said Codex quota was spent “either way” | Inline Claude work does not consume Codex quota | Correct the methodology note and explicitly exclude provider caching/total billing |

## Protocol and CLI evidence

These were checked against current primary documentation rather than memory:

- Codex non-interactive mode documents JSONL events, `thread.started.thread_id`,
  `codex exec resume`, read-only/workspace-write sandboxes, ephemeral sessions,
  and `--ignore-user-config`/`--ignore-rules` for controlled automation:
  <https://learn.chatgpt.com/docs/non-interactive-mode>
- Codex app-server documents the initialize/initialized exchange and
  `account/rateLimits/read`: <https://learn.chatgpt.com/docs/app-server>
- Claude Code documents the distinction between `--tools` and
  `--allowedTools`, plus restricted, bare and non-persistent modes. Restricted
  mode requires 2.1.248+: <https://code.claude.com/docs/en/cli-reference>
- MCP 2026-07-28 requires `server/discover`, per-request metadata and typed
  results: <https://modelcontextprotocol.io/specification/2026-07-28/schema>
- Modern Streamable HTTP requires Origin checks, mirrored request-header
  validation and an empty 202 for accepted notifications:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- Legacy version negotiation remains documented here:
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle>

## Validation in the Codex environment

```text
npm run check                 passed
npm test                      47 passed, 0 failed (Linux, Node 24)
npm run doctor -- --no-live   passed; both CLIs absent and explicitly skipped
```

The final build and budget outputs are recorded in the outer pack's
`VALIDATION.txt`. Installer contents and reported versions are checked after
packaging, not inferred from filenames.

## Still unproven here

No authenticated Codex or Claude CLI is installed in this review environment.
The tests prove bridge behavior against process-level stubs, not acceptance by a
particular installed CLI release. On a machine with both CLIs, the next reviewer
should run:

1. `npm run doctor` (exact read-only calls plus app-server probe).
2. One write delegation in a disposable Git repository with a real verification
   command.
3. Two small tasks in the same lane to prove a real `codex exec resume`.
4. The suite on Windows, especially `.cmd` spawning and case-insensitive claims.

Doctor deliberately does not write files or spend a second Codex call on a live
resume. `AGENT_BRIDGE_CODEX_RESUME=0` is the fallback if lanes are unsupported.

## Boundaries Claude should preserve

- Background claims and lane locks coordinate one bridge process only. Separate
  MCP hosts need separate worktrees or normal repository coordination.
- `files` is a scheduling declaration, not an edit allowlist.
- Verification runs trusted repository code as the current OS user. The first-
  executable allowlist is not a sandbox.
- A remote capability URL grants local read access through the agents even when
  writes are disabled. Keep loopback binding and authenticated tunnel guidance.
- `ask_codex` ignores Codex user config intentionally; without an explicit Agent
  Bridge model mapping, it uses Codex's built-in default rather than a model
  selected in the user's config.
- Modern tool-list change subscriptions are not implemented. The modern server
  advertises `listChanged: false` and returns a zero TTL; legacy clients retain
  the existing list-changed notification.
- Files larger than 2 MB use size/time metadata rather than content hashing in
  Git snapshots. This bounds work but is not an adversarial integrity proof.

## Recommended Claude review order

Read `START_HERE_CLAUDE.md`, inspect `git show --stat` and this file, run the
three local checks, then run the authenticated smoke tests above. If anything is
changed, edit only `src/agent-bridge.mjs` for server behavior, add a regression
test first, bump only `package.json`, and rebuild both installers from that one
source.
