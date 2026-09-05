---
id: host-compatibility
title: Host compatibility
sidebar_label: Host compatibility
description: What changes under each host, what has actually been run, and what each profile cannot do.
---

# Host compatibility

Two statuses matter and they are not the same. **Profile rendered** means the procedures and tool descriptions are generated for that host and the test suite covers that rendering. **Run end to end** means a real project was carried through design, spec, and implementation on that host, and says when and where.

| Host | Profile | Run end to end | Worker | Reviewers |
|---|---|---|---|---|
| Claude Code | rendered, default | Yes. Foreman's own releases from 0.5.x through 0.6.x, Windows 11, 2026 | `Agent` tool, model `sonnet` | Codex CLI and Gemini CLI |
| Cursor | rendered; capability path covered by tests | Not recorded in this repo | `Task` tool, `generalPurpose` | Cursor read-only `Task` seats on GPT-5.6 Sol and Gemini 3.1 Pro |
| Codex | rendered; parallel fan-out contract covered by tests | Not recorded in this repo | `spawn_agent` subagent; the profile asks for `gpt-5.6-luna`, but Codex owns child model selection and Foreman records what actually ran | Headless Claude and Gemini CLI |
| Generic | rendered as a six-capability contract | No | Whatever the host declares; see `HOST-CONTRACT.md` | Host-neutral advisor calls, else adversarial self-review recorded as non-independent |

## What differs per host

- **The worker call.** Each profile names the host's own subagent tool and the model slug to pass. `host_status` prints the slugs in effect.
- **Editing concurrency.** Under every profile, editing workers run one at a time unless each has a proven isolated worktree or sandbox. Claude Code's profile spells out the parallel procedure: `isolation: "worktree"`, disjoint file sets, full `git diff` in each report, serial application with a verdict per unit. Codex explorers, which are read-only, may run in parallel up to `agents.max_threads`.
- **Reviewer seats.** Reviews are cross-vendor by design, so the host's own vendor is never a reviewer. Claude Code reviews with Codex and Gemini; Codex reviews with Claude and Gemini.
- **Autonomy.** Cursor declares no autonomy capability, so phase progression stays interactive there. Claude Code and Codex profiles carry an autonomy clause; the generic profile fails closed and points at the contract.
- **Tool count.** 26 by default, 27 under Codex, one fewer each with compression off.

## Resolution and fallback

`--host=<id>` wins, then `FOREMAN_HOST`, then `claude-code`. An unknown id logs a warning to stderr and uses `claude-code`. The rendered procedure will then name the wrong worker tool, which the model reports as an unsupported capability when it tries to use it.

`host_status` and `session_orient` both report `unsupported_capabilities` for the active profile, taken from the capability contract. The contract, the readiness matrix, the completion-report schema, and the isolation checklist are in `foreman-mcp/HOST-CONTRACT.md` inside the package.

## Windows

- Register the server as `cmd /c foreman-mcp` when the host spawns without a shell. See [Register your host](../getting-started/configure-mcp-host.md).
- `run_tests` resolves `npm.cmd` and other shims itself, without a shell, and runs Gradle wrappers through `GradleWrapperMain`.
- `invoke_advisor` wraps the advisor CLIs' `.cmd` shims.
- Foreman's own suite runs green on Windows 11 with Node 22. Some file-rename races under antivirus scanning are retried with a bounded backoff in the atomic-write helper.
