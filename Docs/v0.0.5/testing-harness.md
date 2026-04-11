# v0.0.5 Testing Harness — Bounded Test Output

## Archetype

**Real child_process spawns** — same pattern as existing `externalCli.test.ts`. No mocks. Tests spawn real Node.js processes that produce known output, then verify the harness captures and truncates correctly.

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

### Tier 1: Unit Tests (real process spawns)

**What it tests:** Individual function behavior — truncation, timeout, exit code capture.

**New test file: `foreman-mcp/tests/runTests.test.ts`**

| Test | Input | Expected |
|------|-------|----------|
| Normal pass | `node -e "process.exit(0)"` | `passed: true`, `exit_code: 0`, `timed_out: false` |
| Normal fail | `node -e "process.exit(1)"` | `passed: false`, `exit_code: 1` |
| Specific exit code | `node -e "process.exit(42)"` | `exit_code: 42`, `passed: false` |
| stdout truncation | Write 20000 chars to stdout, max_output_chars=100 | Output contains `...(truncated)`, `truncated: true`, tail preserved |
| stderr truncation | Write 20000 chars to stderr, max_output_chars=100 | STDERR section contains `...(truncated)`, `truncated: true` |
| Tail preservation | Write `"A".repeat(20000) + "MARKER"`, max_output_chars=200 | Output ends with `MARKER` |
| No truncation when under limit | Write 50 chars, max_output_chars=8000 | `truncated: false`, full output present |
| Timeout | `setTimeout(() => {}, 60000)`, timeout_ms=500 | `timed_out: true`, `exit_code: -1`, `passed: false` |
| Custom timeout | timeout_ms=200 | Triggers faster than default |
| Shell interpretation | `echo hello && echo world` | stdout contains both `hello` and `world` |
| Pipes work | `echo foobar \| grep foo` | stdout contains `foobar` |
| TOON format | Any command | Output has `exit_code:`, `passed:`, `timed_out:`, `truncated:`, `STDOUT`, `STDERR` sections |

**Existing test file: `foreman-mcp/tests/externalCli.test.ts`**

Add to existing describe block:

| Test | Input | Expected |
|------|-------|----------|
| Large stdout is truncated | Write >16000 chars | `truncated: true`, output length capped near MAX_OUTPUT |
| Large stderr is truncated | Write >16000 chars to stderr | `truncated: true` |
| Small output is not truncated | Write 100 chars | `truncated: false` |
| Truncation preserves tail | Write known marker at end of large output | Marker present in result |
| Existing tests still pass | All 6 existing tests | No regressions |

**Existing test file: `foreman-mcp/tests/tools.test.ts`**

Update:

| Test | Change |
|------|--------|
| bundleStatus version check | Assert `"0.0.5"` instead of `"0.0.4"` |

### Tier 2: Integration (existing)

No new integration tests needed. The existing `integration.test.ts` covers MCP server creation and tool registration. Adding `run_tests` to the server will be covered by existing registration patterns.

## Quick Reference

| Action | Command |
|--------|---------|
| Run all tests | `cd foreman-mcp && npx vitest run` |
| Run runTests tests | `cd foreman-mcp && npx vitest run tests/runTests.test.ts` |
| Run externalCli tests | `cd foreman-mcp && npx vitest run tests/externalCli.test.ts` |
| Run tool tests | `cd foreman-mcp && npx vitest run tests/tools.test.ts` |
| Build | `cd foreman-mcp && npm run build` |
