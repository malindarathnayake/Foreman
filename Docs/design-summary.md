# Design Summary — v0.0.6 Security Hardening Pass

## Problem

v0.0.5 pentest triage deferred 3 security items. Codex review found 5 additional gaps in the same risk class. All are in existing files, all are mechanical fixes. Ship as a hardening-only release.

## Approach

Three phases: (1) close all deferred items + inline schema caps, (2) harden `runTests` execution surface, (3) version bump + changelog + test updates. Phase 1 is all one-liners. Phase 2 adds new logic. Phase 3 is integration.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Release scope | Security-only, no features | Ship hardening fast, features on hardened base in v0.0.7 |
| `normalize_review` schema location | Extract to `types.ts` | Consistency — all other write schemas live there |
| `raw_text` cap tier | 50K (same as `brief`) | Carries full review output, same size class |
| `reviewer` cap | 200 chars | Just a name/label, no reason for 10K |
| `error_log` FIFO cap | 20 entries (match `rej[]`) | Consistent pattern across persistence layer |
| `path.isAbsolute()` failure mode | Return `null` (tool unavailable) | Safer than falling back to bare name |
| `last_n_completed` cap | `.min(1).max(100)` | Prevents truncation bypass, 100 is generous |
| `runTests` memory bound | Hard cap at `4 * maxOutputChars` per buffer | Middle ground: no O(N^2) streaming truncation, but prevents OOM. Kill process if exceeded. |
| `runTests` PATH resolution | Resolve via `which` + `isAbsolute()`, same as `capabilityCheck` | Consistent pattern. Cache in module-level Map. |
| `runTests` args caps | Array `.max(100)`, elements `.max(10000)` | Prevent unbounded arg injection |
| Prototype pollution fix | Skip — false positive | JSON.parse neutralizes `__proto__`. No `for...in` in codebase. |
| Inline schema consistency | Add `.max()` to all remaining inline string fields in `server.ts` | Same tier as `types.ts`: 10K for identifiers, enum/number fields get `.min()/.max()` |

## Architecture

No new files. No new tools. All changes are to existing modules.

```
server.ts          — inline schema caps on all tools
types.ts           — NormalizeReviewInputSchema (new), ReadLedgerInputSchema caps
progress.ts        — error_log FIFO cap on write
capabilityCheck.ts — path.isAbsolute() validation
runTests.ts        — hard memory cap, PATH resolution via which
changelog.ts       — v0.0.6 entry
package.json       — version bump
```

## Inline Schema Gap Inventory (server.ts)

| Tool | Field | Current | Fix |
|------|-------|---------|-----|
| changelog | `since_version` | `z.string().optional()` | `.max(20)` |
| read_ledger | `unit_id` | `z.string().optional()` | `.max(10000)` |
| read_ledger | `phase` | `z.string().optional()` | `.max(10000)` |
| read_progress | `last_n_completed` | `z.number().optional()` | `.min(1).max(100)` |
| write_ledger | `unit_id` | `z.string().optional()` | `.max(10000)` |
| write_ledger | `phase` | `z.string().optional()` | `.max(10000)` |
| normalize_review | `reviewer` | `z.string()` | `.max(200)` |
| normalize_review | `raw_text` | `z.string()` | `.max(50000)` |
| run_tests | `runner` | `z.string().min(1)` | `.max(50)` |
| run_tests | `args` | `z.array(z.string()).default([])` | `z.array(z.string().max(10000)).max(100).default([])` |
| pitboss_implementor | `context` | `z.string().optional()` | `.max(10000)` |
| design_partner | `context` | `z.string().optional()` | `.max(10000)` |
| spec_generator | `context` | `z.string().optional()` | `.max(10000)` |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `which` returns non-absolute path | `resolveCliPath` returns `null` -> tool unavailable |
| `which` returns empty/fails | `resolveCliPath` returns `null` -> tool unavailable |
| `runTests` buffer exceeds hard cap | Process killed (SIGTERM then SIGKILL), return partial output with `truncated: true` |
| `error_log` exceeds 20 entries | FIFO: `error_log = error_log.slice(-20)` after push |
| Zod `.max()` exceeded on any field | MCP framework returns validation error to caller |
| `normalize_review` with 50K+ `raw_text` | Zod rejects before handler runs |

## Testing Strategy

- **Archetype:** Unit tests with real child_process spawns (existing pattern)
- **Mock boundaries:** None — real spawns, real file I/O, temp directories
- **Critical path:** error_log FIFO cap on disk (not just display), runTests hard memory cap, isAbsolute validation

### Test Changes Required

| Test File | Change | Why |
|-----------|--------|-----|
| `progress.test.ts` | Add test: 25 error_log entries -> file has 20 on disk | Currently only tests display truncation (slice -5) |
| `tools.test.ts` | Add test: capabilityCheck rejects non-absolute which output | New behavior |
| `tools.test.ts` | Update version assertion `0.0.5` -> `0.0.6` | Version bump |
| `runTests.test.ts` | Add test: buffer exceeding hard cap kills process | New behavior |
| `runTests.test.ts` | Add test: runner resolved to absolute path before spawn | New behavior |
| `integration.test.ts` | Update version assertion `0.0.5` -> `0.0.6` | Version bump |
| `writeTools.test.ts` | Add test: normalize_review rejects >50K raw_text | New schema cap |

## Scope

**In scope:**
- Close INJ-004 (normalize_review caps)
- Close EXH-002 (error_log FIFO + remaining inline caps)
- Close INJ-005 (path.isAbsolute on resolveCliPath)
- Cap all uncapped inline schemas in server.ts
- ReadLedgerInputSchema caps in types.ts
- runTests hard memory cap
- runTests PATH resolution for runners
- runTests args array/element caps
- Version bump to 0.0.6 + changelog

**Out of scope:**
- Read-path escaping for stored prompt injection (INJ-004 full fix — v0.0.7)
- runTests subcommand restrictions (overengineered for LLM-called tool)
- Streaming truncation in runTests (explicit v0.0.5 design decision)
- Prototype pollution defense (`JSON.parse` already neutralizes — false positive)
- New features or tools

## Phasing

### Phase 1: Deferred Items + Schema Caps (mechanical one-liners)
- 1a: Extract `NormalizeReviewInputSchema` to types.ts, cap `reviewer` at 200, `raw_text` at 50K. Update server.ts to use it.
- 1b: Cap `error_log` at 20 FIFO in progress.ts (after push, same pattern as rej[])
- 1c: Add `path.isAbsolute()` check in capabilityCheck.ts resolveCliPath. Return null if not absolute.
- 1d: Cap `ReadLedgerInputSchema` fields in types.ts. Cap all remaining inline schemas in server.ts (see inventory table above).

### Phase 2: runTests Hardening (new logic)
- 2a: Hard memory cap — if either buffer exceeds `4 * maxOutputChars`, kill the process and return truncated output.
- 2b: Runner PATH resolution — resolve runner via `which` + `isAbsolute()` before spawn, cache in module-level Map (same pattern as capabilityCheck).

### Phase 3: Integration + Version Bump
- 3a: Version bump to 0.0.6 in package.json and server.ts McpServer constructor.
- 3b: Changelog entry in changelog.ts.
- 3c: Update test assertions (version strings, tool count if changed).

## Open Items

| Item | Status | Blocking |
|------|--------|----------|
| None | — | — |

## Source: Codex x Claude Deliberation

Codex reviewed 8 findings. Claude independently verified each:
- 3 CONFIRMED at original severity (EXH-002, INJ-004, INJ-005)
- 2 CONFIRMED but downgraded (runTests memory, runTests execution surface)
- 1 REJECTED as false positive (prototype pollution)
- 2 CONFIRMED as LOW additions (ReadLedgerInputSchema, last_n_completed)
- 3 CLAUDE-ONLY additions (changelog, run_tests args, skill context caps)
