# Foreman v0.5.11 Design Concept — Adaptive Review Council

- Status: concept and experiment plan
- Baseline: Foreman v0.5.11
- Implementation status: not implemented
- Primary proving ground: Crucible with opt-in Langfuse tracing

## Decision

Foreman should evolve its checkpoint review into a provider-agnostic **Adaptive Review Council**.

The council is not a fixed swarm and the lens catalog is not a checklist. One capable, broad reviewer remains the default. Foreman adds a specialist only when that specialist covers a materially different risk that the broad reviewer is likely to miss. The provider adapter should use the host's native agent and state model rather than emulate one provider's orchestration semantics on every host.

This design deliberately optimizes for frontier-class models:

- give the lead reviewer the whole task, contract, diff, and relevant evidence;
- add the smallest number of independent, read-only specialist contexts needed;
- keep deterministic controls at trust boundaries instead of accumulating prompt instructions;
- measure whether each extra lens finds unique, confirmed defects;
- stop adding reviewers when duplication, latency, or token cost exceeds the quality gain.

The first implementation work belongs in Crucible experiments. The experiment will build first-class Claude Code, Codex, and Cursor adapters and test all three against the same defect corpus. Foreman should adopt only behavior that produces measurable quality lift.

## Why this exists

Foreman's current adversarial review can benefit from more than a general critic on large or unusually risky changes. A state-machine refactor, for example, may justify separate architecture/state and security reviewers. A small documentation change usually does not.

The design must also account for two observed failure modes:

1. **Over-decomposition:** splitting a coherent problem across too many cold contexts can consume substantially more tokens, duplicate work, and weaken synthesis.
2. **Shared-tree drift:** an operator-provided run record showed host-native workers using `git stash` and `git reset` in a shared tree, reverting accepted code and the tests that covered it. The full suite stayed green. A later pitboss source-marker and test-impact check exposed the missing work, after which the operator restored it from the retained stash.

The second observation demonstrates detection, not prevention or automatic recovery. Foreman v0.5.11 does not claim to intercept arbitrary Git commands issued by a host-native agent. `aider_worker` is the distinct case where Foreman itself creates and tears down an isolated detached worktree.

## Evidence boundaries

This concept separates what is known from what still needs an experiment.

| Evidence | What it supports | Boundary |
| --- | --- | --- |
| Foreman v0.5.11 source and tests | Current checkpoint, advisor, pitboss, Git, worktree, and host contracts | Does not prove future council behavior |
| Crucible source and tests | Staged deterministic runtime plus working opt-in Langfuse telemetry | Crucible remains a proving ground, not a Foreman runtime dependency |
| Operator-provided Claude orchestration and internals notes | Cold child contexts, filesystem handoff, parallel-write risk, structured output value, and high over-decomposition cost | Local design input, not a portable Claude API contract |
| Claude Code hooks documentation | Lifecycle hooks, prompt/agent hook handlers, subagent events, tool-call filtering, and worktree events exist | Does not establish that a hook can enable a session mode called “Ultracode” |
| Current Codex documentation | Native subagents, custom agents, lifecycle hooks, and read-heavy parallel guidance exist | Foreman must still discover the exact capabilities of the connected host |
| Current Cursor documentation | Native/custom subagents, background agents, and non-interactive CLI execution exist | Local, cloud, and CLI paths have different isolation and security properties |

All provider behavior is capability-discovered at runtime or configured by the operator. Model names, reasoning levels, and host features must not become Foreman-wide assumptions.

## Design principles

### 1. Foreman owns review intent, not provider internals

Foreman defines:

- the review objective;
- the evidence boundary;
- candidate risk lenses;
- the minimum result contract;
- synthesis and acceptance rules;
- trace correlation fields.

The provider owns:

- how agents or sessions are created;
- how context is passed;
- how parallelism and waiting work;
- model and reasoning controls;
- native checkpoint, branch, or worktree behavior;
- the detailed event stream.

“Ultracode” is therefore not a Foreman protocol primitive. It is treated as provider/session behavior described by the supplied local notes. Claude, Codex, and Cursor adapters should achieve the same review intent using their native mechanisms, not imitate that label.

### 2. The lens catalog is a menu

A lens is a compact review perspective with an activation rule and an evidence contract. It is not a permanent agent.

Initial catalog:

| Lens | Activate when | Distinct question |
| --- | --- | --- |
| Contract and correctness | Default broad review | Does the implementation satisfy the accepted contract, including unhappy paths? |
| Architecture and structure | Cross-module refactor, new boundary, dependency inversion, or ownership change | Did the change preserve coherent boundaries and dependency direction? |
| State and concurrency | State machine, retry, queue, transaction, cancellation, stream, or lifecycle change | Are transitions, invariants, re-entry, partial failure, and concurrency safe? |
| Security and abuse | Trust boundary, identity, authorization, secret, parser, network, or untrusted input change | How can an attacker or compromised dependency misuse the path? |
| Data integrity and recovery | Migration, persistence, Git/worktree manipulation, destructive command, or recovery path | Can accepted state be lost, silently replaced, or restored incorrectly? |
| Test strength | High-risk fix, weak regression history, or broad green-suite claim | Would a realistic mutant or removed guard still pass? |
| Operability | Release, deployment, telemetry, timeout, resource, or failure-reporting change | Can operators detect, diagnose, and recover from failure? |

The catalog can grow only when a proposed lens repeatedly finds defects that existing lenses do not.

### 3. Project only the context a reviewer needs

This concept document and the full lens catalog are control-plane material; they are not copied into every reviewer prompt.

- The broad reviewer receives the task, accepted contract, intended diff, and relevant verification evidence.
- A specialist receives that same evidence boundary plus one compact lens card describing its distinct question and output requirements.
- Provider capability details, experiment-arm definitions, and unused lens instructions stay outside the model context.
- Synthesis receives normalized findings and evidence references, not every intermediate transcript by default.

Lens cards must remain short and versioned. If a lens needs a long standing prompt to work, first test whether a stronger broad reviewer or a deterministic boundary check solves the problem more reliably.

### 4. Distinguish independence from perspective

Foreman's existing independent advisor seats remain the baseline for independent judgment where the review protocol requires it.

Multiple agents from the same provider or model family can add perspective diversity, but they are not automatically independent votes. Their correlated assumptions, shared training, shared tools, and shared prompt framing must be disclosed during synthesis.

The council does not use majority voting. A single well-evidenced, reproducible defect can override several unsupported approvals.

### 5. Read-only by default

Council members inspect and report. They do not edit the canonical tree, apply fixes, create stashes, reset branches, or resolve their own findings.

If a provider cannot enforce read-only access mechanically, the adapter records that limitation and Foreman's deterministic post-run validation checks the repository state. Prompt-only restraint is useful guidance, not an enforcement boundary.

### 6. Spend controls at boundaries

Controls should protect high-impact transitions:

- before dispatch: record base commit, worktree state, accepted unit, and allowed evidence;
- after a worker: validate expected source and test impact against actual files;
- before review: bind the review packet to the intended diff and contract;
- after review: require file evidence and reproducibility for blocking findings;
- before acceptance: re-check repository state and the accepted test command;
- before cleanup: preserve recovery artifacts until acceptance is durable.

These checks should be compact and machine-verifiable. Repeating equivalent warnings inside every model prompt creates friction without equivalent enforcement.

## Proposed architecture

```text
checkpoint request
      |
      v
risk classifier ---------> broad review only
      |                           |
      | distinct uncovered risk  |
      v                           |
lens selector                     |
      | 0..N specialists          |
      v                           v
provider-native read-only executions
      |
      v
evidence normalizer
      |
      v
synthesis: reproduce, deduplicate, disclose correlation
      |
      +----> Foreman decision record
      |
      +----> optional experiment trace
```

The control plane should stay small:

1. classify task risk;
2. select zero or more specialist lenses;
3. dispatch through a discovered provider adapter;
4. normalize results into one small schema;
5. synthesize on evidence, not votes;
6. emit canonical Foreman records and optional telemetry.

It should not become a general workflow language. Provider-native orchestration already handles spawning, waiting, cancellation, sessions, and summaries better than a portable imitation is likely to.

## Selection and stopping policy

The lead reviewer receives the complete review packet first. Specialist selection happens only after considering the task shape, changed surfaces, and explicit uncertainty.

Conceptual policy:

```text
selected = []
uncovered = classify_distinct_risks(task, diff, contract, evidence)

for risk in highest_materiality_first(uncovered):
    lens = best_distinct_lens(risk)
    if lens adds evidence not already covered
       and expected lift exceeds its execution budget:
        selected += lens

stop when:
    no material risk remains uncovered, or
    the configured lens budget is reached
```

Default budget:

- small or low-risk change: broad reviewer only;
- medium change with one distinct risk: broad reviewer plus at most one specialist;
- large refactor or multiple trust boundaries: broad reviewer plus a small number of non-overlapping specialists;
- more reviewers require an explicit, recorded justification.

The initial experiment must determine useful numeric limits. This concept intentionally does not invent a universal agent count or token threshold before baseline data exists.

An active council also stops expanding when:

- a candidate lens cannot name a distinct unanswered question;
- new findings only duplicate existing findings;
- a lens repeatedly produces rejected or non-reproducible findings;
- the task is too coupled to partition without losing essential context;
- latency, token use, or operator intervention exceeds the experiment budget.

## Minimal provider-neutral contract

The adapter input should be smaller than a full orchestration DSL:

```ts
type ReviewRequest = {
  runId: string;
  objective: string;
  lensId: string;
  evidenceRef: string;
  baseRevision?: string;
  headRevision?: string;
  readOnly: true;
  budgetClass: "broad" | "specialist";
};
```

The normalized result should retain uncertainty:

```ts
type ReviewResult = {
  provider: string;
  host: string;
  lensId: string;
  completion: "complete" | "partial" | "failed";
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    claim: string;
    evidence: string[];
    reproduction?: string;
    confidence: "high" | "medium" | "low";
  }>;
  limitations: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    durationMs?: number;
  };
};
```

Missing output, partial completion, unsupported structured output, and provider refusal remain explicit states. The normalizer must not convert them into approval.

## Provider adapter direction

| Host | Preferred native path | Foreman adaptation | Discovery or risk |
| --- | --- | --- | --- |
| Claude Code | Native subagents/workflows or headless CLI; hooks for narrow lifecycle integration | Supply lens as a read-only role, use structured result where supported, preserve native session semantics | Test whether hooks are useful triggers; do not assume they can enable “Ultracode” |
| Codex | Native subagents/custom agents and lifecycle hooks | Express lenses as bounded read-only agents or skill-guided delegation; let Codex own threads, waiting, and summaries | Avoid redundant Foreman fan-out when the host already delegated |
| Cursor | Native/custom subagents, CLI print mode, or isolated background agent where appropriate | Prefer local read-only review for sensitive code; treat cloud/background execution as a separate capability and trust boundary | Discover exact installed-version interfaces, permissions, branch behavior, and result format |
| Generic CLI/provider | One bounded reviewer process, optionally sequential specialists | Use the minimal input/result contract and explicit capability flags | No assumed parallelism, hooks, isolation, or structured output |

Adapters declare capabilities such as:

```text
subagents
parallel_readers
structured_output
read_only_enforcement
isolated_workspace
lifecycle_hooks
usage_reporting
```

The selector degrades safely. If a capability is absent, Foreman can run one broad reviewer or sequential read-only reviews rather than reject the entire checkpoint.

## Crucible and Langfuse experiment

Crucible is the correct proving ground because it already has staged execution, deterministic run records, verifier/escalation events, and opt-in Langfuse telemetry.

The current implementation already records model-call timing, token usage where reported, transport/model facts, schema repairs, failures, escalation events, and run-level scores. Telemetry is optional, content capture is separately gated, failures do not alter a run, and canonical outcomes remain in Crucible records rather than Langfuse.

The experiment should add bounded scalar fields or repeated lens spans/events for:

- experiment identifier and arm;
- host and provider adapter;
- task risk class;
- lens selected and why;
- broad versus specialist execution;
- confirmed unique findings;
- duplicate findings;
- rejected or non-reproducible findings;
- escaped regression caught;
- schema repair and operator intervention counts;
- tokens, duration, and cost where available;
- final task outcome.

Crucible's Langfuse metadata currently accepts scalar-friendly data and drops complex objects or arrays. Selected lenses should therefore be represented by separate spans/events or a bounded categorical string, not a nested metadata object.

Content capture stays off by default. The experiment must not send repository prompts, replies, secrets, or source content merely to compare orchestration strategies.

### Controlled arms

Run the same seeded tasks through each of the three provider adapters:

| Arm | Review shape | Purpose |
| --- | --- | --- |
| A | Current Foreman checkpoint/advisor behavior | Baseline |
| B | One broad frontier reviewer | Measure how much the strongest simple path already catches |
| C | Broad reviewer plus model-selected specialist lenses | Test adaptive perspective lift |
| D | Broad reviewer plus deterministic mandatory triggers | Consider only if B/C reveal repeatable misses that justify fixed activation |

The minimum matrix is:

| Provider | Broad-only arm | Adaptive-lens arm | Same seeded corpus |
| --- | --- | --- | --- |
| Claude Code | Required | Required | Required |
| Codex | Required | Required | Required |
| Cursor | Required | Required | Required |

The current Foreman baseline is replayed wherever the existing advisor path supports the provider. Deterministic mandatory triggers remain optional until broad-versus-adaptive results justify them.

### Package-under-test rule

Every provider must test the same built artifact, not a source checkout for one host and a package for another:

1. build Foreman once;
2. run the release tests and production dependency audit;
3. create the npm tarball and inspect its contents;
4. record the tarball name, Foreman version, Git revision, npm shasum, and SHA-256;
5. install that exact tarball into isolated Claude Code, Codex, and Cursor test configurations;
6. prove version, diagnostics, MCP initialization, and tool discovery from each installed copy;
7. run the shared review corpus only after all three installation smokes pass.

If the package changes, its identity changes and the three-provider run restarts. Evidence from different package hashes must not be combined into one comparison.

### Dojo evidence layout

Generated experiment evidence belongs in provider-separated Crucible Dojo folders:

```text
dojo/
  review-council/
    <experiment-id>/
      manifest.json
      corpus/
      claude/
        install/
        runs/
        reports/
      codex/
        install/
        runs/
        reports/
      cursor/
        install/
        runs/
        reports/
      comparison/
```

`manifest.json` binds the experiment to the package hashes, Foreman and Crucible revisions, corpus revision, provider CLI versions, configured models/reasoning classes, arm definitions, and content-capture policy. Each provider folder retains raw host output separately from normalized results and human-adjudicated reports. No provider writes into another provider's folder.

Crucible's existing `dojo/` is generated, gitignored experiment space. Durable product conclusions should be promoted into an intentional tracked report or future design/spec rather than making Foreman depend on local Dojo artifacts.

Use tasks with known, mutation-resistant defects, including:

- removed worker-pool bound while superficial tests remain green;
- body-size protection that prevents buffering but resets the client instead of flushing the required response;
- accepted code and its regression tests both removed from the shared tree;
- adversarial wildcard or regex input with bounded length but exponential execution;
- large state transition refactor with partial failure and retry edges.

Each task should be run across repeated, controlled cells. Analyze the adaptive-versus-broad delta within Claude, within Codex, and within Cursor first. Cross-provider comparison is secondary because provider/model differences can otherwise be mistaken for orchestration evidence. For cross-provider results, hold task, evidence packet, output contract, reasoning class, and execution budget as constant as each host allows, and disclose the remaining differences.

### Measurements

Primary:

- unique confirmed defects found;
- seeded defects caught;
- severity-weighted escape rate;
- rejected/non-reproducible finding rate.

Secondary:

- total and reasoning tokens;
- wall time;
- cost where reported;
- duplicated findings;
- operator interventions;
- schema repairs and failed/partial reviewer runs.

The pilot establishes the baseline distribution. Promotion thresholds are set after that data exists rather than chosen to make a preferred design pass.

### Promotion rule

Promote a council behavior into Foreman only when it:

1. catches a repeatable class of material defect missed by the simpler arm;
2. produces reproducible evidence with an acceptable rejected-finding rate;
3. stays inside an operator-approved token, latency, and intervention budget;
4. completes the shared compatibility corpus through Claude Code, Codex, and Cursor without changing canonical run correctness;
5. degrades to a broad single reviewer when optional capabilities are missing.

Retire or merge a lens when repeated trials show no unique confirmed findings or excessive overlap.

## State-integrity experiment

The shared-tree incident deserves one cheap deterministic experiment separate from lens selection.

Record before dispatch:

- base revision;
- dirty/clean state;
- expected changed paths or markers;
- accepted test-impact evidence;
- retained recovery artifact identity, if one exists.

Re-check after each host-native worker and before acceptance:

- accepted source markers or equivalent semantic evidence still exist;
- regression tests that establish acceptance were not silently removed;
- the observed diff is still based on the intended revision;
- unexpected stash/reset/revision drift is surfaced for operator action.

This is an experiment target, not a v0.5.11 implementation claim. A future fix should prefer a small state invariant over a growing list of Git prohibitions in every worker prompt.

## Failure behavior

- A failed specialist does not silently become approval.
- A partial result is synthesized only with its limitations visible.
- Conflicting findings are resolved by evidence and reproduction, not vote count.
- A provider outage falls back to another configured adapter or the broad reviewer path.
- Telemetry failure never changes the canonical Foreman or Crucible result.
- Repository drift pauses acceptance; automatic recovery requires a separate approved design.
- No review agent writes to the canonical tree unless a later design explicitly creates a distinct remediation phase.

## Delivery slices

### Slice 0 — Baseline

- Preserve Foreman v0.5.11 behavior.
- Add no council runtime to the release tag.
- Capture representative Crucible tasks and current-arm metrics.

### Slice 1 — Experiment-only catalog

- Add a small versioned lens catalog to Crucible.
- Implement broad-only and adaptive arms.
- Add trace correlation and outcome scoring without enabling content capture.

### Slice 2 — Native adapter spike

- Build three first-class read-only adapter prototypes: Claude Code, Codex, and Cursor.
- Build and fingerprint one Foreman tarball, then install that exact artifact into all three isolated host configurations.
- Require package/version/diagnostic/MCP-handshake/tool-list smoke evidence under each provider's Dojo subfolder.
- Run adapter contract tests for complete, partial, refused, malformed, timed-out, and unavailable executions.
- Verify the same evidence packet and normalized result contract on all three.
- Document capability discovery, refusal, partial completion, and cost behavior.
- Test whether provider hooks reduce integration friction; do not require hooks.

### Slice 3 — Evaluation

- Replay the same seeded defect tasks through broad-only and adaptive-lens arms on Claude Code, Codex, and Cursor.
- Compare within-provider lift before drawing cross-provider conclusions.
- Reproduce and adjudicate findings independently of model self-report.
- Write raw outputs, normalized results, and adjudicated reports to the matching provider subfolders in `dojo/review-council/<experiment-id>/`.
- Generate a cross-provider comparison only from runs bound to the same package and corpus identities.
- Establish promotion budgets from data.

### Slice 4 — Foreman proposal

- Promote only the smallest successful behavior.
- Produce a separate implementation spec, compatibility contract, migration plan, and tests.
- Keep Crucible telemetry optional and outside Foreman's canonical decision path.

## Decisions deferred until evidence exists

- Numeric lens, token, latency, and cost budgets.
- Whether the lead model or a deterministic classifier selects candidate lenses.
- Whether Claude hooks can reliably initiate the desired native review mode.
- Exact Codex and Cursor adapter APIs for supported installed versions.
- Whether same-provider specialist runs add enough diversity to justify their cost.
- Whether the state-integrity check belongs in pitboss, a host adapter, or both.
- Any automatic repository recovery behavior.

## External references

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks.md)
- [Cursor subagents release note](https://cursor.com/changelog/2-4)
- [Cursor background agents](https://docs.cursor.com/background-agent)
- [Cursor background agents API](https://docs.cursor.com/background-agent/api/overview)
