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

Two CLIs. The **editor UI CLI** is `cursor` (`cursor --add-mcp`). The **Agent CLI** is `agent` (alias `cursor-agent`) and is what Foreman spawns for workers and advisors. They are not the same binary.

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

Register from the editor CLI:

```bash
cursor --add-mcp "{\"name\":\"foreman\",\"command\":\"foreman-mcp\",\"args\":[\"--host=cursor\"]}"
```

Confirm in Cursor's MCP settings, or with `agent mcp list` after the file exists (do not use that command as a health probe from Foreman; it can hang waiting on MCP approval). `capability_check({cli:"cursor"})` probes `agent status --format json`.

`cursor_agents_init` writes `.cursor/agents/foreman-worker*.md` once per project (create-if-absent unless `overwrite: true`). Default model is `inherit`. Those files are the IDE `Task` fallback. The primary spawn is `agent -p --force --trust` (optional `-w`); advisors go through `invoke_advisor({cli:"cursor"})`. Dual-host repos keep Claude Code's `.claude/agents/` files separately — Cursor prefers `.cursor/` on name collision.

## Codex

Global: `~/.codex/config.toml`. Per project: `.codex/config.toml`.

```toml
[mcp_servers.foreman]
command = "foreman-mcp"
args = ["--host=codex"]
tool_timeout_sec = 1200
```

Codex documents a 60-second default tool timeout, which cuts off `invoke_advisor` (900-second budget), `invoke_council`, and `invoke_worker` while the child process keeps running. Set `tool_timeout_sec = 1200` in the `[mcp_servers.foreman]` table. `host_status` reads it from the project config, then the user config, and prints advice when it is unset or shorter.

Restart Codex after changing MCP configuration or reinstalling Foreman.

Codex mode uses native subagents for implementation and review, with no additional CLI or provider credentials required. Editing workers run one at a time unless each has a proven isolated worktree or sandbox. Reviews use 2-5 read-only reviewers with different risk lenses, followed by a separate verifier. A complete `stage: "native"` review can satisfy the Codex phase gate without an override; confirmed findings, incomplete coverage, and stale reviews still block it.

At major checkpoints (phase end, final design/spec review, or high-risk changes), Foreman probes the existing Claude and Gemini advisor tools and uses whichever are available for extra review. If neither is available, native review still works. Optional CLI failures and coverage gaps are recorded, and usable claims are verified. Council seats also remain optional.

`codex_agents_init` creates missing role files and creates `.codex/config.toml` only when absent. Existing role files are preserved unless `overwrite: true` is requested; existing config is always preserved. Check the running host can load the roles; file creation alone does not prove capability. The shipped worker pins are `gpt-5.6-terra` (`worker_light`), `gpt-6-sol` (`worker`), and `gpt-6-astra` (`worker_heavy`); a role file written by an earlier release keeps its pin until `codex_agents_init` rewrites that role. `host_status` reports `review_mode: native-subagents`, the shipped table as `seat_defaults`, and the pins actually on disk as `seat_pins_on_disk`. Agent IDs come from Codex's spawn results; Foreman does not register headless CLI processes in the UI agent picker.

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
| Claude Code, Cursor, generic | 26 | 25 |
| Codex | 27 | 26 |

The difference is `retrieve_original`, registered only when output compression is on, and the host-gated init tools: `claude_agents_init` / `claude_workflows_init` on Claude Code, `cursor_agents_init` on Cursor, `codex_agents_init` on Codex.

Next: [First project](./start-a-project.md).
