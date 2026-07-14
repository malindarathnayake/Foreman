# Lighttask - Foreman Context-Boundary Management

**Status:** PRESSURE-TESTED / SPEC-GENERATED / READY FOR IMPLEMENTATION
**Date:** 2026-07-10
**Scope:** Planning and pressure-testing only. No production implementation is authorized by this artifact.

## Objective

Replace the unconditional fresh-session requirement at every completed phase with a host-neutral boundary attestation and advisory without weakening Foreman's recovery or audit trail.

The feature is not "let the main model summarize itself and continue." Foreman seals verified project state and derives an advisory. Codex, Claude, Cursor, or another host independently decides whether to continue, compact, or start a new conversation. Foreman never claims that a host action occurred and verifies only canonical project state during reorientation.

## Lighttask Classification

`repo`, escalated from lighttask execution to full Foreman design/spec work.

The change spans:

- Foreman ledger, progress, journal, evidence, and MCP contracts.
- Host-owned compaction and conversation behavior, which Foreman must treat as opaque.

This crosses system boundaries and defines new intended behavior. Lighttask is therefore the grounding and planning wrapper, not the implementation protocol.

## Git Context

| Field | Value |
|---|---|
| Repository | `C:/Coding_Workspace/Github/Foreman` |
| Branch | `experiment/dojo-bakeoff` |
| Commit | `04f5cd128c141f54b3f6e6b1cabb99577eeb3882` |
| Upstream | none |
| Worktree | dirty; relevant protocol, ledger, host, type, test, and release files already modified |
| Planning rule | Treat current files as the source of truth. Do not revert or overwrite existing changes. |

Crucible is an optional custom/local-model worker runner. It is not Foreman's primary host, does not own the Codex or Claude pitboss conversation, and is outside this feature's main-context lifecycle.

## Spec Freshness

`partial`.

- Existing `docs/spec.md`, `docs/handoff.md`, and `docs/PROGRESS.md` describe v0.5-era host/autonomy behavior but do not define context attestations, derived advisories, or state-only reorientation verification.
- No `spec-man.machine.v1` artifact covers this feature.
- Relevant source files changed after the existing design/spec documents.
- This plan grounds the current checkout directly. The user's 2026-07-10 product-boundary correction approves host-neutral specification work: Codex and Claude remain primary hosts, while Crucible remains an optional local worker runner.

## Atlas Status

`graphify` is installed, but `graphify-out/` is absent. No atlas was generated because refresh/generation requires explicit approval. Direct source reads are authoritative for this plan.

## Grounding Report

- [VERIFIED] Current protocol is contradictory: `implementor.md` mandates a new session after every phase, while `_common-protocol.md` requires one only above estimated 70% context. Evidence: `foreman-mcp/src/skills/implementor.md:251-254`, `foreman-mcp/src/skills/_common-protocol.md:189-191`, `llms.txt:54`.
- [VERIFIED] A passed phase gate proves unit verdict, seat-minimum, and sidecar-discipline invariants, then snapshots only unit id, verdict, and verdict timestamp. It does not seal test, review, progress, journal, or Git evidence. Evidence: `foreman-mcp/src/lib/ledger.ts:103-113,287-350`.
- [VERIFIED] `Phase` has no seal/capsule state and `WriteLedgerInputSchema` has no matching operation. Evidence: `foreman-mcp/src/types.ts:60-70,127-180`.
- [VERIFIED] Advisor findings have optional classification but no stable finding id, resolution, or closure state. Evidence: `foreman-mcp/src/types.ts:42-58,154-170`.
- [VERIFIED] `run_tests` returns formatted text but persists no structured phase evidence receipt. Evidence: `foreman-mcp/src/tools/runTests.ts:48-175`.
- [VERIFIED] `session_orient` reads progress and discards it, derives position from lexically sorted ledger ids, and reports stale gates without invalidating their completed status. Evidence: `foreman-mcp/src/tools/sessionOrient.ts:24-31,43-157`.
- [VERIFIED] Progress corruption is converted to an empty structure on the current read path, so orientation cannot distinguish missing, corrupt, and genuinely empty progress. Evidence: `foreman-mcp/src/lib/progress.ts:27-50`.
- [VERIFIED] Journal closure is inferred from optional duration/summary fields; no explicit close marker or boundary receipt exists. Evidence: `foreman-mcp/src/types.ts:329-339`, `foreman-mcp/src/lib/journal.ts:165-204`.
- [VERIFIED] Foreman does not provide the autonomous trigger; the host supplies it. Autonomous work suspends across compaction and re-enters through `session_orient`. Evidence: `foreman-mcp/HOST-CONTRACT.md:66-74,103-113`.
- [VERIFIED] Codex declares `autonomy: false`; its native worker model selection remains host-owned. Evidence: `foreman-mcp/src/lib/capabilitySet.ts:20-30`, `foreman-mcp/src/lib/hostProfiles.ts:69-88`.
- [VERIFIED] Codex exposes user `/compact` and token-threshold automatic compaction, but no phase-triggered Foreman MCP primitive is available in the current host contract.
- [MISMATCH] Live `session_orient` returned `status: in_progress`, `current_phase: exp01-calc`, `current_unit: null`, `next_pending_unit: null`, and `stale_gates: p1,p3`. This is diagnostic output, not an actionable automatic-resume contract.
- [VERIFIED] Existing context journal code `CTX_COMP` is a short event, not a canonical capsule store. Evidence: `foreman-mcp/src/types.ts:362-372`.
- [VERIFIED] Current `docs/*` planning artifacts are ignored by `.gitignore`. This pressure-tested plan therefore lives at the non-ignored, trackable path `foreman-mcp/CONTEXT-BOUNDARY-PLAN.md`; `.npmignore` excludes it from release tarballs.
- [UNVERIFIED] Exact context utilization is not available to Foreman as trusted structured host telemetry. Current `ctx_used_pct` is model-supplied at `end_session`.
- [VERIFIED] Crucible is not part of the primary pitboss context lifecycle. Native Codex/Claude subagents remain bounded worker seats; neither is a main-context rotation mechanism.

## Current Status

The host-neutral design and implementation documents are complete. Implementation begins with reorientation correctness and does not change host context behavior. Automatic compaction remains outside Foreman's implementation scope.

## Proposed Contract

### Separate State Axes

Do not overload `phase.g` or `session_orient.status` with context lifecycle.

| Axis | Values | Owner |
|---|---|---|
| Phase validity | `working`, `checkpoint_ready`, `sealed`, `stale`, `blocked`, `corrupt`, `legacy_unsealed` | Foreman |
| Boundary advisory | `not_ready`, `host_choice`, `fresh_context_recommended`, `blocked_by_state` | Pure, versioned policy derived from verified Foreman state |

Optional future context observations are separate telemetry, never part of the attestation. An observation must declare its trust as `caller_reported` or `adapter_verified`; native Codex and Claude currently provide no adapter-verified compaction receipt.

### Boundary Flow

```text
phase work
  -> unit verdicts and G1-G6
  -> full checkpoint tests/build/advisors
  -> update_phase_gate(pass)
  -> progress sync
  -> end_session
  -> prepare_context_boundary (Foreman snapshots exact bytes and atomically commits only the ledger record)
  -> Foreman returns immutable attestation plus derived advisory
  -> host independently continues, compacts, or creates a new conversation
  -> current or later context calls session_orient(boundary_id)
  -> Foreman re-hashes and verifies canonical project state only
  -> init_session
  -> next phase may mutate
```

The protocol forbids next-phase mutation before successful reorientation verification. Foreman can reject its own ledger transitions, but it cannot prevent a host from editing files directly or prove that the caller is a fresh or compacted model context.

This is not a multi-file transaction. The ledger lock cannot serialize progress, journal, Git, or sidecar writers. The seal is a drift-detecting attestation over the exact bytes/projections Foreman read. Verification re-reads every input and fails closed on mismatch. A crash after journal closure but before the ledger seal leaves `checkpoint_ready` and is safely re-runnable.

### Phase Seal V1

Recommended storage: optional, append-only, hash-chained boundary records under the phase. Legacy ledgers remain readable and become `legacy_unsealed`, never silently auto-sealed.

A record contains bounded data only:

```text
schema_version
boundary_id and generation
previous_boundary_hash
phase and sealed_at
canonical phase projection hash
gate snapshot hash
verified sidecar terminal/discipline evidence hash
phase progress projection hash
closed journal session id/hash
review closure hash or versioned absent marker
test/build evidence receipt ids/hashes or explicit waiver ids/absent marker
spec/handoff hashes
workspace fingerprint kind/hash
risk facts used by the separately versioned advisory evaluator
user override id/reason/expiry when applicable
```

It must not contain raw prompts, raw model output, raw test logs, secrets, a recommended host action, a host acknowledgement, or a hash of the entire mutable ledger. The canonical phase projection excludes the seal itself. V1 is shadow-only and carries an explicit absent marker for review resolution until that subsystem ships.

### Evidence Rules

- `run_tests` should emit and persist bounded append-only receipts: command id, normalized argv hash, exit code, timestamp, output digest/pointer, truncation, and runner identity.
- Shell-equivalent evidence is accepted only through an explicit attestation/waiver path because Foreman did not observe it.
- Review findings need stable ids plus resolution/waiver state. `confirmed` and `unverified` findings cannot be treated as closed merely because a later phase gate passed.
- Journal closure must be explicit and read-only corruption checks must never rename or replace state during orientation.
- Git workspaces use HEAD plus a canonical tracked-source/index/worktree digest. The Git digest excludes `docs/.foreman-*`, `Docs/.foreman-*`, configured ledger/progress/journal/event paths, `.git/`, and declared scratch/worktree roots because those inputs are hashed separately or are non-product state. It does not exclude arbitrary dirty product files. Non-git workspaces use a declared degraded file-manifest fingerprint.
- The gate snapshot alone is insufficient. The seal independently hashes the verified terminal sidecar events and durable discipline overrides used to justify gate passage.
- Every external input is stored as an exact-byte or canonical-projection digest. Verification uses the same versioned canonicalizer; timestamp/key-order noise is excluded only when the schema explicitly permits it.

### Policy Rules

1. The main model may request a boundary; it cannot certify its own attestation.
2. `host_choice` requires a valid low-risk attestation. It does not authorize or verify a host action.
3. `fresh_context_recommended` is derived only from mechanical state: `security_boundary`, unresolved high/critical findings, stale state, repeated failed attempts, and explicit spec-declared contract/architecture flags.
4. Foreman never estimates context pressure, invokes `/compact`, creates a host conversation, or records a native-host action as verified.
5. Identical canonical project state produces identical validity and advisory output for Codex, Claude, Cursor, and generic hosts.
6. Native subagents remain worker seats. Luna or any other worker cannot inherit the pitboss role merely because a host spawned it.
7. Context summaries are disposable caches. Ledger/spec/handoff/live source remain authoritative.
8. Any drift, schema mismatch, corrupt state, or invalid boundary id fails closed. Corrupt state can never be overridden into an attestation.

## Pending Decisions

| ID | Decision | Recommended Choice | Blocking |
|---|---|---|---:|
| D1 | Delivery scope | Foreman state attestation and advisory only; no Crucible or native-host lifecycle implementation | resolved |
| D2 | Gate vs attestation | Distinct `prepare_context_boundary`; never overload `update_phase_gate` | resolved |
| D3 | MCP surface | One operation-based `context_boundary` tool for prepare/verify; orientation remains in `session_orient` | resolved |
| D4 | Attestation storage | Optional append-only phase boundary records with canonical projection hashes | resolved |
| D5 | Test/build trust | Tool-issued receipt; explicit recorded waiver for external shell evidence | resolved |
| D6 | Review closure | Stable finding ids and explicit resolve/waive operations | resolved |
| D7 | Workspace fingerprint | HEAD plus canonical tracked dirty-state digest; degraded manifest for non-git | resolved |
| D8 | High-risk classification | Spec-declared flags plus mechanical failure/review state; never free-form model inference | resolved |
| D9 | User experience | Non-blocking advisory; host retains the decision; explicit override remains available where state is valid | resolved |
| D10 | Plan/spec location | Plan is tracked here; formal working documents use the repository's lowercase `docs/` convention | resolved |
| D11 | Advisor budget | Make Claude advisor budget configurable; retain a bounded default and record budget exhaustion distinctly | separate prerequisite |

## Implementation Plan

### Stage 0 - Formalize Before Coding

| Unit | Change | Files/Surface | Verification |
|---|---|---|---|
| P0.1 | Record the approved host-neutral responsibility boundary and D1-D10 | `docs/design-summary.md` | User correction captured; no blocking open items |
| P0.2 | Run `spec_generator`; define schemas, migrations, error table, advisory contract, and acceptance tests | spec, handoff, progress, testing harness | Spec contract trace; exact caller/error/status tables |

### Stage 1 - Reorientation Correctness, No Behavior Change

| Unit | Change | Primary Files | Verification |
|---|---|---|---|
| U1.1 | Add `readProgressWithStatus` and `readJournalWithStatus`; distinguish missing/corrupt/empty without mutation | `src/lib/progress.ts`, `src/lib/journal.ts`, types | focused corruption tests; read-only paths create/rename nothing |
| U1.2 | Add explicit journal closure and bounded append-only test/build receipts; do not add a seal yet | journal/types, `src/tools/runTests.ts`, receipt store/handler | closure idempotence plus success/fail/timeout/truncation/waiver tests |
| U1.3 | Add explicit phase order or a backward-compatible order source, reconcile ledger/progress, and make stale/corrupt state explicit in `session_orient` while preserving existing fields | types, ledger/progress/orient, server | mixed-id ordering, legacy, stale, divergence, and integration fixtures |

Exit gate: current live state must return an explicit blocked/stale reorientation result, never `in_progress` with no actionable unit.

### Stage 2 - Seal V1, Shadow Only

| Unit | Change | Primary Files | Verification |
|---|---|---|---|
| U2.1 | Add optional V1 hash-chained attestation schema with a versioned review-resolution absent marker | `src/types.ts`, canonical hash module | deterministic hash/golden schema tests; deletion/reorder/legacy fixtures |
| U2.2 | Implement boundary snapshot/verify engine: read exact inputs, validate prerequisites, then use the ledger lock only for the final append | new `src/lib/contextBoundary.ts`, ledger/read tools | TOCTOU re-read, crash-before-seal, idempotence, replay, self-drift, sidecar, and secret tests |
| U2.3 | Expose shadow prepare/verify output through orientation/read views; it may classify and log but cannot trigger a host action | `sessionOrient.ts`, read tools, optionally an operation-based MCP surface | schemas, annotations/tool list as applicable, publish smoke |

Exit gate: V1 shadow records and verifies drift only. Missing review resolution is explicit. No result claims that a host compacted, created a conversation, or continued.

### Stage 3 - Seal V2 and Host-Neutral Advisory Protocol

| Unit | Change | Primary Files | Verification |
|---|---|---|---|
| U3.1 | Add stable review finding ids and explicit resolve/waive records; upgrade boundary schema/version to include closure | types, ledger/review tools, boundary canonicalizer | unresolved/rejected/resolved/waived review matrices and migration fixtures |
| U3.2 | Add the pure advisory evaluator and structured boundary output; keep attestation hashes independent from policy output | boundary policy/tool/read views | host-parity, policy-version, no-side-effect, and attestation-stability tests |
| U3.3 | Replace contradictory fresh/70% text with event-based sealed-boundary policy and mandatory post-action orientation | `_common-protocol.md`, `implementor.md`, progress hints | skill render/trim tests on all hosts |
| U3.4 | Update README, llms, usage, changelog, and migration notes | public docs | claims audit, build/full suite/publish smoke |

Exit gate: existing consumers receive only host-neutral advisory output. Foreman performs no automatic host action.

## Rollout

1. **Shadow:** ship stronger orientation and V1 drift attestation behind a disabled flag; classify and log only.
2. **Advisory:** return `host_choice` or `fresh_context_recommended` with mechanical reasons; the host decides what to do.
3. **Default consideration:** enable advisory output after soak data shows no false attestations or drift misses.

Automatic compaction, new-conversation creation, and session rotation remain outside Foreman's rollout.

Rollback is configuration-only at every stage: disable context-boundary output and retain the current fresh-session/manual reorientation path. Boundary records remain readable audit evidence.

## Migration and Compatibility

- Keep ledger/progress/journal version 1 readable; all new fields are optional on read and strict on new writes.
- Legacy passed phases are `legacy_unsealed`, not corrupt and not attested.
- Never auto-seal legacy phases. Explicit migration requires re-gating with current evidence; a user attestation may waive unavailable legacy evidence but cannot turn corrupt state into sealed state.
- Never rewrite an existing seal. Drift produces a stale generation; a new gate/checkpoint creates a new boundary generation.
- Chain each boundary record to its predecessor so deletion/reordering is detectable.
- Existing live stale gates (`p1,p3`) remain report-only during shadow rollout. They require re-gating before any future seal; shadow mode must not block unrelated current work.
- Preserve every existing `session_orient` output field and append new fields during the compatibility window.
- Keep `codex.autonomy` unchanged. Autonomy describes unattended goal continuation, not native context compaction.
- Tool count and publish surface change only if a new MCP tool is chosen; an operation-based existing tool avoids count churn but has weaker discoverability. D3 must settle this explicitly.

## Pressure-Test Matrix

| Scenario | Required Result |
|---|---|
| Gate pending, all units pass | `checkpoint_ready`, never sealed |
| Gate pass, stale gate hash | seal rejected; auto-resume blocked |
| Gate evidence sidecar or discipline override changes after pass | seal/verification stale with exact reason |
| Ledger valid, progress missing/corrupt/divergent | explicit blocked/degraded reason; never empty-state substitution |
| Journal open or corrupt | seal rejected without state mutation |
| Required test/build receipt missing | seal rejected or explicit user waiver required |
| Review contains unresolved confirmed/unverified finding | seal rejected |
| Attestation written, host takes no context action | state remains valid; no action is claimed or required |
| Host compacts mid-unit/mid-review without reporting it | not detectable by Foreman; protocol requires re-grounding when the host exposes the event |
| Duplicate prepare/verify | idempotent; no duplicate boundary generation |
| Boundary record deleted or reordered | previous-boundary chain fails closed |
| Wrong or stale boundary id | verification rejected |
| HEAD/branch/relevant dirty state changes after seal | deterministic stale reason |
| Foreman state file changes only | workspace fingerprint remains stable |
| Non-git workspace | declared degraded manifest; never fake clean Git state |
| Legacy ledger without seal | manual fresh path preserved |
| Security/architecture/API-contract phase | fresh required regardless of pressure |
| Capsule tamper/schema mismatch | fail closed |
| Corrupt state plus user override | override rejected; fresh/manual recovery only |
| Codex lacks phase action primitive | expected; identical host-neutral advisory still returned |
| Advisory policy changes | immutable attestation hash remains unchanged |
| Codex/Claude/Cursor/generic see identical project state | identical validity, advisory, and reason codes |
| Crucible absent or unavailable | no effect on boundary behavior or primary-host operation |
| Crash between gate/progress/journal/seal writes | unsealed; rerun verification safely |
| Advisor exceeds budget | distinct budget exhaustion, fallback/waiver policy; never silently call review complete |

## Verification Commands

From `foreman-mcp/` after implementation units exist:

```powershell
npx vitest run tests/sessionOrient.test.ts tests/progress.test.ts tests/journal.test.ts
npx vitest run tests/contextBoundary.test.ts tests/ledger.test.ts tests/writeTools.test.ts
npx vitest run tests/hostProfiles.test.ts tests/hostStatus.test.ts tests/skillLoaderHost.test.ts tests/skillTrimming.test.ts
npx vitest run tests/integration.test.ts
npm run build
npm test
node scripts/publish-smoke.mjs
```

## Deliberation Summary

Claude Fable 5 Max returned **MODIFY**. Moderator disposition against source:

| Finding | Disposition | Plan Change |
|---|---|---|
| Ledger lock was described as cross-file atomicity | AGREE | Seal redefined as drift-detecting attestation; only final ledger append is atomic |
| Workspace fingerprint could include Foreman state and self-invalidate | NUANCE - exclusion was intended but underspecified | Exact excluded state/scratch path classes are now named; those files are separately hashed |
| Gate hash omits sidecar/discipline evidence | AGREE | Seal independently hashes verified terminal sidecar evidence and overrides |
| V1 referenced unbuilt review-resolution and host-ack systems | AGREE | V1 keeps only the review-resolution absent marker; host acknowledgement is removed from Foreman state |
| Silent-empty progress could launder corruption | AGREE - Stage 1 already preceded seal but dependency was not hard enough | Read-status and explicit closure/receipt work now hard-precede seal code |
| No migration for current stale gates | AGREE | Shadow reports only; stale phases must re-gate |
| No previous-seal chain; corrupt override ambiguous | AGREE | Hash chain added; corrupt-to-seal overrides forbidden |
| Pressure-based signal is impossible without trusted telemetry | AGREE | Codex V1 signal is checkpoint-event-based, never pressure-estimated |

Source-level adversarial review independently confirmed the same core boundaries: separate gate/attestation, fail-closed state orientation, no claimed Codex phase primitive, and no subagent-to-pitboss promotion.

A second audit after the user's product correction returned **MODIFY** and found that verified host acknowledgement and Crucible session rotation still leaked into Foreman core. Both were removed. The resulting contract is state-only and host-neutral: immutable attestation, derived advisory, and no context-action side effects.

## Error Recovery Log

| Date | Unit | Error | Recovery | Status |
|---|---|---|---|---|
| 2026-07-10 | Advisor validation | Broad Claude Fable Max review exceeded Foreman's hardcoded `$1` budget | Narrowed the evidence and output contract; review succeeded; budget configurability recorded as D11 | resolved for planning |
| 2026-07-10 | Plan pressure test | Claude found false cross-file atomicity and an overfull V1 schema | Reframed seal as attestation; hard-sequenced prerequisites; split V1 shadow from V2 enforcement | resolved in plan |

## Session Log

- 2026-07-10: Installed Foreman `lighttask` activated through the Codex-hosted MCP server.
- 2026-07-10: Workspace/git/spec/atlas gates completed; current checkout grounded directly.
- 2026-07-10: Live orientation exposed stale/non-actionable resume state.
- 2026-07-10: Full feature classified as cross-system and escalated; no production code changed.
- 2026-07-10: Claude Fable Max and two source-grounded adversarial passes completed; findings moderated and plan revised.
- 2026-07-10: User clarified that Crucible is only an optional custom/local-model runner; Codex native subagents remain the normal flow.
- 2026-07-10: Follow-up audit removed host acknowledgement and Crucible session rotation from Foreman core; plan approved for specification.
- 2026-07-10: `spec_generator` produced `docs/design-summary.md`, `docs/spec.md`, `docs/handoff.md`, `docs/PROGRESS.md`, and `docs/testing-harness.md` with feature-specific `cb-*` phases.
