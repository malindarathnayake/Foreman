---
id: what-foreman-enforces
title: What Foreman enforces
sidebar_label: What Foreman enforces
description: Which claims the TypeScript server rejects, which remain instructions to the model, and the honest boundary between them.
---

# What Foreman enforces

Two different things keep a Foreman run honest, and they should not be confused.

The **procedure** is Markdown the model reads. It tells the model to inspect files, run tests, grep the spec, and ask reviewers. The model can stop reading it, and context compaction can drop it.

The **ledger validation** is TypeScript in `lib/ledger.ts`. It runs on every `write_ledger` call and rejects writes whose recorded sequence is wrong. It survives compaction because it is not in the context at all. It also cannot see anything except the ledger: it knows a brief was recorded, not that a worker ran; it knows a preflight attestation has the right shape, not that the grep happened; it knows a pass verdict was written, not that a test passed.

## The split

| Enforced by the server | Left to the procedure |
|---|---|
| A pass verdict needs a prior delegation with a brief | The model actually reads every changed file |
| A pass after a rejection or fail verdict needs an attempt recorded after it, a worker delegation or a direct fix | The attempt fixed what was rejected |
| A delegation needs a brief of 20+ characters and a preflight attestation | The model actually runs the grep the attestation claims |
| Another attempt, or a pass, after three failed attempts since the unit last passed needs your override, recorded once as a grant or per write | The model actually runs the unit's test command |
| A recorded review finding carries a classification | The classification was honest |
| A `cross_exam` record never satisfies the review requirement; a `verification` record does only for linked direct-fix re-verdicts | The verification evidence is true |
| A pass on a no-test or no-build phase needs a five-word, 32-character attestation note | The note describes something that happened |
| A rejection on a passed unit reopens it to `pending` | The model writes the rejection when it should |
| A gate needs every unit passed and every declared unit registered | The units were the right units |
| A gate needs a review recorded after the latest verdict | The review read the right files |
| A gate refuses while a review carries a `confirmed` finding | The classification was honest |
| A gate refuses while a current review is partial, failed, or silent with no examined list | The examined list is true |
| A gate on a `hot_path` or `security_boundary` phase needs a declared frontier seat | The seat really is frontier-class |
| A gate refuses when an external worker's sidecar chain contradicts the ledger | Host-native worker behavior, which has no sidecar |
| Declared unit sets are frozen behind a passed gate | The declared set matched the spec |
| A corrupt ledger reports itself instead of looking like a fresh project | You restore it |
| Configured secrets are scrubbed from every state file on write | Secrets that never touched the environment |
| Schema errors come back as one hint per field plus the expected shape | You read them |

## Every refusal

| Write | Refused when | Message starts with | Override |
|---|---|---|---|
| `set_unit_status { s: "delegated" }` | `brief` missing or under 20 chars | `DELEGATION REQUIRED` | none |
| same | `preflight` missing | `PREFLIGHT REQUIRED` | none |
| same | three failed attempts since the unit last passed and no open grant | `DELEGATION CAP` | an open grant from `authorize_attempts`, or `user_override: true` stored on the delegation |
| same | an open grant and `user_override: true` on the same write | `AMBIGUOUS OVERRIDE` | drop one |
| `set_unit_status { s: "ip", direct_fix }` | the unit was never delegated; `direct_fix` given with another status; three failed attempts | `DIRECT FIX BLOCKED`, `DIRECT FIX`, `DELEGATION CAP` | a grant or `user_override: true` for the cap only |
| `authorize_attempts { attempts, reason, user_override: true }` | the unit is unregistered, passed, below the cap, or already has an open grant | `AUTHORIZE BLOCKED` | none |
| `set_verdict { v: "pass" }` | unit has no brief | `VERDICT BLOCKED` | none |
| same | three failed attempts since the last pass and the current attempt was neither granted nor overridden | `DELEGATION CAP` | `user_override: true`, recorded as `cap_override` |
| same | the unit was rejected or failed after its latest recorded attempt | `ATTEMPT REQUIRED` | `user_override: true`, recorded as `cap_override` |
| same | phase scope has `has_tests: false` or `has_build: false` and `note` is short or absent | `ATTESTATION REQUIRED` | none |
| `record_review` | a finding without a `classification` | `SCHEMA ERROR` | fix the call |
| same | `stage: "verification"` without `completion: "complete"` and `evidence`, or `evidence` on another stage | `VERIFICATION INCOMPLETE`, `VERIFICATION EVIDENCE` | none |
| `declare_phase_units` | neither `units` nor `retire` given | `DECLARE REQUIRED` | none |
| same | merged set over 200, or the phase gate is `pass` | `DECLARE CAP`, `PHASE GATE BLOCKED` | none; reopen the gate first |
| `set_phase_scope` | scope already set | `scope_already_set` | none |
| `update_phase_gate { g: "pass" }` | declared id not registered; empty phase; a unit not `pass` | `PHASE GATE BLOCKED` | none |
| same | flagged scope without `agent_class: "frontier"` | `SEAT MINIMUM` | `user_override: true` |
| same | sidecar terminal outcome contradicts a pass | `DISCIPLINE ADHERENCE` | `user_override: true`, recorded in `discipline_overrides` |
| same | no independent review, and no eligible verification record, at or after the latest verdict; `cross_exam` records never count | `REVIEW REQUIRED` | `user_override: true`, recorded as `review_override` |
| same | a current review has a `confirmed` finding | `CONFIRMED FINDINGS` | `user_override: true`, recorded as `confirmed_override` |
| same | a current review is `partial`, `failed`, has zero findings with no `checked` list and no `completion: complete`, or carries a finding recorded before 0.6.4 without a classification | `INCOMPLETE REVIEW` | `user_override: true`, recorded as `incomplete_override` |
| `set_unit_status { s: "delegated" }` | the brief's hash has no passing `preflight_check` record for this unit and phase | `PREFLIGHT RECEIPT` | none — run `preflight_check` |
| same | the spec's `Test:` line does not select the Go package of an authorized file | `CHECKPOINT REACH` | `user_override: true`, recorded as `reach_override` |
| same | another unit holds the repository window | `WINDOW BUSY` | record its verdict or `close_attempt` first |
| `repo_guard { operation: "snapshot" }` | the authorized file set would be empty by accident | `refused` | pass `allowed_files`, or `[]` to declare a read-only guard |
| same | an authorized file is non-empty and entirely NUL bytes | `damaged` | restore the file |
| `set_verdict { v: "pass" }` | the attempt's ownership guard did not clear | `REPOSITORY GUARD` | `user_override: true`, recorded as `guard_override` |
| same | a declared smoke plan or deliverable has no passing `live_smoke` for this attempt, or its digests moved | `SMOKE REQUIRED`, `DELIVERABLES` | `user_override: true`, recorded as `smoke` |
| same | a file or test promised under `creates` still does not exist | `FORWARD CITATIONS UNMET` | none — create it |
| same | the spec contract or checkpoint moved since the attempt was frozen | `CONTRACT CHANGED`, `CHECKPOINT CHANGED` | none — re-preflight |
| `update_phase_gate { g: "pass" }` | three consecutive counted passes carried by same-provider review alone | `INDEPENDENCE BOUND` | a receipted cross-vendor seat, or `user_override` on the record |
| `record_review` | the seat receipt is already bound to a review the ledger still holds | `SEAT RECEIPT` | none — a receipt whose record is gone is reclaimable automatically |
| any write with a bad shape | field missing, wrong enum, over a limit | `SCHEMA ERROR` | fix the call |

Every override is written into the ledger where `read_ledger` and `session_orient` can show it. There is no silent override.

## What the examples look like today

A delegation that the server accepts:

```text
write_ledger({
  operation: "set_unit_status", phase: "p1", unit_id: "u1",
  data: {
    s: "delegated",
    brief: "Add null check on config.port before parseInt; return 400 on missing port",
    tier: "standard",
    route_reason: "single-file change with an existing test",
    preflight: { symbols_grepped: 3, self_consistent: true, telemetry: "n/a" }
  }
})
```

A gate that the server refuses:

```text
write_ledger({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })

CONFIRMED FINDINGS: phase 'p1' has 1 confirmed review finding(s) recorded since its latest
unit verdict: codex: src/lib/foo.ts:42 Missing null check on config.port. Reject the affected
unit(s) (add_rejection → fix → set_verdict), then record a fresh review that shows the finding
resolved before the gate can pass — or set data.user_override: true to waive it; the waiver is
recorded on the phase as confirmed_override.
```

## Other mechanical behavior

- **Stale gates.** A passing gate stores a hash over every unit's id, verdict, and verdict timestamp. Reads recompute it and report `STALE` when a unit changed after the gate. Nothing blocks on it.
- **Corrupt ledger.** `session_orient` returns `status: ledger_corrupt` and leaves the file alone. A write renames it to `.foreman-ledger.json.corrupt.<timestamp>` and starts fresh, so read before writing.
- **Secrets.** Values harvested from the environment (name matches a secret pattern, single token, at least 8 characters, not on a short denylist of dictionary words) and values registered from `.foremanenv` are replaced with `[REDACTED:env:NAME]` in the ledger, progress, journal, `PROGRESS.md` splice, and events file before they hit disk. They are also blocked from outbound `invoke_worker` payloads. A secret that lives only in a file is not harvested and is not scrubbed.
- **Caps.** Per unit: 20 rejections, 20 delegations. Per phase: 20 reviews, 200 declared ids, 10 retire tombstones. Journal: 50 sessions, 200 events per session. Older entries are dropped first-in, first-out.
