# v0.0.7 — Implementation Handoff

## Project Overview

Close 5 pentest triage findings. Revised after Architecture Council review (Codex + Gemini).

**Read the full spec:** `Docs/v0.0.7/spec.md`

## Before Starting

1. Read `Docs/v0.0.7/PROGRESS.md` for current state
2. `cd foreman-mcp && npm run build && npm test` — confirm baseline green
3. Resume from next incomplete item

## Rules

1. After each file change, run that file's test command
2. Update `Docs/v0.0.7/PROGRESS.md` after each unit
3. No features beyond the spec — security fix release
4. Start new chat after Phase 1 checkpoint

## Implementation Order

### Phase 1: runTests Hardening

**Unit 1a — runTests.ts** (4 changes)

1. Line 5: Remove `"npx"` from `DEFAULT_ALLOWED_RUNNERS`
2. Line 14: Add deny list + regex filter after `.filter(Boolean)`:
   ```typescript
   .filter(s => /^[a-zA-Z0-9_.-]+$/.test(s))
   .filter(s => s.toLowerCase() !== 'npx')
   ```
3. Line 73: Add `if (settled) return` as first line of stdout data handler
4. Line 91: Add `if (settled) return` as first line of stderr data handler

Test: `npx vitest run tests/runTests.test.ts`

- Pitfall: existing test at line 32 asserts `toContain('npx')` — change to `not.toContain`
- Pitfall: existing test `'custom allowlist via env'` — verify runner names are alphanumeric

**Unit 1b — server.ts** (1 change)

Line 241: Remove `npx` from run_tests description string.

Test: `npx vitest run tests/integration.test.ts`

**CHECKPOINT:** `npx vitest run tests/runTests.test.ts tests/integration.test.ts`
**→ NEW CHAT**

### Phase 2: ComSpec + Advisor Output

**Unit 2a — externalCli.ts** (1 line)

Line 166: Replace `process.env.ComSpec || 'cmd.exe'` with:
```typescript
path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
```

Test: `npx vitest run tests/externalCli.test.ts`

**Unit 2b — invokeAdvisor.ts** (replace formatAdvisorResult)

Lines 44-53: Replace `formatAdvisorResult` with block format:
```typescript
export function formatAdvisorResult(cli: string, result: ExternalCliResult): string {
  const meta = [
    `cli: ${cli}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
  ].join('\n')

  return `${meta}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}`
}
```

Remove unused `toKeyValue` import if applicable.

Test: `npx vitest run tests/integration.test.ts`

- Note: toon.ts is UNCHANGED — the fix is in invokeAdvisor.ts only

**CHECKPOINT:** `npx vitest run tests/externalCli.test.ts tests/integration.test.ts`
**→ NEW CHAT**

### Phase 3: Version Bump + Tests

**Unit 3a — version bump**
- `package.json:3` → `"0.0.7"`
- `server.ts:42` → `"0.0.7"`
- `changelog.ts:10` → add v0.0.7 entry

**Unit 3b — test updates**
- `runTests.test.ts` — npx removal, deny list, regex, settled tests
- `tools.test.ts` — version `"0.0.6"` → `"0.0.7"`
- `integration.test.ts` — version `"0.0.6"` → `"0.0.7"`, tool count stays 15

**FINAL:** `npx vitest run` — full suite green

## Quick Reference

| Phase | Checkpoint |
|-------|-----------|
| 1 | `npx vitest run tests/runTests.test.ts tests/integration.test.ts` |
| 2 | `npx vitest run tests/externalCli.test.ts tests/integration.test.ts` |
| 3 | `npx vitest run` (full) |

## Key Council Changes (vs original spec)

| # | Original | Revised | Why |
|---|----------|---------|-----|
| 1 | No npx deny list | Deny `npx` from env entries (case-insensitive) | Codex: npx re-addable via FOREMAN_TEST_ALLOWLIST |
| 2 | Hardcode `C:\Windows\System32\cmd.exe` | `path.join(SystemRoot \|\| 'C:\\Windows', ...)` | Gemini: C:\ assumes C drive |
| 3 | Escape newlines in toon.ts globally | Block format in invokeAdvisor.ts only | Gemini: escaping destroys multi-line readability |
| 4 | No description update | Remove npx from server.ts:241 | Codex: stale metadata |
| 5 | — | Document `npm exec` as accepted residual | Codex: `npm exec ≈ npx` |

## Start

First session: begin with Unit 1a (runTests.ts).
