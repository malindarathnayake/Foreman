---
id: installation
title: Installation
sidebar_label: Installation
description: Install Foreman from GitHub Packages or an offline release tarball.
---

# Installation

Foreman requires Node.js 22 or newer.

## GitHub Packages

Add the package scope to `~/.npmrc` or the project `.npmrc`:

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

## Release tarball

Download the `.tgz` from the [latest GitHub release](https://github.com/malindarathnayake/Foreman/releases/latest), then install it without registry authentication. As of 0.5.8 the tarball bundles all runtime dependencies, so it installs fully offline — no registry or DNS access required:

```bash
npm install -g malindarathnayake-foreman-mcp-<version>.tgz
foreman-mcp --version
```

## Verifying the install

`foreman-mcp --diag` prints local runtime and host diagnostics. The server itself uses MCP over stdio; it is not a daemon to launch in a separate terminal.

## Windows long paths

On Windows, long dependency paths can exceed `MAX_PATH`. If installation fails for that reason, enable Windows long paths and run `git config --system core.longpaths true` from an elevated shell.

## Next

Continue to [configuring an MCP host](./configure-mcp-host.md).
