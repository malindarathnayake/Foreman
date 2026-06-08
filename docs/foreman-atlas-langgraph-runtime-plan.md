# Foreman Atlas and LangGraph Runtime Plan

Date: 2026-06-06
Updated: 2026-06-08
Status: partially implemented and validated in dojo

## Decision

Foreman should add two optional support layers:

1. Project Atlas: Graphify or another atlas provider can map a repository and produce queryable source-navigation evidence for `spec_man`, `lighttask`, `doc_man`, and session reorientation.
2. Runtime Control Plane: LangGraph can optionally coordinate long-running, branching, multi-agent Foreman workflows that need durable state, waits, retries, recovery routing, and resumable execution traces.

Neither layer replaces Foreman. Foreman remains the workflow manager and source-of-truth owner.

## Current Release Status

Implemented in v0.1.x:

- `spec_man` protocol guidance for Project Atlas/Graphify evidence.
- `spec_man` machine fields for repo context, atlas metadata, and Plan Delta Ladder output.
- `lighttask` stale-spec and stale-resume re-evaluation guidance.
- MCP activation metadata that tells the model when to use `spec_man`, when `lighttask` should escalate, and when complex implementation may need optional runtime control.
- Dojo validation for TypeScript and Python legacy targets. Both fresh-context subjects scored 100 percent against hidden Plan Delta Ladder contracts.

Still experimental:

- LangGraph runtime adapter.
- Durable checkpointer and interrupt/resume behavior.
- Dedicated Atlas MCP tools such as `atlas_status`, `atlas_refresh`, or `atlas_query`.
- Automatic promotion from `D1 candidate` to `D0 current`. This remains intentionally blocked without review or recorded approval.

## Operating Model

```text
User intent
  -> Foreman protocol head
  -> spec_man grounding and plan evaluation
  -> optional Project Atlas for navigation evidence
  -> optional LangGraph runtime for execution routing
  -> Foreman artifacts as canonical truth
```

Canonical Foreman artifacts:

- specs and machine specs
- ledger
- progress
- journal
- test outputs
- advisor findings
- accepted user decisions
- final implementation records

Non-canonical support artifacts:

- Graphify `graphify-out/GRAPH_REPORT.md`, when report generation succeeds
- Graphify `graphify-out/graph.json`
- Graphify query/path/explain outputs
- LangGraph checkpoints
- LangGraph execution traces
- runtime state inspectors

Support artifacts can guide the agent. They cannot approve requirements, plans, edits, tests, or releases.

Atlas metadata must include enough context to judge freshness:

- provider name and version
- command used
- repo root
- branch and commit when git is available
- dirty-state hash or file manifest hash
- generated time
- included and excluded path scopes
- artifact refs
- trust flags: local-only, AI/API-backed, stale, partial, skipped, unavailable

## Project Atlas Role

Graphify is a strong fit for Foreman's Atlas concept because it builds a project map across code, docs, schemas, configs, and other assets, then exposes graph/query outputs. For Foreman, that makes it a source-investigation accelerator.

Use the Atlas to:

- find likely source quadrants before broad file reads
- discover cross-file and cross-layer relationships
- identify god nodes, hidden seams, and surprising dependencies
- help `spec_man` generate a machine-readable project map
- help `lighttask` decide whether a plan is stale, partial, or missing a quadrant
- help `doc_man` produce architecture and data-flow docs from grounded inputs
- help resume flows avoid rereading the whole repository

Do not use the Atlas to:

- declare intended behavior
- replace direct file, contract, test, or log evidence
- overwrite Foreman plans automatically
- approve a stale spec
- make implementation claims without direct grounding
- become a mandatory dependency for all Foreman users

## LangGraph Runtime Role

LangGraph is a control-plane candidate, not a knowledge-base candidate. It should own runtime coordination only when Foreman workflows become stateful enough to justify it.

Use LangGraph to coordinate:

- current phase and resume cursor
- worker fan-out and merge state
- gate ordering
- user waits and approvals
- advisor rejection routing
- timeout and tool-failure recovery
- bounded retries
- state snapshots that point to Foreman artifacts
- execution traces for audit and replay

Do not use LangGraph to own:

- full specs
- full code context
- full logs
- canonical ledger state
- canonical progress state
- canonical journal entries
- canonical advisor findings
- final correctness

Graph success is execution success only. Correctness still requires Foreman gates, tests, advisor review, and accepted evidence.

## Start and Resume Flow

### Classic Start

```text
activate protocol
  -> classify workspace
  -> read git context if available
  -> inspect existing spec_man output
  -> inspect Atlas status if present
  -> produce grounding report
  -> build or revise plan
  -> user accepts plan
  -> execute classic Foreman flow
```

### Classic Resume

```text
session_orient
  -> read ledger/progress/journal
  -> compare current repo context to recorded spec context
  -> inspect Atlas freshness if present
  -> if stale or partial, invoke spec_man re-evaluation
  -> show plan delta to user
  -> continue only after user accepts the revised path or bypasses with waiver
```

### LangGraph Resume

```text
session_orient
  -> runtime_orient
  -> read Foreman artifacts
  -> read LangGraph checkpoint
  -> inspect repo and Atlas freshness
  -> reconcile states
  -> if aligned, resume from graph cursor
  -> if stale, run spec_man re-evaluation
  -> if graph conflicts with Foreman artifacts, Foreman wins
  -> if checkpoint is missing or corrupt, fall back to classic resume
```

### LangGraph Runtime Re-evaluation Route

```text
orient
  -> atlas_staleness_check
  -> operator_refresh_gate
  -> run_or_skip_atlas
  -> spec_man_reeval
  -> operator_plan_delta_gate
  -> resume_or_replan
  -> implementation/review/test
```

## Re-evaluation Policy

Trigger `spec_man` re-evaluation when any of these are true:

- current branch or commit differs from the spec metadata
- worktree dirty state touches files relevant to the plan
- cited evidence files moved, changed, or disappeared
- Atlas output is older than relevant source, docs, schemas, configs, or contracts
- the requested task targets an uncovered Atlas quadrant
- LangGraph checkpoint phase disagrees with ledger/progress
- advisor findings or tests invalidate the current plan
- user asks to refresh the knowledge base

Re-evaluation output classification:

| Status | Meaning | Required action |
|---|---|---|
| `current` | Plan still matches repo and evidence | Continue |
| `needs_patch` | Plan is mostly valid but needs scoped edits | Show delta and request acceptance |
| `blocked` | Required evidence, credentials, branch, or decision is missing | Stop and ask |
| `superseded` | Plan no longer fits current repo or intent | Generate revised plan and request acceptance |

Only material deltas require user approval. A material delta changes acceptance criteria, public/user-visible behavior, API contracts, data contracts, security boundaries, migration/rollout behavior, test strategy, touched subsystem scope, or risk posture. Non-material evidence refreshes can be logged and continued.

## Plan Delta Ladder

Use the Plan Delta Ladder to keep re-evaluation cyclical without dragging every raw inconsistency through the active context.

```text
D3 raw findings
  -> D2 grouped deltas
  -> D1 candidate plan delta
  -> D0 current accepted plan
```

| Ring | Owner | Contents | Review Gate |
|---|---|---|---|
| `D3 raw` | Surface reviewers, advisors, Atlas checks | Raw inconsistencies, stale facts, missing evidence, objections, and direct-read findings. | Dedupe and evidence tagging. |
| `D2 grouped` | Foreman/spec_man merge | Logical groups by behavior, contract, subsystem, risk, or acceptance criterion. | Each group needs a resolution, blocker, or explicit rejection. |
| `D1 candidate` | Foreman/spec_man | Minimal coherent plan delta proposed for review. | Advisor/subagent correctness review and materiality check. |
| `D0 current` | User-accepted Foreman plan | Active plan used for implementation. | User acceptance when material changes exist. |

`D2` grouping rule:

Group by implementation action surface when possible, not only by conceptual root cause. Keep stale tests, config or feature flags, migrations, external contracts, and legacy helpers separate when they require separate edits, owners, or approvals. `D1` must name every `D2` group it resolves or defers.

This should reduce context pollution:

- subagents produce sealed `D3` reports
- the pitboss/spec-man merge compresses `D3` into `D2`
- only the `D1` candidate is shown for approval
- after promotion to `D0`, lower rings are archived as refs, not carried as full text

LangGraph can later route this cycle:

```text
surface_fanout
  -> d3_collect
  -> d2_group
  -> d1_review
  -> operator_delta_gate
  -> d0_promote
```

Graphify's role is to help identify surfaces and seed `D3`. It does not promote rings.

## State Ownership

| Area | Owner | Notes |
|---|---|---|
| Intended behavior | `spec_man` and accepted user input | Atlas can provide observed evidence only |
| Implementation plan | Foreman plan artifacts | LangGraph can route plan steps, not redefine them |
| Repo map | Atlas provider | Must include freshness metadata and refs |
| Runtime cursor | LangGraph when enabled, otherwise Foreman progress | Must reconcile against Foreman artifacts |
| Unit status | Foreman ledger/progress | Graph stores compact mirrors only |
| Test truth | Test output artifacts | Graph stores refs only |
| Advisor truth | Advisor review artifacts | Graph stores refs and routing decisions |
| User approvals | Foreman journal/decision log | Graph wait state can point to approval refs |

## Proposed Implementation Phases

### Phase 0: Protocol Policy

Status: started.

Scope:

- encode Atlas rules in `spec_man`
- encode Atlas refresh and re-evaluation in `lighttask`
- document that Graphify is optional
- add tests that pin the protocol text

Exit criteria:

- tests pass
- no production dependency added
- no auto-install behavior

### Phase 1: Atlas Dojo

Scope:

- create `Test_dojo/graphify-foreman-atlas/`
- run Graphify against a small target repo first
- run one larger source-heavy target second
- collect `graphify-out/graph.json`, query/path outputs, and `GRAPH_REPORT.md` when available
- compare `spec_man` with and without Atlas inputs

Validation questions:

- did Atlas reduce broad file reading?
- did it find useful cross-file relationships?
- did it hallucinate or over-infer?
- did direct evidence confirm its claims?
- did generated outputs stay compact enough for Foreman use?

Exit criteria:

- Atlas improves source discovery on at least one nontrivial task
- every Atlas-derived claim is either directly verified or marked `[UNVERIFIED]`
- no hooks or persistent assistant instructions are installed by default

### Phase 2: Atlas Adapter Contract

Scope:

- add a small Foreman-side adapter contract for Atlas status
- prefer file inspection and CLI detection over a package dependency
- define output refs and freshness metadata
- keep Graphify invocation user-approved
- support missing Graphify by falling back to direct grounding

Possible future tools:

- `atlas_status`
- `atlas_refresh`
- `atlas_query`

Do not add these until the dojo proves the adapter is worth a stable MCP surface.

Exit criteria:

- adapter can report absent, available, stale, refreshed, skipped, or unavailable
- adapter does not store full graph payloads in Foreman state
- adapter works in non-git folders without prompting for git initialization

### Phase 3: Reorientation Upgrade

Scope:

- extend `session_orient` output or add `runtime_orient`
- compare Foreman artifacts, git context, Atlas freshness, and optional LangGraph state
- produce a clear resume recommendation
- invoke `spec_man` re-evaluation when stale context is detected

Reconciliation rule:

```text
Foreman artifacts win over LangGraph state.
Direct evidence wins over Atlas evidence.
User accepted decisions win over inferred decisions.
Missing runtime state falls back to classic Foreman resume.
```

Exit criteria:

- stale spec/Atlas/repo context is detected
- user can bypass with visible waiver
- reorientation never mutates files without approval

### Phase 4: LangGraph Runtime Adapter

Scope:

- define a Foreman runtime model independent of LangGraph
- implement classic runtime as the default executor
- implement LangGraph as an optional executor behind an explicit flag
- keep node state compact and ref-based
- wire a real checkpointer and interrupt-based waits

Minimum graph state:

- run id
- workflow mode
- current phase
- phase history
- Foreman artifact refs
- worker assignments and statuses
- gate states
- pending waits
- retry log
- failure log
- recovery actions
- decision log
- evidence refs
- resume cursor
- final status

Exit criteria:

- graph runtime can resume a real interrupted flow
- graph state can be inspected without reading full source artifacts
- graph state does not duplicate canonical Foreman payloads
- classic runtime can run the same workflow without LangGraph

### Phase 5: Live Runtime Dojo

Scope:

- replace simulated LangGraph nodes with real Foreman MCP calls or adapters
- inject controlled failures:
  - worker timeout
  - advisor rejection
  - tool failure
  - stale Atlas or spec
- compare classic runtime and graph runtime

Success criteria:

- graph runtime recovers with fewer manual reconstruction steps
- graph runtime preserves resume state across a session break
- graph trace explains failures, retries, waits, and evidence refs
- final correctness matches or exceeds classic runtime
- added ceremony is acceptable only for trigger-qualified work

Failure criteria:

- graph only records stage completion
- graph state conflicts with Foreman artifacts
- graph makes debugging harder
- graph encourages agents to trust state instead of evidence
- graph becomes necessary to understand Foreman artifacts

### Phase 6: Release Gate

Scope:

- decide whether Atlas support remains protocol-only or becomes MCP tools
- decide whether LangGraph runtime remains experimental or ships behind an optional flag
- document trigger policy and fallback behavior
- keep default behavior classic

Release bar:

- no mandatory Graphify dependency
- no mandatory LangGraph dependency for classic users
- no auto-install
- no automatic branch switch
- no automatic git init
- no Graphify hooks by default
- CI passes on a clean install
- all new state has tests for stale/missing/conflicting cases

## Trigger Policy

Use Atlas when:

- repo is unfamiliar or large
- source investigation spans multiple quadrants
- docs/specs/archive content is part of the task
- direct file reads would be broad and unfocused
- plan freshness is uncertain
- user asks to refresh the knowledge base

Skip Atlas when:

- task is a one-file edit
- relevant files are already known
- user wants speed over map quality
- Graphify is unavailable and installation is not approved
- privacy rules prevent semantic extraction

Use LangGraph when:

- work spans multiple sessions
- worker fan-out exists
- human waits or approvals exist
- advisor gates can reject and route fixes
- retries/recovery branches are expected
- auditability and resume reliability matter

Skip LangGraph when:

- task is small and linear
- no fan-out, wait, retry, or gate routing exists
- graph would only record stage completion
- user prefers minimal ceremony

## Pressure Test

### Risk: Atlas Becomes False Authority

Failure mode:

An agent reads the graph report and writes requirements from inferred relationships.

Mitigation:

- require direct evidence for every requirement
- classify Atlas sources as discovery or project_atlas
- record mismatches when Atlas and direct evidence disagree
- keep `spec_man` responsible for interpretation

### Risk: Atlas Staleness

Failure mode:

`graphify-out/` is older than changed source or docs, so resume uses stale navigation.

Mitigation:

- compare Atlas mtimes and metadata to git status and cited evidence
- track provider version, command, included/excluded paths, branch, commit, and dirty-state hash
- mark Atlas state as stale, partial, or unknown
- offer refresh before planning
- allow bypass only with `[UNVERIFIED]` claims

### Risk: Privacy and Backend Leakage

Failure mode:

Docs, PDFs, images, audio, or semantic extraction may leave the machine through an AI backend.

Mitigation:

- ask before AI/API-backed extraction
- prefer local code/schema extraction
- prefer `graphify update <path> --no-cluster` for a local code graph
- record backend and scope
- support direct grounding fallback

### Risk: Local Atlas Is Code-Only

Failure mode:

The safe no-LLM Graphify path maps code relationships but does not understand policy docs, OpenAPI, SQL, or prose-level requirements.

Mitigation:

- record Atlas coverage as partial when only AST extraction is used
- direct-read docs, contracts, schemas, and SQL before writing specs
- require explicit approval before semantic extraction
- consider a Foreman-side merger that stores refs from Graphify plus direct doc/API/SQL evidence

### Risk: Toolchain Drag

Failure mode:

Python, uv, corporate CA certs, proxy, and package version drift make Graphify setup brittle.

Mitigation:

- do not make Graphify required
- detect installed CLI first
- install only by user request
- document proxy/CA env vars separately
- keep Foreman tests independent of Graphify installation

### Risk: Duplicate Runtime Truth

Failure mode:

LangGraph checkpoint says one phase, Foreman progress says another.

Mitigation:

- Foreman artifacts win
- reconciliation writes a decision log
- graph resumes only when aligned
- conflicting graph state routes to repair or classic fallback

### Risk: Interrupt Replay Side Effects

Failure mode:

LangGraph resumes after an interrupt and repeats a non-idempotent side effect.

Mitigation:

- use durable checkpointer
- keep side effects idempotent or behind Foreman gates
- record side-effect completion refs before interrupts
- test resume after every wait type

### Risk: Ceremony Overload

Failure mode:

Small tasks get slowed by Atlas generation and graph runtime setup.

Mitigation:

- default classic runtime
- trigger-based escalation
- `lighttask` stays compact
- skip Atlas and LangGraph when direct grounding is enough

### Risk: Approval Loops

Failure mode:

The system asks for user approval after every minor repo or Atlas change.

Mitigation:

- require approval only for material plan deltas
- log non-material evidence refreshes without stopping
- let the user bypass stale Atlas checks with visible `[UNVERIFIED]` markings
- keep the resume summary focused on changed decisions, not raw file churn

### Risk: Hook and Assistant Instruction Pollution

Failure mode:

Graphify installs assistant hooks or always-on project instructions that conflict with Foreman.

Mitigation:

- do not run `graphify install`, `graphify hook install`, or assistant-specific installs by default
- use Graphify CLI outputs as evidence refs
- keep Foreman instructions authoritative for workflow behavior

## Open Decisions

| Decision | Options | Recommendation |
|---|---|---|
| Atlas MCP tools | protocol-only, adapter library, MCP tools | Start protocol-only, then dojo |
| Graphify output location | `graphify-out/`, `.foreman/atlas/`, configurable | Start with Graphify default, store refs |
| Commit Atlas outputs | commit, ignore, repo-specific | Leave repo-specific; do not mandate |
| LangGraph dependency | prod dep, optional dep, experiment-only | optional/adapter only after live dojo |
| Runtime flag | CLI flag, env var, MCP arg | explicit runtime flag plus classic default |
| Reorient tool | extend `session_orient`, add `runtime_orient` | add `runtime_orient` only when runtime adapter exists |

## Next Concrete Step

Build the Atlas Dojo before adding runtime code:

```text
Test_dojo/graphify-foreman-atlas/
```

The dojo should test whether Graphify materially improves `spec_man` source investigation and stale-plan re-evaluation. If it does not, Foreman should keep Atlas as a protocol-level option and avoid adding MCP tools.

After that, continue the LangGraph live-runtime dojo with real Foreman calls and durable interrupts.
