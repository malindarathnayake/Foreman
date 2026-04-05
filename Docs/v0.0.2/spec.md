# Foreman MCP v0.0.2 - Skill Authoring Spec

## Intent

Author the full workflow bodies for 3 MCP-delivered skills (`foreman:design-partner`, `foreman:spec-generator`, `foreman:implementor`) that replace the local Claude Code skill pipeline. Each skill ships as a `.md` file in `foreman-mcp/src/skills/`, delivered via `skill://foreman/<name>` resources. Users `npm install`, register the MCP server, and get all 3 workflows + 8 helper tools in one surface.

## Decisions & Notes

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-04 | 3 skills: design-partner, spec-generator, implementor | Maps 1:1 to existing pipeline stages |
| 2026-04-04 | Rename project-planner → design-partner + spec-generator | Codex flagged project-planner as misleading |
| 2026-04-04 | Built-in deliberation (no arch-council dependency) | Bundle must be self-contained for npm users |
| 2026-04-04 | Dense markdown format for skill bodies | LLM-consumed, not human-read. ~30% token reduction. |
| 2026-04-04 | spec-generator seeds ledger + progress | Implementor starts with pre-populated state |
| 2026-04-04 | Compact JSON ledger via MCP tools | Token savings. Skill body doesn't document file format. |
| 2026-04-04 | Deliberation duplicated in 2 skills, not shared resource | ~120 lines duplication < round-trip cost of resource read |

---

## Architecture

```text
foreman-mcp/src/skills/
├── design-partner.md    (~350 lines) — NEW
├── spec-generator.md    (~450 lines) — NEW
└── implementor.md       (~380 lines) — REWRITE

Pipeline:
  foreman:design-partner → Docs/design-summary.md
  foreman:spec-generator → Docs/spec.md + handoff.md + PROGRESS.md + testing-harness.md
                         → Seeds ledger + progress via MCP tools
  foreman:implementor    → Reads ledger/progress via MCP tools
                         → Spawns Sonnet workers, validates, Codex/Gemini review
```

## File Structure

```
foreman-mcp/
├── src/
│   ├── server.ts                     # UNCHANGED — auto-discovers skills
│   ├── types.ts                      # UNCHANGED
│   ├── lib/                          # UNCHANGED
│   │   ├── ledger.ts
│   │   ├── progress.ts
│   │   ├── externalCli.ts
│   │   └── toon.ts
│   ├── tools/                        # UNCHANGED
│   │   ├── bundleStatus.ts
│   │   ├── changelog.ts
│   │   ├── readLedger.ts
│   │   ├── readProgress.ts
│   │   ├── capabilityCheck.ts
│   │   ├── writeLedger.ts
│   │   ├── writeProgress.ts
│   │   └── normalizeReview.ts
│   └── skills/
│       ├── design-partner.md         # NEW — full workflow (~350 lines)
│       ├── spec-generator.md         # NEW — full workflow (~450 lines)
│       └── implementor.md            # REWRITE — full workflow (~380 lines)
├── tests/
│   ├── integration.test.ts           # MODIFY — update skill names/count/assertions
│   ├── ledger.test.ts                # UNCHANGED
│   ├── progress.test.ts              # UNCHANGED
│   ├── externalCli.test.ts           # UNCHANGED
│   ├── toon.test.ts                  # UNCHANGED
│   ├── tools.test.ts                 # UNCHANGED
│   └── writeTools.test.ts            # UNCHANGED
├── package.json                      # MODIFY — version 0.0.1 → 0.0.2
└── tsconfig.json                     # UNCHANGED
```

## Dependencies

No new dependencies. Existing:
```json
{
  "@modelcontextprotocol/sdk": "^1.12.0",
  "zod": "^3.24.0"
}
```

## MCP Tool Usage Per Skill

| Tool | design-partner | spec-generator | implementor |
|------|---------------|----------------|-------------|
| `bundle_status` | Version check | Version check | Version check |
| `capability_check` | Deliberation tier | Deliberation tier | Pre-review CLI detection |
| `write_ledger` | — | Seed phases/units | Verdicts, rejections, gates |
| `read_ledger` | — | — | Resume state |
| `write_progress` | — | Seed progress | Unit status, errors |
| `read_progress` | — | — | Truncated resume view |
| `normalize_review` | — | — | Parse review output |
| `changelog` | — | — | — |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `bundle_status` fails | Proceed with warning |
| Both CLIs unavailable | Opus+Opus agent fallback |
| One CLI fails mid-deliberation | Continue with remaining advisor |
| Ledger seed fails | Report error; implementor creates on first run |
| `capability_check` timeout | Treat as unavailable, next tier |

## Out of Scope

- New MCP tools
- Changes to server.ts (auto-discovers from src/skills/*.md)
- arch-council as 4th MCP skill
- Plugin/bootstrap installer
- Codex adapter

---

## Testing Strategy

### Archetype: Infrastructure Tool (MCP Server)

### What to Test

| Category | Scope | Mock/Real |
|----------|-------|-----------|
| Skill resource discovery | All 3 skills listed via resources/list | Real MCP SDK test client |
| Skill content integrity | Frontmatter, key directives, deliberation presence | Resource read assertions |
| Tool count unchanged | Still 8 tools, no update_bundle | Tool list assertions |
| Backward compatibility | Existing 73 non-integration tests still pass | Real test suite |

### What NOT to Test

- Runtime behavior of skill prompts (skills are text, not code)
- Actual Codex/Gemini CLI responses (opaque external systems)
- Design quality of skill-produced artifacts

### Mock Boundaries

| Dependency | Mock Strategy |
|------------|---------------|
| MCP SDK | Real test client via InMemoryTransport |
| Filesystem | Real (skills are static .md files in src/skills/) |

### Coverage Targets

| Package | Target | Focus |
|---------|--------|-------|
| `src/skills/*.md` | Content assertions | Frontmatter, key directives |
| `tests/integration.test.ts` | 100% of skill URIs | All 3 skills verified |

---

## Implementation Order

### Phase 1: Skill Bodies

**Unit 1a: design-partner.md**
1. `foreman-mcp/src/skills/design-partner.md` — Full workflow body (~350 lines)
   - Implementation directives:
     - Port from `~/.claude/skills/design-partner/SKILL.md` (494 lines)
     - Frontmatter: `name: foreman:design-partner`, `version: 0.0.2`, `description`
     - First line after frontmatter: override notice (2 lines)
     - Session start: `mcp__foreman__bundle_status` version check
     - Phase 1-5 flow preserved: Understand → Scoping → Iterate → Synthesize → Handoff
     - Phase 4b: replace `/arch-council` with built-in deliberation protocol (~120 lines)
     - Phase 5 handoff: "invoke `foreman:spec-generator`" not "run `/Write-spec`"
     - Push-back protocol: condense prose to table format
     - Uncertainty protocol: UNKNOWN/UNVERIFIED markers preserved
     - Contract tracing: all 6 checks preserved
     - Grounding rule preserved
     - Quality bar checklist preserved
     - Dense markdown: tables over prose, imperative voice, 1 example per pattern
     - **Deliberation protocol directives:**
       - Detection: `mcp__foreman__capability_check` for codex and gemini
       - Tier mapping: Both→CLI+CLI, one→CLI+Opus, neither→Opus+Opus
       - Codex invocation: `codex exec --skip-git-repo-check -s read-only -m gpt-5.4 -c reasoning.effort="high" -c hide_agent_reasoning=true`
       - Gemini invocation: temp file approach, `-m arch-review --approval-mode plan --output-format text`
       - Opus fallback: Agent tool with `model: "opus"`, adversarial critic prompt
       - Protocol: 6 phases, max 3 cross-examination rounds
       - Anti-patterns: no verbatim relay, no averaging, verify unanimous agreement
       - Timeout: 300s per CLI call
     - DO NOT: add ledger/progress MCP tool calls (design-partner is stateless)
     - DO NOT: exceed ~350 lines
     - DO NOT: include full document templates (that's spec-generator's job)

**Unit 1b: spec-generator.md**
1. `foreman-mcp/src/skills/spec-generator.md` — Full workflow body (~450 lines)
   - Implementation directives:
     - Port from `~/.claude/skills/Write-spec/SKILL.md` (640 lines)
     - Frontmatter: `name: foreman:spec-generator`, `version: 0.0.2`, `description`
     - First line after frontmatter: override notice (2 lines)
     - Ledger prohibition: CRITICAL warning (3 lines)
     - Session start: `mcp__foreman__bundle_status` + check if ledger exists via `mcp__foreman__read_ledger`
     - 4-step procedure preserved: Validate → Determine Language → Design Order → Generate Documents
     - Ambiguity Resolution Protocol: use built-in deliberation instead of `/arch-council`
     - 8 grounding checks (G1-G8): preserve verbatim — these are highest-value content
     - Document templates: condense from ~150 lines to ~80 lines of terse format descriptions
     - After generating handoff: seed ledger via `mcp__foreman__write_ledger`:
       - `operation: "set_unit_status"` for each unit in each phase (status: "pending")
       - Creates the phase/unit structure matching the handoff
     - After generating PROGRESS.md: seed progress via `mcp__foreman__write_progress`:
       - `operation: "start_phase"` for Phase 1
       - `operation: "update_status"` for each unit (status: "pending")
     - Handoff message: "invoke `foreman:implementor`" not "hand to `/pitboss-implementor`"
     - Built-in deliberation protocol: same ~120 lines as design-partner (duplicated)
     - Agent delegation: `code-searcher` for grounding checks (unchanged)
     - Quality checks preserved
     - Dense markdown: tables over prose, imperative voice
     - DO NOT: exceed ~450 lines
     - DO NOT: include arch-council as external dependency
     - DO NOT: write vague directives — every G-check must name specific verification

**Unit 1c: implementor.md (rewrite)**
1. `foreman-mcp/src/skills/implementor.md` — Full workflow body rewrite (~380 lines)
   - Implementation directives:
     - Port from `~/.claude/skills/pitboss-implementor/SKILL.md` (480 lines)
     - Frontmatter: `name: foreman:implementor`, `version: 0.0.2`, `description`, `disableSlashCommand: true`
     - First line after frontmatter: override notice (2 lines)
     - Slash-command guard (4 lines): detect and refuse if invoked as slash command
     - Ledger prohibition: CRITICAL warning (3 lines)
     - Model check: Opus required (MANDATORY)
     - Session start protocol (uses MCP tools):
       1. `mcp__foreman__bundle_status` — version check
       2. `mcp__foreman__read_ledger` with query "full" — get current state
       3. `mcp__foreman__read_progress` — truncated view
       4. Find handoff.md in Docs/
       5. Answer five questions (Where am I? Where going? Goal? Tried? Failed?)
       6. Do NOT rely on host plan/task state — ledger is authority (Change 6)
     - Core rules table: preserved (pit-boss never writes code, workers disposable, etc.)
     - Per-unit workflow: preserved (read spec → batch → context pack → brief → spawn → validate → verdict)
     - Worker brief template: preserved (dense format)
     - Fix brief template: preserved
     - Two-tier fix protocol: preserved (inner loop + outer loop, max 3 outer attempts)
     - Self-review gates G1-G4: preserved with anti-rationalization list
     - Checkpoint protocol (uses MCP tools):
       1. Full test suite
       2. `mcp__foreman__capability_check` — detect Codex/Gemini
       3. Built-in deliberation for review (same tier system)
       4. `mcp__foreman__normalize_review` — parse review output
       5. Classify findings: CONFIRMED/REJECTED/UNVERIFIED
       6. Persist: `mcp__foreman__write_ledger` for unit verdicts, gate results, review findings
       7. Persist: `mcp__foreman__write_progress` for unit completion
       8. Deliberation summary to user
       9. Mandatory new session
     - Ledger operations throughout:
       - `write_ledger({operation:"set_unit_status", phase, unit_id, data:{s:"ip"}})` — unit started
       - `write_ledger({operation:"set_verdict", phase, unit_id, data:{v:"pass"}})` — unit accepted
       - `write_ledger({operation:"add_rejection", phase, unit_id, data:{r,msg,ts}})` — unit rejected
       - `write_ledger({operation:"update_phase_gate", phase, data:{g:"pass"}})` — phase gate
     - Progress operations:
       - `write_progress({operation:"update_status", data:{unit_id, phase, status, notes}})` — unit status
       - `write_progress({operation:"complete_unit", data:{unit_id, phase, completed_at, notes}})` — unit done
       - `write_progress({operation:"log_error", data:{date, unit, what_failed, next_approach}})` — errors
     - Common implementation traps table: preserved
     - Error handling table: preserved + MCP-specific entries
     - Agent delegation: `code-searcher` for gate operations (unchanged)
     - Dense markdown: tables over prose, imperative voice
     - DO NOT: exceed ~380 lines
     - DO NOT: include YAML ledger schema (MCP tools handle format)
     - DO NOT: include manual file write instructions for ledger/progress

   ```bash
   # No test command for skill content — tested via integration tests
   ```

**No checkpoint for Phase 1** — skill files are markdown, not executable. Validation happens in Phase 2 via integration tests.

---

### Phase 2: Cleanup and Tests

**Depends on:** Phase 1 (all 3 skill files written)

**Unit 2a: Cleanup**
1. Delete `foreman-mcp/src/skills/project-planner.md`
2. Update `foreman-mcp/package.json` version: `"0.0.1"` → `"0.0.2"`
   - **Pitfall:** Only change the `version` field. Do NOT modify dependencies, scripts, or other fields.

**Unit 2b: Update integration tests**
1. `foreman-mcp/tests/integration.test.ts` — Update for new skill names and count
   - Modify "list tools" test: tool count stays at 8 (no tool changes)
   - Modify "list resources" tests:
     - Remove assertion for `skill://foreman/project-planner`
     - Add assertion for `skill://foreman/design-partner`
     - Add assertion for `skill://foreman/spec-generator`
     - Keep assertion for `skill://foreman/implementor`
     - Assert exactly 3 resources (was 2)
   - Modify "read skill resource" tests:
     - Remove project-planner content test
     - Add design-partner content test: assert frontmatter `name: foreman:design-partner`, `version: 0.0.2`, deliberation protocol presence (`mcp__foreman__capability_check`), override notice
     - Add spec-generator content test: assert frontmatter `name: foreman:spec-generator`, `version: 0.0.2`, ledger prohibition (`mcp__foreman__write_ledger`), grounding checks presence (`G1:`, `G2:`)
     - Update implementor content test: assert `version: 0.0.2`, `disableSlashCommand: true`, slash-command guard, ledger prohibition, MCP tool references (`mcp__foreman__read_ledger`, `mcp__foreman__write_ledger`)
   - Add `bundle_status` version test: assert response contains `0.0.2` (after package.json bump)
   - **Pitfall:** The write_ledger/read_ledger round-trip test uses tmpdir — do NOT modify it
   - **Pitfall:** Existing tool tests (tools.test.ts, writeTools.test.ts, etc.) must NOT be modified
   ```bash
   cd foreman-mcp && npx vitest run tests/integration.test.ts
   ```

**CHECKPOINT:**
```bash
cd foreman-mcp && npx vitest run
```
**→ Full suite must pass. This is the FINAL checkpoint.**

---

## Quick Reference

### Files to Create
| File | Lines | Source |
|------|-------|--------|
| `src/skills/design-partner.md` | ~350 | Port from `~/.claude/skills/design-partner/SKILL.md` |
| `src/skills/spec-generator.md` | ~450 | Port from `~/.claude/skills/Write-spec/SKILL.md` |

### Files to Rewrite
| File | Lines | Source |
|------|-------|--------|
| `src/skills/implementor.md` | ~380 | Port from `~/.claude/skills/pitboss-implementor/SKILL.md` |

### Files to Modify
| File | Change |
|------|--------|
| `tests/integration.test.ts` | Update skill names/count/content assertions |
| `package.json` | Version 0.0.1 → 0.0.2 |

### Files to Delete
| File | Reason |
|------|--------|
| `src/skills/project-planner.md` | Replaced by design-partner.md + spec-generator.md |

### Checkpoint Commands
| Phase | Command |
|-------|---------|
| 2 (FINAL) | `cd foreman-mcp && npx vitest run` |

### Error Recovery Protocol
| Attempt | Action |
|---------|--------|
| 1 | Diagnose root cause, targeted fix |
| 2 | Different approach — same error = wrong strategy |
| 3 | Question assumptions, check docs |
| 4+ | **STOP** — escalate to user |
