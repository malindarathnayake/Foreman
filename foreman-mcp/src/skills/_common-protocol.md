<!-- section: ledger-critical -->
## Ledger Critical

CRITICAL: Never write `.foreman-ledger.json` directly — all mutations go through `mcp__foreman__write_ledger`. Direct edits corrupt the ledger's invariants and are silently overwritten on the next MCP write.
<!-- /section -->

<!-- section: session-start -->
## Session Start

1. `mcp__foreman__bundle_status` — verify version, log warnings
2. `mcp__foreman__read_ledger` with query "full" — get current state
3. `mcp__foreman__read_progress` — truncated view
4. `mcp__foreman__write_journal({ operation: "init_session", data: { target_version: "<version>", branch: "<branch>", phase: <N>, units: ["<unit ids>"], env: { agent: "opus", worker: "sonnet", codex: null, gemini: null } } })`
5. Find handoff.md in `Docs/` or `docs/`
6. Answer the five questions:

| Question | Source |
|----------|--------|
| Where am I? | Ledger current phase/unit status |
| Where am I going? | Progress checklist |
| What is the goal? | spec.md Intent |
| What has been tried? | Ledger unit history |
| What failed? | Ledger rejection history |

7. Do NOT rely on host plan/task state — ledger is the single authority

**Resume handling:**

| Input | Action |
|-------|--------|
| "resume" | Trust ledger position; pick up at first non-passing unit |
| "phase N" | Verify all units in phases before N show pass verdicts; then proceed |
| Path to handoff | Use that file as handoff; cross-reference with ledger for position |
| Empty (no args) | Auto-detect: read ledger for current phase, find first pending unit |

**Mid-flight handling:** If ledger shows a unit as `ip` (in-progress) at session start, treat it as not started — re-read the files, re-build the brief, re-spawn the worker. Do not assume the prior worker's changes are correct.
<!-- /section -->

<!-- section: deliberation-protocol -->
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
Both CLIs are invoked via `invoke_advisor` — no shell commands needed.
**Codex:** `mcp__foreman__invoke_advisor({ cli: "codex", prompt: "<PROMPT>" })`
**Gemini:** `mcp__foreman__invoke_advisor({ cli: "gemini", prompt: "<PROMPT>" })`
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
<!-- /section -->

<!-- section: ambiguity-resolution -->
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
3. **Escalate non-trivial** — use the built-in Deliberation Protocol (above)
4. **Wait** — do NOT proceed until user arbitrates each ambiguity
5. **Incorporate** — update design context with resolved decisions

**Skip condition:** If user says "skip council" or "just ask me directly", present ambiguities as numbered list for inline resolution.
<!-- /section -->

<!-- section: uncertainty-protocol -->
## Uncertainty Protocol

When facts cannot be confirmed from available files, declare explicitly:

**`UNKNOWN: [thing]`** — not knowable without external input; state what is unknown and what spec section is blocked.

**`UNVERIFIED: [claim]`** — believed true but not confirmed from live files; state confidence level and what is blocked.

**Rules:**
- Never use "maybe", "might", "I think", "probably" for system behavior in any generated document
- All UNKNOWN/UNVERIFIED items must appear in Out of Scope or as explicit blocking items
- Unknowns and unverifieds blocking architecture or integration go in Open Items as blocking
- Use `code-searcher` to resolve unknowns about the existing codebase before labeling them UNKNOWN
<!-- /section -->

<!-- section: error-handling-standard -->
## Error Handling Standard

| Scenario | Behavior |
|----------|----------|
| Worker timeout/crash | Log in ledger, spawn new worker |
| Worker code doesn't compile | Worker inner loop. Still failing → pit-boss fix worker |
| Tests fail after worker | Inner loop for mechanical. Spec failures → pit-boss rejects |
| 3 fix attempts exhausted | Escalate to user with ledger history |
| CLI unavailable for review | Ask user for explicit waiver |
| Spec ambiguity discovered | STOP, ask user. Do not guess. |
| MCP tool call fails | Retry once. If persistent, log error and continue with degraded state |

| Attempt | Action |
|---------|--------|
| 1 | Diagnose root cause, targeted fix |
| 2 | Different approach entirely |
| 3 | Check docs/examples for correct pattern |
| 4+ | STOP — escalate to user |
<!-- /section -->

<!-- section: agent-delegation -->
## Agent Delegation

Use the `code-searcher` sub-agent for search-heavy tasks — symbol greps across the test suite, data-flow searches, locating plan docs, any 3+ file scan. Skip sub-agents for 1–2 reads; they cost context.

- Typical uses: grounding checks (versions, paths, signatures), G4 symbol grep across the test suite.
- Launch multiple agents in parallel for independent checks.
<!-- /section -->

<!-- section: advisor-grounding -->
## Advisor Grounding Protocol

When invoking an advisor (codex/gemini or Opus agent) on code that depends on a specific library, framework, or SDK, include in the prompt: (a) the current relevant imports from the actual source file, (b) a short excerpt or link to the library's documented behavior, and (c) the specific call site line numbers. Without this context advisors hallucinate library APIs and flag phantom bugs.

Rule: if the review target touches a third-party API, paste the imports and the relevant doc excerpt into the advisor prompt; do not rely on the advisor's training recall.
<!-- /section -->

<!-- section: context-budget -->
## Context Budget Discipline

At phase checkpoints, estimate context utilization. If used > 70%, do not proceed into the next phase in the same session — persist all state to the ledger and journal, return a clean handoff, and require a fresh session to resume. Carrying stale context across phases degrades gate judgment and increases rejection cost.

Rule: at every phase-end, honestly estimate `ctx_used_pct` in the `end_session` journal entry, and if it exceeds 70%, refuse to start the next phase in the current session.
<!-- /section -->

<!-- section: no-test-attestation -->
## No-Test Phase Attestation

When a phase is declared with `scope.has_tests: false` or `scope.has_build: false`, the phase verdict must carry an explicit attestation in the `note` field of each unit's `set_verdict` call, describing how the unit was validated in place of automated tests (e.g. manual smoke, downloaded artifact hash, console inspection). Silent verdicts on scopeless phases are forbidden — they hide lazy delegation.

Rule: if `scope.has_tests === false`, pit-boss MUST pass a `note` string to every `set_verdict` call in that phase.
<!-- /section -->
