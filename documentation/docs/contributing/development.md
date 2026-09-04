---
id: development
title: Development
sidebar_label: Development
description: Build, test, and package Foreman the same way CI and the release workflow do.
---

# Development

## The server

```bash
git clone https://github.com/malindarathnayake/Foreman.git
cd Foreman/foreman-mcp
npm ci
npm run build              # tsc, then copies preview assets, docs, and the aider harness into dist/
npm test                   # vitest, 44 files, about a minute
npx tsc --noEmit           # types only
node scripts/publish-smoke.mjs
```

Expected: build clean, every test file passing, and the smoke script ending with `publish smoke check PASSED`.

What `publish-smoke.mjs` proves, in order: `dist/server.js` exists; `npm pack` produces exactly one tarball; that tarball installs with `npm install --offline` into a scratch directory, so nothing in it needs a registry; the generated bin shim starts; the server answers `initialize` and `tools/list` over stdio; and the tool list matches the expected default-host set exactly. It is the same gate the release workflow runs before attaching the tarball.

On Windows, point npm's cache into the workspace if the global cache returns `EPERM`:

```bash
npm_config_cache="$(pwd)/.npm-cache" node scripts/publish-smoke.mjs
```

## Source layout

```text
foreman-mcp/src/server.ts       tool registration, descriptions, CLI flags
foreman-mcp/src/tools/          one handler per tool
foreman-mcp/src/lib/            ledger validation, journal, progress, redaction, host profiles, worker and CLI plumbing
foreman-mcp/src/skills/         the six procedures plus _common-protocol.md and _assists.md
foreman-mcp/src/docs/           the ethos document
foreman-mcp/tests/              vitest; integration tests start the server in-process over an in-memory transport
foreman-mcp/scripts/            publish-smoke.mjs, copy-assets.mjs, aider_harness.py
foreman-mcp/HOST-CONTRACT.md    ships in the tarball
```

## Testing a host profile

`createServer({ host: "cursor" })` in a test renders that profile. The integration suite does this for every host and asserts the rendered procedures contain no unresolved placeholders. Skill line-count ceilings live in `tests/skillTrimming.test.ts`; raise one only with a comment saying what grew.

## Documentation site

```bash
cd documentation
npm ci
npm start              # dev server with hot reload
npm run typecheck
npm run build          # production build into documentation/build; broken links fail the build
```

## Workflows

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | every push and pull request | install, build, test, publish smoke |
| `build.yml` | a `v*` tag | build, smoke, pack, attach the tarball to the GitHub release, publish to GitHub Packages |
| `docs.yml` | changes under `documentation/` | build and deploy the site |
| `security.yml` | push, pull request, weekly | dependency audit, CodeQL, gitleaks |

## References

- [Host capability contract](https://github.com/malindarathnayake/Foreman/blob/main/foreman-mcp/HOST-CONTRACT.md)
- [Security policy](https://github.com/malindarathnayake/Foreman/blob/main/SECURITY.md)
- [Changelog](https://github.com/malindarathnayake/Foreman/blob/main/CHANGELOG.md)
- [Machine-readable onboarding](https://github.com/malindarathnayake/Foreman/blob/main/llms.txt)
