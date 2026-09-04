---
id: what-foreman-enforces
title: What Foreman enforces
sidebar_label: What Foreman enforces
description: The checks that are TypeScript rather than prompt text, and the honest boundary of what they prove.
---

# What Foreman enforces

Foreman deliberately separates **protocol obligations** from **mechanical enforcement**.

The protocols direct the pitboss to ground briefs, keep implementation in worker seats, inspect changes, run the right tests, perform review, and reset context at phase boundaries. Host-native isolation and compliance with those instructions depend on the host and model.

The MCP server enforces the parts that can be checked deterministically:

- a unit cannot receive a passing verdict before a recorded delegation with a brief of at least 20 characters
- a delegation cannot be recorded without the brief-preflight attestation (`symbols_grepped`, `self_consistent: true`), which is stored on the delegation entry
- a rejected write returns one hint per field plus the operation's expected data shape, never a raw validator dump
- a phase cannot pass while any unit lacks a passing verdict, and an empty phase cannot pass
- a phase cannot pass with zero recorded advisor reviews; an explicit user override is recorded on the phase
- rejecting a unit that already passed reopens it to `pending` — a passed unit cannot stay gate-passable while under remediation
- a pass without tests or a build requires an attestation of at least 5 words and 32 characters
- a fourth delegation after three distinct rejected attempts requires an explicit user override
- a passed gate becomes stale when one of its units changes afterward
- phases marked `hot_path` or `security_boundary` require a declared frontier-class seat or explicit override
- external-worker sidecar outcomes cannot contradict the ledger's claimed result without blocking the gate
- a corrupt ledger reports itself instead of silently appearing to be a fresh project

Example refusals:

```text
VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation.

PHASE GATE BLOCKED: phase 'P2' has units without a pass verdict: U5.

ATTESTATION REQUIRED: phase 'P4' declares has_tests:false.
```

These checks are TypeScript code, not instructions that disappear during compaction.

## What that looks like mid-session

The pitboss tries to accept its own direct edit, gets blocked, and is forced back into the delegation lane:

```text
pitboss:  write_ledger({ operation: "set_verdict", phase: "P2", unit_id: "U4",
                         data: { v: "pass" } })
foreman:  VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation.
          Call mcp__foreman__pitboss_implementor to load the full protocol.

pitboss:  write_ledger({ operation: "set_unit_status", phase: "P2", unit_id: "U4",
                         data: { s: "delegated", brief: "Add cursor pagination to
                         GET /orders; keep response shape; test: npm t -- orders",
                         tier: "standard", route_reason: "bounded, fully specified" } })
foreman:  ok
          -> worker implements, pitboss re-reads files + runs tests, then records the verdict
```

## The honest boundary

Foreman cannot prove that a model is truthful or that passing tests imply correct software. It proves that declared workflow transitions occurred, preserves evidence explicitly recorded in its state, and makes certain missing or contradictory records visible. A host can skip Foreman entirely; such a run simply produces no Foreman record.
