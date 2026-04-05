# Foreman MCP - Architecture Remediation Progress

## Current Status
**Phase:** 4 - MCP Server Wiring — CHECKPOINT PASSED (FINAL)
**Last Completed:** Unit 4a — MCP server + skill stubs + integration tests (with Codex fix)
**Next Up:** DELIVER to user — Implementation complete
**Blocked:** none

---

## Checklist

### Phase 1: Foundation (Types, Ledger, Progress)
- [x] `foreman-mcp/src/types.ts` — Shared types + Zod schemas
- [x] `foreman-mcp/src/lib/ledger.ts` — Ledger read/write with async mutex
- [x] `foreman-mcp/tests/ledger.test.ts` — Mutex, corruption, concurrent writes (7/7 pass)
- [x] `foreman-mcp/src/lib/progress.ts` — Progress read/write with truncation
- [x] `foreman-mcp/tests/progress.test.ts` — Truncation algorithm (9/9 pass)
- [x] **CHECKPOINT:** `cd foreman-mcp && npx vitest run tests/ledger.test.ts tests/progress.test.ts` (16/16 pass)
- [x] **Codex review:** 3 findings — 1 CONFIRMED+FIXED, 2 REJECTED
- [x] **-> NEW CHAT** after checkpoint passes

### Phase 2: External CLI Runner
- [x] `foreman-mcp/src/lib/externalCli.ts` — Spawn with timeout + stdin close
- [x] `foreman-mcp/tests/externalCli.test.ts` — Timeout, ENOENT, stdin, partial output (6/6 pass)
- [x] **CHECKPOINT:** `cd foreman-mcp && npx vitest run tests/` (22/22 pass)
- [x] **Codex review:** 2 findings — 2 CONFIRMED+FIXED (test strengthening)
- [x] **-> NEW CHAT** after checkpoint passes

### Phase 3: MCP Tools
- [x] `foreman-mcp/src/lib/toon.ts` — TOON serializer (toKeyValue, toTable)
- [x] `foreman-mcp/src/tools/bundleStatus.ts` — Version check + override info
- [x] `foreman-mcp/src/tools/changelog.ts` — Static changelog
- [x] `foreman-mcp/src/tools/readLedger.ts` — Ledger query
- [x] `foreman-mcp/src/tools/readProgress.ts` — Truncated progress
- [x] `foreman-mcp/src/tools/capabilityCheck.ts` — External CLI detection
- [x] `foreman-mcp/src/tools/writeLedger.ts` — Serialized ledger mutations
- [x] `foreman-mcp/src/tools/writeProgress.ts` — Progress updates
- [x] `foreman-mcp/src/tools/normalizeReview.ts` — Review result ingestion
- [x] **CHECKPOINT:** `cd foreman-mcp && npx vitest run tests/` (73/73 pass)
- [x] **Codex review:** 4 findings — 1 CONFIRMED+FIXED, 3 REJECTED
- [x] **-> NEW CHAT** after checkpoint passes

### Phase 4: MCP Server Wiring
- [x] `foreman-mcp/src/server.ts` — MCP server + tool registration + skill resources
- [x] `foreman-mcp/src/skills/project-planner.md` — Planner skill stub
- [x] `foreman-mcp/src/skills/implementor.md` — Implementor skill stub
- [x] `foreman-mcp/tests/integration.test.ts` — Round-trip tests (10/10 pass)
- [x] **FINAL:** `cd foreman-mcp && npx vitest run` (83/83 pass)
- [x] **Codex review:** 3 findings — 2 CONFIRMED+FIXED, 1 REJECTED
- [x] **-> DELIVER** to user

---

## Decisions & Notes

| Date | Decision/Note |
|------|---------------|
| 2026-04-02 | Architecture Council review completed. 5 remediation items identified. |
| 2026-04-02 | Ledger: compact JSON (minified, short keys) for token savings. |
| 2026-04-02 | MCP tool output: TOON format (key/value + tables) for LLM consumption. |
| 2026-04-02 | `update_bundle` removed as MCP tool — user CLI command only. |
| 2026-04-02 | Serialization: in-process async mutex, not filesystem locks. |
| 2026-04-02 | External CLI timeout: 120s default, 15s for health checks. |
| 2026-04-02 | Progress truncation: last 10 completed + all incomplete + last 5 errors. |
| 2026-04-02 | Ledger is THE workflow authority; host plan/task state is ephemeral per-session. (Codex finding) |
| 2026-04-02 | Implementor must run via SkillTool only, not slash-command — permissions don't survive compaction. (Codex finding) |
| 2026-04-04 | readLedger query:full returns JSON — design policy says JSON for deeply nested data. |
| 2026-04-04 | Skills path: fallback from dist/skills/ to ../src/skills/ for production compatibility. (Codex finding) |

---

## Session Log

| Date | Phase | Work Done | Result | Notes |
|------|-------|-----------|--------|-------|
| 2026-04-02 | 1 | Unit 1a: types.ts + ledger.ts + tests | 7/7 pass | Worker a3b71, accepted first try |
| 2026-04-02 | 1 | Unit 1b: progress.ts + tests | 9/9 pass | Worker a3cd2, accepted first try |
| 2026-04-02 | 1 | Codex review + fix (phase name drift) | 16/16 pass | Fix worker a03b9, 1 MEDIUM finding fixed |
| 2026-04-02 | 1 | Phase 1 checkpoint | ALL GATES PASS | G1-G4 pass, Codex complete |
| 2026-04-03 | 2 | Unit 2a: externalCli.ts + tests | 6/6 pass | Worker a63dfd1, accepted first try |
| 2026-04-03 | 2 | Codex review + fix (test hardening) | 22/22 pass | 2 MEDIUM/LOW findings fixed — partial output + stdin guard |
| 2026-04-03 | 2 | Phase 2 checkpoint | ALL GATES PASS | G1-G4 pass, Codex complete |
| 2026-04-04 | 3 | Unit 3a: toon.ts + 5 read-only tools + tests | 50/50 pass | Worker af375, accepted first try |
| 2026-04-04 | 3 | Unit 3b: writeLedger + writeProgress + normalizeReview + tests | 71/71 pass | Worker a1778, accepted first try |
| 2026-04-04 | 3 | Codex review + fix (normalizeReview parser) | 73/73 pass | 1 MEDIUM finding fixed — parser line-start anchor + desc accumulation |
| 2026-04-04 | 3 | Phase 3 checkpoint | ALL GATES PASS | G1-G4 pass, Codex complete |
| 2026-04-04 | 4 | Unit 4a: server.ts + skills + integration tests | 82/82 pass | Worker a9868, accepted first try |
| 2026-04-04 | 4 | Codex review + fix (skills path + test coverage) | 83/83 pass | 2 findings fixed — skills path fallback + implementor test |
| 2026-04-04 | 4 | Phase 4 checkpoint (FINAL) | ALL GATES PASS | G1-G4 pass, Codex complete |

---

## Error Recovery Log

| Date | What Failed | Why | Next Approach |
|------|-------------|-----|---------------|

**Protocol:**
- Attempt 1: Diagnose, targeted fix
- Attempt 2: Different approach (same error = wrong strategy)
- Attempt 3: Question assumptions, check docs
- Attempt 4+: **STOP** — escalate to user with this log

---

## Context Management

### New Chat Startup Protocol
| Question | Answer Source |
|----------|---------------|
| Where am I? | Current Status -> Phase |
| Where am I going? | Checklist -> remaining items |
| What's the goal? | spec.md -> Intent |
| What have I tried? | Session Log |
| What failed? | Error Recovery Log |

### New Chat Policy
Start a fresh chat after each CHECKPOINT passes.

---

## Environment Notes
- **Platform:** macOS Darwin 25.4.0
- **Runtime:** Node.js (via nvm, v24.14.0)
- **Test framework:** vitest
- **Package manager:** npm
- **MCP SDK:** @modelcontextprotocol/sdk v1.29.0
