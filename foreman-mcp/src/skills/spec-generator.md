---
name: foreman:spec-generator
version: 0.0.5
description: Generate formal implementation documents from a design summary. Produces spec, handoff, progress tracker, and testing harness. Second stage of the Foreman pipeline.
---

{{include: ledger-critical}}

{{include: engineering-ethos}}

{{include: session-start}}

## Core Directive

Transform a design summary into the complete implementation document set. No creativity — this is a translation step. Decisions are already made; format them into documents implementation agents can execute without asking questions.

## Engineering Ethos

The spec must carry the design summary's Performance Budget, Threat Model, and Telemetry Contract through to per-unit directives: every `hot`/`extreme` unit directive includes its perf rationale and budget; telemetry-touching units cite the contract entries they implement; pillar conflicts appear as Decisions rows, never resolved silently. A design summary missing these sections with no declared `standard`-tier rationale is a gap — escalate, don't fill.

{{include: ambiguity-resolution}}

{{include: deliberation-protocol}}

## Agent Delegation

Use `code-searcher` sub-agent for grounding checks:
- G1: version numbers, line numbers, file paths
- G3: all references to shared dependencies
- G5: code around insertion points for control-flow
- G7: test suite grep for changed symbols
- G8: controller/handler response models

Launch multiple agents in parallel for independent checks.

{{include: uncertainty-protocol}}

## Inputs

Needs a design summary with: problem statement, architecture, key decisions, integration points, error handling, scope boundaries, testing archetype.

Sources: `Docs/design-summary.md`, pasted in conversation, or referenced file.

If missing critical sections → list what's missing, don't fill gaps with assumptions.

**Block condition:** If the design summary is absent or lacks a problem statement and architecture, stop immediately:

| Field | Content |
|-------|---------|
| Blocker | Specific missing section(s) |
| What I Need | Exact content required to proceed |
| Next Step | Call `mcp__foreman__design_partner` to produce a complete design summary |

## Procedure

### Step 1: Validate Design Summary

Check completeness across 10 items:

| Item | Required |
|------|----------|
| Problem statement | Clear, 1-3 sentences |
| Architecture | Diagram or plain-text structure |
| Key decisions | Table with rationale |
| Integration points | All external systems with protocols |
| Error handling | Per-scenario behavior |
| Scope boundaries | In scope AND out of scope |
| Testing archetype | Named archetype |
| Config surface | Tunable settings identified |
| Observability | Metrics and logging defined |
| Performance budget | Tier per path; budgets for hot/extreme (or explicit all-standard declaration) |
| Threat model | Threat table with technique IDs (stack profile's threat framework) + detection evidence |
| Telemetry contract | Spans, metrics with bounded tag values, structured-log fields, audit stream |
| Open items | None blocking, or explicitly deferred |

Classify gaps as: missing sections (need design session before proceeding) or ambiguous sections (escalate via deliberation protocol).

### Step 2: Determine Language and File Patterns

Identify: language, config format, test framework, test command, file extension. Read actual project files — do not guess.

### Step 3: Design Implementation Order

Break into phases and units. Rules:
- Each phase independently testable
- Units are 1-3 files
- Dependencies flow forward only
- Start with types/models, build outward
- Each unit has exactly one test command that confirms it works
- Run ambiguity gate here too — flag anything that would require a guess during implementation

**Phase checkpoint format:** After the last unit of each phase, specify a checkpoint command the implementor runs to confirm the entire phase is working before moving forward. The checkpoint must be runnable without future units present.

### Step 4: Generate Four Documents

Write `Docs/spec.md`, `Docs/handoff.md`, `Docs/PROGRESS.md`, `Docs/testing-harness.md`.

## Document Templates

### Document 1: `Docs/spec.md`
- **Intent** — one paragraph, what this builds and why
- **Decisions & Notes** — table: Decision | Choice | Rationale | Source
- **Architecture** — mermaid or text diagram + file structure tree
- **Config Schema** — actual format for the project language (not prose)
- **Integration Discovery Findings** — if discovery was performed, what was found
- **Core Behavior** — numbered happy-path steps, no branching
- **Metrics/Outputs** — table: Metric | Type | Source | Notes
- **Performance Budgets** — table: Path/Unit | Tier | Budget | Justified Costs (hot/extreme only; omit section only if all-standard is declared)
- **Threat Table** — table: Component | Compromise Impact | Technique IDs (stack profile's threat framework) | Controls | Detection Evidence
- **Telemetry Contract** — spans (names, key attrs); metrics (name, type, unit, tag keys + bounded value sets — unbounded values are never metric attributes; move them to span attributes or log fields); structured-log fields per the stack profile's schema; audit stream; sampling policy; transport declared per the stack profile
- **Error Handling** — table: Scenario | Behavior | Recovery
- **Dependencies** — table: Package | Version | Purpose (real versions or UNKNOWN)
- **Out of Scope** — explicit list
- **Testing Strategy** — archetype, what-to-test table, what-NOT-to-test, mock boundaries table, critical path, coverage targets table
- **Implementation Order** — phases with units; each unit has: files, directives, test command, DO NOT items; checkpoints between phases

### Document 2: `Docs/handoff.md`
- **Project Overview** — one paragraph + link to spec.md
- **Before Starting** — session protocol (read spec, read this, read PROGRESS.md)
- **Rules** — implementation rules list (no scope additions, no skipping tests, etc.)
- **Implementation Order** — copy phases/units from spec with additional dependency/pitfall context per unit
- **Testing Strategy** — archetype name + link to testing-harness.md
- **Quick Reference** — checkpoint commands table, error recovery table
- **Start** — first session instructions vs resuming mid-implementation

### Document 3: `Docs/PROGRESS.md`
- **Current Status** — phase, last completed unit, next up, blocked (if any)
- **Ledger Status** — machine-owned: emit exactly `<!-- foreman:checklist-start -->` and `<!-- foreman:checklist-end -->` on their own lines with nothing between; `write_progress` renders the ledger checklist there and replaces the block on every call — never hand-write inside the fences (it does not survive)
- **Unit Plan** — per-phase table: unit id | files | checkpoint command — no checkboxes; the checkbox view is Ledger Status
- **Decisions & Notes** — table: Decision | Value | Source (populated from spec)
- **Session Log** — table: Date | Phase | Unit | Outcome | Notes
- **Error Recovery Log** — table: Date | Error | Fix | Status; plus recovery protocol
- **Context Management** — five questions table an implementor should answer at session start; new-chat policy
- **Environment Notes** — language version, required env vars, setup commands

### Document 4: `Docs/testing-harness.md`
- **Archetype** — named archetype with one-line description
- **Operator Questions** — pre-filled where known, UNKNOWN where not
- **Test Tiers** — unit → mocked integration → real integration → e2e (per-tier: what it tests, how to run, when to run)
- **Archetype-Specific Patterns** — patterns specific to the archetype (e.g. hermetic server for HTTP, table-driven for pure functions)
- **Quick Reference** — run command, seed command, reset command
- **Pre-Implementation Discovery** — if deferred integrations exist, discovery steps before first test can run

## Grounding Checks (Mandatory)

Run AFTER drafting all documents but BEFORE delivering to user.

### G1: Verify facts against live files, not memory
For every version number, line number, file path, or package reference in the spec/handoff:
- **Open the actual file and confirm the value.** Do NOT trust auto-memory, prior conversation context, or your own earlier statements.
- If the spec says "bump version X → Y", read the .csproj / package.json / pyproject.toml and confirm X is the current value.
- If the spec says "line 438", read the file and confirm line 438 contains what you claim.
*Catches: stale memory producing wrong version numbers.*

### G2: Verify file write locations
After writing any document with the Write tool:
- **Glob or ls to confirm the file landed where you expect.** The Write tool's absolute path may resolve differently than the relative path you reference.
- Cross-check the path in every document header, cross-reference link, and "Read the full spec" pointer.
*Catches: files landing in wrong directories.*

### G3: Search for ALL dependents, not just the obvious one
When a spec changes a shared dependency (package version, config key, API contract):
- **Search the entire repo** for all references to that dependency.
- Every match must appear in the file change summary.
*Catches: updating one project's reference but missing another's identical pin.*

### G4: Trace each unit's verification against per-unit state
For every verification step in the handoff:
- **Replay only that unit's changes** and confirm the verification is true at that point.
- Do not reference later units' outcomes.
*Catches: verification steps describing end-state instead of per-unit state.*

### G5: Trace code placement against control flow
When the spec says "add code at line N" or "after X":
- **Read 10 lines above and below.** Confirm new code is reachable — not after return/throw/break.
- For languages with local functions after returns, confirm insertion is in executable body.
*Catches: code placed after return statements.*

### G6: Name concrete test files
Every test instruction must include:
- Exact file path of the test file
- Test helper/factory to use (with import path)
- Test command to run
*Catches: vague "run tests" instructions.*

### G7: Test-suite impact analysis for behavior changes
When a unit changes observable behavior:
- **Grep the entire test suite** for every symbol/rule-ID/field being changed.
- Every existing assertion on OLD behavior must be explicitly accounted for (updated, rewritten, or deleted).
*Catches: new tests added but old tests still assert old behavior.*

### G8: Verification step endpoint confirmation
When a unit includes "check endpoint X for Y":
- **Read the actual response model.** Confirm it includes the needed fields.
- Do NOT write verification steps from memory of the API surface.
*Catches: verification steps pointing to wrong endpoints.*

### G9: Ethos grounding
- Every `hot`/`extreme` unit directive carries a perf rationale sourced from the design summary or a benchmark.
- Every Telemetry Contract entry has a source (design summary, existing code, or explicit new-declaration) and every metric states its tag-value bounds.
- The Threat Table covers every trust boundary named in the design summary; each row's technique names concrete detection evidence from the Telemetry Contract, or explicitly states no in-app detection with a compensating control — never a fabricated telemetry event.
*Catches: hot paths speced without budgets; unbounded metric tags; trust boundaries with no threat row.*

### G10: Directive self-consistency + telemetry names
- Every test expectation in a unit directive (status, value, error, log key) is consistent with that directive's implementation instruction and the error-handling matrix.
- Every telemetry field a directive introduces is labelled core or custom; custom names are checked against the active stack profile's reserved-name rule (`ethos` telemetry section). If the profile resolved by fallback or the transport is unstated, mark it UNKNOWN — never lint against the reference backend by guess.
*Catches: directives that ask for 400 and assert 404; log keys that collide with the backend's reserved fields.*

## Ledger Seeding

First, declare each phase's expected unit set — this is what lets the gate and `session_orient` mechanically catch a unit that was declared in the handoff but never seeded:
```
mcp__foreman__write_ledger({
  operation: "declare_phase_units",
  phase: "<phase-id>",
  data: { units: ["<unit-id>", ...] }
})
```

Then, for each phase and unit in the implementation order:
```
mcp__foreman__write_ledger({
  operation: "set_unit_status",
  phase: "<phase-id>",
  unit_id: "<unit-id>",
  data: { s: "pending" }
})
```

## Progress Seeding

```
mcp__foreman__write_progress({
  operation: "start_phase",
  data: { phase: "<phase-1-id>", name: "<Phase 1 Name>" }
})

For each unit:
mcp__foreman__write_progress({
  operation: "update_status",
  data: { unit_id: "<id>", phase: "<phase-id>", status: "pending", notes: "<description>" }
})
```

## Output + Handoff

`mcp__foreman__write_journal({ operation: "end_session", data: { dur_min: <estimate>, ctx_used_pct: <estimate>, summary: { units_ok: 1, units_rej: 0, w_spawned: 0, w_wasted: 0, tok_wasted: 0, delay_min: 0, blockers: [], friction: <1-100> } } })`

**State tracking (read-only check — never a `.gitignore` edit):** run `git check-ignore -q` on `Docs/.foreman-ledger.json`, `.foreman-progress.json`, `.foreman-journal.json`, `.foreman-events.jsonl` and record the result in handoff.md's Start section as `state_tracking_policy: tracked | local | undecided`. If the handoff tells the implementor to commit Foreman state but the paths are ignored (or the reverse), that is a grounding failure: ask the owner which policy holds. Never create or rewrite `.gitignore` to resolve it.

Save four documents to `Docs/`. Tell the user:

> Four documents generated in `Docs/`. Review `spec.md` first. To start implementation, call `mcp__foreman__pitboss_implementor`.

If blocking open items remain, list them and refuse to hand off.

## Quality Checks

Run before delivering documents to user:

- [ ] Every directive names specific library/function/pattern
- [ ] Every external call in error handling matrix
- [ ] Every config value has a source
- [ ] Every phase has runnable checkpoint command
- [ ] Out of scope explicit and complete
- [ ] Dependency versions real or marked UNKNOWN
- [ ] File structure matches implementation order
- [ ] G1-G10 grounding checks all completed
- [ ] `state_tracking_policy` recorded in handoff.md (check-ignore result, no `.gitignore` written)
- [ ] Ethos sections present (Performance Budgets / Threat Table / Telemetry Contract) or all-standard declared with rationale
- [ ] Declared-unit sets registered for every phase (`declare_phase_units`)
- [ ] Ledger seeding calls issued for all phases and units
- [ ] Progress seeding calls issued for phase 1
- [ ] No ambiguities remain open (all resolved or explicitly deferred with user sign-off)
- [ ] handoff.md first-session instructions are executable without reading anything else first

## What This Skill Does NOT Do
- Design from scratch (decisions must exist in design summary; ambiguities resolved via deliberation)
- Implement code
- Guess at libraries or versions (marks UNKNOWN)
- Add scope beyond design summary
- Write vague directives like "handle the error" or "add appropriate logging"
- Run deliberation when user opts out — present numbered list instead
- Proceed past open blocking ambiguities without user resolution
- Skip G1-G8 grounding checks even when the spec seems obvious
