# Security Policy

Foreman is an MCP server that enforces engineering discipline protocols (package `foreman-mcp`).

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.5.x   | ✅        |
| < 0.5   | ❌        |

Security fixes land on the latest minor release only; users on older versions should upgrade.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.**

Report vulnerabilities through GitHub **private vulnerability reporting** on this repository: [https://github.com/malindarathnayake/Foreman/security/advisories/new](https://github.com/malindarathnayake/Foreman/security/advisories/new). This repository is the canonical home of Foreman (not a fork) — reports filed here reach the maintainer directly.

When reporting, please include:

- Vulnerability type
- Affected file/path
- Reproduction steps
- Proof of concept, if available
- Impact assessment

## What to Expect

Foreman is a single-maintainer project. The following are best-effort targets, not a security team SLA:

- **Acknowledgment:** within 72 hours.
- **Assessment/severity triage:** within 7 days.
- **Fix:** critical/high issues target a patched release within 14 days of triage; medium/low severity issues are batched into the next scheduled release.
- **Credit:** reporters are credited in the published advisory with their permission.

## Scope

**In scope:**

- The `foreman-mcp` npm package (MCP server, tools, skills)
- The bundled vendored `context-crush` fork under `foreman-mcp/vendor/` — report vulnerabilities here, NOT to upstream headroom, since our fork diverges (see `foreman-mcp/vendor/context-crush/SYNC.md`)
- The repository's GitHub Actions workflows
- The published package artifacts

**Out of scope:**

- Vulnerabilities in the advisor CLIs themselves (Codex CLI, Gemini CLI) — report upstream
- MCP host applications (Claude Code, Cursor, etc.) — report to their vendors
- Vulnerabilities in third-party dependencies without a Foreman-specific exploitation path — report upstream; we track advisories via `npm audit`/Dependabot
- Social engineering
- Issues requiring an already-compromised local machine

## Delegation & Redaction Boundary

<!-- foreman:d1-boundary — this section is intentionally deferred to v0.5.0
     unit 4h: it documents the S7 worker-delegation redaction behavior and must
     be written AFTER that behavior ships, so the statement describes the code
     as-built rather than as-planned. Do not fill it in before then. -->

*This section is completed in a later v0.5.0 change (unit 4h), after the
delegation redaction layer it documents has shipped.*
