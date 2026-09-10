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
| Codex | native protocol rendering and MCP review-to-gate path tested | Full project run not recorded in this repo | Native `spawn_agent`; configured worker tiers, actual model reported by the host | Native reviewers + verifier; available Claude/Gemini CLIs supplement major checkpoints |
| Generic | rendered as a six-capability contract | No | Whatever the host declares; see `HOST-CONTRACT.md` | Host-neutral advisor calls, else adversarial self-review recorded as non-independent |

## What differs per host

- **The worker call.** Each profile names the host's own subagent tool and the model slug to pass. `host_status` prints the slugs in effect.
- **Editing concurrency.** Under every profile, editing workers run one at a time unless each has a proven isolated worktree or sandbox. Claude Code's profile spells out the parallel procedure: `isolation: "worktree"`, disjoint file sets, full `git diff` in each report, serial application with a verdict per unit. Codex explorers, which are read-only, may run in parallel up to `agents.max_threads`.
- **Reviewer seats.** Claude Code reviews with Codex and Gemini. Codex defaults to native reviewers plus a verifier, and adds available Claude/Gemini advisors at major checkpoints. Native review is recorded as same-provider review; it is not described as cross-vendor independence.
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

## Rank policy across hosts

Every host uses the same declared model/effort rank policy. The host profile still selects worker and advisor tools; rank selects eligible workflow shortcuts. `write_journal init_session` accepts the pitboss's self-reported identity, and unknown models continue with normal protocol. No additional external CLI is needed for rank lookup.

Top can reuse a bounded native worker for fixes and test changes, use compact follow-ups and focused intermediate checks, and obtain independent verification of the delta against retained review coverage. Middle gets mechanical worker reuse and compact follow-ups with normal checks/review. Native reuse needs an actual recorded worker ID in the same active session; an unsupported follow-up mechanism or a host switch requires a fresh worker. Existing sidecar `invoke_worker` attempts do not qualify for native reuse.

Complete native review and accepted delta evidence survive host switching with their original same-provider provenance. Creating a native review still uses Codex's native reviewer/verifier procedure. Rank never changes configured seat capability, ownership boundaries, attempt limits, or checkpoint gates.

## Saved workflows on Claude Code

Claude Code's Workflow tool runs many agents from one script. `claude_workflows_init` installs Foreman's three scripts into the project's `.claude/workflows/`: a design panel, a checkpoint review fan, and a field-report triage. The pit-boss confirms a run with you first unless you opted in with `ultracode`. A workflow review is same-model perspective, recorded as `fan`, and never a gate seat. Implementation never runs inside a workflow. Codex, Cursor and generic hosts have no equivalent surface.
