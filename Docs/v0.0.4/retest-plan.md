# Foreman MCP v0.0.4 — Re-Test Plan

**Date:** 2026-04-08
**Model:** Claude Opus 4.6 (1M context)

## Goal

Validate that v0.0.4 skill activation tools work end-to-end: the LLM can invoke each pipeline stage as a tool, receive the full protocol, and follow it through to handoff. Confirm cross-references guide the LLM to the correct next tool at each pipeline transition.

## What Changed in v0.0.4

| Change | Why | What to Verify |
|--------|-----|----------------|
| `design_partner` tool | Skills as resources weren't discoverable | Tool appears in `listTools()`, returns full design-partner protocol |
| `spec_generator` tool | Same — resources not invoked by LLMs | Tool appears in `listTools()`, returns full spec-generator protocol |
| `pitboss_implementor` tool | Same | Tool appears in `listTools()`, returns full implementor protocol |
| Skill loader with 3-tier override | Local customization support | Bundled loads by default; user override takes precedence if present |
| Cross-refs: `skill://` → `mcp__foreman__*` | Error messages pointed to resource URIs | Ledger errors and progress hints reference tool names |
| Cross-refs: skill handoffs updated | Skills referenced each other by old names | design-partner → spec_generator, spec-generator → pitboss_implementor |
| Slash-command guard removed from implementor | No longer delivered via slash command | No "must be invoked via SkillTool" error |
| Version bump to 0.0.4 | Release hygiene | `bundle_status` returns `0.0.4`, changelog has 6 entries |

## Pre-flight

1. Verify Foreman MCP is running v0.0.4:
   - `mcp__foreman__bundle_status` returns `bundle_version: 0.0.4`
   - `mcp__foreman__changelog` shows 6 entries including 0.0.4

2. Verify all 11 tools are registered:
   - `listTools()` returns exactly 11 tools
   - Includes: `design_partner`, `spec_generator`, `pitboss_implementor` (plus the 8 data tools)

3. Verify skill resources still registered (backward compat):
   - `listResources()` returns 3 resources: `skill://foreman/design-partner`, `skill://foreman/spec-generator`, `skill://foreman/implementor`

4. Verify test suite:
   - `cd foreman-mcp && npm test` — 103 tests pass

## Execution

### Stage 1: Tool Discovery & Activation

Test each skill tool individually. No project context needed — just verify activation.

**Test 1a: design_partner activation**

1. Call `mcp__foreman__design_partner` with no args
2. Verify response contains:
   - [ ] TOON header: `skill: foreman:design-partner`
   - [ ] Source field: `source: bundled` or `source: user-override`
   - [ ] Separator: `---`
   - [ ] Skill frontmatter: `name: foreman:design-partner`, `version: 0.0.4`
   - [ ] Protocol content: Phase 1, Phase 2, YIELD directives, Phase 5 handoff
   - [ ] Updated handoff reference: `mcp__foreman__spec_generator` (not `foreman:spec-generator`)

**Test 1b: design_partner with context**

1. Call `mcp__foreman__design_partner({ context: "CLI pomodoro timer in TypeScript" })`
2. Verify response contains:
   - [ ] `activation_context: CLI pomodoro timer in TypeScript` in header

**Test 1c: spec_generator activation**

1. Call `mcp__foreman__spec_generator` with no args
2. Verify response contains:
   - [ ] TOON header: `skill: foreman:spec-generator`
   - [ ] Skill frontmatter: `version: 0.0.4`
   - [ ] Protocol content: Ledger Seeding, Grounding Checks G1-G8
   - [ ] Updated blocker reference: `mcp__foreman__design_partner` (not `foreman:design-partner`)
   - [ ] Updated handoff reference: `mcp__foreman__pitboss_implementor` (not `foreman:implementor`)

**Test 1d: pitboss_implementor activation**

1. Call `mcp__foreman__pitboss_implementor` with no args
2. Verify response contains:
   - [ ] TOON header: `skill: foreman:pitboss-implementor`
   - [ ] Skill frontmatter: `version: 0.0.4`
   - [ ] Protocol content: Core Rules table, Per-Unit Workflow, Gates G1-G5
   - [ ] No slash-command guard ("If you are running as a slash command" should NOT appear)
   - [ ] Updated delivery note: `mcp__foreman__pitboss_implementor` tool reference

### Stage 2: Cross-Reference Validation

**Test 2a: Ledger error messages**

1. Call `mcp__foreman__write_ledger` with operation `set_unit_status`, `s: "delegated"`, and a brief shorter than 20 chars
2. Verify error message contains:
   - [ ] `mcp__foreman__pitboss_implementor` (not `skill://foreman/implementor`)

3. Create a unit without delegation, then try to set verdict to pass:
   - `write_ledger({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip" } })`
   - `write_ledger({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })`
4. Verify error message contains:
   - [ ] `mcp__foreman__pitboss_implementor` (not `skill://foreman/implementor`)

**Test 2b: Progress session hints**

1. Call `mcp__foreman__read_progress` on an empty progress file
2. Verify session hint contains:
   - [ ] `mcp__foreman__spec_generator` (not `foreman:spec-generator`)

3. Seed a unit and read progress again:
   - `write_progress({ operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "working" } })`
   - `read_progress`
4. Verify workflow directive contains:
   - [ ] `mcp__foreman__pitboss_implementor` (not `skill://foreman/implementor`)

### Stage 3: Pipeline Flow (End-to-End)

Use the same test app as prior versions (CLI pomodoro timer).

1. Delete existing MCP test arm: `rm -rf ~/Coding_Workspace/ab-test/mcp`
2. Create fresh directory: `mkdir -p ~/Coding_Workspace/ab-test/mcp && cd ~/Coding_Workspace/ab-test/mcp && git init`

**3a: Design phase**

1. Open fresh Claude Code session in `~/Coding_Workspace/ab-test/mcp/`
2. Paste the pomodoro prompt (same as v0.0.3 retest)
3. Say: "call the foreman design_partner tool"
4. Verify:
   - [ ] LLM calls `mcp__foreman__design_partner` (not `readResource`)
   - [ ] LLM receives and follows the design-partner protocol
   - [ ] YIELD checkpoints work (scoping questions, follow-ups, design approval)
   - [ ] Design summary saved to `Docs/design-summary.md`

**3b: Spec phase**

1. After design approval, LLM should reference `mcp__foreman__spec_generator` in its handoff
2. Say: "call the foreman spec_generator tool"
3. Verify:
   - [ ] LLM calls `mcp__foreman__spec_generator` (not `readResource`)
   - [ ] 4 documents generated: spec.md, handoff.md, PROGRESS.md, testing-harness.md
   - [ ] Ledger seeded (units created via `write_ledger`)
   - [ ] Progress seeded (phase started via `write_progress`)
   - [ ] Zero validation errors on first tool calls

**3c: Implementation phase**

1. After spec approval, LLM should reference `mcp__foreman__pitboss_implementor` in its handoff
2. Say: "call the foreman pitboss_implementor tool"
3. Verify:
   - [ ] LLM calls `mcp__foreman__pitboss_implementor` (not `readResource`)
   - [ ] Pitboss/worker pattern executed (workers spawned via Agent tool)
   - [ ] Gates G1-G5 applied
   - [ ] Phase checkpoint with deliberation (Codex/Gemini or Opus fallback)
   - [ ] Final app works: `pomo start`, `pomo status`, `pomo log`

## Success Criteria

### v0.0.4 passes if:

**Skill activation tools:**
- [ ] All 3 tools return full skill protocols (no truncation)
- [ ] TOON headers present with correct skill names and source
- [ ] `activation_context` included when passed
- [ ] Override resolution works (user-override takes precedence over bundled)

**Cross-references:**
- [ ] Zero references to `skill://foreman/` in error messages or session hints
- [ ] Zero references to `foreman:spec-generator` or `foreman:implementor` in tool output
- [ ] Each skill's handoff correctly references the next pipeline tool

**Pipeline flow:**
- [ ] LLM invokes tools (not resources) at each pipeline stage
- [ ] Handoff transitions work: design → spec → implement
- [ ] All existing functionality preserved (YIELD, enums, pitboss enforcement)

**Regression checks:**
- [ ] `bundle_status` returns `0.0.4`
- [ ] `changelog` returns 6 entries
- [ ] 103 tests pass
- [ ] skill:// resources still registered and readable
- [ ] No regressions vs v0.0.3 behavior

### Red flags (abort and investigate):

- Tool returns empty or truncated skill content
- LLM ignores the tool and tries to read the resource instead
- Cross-reference still points to `skill://` URI
- Override loads when none exists, or bundled loads when override exists
- Skill activation breaks YIELD behavior from v0.0.3
- Test count drops below 103

## Comparison Matrix

| Metric | v0.0.3 MCP | v0.0.4 MCP | Native |
|--------|-----------|-----------|--------|
| Tools registered | 8 | 11 | N/A |
| Skill activation | readResource | callTool | Skill tool |
| Pipeline handoff | Manual URI | Tool-to-tool | Skill-to-skill |
| Override support | None | 3-tier | Local only |
| Validation errors | 0 | target: 0 | N/A |
| YIELD checkpoints | 3/3 | target: 3/3 | N/A |
| Tests | 99 | 103 | 35 |

## Post-Test

Record results in `Docs/v0.0.4/retest-results.md`:

```markdown
## v0.0.4 Re-Test Results

### Skill Activation Tools
| Tool | Returns protocol? | TOON header? | Context param? | Override? |
|------|------------------|--------------|----------------|-----------|
| design_partner | | | | |
| spec_generator | | | | |
| pitboss_implementor | | | | |

### Cross-References
| Location | Expected reference | Actual | Pass? |
|----------|--------------------|--------|-------|
| ledger.ts delegation error | mcp__foreman__pitboss_implementor | | |
| ledger.ts verdict error | mcp__foreman__pitboss_implementor | | |
| progress.ts empty hint | mcp__foreman__spec_generator | | |
| progress.ts workflow | mcp__foreman__pitboss_implementor | | |
| design-partner handoff | mcp__foreman__spec_generator | | |
| spec-generator blocker | mcp__foreman__design_partner | | |
| spec-generator handoff | mcp__foreman__pitboss_implementor | | |

### Pipeline Flow
| Stage | Tool invoked? | Protocol followed? | Handoff correct? |
|-------|--------------|-------------------|-----------------|
| Design | | | |
| Spec | | | |
| Implement | | | |

### Overall Metrics
| Metric | v0.0.3 MCP | v0.0.4 MCP | Native |
|--------|-----------|-----------|--------|
| Tools | 8 | | N/A |
| Tests | 99 | | 35 |
| Validation errors | 0 | | N/A |
| YIELD checkpoints | 3/3 | | N/A |
| App functional? | Yes | | Yes |

### Verdict
[All changes confirmed / Partial / Issues found]
```
