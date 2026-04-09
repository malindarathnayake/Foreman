# Foreman MCP v0.0.4 — Spec

**Date:** 2026-04-08
**Changes:** Skill activation tools — full pipeline as MCP tools

---

## Change 1: Skill Activation Tools

### Problem

Foreman delivers 3 skills as MCP resources (`skill://foreman/<name>`), but LLMs don't reliably discover or invoke resources. The skills appear in `listResources()` — a pull-based API the LLM has no reason to call unless prompted. In practice, the LLM never reads the skill resource on its own; the user must explicitly say "read skill://foreman/implementor" or the session hints must direct it there.

This creates a fragile activation path: `session_hint` in `read_progress` tells the LLM to "Read skill://foreman/implementor", but the LLM must parse that URI, call `readResource`, and then follow a 275-line protocol. Two indirections where one would do.

### Root Cause

Skills were modeled as MCP resources (content to be read) rather than MCP tools (actions to be invoked). Resources are passive — they exist but are never pushed. Tools are active — they appear in `listTools()`, have descriptions the LLM reads at session start, and can be called directly.

### Fix

Expose each skill as an MCP tool that, when called, loads the skill markdown (with override support) and returns it as the tool response. The skill protocol is injected directly into the LLM's token set.

Three new tools form the Foreman pipeline:

```
mcp__foreman__design_partner → mcp__foreman__spec_generator → mcp__foreman__pitboss_implementor
```

### Changes

**New files:**

| File | Purpose |
|------|---------|
| `src/lib/skillLoader.ts` | Generic skill loader with 3-tier override: project-local > user-global > bundled |
| `src/tools/activateDesignPartner.ts` | Handler for `design_partner` tool |
| `src/tools/activateSpecGenerator.ts` | Handler for `spec_generator` tool |
| `src/tools/activateImplementor.ts` | Handler for `pitboss_implementor` tool |

**`src/lib/skillLoader.ts` — Override resolution:**

```typescript
// Priority order:
// 1. .claude/skills/<skill-name>/SKILL.md  (project-local)
// 2. ~/.claude/skills/<skill-name>/SKILL.md (user-global)
// 3. <bundledSkillsDir>/<skill-name>.md     (bundled in package)

export interface SkillLoadResult {
  content: string
  source: "project-override" | "user-override" | "bundled"
  path: string
}
```

**`src/server.ts` — Tool registrations (3 new tools, 11 total):**

```typescript
// Tool: pitboss_implementor
// Activates pit-boss/worker orchestration protocol.
// Gates G1-G5, Codex/Gemini deliberation, falls back to Opus agents.
// Input: { context?: string }

// Tool: design_partner
// Activates collaborative design session.
// Pushes back on vague requirements, forces decisions, runs deliberation.
// Produces Docs/design-summary.md. First stage of pipeline.
// Input: { context?: string }

// Tool: spec_generator
// Activates spec generation from design summary.
// Produces spec.md, handoff.md, PROGRESS.md, testing-harness.md.
// Seeds ledger and progress. Second stage of pipeline.
// Input: { context?: string }
```

Each tool returns a TOON header + the full skill markdown:

```
skill: foreman:design-partner
source: bundled
activation_context: new MCP plugin for Slack

---

<full skill markdown content>
```

### What NOT to change

- Keep `skill://foreman/<name>` resource registration — backward compatibility for MCP clients that use the resource protocol
- Keep skill markdown files in `src/skills/` — they're the single source of truth for both tools and resources
- Don't merge the 3 skills into one tool — each skill is a distinct protocol with its own YIELD points, phases, and handoff rules

---

## Change 2: Cross-Reference Updates

### Problem

Error messages in `ledger.ts` and session hints in `progress.ts` direct the LLM to `skill://foreman/implementor` — a resource URI. Skill markdown files direct the LLM to "invoke foreman:spec-generator" — a skill name that doesn't correspond to any tool. These references are now stale.

### Fix

Update all cross-references to use the MCP tool names:

**`src/lib/ledger.ts` (2 error messages):**

```
// BEFORE
"Read skill://foreman/implementor for the full protocol."

// AFTER
"Call mcp__foreman__pitboss_implementor to load the full protocol."
```

**`src/lib/progress.ts` (session hints):**

```
// BEFORE
"WORKFLOW: Read skill://foreman/implementor for the full protocol."
"No units found. Run foreman:spec-generator to create the implementation plan."

// AFTER
"WORKFLOW: Call mcp__foreman__pitboss_implementor to load the full protocol."
"No units found. Call mcp__foreman__spec_generator to create the implementation plan."
```

**`src/skills/design-partner.md` (handoff):**

```
// BEFORE
> Invoke `foreman:spec-generator` to produce formal implementation documents.
- Generate specs (use foreman:spec-generator)

// AFTER
> Call `mcp__foreman__spec_generator` to produce formal implementation documents.
- Generate specs (use mcp__foreman__spec_generator)
```

**`src/skills/spec-generator.md` (handoff + blocker):**

```
// BEFORE
| Next Step | Run `foreman:design-partner` to produce a complete design summary |
> To start implementation, invoke `foreman:implementor`.

// AFTER
| Next Step | Call `mcp__foreman__design_partner` to produce a complete design summary |
> To start implementation, call `mcp__foreman__pitboss_implementor`.
```

**`src/skills/implementor.md` (slash-command guard removed):**

```
// BEFORE
If you are running as a slash command (not via SkillTool), STOP.
Tell the user: "The Foreman implementor must be invoked via SkillTool..."

// AFTER
Note: This skill is delivered by the Foreman MCP bundle via the
`mcp__foreman__pitboss_implementor` tool.
```

### What NOT to change

- Skill frontmatter `name:` field stays as `foreman:implementor` etc. — this is the skill identity, not the tool name
- Override path instructions stay — they're still valid for customization

---

## Change 3: Version Bump

| File | Before | After |
|------|--------|-------|
| `package.json` | `0.0.3-3` | `0.0.4` |
| `server.ts` McpServer constructor | `0.0.3-3` | `0.0.4` |
| `skills/design-partner.md` frontmatter | `0.0.3-3` | `0.0.4` |
| `skills/spec-generator.md` frontmatter | `0.0.3-3` | `0.0.4` |
| `skills/implementor.md` frontmatter | `0.0.3-3` | `0.0.4` |
| `changelog.ts` | — | New entry for 0.0.4 |

---

## Implementation Order

### Unit 1: Skill Loader Library

1. Create `src/lib/skillLoader.ts` — `loadSkill(name, bundledDir)` with 3-tier override
2. Build: `npm run build`
3. Verify: unit tests for bundled load, missing skill error

### Unit 2: Tool Handlers

1. Create `src/tools/activateImplementor.ts`
2. Create `src/tools/activateDesignPartner.ts`
3. Create `src/tools/activateSpecGenerator.ts`
4. Build: `npm run build`

### Unit 3: Server Registration

1. Import handlers in `src/server.ts`
2. Register `pitboss_implementor`, `design_partner`, `spec_generator` tools
3. Build: `npm run build`
4. Verify: `listTools()` returns 11 tools

### Unit 4: Cross-Reference Updates

1. Update `src/lib/ledger.ts` — 2 error messages
2. Update `src/lib/progress.ts` — 2 session hints
3. Update 3 skill markdown files — handoff references, version bump, guard removal
4. Build: `npm run build`

### Unit 5: Version Bump + Changelog

1. `package.json` → `0.0.4`
2. `server.ts` → `0.0.4`
3. `changelog.ts` → new entry
4. Build: `npm run build`

### Unit 6: Test Updates

1. `tests/integration.test.ts` — tool count 11, new tool names, round-trip tests for all 3 skill tools
2. `tests/tools.test.ts` — version assertions, session hint text
3. `tests/skillLoader.test.ts` — unit tests for loader
4. Run: `npm test` — target 103+ tests, all passing

---

## Out of Scope

- Adding `design_partner` or `spec_generator` to session hints — the tools are discoverable via `listTools()` and each skill's handoff now references the next tool by name
- Removing MCP resource registration — kept for backward compatibility
- Adding input validation beyond `context?: string` — the tools are activation pipes, not data tools
- Per-skill override management UI or tooling
- Changing skill content/protocol (only cross-references and the slash-command guard changed)
