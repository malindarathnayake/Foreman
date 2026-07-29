---
id: start-a-project
title: Start a project
sidebar_label: Start a project
description: One protocol per session, from design through phased implementation.
---

# Start a project

Use one protocol per session. For a new feature:

```text
Session 1:
design_partner({ "context": "Design the requested feature against this repository. Record unresolved decisions and do not implement it." })

Session 2, after approving the design:
spec_generator({ "context": "Generate the executable implementation documents from Docs/design-summary.md." })

Session 3:
pitboss_implementor({ "context": "Implement the approved spec one bounded unit at a time. Resume from Foreman state." })
```

For a surgical change:

```text
lighttask({ "context": "Ground this change against the current repository, implement it, validate it, and record the result." })
```

Your MCP client may display tool names with a namespace such as `mcp__foreman__design_partner`.

## Picking the right protocol

See [protocols](../concepts/protocols.md) for the full selection table, and [when Foreman pays for itself](../concepts/when-to-use-it.md) for whether the harness is worth its overhead on a given task.
