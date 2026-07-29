---
id: intro
title: What Foreman is
sidebar_label: What Foreman is
slug: /
description: A local, ledger-backed coding harness that carries a repository from clarified intent to gated, resumable completion.
---

# Foreman

**A spec-to-code harness for AI-assisted software development.**

Foreman is a local, ledger-backed coding harness that takes a real repository from clarified intent through design and executable specification to delegated implementation, recorded validation, and resumable completion.

A frontier model occupies the **pitboss** seat. It works with you on the design, converts approved decisions into bounded implementation units, delegates those units to workers, inspects and tests their output, rejects bad work, and closes phase gates. Foreman supplies the operating protocols, durable project state, and mechanical checks that keep that process coherent across models and sessions.

```text
intent / existing repository
            |
      design_partner
            |
      approved design
            |
       spec_generator
            |
 spec + handoff + tests + progress
            |
   pitboss_implementor
            |
 bounded unit -> worker -> inspect -> test -> review -> phase gate
            |                                      |
            +----------- ledger / journal ---------+
```

**Models generate code. Foreman controls the job.**

Foreman is not another general-purpose agent framework, and it does not replace your coding host, repository tools, or CI. It controls the development lifecycle across them.

| | |
|---|---|
| **Current release** | `v0.5.11` |
| **Package** | `@malindarathnayake/foreman-mcp` |
| **Runtime** | Node.js `>=22` |
| **License** | Apache-2.0 |

## Start here

1. **[Install](./getting-started/installation.md)** — GitHub Packages or an offline release tarball.
2. **[Configure an MCP host](./getting-started/configure-mcp-host.md)** — Claude Code, Cursor, Codex, or a generic host.
3. **[Start a project](./getting-started/start-a-project.md)** — pick one protocol per session.

Already installed? Point your MCP host at `foreman-mcp` with the right `--host` flag and call `session_orient`.

## Understand the design

- **[Not another agent framework](./concepts/not-another-agent-framework.md)** — why Foreman competes on control rather than autonomy, and what that costs you.
- **[What "coding harness" means](./concepts/coding-harness.md)** — the seats, and who owns which decision.
- **[The development lifecycle](./concepts/lifecycle.md)** — design, spec, delegate, inspect, gate.
- **[What Foreman enforces](./enforcement/what-foreman-enforces.md)** — the checks that are TypeScript rather than prompt text, and the honest boundary of what they prove.

## Forged in real development

Foreman grew out of delivering and maintaining real systems across **Java, Go, C#, C++, Python, and React**.

Those runs exposed the same failures repeatedly:

- a long session drifted away from the approved design
- a worker received too much context, solved the wrong problem, or timed out halfway through it
- the agent that wrote a defect reviewed and defended its own work
- "all tests pass" existed only as a sentence in chat
- a new session reconstructed implementation status from a compacted conversation
- cheaper models were asked to make project-level decisions they were not equipped to make

Foreman turns those failures into an explicit lifecycle. A frontier model is used where judgment matters. Bounded implementation can be delegated to smaller, local, or remote workers. Recorded verdicts, review findings, failures, and evidence explicitly written to Foreman state survive outside the context window. Raw test output remains the host's responsibility unless it is recorded.

In one real Java REST API delivery, Foreman carried an approved design into a seven-phase implementation. Reviews caught scope, validation-order, and database-filter defects. The run recovered from worker timeouts, reran focused Gradle validation, and resumed from recorded state instead of replaying chat history. That is the class of work Foreman exists to control.

Foreman's own releases are produced by this same pipeline: each version is carried through `design_partner`, `spec_generator`, and `pitboss_implementor`, and its design summary, implementation spec, handoff, progress record, and testing harness live under `docs/` in the working tree. Those are live working artifacts rather than published templates, so they are kept out of the published repository.
