# Foreman MCP v0.0.2.1 — Re-Test Plan

## Goal

Validate that v0.0.2.1 fixes resolve the issues found in the v0.0.2 AB test. Only the MCP arm is re-run — the Native arm (Arm A) is unchanged and serves as the baseline.

## What Changed in v0.0.2.1

| Change | Why | What to Verify |
|--------|-----|----------------|
| Tool descriptions document operations | DX — callers couldn't discover valid operations | No validation errors on first `write_ledger`/`write_progress` call |
| Gate 5: Worker Hygiene (5 checks) | AB test found 5 issues uncaught by G1–G4 | Pit-boss rejects or fixes issues before accepting units |
| Server version corrected | Mismatch between package.json and hardcoded | `bundle_status` returns `0.0.2.1` |
| Changelog backfilled | Missing 0.0.2 entry | `changelog` tool returns all 3 versions |

## Test App

Same CLI Pomodoro Timer as v0.0.2 AB test. Same prompt, same scoping answers.

## Pre-flight

1. Build foreman-mcp: `cd foreman-mcp && npm run build`
2. Restart Claude Code to pick up new MCP server
3. Verify: `mcp__foreman__bundle_status` returns `0.0.2.1`
4. Verify: `mcp__foreman__changelog` shows 0.0.1, 0.0.2, and 0.0.2.1 entries
5. Create fresh working directory: `~/Coding_Workspace/ab-test/mcp/`
6. Initialize git: `cd ~/Coding_Workspace/ab-test/mcp && git init`

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
4. Use identical scoping answers:

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

5. Approve design summary

### Stage 2: Spec (foreman:spec-generator)

1. Say: "invoke foreman:spec-generator"
2. Review spec — check that all 4 documents are generated
3. **Verify:** No validation errors when spec-generator seeds the ledger
4. Record: did `write_ledger`/`write_progress` succeed on first call? (v0.0.2.1 fix)

### Stage 3: Implement (foreman:implementor)

1. Say: "invoke foreman:implementor"
2. Let implementation run to completion
3. **Key observation:** Does Gate 5 fire during self-review?
4. Record per-unit: did pit-boss catch any Gate 5 issues?

## Success Criteria

### v0.0.2.1 passes if:

- [ ] `bundle_status` returns `0.0.2.1`
- [ ] `changelog` returns all 3 version entries
- [ ] No `write_ledger`/`write_progress` validation errors (tool descriptions worked)
- [ ] Spec-generator seeds ledger + progress successfully on first attempt
- [ ] Implementor reads ledger/progress and resumes correctly
- [ ] Gate 5 is applied at each phase checkpoint
- [ ] Final app works: `pomo start`, `pomo status`, `pomo log`
- [ ] Test suite passes
- [ ] No regressions vs Arm A (Native) baseline

### Gate 5 specifically passes if:

- [ ] No unused imports in any source file
- [ ] All test dates use UTC (explicit timezone, no local-time ambiguity)
- [ ] All "doesn't throw" tests also assert the expected side effect
- [ ] All import paths match the project's module resolution (`.js` for ESM)
- [ ] No fragile timing patterns (no bare `Promise.resolve()`, no `sleep`, no scheduling assumptions)

### Comparison against v0.0.2 AB test:

| v0.0.2 Issue | Expected in v0.0.2.1 |
|--------------|---------------------|
| `write_progress` failed with "init" operation | No validation error — operations documented in description |
| Unused `TimerState` import (found in Native) | Gate 5 catches "dead imports" if worker produces this |
| Timezone-dependent test date (found in Native) | Gate 5 catches "test determinism" |
| `await Promise.resolve()` flush (found in Native) | Gate 5 catches "fragile timing" |
| Missing `.js` extension (found in MCP) | Gate 5 catches "module resolution" |
| No `console.error` assertion (found in MCP) | Gate 5 catches "assertion completeness" |

### Red flags (abort and investigate):

- Gate 5 not mentioned in pit-boss self-review output
- Skill content truncated or missing Gate 5 section
- MCP tool calls fail with new error types
- Quality regression vs v0.0.2 (fewer tests, worse coverage)

## Post-Test

Compare results against `Docs/v0.0.2/ab-test-results.md`:

```markdown
## v0.0.2.1 Re-Test Results

### Metrics
| Metric | v0.0.2 MCP | v0.0.2.1 MCP | Delta |
|--------|-----------|-------------|-------|
| Tests | 40 | | |
| Workers | 6 | | |
| Rejections | 0 | | |
| MCP tool failures | 1 (validation) | | |
| Gate 5 findings | N/A | | |
| Gate 5 fixes applied | N/A | | |

### Gate 5 Observations
[Did Gate 5 catch anything? What was fixed before acceptance?]

### Tool Description DX
[Did the caller discover operations without hitting validation errors?]

### Verdict
[Confirmed fix / Partial fix / No improvement]
```
