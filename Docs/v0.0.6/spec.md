# v0.0.6 Spec — Security Hardening Pass

## Intent

Close 3 deferred security items from the v0.0.5 pentest triage (INJ-004, INJ-005, EXH-002), cap all uncapped inline Zod schemas in server.ts, harden runTests execution surface with memory bounds and PATH resolution, add session journal for operational telemetry, and bump to 0.0.6.

## Decisions & Notes

| Decision | Choice | Rationale | Source |
|----------|--------|-----------|--------|
| Release scope | Security + telemetry | Hardening + journal for iteration feedback | Design session |
| `normalize_review` schema location | Extract to `types.ts` | Consistency with all other write schemas | Design session |
| `raw_text` cap | 50000 chars | Same tier as `brief` — carries full review output | Design session |
| `reviewer` cap | 200 chars | Just a name/label | Design session |
| `error_log` FIFO cap | 20 entries | Match `rej[]` pattern in ledger.ts:124 | Design session |
| `path.isAbsolute()` failure mode | Return `null` (unavailable) | Safer than fallback to bare name | Design session |
| `last_n_completed` cap | `.min(1).max(100)` | Prevents truncation bypass | Codex review |
| `since_version` cap | `.max(20)` | Semver strings are short | Codex review |
| `runTests` hard memory cap | `4 * maxOutputChars` per buffer | Middle ground: no O(N^2) streaming, prevents OOM | Deliberation |
| `runTests` PATH resolution | `which` + `isAbsolute()`, cached | Same pattern as capabilityCheck.ts | Deliberation |
| `runTests` args caps | Array `.max(100)`, elements `.max(10000)` | Prevent unbounded arg injection | Deliberation |
| `runTests` runner cap | `.max(50)` | Binary names are short | Deliberation |
| Prototype pollution fix | Skip | JSON.parse neutralizes `__proto__`; no `for...in` in codebase | Deliberation — false positive |
| Inline read schema caps | 10000 for identifiers | Match write schema tier | Consistency |
| Skill `context` cap | 10000 | Short activation context, not code | Consistency |
| Binary resolution cmd | `process.platform === 'win32' ? 'where' : 'which'` | `which` is POSIX-only, `where` is Windows equivalent | AB test finding |
| `invoke_advisor` location | `externalCli.ts` function + MCP tool | Keeps platform logic in TypeScript, skills stay platform-agnostic | Design session |
| Prompt passing strategy | stdin piping via `runWithStdin` | Eliminates all OS arg length limits; both CLIs support stdin (Codex: `exec -`, Gemini: stdin appended to `-p`) | Arch council |
| `.cmd` shim handling | `SpawnPlan` type: wrap `.cmd`/`.bat` via `cmd.exe /d /s /c` | npm globals on Windows are `.cmd` shims; `spawn()` cannot execute them directly | Arch council |
| CRLF handling | `.split(/\r?\n/)` in all resolution paths | `where.exe` returns `\r\n`; `.split('\n')[0]` leaves trailing `\r` | Arch council |
| Phase 3 gate | `test-cli-invoker/` standalone proof must pass first | Validates SpawnPlan, stdin, CRLF before integration | Arch council |
| `invoke_advisor` prompt cap | 100000 chars | Deliberation prompts can be long but must be bounded | Consistency |
| `invoke_advisor` timeout range | 5000–600000ms, default 300000 | Match existing deliberation timeout | Consistency |
| Skill CLI Invocation sections | Replace with `invoke_advisor` tool call | Skills become platform-agnostic, all shell logic in TypeScript | Design session |
| Journal file format | JSON, dense keys (`t`, `u`, `tok`, `msg`) | Match ledger/progress I/O pattern, token-efficient | Design session |
| Journal `tok`/`wait` fields | Numbers (not strings) | Enables arithmetic in rollup without parsing "12k" | Deliberation |
| Journal session ID | Running counter (`next_sid`) in file | Prevents ID collision after FIFO drop | Deliberation |
| Journal session FIFO | 50 sessions max | Bound file growth | Design session |
| Journal event cap | 200 per session | Prevent runaway logging | Design session |
| Journal env auto-detect | os + node + foreman server-side | Caller passes agent/worker/codex/gemini | Design session |
| Journal rollup | Auto-compute at 5+ sessions | Cross-session trend analysis | Design session |
| Journal event codes | Zod enum (23 codes) | Prevent typos, self-documenting schema | Design session |

## Architecture

One new file (`lib/journal.ts`). All other changes to existing modules. Phase 3 has a standalone gate (`test-cli-invoker/`).

```
test-cli-invoker/              ← standalone proof-of-concept (Phase 3 gate)
  spec.md                      ← full spec for SpawnPlan + stdin + CRLF
  src/
    spawnPlan.ts               ← resolveInvocation() → SpawnPlan
    invokeAdvisor.ts           ← advisor invocation using SpawnPlan + stdin
  tests/
    spawnPlan.test.ts          ← mock-based resolution tests (incl. Windows .cmd)
    stdin.test.ts              ← real spawn stdin delivery tests
    crlf.test.ts               ← CRLF edge cases
    integration.test.ts        ← end-to-end with real node binary

foreman-mcp/
  src/
    types.ts              ← NormalizeReviewInputSchema, journal types + schemas, ReadLedgerInputSchema caps
    server.ts             ← inline schema caps, NormalizeReviewInputSchema, write_journal + read_journal + invoke_advisor tools
    lib/
      externalCli.ts      ← RESOLVE_CMD constant, invokeAdvisor() function
      journal.ts          ← session journal read/write + rollup (new file)
      progress.ts         ← error_log FIFO cap on write path
    tools/
      capabilityCheck.ts  ← path.isAbsolute() + RESOLVE_CMD import
      runTests.ts         ← hard memory cap, PATH resolution via RESOLVE_CMD
      changelog.ts        ← v0.0.6 entry
    skills/
      design-partner.md   ← CLI Invocation section → invoke_advisor tool call
      spec-generator.md   ← CLI Invocation section → invoke_advisor tool call
  package.json            ← version bump
  tests/
    externalCli.test.ts   ← RESOLVE_CMD value test, invokeAdvisor unavailable CLI test
    journal.test.ts       ← journal init/log/end/FIFO/rollup (new file)
    progress.test.ts      ← error_log FIFO on-disk test
    tools.test.ts         ← capabilityCheck isAbsolute test, version bump
    runTests.test.ts      ← memory cap test, PATH resolution test
    writeTools.test.ts    ← normalize_review cap rejection test
    integration.test.ts   ← version assertion update, tool count 14 → 15
```

## Core Behavior

### Phase 1: Schema Caps + Deferred Items

1. Add `NormalizeReviewInputSchema` to `types.ts` with `reviewer: z.string().max(200)` and `raw_text: z.string().max(50000)`.
2. Add `.max(10000)` to `ReadLedgerInputSchema` fields `unit_id` and `phase`.
3. Update `server.ts` `normalize_review` registration to import and use `NormalizeReviewInputSchema`.
4. Cap all remaining inline schemas in `server.ts`:
   - `changelog.since_version`: `.max(20)`
   - `read_ledger.unit_id`, `read_ledger.phase`: `.max(10000)`
   - `read_progress.last_n_completed`: `.min(1).max(100)`
   - `write_ledger.unit_id`, `write_ledger.phase`: `.max(10000)`
   - `run_tests.runner`: `.max(50)`
   - `run_tests.args`: `z.array(z.string().max(10000)).max(100).default([])`
   - `pitboss_implementor.context`: `.max(10000)`
   - `design_partner.context`: `.max(10000)`
   - `spec_generator.context`: `.max(10000)`
5. In `progress.ts`, after `progress.error_log.push(...)` at line 96, add FIFO cap: `if (progress.error_log.length > 20) progress.error_log = progress.error_log.slice(-20)`.
6. In `capabilityCheck.ts`, after resolving `absPath` at line 11, add: `import path from "path"` at top, then check `if (!path.isAbsolute(absPath)) return null` before caching.
7. Add journal types and schemas to `types.ts`: `JournalEnv`, `JournalEvent`, `SessionSummary`, `JournalSession`, `JournalRollup`, `JournalFile` interfaces; `WriteJournalInputSchema` (discriminated union: `init_session`, `log_event`, `end_session`); `ReadJournalInputSchema`. Event codes as Zod enum (23 codes).
8. Create `lib/journal.ts`: JSON file I/O with atomic writes, per-path mutex (same pattern as `progress.ts`). Functions: `readJournal`, `initSession` (auto-detects os/node/foreman env), `logEvent`, `endSession`, `computeRollup` (pure). FIFO: 50 sessions, 200 events/session.
9. Register `write_journal` and `read_journal` tools in `server.ts`. `write_journal` handles `init_session`/`log_event`/`end_session`. `read_journal` supports `last_n` and `rollup_only`.

### Phase 2: runTests Hardening

10. In `runTests.ts`, add hard memory cap to both `data` event handlers: if either buffer exceeds `4 * maxOutputChars`, kill the child process immediately (SIGTERM then SIGKILL) and resolve with truncated output, `truncated: true`.
11. In `runTests.ts`, resolve runner binary via `which` before spawn: import `runExternalCli` from `externalCli.js`, resolve runner to absolute path via `runExternalCli("which", [runner], 3000)`, validate `path.isAbsolute()`, cache in module-level `Map<string, string>`. If resolution fails, return error string without spawning.

### Phase 3: Integration + Version Bump

12. Bump `package.json` version `"0.0.5"` -> `"0.0.6"`.
13. Bump `server.ts` McpServer constructor version `"0.0.5"` -> `"0.0.6"`.
14. Add changelog entry at index 0 of CHANGELOG array in `changelog.ts`.
15. Update test assertions: version strings `0.0.5` -> `0.0.6` in `tools.test.ts` and `integration.test.ts`.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `which` returns non-absolute path | `resolveCliPath` returns `null` -> tool reports unavailable |
| `which` fails/empty | `resolveCliPath` returns `null` -> tool reports unavailable |
| `runTests` buffer exceeds hard cap | Child killed (SIGTERM->SIGKILL), return partial output with `truncated: true`, `timed_out: false` |
| `runTests` runner resolution fails | Return error string: `"error: runner not found\nrunner: <name>"` without spawning |
| `error_log` exceeds 20 | FIFO: `error_log = error_log.slice(-20)` |
| Zod `.max()` exceeded | MCP framework returns Zod validation error to caller |
| `normalize_review` with >50K `raw_text` | Zod rejects before handler runs |
| Journal file corrupt | Back up + return fresh (same pattern as progress.ts) |
| Journal >50 sessions | FIFO: drop oldest sessions on `initSession` |
| Journal >200 events/session | `logEvent` returns error, does not append |
| Journal file missing | `readJournal` returns `{ v:1, sessions:[] }` |
| `RESOLVE_CMD` (`which`/`where`) not found | `resolveInvocation` returns `{ ok: false, reason: "<cli> not found" }` |
| Resolved path is non-absolute | `resolveInvocation` returns `{ ok: false }` |
| Windows: only `.cmd` shims found | `SpawnPlan` wraps via `cmd.exe /d /s /c`; prompt via stdin (bypasses 8K cmd.exe limit) |
| Windows: `.exe` and `.cmd` both found | `SpawnPlan` prefers `.exe` (no wrapper needed) |
| `where.exe` returns CRLF | Split with `/\r?\n/`, trim each line |
| `invokeAdvisor` unknown CLI name | Returns `exitCode: -1`, stderr: `unknown cli: <name>` |
| stdin write error (child exited early) | `child.stdin.on('error')` swallowed — normal for short-lived processes |
| `invoke_advisor` prompt exceeds 100K | Zod rejects before handler runs |
| `invoke_advisor` timeout outside 5s–600s | Zod rejects before handler runs |

## Dependencies

No new dependencies. All changes use existing imports (`path`, `child_process`, `zod`).

## Out of Scope

- Read-path escaping for stored prompt injection (INJ-004 full fix — v0.0.7)
- `runTests` subcommand restrictions (overengineered for LLM-called tool)
- Streaming truncation in `runTests` (explicit v0.0.5 design decision)
- Prototype pollution defense (false positive — JSON.parse neutralizes)
- Journal cross-project aggregation (v0.0.7+)
- Journal UI/dashboard
- `skillLoader.ts` path separator validation (no current exploit path)
- CLI-specific prompt file flags (`-p @file` for Gemini, etc.) — unnecessary when using stdin
- Windows CI matrix (mocked via canned `where` output in test-cli-invoker; real Windows testing deferred)

## Testing Strategy

- **Archetype:** Unit tests with real child_process spawns
- **Mock boundaries:** None — real spawns, real file I/O, temp directories
- **Framework:** Vitest 3.2

### What to Test

| Test | File | Why |
|------|------|-----|
| error_log FIFO cap on disk | `progress.test.ts` | Currently only tests display trim, not write cap |
| capabilityCheck rejects non-absolute which output | `tools.test.ts` | New behavior |
| normalize_review rejects >50K raw_text | `writeTools.test.ts` | New schema cap |
| runTests kills process at hard memory cap | `runTests.test.ts` | New behavior |
| runTests resolves runner to absolute path | `runTests.test.ts` | New behavior |
| runTests rejects unresolvable runner | `runTests.test.ts` | New behavior |
| Version assertions updated | `tools.test.ts`, `integration.test.ts` | Version bump |
| Journal init_session + env auto-detect | `journal.test.ts` | New module |
| Journal log_event append + event code validation | `journal.test.ts` | New module |
| Journal end_session + summary | `journal.test.ts` | New module |
| Journal FIFO cap (50 sessions) | `journal.test.ts` | Bound enforcement |
| Journal event cap (200/session) | `journal.test.ts` | Bound enforcement |
| Journal rollup computation | `journal.test.ts` | Pure function |
| Journal read with last_n filter | `journal.test.ts` | New module |
| RESOLVE_CMD is `which` on non-Windows | `externalCli.test.ts` | Platform constant |
| invokeAdvisor returns error for unavailable CLI | `externalCli.test.ts` | New function |
| invokeAdvisor returns error for unknown CLI name | `externalCli.test.ts` | New function |
| capabilityCheck uses RESOLVE_CMD (not hardcoded `which`) | `tools.test.ts` | Refactor verification |
| invoke_advisor tool registered and callable | `integration.test.ts` | New tool |
| Tool count 15 | `integration.test.ts` | Added invoke_advisor |

### What NOT to Test

- Prototype pollution (not a real vulnerability)
- Exact Zod error message text (fragile)
- Subcommand restrictions (out of scope)
- `invokeAdvisor` on actual Windows (CI is Linux; platform constant is tested by value)
- Actual Codex/Gemini CLI output (external dependency; test binary resolution + error paths only)

## Implementation Order

### Phase 1: Schema Caps + Deferred Items

**Unit 1a — types.ts: NormalizeReviewInputSchema + ReadLedgerInputSchema caps**
- File: `foreman-mcp/src/types.ts`
- Add `NormalizeReviewInputSchema` export after `ReadLedgerInputSchema` (line ~86):
  ```typescript
  export const NormalizeReviewInputSchema = z.object({
    reviewer: z.string().max(200),
    raw_text: z.string().max(50000),
  })
  export type NormalizeReviewInput = z.infer<typeof NormalizeReviewInputSchema>
  ```
- Add `.max(10000)` to `ReadLedgerInputSchema` fields at lines 81-82:
  - `unit_id: z.string().max(10000).optional()`
  - `phase: z.string().max(10000).optional()`
- DO NOT modify WriteLedgerInputSchema, WriteProgressInputSchema, or any other existing schema
- Test: `cd foreman-mcp && npx vitest run tests/writeTools.test.ts`

**Unit 1b — server.ts: inline schema caps + NormalizeReviewInputSchema**
- File: `foreman-mcp/src/server.ts`
- Add import: `import { NormalizeReviewInputSchema } from "./types.js"` (add to existing types import if present, otherwise new line)
- Replace normalize_review inputSchema (lines 162-165) with: `inputSchema: NormalizeReviewInputSchema.shape`
- Note: `.shape` extracts the raw Zod object fields for McpServer registerTool, which expects `Record<string, ZodType>` not a `ZodObject`
- Cap all remaining inline schemas per the inventory table in the design summary
- DO NOT change tool descriptions, handler logic, or tool names
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Unit 1c — progress.ts: error_log FIFO cap**
- File: `foreman-mcp/src/lib/progress.ts`
- After line 96 (`progress.error_log.push(...)`), add:
  ```typescript
  if (progress.error_log.length > 20) progress.error_log = progress.error_log.slice(-20)
  ```
- DO NOT modify truncateProgress, readProgress, or any other function
- Test: `cd foreman-mcp && npx vitest run tests/progress.test.ts`

**Unit 1d — capabilityCheck.ts: path.isAbsolute()**
- File: `foreman-mcp/src/tools/capabilityCheck.ts`
- Add `import path from "path"` at top of file
- In `resolveCliPath`, after line 11 (`const absPath = result.stdout.trim().split("\n")[0]`), add:
  ```typescript
  if (!path.isAbsolute(absPath)) return null
  ```
- DO NOT modify HEALTH_COMMANDS, capabilityCheck function body, or any other logic
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`

**Unit 1e — types.ts + lib/journal.ts: Session journal types and I/O**
- Files: `foreman-mcp/src/types.ts` (modify), `foreman-mcp/src/lib/journal.ts` (CREATE)
- Add to `types.ts` after `WriteProgressInputSchema` block:
  - Interfaces: `JournalEnv`, `JournalEvent`, `SessionSummary`, `JournalSession`, `JournalRollup`, `JournalFile`
  - Event code Zod enum: `W_FAIL`, `W_REJ`, `W_RETRY`, `W_DRIFT`, `CX_ERR`, `CX_FP`, `ED_FAIL`, `ED_STALE`, `T_FLAKE`, `T_INFRA`, `BLD_ERR`, `CTX_OVF`, `CTX_COMP`, `SPEC_AMB`, `GATE_FIX`, `TOOL_ERR`, `USR_INT`, `MODEL_DEG`, `PERM_DENY`, `HOOK_BLOCK`, `DEP_MISS`, `SCHEMA_DRIFT`, `MERGE_CONF`
  - `WriteJournalInputSchema`: discriminated union (`init_session`, `log_event`, `end_session`)
  - `ReadJournalInputSchema`: `{ last_n?: number, rollup_only?: boolean }`
  - All string fields capped with `.max()`. `tok` and `wait` are `z.number()` (not strings) — enables arithmetic in rollup.
- Create `lib/journal.ts` — same I/O pattern as `progress.ts`:
  - Per-path mutex (separate lock registry)
  - `readJournal(filePath)`: read JSON, return fresh `{ v:1, project:"", target_version:"", next_sid:1, sessions:[] }` on ENOENT
  - `initSession(filePath, data)`: append new session, auto-detect `env.os` (`process.platform-process.arch`), `env.node` (`process.version`), `env.foreman` (from `package.json`). Generate `id` = `s${next_sid}`, increment `next_sid`. Update file-level `project` and `target_version` from caller data. FIFO: if sessions > 50, drop oldest.
  - `logEvent(filePath, event)`: append event to last session. Return error if events > 200 or no active session.
  - `endSession(filePath, data)`: fill `dur_min`, `ctx_used_pct`, `summary` on last session. If `sessions.length >= 5`, compute and store rollup.
  - `computeRollup(sessions)`: pure function — `avg_friction`, `top_events`, `tok_total_wasted`, `delay_total_min`, `worst_unit_pattern`, `best_unit_pattern`
  - Atomic write: `.tmp` + rename
- DO NOT import from ledger.ts or progress.ts
- Test: `cd foreman-mcp && npx vitest run tests/journal.test.ts`

**Unit 1f — server.ts: write_journal + read_journal tools**
- File: `foreman-mcp/src/server.ts`
- Add imports: journal functions from `./lib/journal.js`, `WriteJournalInputSchema` + `ReadJournalInputSchema` from `./types.js`
- Add `journalPath` to `ServerConfig` interface: `journalPath?: string`
- Add to `createServer`: `const journalPath = config?.journalPath ?? "Docs/.foreman-journal.json"`
- Register `write_journal` tool (after `write_progress`):
  - Description: "Writes to the Foreman session journal. Operations: init_session, log_event, end_session."
  - inputSchema: `{ operation: z.enum([...]), data: z.record(z.unknown()) }` (same loose pattern as write_ledger/write_progress — real validation in journal.ts via WriteJournalInputSchema)
  - Handler delegates to `initSession`/`logEvent`/`endSession` based on operation
- Register `read_journal` tool (after `read_progress`):
  - Description: "Reads the Foreman session journal."
  - inputSchema: `{ last_n: z.number().min(1).max(100).optional(), rollup_only: z.boolean().optional() }`
  - Handler reads journal, slices to `last_n` sessions if provided, returns rollup only if `rollup_only`
- Tool count: 12 → 14 (invoke_advisor added separately in Phase 3, bringing total to 15)
- DO NOT change existing tool registrations
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Phase 1 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 2: runTests Hardening

**Unit 2a — runTests.ts: hard memory cap**
- File: `foreman-mcp/src/tools/runTests.ts`
- Add constant: `const BUFFER_CAP_MULTIPLIER = 4`
- In both `data` event handlers (lines 43-45, 47-49), after appending to buffer, add hard cap check:
  ```typescript
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    if (stdoutBuf.length + stderrBuf.length > BUFFER_CAP_MULTIPLIER * maxOutputChars) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000)
        const { text: ot, wasTruncated: otr } = truncate(stdoutBuf, maxOutputChars)
        const { text: et, wasTruncated: etr } = truncate(stderrBuf, maxOutputChars)
        resolve(
          `exit_code: -1\npassed: false\ntimed_out: false\ntruncated: true\n\nSTDOUT\n${ot}\n\nSTDERR\n${et}`
        )
      }
      return
    }
  })
  ```
- Same pattern for stderr handler
- Pitfall: both handlers must check combined buffer size, not just their own. A process writing only to stdout should still be killed if stdout alone exceeds the cap.
- Simplification: check `stdoutBuf.length > hardCap || stderrBuf.length > hardCap` where `hardCap = BUFFER_CAP_MULTIPLIER * maxOutputChars`. This avoids the combined-size confusion.
- DO NOT change the existing post-exit truncation logic — the hard cap is an additional safety net
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Unit 2b — runTests.ts: runner PATH resolution**
- File: `foreman-mcp/src/tools/runTests.ts`
- Add imports: `import { runExternalCli } from '../lib/externalCli.js'` and `import path from 'path'`
- Add module-level cache: `const resolvedRunners = new Map<string, string>()`
- Add resolver function:
  ```typescript
  async function resolveRunner(runner: string): Promise<string | null> {
    if (resolvedRunners.has(runner)) return resolvedRunners.get(runner)!
    const result = await runExternalCli("which", [runner], 3000)
    if (result.exitCode === 0 && result.stdout.trim()) {
      const absPath = result.stdout.trim().split("\n")[0]
      if (!path.isAbsolute(absPath)) return null
      resolvedRunners.set(runner, absPath)
      return absPath
    }
    return null
  }
  ```
- In `runTests`, after allowlist check and before spawn:
  ```typescript
  const resolvedPath = await resolveRunner(runner)
  if (!resolvedPath) {
    return `error: runner not found\nrunner: ${runner}\nallowed_runners: ${DEFAULT_ALLOWED_RUNNERS.join(", ")}`
  }
  ```
- Change `spawn(runner, args, ...)` to `spawn(resolvedPath, args, ...)`
- The function signature changes from sync Promise.resolve for allowlist error to always async (it already returns Promise<string>)
- DO NOT modify the allowlist check, truncation logic, or TOON output format
- Test: `cd foreman-mcp && npx vitest run tests/runTests.test.ts`

**Phase 2 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 3: Cross-Platform CLI Invocation

**GATE:** Phase 3 integration is blocked until `test-cli-invoker/` passes. See `test-cli-invoker/spec.md` for the standalone proof-of-concept that validates SpawnPlan, stdin delivery, CRLF handling, and `.cmd` shim wrapping. Run `cd test-cli-invoker && npx vitest run` — all green before proceeding.

**Problem:** Deliberation protocol in `design-partner.md` and `spec-generator.md` contains POSIX-only shell constructs that break on Windows/PowerShell:

| POSIX Construct | Used In | Breaks Because |
|-----------------|---------|----------------|
| `mktemp /tmp/gemini-prompt.XXXXXX` | Skill CLI Invocation | No `/tmp/`, no `mktemp` on Windows |
| `cat <<'PROMPT' > "$TMPFILE"` | Skill CLI Invocation | Heredoc is bash/zsh only |
| `$(cat "$TMPFILE")` | Skill CLI Invocation | Command substitution differs in PowerShell |
| `rm -f "$TMPFILE"` | Skill CLI Invocation | `rm` not available natively on Windows |
| `which` | `capabilityCheck.ts`, `runTests.ts` | Windows uses `where.exe` instead |

**Root cause:** Skills describe shell commands for the agent to execute via Bash. But `externalCli.ts` already uses `spawn(command, args)` — no shell needed. Shell-specific constructs exist only because there was no MCP tool to invoke advisors directly.

**Architecture Council blockers (2026-04-10):** Three additional issues found during Codex+Gemini deliberation:

| # | Blocker | Impact | Fix |
|---|---------|--------|-----|
| 1 | `.cmd` shim breaks `spawn()` | npm globals on Windows are `.cmd` shims; `spawn(path, args)` ENOENT | `SpawnPlan` type: wrap `.cmd`/`.bat` via `cmd.exe /d /s /c` |
| 2 | CRLF in `where.exe` output | `.split('\n')[0]` leaves trailing `\r` | Split with `/\r?\n/` everywhere |
| 3 | Prompt via argv hits OS limits | `CreateProcess`: 32,767 chars; `cmd.exe /c`: 8,191 chars | Deliver prompt via stdin; both CLIs support it |

**Solution:** `SpawnPlan` type + `runWithStdin` function + `invokeAdvisor` orchestrator. Full design in `test-cli-invoker/spec.md`.

**Unit 3a — externalCli.ts: RESOLVE_CMD + SpawnPlan + runWithStdin + invokeAdvisor**
- File: `foreman-mcp/src/lib/externalCli.ts`
- Add import: `import path from 'path'`
- Transplant from `test-cli-invoker/src/` after gate passes:
  - `RESOLVE_CMD` constant: `process.platform === 'win32' ? 'where' : 'which'`
  - `SpawnPlan` interface: `{ command: string, args: string[], needsStdin: boolean }`
  - `resolveInvocation(cli)` function: resolves binary, handles CRLF (`/\r?\n/`), on Windows prefers `.exe` over `.cmd`, wraps `.cmd`/`.bat` via `cmd.exe /d /s /c`
  - `runWithStdin(command, args, stdinData, timeoutMs)` function: same as `runExternalCli` but writes `stdinData` to stdin before `.end()`. `runExternalCli` remains unchanged (backwards-compatible).
  - `invokeAdvisor(cli, prompt, timeoutMs)` function: resolves via `resolveInvocation`, builds advisor-specific args (Codex: `exec ... -` for stdin; Gemini: `-p ""` with stdin appended), calls `runWithStdin`
  - `ADVISOR_CONFIGS`: args builders with **no prompt in args** — prompt goes via stdin
- Codex args: `["exec", "--skip-git-repo-check", "-s", "read-only", "-c", "hide_agent_reasoning=true", "-"]` (the `-` tells Codex to read stdin; model and reasoning effort come from user's `~/.codex/config.toml` defaults)
- Gemini args: `["-p", "", "-m", "arch-review", "--approval-mode", "plan", "--output-format", "text"]` (empty `-p`, Gemini appends stdin)
- DO NOT modify `runExternalCli` or `ExternalCliResult` — `runWithStdin` is a new sibling function
- Test: `cd foreman-mcp && npx vitest run tests/externalCli.test.ts`

**Unit 3b — capabilityCheck.ts + runTests.ts: RESOLVE_CMD + CRLF fix**
- Files: `foreman-mcp/src/tools/capabilityCheck.ts`, `foreman-mcp/src/tools/runTests.ts`
- In both files, import `RESOLVE_CMD` from `../lib/externalCli.js`
- Replace hardcoded `"which"` with `RESOLVE_CMD`:
  - `capabilityCheck.ts` line 10: `runExternalCli("which", [cli], 3000)` → `runExternalCli(RESOLVE_CMD, [cli], 3000)`
  - `runTests.ts` resolver: `runExternalCli("which", [runner], 3000)` → `runExternalCli(RESOLVE_CMD, [runner], 3000)`
- Fix CRLF in both files — replace `.split("\n")[0]` with `.split(/\r?\n/)[0]`:
  - `capabilityCheck.ts` line 12: `result.stdout.trim().split("\n")[0]` → `result.stdout.trim().split(/\r?\n/)[0]`
  - `runTests.ts` line 21: `result.stdout.trim().split("\n")[0]` → `result.stdout.trim().split(/\r?\n/)[0]`
- DO NOT change any other logic in these files
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts tests/runTests.test.ts`

**Unit 3c — server.ts: register invoke_advisor tool**
- File: `foreman-mcp/src/server.ts`
- Add import: `invokeAdvisor` from `./lib/externalCli.js`
- Register `invoke_advisor` tool (after `capability_check`):
  ```typescript
  server.tool("invoke_advisor",
    "Invokes an external advisor CLI (Codex or Gemini) with a prompt. Handles platform-aware binary resolution (which on POSIX, where on Windows) and cross-platform arg passing. No shell commands needed — call this tool instead.",
    {
      cli: z.enum(["codex", "gemini"]),
      prompt: z.string().max(100000),
      timeout_ms: z.number().min(5000).max(600000).default(300000),
    },
    async ({ cli, prompt, timeout_ms }) => {
      const result = await invokeAdvisor(cli, prompt, timeout_ms)
      return {
        content: [{
          type: "text" as const,
          text: toKeyValue({
            cli,
            exit_code: String(result.exitCode),
            timed_out: String(result.timedOut),
            truncated: String(result.truncated),
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        }],
      }
    }
  )
  ```
- Tool count: 14 → 15
- DO NOT change existing tool registrations
- Test: `cd foreman-mcp && npx vitest run tests/integration.test.ts`

**Unit 3d — Skills: replace CLI Invocation with invoke_advisor**
- Files: `foreman-mcp/src/skills/design-partner.md`, `foreman-mcp/src/skills/spec-generator.md`
- Replace the `### CLI Invocation` section in both files. Remove the POSIX shell commands and replace with:
  ```markdown
  ### CLI Invocation

  Both CLIs are invoked via the `invoke_advisor` tool. The tool handles platform
  detection (which/where), binary resolution, and cross-platform arg passing
  internally — no shell commands needed.

  **Codex:**
  `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })`

  **Gemini:**
  `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`

  Default timeout: 300000ms. Both calls resolve the CLI binary to an absolute
  path and pass the prompt as a direct process argument (no temp files, no shell).

  **Opus agent fallback:** Use Agent tool with `model: "opus"` and adversarial critic prompt.
  ```
- DO NOT change the Tier Mapping, Prompt Template, Protocol, Cross-Examination, or Anti-Patterns sections
- Test: manual — verify skill loads via `mcp__foreman__bundle_status`

**Phase 3 Checkpoint:** `cd foreman-mcp && npx vitest run`

### Phase 4: Integration + Version Bump

**Unit 4a — Version bump + changelog**
- Files: `foreman-mcp/package.json`, `foreman-mcp/src/server.ts`, `foreman-mcp/src/tools/changelog.ts`
- `package.json` line 3: `"version": "0.0.5"` -> `"version": "0.0.6"`
- `server.ts` line 37: `{ name: "foreman", version: "0.0.5" }` -> `{ name: "foreman", version: "0.0.6" }`
- `changelog.ts`: Add entry at index 0:
  ```typescript
  { version: "0.0.6", date: "2026-04-10", description: "Security hardening, cross-platform CLI, session journal — input length caps on all inline schemas, normalize_review schema extraction, error_log FIFO cap, path.isAbsolute() on CLI resolution, runTests hard memory cap and PATH resolution, cross-platform invoke_advisor tool (which/where), session journal for operational telemetry (pentest triage v0.0.5 deferred items)" },
  ```
- Test: `cd foreman-mcp && npx vitest run tests/tools.test.ts`

**Unit 4b — Test updates**
- Files: `foreman-mcp/tests/tools.test.ts`, `foreman-mcp/tests/integration.test.ts`, `foreman-mcp/tests/progress.test.ts`, `foreman-mcp/tests/runTests.test.ts`, `foreman-mcp/tests/writeTools.test.ts`
- `tools.test.ts`: Update `"0.0.5"` version assertions to `"0.0.6"`
- `integration.test.ts`: Update version assertion `"0.0.5"` -> `"0.0.6"`
- `progress.test.ts`: Add test: write 25 error_log entries, read file from disk, assert length is 20 (FIFO cap)
- `runTests.test.ts`: Add tests for: (a) hard memory cap kills process, (b) runner resolved to absolute path (mock via env allowlist + real which), (c) unresolvable runner returns error
- `writeTools.test.ts`: Add test: normalizeReview called via schema with >50K raw_text throws Zod error
- `journal.test.ts` (NEW): (a) initSession creates file + auto-fills env.os/node/foreman; (b) logEvent appends events; (c) endSession fills summary; (d) FIFO cap: 55 sessions → 50 on disk; (e) event cap: 201st event rejected; (f) rollup computed at 5+ sessions; (g) readJournal with last_n filter; (h) WriteJournalInputSchema rejects invalid event codes
- Pitfall: `runTests.test.ts` uses `FOREMAN_TEST_ALLOWLIST=node` for execution tests. PATH resolution will resolve `node` via `which` — this works. But the resolution adds ~3s per first-run test. Consider that tests already allow 10s timeouts.
- Pitfall: `integration.test.ts` line 31 asserts tool count `12` — must update to `15` (added write_journal + read_journal + invoke_advisor).
- Test: `cd foreman-mcp && npx vitest run`

**Phase 4 Checkpoint:** `cd foreman-mcp && npx vitest run` (full suite, all tests pass)
