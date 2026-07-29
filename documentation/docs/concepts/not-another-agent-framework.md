---
id: not-another-agent-framework
title: Not another agent framework
sidebar_label: Not another agent framework
description: Foreman competes on control and trust over the code that ships, not on autonomy.
---

# Not another agent framework

There are hundreds of multi-agent orchestrators, spec-driven development kits, and autonomous coding agents. Nearly all of them compete on the same axis: **more autonomy** — spawn more agents, run longer unattended, touch more of the repository per prompt.

Foreman competes on the opposite axis: **control and trust over the code that ships.** It exists for work where you need fine-grained control over what gets written and verifiable grounds for accepting it — not a longer leash for the model.

| Typical agent tooling | Foreman |
|---|---|
| Discipline lives in prompts and system messages, and decays with context compaction | Non-negotiables are TypeScript checks against durable state; they cannot be compacted away or rationalized past |
| The same agent writes, reviews, and accepts its own work | Writing, accepting, and reviewing are separate seats; a verdict without a recorded delegation is refused |
| "All tests pass" is a sentence in the transcript | A pass requires recorded delegation and evidence, or an explicit attestation; a gate goes stale when a unit changes under it |
| Progress state lives in the context window | State lives on disk in a validated ledger; a new session reconstructs reality from `session_orient`, not from a summary of a summary |
| Failure handling is retry-until-plausible | Three rejected attempts freeze the unit until a human explicitly overrides |
| Review findings are unverified prose | Advisor findings are normalized, classified, and their `file:line` citations mechanically verified before they are recorded |
| Autonomy is the product | The human owns intent, arbitration, and final authority; autonomy is granted only inside a bounded, evidenced unit |

This makes Foreman deliberately demanding. It asks you to approve designs, arbitrate recorded trade-offs, and own phase acceptance. If you want an agent that runs unattended overnight and hands you a diff to skim, Foreman is the wrong tool — that workflow is precisely the failure mode it was built to prevent. It is made for engineers who read the code, understand the state of their system, and need to trust *how* "done" was reached, not just that something was produced.

## No model lock-in

Because project state lives in the ledger rather than in any vendor's session memory, the pitboss seat is a replaceable slot. A project can be ground through its breadth phases by one frontier model under one host, then hand its hardest integration unit to a different vendor's model under a different host — the incoming model calls `session_orient`, receives the exact unit status, rejection history, and named open findings, and resumes mid-unit with no handoff document and no re-explanation. The same mechanism is what lets a smaller local model eventually occupy a worker or pitboss seat: the discipline lives in the harness, so the seat only has to code.

Model vendors are building in the opposite direction — memory features and persistent sessions that make their model the place your project state lives. Foreman keeps that state in files no vendor owns.

## Auditable down to the bottom

A harness whose product is trust must itself be inspectable. All of Foreman's state — ledger, progress, journal, events — is JSON and Markdown inside your repository: you can `git diff` a verdict, grep the session history, and read every protocol as plain bundled Markdown. There is no web console, no dashboard, and no service between you and your project's record. The enforcement layer itself is small TypeScript with two production dependencies, readable in an afternoon. Nothing about how "done" was reached is stored anywhere you cannot open in an editor.

## Lean by composing the host

Foreman does not bundle a second version-control system, shell, compiler, or provider runtime. It composes the tools already available in the development environment: the host's native agent/worker primitives; installed Claude, Codex, Gemini, or Aider CLIs when configured; allowlisted repository test runners; and Git for base-commit capture, tracked-file cleanliness checks, detached worker worktrees, bounded diffs, and cleanup. That keeps Foreman focused on coordination, evidence, and gates instead of duplicating mature execution engines.

The `aider_worker` path does **not** execute `git stash`. It records base-file hashes, refuses untracked or dirty delegated files before creating an isolated detached worktree, captures only the bounded worker diff, and tears the worktree down after validation. Current refusal messages may tell the operator to commit or stash the affected files, but that remains an operator-controlled Git action. Crash recovery can reclaim Foreman-named orphan worktrees and prune Git metadata; neither mechanism is advertised as a backup or as a guarantee that arbitrary user edits can be restored. Keep normal commits and backups for that job.

Host-native workers have a different boundary: the host, not the MCP server, enforces their filesystem isolation. Foreman's host contract requires a worktree per concurrent seat, forbids crossing seats through a shared mutable tree, and requires dirty state to be preserved. Foreman does not intercept a host agent's Git commands, but its independent validation is designed to detect resulting state loss: the pitboss re-reads actual files, compares them with the specification, and searches the full test suite for changed symbols instead of trusting the worker or a green exit code. Detection is after the fact, not automatic restoration. If a host cannot honor isolation, serialize workers.
