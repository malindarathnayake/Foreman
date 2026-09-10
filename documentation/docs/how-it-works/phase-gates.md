---
id: phase-gates
title: Phase gates and reviews
sidebar_label: Phase gates and reviews
description: What must happen before a phase gate can be recorded as passed, who reviews, what the ledger refuses, and what the review policy adds.
---

# Phase gates and reviews

A phase closes with one ledger write, `update_phase_gate { g: "pass" }`. The server refuses it unless the ledger shows the work was reviewed. The procedure tells the model what to do to get there.

## The checkpoint procedure

Runs when every unit in the phase has a passing verdict. Codex uses the native procedure below; the external-first reviewer selection in steps 2-3 applies to the other hosts.

1. **Full test suite** through `run_tests`.
2. **Pick reviewers.** In order of preference: a configured review council (`invoke_council`, remote seats over one evidence packet); otherwise the two CLI advisor seats for the host; otherwise one advisor plus a recorded non-independent fallback; otherwise the model asks you: `Independent review unavailable. Proceed with pit-boss gates only? [y/N]`. Two seats on one vendor are perspective, not independence, and the review record says so.
3. **Probe** each CLI seat with `capability_check` at session start and record `<version>/<auth_status>` in the journal; re-probe at the checkpoint only if the earlier probe failed.
4. **Ask each seat** the same thing: review the phase changes against the spec; list directives not implemented, contradictions, missing error handling, test gaps, security issues with a `[CWE-###]` prefix, and telemetry contract violations; start every finding with its severity in brackets and then `file:line`, one finding per list item; and for each category list what was examined even when nothing was found. The prompt also carries the grounding rules: paste the real imports and doc excerpts for any third-party API, and read selectively rather than dumping files.
5. **`normalize_review`** turns each seat's text into findings. Unmarked prose, including the examined list, is counted, not turned into findings.
6. **Classify** each finding `confirmed`, `rejected`, or `unverified` by checking it against the code. Every recorded finding carries one; `record_review` refuses a finding without it. A seat with zero findings and no examined list is `completion: "partial"`, never clean. If one seat confirmed findings and another reported nothing, the model may re-prompt the silent seat once, naming only the files involved, and records that pass as `stage: "cross_exam"`. It never counts as a second independent seat.
7. **`record_review`** per seat: advisor, stage, completion, checked, findings with classifications.
8. **Fix confirmed findings.** Reject the affected unit, fix through a worker (reuse when the declared rank permits it), re-verdict, then record a fresh full review or eligible independently verified delta so the finding is shown resolved.
9. **`update_phase_gate { g: "pass" }`**, then `write_progress complete_unit` for the phase, then a deliberation summary to you: what was built, worker stats, gate results, findings, test results.
10. **End the session.** `write_journal end_session` with the friction summary, then: `Phase N complete. New session required.` You can override with `--force-continue`; the model logs `GATE_OVERRIDE` and keeps the same journal session.

## Who reviews, per host

| Host | Advisor A | Advisor B | Fallback when neither is available |
|---|---|---|---|
| Claude Code | Codex CLI: `codex exec`, `gpt-6-astra`, reasoning `xhigh`, read-only sandbox; needs codex-cli 0.153.4 or newer, and the seat checks the model the CLI echoes | Gemini CLI, `-m gemini-3.1-pro-preview`, plan approval mode, JSON output so the served model is checked | Claude subagents with an adversarial critic prompt, recorded as non-independent |
| Cursor | Cursor read-only `Task` seat on GPT-5.6 Sol | Cursor read-only `Task` seat on Gemini 3.1 Pro | Sonnet adversarial review, recorded as non-independent |
| Codex | Native reviewers (2-5 distinct lenses) | Separate native verifier | Native review is the default; available Claude/Gemini advisors add review at major checkpoints |

The CLIs are child processes. Each uses its own login and its own network. Foreman passes the prompt on stdin and captures stdout; on a successful call it drops the CLI's stderr unless stdout itself was truncated.

Advisors never see each other's raw output. Cross-examination, when it happens, is a separate labelled record.

## Native Codex checkpoints

With `--host=codex`, the host runs bounded workers, then 2-5 fresh read-only reviewer contexts with different risk lenses, followed by a distinct verifier. Each reviewer lists what it examined. The verifier checks findings against code and returns classifications and coverage. Native agents share a provider; this is separate-context review, not cross-vendor independence.

At major checkpoints, the existing `capability_check` and `invoke_advisor` tools add whichever Claude/Gemini advisors are available. Neither CLI is required. If an optional advisor fails or returns a partial report, its limitations are recorded and any usable claims go to the native verifier. Complete external reports are recorded separately; their confirmed findings also block the gate.

Persist the native report with `record_review` using `stage: "native"`, `completion: "complete"`, `findings`, `checked`, and `native: { reviewers: [{ agent_id, lens, completion, checked }], verifier_id }`. Use actual host-returned IDs. At least two reviewers with distinct IDs and lenses, a different verifier ID, completed coverage, and no unverified findings are required. The report must cover the current unit verdicts. Partial/failed runs can be recorded, but do not satisfy the gate; rerun the same advisor to supersede incomplete evidence. Confirmed findings require a worker fix and fresh review evidence; an eligible Top correction can extend its baseline with the delta verification path below.

A clean native review satisfies the gate without `user_override`, including after switching hosts. Other hosts retain their existing review creation policy, and legacy `stage: "fan"` records are not automatically upgraded. Native provenance is host-reported evidence: Foreman validates its structure, not the actual host session graph or UI visibility. Read the full phase ledger to inspect retained agent IDs.

## What the ledger refuses at the gate

In this order, so an earlier problem is reported before a later one:

| Check | Refusal | Override |
|---|---|---|
| A declared unit id has no ledger entry | `PHASE GATE BLOCKED: phase 'p2' declares units never registered ...` | none, seed the unit |
| The phase has no units | `PHASE GATE BLOCKED: phase 'p2' has no units recorded` | none |
| A unit's verdict is not `pass` | `PHASE GATE BLOCKED: phase 'p2' has units without a pass verdict: u5` | none; `inconclusive` units are named separately as re-run guidance |
| Phase scope is `hot_path` or `security_boundary` and the write does not declare `agent_class: "frontier"` | `SEAT MINIMUM: ...` | `user_override: true` |
| A unit passed in the ledger but its latest `invoke_worker` sidecar chain ended in a failure or never ended | `DISCIPLINE ADHERENCE: ...` | `user_override: true`, recorded in `discipline_overrides` |
| No independent review, complete native review, or eligible verification record was recorded at or after the phase's latest unit verdict. A `cross_exam` record never counts | `REVIEW REQUIRED: ...` (names how many older reviews exist and why current records do not count) | `user_override: true`, recorded as `review_override` |
| A review recorded since the latest verdict carries a finding classified `confirmed` | `CONFIRMED FINDINGS: phase 'p2' has 1 confirmed review finding(s) ... codex: src/a.ts:42 null deref ...` | `user_override: true`, recorded as `confirmed_override` with the count |
| A review recorded since the latest verdict is `completion: partial` or `failed`, or has zero findings with no `checked` list and no `completion: complete` | `INCOMPLETE REVIEW: phase 'p2' has 1 review(s) ... gemini: zero findings with no examined list` | `user_override: true`, recorded as `incomplete_override` with the count |
| A unit in the phase escaped an earlier gate and the escape is unclassified | `ESCAPE UNCLASSIFIED: phase 'p2' has 1 post-gate escape(s) not yet classified: u5 (gate #1, same_provider)` | `user_override: true`, recorded as `escape_override` |
| This would be the third consecutive counted pass carried by same-provider review alone | `INDEPENDENCE BOUND: phase 'p4' would be counted pass #4 on same_provider review since the last receipted cross-vendor seat ...` | `user_override: true`, recorded as `independence_override` |

A passing gate snapshots a hash of every unit's id, verdict, and verdict timestamp. If a unit changes afterwards, `read_ledger` and `session_orient` report the gate as stale. Nothing is blocked by staleness; it is a flag for you.

## What carried the pass: basis, receipts, escapes

The seat rule above decides whether a gate passes. Since 0.6.19 the ledger also records what carried each counted pass and what happened to the code afterwards, so the cost of a cheaper review path becomes visible instead of assumed.

**Basis.** Every counted pass (a first pass, or a re-pass over a changed unit set) is stamped with a basis class: `receipted_external` (a seat Foreman launched on another vendor, bound to the record by receipt), `declared_external` (an independent record with no receipt, which is every record written before 0.6.19), `same_provider` (a native Codex review, or a receipted seat on the host's own vendor), a `delta:` variant for an eligible verification carrying its baseline's class, or `override`. Per-basis totals survive the bounded history.

**Receipts.** `invoke_advisor` writes a hash-chained receipt for every run and returns `seat_receipt` and `packet_sha256` in its meta block. Copy both into `record_review` as `seat_receipt` and `packet_hash`. The ledger refuses a receipt that does not exist, names a different prompt, belongs to a failed run, was already bound, or ran before the newest verdict or attempt. On Codex an unreceipted independent record is stored with a warning and counts against the bound below.

**Independence bound.** Three consecutive counted passes carried by same-provider review alone (or by an override) are the limit. The next is refused until a receipted cross-vendor seat resets the streak, or you override on the record. This is what makes the erosion of cross-vendor review bounded rather than merely visible.

**Escapes.** After a gate passes, a rejection, a non-pass verdict, or a new attempt on one of its units records an escape against that gate. The ledger demands a class (`original_defect`, `remediation_defect`, `test_gap`, `process`, `new_scope`) before the unit passes again: `record_escape { class }`, or `escape_class` on the rejection itself. `record_escape { class, source: "later" }` records a defect found in a later phase or in production. `read_ledger { query: "review_outcomes" }` reports gates and escapes per basis; after enough projects, that table is how a review path earns or loses its standing. Rank never enters review sufficiency.

## Corrections: reuse baseline review coverage

Top rank can extend a retained complete independent or native review with a separate read-only verifier of the correction delta. This avoids repeating review of unchanged work; full checkpoint validation still runs. Middle, Standard and Unknown retain normal review requirements. An accepted verification remains usable after switching hosts or ranks, retaining the baseline's original provenance.

Record `stage: "verification"`, `completion: "complete"`, `checked`, `findings`, and `evidence: { kind: "worker_delta", verifier_id, baseline_review_ts, units: [{ unit_id, attempt }], files, tests, probe }`. The verifier must differ from all correcting workers and check the fix and test oracle against the spec. Evidence must cover every changed attempt and all frozen authorized paths across the corrections since the baseline. Tests and probes name their commands/methods and results, or an explicit allowed n/a reason.

Each correction must be an eligible native worker reuse with a cleared guard, in the same unit and frozen file scope. The phase cannot be `hot_path` or `security_boundary`; no confirmed finding above LOW since the baseline qualifies. A failed eligibility check requires a fresh full review. Foreman validates the recorded links and coverage, not the truth of a model's report. Rank never clears unresolved findings or replaces checkpoint evidence.

The older literal `direct_fix` / `via: "pitboss-direct"` verification path remains compatible with historical records. New corrections, including fixture and test edits, always use an implementation worker.

A silent seat is not a clean seat. When an advisor exits 0 with empty output, or echoes the prompt back, `invoke_advisor` reports `completion: failed` with the reason and the stderr tail. The procedure records it as failed with the reason in `limitations` and retries once.

## Review policy

The `ethos` tool serves a bundled engineering document, rendered with the active stack profile, that every protocol reads. It adds requirements to reviews and to unit gates. These are obligations in the procedure, not ledger checks, with one exception noted below.

- **Tiers.** Each major code path is declared `standard`, `hot`, or `extreme` at design time. A `hot` or `extreme` unit needs a stated performance rationale, and its verdict needs measured evidence against the spec's budget. A rationale without a measurement does not pass G6.
- **Security.** Any component on a trust boundary gets a threat table at design time: impact, attacker technique, control, and the named telemetry event that would show exploitation. Every security finding at review carries a `[CWE-###]` prefix, or `[CWE-UNMAPPED]` with a reason. A secret in a brief, log, span, or metric is CRITICAL at every tier and is the one G5 check that never skips.
- **Telemetry.** The spec declares span names, metric names with bounded tag values, and structured log field names before implementation. Unbounded values never become metric tags. Custom log field names are checked against the stack profile's reserved names at brief time.
- **Conflicts** between security and performance are recorded and arbitrated by you, never resolved silently.
- **Stack profile.** `FOREMAN_STACK_PROFILE` or `Docs/foreman-stack-profile.md` supplies the backend-specific rules, for example GELF reserved field names. If neither is set, the bundled reference profile is used; when the profile resolved by fallback, the procedure tells the model to flag a naming question as ambiguous rather than lint against the wrong backend.

The exception: `SEAT MINIMUM` above. A phase scoped `hot_path` or `security_boundary` cannot close unless the gate write declares a frontier-class seat or an override.

## Repeated blocks

A green suite plus a finding that the suite cannot observe the production behavior is a test-evidence failure, not a passed checkpoint. After the second such block on a phase, the procedure requires a targeted mutation or fault-injection probe over the exact seam before another reading-only review; removing the control must make the focused suite fail. Every later finding is classified `original_defect`, `remediation_defect`, `test_gap`, or `process`. After the third block the model stops and gives you a decision packet: evidence gained, surviving mutations, original versus remediation defect counts, remaining impact, cost of another round, and the choices to continue, narrow, defer, or override. Foreman never auto-passes because review is expensive.
