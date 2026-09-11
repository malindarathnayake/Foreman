---
name: foreman:implementor
version: 0.0.5
description: Pit-boss implementation orchestrator. A frontier pitboss orchestrates disposable bounded workers and validates against the spec. Third stage of the Foreman pipeline.
---

{{include: ledger-critical}}

**Seat Check:** A frontier-class pitboss is required. If the current seat is not declared `frontier`, STOP and ask the user to switch to a frontier seat. Provider and model names are host configuration, not protocol rules.

{{include: engineering-ethos}}

## Core Rules

| Rule | Why |
|------|-----|
| Pit-boss NEVER writes implementation code, fixes, or tests; use an implementation worker | Separation of concerns |
| Workers NEVER see full spec, ledger, or progress | Information isolation |
| Workers stay bounded to one unit; release after its correction work is complete | Prevents context accumulation across units |
| Fresh worker after rejection unless the declared rank permits bounded reuse | Keep correction scope explicit |
| Ledger is durable — persisted after every verdict | State survives sessions |
| Mandatory new session at phase checkpoints | Context accumulation degrades quality |

**Proportional entry:** full implementor ceremony is for prepared multi-unit work, security/trust boundaries, migrations, and changes where a silent defect is expensive. Ordinary low-risk CRUD and one-file maintenance can use `lighttask` before entering this protocol; do not manufacture phases merely to satisfy this protocol.

{{include: session-start}}

## Journal — Friction Logging

Log only failures and delays. Do NOT log successes, worker spawns, or test passes.

`mcp__foreman__write_journal({ operation: "log_event", data: { t: "<CODE>", u: "<unit>", tok: 0, msg: "<≤400 chars>" } })`

A `msg` over 400 characters is cut to 400 with a trailing `…[truncated N chars]` marker and the call returns a warning; split long text across events if the tail matters. Ids and findings are never cut.

| Code | Trigger |
|------|---------|
| W_REJ | Pit-boss rejects worker output |
| W_FAIL | Worker crashes or times out |
| W_RETRY | 2nd/3rd outer-loop fix attempt |
| GATE_FIX | Gate G1–G6 fails, requires fix |
| CX_ERR | Advisor CLI error |
| SPEC_AMB | Stopped — spec ambiguity, asking user |
| SPEC_GAP | Spec gap resolved by pit-boss decision — recorded in PROGRESS Decisions (owner-overrulable), run continued |
| GATE_OVERRIDE | User forced past a phase checkpoint (`--force-continue`) — set `gate`, keep the SAME journal session |
| T_FLAKE | Flaky test detected |
| BLD_ERR | Build/compile failure after worker |
| USR_INT | User interrupted or overrode |

Phase-end `end_session` call: see Checkpoint Protocol below.

## Per-Unit Workflow

### Step 1: Read Unit Spec
Read the unit directive from handoff.md. Extract: files to touch, expected behavior, test command, scope boundaries.

### Step 2: Decide Batching

| Pattern | Batching | Why |
|---------|----------|-----|
| Same mechanical change across N files | 1 worker | Same pattern |
| N files with unique logic | 1 worker per file | Each needs own brief |
| N files with 2 patterns | 2 workers | Groups reduce count |
| 1 complex file | 1 worker | Focused attention |

When batching yields N>1 workers that can run concurrently:

{{worker_fanout}}

Parallel fan-out still requires one `s:'delegated'` ledger write per unit before that unit's spawn, and one independent validate/verdict per unit afterward.
### Step 3: Read Source Files
Before building brief, read actual source. Capture:
- BEFORE state: exact function body, class definition, or file content the worker will modify
- Import block: all current imports so the worker doesn't duplicate or break them
- Exported symbols: names, signatures, and types that other units depend on
- Test file structure: how tests are organized so worker places new tests correctly

### Step 4: Build Worker Brief
```
# Worker Brief — Unit [ID]
## Task — [directive from handoff, verbatim or paraphrased]
## Files — CREATE/MODIFY list with paths
## BEFORE/AFTER Pattern — excerpts from actual code showing expected delta
## Interface Context — relevant exports from ledger, signatures worker must satisfy
## DO NOT — explicit scope boundaries, files to leave alone
## Shared-Tree Safety — The repository state is user-owned. Run only read-only Git commands (`status`, `diff`, `log`, `show`). NEVER run `git stash`, `reset`, `checkout`, `switch`, `clean`, `add`, `commit`, `merge`, `rebase`, `cherry-pick`, `worktree`, or any command that changes the index, stash, refs, branch, HEAD, or files outside the listed task. Do not "clean up" a dirty tree. If repository state blocks the task, STOP and report it to the pit-boss unchanged.
## Ethos — perf tier (standard/hot/extreme); budget + rationale if hot/extreme; telemetry contract excerpt if the unit emits signals
## Test Command — exact command to run
## Inner Loop Rules — compile/import/type errors: self-fix max 2. Logic/spec issues: return immediately.
```

### Step 4.5: Brief Preflight Gate

Runs AFTER drafting the brief, BEFORE invoking the host's worker mechanism. Its result is attested on the delegated write (Step 5, `preflight`) — the ledger refuses `s:'delegated'` without it. Seven mechanical steps:

1. **Extract key symbols** from the brief — type names, field names, function names, file paths, specific values (numeric caps, enum literals, magic strings). Write them down.
2. **Grep `spec.md` for each symbol** — every occurrence across the spec, not only the Unit directive block.
3. **Read each hit with ±5 lines of context** — prioritize: Error Handling tables, Core Behavior sections, other Unit directives, Decisions & Notes rows.
4. **Diff the brief against the full symbol footprint:**
   - (a) Does the brief impose a constraint that another spec row contradicts?
   - (b) Does the brief omit a constraint from a row outside the Unit directive block?
   - (c) Does the brief encode a literal value (e.g. `.max(500)`) that appears with different semantics elsewhere in the spec?
5. **If any contradiction or omission found: revise the brief before spawning.** Worker tests validate the brief, not the spec — they cannot catch spec/brief drift.
6. **Brief self-consistency:** every test expectation in the brief (asserted status, value, error, log key) must be consistent with the brief's own implementation instruction, AFTER pattern, and the spec's error-handling row — a brief that tells the worker to return 400 and to assert 404 is a brief defect, not a worker defect.
7. **Telemetry names (units that emit signals):** list every CUSTOM log/metric field the brief introduces and check it against the active stack profile's reserved-name rule (`ethos` telemetry section); core fields are exempt. If the stack profile resolved by fallback or the transport is unstated, log SPEC_AMB and ask — never lint against the reference backend by guess.
8. **Contract claims (phase scope `has_api`):** the unit's `foreman-contract` block in `spec.md` registers its claims, smoke plan and deliverables; run `mcp__foreman__contract_probe({ phase, unit_id, claim_id })` for every claim before `preflight_check`, which refuses until each has a passing claim-mode probe under the current block (a url-mode probe is diagnostic and never counts; no block is a refusal, `claims: [], smoke: null` is the reviewed opt-out). A failing claim is a spec or reality gap to settle by the Probe check, never a reason to edit the block into passing. The block is frozen on the delegation: amending it after means a new preflight and a new attempt.
9. **Files the unit creates:** pass `creates: [{ file, tests: [names] }]` to `preflight_check` for every file and test the brief orders into existence; their citations are forward instead of dead, and the pass verdict refuses until each test is declared in its file, so name them exactly as the brief does.

Anti-pattern: *"I read Unit X's directive section carefully."* The spec is a graph, not a list. Every symbol has a cross-reference footprint across multiple sections (data model, error handling, phase directives, decisions table). Grep first.

### Spec amendment (SPEC_GAP)

{{include: probe-check}}

When preflight or validation shows the SPEC is wrong and an accepted decision or a live fact leaves only ONE valid correction, amend it in place as one atomic logical change across every affected document (`spec.md`, `handoff.md`, `testing-harness.md`, the PROGRESS Unit Plan) — never one section now and the rest later. Record it ONCE: a PROGRESS Decisions row (`SPEC_GAP-<n> | <date> | <reason> | sections touched`) and one `write_journal log_event SPEC_GAP`; no per-section callouts. Reopen a passed unit only if the amendment changes what that unit must do (`add_rejection` reopens it) — a correction that makes the spec match already-correct code is not a rejection. Re-run G3/G4 for affected units and the spec generator's G1, G3, G7, G10 for the amended sections. Anything material — acceptance criteria, public/data/security contracts, migrations, test strategy, scope — is NOT amended here: log `SPEC_AMB`, stop, and take it to the owner or a `spec_man` re-evaluation.

### Step 5: Spawn Worker

**Shared-tree preflight (before every editing worker):** `mcp__foreman__repo_guard({ operation: "snapshot", phase, unit_id, files: [<the unit's files>], allowed_files: [<the files the brief authorizes>] })` — run it AFTER the `s:'delegated'` write and BEFORE spawning. Foreman captures the repository root, branch, HEAD, stash, every changed path with a content fingerprint, `core.autocrlf`, and `git ls-files --eol`, and freezes `allowed_files` onto that baseline. Treat the snapshot as an ownership boundary, not something to normalize. It cannot be re-taken for this attempt: a second baseline would discard the comparison recorded against the first. Outside a git work tree it reports `n/a` and the rules below apply by hand; a git probe that fails or truncates is a refusal, and nothing is recorded. A host-native worker that edits the shared tree runs **sequentially** unless the host proves it has an isolated worktree/sandbox. Parallel read-only explorers are allowed; parallel patch-only workers are allowed only when their editable sets are disjoint and every returned patch is protected by a content-addressed staleness check.

The worker brief MUST contain the Shared-Tree Safety paragraph above verbatim. If accepted uncommitted work is present and the host cannot prevent Git mutations, use a patch-only worker path or stop for owner direction. Never stash, commit, reset, checkout, clean, or move the user's work to make delegation convenient.

Record the delegation in the ledger BEFORE spawning. This is mechanically enforced — a `pass` verdict is rejected unless the unit was first set to `delegated` with a brief. Also record the cost `tier` the worker runs at and a short `route_reason` — audit evidence, not a gate:
```
mcp__foreman__write_ledger({ operation: "set_unit_status", phase, unit_id, data: { s: "delegated", brief: "<1-3 line summary of the worker brief>", tier: "standard", route_reason: "<why this tier fits this unit>", preflight: { symbols_grepped: <N from Step 4.5>, self_consistent: true, telemetry: "checked" | "n/a" } } })
```
Record `worker_id: "<actual host-returned ID>"` for a native worker on the verdict, or — when the previous attempt still carries no ID (rejected before any verdict, or a verdict written without it) — on the eligible correction write, which binds it onto that attempt once (`worker_id_bound: { at: "correction" }`). A recorded ID never changes. Never invent an ID or carry a live-worker assumption across sessions.

Tiers: `cheap` (mechanical, fully-specified change), `standard` (default capable worker), `premium` (subtle or high-risk unit escalated to a stronger model). Each (re-)delegation is appended to the unit's `delegations[]` history, so the tier choice and reason survive the brief overwrite on fix attempts.

{{worker_invoke}}
- Worker sees ONLY: its brief, the BEFORE/AFTER excerpts you include, and its own tool calls
- Worker MUST NOT be given the handoff.md path to read directly
- Worker MUST NOT be given access to the ledger or progress file
- If worker needs additional context, pit-boss reads the file and pastes the relevant excerpt into a follow-up message

### Step 6: Validate
After worker returns, pit-boss validates independently — do not trust worker's self-report:
1. **Repository-state guard — before tests:** `mcp__foreman__repo_guard({ operation: "compare", phase, unit_id, files: [<the unit's files>] })`. The authorized set is already frozen on the baseline, so `compare` takes no `allowed_files` — passing one is refused, because widening authorization after the worker ran would clear the worker's own mutation. Foreman re-reads the state and names every mutation outside the frozen set: a moved HEAD, a touched index or stash, a changed `core.autocrlf`, a file changed outside the brief, an already-dirty file whose content was overwritten, or a pre-existing uncommitted change that disappeared. A violation is a hard stop. Do not attempt automatic recovery and do not continue to tests; preserve evidence and escalate to the owner. The result is recorded on the delegation and `set_verdict v:'pass'` is refused for that attempt until it clears (`REPOSITORY GUARD`) — `user_override` waives it and is recorded as `guard_override`. Foreman's own writes are excluded by the server, not by you: the .foreman-* state files, their .corrupt/.tmp side files, and the fenced checklist block in Docs/PROGRESS.md never appear as violations. A violation naming Docs/PROGRESS.md means content OUTSIDE the fence changed (or a second fence appeared), and that is the worker's.
2. Read every modified file — confirm changes match the AFTER pattern from the brief
3. Re-run tests — call mcp__foreman__run_tests with the unit's test command; read exit_code for pass/fail, STDERR tail for failure context. Do not run tests via Bash. Eligible Top corrections may use focused validation as described below, while still running spec-mandated checks. Foreman froze the spec's Test line on the delegation and refuses a delegation or verdict whose go test selectors omit the package of an authorized file (`CHECKPOINT REACH`, a `testdata` fixture belongs to its parent package). That is package selection, not observation: check yourself that the selected tests, `-run` filters and build tags exercise the change, and that a fixture read by a sibling package is covered by that package's tests.
4. Spec check — read the original spec directive sentence by sentence; confirm each has a corresponding code path
5. Export check — verify exported names and signatures match what the ledger records as interface contracts
6. Consistency check — confirm changes integrate cleanly with prior accepted units; no regressions introduced
7. Budget check (hot/extreme perf-tier units only) — require the unit's benchmark/profile evidence and compare against the spec's Performance Budgets row; a regression is a reject, not a note

### Step 7: Verdict

**ACCEPT** — required ledger sequence per unit is `ip` → `delegated` (Step 5) → `pass`; the ledger rejects a pass verdict without prior delegation. Wherever the unit's block declares a smoke plan or deliverables, run `mcp__foreman__live_smoke({ phase, unit_id, plan_id })` after the guard compare and the suite, before the verdict (remove stale outputs first: a deliverable that already exists is refused). Foreman runs the frozen plan through the real runner, digests every deliverable it produced and evaluates the declared properties; `set_verdict pass` refuses (`SMOKE REQUIRED`) without a passing smoke for this attempt whose harness, input, deliverable and reference digests still match, so any edit after the smoke means another run. A green suite, killed mutations and a clean guard prove that the controls exist, not that the output is right: mutation sensitivity is not domain coverage. Before the verdict, open the emitted bytes the receipt names and check them against the spec yourself; the reviewer who carries the gate cites the receipt's `run_id` in `record_review smoke_receipts` and does the same, never re-running the checkpoint as its only evidence.
```
mcp__foreman__write_ledger({ operation: "set_unit_status", phase, unit_id, data: { s: "ip" } })   // when starting (Step 1)
// s:'delegated' with brief was recorded in Step 5, before spawning the worker
mcp__foreman__write_ledger({ operation: "set_verdict", phase, unit_id, data: { v: "pass", note: "<attestation — mechanically required when scope.has_tests===false or scope.has_build===false>" } })  // when accepted
mcp__foreman__write_progress({ operation: "complete_unit", data: { unit_id, phase, completed_at, notes } })
```

**REJECT — enter fix protocol:**
```
mcp__foreman__write_ledger({ operation: "add_rejection", phase, unit_id, data: { r: "reviewer", msg: "reason", ts: "timestamp", escape_class: "<class, when the unit's gate already passed>" } })
mcp__foreman__write_progress({ operation: "log_error", data: { date, unit, what_failed, next_approach } })
```
When the rejection is answered by a delegation you are about to record, skip `add_rejection` and put the finding on that write as `data.rejection: { r, msg, escape_class? }` — the ledger records the rejection first, then the attempt, with one timestamp (see Nit path).

{{include: no-test-attestation}}

## Two-Tier Fix Protocol

**Inner Loop (same worker):** Compile/import/type errors → self-fix max 2. Logic/spec errors → return to pit-boss immediately. Inner loop attempts do NOT count toward outer fix limit.

**Outer Loop (recorded worker attempt, max 3 failures)** - Use a fresh worker by default; apply the rank-based correction path below automatically when eligible. Fresh-worker fix brief template:
```
# Fix Brief — Unit [ID], Attempt [N of 3]
## What Was Wrong — file:line reference + specific problem description
## What the Spec Says — exact quoted text from spec
## Files to Fix — path + specific change required
## Files to Leave Alone — explicit list
## Previous Attempts — pulled from ledger rejection history
## Tier + Route Reason — tier for this attempt + why (see escalation rule below)
## Test Command — exact command
## Inner Loop Rules — compile fixes OK (max 2), spec issues return immediately
```

**Guarded tier escalation:** A repeated failure signals spec/brief ambiguity, not insufficient model horsepower. Do NOT bump a fix worker to a higher `tier` on an unchanged brief. Escalate the tier (e.g. `standard` → `premium`) ONLY when the re-delegation's `route_reason` cites a concrete brief refinement (missing context now added) or an advisor diagnosis of the failure. Record tier + route_reason on the `delegated` write so the escalation is auditable in `delegations[]`.

After 3 outer-loop failures: STOP. Escalate to user with full rejection history from ledger. Ledger-enforced: the cap counts failed attempts (rejection or fail verdict) since the unit last passed; a further attempt or a pass then needs `user_override` (recorded on the attempt or as `cap_override`). Fixing off the record is not a way past it — a pass also needs an attempt recorded after the latest failure (`ATTEMPT REQUIRED`). One owner decision can cover several attempts: at the cap, record `authorize_attempts { attempts, reason, user_override: true }` once; each further attempt is charged to it, `session_orient` shows what is left, and a pass closes it.

**Rank-based corrections:** Use the `model_rank` and `workflow_permissions` returned by startup/orientation. Middle rank permits same-worker **mechanical** corrections (exact rename, import, literal or fixture correction with unchanged behavior and acceptance criteria). Top rank also permits **bounded** implementation fixes and test changes within the same unit and frozen authorized files. Standard/unknown follow the normal fresh-worker path. A changed understanding, unavailable worker, new session, or expanded scope requires a fresh worker. Authorization, budget, security boundaries, public contracts, acceptance criteria, and scope changes never qualify.

Record the rejection once, then a new `s:'delegated'` attempt with `worker_id` (the actual existing native worker ID), `correction: { kind: "mechanical" | "bounded", from_attempt: <previous attempt>, files: [<changed files>] }`, a compact `brief` referencing the previous brief and stating the finding, required delta and validation, and the normal preflight attestation. Reuse only a worker from this active session. Its ID is bound to the previous attempt either by `set_verdict { worker_id }` or, while that attempt carries no ID (after an `add_rejection` with no verdict, or a verdict written without it), by this correction's `worker_id` (same session, and only after its guard compare cleared); a bound ID is never rebound. Retain an eligible worker while its unit is under validation/review, and start fresh if the host has already released it. Take a new guard snapshot before sending the follow-up, preserving the original frozen authorized file scope; compare before tests and verdict as usual. Reuse is still an outer attempt, subject to existing failure caps and unresolved guard violations. Retain the original Shared-Tree Safety instructions and supply relevant context excerpts rather than the ledger or full handoff.

**Nit path (mechanical correction, four ledger/guard calls).** A nit is a finding whose fix is a literal, rename, import, fixture or test-assertion change inside the unit's frozen file set with unchanged behaviour and acceptance criteria. It goes through a worker like everything else; what is cut is bookkeeping, never a check. No `s:'ip'` write, no `add_rejection`, no `record_escape`, no re-supplied file list:

1. `write_ledger { operation: "set_unit_status", phase, unit_id, data: { s: "delegated", brief: "<prior brief ref + the finding + the exact delta + validation>", preflight: { symbols_grepped: <N>, self_consistent: true, telemetry: "n/a" }, worker_id: "<recorded native worker>", correction: { kind: "mechanical", from_attempt: <current attempt>, files: [<the files>] }, rejection: { r: "<finder>", msg: "<file:line finding>", escape_class: "<original_defect | remediation_defect | test_gap | process | new_scope — when the unit's gate already passed>" } } }` — records the rejection, the escape and the new attempt in one write; a refused write records none of them and says so. The escape is classified here only when it is new: on a repeat finding against a gate the unit already escaped, the existing escape gains the source and `escape_class` is ignored (the warning says "classify with record_escape"), so the class goes on the verdict in step 5. Fresh-worker fixes (Standard/unknown rank, or a released worker) use the same `rejection` field without `correction`.
2. `repo_guard { operation: "snapshot", phase, unit_id }` — on a correction the frozen authorized set and entry limit are copied from the previous baseline; a different `allowed_files` is refused.
3. Resume the worker with the compact brief; run `run_tests` as in Step 6.
4. `repo_guard { operation: "compare", phase, unit_id }` — a violation is still a hard stop.
5. `write_ledger { operation: "set_verdict", phase, unit_id, data: { v: "pass", via: "worker", worker_id } }` — add `escape_class` here when the unit's escape is still unclassified (a reopen verdict, a correction on a covered pass with no `rejection`, or the repeat-finding case in step 1); it classifies the NEWEST unclassified escape, and the ledger refuses the pass while any older one (possible only after a recorded `escape_override`) stays unclassified — `record_escape` clears that one.

Then the gate: the correction bumped this unit's attempt, so no seat covers it any more (the other units keep their earlier seats; the gate names the uncovered unit). Top rank: a fresh read-only verifier records `record_review { stage: "verification", evidence: { kind: "worker_delta", … } }` and `update_phase_gate g:'pass'` re-stamps the gate. Other ranks re-run a seat over that unit and record it with `data.units: [<unit id>]`. This is the boundary, not ceremony: an unreviewed fix behind a green gate is the loophole 0.6.9 closed. One `write_progress` at most — `complete_unit` only if the PROGRESS entry was reopened; no `log_error` for a nit, the ledger `rej[]` entry and the escape row are the record.

Top rank may use focused intermediate validation of the changed behavior and its dependencies, while still running every spec-mandated unit check, Step 6 ownership/spec checks, and full checkpoint validation. Middle rank retains normal validation and review. After an eligible Top correction, a separate read-only verifier can check the complete delta and extend still-valid baseline review coverage through `stage:'verification'` with `evidence.kind:'worker_delta'`; see checkpoint review. Neither reuse nor rank permits self-review or skipping final independent verification.

The legacy `direct_fix` / `via:'pitboss-direct'` record format remains readable for compatibility. Do not use it for new work: all implementation, fixes, fixture changes and test edits in this protocol go through a worker.

### Repeated Checkpoint Blocks

A green suite plus a finding that "the suite cannot observe the production behavior" is a test-evidence failure, not a passed checkpoint.

- After the **second checkpoint block of that class**, run a targeted mutation or fault-injection probe over the exact production seam before another reading-only review. The acceptance criterion is explicit: replacing/removing the control must make the focused suite fail. A kill proves sensitivity to that exact substitution and nothing more: read the substitution and the assertion that failed before crediting it to the control.
- Mutation or fault-injection workers that edit source run **serially** on the shared tree or in separate, proven worktrees. Never run two source-mutating review seats concurrently.
- Classify every later finding as `original_defect`, `remediation_defect`, `test_gap`, or `process/tooling`. This exposes when repeated remediation is manufacturing most of the new risk. Post-gate: the ledger records an escape when a gated unit is rejected, re-verdicted below pass, or re-attempted; classify it with `write_ledger record_escape { class }` (or `add_rejection { escape_class }`) before the unit's next pass verdict, and `read_ledger { query: "review_outcomes" }` shows escapes per review basis.
- After the **third checkpoint block**, STOP before writing another fix. Present the owner a decision packet: evidence gained since the prior attempt; surviving mutations/untested behavior; original-versus-remediation defect counts; remaining silent-failure impact; cost and scope of one more round; and explicit choices to continue, narrow, defer, or override.
- Owner arbitration is the termination rule. Foreman never auto-passes because review is expensive, and an adversarial seat never creates an endless loop merely by producing a new opinion: another remediation round requires a confirmed behavior, contract, or evidence gap with a concrete acceptance test.

## Worker Invocation Paths

| Path | Inner loop (self-fix) | Outer loop |
|---|---|---|
| Host-native subagent | ≤2 compile/import/type fixes | ≤3 attempts |
| invoke_worker (EXPERIMENTAL) | NONE — one-shot; repair round is v0.6 | ≤3 attempts |

`invoke_worker` protocol (EXPERIMENTAL S7 patch-worker delegation):
1. Delegate in the ledger FIRST — `set_unit_status s:'delegated'` (`invoke_worker` refuses otherwise).
2. Call `invoke_worker { phase, unit_id, brief, tier, files }`.
3. Apply the returned patch VERBATIM via host tools after the `base_file_hashes` CAS check.
4. Record outcomes via `add_rejection r:'ED_STALE'|'PATCH_APPLY_FAIL'|'BLD_ERR'` or `set_verdict` — the ledger hook appends the terminal sidecar event.
5. Failure returns carry `hint:` from the recovery playbook — resolve it before re-delegating.

Any brief built from scrubbed material must include this disclosure verbatim: `[REDACTED:*] tokens are intentionally removed secrets; treat as opaque; never reproduce them.`

## Self-Review Gates G1–G6

**Anti-rationalization list — none of these justify skipping a gate:**
- "The diff looks clean so logic must be correct" — trace against spec
- "Worker's tests pass so implementation is correct" — verify independently
- "Already validated this pattern in prior unit" — read actual files
- "Mechanical change, no need to check" — check anyway
- "Worker said it handled the edge case" — read the code
- "Checking all gates would take too long" — run them
- "It's just logging/metrics, no G6 needed" — telemetry is a contract and an attack surface

| Gate | Applicability | Check |
|------|---------------|-------|
| G1 | always | **Contract Completeness** — Every return field populated by this function (not deferred to caller); tests assert values not shapes |
| G2 | scope.has_tests | **Assertion Integrity** — No `or True`, no bare except, no skipped assertion without documented reason; fix flakiness don't weaken |
| G3 | always | **Spec Fidelity** — Every sentence in the spec directive has a corresponding code path; parameter names match literally, not paraphrased |
| G4 | scope.has_tests | **Test-Suite Impact** — Grep the full test suite for changed function/class/constant names; update any old assertions on prior behavior |
| G5 | always | **Worker Hygiene** — dead imports, test determinism, assertion completeness, module resolution, fragile timing |
| G6 | perf tier hot/extreme, OR any unit file appears as a Component row in the spec's Threat Table, OR the unit implements a Telemetry Contract entry, OR the unit handles authn/authz, secrets, or input crossing a Threat Table trust boundary | **Ethos Compliance** — perf rationale present and cited (spec directive or code comment); no unjustified alloc/lock/syscall on marked hot paths; for hot/extreme units, benchmark/profile evidence shows no regression vs the spec budget (extreme: before/after attached) — a rationale without measurement does not satisfy this gate; telemetry matches the spec contract (names, bounded tag values, trace correlation); security findings carry `[CWE-###]` prefix (closest class or `[CWE-UNMAPPED]` + reason) |

**Gate skip protocol:** If `phase.scope.has_tests === false`, gates G2 and G4 auto-skip with `status: n/a` in the verdict. G6 auto-skips only when the unit matches none of its applicability conditions — cite the Threat Table and Telemetry Contract rows you checked in the verdict `note`. The secrets/PII check lives in G5 and never skips. Record every skip in the verdict `note` field.

### G5 — Worker Hygiene (expanded)

| Check | What to look for | Why |
|-------|-----------------|-----|
| **Dead imports** | Every import/using/require is referenced in the file body. Grep the file for each imported symbol. | Unused imports pass tests but fail linters and signal sloppy generation. Go catches this at compile time; most languages don't. |
| **Test determinism** | No test relies on wall-clock time, locale, timezone, OS-specific ordering, or execution timing. Dates must be pinned to UTC (not local time). Random seeds must be fixed. Dict/map iteration must not assume order. | Flaky tests are worse than missing tests — they erode trust in the suite. |
| **Assertion completeness** | Every test that verifies "X doesn't throw/fail" ALSO verifies the expected side effect occurred. Catching an error without asserting what happened is a no-op test. | A test that only checks "no crash" proves nothing about correctness. |
| **Module resolution** | Import paths match the project's module system. If ESM: extensions present. If CJS: no extensions. If Go: correct module path. If Python: relative vs absolute matches project convention. Read the project config (tsconfig, go.mod, pyproject.toml) to determine which system is in use. | Wrong resolution works in test runners but fails in production or stricter runtimes. |
| **Fragile timing** | No test depends on microtask ordering, goroutine scheduling, thread interleaving, or sleep durations to be correct. If a test needs async work to settle, it must use the language's deterministic mechanism (fake timers, channels, waitgroups, asyncio event loop advance) — not `sleep` or `Promise.resolve()`. | Timing-dependent tests are the #1 source of CI flakes across all languages. |
| **Secrets/PII** | No credentials, tokens, or PII in code, logs, spans, metrics, test fixtures, or the worker brief itself. | Ethos hard rule — any occurrence is CRITICAL at every tier; this check never skips. |

**How to run Gate 5:** For each file the worker modified, open it and scan for the six patterns above. This is a read-only scan — no tools needed beyond Read. If any check fails, reject the unit with the specific file:line and pattern name.

**How to run all gates:** list all functions touched → apply G1 → grep for G2 patterns → read each spec sentence → G3 match → grep G4 symbols → scan modified files for G5 patterns → G6: check the unit's tier + the spec's Telemetry Contract against the ethos checklist. Do NOT mark CHECKPOINT REACHED until all six pass.

{{include: advisor-grounding}}

## Checkpoint Protocol

At phase end, after all six gates (G1–G6) pass:
**1. Full Test Suite:** Run the complete test suite via mcp__foreman__run_tests, not Bash.

{{include: checkpoint-review}}

**3. Persist State:**
```
mcp__foreman__write_ledger({ operation: "update_phase_gate", phase, data: { g: "pass" } })
mcp__foreman__write_progress({ operation: "complete_unit", data: { ... } })
```
Gate `pass` is mechanically enforced: it is rejected unless every unit in the phase has verdict `pass`. If blocked, resolve the listed units — do not work around the gate.
Include: unit verdicts, gate results, review findings with classifications, deferred concerns.

**4. Deliberation Summary:** Present to user: what was built, worker stats, gate results, review findings, test results.

**5. Mandatory New Session:** "Phase [N] complete. New session required. All state persisted to ledger + progress." Default: new session. User can override with `--force-continue`: log `GATE_OVERRIDE` (with `gate`) and continue in the SAME journal session — do not end_session/init_session for an override. Before ending, call:
```
mcp__foreman__write_journal({ operation: "end_session", data: { dur_min: <estimate>, ctx_used_pct: <estimate>, summary: { units_ok: <N>, units_rej: <N>, w_spawned: <N>, w_wasted: <N>, tok_wasted: 0, delay_min: 0, blockers: [], friction: <1-100> } } })
```

{{include: context-budget}}

{{include: agent-delegation}}

{{include: error-handling-standard}}

## Common Implementation Traps

| Trap | Example | Prevention |
|------|---------|------------|
| "Caller fills it in" | Returning struct with placeholder fields | G1: function populates its own return |
| Safety-valve assertions | `assert X or True` | G2: fix flakiness, don't weaken |
| Mental paraphrase | Spec says "all", worker thinks "relevant" | G3: read spec literally |
| Tests that confirm impl | Tests mirror worker's mental model | G1: test values, not shapes |
| Scope creep in workers | Worker adds "helpful" extras | Spec check: ONLY the directive |
| Trusting worker summary | "Worker said tests pass" | Step 6: re-run tests yourself |
| Skipping export check | New name doesn't match ledger contract | Step 6: verify against ledger exports |
| Re-using stale context | Reading file from earlier in session | Step 3: always re-read before brief |

## Seat Assists (S4)

When delegating to a `compact`-class worker, include the worked exemplar + output schema in the brief — brief obligations scale with the RECEIVING seat's declared class; the exemplar is for the CALLER to embed, never injected into the worker.
{{class compact: worked-brief-exemplar}}
{{class compact: completion-report-exemplar}}
{{class compact: verdict-note-exemplar}}
{{class compact: fix-brief-exemplar}}
{{class compact|capable: tool-loop-guard}}
{{class compact|capable: output-format-guard}}
{{class compact|capable: patch-hygiene-guard}}
