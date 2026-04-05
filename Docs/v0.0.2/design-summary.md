## Design Summary — Foreman MCP v0.0.2: Skill Authoring

### Problem
The Foreman MCP server (v0.0.1) ships 8 helper tools and a skill delivery mechanism, but the skill bodies are empty stubs. Users who `npm install` the bundle get plumbing with no workflow intelligence. The existing Claude Code skills (`design-partner`, `Write-spec`, `pitboss-implementor`) contain the full workflow logic but live as hand-managed local files — no versioning, no single-update-surface, no MCP tool integration.

### Approach
Port the 3 existing local skills into full MCP-delivered skill bodies at `src/skills/*.md`. Each skill is rewritten in dense markdown (tables over prose, imperative voice, ~30% fewer tokens than originals) while preserving all behavioral rules. Skills use MCP helper tools where they add value, and embed a built-in deliberation protocol (adapted from arch-council) for architecture decisions — no external skill dependencies.

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Skill count | 3: `design-partner`, `spec-generator`, `implementor` | Maps 1:1 to existing pipeline stages. Clear roles, clear names. |
| Naming | Rename `project-planner` → split into `design-partner` + `spec-generator` | Codex flagged `project-planner` as misleading. Two skills with clear responsibilities. |
| design-partner MCP usage | `bundle_status` + `capability_check` only | Conversational skill — no ledger/progress state to manage. capability_check needed for deliberation tier detection. |
| spec-generator MCP usage | `write_ledger` (seed phases/units), `write_progress` (seed progress), `bundle_status`, `capability_check` | Seeds the ledger and progress so implementor starts with pre-populated state. |
| implementor MCP usage | All 8 tools | Full integration — serialized ledger writes, truncated progress reads, capability checks, review normalization. |
| Deliberation | Built-in, embedded in design-partner + spec-generator (~120 lines each, duplicated) | Bundle must be self-contained. No dependency on local `/arch-council` skill. |
| Deliberation fallback tiers | Codex+Gemini → Codex+Opus → Gemini+Opus → Opus+Opus | Uses `capability_check` to detect available CLIs. Always has a working path. |
| Ledger format | Compact JSON via `mcp__foreman__write_ledger` | Token savings. MCP tools handle serialization — skill body doesn't document the file format. |
| Skill body format | Dense markdown — tables, imperatives, no filler | Skills are LLM-consumed, not human-read. ~30% token reduction vs originals. |
| arch-council dependency | None — deliberation is built-in | `npm install` gives you everything. Users with local arch-council can override via Change 5 mechanism. |
| Existing stub handling | Delete `project-planner.md`, create `design-partner.md` + `spec-generator.md`, rewrite `implementor.md` | Update integration tests to match new skill names/count. |

### Architecture

```text
User
  → foreman:design-partner (MCP skill)
      → Conversational design session
      → Built-in deliberation (Codex/Gemini/Opus tiers)
      → Output: Docs/design-summary.md (via FileWriteTool)
  → foreman:spec-generator (MCP skill)
      → Reads Docs/design-summary.md
      → Built-in deliberation for ambiguities
      → Writes: Docs/spec.md, Docs/handoff.md (via FileWriteTool)
      → Seeds: ledger + progress (via mcp__foreman__write_ledger, write_progress)
      → Writes: Docs/PROGRESS.md, Docs/testing-harness.md (via FileWriteTool)
  → foreman:implementor (MCP skill)
      → Reads ledger (mcp__foreman__read_ledger)
      → Reads progress (mcp__foreman__read_progress)
      → Spawns Sonnet workers (Agent tool)
      → Validates against spec (pit-boss pattern)
      → Updates ledger (mcp__foreman__write_ledger)
      → Updates progress (mcp__foreman__write_progress)
      → Capability check before review (mcp__foreman__capability_check)
      → Normalizes review output (mcp__foreman__normalize_review)
      → Codex/Gemini/Opus review at checkpoints (built-in deliberation)
```

### MCP Tool Usage Per Skill

| Tool | design-partner | spec-generator | implementor |
|------|---------------|----------------|-------------|
| `bundle_status` | Session start version check | Session start version check | Session start version check |
| `changelog` | — | — | — |
| `read_ledger` | — | — | Resume: read current state |
| `write_ledger` | — | Seed empty phases/units | Set verdicts, rejections, gates |
| `read_progress` | — | — | Resume: truncated view |
| `write_progress` | — | Seed initial progress | Update unit status, log errors |
| `capability_check` | Deliberation tier detection | Deliberation tier detection | Pre-review CLI detection |
| `normalize_review` | — | — | Parse Codex/Gemini review output |

### Built-in Deliberation Protocol (Embedded in design-partner + spec-generator)

Adapted from `arch-council` skill (380 lines → ~120 lines per skill, dense format).

**Detection flow:**
```
1. mcp__foreman__capability_check({ cli: "codex" })
2. mcp__foreman__capability_check({ cli: "gemini" })
3. Map to tier:
   - Both → Codex CLI + Gemini CLI + Opus moderator
   - Codex only → Codex CLI + Opus critic + Opus moderator
   - Gemini only → Gemini CLI + Opus critic + Opus moderator
   - Neither → Opus proposer + Opus critic + Opus moderator
```

**Protocol (6 phases, max 3 cross-examination rounds):**
1. Independent analysis (parallel — both advisors get same question)
2. Moderator digest (summarize, flag hallucination/over-engineering)
3. Cross-examination (each challenges the other, max 3 rounds)
4. Convergence check (agree / partial / deadlock)
5. Council report (structured table with competing proposals)
6. User arbitration (user picks direction, mandatory)

**CLI invocation patterns (from arch-council):**
- Codex: `codex exec --skip-git-repo-check -s read-only -m gpt-5.4 -c reasoning.effort="high" -c hide_agent_reasoning=true "<prompt>"`
- Gemini: temp file approach — `cat <<'PROMPT' > "$TMPFILE"` then `gemini -p "$(cat "$TMPFILE")" -m arch-review --approval-mode plan --output-format text`
- Opus agents: `Agent tool with model: "opus"`, adversarial critic prompt
- Timeout: 300s per CLI call

**Anti-patterns (carried over):**
- Don't relay outputs verbatim — summarize and compare
- Don't let advisors see raw output from each other
- Don't average recommendations — push for a winner
- Don't accept unanimous agreement without verification
- Don't run more than 3 cross-examination rounds

### Skill Body Structure (Dense Markdown Format)

Each skill follows this structure:

```markdown
---
name: foreman:<skill-name>
version: 0.0.2
description: <one-liner>
[disableSlashCommand: true]  # implementor only
---

[Override notice — 2 lines]
[Ledger prohibition — 3 lines]  # spec-generator + implementor
[Slash-command guard — 4 lines]  # implementor only

## Session Start
[bundle_status check + skill-specific startup]

## Core Rules
[Table format — Rule | Why]

## Workflow
[Phase-by-phase instructions, tables, terse imperatives]

## Deliberation Protocol  # design-partner + spec-generator only
[~120 lines — detection, tier mapping, protocol, templates]

## Error Handling
[Table format — Scenario | Behavior]
```

### Skill-Specific Porting Notes

#### foreman:design-partner (from design-partner, 494 → ~350 lines)

**What carries over 1:1:**
- Phase 1-5 flow (Understand → Scoping → Iterate → Synthesize → Handoff)
- Push-back protocol (condensed to table)
- Uncertainty protocol (UNKNOWN/UNVERIFIED markers)
- Block conditions
- Integration discovery decision tree
- Contract tracing rules
- Grounding rule
- Quality bar checklist

**What changes:**
- Session start: add `bundle_status` check
- Phase 4b: replace `/arch-council` invocation with built-in deliberation protocol
- Phase 5 handoff: "invoke `foreman:spec-generator`" instead of "run `/Write-spec`"
- Agent delegation: `code-searcher` sub-agent usage unchanged
- Prose sections → tables (push-back protocol, scope change handling)

**What's removed:**
- Verbose examples (3 examples per pattern → 1)
- Redundant prose explanations where tables suffice

#### foreman:spec-generator (from Write-spec, 640 → ~450 lines)

**What carries over 1:1:**
- 4-step procedure (Validate → Determine Language → Design Order → Generate Documents)
- Ambiguity Resolution Protocol (now uses built-in deliberation instead of `/arch-council`)
- 8 grounding checks (G1-G8) — these are the highest-value content, preserved verbatim
- Document templates for spec.md, handoff.md, PROGRESS.md, testing-harness.md
- Quality checks

**What changes:**
- Session start: add `bundle_status` check + `read_ledger` (check if ledger already exists)
- After generating handoff: seed ledger via `write_ledger` (create phases/units from implementation order)
- After generating PROGRESS.md: seed progress via `write_progress` (create initial progress state)
- Ambiguity escalation: built-in deliberation instead of `/arch-council`
- Handoff message: "invoke `foreman:implementor`" instead of "hand to `/pitboss-implementor`"
- Document templates: condensed (~150 lines → ~80 lines of terse format descriptions)

**What's removed:**
- Full document template examples (replace with terse format descriptions — the LLM knows markdown)
- Repeated session protocol (standardized across all 3 skills)

#### foreman:implementor (from pitboss-implementor, 480 → ~380 lines)

**What carries over 1:1:**
- Model check (Opus required)
- Core rules table (pit-boss never writes code, workers disposable, etc.)
- Per-unit workflow (read spec → decide batching → context pack → brief → spawn → validate → verdict)
- Worker brief template
- Fix brief template
- Two-tier fix protocol (inner loop + outer loop)
- Self-review gates (G1-G4)
- Anti-rationalization list
- Common implementation traps table
- Error handling table

**What changes:**
- Session start: `read_ledger` + `read_progress` via MCP tools instead of file reads
- Ledger operations: `write_ledger` for verdicts, rejections, unit status, phase gates
- Progress operations: `write_progress` for unit completion, error logging
- Checkpoint review: `capability_check` before spawning Codex/Gemini, `normalize_review` for parsing output
- Checkpoint protocol: built-in deliberation replaces Codex-only review
- Resume protocol: ledger is single authority (Change 6 — ignore host plan/task state)

**What's removed:**
- YAML ledger schema documentation (MCP tools handle format)
- Manual file write instructions (replaced by tool calls)
- Redundant session protocol (standardized)

### Integration Points

| System | Protocol | Auth | Status |
|--------|----------|------|--------|
| MCP SDK | stdio transport | local process | VERIFIED (Phase 4 complete) |
| Codex CLI | `codex exec` subprocess | local env / `codex login` | VERIFIED via `capability_check` |
| Gemini CLI | `gemini -p` subprocess | GEMINI_API_KEY or google-login | VERIFIED via `capability_check` |
| Claude Code skill loader | `skill://` resources via MCP | per-server auth | VERIFIED (Phase 4 complete) |
| Filesystem | direct file I/O for design-summary, spec, handoff | local trust | N/A |

### Config Surface

No new config beyond v0.0.1. Skills use existing MCP server config:

| Setting | Type | Default |
|---------|------|---------|
| `ledgerPath` | string | `Docs/.foreman-ledger.json` |
| `progressPath` | string | `Docs/.foreman-progress.json` |
| `docsDir` | string | `Docs` |

### Error Handling

| Scenario | Behavior |
|----------|----------|
| `bundle_status` fails | Skill proceeds with warning. Logs degraded status. |
| Both CLIs unavailable for deliberation | Fall back to Opus+Opus agents. Always has a working path. |
| One CLI fails mid-deliberation | Continue with remaining advisor + Opus moderator. |
| Ledger seed fails in spec-generator | Report error. Implementor can still create ledger on first run. |
| `capability_check` times out | Treat CLI as unavailable. Fall back to next tier. |
| Gemini API key not set | Detect in capability_check (auth_status: "expired"). Fall to next tier. |

### Testing Strategy

- **Archetype:** Infrastructure Tool (MCP Server) — same as v0.0.1
- **Mock boundaries:** Skill content tested via resource read assertions. No runtime behavior testing (skills are prompt text, not executable code).
- **Critical path:** Integration tests verifying skill URIs, content assertions (frontmatter, key directives, deliberation protocol presence)

### Scope

**In scope:**
- Full workflow body for `foreman:design-partner` (~350 lines)
- Full workflow body for `foreman:spec-generator` (~450 lines)
- Full workflow body for `foreman:implementor` (~380 lines)
- Built-in deliberation protocol in design-partner and spec-generator
- Delete old `project-planner.md` stub
- Update integration tests for new skill names/count (3 skills instead of 2)
- Update `package.json` version to 0.0.2

**Out of scope:**
- New MCP tools (the 8 existing tools are sufficient)
- Changes to `server.ts` (auto-discovers skills from `src/skills/*.md`)
- arch-council as a 4th MCP skill
- Plugin/bootstrap installer
- Codex adapter

**Phase 2 candidates:**
- Resumable design sessions with design-state storage in ledger
- Shared deliberation resource (if duplication becomes a maintenance problem)
- Gemini settings.json auto-configuration for `arch-review` alias
- Design-summary validation tool (MCP tool that checks completeness)

### Open Items

| Item | Status | Blocking |
|------|--------|----------|
| Gemini `arch-review` alias setup | Documented in deliberation protocol | No — deliberation detects missing alias via capability_check |
| `project-planner.md` deletion | Planned — tests must be updated first | No |
| Pre-existing `tsc --noEmit` error in `writeLedger.ts:17` | Deferred from Phase 4 | No |
