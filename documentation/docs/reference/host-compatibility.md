---
id: host-compatibility
title: Host compatibility
sidebar_label: Host compatibility
description: Supported MCP hosts, their status, and the caveats that matter per host.
---

# Host compatibility

| Host | Status | Important caveat |
|---|---|---|
| Claude Code | Primary profile | Native workers use the host's Agent capability; advisor CLIs are optional |
| Cursor | Rendered profile and tested capability path | No declared autonomy capability; phase progression remains interactive |
| Codex | Native subagent profile with parallel fan-out | `spawn_agent` model selection is host-owned; Luna is preferred but only confirmed routing may be recorded. Fan-out is capped by `agents.max_threads` with `max_depth=1`. Claude Fable 5 max and Gemini provide independent review |
| Generic MCP host | Declared six-capability contract | The operator must verify the host against [HOST-CONTRACT.md](https://github.com/malindarathnayake/Foreman/blob/main/foreman-mcp/HOST-CONTRACT.md) |

Unsupported capabilities are reported by `host_status` and `session_orient` with their documented degradation.
