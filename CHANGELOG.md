# Changelog

## 0.2.2 - 2026-06-13

- Successful `invoke_advisor` output (prose) is no longer eligible for lossy log compression — previously a review quoting >=3 error lines was misrouted to the log compressor and silently lost its recommendations. Success now passes through; only **failed** advisor diagnostics are compressed (and recoverable via `retrieve_original`).
- Trimmed the redundant advisor `STDERR` on clean success (CLI banner + echoed prompt + a verbatim duplicate of `STDOUT` + token count); the token count is preserved as a `tokens_used` meta line. `STDERR` is retained on failure or truncation.
- Fixed a meta-head line duplication in compressed `run_tests` output (the re-prepended `exit_code`/`passed`/`timed_out`/`truncated` block could repeat a line the compressor retained).
- `retrieve_original` and `invoke_advisor` tool descriptions now cue agents to retrieve the original when a compressed summary is insufficient.
- Bumped package, server, and tests to `0.2.2`.

## 0.2.1 - 2026-06-12

- Compressed `run_tests` / `invoke_advisor` output now retains the tool's leading meta block (`exit_code`, `passed`, `timed_out`, `truncated` / `cli`) — re-prepended onto the compressed digest. Previously the log compressor's error-extraction dropped these lines (pilot finding #1).
- Never applied to `smart_crusher` (JSON) output; skipped when the digest already contains the block.
- Bumped package, server, and tests to `0.2.1`.

## 0.2.0 - 2026-06-12

- Integrated `context-crush`: `run_tests` and `invoke_advisor` outputs ≥2048 bytes that detect as log/diff/json are compressed with reversible CCR storage; compressed output carries a `<<ccr:HASH>>` marker.
- New `retrieve_original` tool (22nd tool) exchanges a marker hash for the exact original output; unknown/expired hashes return a deterministic `ccr_missing_or_expired` error.
- Compression is **default ON** for the 0.2.0 pilot. Kill switch: `FOREMAN_COMPRESSION=0`. Per-tool allowlist: `FOREMAN_COMPRESSION_TOOLS` (default `run_tests,invoke_advisor`). CCR TTL: `CONTEXT_CRUSH_CCR_TTL_SECONDS` (default 300s).
- Prose/text outputs pass through unchanged; originals are always stored before lossy output escapes (fail-open invariant).
- `context-crush` is a bundled dependency (`bundleDependencies`) so packed tarballs are self-contained.
- Bumped package, server, and tests to `0.2.0`.

## 0.1.3 - 2026-06-09

- Documented the enforced `ip -> delegated -> pass` ledger sequence in the implementor protocol and the `write_ledger` tool description — previously the `delegated` step existed only in the enforcement code, so every first pass verdict hit `VERDICT BLOCKED` and the model learned the sequence from the error message.
- `update_phase_gate` with `g:'pass'` is now blocked unless every unit in the phase carries a pass verdict; empty phases cannot pass a gate.
- Pass verdicts on phases scoped `has_tests:false` or `has_build:false` now mechanically require a non-empty attestation `note` (previously prose-only).
- `set_phase_scope`'s test-file mismatch warning now surfaces in the tool result instead of stderr only.
- Read paths (`read_ledger`, `session_orient`, `write_progress`) report `ledger_corrupt` instead of silently treating a corrupt ledger as a fresh project, and never rename the corrupt file; writes recovering from corruption warn with the `.corrupt.<ts>` backup path.
- `read_ledger` single-unit and verdicts views now include `via` and `note`.
- Bumped package, server, and tests to `0.1.3`.

## 0.1.2 - 2026-06-08

- Added `verify_citations`: a deterministic tool that re-reads `[OBSERVED]`/`[IMPLEMENTED]` `file:line` evidence and reports CONFIRMED/DRIFTED/MISSING/UNANCHORED.
- Added a shared `citation-verification` protocol section (included by `spec_man` and `doc_man`); spec/doc completion now requires every claim-bearing citation to be CONFIRMED or explicitly downgraded.
- Fixed `capability_check` reporting an authenticated codex as `auth_status: expired` — codex health now uses `codex login status` instead of a full `codex exec` with a stale model under a 15s timeout.
- Codex advisor now runs `gpt-5.5` at `high` reasoning effort; Cursor advisor slug is `gpt-5.5-high`.
- Bumped package, server, and tests to `0.1.2`.

## 0.1.1 - 2026-06-08

- Updated MCP activation metadata so tool choice advertises the Foreman routing policy before a model opens the full skill body.
- `spec_man` metadata now calls out stale-plan detection, existing repo/spec re-evaluation, Atlas/Graphify code-surfacing, Plan Delta Ladder fields, and the rule that `D1` is not auto-promoted to `D0`.
- `lighttask` metadata now positions it as the small surgical default and says when to escalate into `spec_man`.
- `pitboss_implementor` metadata now calls out worker fan-out, retries, blocked work, recovery, multi-session resume, and optional LangGraph-style runtime-control triggers.
- Added regression coverage for activation-tool descriptions.
- Bumped package, server, tests, install docs, and release tarball to `0.1.1`.

## 0.1.0 - 2026-06-06

- First minor release for the lighttask/spec/doc protocol family.
- Promoted `lighttask`, `spec_man`, and `doc_man` tool heads.
- Added optional Graphify-backed Project Atlas guidance for `spec_man` grounding and `lighttask` stale-context re-evaluation.
- Added Plan Delta Ladder guidance for keeping raw findings, grouped deltas, candidate plans, and accepted current plans separate.
- Added dojo validation for Graphify/Atlas and cross-language legacy re-evaluation.

## 0.0.10 - 2026-06-06

- Added `lighttask`, `spec_man`, and `doc_man` skill activation tools.
- Introduced surgical-task gates for workspace classification, git context, spec freshness, grounding, bypass waivers, and adversarial review.
- Added grounded spec and documentation protocols.
- Added deterministic capability-check tests.

## Earlier Releases

Use the `changelog` MCP tool for the full historical table from `0.0.1` through `0.0.9`.
