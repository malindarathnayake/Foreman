---
id: configure-mcp-host
title: Register your host
sidebar_label: Register your host
description: Exact configuration for Claude Code, Cursor, Codex, and the Antigravity CLI, including Windows, and how to confirm the host loaded the server.
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

`codex_agents_init` creates missing role files and creates `.codex/config.toml` only when absent. Existing role files are preserved unless `overwrite: true` is requested; existing config is always preserved. Check the running host can load the roles; file creation alone does not prove capability. The shipped worker pins are `gpt-5.6-terra` (`worker_light`), `gpt-6-sol` (`worker`), and `gpt-6.2-astra` (`worker_heavy`); a role file written by an earlier release keeps its pin until `codex_agents_init` rewrites that role. `host_status` reports `review_mode: native-subagents`, the shipped table as `seat_defaults`, and the pins actually on disk as `seat_pins_on_disk`. Agent IDs come from Codex's spawn results; Foreman does not register headless CLI processes in the UI agent picker.

## Antigravity (agy)

Verified on agy 1.5.11. Register Foreman under the name `foreman`. Do not install it as an agy plugin: a plugin renames the server to `<plugin>_foreman` and the protocol's tool names stop matching. The `--` is required, because agy takes its own flags before `<name>`:

```bash
agy mcp add -e FOREMAN_HOST=antigravity foreman -- foreman-mcp --host=antigravity
```

`--host` and `FOREMAN_HOST` each select the profile on their own; setting both is harmless. Then edit `~/.gemini/config/mcp_config.json` so the entry looks like this:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp",
      "args": ["--host=antigravity"],
      "env": { "FOREMAN_HOST": "antigravity" },
      "timeoutSeconds": 1200,
      "tools": {
        "session_orient": { "eager": true },
        "read_ledger": { "eager": true },
        "write_ledger": { "eager": true },
        "pitboss_implementor": { "eager": true },
        "lighttask": { "eager": true }
      }
    }
  }
}
```

- `timeoutSeconds: 1200` replaces agy's default connect and call limits, which cut off `invoke_advisor` and `invoke_council`. `host_status` reads the value from `.agents/mcp_config.json`, then `~/.gemini/config/mcp_config.json`, and advises when it is lower. agy accepts comments in this file, but `host_status` reads it as plain JSON and reports `unknown` when it cannot parse it.
- agy loads MCP tools lazily. The five eager tools put their descriptions in the prompt; every other Foreman tool is still reachable through `call_mcp_tool`. Put `eager` on individual tools only: `{"eager": true}` at the `tools` level drops the server.
- Do not commit a workspace `.agents/mcp_config.json`; whether agy trust-gates it is not yet known.
- On Windows, if agy cannot start the npm `.cmd` shim, use `"command": "node"` with `"args": ["<global npm root>/@malindarathnayake/foreman-mcp/dist/server.js", "--host=antigravity"]`. `npm root -g` prints the global root.
- Headless runs (`agy -p`) soft-deny MCP calls and still exit 0 unless you pass `--model`, `--mode accept-edits` and `--settings '{"permissions":{"allow":["mcp(foreman/*)"]}}'`. Interactive sessions ask as usual.

**Bootstrap rule.** agy does not pass MCP server instructions to the model, so Foreman needs a rule. Create the global rule `~/.gemini/config/rules/foreman.md`; `antigravity_agents_init` also writes the same rule per repository as `.agents/rules/foreman.md`. Foreman never writes under `~/.gemini`.

```markdown
---
trigger: always_on
---
Foreman (MCP server "foreman") is a spec-driven workflow harness. Use it only when the user asks for Foreman work or this repository has .foreman-ledger.json. Then call session_orient first (mcp_foreman_session_orient, or call_mcp_tool ServerName:"foreman" ToolName:"session_orient") and follow its action; the ledger, not chat history, is the source of truth. If you are a subagent (worker, reviewer or verifier), ignore this rule and do only your brief.
```

**Seats.** Ask the model to call `antigravity_agents_init` once per repository, then start a new agy session so the seat files load. It writes `.agents/agents/foreman-*.md`. The `model:` line takes agy tier words only (`inherit`, `flash_lite`, `flash`, `pro`); a concrete model id makes agy drop the seat with "subagent not found", so the tool refuses one. Served models were measured from each seat's transcript and did not depend on the parent model:

| Seat | Ledger tier | `model:` | Served model (agy 1.5.11) | Tools |
|---|---|---|---|---|
| `foreman-worker-light` | cheap | `flash` | `gemini-4-hydrogen-tiered-high` | `read_file`, `edit_file`, `write_file`, `run_command`, `manage_task` |
| `foreman-worker` | standard | `flash` | `gemini-4-hydrogen-tiered-high` | same as above |
| `foreman-worker-heavy` | premium | `pro` | `gemini-4-hydrogen-tiered-xhigh` | same as above |
| `foreman-worker-frontier` | frontier | `pro` | `gemini-4-hydrogen-tiered-xhigh` | same as above |
| `foreman-reviewer`, `foreman-verifier` | review | `pro` | `gemini-4-hydrogen-tiered-xhigh` | `read_file` |

Frontier runs the same tier as premium on this host: it is a premium retry with a brief refined by an advisor's diagnosis of the rejection. Workers spawn through `invoke_subagent` with the seat's `TypeName` and no `Model`. Editing workers run one at a time with `Workspace: "inherit"`. `invoke_subagent` returns the seat's `transcript.jsonl`; the pit-boss records the `"model"` value it shows as `worker_model`. Every seat sets `inheritMcp: false` and `inheritCustomizations: false` and lists its tools, so a seat cannot reach Foreman's MCP tools through agy. Worker seats keep `run_command`, an unrestricted shell; their instructions forbid starting `agy`, `foreman-mcp` or another agent CLI from it, so that part of the isolation is behavioural. `antigravity_agents_init` and `host_status` report `seat_drift` for any seat file that differs from the Foreman template; do not spawn a drifted seat until it is rewritten with `overwrite: true`.

**Review.** Native review (`stage: "native"`) is the default gate path, as on Codex: read-only reviewer seats with distinct lenses, then the verifier. The external advisors are Claude (`claude-fable-5-2` at max effort, Opus fallback) and Codex (`gpt-6.2-astra` at `xhigh`). `invoke_advisor({cli:"gemini"})` still works, but when the pit-boss runs Gemini it is the host's own vendor: perspective, not independence. There is no `workflow` tool on this host.

`host_status` reports the seat table read from `.agents/agents/`, the served model per tier word, whether the bootstrap rule is present, and the timeout in effect.

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

Resolution order: `--host=<id>` on the command line, then the `FOREMAN_HOST` environment variable, then `claude-code`. Accepted ids: `claude-code`, `cursor`, `codex`, `antigravity`, `generic`. An unknown id falls back to `claude-code` with a warning on stderr.

The host must start the process with your repo as the working directory. Foreman resolves `Docs/.foreman-ledger.json`, `Docs/.foreman-progress.json`, `Docs/.foreman-journal.json`, and `.foremanenv` from there. Symptom of a wrong directory: `session_orient` answers `status: no_phases_yet` on a project that has a ledger.

## Confirm the connection

Paste this in the chat:

```text
Call Foreman's host_status, bundle_status, and session_orient tools and report any warning.
```

`host_status` names the active profile and the model slugs it will ask the host to use. `bundle_status` names the version and whether a skill override is shadowing a bundled protocol. The host's own tool list should show this many Foreman tools:

| Host | Compression on (default) | `FOREMAN_COMPRESSION=0` |
|---|---|---|
| Claude Code, Cursor, Codex | 37 | 36 |
| Antigravity | 36 | 35 |
| generic | 35 | 34 |

The difference is `retrieve_original`, registered only when output compression is on, and the host-gated tools: `claude_agents_init` / `claude_workflows_init` on Claude Code, `cursor_agents_init` and `workflow` on Cursor, `codex_agents_init` and `workflow` on Codex, `antigravity_agents_init` on Antigravity.

Next: [First project](./start-a-project.md).
