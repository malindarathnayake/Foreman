---
id: upgrading
title: Upgrading from 0.4.x
sidebar_label: Upgrading from 0.4.x
description: Archiving older personal Layer-1 ethos overrides so they do not shadow the bundled protocols.
---

# Upgrading from 0.4.x

If you installed older personal Layer-1 ethos files, archive rather than delete `~/.claude/engineering-ethos.md` and the Foreman skill overrides under `~/.claude/skills/`. Remove or update any `~/.claude/CLAUDE.md` pointers to those files, then use the bundled `ethos` tool.

User overrides take precedence over bundled skills, so a stale override can silently shadow the current protocol. See [skill override precedence](../reference/architecture.md#skill-override-precedence).
