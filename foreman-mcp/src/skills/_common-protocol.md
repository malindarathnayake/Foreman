<!-- section: ledger-critical -->
## Ledger Critical

CRITICAL: Never write `.foreman-ledger.json` directly — all mutations go through `mcp__foreman__write_ledger`. Direct edits corrupt the ledger's invariants and are silently overwritten on the next MCP write.
<!-- /section -->

<!-- section: session-start -->
## Session Start

1. `mcp__foreman__bundle_status` — verify version, log warnings
2. `mcp__foreman__session_orient` — the ONLY resume authority. Follow its `action` and `resume_target`.
3. If `state_drift` is not `none`, STOP and reconcile ledger/progress before delegation. Never choose the progress target over the ledger target. If `missing_declared_units` is not `none`, seed those units (`set_unit_status s:'pending'`) before delegation — they are declared spec scope the ledger doesn't track yet.
4. `mcp__foreman__read_progress` — ledger status from the same calculation as `session_orient`, followed by descriptive checklist notes. Use ledger `units_passed`/`units_total` and `phases_done`/`phases_total` when reporting progress. Checklist `entries_marked_complete` is not project completion; all unit verdicts passing can still leave a phase gate pending.
5. `mcp__foreman__read_ledger` — read only the bounded slice needed for the current action, e.g. `read_ledger({ query: "verdicts", phase: "<current-phase>", limit: 50 })` or `read_ledger({ phase, unit_id })`. Never start a session with `query:"full"`. Table cells clip at 240 chars — a unit's full verdict note comes from `read_ledger({ phase, unit_id })`; full rejection/review text from `read_ledger({ query: "full", phase })`.
6. `mcp__foreman__write_journal({ operation: "init_session", data: { target_version: "<version>", branch: "<branch>", phase: "<phase-id>", units: ["<unit ids>"], env: { agent: "frontier-pitboss", model: "<your model, or unknown>", effort: "<your reasoning effort, or unknown>", worker: "configured-worker", claude: null, codex: null, gemini: null } } })` — {{session_advisor_setup}} If the handoff declares units for the current (not-yet-passed) phase that the ledger doesn't know, `declare_phase_units` + seed them before delegation; if such units surface for a phase whose gate already passed, STOP and escalate — reopening a gate is a user decision.
7. Find handoff.md in `Docs/` or `docs/`
8. Answer the five questions:

| Question | Source |
|----------|--------|
| Where am I? | `session_orient` ledger-derived `action` + `resume_target` |
| Where am I going? | `session_orient` next pending unit; spec/handoff for planned scope |
| What is the goal? | spec.md Intent |
| What has been tried? | Ledger unit history |
| What failed? | Ledger rejection history |

9. Do NOT infer completion or a resume target from host plan/task state or checklist entries — the ledger through `session_orient` is the single authority; `read_progress` mirrors that calculation.

**Declared workflow rank:** At startup, report your model and reasoning effort as known; say `unknown` when unavailable. Foreman trusts this declaration and computes the rank; do not submit a rank or infer one from the worker model. Weight 3 Top: Astra (`gpt-6-astra`) at `high`, `xhigh`, `max` or `ultra`, and Fable 5.1. Weight 2 Middle: Opus or Terra. Weight 1 Standard: Sonnet or Luna. Weight 0 Unknown: other or undeclared models, including Sol. Standard and Unknown use normal Foreman protocol without blocking startup. Rank is separate from configured `agent_class`, worker capability and cost tier; weights never add across agents.

Use permitted shortcuts automatically: Middle can reuse a native worker for mechanical corrections with a compact follow-up; Top additionally permits bounded fixes/test changes, focused intermediate checks and independently verified delta review. Existing ownership, authorization, attempt limits and checkpoint gates still apply. All implementation, fixes and test edits require a worker in the implementor protocol. A compact follow-up records the correction once against its prior brief; do not rewrite unchanged facts across multiple records. A correction's finding rides the delegated write (`data.rejection`) and a post-gate escape class rides the rejection or the verdict (`escape_class`); neither skips the guard, the attempt cap, or the checkpoint review.

If your model or effort changes within this session, call `write_journal({ operation: "declare_model", data: { model: "<current model>", effort: "<current effort>" } })` before the next workflow action. This replaces both fields; omitted or unknown information grants no shortcut. Each new session declares again; ending the session or restarting the server clears the active declaration. Previously accepted review evidence retains its provenance after a host/model switch; the next action uses the incoming rank. `session_orient` and `read_progress` expose `model_rank`, `model_weight` and `workflow_permissions`.

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

### Choosing the seat kind

| Deliberation shape | Seat kind | Why |
|---|---|---|
| Review of a **concrete change or plan** (diff, checklist, patch, grounding report) | `invoke_council` — remote lens seats | Packet-bound, parallel, lens-scoped, structured findings, cheap enough to run at every checkpoint |
| **Open design question** with no artifact yet ("which approach?") | CLI advisor seats | Council seats are stateless and see ONLY the packet — they cannot explore the codebase to form a design position |

Both kinds feed the same 6-phase protocol below, and both stop at user arbitration.

### Detection

**The council is entirely optional.** Foreman with no council configured behaves exactly as it always has — this is the normal flow, not a degraded one. There is nothing to install, no probe to run, and no warning to surface.

- Council: `mcp__foreman__invoke_council` returns `status: unavailable` when no seats are configured. That response names the next rung itself, so no separate capability check exists or is needed.
- Advisors: {{advisor_checks}}

### Tier Mapping
Take the highest available rung. Every rung below the first is RECORDED, not silent.

| Rung | Available | Review path | Independence |
|---|---|---|---|
| 1 | ≥2 council seats | `invoke_council` across the selected lenses; add a CLI advisor for open design questions | Independent — disclose vendor correlation |
| 2 | 1 council seat | `invoke_council` with the single seat; note single-seat coverage in the review record | Independent, single perspective |
| 3 | No council, both advisors | Invoke both advisors independently | Independent |
| 4 | No council, one advisor | That advisor + recorded non-independent fallback | Partial — record it |
| 5 | Nothing available | {{advisor_fallback}} | NOT independent — say so in the ledger |

Rules that hold at every rung:

- `status: unavailable` is **not** a failed review and **not** a passed one. Drop to the next rung and carry on with the normal Foreman flow.
- A council returning `status: fail` (every seat failed) does not promote the review to "passed" either — same rule, drop a rung.
- Two seats on one model is **perspective, not independence**. Whenever rung 5 is used, or two council seats share a vendor, say so in the review record.

### Advisor Invocation
Advisor invocation is host-specific. The active host is resolved at server start (default: Claude Code; set `FOREMAN_HOST=cursor` or pass `--host=cursor` for Cursor mode).

{{advisor_a}}
{{advisor_b}}
{{advisor_fallback}}

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
2. **Classify** — Empirical (a fact about a system outside the repository that a side-effect-free probe with a credential the project holds can answer → run the Probe check, probe first, record the result, then it is Trivial), Trivial (one sensible answer given context → resolve with note), or Non-trivial (genuine tradeoffs → escalate). An ambiguity is never escalated while a probe could still answer it; a probe with side effects or a missing credential is one line to the user, who is present, never a packet.
3. **Escalate non-trivial** — use the built-in Deliberation Protocol (above)
4. **Wait** — do NOT proceed until user arbitrates each ambiguity
5. **Incorporate** — update design context with resolved decisions

**Skip condition:** If user says "skip council" or "just ask me directly", present ambiguities as numbered list for inline resolution.
<!-- /section -->

<!-- section: probe-check -->
**Probe check — answer it yourself, before any packet.** Whenever a gap is about how something outside the repository behaves — an API's schema or a query's shape, a field or node name, a permission string, a response taxonomy, a rate limit, a webhook's payload, whether a port answers, what a service returns — write and answer this block before classifying the gap, and put the block at the top of any decision or journal entry the gap produces:

```
Probe check:
- Docs: <official source and the exact version checked, via which tool> | none found
- What would answer it: <introspection | GET or list call | connect to the port | send a test message | dry run | read a log>
- Side effects: none | <what it would create, send, or change>
- Credentials: available (<store or file, never the value>) | missing
- Cost: <N calls against <limit>> | negligible
- Decision: PROBE NOW | ASK ONE LINE (side effects or missing credential) | OWNER DECISION (policy, ownership, cost, scope, security-control wording)
```

Fill `Docs` first when a research tool is available (a Perplexity MCP, WebFetch, the vendor's own MCP): find the official reference for the version the project actually runs, quote the version you checked, and never cite a document whose version you could not match. Docs and probe are a pair: the docs say what should be there, the probe confirms what is; a doc claim the probe contradicts is recorded as a contradiction, and neither alone settles a gap that both could check. `PROBE NOW` is the answer whenever the probe is side-effect-free and the credential exists: write the probe, run it, keep the artifact under `bin/` with the secret never printed, and record the result as a live fact; the gap is then a SPEC_GAP amendment, not an owner decision. `ASK ONE LINE` is one sentence to the user, who is present and can approve a probe with side effects or supply a credential; it is never a packet. `OWNER DECISION` is reserved for what no probe can settle. A gap is never escalated while a probe could still answer it, and discovery replaces the packet, not the unit protocol: once the fact is known, the change still goes through its ledger record, guard cycle and verdict.
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
| CLI unavailable for review | {{cli_unavailable}} |
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

When invoking an advisor (external CLI or host-native fallback) on code that depends on a specific library, framework, or SDK, include in the prompt: (a) the current relevant imports from the actual source file, (b) a short excerpt or link to the library's documented behavior, and (c) the specific call site line numbers. Without this context advisors hallucinate library APIs and flag phantom bugs.

Rule: if the review target touches a third-party API, paste the imports and the relevant doc excerpt into the advisor prompt; do not rely on the advisor's training recall.

Advisor output economy: every advisor prompt MUST include an efficiency instruction — read files selectively (grep for the named symbols, read relevant ranges), never reproduce entire files in the transcript or the review output, and spend the budget on analysis, not restating inputs. An advisor that dumps file contents burns its reasoning budget and times out before producing findings.

Adversarial wording: state the authorized verification goal and the bounded target — "find inputs this guard fails to reject", "show an in-scope call sequence where this check is skipped". Avoid context-free "break / bypass / defeat / circumvent" imperatives; some advisor CLIs refuse them and the run is wasted. If a seat refuses, record `completion: "failed"` with the refusal in `limitations`, retry once with bounded verification wording, and never treat a refusal as a clean review.
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

This is mechanically enforced: when phase scope declares `has_tests: false` or `has_build: false`, `set_verdict(v:'pass')` without a non-empty `note` is rejected by the ledger.
<!-- /section -->

<!-- section: citation-verification -->
## Citation Verification

Every `[OBSERVED]` / `[IMPLEMENTED]` evidence reference should carry a verbatim anchor in addition to its `file:line`. The anchor is a second backtick-wrapped token placed immediately after the `file:line` ref, and it is the exact text present on the cited line.

Anchor grammar:

```text
Evidence: `<file:line>` `<verbatim text on that line>`
```

- Two adjacent backtick spans = ref + anchor. One span = ref only (unanchored).
- The anchor is matched as a literal substring of the cited line, never as a regex.
- Anchors apply to `file:line` refs only. Commands, tickets, spec refs, discovery refs, and external-doc refs have no line to verify and take no anchor.
- If the verbatim text itself contains a backtick, wrap the anchor in a double-backtick span per standard Markdown inline-code escaping.
- Prefer an anchor that is unique within the cited file. Avoid anchors that are pure punctuation, a single common keyword (`return`, `const`, `}`, `import`), or shorter than 8 non-whitespace characters; these are too generic to verify and will not earn a `CONFIRMED`.

Before a spec or doc is complete, run `mcp__foreman__verify_citations` over it. React to each per-ref verdict:

| Verdict | Action |
|---|---|
| `CONFIRMED` / `CONFIRMED_NORMALIZED` | Anchor located at the cited line. No change. |
| `DRIFTED` | Anchor found at a different line. Correct the `file:line` to the reported line. |
| `MISSING` | File or line gone, or anchor absent in the search window. Re-ground the claim against current code, or downgrade to `[UNRESOLVED]` / `[UNVERIFIED]` with a stated reason. |
| `UNANCHORED` | File and line exist, content unverified. Add the verbatim anchor, or downgrade with a stated reason. |
| `NON_FILE` | Out of scope (command, ticket, URL, spec/discovery ref). Not an error; no anchor expected. |
| `ANCHOR_TOO_GENERIC` | Anchor is not discriminating. Replace it with a longer, file-unique snippet. Does not count as confirmed. |
| `CASE_MISMATCH` | Anchor or path matched only ignoring case. Fix the casing. Does not count as confirmed. |
| `MALFORMED` / `AMBIGUOUS` / `UNDECODABLE` | Fix the ref: repair the line number or path, narrow the anchor, or re-ground. None count as confirmed. |

Two gates, and they are not the same:

- The tool's `passed` boolean is a weak "no broken refs" signal. It is `true` only when there are no `MISSING`, `MALFORMED`, `UNDECODABLE`, or `AMBIGUOUS` refs. It does NOT fail on `UNANCHORED`, because the tool cannot tell which refs are claim-bearing.
- Completion gate (authoritative): a spec or doc is not done until every `[OBSERVED]` / `[IMPLEMENTED]` ref is `CONFIRMED` (or `CONFIRMED_NORMALIZED`), or has been explicitly downgraded to `[UNRESOLVED]` / `[UNVERIFIED]` with a stated reason recorded inline. `UNANCHORED`, `ANCHOR_TOO_GENERIC`, `CASE_MISMATCH`, and `NON_FILE` do not satisfy this gate for a claim that depends on code content. A tool `passed: true` is necessary but not sufficient for completion.

Semantic boundary: verification proves LOCATION and VERBATIM PRESENCE only. It proves the anchor text sits at the cited line. It does NOT prove the line supports the claim. A line can match its anchor exactly while the surrounding logic contradicts the claim (renamed constant, inverted condition, value behind a feature flag). A `CONFIRMED` verdict means the anchor is located at the cited line, never that the claim is true. Route semantic conflicts to the Mismatch machinery, not to this gate.
<!-- /section -->

<!-- section: engineering-ethos -->
## Engineering Ethos

Read the `ethos` tool at session start whenever the work is flagged: any design or spec session, any unit whose phase or directive declares a perf tier above `standard`, a `security_boundary` scope, or a Telemetry Contract entry. Serve a single checklist with `ethos({ section })`.

- **Tier declaration**: proportionality is declared, not inferred — every major path carries a tier (`standard`/`hot`/`extreme`) in the design summary and spec; an undeclared tier in a generated document is a gap to escalate, not a default to apply.
- **Conflicts recorded**: pillar conflicts (perf-vs-security, perf-vs-telemetry, cost-vs-coverage) are written into the spec Decisions table or a ledger note and arbitrated — never silently resolved.
<!-- /section -->

<!-- section: checkpoint-review -->
**2. Review via Deliberation:**
1. Check the active host's advisor seats — reuse the session-start probe results recorded in the `init_session` journal `env`; re-probe ({{advisor_checks}}) only if an advisor was not probed or its recorded status was a failure
2. Map to tier:

| Advisor A | Advisor B | Review path | Moderator |
|-----------|-----------|-------------|-----------|
| available | available | Invoke both independently | Pitboss (you) |
| available | unavailable | Advisor A + recorded non-independent fallback | Pitboss (you) |
| unavailable | available | Advisor B + recorded non-independent fallback | Pitboss (you) |
| unavailable | unavailable | Ask the user before proceeding with pitboss-only gates | Pitboss (you) |

3. Use the active host's invocation mappings:

{{advisor_a}}
{{advisor_b}}
{{advisor_fallback}}

4. Ask each advisor (append the Advisor Grounding Protocol's efficiency instruction verbatim — selective reading, no file dumps): "Review these phase changes against the spec. List any: (a) spec directives not implemented, (b) implementations that contradict the spec, (c) missing error handling, (d) test gaps, (e) security issues — prefix each `[CWE-###]` (closest class or `[CWE-UNMAPPED]` + reason if none fits); where a finding weakens a control or detection-evidence row in the spec's Threat Table, cite that row by component name — do NOT invent new technique mappings during code review, (f) telemetry contract violations — names, unbounded tag values, missing trace correlation, secrets/PII in signals. Be specific — file:line references required. Start every finding with its severity in brackets — `[CRITICAL]`, `[HIGH]`, `[MEDIUM]`, `[LOW]` — then the file:line, one finding per list item. For each category, list what you examined (files/functions) even when you report nothing — a category with no findings and no examined list is not reviewed."

5. `mcp__foreman__normalize_review` — parse review output into structured findings (`findings_json` is record_review-ready; `unparsed_lines` counts prose that opened no finding — the examined list lands there, not in findings)
6. An advisor result marked `completion: failed` (empty or echoed output, non-zero exit) is not a seat: record it with the reason in `limitations`, retry once, and after a second failure use the unavailable row above. Classify each finding: CONFIRMED / REJECTED / UNVERIFIED — every recorded finding carries one; `record_review` refuses a finding without it. A seat reporting zero findings with no examined list is `completion: "partial"`, never clean — no line-count floor decides this. If another seat has CONFIRMED findings, re-prompt the silent seat ONCE naming only the files involved (never the other seat's claims or lines) and record that pass separately with `stage: "cross_exam"`; it never counts as an independent seat.
7. Persist the review durably — `mcp__foreman__write_ledger({ operation: "record_review", phase, data: { advisor, stage: "independent", completion, checked: [<what the seat examined>], findings: [{ severity, file, line, description, classification }] } })`. Use lowercase classification (`confirmed` / `rejected` / `unverified`). Security findings keep their `[CWE-###]` prefix in `description`. Survives the session; retrievable via `read_ledger({ query: "reviews" })`. The phase gate is ledger-enforced: it requires a review recorded after the latest unit verdict and refuses `pass` while any such review carries a `confirmed` finding — reject the affected unit (`add_rejection` → fix → `set_verdict`), then obtain fresh full-review or eligible delta-verification evidence showing it resolved. `user_override` waives and is recorded on the phase. For eligible Top corrections, a fresh read-only verifier (different from every correcting worker) may extend a retained complete independent or native baseline with `record_review { stage: "verification", completion: "complete", checked: [<delta examined>], findings: [], evidence: { kind: "worker_delta", verifier_id: "<actual verifier ID>", baseline_review_ts, units: [{ unit_id, attempt }], files, tests, probe } }`. Cover every changed attempt and all frozen authorized paths across corrections since that baseline; retain passing test/probe evidence or an explicit allowed n/a reason. No hot-path/security-boundary phase or confirmed finding above LOW since the baseline qualifies. The gate validates the evidence links and current coverage; a rank label alone never satisfies review, and a `cross_exam` record never counts as a seat. The verifier checks both the fix and the test oracle against the spec. If eligibility fails, obtain a fresh full review. Complete native baseline evidence remains usable on other hosts with its same-provider label. Legacy direct-fix verification records remain compatible, but new corrections always use workers. A seat that failed, timed out, or reported nothing is superseded by re-running the SAME advisor to a complete record; never re-verdict a unit to clear it. When the seat ran through `invoke_advisor`, copy `seat_receipt` and `packet_sha256` from its meta block into the record as `seat_receipt` and `packet_hash`: the ledger checks them against the receipts file it wrote, and only a receipted seat on another vendor counts as cross-vendor review. A gate pass is stamped with the basis that carried it (receipted external, declared external, same-provider native, delta, or override); the third consecutive counted pass carried by same-provider review alone is refused (`INDEPENDENCE BOUND`) until a receipted cross-vendor seat resets it or the owner overrides on the record. After a gate passes, a rejection, a non-pass verdict, or a new attempt on one of its units records an escape against that gate; classify it with `record_escape { class }` (or `add_rejection { escape_class }`) before the unit's next pass verdict. `read_ledger { query: "review_outcomes" }` reports gates and escapes per basis. Review currency is judged per unit: a record covers a unit when it was recorded at or after that unit's verdict and its snapshot names the unit's current attempt. A new attempt on one unit stales coverage for that unit only; the gate refuses with UNCOVERED UNITS naming the units whose current attempt no seat-grade record covers. Re-run the seat over exactly those units and record it with data.units: [<those unit ids>] so the record claims only what the seat examined; omit data.units only when the seat reviewed the whole phase. Earlier seats keep covering the units they snapshot; a confirmed finding or an incomplete record on such a seat keeps blocking while it carries any unit no later seat covers, and the block names those units — re-cover them (scoped or whole) to retire it. A scoped record cannot be a verification baseline. The gate stamp lists every carrying seat, and its basis is the weakest per-unit class: a moved unit covered only by same-provider review makes the pass same-provider for the independence bound.
8. If no CLIs available: ask user "Independent review unavailable. Proceed with pit-boss gates only? [y/N]"
<!-- /section -->
