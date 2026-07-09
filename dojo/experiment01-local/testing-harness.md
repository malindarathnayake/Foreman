# Testing harness — `expr` (Foreman experiment-2)

## Archetype
Hermetic Node ESM + `node:assert`, zero dependencies (same rig as experiment 1). Pure functions →
table-driven assertions.

## Test tiers
| Tier | What | How | When |
|---|---|---|---|
| Unit (per category) | Each unit against the frozen contract | `node acceptance.test.mjs`, read `byCat.<unit>` | After each unit lands |
| Phase | Full pipeline + error codes | `node acceptance.test.mjs` → 53/53 | At phase checkpoint |

## Ground truth
`acceptance.test.mjs` — 53 assertions across tokenize(10)/parse(12)/evaluate(10)/calc(18)/errors(3).
Validated 53/53 against a reference implementation before use. HIDDEN from workers. `parse` cases use
hand-built Tokens and `evaluate` cases use hand-built Nodes, so each unit is scored independently of the
others' state.

## Quick reference
- Run: `DOJO=<experiment folder>; node "$DOJO/acceptance.test.mjs"` (imports `./src/*` relative to the test).
- Reset: `git checkout -- <experiment folder>/src` to restore skeletons.

## Operator questions
- Workers see the scorer? **No** — pit-boss-only ground truth.
- Deterministic? **Yes** — no time/random/network.
