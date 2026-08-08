<div align="center">

<img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman" width="800" />

# Foreman

_a spec-to-code harness for AI-assisted software development — design, delegate, verify, and gate real work in a real repository_

<p align="center">
  <a href="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml/badge.svg" alt="Build and Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22" /></a>
  <a href="https://malindarathnayake.github.io/Foreman/"><img src="https://img.shields.io/badge/docs-foreman-b45309.svg" alt="Documentation" /></a>
</p>

</div>

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

Foreman is not another general-purpose agent framework, and it does not replace your coding host, repository tools, or CI. It controls the development lifecycle across them. Discipline lives in TypeScript checks against durable on-disk state rather than in prompt text, so it cannot be compacted away: a unit cannot pass without a recorded delegation, a phase cannot close with an unverified unit, and three rejected attempts freeze the work until you override it.

# Get started

**Install** — Foreman requires Node.js 22 or newer.

```bash
npm install -g @malindarathnayake/foreman-mcp
foreman-mcp --version
```

Installing from GitHub Packages needs a `read:packages` token and a scoped `.npmrc`. The [release tarball](https://github.com/malindarathnayake/Foreman/releases/latest) installs fully offline with no registry authentication. Full instructions: **[Installation](https://malindarathnayake.github.io/Foreman/getting-started/installation)**.

**Point an MCP host at it** — Claude Code, Cursor, Codex, or any host meeting the capability contract.

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

Cursor and Codex need an explicit `--host` flag; Windows may need a `cmd /c` shim. See **[Configure an MCP host](https://malindarathnayake.github.io/Foreman/getting-started/configure-mcp-host)**.

**Run one protocol per session** — then call `session_orient` to pick up where the ledger left off.

```text
design_partner        new behavior, unclear requirements, architectural decisions
spec_generator        turn an approved design into implementation-ready documents
pitboss_implementor   multi-unit implementation from prepared specs
lighttask             a small, grounded change that can be completed directly
spec_man              recover intended behavior in an existing repository
doc_man               grounded technical documentation
```

See **[Start a project](https://malindarathnayake.github.io/Foreman/getting-started/start-a-project)**.

# Documentation

Full documentation lives at **[malindarathnayake.github.io/Foreman](https://malindarathnayake.github.io/Foreman/)**.

- [Not another agent framework](https://malindarathnayake.github.io/Foreman/concepts/not-another-agent-framework) — why Foreman competes on control instead of autonomy, and what that costs you
- [What "coding harness" means](https://malindarathnayake.github.io/Foreman/concepts/coding-harness) — the seats, and who owns which decision
- [The development lifecycle](https://malindarathnayake.github.io/Foreman/concepts/lifecycle) — design, spec, delegate, inspect, gate
- [What Foreman enforces](https://malindarathnayake.github.io/Foreman/enforcement/what-foreman-enforces) — the mechanical checks, and the honest boundary of what they prove
- [Advisor seats and deliberation](https://malindarathnayake.github.io/Foreman/execution/advisor-seats) — cross-vendor independent review
- [Tool surface](https://malindarathnayake.github.io/Foreman/reference/tool-surface) — every MCP tool, grouped by role
- [When to use it — and when to skip it](https://malindarathnayake.github.io/Foreman/concepts/when-to-use-it)

# Project

**Current release:** `v0.5.13` | **Package:** `@malindarathnayake/foreman-mcp` | **Runtime:** Node.js `>=22`

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md) — read before enabling external worker endpoints
- [Host capability contract](foreman-mcp/HOST-CONTRACT.md)
- [Machine-readable onboarding](llms.txt)
- [Development](https://malindarathnayake.github.io/Foreman/contributing/development)

# License

[Apache-2.0](LICENSE) Copyright 2026 Malinda Rathnayake
