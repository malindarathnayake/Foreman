---
id: unit-life
title: A unit's life
sidebar_label: A unit's life
description: Every step between selecting a unit and accepting or rejecting it, with the exact ledger writes and the errors the ledger returns.
---

# A unit's life

This is what `pitboss_implementor` makes the host model do for one unit. Steps marked **ledger** are validated by the server and refused when out of order. Everything else is an instruction in the procedure.

## 1. Select

`session_orient` returns `action: implement_unit` and `resume_target: <phase>/<unit>`. The model reads that unit's directive in `Docs/spec.md` and its entry in `Docs/handoff.md`: files to touch, expected behavior, test command, scope boundary.

**Ledger:** `set_unit_status { s: "ip" }`.

## 2. Read the source

Before writing a brief, the model reads the files the directive names and captures the current function bodies, the import block, exported symbols other units depend on, and how the test file is organized. Briefs quote real code, not recollection.

## 3. Write the brief

The brief is the only thing the worker sees. It contains: the task, the files to create or modify, BEFORE and AFTER excerpts from the real code, the interface the worker must satisfy, an explicit DO NOT list, the shared-tree safety paragraph (read-only git only, no stash, checkout, reset, commit), the performance tier and telemetry contract if the unit has one, the exact test command, and the inner-loop rule: fix compile and import errors yourself up to twice, return immediately on anything about logic or spec.

## 4. Preflight the brief

Seven checks before spawning: extract every symbol the brief names; grep `spec.md` for each; read each hit with context; diff the brief against that footprint for contradictions, omissions, and literal values used differently elsewhere; revise; check that every test expectation in the brief agrees with its own implementation instruction; if the unit emits telemetry, check custom field names against the stack profile's reserved names.

**Ledger:** `set_unit_status { s: "delegated", brief, tier, route_reason, preflight: { symbols_grepped, self_consistent: true, telemetry } }`.

The server refuses this write without a brief of at least 20 characters (`DELEGATION REQUIRED`) or without the preflight object (`PREFLIGHT REQUIRED`). It stores the brief, the tier, and the attestation on the unit's `delegations[]` history, so they survive later re-delegations. It refuses another attempt after three failed attempts since the unit last passed (`DELEGATION CAP`) unless the write carries `user_override: true`, which is recorded on the delegation. Each delegation is an attempt; so is a recorded direct fix.

The attestation is exactly that. The server checks the shape, not whether the grep happened.

## 5. Spawn the worker

Before any editing worker, the model snapshots branch, HEAD, stash list, staged diff, and dirty paths. That snapshot is the ownership boundary it will check against afterwards.

Which worker depends on the host:

| Host | Worker | Who applies the change |
|---|---|---|
| Claude Code | `Agent` tool, model `sonnet`, brief only | The worker edits the shared tree directly |
| Cursor | `Task` tool, `generalPurpose`, brief only | The worker edits the shared tree directly |
| Codex | `spawn_agent` subagent, brief only | The worker edits the shared tree directly |
| Any host, `invoke_worker` (experimental) | The brief and selected file excerpts go to an OpenAI-compatible endpoint configured in `.foremanenv`; a checked patch comes back | The model applies the patch after a base-file hash check |

Editing workers run one at a time on the shared tree. Parallel editing is allowed only when each worker has an isolated worktree, their file sets are disjoint, each returns its full `git diff`, and the model applies those diffs serially with a verdict per unit. Read-only explorer workers may run in parallel.

Line endings matter for worktrees. On a repo with `core.autocrlf=true` and no `.gitattributes` eol rule, a fresh worktree checks out CRLF while the index is LF, and every formatter in that tree reports noise. The procedure has the model check `core.autocrlf` and `git ls-files --eol` first, serialize on the shared tree when the repo cannot normalize itself, create worktrees with `git -c core.autocrlf=false worktree add`, and run `git apply --check` before applying a returned diff.

## 6. Validate

The worker's report is an input, not a verdict. In order:

1. **Repository-state guard.** Compare branch, HEAD, stash, index, and dirty paths against the snapshot. Any change outside the brief's files, or any sign of `git stash`, `reset`, `checkout`, or `clean`, is a hard stop: preserve evidence, escalate to you, do not run tests.
2. **Read every modified file** and compare against the AFTER pattern in the brief.
3. **Run the test command** through `run_tests`, not the shell. Read the exit code, then the stderr tail.
4. **Spec check.** Read the directive sentence by sentence; each needs a code path.
5. **Export check.** Exported names and signatures match what other units expect.
6. **Consistency check** with previously accepted units.
7. **Budget check** for hot and extreme performance tiers: benchmark evidence against the spec's budget.

Then the six self-review gates:

| Gate | When | Check |
|---|---|---|
| G1 | always | Every return field populated by this function; tests assert values, not shapes |
| G2 | phase has tests | No weakened assertions, no bare excepts, no skipped tests without a reason |
| G3 | always | Every spec sentence has a code path; names match literally |
| G4 | phase has tests | Grep the whole suite for changed symbols; old assertions updated |
| G5 | always | Dead imports, test determinism, assertion completeness, module resolution, fragile timing, and secrets or PII anywhere |
| G6 | hot or extreme tier, a Threat Table component, a telemetry contract entry, or an authn, authz, secret, or trust-boundary path | Perf rationale with measurement; telemetry names and cardinality match the contract; security findings carry a `[CWE-###]` prefix |

## 7. Verdict

**Ledger, accept:** `set_verdict { v: "pass", note? }`. Refused (`VERDICT BLOCKED`) unless a delegation with a brief was recorded first. Refused (`ATTEMPT REQUIRED`) when the unit was rejected or failed after its latest recorded attempt: the fix has to be recorded as a worker delegation or a direct fix before the pass. Refused (`DELEGATION CAP`) past three failed attempts unless the current attempt was recorded with `user_override` or the verdict carries it, in which case the waiver is recorded on the unit as `cap_override`. On a phase whose scope declares `has_tests: false` or `has_build: false`, refused (`ATTESTATION REQUIRED`) unless `note` has at least five words and 32 characters describing how the unit was checked. The first pass stamps `first_pass_ts`, which later re-verdicts never change. A pass resets the failed-attempt count to zero.

Then `write_progress complete_unit`.

**Ledger, reject:** `add_rejection { r, msg, ts }`, then `write_progress log_error`. If the unit had already passed, the rejection reopens it to `pending` and the write returns a warning saying so. The rejection is stamped with the attempt it belongs to and counts as a failed attempt; two rejections of one attempt count once. A `fail` verdict counts the same way. An `inconclusive` verdict counts nothing.

## 8. Fix loop

Inner loop, same worker: compile, import, and type errors, at most two self-fixes. Anything about logic or spec comes straight back.

Outer loop, fresh worker, at most three attempts: the model writes a fix brief that quotes the rejection, the spec text, the exact files to touch and to leave alone, the previous attempts from the ledger, and the tier. Raising the tier is allowed only when the fix brief adds context or cites a reviewer diagnosis; a repeated failure on an unchanged brief means the brief is wrong, not the model too small.

After three failed attempts since the unit last passed, the model stops and escalates with the full rejection history. The ledger holds that line: another attempt or a pass then needs `user_override`, so fixing off the record is not a way past it. A unit reopened by a checkpoint finding after a pass starts a fresh count, because the earlier series did converge.

**Direct Fix.** The one case where the model edits product code itself under this protocol. All of these must hold: the unit's latest delegation was host-native, not `invoke_worker`; the change is an exact literal substitution the rejection already spelled out, such as a rename, a typo, an import path, a test name, or a constant the spec states verbatim; it touches only the unit's files; it adds no function, branch, or test; it does not touch authn, authz, secrets, telemetry names, public contracts, schemas, concurrency, or error semantics. Line count is not the boundary. The model records it first with `set_unit_status { s: "ip", direct_fix: "<file>: <substitution>" }`, applies it, runs the full validation and gates, and records `set_verdict { v: "pass", via: "pitboss-direct", note: "direct-fix: ..." }`. It counts as an outer-loop attempt, and the pass is refused without the record. The server refuses the record on a unit that has never been delegated (`DIRECT FIX BLOCKED`).

## Errors you will see

```text
DELEGATION REQUIRED: set_unit_status with s:'delegated' requires a 'brief' field (min 20 chars) ...
PREFLIGHT REQUIRED: set_unit_status with s:'delegated' requires data.preflight — the Brief Preflight Gate attestation: { symbols_grepped: ..., self_consistent: true, telemetry?: 'checked'|'n/a' } ...
DELEGATION CAP: unit 'u3' has 3 failed attempts since its last pass (cap 3). A further delegation needs data.user_override: true ... A pass verdict is blocked the same way ...
VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation. Unit must go through: set_unit_status(s:'ip') → set_unit_status(s:'delegated', brief:'...') → set_verdict(v:'pass') ...
ATTEMPT REQUIRED: unit 'u3' was rejected or failed after its latest recorded attempt #2. Record the fix attempt first — set_unit_status s:'delegated' (fresh worker) or s:'ip' with data.direct_fix (literal substitution) — then set_verdict ...
ATTESTATION REQUIRED: phase 'p4' declares scope has_tests:false. set_verdict(v:'pass') must include a non-empty 'note' ...
SCHEMA ERROR — write_ledger set_verdict rejected (1 issue):
  data.via: Invalid option: expected one of "worker"|"pitboss-direct"|"n/a"
Expected data shape: { v: 'pass'|'fail'|'pending'|'inconclusive', via?: 'worker'|'pitboss-direct'|'n/a', note?: string (≤10000 chars) }
```

For `invoke_worker` there is a separate 17-stage failure taxonomy (`WORKER_TIMEOUT`, `PATCH_PROTECTED_PATH_FAIL`, `ED_STALE`, and so on). Each failure result carries a `hint:` line from a fixed playbook telling the model what to do before re-delegating. The full catalog is in `HOST-CONTRACT.md` in the package.
