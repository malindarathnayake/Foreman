---
name: foreman:researcher
version: 0.0.1
description: Lightweight iterative-experiment protocol. Question, hypothesis, bounded variant, evidence, decision, checkpoint — for tuning prompts, engines and deterministic blocks without the design -> spec -> implement pipeline.
---

# Researcher

Run iterative experiments where the answer is not known in advance and the work is measured rather than specified: tuning a decomposition prompt until a model reads video frames correctly, or bringing a deterministic engine up to a correctness and latency bar.

The loop is: **question -> hypothesis -> bounded variant -> evidence -> decision -> checkpoint.**

Use `researcher` when you are changing something, measuring the result, and deciding based on the measurement — repeatedly, possibly over days. Use `lighttask` when you already know what to build and it is a surgical change. Use the full `pitboss_implementor` pipeline when a result is ready to become shipped code.

Do not use `researcher` to avoid specifying work you already understand. "I will experiment my way to it" is not a hypothesis.

## Core Rules

| Rule | Requirement |
|---|---|
| One change per variant | A variant that changes two things teaches you nothing about either. Split it. |
| Declare the verdict method BEFORE the run | Write down what counts as better, and on what inputs, before you see the output. Deciding afterwards is how a preferred variant wins on a moved goalpost. |
| Same evaluation set, or it is not a comparison | Two variants scored on different inputs are two anecdotes. State the set; if it changes, every prior score is stale and marked so. |
| Negative results are results | A variant that made things worse is recorded and kept. Deleting it means trying it again in three weeks. |
| Never rewrite a recorded result | Corrections are new rows that supersede, with the reason. The tracker is append-mostly. |
| Direction changes are cited | Record what changed, why, what you ruled out, and what is still uncertain. |
| Uncertainty survives compression | A checkpoint that turns "unresolved" into a settled fact is a lie you will act on tomorrow. Mark proposals as proposals. |
| No autonomous destructive work | Experiments read and write their own scratch outputs. Repository state is user-owned; the same shared-tree rules apply as everywhere else in Foreman. |
| Escalate on promotion | The moment a result becomes code that ships, it leaves this protocol for the normal pipeline. |
| Index, not archive | The thread file is an INDEX: one line per run, pointing at the run's own file. Detail lives in the run file. Nobody — human or model — should have to read a 2000-line tracker to learn what the current baseline is. |
| Index is not truth | The index summarises; the run file is the evidence. Where they disagree, the run file wins and the mismatch is recorded. (Same rule the `spec-man` atlas follows.) |

{{include: uncertainty-protocol}}

## Output — an index and its run files

This follows the galaxy-map / atlas pattern already used by `spec-man`: **the map holds references, not payloads.**

```text
Docs/research.md                      <- the INDEX. Thin. Read this first, always.
Docs/research/<thread>/v3.md          <- one file per run. Full detail, raw output, failures.
Docs/research/<thread>/eval-set.md    <- the frozen evaluation set, written once
```

Use lowercase `docs/` when the repo already does.

**The index carries, and only carries:** the objective, the stopping condition, the current baseline and its measurement, one ROW per run (id, hypothesis, verdict, score, link), the decisions, open questions, and the checkpoint. It stays under roughly 200 lines. When it cannot, the resolved runs collapse into a `## Settled` one-liner each and their rows drop off — the run files are never deleted, only unlinked from the active table.

**The run file carries** everything the row cannot: the exact change, the command, the raw output or a pointer to it, per-case results, what surprised you, and any dead end worth not repeating. It can be as long as it needs to be, because nothing reads it unless that specific run is in question.

**Reading order on resume** is index -> checkpoint -> the one or two run files the checkpoint names. Never a full-thread read. A model that greps the whole thread to answer "what is the current baseline" has been failed by the index, not by its own search.

**Large artifacts** (frames, transcripts, model outputs, profiles) are referenced by path and digest from the run file — never pasted into it. The run file says where they are and what they hashed to.

## Starting From Existing Records

There is no `research_migrate` tool. Bringing prior work — a spec, a progress file, a ledger phase, journal sessions, handoff notes, loose experiment artifacts — into a thread is a manual act, which means **you are the idempotence**. Follow these or a second pass will duplicate what the first pass already imported.

**Never modify the source.** The spec, ledger and handoff stay exactly as they are. Adoption is a read. If a source document is wrong, that is a finding to record, not an edit to make.

**Every adopted item cites where it came from** — file and section, as a link, on the row or in the run file:

```markdown
| v0 | prior baseline from p11 checkpoint | — | 12/20 | [v0](research/frames/v0.md) · src: [handoff.md#p11-checkpoint](../handoff.md) |
```

A row with no source link is something you wrote today, not something you adopted. Keep that distinction visible — it is the difference between evidence and recollection.

**Give adopted runs stable ids derived from the source, not sequence numbers.** `v0-p11ckpt` re-derives to the same id next time; `v0` does not. Re-adopting the same source section must land on the same id, see it already present, and stop.

**Record what was adopted, once, in the index:**

```markdown
## Imported
| source | section | as | date |
|--------|---------|----|------|
| Docs/handoff.md | p11 checkpoint | v0-p11ckpt | 2026-09-11 |
| Docs/.foreman-ledger.json | exp02-calc/u3-evaluate | v1-exp02u3 | 2026-09-11 |
```

Before adopting anything, read this table. A source+section already listed is done — skip it. When a source has genuinely CHANGED since import, add a new run superseding the old one and say what moved; never edit the earlier row.

**Carry over meaning, not just text:** completed work, failures, what is still pending, decisions already taken, and decisions already superseded. A failure that is dropped on import gets retried in three weeks, which is the whole reason the protocol keeps negative results.

**Mark ambiguity instead of resolving it.** Where the source does not say whether something passed, what it was measured on, or whether a decision still stands, write `[UNVERIFIED]` and carry it into Open questions. Adoption is not the moment to decide what old work meant — guessing here launders recollection into the record as evidence.

**Do not import wholesale.** A spec is not a set of runs. Adopt what the thread will actually be judged against: the baseline and its measurement, results that constrain what to try next, and decisions still in force. Everything else stays where it is and gets linked when needed.

**Scores from before the evaluation set was frozen are not comparable** to scores after. Import them marked as such, or leave them out. Two numbers from different input sets are two anecdotes (Core Rules), and adoption is the easiest place to forget that.

## Phase 0: Frame the Question

Before any variant, write the header of the INDEX (`Docs/research.md`):

- **Objective** — one sentence. What are you trying to make true?
- **Current state** — what the baseline does today, measured, not remembered.
- **What would change my mind** — the observation that would make you abandon this direction. If nothing would, this is not an experiment.
- **Budget** — how many variants, or how much time, before you stop and reassess. Bounded on purpose.

A thread with no stated stopping condition runs forever. State one.

## Phase 1: Declare the Evaluation Set and the Verdict Method

This is the phase people skip, and skipping it is why iterative work drifts.

**Evaluation set** — the exact inputs every variant is judged on. Name them precisely: a file list, a directory plus a glob, a frozen corpus, a commit. If the set is a sample, say how it was drawn and keep it fixed. Changing the set later is allowed; it retires every score taken under the old one.

**Verdict method** — one of:

| Method | For | Record |
|---|---|---|
| `deterministic` | Engines, parsers, calculators, deterministic blocks | Pass/fail per case, plus the measurement that matters (latency, allocations, throughput). A correctness regression outranks any speed gain. |
| `scored` | Prompts, model outputs, anything judged | The rubric, its version, and who or what scored it. A model scoring its own output is recorded as such — it is evidence, not ground truth. |
| `observed` | Early exploration with no metric yet | Explicitly provisional. A thread may not CLOSE on `observed`; promote to `deterministic` or `scored` first. |

Write the method into the index and the evaluation set into its own `eval-set.md` before the first run. If you cannot state what better means, that is the finding — stop and resolve it.

## Phase 2: The Variant Loop

For each variant:

1. **Hypothesis** — one sentence: what you changed and what you expect it to do. An expectation you record before the run is worth ten explanations after it.
2. **The change** — one thing. Record it verbatim if it is small (a prompt delta, a parameter), by reference if it is large (a commit, a file).
3. **Run** — against the declared evaluation set, unchanged. Use `run_tests` for anything with a runner; it applies the allowlist and output shaping.
4. **Evidence** — the actual numbers or outputs, not your impression of them. Paste the counts. If a run failed to execute, that is `invalid`, not a result — a guard or harness that ran nothing tells you nothing.
5. **Verdict** — `better` / `worse` / `no-change` / `inconclusive` / `invalid`, against the declared method.
6. **Keep or revert** — and say which. A kept variant becomes the new baseline; record that the baseline moved.

**Where each part goes:** steps 1-5 are written into the run's own file `Docs/research/<thread>/<id>.md` as you go. Step 6 adds ONE row to the index and, if the baseline moved, updates the index's baseline line. Write the run file first, the index row second — the index points at evidence that already exists.

Record each variant before starting the next one. A batch of five variants written up from memory afterwards is a reconstruction.

**On a surprising result:** re-run it before believing it. Non-determinism in model output is expected; non-determinism in a deterministic engine is a bug in the engine or the harness, and the protocol stops until you know which.

## Phase 3: Decisions

A decision is a direction change: adopting a variant as the baseline, abandoning an approach, changing the evaluation set, or redefining the verdict method.

Every decision records:

- **What changed** and **why**, in that order.
- **Evidence** — the variant ids or measurements it rests on. A decision with no cited evidence is a preference; label it one.
- **Alternatives considered** and why they lost.
- **Remaining uncertainty** — what you still do not know that could reverse this.
- **Supersedes** — the earlier decision this replaces, by id. The earlier one stays in the file.

Never edit a past decision. Add the new one and link it.

## Phase 4: Checkpoint

At the end of a session, or when context is running low, replace the index's `## Checkpoint` block (there is only ever one, the current one): current objective, the baseline and its measurement, active hypothesis, what was ruled out, blockers, and the **exact next action**.

Resume reads the checkpoint FIRST, then verifies it against the live artifacts before trusting it: does the baseline still measure what the checkpoint claims, does the evaluation set still exist, did anything move underneath. A checkpoint whose artifacts no longer verify is stale — say so and re-measure rather than building on it.

Foreman's compression can shorten a long thread, but a compressed checkpoint that loses an uncertainty marker or promotes a proposal into a decision has corrupted the thread. Check those two things survive.

## Phase 5: Promotion

When a result is ready to become shipped code, it leaves this protocol.

- Small and surgical -> `lighttask`.
- A feature or subsystem -> `design_partner` -> `spec_generator` -> `pitboss_implementor`.

Record the promotion in the tracker with the variant id it came from, so the shipped code has a traceable origin.

The research verdict is not an implementation verdict — but be exact about what the destination actually enforces, because they differ:

- via `lighttask`: its own grounding, adversarial review and verification checklist. It permits direct implementation for a small unit; there is no ledger delegation and no ownership-guard cycle on that path.
- via the full pipeline: spec, worker delegation, the repository guard, verdicts and phase-gate review, all ledger-enforced.

Pick the destination for the risk, not for the convenience. A measurement is not a gate in either case.

{{include: advisor-grounding}}

## Templates

### The index — `Docs/research.md`

Thin by construction. If this file is hard to scan, the protocol is being used wrong.

```markdown
# Research — <thread name>

**Objective:** <one sentence>
**Stopping condition:** <N variants, or a date, or a bar to clear>
**Status:** active | parked | settled
**Baseline:** v2 — 16/20  ([detail](research/<thread>/v2.md))

## Setup
- **Evaluation set:** [frozen 20-frame set](research/<thread>/eval-set.md)  (frozen 2026-09-11)
- **Verdict method:** scored
- **Rubric / harness:** frame-recall v1 — `npm run eval`

## Runs
| id | hypothesis | verdict | score | detail |
|----|-----------|---------|-------|--------|
| v1 | baseline | — | 12/20 | [v1](research/<thread>/v1.md) |
| v2 | scene split lifts frame recall | better | 16/20 | [v2](research/<thread>/v2.md) |
| v3 | object list adds precision | worse | 9/20 | [v3](research/<thread>/v3.md) |

## Decisions
### D1 — adopt v2 as baseline (2026-09-11)
- **Why:** +4 frame recall, no regression on ordering
- **Evidence:** v2 vs v1 on the frozen set
- **Alternatives:** v3 (object list) — over-segments, rejected
- **Uncertainty:** untested on >60s clips
- **Supersedes:** —

## Open questions
- Does scene split hold on low-light footage? — parked

## Checkpoint (2026-09-11)
- **Baseline:** v2 — 16/20
- **Active hypothesis:** v2 + temporal hint
- **Ruled out:** v3 (over-segmentation)
- **Blockers:** none
- **NEXT ACTION:** run v4 = v2 + temporal hint against the frozen set

## Settled
- Prompt length past ~400 tokens shows no gain (v0a-v0d, archived)
```

### A run file — `Docs/research/<thread>/v3.md`

As long as it needs to be. Nothing reads it unless this run is in question.

```markdown
# v3 — object list adds precision

**Hypothesis:** enumerating expected objects raises precision without hurting recall.
**Parent:** v2
**Evaluation set:** frozen 20-frame set (unchanged)
**Command:** `npm run eval -- --prompt prompts/v3.txt`
**Ran:** 2026-09-11T20:14Z

## Change
```diff
+ List the objects you expect before describing the scene.
```

## Result — worse (9/20, baseline 16/20)
| case | expected | got | pass |
|------|----------|-----|------|
| f01 | 3 scenes | 7 scenes | no |
| ... | | | |

## What happened
Over-segments: the object list makes it treat each object as a scene boundary.

## Artifacts
- outputs: `out/v3/` (sha256 4b1c…)

## Do not repeat
Object enumeration before scene description. Try it AFTER, if at all.
```

## What This Protocol Does NOT Do

- Gate anything. It records and disciplines; it does not refuse.
- Replace the implementation pipeline. Promoted work goes through the normal gates.
- Make a model's self-assessment into ground truth. A model scoring its own output is recorded as a model scoring its own output.
- Bound spend or API usage. That is the host's concern, not Foreman's.

{{include: error-handling-standard}}
