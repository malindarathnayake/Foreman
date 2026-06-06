---
name: foreman:doc-man
version: 0.0.1
description: Generates focused technical documentation from spec-man output, discovery output, source code, repo structure, implementation notes, existing docs, command output, or user context.
---

# Doc-man

Generate technical documentation that engineers and agents can use immediately.

This skill does not invent intended behavior. It documents from grounded inputs. It prefers `spec_man` for intended behavior and project discovery or atlas output for actual implementation behavior.

## Core Contract

Produce focused technical docs.

No marketing. No filler. No inflated prose. No audience sections. No executive summaries unless asked. No generic LLM phrasing. No em dashes. No decorative language. No fake certainty.

Write like an engineer documenting a system for another engineer.

## Source Priority

Before generating documentation, look for upstream outputs in this order:

1. `spec-man` output
2. project atlas, code-discovery, or state-explorer output
3. existing project documentation
4. source code and configuration
5. command output, logs, traces, manifests
6. user-provided context
7. external public documentation for dependencies, APIs, platforms, and standards

`spec-man` is the preferred source for intended behavior, requirements, constraints, interfaces, acceptance criteria, user-visible semantics, and target contracts.

Discovery output is the preferred source for actual implementation behavior, state transitions, data flows, side effects, trust boundaries, and operational reality.

When both exist:

- `spec-man` defines what the system is supposed to do.
- discovery defines what the system currently does.
- if they disagree, document the mismatch explicitly.

## Finding Spec-man Output

Look for `spec-man` output before drafting docs:

```text
docs/spec/SPEC.md
docs/spec/API.md
docs/spec/DATA_CONTRACTS.md
docs/spec/ACCEPTANCE.md
docs/spec/spec.machine.json
docs/spec/<feature-or-subsystem>/SPEC.md
docs/spec/<feature-or-subsystem>/spec.machine.json
```

Also accept `Docs/` variants when the repo uses uppercase docs.

Markers:

```markdown
<!-- spec-man:v1 -->
```

```json
{
  "schema": "spec-man.machine.v1"
}
```

If no `spec-man` output is found, continue only when implementation-grounded documentation is still useful. Add this notice near the top of generated human docs unless the user asks to omit it:

```markdown
> Spec source missing: no `spec-man` output was provided or found. This document is based on implementation evidence and available project context. Run `spec_man` first if intended behavior, acceptance criteria, or product constraints need to be authoritative.
```

Recommend `spec_man` first when the requested documentation depends on intended behavior, requirements, acceptance criteria, external interfaces, or user-visible semantics.

## Grounding Rule

Every factual claim must come from one of:

- `spec-man` output
- source code
- command output
- existing project docs
- dependency manifests
- deployment manifests
- API specs
- logs or traces
- project atlas or discovery output
- web documentation for external tools, standards, or public APIs
- `[UNVERIFIED]`

If documentation depends on facts not present in context, use:

```markdown
[UNVERIFIED] <claim>
[TODO: confirm <specific missing fact>]
[ASSUMPTION: <specific assumption and why it was made>]
```

Do not hide uncertainty.

## Mismatch Rule

If `spec-man` and implementation evidence disagree, preserve both facts.

Human format:

```markdown
[SPECIFIED] <what spec-man says should happen>
Evidence: `<spec-man ref>`

[IMPLEMENTED] <what the code currently does>
Evidence: `<file:line>` or `<discovery ref>`

[MISMATCH] <short statement of the difference>
```

Machine format:

```json
{
  "id": "mismatch.001",
  "type": "spec_implementation_mismatch",
  "specified_behavior": "",
  "implemented_behavior": "",
  "impact": "low|medium|high|unknown",
  "spec_evidence": [],
  "implementation_evidence": [],
  "resolution_status": "open|accepted|fixed|deferred"
}
```

Do not treat the implementation as wrong automatically. Do not treat the spec as current automatically.

## README Mode

Generate or update `README.md`.

Purpose:

- explain what the project is
- show current build, test, release, license, and runtime surface when known
- show how to install, configure, run, test, and operate it
- link to deeper docs when needed

Default structure:

```markdown
# <Project Name>

<One direct paragraph explaining what this project does. No hype.>

## Status

<Current maturity or operational status if known. Otherwise omit.>

## Features

- <Concrete implemented or specified capability>

## Architecture

<Short architecture explanation or link to docs/ARCHITECTURE.md.>

## Requirements

- <runtime>

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|

## Quick Start

```bash
<commands>
```

## Development

```bash
<install>
<test>
<lint>
```

## Testing

```bash
<test command>
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)

## License

<license if known>
```

Badge rules:

- Use badges only when true and backed by repo evidence.
- Prefer build, test, release, license, language, package version, coverage, and container image.
- Do not add fake passing badges, social badges, or promotional badges unless requested.

## Architecture Documentation Mode

Generate `docs/ARCHITECTURE.md`.

Required topics:

- system shape
- components and responsibilities
- runtime flow
- state ownership
- external dependencies
- trust boundaries
- deployment shape when known
- design constraints
- open questions

Do not create decorative diagrams. Label proposed architecture as proposed.

## Data-flow Documentation Mode

Generate `docs/DATAFLOW.md`.

Required topics:

- flow inventory
- ingress to egress steps
- transformations
- storage
- external calls
- failure and retry behavior
- drift risks

Use sequence diagrams for request flows, flowcharts for pipelines, and state diagrams for lifecycles.

## Mermaid Diagram Mode

Generate Mermaid code only unless the user asks for explanation.

Defaults:

- `flowchart LR` for architecture and components
- `flowchart TB` for deployment topology
- `sequenceDiagram` for request and data flows
- `stateDiagram-v2` for lifecycle transitions
- `classDiagram` only when object relationships matter
- `erDiagram` only when schema relationships are known

Rules:

- Keep node labels short.
- Use stable names from code, config, service names, tables, queues, and modules.
- Do not imply directionality unless known.
- Add comments for unknowns.

## Confluence Documentation Mode

Generate Confluence-ready Markdown.

Rules:

- Use simple headings.
- Use normal Markdown tables only when readable.
- Use fenced code blocks for config, commands, JSON, YAML, and Mermaid.
- Put Mermaid in a fenced code block unless the user confirms a Mermaid macro or app exists.
- Do not rely on collapsible sections, GitHub alerts, HTML badges, or GitHub-specific Markdown.
- Keep pages shorter than repo docs.

Default sections:

- purpose
- how it works
- architecture
- key components
- configuration
- operations
- failure modes
- open questions

## Machine Documentation Mode

Generate dense machine-to-machine documentation for agents, context packs, project atlases, or validators.

Output valid JSON only unless the user requests YAML.

Default schema:

```json
{
  "schema": "doc-man.machine.v1",
  "source_priority": [
    "spec-man",
    "project-atlas",
    "existing-docs",
    "source-code",
    "command-output",
    "user-context",
    "external-docs"
  ],
  "project": {
    "name": "",
    "repo": "",
    "language": [],
    "package_managers": [],
    "runtimes": [],
    "entrypoints": []
  },
  "spec_sources": [],
  "implementation_sources": [],
  "components": [],
  "flows": [],
  "state": [],
  "external_dependencies": [],
  "trust_boundaries": [],
  "mismatches": [],
  "diagrams": [],
  "open_questions": []
}
```

Machine mode rules:

- Prefer exact identifiers from code, specs, manifests, and contracts.
- Use `verification_status`.
- Use `evidence` arrays everywhere.
- Mermaid source must be escaped as a JSON string.
- Do not convert uncertainty into natural language.

## Style Rules

Use:

- short sections
- direct headings
- tables for reference material
- code blocks for commands and config
- numbered steps only for ordered procedures
- bullets only when order does not matter
- concrete names from code, specs, and config
- present tense for current behavior
- future tense only for proposed work

Avoid:

- marketing language
- vague claims
- motivational prose
- long introductions
- audience sections
- summary sections
- sections that repeat the title
- "in conclusion"
- "it is important to note"
- "designed to be"
- em dashes
- decorative emojis
- unverified badges
- broad claims about security, load, or performance unless proven

## Workflow

1. Identify requested doc type.
2. Look for `spec-man` output.
3. Look for project atlas or discovery output.
4. Extract only facts relevant to the requested doc.
5. Decide the minimum useful structure.
6. Draft the doc.
7. Check every claim against available evidence.
8. Mark gaps as `[UNVERIFIED]`, `[TODO]`, or `[ASSUMPTION]`.
9. Remove filler.
10. Remove sections that do not add value.
11. Validate Mermaid syntax where possible.
12. Return the final doc or write it to the requested path.

## File Naming Defaults

```text
README.md
docs/ARCHITECTURE.md
docs/DATAFLOW.md
docs/OPERATIONS.md
docs/CONFIGURATION.md
docs/SECURITY.md
docs/CONFLUENCE/<page-name>.md
docs/machine/project.context.json
```

## Done When

The doc lets a technical reader or downstream agent understand the relevant system area without asking:

- what it is
- how it runs
- what components exist
- what state exists
- how data moves
- where to change behavior
- what can break
- what remains unknown

Stop when the requested documentation is useful and grounded. Do not expand scope for polish.
