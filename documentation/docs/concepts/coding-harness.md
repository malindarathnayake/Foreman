---
id: coding-harness
title: What "coding harness" means
sidebar_label: What a coding harness is
description: The seats in a Foreman run and who owns which decision.
---

# What "coding harness" means

A coding model edits files. A coding harness controls the development lifecycle around those edits.

| Seat | Responsibility |
|---|---|
| **User** | Owns product intent, scope decisions, overrides, and final authority |
| **Pitboss** | Frontier model that grounds the plan, scopes units, delegates work, validates results, and owns acceptance |
| **Foreman** | Supplies protocols, canonical state, evidence records, recovery, and mechanical gates |
| **Workers** | Host-native agents or configured worker backends that implement one bounded unit |
| **Advisors** | Separate reviewer seats used for design deliberation and checkpoint review |
| **Repository tools** | Compilers, tests, linters, and build commands that provide observable validation evidence |

During a phased implementation, the pitboss is kept out of product-code edits by protocol so its context remains available for integration and review. Workers receive a narrow brief and return a completion report or patch. The pitboss then re-reads the changed files, runs the repository's checks, compares the result with the specification, and records the verdict.

Under the protocol, workers do not accept their own units; the pitboss owns the verdict. The patch-worker tools cannot write verdicts. Worker engines are replaceable, while Foreman remains the authority for project state and completion.
