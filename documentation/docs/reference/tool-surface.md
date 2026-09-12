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
| `design_partner`, `spec_generator`, `pitboss_implementor`, `lighttask`, `researcher`, `spec_man`, `doc_man` | `context` string | The procedure for that protocol, rendered for the active host. `researcher` is the iterative-experiment loop — question, hypothesis, bounded variant, evidence, decision, checkpoint — keeping a thin `Docs/research.md` index with one file per run; it records and disciplines, and gates nothing |
| `session_orient` | none | The resume state. See [Resuming a session](../how-it-works/resuming.md) |
| `read_ledger` | `query`: `verdicts`, `rejections`, `phase_gates`, `reviews`, `delegation_metrics`, `review_outcomes`, `facts`, `reconstruct`, `full`; `phase`, `unit_id`, `verdict`, `include_notes`, `cursor`, `limit` up to 100 | A paged table, or one unit, or the full JSON. `full` on a large ledger returns guidance instead of flooding the context. `reconstruct` builds a read-only recovery worksheet from the append-only sidecars after a ledger loss |
| `read_progress` | `last_n_completed` | Ledger progress and resume state shared with `session_orient`, followed by descriptive checklist notes |
| `read_journal` | `last_n`, `rollup_only` | Sessions, or the rollup |
| `bundle_status` | none | `running_version` versus `runtime_disk_version`; `restart_recommended` as `true` with what changed, `false`, or `n/a` with why, from comparing `dist/`, `package.json`, and the stack profile override against a snapshot taken at process start; and which skills are shadowed by a project or user override. Compiled code cannot be reloaded; protocol Markdown is re-read on every activation |
| `host_status` | none | Active host profile and the model slugs it renders |
| `changelog` | `since` | Bundled changelog entries |
| `ethos` | `section` | The engineering document rendered with the active stack profile |
| `normalize_review` | `reviewer`, `raw_text` | Findings parsed from reviewer text, a `findings_json:` line ready for `record_review`, and `unparsed_lines`. Zero findings from non-empty text prints the grammar it requires — an explicit `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` or `P0`–`P3` token |
| `verify_citations` | spec text plus citations | Each `file:line` citation checked against the repo |
| `retrieve_original` | a `<<ccr:HASH>>` marker | The uncompressed output that marker replaced, for 30 minutes by default |

## Write files under `Docs/`

| Tool | Operations | Refusals |
|---|---|---|
| `write_ledger` | `set_unit_status`, `set_verdict`, `add_rejection`, `authorize_attempts`, `declare_phase_units`, `update_phase_gate`, `set_phase_scope`, `record_review` | The full list on [What Foreman enforces](../enforcement/what-foreman-enforces.md). The tool description carries every operation's exact `data` shape |
| `write_progress` | `start_phase`, `update_status`, `complete_unit`, `log_error` | Also rewrites the fenced block in `PROGRESS.md` from the ledger. `complete_unit` reports `legacy_checkbox_candidates` for hand-written `- [ ] <unit id>` lines outside the fence and leaves them as they are |
| `repo_guard` | `snapshot`, `compare` | Records the shared-tree ownership check on the unit's newest delegation. `allowed_files` is the allow-list `compare` measures against; `files` only scopes the line-ending probe. An accidentally empty allow-list is refused, and both operations refuse or flag an authorized file that is entirely NUL bytes. Files Foreman itself writes (`.foreman-*` state files and their `.corrupt`/`.tmp` side files, and the fenced checklist block in `Docs/PROGRESS.md`) are never charged to the worker; `PROGRESS.md` content outside the fence still is, and the fence interior is not verified (the ledger is authoritative) |
| `write_journal` | `init_session`, `declare_model`, `log_event`, `end_session` | Declared model/effort workflow rank; 15 anomaly-only event codes; 200 events per session; `log_event msg` over 400 chars is cut with a marker and a warning |

## Spawn a local process

| Tool | Spawns | Notes |
|---|---|---|
| `run_tests` | One runner from the allowlist: `npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`, `gradle`, `gradlew`, `gofmt`, `golangci-lint`; extend with `FOREMAN_TEST_ALLOWLIST`; `npx` is never allowed | No shell. Windows `.cmd` shims and Gradle wrappers are resolved directly. `passed` is exit code 0; list-style checkers such as `gofmt -l` exit 0 and print the files needing work, so pass `fail_on_stdout: true` for those. Output is capped per stream (default 8000 characters, max 50000) and truncation keeps the tail. `strip_patterns` drops lines matching up to 10 regexes before the cap; `tail_lines` keeps the last N lines. Default timeout 60 s, max 600 s |
| `live_smoke` | The smoke plan registered in the unit's `foreman-contract` block, through `run_tests` (same allowlist, no shell) in the plan's cwd | The call carries `plan_id` only; command, cwd, environment names, harness files and application inputs come from the spec. The plan's env names resolve from the server environment first and `~/.foreman-mcp/.env` second and are laid over the child's environment only; refuses when one is unset in both, a harness file is missing, or a declared deliverable already exists before the run. After the run every declared deliverable is digested and its assertions evaluated (size bounds, JSON checks, `values_in` against a reference file frozen at delegation); the receipt carries the results Records a receipt bound to the attempt, the contract digest, a harness digest and an input digest; `set_verdict pass` in a `has_api` phase recomputes the digests and requires a current passing receipt |
| `capability_check` | The advisor CLI's version and health commands | Returns `ok`, `not_found`, `not_trusted`, `auth_expired`, `probe_timeout`, `model_substituted`, or `error`, with a one-line hint. For gemini it also reports `model_requested` and `model_served` from the run stats |
| `invoke_advisor` | `claude`, `codex`, or `gemini` CLI with the prompt on stdin | The CLI's own login and network. On success, stderr is dropped unless stdout was truncated; failures keep it. Exit 0 with empty stdout, or stdout equal to the prompt, is reported as `completion: failed` with the reason and the stderr tail. Gemini answers in JSON and Codex echoes its model in a header; the meta block names `model_requested` and `model_served` (plus `reasoning_effort` for Codex), and a served model other than the pinned one, `gemini-3.1-pro-preview` or `gpt-6-astra` at `xhigh`, is `completion: failed` with `model_substituted` |

## Make a network call

| Tool | Sends | To |
|---|---|---|
| `invoke_worker` | The brief and the listed files' contents | The OpenAI-compatible endpoint named in `.foremanenv` for the requested tier. Configured secret values are blocked from the payload |
| `invoke_council` | One evidence packet plus one lens card per seat | The remote review seats configured in `.foremanenv` or `~/.foreman-mcp/.env`. Optional Langfuse tracing sends review metadata, and content only when `FOREMAN_LANGFUSE_CONTENT` allows it |

| `contract_probe` | One GET or HEAD, headers resolved from `${ENV:NAME}` tokens (server environment first, `~/.foreman-mcp/.env` second) whose values are never printed or stored | In claim mode (`claim_id`) the URL and assertions come from the unit's `foreman-contract` block in the spec; in diagnostic mode (`url`) from the call, recorded `diagnostic` and never satisfying a claim. Follows no redirects. Streams the body under a 4 MB cap; an incomplete capture fails every body assertion. Records origin and path, status, bytes and body hash on the unit |

`invoke_worker` and `invoke_council` refuse to run while `.foremanenv` is tracked or not ignored. `invoke_worker` is marked EXPERIMENTAL in its description; both carry `openWorldHint: true`.

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

### Declared rank and correction fields

`write_journal init_session` accepts `data.env.model` and `data.env.effort`. `declare_model` accepts `data: { model, effort }` and replaces both fields in the active session. Both return the calculated `model_rank` (model, effort, rank, weight, policy_version, session_id, permissions). Identity is self-declared; unmapped inputs use normal protocol. The permission booleans are `reuse_worker_mechanical`, `reuse_worker_bounded`, `compact_followup`, `focused_validation`, and `delta_review`.

For native workers, `write_ledger set_verdict` can bind the actual host-returned `worker_id`. An eligible correction uses a new `set_unit_status` delegation with that `worker_id` and `correction: { kind: "mechanical" | "bounded", from_attempt, files }`, plus the normal brief and preflight. This allocates an ordinary outer attempt; take a new guard snapshot before reuse and compare before verdict. The frozen authorized scope remains the original scope. If the previous attempt carries no `worker_id` (rejected before a verdict, or a verdict written without it), the correction's `worker_id` is bound onto it in the same session and recorded as `worker_id_bound: { at: "correction", ts, by_attempt }`; a bound id is never rebound. The finding may be inlined as `data.rejection: { r, msg, escape_class? }`. On any correction attempt, `repo_guard snapshot` copies `allowed_files` and `max_entries` from the `from_attempt` baseline when they are omitted.

Top delta review uses `record_review` at `stage: "verification"` with `evidence.kind: "worker_delta"` and a separate `verifier_id`, plus the baseline timestamp, all covered unit/attempt pairs, all frozen authorized paths, tests and probe evidence. Existing direct-fix fields remain compatible for historical integrations; the implementation protocol uses workers for new corrections.
