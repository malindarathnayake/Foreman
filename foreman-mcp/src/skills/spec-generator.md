---
name: foreman:spec-generator
version: 0.0.4
description: Generate formal implementation documents from a design summary. Produces spec, handoff, progress tracker, and testing harness. Second stage of the Foreman pipeline.
---

Note: This skill is delivered by the Foreman MCP bundle. To customize it,
create a local override at .claude/skills/spec-generator/SKILL.md

CRITICAL: Never write to Docs/.foreman-ledger.json using FileWriteTool or Edit.
All ledger mutations MUST go through mcp__foreman__write_ledger.
Direct file writes to the ledger will be rejected by the Foreman review gate.

## Session Start
1. Call `mcp__foreman__bundle_status` — verify version, log warnings if degraded
2. Call `mcp__foreman__read_ledger` — check if a ledger already exists (avoid overwriting prior state)
3. If ledger exists with active phases → WARN user: "Existing ledger found. Regenerating spec will overwrite it. Confirm before proceeding."
4. Read design summary from `Docs/design-summary.md` or user-provided source

## Core Directive

Transform a design summary into the complete implementation document set. No creativity — this is a translation step. Decisions are already made; format them into documents implementation agents can execute without asking questions.

## Ambiguity Resolution Protocol

This is MANDATORY. The spec writer's #1 failure mode is glossing over ambiguities.

**What counts as ambiguous:**

| Pattern | Example |
|---------|---------|
| Vague error handling | "handle errors appropriately" |
| Unspecified protocol | "use a queue" but not which one |
| Missing auth/retry/timeout | Integration without error behavior |
| Undefined schema | Data flow in prose, shape unspecified |
| Deferred architecture | "defer to implementation" for arch decisions |
| Fuzzy scope | "maybe include X in v1" |
| Unquantified requirements | Performance mentioned but not quantified |

**Resolution flow:**
1. **Detect** — flag every ambiguity while validating design summary or designing implementation order
2. **Classify** — Trivial (one sensible answer given context → resolve with note) or Non-trivial (genuine tradeoffs → escalate)
3. **Escalate non-trivial** — use the built-in Deliberation Protocol (below)
4. **Wait** — do NOT proceed until user arbitrates each ambiguity
5. **Incorporate** — update design context with resolved decisions

**Skip condition:** If user says "skip council" or "just ask me directly", present ambiguities as numbered list for inline resolution.

## Deliberation Protocol

When non-trivial ambiguities need resolution — escalate to multi-model deliberation.

### Detection
1. `mcp__foreman__capability_check({ cli: "codex" })` → codex available?
2. `mcp__foreman__capability_check({ cli: "gemini" })` → gemini available?

### Tier Mapping
| Codex | Gemini | Advisor A | Advisor B | Moderator |
|-------|--------|-----------|-----------|-----------|
| ✓ | ✓ | Codex CLI | Gemini CLI | Opus (you) |
| ✓ | ✗ | Codex CLI | Opus agent | Opus (you) |
| ✗ | ✓ | Gemini CLI | Opus agent | Opus (you) |
| ✗ | ✗ | Opus agent | Opus agent (adversarial) | Opus (you) |

### CLI Invocation

**Codex:**
```bash
codex exec --skip-git-repo-check -s read-only -m gpt-5.4 \
  -c reasoning.effort="high" -c hide_agent_reasoning=true "<PROMPT>"
```
Timeout: 300000ms.

**Gemini (temp file approach):**
```bash
TMPFILE=$(mktemp /tmp/gemini-prompt.XXXXXX) && cat <<'PROMPT' > "$TMPFILE"
<prompt content>
PROMPT
gemini -p "$(cat "$TMPFILE")" -m arch-review --approval-mode plan --output-format text; rm -f "$TMPFILE"
```
Timeout: 300000ms. Gemini is stateless — each call is fresh.

**Opus agent fallback:** Use Agent tool with `model: "opus"` and adversarial critic prompt.

### Prompt Template (both advisors)
```
You are an expert software architect on an architecture review council.
Context: Generating implementation spec from design summary for [project].
AMBIGUITIES: <numbered list of unresolved decisions>
CONSTRAINTS: <from design summary>
CODEBASE CONTEXT: You have access to the codebase in the current directory.

For each ambiguity: recommend a concrete approach with rationale, list tradeoffs,
rate confidence (LOW/MEDIUM/HIGH). Be opinionated. Take a clear position.
```

### Protocol (6 phases, max 3 cross-examination rounds)
| Phase | Action |
|-------|--------|
| 1. Independent Analysis | Send same ambiguities to both advisors in parallel |
| 2. Moderator Digest | Summarize positions, flag: [HALLUCINATION RISK], [OVER-ENGINEERING], [MISSING EVIDENCE], [SYNCOPHANCY RISK] |
| 3. Cross-Examination | Each challenges the other. Max 3 rounds. Re-embed context for Gemini. |
| 4. Convergence Check | Full → Phase 5. Partial → another round. Deadlock after 3 → present both. |
| 5. Council Report | Consensus or competing proposals with moderator recommendation |
| 6. User Arbitration | User picks. Do NOT proceed until user decides. |

### Cross-Examination Prompt Template
```
SPEC COUNCIL — ROUND N CROSS-EXAMINATION
CODEBASE CONTEXT: <key excerpts for stateless advisors>
Your previous recommendation: <summary>
Opposing recommendation: <summary>
Their key arguments: <bullets>

Tasks: 1. Identify weakest points in opposing view 2. Challenge with codebase evidence
3. Defend where you're right 4. CONCEDE where opposing view is better
5. Propose synthesis if both have merit. Do NOT be agreeable for the sake of it.
```

### Anti-Patterns
- Do NOT relay outputs verbatim — summarize and compare
- Do NOT let advisors see raw output from each other
- Do NOT average recommendations — push for a winner
- Do NOT accept unanimous agreement without verification
- Do NOT run more than 3 cross-examination rounds

## Agent Delegation

Use `code-searcher` sub-agent for grounding checks:
- G1: version numbers, line numbers, file paths
- G3: all references to shared dependencies
- G5: code around insertion points for control-flow
- G7: test suite grep for changed symbols
- G8: controller/handler response models

Launch multiple agents in parallel for independent checks. Do not wait for one to finish before starting another.

## Uncertainty Protocol

When facts cannot be confirmed from available files, declare explicitly:

**`UNKNOWN: [thing]`** — not knowable without external input
- State what is unknown and the fastest way to find out
- State what spec section is blocked until resolved

**`UNVERIFIED: [claim]`** — believed true but not confirmed from live files
- State confidence level and how to verify
- State what is blocked until verified

Rules: Never use "maybe", "might", "I think", "probably" for system behavior in any generated document. All UNKNOWN/UNVERIFIED items in the spec must appear in Out of Scope or as explicit blocking items.

## Inputs

Needs a design summary with: problem statement, architecture, key decisions, integration points, error handling, scope boundaries, testing archetype.

Sources: `Docs/design-summary.md`, pasted in conversation, or referenced file.

If missing critical sections → list what's missing, don't fill gaps with assumptions.

**Block condition:** If the design summary is absent or lacks a problem statement and architecture, stop immediately:

| Field | Content |
|-------|---------|
| Blocker | Specific missing section(s) |
| What I Need | Exact content required to proceed |
| Next Step | Call `mcp__foreman__design_partner` to produce a complete design summary |

Do NOT generate partial spec documents from incomplete design summaries. A spec built on gaps will produce an implementation that fails at the seams.

## Procedure

### Step 1: Validate Design Summary

Check completeness across 10 items:

| Item | Required |
|------|----------|
| Problem statement | Clear, 1-3 sentences |
| Architecture | Diagram or plain-text structure |
| Key decisions | Table with rationale |
| Integration points | All external systems with protocols |
| Error handling | Per-scenario behavior |
| Scope boundaries | In scope AND out of scope |
| Testing archetype | Named archetype |
| Config surface | Tunable settings identified |
| Observability | Metrics and logging defined |
| Open items | None blocking, or explicitly deferred |

Classify gaps as: missing sections (need design session before proceeding) or ambiguous sections (escalate via deliberation protocol).

### Step 2: Determine Language and File Patterns

Identify: language, config format, test framework, test command, file extension. Read actual project files — do not guess.

### Step 3: Design Implementation Order

Break into phases and units. Rules:
- Each phase independently testable
- Units are 1-3 files
- Dependencies flow forward only
- Start with types/models, build outward
- Each unit has exactly one test command that confirms it works
- Run ambiguity gate here too — flag anything that would require a guess during implementation

**Phase checkpoint format:** After the last unit of each phase, specify a checkpoint command the implementor runs to confirm the entire phase is working before moving forward. The checkpoint must be runnable without future units present.

### Step 4: Generate Four Documents

Write `Docs/spec.md`, `Docs/handoff.md`, `Docs/PROGRESS.md`, `Docs/testing-harness.md`.

## Document Templates

### Document 1: `Docs/spec.md`

Sections (terse):
- **Intent** — one paragraph, what this builds and why
- **Decisions & Notes** — table: Decision | Choice | Rationale | Source
- **Architecture** — mermaid or text diagram + file structure tree
- **Config Schema** — actual format for the project language (not prose)
- **Integration Discovery Findings** — if discovery was performed, what was found
- **Core Behavior** — numbered happy-path steps, no branching
- **Metrics/Outputs** — table: Metric | Type | Source | Notes
- **Error Handling** — table: Scenario | Behavior | Recovery
- **Dependencies** — table: Package | Version | Purpose (real versions or UNKNOWN)
- **Out of Scope** — explicit list
- **Testing Strategy** — archetype, what-to-test table, what-NOT-to-test, mock boundaries table, critical path, coverage targets table
- **Implementation Order** — phases with units; each unit has: files, directives, test command, DO NOT items; checkpoints between phases

### Document 2: `Docs/handoff.md`

Sections (terse):
- **Project Overview** — one paragraph + link to spec.md
- **Before Starting** — session protocol (read spec, read this, read PROGRESS.md)
- **Rules** — implementation rules list (no scope additions, no skipping tests, etc.)
- **Implementation Order** — copy phases/units from spec with additional dependency/pitfall context per unit
- **Testing Strategy** — archetype name + link to testing-harness.md
- **Quick Reference** — checkpoint commands table, error recovery table
- **Start** — first session instructions vs resuming mid-implementation

### Document 3: `Docs/PROGRESS.md`

Sections (terse):
- **Current Status** — phase, last completed unit, next up, blocked (if any)
- **Checklist** — per-phase checkboxes with file names and checkpoint commands
- **Decisions & Notes** — table: Decision | Value | Source (populated from spec)
- **Session Log** — table: Date | Phase | Unit | Outcome | Notes
- **Error Recovery Log** — table: Date | Error | Fix | Status; plus recovery protocol
- **Context Management** — five questions table an implementor should answer at session start; new-chat policy
- **Environment Notes** — language version, required env vars, setup commands

### Document 4: `Docs/testing-harness.md`

Sections (terse):
- **Archetype** — named archetype with one-line description
- **Operator Questions** — pre-filled where known, UNKNOWN where not
- **Test Tiers** — unit → mocked integration → real integration → e2e (per-tier: what it tests, how to run, when to run)
- **Archetype-Specific Patterns** — patterns specific to the archetype (e.g. hermetic server for HTTP, table-driven for pure functions)
- **Quick Reference** — run command, seed command, reset command
- **Pre-Implementation Discovery** — if deferred integrations exist, discovery steps before first test can run

## Grounding Checks (Mandatory)

Run AFTER drafting all documents but BEFORE delivering to user.

### G1: Verify facts against live files, not memory
For every version number, line number, file path, or package reference in the spec/handoff:
- **Open the actual file and confirm the value.** Do NOT trust auto-memory, prior conversation context, or your own earlier statements.
- If the spec says "bump version X → Y", read the .csproj / package.json / pyproject.toml and confirm X is the current value.
- If the spec says "line 438", read the file and confirm line 438 contains what you claim.
*Catches: stale memory producing wrong version numbers.*

### G2: Verify file write locations
After writing any document with the Write tool:
- **Glob or ls to confirm the file landed where you expect.** The Write tool's absolute path may resolve differently than the relative path you reference.
- Cross-check the path in every document header, cross-reference link, and "Read the full spec" pointer.
*Catches: files landing in wrong directories.*

### G3: Search for ALL dependents, not just the obvious one
When a spec changes a shared dependency (package version, config key, API contract):
- **Search the entire repo** for all references to that dependency.
- Every match must appear in the file change summary.
*Catches: updating one project's reference but missing another's identical pin.*

### G4: Trace each unit's verification against per-unit state
For every verification step in the handoff:
- **Replay only that unit's changes** and confirm the verification is true at that point.
- Do not reference later units' outcomes.
*Catches: verification steps describing end-state instead of per-unit state.*

### G5: Trace code placement against control flow
When the spec says "add code at line N" or "after X":
- **Read 10 lines above and below.** Confirm new code is reachable — not after return/throw/break.
- For languages with local functions after returns, confirm insertion is in executable body.
*Catches: code placed after return statements.*

### G6: Name concrete test files
Every test instruction must include:
- Exact file path of the test file
- Test helper/factory to use (with import path)
- Test command to run
*Catches: vague "run tests" instructions.*

### G7: Test-suite impact analysis for behavior changes
When a unit changes observable behavior:
- **Grep the entire test suite** for every symbol/rule-ID/field being changed.
- Every existing assertion on OLD behavior must be explicitly accounted for (updated, rewritten, or deleted).
*Catches: new tests added but old tests still assert old behavior.*

### G8: Verification step endpoint confirmation
When a unit includes "check endpoint X for Y":
- **Read the actual response model.** Confirm it includes the needed fields.
- Do NOT write verification steps from memory of the API surface.
*Catches: verification steps pointing to wrong endpoints.*

## Ledger Seeding

After generating the handoff document, seed the ledger with the implementation structure:

For each phase and unit in the implementation order:
```
mcp__foreman__write_ledger({
  operation: "set_unit_status",
  phase: "<phase-id>",
  unit_id: "<unit-id>",
  data: { s: "pending" }
})
```

This creates the phase/unit structure so the implementor starts with pre-populated state.

## Progress Seeding

After generating PROGRESS.md, seed the progress state:

```
mcp__foreman__write_progress({
  operation: "start_phase",
  data: { phase: "<phase-1-id>", name: "<Phase 1 Name>" }
})

For each unit:
mcp__foreman__write_progress({
  operation: "update_status",
  data: { unit_id: "<id>", phase: "<phase-id>", status: "pending", notes: "<description>" }
})
```

## Output + Handoff

Save four documents to `Docs/`. Tell the user:

> Four documents generated in `Docs/`. Review `spec.md` first. To start implementation, call `mcp__foreman__pitboss_implementor`.

If blocking open items remain, list them and refuse to hand off.

## Quality Checks

Run before delivering documents to user:

- [ ] Every directive names specific library/function/pattern
- [ ] Every external call in error handling matrix
- [ ] Every config value has a source
- [ ] Every phase has runnable checkpoint command
- [ ] Out of scope explicit and complete
- [ ] Dependency versions real or marked UNKNOWN
- [ ] File structure matches implementation order
- [ ] G1-G8 grounding checks all completed
- [ ] Ledger seeding calls issued for all phases and units
- [ ] Progress seeding calls issued for phase 1
- [ ] No ambiguities remain open (all resolved or explicitly deferred with user sign-off)
- [ ] handoff.md first-session instructions are executable without reading anything else first

## What This Skill Does NOT Do
- Design from scratch (decisions must exist in design summary; ambiguities resolved via deliberation)
- Implement code
- Guess at libraries or versions (marks UNKNOWN)
- Add scope beyond design summary
- Write vague directives like "handle the error" or "add appropriate logging"
- Run deliberation when user opts out — present numbered list instead
- Proceed past open blocking ambiguities without user resolution
- Skip G1-G8 grounding checks even when the spec seems obvious
