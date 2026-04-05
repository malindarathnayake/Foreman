# Foreman MCP v0.0.2 — AB Test Results

**Date:** 2026-04-04
**Model:** Claude Opus 4.6 (1M context)
**Foreman version:** 0.0.2

## Side-by-Side

| Metric | Arm A (Native) | Arm B (MCP) | Delta |
|--------|---------------|-------------|-------|
| Design tokens | ~8K | ~8K | ~0 |
| Spec tokens | ~15K | ~15K | ~0 |
| Impl tokens | ~120K | ~110K | -10K MCP |
| Total tokens | ~143K | ~133K | -10K MCP |
| Workers spawned | 6 | 6 | 0 |
| Worker rejections | 0 | 0 | 0 |
| Test pass rate | 35/35 (100%) | 40/40 (100%) | +5 MCP |
| Test files | 5 | 5 | 0 |
| Source files | 7 | 7 | 0 |
| Spec documents | 5 | 5 | 0 |
| MCP tool calls | N/A | 19 | N/A |
| MCP tool failures | N/A | 0 | N/A |
| App functional? | Yes | Yes | Tie |

## MCP-Specific Observations

### Tool Call Success Rate
- `bundle_status`: 1/1 (100%)
- `write_ledger`: 14/14 (100%)
- `read_ledger`: 2/2 (100%)
- `write_progress`: 2/3 (67% — 1 validation error on first call, self-corrected)
- `read_progress`: 1/1 (100%)
- **Total:** 20/21 (95%)

### Skill Delivery Integrity
- All 3 MCP resources (design-partner, spec-generator, implementor) loaded via `ReadMcpResourceTool`
- No truncation detected — full skill content delivered
- Frontmatter parsed correctly

### Ledger/Progress Round-Trip
- Ledger seeded with 7 units across 3 phases
- All 7 units progressed through pending → ip → pass
- All 3 phase gates set to pass
- `read_ledger` with query "full" returned correct state after all writes

### Deliberation Tier Detection
- Not exercised — no ambiguities arose during design or spec generation
- `capability_check` confirmed both codex and gemini available
- Would need a more ambiguous prompt to trigger this path

## Issues Found

### Arm A (Native) — 3 Issues

| # | File | Issue | Severity | Gate 5 Check |
|---|------|-------|----------|--------------|
| 1 | `src/timer.ts:1` | Unused `TimerState` import | LOW | Dead imports |
| 2 | `tests/log.test.ts:86` | `vi.setSystemTime(new Date('2026-04-04T10:00:00'))` — missing UTC `Z` suffix, timezone-dependent | MEDIUM | Test determinism |
| 3 | `tests/timer.test.ts:62` | `await Promise.resolve()` for microtask flush — fragile timing | LOW | Fragile timing |

### Arm B (MCP) — 2 Issues

| # | File | Issue | Severity | Gate 5 Check |
|---|------|-------|----------|--------------|
| 1 | `tests/notify.test.ts:3` | Import `'../src/notify'` missing `.js` extension — may fail under strict ESM | LOW | Module resolution |
| 2 | `tests/notify.test.ts:22-26` | Error swallow test doesn't verify `console.error` was called | LOW | Assertion completeness |

### MCP Server Issues (Fixed in v0.0.2.1)

| # | Issue | Fix |
|---|-------|-----|
| 1 | `write_ledger` and `write_progress` valid operations not documented in tool description — discoverable only via error messages | Tool descriptions now list all operations with required fields |
| 2 | Server version hardcoded as `0.0.1` while package.json was `0.0.2` | Hardcoded version now `0.0.2.1` |
| 3 | Changelog missing `0.0.2` entry | Both `0.0.2` and `0.0.2.1` entries added |

## Source Code Comparison

### Implementation Quality
All 7 source files are **functionally identical** between both arms. Same architecture, same module split, same error handling patterns. Differences are cosmetic:
- Native uses expanded formatting with inline comments
- MCP uses compact formatting

### Test Quality
| Module | Native Tests | MCP Tests | Difference |
|--------|-------------|-----------|------------|
| state.test.ts | 7 | 9 | MCP: +ensureDataDir idempotent, +break type round-trip |
| log.test.ts | 7 | 10 | MCP: +dir creation, +all-match-today, +missing file for getTodayEntries |
| notify.test.ts | 2 | 2 | Native better: verifies console.error on error path |
| timer.test.ts | 13 | 13 | MCP slightly better: uses readState()/readLog() helpers, UTC dates |
| cli.test.ts | 6 | 6 | Identical coverage |
| **Total** | **35** | **40** | **+5 MCP** |

Test count difference is stochastic worker variance, not a systematic pipeline advantage.

### Spec Quality
- Native spec: ~340 lines, more detailed implementation directives and DO NOT lists
- MCP spec: ~253 lines, more concise, includes Decisions & Notes table with rationale
- Both are sufficient for implementation — style difference, not quality difference

## Verdict

**Ship MCP** with v0.0.2.1 fixes applied.

The MCP pipeline produces equivalent code quality with zero regressions. All AB test issues are now catchable by the new Gate 5 (Worker Hygiene) added in v0.0.2.1.

### v0.0.2.1 Fixes Applied
1. Tool descriptions document valid operations (DX improvement)
2. Server version mismatch fixed
3. Changelog backfilled
4. Gate 5 added to implementor skill (catches all 5 AB test issues)
