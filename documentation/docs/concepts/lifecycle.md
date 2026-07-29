---
id: lifecycle
title: The development lifecycle
sidebar_label: The lifecycle
description: Design, executable spec, bounded delegation, inspection, and phase gates.
---

# The development lifecycle

## 1. Design with the repository in the room

`design_partner` clarifies the problem, inspects the current system, exposes architectural and security decisions, records decisions and rationale, and produces `Docs/design-summary.md` for user approval.

The design is collaborative. Foreman does not silently convert unresolved questions into implementation assumptions.

## 2. Turn decisions into an executable spec

`spec_generator` converts the approved design into:

```text
Docs/spec.md              behavior, contracts, phases, and bounded units
Docs/handoff.md           session-start and recovery instructions
Docs/PROGRESS.md          human-readable implementation state
Docs/testing-harness.md   validation strategy and commands
```

Dependencies, ordering, unit scope, and phase checkpoints are explicit before code is written.

## 3. Delegate bounded implementation

`pitboss_implementor` grounds the next unit against the live repository and creates the smallest brief that can be implemented and tested independently. The worker gets the unit, relevant source context, constraints, and expected completion-report shape. It does not need to own the project plan.

## 4. Inspect, test, and reject

Worker claims are inputs, not verdicts. The protocol requires the pitboss to inspect the actual files, run focused validation, check specification fidelity and integration seams, and re-delegate concrete fixes when the work is wrong.

Independent advisor output can be normalized, classified, cited, and recorded at design or phase boundaries. When an independent seat is unavailable, the protocol records that limitation instead of pretending self-review is independent.

## 5. Gate the phase and resume from disk

Under the protocol, a phase closes only after its units carry passing verdicts and its checkpoint is accepted. The protocol then calls for a context reset before the next phase. `session_orient` reconstructs ledger state, so a fresh session does not have to infer reality from chat history.
