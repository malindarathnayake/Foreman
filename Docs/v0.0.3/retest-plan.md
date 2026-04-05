# Foreman MCP v0.0.3 — Re-Test Plan

**Date:** 2026-04-05
**Model:** Claude Opus 4.6 (1M context)

## Goal

Validate that v0.0.3 fixes resolve the two remaining issues from v0.0.2.1:
1. **Tool schema enums** — `write_ledger`/`write_progress` should succeed on first call (no more "guess the operation" failures)
2. **Design-partner YIELD** — scoping questions should appear immediately, not hidden behind a spinner

Only the MCP arm is re-run. The Native arm (`~/Coding_Workspace/ab-test/native/`) is unchanged (35 tests, 5 files) and serves as the baseline.

## What Changed in v0.0.3

| Change | Why | What to Verify |
|--------|-----|----------------|
| `z.string()` → `z.enum([...])` for operation params | Model couldn't discover valid operations from schema | `write_ledger`/`write_progress` succeed on first call — zero validation errors |
| 3 YIELD directives in design-partner.md | Model kept generating after scoping questions — user saw spinner not questions | Questions render immediately, model stops, user can type answers |
| Version bump to 0.0.3 | Release hygiene | `bundle_status` returns `0.0.3`, changelog has 4 entries |
| Skill frontmatter versions synced to 0.0.3 | Were inconsistent (0.0.2, 0.0.2.1) | All 3 skills report `version: 0.0.3` |

## Pre-flight

1. Delete existing MCP arm: `rm -rf ~/Coding_Workspace/ab-test/mcp`
2. Create fresh directory: `mkdir -p ~/Coding_Workspace/ab-test/mcp && cd ~/Coding_Workspace/ab-test/mcp && git init`
3. Verify Foreman MCP is running:
   - `mcp__foreman__bundle_status` returns `bundle_version: 0.0.3`
   - `mcp__foreman__changelog` shows 4 entries: 0.0.1, 0.0.2, 0.0.2.1, 0.0.3
4. Verify tool schema exposes enums:
   - Check that `write_ledger` tool definition shows `"enum": ["set_unit_status", "set_verdict", "add_rejection", "update_phase_gate"]`
   - Check that `write_progress` tool definition shows `"enum": ["update_status", "complete_unit", "log_error", "start_phase"]`

## Execution

### Stage 1: Design (foreman:design-partner)

1. Open fresh Claude Code session in `~/Coding_Workspace/ab-test/mcp/`
2. Paste the prompt:

```
I want to build a CLI pomodoro timer in Node.js (TypeScript).

Features:
- `pomo start` — begins a 25-minute focus session
- `pomo break` — begins a 5-minute break
- `pomo status` — shows current timer state and time remaining
- `pomo log` — shows today's completed sessions

Requirements:
- Timer state persisted to ~/.pomo/state.json so `pomo status` works across invocations
- Session log persisted to ~/.pomo/log.json (date, type, duration, completed)
- Desktop notification via node-notifier when timer completes
- Graceful handling of: timer already running, no active timer, corrupt state file
- Exit code 0 on success, 1 on error

Keep it simple — no config files, no plugins, no web UI.
```

3. Say: "run the foreman:design-partner skill"

**YIELD checkpoint 1 (primary v0.0.3 validation):**
- [ ] Model outputs scoping questions and **stops** — no spinner, no "Worked for Ns"
- [ ] Questions are visible immediately in the terminal
- [ ] Model does NOT proceed to Phase 3 or run background tools
- [ ] Time from skill invocation to visible questions: record in seconds

4. Provide identical scoping answers:

| Question | Answer |
|----------|--------|
| Runtime | One-shot CLI invocations. No daemon. |
| Persistence | JSON files in ~/.pomo/ |
| Notification | node-notifier (cross-platform) |
| Testing | vitest, mock fs and timers |
| Error handling | Return exit code 1, print error to stderr |
| Scope control | No config, no plugins, no web. Just CLI. |
| Timer accuracy | setTimeout-based, ~1 second polling for status display |
| Architecture | Single package, src/ + tests/ + bin/ |

**YIELD checkpoint 2:**
- [ ] If model asks follow-ups: stops after each question, waits for answer
- [ ] If no follow-ups: proceeds directly to design summary

**YIELD checkpoint 3:**
- [ ] Model presents design summary and **stops** for approval
- [ ] Model does NOT proceed to spec generation without explicit approval

5. Approve design summary

### Stage 2: Spec (foreman:spec-generator)

1. Say: "invoke foreman:spec-generator"
2. Review spec — check that all 4 documents are generated (spec.md, handoff.md, PROGRESS.md, testing-harness.md)

**Schema enum validation (primary v0.0.3 validation):**
- [ ] First `write_ledger` call uses a valid operation from the enum — record which operation
- [ ] First `write_ledger` call succeeds — zero validation errors
- [ ] First `write_progress` call uses a valid operation from the enum — record which operation
- [ ] First `write_progress` call succeeds — zero validation errors
- [ ] Total validation errors across all tool calls: record count (target: 0)

### Stage 3: Implement (foreman:implementor)

1. Say: "invoke foreman:implementor"
2. Let implementation run to completion
3. Record: total `write_ledger`/`write_progress` validation errors during implementation (target: 0)
4. Gate 5 applied at phase checkpoints

## Success Criteria

### v0.0.3 passes if:

**Fix 1 — Tool Schema Enums:**
- [ ] Zero `write_ledger` validation errors across all stages (was 3 in v0.0.2.1)
- [ ] Zero `write_progress` validation errors across all stages (was 3 in v0.0.2.1)
- [ ] Model selects correct operation on first attempt every time

**Fix 2 — Design-Partner YIELD:**
- [ ] Scoping questions visible immediately after skill invocation (no spinner)
- [ ] Model stops after outputting questions — does not continue to Phase 3
- [ ] Model stops after design summary — waits for approval
- [ ] At no point does the user need to ask "is it running?"

**Regression checks:**
- [ ] `bundle_status` returns `0.0.3`
- [ ] `changelog` returns 4 version entries
- [ ] Gate 5 applied during implementation review
- [ ] Final app works: `pomo start`, `pomo status`, `pomo log`
- [ ] Test suite passes
- [ ] No regressions vs Native arm baseline (35 tests, 5 files)

### Red flags (abort and investigate):

- Model sees `"type": "string"` instead of enum for operation parameter
- YIELD directive ignored — model generates past scoping questions without stopping
- Skill content missing YIELD sections (truncated during MCP resource delivery)
- MCP tool calls fail with new error types
- Quality regression vs v0.0.2.1 (fewer tests, worse coverage)

## Comparison Matrix

| Metric | v0.0.2 MCP | v0.0.2.1 MCP | v0.0.3 MCP | Native |
|--------|-----------|-------------|-----------|--------|
| Tests | 40 | 27 | | 35 |
| Validation errors | 1 | 3 | target: 0 | N/A |
| Design-partner visible? | N/A | Spinner (38s) | target: immediate | N/A |
| YIELD stops worked | N/A | N/A | target: 3/3 | N/A |
| Gate 5 findings | N/A | 0 (clean) | | N/A |
| App functional? | Yes | Yes | | Yes |

## Post-Test

Record results in `Docs/v0.0.3/retest-results.md`:

```markdown
## v0.0.3 Re-Test Results

### Fix 1: Tool Schema Enums
| Metric | v0.0.2.1 | v0.0.3 | 
|--------|---------|--------|
| write_ledger validation errors | 3 | |
| write_progress validation errors | 3 | |
| First-call success rate | ~33% | |
| Operations discovered from | Error messages | Schema enum |

### Fix 2: Design-Partner YIELD
| Checkpoint | Worked? | Time to visible | Notes |
|-----------|---------|-----------------|-------|
| After scoping questions | | | |
| After follow-ups | | | |
| After design summary | | | |
| User asked "is it running?" | | | Should be: never |

### Overall Metrics
| Metric | v0.0.2.1 MCP | v0.0.3 MCP | Native | 
|--------|-------------|-----------|--------|
| Tests | 27 | | 35 |
| Test files | | | 5 |
| Workers | 0 | | N/A |
| Gate 5 findings | 0 | | N/A |
| App functional? | Yes | | Yes |

### Verdict
[Both fixes confirmed / Partial / No improvement]
```
