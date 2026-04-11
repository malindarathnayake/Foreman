# Foreman MCP v0.0.6 — AB Test Plan

## Goal

Compare the **local Claude Code skill pipeline** (design-partner → Write-spec → pitboss-implementor) against the **MCP-delivered pipeline** (foreman:design-partner → foreman:spec-generator → foreman:implementor) using an identical prompt. Measure: correctness, token efficiency, workflow coherence, session journal telemetry, schema cap enforcement, and failure modes.

**v0.0.6 focus areas:** Verify that security hardening (schema caps, FIFO caps, PATH resolution) does not regress pipeline behavior, and that the new session journal captures operational telemetry end-to-end.

## Test App: CLI Expense Tracker

A small Node.js CLI tool — just enough moving parts to exercise the full pipeline plus the new v0.0.6 surfaces.

**Why this app:**
- ~250-350 lines of implementation code (small token footprint)
- Has real architecture decisions (data model, storage, aggregation)
- Has integration points (file I/O for expense log, CSV export)
- Has error handling (invalid amounts, corrupt data file, missing categories)
- Has testing surface (aggregation logic, CLI parsing, persistence, edge cases)
- Forces the spec generator to make concrete decisions (no hand-waving)
- Forces the implementor to handle validation, I/O, and data transformation — enough to trigger real bugs
- Generates enough test output to exercise runTests bounded output and hard memory cap

### The Prompt (identical for both arms)

```
I want to build a CLI expense tracker in Node.js (TypeScript).

Features:
- `expense add <amount> <category> [description]` — records an expense with today's date
- `expense list [--category <cat>] [--since <date>]` — shows expenses, optionally filtered
- `expense summary [--month <YYYY-MM>]` — shows totals by category for current or specified month
- `expense export [--format csv|json]` — exports all expenses to stdout

Requirements:
- Expenses persisted to ~/.expenses/data.json (date, amount, category, description)
- Amount must be a positive number with at most 2 decimal places
- Categories are free-form strings, case-insensitive for matching
- Summary shows per-category totals and grand total
- Graceful handling of: corrupt data file, invalid amount, missing required args
- Exit code 0 on success, 1 on error

Keep it simple — no config files, no plugins, no web UI, no database.
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
| Tool integration | Did MCP tools (write_ledger, write_progress, write_journal) fire correctly? |
| Deliberation trigger | If ambiguity arose, did deliberation protocol activate? |
| Schema cap enforcement | Did any oversized input get rejected by Zod caps? (should not happen in normal use) |

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
| Gate results | G1-G5 all pass? Any findings? |
| Code correctness | Does `expense add 12.50 food lunch && expense list && expense summary` actually work? |
| Review findings | Codex/Gemini/Opus review — confirmed issues? |
| run_tests usage | Did implementor use `mcp__foreman__run_tests` instead of Bash for test execution? |

### 4. Token Efficiency

| Metric | How to Measure |
|--------|---------------|
| Design stage tokens | From Claude Code usage stats |
| Spec stage tokens | From Claude Code usage stats |
| Impl stage tokens | From Claude Code usage stats |
| Total pipeline tokens | Sum of all stages |

### 5. Session Journal Telemetry (Arm B only)

| Metric | How to Measure |
|--------|---------------|
| init_session fired | `read_journal` returns at least 1 session with env auto-detected |
| Events logged | `read_journal` shows events with valid event codes (W_FAIL, W_REJ, etc.) |
| end_session fired | Last session has dur_min, ctx_used_pct, and summary filled |
| Rollup computed | After 5+ sessions, `read_journal({ rollup_only: true })` returns aggregated stats |
| FIFO enforced | After many sessions, oldest sessions are dropped (50 cap) |
| tok/wait as numbers | Journal event tok and wait fields are numbers, not strings |

### 6. Security Hardening Verification

| What to Verify | How |
|----------------|-----|
| Schema caps don't block normal use | All MCP tool calls succeed with typical inputs |
| run_tests PATH resolution | `capability_check` and `run_tests` both resolve runners to absolute paths |
| error_log FIFO | After 20+ errors logged, only the last 20 are retained |
| normalize_review caps | reviewer max 200, raw_text max 50000 — normal reviews fit within caps |
| Inline schema caps | All read/write tool inputs accepted at normal sizes |

### 7. Failure Modes (most important)

| What to Watch For | Why |
|-------------------|-----|
| MCP tool call failures | Are write_ledger/read_ledger/write_journal calls working? |
| Skill content truncation | Is the full skill body being delivered via MCP? |
| Deliberation tier detection | Does capability_check correctly detect Codex/Gemini? |
| Ledger seeding | Does spec-generator seed correctly for implementor? |
| Cross-session state | Does implementor resume correctly from ledger? |
| Worker brief quality | Are MCP-delivered briefs as good as local ones? |
| Override notice | Does the override mechanism work? |
| Schema rejection false positives | Do Zod caps reject any legitimate input? |
| Journal write failures | Does write_journal error on valid input? |
| runTests runner resolution | Does `which` resolve runners correctly? Does `path.isAbsolute` reject bad paths? |

## Execution Protocol

### Pre-flight
1. Verify foreman MCP is registered and responding: start a fresh Claude Code session, check that `mcp__foreman__bundle_status` returns `0.0.6`
2. Verify tool count: `mcp__foreman__bundle_status` returns `0.0.6` and MCP `listTools()` shows 14 tools
3. Verify journal: `mcp__foreman__read_journal` should return fresh or existing journal
4. Create both working directories
5. Initialize git in both (for diff tracking)
6. Pin Claude Code model: both arms MUST use the same model (e.g., Opus 4.6). Note version.

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
11. Record: tokens used per stage, MCP tool call logs, journal entries, any errors, final test results
12. After completion: `mcp__foreman__read_journal` — capture full journal output

### Scoping Question Answers (identical for both arms)

Pre-script answers so both arms get the same inputs:

| Question | Answer |
|----------|--------|
| Runtime | One-shot CLI invocations. No daemon. |
| Persistence | JSON file in ~/.expenses/ |
| Output formats | CSV and JSON export to stdout. Default export format: JSON. |
| Testing | vitest, mock fs |
| Error handling | Return exit code 1, print error to stderr |
| Scope control | No config, no plugins, no web. Just CLI. |
| Amount validation | Positive number, max 2 decimal places, reject NaN/negative/zero |
| Architecture | Single package, src/ + tests/ + bin/ |
| Money storage | Store as number (not cents integer). Round to 2 decimals on input. |
| Dates/timezone | Store as ISO 8601 UTC strings. `--since` is inclusive. |
| Category handling | Store as-given (preserve case). Match case-insensitive for filters/summary. |
| Description with spaces | Rest of args after category joined with spaces. Optional. |
| Corrupt data file | Back up corrupt file, start fresh, print warning to stderr. |
| CLI parser | Use `process.argv` manual parsing (no commander/yargs dependency). |
| Cleanup before test | `rm -rf ~/.expenses` between arms to prevent contamination. |

## Success Criteria

### Arm B (MCP) passes if:
- [ ] All 3 MCP skills load and execute without errors
- [ ] bundle_status returns 0.0.6 at each stage's session start
- [ ] Tool count is 14 (includes write_journal + read_journal)
- [ ] spec-generator seeds ledger + progress successfully
- [ ] implementor reads ledger/progress and resumes correctly
- [ ] implementor uses run_tests instead of Bash for test execution
- [ ] Final app works: `expense add`, `expense list`, `expense summary`, `expense export` all functional
- [ ] Test suite passes
- [ ] No schema cap false positives (no Zod rejections on valid input)
- [ ] Session journal records at least 1 session with env, events, and summary
- [ ] No regressions vs Arm A quality

### Red flags (either arm):
- Skill truncated or missing sections
- Deliberation protocol fails to detect CLIs
- Worker briefs missing context (incomplete BEFORE/AFTER patterns)
- Grounding checks skipped
- Vague directives in spec ("handle errors appropriately")
- Schema caps rejecting normal-length inputs
- run_tests failing to resolve runner via which
- Journal write_journal calls failing silently

## Post-Test Analysis

After both arms complete, produce a comparison report:

```markdown
## AB Test Results — Foreman v0.0.6

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
- run_tests usage (vs Bash fallback)

### v0.0.6 Security Hardening Observations
- Schema cap behavior during normal pipeline execution
- Any Zod rejection errors encountered
- runTests PATH resolution behavior
- error_log FIFO cap behavior (if >20 errors logged)

### Session Journal Observations
- init_session / log_event / end_session call count
- env auto-detection accuracy (os, node, foreman version)
- Event code distribution
- Rollup computation (if 5+ sessions ran)
- Journal file size and FIFO behavior

### Issues Found
[List any bugs, regressions, or gaps]

### Verdict
[Ship / Fix first / Redesign]
```
