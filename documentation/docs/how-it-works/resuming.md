---
id: resuming
title: Resuming a session
sidebar_label: Resuming a session
description: The exact calls that recover the next safe action after a stop, a crash, or a handoff, and what each field means.
---

# Resuming a session

Every session starts the same way, whether it is the first, a planned continuation after a phase gate, or recovery from a crash. The procedure makes the model do this before anything else:

```text
bundle_status                                  version, and whether a skill override is active
session_orient                                 the only resume authority
read_progress                                  the same ledger summary, followed by checklist notes
read_ledger({ query: "verdicts", phase: "<current>", limit: 50 })   a bounded slice, never "full"
write_journal({ operation: "init_session", ... })
```

Paste this to start any later session:

```text
Use the Foreman MCP server. Call session_orient, then pitboss_implementor with the
context "Resume from Foreman state."
```

## What `session_orient` returns

```text
status: in_progress
action: implement_unit
resume_target: p2/u3
current_phase: p2
current_unit: u3
last_completed_unit: p2/u2
latest_pass_verdict_unit: p1/u4
latest_pass_verdict_ts: 2026-09-03T14:02:11.318Z
next_pending_unit: p2/u4
blocked_on: null
active_rejections: 0
attempt_blocks: none
attempt_grants: none
phases_total: 4
phases_done: 1
unsupported_capabilities: none
stale_gates: none
state_drift: none
progress_advisories: none
missing_declared_units: none
```

| Field | Meaning |
|---|---|
| `action` | `plan_project` (empty ledger), `implement_unit`, `retry_phase_gate` (every unit passed, gate still pending), `complete`, or `resolve_phase_state` (a phase is open but has no unit to work) |
| `resume_target` | `<phase>/<unit>`, `<phase>/phase_gate`, or `null` |
| `current_phase`, `current_unit` | First phase whose gate is not `pass`; first unit in it, registered or declared, whose verdict is not `pass`. Ids sort naturally: `p2` before `p10` |
| `last_completed_unit` | The completion frontier: newest `first_pass_ts`. Re-verdicting an older unit does not move it |
| `latest_pass_verdict_unit`, `latest_pass_verdict_ts` | Newest pass by `v_ts`. Re-verdicts move it. Useful for "what was touched last" |
| `next_pending_unit` | First unit with status `pending`, or declared and not yet seeded, from the current phase on |
| `blocked_on`, `active_rejections` | First unit with rejections and no pass verdict; count of such units across all phases |
| `attempt_blocks` | Units the ledger will refuse a pass on: `p4/u2:cap(3)` for three failed attempts since the last pass with no open grant, `p1/u3:needs_attempt` for a rejection or fail verdict with no attempt recorded since |
| `attempt_grants` | Open owner grants past the cap: `p4/u2:#1(2 left)`. The next attempt on that unit is charged to the grant; do not ask for another override |
| `stale_gates` | Phases whose passed-gate hash no longer matches their units |
| `state_drift` | `progress:complete(<unit>);ledger:<target>` when the progress file marks a unit complete that the ledger has not passed, the one contradiction the file cannot honestly hold; `progress:<unit>;ledger:no_phases` when progress has units and the ledger has none. Where the progress pointer sits relative to the ledger target is never drift |
| `progress_advisories` | Non-blocking: `stale:<paths>` for entries still open on units the ledger passed, `ahead:<paths>` for open entries later than the target, `orphan:<paths>` for entries the ledger does not know. Five per kind, then a count |
| `missing_declared_units` | Declared ids with no ledger entry, up to ten |
| `units_passed`, `units_total`, `units_remaining` | Passed verdicts versus the union of registered and declared units in the ledger. Declared units without entries count as remaining. Scope not yet declared in the ledger is not counted |
| `phases_done`, `phases_total` | Passed phase gates versus ledger phases. Every unit passing does not finish the project while a phase gate remains pending |
| `unsupported_capabilities` | What the active host profile cannot do, from the capability contract |

`read_progress` uses this same calculation on every host profile. Its `LEDGER STATUS` section agrees with `session_orient` for the same stored state. The following `PLANNING CHECKLIST` section labels its own totals as `entries_marked_complete` and `entries_total`; these describe checklist coverage, not project completion. For example, all 67 checklist entries can be marked complete while the ledger reports 67 of 71 units passed, 9 of 13 phase gates passed, and a current unit still in progress. Reads display this difference without changing either file.

Three example shapes:

```text
action: implement_unit        resume_target: p2/u3        -> work u3
action: retry_phase_gate      resume_target: p2/phase_gate -> run the checkpoint again
action: complete              resume_target: null         -> nothing left
```

## What the procedure does with it

- **`state_drift` is not `none`:** stop and reconcile before delegating. The ledger target wins; the progress file is corrected to match. A unit reopened by a checkpoint finding after `complete_unit` is the common cause; re-verdict it or reset its progress status.
- **`progress_advisories` is not `none`:** continue. Fix stale entries with `complete_unit` when convenient; ahead entries are the plan getting written down early; orphans are usually an old id scheme.
- **`missing_declared_units` is not `none`:** seed each with `set_unit_status { s: "pending" }` before delegating. They are spec scope the ledger does not track yet.
- **The current unit is `ip`:** treat it as not started. Re-read the files, rebuild the brief, respawn the worker. The previous worker's partial edit is not trusted; the repository-state guard in validation will catch anything it left behind.
- **`blocked_on` is set:** read that unit's rejections with `read_ledger({ phase, unit_id })` before writing a fix brief.
- **`attempt_blocks` names a unit:** `needs_attempt` means the next write for it is a recorded worker delegation, not a verdict. `cap(n)` means stop and bring the rejection history to the owner; the ledger refuses another attempt and a pass alike until the owner records a grant with `authorize_attempts` or a write carries `user_override`. A unit listed under `attempt_grants` is not blocked: charge the next attempt to the grant.
- **`stale_gates` is set:** a unit changed after its phase closed. The gate is not reopened for you; decide whether to re-run the checkpoint.

## Corrupt ledger

```text
status: ledger_corrupt
ledger_path: Docs/.foreman-ledger.json
hint: Ledger JSON failed to parse. File left untouched. Prior project state is NOT gone —
      inspect/restore the file before any write_ledger call (writes rename it to
      .corrupt.<ts> and start fresh).
```

Reads never touch the file. The first write renames it to `.foreman-ledger.json.corrupt.<timestamp>` and starts a new empty ledger. Restore from git or from that backup before letting the model write.

## What still needs you

Orientation tells the model where it is. It does not tell it whether the spec is still right, whether a stale gate should be reopened, or whether a three-times-rejected unit needs a fourth attempt or a redesign. Those come back to you as questions, and the procedure is written to stop for the answer.

## Model ranks on resume

During normal `write_journal init_session`, the pitboss declares `env.model` and `env.effort`. Foreman trusts the declaration and returns `model_rank` with a weight and explicit permissions. Unavailable, unknown or unmapped values grant no shortcuts and never block normal startup. No identity authentication or owner confirmation is added.

Astra (`gpt-6-astra`) at `high`, `xhigh`, `max` or `ultra`, and Fable 5.1 receive Top weight 3; Opus and Terra receive Middle 2; Sonnet and Luna receive Standard 1. Other models, including Sol, receive Unknown 0 and normal protocol. Rank does not alter the configured seat capability or cost tier.

`session_orient` and `read_progress` show the active declaration, rank, weight and `workflow_permissions`. A model/effort change calls `write_journal { operation: "declare_model", data: { model, effort } }` before the next action; both fields are replaced, so omission does not preserve a previous Top rank. Ending a session or restarting Foreman clears the active declaration. New sessions always declare again.

A host or model switch keeps valid durable review evidence. The incoming rank determines the next action's permissions, and a previous host's worker ID is not presumed live. Reuse only a native worker in the same active session and original unit/file scope; otherwise start a fresh worker. Every correction remains a recorded attempt with ownership checks.
