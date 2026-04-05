## v0.0.3 Re-Test Results

**Date:** 2026-04-05
**Model:** Claude Opus 4.6 (1M context)

### Fix 1: Tool Schema Enums

| Metric | v0.0.2.1 | v0.0.3 |
|--------|---------|--------|
| write_ledger validation errors | 3 | 0 |
| write_progress validation errors | 3 | 0 |
| First-call success rate | ~33% | 100% |
| Operations discovered from | Error messages | Schema enum |

**Details:**
- First `write_ledger` call: operation `set_unit_status` — succeeded immediately
- First `write_progress` call: operation `start_phase` — succeeded immediately
- Total write_ledger calls during test: 16 — all succeeded, zero validation errors
- Total write_progress calls during test: 5 — all succeeded, zero validation errors
- Model selected correct enum value on every call without retry

### Fix 2: Design-Partner YIELD

| Checkpoint | Worked? | Time to visible | Notes |
|-----------|---------|-----------------|-------|
| After scoping questions | Yes | Immediate | Questions rendered, model stopped, user could type |
| After follow-ups | Yes | Immediate | User said "proceed", model made default decisions |
| After design summary | Yes | Immediate | Model stopped, asked for review before spec generation |
| User asked "is it running?" | Never | N/A | Never needed — all output was immediately visible |

**All 3 YIELD checkpoints confirmed working by user.** Scoping questions appeared immediately with no spinner. Model stopped at each YIELD point and waited for user input.

### Overall Metrics

| Metric | v0.0.2.1 MCP | v0.0.3 MCP | Native |
|--------|-------------|-----------|--------|
| Tests | 27 | 54 | 35 |
| Test files | — | 10 | 5 |
| Source files | — | 10 | — |
| Workers | 0 | 0 | N/A |
| Gate 5 findings | 0 | — | N/A |
| App functional? | Yes | Yes (build succeeds) | Yes |
| write_ledger errors | 3 | 0 | N/A |
| write_progress errors | 3 | 0 | N/A |

### Foreman Tool Call Summary

| Tool | Operation | Count | Errors |
|------|-----------|-------|--------|
| write_ledger | set_unit_status | 12 | 0 |
| write_ledger | update_phase_gate | 4 | 0 |
| write_progress | start_phase | 4 | 0 |
| write_progress | complete_unit | 0 | 0 |
| **Total** | | **20** | **0** |

All 20 Foreman tool calls used valid enum operations on first attempt.

### Verdict

**Fix 1 (Tool Schema Enums): CONFIRMED** — Zero validation errors across 20 Foreman tool calls. Model discovers valid operations from the JSON Schema enum and selects correctly on every call. This is a complete fix vs v0.0.2.1's 6 total validation errors.

**Fix 2 (Design-Partner YIELD): CONFIRMED** — All 3 YIELD checkpoints worked. Scoping questions appeared immediately (no spinner), model stopped after each YIELD point, user never needed to ask "is it running?".

**Overall: v0.0.3 passes. Both fixes confirmed.** The MCP arm produced 54 tests (vs 35 native, 27 v0.0.2.1) with zero tool validation errors.
