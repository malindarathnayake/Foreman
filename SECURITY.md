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

Foreman polices exactly two things: its own outbound calls, and its own durable artifacts. Everything else named below is out of scope by architecture, not by oversight.

**Outbound calls (the `invoke_worker` egress path).** Before a brief and its file contents leave this machine, an exact-value outbound gate checks the fully-serialized request against every secret value Foreman knows about — a match blocks the call before any network request is made. The first `invoke_worker` call in a running process prints a one-time notice naming the destination host, so routing is reviewable before repeated delegation. The API key itself never appears in a brief, a file, a return value, or the request body: `.foremanenv` names it only via `${ENV:NAME}` indirection, and the resolved value is confined to the outbound `Authorization` header.

**Durable artifacts (ledger, journal, progress JSON, the PROGRESS.md splice, events sidecar).** Every one of these write paths scrubs the same secret set before anything touches disk, replacing values with a loud, one-way, grep-able `[REDACTED:env:NAME]` marker — never a reversible placeholder, never a plausible fake value that could silently corrupt a patch. This applies uniformly across the ledger, the journal, `progress.json`, the PROGRESS.md splice, and the hash-chained `.foreman-events.jsonl` sidecar.

**Out of scope by architecture: the host's own model traffic.** Foreman is an MCP tool server, not a proxy. The host agent (Claude Code, Cursor, etc.) reads files and talks to its own LLM directly, and that traffic never passes through Foreman — Foreman cannot see it, filter it, or redact it. Whatever the host agent's own context window ends up holding is the host's and the operator's responsibility.

**Advisor CLI children (`invoke_advisor`).** A spawned Codex or Gemini CLI process inherits the full environment. This is a documented boundary, not a filtered one: stripping a child's environment would break that CLI's own authentication. The residual risk is stated honestly rather than hidden — a spawned CLI's own stderr/stdout could carry an environment value before it ever reaches Foreman. Foreman's scrub-on-write cleans what lands in a Foreman-owned artifact; it cannot clean the child process's own output ahead of that.

**File-only secrets are invisible to the gate.** The harvest reads the process environment, plus any key resolved through `.foremanenv`'s `${ENV:NAME}` indirection and explicitly registered with the redaction module. A secret that lives only in a file on disk — never exported to the environment — is unknown to both the scrub and the outbound gate.

**Transport posture.** Remote endpoints configured in `.foremanenv` should always be `https://`. `http://` is accepted — it exists for loopback/local inference servers and test mocks — but pointing a remote, non-loopback endpoint at plain HTTP is the operator's own risk; Foreman does not warn or block on it.

**`.foremanenv` protections.** The loader refuses to load a `.foremanenv` that is git-tracked, or one that exists but is not git-ignored, with the exact fix commands in the refusal message (`echo .foremanenv >> .gitignore`, plus `git rm --cached .foremanenv` if it was already tracked). Both refusals fail closed and are recorded as a `SEC_BLOCK` journal event.

Report issues in this boundary the same way as any other vulnerability — see "Reporting a Vulnerability" above.
