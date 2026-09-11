# HOST-CONTRACT — Foreman's six-capability host contract (v0.5.0)

What a host must provide to run the Foreman protocols, and exactly how ready each capability is. The claude-code / cursor / codex presets are RENDERED compatibility presets over this contract, not privileged modes — a "preset" is a pre-rendered profile of this contract, never a superset of it.

## Smoke taxonomy (3 levels)

| Level | Meaning | CI policy |
|---|---|---|
| contract | Deterministic render/shape check, no credentials, no network | REQUIRED in CI |
| dry-run | Exercises the real code path with mocked/synthetic providers | CI-optional, deterministic |
| live | Real provider, real credentials | Diagnostic ONLY — must not fail CI |

## Capability readiness matrix

Six capabilities, each rated READY / DECLARED / EXPERIMENTAL. READY means the behavior is exercised today. DECLARED means the shape and semantics are fixed and documented but enforcement/telemetry is partial. EXPERIMENTAL means the capability exists on one preset only and is not yet a general contract guarantee.

### spawn-worker

- **Readiness:** READY (exercised by the claude-code preset; Cursor and Codex preset rendering tested).
- **Use when:** a unit brief is fully specified and a disposable implementation seat is available.
- **Do not use when:** the change is a one-line orchestrator-side fix or the brief cannot be isolated from spec/ledger.
- **NOT-claims:**
  - "Foreman does not spawn processes itself for native worker seats — the host's agent mechanism does"
  - "worker seats never see the spec, ledger, or progress files"
  - "Codex currently owns per-subagent model selection — `gpt-5.6-luna` is a preferred seat, not a Foreman-enforced claim"
- **Smoke:** `worker_invoke` and `worker_fanout` placeholders render on every host with zero unresolved markers (contract, CI-required via hostContract.test.ts / skillLoaderHost.test.ts).
- **Codex fan-out:** `spawn_agent` editing workers share repository state and run sequentially unless each has a proven isolated worktree/sandbox. `agents.max_threads` is for read-only explorers/reviewers, or patch-only workers with disjoint editable sets and CAS-protected apply. Each unit still requires its own `s:'delegated'` ledger write before spawn; `max_depth=1` remains mandatory. Call `codex_agents_init` once per project to write `.codex/agents/{explorer,worker}.toml` and create `.codex/config.toml` `[agents]` only when that file is absent (existing config.toml is never overwritten).

### invoke-advisor

- **Readiness:** READY (invoke_advisor tool + D11 capability_check taxonomy).
- **Use when:** phase-checkpoint deliberation or design review needs independent perspectives.
- **Codex profile:** Native reviewers and a separate verifier are the default review path. At major checkpoints, available Claude Fable 5 (max effort) and Gemini CLI advisors add external review through the existing tools. Missing CLIs do not block a complete native review. CLI versions remain telemetry, not compatibility pins.
- **Native review gate:** `record_review stage:'native'` is accepted on the Codex host. A complete record requires 2-5 distinct native reviewer IDs with distinct lenses and completed checked lists, a separate verifier ID, its checked list, and no unverified findings. Native provenance is host-reported; Foreman validates the shape, not the host process graph. Current confirmed findings, stale reviews, incomplete review coverage, and all existing unit/scope checks still block the gate. Legacy `fan` records remain non-qualifying. External review findings retain their own source; native review never claims cross-vendor independence. On Codex a native re-review may be scoped to the moved units and recorded with data.units.
- **Do not use when:** the CLI is not authenticated (capability_check returns a non-ok status with a corrective hint). On Codex, continue with the native review path and record the optional advisor as unavailable in `limitations`; on other hosts, ask the owner for a waiver. Never substitute a self-review pass for a seat.
- **Receipts (0.6.19):** every `invoke_advisor` run appends a receipt to `.foreman-seats.jsonl` beside the ledger (hash-chained, Foreman-only writer) and returns `seat_receipt` and `packet_sha256` in its meta block. `record_review` binds one receipt to one independent record when `packet_hash` equals the receipt's prompt hash, the run succeeded, the receipt is unspent, and it post-dates the newest verdict and attempt.
- **Per-unit coverage (0.6.20):** the phase gate judges review currency per unit: a record covers a unit when recorded at or after that unit's verdict with a snapshot naming its current attempt. `record_review data.units` narrows a seat's snapshot to the units it examined (narrowing only; refused with cross_exam, verification or fan, and for unregistered ids). The gate requires every unit's current attempt to be covered by an independent record, a complete native record (Codex), or an eligible verification, and names the uncovered units. Earlier records keep blocking on confirmed findings and incompleteness while they carry a unit no later seat covers. The stamp basis is the weakest per-unit class. Legacy records without a snapshot stay timestamp-keyed.
- **Soft limits (0.6.20):** `write_journal log_event msg`, `record_review checked[]`, `limitations`, and native reviewer `checked[]` entries over their limit are cut to the limit with a trailing `…[truncated N chars]` marker and a warning instead of refusing the write. Ids, findings, evidence and notes keep hard limits; the gate reads nothing from a truncated field beyond its presence (a worker_delta record still needs `checked[]` to match `evidence.files`, so a cut path fails closed).
- **NOT-claims:**
  - "advisor child processes inherit the full environment — a DOCUMENTED boundary, not a filtered one (see SECURITY.md)"
- **Smoke:** mocked per-status taxonomy matrix (contract, CI-required: capabilityCheckTaxonomy.test.ts); real-CLI probe (live, diagnostic).

### run-tests

- **Readiness:** READY (allowlisted runners, bounded output).
- **Use when:** validating worker output against the unit's named test command.
- **Do not use when:** the runner is not in the allowlist (run tests via the host shell and paste evidence instead).
- **NOT-claims:**
  - "no arbitrary shell execution — runner allowlist only"
- **Smoke:** runner-allowlist + bounded-output unit tests (contract, CI-required).

### report-tokens

- **Readiness:** DECLARED (advisor calls report tokens_used today; per-delegation token telemetry arrives with `invoke_worker` in P4).
- **Use when:** recording delegation cost telemetry.
- **Do not use when:** the host cannot count tokens — record 0/unknown, never estimates.
- **NOT-claims:**
  - "no cross-tool token accounting in v0.5.0"
- **Degradation** (from the capability-set module): token telemetry recorded as 0/unknown; token-budget features and autonomy are refused.
- **Smoke:** capability-set totality test (contract, CI-required).

### honor-isolation

- **Readiness:** DECLARED (semantics documented below; enforcement is host-side; the `edit_format` seam ships in v0.5.0's shape parser).
- **Use when:** multiple seats might touch the same tree.
- **Do not use when:** single-seat sequential work on one tree (isolation is then a no-op).
- **NOT-claims:**
  - "For host-native seats, the Foreman capability layer validates isolation declarations; the host creates and destroys their worktrees."
  - "Foreman does not intercept a host-native agent's Git commands. The host/brief MUST deny Git mutations (`stash`, `reset`, `checkout`, `switch`, `clean`, staging, commits, ref/index/stash changes), and the pitboss MUST compare branch/HEAD/stash/index/dirty-path state before running tests. A mismatch is a hard stop; Foreman never performs automatic recovery."
- **Smoke:** seat-declaration shape validation (contract, from P3 onward).

### autonomy

- **Readiness:** EXPERIMENTAL (claude-code /goal preset only; cursor: unsupported; codex: DRAFT).
- **Use when:** a user-issued goal with budgets and scopes declared up front needs to run across phase-gate-bounded work without an interactive turn per step.
- **Do not use when:** no budget/scope declaration exists (fails closed — no autonomous continuation), or the host cannot report tokens (`report-tokens` is a prerequisite).
- **NOT-claims:**
  - "Foreman does not supply the autonomous trigger — it ships the continuation directive; the host supplies the trigger"
  - "an autonomy goal never rolls past a phase gate — the gate ends it"
- **Smoke:** `{{autonomy}}` placeholder renders on every host (contract, CI-required via hostContract.test.ts); autonomous goal runs are live-diagnostic only.
- **Full clause below** — see "Autonomy capability".

## Isolation semantics checklist

- [ ] **Worktree-per-seat** — each concurrent seat gets its own worktree.
- [ ] **Per-run state record** — which seat, which tree, which base commit.
- [ ] **Orphan-reclaim rule** — a crashed seat's tree is reclaimed only after its state record is inspected.
- [ ] **Never destroy dirty state.**
- [ ] **Shared-tree mutation denylist** — implementation workers use read-only Git inspection only; repository/index/stash/ref changes are forbidden.
- [ ] **Before/after state guard** — branch, HEAD, stash ref/list, staged diff, and pre-existing dirty paths are compared before tests or verdict. Foreman-written state (.foreman-ledger/progress/journal/events/seats and their side files) and the fenced block of Docs/PROGRESS.md are excluded from the comparison by the server; a file outside that set is never excused.
- [ ] **Artifacts, not shared trees** — work crosses seats only as well-formed artifacts (patches/reports), never shared mutable trees.
- [ ] **Line endings** — worktrees are created with `git -c core.autocrlf=false worktree add` so the checkout matches the index; `.gitattributes` is authoritative. A repo with `core.autocrlf=true` and no eol attributes for the delegated files serializes editing seats instead of parallelizing. Returned diffs pass `git apply --check` and are rejected when their endings disagree with the target path's `git ls-files --eol` attributes; the presence of CR alone is not a defect.
- [ ] **State-root separation by path classification** — project tree vs Foreman state vs scratch — a write outside the declared class is a defect.

## Seat declaration

```
{ seat_id, role, capability_class, tier, edit_format, isolation? }
```

- `seat_id` — unique identifier for this seat instance.
- `role` — `pitboss` | `worker` | `advisor`.
- `capability_class` — `frontier` | `capable` | `compact`.
- `tier` — `cheap` | `standard` | `premium`.
- `edit_format` — `unified_diff` | `search_replace` | `whole_file`.
- `isolation?` — optional; carries the worktree/seat isolation declaration when honor-isolation applies.

Config DECLARES, tools VALIDATE — a seat never self-describes its class or tier at runtime.

Capability class and cost tier are two axes, both recorded per delegation.

## Declared workflow rank

The pitboss reports `env.model` and `env.effort` in `write_journal init_session`; `declare_model { model, effort }` replaces the declaration on a model change. Foreman trusts this input and maps it to permissions; it does not authenticate model identity. Missing or unmapped values use normal protocol without blocking startup. A new session declares again, and session end or server restart clears the active declaration.

| Weight | Mapping | Workflow permission |
|---|---|---|
| 3 Top | Astra / `gpt-6-astra`, effort `high`, `xhigh`, `max`, `ultra`; Fable 5.1 | Bounded native worker reuse, compact follow-ups, focused intermediate checks, independently verified delta review |
| 2 Middle | Opus; Terra / `gpt-5.6-terra` | Mechanical native worker reuse and compact follow-ups; normal checks and review |
| 1 Standard | Sonnet; Luna / `gpt-5.6-luna` | Normal protocol |
| 0 Unknown | Undeclared/unmapped, including Sol | Normal protocol |

Rank is an additional workflow axis, separate from configured capability class and cost tier. It neither promotes a seat class nor sums across seats. Native worker reuse needs the same active session, unit, recorded worker ID (bound at the verdict, or by the first correction while the attempt carries no ID whatever verdict it received; never rebound) and frozen file scope, a new recorded attempt, normal preflight, and a fresh guard comparison. A changed understanding or scope starts a fresh worker. New implementation, fixes and test edits always use workers. Rank never waives ownership, authorization, budgets, attempt limits, required validation or checkpoint gates. Retained review evidence remains portable; the next action uses the incoming rank. The finding a correction answers may be recorded on the delegated write (`set_unit_status data.rejection`), and an escape class on the verdict (`set_verdict data.escape_class`); both are the same ledger semantics as `add_rejection` / `record_escape` in one write.

Rank never enters review sufficiency. Declared ids (`verifier_id`, `worker_id`, native agent ids) are strings compared for distinctness; Foreman does not verify them.

## Review outcomes, receipts and the independence bound (0.6.19)

The seat rule at `update_phase_gate` is unchanged. What is new is that every COUNTED pass (a first pass, or a re-pass over a changed unit set; re-issuing `g:'pass'` over the same snapshot stamps nothing) is stamped with the basis that carried it, from strongest to weakest: `receipted_external`, `delta:receipted_external`, `declared_external`, `delta:declared_external`, `receipted`, `same_provider`, `delta:same_provider`, `override`. The stamp lists the seats, the other records present, the per-unit attempt snapshot, every waiver accepted, the declared rank, and a token split. Scalar totals per basis survive the bounded history (5 stamps per phase).

**What a receipt proves.** A Foreman-launched process on a named vendor ran after the newest verdict and attempt in the phase, was served the model it names, and produced at least 200 bytes from a prompt of at least 1024 bytes that the record names by hash. It does not prove the findings came from that output. A pit-boss with a shell can still write the file; the hash chain makes that loud, not impossible. A receipt on the host's own vendor is `same_provider`; a receipt on a host whose vendor Foreman cannot know (cursor, generic) is `receipted`, and two receipted vendors on such a host are `receipted_external`.

**Independence bound.** The ledger keeps a streak of consecutive weak-basis counted passes. Weak: `same_provider`, `delta:same_provider`, `override`, and on a Codex-host record an unreceipted `declared_external`. The third such pass is refused (`INDEPENDENCE BOUND`, bound 3) unless `data.user_override: true`, recorded on the phase as `independence_override`. Only a `receipted_external` pass resets the streak; every other basis is neutral. A re-gate of a phase already in the streak neither spends nor resets. Records written before 0.6.19 carry no `basis_version` and are neutral.

**Escapes.** A unit is covered by the counted gate whose attempt snapshot still matches it. A rejection, a non-pass verdict, or a new attempt on a covered unit records an escape against that gate (existence is server-authored; the class is a closed enum). `set_verdict v:'pass'` on a unit with an unclassified escape and `update_phase_gate g:'pass'` on a phase with any are refused unless overridden (`cap_override.waived:'escape'`, `escape_override`). `record_escape { class, found_by?, note? }` classifies, as does `add_rejection { escape_class }` in the same write and `set_verdict { escape_class }` for an escape recorded by a reopen or a new attempt (the newest unclassified one; an older one, possible only after an `escape_override`, still refuses the pass); `source:'later'` records a defect found out of band on a still-covered unit. Escape counts are a floor: only contradictions written to the ledger are seen, and on a Codex-only project the finder is usually the next native review.

**Report.** `read_ledger { query: "review_outcomes" }` recomputes gates, re-gates, units, seat agents per gate, defect and other escapes, and tokens per basis from the scalar totals on every read; with `phase` it appends that phase's escape rows. Cost is a partial axis: native records carry no token surface.

## Reality as a source of truth (0.6.22)

A unit's external claims and its live smoke plan are authored once, in a `foreman-contract` fenced JSON block under the unit's heading in `Docs/spec.md`, and executed only from there. `contract_probe { phase, unit_id, claim_id }` loads the request recipe and assertions from the claim and records the claim id and the contract digest; a url-mode probe is recorded `diagnostic` and never satisfies a claim. Capture streams under a 4 MB cap and an incomplete capture fails every body assertion. `live_smoke { phase, unit_id, plan_id }` runs the registered plan through `run_tests` (no shell, the runner allowlist applies) in the plan's cwd and records a receipt bound to the attempt, the contract digest, a digest of the harness files and a digest of the application inputs, all server-computed. In a `has_api` phase: `preflight_check` requires a passing claim-mode probe for every registered claim under the current digest (no block is a refusal; `claims: [], smoke: null` is the reviewed opt-out); the delegation freezes the digest and refuses a receipt taken under another; `set_verdict v:'pass'` recomputes the digests and refuses (`SMOKE REQUIRED`) without a current passing smoke whose digests still match, waivable by `user_override` as `cap_override.waived: smoke`. The ledger keeps one repository window per root: a guard snapshot acquires it (`editing`), an ok comparison moves it to `validation`, any verdict, `close_attempt` on the owning attempt, or a new attempt on the same unit releases it, and another unit's delegation or snapshot is refused meanwhile (`WINDOW BUSY`). A guard comparison carries the baseline hash it was taken against and is refused against a different baseline. Servers started without a spec path keep the 0.6.21 behaviour. What a smoke receipt proves: Foreman executed the frozen recipe on these bytes and saw this result. What it does not prove: that the harness honestly exercises production code; the harness inventory exists so review can read it.

## Attempt outcomes, heartbeats, contract probes (0.6.21)

`close_attempt { attempt, outcome: delivered | blocked | validation_only, note }` labels a non-failure ending once and keeps lifetime counters on the unit; a rejection or fail verdict marks the attempt `rejected`, server-authored and never relabelled. Nothing here touches attempt ids, the failure cap, `needs_attempt`, the guard or the verdict. Workers append heartbeat lines to `.foreman-heartbeat.jsonl` (Foreman-owned, guard-excluded, never a fence mark); `worker_status` reads them keyed on the current attempt and is advisory. `contract_probe` is executed by Foreman (GET or HEAD only), evaluates explicit assertions, stores origin and path but never a query or a credential value, and records on the unit; a phase whose scope declares `has_api` cannot pass preflight without a passing probe. Two actors, one tree: the pit-boss does not write Docs/ or the harness inside a worker window; a path exemption was considered and vetoed because content cannot attribute a write to an actor.

## Preflight receipt and the oracle (0.6.20)

`preflight_check` compares a worker brief against the spec before the attempt is spent and writes a record beside the ledger keyed on the brief's hash. Once a project has run it, `set_unit_status s:'delegated'` refuses a brief whose hash has no passing record (`PREFLIGHT RECEIPT`); before that first run the attestation stands with a note. Refusals are mechanical (a symbol absent from the spec, a citation that does not resolve); everything else is advisory. `verify_oracle` is the mutation primitive the repeated-block rule asks for: apply, run the guard test through run_tests, restore by hash, record killed/survived/invalid on the unit. `stage:'native'` is accepted on Claude Code as well as Codex; the basis stamp labels it same-provider and the independence bound caps the streak.

## Probe check: discover before you escalate (0.6.20)

A gap about how something outside the repository behaves (schema, query shape, field names, permission strings, response taxonomy, limits, webhook payloads, whether a port answers) is answered by a probe before it can be classified. The pit-boss answers a fixed block itself: official docs for the exact version (through a research MCP or fetch, never cited without a version match), what would answer it, side effects, credentials, cost, decision. Docs and probe are a pair: the docs say what should be there, the probe confirms what is. `PROBE NOW` when side-effect-free with a held credential; `ASK ONE LINE` when a side effect or a missing credential needs the user, who is present; `OWNER DECISION` only for policy, ownership, cost, scope and security-control wording. The block heads any decision or journal entry the gap produces and is included by the implementor, design partner, spec generator and lighttask procedures. Discovery replaces the packet, never the unit protocol. Field report 2026-09-10: a pit-boss wrote a 117-line owner packet for a GraphQL document gap that introspection answered in minutes.

## Saved workflows (Claude Code only, 0.6.20)

The Claude Code host exposes a Workflow tool that orchestrates many agents from one script. Foreman ships three scripts and installs them into the project's `.claude/workflows/` through `claude_workflows_init`; the pit-boss runs them by name with the host's tool. A run is a paid, user-approved action: the skill text tells the pit-boss to confirm the workflow, its phases and agent count with the user first unless the session opted in (`ultracode`, or a standing instruction), and the host shows its own permission dialog.

| Workflow | When | Result |
|---|---|---|
| `foreman-design-panel` | an open design question in design_partner or spec work | one recommendation plus the conflicts the user arbitrates |
| `foreman-checkpoint-review` | the review fan at a phase checkpoint | a record_review-ready report, recorded `stage:'fan'` with the run id in `limitations` |
| `foreman-triage` | a batch of field reports | each report verified in code, a fix designed and attacked; implementation stays with the unit protocol |

Every agent in a workflow runs on the host's own model. A workflow review is therefore PERSPECTIVE, recorded as `fan`, and never a gate seat; `invoke_advisor` seats on another vendor still satisfy the gate and the independence bound. Implementation never runs inside a workflow: each unit keeps its ledger record, guard cycle and verdict, and editing workers run sequentially on the shared tree. Other hosts have no saved-workflow surface and their placeholder says so.

## Autonomy capability

This section is the source text behind the `{{autonomy}}` placeholder family.

Budgets and scopes are declared up front; absence of a declaration fails closed — no autonomous continuation.

`report-tokens` is a prerequisite: a host that cannot report tokens cannot run autonomy features.

Autonomous work suspends across compaction and re-enters via `session_orient`.

Foreman ships the continuation directive, the host supplies the trigger.

## Inner loops per path

| Path | Self-fix | Outer loop |
|---|---|---|
| native worker seat | ≤2 (compile/import/type only) | ≤3 |
| `invoke_worker` (P4, EXPERIMENTAL) | NO self-fix (one-shot; repair loop lands v0.6) | ≤3 |

Both: logic/spec failures return to the pitboss immediately.

## Seat minimum (D13)

`update_phase_gate g:'pass'` on a phase scoped `hot_path` or `security_boundary` REQUIRES `data.agent_class === 'frontier'` (or `data.user_override: true`).

Note: mechanically enforced from v0.5.0 (ships in P3); document-level rule here.

## Completion report (worker_invoke capability)

The schema a native worker seat returns to the pitboss:

```
{
  status: "complete" | "blocked" | "failed",
  files_changed: [ ... ],
  test_command: string,
  test_exit_code: number,
  deviations: [ ... ],
  evidence: [ "file:line", ... ],
  tokens?: { in: number, out: number },
  worker_confidence?: number
}
```

- `status` — one of `complete`, `blocked`, `failed`.
- `files_changed` — the files touched by the worker.
- `test_command` — the test command actually run.
- `test_exit_code` — the exit code of `test_command`.
- `deviations` — deviations from the brief, if any.
- `evidence` — `file:line` anchors backing the report's claims.
- `tokens?` — `{ in, out }`; 0/unknown allowed when report-tokens is unsupported.
- `worker_confidence?` — 0-1.

worker_confidence is advisory-only and NEVER gates a verdict (D8).

## S7 error-code catalog

Every `invoke_worker` outcome is classified into a closed 17-stage taxonomy. Failures return `status: fail` with `failure_stage`, `refunded`, `hint`, and `delegation_id` (plus a bounded `detail` where useful) — never a bare error string. The tool is ONE-SHOT: a single automatic `reasoning_effort` downgrade retry is the only retry it performs; no other retries happen inside the tool, and a full repair round is deferred to v0.6. Four stages — `ED_STALE`, `PATCH_APPLY_FAIL`, `BLD_ERR`, `W_REJ` — are never emitted by `invoke_worker` itself; they are recorded by the PITBOSS via `write_ledger` after host-side patch apply, build, and review, and the ledger write's post-write hook appends their terminal sidecar event.

| Chain stage | Stages | Terminal event | Refunded |
|---|---|---|---|
| PRE-SEND / TRANSPORT | BRIEF_TOO_LARGE, WORKER_PAYLOAD_SECRET_BLOCK, WORKER_UNREACHABLE, WORKER_TIMEOUT, WORKER_AUTH_FAIL, WORKER_QUOTA_FAIL, WORKER_MODEL_NOT_FOUND | `worker_completed` | YES — excluded from model scorecards |
| STAGE-0 (model discipline) | WORKER_GHOST, WORKER_RESPONSE_TOO_LARGE, MODEL_SCHEMA_FAIL | `worker_completed` | no |
| PARSE / APPLY | PATCH_PARSE_FAIL, PATCH_REDACTION_MARKER_FAIL, PATCH_PROTECTED_PATH_FAIL, ED_STALE, PATCH_APPLY_FAIL | `patch_checked` | no |
| BUILD | BLD_ERR | `validation_completed` | no |
| SEMANTIC | W_REJ | `validation_completed` | no |

| failure_stage | Chain stage | Terminal event | Refunded | Recovery (pitboss action) |
|---|---|---|---|---|
| BRIEF_TOO_LARGE | PRE-SEND / TRANSPORT | `worker_completed` | YES | Brief or file payload exceeds the size budget. Trim the brief, split the unit into smaller files, or raise FOREMAN_BRIEF_MAX_BYTES. |
| WORKER_PAYLOAD_SECRET_BLOCK | PRE-SEND / TRANSPORT | `worker_completed` | YES | A configured secret's value appears in the outbound payload (named in detail). Remove it from the brief/files and re-delegate; nothing left this machine. |
| WORKER_UNREACHABLE | PRE-SEND / TRANSPORT | `worker_completed` | YES | The endpoint could not be reached or returned an unclassifiable status. Check FOREMAN_API_BASE routing and network access, then re-delegate. |
| WORKER_TIMEOUT | PRE-SEND / TRANSPORT | `worker_completed` | YES | The worker stalled mid-response (inter-chunk timeout). Re-delegate; if it recurs, raise FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS or pick a faster model. |
| WORKER_AUTH_FAIL | PRE-SEND / TRANSPORT | `worker_completed` | YES | The endpoint rejected the API key (401/403). Fix the key referenced by FOREMAN_API_KEY in .foremanenv and re-delegate. |
| WORKER_QUOTA_FAIL | PRE-SEND / TRANSPORT | `worker_completed` | YES | The endpoint is rate-limited or out of quota (429). Wait and re-delegate, or switch to a tier with available quota. |
| WORKER_MODEL_NOT_FOUND | PRE-SEND / TRANSPORT | `worker_completed` | YES | The configured model id was not found (404 / model_not_found). Correct FOREMAN_TIER_<TIER> in .foremanenv and re-delegate. |
| WORKER_GHOST | STAGE-0 (model discipline) | `worker_completed` | no | The worker produced no usable patch. Re-delegate with a sharper brief; if it reported a blocker (see detail), resolve that first. |
| WORKER_RESPONSE_TOO_LARGE | STAGE-0 (model discipline) | `worker_completed` | no | The worker's response exceeded the byte budget and was discarded (model output discipline). Tighten the brief or raise FOREMAN_WORKER_RESPONSE_MAX_BYTES. |
| MODEL_SCHEMA_FAIL | STAGE-0 (model discipline) | `worker_completed` | no | The worker's response did not match the required JSON-metadata-plus-patch schema. Re-delegate; if it recurs, pick a more capable tier. |
| PATCH_PARSE_FAIL | PARSE / APPLY | `patch_checked` | no | The returned patch is not well-formed for the requested edit format. Re-delegate, or switch the tier's FOREMAN_EDIT_FORMAT_<TIER>. |
| PATCH_REDACTION_MARKER_FAIL | PARSE / APPLY | `patch_checked` | no | The patch contains a redaction marker (a removed-secret placeholder). Re-delegate; do NOT apply — applying would write the marker into source. |
| PATCH_PROTECTED_PATH_FAIL | PARSE / APPLY | `patch_checked` | no | The patch targets a protected path (docs/state dir, .foreman* file, .git/, or outside the listed files). Re-delegate scoped to the listed files only. |
| ED_STALE | PARSE / APPLY | `patch_checked` | no | The base files changed since delegation (host-side CAS mismatch at apply time). Re-read the files, rebuild the brief, record the attempt with write_ledger add_rejection, then re-delegate. |
| PATCH_APPLY_FAIL | PARSE / APPLY | `patch_checked` | no | The host could not apply the returned patch (hunks did not apply). Record the failure with write_ledger add_rejection and re-delegate with refreshed file contents. |
| BLD_ERR | BUILD | `validation_completed` | no | The patch applied but the build/typecheck failed. Record it with write_ledger add_rejection (include the build error) and re-delegate a fix. |
| W_REJ | SEMANTIC | `validation_completed` | no | A reviewer rejected the applied patch. Record it with write_ledger add_rejection and re-delegate addressing the review findings. |

PATCH_PARSE_FAIL recurring against a given tier is a signal to switch that tier's `edit_format` to something stricter (e.g. `whole_file` for compact-class models) rather than re-delegating the same format again.

### Host apply protocol

1. The pitboss records the delegation in the ledger FIRST — `write_ledger set_unit_status s:'delegated'`.
2. The pitboss calls `invoke_worker`.
3. On `status: ok`, the pitboss verifies each returned `base_file_hashes` entry still matches the on-disk file (a CAS check) before touching anything — a mismatch is recorded as `write_ledger add_rejection r:'ED_STALE'` and the patch is never applied.
4. The pitboss applies the sentinel-delimited patch VERBATIM with host tools.
5. Apply failure is recorded as `add_rejection r:'PATCH_APPLY_FAIL'`; build/test failure is recorded as `add_rejection r:'BLD_ERR'`; the review verdict is recorded via `set_verdict`. Each of these ledger writes closes the delegation's sidecar chain automatically.
