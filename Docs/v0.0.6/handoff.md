# v0.0.6 Handoff — Security Hardening Pass

## Project Overview

Closes deferred pentest triage items from v0.0.5, caps all remaining uncapped inline schemas, and adds session journal for operational telemetry. Three phases: schema caps + deferred items + journal, runTests hardening, version bump + test updates. See [spec.md](spec.md) for full details.

## Before Starting

1. Read `Docs/v0.0.6/spec.md`
2. Read this file
3. `mcp__foreman__read_progress` — check current position
4. `mcp__foreman__read_ledger({ query: "full" })` — check verdicts

## Rules

- No scope additions — only the files listed per unit
- Run the test command after every unit
- All `.max()` constraints on write schemas go in `types.ts`
- All `.max()` constraints on read/inline schemas go directly in `server.ts`
- `NormalizeReviewInputSchema` must be exported from `types.ts` and imported in `server.ts` via `.shape`
- Do NOT change tool descriptions, handler logic, or tool names when adding caps
- Do NOT modify the post-exit truncation logic in `runTests.ts` — the hard cap is an additional safety net, not a replacement
- The `runTests` function must remain a single exported function with the same signature
- `reviewer` cap is 200 (not 10000) — it's a name, not content
- Journal I/O follows the same pattern as progress.ts: per-path mutex, atomic write, ENOENT → fresh
- Journal file path default: `Docs/.foreman-journal.json`
- Event codes are a Zod enum — do NOT use free strings

## Implementation Order

### Phase 1: Schema Caps + Deferred Items

**Unit 1a — types.ts: New schema + ReadLedgerInputSchema caps**
- File: `foreman-mcp/src/types.ts`
- Add `NormalizeReviewInputSchema` export after `ReadLedgerInputSchema` block (after line 86):
  ```typescript
  export const NormalizeReviewInputSchema = z.object({
    reviewer: z.string().max(200),
    raw_text: z.string().max(50000),
  })
  export type NormalizeReviewInput = z.infer<typeof NormalizeReviewInputSchema>
  ```
- Change `ReadLedgerInputSchema` fields (lines 81-82):
  - `unit_id: z.string().optional()` -> `unit_id: z.string().max(10000).optional()`
  - `phase: z.string().optional()` -> `phase: z.string().max(10000).optional()`
- Test: `cd foreman-mcp && npx vitest run tests/writeTools.test.ts`
- Pitfall: `ReadLedgerInputSchema` is imported in `readLedger.ts` as a type — the `.max()` addition is backward compatible.

**Unit 1b — server.ts: Inline schema caps + NormalizeReviewInputSchema import**
- File: `foreman-mcp/src/server.ts`
- Add to imports: `import { ..., NormalizeReviewInputSchema } from "./types.js"` (the file already imports `WriteLedgerInputSchema` and `WriteProgressInputSchema` — add `NormalizeReviewInputSchema` to the same import)

Wait — check: does server.ts import from types.ts? Let me list what it imports.

Actually, from the code I read earlier, `server.ts` does NOT import from `types.ts` directly. The handler files (`writeLedger.ts`, `writeProgress.ts`) import the schemas. So I need to add a new import.

Changes to `server.ts` inline schemas:

| Line | Tool | Field | Before | After |
|------|------|-------|--------|-------|
| 57 | changelog | since_version | `z.string().optional()` | `z.string().max(20).optional()` |
| 71 | read_ledger | unit_id | `z.string().optional()` | `z.string().max(10000).optional()` |
| 72 | read_ledger | phase | `z.string().optional()` | `z.string().max(10000).optional()` |
| 87 | read_progress | last_n_completed | `z.number().optional()` | `z.number().min(1).max(100).optional()` |
| 124 | write_ledger | unit_id | `z.string().optional()` | `z.string().max(10000).optional()` |
| 125 | write_ledger | phase | `z.string().optional()` | `z.string().max(10000).optional()` |
| 162-165 | normalize_review | (whole block) | `{ reviewer: z.string(), raw_text: z.string() }` | `NormalizeReviewInputSchema.shape` |
| 178 | run_tests | runner | `z.string().min(1)` | `z.string().min(1).max(50)` |
| 179 | run_tests | args | `z.array(z.string()).default([])` | `z.array(z.string().max(10000)).max(100).default([])` |
| 216 | pitboss_implementor | context | `z.string().optional()` | `z.string().max(10000).optional()` |
| 237 | design_partner | context | `z.string().optional()` | `z.string().max(10000).optional()` |
| 258 | spec_generator | context | `z.string().optional()` | `z.string().max(10000).optional()` |

- DO NOT change any handler functions, tool descriptions, or registrations beyond the inputSchema
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Unit 1c — progress.ts: error_log FIFO cap**
- File: `foreman-mcp/src/lib/progress.ts`
- After line 96 (`progress.error_log.push({ date, unit, what_failed, next_approach })`), add:
  ```typescript
  if (progress.error_log.length > 20) progress.error_log = progress.error_log.slice(-20)
  ```
- This is identical to the `rej[]` pattern at `ledger.ts:124`
- DO NOT modify `truncateProgress` — it already slices to 5 for display, this caps on disk
- Test: `cd foreman-mcp && npx vitest run tests/progress.test.ts`

**Unit 1d — capabilityCheck.ts: path.isAbsolute()**
- File: `foreman-mcp/src/tools/capabilityCheck.ts`
- Add import at line 1 area: `import path from "path"`
- In `resolveCliPath`, between line 11 and line 12:
  ```typescript
  // BEFORE (line 11):
  const absPath = result.stdout.trim().split("\n")[0]
  // ADD:
  if (!path.isAbsolute(absPath)) return null
  // KEEP (line 12):
  resolvedPaths.set(cli, absPath)
  ```
- DO NOT modify HEALTH_COMMANDS, capabilityCheck function, or cache logic
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`

**Unit 1e — types.ts + lib/journal.ts: Session journal types and I/O**
- Files: `foreman-mcp/src/types.ts` (modify), `foreman-mcp/src/lib/journal.ts` (CREATE)
- Add to `types.ts` after `WriteProgressInputSchema` block (after line 168):
  - Journal interfaces: `JournalEnv`, `JournalEvent`, `SessionSummary`, `JournalSession`, `JournalRollup`, `JournalFile`
  - Event code Zod enum (`JournalEventCode`): `W_FAIL`, `W_REJ`, `W_RETRY`, `W_DRIFT`, `CX_ERR`, `CX_FP`, `ED_FAIL`, `ED_STALE`, `T_FLAKE`, `T_INFRA`, `BLD_ERR`, `CTX_OVF`, `CTX_COMP`, `SPEC_AMB`, `GATE_FIX`, `TOOL_ERR`, `USR_INT`, `MODEL_DEG`, `PERM_DENY`, `HOOK_BLOCK`, `DEP_MISS`, `SCHEMA_DRIFT`, `MERGE_CONF`
  - `WriteJournalInputSchema`: discriminated union on `operation`:
    - `init_session`: `{ target_version, branch, phase, units, env: { agent, worker, codex, gemini } }`
    - `log_event`: `{ t: JournalEventCode, u, tok, msg, wait?, gate? }`
    - `end_session`: `{ dur_min, ctx_used_pct, summary: { units_ok, units_rej, w_spawned, w_wasted, tok_wasted, delay_min, blockers, friction } }`
  - `ReadJournalInputSchema`: `{ last_n?: number, rollup_only?: boolean }`
  - All string fields capped with `.max()`: event fields max(200), env fields max(100). `tok: z.number().min(0)` (raw token count, e.g. 12000). `wait: z.number().min(0).optional()` (delay in minutes, e.g. 8).
  - Export all schemas and types
- Create `lib/journal.ts` (NEW) — same I/O pattern as `progress.ts`:
  - Per-path mutex (separate lock registry — DO NOT share with ledger or progress)
  - `readJournal(filePath)`: read JSON, return `{ v:1, project:"", target_version:"", next_sid:1, sessions:[] }` on ENOENT. Back up corrupt JSON.
  - `initSession(filePath, data)`: parse via `WriteJournalInputSchema`, append new session entry, auto-detect `env.os` = `${process.platform}-${process.arch}`, `env.node` = `process.version`, `env.foreman` = read from `package.json`. Generate session `id` = `s${journal.next_sid}`, increment `next_sid`, `ts` = ISO now. Update file-level `project` and `target_version` from caller data. FIFO: if sessions > 50, `sessions = sessions.slice(-50)`.
  - `logEvent(filePath, event)`: parse event via schema, append to last session's events array. Return error string if no active session or events.length > 200.
  - `endSession(filePath, data)`: fill `dur_min`, `ctx_used_pct`, `summary` on last session. If `sessions.length >= 5`, call `computeRollup` and store result.
  - `computeRollup(sessions)`: pure function — aggregate `avg_friction`, sort event codes by frequency → `top_events`, sum `tok_wasted` and `delay_min`, find unit patterns with most/fewest rejections → `worst_unit_pattern`/`best_unit_pattern`.
  - Atomic write: `.tmp` + rename (same as progress.ts)
- DO NOT import from ledger.ts or progress.ts — separate concerns
- Test: `cd foreman-mcp && npx vitest run tests/journal.test.ts`

**Unit 1f — server.ts: write_journal + read_journal tools**
- File: `foreman-mcp/src/server.ts`
- Add imports: `{ readJournal, initSession, logEvent, endSession }` from `./lib/journal.js`; `{ WriteJournalInputSchema, ReadJournalInputSchema }` from `./types.js` (add to existing types import)
- Add `journalPath` to `ServerConfig` interface: `journalPath?: string`
- Add to `createServer` after `docsDir`: `const journalPath = config?.journalPath ?? "Docs/.foreman-journal.json"`
- Register `write_journal` tool (after `write_progress` block):
  ```
  description: "Writes to the Foreman session journal. Operations: init_session — start session with env; log_event — append operational event; end_session — finalize with summary."
  inputSchema: {
    operation: z.enum(["init_session", "log_event", "end_session"]),
    data: z.record(z.unknown()),
  }
  ```
  - Handler: switch on `args.operation`, delegate to `initSession(journalPath, args)` / `logEvent(journalPath, args)` / `endSession(journalPath, args)`. Real validation via `WriteJournalInputSchema` inside journal.ts.
- Register `read_journal` tool (after `read_progress` block):
  ```
  description: "Reads the Foreman session journal. Returns session history with rollup."
  inputSchema: {
    last_n: z.number().min(1).max(100).optional(),
    rollup_only: z.boolean().optional(),
  }
  ```
  - Handler: call `readJournal(journalPath)`, if `rollup_only` return only rollup, if `last_n` slice sessions, return JSON.
- Tool count: 12 → 14
- DO NOT change existing tool registrations, descriptions, or handler logic
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Phase 1 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 2: runTests Hardening

**Unit 2a — runTests.ts: hard memory cap**
- File: `foreman-mcp/src/tools/runTests.ts`
- Add constant after `DEFAULT_ALLOWED_RUNNERS`: `const BUFFER_CAP_MULTIPLIER = 4`
- Compute hard cap inside `runTests` after spawn: `const hardCap = BUFFER_CAP_MULTIPLIER * maxOutputChars`
- In the `child.stdout.on('data', ...)` handler (line 43), after `stdoutBuf += chunk.toString()`:
  ```typescript
  if (stdoutBuf.length > hardCap || stderrBuf.length > hardCap) {
    if (!settled) {
      settled = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
      const { text: stdoutText, wasTruncated: stdoutTruncated } = truncate(stdoutBuf, maxOutputChars)
      const { text: stderrText, wasTruncated: stderrTruncated } = truncate(stderrBuf, maxOutputChars)
      resolve(
        `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n\nSTDOUT\n${stdoutText}\n\nSTDERR\n${stderrText}`
      )
    }
    return
  }
  ```
- Same check in the `child.stderr.on('data', ...)` handler (line 47)
- Pitfall: the `settled` flag prevents double-resolve. Both handlers share the same flag and same resolve — no race.
- Pitfall: `hardCap` with default maxOutputChars=8000 is 32000 chars — reasonable memory bound
- DO NOT change the post-exit truncation or timeout logic
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Unit 2b — runTests.ts: runner PATH resolution**
- File: `foreman-mcp/src/tools/runTests.ts`
- Add imports at top:
  ```typescript
  import { runExternalCli } from '../lib/externalCli.js'
  import path from 'path'
  ```
- Add module-level cache after `DEFAULT_ALLOWED_RUNNERS`:
  ```typescript
  const resolvedRunners = new Map<string, string>()
  ```
- Add resolver function after `getAllowedRunners`:
  ```typescript
  async function resolveRunner(runner: string): Promise<string | null> {
    if (resolvedRunners.has(runner)) return resolvedRunners.get(runner)!
    const result = await runExternalCli("which", [runner], 3000)
    if (result.exitCode === 0 && result.stdout.trim()) {
      const resolved = result.stdout.trim().split("\n")[0]
      if (!path.isAbsolute(resolved)) return null
      resolvedRunners.set(runner, resolved)
      return resolved
    }
    return null
  }
  ```
- In `runTests`, after the allowlist check (line 29) and before `return new Promise(...)`:
  ```typescript
  const resolvedPath = await resolveRunner(runner)
  if (!resolvedPath) {
    return `error: runner not found\nrunner: ${runner}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
  }
  ```
- Change `spawn(runner, args, ...)` (line 37) to `spawn(resolvedPath, args, ...)`
- Pitfall: Tests use `FOREMAN_TEST_ALLOWLIST=node` and `node` is always in PATH. Resolution adds ~100ms overhead on first call per runner (cached after).
- Pitfall: The allowlist error and the resolution error have different messages. Allowlist: `"error: runner not in allowlist"`. Resolution: `"error: runner not found"`. Tests distinguish them.
- DO NOT modify allowlist logic, truncation, TOON format, or timeout handling
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Phase 2 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 3: Integration + Version Bump

**Unit 3a — Version bump + changelog**
- Files: `foreman-mcp/package.json`, `foreman-mcp/src/server.ts`, `foreman-mcp/src/tools/changelog.ts`
- `package.json` line 3: `"0.0.5"` -> `"0.0.6"`
- `server.ts` line 37: `"0.0.5"` -> `"0.0.6"`
- `changelog.ts`: Insert at index 0 of CHANGELOG array:
  ```typescript
  { version: "0.0.6", date: "2026-04-10", description: "Security hardening + session journal — input length caps on all inline schemas, normalize_review schema extraction, error_log FIFO cap, path.isAbsolute() on CLI resolution, runTests hard memory cap and PATH resolution, session journal for operational telemetry (pentest triage v0.0.5 deferred items)" },
  ```
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`
- Pitfall: `bundleStatus` test asserts `"0.0.5"` — will fail until 3b updates it

**Unit 3b — Test updates**
- Files: `foreman-mcp/tests/tools.test.ts`, `foreman-mcp/tests/integration.test.ts`, `foreman-mcp/tests/progress.test.ts`, `foreman-mcp/tests/runTests.test.ts`, `foreman-mcp/tests/writeTools.test.ts`, `foreman-mcp/tests/journal.test.ts`
- Version assertions:
  - `tools.test.ts` line 28: `"0.0.5"` -> `"0.0.6"`
  - `integration.test.ts` line 129 (or wherever bundleStatus assertion is): `"0.0.5"` -> `"0.0.6"`
- New tests:
  - `progress.test.ts`: write 25 log_error entries to disk, readProgress, assert `progress.error_log.length === 20` and first entry is entry #6 (0-indexed: 5)
  - `runTests.test.ts`: (a) process producing output exceeding `4 * maxOutputChars` is killed and returns `truncated: true`; (b) resolved runner path is used for spawn (verify node resolves); (c) nonexistent runner on allowlist returns `"error: runner not found"`
  - `writeTools.test.ts`: import `NormalizeReviewInputSchema` from types, verify `.parse({ reviewer: "x".repeat(201), raw_text: "ok" })` throws; verify `.parse({ reviewer: "ok", raw_text: "x".repeat(50001) })` throws
  - `journal.test.ts` (NEW): (a) initSession creates file + auto-fills env.os/node/foreman; (b) logEvent appends events + validates event code enum; (c) endSession fills summary; (d) FIFO cap: 55 sessions → 50 on disk; (e) event cap: 201st event rejected; (f) rollup computed at 5+ sessions; (g) readJournal with last_n filter; (h) WriteJournalInputSchema rejects invalid event codes
- Pitfall: `integration.test.ts` asserts tool count — must update from `12` to `14` (added write_journal + read_journal)
- Test: `cd foreman-mcp && npx vitest run`

**Phase 3 Checkpoint:** `cd foreman-mcp && npx vitest run` (full suite, all tests pass)

## Testing Strategy

Archetype: Unit tests with real child_process spawns. See [testing-harness.md](testing-harness.md).

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cd foreman-mcp && npx vitest run` | Full test suite |
| `cd foreman-mcp && npx vitest run tests/writeTools.test.ts` | Schema + normalize_review tests |
| `cd foreman-mcp && npx vitest run tests/tools.test.ts` | Tool tests (capabilityCheck, version) |
| `cd foreman-mcp && npx vitest run tests/progress.test.ts` | Progress + error_log tests |
| `cd foreman-mcp && npx vitest run tests/runTests.test.ts` | runTests tests |
| `cd foreman-mcp && npx vitest run tests/journal.test.ts` | Journal tests |
| `cd foreman-mcp && npx vitest run tests/integration.test.ts` | Integration tests |
| `cd foreman-mcp && npm run build` | TypeScript compile |

| Error | Recovery |
|-------|----------|
| Type error from NormalizeReviewInputSchema | Check export in types.ts, import path in server.ts |
| bundleStatus test fails | Update version assertion from 0.0.5 to 0.0.6 |
| runTests test timeout | PATH resolution adds ~100ms — check test timeout is sufficient |
| capabilityCheck test fails | Verify path import added, isAbsolute check is between lines 11-12 |

## Start

**First session:** Begin at Phase 1, Unit 1a. Read the spec, read `types.ts`, add the new schema and caps.

**Resuming:** `mcp__foreman__read_progress` -> find first non-complete unit -> pick up there.
