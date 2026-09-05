---
id: ledger-files
title: The ledger and the other files
sidebar_label: The ledger and the other files
description: Which file stores what, which tool writes it, when it appears, what is capped, and whether to commit it.
---

# The ledger and the other files

All paths are relative to the working directory the host started the server in. The default docs directory is `Docs/`.

## Inventory

| File | Appears when | Written by | Read by |
|---|---|---|---|
| `Docs/design-summary.md` | `design_partner` finishes | the model, as a normal file | you, `spec_generator` |
| `Docs/spec.md` | `spec_generator` finishes | the model | the model, every unit |
| `Docs/handoff.md` | same | the model | the model, every session start |
| `Docs/PROGRESS.md` | same | the model, then `write_progress` for the fenced block | you |
| `Docs/testing-harness.md` | same | the model | the model, at validation |
| `Docs/.foreman-ledger.json` | first `write_ledger` | `write_ledger` only | `session_orient`, `read_ledger`, the phase gate, `write_progress` |
| `Docs/.foreman-progress.json` | first `write_progress` | `write_progress` | `read_progress`, `session_orient` for drift |
| `Docs/.foreman-journal.json` | first `write_journal` | `write_journal` | `read_journal` |
| `Docs/.foreman-events.jsonl` | first `invoke_worker` call | that tool and the `write_ledger` hook that closes its chains | the phase gate, `read_ledger delegation_metrics` |
| `Docs/diagrams/*.mmd` | `preview_diagram` is used | the model | `preview_diagram` |
| `Docs/lighttask.md` | `lighttask` is used | the model | you |
| `Docs/foreman-stack-profile.md` | you create it | you | the `ethos` tool |
| `.codex/agents/*.toml`, `.codex/config.toml` | `codex_agents_init` on the Codex host, only if absent | that tool | Codex |
| `.foremanenv` | you create it to configure `invoke_worker` or a review council | you | those tools |

Do not edit the `.foreman-*` files by hand. The ledger's invariants are checked on write, and the next tool write overwrites a hand edit anyway.

## The ledger

One JSON file. Phases keyed by id; units keyed by id inside each phase. Per unit: status `s` (`pending`, `ip`, `delegated`, `done`, `fail`), verdict `v` (`pending`, `pass`, `fail`, `inconclusive`), `v_ts`, `first_pass_ts`, `via`, `note`, the latest brief `w`, `rej[]`, `delegations[]` with brief, tier, route reason, preflight, attempt, and override, `direct_fixes[]`, `tier`, the attempt counters `attempt_seq`, `epoch_failed`, `last_failed_attempt`, `needs_attempt`, `cap_override_attempt`, `cap_override` when a pass waived a rule, and `cap_grants[]`: owner grants past the cap, newest last, each with what was granted, what remains, which attempts consumed it, and how it closed. The counters are server-written; the arrays drop their oldest entries at 20, so the counters and the newest grant, not the arrays, carry the cap. A review record carries `stage` and, for `verification`, the `evidence` object. Per phase: gate `g`, `scope`, `declared_units`, `declared_log`, `reviews[]`, `gate_units_hash`, and the override records `discipline_overrides`, `review_override`, `confirmed_override`.

Two things read it for decisions. `session_orient` derives the next action from it. `update_phase_gate` validates against it. Everything else that reads it is display.

Verdict timestamps drive two different answers. `latest_pass_verdict_unit` is the newest pass by `v_ts`, which a re-verdict moves. `last_completed_unit` is the frontier by `first_pass_ts`, which a re-verdict does not move.

## Progress

`.foreman-progress.json` holds a per-unit status and note for the checklist. It is descriptive. `session_orient` compares it to the ledger unit by unit: an entry marked complete for a unit the ledger has not passed is `state_drift`, and the procedure stops to reconcile; entries that are merely stale, ahead of the target, or unknown to the ledger are `progress_advisories`, which never stop anything. Only the exact status `complete` counts as complete; `complete_unit` writes it.

`PROGRESS.md` is yours except for one block. Everything between `<!-- foreman:checklist-start -->` and `<!-- foreman:checklist-end -->` is replaced on every `write_progress` call with a checklist rendered from the ledger: unit ids in natural order, verdict, and note. Anything you type inside the fences is lost on the next write. The spec generator emits an empty fenced block and keeps the hand-written unit plan, with files and checkpoint commands, outside it. If the file has no fences, the block is appended at the end. If the ledger has not been seeded yet, the block renders `_No phases yet._`.

## Journal

Per session: id, timestamp, branch, phase, units, environment (host, worker, reviewer probe results, declared capability classes), events, and an end-of-session summary with units passed and rejected, workers spawned and wasted, tokens wasted, delay, blockers, and a friction score. Events are anomaly-only, 15 codes: worker failures and rejections, advisor errors, test flakes, build errors, context overflow, spec ambiguity stops, spec gaps decided and continued, gate fixes, tool errors, user interrupts and gate overrides, and so on. After five sessions the file carries a rollup: average friction, top events, total tokens wasted, worst and best unit patterns. `read_journal { rollup_only: true }` returns just that.

## Events

An append-only JSON-lines file with a SHA-256 chain, written only for external workers. Each delegation gets a chain: started, worker completed, patch checked, and a terminal validation event that the `write_ledger` hook appends when the verdict lands. The phase gate compares each passed unit's ledger verdict to its latest chain's terminal outcome. A broken chain throws loudly and halts the gate.

## Caps

| Where | Cap | Behavior |
|---|---|---|
| unit `rej[]` | 20 | oldest dropped |
| unit `delegations[]` | 20 | oldest dropped; attempt numbers keep counting |
| phase `reviews[]` | 20 | oldest dropped |
| phase `declared_units` | 200 | write refused |
| phase `declared_log` | 10 | oldest dropped |
| journal sessions | 50 | oldest dropped |
| journal events per session | 200 | write refused with `event cap reached` |
| `read_ledger` page | 100 rows | cursor paging |

## Commit or ignore

Both work. The choice changes who can resume.

| Policy | Effect |
|---|---|
| Tracked | Anyone who clones can call `session_orient` and get the current unit, rejection history, and open findings. Every verdict is a `git diff`. Rejection messages, brief summaries, and journal notes become part of the repo history |
| Local | Only your checkout can resume. Nothing about how "done" was reached leaves your machine through git |

Check what your repo does:

```bash
git check-ignore -v Docs/.foreman-ledger.json Docs/.foreman-progress.json Docs/.foreman-journal.json Docs/.foreman-events.jsonl
```

`spec_generator` runs that check and records `state_tracking_policy: tracked | local | undecided` in `handoff.md`. If the handoff says to commit state but the paths are ignored, the procedure treats that as a grounding failure and asks you. It never writes `.gitignore`.

`.foremanenv` is different. It must be ignored and untracked, and both worker tools refuse to run otherwise.
