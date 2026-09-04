---
id: protocols
title: The six protocols
sidebar_label: The six protocols
description: What each protocol tool returns, what it produces, and which one to ask for.
---

# The six protocols

A protocol tool takes one argument, `context`, and returns a Markdown procedure. The host model reads it and follows it for the rest of the session. The MCP server does not execute the procedure and does not stop other tools from being called first. "One protocol per session" is how the procedures are written to be used, not a rule the server enforces.

`session_orient` is not a protocol. It is a state tool every procedure calls first.

| Protocol | Ask for it when | What it writes |
|---|---|---|
| `design_partner` | New behavior, unclear requirements, an architectural decision | `Docs/design-summary.md`, after you approve it |
| `spec_generator` | You have an approved design summary | `Docs/spec.md`, `handoff.md`, `PROGRESS.md`, `testing-harness.md`; seeds every phase and unit in the ledger |
| `pitboss_implementor` | You have a spec with more than one unit | Code, through workers; a ledger entry per unit; a review record per phase |
| `lighttask` | One small change you could describe in a sentence | The change itself, made directly; `Docs/lighttask.md` as the tracker |
| `spec_man` | An existing repo whose intended behavior is undocumented or stale | A specification, machine-readable or feature-level, with every claim cited to code, tests, or a requirement |
| `doc_man` | You need documentation of what exists | The requested documents, with unverifiable behavior labelled as such |

Picking:

```text
one small, clear change            -> lighttask
new feature                        -> design_partner, then spec_generator, then pitboss_implementor
spec already written, many units   -> pitboss_implementor
existing system, no reliable spec  -> spec_man
documentation                      -> doc_man
```

## What each one does

**`design_partner`** listens first, then asks 5 to 8 pointed scoping questions and stops for answers. It inspects the repo before proposing anything. Unresolved questions stay unresolved: it will not turn one into an implementation assumption. When the blocking ones are settled it writes the design summary and asks you to approve the file, not the conversation. Non-trivial ambiguities can be sent to two reviewer seats for deliberation; deadlocks come back to you.

**`spec_generator`** turns the summary into units. Each unit gets a directive naming the files, the behavior, the error handling, and the test command. It runs ten grounding checks against the repo (G1 to G10), for example: every external call has a row in the error-handling table, every test command exists, every test expectation agrees with its directive. Then it seeds the ledger with `declare_phase_units` and one `set_unit_status` per unit, runs `git check-ignore` on the state files and records the result in `handoff.md` as `state_tracking_policy`, and hands off. If blocking ambiguities remain, it refuses to hand off and lists them.

**`pitboss_implementor`** is the long one. Per unit: read the directive, read the source files, write a brief, run the brief preflight, record the delegation, spawn a worker, inspect every changed file, run the test command, record a verdict. Per phase: run the full suite, send the phase to reviewers, record findings, close the gate, end the session. See [A unit's life](./unit-life.md) and [Phase gates and reviews](./phase-gates.md). The model does not edit product code under this protocol, with one exception: a Direct Fix, a literal substitution after a rejection.

**`lighttask`** is the one protocol where the model edits directly. It grounds the change against the current code, makes it, validates it, and records it in `Docs/lighttask.md`. No workers, no phases, no ledger units unless the repo already has a ledger.

**`spec_man`** reads what exists and writes what was intended. It has a source priority: user requirements first, then existing specs, then code and tests. It has two output modes, a machine spec with a fixed section list (status, problem, target behavior, non-goals, user-visible behavior, system behavior, data contract, interfaces, acceptance criteria, risks) and a feature spec for one capability. A re-evaluation flow compares an existing spec to the code and rates the delta before proposing changes.

**`doc_man`** writes README, architecture, data-flow, or other requested documents from the code. It cites what it read. Behavior it could not verify is labelled, not asserted.

## Overriding a protocol

The procedures are bundled Markdown under `src/skills/` in the package. A file at `.claude/skills/<name>/SKILL.md` in the repo overrides the bundled one; `~/.claude/skills/<name>/SKILL.md` overrides that. Those paths are read under every host profile, not only Claude Code. `bundle_status` reports when an override is active. A stale override silently shadows a newer bundled protocol; see [Upgrading](../contributing/upgrading.md).
