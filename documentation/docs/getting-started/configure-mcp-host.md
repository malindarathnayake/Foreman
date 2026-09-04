---
id: configure-mcp-host
title: Register your host
sidebar_label: Register your host
description: Exact configuration for Claude Code, Cursor, and Codex, including Windows, and how to confirm the host loaded the server.
---

# Register your host

Foreman renders its procedures differently per host. The host flag picks the profile. Getting it wrong is not fatal, but the procedure will name the wrong worker tool, for example telling Cursor to use Claude Code's `Agent` tool.

## Claude Code

```bash
claude mcp add --scope user foreman -- foreman-mcp
claude mcp get foreman
```

`--scope user` writes `~/.claude.json`. `--scope project` writes `.mcp.json` in the repo instead, which you can commit. The JSON either scope produces:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

Confirm inside a session with `/mcp`. Foreman should be listed as connected.

## Cursor

Global: `~/.cursor/mcp.json`. Per project: `.cursor/mcp.json`.

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

Confirm in Cursor's MCP settings; the server should show its tools.

## Codex

Global: `~/.codex/config.toml`. Per project: `.codex/config.toml`.

```toml
[mcp_servers.foreman]
command = "foreman-mcp"
args = ["--host=codex"]
```

Restart Codex after changing MCP configuration or reinstalling Foreman.

Codex specifics. Workers are Codex `spawn_agent` subagents. Editing workers run one at a time unless each has a proven isolated worktree or sandbox; read-only explorer agents may run in parallel. The `codex_agents_init` tool writes `.codex/agents/explorer.toml`, `.codex/agents/worker.toml`, and an `[agents]` block in `.codex/config.toml`, and only when those files are absent. In Codex mode, phase reviews use headless Claude and the Gemini CLI, since Codex is the host.

## Windows

The global install creates a `.cmd` shim. Hosts that spawn the command without a shell need `cmd /c`:

```json
{ "mcpServers": { "foreman": { "command": "cmd", "args": ["/c", "foreman-mcp"] } } }
```

```json
{ "mcpServers": { "foreman": { "command": "cmd", "args": ["/c", "foreman-mcp", "--host=cursor"] } } }
```

```toml
[mcp_servers.foreman]
command = "cmd"
args = ["/c", "foreman-mcp", "--host=codex"]
```

## Host resolution and working directory

Resolution order: `--host=<id>` on the command line, then the `FOREMAN_HOST` environment variable, then `claude-code`. Accepted ids: `claude-code`, `cursor`, `codex`, `generic`. An unknown id falls back to `claude-code` with a warning on stderr.

The host must start the process with your repo as the working directory. Foreman resolves `Docs/.foreman-ledger.json`, `Docs/.foreman-progress.json`, `Docs/.foreman-journal.json`, and `.foremanenv` from there. Symptom of a wrong directory: `session_orient` answers `status: no_phases_yet` on a project that has a ledger.

## Confirm the connection

Paste this in the chat:

```text
Call Foreman's host_status, bundle_status, and session_orient tools and report any warning.
```

`host_status` names the active profile and the model slugs it will ask the host to use. `bundle_status` names the version and whether a skill override is shadowing a bundled protocol. The host's own tool list should show this many Foreman tools:

| Host | Compression on (default) | `FOREMAN_COMPRESSION=0` |
|---|---|---|
| Claude Code, Cursor, generic | 27 | 26 |
| Codex | 28 | 27 |

The difference is `retrieve_original`, registered only when output compression is on, and `codex_agents_init`, registered only under the Codex profile.

Next: [First project](./start-a-project.md).
