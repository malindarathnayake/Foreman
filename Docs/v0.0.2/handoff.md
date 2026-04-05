# Foreman MCP v0.0.2 - Implementation Handoff

## Project Overview

Author the full workflow bodies for 3 MCP-delivered skills that ship with the Foreman MCP bundle. This replaces the empty skill stubs from v0.0.1 with dense-markdown workflow prompts ported from existing Claude Code skills.

**Read the full spec:** `Docs/v0.0.2/spec.md`
**Read the design summary:** `Docs/v0.0.2/design-summary.md`

---

## Before Starting: Check Progress

**On every session start:**
1. Check `Docs/v0.0.2/PROGRESS.md` for current state
2. Scan `foreman-mcp/src/skills/` to verify which files exist
3. Run `cd foreman-mcp && npx vitest run` to check test status
4. Resume from next incomplete item in PROGRESS.md

---

## Rules

**During implementation:**
1. Skills are markdown files — author them with the Write tool
2. Dense markdown format: tables over prose, imperative voice, 1 example per pattern
3. Each skill must include its full workflow logic — no stubs
4. Read the source skill body before writing the MCP version
5. Update `Docs/v0.0.2/PROGRESS.md` after each unit
6. No features beyond the design summary — these are ports, not rewrites
7. Ask if ambiguous — don't guess
8. **Ledger format is compact JSON** — skills reference `mcp__foreman__write_ledger`, not file I/O
9. Start new chat after the checkpoint
10. Never silently retry failures — log to PROGRESS.md, change approach

---

## Implementation Order

### Phase 1: Skill Bodies

**What it enables:** Phase 2 tests depend on all 3 skill files existing with correct content.

**Unit 1a: design-partner.md**

Port from `~/.claude/skills/design-partner/SKILL.md` (494 lines → ~350 lines).

1. `foreman-mcp/src/skills/design-partner.md` — Full workflow body
   - Read the source skill at `~/.claude/skills/design-partner/SKILL.md`
   - Read the arch-council skill at `~/.claude/skills/arch-council/SKILL.md` for deliberation protocol
   - Write the MCP version with these changes:
     - Frontmatter: `name: foreman:design-partner`, `version: 0.0.2`, description
     - Add override notice (first 2 lines after frontmatter)
     - Add session start: `mcp__foreman__bundle_status` call
     - Replace Phase 4b `/arch-council` with built-in deliberation protocol (~120 lines)
     - Replace Phase 5 handoff: "invoke `foreman:spec-generator`"
     - Condense prose sections to tables (push-back protocol, scope change, etc.)
     - Preserve: all 5 phases, uncertainty protocol, block conditions, contract tracing, grounding rule, quality bar
   - **Pitfall:** Do NOT add ledger/progress tool calls — design-partner is stateless
   - **Pitfall:** Do NOT exceed ~350 lines — condense prose, not logic

**Unit 1b: spec-generator.md**

Port from `~/.claude/skills/Write-spec/SKILL.md` (640 lines → ~450 lines).

1. `foreman-mcp/src/skills/spec-generator.md` — Full workflow body
   - Read the source skill at `~/.claude/skills/Write-spec/SKILL.md`
   - Write the MCP version with these changes:
     - Frontmatter: `name: foreman:spec-generator`, `version: 0.0.2`, description
     - Add override notice + ledger prohibition (CRITICAL warning)
     - Add session start: `mcp__foreman__bundle_status` + `mcp__foreman__read_ledger` check
     - Replace `/arch-council` with built-in deliberation (~120 lines, same as design-partner)
     - After handoff generation: seed ledger via `mcp__foreman__write_ledger`:
       ```
       For each phase/unit in the implementation order:
         write_ledger({ operation: "set_unit_status", phase: "<id>", unit_id: "<id>", data: { s: "pending" } })
       ```
     - After PROGRESS.md generation: seed progress via `mcp__foreman__write_progress`:
       ```
       write_progress({ operation: "start_phase", data: { phase: "<id>", name: "<name>" } })
       For each unit:
         write_progress({ operation: "update_status", data: { unit_id, phase, status: "pending", notes: "<desc>" } })
       ```
     - Replace handoff message: "invoke `foreman:implementor`"
     - Condense document templates (~150 → ~80 lines)
     - **Preserve verbatim:** 8 grounding checks (G1-G8) — these are the highest-value content
     - Preserve: 4-step procedure, ambiguity protocol, quality checks, agent delegation
   - **Pitfall:** G1-G8 are non-negotiable — do not condense or summarize them
   - **Pitfall:** Do NOT exceed ~450 lines

**Unit 1c: implementor.md (rewrite)**

Port from `~/.claude/skills/pitboss-implementor/SKILL.md` (480 lines → ~380 lines).

1. `foreman-mcp/src/skills/implementor.md` — Full workflow body rewrite
   - Read the source skill at `~/.claude/skills/pitboss-implementor/SKILL.md`
   - Write the MCP version with these changes:
     - Frontmatter: `name: foreman:implementor`, `version: 0.0.2`, description, `disableSlashCommand: true`
     - Add override notice + slash-command guard + ledger prohibition
     - Session start uses MCP tools:
       1. `mcp__foreman__bundle_status`
       2. `mcp__foreman__read_ledger` with query "full"
       3. `mcp__foreman__read_progress`
       4. Find handoff.md, answer five questions
       5. Ignore host plan/task state — ledger is authority
     - All ledger operations use `mcp__foreman__write_ledger`:
       - `set_unit_status` (pending/ip/done/fail)
       - `set_verdict` (pass/fail/pending)
       - `add_rejection` (reviewer, message, timestamp)
       - `update_phase_gate` (pass/fail/pending)
     - All progress operations use `mcp__foreman__write_progress`:
       - `update_status`, `complete_unit`, `log_error`
     - Checkpoint review uses `mcp__foreman__capability_check` + `mcp__foreman__normalize_review`
     - Built-in deliberation for checkpoint review (same tier system as design-partner)
     - Preserve: model check, core rules, per-unit workflow, worker/fix briefs, two-tier fix protocol, G1-G4 gates, anti-rationalization, traps table
   - **Pitfall:** Do NOT include YAML ledger schema docs — MCP tools handle format
   - **Pitfall:** Do NOT include manual file write instructions for ledger/progress
   - **Pitfall:** Do NOT exceed ~380 lines

**No checkpoint for Phase 1** — skill files are markdown, tested in Phase 2.

---

### Phase 2: Cleanup and Tests

**Depends on:** Phase 1 (all 3 skill files exist)
**What it enables:** Full test suite validates the complete v0.0.2 bundle

**Unit 2a: Cleanup**
1. Delete `foreman-mcp/src/skills/project-planner.md`
2. Modify `foreman-mcp/package.json` — change `"version": "0.0.1"` → `"version": "0.0.2"`
   - Only change the version field. Nothing else.

**Unit 2b: Update integration tests**
1. `foreman-mcp/tests/integration.test.ts` — Update for new skills
   - **Tools tests:** No changes needed (still 8 tools, still no update_bundle)
   - **Resource list tests:**
     - Remove: `skill://foreman/project-planner` assertion
     - Add: `skill://foreman/design-partner` assertion
     - Add: `skill://foreman/spec-generator` assertion
     - Keep: `skill://foreman/implementor` assertion
     - Add: assert exactly 3 resources total
   - **Resource content tests:**
     - Remove: project-planner content test
     - Add: design-partner test — assert `name: foreman:design-partner`, `version: 0.0.2`, `mcp__foreman__capability_check` (deliberation), override notice
     - Add: spec-generator test — assert `name: foreman:spec-generator`, `version: 0.0.2`, `mcp__foreman__write_ledger` (ledger prohibition), grounding check markers (`G1:` or similar)
     - Update: implementor test — assert `version: 0.0.2`, `disableSlashCommand: true`, slash-command guard, `mcp__foreman__read_ledger`, `mcp__foreman__write_ledger`
   - **bundle_status test:** Update expected version from `0.0.1` to `0.0.2`
   - **DO NOT modify:** write_ledger/read_ledger round-trip test, normalize_review test, tool list tests (count/names)
   - **DO NOT modify:** Any non-integration test files
   ```bash
   cd foreman-mcp && npx vitest run tests/integration.test.ts
   ```

**CHECKPOINT (FINAL):**
```bash
cd foreman-mcp && npx vitest run
```
**→ All tests must pass. Deliver to user.**

---

## Testing Strategy

### Archetype: Infrastructure Tool (MCP Server)
See `Docs/v0.0.1/testing-harness.md` for environment-specific test execution (unchanged from v0.0.1).

### Mock Boundaries

| Dependency | Mock Strategy |
|------------|---------------|
| MCP SDK | Real test client via InMemoryTransport |
| Skill files | Real filesystem (static .md files) |

### Coverage Targets

| Package | Target | Focus |
|---------|--------|-------|
| `src/skills/*.md` | Content assertions | Frontmatter, directives, deliberation |
| `tests/integration.test.ts` | All 3 skill URIs | Discovery + content |

---

## Quick Reference

### Source Skills (read these before writing)
| MCP Skill | Source | Location |
|-----------|--------|----------|
| design-partner | design-partner | `~/.claude/skills/design-partner/SKILL.md` |
| spec-generator | Write-spec | `~/.claude/skills/Write-spec/SKILL.md` |
| implementor | pitboss-implementor | `~/.claude/skills/pitboss-implementor/SKILL.md` |
| (deliberation) | arch-council | `~/.claude/skills/arch-council/SKILL.md` |

### Checkpoint Commands
| Phase | Command |
|-------|---------|
| 2 (FINAL) | `cd foreman-mcp && npx vitest run` |

### Error Recovery Protocol
| Attempt | Action |
|---------|--------|
| 1 | Diagnose root cause, apply targeted fix |
| 2 | Different approach — same error means wrong strategy |
| 3 | Question assumptions, check docs/examples |
| 4+ | **STOP** — log to Error Recovery Log in PROGRESS.md, escalate to user |

---

## Start

**First session?**
1. Read this handoff + `Docs/v0.0.2/spec.md`
2. Begin with Unit 1a (design-partner.md)

**Resuming?**
1. Read `Docs/v0.0.2/PROGRESS.md`
2. Verify with `ls foreman-mcp/src/skills/`
3. Run `cd foreman-mcp && npx vitest run` to check status
4. Continue from next incomplete item
