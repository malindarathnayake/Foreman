---
id: configuration
title: Configuration and overrides
sidebar_label: Configuration and overrides
description: Command-line flags, environment variables, the .foremanenv worker file, the council store, stack profiles, and skill overrides.
---

# Configuration and overrides

Nothing here is required. A fresh install with no configuration serves all six protocols, the ledger, tests, and CLI reviewers. Configuration is needed only for external workers, a review council, tracing, or a repo-specific review policy.

## Command line

| Flag | Effect |
|---|---|
| `--host=<id>` | Host profile: `claude-code` (default), `cursor`, `codex`, `generic` |
| `--version`, `-v` | Print the version and exit |
| `--diag` | Print runtime, package, SDK, and skills diagnostics and exit |

Any other flag prints usage. With no flag the process serves MCP on stdin and stdout.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `FOREMAN_HOST` | Host profile when `--host` is absent | `claude-code` |
| `FOREMAN_STACK_PROFILE` | Named bundled stack profile for the `ethos` document | unset; then `Docs/foreman-stack-profile.md`, then the bundled reference |
| `FOREMAN_AGENT_CLASS` | Declared class of the host model: `frontier`, `capable`, `compact`. Controls which seat-assist fragments render into the procedures | `frontier` |
| `FOREMAN_COMPRESSION` | `0` turns output compression off | on |
| `FOREMAN_COMPRESSION_TOOLS` | Comma list narrowing which tools compress | `run_tests,invoke_advisor` |
| `CONTEXT_CRUSH_CCR_TTL_SECONDS` | How long `retrieve_original` can recover a compressed output | 1800 |
| `FOREMAN_TEST_ALLOWLIST` | Extra `run_tests` runners, comma separated | none |
| `FOREMAN_BRIEF_MAX_BYTES` | `invoke_worker` brief plus file payload cap | 262144 |
| `FOREMAN_WORKER_RESPONSE_MAX_BYTES` | `invoke_worker` response cap | see tool description |
| `FOREMAN_WORKER_CONNECT_TIMEOUT_MS`, `FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS` | `invoke_worker` two-phase timeouts | see tool description |
| `FOREMAN_COUNCIL_MAX_CALLS` | Cap on seats times lenses per `invoke_council` call | see tool description |
| `FOREMAN_COUNCIL_EFFORT_MAX_TOKENS`, `FOREMAN_COUNCIL_PACKET_MAX_BYTES`, `FOREMAN_COUNCIL_RESPONSE_MAX_BYTES` | Council budgets | see tool description |
| `FOREMAN_COUNCIL_SEAT_A`, `_B`, `_C`; `FOREMAN_COUNCIL_LABEL_<seat>`; `FOREMAN_COUNCIL_REASONING_<seat>`; `FOREMAN_COUNCIL_REASONING_MAX_TOKENS_<seat>` | Council seat models and reasoning settings | unset; the council reports `unavailable` |
| `FOREMAN_LANGFUSE_BASE_URL`, `_PUBLIC_KEY`, `_SECRET_KEY`, `_TIMEOUT_MS`, `_ENVIRONMENT`, `_RELEASE`, `_CONTENT` | Optional Langfuse tracing for council runs. Tracing is off unless the URL and keys are set; `_CONTENT` controls whether prompt and finding text is sent | off |
| `FOREMAN_PREVIEW` | `0` disables the diagram preview server | on |
| `FOREMAN_NO_OPEN` | Set to stop `preview_diagram` from opening a browser | unset |

## `.foremanenv`

An INI-style file in the repo root that configures `invoke_worker` and the review council: the API base URL, the name of the environment variable holding the key (never the key itself; the syntax is `${ENV:NAME}`), and one model per tier (`cheap`, `standard`, `premium`) with its class, edit format, and optional reasoning settings. The loader refuses to run if the file is tracked by git or not ignored, and it names the exact line to add for every validation failure. The resolved key is registered with the redaction module and never appears in any output, error, or log.

## `~/.foreman-mcp/.env`

An operator-owned store outside any repo. Council seats configured here override the same seats in `.foremanenv`, so a model can be swapped without editing a shared file. For the API key, the process environment wins over this file.

## Stack profile

The `ethos` document has backend-specific sections: telemetry backend rules such as reserved log field names, and the security framework flavor. `FOREMAN_STACK_PROFILE` selects a bundled profile; `Docs/foreman-stack-profile.md` supplies a project one, parsed as tagged sections; with neither, the bundled reference profile is used. A malformed override falls back to the reference with a warning. Procedures tell the model to treat a name check as ambiguous when the profile resolved by fallback.

## Skill overrides

```text
.claude/skills/<name>/SKILL.md     project override, highest precedence
~/.claude/skills/<name>/SKILL.md   user override
bundled                            package default
```

Names: `design-partner`, `spec-generator`, `implementor`, `lighttask`, `spec-man`, `doc-man`. These paths are read under every host profile. `bundle_status` reports an active override. A stale override silently shadows a newer bundled protocol, which is the most common cause of "the procedure does not mention X" after an upgrade. See [Upgrading](../contributing/upgrading.md).
