# v0.0.6 Testing Harness — Security Hardening Pass

## Archetype

**Real child_process spawns + real file I/O** — same pattern as existing test suite. No mocks. Tests spawn real processes, write real files, verify real behavior.

## Operator Questions

| Question | Answer |
|----------|--------|
| Test framework? | Vitest 3.2 (`npx vitest run`) |
| Test location? | `foreman-mcp/tests/` |
| Naming convention? | `<module>.test.ts` |
| Import style? | `import { fn } from '../src/lib/module.js'` (ESM, .js extension) |
| Fixtures needed? | No — inline Node.js scripts via `node -e "..."` |
| CI command? | `cd foreman-mcp && npx vitest run` |

## Test Tiers

### Tier 1: Schema Validation Tests

**Existing file: `foreman-mcp/tests/writeTools.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| NormalizeReviewInputSchema rejects long reviewer | `reviewer: "x".repeat(201)` | Zod throws |
| NormalizeReviewInputSchema rejects long raw_text | `raw_text: "x".repeat(50001)` | Zod throws |
| NormalizeReviewInputSchema accepts valid input | `reviewer: "codex", raw_text: "HIGH: bug"` | Parses OK |

### Tier 2: FIFO Cap Tests

**Existing file: `foreman-mcp/tests/progress.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| error_log FIFO cap on disk | Write 25 log_error ops, read file | `error_log.length === 20`, first entry is #6 (0-indexed: 5) |
| error_log under cap preserved | Write 5 log_error ops, read file | `error_log.length === 5`, all preserved |
| Existing display truncation still works | 10 error entries, truncateProgress | `errors.length === 5` (unchanged) |

### Tier 3: Path Validation Tests

**Existing file: `foreman-mcp/tests/tools.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| capabilityCheck resolves absolute path | Call with "codex" or "gemini" | Result contains `available:` in TOON format |
| Existing capabilityCheck tests still pass | No change | No regressions |

Note: Testing non-absolute `which` output directly is hard without mocking `which`. The isAbsolute check is defense-in-depth. Verify by reading the code — the check is between `which` resolution and cache storage.

### Tier 4: runTests Hardening Tests

**Existing file: `foreman-mcp/tests/runTests.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| Hard memory cap kills process | `node -e` writing `5 * maxOutputChars` chars, maxOutputChars=1000 | `truncated: true`, `exit_code: -1`, output present but capped |
| Runner resolved via which | `runTests('node', ['-e', 'process.exit(0)'])` with FOREMAN_TEST_ALLOWLIST=node | `passed: true` (node resolves) |
| Unresolvable runner returns error | `runTests('nonexistent_runner_xyz', [])` with FOREMAN_TEST_ALLOWLIST=nonexistent_runner_xyz | Contains `"error: runner not found"` |
| Existing tests still pass | All 13 existing tests | No regressions |

### Tier 5: Journal Tests

**New file: `foreman-mcp/tests/journal.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| initSession creates file + env | Call with env data | File exists, 1 session, `env.os` auto-filled |
| logEvent appends | Log 3 events | `sessions[0].events.length === 3` |
| logEvent validates code | `{ t: "INVALID" }` | Zod throws |
| endSession fills summary | Call with summary data | `sessions[0].summary.friction` is number |
| FIFO cap 50 sessions | Init 55 sessions | `sessions.length === 50`, oldest dropped |
| Event cap 200 | Log 201 events | Error returned on 201st |
| Rollup at 5 sessions | End 5 sessions with friction | `rollup.avg_friction` is number |
| readJournal last_n | 10 sessions, `last_n=3` | 3 sessions returned |
| Env auto-detect | initSession without os/node | `env.os` and `env.node` auto-filled |
| Corrupt JSON recovery | Write garbage, readJournal | Returns fresh, backup created |

### Tier 6: Version + Integration

**Existing files: `tools.test.ts`, `integration.test.ts`**

| Test | Change |
|------|--------|
| bundleStatus version check | Assert `"0.0.6"` instead of `"0.0.5"` |
| integration version check | Assert `"0.0.6"` instead of `"0.0.5"` |
| Tool count | Update to 14 (added write_journal + read_journal) |

## Quick Reference

| Action | Command |
|--------|---------|
| Run all tests | `cd foreman-mcp && npx vitest run` |
| Run schema tests | `cd foreman-mcp && npx vitest run tests/writeTools.test.ts` |
| Run progress tests | `cd foreman-mcp && npx vitest run tests/progress.test.ts` |
| Run tool tests | `cd foreman-mcp && npx vitest run tests/tools.test.ts` |
| Run runTests tests | `cd foreman-mcp && npx vitest run tests/runTests.test.ts` |
| Run journal tests | `cd foreman-mcp && npx vitest run tests/journal.test.ts` |
| Run integration tests | `cd foreman-mcp && npx vitest run tests/integration.test.ts` |
| Build | `cd foreman-mcp && npm run build` |
