# @malindarathnayake/foreman-mcp

Foreman is an MCP server for Claude Code, Cursor, Codex, and the Antigravity CLI (`agy`). It gives the model a set of workflow procedures and a ledger file in your repo; the ledger refuses verdicts and phase gates that skip steps.

Install from the release tarball (bundles its runtime dependencies, no registry login needed):

```bash
npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

Register it with your host, then ask the model to call `session_orient`:

```bash
claude mcp add --scope user foreman -- foreman-mcp
# Antigravity CLI (verified on agy 1.5.11):
agy mcp add -e FOREMAN_HOST=antigravity foreman -- foreman-mcp --host=antigravity
```

Full README, install options, and docs: https://github.com/malindarathnayake/Foreman and https://malindarathnayake.github.io/Foreman/

License: Apache-2.0.

In `--host=codex` mode, workers and reviews use native Codex subagents. Complete native reviewer/verifier evidence can satisfy phase gates without extra CLIs. At major checkpoints, the existing Claude/Gemini tools add whichever advisors are available; missing optional providers do not require an override.

In `--host=antigravity` mode (agy 1.5.11), `antigravity_agents_init` writes the seats to `.agents/agents/` and a bootstrap rule to `.agents/rules/foreman.md`. Seats use tier words (`flash` for cheap and standard, `pro` for premium and frontier), and workers spawn through `invoke_subagent` with no `Model`. Native review is the default gate path; the advisors are Claude and Codex, and `cli:'gemini'` is same-vendor perspective there. There is no `workflow` tool on this host.

Foreman includes `foreman-design-panel`, `foreman-design-gauntlet`, `foreman-checkpoint-review` and `foreman-triage`. On Codex and Cursor, `workflow { name, mode: 'describe' }` returns phases, roles, agent estimates and cost without requiring args; `workflow { name, args }` returns the native procedure. On Claude Code, `claude_workflows_init` installs the existing scripts into `.claude/workflows/`. Generic and Antigravity hosts have no workflow tool. Each run is user-approved and never implements or writes the ledger; aggregate reviews are `stage:'fan'`, with external advisor receipts kept separate. See the [host contract](HOST-CONTRACT.md#saved-workflows).

Foreman also supports a declared model rank: report `env.model` and `env.effort` at journal startup. Astra at High or above and Fable 5.1 receive bounded worker reuse, compact correction briefs, focused intermediate validation and independently verified delta review; Opus and Terra receive mechanical worker reuse and compact briefs. Unknown models use normal protocol. Workers, ownership guards, recorded attempts and checkpoint gates remain required. See the [host contract](HOST-CONTRACT.md#declared-workflow-rank).
