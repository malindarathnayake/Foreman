# PROGRESS — `expr` (Foreman experiment-2)

Spec: `spec.md` · Handoff: `handoff.md` · Harness: `testing-harness.md`

## Current Status
| Field | Value |
|---|---|
| Phase | `exp01-calc` / `exp02-calc` — one phase each, 4 units |
| Units | U1 tokenize · U2 parse · U3 evaluate · U4 calc |
| Blocked | none |
| Proportionality | standard (all units) |

## Checklist (per experiment)
- [ ] U1 `tokenize` — `src/tokenize.mjs` — gate `byCat.tokenize` 10/10
- [ ] U2 `parse` — `src/parse.mjs` — gate `byCat.parse` 12/12
- [ ] U3 `evaluate` — `src/evaluate.mjs` — gate `byCat.evaluate` 10/10
- [ ] U4 `calc` — `src/calc.mjs` — gate `byCat.calc` 18/18 + `byCat.errors` 3/3
- [ ] Phase checkpoint — 53/53

## Decisions & Notes
| Decision | Value | Source |
|---|---|---|
| Frozen contracts | Token + Node shapes fixed in spec | design-summary |
| `^` binds tighter than unary `-` | `-2^2 = -4` | design-summary |
| `^` right-assoc | `2^3^2 = 512` | design-summary |
| `/0` → DIVZERO | throw, never Infinity | design-summary |
| Depth bound 50 | paren nesting → DEPTH | design-summary |

## Session Log
| Date | Phase | Unit | Outcome | Notes |
|---|---|---|---|---|
| 2026-07-08 | — | spec | done | design_partner + spec_generator; scorer validated 53/53 vs reference |

## Context Management
| Question | Answer from |
|---|---|
| Where am I? | ledger phase/unit |
| Where going? | this checklist |
| Goal? | spec Intent |
| Tried? | ledger delegations |
| Failed? | ledger rejections |

## Environment Notes
Node ≥ 22; no deps. Test: `node acceptance.test.mjs` (hidden). experiment01 workers = local reasoner-large
via `aider_worker`; experiment02 workers = Sonnet 5.
