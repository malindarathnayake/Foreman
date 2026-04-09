<p align="center">
  <img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman — Workflow Orchestrator for AI Coding Agents" width="800" />
</p>

<p align="center">
  <a href="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml/badge.svg" alt="Build & Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" /></a>
</p>

**A software development governance layer for AI coding agents.** Foreman enforces a design → spec → implement pipeline, validates every state change through a structured ledger, and uses independent models (Codex, Gemini) to review work at phase gates. It doesn't write code — it supervises agents that do.

**11 tools. 3 skill protocols. ~750 tokens idle overhead.**

---

## Quick Start

### Install

```bash
curl -LO https://github.com/malindarathnayake/Foreman/raw/main/artifacts/malindarathnayake-foreman-mcp-0.0.4.tgz
npm install -g malindarathnayake-foreman-mcp-0.0.4.tgz
```

Or via GitHub Packages: `npm install -g @malindarathnayake/foreman-mcp` ([setup](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages))

### Configure

Add to your MCP settings (`~/.claude/settings.json`, `.cursor/mcp.json`, or Cline config):

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

<details>
<summary>Other install methods (npx, Windows)</summary>

Via npx (no install):
```json
{ "mcpServers": { "foreman": { "command": "npx", "args": ["-y", "@malindarathnayake/foreman-mcp"] } } }
```

Windows:
```json
{ "mcpServers": { "foreman": { "command": "cmd", "args": ["/c", "foreman-mcp"] } } }
```
</details>

### Use

```
> call the foreman design_partner tool      # workshop the design
> call the foreman spec_generator tool      # generate spec + handoff + progress + test harness
> call the foreman pitboss_implementor tool # implement unit-by-unit with worker agents
```

---

## How It Works

```mermaid
flowchart LR
    subgraph Pipeline
        DP["design_partner"] --> SG["spec_generator"] --> PI["pitboss_implementor"]
    end

    subgraph "Per Unit"
        direction TB
        W["Sonnet worker<br/>writes code"] --> V["Opus pitboss<br/>validates against spec"]
        V -->|pass| L["write_ledger<br/>record verdict"]
        V -->|fail| R["spawn fresh worker<br/>with rejection context"]
    end

    subgraph "Phase Gate"
        direction TB
        G1["Gates G1–G5"] --> D["Deliberation<br/>Codex + Gemini + Opus"]
        D --> PG["write_ledger<br/>update_phase_gate"]
    end

    PI --> W
    L --> G1
```

Each skill activation tool injects a protocol into the LLM's context when called. The LLM follows the protocol — it doesn't need to figure out which tools to use or in what order.

| Stage | Tool | What happens |
|-------|------|-------------|
| **Design** | `design_partner` | Scoping questions, push-back on vague requirements, YIELD directives that force the LLM to stop and wait for user input, multi-model deliberation on ambiguities |
| **Spec** | `spec_generator` | Transforms design summary into 4 docs (spec, handoff, progress, testing harness), seeds ledger with phase/unit structure |
| **Implement** | `pitboss_implementor` | Spawns disposable Sonnet workers per unit, validates output against spec, runs self-review gates G1-G5, deliberates with Codex/Gemini at phase boundaries |

**The pitboss never writes code.** It reads the spec, builds a brief, spawns a worker, validates the result, and records the verdict. If the worker fails, it's killed and a fresh one gets the rejection context.

---

## What Makes This Different

The AI coding landscape in 2026 has matured — Cursor has Plan Mode, Codex CLI has session persistence, Devin can orchestrate child agents. But none enforce a design-before-code pipeline with cross-model deliberation and a structured audit ledger.

| | Foreman | Cursor 3 | Codex CLI | Devin |
|---|---------|----------|-----------|-------|
| **Design before code** | Enforced | Optional (Plan Mode) | No | Needs upfront spec |
| **Independent review** | Codex + Gemini (different models) | BugBot (same model, 8 passes) | Same model | Same agent |
| **Structured ledger** | Verdicts, rejections, phase gates | Enterprise audit logs | SQLite session threads | Session logs |
| **Writer/reviewer split** | Opus validates, Sonnet writes | Same agent | Same agent | Same agent |
| **Multi-model deliberation** | At every phase gate | `/best-of-n` (no gates) | No | Same model |

---

## Tools Reference

### Skill Activation (3 tools)

| Tool | Protocol injected |
|------|-------------------|
| `design_partner` | Collaborative design session with YIELD checkpoints |
| `spec_generator` | Spec generation + ledger/progress seeding |
| `pitboss_implementor` | Pitboss/worker orchestration with G1-G5 gates |

### Data (8 tools)

| Tool | Purpose |
|------|---------|
| `read_ledger` / `write_ledger` | Unit status, verdicts, rejections, phase gates |
| `read_progress` / `write_progress` | Bounded progress view, phase management |
| `bundle_status` | Server version and override info |
| `changelog` | Version history |
| `capability_check` | Check if Codex/Gemini CLI is available |
| `normalize_review` | Parse review findings into structured format |

---

## Architecture

```mermaid
graph TD
    Agent["AI Agent<br/>(Claude Code, Cursor, Cline)"]

    subgraph Foreman MCP Server
        direction TB
        SKT["Skill Activation Tools"]
        DT["Data Tools"]
        SL["Skill Loader<br/>project → user → bundled"]
        SK["Skills (.md)"]
    end

    Ledger[".foreman-ledger.json"]
    Progress[".foreman-progress.json"]

    Agent <-->|"stdio / MCP"| SKT
    Agent <-->|"stdio / MCP"| DT
    SKT --> SL --> SK
    DT -->|"mutex-serialized"| Ledger
    DT -->|"mutex-serialized"| Progress
```

**Stack:** TypeScript (ESM) · `@modelcontextprotocol/sdk` · Zod · stdio transport

### Skill overrides

When a skill tool is called, the loader checks for local overrides first:

```
.claude/skills/<skill-name>/SKILL.md        # project-local (highest priority)
~/.claude/skills/<skill-name>/SKILL.md      # user-global
<bundled>/skills/<skill-name>.md            # packaged default
```

---

## Why This Exists

AI coding agents are good at writing code but bad at governance. On multi-file projects they lose context across sessions, skip design, self-review their own work, and leave no audit trail. Skills alone can't fix this — a skill can say "update the ledger after each unit" but the agent can forget or hallucinate the update.

Foreman separates the concerns:
- **Skills** provide the workflow (design → spec → implement → gate)
- **MCP tools** provide the infrastructure (validated writes, bounded reads, mutex serialization, enum schemas)
- **The ledger** provides the audit trail (survives crashes, sessions, and context resets)

One `npm install` gives any MCP-compatible agent the full pipeline.

---

## Development

```bash
git clone https://github.com/malindarathnayake/foreman.git
cd foreman/foreman-mcp
npm install
npm run build
npm test          # 103 tests across 8 files
```

---

## License

[AGPL-3.0](LICENSE) — Copyright (c) 2026 Malinda Rathnayake
