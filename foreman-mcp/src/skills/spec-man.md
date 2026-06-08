---
name: foreman:spec-man
version: 0.0.1
description: Produces focused intended-behavior specifications and machine specs from user intent, requirements, tickets, existing specs, code evidence, contracts, discovery output, or external documentation.
---

# Spec-man

Produce authoritative intended-behavior specifications.

A spec is not documentation of whatever the code currently does. A spec defines what the system or feature is supposed to do, what it must not do, and what constraints must hold. It gives implementers, reviewers, testers, documentation agents, and future agents a stable target.

## Core Contract

Specs must be:

- technical
- concise
- testable
- grounded
- implementation-ready
- explicit about unknowns
- free of marketing language
- free of filler

Every requirement must be backed by supplied context or marked unresolved.

Use direct language. Do not write an essay. Do not add audience sections, executive summaries, background sections, or motivational prose unless the user asks for them.

## Source Priority

Use sources in this order:

1. Direct user instructions in the current task
2. Existing `spec-man` output
3. Product requirements, tickets, issues, design notes, customer constraints, or stakeholder notes
4. Existing API specs, schemas, contracts, and acceptance tests
5. Existing project documentation
6. Discovery output such as code maps, project atlases, or state exploration
7. Source code, configuration, deployment manifests, logs, and command output
8. External public documentation for third-party APIs, platforms, standards, and dependencies

User intent defines target behavior. Implementation evidence can constrain the spec, reveal existing behavior, and expose compatibility risk, but it does not automatically define intended behavior.

If the user asks to spec an existing system as implemented, label the output as an implementation spec. If the user asks to spec planned work, label the output as a target spec.

## Project Atlas Integration

A project atlas is a generated map of the repository, docs, schemas, configs, and dependency seams. Graphify is the preferred atlas provider when it is installed or `graphify-out/` already exists.

Use the atlas to choose quadrants, find likely evidence, discover cross-file relationships, and detect stale coverage. Do not treat the atlas as authoritative truth. Every requirement still needs direct evidence from user context, specs, source files, contracts, tests, logs, or command output.

Atlas provider rules:

- `graphify-out/GRAPH_REPORT.md` is an optional human navigation report when report generation succeeds.
- `graphify-out/graph.json` is machine-readable atlas evidence.
- `graphify-out/graph.html` is optional visualization evidence.
- `.graphifyignore` controls atlas scope when present.
- `graphify query`, `graphify path`, and `graphify explain` may guide targeted reads.
- `graphify update <path> --no-cluster` is the preferred local code-graph refresh because it avoids LLM-backed semantic extraction.
- `graphify <path>` or `graphify extract <path>` may invoke semantic extraction through a configured AI backend and requires explicit approval.

Trigger atlas discovery or refresh when:

- the user asks for a repo map, galaxy map, source investigation, or knowledge base refresh
- a task starts or resumes after the repo branch, commit, dirty state, or relevant files changed
- existing `spec-man` output is stale, partial, missing cited evidence, or lacks the requested quadrant
- the requested work spans multiple subsystems, data contracts, APIs, migrations, queues, auth boundaries, or docs archives
- direct reading would require broad repo traversal before the relevant files are known

Before generating or updating an atlas:

- check whether `graphify` is available on PATH
- check whether `graphify-out/graph.json` or `graphify-out/GRAPH_REPORT.md` already exists
- ask before installing Graphify, creating a new atlas, updating `graphify-out/`, or invoking an AI/API-backed extraction
- prefer local code/schema extraction when possible
- record whether docs, PDFs, images, audio, video, or semantic extraction may leave the machine through an AI backend

Store atlas output as evidence references, not copied payloads. If the atlas and direct evidence disagree, direct evidence wins and the mismatch must be recorded.

## Re-evaluation Flow

Use re-evaluation mode when an existing Foreman plan, lighttask plan, implementation spec, or machine spec may no longer match the current repo.

Re-evaluation steps:

1. Read the current repo context, existing spec-man output, plan artifacts, and available atlas refs.
2. If the atlas is stale or missing for the requested quadrant, offer an atlas refresh. If the user skips it, continue with direct grounding and mark atlas coverage `[UNVERIFIED]`.
3. Compare the refreshed or existing atlas against direct reads of the files, contracts, tests, and docs that affect the plan.
4. Classify the existing plan as `current`, `needs_patch`, `blocked`, or `superseded`.
5. If material inconsistencies exist, run the Plan Delta Ladder before changing the active plan.
6. If the promoted plan needs material changes, present the delta and ask the user to accept the revised plan before implementation continues.

The atlas can trigger re-evaluation. It cannot approve the revised plan.

## Plan Delta Ladder

Use the Plan Delta Ladder when re-evaluation finds inconsistencies across code, docs, specs, tests, APIs, data, deployment, or runtime behavior.

The ladder reduces context drag by compressing raw findings into successively smaller review artifacts:

| Ring | Name | Purpose | Promotion rule |
|---|---|---|---|
| `D3` | Raw deltas | Individual inconsistencies, stale facts, missing evidence, reviewer objections, and surface-level findings. | Promote only after dedupe and evidence tagging. |
| `D2` | Delta groups | Related inconsistencies grouped by subsystem, contract, behavior, risk, or acceptance criterion. | Promote only when each group has a proposed resolution or explicit blocker. |
| `D1` | Candidate plan delta | Minimal coherent change set that updates the plan without carrying raw noise forward. | Promote only after advisor or subagent review checks correctness and missing interactions. |
| `D0` | Current plan | Accepted plan state used for implementation. | Promote only after user acceptance when material behavior, contracts, risk, or scope changes. |

Rules:

- Keep raw `D3` findings sealed by source surface when possible.
- Merge duplicate or overlapping `D3` findings before creating `D2` groups.
- Do not promote a `D2` group if it lacks evidence refs or has unresolved contradictions.
- Prefer `D2` groups that map to implementation action surfaces, not only conceptual root causes.
- Preserve stale tests as their own `D2` group when tests encode old behavior.
- Preserve config, feature flags, migrations, contracts, and legacy helpers as separate `D2` groups when they require separate edits or approvals.
- A `D2` group should be small enough that a worker could own it without rereading all raw `D3` findings.
- Do not promote `D1` to `D0` if material changes lack user approval.
- `D1` must name each `D2` group it resolves or explicitly defers.
- Once `D0` is accepted, archive lower rings as evidence refs and stop carrying their full text in the active context.
- If later evidence contradicts `D0`, start a new ladder instead of mutating the old rings.

Material changes include acceptance criteria, user-visible behavior, public API contracts, data contracts, security boundaries, migrations, rollout behavior, test strategy, touched subsystem scope, or risk posture.

Non-material evidence refreshes may be logged and promoted without stopping for approval.

## Output Discovery Markers

Human spec files include this marker near the top:

```markdown
<!-- spec-man:v1 -->
```

Machine specs include:

```json
{
  "schema": "spec-man.machine.v1"
}
```

Default paths:

```text
docs/spec/SPEC.md
docs/spec/API.md
docs/spec/DATA_CONTRACTS.md
docs/spec/ACCEPTANCE.md
docs/spec/spec.machine.json
```

Use a narrower path when scoped to one subsystem or feature:

```text
docs/spec/<feature-or-subsystem>/SPEC.md
docs/spec/<feature-or-subsystem>/spec.machine.json
```

Match the repo's existing docs directory casing.

## Grounding Rule

For every requirement or claim, classify the source:

| Tag | Meaning |
|---|---|
| `[SPECIFIED]` | From user intent, ticket, requirement, design note, or existing spec. |
| `[OBSERVED]` | From code, config, tests, logs, docs, or discovery output. |
| `[EXTERNAL]` | From public documentation for a dependency, API, platform, or standard. |
| `[ASSUMPTION]` | Explicit assumption made to continue. |
| `[UNRESOLVED]` | Missing fact that must be answered. |

Use evidence references when available:

```markdown
Evidence: `<file:line>`, `<command>`, `<ticket/ref>`, `<spec ref>`, `<external doc ref>`
```

If no evidence exists, mark the item `[UNRESOLVED]`.

## Requirement Language

- `MUST` means required for correctness or acceptance.
- `MUST NOT` means prohibited behavior.
- `SHOULD` means expected unless a documented exception applies.
- `MAY` means optional behavior.

Only use uppercase requirement words for testable or reviewable requirements.

## Machine Spec Mode

Use machine spec mode for agents, code generators, validators, project atlases, or machine-to-machine handoff.

Output valid JSON only unless the user asks for YAML.

Default schema:

```json
{
  "schema": "spec-man.machine.v1",
  "spec_id": "",
  "status": "draft|ready-for-implementation|implemented|superseded",
  "mode": "feature|technical|api|data_contract|behavior|state_machine|implementation",
  "repo": {
    "is_git": false,
    "git_tracking": "detected|initialized|skipped|unavailable",
    "root": "",
    "branch": "",
    "commit": "",
    "dirty": false,
    "upstream": "",
    "generated_at": ""
  },
  "atlas": {
    "provider": "none|graphify|other",
    "status": "absent|available|generated|refreshed|stale|skipped|unavailable",
    "root": "",
    "generated_at": "",
    "graph_ref": "",
    "report_ref": "",
    "query_refs": [],
    "coverage": {
      "state": "current|partial|stale|unknown",
      "covered_quadrants": [],
      "uncovered_quadrants": [],
      "staleness_reasons": []
    }
  },
  "sources": [
    {
      "id": "source.001",
      "type": "user_context|ticket|existing_spec|code|discovery|project_atlas|external_doc|command_output",
      "ref": "",
      "trust": "high|medium|low",
      "notes": ""
    }
  ],
  "scope": {
    "in": [],
    "out": [],
    "assumptions": [],
    "unresolved": []
  },
  "plan_delta": {
    "status": "none|d3_raw|d2_grouped|d1_candidate|d0_current",
    "reevaluation_status": "current|needs_patch|blocked|superseded|unknown",
    "material_delta": false,
    "approval_required": false,
    "rings": {
      "d3_raw": [],
      "d2_groups": [],
      "d1_candidate": {},
      "d0_current_ref": ""
    },
    "promotion_log": []
  },
  "requirements": [
    {
      "id": "R001",
      "text": "",
      "priority": "must|should|may",
      "source_ids": [],
      "verification": "",
      "status": "specified|observed|assumed|unresolved"
    }
  ],
  "interfaces": [],
  "data_contracts": [],
  "state_machines": [],
  "acceptance_criteria": [],
  "risks": [],
  "mismatches": [],
  "open_questions": []
}
```

Include repo context when available so planners can detect stale specs, branch mismatches, and missing git provenance.

## Feature Spec Mode

Use this for new behavior, behavior changes, or feature planning.

Default structure:

```markdown
<!-- spec-man:v1 -->

# <Feature Name> Spec

## Status

<draft|ready-for-implementation|implemented|superseded>

## Problem

<The concrete problem this feature solves. One short paragraph.>

## Target Behavior

- <Requirement or behavior>

## Non-goals

- <Explicitly excluded behavior>

## User-visible Behavior

| Case | Input / action | Expected result |
|---|---|---|

## System Behavior

| ID | Requirement | Source | Verification |
|---|---|---|---|

## Data Contract

| Field | Type | Required | Source | Notes |
|---|---|---:|---|---|

## Interfaces

| Interface | Method / event | Input | Output | Errors |
|---|---|---|---|---|

## Acceptance Criteria

| ID | Criterion | Verification |
|---|---|---|

## Risks and Constraints

- <risk or constraint>

## Open Questions

- [UNRESOLVED] <specific question>
```

## Technical Spec Mode

Use this for implementation-ready engineering specs.

Required sections:

- status
- scope
- requirements table with IDs
- proposed design
- components
- data flow
- state changes
- API and contracts
- failure behavior
- security and trust boundaries
- migration and rollout
- acceptance criteria
- open questions

Every requirement row must include priority, source, and verification.

## API Spec Mode

Use this for HTTP APIs, RPC APIs, events, CLIs, SDK interfaces, and service contracts.

For HTTP APIs, prefer OpenAPI when enough information exists. If not enough information exists, write contract tables and mark gaps.

Required sections:

- base path or protocol
- authentication
- endpoints or operations
- schemas
- error model
- compatibility

## Data Contract Mode

Use this for database records, events, messages, files, JSON payloads, CSVs, object storage payloads, queue messages, and cross-service contracts.

Required sections:

- owner
- schema
- producers
- consumers
- compatibility rules
- examples when they remove ambiguity

Generate JSON Schema when machine validation is needed.

## Behavior and State Spec Mode

Use this for lifecycle-heavy features, jobs, workflows, approvals, sync engines, reconciliation loops, status fields, and retry systems.

Required sections:

- states
- transitions
- state diagram when useful
- invariants
- failure behavior

## Mismatch Handling

When implementation evidence conflicts with intended behavior, preserve both.

Human format:

```markdown
[OBSERVED] <what the implementation currently does>
Evidence: `<file:line>` or `<discovery ref>`

[SPECIFIED] <what the intended behavior says>
Evidence: `<spec/user/ticket ref>`

[MISMATCH] <short statement of the difference>
```

Machine format:

```json
{
  "id": "mismatch.001",
  "type": "implementation_target_mismatch",
  "specified_behavior": "",
  "observed_behavior": "",
  "impact": "low|medium|high|unknown",
  "specified_evidence": [],
  "observed_evidence": [],
  "resolution_status": "open|accepted|fixed|deferred"
}
```

Do not assume the code is wrong. Do not assume the spec is current. Mark the conflict and continue.

## Style Rules

Use:

- concrete names
- stable IDs
- tables for requirements and contracts
- Mermaid only when it clarifies state, sequence, or architecture
- examples only when they remove ambiguity
- direct requirements
- short sections

Avoid:

- marketing language
- vague claims
- broad promises
- background essays
- audience sections
- summary sections
- decorative prose
- em dashes
- emojis
- fake certainty
- generic LLM phrasing

## Workflow

1. Identify the requested spec mode.
2. Extract intended behavior and constraints.
3. Separate intended behavior from observed implementation.
4. Assign stable IDs.
5. Define interfaces, data contracts, state, failure behavior, and acceptance criteria.
6. Mark unresolved facts.
7. Remove prose that does not affect implementation, testing, or review.
8. Output the requested spec file or machine JSON.

## Done When

The spec gives downstream work enough information to:

- implement target behavior
- test target behavior
- review compatibility and risk
- generate user or system documentation through `doc_man`
- identify unresolved decisions without guessing

Stop at specification. Do not implement unless the user explicitly asks.
