# @malindarathnayake/foreman-mcp

Foreman is an MCP server for Claude Code, Cursor, and Codex. It gives the model a set of workflow procedures and a ledger file in your repo; the ledger refuses verdicts and phase gates that skip steps.

Install from the release tarball (bundles its runtime dependencies, no registry login needed):

```bash
npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

Register it with your host, then ask the model to call `session_orient`:

```bash
claude mcp add --scope user foreman -- foreman-mcp
```

Full README, install options, and docs: https://github.com/malindarathnayake/Foreman and https://malindarathnayake.github.io/Foreman/

License: Apache-2.0.

In `--host=codex` mode, workers and reviews use native Codex subagents. Complete native reviewer/verifier evidence can satisfy phase gates without extra CLIs. At major checkpoints, the existing Claude/Gemini tools add whichever advisors are available; missing optional providers do not require an override.

Foreman also supports a declared model rank: report `env.model` and `env.effort` at journal startup. Astra at High or above and Fable 5.1 receive bounded worker reuse, compact correction briefs, focused intermediate validation and independently verified delta review; Opus and Terra receive mechanical worker reuse and compact briefs. Unknown models use normal protocol. Workers, ownership guards, recorded attempts and checkpoint gates remain required. See the [host contract](HOST-CONTRACT.md#declared-workflow-rank).
