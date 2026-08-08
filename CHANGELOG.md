# Changelog

## 0.5.14 - 2026-08-08

- Diagram preview viewer gained interaction controls: cursor-centered wheel zoom, drag panning, toolbar (zoom in/out, 100%, fit) with `+`/`-`/`0`/`f` keyboard shortcuts, and client-side export as PNG (2x, white background, canvas-limit capped), SVG, or the raw `.mmd` source. All rendering and export stay client-side under the existing strict CSP (PNG rasterizes through a `data:` URL; a tainted-canvas edge case falls back to SVG export). First render auto-fits oversized diagrams; live-reload preserves the current zoom/pan.

- Declared units are now a ledger fact: new `write_ledger` operation `declare_phase_units` records each phase's expected unit-id set (additive union-merge, cap 200, ids validated against TOON-structural characters). The phase gate blocks `g:'pass'` while any declared id is unregistered, and `session_orient` resumes at the first declared-but-unseeded unit (`action: implement_unit`, new `missing_declared_units` field) instead of misreporting `retry_phase_gate` on a partially-seeded phase — closes the field-reported hole where a quarter-implemented phase passed its gate mechanically.
- Declared sets are frozen behind a passed gate (reopen the gate first — no override), participate in the D2b gate-staleness hash when present (legacy hashes unaffected), and support auditable correction: `retire` removes declared-only ids with a mandatory reason tombstoned in `declared_log`. The progress checklist renders declared-but-unregistered units as unchecked `declared, unregistered` rows instead of erasing them.
- `session_orient` state-drift detection is now bidirectional: progress marking the ledger's resume unit itself complete is flagged as `progress:complete(<unit>);ledger:<target>`. Partial progress files (earlier phases only) remain non-drift, so later-phase resumes are not blocked.
- `read_ledger` paged queries emit a query-specific recovery `hint` when cells were truncated (verdict notes → per-unit read; rejections/reviews → phase-scoped `full`); untruncated output is byte-identical.
- Session-start protocol: implementor sessions probe advisors once and record `<version>/<auth_status>` in the `init_session` env (`null` now explicitly means "not probed"); checkpoints reuse the probe instead of re-running it.
- The claude-code worker fan-out rule replaces its vague isolation exception with a concrete procedure: parallel editing workers require `isolation: "worktree"`, disjoint editable sets, full `git diff` in each completion report, and serial per-unit application; the full worktree fan-out contract remains v0.6 HOST-CONTRACT scope.
- Bumped package to `0.5.14`.

## 0.5.13 - 2026-08-05

- Hardened shared-tree delegation after a production migration exposed a destructive `git stash` hazard: editing workers receive an explicit Git-mutation denylist, run sequentially unless isolated, and require a before/after branch, HEAD, stash, index, and dirty-path guard before tests or verdict. Foreman never performs automatic repository recovery.
- Made ledger reads safe on mature projects with phase/verdict filters, cursor pagination, bounded cells, notes omitted by default, and recovery guidance instead of oversized `full` output.
- Made `session_orient` the ledger-authoritative resume path, with explicit action and resume target, phase-gate retry detection, timestamp-based last-completed selection, and ledger/progress drift reporting. `read_progress` is now explicitly descriptive only.
- Added shell-free Gradle wrapper support to `run_tests`, including Windows execution through `GradleWrapperMain`, and allowed canonical string journal phase ids such as `V20-P0` while retaining legacy numeric input.
- Added a repeated-checkpoint termination protocol: targeted mutation or fault injection after a second green-but-unobservable block, defect-source classification, and mandatory owner arbitration after a third block.
- Bumped package to `0.5.13`.

## 0.5.12 - 2026-08-03

- Added `invoke_council` (EXPERIMENTAL): an adaptive review council that runs N remote read-only review seats across M risk lenses over one evidence packet, in parallel, and returns structured findings for the host to moderate and the user to arbitrate. Read-only by design — seats never edit the tree, apply fixes, or write the ledger, and findings come back ledger-shaped for `write_ledger record_review`.
- The council is entirely optional and its absence is a supported state, not an error: with no seats configured the tool returns `status: unavailable`, names the next rung of the deliberation ladder, and every other tool, skill, and ledger flow behaves exactly as before.
- Added a versioned 7-lens catalog (contract, architecture, state, security, data, tests, operability). Each seat receives the evidence packet plus ONE compact lens card; the catalog, other lenses, and provider details never enter a reviewer's context.
- Seats are configurable from the repo `.foremanenv` or from a new operator-owned store at `~/.foreman-mcp/.env`, with the home store overriding per seat so a model can be swapped without editing a shared repo file. Each seat reports which file configured it.
- `~/.foreman-mcp/.env` also serves as a credential store: an API key may live there instead of the process environment. For the API key the process environment wins; for council seats the home store wins.
- [CWE-522] The council resolves its API key from the same store that supplied its endpoint. A repo `.foremanenv` pointing at a local serving box while the home store seats the council on a hosted provider is the expected setup, and resolving those independently would misdeliver a credential in one direction or the other.
- [CWE-532] Every value in the home credential store that clears the redaction harvest guards is now registered for redaction. Previously only the single resolved `FOREMAN_API_KEY` was registered, so a second credential in that file was invisible to both `scrub()` and the outbound secret gate.
- Extracted the remote chat transport into `lib/chatTransport.ts`, shared byte-for-byte between `invoke_worker` and `invoke_council`: two-phase connect/activity timeouts, byte-capped streaming reads, and the closed status-to-failure-stage mapping now have one implementation. `invoke_worker` behavior is unchanged.
- Council requests stream (`stream: true`) so the connect budget measures the endpoint rather than a multi-minute reasoning generation, and the activity budget detects a genuine mid-generation stall. OpenRouter-native provider routing is sent only when the endpoint is actually OpenRouter.
- Deliberation protocol extended to a recorded 5-rung ladder (council → single seat → both CLI advisors → one advisor → two adversarial passes). `status: unavailable` and `status: fail` both drop a rung; neither is ever a passed review. Two seats on one model is disclosed as perspective, not independence.
- Added optional Langfuse tracing for council runs, vendored zero-dependency from crucible. Off unless `FOREMAN_LANGFUSE_*` is configured; content capture is separately gated and off by default; a tracing failure degrades to silence and never alters a review.
- Bumped package to `0.5.12`.

## 0.5.11 - 2026-07-28

- Migrated from the monolithic MCP TypeScript SDK v1 package to the stable split v2 packages (`@modelcontextprotocol/server` for runtime and `@modelcontextprotocol/client` for tests).
- Upgraded to Zod 4 Standard Schema objects for every tool registration and enabled stdio negotiation for both legacy MCP clients and the 2026-07-28 protocol era.
- Made every tool input contract strict (`additionalProperties: false`), promoted display titles to v2 top-level metadata, and added validated scalar output schemas plus `structuredContent` while retaining the existing text content for clients.
- Added wire-level regression coverage for modern negotiation, legacy fallback and scalar-output projection, invalid arguments, unknown tools, and split-package diagnostics.
- Fixed `--diag` to report the installed `@modelcontextprotocol/server` version instead of probing the removed v1 package.
- Kept release tarballs offline-installable by bundling the v2 server package and its runtime dependencies.
- Excluded the workspace-local `.tmp/` npm cache from release tarballs after package-content inspection caught it in the candidate archive.
- Documented the evidence-backed lean-runtime boundary: Foreman composes installed host tools; `aider_worker` uses isolated Git worktrees without executing `git stash`; host-native isolation remains host-enforced and makes no user-edit recovery guarantee.
- Bumped package to `0.5.11`.

## 0.5.10 - 2026-07-13

- Codex advisor reviews now run `gpt-5.6-sol` at `xhigh` reasoning effort (was `ultra`); regression coverage updated.
- `invoke_advisor` timeout budget raised for newer Sol-class thinking time: default 5 → 15 minutes, cap 10 → 30 minutes. A timed-out advisor was previously killed mid-reasoning and recorded as unavailable.
- Gitleaks allowlist: exact-token entries for the aider transport and foremanEnv test fixtures, plus a path allowlist for dojo ledger-snapshot sha256 content hashes (all false positives; CI secret scan green again).
- The aiderWorker "python missing" capability-probe test now skips on hosts where python cannot be hidden from PATH (e.g. GitHub Ubuntu runners, where /usr/bin hosts both python3 and git).
- Bumped package to `0.5.10`.

## 0.5.9 - 2026-07-12

- Fixed `run_tests` on Windows when `where npm` resolves first to Node's extensionless bash shim (`C:\Program Files\nodejs\npm`), which `spawn()` cannot execute and previously failed with `ENOENT`. Foreman now invokes the adjacent `npm-cli.js` with its current Node executable, without `cmd.exe` or shell interpolation.
- Windows runner resolution now prefers native `.exe`/`.com` candidates over extensionless shims. `.cmd`/`.bat` shims remain refused when no shell-free invocation exists.
- Bumped package to `0.5.9`.

## 0.5.8 - 2026-07-12

- Codex multi-agent orchestration (`--host=codex`): new `worker_fanout` host placeholder on all profiles; implementor Step 2 renders parallel spawn/wait/summarize with per-unit ledger `delegated` before spawn and `max_depth=1`.
- New `codex_agents_init` MCP tool (registered only when `host===codex`): writes `.codex/agents/explorer.toml` + `worker.toml` (overrides built-in roles to pin sandbox_mode); creates `.codex/config.toml` `[agents]` only when absent — never clobbers existing config; model pins are optional caller overrides.
- Release tarballs now bundle all runtime dependencies (`@modelcontextprotocol/sdk`, `zod`, and `context-crush`) so local `.tgz` installation does not require npm registry access.
- Bumped package to `0.5.8`.

## 0.5.7 - 2026-07-10

- Replaced the broken Claude-Code alias in `--host=codex` with a native Codex profile: bounded workers use Codex `spawn_agent`, with `gpt-5.6-luna` recorded as a preference only when the host confirms that model selection.
- Added Claude as a first-class `capability_check` / `invoke_advisor` CLI. Codex-mode adversarial review now runs headless `claude-fable-5` at `max` effort with tools disabled and a one-dollar call budget, with Gemini as the second independent advisor.
- Removed provider names from the bundled implementor's pitboss, worker, and checkpoint rules. Advisor detection and invocation now render from the active host profile.
- Added an authoritative host-runtime preamble for project/user skill overrides so stale provider instructions cannot shadow current host routing. Claude CLI versions remain telemetry only and never gate compatibility.
- Clarified that Crucible is an optional future custom/local-model worker runner, not part of the normal Codex or Claude flow and not an owner of the frontier pitboss conversation.
- Bumped package to `0.5.7`.

## 0.5.6 - 2026-07-09

- Updated Codex review routing to `gpt-5.6-sol` with `ultra` reasoning effort.
- Updated the Cursor Advisor A profile to the matching `gpt-5.6-sol-ultra` model slug and added direct regression coverage for the Codex invocation arguments.
- Bumped package to `0.5.6`.

## 0.5.5 - 2026-07-08

- EXPERIMENTAL `aider_worker` (26th tool): a sibling of `invoke_worker` (forked, not an extension) that drives the aider Python CLI as a benchmarked local subagent. Preserves the #1 invariant — never mutate the tree, never apply from the worker tool — via an isolated-worktree→`git diff` apply model: the tool runs aider in an ephemeral worktree off the base commit (`use_git=False`, `auto_commits=False`), returns the diff verbatim between `-----BEGIN/END FOREMAN PATCH-----` sentinels plus `base_file_hashes`, and the host applies after the CAS staleness check (`ED_STALE`). Dirty base tree → `WORKER_DIRTY_TREE_REFUSAL` (refunded).
- aider transport is an external Python harness (`scripts/aider_harness.py`) spawned through the existing `lib/externalCli.ts` seam — no new Node runtime deps. A `capability_check`-style probe fails open with a recorded waiver when python/aider are absent (route falls back to `remote-chat`). Filtered child env keeps the API key off the child's environment (key travels via stdin only); harness stdout is isolated to a single metadata-only JSON object.
- New orthogonal `worker_kind` axis in `.foremanenv` (`remote-chat | aider-cli`), defaulting to `remote-chat` so existing v0.5.0 configs keep loading; `aider-cli` tiers require `FOREMAN_NUM_CTX_<T>`.
- Closed failure taxonomy extended 17 → 21 (`WORKER_BINARY_NOT_FOUND`, `WORKER_AIDER_EXIT`, `WORKER_AIDER_LLM_ERROR`, `WORKER_DIRTY_TREE_REFUSAL`), byte-shared between the `invoke_worker` PLAYBOOK and the events sidecar; all four new CLI stages are refunded (do not count against the per-model discipline scorecard).
- Server-side discipline-adherence gate in `lib/ledger.ts`: reconciles each pass-unit's ledger verdict against its latest hash-chained sidecar terminal outcome. Strict/fail-closed — only a terminal `validation_completed{outcome:'pass'}` is clean; every other terminal (including a refunded-infra failure on the latest delegation) blocks the phase gate unless a `user_override` is recorded in `discipline_overrides`. Native/Agent-delegated units with no sidecar delegation skip the gate.
- Deferred to the GPU serving host (advisory, never CI): the headroom-proxy wiring (P6) and the multi-model local bake-off (P8), which need the vLLM + aider serving environment.
- Bumped package to `0.5.5`.

## 0.5.2 - 2026-07-07

- Patch release so the published package and release tarball carry the two post-tag security fixes that v0.5.0's re-tagged run could not publish (409 — cannot publish over an existing version): the gitleaks test-fixture allowlist (`.gitleaks.toml`) and the linear slash-trim in the worker-patch protected-path check (CodeQL `js/polynomial-redos`, `workerResponse.ts`).
- Supersedes the unpublished `v0.5.1` tag (retired before its publish run); no functional changes beyond the fixes above. Bumped package to `0.5.2`.

## 0.5.0 - 2026-07-06

- S8 CCR hardening: failure-output exemption (≤8192-char failing output passes through verbatim), dead-marker/empty-output fail-open guards, miss-recovery (expired `<<ccr:HASH>>` retrieval names the originating tool), Foreman-side TTL default raised to 1800 s, vendored-fork SYNC.md with pinned upstream SHAs.
- Release engineering: push/PR CI (`ci.yml`), security workflow trio (npm audit / CodeQL / gitleaks) + dependabot, SECURITY.md with private-vulnerability-reporting route, publish smoke gate spawns the installed bin shim, SHA-pinned actions everywhere.
- Engineering ethos upstreamed: new `ethos` tool (24th) serving the bundled ethos doc with stack-profile sections; ethos content ported into the four protocol skills; project-level stack-profile override (`foreman-stack-profile.md`).
- Host contract: `generic` host id, single capability-set module with `unsupported_capabilities:` echo in `host_status`/`session_orient`, HOST-CONTRACT.md six-capability contract, `capability_check` closed status taxonomy (`ok|not_found|not_trusted|auth_expired|probe_timeout|error`) with versioned sentinel table, MCP `readOnlyHint`/`destructiveHint`/`title` annotations on all tools.
- Ledger enforcement pack: delegation cap (3 distinct rejected attempts, `user_override` escape), `inconclusive` verdict, attestation floor (5 words/32 chars), gate-staleness hash (`STALE` column + `stale_gates:` echo), atomic tmp-file writes with unique suffixes, D13 seat-minimum gate check, capability-class skill fragments (`FOREMAN_AGENT_CLASS`).
- S7 EXPERIMENTAL `invoke_worker` (25th tool): brief → OpenAI-compatible endpoint → shape-checked patch; `.foremanenv` config with `${ENV:NAME}` indirection + refuse-if-git-tracked; secret redaction on all durable writes (`[REDACTED:env:NAME]` markers); hash-chained append-only events sidecar (`Docs/.foreman-events.jsonl`); ledger post-write hook closes delegation chains; 17-stage failure taxonomy + recovery playbook in HOST-CONTRACT.md.
- S6 metrics: `read_ledger {query:"delegation_metrics"}` (survival-chain rates with explicit denominators, refund split, per-tier scorecard, drift warnings) and `ccr_stats` token-savings evidence folded into the ledger with a `ccr_savings:` footer; paired compression evidence run executed (advisory, never CI).
- `llms.txt` onboarding packet at repo root; README v0.5.0 funnel (host matrix, when-to-skip, migration note).
- Deliberated out of this release and banked for v0.6: the `invoke_worker` repair round (one release of one-shot failure-stage telemetry derives the repair trigger rules first), host-autonomy integration, and the full paired benchmark matrix (the promotion gate for worker/compression defaults).
- Bumped package to `0.5.0`.

## 0.4.0 - 2026-07-01

- Cost-tier telemetry and durable review records: delegations record `tier` + `route_reason` (appended to per-unit `delegations[]` history); `record_review` persists advisor findings to the ledger, retrievable via `read_ledger({ query: "reviews" })`.
- Relicensed from AGPL-3.0 to Apache-2.0 (2026-06-29).

## 0.3.0 - 2026-06-14

- New `preview_diagram` tool — live in-project Mermaid diagram workshop (23rd tool).

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
