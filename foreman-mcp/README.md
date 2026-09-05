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
