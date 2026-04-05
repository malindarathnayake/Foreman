# Foreman MCP - Implementation Handoff

## Project Overview

Implement the Foreman MCP server — an MCP-owned workflow orchestrator that delivers planning and implementation skills with helper tools. This handoff covers the 5 architecture remediation items that harden the foundation before building the full workflow.

**Read the full spec:** `Docs/foreman/spec.md`
**Read the design summary:** `Docs/foreman/design-summary.md`

---

## Before Starting: Check Progress

**On every session start:**
1. Check `Docs/foreman/PROGRESS.md` for current state
2. Scan existing files in `foreman-mcp/` to verify progress
3. Run `npx vitest run` from `foreman-mcp/` to check test status
4. Resume from next incomplete item in PROGRESS.md

---

## Rules

**During implementation:**
1. After each file, write tests for it
2. Run tests before proceeding to the next unit
3. Update `Docs/foreman/PROGRESS.md` after each unit
4. Stop for review after each testable unit
5. No features beyond the spec — these are 5 targeted remediation items
6. Ask if ambiguous — don't guess
7. Error handling is mandatory on every external call and file operation
8. Start new chat after checkpoints
9. Never silently retry failures — log to PROGRESS.md, change approach
10. **Ledger format is compact JSON** — `JSON.stringify(data)` with NO pretty-print. Short keys (`s`, `v`, `ts`, `rej`). Token savings are critical.
11. **TOON format for MCP tool output** — key/value lines for status, pipe-delimited tables for lists. See spec for format details.

---

## Implementation Order

### Phase 1: Foundation (Types, Ledger, Progress)

**What it enables:** All other phases depend on the ledger and progress core. These are the serialization-safe primitives.

**Unit 1a: Types and ledger core**
1. `foreman-mcp/src/types.ts` — All shared types
   - `LedgerFile`, `Phase`, `Unit`, `Rejection` with compact key names (`s`, `v`, `w`, `rej`)
   - Zod schemas for MCP tool input validation
   - `ProgressFile`, `TruncatedView`, `StatusSummary`
   - Operation discriminated unions for `write_ledger` and `write_progress`
2. `foreman-mcp/src/lib/ledger.ts` — Ledger read/write with async mutex
   - Promise-chain mutex (see spec for pattern)
   - Read: `readFile` → `JSON.parse` with corruption recovery
   - Write: `JSON.stringify(data)` → write `.tmp` → `rename` (atomic)
   - Auto-create on first access if missing
   - **Pitfall:** Do NOT use `writeFile` directly — always write-to-tmp-then-rename for atomicity
3. `foreman-mcp/tests/ledger.test.ts`
   - 10 concurrent writes → all succeed, no data loss
   - Corrupt file → recovery, fresh ledger
   - Missing file → auto-create
   ```bash
   cd foreman-mcp && npx vitest run tests/ledger.test.ts
   ```

**Unit 1b: Progress core with truncation**
1. `foreman-mcp/src/lib/progress.ts` — Progress read/write with truncation
   - Separate mutex instance from ledger
   - Truncation: last N completed (sorted by timestamp desc) + ALL incomplete + last 5 errors
   - After JSON write, regenerate human-readable `Docs/PROGRESS.md` markdown
   - **Pitfall:** Don't parse existing markdown PROGRESS.md — the JSON state is authoritative
2. `foreman-mcp/tests/progress.test.ts`
   - 50 completed + 5 incomplete, truncated to 10 + 5
   - 0 completed → only incomplete shown
   - Error log capped at 5
   ```bash
   cd foreman-mcp && npx vitest run tests/progress.test.ts
   ```

**CHECKPOINT:**
```bash
cd foreman-mcp && npx vitest run tests/ledger.test.ts tests/progress.test.ts
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

---

### Phase 2: External CLI Runner

**Depends on:** Nothing (independent module)
**What it enables:** Phase 3 capability_check tool

**Unit 2a: External CLI execution with timeout**
1. `foreman-mcp/src/lib/externalCli.ts` — Spawn with timeout + stdin redirect
   - `child_process.spawn` (NOT `exec`)
   - Close stdin immediately (`child.stdin.end()`)
   - SIGTERM on timeout, SIGKILL after 5s grace
   - Return `{ stdout, stderr, timedOut, exitCode }`
   - **Pitfall:** Do NOT use `shell: true` — direct exec avoids shell injection
   - **Pitfall:** Do NOT use `</dev/null` in the command string — close stdin programmatically
2. `foreman-mcp/tests/externalCli.test.ts`
   - Normal completion → full output, `timedOut: false`
   - Timeout → killed, partial output, `timedOut: true`
   - Missing binary → graceful ENOENT error
   - Stdin closed verification
   ```bash
   cd foreman-mcp && npx vitest run tests/externalCli.test.ts
   ```

**CHECKPOINT:**
```bash
cd foreman-mcp && npx vitest run tests/
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

---

### Phase 3: MCP Tools

**Depends on:** Phase 1 (ledger, progress), Phase 2 (externalCli)
**What it enables:** Phase 4 (server wiring)

**Unit 3a: TOON serializer + read-only tools**
1. `foreman-mcp/src/lib/toon.ts` — Two functions only
   - `toKeyValue(record: Record<string, string>)` → `key: value\n` lines
   - `toTable(headers: string[], rows: string[][])` → pipe-delimited table
   - No classes, no config, no options
2. `foreman-mcp/src/tools/bundleStatus.ts` — Version check + override info
   - Read package.json for bundle version
   - Include OVERRIDE INFO section (see spec Change 5)
   - Output via `toKeyValue`
3. `foreman-mcp/src/tools/changelog.ts` — Static changelog array, filter by `since_version`
4. `foreman-mcp/src/tools/readLedger.ts` — Delegate to `lib/ledger.ts`, format via TOON
5. `foreman-mcp/src/tools/readProgress.ts` — Delegate to `lib/progress.ts` truncation
6. `foreman-mcp/src/tools/capabilityCheck.ts` — Health check via `lib/externalCli.ts` (15s timeout)

**Unit 3b: Write tools + review normalizer**
1. `foreman-mcp/src/tools/writeLedger.ts` — Zod-validated input → `lib/ledger.ts`
2. `foreman-mcp/src/tools/writeProgress.ts` — Zod-validated input → `lib/progress.ts`
3. `foreman-mcp/src/tools/normalizeReview.ts` — Parse raw review text → structured findings

**CHECKPOINT:**
```bash
cd foreman-mcp && npx vitest run tests/
```
**-> NEW CHAT after passing. Update PROGRESS.md first.**

---

### Phase 4: MCP Server Wiring

**Depends on:** Phase 3 (all tools)
**What it enables:** Full Foreman MCP server ready for Claude Code integration

**Unit 4a: Server setup and skill delivery**
1. `foreman-mcp/src/server.ts` — MCP server with all tools + skill resources
   - `@modelcontextprotocol/sdk` Server class, stdio transport
   - Register all tools via `ListToolsRequestSchema`
   - Register skill:// resources via `ListResourcesRequestSchema`
   - Serve `src/skills/*.md` as resources
   - **Critical:** Do NOT expose `update_bundle` as a tool
2. `foreman-mcp/src/skills/project-planner.md` — Stub with frontmatter + ledger prohibition
3. `foreman-mcp/src/skills/implementor.md` — Stub with frontmatter + ledger prohibition
4. `foreman-mcp/tests/integration.test.ts`
   - Connect → list tools → verify all 8 tools present, `update_bundle` absent
   - Connect → list resources → verify `skill://foreman/*` URIs
   - write_ledger → read_ledger round-trip
   ```bash
   cd foreman-mcp && npx vitest run tests/integration.test.ts
   ```

**FINAL:**
```bash
cd foreman-mcp && npx vitest run
```
**-> Deliver to user. Implementation complete.**

---

## Testing Strategy

### Archetype: Infrastructure Tool (MCP Server)

See `Docs/foreman/testing-harness.md` for environment-specific test execution.

### Mock Boundaries

| Dependency | Mock Strategy |
|------------|---------------|
| Filesystem | Real filesystem in vitest `tmpdir` |
| External CLIs | Mock `child_process.spawn` |
| MCP SDK | Real SDK test client for integration; mock for unit tests |

### Coverage Targets

| Package | Target | Focus |
|---------|--------|-------|
| `src/lib/` | 90% | mutex, corruption, concurrency |
| `src/tools/` | 70% | input validation, output format |
| `src/server.ts` | 50% | startup, registration |

---

## Quick Reference

### Checkpoint Commands
| Phase | Command |
|-------|---------|
| 1 | `cd foreman-mcp && npx vitest run tests/ledger.test.ts tests/progress.test.ts` |
| 2 | `cd foreman-mcp && npx vitest run tests/` |
| 3 | `cd foreman-mcp && npx vitest run tests/` |
| 4 (FINAL) | `cd foreman-mcp && npx vitest run` |

### Error Recovery Protocol
| Attempt | Action |
|---------|--------|
| 1 | Diagnose root cause, apply targeted fix |
| 2 | Different approach — same error means wrong strategy |
| 3 | Question assumptions, check docs/examples |
| 4+ | **STOP** — log to Error Recovery Log in PROGRESS.md, escalate to user |

---

## Start

**First session?**
1. Create `foreman-mcp/` directory with `package.json` and `tsconfig.json`
2. `npm install @modelcontextprotocol/sdk vitest typescript @types/node`
3. Begin with Unit 1a (types + ledger)

**Resuming?**
1. Read `Docs/foreman/PROGRESS.md`
2. Verify with `ls foreman-mcp/src/`
3. Run checkpoint for current phase
4. Continue from next incomplete item
