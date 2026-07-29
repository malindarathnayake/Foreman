---
id: configure-mcp-host
title: Configure an MCP host
sidebar_label: Configure an MCP host
description: Claude Code, Cursor, Codex, and generic MCP host configuration, including Windows shims.
---

# Configure an MCP host

## Claude Code or another Claude-style MCP host

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

## Cursor

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp",
      "args": ["--host=cursor"]
    }
  }
}
```

## Codex

Codex uses TOML configuration and must select the native Codex profile explicitly:

```toml
[mcp_servers.foreman]
command = "foreman-mcp"
args = ["--host=codex"]
```

**Codex mode:** Foreman uses native Codex subagents for bounded work. Independent units can run in parallel; Foreman records delegation first, then independently validates each result. Call `codex_agents_init` to create optional explorer/worker roles and concurrency settings without overwriting existing Codex config.

In Codex mode, headless Claude serves as Advisor A and Gemini as Advisor B — see [advisor seats and deliberation](../execution/advisor-seats.md) for the per-host seat assignments and the deliberation loop. Restart Codex after changing MCP configuration or reinstalling Foreman.

<details>
<summary>Codex parallel-worker details</summary>

When a phase batches to N independent units, the pitboss delegates each unit in the ledger, spawns up to `agents.max_threads` (default 6) `spawn_agent` workers at once with `max_depth=1`, waits for all, and validates each unit independently. `codex_agents_init` writes `.codex/agents/explorer.toml` (read-only code mapper), `.codex/agents/worker.toml` (workspace-write implementer), and a `.codex/config.toml` `[agents]` block only when the configuration file is absent.

</details>

## Windows command shim

For the default host:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "cmd",
      "args": ["/c", "foreman-mcp"]
    }
  }
}
```

For Cursor on Windows, preserve the host argument:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "cmd",
      "args": ["/c", "foreman-mcp", "--host=cursor"]
    }
  }
}
```

## Host resolution and working directory

Host resolution order is `--host=<id>`, then `FOREMAN_HOST`, then `claude-code`. Accepted profiles are `claude-code`, `cursor`, `codex`, and `generic`.

Make sure the host starts the MCP process with the target repository as its working directory. Foreman's state paths and `.foremanenv` are resolved from that directory.

## Confirm the connection

After connecting, call:

```text
host_status
bundle_status
session_orient
```

See [host compatibility](../reference/host-compatibility.md) for per-host caveats and documented degradations.
