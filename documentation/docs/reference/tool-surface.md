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

`retrieve_original` exists only when compression is on. `codex_agents_init` exists only under the Codex profile. `cursor_agents_init` exists only under the Cursor profile. `claude_agents_init` and `claude_workflows_init` exist only under Claude Code. Every tool advertises a strict JSON Schema input and returns text; write tools also return a `SCHEMA ERROR` with one hint per field when the input is wrong.

Server instructions. Hosts that defer tool loading may show a session nothing from Foreman but its initialize instructions, so those are short and conditional: use Foreman when the user asks for it or the repository already has a ledger, a missing ledger is not a reason to start one, and worker and reviewer seats ignore Foreman state.

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
| `host_status` | none | Active host profile and the model slugs it renders. On Codex the shipped seat table is `seat_defaults`, beside `seat_pins_on_disk` read from `.codex/agents/*.toml` and `tool_timeout_sec` read from the `[mcp_servers.foreman]` table (project config, then user); when that is unset or under 1200 it adds `tool_timeout_advice` to set 1200, since Codex's documented 60 s default cuts off advisors, councils and workers `os_cert_store` says whether TLS from the server trusts the operating system certificate store. |
| `changelog` | `since` | Bundled changelog entries |
| `ethos` | `section` | The engineering document rendered with the active stack profile |
| `normalize_review` | `reviewer`, `raw_text` | Findings parsed from reviewer text, a `findings_json:` line ready for `record_review`, and `unparsed_lines`. Zero findings from non-empty text prints the grammar it requires — an explicit `CRITICAL`/`HIGH`/`MEDIUM`/`LOW` or `P0`–`P3` token |
| `verify_citations` | spec text plus citations | Each `file:line` citation checked against the repo |
| `retrieve_original` | a `<<ccr:HASH>>` marker | The uncompressed output that marker replaced, for 30 minutes by default |

## Write files under `Docs/`

| Tool | Operations | Refusals |
|---|---|---|
| `write_ledger` | `set_unit_status`, `set_verdict`, `add_rejection`, `authorize_attempts`, `declare_phase_units`, `update_phase_gate`, `set_phase_scope`, `record_review`, `record_escape`, `record_fact`, `close_attempt` | The full list on [What Foreman enforces](../enforcement/what-foreman-enforces.md). `phase` is required on every operation. The input schema carries every operation's exact `data` shape, including array minimums such as `(min 2, max 5)` for native reviewers. `set_unit_status { s: "delegated" }` accepts `guard: { files, allowed_files }` to take the `repo_guard` baseline in the same write (`guard: {}` on a correction inherits the set). `record_review` findings accept `units`, the registered units a finding is about A seat receipt with `failure_reason: timed_out` can be bound to a `completion: "partial"` record: its findings count and block if confirmed, and the record covers nothing. `set_unit_status` also accepts `preflight_check: { symbols, files, creates }` to run the preflight in the same write. A pass verdict on an attempt whose baseline has no comparison yet runs the comparison first, in the baseline's own repository. |
| `write_progress` | `start_phase`, `update_status`, `complete_unit`, `log_error` | Also rewrites the fenced block in `PROGRESS.md` from the ledger. `complete_unit` reports `legacy_checkbox_candidates` for hand-written `- [ ] <unit id>` lines outside the fence and leaves them as they are |
| `repo_guard` | `snapshot`, `compare` | Records the shared-tree ownership check on the unit's newest delegation. `allowed_files` is the allow-list `compare` measures against; `files` only scopes the line-ending probe. An accidentally empty allow-list is refused, and both operations refuse or flag an authorized file that is entirely NUL bytes. Files Foreman itself writes (`.foreman-*` state files and their `.corrupt`/`.tmp` side files, and the fenced checklist block in `Docs/PROGRESS.md`) are never charged to the worker; `PROGRESS.md` content outside the fence still is, and the fence interior is not verified (the ledger is authoritative). An explicit `snapshot` on an attempt whose delegation already took its baseline is answered from that baseline. `compare` records the paths a violation named and re-checks every earlier open violation against its own baseline, marking it `resolved` when those paths are restored Files the unit promised in `preflight_check` `creates` join the authorized set at snapshot time. |
| `preflight_check` | one check of a brief against the spec for `phase` and `unit_id`, with `brief`, `symbols`, `files`, `creates`, and `correcting_attempt` | Records a receipt keyed by the brief's hash, which the delegation cites as `preflight.receipt`. Hashes the unit's `foreman-contract` block whenever one exists and fails on a block that does not parse. Fenced blocks are skipped when scoring directive coverage only; citations and the checkpoint's `Test:` lines still read them. A checkpoint on a runner Foreman does not parse (dotnet, pytest, make) reads `not checked`. A bare prose path resolves when exactly one of the unit's listed files ends with it. `correcting_attempt`, which must name an attempt the ledger holds, sets coverage to `n/a` |
| `write_journal` | `init_session`, `declare_model`, `log_event`, `end_session` | Declared model/effort workflow rank; 15 anomaly-only event codes; 200 events per session; `log_event msg` over 400 chars is cut with a marker and a warning |

## Spawn a local process

| Tool | Spawns | Notes |
|---|---|---|
| `run_tests` | One runner from the allowlist: `npm`, `pytest`, `go`, `cargo`, `dotnet`, `make`, `gradle`, `gradlew`, `gofmt`, `golangci-lint`; extend with `FOREMAN_TEST_ALLOWLIST`; `npx` is never allowed | No shell. Windows `.cmd` shims and Gradle wrappers are resolved directly. `passed` is exit code 0; list-style checkers such as `gofmt -l` exit 0 and print the files needing work, so pass `fail_on_stdout: true` for those. Output is capped per stream (default 8000 characters, max 50000) and truncation keeps the tail. `strip_patterns` drops lines matching up to 10 regexes before the cap; `tail_lines` keeps the last N lines. Default timeout 60 s, max 600 s A timeout kills the runner's whole process tree; a run whose output pipes stay open after the runner exits reports `timed_out: true`, never a pass. |
| `live_smoke` | The smoke plan registered in the unit's `foreman-contract` block, through `run_tests` (same allowlist, no shell) in the plan's cwd | The call carries `plan_id` only; command, cwd, environment names, harness files and application inputs come from the spec. The plan's env names resolve from the server environment first and `~/.foreman-mcp/.env` second and are laid over the child's environment only; refuses when one is unset in both, a harness file is missing, or a declared deliverable already exists before the run. After the run every declared deliverable is digested and its assertions evaluated (size bounds, JSON checks, `values_in` against a reference file frozen at delegation); the receipt carries the results Records a receipt bound to the attempt, the contract digest, a harness digest and an input digest; `set_verdict pass` in a `has_api` phase recomputes the digests and requires a current passing receipt |
| `capability_check` | The advisor CLI's version and health commands | Returns `ok`, `not_found`, `not_trusted`, `auth_expired`, `probe_timeout`, `model_substituted`, or `error`, with a one-line hint. An `ok` carries `auth_scope`: it reflects local login state, and the service can still reject the credential. For gemini it also reports `model_requested` and `model_served` from the run stats. On the Cursor host, also `cli: "cursor"` (`agent status --format json`); it is not assumed available from Task |
| `invoke_advisor` | `claude`, `codex`, or `gemini` CLI with the prompt on stdin; on the Cursor host also `cursor` | The CLI's own login and network. Claude/codex/gemini take the prompt on stdin. On `--host=cursor`, `cli: "cursor"` writes a tempfile (Windows argv cap) and runs `agent -p --mode=ask --trust` (never `--approve-mcps`). On success, stderr is dropped unless stdout was truncated; failures keep it. Exit 0 with empty stdout, or stdout equal to the prompt, is reported as `completion: failed` with the reason and the stderr tail. Gemini answers in JSON and Codex echoes its model in a header; the meta block names `model_requested` and `model_served` (plus `reasoning_effort` for Codex), and a served model other than the pinned one, `gemini-3.1-pro-preview` or `gpt-6-astra` at `xhigh`, is `completion: failed` with `model_substituted`. A non-zero exit is classified from structured state and the stderr tail (never the echoed prompt) as `failure_reason: timed_out`, `auth_failed`, `budget_exceeded` or `model_rejected`, with a one-line fix, in the output and on the receipt. The Claude seat's USD cap is 1, overridable with `FOREMAN_CLAUDE_ADVISOR_BUDGET_USD`. Receipts carry `started_ts`. Cursor receipts are provider unknown Since 0.6.39: the Claude seat runs `claude-fable-5-1` and retries once on `claude-opus-5-5` when the CLI refuses Fable (`model_fallback` in the meta block, and a receipt for each attempt). Optional `phase` and `units` pin those units' files on the receipt. A timeout or a host cancel kills the whole process tree; a host cancel records failure class `cancelled`. Progress notifications every 20 s when the host sends a progress token. |

## Make a network call

| Tool | Sends | To |
|---|---|---|
| `invoke_worker` | The brief and the listed files' contents | The OpenAI-compatible endpoint named in `.foremanenv` for the requested tier. Configured secret values are blocked from the payload A host cancel stops the call; it also has an overall deadline (`FOREMAN_WORKER_TOTAL_TIMEOUT_MS`, default 30 min). |
| `invoke_council` | One evidence packet plus one lens card per seat | The remote review seats configured in `.foremanenv` or `~/.foreman-mcp/.env`. Optional Langfuse tracing sends review metadata, and content only when `FOREMAN_LANGFUSE_CONTENT` allows it Optional `units` pins those units' files on each seat receipt. A host cancel stops the seats; the HTTP calls have an overall deadline (`FOREMAN_WORKER_TOTAL_TIMEOUT_MS`). |

| `contract_probe` | One GET or HEAD, headers resolved from `${ENV:NAME}` tokens (server environment first, `~/.foreman-mcp/.env` second) whose values are never printed or stored. The URL is literal; tokens expand in headers only | In claim mode (`claim_id`) the URL and assertions come from the unit's `foreman-contract` block in the spec; in diagnostic mode (`url`) from the call, recorded `diagnostic` and never satisfying a claim. Follows no redirects. Streams the body under a 4 MB cap; an incomplete capture fails every body assertion. Records origin and path, status, bytes and body hash on the unit TLS trusts the operating system certificate store as well as Node's bundled list; a certificate failure names its cause and the fix. |

`invoke_worker` and `invoke_council` refuse to run while `.foremanenv` is tracked or not ignored. `invoke_worker` is marked EXPERIMENTAL in its description; both carry `openWorldHint: true`.

## Open a listener

| Tool | Binds | Notes |
|---|---|---|
| `preview_diagram` | `127.0.0.1` only, random port, per-process token on every private route | Serves a Mermaid preview and opens the browser unless `FOREMAN_NO_OPEN` is set. `FOREMAN_PREVIEW=0` disables the tool's server. Unquoted flowchart edge labels that contain `--` are quoted on write and on `/api/source` so mermaid 11 does not lex them as a new edge |

## Write outside `Docs/`

| Tool | Writes |
|---|---|
| `codex_agents_init` (Codex only) | `.codex/agents/explorer.toml`, `.codex/agents/worker.toml`, and an `[agents]` block in `.codex/config.toml`, each only if absent |
| `cursor_agents_init` (Cursor only) | `.cursor/agents/foreman-worker-light.md`, `foreman-worker.md`, `foreman-worker-heavy.md`, each only if absent unless `overwrite: true`. Default model `inherit`. |
| `claude_agents_init` (Claude Code only) | `.claude/agents/foreman-worker-light.md`, `foreman-worker.md`, `foreman-worker-heavy.md`, each only if absent unless `overwrite: true` |

## Output compression

`run_tests` and `invoke_advisor` outputs of 2048 bytes or more that look like logs or diffs are compressed before they reach the model, with a `<<ccr:HASH>>` marker. Failed test runs under 8 KB are exempt so the diagnostic survives. `retrieve_original` returns the full text. `FOREMAN_COMPRESSION=0` turns it off; `FOREMAN_COMPRESSION_TOOLS` narrows which tools it applies to.

The machine-readable version of this page is [llms.txt](https://github.com/malindarathnayake/Foreman/blob/main/llms.txt).

### Declared rank and correction fields

`write_journal init_session` accepts `data.env.model` and `data.env.effort`. `declare_model` accepts `data: { model, effort }` and replaces both fields in the active session. Both return the calculated `model_rank` (model, effort, rank, weight, policy_version, session_id, permissions). Identity is self-declared; unmapped inputs use normal protocol. The permission booleans are `reuse_worker_mechanical`, `reuse_worker_bounded`, `compact_followup`, `focused_validation`, and `delta_review`.

For native workers, `write_ledger set_verdict` can bind the actual host-returned `worker_id`. An eligible correction uses a new `set_unit_status` delegation with that `worker_id` and `correction: { kind: "mechanical" | "bounded", from_attempt, files }`, plus the normal brief and preflight. This allocates an ordinary outer attempt; take a new guard snapshot before reuse and compare before verdict. The frozen authorized scope remains the original scope. If the previous attempt carries no `worker_id` (rejected before a verdict, or a verdict written without it), the correction's `worker_id` is bound onto it in the same session and recorded as `worker_id_bound: { at: "correction", ts, by_attempt }`; a bound id is never rebound. The finding may be inlined as `data.rejection: { r, msg, escape_class? }`. On any correction attempt, `repo_guard snapshot` copies `allowed_files` and `max_entries` from the `from_attempt` baseline when they are omitted.

Top delta review uses `record_review` at `stage: "verification"` with `evidence.kind: "worker_delta"` and a separate `verifier_id`, plus the baseline timestamp, all covered unit/attempt pairs, all frozen authorized paths, tests and probe evidence. Existing direct-fix fields remain compatible for historical integrations; the implementation protocol uses workers for new corrections.
