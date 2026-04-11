# v0.0.7 Spec — Pentest Triage Fixes

## Intent

Close 5 findings from the v0.0.6 pentest triage (INJ-006, INJ-007, INJ-008, INJ-009, EXH-004). All are confirmed vulnerabilities or defense gaps identified by Purple-Planner + Codex adversarial review + Purple-Leader analysis workers. Revised after Architecture Council review (Codex + Gemini, 2026-04-11).

## Decisions & Notes

| Decision | Choice | Rationale | Source |
|----------|--------|-----------|--------|
| Remove `npx` from allowlist | Delete from `DEFAULT_ALLOWED_RUNNERS` | npx downloads+runs arbitrary packages; `npm test` covers CI | INJ-008 triage (P2) |
| Deny `npx` from env entries | `.filter(s => s.toLowerCase() !== 'npx')` after regex | Prevents re-adding npx via FOREMAN_TEST_ALLOWLIST | Arch council (Codex) |
| ALLOWLIST regex filter | `/^[a-zA-Z0-9_.-]+$/` on each env entry | Blocks path traversal, shell metacharacters in runner names | INJ-007 triage (P3) |
| Settled guard on data handlers | `if (settled) return` before buffer append | Prevents unbounded buffer growth in 0-2000ms race window | EXH-004 triage (P3) |
| ComSpec via SystemRoot | `path.join(process.env.SystemRoot \|\| 'C:\\Windows', 'System32', 'cmd.exe')` | Handles non-C-drive installs; SystemRoot is OS-set at boot, not user-poisonable | INJ-006 triage (P3) + Arch council (Gemini) |
| Block format for advisor output | Change `formatAdvisorResult` to use STDOUT/STDERR blocks, not `toKeyValue` for raw output | Prevents TOON injection without destroying multi-line readability | INJ-009 triage (P3) + Arch council (Gemini) |
| `npm exec` accepted residual | Document, do not restrict | Restricting npm subcommands requires arg parsing — different scope. `npm` is the primary CI use case | Arch council (Codex) |
| Update server.ts tool description | Remove `npx` from run_tests description string | Metadata must match actual allowlist | Arch council (Codex) |
| Version bump | 0.0.6 → 0.0.7 | Release fixes | Standard |

## Architecture

No new files. All changes to existing modules.

```
foreman-mcp/
  src/
    lib/
      externalCli.ts      ← ComSpec via SystemRoot (line 166)
    tools/
      runTests.ts         ← remove npx, deny list, regex filter, settled guard (lines 5, 14, 73, 91)
      invokeAdvisor.ts    ← formatAdvisorResult block format (line 44)
      changelog.ts        ← v0.0.7 entry
    server.ts             ← version bump (line 42), run_tests description update (line 241)
  package.json            ← version bump (line 3)
  tests/
    runTests.test.ts      ← npx removal, deny list, regex filter, settled guard tests
    externalCli.test.ts   ← verify no regression
    toon.test.ts          ← verify no regression (toon.ts is UNCHANGED)
    tools.test.ts         ← version bump assertion
    integration.test.ts   ← version bump assertion
```

## Core Behavior

### Phase 1: runTests Hardening (INJ-007, INJ-008, EXH-004)

**Unit 1a — runTests.ts: remove npx + deny list + regex filter + settled guard**

File: `foreman-mcp/src/tools/runTests.ts`

1. Remove `"npx"` from `DEFAULT_ALLOWED_RUNNERS` at line 5:
   ```typescript
   export const DEFAULT_ALLOWED_RUNNERS = ["npm", "pytest", "go", "cargo", "dotnet", "make"]
   ```

2. Add deny list + regex filter to `getAllowedRunners()` at line 14. After `.filter(Boolean)`, add deny list and regex:
   ```typescript
   function getAllowedRunners(): string[] {
     const extra = process.env.FOREMAN_TEST_ALLOWLIST
     if (extra) {
       return [
         ...DEFAULT_ALLOWED_RUNNERS,
         ...extra.split(",")
           .map(s => s.trim())
           .filter(Boolean)
           .filter(s => /^[a-zA-Z0-9_.-]+$/.test(s))
           .filter(s => s.toLowerCase() !== 'npx')
       ]
     }
     return DEFAULT_ALLOWED_RUNNERS
   }
   ```

3. Add settled guard at top of both data handlers. At line 73 (stdout handler) and line 91 (stderr handler), add `if (settled) return` as the first line of each handler, BEFORE the buffer append:
   ```typescript
   child.stdout.on('data', (chunk: Buffer) => {
     if (settled) return
     stdoutBuf += chunk.toString()
     // ... rest of handler unchanged
   })

   child.stderr.on('data', (chunk: Buffer) => {
     if (settled) return
     stderrBuf += chunk.toString()
     // ... rest of handler unchanged
   })
   ```

- DO NOT change the allowlist check logic, truncation logic, timeout behavior, or output format
- DO NOT add npx back under any condition — it is denied both from the default list and from env entries
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Unit 1b — server.ts: update run_tests description**

File: `foreman-mcp/src/server.ts`

At line 241, update the tool description to remove `npx`:
```
Before: "Runs a test command with bounded output. Runner must be in allowlist (npm, npx, pytest, go, cargo, dotnet, make). Use instead of Bash for test execution."
After:  "Runs a test command with bounded output. Runner must be in allowlist (npm, pytest, go, cargo, dotnet, make). Use instead of Bash for test execution."
```

- DO NOT change the inputSchema, handler logic, or any other tool
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

### Phase 2: ComSpec + Advisor Output Format (INJ-006, INJ-009)

**Unit 2a — externalCli.ts: ComSpec via SystemRoot**

File: `foreman-mcp/src/lib/externalCli.ts`

Add `import path from 'path'` if not already present (it is — line 2).

At line 166, replace:
```typescript
const comspec = process.env.ComSpec || 'cmd.exe'
```
With:
```typescript
const comspec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
```

`SystemRoot` is set by the OS at boot (system-level environment, not user-level). Falling back to `C:\Windows` handles the case where it's unset. This is strictly safer than trusting `ComSpec` (user-level, easily poisoned) while supporting non-C-drive Windows installs.

- DO NOT modify `resolveInvocation`, `runExternalCli`, `runWithStdin`, or any other function
- Test: `cd foreman-mcp && npx vitest run tests/externalCli.test.ts`

**Unit 2b — invokeAdvisor.ts: block format for advisor output**

File: `foreman-mcp/src/tools/invokeAdvisor.ts`

Replace `formatAdvisorResult` (lines 44-53) with block format that separates metadata from raw output:

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

This matches the output format used by `runTests` (key:value metadata, then `STDOUT`/`STDERR` blocks). Raw multi-line advisor output is readable. Forged key:value lines in stdout cannot escape the STDOUT block because parsers look for metadata BEFORE the first blank line.

Remove the `toKeyValue` import from invokeAdvisor.ts if it becomes unused.

- DO NOT modify `invokeAdvisor()`, `ADVISOR_CONFIGS`, or any other function
- DO NOT change `toon.ts` — it is unchanged in this release
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

### Phase 3: Version Bump + Tests

**Unit 3a — version bump + changelog**

Files: `foreman-mcp/package.json`, `foreman-mcp/src/server.ts`, `foreman-mcp/src/tools/changelog.ts`

- `package.json` line 3: `"version": "0.0.6"` → `"version": "0.0.7"`
- `server.ts` line 42: `version: "0.0.6"` → `version: "0.0.7"`
- `changelog.ts`: Add entry at index 0:
  ```typescript
  { version: "0.0.7", date: "2026-04-11", description: "Pentest triage fixes — remove npx from run_tests allowlist + deny via env (INJ-008), regex filter on FOREMAN_TEST_ALLOWLIST (INJ-007), settled guard on runTests data handlers (EXH-004), ComSpec via SystemRoot (INJ-006), block format for invoke_advisor output (INJ-009)" },
  ```

**Unit 3b — test updates**

Files: `foreman-mcp/tests/runTests.test.ts`, `foreman-mcp/tests/tools.test.ts`, `foreman-mcp/tests/integration.test.ts`

- `runTests.test.ts`:
  - Update existing test at line 32: `expect(DEFAULT_ALLOWED_RUNNERS).not.toContain('npx')` (was `toContain`)
  - Add test: FOREMAN_TEST_ALLOWLIST with `bash,../../evil,curl` → only `bash` and `curl` survive regex filter
  - Add test: FOREMAN_TEST_ALLOWLIST with `npx,NPX,Npx` → all three denied (case-insensitive)
  - Add test: FOREMAN_TEST_ALLOWLIST with `valid-runner,in.valid;chars` → only `valid-runner` survives
  - Add test: settled guard — spawn process that writes fast after cap, confirm no crash
  - Pitfall: existing test `'custom allowlist via env accepts unknown runner'` at line ~116 — verify runner name is alphanumeric

- `tools.test.ts`: Update `"0.0.6"` version assertions to `"0.0.7"`
- `integration.test.ts`: Update version assertion `"0.0.6"` → `"0.0.7"`. Tool count stays at 15.

**Phase 3 Checkpoint:** `cd foreman-mcp && npx vitest run`

## Error Handling

| Scenario | Behavior |
|----------|----------|
| FOREMAN_TEST_ALLOWLIST entry fails regex | Silently dropped |
| FOREMAN_TEST_ALLOWLIST entry is `npx` (any case) | Silently dropped by deny filter |
| FOREMAN_TEST_ALLOWLIST entirely invalid | Falls back to DEFAULT_ALLOWED_RUNNERS only |
| ComSpec env var set on Windows | Ignored — SystemRoot-derived path used |
| SystemRoot env var unset on Windows | Falls back to `C:\Windows` |
| Advisor stdout contains forged key:value lines | Contained in STDOUT block — cannot escape to metadata |
| Data event fires after settled=true in runTests | Early return — buffer unchanged |

## Dependencies

No new dependencies.

## Out of Scope

- EXH-005 (grandchild process kill) — deferred to v0.0.8
- Windows CI testing — validated via test-cli-invoker manually
- `npm exec` subcommand restriction — accepted residual risk; `npm` is the primary CI runner. Restricting subcommands requires arg parsing (different scope)
- `make` args validation — build tool, not package downloader
- `toon.ts` changes — toon.ts is UNCHANGED in this release; INJ-009 is fixed in invokeAdvisor.ts

## Testing Strategy

- **Archetype:** Unit tests with real child_process spawns
- **Mock boundaries:** None — real spawns, real file I/O
- **Framework:** Vitest 3.2

### What to Test

| Test | File | Why |
|------|------|-----|
| npx removed from DEFAULT_ALLOWED_RUNNERS | `runTests.test.ts` | INJ-008 fix |
| npx denied from env entries (case-insensitive) | `runTests.test.ts` | INJ-008 completeness (Codex finding) |
| Regex filter on FOREMAN_TEST_ALLOWLIST | `runTests.test.ts` | INJ-007 fix |
| Settled guard prevents buffer growth | `runTests.test.ts` | EXH-004 fix |
| invoke_advisor output uses block format | `integration.test.ts` | INJ-009 fix |
| Version assertions | `tools.test.ts`, `integration.test.ts` | Version bump |

### What NOT to Test

- ComSpec/SystemRoot on macOS (Windows-only code path; tested via test-cli-invoker)
- Exact Zod error messages (fragile)
- `npm exec` bypass (accepted residual — documented in Out of Scope)
- toon.ts (unchanged)

## Implementation Order

### Phase 1: runTests Hardening (INJ-007, INJ-008, EXH-004)

**Unit 1a — runTests.ts: remove npx, deny list, regex filter, settled guard**
- File: `foreman-mcp/src/tools/runTests.ts`
- Changes at lines 5, 14, 73, 91
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Unit 1b — server.ts: update run_tests description**
- File: `foreman-mcp/src/server.ts` line 241
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Phase 1 Checkpoint:** `cd foreman-mcp && npx vitest run tests/runTests.test.ts tests/integration.test.ts`

### Phase 2: ComSpec + Advisor Output (INJ-006, INJ-009)

**Unit 2a — externalCli.ts: ComSpec via SystemRoot** (line 166)
- Test: `cd foreman-mcp && npx vitest run tests/externalCli.test.ts`

**Unit 2b — invokeAdvisor.ts: block format** (lines 44-53)
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Phase 2 Checkpoint:** `cd foreman-mcp && npx vitest run tests/externalCli.test.ts tests/integration.test.ts`

### Phase 3: Version Bump + Tests

**Unit 3a — version bump + changelog**
**Unit 3b — test updates**

**Phase 3 Checkpoint:** `cd foreman-mcp && npx vitest run` (full suite)
