---
id: phase-gates
title: Phase gates and reviews
sidebar_label: Phase gates and reviews
description: What must happen before a phase gate can be recorded as passed, who reviews, what the ledger refuses, and what the review policy adds.
---

# Phase gates and reviews

A phase closes with one ledger write, `update_phase_gate { g: "pass" }`. The server refuses it unless the ledger shows the work was reviewed. The procedure tells the model what to do to get there.

## The checkpoint procedure

Runs when every unit in the phase has a passing verdict.

1. **Full test suite** through `run_tests`.
2. **Pick reviewers.** In order of preference: a configured review council (`invoke_council`, remote seats over one evidence packet); otherwise the two CLI advisor seats for the host; otherwise one advisor plus a recorded non-independent fallback; otherwise the model asks you: `Independent review unavailable. Proceed with pit-boss gates only? [y/N]`. Two seats on one vendor are perspective, not independence, and the review record says so.
3. **Probe** each CLI seat with `capability_check` at session start and record `<version>/<auth_status>` in the journal; re-probe at the checkpoint only if the earlier probe failed.
4. **Ask each seat** the same thing: review the phase changes against the spec; list directives not implemented, contradictions, missing error handling, test gaps, security issues with a `[CWE-###]` prefix, and telemetry contract violations; start every finding with its severity in brackets and then `file:line`, one finding per list item; and for each category list what was examined even when nothing was found. The prompt also carries the grounding rules: paste the real imports and doc excerpts for any third-party API, and read selectively rather than dumping files.
5. **`normalize_review`** turns each seat's text into findings. Unmarked prose, including the examined list, is counted, not turned into findings.
6. **Classify** each finding `confirmed`, `rejected`, or `unverified` by checking it against the code. Every recorded finding carries one; `record_review` refuses a finding without it. A seat with zero findings and no examined list is `completion: "partial"`, never clean. If one seat confirmed findings and another reported nothing, the model may re-prompt the silent seat once, naming only the files involved, and records that pass as `stage: "cross_exam"`. It never counts as a second independent seat.
7. **`record_review`** per seat: advisor, stage, completion, checked, findings with classifications.
8. **Fix confirmed findings.** Reject the affected unit, fix through a fresh worker, re-verdict, then re-run the review so a fresh record shows the finding gone.
9. **`update_phase_gate { g: "pass" }`**, then `write_progress complete_unit` for the phase, then a deliberation summary to you: what was built, worker stats, gate results, findings, test results.
10. **End the session.** `write_journal end_session` with the friction summary, then: `Phase N complete. New session required.` You can override with `--force-continue`; the model logs `GATE_OVERRIDE` and keeps the same journal session.

## Who reviews, per host

| Host | Advisor A | Advisor B | Fallback when neither is available |
|---|---|---|---|
| Claude Code | Codex CLI: `codex exec`, `gpt-5.6-sol`, reasoning `xhigh`, read-only sandbox | Gemini CLI, `-m arch-review`, plan approval mode | Claude subagents with an adversarial critic prompt, recorded as non-independent |
| Cursor | Cursor read-only `Task` seat on GPT-5.6 Sol | Cursor read-only `Task` seat on Gemini 3.1 Pro | Sonnet adversarial review, recorded as non-independent |
| Codex | Headless Claude: `claude -p`, `claude-fable-5`, effort `max`, no tools, no session persistence | Gemini CLI | Adversarial self-review, recorded as non-independent |

The CLIs are child processes. Each uses its own login and its own network. Foreman passes the prompt on stdin and captures stdout; on a successful call it drops the CLI's stderr unless stdout itself was truncated.

Advisors never see each other's raw output. Cross-examination, when it happens, is a separate labelled record.

## What the ledger refuses at the gate

In this order, so an earlier problem is reported before a later one:

| Check | Refusal | Override |
|---|---|---|
| A declared unit id has no ledger entry | `PHASE GATE BLOCKED: phase 'p2' declares units never registered ...` | none, seed the unit |
| The phase has no units | `PHASE GATE BLOCKED: phase 'p2' has no units recorded` | none |
| A unit's verdict is not `pass` | `PHASE GATE BLOCKED: phase 'p2' has units without a pass verdict: u5` | none; `inconclusive` units are named separately as re-run guidance |
| Phase scope is `hot_path` or `security_boundary` and the write does not declare `agent_class: "frontier"` | `SEAT MINIMUM: ...` | `user_override: true` |
| A unit passed in the ledger but its latest `invoke_worker` sidecar chain ended in a failure or never ended | `DISCIPLINE ADHERENCE: ...` | `user_override: true`, recorded in `discipline_overrides` |
| No independent review, and no eligible verification record, was recorded at or after the phase's latest unit verdict. A `cross_exam` record never counts | `REVIEW REQUIRED: ...` (names how many older reviews exist and why current records do not count) | `user_override: true`, recorded as `review_override` |
| A review recorded since the latest verdict carries a finding classified `confirmed` | `CONFIRMED FINDINGS: phase 'p2' has 1 confirmed review finding(s) ... codex: src/a.ts:42 null deref ...` | `user_override: true`, recorded as `confirmed_override` with the count |
| A review recorded since the latest verdict is `completion: partial` or `failed`, or has zero findings with no `checked` list and no `completion: complete` | `INCOMPLETE REVIEW: phase 'p2' has 1 review(s) ... gemini: zero findings with no examined list` | `user_override: true`, recorded as `incomplete_override` with the count |

A passing gate snapshots a hash of every unit's id, verdict, and verdict timestamp. If a unit changes afterwards, `read_ledger` and `session_orient` report the gate as stale. Nothing is blocked by staleness; it is a flag for you.

## Trivial follow-ups: the verification record

A review that finds only LOW items, fixed by direct fix, used to cost a fresh seat because the re-verdict made the review stale. Since 0.6.5 the model may close that case with `record_review { stage: "verification", completion: "complete", evidence }` instead. The evidence names the independent review it extends (`baseline_review_ts`), each unit and attempt re-verified, the files, the test command and result, and the mutation probe and result, or a stated reason either does not apply. The server cannot check the evidence; what it checks is the link. The record counts for the gate only when all of these hold: the baseline is a retained independent review; the phase is not `hot_path` or `security_boundary`; no `confirmed` finding above LOW was recorded since the baseline; every unit re-verdicted since the baseline passed `via: "pitboss-direct"` with a direct-fix record at its current attempt; the evidence names that exact unit and attempt; and the sidecar shows no `invoke_worker` delegation for that attempt. When any of those fails, `REVIEW REQUIRED` says which, and the follow-up needs a seat.

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
