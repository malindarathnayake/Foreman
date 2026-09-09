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

Codex mode uses native subagents for implementation and review, with no additional CLI or provider credentials required. Editing workers run one at a time unless each has a proven isolated worktree or sandbox. Reviews use 2-5 read-only reviewers with different risk lenses, followed by a separate verifier. A complete `stage: "native"` review can satisfy the Codex phase gate without an override; confirmed findings, incomplete coverage, and stale reviews still block it.

At major checkpoints (phase end, final design/spec review, or high-risk changes), Foreman probes the existing Claude and Gemini advisor tools and uses whichever are available for extra review. If neither is available, native review still works. Optional CLI failures and coverage gaps are recorded, and usable claims are verified. Council seats also remain optional.

`codex_agents_init` creates missing role files and creates `.codex/config.toml` only when absent. Existing role files are preserved unless `overwrite: true` is requested; existing config is always preserved. Check the running host can load the roles; file creation alone does not prove capability. `host_status` reports `review_mode: native-subagents`. Agent IDs come from Codex's spawn results; Foreman does not register headless CLI processes in the UI agent picker.

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

The difference is `retrieve_original`, registered only when output compression is on, and `codex_agents_init`, registered only under the Codex profile.

Next: [First project](./start-a-project.md).
