---
id: state-and-recovery
title: Durable state and recovery
sidebar_label: State and recovery
description: Where Foreman keeps project state on disk, and how a fresh session reconstructs it.
---

# Durable state and recovery

State is stored relative to the MCP server's current working directory, which should be the target repository root:

```text
Docs/.foreman-ledger.json     phases, units, delegations, verdicts, gates, reviews
Docs/.foreman-progress.json   compact progress state
Docs/.foreman-journal.json    session history and rollups
Docs/.foreman-events.jsonl    hash-chained external-worker events, when used
Docs/PROGRESS.md              human run log with a ledger-synchronized checklist
```

Do not edit `.foreman-*` state files directly; use Foreman tools so validation and state invariants remain intact. `PROGRESS.md` is the human-facing, protocol-maintained run log.

## Starting a session

```text
session_orient
read_ledger({ "query": "full" })
read_progress
```

`session_orient` reports the current phase, last completed unit, next pending unit, blockers, stale gates, and unsupported host capabilities. Recovery starts from that state, not from a model's summary of an earlier conversation.
