# Handoff — `expr` safe expression evaluator (Foreman experiment-2)

Implementor entry point. Full spec: `spec.md` (read first). Tracker: `PROGRESS.md`. Tests:
`testing-harness.md`.

## Project Overview
A 4-unit, dependency-free arithmetic evaluator (`tokenize → parse → evaluate → calc`) with frozen
interface contracts. Built twice under an Opus pit-boss with different worker pools (experiment01 = local
`reasoner-large` via `aider_worker`; experiment02 = Sonnet). Same spec, same gates, same hidden scorer.

## Before Starting
1. `mcp__foreman__read_ledger { query:"full" }` — position (single authority).
2. `mcp__foreman__read_progress` — checklist.
3. Read `spec.md` Implementation Order for the active unit; read the FROZEN contracts.

## Rules
- Pit-boss pattern: `set_unit_status ip` → build brief → `delegated` (brief ≥20 chars) → worker → validate
  → host-apply → run scorer → `set_verdict`. Orchestrator never writes implementation code.
- Workers get ONLY their unit brief + the frozen contracts + the `src/errors.mjs` contents. They never see
  `acceptance.test.mjs`.
- No dependencies. Node ESM. Node built-ins only.
- The Token and Node shapes are FROZEN — a unit that alters them is wrong (it breaks the next unit).
- Gate each unit on its `byCat` category; do not accept a unit whose category is not full.

## Implementation Order
U1 `tokenize` → U2 `parse` → U3 `evaluate` → U4 `calc`. Forward deps only. See `spec.md` for per-unit
directives, DO NOT lists, and test gates.

## Quick Reference
| Checkpoint | Command |
|---|---|
| Per unit | `node acceptance.test.mjs` → `byCat.<unit>` full |
| Phase | `node acceptance.test.mjs` → 53/53 |

| Error situation | Recovery |
|---|---|
| Category not full after worker | Fix brief with the failing cases (expected vs actual), re-delegate (outer cap 3) |
| Unit alters a frozen contract | Reject — it will break the downstream unit |
| Worker reimplements another unit | Reject — scope creep |

## Start
Seed ledger units U1–U4 `pending`, `set_phase_scope`, begin U1 per the pitboss pattern.
