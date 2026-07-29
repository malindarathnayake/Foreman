---
id: worker-backends
title: Worker backends
sidebar_label: Worker backends
description: Host-native subagents, patch workers, and the local Aider bridge.
---

# Worker backends

Foreman supports multiple ways to fill a bounded worker seat:

| Backend | Status | Behavior |
|---|---|---|
| Host-native worker | Primary | The host spawns its own subagent and returns a completion report |
| `invoke_worker` | Experimental | Sends a brief and selected file excerpts to a configured OpenAI-compatible endpoint and returns a checked patch |
| `aider_worker` | Temporary local bridge | Runs Aider in an isolated temporary worktree and returns the computed diff plus base-file hashes |

For patch workers, the protocol requires the host to verify base-file hashes before applying the patch and to record stale bases, application failures, build failures, and review rejections. The tools block malformed patches and protected paths before returning usable output. A patch-worker tool never applies its output to the main working tree and never writes a ledger verdict.

`aider_worker` is not the target worker architecture. It remains a temporary local bridge until Crucible's optional custom/local-model runner is ready. Crucible does not replace host-native Codex or Claude workers and does not own the main pitboss conversation.

The ledger records cost tier, route reason, attempts, and verdicts. External-worker events additionally record the configured capability class, backend, model, and outcome. Configuration chooses the models and worker kinds. Foreman does not autonomously optimize or change that policy during a project.

This is how the harness combines a strong pitboss with smaller local or remote models without giving those workers project-level authority.

## Codex workers

Codex mode uses native `spawn_agent` subagents — singly or as a parallel fan-out under `agents.max_threads` — and names `gpt-5.6-luna` as the preferred worker seat. The current Codex spawn contract does not expose per-child model selection, so Foreman records the actual model and never claims Luna unless the host confirms it. Parallel fan-out never relaxes the ledger sequence: every unit is delegated before its worker spawns and receives its own independent verdict. Crucible is planned only as an optional deterministic routing boundary for custom/local workers.
