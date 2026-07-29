---
id: development
title: Development
sidebar_label: Development
description: Build, test, and smoke-check Foreman from source.
---

# Development

```bash
git clone https://github.com/malindarathnayake/Foreman.git
cd Foreman/foreman-mcp
npm ci
npm run build
npm test
node scripts/publish-smoke.mjs
```

## Source layout

```text
foreman-mcp/src/server.ts       MCP server and tool registration
foreman-mcp/src/tools/          tool handlers
foreman-mcp/src/lib/            ledger, state, host, worker, and CLI helpers
foreman-mcp/src/skills/         bundled coding protocols
foreman-mcp/tests/              Vitest suite
```

## Documentation site

This site lives in `documentation/` and is built with Docusaurus:

```bash
cd documentation
npm ci
npm start          # local dev server with hot reload
npm run build      # production build into documentation/build
```

## Useful references

- [Machine-readable onboarding](https://github.com/malindarathnayake/Foreman/blob/main/llms.txt)
- [Host capability contract](https://github.com/malindarathnayake/Foreman/blob/main/foreman-mcp/HOST-CONTRACT.md)
- [Security policy](https://github.com/malindarathnayake/Foreman/blob/main/SECURITY.md)
- [Changelog](https://github.com/malindarathnayake/Foreman/blob/main/CHANGELOG.md)
- [Compression benchmarks](https://github.com/malindarathnayake/Foreman/blob/main/docs/compression-benchmarks.md)
