---
name: foreman:implementor
version: 0.0.3-1
description: Pit-boss implementation orchestrator. Opus orchestrates disposable Sonnet workers, validates against spec. Third stage of the Foreman pipeline.
disableSlashCommand: true
---

Note: This skill is delivered by the Foreman MCP bundle. To customize it,
create a local override at .claude/skills/foreman-implementor/SKILL.md

If you are running as a slash command (not via SkillTool), STOP.
Tell the user: "The Foreman implementor must be invoked via SkillTool,
not as a slash command. Use: 'run the foreman:implementor skill' instead
of '/foreman-implementor'."

CRITICAL: Never write to Docs/.foreman-ledger.json using FileWriteTool or Edit.
All ledger mutations MUST go through mcp__foreman__write_ledger.
Direct file writes to the ledger will be rejected by the Foreman review gate.

## Model Check (MANDATORY)
- If running as Sonnet or Haiku: STOP. Tell user: "Foreman implementor requires Opus. Switch with `/model opus`."
- If running as Opus: Proceed.

## Core Rules

| Rule | Why |
|------|-----|
| Pit-boss NEVER writes implementation code | Separation of concerns |
| Workers NEVER see full spec, ledger, or progress | Information isolation |
| Workers are disposable — killed after each unit | Prevents hallucination accumulation |
| Fresh worker for fixes after rejection | Sunk-cost bias in original worker |
| Ledger is durable — persisted after every verdict | State survives sessions |
| Mandatory new session at phase checkpoints | Context accumulation degrades quality |

## Session Start Protocol

On every session start:

1. `mcp__foreman__bundle_status` — verify version, log warnings
2. `mcp__foreman__read_ledger` with query "full" — get current state
3. `mcp__foreman__read_progress` — truncated view
4. Find handoff.md in `Docs/` or `docs/`
5. Answer the five questions:

| Question | Source |
|----------|--------|
| Where am I? | Ledger current phase/unit status |
| Where am I going? | Progress checklist |
| What is the goal? | spec.md Intent |
| What has been tried? | Ledger unit history |
| What failed? | Ledger rejection history |

6. Do NOT rely on host plan/task state — ledger is the single authority

**Resume handling:**

| Input | Action |
|-------|--------|
| "resume" | Trust ledger position; pick up at first non-passing unit |
| "phase N" | Verify all units in phases before N show pass verdicts; then proceed |
| Path to handoff | Use that file as handoff; cross-reference with ledger for position |
| Empty (no args) | Auto-detect: read ledger for current phase, find first pending unit |

**Mid-flight handling:** If ledger shows a unit as `ip` (in-progress) at session start, treat it as not started — re-read the files, re-build the brief, re-spawn the worker. Do not assume the prior worker's changes are correct.

## Per-Unit Workflow

### Step 1: Read Unit Spec
Read the unit directive from handoff.md. Extract: files to touch, expected behavior, test command, scope boundaries.

### Step 2: Decide Batching

| Pattern | Batching | Why |
|---------|----------|-----|
| Same mechanical change across N files | 1 worker | Same pattern |
| N files with unique logic | 1 worker per file | Each needs own brief |
| N files with 2 patterns | 2 workers | Groups reduce count |
| 1 complex file | 1 worker | Focused attention |

### Step 3: Read Source Files
Before building brief, read actual source. Capture:
- BEFORE state: exact function body, class definition, or file content the worker will modify
- Import block: all current imports so the worker doesn't duplicate or break them
- Exported symbols: names, signatures, and types that other units depend on
- Test file structure: how tests are organized so worker places new tests correctly

Do NOT rely on memory or prior reads from earlier in the session. Always re-read to get the current state.

### Step 4: Build Worker Brief

```
# Worker Brief — Unit [ID]
## Task — [directive from handoff, verbatim or paraphrased]
## Files — CREATE/MODIFY list with paths
## BEFORE/AFTER Pattern — excerpts from actual code showing expected delta
## Interface Context — relevant exports from ledger, signatures worker must satisfy
## DO NOT — explicit scope boundaries, files to leave alone
## Test Command — exact command to run
## Inner Loop Rules — compile/import/type errors: self-fix max 2. Logic/spec issues: return immediately.
```

### Step 5: Spawn Sonnet Worker
Use Agent tool with `model: "sonnet"`. Pass only the worker brief — no spec, no ledger, no progress file.

Worker isolation rules:
- Worker sees ONLY: its brief, the BEFORE/AFTER excerpts you include, and its own tool calls
- Worker MUST NOT be given the handoff.md path to read directly
- Worker MUST NOT be given access to the ledger or progress file
- If worker needs additional context, pit-boss reads the file and pastes the relevant excerpt into a follow-up message

### Step 6: Validate
After worker returns, pit-boss validates independently — do not trust worker's self-report:

1. **Read every modified file** — confirm changes match the AFTER pattern from the brief
2. **Re-run tests** — execute the test command yourself; do not accept worker's "tests pass" claim
3. **Spec check** — read the original spec directive sentence by sentence; confirm each has a corresponding code path
4. **Export check** — verify exported names and signatures match what the ledger records as interface contracts
5. **Consistency check** — confirm changes integrate cleanly with prior accepted units; no regressions introduced

### Step 7: Verdict

**ACCEPT:**
```
mcp__foreman__write_ledger({ operation: "set_unit_status", phase, unit_id, data: { s: "ip" } })   // when starting
mcp__foreman__write_ledger({ operation: "set_verdict", phase, unit_id, data: { v: "pass" } })     // when accepted
mcp__foreman__write_progress({ operation: "complete_unit", data: { unit_id, phase, completed_at, notes } })
```

**REJECT — enter fix protocol:**
```
mcp__foreman__write_ledger({ operation: "add_rejection", phase, unit_id, data: { r: "reviewer", msg: "reason", ts: "timestamp" } })
mcp__foreman__write_progress({ operation: "log_error", data: { date, unit, what_failed, next_approach } })
```

## Two-Tier Fix Protocol

### Inner Loop (same worker)
- Compile / import / type errors → worker self-fixes, max 2 attempts
- Logic or spec errors → return to pit-boss immediately
- Inner loop attempts do NOT count toward outer fix limit

### Outer Loop (fresh worker, max 3 attempts)

Fix brief template:
```
# Fix Brief — Unit [ID], Attempt [N of 3]
## What Was Wrong — file:line reference + specific problem description
## What the Spec Says — exact quoted text from spec
## Files to Fix — path + specific change required
## Files to Leave Alone — explicit list
## Previous Attempts — pulled from ledger rejection history
## Test Command — exact command
## Inner Loop Rules — compile fixes OK (max 2), spec issues return immediately
```

After 3 outer-loop failures: STOP. Escalate to user with full rejection history from ledger.

## Self-Review Gates G1–G5

**Anti-rationalization list — none of these justify skipping a gate:**
- "The diff looks clean so logic must be correct" — trace against spec
- "Worker's tests pass so implementation is correct" — verify independently
- "Already validated this pattern in prior unit" — read actual files
- "Mechanical change, no need to check" — check anyway
- "Worker said it handled the edge case" — read the code
- "Checking all four gates would take too long" — run them

**Gate 1 — Contract Completeness:** Every return type field is populated by this function (not deferred to caller). Tests assert field values, not just shapes or non-nil.

**Gate 2 — Assertion Integrity:** No `or True`, no bare except, no skipped assertion without documented reason. Flaky assertions must be fixed, not weakened.

**Gate 3 — Spec Fidelity:** Every sentence in the spec directive has a corresponding code path. Parameter names, field names, and semantics match spec literally — not paraphrased.

**Gate 4 — Test-Suite Impact:** Grep the full test suite for changed function/class/constant names. Update any old assertions that reference prior behavior.

**Gate 5 — Worker Hygiene:** Language-agnostic checks on every file the worker touched. These catch the class of issues that pass tests but degrade code quality.

Run these checks by reading every modified file:

| Check | What to look for | Why |
|-------|-----------------|-----|
| **Dead imports** | Every import/using/require is referenced in the file body. Grep the file for each imported symbol. | Unused imports pass tests but fail linters and signal sloppy generation. Go catches this at compile time; most languages don't. |
| **Test determinism** | No test relies on wall-clock time, locale, timezone, OS-specific ordering, or execution timing. Dates must be pinned to UTC (not local time). Random seeds must be fixed. Dict/map iteration must not assume order. | Flaky tests are worse than missing tests — they erode trust in the suite. |
| **Assertion completeness** | Every test that verifies "X doesn't throw/fail" ALSO verifies the expected side effect occurred. Catching an error without asserting what happened is a no-op test. | A test that only checks "no crash" proves nothing about correctness. |
| **Module resolution** | Import paths match the project's module system. If ESM: extensions present. If CJS: no extensions. If Go: correct module path. If Python: relative vs absolute matches project convention. Read the project config (tsconfig, go.mod, pyproject.toml) to determine which system is in use. | Wrong resolution works in test runners but fails in production or stricter runtimes. |
| **Fragile timing** | No test depends on microtask ordering, goroutine scheduling, thread interleaving, or sleep durations to be correct. If a test needs async work to settle, it must use the language's deterministic mechanism (fake timers, channels, waitgroups, asyncio event loop advance) — not `sleep` or `Promise.resolve()`. | Timing-dependent tests are the #1 source of CI flakes across all languages. |

**How to run Gate 5:** For each file the worker modified, open it and scan for the five patterns above. This is a read-only scan — no tools needed beyond Read. If any check fails, reject the unit with the specific file:line and pattern name.

**How to run all gates:** list all functions touched → apply G1 → grep for G2 patterns → read each spec sentence → G3 match → grep G4 symbols → scan modified files for G5 patterns. Do NOT mark CHECKPOINT REACHED until all five pass.

## Checkpoint Protocol

At phase end, after all five gates pass:

### 1. Full Test Suite
Run the complete test suite — not just this phase's tests.

### 2. Review via Deliberation
1. `mcp__foreman__capability_check({ cli: "codex" })` + `mcp__foreman__capability_check({ cli: "gemini" })`
2. Map to tier:

| Codex | Gemini | Advisor A | Advisor B | Moderator |
|-------|--------|-----------|-----------|-----------|
| ✓ | ✓ | Codex CLI | Gemini CLI | Opus (you) |
| ✓ | ✗ | Codex CLI | Opus agent | Opus (you) |
| ✗ | ✓ | Gemini CLI | Opus agent | Opus (you) |
| ✗ | ✗ | Opus agent | Opus agent | Opus (you) |

3. Ask each advisor: "Review these phase changes against the spec. List any: (a) spec directives not implemented, (b) implementations that contradict the spec, (c) missing error handling, (d) test gaps. Be specific — file:line references required."
4. `mcp__foreman__normalize_review` — parse review output into structured findings
5. Classify each finding: CONFIRMED / REJECTED / UNVERIFIED
6. If no CLIs available: ask user "Independent review unavailable. Proceed with pit-boss gates only? [y/N]"

### 3. Persist State
```
mcp__foreman__write_ledger({ operation: "update_phase_gate", phase, data: { g: "pass" } })
mcp__foreman__write_progress({ operation: "complete_unit", data: { ... } })
```
Include: unit verdicts, gate results, review findings with classifications, deferred concerns.

### 4. Deliberation Summary
Present to user: what was built, worker stats, gate results, review findings, test results.

### 5. Mandatory New Session
> "Phase [N] complete. New session required. All state persisted to ledger + progress."

Default: new session. User can override with `--force-continue`. Verify writes before ending.

## Agent Delegation

Use a `code-searcher` sub-agent (Agent tool, no model override needed) for search-heavy tasks:
- Gate 4: grep the full test suite for changed function/class/constant names
- Gate 3: search for data flow patterns across multiple files
- Session start: locate plan docs, handoff.md, and scan project structure
- Any task requiring searching more than 3 files for a pattern

Do NOT spawn a sub-agent for tasks you can do in one or two reads. Sub-agents cost context — use them where grep scope is large.

## Error Handling

### Scenario Table

| Scenario | Behavior |
|----------|----------|
| Worker timeout/crash | Log in ledger, spawn new worker |
| Worker code doesn't compile | Worker inner loop. Still failing → pit-boss fix worker |
| Tests fail after worker | Inner loop for mechanical. Spec failures → pit-boss rejects |
| 3 fix attempts exhausted | Escalate to user with ledger history |
| CLI unavailable for review | Ask user for explicit waiver |
| Spec ambiguity discovered | STOP, ask user. Do not guess. |
| MCP tool call fails | Retry once. If persistent, log error and continue with degraded state |

### Recovery Table

| Attempt | Action |
|---------|--------|
| 1 | Diagnose root cause, targeted fix |
| 2 | Different approach entirely |
| 3 | Check docs/examples for correct pattern |
| 4+ | STOP — escalate to user |

## Common Implementation Traps

| Trap | Example | Prevention |
|------|---------|------------|
| "Caller fills it in" | Returning struct with placeholder fields | G1: function populates its own return |
| Safety-valve assertions | `assert X or True` | G2: fix flakiness, don't weaken |
| Mental paraphrase | Spec says "all", worker thinks "relevant" | G3: read spec literally |
| Tests that confirm impl | Tests mirror worker's mental model | G1: test values, not shapes |
| Scope creep in workers | Worker adds "helpful" extras | Spec check: ONLY the directive |
| Trusting worker summary | "Worker said tests pass" | Step 6: re-run tests yourself |
| Skipping export check | New name doesn't match ledger contract | Step 6: verify against ledger exports |
| Re-using stale context | Reading file from earlier in session | Step 3: always re-read before brief |
