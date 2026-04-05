## Design Summary - Foreman MCP

### Problem
You want to ship a reusable workflow that combines project planning and foreman-style implementation orchestration without asking users to hand-manage raw skill files. It should reuse the existing Claude Code architecture for code understanding, subagents, tasks, skills, plugins, and MCP instead of rebuilding those primitives.

### Approach
Ship this as an MCP-owned workflow bundle, with the skill contract and the helper tools versioned together in the same MCP surface.

Design the workflow core so it can be adapted to Codex too. The durable concepts here are not Anthropic-specific:

- prompt/skill entrypoints
- tool-gated file and shell access
- subagents / worker orchestration
- MCP-backed structured helpers
- durable plan and progress artifacts on disk

Claude Code already has a real MCP skill path:

- MCP prompts become command entries
- MCP skills are discovered from `skill://` resources
- MCP skill changes are refreshed on `resources/list_changed`

That means the cleanest design is:

- the Foreman MCP bundle is the canonical source of the planner and implementor skill bodies
- the same MCP bundle exposes the helper tools those skills rely on
- an optional plugin or installer can exist purely to register/configure the MCP server and add UX niceties
- any local launcher skill should stay thin and stable, not carry the evolving workflow logic

The MCP server provides both the user-facing entrypoints and the structured helper operations that are awkward to express as plain prompt text:

- ledger read/write helpers
- plan/progress file discovery
- environment capability checks for external CLIs
- normalized review result ingestion
- bundle/version reconciliation

The user-facing invocation still stays skill-first, but the skill itself can now be delivered by MCP. When Claude Code MCP skill discovery is available, there is no reason for the mutable planner or implementor contract to live in hand-managed local `SKILL.md` files.

### Key Decisions
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Distribution | MCP-owned bundle, optional plugin/bootstrap wrapper | One update surface is the main goal. The MCP bundle can carry both the workflow contract and its helper tools, while a plugin can remain optional for install UX. |
| MCP role | Canonical workflow surface plus helper tools | The planner and implementor skills should evolve with the same bundle that owns ledger, checkpoint, and capability helpers. |
| Skill naming | Use MCP skill namespaces | This matches the host's existing `<server>:<skill>` MCP skill convention. |
| Portability | Shared workflow core plus CLI-specific adapters | Claude Code and Codex expose similar primitives, so the workflow logic should stay portable while integration glue stays thin and local to each CLI. |
| Code-understanding strategy | Reuse Claude Code primitives | `attachments.ts`, read/search tools, `Explore` agent, `Plan` agent, task tools, and `SkillTool` already solve most context-gathering needs. |
| Versioning | Track both MCP bundle version and per-skill version | The MCP bundle is the thing being updated. Per-skill version still tells the LLM whether the workflow contract itself is stale. |
| MCP response format | Use TOON-style compact text in v1 | Most Foreman responses are small state objects, summaries, or nested records. TOON-like key/value + table output is a better default, and v1 should avoid format branching until benchmarks justify it. |
| Planning council | Multi-agent first, external CLI reviewers opportunistic | If Codex/Gemini are available, use them. If not, fall back to in-process planner/critic agents so the workflow still works. |
| Foreman review model | Fresh worker agents plus independent verifier/reviewer | This preserves the desired separation-of-concerns and avoids self-review bias. |
| Persistence | `Docs/PROGRESS.md`, `Docs/.foreman-ledger.yaml`, handoff/spec docs | The workflow needs durable state across sessions and phase boundaries. |
| Core integration point | MCP-delivered skills invoking existing tools and a small MCP tool surface | Lowest-friction way to get a single update surface without rebuilding Claude Code core behavior. |
| MCP implementation style | Fit it to Claude Code’s actual extension seams | Because we have the source, we can mirror real tool, command, task, and AppState conventions instead of guessing. |

### Recommendation Matrix
| Option | Fit | Why |
|--------|-----|-----|
| MCP only | High | Best fit if the main requirement is one update surface for both workflow prompt and helper tooling. |
| Plugin only | Medium | Easier to start, but it keeps the mutable workflow contract in local files and weakens the update story. |
| MCP-owned bundle + optional plugin/bootstrap installer | Highest | MCP owns the evolving contract; an optional plugin only handles registration, discovery, or user-facing convenience. |
| New built-in core tool | Low initially | Higher maintenance and review surface. Only worth it after the workflow proves itself as a plugin. |

### Architecture
```text
User
  -> CLI adapter (Claude Code first, Codex later)
  -> MCP skill (`foreman:project-planner` or `foreman:implementor`)
  -> existing Claude Code tools
       - SkillTool
       - AgentTool / TeamCreateTool / SendMessageTool
       - TaskCreate / TaskList / TaskUpdate
       - FileRead / Grep / Glob / Bash
  -> same MCP server's helper tools (`mcp__foreman__*`)
       - ledger ops
       - capability detection
       - review result normalization
       - checkpoint/state helpers
       - skill/bundle version checks
  -> optional plugin/bootstrap
       - registers the MCP server
       - adds optional status/resume UX
  -> durable docs
       - Docs/spec.md
       - Docs/handoff.md
       - Docs/PROGRESS.md
       - Docs/.foreman-ledger.yaml
  -> user arbitration on disputed decisions or review findings
```

### Runtime Surfaces
| Surface | Entrypoint | Shared Core | Notes |
|---------|------------|-------------|-------|
| Planner workflow | MCP skill `foreman:project-planner` | Agent/team/task tools + read/search/context stack | Produces plan, design summary, and handoff artifacts. |
| Implementor workflow | MCP skill `foreman:implementor` | Agent/team/task tools + ledger/progress helpers | Orchestrates workers, validation, and checkpoints. |
| MCP helpers | same MCP server | ledger/progress/capability helper functions | Consumed by the workflow skills via `mcp__foreman__*` tools. |
| Optional bootstrap UX | plugin commands or thin local launcher skills | same shared helpers | Useful for install, status, resume, or environments that want a stable local entrypoint. |
| Codex adapter | Codex MCP registration plus thin launcher if needed | same workflow documents and MCP helper contracts | Should mirror Claude Code behavior where the platform primitives line up. |

### Fallback Deliberation Modes
| Environment | Behavior |
|-------------|----------|
| Codex CLI and Gemini CLI available | External architecture council plus local moderator. |
| One external CLI available | One external advisor plus one in-process critic/planner agent. |
| No external CLIs available | Two or three in-process planner/critic agents debate; user arbitrates. |

### Persistence / Recovery
| Artifact | Writer | Reader / Recovery Path | Notes |
|----------|--------|------------------------|-------|
| `Docs/spec.md` | planner/spec-generator phase | planner + foreman | Intent and behavioral contract. |
| `Docs/handoff.md` | planner/spec-generator phase | foreman | Per-unit implementation instructions. |
| `Docs/PROGRESS.md` | foreman | foreman on resume | Human-readable checkpoint state. |
| `Docs/.foreman-ledger.yaml` | foreman + optional MCP helpers | foreman on resume | Durable machine-readable verdicts, rejections, and phase gates. |

### Integration Points
| System | Protocol | Auth | Discovery Status |
|--------|----------|------|------------------|
| Plugin loader | local files via `plugin.json` and plugin dirs | local trust / plugin policy | VERIFIED |
| Skill loader | markdown-backed prompt commands | local trust / plugin policy | VERIFIED |
| Skill version metadata | skill frontmatter -> command model | local file trust | VERIFIED |
| MCP client | stdio / SSE / HTTP / websocket | per-server auth | VERIFIED |
| MCP skill discovery | `skill://` resources -> MCP skills in command model | per-server auth | VERIFIED in call paths and comments, though the concrete loader file is absent in this checkout |
| MCP server entrypoint template | `src/entrypoints/mcp.ts` | local process trust | VERIFIED as a starting pattern |
| Agent/swarm runtime | built-in tools and AppState tasks | runtime permissions | VERIFIED |
| External reviewers | CLI executable detection | local environment | UNVERIFIED in this repo, but easy to probe at runtime |

### Reuse-First Context Strategy
Do not build a new retrieval/indexing stack first.

Use these existing layers:

- `src/utils/attachments.ts` for plan, task, file, memory, skill, and MCP-resource injection
- `src/tools/FileReadTool`, `src/tools/GrepTool`, `src/tools/GlobTool`, and `src/tools/BashTool` for grounded code inspection
- `src/tools/AgentTool/built-in/exploreAgent.ts` for fast read-only exploration
- `src/tools/AgentTool/built-in/planAgent.ts` for read-only planning
- `src/tools/AgentTool/built-in/verificationAgent.ts` for adversarial implementation review
- `src/tools/TaskCreateTool`, `src/tools/TaskListTool`, and `src/tools/TaskUpdateTool` for coordination state

That keeps the workflow aligned with how Claude Code already understands repos and manages context.

The versioning primitive already exists in the host runtime:

- skill/command frontmatter supports `version`
- loaders preserve that into the command model

So the Foreman bundle should reuse that field rather than inventing a second prompt-version metadata format.

### Response Serialization Policy
Do not default to JSON for MCP helper responses unless the shape is genuinely nested and irregular.

Use this output policy:

| Response Shape | Format | Why |
|----------------|--------|-----|
| Small status objects (`bundle_status`, `update_bundle`, checkpoint results) | compact TOON-style key/value lines | Cheap, readable, and avoids JSON punctuation overhead. |
| Medium uniform lists (`units`, `tasks`, `rejections`, changelog entries) | TOON table | Column names declared once; still self-describing. |
| Deeply nested or irregular data | JSON or markdown blocks | Compression tricks hurt more than they help here. |

For Foreman specifically:

- `mcp__foreman__bundle_status`: compact key/value output
- `mcp__foreman__list_units`: TOON table
- `mcp__foreman__list_rejections`: TOON table
- `mcp__foreman__changelog`: TOON table
- `mcp__foreman__get_unit_context`: structured markdown or JSON, because the payload is nested

Important constraint:

- TOON or pipe-delimited output reduces tool-result tokens.
- It does **not** materially reduce tool-schema metadata cost.

To reduce tool metadata cost, keep the MCP surface small:

- prefer a few broad tools over many narrow ones
- keep descriptions short and literal
- avoid duplicating semantics across multiple tools
- encode optional detail in arguments, not in extra tool count

For now, do not standardize a second compact format in the design. If later benchmarks show that TOON is leaving meaningful savings on the table for one or two specific high-volume responses, that can be introduced as a measured v2 change.

### Contract Tracing
| Contract | Direct Callers | Reader / Executor Path | Notes |
|----------|----------------|------------------------|-------|
| MCP skill invocation | slash command or `SkillTool` | `resources/list` -> MCP skill loading -> `appState.mcp.commands` -> prompt body -> existing tools | Best primary surface when you want the MCP bundle to own the mutable workflow contract. |
| Optional thin launcher | slash command or local skill | local command metadata -> handoff to MCP skill or MCP tool | Useful only for bootstrap UX or compatibility shims. |
| MCP helper invocation | workflow skill / model tool call | `services/mcp/client.ts` -> `appState.mcp.tools` -> `MCPTool` | Best for structured ledger/status/capability helpers, exposed as `mcp__foreman__*`. |
| Skill version reconciliation | workflow skill start hook / first tool call | local command metadata + `mcp__foreman__bundle_status` | Lets the skill decide whether it should continue, warn, or request update. |
| Team debate / worker orchestration | workflow skill via `AgentTool` / `TeamCreateTool` | `spawnMultiAgent.ts` / `spawnInProcess.ts` / `inProcessRunner.ts` | Already supports in-process teammates, messaging, and plan-mode gating. |
| Plan approval | teammate exits plan mode | `ExitPlanModeV2Tool` -> mailbox/AppState approval flow | Existing contract for "argue, then ask user to arbitrate." |

### Versioning / Update Protocol
Use a two-level version model, with the MCP bundle as the canonical source of truth.

| Level | Purpose | Source of Truth |
|-------|---------|-----------------|
| MCP bundle version | package/install/update lifecycle | MCP server bundle metadata |
| Skill version | prompt/workflow contract version | `version:` in each MCP skill frontmatter |

Recommended MCP helper tools:

- `mcp__foreman__bundle_status`
  - returns installed bundle version, canonical bundle version, per-skill versions, compatibility flags, and whether an update is recommended
- `mcp__foreman__update_bundle`
  - updates the installed Foreman bundle and refreshes the skill/tool contract together
- `mcp__foreman__changelog`
  - returns human-readable upgrade notes for the LLM to summarize

Recommended startup flow for each Foreman skill:

1. Read its exposed `version` from MCP skill command metadata.
2. Call `mcp__foreman__bundle_status`.
3. If versions match, proceed.
4. If the skill is stale but compatible, tell the user an update is available and offer to run it.
5. If the skill is stale and incompatible, stop normal execution and require update first.
6. After update, the LLM resumes using the new skill/bundle contract.

This gives you the behavior you want:

- the MCP bundle can ship the canonical skill contract
- the skill and its helper tooling evolve together
- any optional local launcher can stay nearly static
- the LLM can be told, in structured form, whether it should continue or update
- Codex and Claude Code can share the same version/reconciliation logic

### Config Surface
| Setting | Type | Source | Default |
|---------|------|--------|---------|
| `foreman.use_external_reviewers` | boolean | bootstrap/plugin settings | `true` |
| `foreman.external_reviewers` | string[] | bootstrap/plugin settings | `["codex","gemini"]` |
| `foreman.default_worker_model` | string | bootstrap/plugin settings | inherit repo default |
| `foreman.default_planner_model` | string | bootstrap/plugin settings | inherit repo default |
| `foreman.ledger_path` | string | bootstrap/plugin settings | `Docs/.foreman-ledger.yaml` |
| `foreman.docs_dir` | string | bootstrap/plugin settings | `Docs` |
| `foreman.mcp_transport` | string | bootstrap/plugin settings | `stdio` |
| `foreman.min_supported_skill_version` | string | MCP bundle status result | current bundle policy |

### Error Handling
| Scenario | Behavior |
|----------|----------|
| External reviewer CLI missing | Fall back to in-process planner/critic/verifier agents and report the downgrade. |
| MCP workflow server unavailable | Thin launchers or bootstrap commands should report the workflow as unavailable rather than silently falling back to stale local prompt logic. |
| Ledger file missing | Create it on first run. |
| Ledger conflicts with disk | Disk wins; repair ledger and note it in progress/summary. |
| Planner agents disagree | Summarize competing proposals and require user arbitration. |
| Worker fails repeatedly | Escalate with rejection history and stop automatic retries at the configured ceiling. |

### Observability
- Task list and teammate status are the primary live execution UI.
- Ledger entries are the durable audit trail.
- Planner and Foreman summaries should explicitly report which fallback path was used: external CLIs, subagents only, or mixed.
- MCP helper failures should be surfaced as degraded-mode notices, not silent skips.

### Testing Strategy
- Build the workflow first as an MCP bundle with fixture docs and a fake ledger.
- Add integration tests for MCP skill discovery, tool exposure, and agent/tool orchestration boundaries.
- If a plugin/bootstrap wrapper exists, keep its tests narrow and focused on registration and UX only.
- Add fallback-path tests: external CLIs present, one missing, all missing.
- Add ledger round-trip tests for create, resume, conflict repair, and rejection history.
- Only consider a built-in core tool after the MCP workflow proves stable.

### Scope
In scope:
- MCP-owned planner + Foreman workflow
- subagent debate fallback
- optional bootstrap plugin or thin launcher
- durable ledger/progress integration
- reuse of Claude Code’s existing context/tooling stack

Out of scope:
- replacing Claude Code’s built-in context system
- a brand-new core retrieval/indexing service
- promoting this to a built-in core tool on the first iteration

Phase 2 candidates:
- richer plugin UI/status commands
- marketplace packaging
- external-reviewer adapters beyond Codex/Gemini
- automated remediation brief generation from rejected reviews
- first-class Codex adapter with the same ledger and debate contracts

### Open Items
| Item | Status | Blocking |
|------|--------|----------|
| Whether a bootstrap plugin is needed at all, or whether MCP skill discovery alone is enough | Open | No |
| Exact optional MCP helper API shape | Open | No |
| Whether to store planner debate transcripts in ledger or only final summary | Open | No |
| Whether Foreman should use team/swarm teammates or disposable background agents by default | Open | No |
| The concrete `src/skills/mcpSkills.ts/js` implementation file is absent in this checkout, even though the surrounding call paths clearly reference it | Open | No |
