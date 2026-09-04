---
id: start-a-project
title: First project
sidebar_label: First project
description: What you type, what tool calls appear, and what files exist after each session of a new feature.
---

# First project

A new feature takes three sessions: design, spec, implementation. One protocol per session. The tool calls and file names below are what the code produces; the values inside them are illustrative.

## Session 1: design

Start your host in the repo and paste:

```text
Use the Foreman MCP server. Call session_orient first. Then call design_partner with
this context: "Design <feature>. Inspect the current repository and do not implement
it yet."
```

The host calls `session_orient`. On a fresh repo it returns:

```text
status: no_phases_yet
action: plan_project
resume_target: null
...
```

Then it calls `design_partner`, which returns the design procedure. The model asks 5 to 8 scoping questions and stops. Answer them. It may push back on an answer and ask again. When the blocking questions are settled it writes `Docs/design-summary.md` and asks you to approve it. Read that file; it is the input to everything after. Approve it in the chat.

Files after session 1: `Docs/design-summary.md`.

## Session 2: spec

New session. Paste:

```text
Use the Foreman MCP server. Call session_orient, then spec_generator with this
context: "Generate the implementation documents from Docs/design-summary.md."
```

The model writes four files and seeds the ledger. You will see these calls, one per phase and unit:

```text
mcp__foreman__write_ledger   declare_phase_units  p1  { units: ["u1", "u2", "u3"] }
mcp__foreman__write_ledger   set_unit_status      p1/u1 { s: "pending" }
mcp__foreman__write_progress start_phase          p1
mcp__foreman__write_progress update_status        p1/u1 pending
mcp__foreman__write_journal  end_session
```

It ends with a message naming the four documents and telling you to call `pitboss_implementor` next. If it lists open ambiguities instead, it has refused to hand off; resolve them and rerun.

Files after session 2:

```text
Docs/spec.md               phases, units, one directive per unit, error-handling table, test commands
Docs/handoff.md            session-start steps, unit order, recovery notes, state_tracking_policy
Docs/PROGRESS.md           an empty fenced block Foreman fills from the ledger, plus your Unit Plan table
Docs/testing-harness.md    test tiers and the commands for each
Docs/.foreman-ledger.json  every phase and unit, status pending
Docs/.foreman-progress.json
Docs/.foreman-journal.json
```

## Session 3 and on: implement

New session. Paste:

```text
Use the Foreman MCP server. Call session_orient, then pitboss_implementor with this
context: "Implement the approved spec one unit at a time. Resume from Foreman state."
```

`session_orient` now answers `action: implement_unit` and `resume_target: p1/u1`. The model probes reviewer CLIs once (`capability_check`), records the session (`write_journal init_session`), and works the unit. For one unit you will see:

```text
mcp__foreman__write_ledger  set_unit_status p1/u1 { s: "ip" }
                            (model reads the directive in spec.md and the source files it names)
mcp__foreman__write_ledger  set_unit_status p1/u1 { s: "delegated", brief: "...", tier: "standard",
                                                   preflight: { symbols_grepped: 4, self_consistent: true, telemetry: "n/a" } }
Agent                       worker subagent implements the brief, returns a completion report
                            (model reads every changed file)
mcp__foreman__run_tests     { runner: "npm", args: ["test", "--", "u1"] }
mcp__foreman__write_ledger  set_verdict p1/u1 { v: "pass" }
mcp__foreman__write_progress complete_unit p1/u1
```

If the model rejects the worker's output you see `add_rejection` instead of `set_verdict`, then a second `delegated` write with a fix brief and a fresh worker. After three rejected attempts the next `delegated` write is refused with `DELEGATION CAP` until you tell the model to set `user_override: true`.

When every unit in the phase has passed, the model runs the full test suite, sends the phase to the reviewers, and records what they found:

```text
mcp__foreman__invoke_advisor  { cli: "codex", prompt: "Review these phase changes against the spec..." }
mcp__foreman__invoke_advisor  { cli: "gemini", ... }
mcp__foreman__normalize_review
mcp__foreman__write_ledger    record_review p1 { advisor: "codex", stage: "independent", completion: "complete", checked: [...], findings: [...] }
mcp__foreman__write_ledger    update_phase_gate p1 { g: "pass" }
mcp__foreman__write_journal   end_session
```

If a reviewer finding was classified `confirmed`, the gate write is refused with `CONFIRMED FINDINGS` and the model goes back to the affected unit: rejection, fix, re-verdict, fresh review, then the gate.

The session ends with: `Phase 1 complete. New session required. All state persisted to ledger + progress.` Start a new session and paste the session-3 prompt again. `session_orient` picks up at `p2/u1`.

## If you need to stop mid-unit

Stop. The next session's `session_orient` reports the unit as in progress, and the procedure restarts it: the model re-reads the files, rebuilds the brief, and respawns the worker. It does not resume the previous worker's half-finished edit. See [Resuming a session](../how-it-works/resuming.md).
