<div align="center">

<img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman" width="800" />

# Foreman

<p align="center">
  <a href="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml/badge.svg" alt="Build and Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22" /></a>
  <a href="https://malindarathnayake.github.io/Foreman/"><img src="https://img.shields.io/badge/docs-foreman-b45309.svg" alt="Documentation" /></a>
</p>

</div>

Foreman is an MCP server for Claude Code, Cursor, and Codex. It gives the model a set of workflow procedures and a ledger file in your repo. The procedures make the model plan with you, write a spec, hand each piece of code to a worker subagent, inspect and test the worker's output, and record a verdict. The ledger refuses verdicts and phase gates that skip steps. Phase and unit status lives in `Docs/.foreman-ledger.json`, so a later session resumes from that file instead of from chat history.

## Install

Node.js 22 or newer. Download the `.tgz` from the [latest release](https://github.com/malindarathnayake/Foreman/releases/latest), then:

```bash
npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

The tarball bundles its runtime dependencies, so after the download npm installs it without contacting a registry.

Register it with Claude Code, then confirm the host sees it:

```bash
claude mcp add --scope user foreman -- foreman-mcp
claude mcp get foreman
```

Start Claude Code in the repo you want to work on and paste this as your first message:

```text
Use the Foreman MCP server. Call session_orient first, then call design_partner
with this context: "Design <feature>. Inspect the current repository and do not
implement it yet."
```

The host shows the calls it makes, for example `mcp__foreman__session_orient`. On a fresh repo `session_orient` answers `status: no_phases_yet` and `action: plan_project`.

<details>
<summary><b>Cursor, Codex, Windows, and editing the JSON by hand</b></summary>

Claude Code stores user-scope servers in `~/.claude.json` and project-scope servers in `.mcp.json`. The equivalent of the command above:

```json
{ "mcpServers": { "foreman": { "command": "foreman-mcp" } } }
```

Cursor reads `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`, and needs the host flag:

```json
{ "mcpServers": { "foreman": { "command": "foreman-mcp", "args": ["--host=cursor"] } } }
```

Codex reads `~/.codex/config.toml` or the project's `.codex/config.toml`:

```toml
[mcp_servers.foreman]
command = "foreman-mcp"
args = ["--host=codex"]
```

On Windows the npm shim is a `.cmd` file, so wrap the command:

```json
{ "mcpServers": { "foreman": { "command": "cmd", "args": ["/c", "foreman-mcp"] } } }
```

Add `"--host=cursor"` or `"--host=codex"` after `"foreman-mcp"` for those hosts. The host must start the MCP process with your repo as the working directory. State paths are resolved from there, and a wrong directory means the ledger is written somewhere else.

Verify with the host's own MCP list, then ask the model to call `host_status` and `bundle_status`. Full page: [Register your host](https://malindarathnayake.github.io/Foreman/getting-started/configure-mcp-host).

</details>

<details>
<summary><b>Installing from GitHub Packages instead</b></summary>

The package is also published to GitHub Packages as `@malindarathnayake/foreman-mcp`. That path needs a token with `read:packages` even for public packages and a scoped `.npmrc`. Steps: [Installation](https://malindarathnayake.github.io/Foreman/getting-started/installation).

</details>

## The protocols

A protocol is a tool that returns a procedure to the model. The model follows it for the rest of the session. Use one per session; that is a convention, not something the server enforces. Ask the model to call `session_orient` at the start of every session, including the first.

```text
design_partner        new feature or unclear requirements; asks you questions, writes Docs/design-summary.md
spec_generator        turns an approved design summary into spec, handoff, progress, and test documents
pitboss_implementor   implements a spec unit by unit through worker subagents
lighttask             one small change, edited directly, validated, recorded
spec_man              writes a spec of intended or as-implemented behavior from an existing repo
doc_man               writes documentation from the code and labels what it cannot verify
```

<details>
<summary><b>What happens when you use it</b></summary>

1. **`design_partner`** asks 5 to 8 scoping questions and stops for your answers. When the blocking ones are settled it writes `Docs/design-summary.md` and asks you to approve it.
2. **`spec_generator`** reads the approved summary and writes four files in `Docs/`: `spec.md` (phases and units, each with a directive), `handoff.md` (session-start and recovery instructions), `PROGRESS.md` (checklist and decisions), and `testing-harness.md` (test tiers and commands). It seeds the ledger with every phase and unit.
3. **`pitboss_implementor`** works one unit at a time. The procedure tells the model to read the unit directive, build a brief for a worker, record the delegation in the ledger, start a worker subagent in your host, inspect every changed file, run the unit's test command, and record a pass or a rejection. A rejected unit goes to a fresh worker with the rejection history. After three failed attempts since the unit last passed, the ledger refuses another attempt, and a pass, without your override.
4. **At the end of a phase** the procedure sends the changes to outside reviewers. On Claude Code those are the Codex CLI and Gemini CLI, if installed. Findings are classified and recorded. The ledger refuses to close the phase while a review carries a confirmed finding, until the fix is re-verdicted and a fresh review shows it resolved. Then the procedure tells you to start a new session.
5. **Next session**, `session_orient` reads the ledger and returns the action and target: `implement_unit p2/u3`, `retry_phase_gate`, or `complete`. A unit that was in progress when the session stopped is restarted, not resumed mid-edit.

Normal implementation units are delegated. The model edits directly only under `lighttask`, or under the implementor's Direct Fix rule, which allows a literal substitution after a rejection and nothing else.

</details>

<details>
<summary><b>What the ledger refuses, and what stays a procedure</b></summary>

`lib/ledger.ts` validates every write to the ledger. It rejects:

| Write | Refused unless |
|---|---|
| Delegating a unit | a brief of 20+ characters and a preflight attestation are included |
| A pass verdict | a delegation was recorded first; after a rejection, a fix attempt was recorded after it (a worker delegation or a direct fix); on a phase with no tests, a written attestation of how it was checked |
| Another attempt, or a pass, after three failed attempts since the unit last passed | you decide once with `authorize_attempts`, or set `user_override` on the write; either is recorded on the unit |
| Closing a phase after a fix | an independent review, or a verification record with evidence for a direct fix, postdates the re-verdict; a cross-examination record never counts |
| A review finding | it carries a classification: confirmed, rejected, or unverified |
| Closing a phase | every unit passed, every declared unit is registered, a review was recorded after the latest verdict, and no such review carries a confirmed finding, is partial, or is silent without an examined list; `user_override` waives the review conditions and is recorded on the phase |
| A rejection on a passed unit | never refused; it reopens the unit to pending |

Those are checks on the ledger's own records. The ledger cannot see whether the model actually read a file or ran a test. Reading changed files, running the test command, comparing against the spec, and reviewing are obligations in the procedure text. The full split: [What Foreman enforces](https://malindarathnayake.github.io/Foreman/enforcement/what-foreman-enforces).

</details>

<details>
<summary><b>Files it creates</b></summary>

Everything lands under `Docs/` in your repo.

| File | Written by | Purpose |
|---|---|---|
| `design-summary.md` | design_partner | The approved design |
| `spec.md` | spec_generator | Phases, units, directives, error handling, test commands |
| `handoff.md` | spec_generator | How to start and resume implementation |
| `PROGRESS.md` | spec_generator, then write_progress | Checklist between fence markers is rendered from the ledger; text outside the fences is yours |
| `testing-harness.md` | spec_generator | Test tiers and commands |
| `.foreman-ledger.json` | write_ledger only | Unit status, verdicts, delegation history, rejections, reviews, gates. Read by `session_orient` and the phase gate |
| `.foreman-progress.json` | write_progress | The data behind the checklist. Descriptive only |
| `.foreman-journal.json` | write_journal | Friction log: failures, retries, delays, overrides |
| `.foreman-events.jsonl` | invoke_worker | Hash-chained event log; only when that tool is used |

Commit them or ignore them; both work. Tracked state lets another person resume from the ledger. The spec generator runs `git check-ignore` on these paths and records the result in `handoff.md` as `state_tracking_policy`.

</details>

<details>
<summary><b>What it costs</b></summary>

Every unit is a brief, a worker run, a file inspection, a test run, and a verdict. Every phase adds a review round. For a one-file change that is overhead with no payoff. Use `lighttask`, or skip Foreman for that change. Details: [What Foreman is](https://malindarathnayake.github.io/Foreman/#when-to-skip-it).

</details>

<details>
<summary><b>What can leave your machine</b></summary>

Reviews spawn the Codex, Gemini, or Claude CLI as child processes; each uses its own provider login. One experimental tool, `invoke_worker`, sends a brief and file excerpts to an endpoint you configure. Optional Langfuse tracing sends review metadata. Nothing else makes a network call. Read [SECURITY.md](SECURITY.md) and [Security](https://malindarathnayake.github.io/Foreman/reference/privacy-and-security) before enabling it.

</details>

## Documentation

Full docs: [malindarathnayake.github.io/Foreman](https://malindarathnayake.github.io/Foreman/)

- [First project](https://malindarathnayake.github.io/Foreman/getting-started/start-a-project), a walkthrough with the calls and the files that appear
- [A unit's life](https://malindarathnayake.github.io/Foreman/how-it-works/unit-life) and [Phase gates and reviews](https://malindarathnayake.github.io/Foreman/how-it-works/phase-gates)
- [What Foreman enforces](https://malindarathnayake.github.io/Foreman/enforcement/what-foreman-enforces)
- [Every tool](https://malindarathnayake.github.io/Foreman/reference/tool-surface)

## Project

**Current release:** `v0.6.12` | **Package:** `@malindarathnayake/foreman-mcp` | **Runtime:** Node.js `>=22`

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Host capability contract](foreman-mcp/HOST-CONTRACT.md)
- [Machine-readable onboarding](llms.txt)
- [Development](https://malindarathnayake.github.io/Foreman/contributing/development)

## License

[Apache-2.0](LICENSE) Copyright 2026 Malinda Rathnayake
