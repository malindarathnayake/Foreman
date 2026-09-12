---
id: upgrading
title: Upgrading
sidebar_label: Upgrading
description: How to replace a release, what to verify afterwards, and which releases changed ledger behavior.
---

# Upgrading

## Procedure

1. Install the new tarball over the old one: `npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz`.
2. Restart the host. A running session keeps its old server process for as long as it lives.
3. Verify: `foreman-mcp --version`, then in the host ask for `bundle_status` and `host_status`. `bundle_status` compares `dist/`, `package.json`, and the stack profile override against a snapshot taken when the process started and prints `restart_recommended: true` with what changed when the host is still talking to the old process, `false` when nothing changed, or `n/a` with why it could not compare. It also lists any skill shadowed by an override. Check the tool count against [Register your host](../getting-started/configure-mcp-host.md).

## Overrides that shadow the upgrade

A file at `.claude/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md` replaces the bundled procedure of the same name under every host profile. After an upgrade the bundled procedure changes and the override does not. Symptoms: the model does not know about a field the changelog says exists, or `write_ledger` refuses a call the procedure told it to make. `bundle_status` says `override` when one is active. Archive the override somewhere outside those paths, restart the host, and check `bundle_status` again.

Older personal ethos files: if you installed a `~/.claude/engineering-ethos.md` and skill overrides for it in the 0.4.x era, archive them and use the bundled `ethos` tool; the overrides were shadowing newer protocols.

## Ledger compatibility

Ledger changes are additive. An older ledger loads under a newer server; fields it lacks are treated as absent, and the behaviors below apply from the first write after the upgrade.

| Release | What changed for existing projects |
|---|---|
| 0.5.0 | Added `v_ts`, `inconclusive` verdicts, rejection attempt stamps, gate staleness hash, secret scrubbing on write, the external-worker events file, `invoke_worker` |
| 0.5.5 | `aider_worker` |
| 0.5.11 | `declare_phase_units`; a gate now refuses while a declared id is unregistered |
| 0.5.12 | `invoke_council`; optional Langfuse tracing |
| 0.5.13 | Shared-tree worker safety in the procedures; paged `read_ledger` |
| 0.6.0 | A gate refuses with no recorded review; a rejection on a passed unit reopens it; `first_pass_ts`; natural ordering in `session_orient`; `record_review` gains `completion`, `checked`, `limitations`, `stage`. Existing projects: the next gate needs a `record_review` |
| 0.6.1 | `set_unit_status s:'delegated'` refuses without `preflight`; schema errors become one hint per field; journal codes `SPEC_GAP` and `GATE_OVERRIDE`; `run_tests` output shaping. Existing projects: the next delegation needs the preflight object |
| 0.6.2 | A gate refuses while a review recorded since the latest verdict carries a `confirmed` finding, or is partial, failed, or silent with no `checked` list; a review that predates a re-verdict no longer satisfies the review requirement. Data shapes moved into the input schema. Journal `msg` limit 400. `gofmt` and `golangci-lint` in the `run_tests` allowlist with `fail_on_stdout`. `aider_worker` worktrees created with `core.autocrlf=false`. Existing projects: a phase with an old confirmed finding needs a fresh review after the fix, and a zero-finding review needs `checked` or `completion: complete` |
| 0.6.3 | `aider_worker` removed; `.foremanenv` no longer accepts `aider-cli` or the `FOREMAN_NUM_CTX_*`, `FOREMAN_MAX_REFLECTIONS_*`, `FOREMAN_REASONING_TAG_*` keys; journal codes trimmed to 15; the tarball ships only runtime files. Existing projects: sidecars and journals written earlier still read; a `.foremanenv` with an `aider-cli` tier must drop it |
| 0.6.4 | A pass verdict refuses without an attempt recorded after the latest rejection or fail verdict (`ATTEMPT REQUIRED`) and, past the cap, without `user_override` (recorded as `cap_override`); the cap counts failed attempts since the unit last passed; `fail` verdicts count; a direct fix is recorded with `set_unit_status { s: "ip", direct_fix }`; `record_review` findings need a classification; `bundle_status` compares disk against a process-start snapshot. Existing projects: a unit rejected before the upgrade with no delegation since needs its fix attempt recorded before it can pass; a review recorded earlier with an unclassified finding reads as incomplete at the next gate |
| 0.6.5 | `authorize_attempts` records one owner grant past the cap instead of a `user_override` per write; a `cross_exam` review no longer satisfies the gate's review requirement; `stage: "verification"` with evidence closes direct-fix follow-ups; `state_drift` fires only on a unit marked complete that the ledger has not passed, everything else is a `progress_advisories` note; `invoke_advisor` reports an empty or echoed exit-0 result as `completion: failed`; `checked[]` entries up to 400 characters; `complete_unit` counts legacy checkbox lines outside the fence. Existing projects: a phase whose only current review is a `cross_exam` record needs an independent review or a verification record before its gate passes; a session that stopped on pointer drift resumes without it |
| 0.6.20 | Over-long `log_event msg`, `record_review checked[]`, `limitations`, and native reviewer `checked[]` entries are cut to the limit with a trailing `…[truncated N chars]` marker and a warning instead of refusing the write; ids, findings, evidence and notes still refuse. |
| 0.6.21-0.6.23 | `close_attempt` labels a non-failure ending; `worker_status` reads worker heartbeats; `phase_ownership` sweeps a phase; `contract_probe` is bound to a claim in the spec's `foreman-contract` block and required in a `has_api` phase; `live_smoke` records a run receipt the pass verdict reads; the ledger holds one repository window per root. Probe and smoke resolve credentials from `~/.foreman-mcp/.env`. Existing projects: a `has_api` phase needs a contract block per unit before its next preflight |
| 0.6.24-0.6.25 | The contract block gains `deliverables` whose bytes the verdict re-digests; the contract and the spec's `Test:` line are FROZEN on the delegation, so editing either afterwards refuses the verdict rather than lifting a gate; `preflight_check` gains `creates` for files the unit will make, and the pass verdict checks the promise; the checkpoint must select the Go package of every authorized file. Existing projects: a unit whose `Test:` line misses one of its own packages needs the line widened or `user_override` |
| 0.6.26 | Durability: `atomicWriteFile` fsyncs before the rename, which is what a crash-truncated all-NUL ledger was missing; sidecar appends flush too. `repo_guard` refuses an accidentally empty allow-list and reports an authorized file that is entirely NUL; `verify_oracle` calls a run that executed NO test `invalid` rather than a survivor; middle rank gains bounded worker reuse; `read_ledger { query: "reconstruct" }` builds a read-only recovery worksheet from the append-only sidecars. Existing projects: nothing to do |
| 0.6.27 | `researcher` protocol added. The declared model rank survives a mid-session Foreman restart — it is read back from the journal, same-host and still-open only, and restores ORIENTATION but no workflow permissions until `declare_model` confirms the model. `preflight_check` stores the brief text beside its hash, so a delegation can carry `preflight.receipt` with no `brief` field. A HEAD move whose commits touch only Foreman-owned files is attributed, not a violation. `-run` in prose is no longer read as a citation, and a short path resolves against the unit's own declared directories. Existing projects: nothing to do |

Tools added along the way: `invoke_worker` (0.5.0), `aider_worker` (0.5.5, removed in 0.6.3), `invoke_council` (0.5.12), `codex_agents_init` (Codex profile), `preflight_check` / `verify_oracle` / `repo_guard` (0.6.10-0.6.20), `phase_ownership` / `worker_status` / `contract_probe` / `live_smoke` (0.6.21-0.6.22), `researcher` (0.6.27).
