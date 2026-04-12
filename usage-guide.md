# Usage Guide — Building a CLI Expense Tracker

This walkthrough shows the full Foreman pipeline using a real project: a Node.js CLI expense tracker with 4 commands (`add`, `list`, `summary`, `export`), JSON persistence, and zero runtime dependencies. This is the same app used in Foreman's AB test suite.

## Prerequisites

- Claude Code (or any MCP-compatible agent running Opus)
- Foreman MCP installed and configured (see [Quick Start](README.md#quick-start))
- A new project directory:
  ```bash
  mkdir expense-tracker && cd expense-tracker
  npm init -y
  npm install -D typescript vitest @types/node
  ```

## Stage 1: Design

Open Claude Code in your project directory and call the design partner:

```
> Call the foreman design_partner tool. I want to build a CLI expense tracker.
```

Foreman returns the design partner protocol. The LLM will:
- Ask scoping questions ("What commands?", "How do you store data?", "What's out of scope?")
- Push back on vague requirements ("You said 'handle errors appropriately' — what does that mean for a corrupt data file?")
- Use YIELD directives to pause and wait for your answers
- Escalate non-trivial ambiguities to Codex/Gemini deliberation

You work through the design interactively until all decisions are made. The output is a `Docs/design-summary.md` that captures:
- Problem statement
- Architecture and file structure
- Key decisions table (money storage, date format, error handling, etc.)
- Scope boundaries (in/out)
- Testing archetype

**This is the most important stage.** A good design summary produces a good spec. A vague one produces a spec full of gaps.

## Stage 2: Spec

Once your design summary is complete:

```
> Call the foreman spec_generator tool.
  Context: Design summary at Docs/design-summary.md
```

The spec generator reads your design summary and produces four documents:

| Document | Purpose |
|----------|---------|
| `Docs/spec.md` | Full implementation spec — architecture, behavior, error handling, testing strategy, implementation order with phases and units |
| `Docs/handoff.md` | Implementation instructions — what to do first, checkpoints, pitfalls |
| `Docs/PROGRESS.md` | Progress tracker — checklist, session log, error recovery |
| `Docs/testing-harness.md` | Test strategy — archetypes, mock boundaries, tier structure |

It also seeds the Foreman ledger with your phase/unit structure:

```
Phase 1: Foundation (types, validation, storage)
Phase 2: Commands (add, list, summary, export)
Phase 3: CLI Entry + Integration
```

**Stop here and review.** Read `spec.md` carefully. This is the contract the pitboss will enforce. If the spec says "round to 2 decimal places using `Math.round(amount * 100) / 100`" — that's exactly what the worker will implement and the pitboss will validate. Fix any issues in the spec before proceeding.

## Stage 3: Implement

Once the spec is right:

```
> Call the foreman pitboss_implementor tool.
  Context: Spec at Docs/spec.md, handoff at Docs/handoff.md. Start from Phase 1.
```

The pitboss takes over. For each unit it:

1. **Reads the unit spec** from handoff.md
2. **Reads existing source files** to build context
3. **Builds a worker brief** — only the information this worker needs, not the full spec
4. **Spawns a Sonnet worker** via the Agent tool
5. **Validates independently** — reads every modified file, re-runs tests, checks against spec
6. **Records the verdict** in the ledger via `write_ledger`

You watch the pitboss work. For the expense tracker, it spawns 7 workers across 3 phases:

```
Phase 1: types.ts + validate.ts → storage.ts                    (2 workers)
Phase 2: add.ts → list.ts → summary.ts → format.ts + export.ts  (4 workers)
Phase 3: main.ts + bin/expense.ts + cli.test.ts                  (1 worker)
```

At each phase boundary, the pitboss runs the full test suite and (if Codex/Gemini are installed) sends the phase changes for independent review before flipping the phase gate.

## What You Get

After the pipeline completes:

```
expense-tracker/
  bin/expense.ts           # CLI entry point
  src/
    main.ts                # Arg parser + command dispatch
    types.ts               # Expense interface, path constants
    validate.ts            # Amount, date, month validation
    storage.ts             # JSON file read/write/backup
    format.ts              # CSV/JSON formatters
    commands/
      add.ts, list.ts, summary.ts, export.ts
  tests/
    validate.test.ts, storage.test.ts, add.test.ts,
    list.test.ts, summary.test.ts, export.test.ts, cli.test.ts
  Docs/
    design-summary.md, spec.md, handoff.md, PROGRESS.md, testing-harness.md
    .foreman-ledger.json   # Full audit trail
    .foreman-progress.json # Progress state
```

**7 test files. 66-80 tests (worker variance). 100% pass rate. Zero runtime dependencies.**

The ledger records every status change, delegation, verdict, and phase gate — a complete audit trail of how the code was built.
