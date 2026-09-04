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
- **Codex profile:** Advisor A is headless Claude Fable 5 at max effort; Advisor B is Gemini. Claude CLI versions are reported as telemetry and are not compatibility-pinned.
- **Do not use when:** the CLI is not authenticated (capability_check returns a non-ok status with a corrective hint) — degrade to adversarial self-review.
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
  - "`aider_worker` is the exception: that MCP tool creates and tears down its own isolated detached worktree."
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
- [ ] **Before/after state guard** — branch, HEAD, stash ref/list, staged diff, and pre-existing dirty paths are compared before tests or verdict.
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
