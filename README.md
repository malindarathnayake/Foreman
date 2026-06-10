<p align="center">
  <img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman — Workflow Orchestrator for AI Coding Agents" width="800" />
</p>

<p align="center">
  <a href="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/foreman/actions/workflows/build.yml/badge.svg" alt="Build & Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" /></a>
</p>

**A software development governance layer for AI coding agents.** Foreman enforces a design → spec → implement pipeline, validates every state change through a structured ledger, and uses independent models (Codex, Gemini, GPT-5.5, Gemini-3.1-pro) to review work at phase gates. It doesn't write code — it supervises agents that do.

Foreman targets the four things that kill large refactors — drift, hallucinated foundations, confident-but-wrong output, and blast-radius blindness — with a durable ledger, file:line grounding + citation checks, and gated pit-boss/worker decomposition.

**21 tools. 6 skill protocols. Multi-host: Claude Code, Cursor, Codex CLI.** Foreman includes the full design/spec/implement pipeline plus lightweight surgical-task, specification, and documentation protocols. `spec_man` can draw from an optional project atlas such as Graphify when one is available.

Current release: **v0.1.3**. See [CHANGELOG.md](CHANGELOG.md) for release history.

---

## What Foreman Actually Does

Foreman is built around one observation: with frontier orchestrator models (Claude Opus / Fable class), the context window is both the cost center and the failure point. Long coding sessions fill it with diffs, test output, and dead ends — judgment degrades, tokens burn, and the model starts re-deriving decisions it already made. Foreman structures development so the expensive model never carries that weight.

**Phase-gated development.** Work is decomposed into phases, each phase into units of 1–3 files with one test command each. A phase ends at a gate: every unit validated against the spec, the full test suite re-run, independent models reviewing the changes, and the gate recorded in a durable ledger. Gates are enforced in code, not prompts — the ledger refuses a `pass` verdict for a unit that was never delegated to a worker, and refuses to close a phase while any unit isn't passing.

**The pitboss model — context isolation by construction.** One frontier model (the pitboss) orchestrates and validates; it never writes code. Each unit is implemented by a disposable subagent (Sonnet-class worker) that receives a minimal brief — the exact code excerpts, interface contracts, and test command it needs — and nothing else: no full spec, no ledger, no conversation history. The worker is discarded after the unit. This buys three things at once:

- **Clean orchestrator context.** The pitboss's window holds the plan, the briefs, and the verdicts — not the thousands of lines of code and test output the workers churn through. Validation quality stays flat across a long project instead of degrading as the session grows.
- **Token economics.** Bulk token spend — reading source, writing code, fixing compile errors — lands on the cheaper worker model. The frontier model's expensive context is reserved for orchestration, validation, and gate decisions.
- **No error accumulation.** Every worker starts with zero accumulated hallucinations. A rejected unit gets a *fresh* worker with the rejection history in its brief — never the same worker defending its own output.

**State lives on disk, not in the chat.** The ledger, progress tracker, and session journal are JSON files that survive context resets. Sessions are *expected* to end at phase boundaries — a fresh session per phase is mandatory in the protocol. The next session re-orients with one `session_orient` call and resumes exactly where the ledger says it should.

**Nothing is trusted without evidence.** The pitboss re-runs tests itself rather than trusting worker self-reports. Specs and docs must cite `file:line` evidence with verbatim anchors that `verify_citations` re-reads deterministically. Independent models review every phase. Spec-vs-code conflicts are recorded as explicit mismatches, never silently resolved.

---

## Quick Start

### Install — GitHub Packages (recommended)

Foreman is published to GitHub Packages. Add a `.npmrc` in your project (or home directory) so the scope resolves to GitHub:

```
@malindarathnayake:registry=https://npm.pkg.github.com
```

Then install globally:

```bash
npm install -g @malindarathnayake/foreman-mcp
```

GitHub Packages requires a personal access token with `read:packages` scope, even for public packages — set `NPM_TOKEN` or run `npm login --registry=https://npm.pkg.github.com` once.

### Install — tarball (no auth required)

```bash
curl -LO https://github.com/malindarathnayake/Foreman/releases/download/v0.1.3/malindarathnayake-foreman-mcp-0.1.3.tgz
npm install -g malindarathnayake-foreman-mcp-0.1.3.tgz
```

Or grab the latest tarball directly from the [Releases page](https://github.com/malindarathnayake/Foreman/releases/latest). The repo's `artifacts/` folder retains historical tarballs (≤ v0.0.8) for archival reference; new versions live only on Releases + GitHub Packages.

### Configure

Add to your MCP settings (`~/.claude/settings.json`, `.cursor/mcp.json`, or Cline config).

**Claude Code (default):**

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

**Cursor (uses Task subagents instead of CLIs):**

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

In `cursor` mode, workers spawn via the Cursor `Task` tool with `claude-4.6-sonnet-medium-thinking`, and advisors run as `gpt-5.5-medium` + `gemini-3.1-pro` (with `composer-2-fast` fallback) — no external CLI binaries required. Confirm with `mcp__foreman__host_status` after connecting.

<details>
<summary>Host resolution precedence</summary>

1. `--host=<id>` CLI flag (recommended — visible in MCP config)
2. `FOREMAN_HOST` env var (must be nested under `env` in MCP config)
3. Default: `claude-code`

Accepted values: `claude-code`, `cursor`, `codex` (codex is currently an alias of claude-code). Unknown values fall back to claude-code with a stderr warning.
</details>

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
3. **Implement** — The pitboss builds a brief per unit, spawns a disposable Sonnet worker (Claude Code: `Agent` tool with sonnet · Cursor: `Task` tool with claude-4.6-sonnet-medium-thinking), validates output against the spec, runs gates G1–G5, records the verdict. At phase boundaries, two advisors review independently (Claude Code: Codex + Gemini CLIs · Cursor: GPT-5.5 + Gemini-3.1-pro subagents).

**The pitboss never writes code.** Workers write code but never see the full spec, the ledger, or prior units. This separation prevents hallucination accumulation and self-review bias.

### Spec-man, Atlas, And Plan Drift

Foreman v0.1.x adds a grounded re-evaluation lane for existing repositories. When `spec_man` is used against a repo that already has specs, plans, or implementation history, it can:

- record git branch, commit, dirty state, and source evidence in the machine spec
- use an optional project atlas such as Graphify as navigation evidence
- detect stale or partial plans when code, docs, contracts, config, or tests drift
- group inconsistencies with the Plan Delta Ladder: `D3 raw`, `D2 grouped`, `D1 candidate`, `D0 current`
- keep `D1` as a candidate until review or user approval promotes it
- verify every `[OBSERVED]` citation with `verify_citations` and require each to be CONFIRMED (or explicitly downgraded) before the spec is done

`lighttask` remains the small surgical default. It escalates to `spec_man` when grounding finds missing, stale, or partial specs. For long-running, branching, multi-worker workflows, Foreman metadata now telegraphs when optional LangGraph-style runtime control may be warranted, while Foreman artifacts remain canonical.

See [docs/foreman-atlas-langgraph-runtime-plan.md](docs/foreman-atlas-langgraph-runtime-plan.md) for the design boundary and validation status.

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

### Why It's Built This Way

Large refactors rarely fail on coding ability — they fail on four things, and Foreman attacks each:

| Failure mode | What kills the refactor | Foreman's answer |
|---|---|---|
| **Drift** | Agent forgets the plan mid-stream and re-derives it wrong | Ledger + journal + handoff keep the plan on disk |
| **Hallucinated foundation** | Builds on a route/schema/API that doesn't exist; the error compounds | `[OBSERVED]` + file:line grounding, `verify_citations` |
| **Confident wrongness** | Authoritative-looking output that's wrong, so it passes review | Deterministic gates + independent-model review + citation gate |
| **Blast-radius blindness** | Breaks an invariant three files away | Spec scoping + Plan Delta Ladder + pit-boss/worker split |

A checklist-and-gate system aimed at the four ways big refactors crash and burn — not a generic agent-workflow wrapper.

---

## Tools Reference

### Skill Activation (6 protocols)

These tools don't do the work themselves — each injects a protocol the calling LLM must follow, turning a general-purpose agent into a specific role with rules, gates, and output contracts.

**`design_partner` — interrogate before designing.** Runs a structured design session that refuses to proceed on vague requirements. It asks pointed scoping questions, stops and waits for your answers (YIELD checkpoints), surfaces contradictions the moment they appear, blocks entirely when a central integration lacks credentials or schemas, and escalates genuine tradeoffs to a two-model council with you as arbiter. Output: `Docs/design-summary.md` with every decision and its rationale recorded. It will not accept "handle errors appropriately" as a requirement.

**`spec_generator` — translate decisions into executable documents.** Deliberately zero-creativity: takes the design summary and produces the four documents the pipeline runs on — `spec.md` (the contract the pitboss enforces), `handoff.md` (per-unit instructions), `PROGRESS.md`, `testing-harness.md` — breaks the work into phases and units, runs eight grounding checks against live files (versions, paths, insertion points, test-suite impact), and seeds the ledger. If the design summary has gaps, it stops and lists what's missing rather than filling them with assumptions.

**`pitboss_implementor` — orchestrate disposable workers.** The implementation protocol from the operating model above. Per unit: read the actual source, build a minimal worker brief, record the delegation in the ledger, spawn the worker, then validate independently — re-read every modified file, re-run tests, check the spec sentence by sentence, run gates G1–G5. Rejected work goes to a fresh worker with the rejection history (max 3 attempts, then escalate to you). Phase ends trigger the full suite, two-model review, and a mandatory new session.

**`lighttask` — surgical work without the ceremony.** For tasks of one to a few PRs that deserve rigor but not four documents. Classifies the workspace, captures git context, checks whether existing specs are stale against the current checkout, produces a facts-only grounding report (every claim cited or marked `[UNVERIFIED]`), drafts the smallest plan that satisfies the grounded facts, requires an adversarial advisor review before executing, and tracks everything in a single `Docs/lighttask.md`. Escalates to `spec_man` or the full pipeline when the work outgrows it.

**`spec_man` — write what the system is *supposed* to do.** Produces intended-behavior specifications — not documentation of whatever the code currently does. Sources are ranked (your intent > tickets > contracts > code), every requirement is tagged by provenance (`[SPECIFIED]` / `[OBSERVED]` / `[ASSUMPTION]` / `[UNRESOLVED]`), and every `[OBSERVED]` claim carries a `file:line` citation with a verbatim anchor that `verify_citations` re-checks deterministically — the spec isn't done until each citation is confirmed or explicitly downgraded. Where spec and code disagree, it records a mismatch instead of picking a side. Emits a human spec plus a machine spec (`spec.machine.json`) with git provenance, so a later session can detect that the plan went stale. Re-evaluation mode classifies an existing plan as `current` / `needs_patch` / `blocked` / `superseded` via the Plan Delta Ladder.

**`doc_man` — document from evidence, not memory.** Generates engineering documentation (README, architecture, data-flow, Confluence pages, Mermaid diagrams, machine-readable context packs) from grounded sources only: spec-man output for intended behavior, code and discovery output for actual behavior. Every claim needs a source or gets `[UNVERIFIED]`; no marketing prose; spec-vs-implementation disagreements become explicit mismatch entries. Use it after `spec_man` when the docs need to be authoritative.

### Data (10 tools)

| Tool | Purpose |
|------|---------|
| `read_ledger` / `write_ledger` | Unit status, verdicts (with `via` attribution), rejections, phase gates, phase scope |
| `read_progress` / `write_progress` | Bounded progress view, phase management, fenced PROGRESS.md auto-sync |
| `read_journal` / `write_journal` | Session telemetry — friction events, rollups |
| `session_orient` | Returns current phase, last completed, and next-up unit in one call |
| `bundle_status` | Server version and override info |
| `host_status` | Active host (claude-code/cursor/codex) + worker/advisor model slugs |
| `changelog` | Version history |

### Execution (5 tools)

| Tool | Purpose |
|------|---------|
| `capability_check` | Detect if Codex/Gemini CLI is installed and authenticated. In `cursor` host mode, returns synthetic-available (Task subagent is always reachable) |
| `invoke_advisor` | Run Codex or Gemini CLI with stdin prompt delivery (claude-code/codex hosts) |
| `run_tests` | Bounded test execution with runner allowlist (`npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`) |
| `normalize_review` | Parse review findings into structured format |
| `verify_citations` | Deterministically check evidence citations resolve to real files/lines and that verbatim anchors are present (CONFIRMED/DRIFTED/MISSING/UNANCHORED) |

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
| **Input validation** | All 21 MCP tools | Zod schemas with `.max()` length caps, enum restrictions, regex filters on every input |
| **Path jail** | `verify_citations` file reads | Cited paths and `spec_path` resolved under `repo_root`; `../` traversal and absolute escapes rejected; UTF-16/undecodable specs rejected rather than silently parsed to a false pass |
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
| Grandchild process orphans | `SIGTERM`/`SIGKILL` hits direct child only. Needs `detached: true` + process group kill (deferred to v0.0.9) |

### Pentest History

| Version | Findings | Fixed | Accepted | Deferred |
|---------|:--------:|:-----:|:--------:|:--------:|
| v0.0.5 | 8 | 5 | 3 | 0 |
| v0.0.6 | 6 | 5 | 0 | 1 |
| **Total** | **14** | **10** | **3** | **1** |

v0.0.7.5 was a workflow-hygiene patch - skill trim, ledger honesty, session orient. v0.0.8 adds host-aware skill rendering (Cursor mode) - purely additive; no new attack surface (no new external IO, no new shell invocation paths). v0.1.x adds protocol guidance and metadata; the only new IO surface is `verify_citations`, which performs read-only file access jailed under `repo_root` (traversal and absolute paths rejected, UTF-16/undecodable specs refused). Graphify and LangGraph remain optional support paths and are not production dependencies.

### Supply Chain Scan

| Status | Scan | Date | Validated | Link |
|--------|------|------|-----------|------|
| ✅ | Socket full scan | 2026-06-08 | Scan creation validated; org policy report requires additional Socket permission | [Socket report](https://socket.dev/dashboard/org/fts/sbom/26b91aee-2d2d-4f54-999e-a16730729f5d) |

Details: [docs/socket-security-scan-2026-06-08.md](docs/socket-security-scan-2026-06-08.md)

### Dependencies

**2 production dependencies:** `@modelcontextprotocol/sdk`, `zod`. No heavy frameworks, no transitive risk surface beyond the MCP SDK.

---

## What's New in v0.1.3

| Change | Detail |
|--------|--------|
| Delegated sequence documented | The ledger has always enforced `ip -> delegated -> pass`, but the `delegated` step lived only in the enforcement code. The implementor protocol and `write_ledger` tool description now teach it, so pass verdicts no longer hit `VERDICT BLOCKED` on first attempt. |
| Phase gates enforced | `update_phase_gate` with `g:'pass'` is rejected unless every unit in the phase carries a pass verdict; empty phases cannot pass a gate. |
| Attestation enforced | Pass verdicts on phases scoped `has_tests:false` or `has_build:false` mechanically require a non-empty attestation `note` describing how the unit was validated. |
| Warnings visible | `set_phase_scope`'s test-file mismatch warning surfaces in the tool result, not just stderr. |
| Corrupt-ledger honesty | Read paths report `ledger_corrupt` instead of masquerading as a fresh project, and never rename the corrupt file; writes recovering from corruption warn with the backup path. |
| Verdict metadata visible | `read_ledger` single-unit and verdicts views now include `via` and `note`. |

Earlier `v0.1.x` citation-verification, protocol-metadata, Spec-man re-evaluation, Project Atlas, and Plan Delta Ladder changes are in [CHANGELOG.md](CHANGELOG.md).

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
npm test          # 399 tests across 17 files
```

---

## License

[AGPL-3.0](LICENSE) — Copyright (c) 2026 Malinda Rathnayake
