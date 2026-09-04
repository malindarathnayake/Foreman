---
id: upgrading
title: Upgrading
sidebar_label: Upgrading
description: How to replace a release, what to verify afterwards, and which releases changed ledger behavior.
---

# Upgrading

## Procedure

1. Install the new tarball over the old one: `npm install -g ./malindarathnayake-foreman-mcp-<version>.tgz`.
2. Restart the host. A running session keeps its old server process for as long as it lives.
3. Verify: `foreman-mcp --version`, then in the host ask for `bundle_status` and `host_status`. `bundle_status` prints `running_version` and `runtime_disk_version`; when they differ it says `restart_recommended: true`, which means the host is still talking to the old process. It also lists any skill shadowed by an override. Check the tool count against [Register your host](../getting-started/configure-mcp-host.md).

## Overrides that shadow the upgrade

A file at `.claude/skills/<name>/SKILL.md` or `~/.claude/skills/<name>/SKILL.md` replaces the bundled procedure of the same name under every host profile. After an upgrade the bundled procedure changes and the override does not. Symptoms: the model does not know about a field the changelog says exists, or `write_ledger` refuses a call the procedure told it to make. `bundle_status` says `override` when one is active. Archive the override somewhere outside those paths, restart the host, and check `bundle_status` again.

Older personal ethos files: if you installed a `~/.claude/engineering-ethos.md` and skill overrides for it in the 0.4.x era, archive them and use the bundled `ethos` tool; the overrides were shadowing newer protocols.

## Ledger compatibility

Ledger changes are additive. An older ledger loads under a newer server; fields it lacks are treated as absent, and the behaviors below apply from the first write after the upgrade.

| Release | What changed for existing projects |
|---|---|
| 0.5.0 | Added `v_ts`, `inconclusive` verdicts, rejection attempt stamps, gate staleness hash, secret scrubbing on write, the external-worker events file, `invoke_worker` |
| 0.5.5 | `aider_worker` |
| 0.5.11 | `declare_phase_units`; a gate now refuses while a declared id is unregistered |
| 0.5.12 | `invoke_council`; optional Langfuse tracing |
| 0.5.13 | Shared-tree worker safety in the procedures; paged `read_ledger` |
| 0.6.0 | A gate refuses with no recorded review; a rejection on a passed unit reopens it; `first_pass_ts`; natural ordering in `session_orient`; `record_review` gains `completion`, `checked`, `limitations`, `stage`. Existing projects: the next gate needs a `record_review` |
| 0.6.1 | `set_unit_status s:'delegated'` refuses without `preflight`; schema errors become one hint per field; journal codes `SPEC_GAP` and `GATE_OVERRIDE`; `run_tests` output shaping. Existing projects: the next delegation needs the preflight object |
| 0.6.2 | A gate refuses while a review recorded since the latest verdict carries a `confirmed` finding, or is partial, failed, or silent with no `checked` list; a review that predates a re-verdict no longer satisfies the review requirement. Data shapes moved into the input schema. Journal `msg` limit 400. `gofmt` and `golangci-lint` in the `run_tests` allowlist with `fail_on_stdout`. `aider_worker` worktrees created with `core.autocrlf=false`. Existing projects: a phase with an old confirmed finding needs a fresh review after the fix, and a zero-finding review needs `checked` or `completion: complete` |

Tools added along the way: `invoke_worker` (0.5.0), `aider_worker` (0.5.5), `invoke_council` (0.5.12), `codex_agents_init` (Codex profile). None removed.
