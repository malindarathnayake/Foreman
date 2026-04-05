# Foreman MCP v0.0.3 — Spec

**Date:** 2026-04-04
**Fixes:** 2 issues from v0.0.2.1 retest

---

## Fix 1: Tool Schema Enum for write_ledger / write_progress

### Problem

The `operation` parameter in both `write_ledger` and `write_progress` is registered as `z.string()` in the MCP tool schema (foreman-mcp/src/server.ts:119, 144). The strict discriminated union validation happens at runtime inside the handler (foreman-mcp/src/types.ts:70-75, 159-164). This means the model sees `"operation": {"type": "string"}` in the tool definition — a free-form field with no hint of valid values.

Result: every first call fails with a validation error. The model must fail, read the error, and retry. In the v0.0.2.1 retest, this took 3 attempts before success.

### Root Cause

Two-tier validation: loose schema at registration → strict schema at handler. The loose schema was intentional during early development (easier to iterate), but now the operations are stable.

### Fix

Replace `z.string()` with `z.enum([...])` at the tool registration level so valid operations appear in the JSON Schema the model receives.

### Changes

**File: `foreman-mcp/src/server.ts`**

**write_ledger (lines 118-123):**

```typescript
// BEFORE
inputSchema: {
  operation: z.string(),
  unit_id: z.string().optional(),
  phase: z.string().optional(),
  data: z.record(z.unknown()),
},

// AFTER
inputSchema: {
  operation: z.enum(["set_unit_status", "set_verdict", "add_rejection", "update_phase_gate"]),
  unit_id: z.string().optional(),
  phase: z.string().optional(),
  data: z.record(z.unknown()),
},
```

**write_progress (lines 143-146):**

```typescript
// BEFORE
inputSchema: {
  operation: z.string(),
  data: z.record(z.unknown()),
},

// AFTER
inputSchema: {
  operation: z.enum(["update_status", "complete_unit", "log_error", "start_phase"]),
  data: z.record(z.unknown()),
},
```

### What NOT to change

- Keep the discriminated union validation in `foreman-mcp/src/types.ts` — it validates `data` shape per operation. The enum at registration only constrains the operation name; the handler still validates the full shape.
- Keep the operation descriptions in the tool `description` field (foreman-mcp/src/server.ts:109-117, 134-142) — they document the required `data` fields per operation. The enum tells the model WHICH operations exist; the description tells it WHAT each operation needs.

### Verification

After this fix, the JSON Schema exposed to models will show:

```json
{
  "operation": {
    "type": "string",
    "enum": ["set_unit_status", "set_verdict", "add_rejection", "update_phase_gate"]
  }
}
```

The model can now select from valid operations on the first call. The `data` field is still `record<unknown>`, so the model still reads the description for per-operation field requirements — but the operation itself is no longer a guess.

### Test

1. `cd foreman-mcp && npm run build`
2. Restart Claude Code
3. Call `write_ledger` with operation `set_unit_status` — should succeed first try
4. Call `write_progress` with operation `start_phase` — should succeed first try
5. Call `write_ledger` with operation `"init"` — should get a schema-level rejection (not a runtime validation error) that shows the valid enum values

---

## Fix 2: Design-Partner Interactive Pause

### Problem

During the v0.0.2.1 retest, the design-partner skill was invoked via `Skill("design-partner")`. The Skill tool loaded the skill content into the conversation as a system prompt. The model then:

1. Read the skill instructions
2. Generated the scoping questions
3. **Appeared to still be working** ("Worked for 38s · 1 shell still running")

The user saw a spinner, not the questions. The questions were generated inside the model's response, but because the Skill tool was still "running" (the model was producing a long response including both questions and follow-up work), the UI showed a loading state. The user had to ask "is it running?" to discover the questions had been generated.

### Root Cause

The skill text says to "produce scoping questions" (Phase 2) then "iterate on answers" (Phase 3). But it doesn't tell the model to **stop generating and yield control to the user** after outputting the questions. The model treats the entire skill as a single execution flow and tries to keep going — either generating placeholder answers, starting Phase 3 speculatively, or running background tools.

In Claude Code's UI, a long model response during skill execution appears as a spinner with "Worked for Ns". The user can't see intermediate text output until the model finishes its full turn. If the model doesn't explicitly stop after outputting questions, the questions are invisible until the turn completes.

### Fix

Add explicit **YIELD directives** to the design-partner skill at every point where user input is required. These tell the model to:
1. Output the questions as visible text
2. **End its turn** (stop generating)
3. Wait for the user's next message

### Changes

**File: `foreman-mcp/src/skills/design-partner.md`**

**After Phase 2 section (after line 60), add:**

```markdown
### YIELD: Wait for User Answers

After outputting the Scoping Questions, Risks, and Proposed Simplification sections:

**STOP GENERATING. End your turn here.**

Do not proceed to Phase 3. Do not answer the questions yourself. Do not run background tools. Do not start designing.

Output the questions as your complete response and wait for the user to reply with their answers. The user needs to see the questions and make decisions — this is the entire point of the design session.

Resume at Phase 3 only after the user provides answers in their next message.
```

**After Phase 3 section (after line 76), add:**

```markdown
### YIELD: Wait for Follow-Up Answers

If you asked a follow-up question during iteration:

**STOP GENERATING. End your turn here.**

Do not proceed to Phase 4 until the user has answered all follow-up questions and no blocking ambiguities remain.
```

**After Phase 4 section (after line 96, before Phase 4b), add:**

```markdown
### YIELD: User Approval Required

After saving the design summary to `Docs/design-summary.md`:

**STOP GENERATING. End your turn here.**

Present the design summary and ask: "Design summary saved. Review it — does this accurately capture what we decided? Any changes before I hand off to spec generation?"

Do not proceed to Phase 5 (handoff) until the user explicitly approves.
```

### Why YIELD Directives Work

Claude Code's skill system injects skill content as instructions the model follows. The model's default behavior is to complete the entire instruction sequence in one turn if it can. Explicit STOP directives override this — they tell the model that completing Phase 2 IS the complete response for this turn.

This pattern is already proven in other skills:
- The implementor skill says "Stop for review after each testable unit"
- The spec-generator skill says "Do NOT proceed to Step 2 until every ambiguity is resolved"

But those are phrased as conditional gates. The design-partner needs unconditional stops because user input is always required at these points — there's no condition where the model should continue.

### What NOT to change

- Don't change the MCP resource delivery mechanism — the skill content arrives correctly
- Don't add MCP tools for "ask user" — Claude Code already has user interaction built in
- Don't restructure the phases — the design flow is correct, only the pause points are missing

### Verification

1. Invoke `Skill("design-partner")` with a project description
2. Model should output scoping questions and **stop** — no spinner, no background work
3. User sees questions immediately and can type answers
4. Model processes answers and either asks follow-ups (then stops again) or produces design summary (then stops for approval)
5. At no point should the user need to ask "is it running?"

---

## Implementation Order

**All commands below assume working directory is `foreman-mcp/`.**

### Unit 1: Tool Schema Enum

1. Edit `foreman-mcp/src/server.ts` lines 119 and 144 — replace `z.string()` with `z.enum([...])`
2. `cd foreman-mcp && npm run build`
3. Verify: tool schema in MCP handshake shows enum values

### Unit 2: Design-Partner YIELD Directives

1. Edit `foreman-mcp/src/skills/design-partner.md` — add 3 YIELD sections after Phases 2, 3, and 4
2. `cd foreman-mcp && npm run build` (skills are .md, but rebuild ensures no stale dist)
3. Verify: manual test with a design session

### Unit 3: Version Bump + Test Updates

1. Update `foreman-mcp/package.json` version to `0.0.3`
2. Update `foreman-mcp/src/server.ts` version string (line 33) to `0.0.3`
3. Add changelog entry for v0.0.3 in `foreman-mcp/src/tools/changelog.ts`
4. Update version assertions in tests:
   - `foreman-mcp/tests/tools.test.ts:28` — change `bundle_version: 0.0.2` → `bundle_version: 0.0.3`
   - `foreman-mcp/tests/integration.test.ts:95` — change `version: 0.0.2` → `version: 0.0.3` (design-partner)
   - `foreman-mcp/tests/integration.test.ts:105` — change `version: 0.0.2` → `version: 0.0.3` (spec-generator)
   - `foreman-mcp/tests/integration.test.ts:127,132` — change `0.0.2` → `0.0.3` (bundle_status)
5. Update skill frontmatter versions to `0.0.3`:
   - `foreman-mcp/src/skills/design-partner.md:3`
   - `foreman-mcp/src/skills/spec-generator.md:3`
   - `foreman-mcp/src/skills/implementor.md:3`
6. `cd foreman-mcp && npm run build && npm test`

---

## Out of Scope

- Changing `data` from `record<unknown>` to per-operation typed schemas in the tool registration — the MCP SDK does support `oneOf` and `AnySchema` for `inputSchema`, but wiring up discriminated unions for `data` per operation adds complexity beyond this patch's scope
- Adding a `pomo stop` command to the test app
- Changing how MCP resources are delivered (the resource mechanism works fine)
- Adding a dedicated "ask user" MCP tool (unnecessary — model can already yield to user)
