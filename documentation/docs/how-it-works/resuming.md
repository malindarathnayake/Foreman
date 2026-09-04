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
read_progress                                  the descriptive checklist; never the resume target
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
phases_total: 4
phases_done: 1
unsupported_capabilities: none
stale_gates: none
state_drift: none
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
| `stale_gates` | Phases whose passed-gate hash no longer matches their units |
| `state_drift` | `progress:<target>;ledger:<target>` when the progress file points elsewhere, or `progress:complete(<unit>);ledger:<target>` when progress marks the ledger's own resume unit complete |
| `missing_declared_units` | Declared ids with no ledger entry, up to ten |
| `unsupported_capabilities` | What the active host profile cannot do, from the capability contract |

Three example shapes:

```text
action: implement_unit        resume_target: p2/u3        -> work u3
action: retry_phase_gate      resume_target: p2/phase_gate -> run the checkpoint again
action: complete              resume_target: null         -> nothing left
```

## What the procedure does with it

- **`state_drift` is not `none`:** stop and reconcile before delegating. The ledger target wins; the progress file is corrected to match.
- **`missing_declared_units` is not `none`:** seed each with `set_unit_status { s: "pending" }` before delegating. They are spec scope the ledger does not track yet.
- **The current unit is `ip`:** treat it as not started. Re-read the files, rebuild the brief, respawn the worker. The previous worker's partial edit is not trusted; the repository-state guard in validation will catch anything it left behind.
- **`blocked_on` is set:** read that unit's rejections with `read_ledger({ phase, unit_id })` before writing a fix brief.
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
