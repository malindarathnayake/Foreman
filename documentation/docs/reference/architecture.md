---
id: architecture
title: Architecture
sidebar_label: Architecture
description: Runtime stack, dependency budget, and skill override precedence.
---

# Architecture

```text
TypeScript ESM
@modelcontextprotocol/server v2
Zod 4 Standard Schema validation
stdio transport with legacy + 2026-07-28 protocol negotiation
2 external production dependencies + 1 bundled first-party compression package
```

## Skill override precedence

```text
.claude/skills/<skill-name>/SKILL.md     project override
~/.claude/skills/<skill-name>/SKILL.md   user override
bundled skill                            package default
```

User overrides take precedence over bundled skills, so a stale override can silently shadow the current protocol. See [upgrading](../contributing/upgrading.md) if you are moving from an older personal override layout.

## Stack profiles

The `FOREMAN_STACK_PROFILE` setting or `Docs/foreman-stack-profile.md` can supply repository-specific security-framework and telemetry-backend conventions without forking the core protocols.

## Source layout

```text
foreman-mcp/src/server.ts       MCP server and tool registration
foreman-mcp/src/tools/          tool handlers
foreman-mcp/src/lib/            ledger, state, host, worker, and CLI helpers
foreman-mcp/src/skills/         bundled coding protocols
foreman-mcp/tests/              Vitest suite
```
