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
  "sources": [
    {
      "id": "source.001",
      "type": "user_context|ticket|existing_spec|code|discovery|external_doc|command_output",
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
