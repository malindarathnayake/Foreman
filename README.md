<p align="center">
  <img src="https://raw.githubusercontent.com/malindarathnayake/Foreman/main/assets/banner.jpg" alt="Foreman" width="800" />
</p>

<p align="center">
  <a href="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/Foreman/actions/workflows/build.yml/badge.svg" alt="Build and Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js >= 22" /></a>
</p>

# Foreman

## A spec-to-code harness for AI-assisted software development

Foreman is a local, ledger-backed coding harness that takes a real repository from clarified intent through design and executable specification to delegated implementation, recorded validation, and resumable completion.

A frontier model occupies the **pitboss** seat. It works with you on the design, converts approved decisions into bounded implementation units, delegates those units to workers, inspects and tests their output, rejects bad work, and closes phase gates. Foreman supplies the operating protocols, durable project state, and mechanical checks that keep that process coherent across models and sessions.

```text
intent / existing repository
            |
      design_partner
            |
      approved design
            |
       spec_generator
            |
 spec + handoff + tests + progress
            |
   pitboss_implementor
            |
 bounded unit -> worker -> inspect -> test -> review -> phase gate
            |                                      |
            +----------- ledger / journal ---------+
```

**Models generate code. Foreman controls the job.**

Foreman is not another general-purpose agent framework, and it does not replace your coding host, repository tools, or CI. It controls the development lifecycle across them.

**Current release:** `v0.5.9` | **Package:** `@malindarathnayake/foreman-mcp` | **Runtime:** Node.js `>=22` | **License:** Apache-2.0

**Quickstart:** [Install](#install) → [Configure an MCP host](#configure-an-mcp-host) → [Start a project](#start-a-project). Already installed? Point your MCP host at `foreman-mcp` with the right `--host` flag and call `session_orient`.

---

## Not another agent framework

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

## Forged in real development

Foreman grew out of delivering and maintaining real systems across **Java, Go, C#, C++, Python, and React**.

Those runs exposed the same failures repeatedly:

- a long session drifted away from the approved design
- a worker received too much context, solved the wrong problem, or timed out halfway through it
- the agent that wrote a defect reviewed and defended its own work
- "all tests pass" existed only as a sentence in chat
- a new session reconstructed implementation status from a compacted conversation
- cheaper models were asked to make project-level decisions they were not equipped to make

Foreman turns those failures into an explicit lifecycle. A frontier model is used where judgment matters. Bounded implementation can be delegated to smaller, local, or remote workers. Recorded verdicts, review findings, failures, and evidence explicitly written to Foreman state survive outside the context window. Raw test output remains the host's responsibility unless it is recorded.

In one real Java REST API delivery, Foreman carried an approved design into a seven-phase implementation. Reviews caught scope, validation-order, and database-filter defects. The run recovered from worker timeouts, reran focused Gradle validation, and resumed from recorded state instead of replaying chat history. That is the class of work Foreman exists to control.

Foreman's own releases use the same pipeline. This repository contains the actual [design summary](docs/design-summary.md), [implementation spec](docs/spec.md), [handoff](docs/handoff.md), [progress record](docs/PROGRESS.md), and [testing harness](docs/testing-harness.md) used for its multi-phase development. They are working artifacts, not sample templates.

## What "coding harness" means

A coding model edits files. A coding harness controls the development lifecycle around those edits.

| Seat | Responsibility |
|---|---|
| **User** | Owns product intent, scope decisions, overrides, and final authority |
| **Pitboss** | Frontier model that grounds the plan, scopes units, delegates work, validates results, and owns acceptance |
| **Foreman** | Supplies protocols, canonical state, evidence records, recovery, and mechanical gates |
| **Workers** | Host-native agents or configured worker backends that implement one bounded unit |
| **Advisors** | Separate reviewer seats used for design deliberation and checkpoint review |
| **Repository tools** | Compilers, tests, linters, and build commands that provide observable validation evidence |

During a phased implementation, the pitboss is kept out of product-code edits by protocol so its context remains available for integration and review. Workers receive a narrow brief and return a completion report or patch. The pitboss then re-reads the changed files, runs the repository's checks, compares the result with the specification, and records the verdict.

Under the protocol, workers do not accept their own units; the pitboss owns the verdict. The patch-worker tools cannot write verdicts. Worker engines are replaceable, while Foreman remains the authority for project state and completion.

## The development lifecycle

### 1. Design with the repository in the room

`design_partner` clarifies the problem, inspects the current system, exposes architectural and security decisions, records decisions and rationale, and produces `Docs/design-summary.md` for user approval.

The design is collaborative. Foreman does not silently convert unresolved questions into implementation assumptions.

### 2. Turn decisions into an executable spec

`spec_generator` converts the approved design into:

```text
Docs/spec.md              behavior, contracts, phases, and bounded units
Docs/handoff.md           session-start and recovery instructions
Docs/PROGRESS.md          human-readable implementation state
Docs/testing-harness.md   validation strategy and commands
```

Dependencies, ordering, unit scope, and phase checkpoints are explicit before code is written.

### 3. Delegate bounded implementation

`pitboss_implementor` grounds the next unit against the live repository and creates the smallest brief that can be implemented and tested independently. The worker gets the unit, relevant source context, constraints, and expected completion-report shape. It does not need to own the project plan.

### 4. Inspect, test, and reject

Worker claims are inputs, not verdicts. The protocol requires the pitboss to inspect the actual files, run focused validation, check specification fidelity and integration seams, and re-delegate concrete fixes when the work is wrong.

Independent advisor output can be normalized, classified, cited, and recorded at design or phase boundaries. When an independent seat is unavailable, the protocol records that limitation instead of pretending self-review is independent.

### 5. Gate the phase and resume from disk

Under the protocol, a phase closes only after its units carry passing verdicts and its checkpoint is accepted. The protocol then calls for a context reset before the next phase. `session_orient` reconstructs ledger state, so a fresh session does not have to infer reality from chat history.

## Protocols

Activate one protocol for the job in the current session:

| Protocol | Use it for | Primary output |
|---|---|---|
| `lighttask` | A small, grounded change that can be completed directly | `Docs/lighttask.md` |
| `design_partner` | New behavior, unclear requirements, or architectural decisions | `Docs/design-summary.md` |
| `spec_generator` | Turning an approved design into implementation-ready documents | Spec, handoff, progress, and testing documents |
| `pitboss_implementor` | Multi-unit implementation from prepared specs | Implementation plus ledger-backed validation evidence |
| `spec_man` | Recovering or re-evaluating intended behavior in an existing repository | Human and machine-readable specifications |
| `doc_man` | Producing grounded technical documentation | README, architecture, data-flow, or other requested docs |

```text
small clear change       -> lighttask
unclear existing system  -> spec_man
new feature              -> design_partner -> spec_generator -> pitboss_implementor
prepared multi-unit spec -> pitboss_implementor
technical documentation -> doc_man
```

The protocols are inspectable bundled Markdown rendered for the active host. They can be overridden per project or per user.

## What Foreman enforces

Foreman deliberately separates **protocol obligations** from **mechanical enforcement**.

The protocols direct the pitboss to ground briefs, keep implementation in worker seats, inspect changes, run the right tests, perform review, and reset context at phase boundaries. Host-native isolation and compliance with those instructions depend on the host and model.

The MCP server enforces the parts that can be checked deterministically:

- a unit cannot receive a passing verdict before a recorded delegation with a brief of at least 20 characters
- a phase cannot pass while any unit lacks a passing verdict, and an empty phase cannot pass
- a pass without tests or a build requires an attestation of at least 5 words and 32 characters
- a fourth delegation after three distinct rejected attempts requires an explicit user override
- a passed gate becomes stale when one of its units changes afterward
- phases marked `hot_path` or `security_boundary` require a declared frontier-class seat or explicit override
- external-worker sidecar outcomes cannot contradict the ledger's claimed result without blocking the gate
- a corrupt ledger reports itself instead of silently appearing to be a fresh project

Example refusals:

```text
VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation.

PHASE GATE BLOCKED: phase 'P2' has units without a pass verdict: U5.

ATTESTATION REQUIRED: phase 'P4' declares has_tests:false.
```

These checks are TypeScript code, not instructions that disappear during compaction.

What that looks like mid-session — the pitboss tries to accept its own direct edit, gets blocked, and is forced back into the delegation lane:

```text
pitboss:  write_ledger({ operation: "set_verdict", phase: "P2", unit_id: "U4",
                         data: { v: "pass" } })
foreman:  VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation.
          Call mcp__foreman__pitboss_implementor to load the full protocol.

pitboss:  write_ledger({ operation: "set_unit_status", phase: "P2", unit_id: "U4",
                         data: { s: "delegated", brief: "Add cursor pagination to
                         GET /orders; keep response shape; test: npm t -- orders",
                         tier: "standard", route_reason: "bounded, fully specified" } })
foreman:  ok
          -> worker implements, pitboss re-reads files + runs tests, then records the verdict
```

The honest boundary is equally important: Foreman cannot prove that a model is truthful or that passing tests imply correct software. It proves that declared workflow transitions occurred, preserves evidence explicitly recorded in its state, and makes certain missing or contradictory records visible. A host can skip Foreman entirely; such a run simply produces no Foreman record.

## Worker backends

Foreman supports multiple ways to fill a bounded worker seat:

| Backend | Status | Behavior |
|---|---|---|
| Host-native worker | Primary | The host spawns its own subagent and returns a completion report |
| `invoke_worker` | Experimental | Sends a brief and selected file excerpts to a configured OpenAI-compatible endpoint and returns a checked patch |
| `aider_worker` | Temporary local bridge | Runs Aider in an isolated temporary worktree and returns the computed diff plus base-file hashes |

For patch workers, the protocol requires the host to verify base-file hashes before applying the patch and to record stale bases, application failures, build failures, and review rejections. The tools block malformed patches and protected paths before returning usable output. A patch-worker tool never applies its output to the main working tree and never writes a ledger verdict.

`aider_worker` is not the target worker architecture. It remains a temporary local bridge until Crucible's optional custom/local-model runner is ready. Crucible does not replace host-native Codex or Claude workers and does not own the main pitboss conversation.

The ledger records cost tier, route reason, attempts, and verdicts. External-worker events additionally record the configured capability class, backend, model, and outcome. Configuration chooses the models and worker kinds. Foreman does not autonomously optimize or change that policy during a project.

This is how the harness combines a strong pitboss with smaller local or remote models without giving those workers project-level authority.

**Codex workers:** Codex mode uses native `spawn_agent` subagents — singly or as a parallel fan-out under `agents.max_threads` — and names `gpt-5.6-luna` as the preferred worker seat. The current Codex spawn contract does not expose per-child model selection, so Foreman records the actual model and never claims Luna unless the host confirms it. Parallel fan-out never relaxes the ledger sequence: every unit is delegated before its worker spawns and receives its own independent verdict. Crucible is planned only as an optional deterministic routing boundary for custom/local workers.

## Advisor seats and deliberation

Advisors are independent reviewer seats — models with no stake in the work — used for design deliberation and checkpoint review. They are deliberately drawn from a different vendor than the pitboss: same-family models share training priors and blind spots, so cross-vendor review catches classes of defects that self-review structurally cannot.

When non-trivial ambiguities or checkpoint reviews need resolution, the protocol runs a fixed deliberation loop: both advisors analyze the same questions independently and in parallel; the moderator digests their positions and flags hallucination risk, over-engineering, missing evidence, and sycophancy; the advisors cross-examine each other for at most three rounds; and the result is presented as a consensus or as competing proposals with a moderator recommendation. Non-trivial deadlocks go to the user, and the run does not proceed until the user arbitrates. Advisors never see each other's raw output, never receive the moderator's position first, and never write verdicts — review findings pass through `normalize_review` and `verify_citations` before anything is recorded.

Default seat assignments per host:

| Host | Advisor A | Advisor B | Moderator | Degraded fallback |
|---|---|---|---|---|
| Claude Code | Codex CLI — GPT-5.6 Sol, reasoning `ultra`, read-only sandbox | Gemini CLI — the operator's `arch-review` model profile | The host pitboss model | Opus agents with an adversarial critic prompt |
| Cursor | GPT-5.6 Sol `ultra`, read-only task | Gemini 3.1 Pro, read-only task | The host pitboss model | Sonnet adversarial review, recorded as non-independent |
| Codex | Headless Claude — `claude-fable-5`, effort `max`, tools and session persistence disabled | Gemini CLI | The Codex pitboss | Adversarial self-review, recorded as non-independent |

These assignments come from real project runs, not published benchmarks. In practice across those runs: the Codex/Sol seat has been the strongest reviewer of state machines and protocol invariants; the Gemini seat reads large Java codebases more reliably than the alternatives; and Claude frontier models have been most effective in the moderator seat. A moderator arbitrating two opposing, evidence-cited advisor positions produces sharper judgments than the same model asked to find issues in raw code cold — the structured deliberation transcript is better conditioning material than an unframed diff. That observation is why the protocol requires the moderator to digest and compare advisor positions instead of relaying their output verbatim.

When an advisor seat is unavailable, the run continues with the documented fallback and the ledger records that independent review was unavailable — the weakness is made visible, not papered over.

## Durable state and recovery

State is stored relative to the MCP server's current working directory, which should be the target repository root:

```text
Docs/.foreman-ledger.json     phases, units, delegations, verdicts, gates, reviews
Docs/.foreman-progress.json   compact progress state
Docs/.foreman-journal.json    session history and rollups
Docs/.foreman-events.jsonl    hash-chained external-worker events, when used
Docs/PROGRESS.md              human run log with a ledger-synchronized checklist
```

Do not edit `.foreman-*` state files directly; use Foreman tools so validation and state invariants remain intact. `PROGRESS.md` is the human-facing, protocol-maintained run log.

At the start of a session:

```text
session_orient
read_ledger({ "query": "full" })
read_progress
```

`session_orient` reports the current phase, last completed unit, next pending unit, blockers, stale gates, and unsupported host capabilities. Recovery starts from that state, not from a model's summary of an earlier conversation.

## Install

### GitHub Packages

Foreman requires Node.js 22 or newer. Add the package scope to `~/.npmrc` or the project `.npmrc`:

```text
@malindarathnayake:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

Then install the binary:

```bash
npm install -g @malindarathnayake/foreman-mcp
foreman-mcp --version
```

GitHub Packages requires a token with `read:packages`, including for public packages.

### Release tarball

Download the `.tgz` from the [latest GitHub release](https://github.com/malindarathnayake/Foreman/releases/latest), then install it without registry authentication. As of 0.5.8 the tarball bundles all runtime dependencies, so it installs fully offline — no registry or DNS access required:

```bash
npm install -g malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

`foreman-mcp --diag` prints local runtime and host diagnostics. The server itself uses MCP over stdio; it is not a daemon to launch in a separate terminal.

On Windows, long dependency paths can exceed `MAX_PATH`. If installation fails for that reason, enable Windows long paths and run `git config --system core.longpaths true` from an elevated shell.

## Configure an MCP host

### Claude Code or another Claude-style MCP host

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp"
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "foreman": {
      "command": "foreman-mcp",
      "args": ["--host=cursor"]
    }
  }
}
```

### Codex

Codex uses TOML configuration and must select the native Codex profile explicitly:

```toml
[mcp_servers.foreman]
command = "foreman-mcp"
args = ["--host=codex"]
```

**Codex mode:** Foreman uses native Codex subagents for bounded work. Independent units can run in parallel; Foreman records delegation first, then independently validates each result. Call `codex_agents_init` to create optional explorer/worker roles and concurrency settings without overwriting existing Codex config.

In Codex mode, headless Claude serves as Advisor A and Gemini as Advisor B — see [Advisor seats and deliberation](#advisor-seats-and-deliberation) for the per-host seat assignments and the deliberation loop. Restart Codex after changing MCP configuration or reinstalling Foreman.

<details>
<summary>Codex parallel-worker details</summary>

When a phase batches to N independent units, the pitboss delegates each unit in the ledger, spawns up to `agents.max_threads` (default 6) `spawn_agent` workers at once with `max_depth=1`, waits for all, and validates each unit independently. `codex_agents_init` writes `.codex/agents/explorer.toml` (read-only code mapper), `.codex/agents/worker.toml` (workspace-write implementer), and a `.codex/config.toml` `[agents]` block only when the configuration file is absent.

</details>

### Windows command shim

For the default host:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "cmd",
      "args": ["/c", "foreman-mcp"]
    }
  }
}
```

For Cursor on Windows, preserve the host argument:

```json
{
  "mcpServers": {
    "foreman": {
      "command": "cmd",
      "args": ["/c", "foreman-mcp", "--host=cursor"]
    }
  }
}
```

Host resolution order is `--host=<id>`, then `FOREMAN_HOST`, then `claude-code`. Accepted profiles are `claude-code`, `cursor`, `codex`, and `generic`.

Make sure the host starts the MCP process with the target repository as its working directory. Foreman's state paths and `.foremanenv` are resolved from that directory.

After connecting, call:

```text
host_status
bundle_status
session_orient
```

## Start a project

Use one protocol per session. For a new feature:

```text
Session 1:
design_partner({ "context": "Design the requested feature against this repository. Record unresolved decisions and do not implement it." })

Session 2, after approving the design:
spec_generator({ "context": "Generate the executable implementation documents from Docs/design-summary.md." })

Session 3:
pitboss_implementor({ "context": "Implement the approved spec one bounded unit at a time. Resume from Foreman state." })
```

For a surgical change:

```text
lighttask({ "context": "Ground this change against the current repository, implement it, validate it, and record the result." })
```

Your MCP client may display tool names with a namespace such as `mcp__foreman__design_partner`.

## When Foreman pays for itself

Use Foreman when any of these are true:

- the work spans multiple phases, sessions, or context windows
- architecture and implementation need a durable connection
- multiple models or worker tiers participate
- smaller workers need bounded tasks and stronger supervision
- review findings and failed attempts must survive handoff
- implementation needs to be checked against more than a test exit code
- future-you or another developer must be able to inspect how "done" was reached

The dividing line is context accumulation and coordination risk, not repository size. A difficult single feature can justify the harness; a large mechanical rename might not.

### When to skip it

Skip Foreman when the task is a one-file fix that will finish in one clean session, a throwaway prototype, or work whose history and acceptance evidence have no future value. The protocols add real overhead: procedure context, state calls, review, and phase checkpoints. Do not pay that cost where a focused edit and a test run are enough.

The phased implementor also assumes a strong pitboss. A very small model should not own architecture, cross-unit integration, or security acceptance merely because it is cheap. Use small models in bounded worker seats.

## Mission boundary

Foreman's product is the controlled software-development loop:

```text
design -> spec -> bounded work -> delegated execution
       -> verification -> review -> gated completion -> resume
```

Foreman owns protocol delivery, canonical run state, delegation evidence, acceptance gates, and recovery. Worker engines and host-native agents own bounded code generation. For patch-returning backends, the host owns final patch application. Repository tooling and CI own their respective checks.

Model training, model serving, generic experiment tracking, prompt optimization, and automatic production routing are outside Foreman's mission. Evaluation may qualify a worker configuration, but an evaluation score never overrides tests, scope, security checks, or a Foreman gate.

## Host compatibility

| Host | Status | Important caveat |
|---|---|---|
| Claude Code | Primary profile | Native workers use the host's Agent capability; advisor CLIs are optional |
| Cursor | Rendered profile and tested capability path | No declared autonomy capability; phase progression remains interactive |
| Codex | Native subagent profile with parallel fan-out | `spawn_agent` model selection is host-owned; Luna is preferred but only confirmed routing may be recorded. Fan-out is capped by `agents.max_threads` with `max_depth=1`. Claude Fable 5 max and Gemini provide independent review |
| Generic MCP host | Declared six-capability contract | The operator must verify the host against [HOST-CONTRACT.md](foreman-mcp/HOST-CONTRACT.md) |

Unsupported capabilities are reported by `host_status` and `session_orient` with their documented degradation.

## Tool surface

The default server exposes 26 MCP tools. `retrieve_original` is omitted when output compression is disabled, reducing the live surface to 25. Codex mode adds `codex_agents_init`, raising its surface to 27.

**Protocol activation:** `design_partner`, `spec_generator`, `pitboss_implementor`, `lighttask`, `spec_man`, `doc_man`

**State and metadata:** `session_orient`, `read_ledger`, `write_ledger`, `read_progress`, `write_progress`, `read_journal`, `write_journal`, `bundle_status`, `host_status`, `changelog`, `ethos`

**Execution and review:** `capability_check`, `invoke_advisor`, `invoke_worker`, `aider_worker`, `run_tests`, `normalize_review`, `verify_citations`, `retrieve_original`, `preview_diagram`

**Host-specific:** `codex_agents_init` (codex host only) — writes `.codex/agents/` role TOMLs and the `[agents]` concurrency config for parallel fan-out

Notable supporting behavior:

- large test or failed-advisor output can be compressed with a recoverable `<<ccr:HASH>>` marker; call `retrieve_original` before acting when the digest is insufficient
- Codex-mode Claude review runs headless `claude-fable-5` at `max` effort, with tools and session persistence disabled; the observed CLI version is telemetry only
- `preview_diagram` serves a token-protected Mermaid preview on loopback only
- `run_tests` uses an allowlist; its defaults are `npm`, `pytest`, `go`, `cargo`, `dotnet`, and `make`
- other repository commands, including Gradle, Maven, CMake, or CTest, can be executed through the host shell and recorded as validation evidence

See [llms.txt](llms.txt) for the compact machine-readable tool contract.

## Privacy and security boundaries

Foreman's ledger, progress, journal, and metrics remain local. Foreman has no usage-telemetry service.

Network and process boundaries are explicit:

- `preview_diagram` is Foreman's only listener and binds to loopback
- `invoke_worker` sends the selected brief and file excerpts to the endpoint configured by the operator
- `invoke_advisor` launches the installed Claude, Codex, or Gemini CLI, which uses that provider's own network and authentication
- `aider_worker` launches the installed Python/Aider process and uses the endpoint configured for that worker tier
- the host model's own traffic never passes through Foreman and cannot be filtered by it

`.foremanenv` must be gitignored and untracked. Foreman refuses both configured worker paths otherwise. Known configured secrets are blocked from outbound worker payloads and scrubbed from Foreman-owned durable artifacts. Read the full [security policy](SECURITY.md), including residual risks and reporting instructions, before enabling external worker endpoints.

## Architecture

```text
TypeScript ESM
@modelcontextprotocol/sdk
Zod validation
stdio transport
2 external production dependencies + 1 bundled first-party compression package
```

Skill override precedence:

```text
.claude/skills/<skill-name>/SKILL.md     project override
~/.claude/skills/<skill-name>/SKILL.md   user override
bundled skill                            package default
```

The `FOREMAN_STACK_PROFILE` setting or `Docs/foreman-stack-profile.md` can supply repository-specific security-framework and telemetry-backend conventions without forking the core protocols.

## Development

```bash
git clone https://github.com/malindarathnayake/Foreman.git
cd Foreman/foreman-mcp
npm ci
npm run build
npm test
node scripts/publish-smoke.mjs
```

```text
foreman-mcp/src/server.ts       MCP server and tool registration
foreman-mcp/src/tools/          tool handlers
foreman-mcp/src/lib/            ledger, state, host, worker, and CLI helpers
foreman-mcp/src/skills/         bundled coding protocols
foreman-mcp/tests/              Vitest suite
```

Useful references:

- [Machine-readable onboarding](llms.txt)
- [Host capability contract](foreman-mcp/HOST-CONTRACT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Compression benchmarks](docs/compression-benchmarks.md)

## Upgrading from 0.4.x

If you installed older personal Layer-1 ethos files, archive rather than delete `~/.claude/engineering-ethos.md` and the Foreman skill overrides under `~/.claude/skills/`. Remove or update any `~/.claude/CLAUDE.md` pointers to those files, then use the bundled `ethos` tool. User overrides take precedence over bundled skills, so a stale override can silently shadow the current protocol.

## License

[Apache-2.0](LICENSE) Copyright 2026 Malinda Rathnayake
