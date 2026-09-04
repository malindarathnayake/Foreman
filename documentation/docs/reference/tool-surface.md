---
id: tool-surface
title: Tools
sidebar_label: Tools
description: Every MCP tool, grouped by what it touches, with the inputs that matter and what can leave the machine.
---

# Tools

| Host | Compression on (default) | `FOREMAN_COMPRESSION=0` |
|---|---|---|
| Claude Code, Cursor, generic | 26 | 25 |
| Codex | 27 | 26 |

`retrieve_original` exists only when compression is on. `codex_agents_init` exists only under the Codex profile. Every tool advertises a strict JSON Schema input and returns text; write tools also return a `SCHEMA ERROR` with one hint per field when the input is wrong.

Where the shapes are. Hosts clip tool descriptions at about 2,000 characters, so the per-operation `data` shapes for `write_ledger`, `write_journal`, and `write_progress` are generated into the input schema's `data` property description, which hosts show in full. Every tool description is held under the clip by a test.

## Return text, touch nothing

| Tool | Input that matters | Returns |
|---|---|---|
| `design_partner`, `spec_generator`, `pitboss_implementor`, `lighttask`, `spec_man`, `doc_man` | `context` string | The procedure for that protocol, rendered for the active host |
| `session_orient` | none | The resume state. See [Resuming a session](../how-it-works/resuming.md) |
| `read_ledger` | `query`: `verdicts`, `rejections`, `phase_gates`, `reviews`, `delegation_metrics`, `full`; `phase`, `unit_id`, `verdict`, `include_notes`, `cursor`, `limit` up to 100 | A paged table, or one unit, or the full JSON. `full` on a large ledger returns guidance instead of flooding the context |
| `read_progress` | `last_n_completed` | The descriptive checklist |
| `read_journal` | `last_n`, `rollup_only` | Sessions, or the rollup |
| `bundle_status` | none | `running_version` versus `runtime_disk_version`, `restart_recommended` when they differ, and which skills are shadowed by a project or user override. Compiled code cannot be reloaded; protocol Markdown is re-read on every activation |
| `host_status` | none | Active host profile and the model slugs it renders |
| `changelog` | `since` | Bundled changelog entries |
| `ethos` | `section` | The engineering document rendered with the active stack profile |
| `normalize_review` | `reviewer`, `raw_text` | Findings parsed from reviewer text, a `findings_json:` line ready for `record_review`, and `unparsed_lines` |
| `verify_citations` | spec text plus citations | Each `file:line` citation checked against the repo |
| `retrieve_original` | a `<<ccr:HASH>>` marker | The uncompressed output that marker replaced, for 30 minutes by default |

## Write files under `Docs/`

| Tool | Operations | Refusals |
|---|---|---|
| `write_ledger` | `set_unit_status`, `set_verdict`, `add_rejection`, `declare_phase_units`, `update_phase_gate`, `set_phase_scope`, `record_review` | The full list on [What Foreman enforces](../enforcement/what-foreman-enforces.md). The tool description carries every operation's exact `data` shape |
| `write_progress` | `start_phase`, `update_status`, `complete_unit`, `log_error` | Also rewrites the fenced block in `PROGRESS.md` from the ledger |
| `write_journal` | `init_session`, `log_event`, `end_session` | 15 anomaly-only event codes; 200 events per session |

## Spawn a local process

| Tool | Spawns | Notes |
|---|---|---|
| `run_tests` | One runner from the allowlist: `npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`, `gradle`, `gradlew`, `gofmt`, `golangci-lint`; extend with `FOREMAN_TEST_ALLOWLIST`; `npx` is never allowed | No shell. Windows `.cmd` shims and Gradle wrappers are resolved directly. `passed` is exit code 0; list-style checkers such as `gofmt -l` exit 0 and print the files needing work, so pass `fail_on_stdout: true` for those. Output is capped per stream (default 8000 characters, max 50000) and truncation keeps the tail. `strip_patterns` drops lines matching up to 10 regexes before the cap; `tail_lines` keeps the last N lines. Default timeout 60 s, max 600 s |
| `capability_check` | The advisor CLI's version and health commands | Returns `ok`, `not_found`, `not_trusted`, `auth_expired`, `probe_timeout`, or `error`, with a one-line hint |
| `invoke_advisor` | `claude`, `codex`, or `gemini` CLI with the prompt on stdin | The CLI's own login and network. On success, stderr is dropped unless stdout was truncated; failures keep it |

## Make a network call

| Tool | Sends | To |
|---|---|---|
| `invoke_worker` | The brief and the listed files' contents | The OpenAI-compatible endpoint named in `.foremanenv` for the requested tier. Configured secret values are blocked from the payload |
| `invoke_council` | One evidence packet plus one lens card per seat | The remote review seats configured in `.foremanenv` or `~/.foreman-mcp/.env`. Optional Langfuse tracing sends review metadata, and content only when `FOREMAN_LANGFUSE_CONTENT` allows it |

Both refuse to run while `.foremanenv` is tracked or not ignored. `invoke_worker` is marked EXPERIMENTAL in its description; both carry `openWorldHint: true`.

## Open a listener

| Tool | Binds | Notes |
|---|---|---|
| `preview_diagram` | `127.0.0.1` only, random port, per-process token on every private route | Serves a Mermaid preview and opens the browser unless `FOREMAN_NO_OPEN` is set. `FOREMAN_PREVIEW=0` disables the tool's server |

## Write outside `Docs/`

| Tool | Writes |
|---|---|
| `codex_agents_init` (Codex only) | `.codex/agents/explorer.toml`, `.codex/agents/worker.toml`, and an `[agents]` block in `.codex/config.toml`, each only if absent |

## Output compression

`run_tests` and `invoke_advisor` outputs of 2048 bytes or more that look like logs or diffs are compressed before they reach the model, with a `<<ccr:HASH>>` marker. Failed test runs under 8 KB are exempt so the diagnostic survives. `retrieve_original` returns the full text. `FOREMAN_COMPRESSION=0` turns it off; `FOREMAN_COMPRESSION_TOOLS` narrows which tools it applies to.

The machine-readable version of this page is [llms.txt](https://github.com/malindarathnayake/Foreman/blob/main/llms.txt).
