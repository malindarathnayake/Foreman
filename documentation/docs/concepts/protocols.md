---
id: protocols
title: Protocols
sidebar_label: Protocols
description: One protocol per session, and how to pick the right one.
---

# Protocols

Activate one protocol for the job in the current session:

| Protocol | Use it for | Primary output |
|---|---|---|
| `lighttask` | A small, grounded change that can be completed directly | `Docs/lighttask.md` |
| `design_partner` | New behavior, unclear requirements, or architectural decisions | `Docs/design-summary.md` |
| `spec_generator` | Turning an approved design into implementation-ready documents | Spec, handoff, progress, and testing documents |
| `pitboss_implementor` | Multi-unit implementation from prepared specs | Implementation plus ledger-backed validation evidence |
| `spec_man` | Recovering or re-evaluating intended behavior in an existing repository | Human and machine-readable specifications |
| `doc_man` | Producing grounded technical documentation | README, architecture, data-flow, or other requested docs |

```text
small clear change       -> lighttask
unclear existing system  -> spec_man
new feature              -> design_partner -> spec_generator -> pitboss_implementor
prepared multi-unit spec -> pitboss_implementor
technical documentation -> doc_man
```

The protocols are inspectable bundled Markdown rendered for the active host. They can be overridden per project or per user — see [skill override precedence](../reference/architecture.md#skill-override-precedence).
