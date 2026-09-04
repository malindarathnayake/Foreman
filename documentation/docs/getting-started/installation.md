---
id: installation
title: Install
sidebar_label: Install
description: Install the release tarball, verify the binary, and know what to do when the command is not found.
---

# Install

Node.js 22 or newer. Check with `node --version`.

## From the release tarball

1. Download `malindarathnayake-foreman-mcp-<version>.tgz` from the [latest release](https://github.com/malindarathnayake/Foreman/releases/latest).
2. Install it globally:

```bash
npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

Expected output: `Foreman v<version>`.

The tarball bundles its runtime dependencies (`bundleDependencies` in `package.json`), so after the download npm installs it without contacting a registry. The release workflow proves that before publishing: it installs the packed tarball with `npm install --offline` into a scratch directory, spawns the bin shim, and checks `tools/list` over MCP.

## Verify

```bash
foreman-mcp --diag
```

Trimmed output from a real install:

```text
── Runtime ──
  node                 v22.16.0
  platform             win32 x64
  entry                …\node_modules\@malindarathnayake\foreman-mcp\dist\server.js

── Package ──
  name                 @malindarathnayake/foreman-mcp
  version              0.6.3

── MCP SDK ──
  server SDK version   2.0.0

── Skills ──
  skill files          design-partner.md, doc-man.md, implementor.md, lighttask.md, spec-generator.md, spec-man.md
```

The server speaks MCP over stdio. Running `foreman-mcp` with no flags in a terminal waits on stdin; that is not a hang. The host starts and stops the process.

## From GitHub Packages

The same package is published to GitHub Packages. That path needs a token with `read:packages`, even for a public package, and a scoped `.npmrc`:

```text
@malindarathnayake:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

```bash
npm install -g @malindarathnayake/foreman-mcp
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `foreman-mcp: command not found` | npm's global bin directory is not on `PATH` | `npm prefix -g` prints the prefix. Add `<prefix>/bin` on Linux and macOS, or the prefix itself on Windows, to `PATH` |
| Host reports the server exited immediately (Windows) | The global install created `foreman-mcp.cmd`, and the host spawned it without a shell | Register it as `cmd /c foreman-mcp`. See [Register your host](./configure-mcp-host.md) |
| `--version` prints an old version after reinstalling | A running host session keeps its old server process | Restart the host |

Next: [Register your host](./configure-mcp-host.md).
