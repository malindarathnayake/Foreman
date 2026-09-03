---
id: advisor-seats
title: Advisor seats and deliberation
sidebar_label: Advisor seats
description: Independent cross-vendor reviewer seats, the fixed deliberation loop, and what happens when a seat is unavailable.
---

# Advisor seats and deliberation

Advisors are independent reviewer seats — models with no stake in the work — used for design deliberation and checkpoint review. They are deliberately drawn from a different vendor than the pitboss: same-family models share training priors and blind spots, so cross-vendor review catches classes of defects that self-review structurally cannot.

## The deliberation loop

When non-trivial ambiguities or checkpoint reviews need resolution, the protocol runs a fixed deliberation loop: both advisors analyze the same questions independently and in parallel; the moderator digests their positions and flags hallucination risk, over-engineering, missing evidence, and sycophancy; the advisors cross-examine each other for at most three rounds; and the result is presented as a consensus or as competing proposals with a moderator recommendation.

Non-trivial deadlocks go to the user, and the run does not proceed until the user arbitrates. Advisors never see each other's raw output, never receive the moderator's position first, and never write verdicts — review findings pass through `normalize_review` and `verify_citations` before anything is recorded.

Silence is not approval. Every advisor must list what it examined per category; a seat that reports zero findings with no such list is recorded as `partial`, never as clean. When one seat has confirmed findings and another reported nothing, the silent seat may be re-prompted once with only the file names involved — that pass is recorded as `cross_exam` and never counts as a second independent seat. The phase gate refuses to pass with no review recorded at all.

## Default seat assignments per host

| Host | Advisor A | Advisor B | Moderator | Degraded fallback |
|---|---|---|---|---|
| Claude Code | Codex CLI — GPT-5.6 Sol, reasoning `ultra`, read-only sandbox | Gemini CLI — the operator's `arch-review` model profile | The host pitboss model | Opus agents with an adversarial critic prompt |
| Cursor | GPT-5.6 Sol `ultra`, read-only task | Gemini 3.1 Pro, read-only task | The host pitboss model | Sonnet adversarial review, recorded as non-independent |
| Codex | Headless Claude — `claude-fable-5`, effort `max`, tools and session persistence disabled | Gemini CLI | The Codex pitboss | Adversarial self-review, recorded as non-independent |

These assignments come from real project runs, not published benchmarks. In practice across those runs: the Codex/Sol seat has been the strongest reviewer of state machines and protocol invariants; the Gemini seat reads large Java codebases more reliably than the alternatives; and Claude frontier models have been most effective in the moderator seat.

A moderator arbitrating two opposing, evidence-cited advisor positions produces sharper judgments than the same model asked to find issues in raw code cold — the structured deliberation transcript is better conditioning material than an unframed diff. That observation is why the protocol requires the moderator to digest and compare advisor positions instead of relaying their output verbatim.

When an advisor seat is unavailable, the run continues with the documented fallback and the ledger records that independent review was unavailable — the weakness is made visible, not papered over.
