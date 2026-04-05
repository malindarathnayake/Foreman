# Foreman MCP

Portable workflow orchestrator for AI coding agents. Ships as an MCP server — works with Claude Code, Cursor, Windsurf, Cline, or any agent that speaks MCP.

Foreman encodes the orchestration knowledge that teams learn through trial and error — concurrency safety, context management, state recovery, review gates — so the agent handles it and the developer doesn't have to.

## What It Does

Foreman turns a natural language request into a planned, tracked, reviewed implementation:

1. **Plan** — Analyzes the codebase, debates approaches (optionally with external models), asks the user to pick a direction, produces spec and handoff docs
2. **Implement** — Orchestrates worker agents per unit, verifies output, gates phases on review
3. **Track** — Durable ledger survives session boundaries, context compaction, branch switches
4. **Review** — External CLI reviewers (Codex, Gemini) with timeout/fallback, or in-process critic agents
5. **Resume** — Pick up exactly where you left off, even in a new session or a different agent

## Why This Exists

AI coding agents are powerful but require orchestration knowledge to use well on non-trivial tasks:

- Which files are done? What's left? (state tracking)
- Two workers finished at the same time — who wins? (concurrency)
- Context window is degrading on day 3 — why? (unbounded state injection)
- Session crashed mid-implementation — where was I? (recovery)
- The reviewer flagged something bogus — how do I override? (governance)

Most teams learn these patterns through failure. Foreman encodes them into infrastructure so the wrong thing is hard to do and the right thing is automatic.

## Install

```bash
npm install -g foreman-mcp
```

Add to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "npx",
      "args": ["foreman-mcp"],
      "type": "stdio"
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` under `mcpServers`.

### Cursor

Add to `.cursor/mcp.json`.

### Other MCP-Compatible Agents

Any agent that connects to MCP servers via stdio or HTTP can use Foreman. The skill delivery mechanism varies — see [Agent Compatibility](#agent-compatibility).

## Quick Start

```
User: "Add structured logging to this C# app using Foreman"

Foreman: Analyzes codebase → debates Serilog vs M.E.L → asks user to pick
         → produces spec + handoff → initializes ledger

User: "Start implementing"

Foreman: Reads ledger → spawns workers per unit → verifies each
         → runs external review at phase gates → tracks everything

User: (next day) "Where are we?"

Foreman: Reads ledger → "11/11 units complete across 4 phases. One rejection
          in Phase 3 (fixed). Implementation complete."
```

## Architecture

```
Foreman MCP Server (Node.js, stdio)
|
+-- Skills (via skill:// resources)
|   +-- foreman:project-planner
|   +-- foreman:implementor
|
+-- MCP Tools (mcp__foreman__*)
|   +-- bundle_status        version check, read-only
|   +-- changelog            upgrade notes, read-only
|   +-- read_ledger          query workflow state
|   +-- write_ledger         mutate workflow state (serialized)
|   +-- read_progress        truncated progress view
|   +-- write_progress       update progress
|   +-- capability_check     detect external CLIs
|   +-- normalize_review     parse review output
|
+-- Artifacts (in your repo)
    +-- Docs/spec.md
    +-- Docs/handoff.md
    +-- Docs/PROGRESS.md              human-readable, generated
    +-- Docs/.foreman-ledger.json     machine-readable, authoritative
```

## How It Works

### Token Budget

Foreman is designed to be cheap at idle and efficient at runtime.

| Event | Foreman Token Cost | Notes |
|-------|-------------------|-------|
| Agent starts (idle) | ~750 tokens | 8 tool schemas + server instructions + skill listing |
| User invokes planner | +~2,000 tokens | Skill body loads on-demand, not at startup |
| Ledger read (20-unit project) | ~500 tokens | Compact JSON, short keys |
| Progress read (50 units) | ~400 tokens | Truncated to last 10 + incomplete |

For context: Claude Code's built-in tools cost ~10,000 tokens. Foreman adds ~7% to that baseline.

### Skill Loading

Skill bodies are **not preloaded**. The agent sees a one-line listing (~25 tokens per skill) until it decides to invoke one. The full prompt loads on-demand via SkillTool. Forked skills (`context: fork`) run in an isolated sub-agent and never enter the main conversation context.

### State Model

The ledger (`Docs/.foreman-ledger.json`) is the **single workflow authority**:

- Compact JSON with short keys (`s`, `v`, `ts`, `rej`) for token efficiency
- All writes serialized through `mcp__foreman__write_ledger` (in-process async mutex)
- Agent plan/task state is ephemeral — rebuilt from the ledger each session
- `Docs/PROGRESS.md` is a rendered view for humans, not authoritative

### Concurrency Safety

Subagents cannot write to the ledger directly. All mutations go through the MCP server, which serializes them. This prevents the last-writer-wins corruption that occurs when parallel agents write to the same file.

### External Review

Foreman can use Codex CLI and Gemini CLI as external reviewers at phase gates:

- Health check before invocation (15s timeout)
- Execution timeout (120s default, configurable)
- Stdin closed to prevent interactive prompts
- Automatic fallback to in-process critic agents if CLIs unavailable

### Resume

On every skill invocation, Foreman reads the ledger and rebuilds state. It doesn't matter if:

- The session was compacted
- The user switched branches and came back
- A different agent is continuing the work
- The previous session crashed mid-unit

The ledger is a file in the repo. Any agent on any machine can pick up where the last one left off.

## Customizing Workflow Prompts

Foreman delivers its planner and implementor skills via MCP. To customize for your project:

1. Run the skill once to see its name (e.g., `foreman:project-planner`)
2. Create a local override: `.claude/skills/foreman-project-planner/SKILL.md`
3. Copy the original skill body and modify as needed
4. Your local version takes precedence automatically

To revert: delete the local SKILL.md file.

This works because Claude Code resolves skills with `uniqBy([...localCommands, ...mcpSkills], 'name')` — local always wins.

## Agent Compatibility

Foreman's core is agent-agnostic. The MCP tools and ledger work with any agent. The agent-specific layer is thin:

| Layer | Agent-Specific? | Notes |
|-------|----------------|-------|
| Ledger + progress | No | JSON files in your repo |
| MCP tools | No | Standard MCP protocol |
| Skill delivery | Yes | `skill://` resources for Claude Code; local prompt files for others |
| Invocation constraints | Yes | SkillTool vs slash-command is a Claude Code detail |
| Local skill override | Yes | `.claude/skills/` is Claude Code's path; Cursor has its own |

For agents without MCP skill discovery, use the skills as local prompt files. The MCP tools work regardless.

## Configuration

```json
{
  "foreman": {
    "use_external_reviewers": true,
    "external_reviewers": ["codex", "gemini"],
    "external_reviewer_timeout_ms": 120000,
    "default_worker_model": null,
    "default_planner_model": null,
    "ledger_path": "Docs/.foreman-ledger.json",
    "docs_dir": "Docs",
    "progress_truncation_units": 10,
    "mcp_transport": "stdio"
  }
}
```

## Design Docs

| Document | Purpose |
|----------|---------|
| `Docs/foreman/design-summary.md` | Full design with rationale, integration points, contract tracing |
| `Docs/foreman/spec.md` | Implementation spec — 7 remediation items from Architecture Council review |
| `Docs/foreman/handoff.md` | Phase-by-phase implementation instructions |
| `Docs/foreman/PROGRESS.md` | Implementation progress tracker |
| `Docs/foreman/testing-harness.md` | Test strategy, tiers, key scenarios |

## License

TBD
