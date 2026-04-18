<p align="center">
  <img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman — Workflow Orchestrator for AI Coding Agents" width="800" />
</p>

<p align="center">
  <a href="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml/badge.svg" alt="Build & Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" /></a>
</p>

**A software development governance layer for AI coding agents.** Foreman enforces a design → spec → implement pipeline, validates every state change through a structured ledger, and uses independent models (Codex, Gemini) to review work at phase gates. It doesn't write code — it supervises agents that do.

**16 tools. 3 skill protocols. Skill bodies trimmed ~30% in v0.0.7.5 for tighter context budgets.**

---

## Quick Start

### Install

```bash
curl -LO https://github.com/malindarathnayake/Foreman/raw/main/artifacts/malindarathnayake-foreman-mcp-0.0.7.5.tgz
npm install -g malindarathnayake-foreman-mcp-0.0.7.5.tgz
```

Or grab the latest tarball directly from the [Releases page](https://github.com/malindarathnayake/Foreman/releases/latest).

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
<summary>Windows install note</summary>

```json
{ "mcpServers": { "foreman": { "command": "cmd", "args": ["/c", "foreman-mcp"] } } }
```
</details>

---

## How It Works

```
design_partner → spec_generator → pitboss_implementor
```

1. **Design** — You and the LLM workshop requirements interactively. Output: `Docs/design-summary.md`.
2. **Spec** — Transforms the design into four formal documents (spec, handoff, progress tracker, testing harness) and seeds the ledger.
3. **Implement** — The pitboss (Opus) builds a brief per unit, spawns a disposable Sonnet worker, validates output against the spec, runs gates G1–G5, records the verdict. At phase boundaries, Codex + Gemini review independently.

**The pitboss never writes code.** Workers write code but never see the full spec, the ledger, or prior units. This separation prevents hallucination accumulation and self-review bias.

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

> **Full walkthrough:** [Usage Guide — Building a CLI Expense Tracker](usage-guide.md)

---

## Tools Reference

### Skill Activation (3 tools)

| Tool | Protocol injected |
|------|-------------------|
| `design_partner` | Collaborative design session with YIELD checkpoints |
| `spec_generator` | Spec generation + ledger/progress seeding |
| `pitboss_implementor` | Pitboss/worker orchestration with G1-G5 gates |

### Data (9 tools)

| Tool | Purpose |
|------|---------|
| `read_ledger` / `write_ledger` | Unit status, verdicts (with `via` attribution), rejections, phase gates, phase scope |
| `read_progress` / `write_progress` | Bounded progress view, phase management, fenced PROGRESS.md auto-sync |
| `read_journal` / `write_journal` | Session telemetry — friction events, rollups |
| `session_orient` | Returns current phase, last completed, and next-up unit in one call |
| `bundle_status` | Server version and override info |
| `changelog` | Version history |

### Execution (4 tools)

| Tool | Purpose |
|------|---------|
| `capability_check` | Detect if Codex/Gemini CLI is installed and authenticated |
| `invoke_advisor` | Run Codex or Gemini CLI with stdin prompt delivery |
| `run_tests` | Bounded test execution with runner allowlist (`npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`) |
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
        ET["Execution Tools"]
        SL["Skill Loader<br/>project → user → bundled"]
        SK["Skills (.md)"]
    end

    Ledger[".foreman-ledger.json"]
    Progress[".foreman-progress.json"]
    Journal[".foreman-journal.json"]

    Agent <-->|"stdio / MCP"| SKT
    Agent <-->|"stdio / MCP"| DT
    Agent <-->|"stdio / MCP"| ET
    SKT --> SL --> SK
    DT -->|"serialized · atomic write"| Ledger
    DT -->|"serialized · atomic write"| Progress
    DT -->|"serialized · atomic write"| Journal
```

**Stack:** TypeScript (ESM) · `@modelcontextprotocol/sdk` · Zod · stdio transport · 2 prod deps

### Skill overrides

```
.claude/skills/<skill-name>/SKILL.md        # project-local (highest priority)
~/.claude/skills/<skill-name>/SKILL.md      # user-global
<bundled>/skills/<skill-name>.md            # packaged default
```

---

## Security Posture

Foreman v0.0.7 was hardened through a Purple Team pentest pipeline.

### Threat Model

Foreman is a **stdio-only MCP server**. The trust boundary is the parent process (Claude Code) — any process that can spawn `foreman-mcp` already has equivalent user-level access. No network exposure, no HTTP listener, no auth layer (by design — stdio pipes don't need them).

### Defense Layers

| Layer | What It Protects | How |
|-------|-----------------|-----|
| **Input validation** | All 16 MCP tools | Zod schemas with `.max()` length caps, enum restrictions, regex filters on every input |
| **Runner allowlist** | `run_tests` tool | Only `npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`. Regex filter (`/^[a-zA-Z0-9_.-]+$/`) on env-supplied entries. `npx` explicitly denied |
| **Absolute path resolution** | CLI invocation | All external CLIs resolved to absolute paths via `which`/`where`. Relative paths and `.cmd`/`.bat` shims rejected on Windows |
| **Stdin delivery** | `invoke_advisor` tool | Prompts sent via stdin pipe, not command-line args. Bypasses shell metacharacter injection and OS `ARG_MAX` limits |
| **Buffer caps** | External CLI output | Hard caps on stdout/stderr (16KB default, 4x multiplier for `run_tests`). Settled guards prevent buffer growth after cap fires |
| **FIFO caps** | Internal state growth | Rejection arrays capped at 20, journal events at 200/session, sessions at 50, error logs at 20 |
| **Atomic writes** | Ledger/progress/journal | Write to `.tmp` file first, then `rename()`. No partial corruption on crash |
| **Block format output** | Advisor result parsing | Metadata separated from raw stdout/stderr blocks. Prevents TOON injection from advisory CLI output |
| **ComSpec hardening** | Windows `.cmd` wrapper | `cmd.exe` resolved via `SystemRoot` (OS-set at boot), not user-controllable `ComSpec` env var |

### Accepted Residuals

| Risk | Why Accepted |
|------|-------------|
| `npm exec` can run arbitrary packages | Restricting npm subcommands requires arg parsing — different scope. `npm` is the primary CI use case |
| No auth on MCP tools | Stdio-only, same-user privilege. ZTNA + EDR covers the threat model |
| No RBAC / tool scoping | Single-user dev tool. All tools available to parent process by design |
| Grandchild process orphans | `SIGTERM`/`SIGKILL` hits direct child only. Needs `detached: true` + process group kill (v0.0.8) |

### Pentest History

| Version | Findings | Fixed | Accepted | Deferred |
|---------|:--------:|:-----:|:--------:|:--------:|
| v0.0.5 | 8 | 5 | 3 | 0 |
| v0.0.6 | 6 | 5 | 0 | 1 |
| **Total** | **14** | **10** | **3** | **1** |

v0.0.7.5 is a workflow-hygiene patch — skill trim, ledger honesty, session orient. No new attack surface; all existing defenses intact.

### Dependencies

**2 production dependencies:** `@modelcontextprotocol/sdk`, `zod`. No heavy frameworks, no transitive risk surface beyond the MCP SDK.

---

## FAQ

**Isn't the pitboss just an LLM grading another LLM's homework?**
No. The pitboss re-runs tests itself and reads stdout/stderr — it doesn't trust the worker's self-report. Five named gates (G1–G5) check contract completeness, assertion integrity, spec fidelity, test-suite impact, and worker hygiene — several via deterministic pattern matching. The LLM layer handles *semantic* validation that static analysis can't cover.

**Doesn't a flat JSON ledger fall over with parallel workers?**
Single-writer by design. Only the pitboss writes; units dispatch sequentially. Writes are serialized via a per-path promise-chain lock with atomic `.tmp`→`rename`.

**Multi-model deliberation must be slow and expensive.**
It runs once per *phase completion*, not per unit. A 3-phase project triggers ~3 sessions. Skippable if Codex/Gemini aren't installed or via "skip council."

**Why not replace Opus validation with CI/CD?**
Tests answer "does it compile and pass assertions." They can't answer "did you implement what the spec describes." Foreman layers both: deterministic gates first, then LLM review for what automation can't catch.

**What if the context window resets mid-implementation?**
The ledger and progress files survive on disk. A new session reads them back and resumes from the last recorded state.

---

## Development

```bash
git clone https://github.com/malindarathnayake/foreman.git
cd foreman/foreman-mcp
npm install
npm run build
npm test          # 301 tests across 13 files
```

---

## License

[AGPL-3.0](LICENSE) — Copyright (c) 2026 Malinda Rathnayake
