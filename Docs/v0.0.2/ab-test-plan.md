# Foreman MCP v0.0.2 — AB Test Plan

## Goal

Compare the **local Claude Code skill pipeline** (design-partner → Write-spec → pitboss-implementor) against the **MCP-delivered pipeline** (foreman:design-partner → foreman:spec-generator → foreman:implementor) using an identical prompt. Measure: correctness, token efficiency, workflow coherence, and failure modes.

## Test App: CLI Pomodoro Timer

A small Node.js CLI tool — just enough moving parts to exercise the full pipeline without burning excessive tokens.

**Why this app:**
- ~200-300 lines of implementation code (small token footprint)
- Has real architecture decisions (timer state machine, notification, persistence)
- Has integration points (system notifications, file I/O for session log)
- Has error handling (timer interruption, invalid input, file write failures)
- Has testing surface (state machine logic, CLI parsing, persistence)
- Forces the spec generator to make concrete decisions (no hand-waving)
- Forces the implementor to handle state, async, and I/O — enough to trigger real bugs

### The Prompt (identical for both arms)

```
I want to build a CLI pomodoro timer in Node.js (TypeScript).

Features:
- `pomo start` — begins a 25-minute focus session
- `pomo break` — begins a 5-minute break
- `pomo status` — shows current timer state and time remaining
- `pomo log` — shows today's completed sessions

Requirements:
- Timer state persisted to ~/.pomo/state.json so `pomo status` works across invocations
- Session log persisted to ~/.pomo/log.json (date, type, duration, completed)
- Desktop notification via node-notifier when timer completes
- Graceful handling of: timer already running, no active timer, corrupt state file
- Exit code 0 on success, 1 on error

Keep it simple — no config files, no plugins, no web UI.
```

## Arms

### Arm A: Local Skills (Control)

| Stage | Skill | Invocation |
|-------|-------|------------|
| Design | `/design-partner` | Local Claude Code skill |
| Spec | `/Write-spec` | Local Claude Code skill |
| Implement | `/pitboss-implementor` | Local Claude Code skill (this very skill) |

**Environment:**
- Fresh working directory: `~/Coding_Workspace/ab-test/arm-a-local/`
- No foreman MCP server registered (disable in .mcp.json for this session)
- Standard Claude Code with local skills

### Arm B: MCP Pipeline (Treatment)

| Stage | Skill | Invocation |
|-------|-------|------------|
| Design | `foreman:design-partner` | MCP-delivered skill |
| Spec | `foreman:spec-generator` | MCP-delivered skill |
| Implement | `foreman:implementor` | MCP-delivered skill |

**Environment:**
- Fresh working directory: `~/Coding_Workspace/ab-test/arm-b-mcp/`
- Foreman MCP server registered in .mcp.json
- Local skills still present but not invoked (user invokes MCP skills explicitly)

## Measurement Framework

### 1. Workflow Coherence (per stage)

| Metric | How to Measure |
|--------|---------------|
| Session start protocol | Did the skill check bundle_status / read ledger correctly? |
| Handoff clarity | Does the output clearly tell the user what to do next? |
| Tool integration | Did MCP tools (write_ledger, write_progress) fire correctly? |
| Deliberation trigger | If ambiguity arose, did deliberation protocol activate? |

### 2. Spec Quality (after spec generation)

| Metric | How to Measure |
|--------|---------------|
| Grounding checks | Did G1-G8 run? Were any violations caught? |
| Directive specificity | Count vague directives ("handle appropriately") — should be 0 |
| Completeness | All 4 documents generated? All phases have checkpoints? |
| Ambiguity handling | Were ambiguities detected and resolved (not glossed)? |

### 3. Implementation Quality (after implementation)

| Metric | How to Measure |
|--------|---------------|
| Test pass rate | All tests green on first checkpoint? |
| Worker efficiency | Workers spawned / rejections / fix attempts |
| Gate results | G1-G4 all pass? Any findings? |
| Code correctness | Does `pomo start && pomo status && pomo log` actually work? |
| Review findings | Codex/Gemini/Opus review — confirmed issues? |

### 4. Token Efficiency

| Metric | How to Measure |
|--------|---------------|
| Design stage tokens | From Claude Code usage stats |
| Spec stage tokens | From Claude Code usage stats |
| Impl stage tokens | From Claude Code usage stats |
| Total pipeline tokens | Sum of all stages |

### 5. Failure Modes (most important)

| What to Watch For | Why |
|-------------------|-----|
| MCP tool call failures | Are write_ledger/read_ledger calls working? |
| Skill content truncation | Is the full skill body being delivered via MCP? |
| Deliberation tier detection | Does capability_check correctly detect Codex/Gemini? |
| Ledger seeding | Does spec-generator seed correctly for implementor? |
| Cross-session state | Does implementor resume correctly from ledger? |
| Worker brief quality | Are MCP-delivered briefs as good as local ones? |
| Override notice | Does the override mechanism work? |

## Execution Protocol

### Pre-flight
1. Verify foreman MCP is registered and responding: start a fresh Claude Code session, check that `mcp__foreman__bundle_status` returns `0.0.2`
2. Create both working directories
3. Initialize git in both (for diff tracking)
4. Note the Claude Code model and version

### Arm A Execution
1. Open fresh Claude Code session in `arm-a-local/`
2. Disable foreman MCP (comment out in .mcp.json)
3. Paste the prompt
4. Invoke `/design-partner`
5. Answer scoping questions identically to Arm B
6. Approve design summary
7. Invoke `/Write-spec`
8. Review spec, approve
9. Invoke `/pitboss-implementor`
10. Let implementation run to completion
11. Record: tokens used per stage, any errors, final test results

### Arm B Execution
1. Open fresh Claude Code session in `arm-b-mcp/`
2. Ensure foreman MCP is active
3. Paste the prompt
4. Say: "run the foreman:design-partner skill"
5. Answer scoping questions identically to Arm A
6. Approve design summary
7. Say: "invoke foreman:spec-generator"
8. Review spec, approve
9. Say: "invoke foreman:implementor" (or let spec-generator hand off)
10. Let implementation run to completion
11. Record: tokens used per stage, MCP tool call logs, any errors, final test results

### Scoping Question Answers (identical for both arms)

Pre-script answers so both arms get the same inputs:

| Question | Answer |
|----------|--------|
| Runtime | One-shot CLI invocations. No daemon. |
| Persistence | JSON files in ~/.pomo/ |
| Notification | node-notifier (cross-platform) |
| Testing | vitest, mock fs and timers |
| Error handling | Return exit code 1, print error to stderr |
| Scope control | No config, no plugins, no web. Just CLI. |
| Timer accuracy | setTimeout-based, ~1 second polling for status display |
| Architecture | Single package, src/ + tests/ + bin/ |

## Success Criteria

### Arm B (MCP) passes if:
- [ ] All 3 MCP skills load and execute without errors
- [ ] bundle_status returns 0.0.2 at each stage's session start
- [ ] spec-generator seeds ledger + progress successfully
- [ ] implementor reads ledger/progress and resumes correctly
- [ ] Final app works: `pomo start`, `pomo status`, `pomo log` all functional
- [ ] Test suite passes
- [ ] No regressions vs Arm A quality

### Red flags (either arm):
- Skill truncated or missing sections
- Deliberation protocol fails to detect CLIs
- Worker briefs missing context (incomplete BEFORE/AFTER patterns)
- Grounding checks skipped
- Vague directives in spec ("handle errors appropriately")

## Post-Test Analysis

After both arms complete, produce a comparison report:

```markdown
## AB Test Results — Foreman v0.0.2

### Side-by-Side

| Metric | Arm A (Local) | Arm B (MCP) | Delta |
|--------|--------------|-------------|-------|
| Design tokens | | | |
| Spec tokens | | | |
| Impl tokens | | | |
| Total tokens | | | |
| Workers spawned | | | |
| Worker rejections | | | |
| Test pass rate | | | |
| Codex findings | | | |
| App functional? | | | |

### MCP-Specific Observations
- Tool call success rate
- Skill delivery integrity
- Ledger/progress round-trip
- Deliberation tier detection

### Issues Found
[List any bugs, regressions, or gaps]

### Verdict
[Ship / Fix first / Redesign]
```
