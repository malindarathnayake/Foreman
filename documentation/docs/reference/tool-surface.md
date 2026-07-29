---
id: tool-surface
title: Tool surface
sidebar_label: Tool surface
description: The MCP tools Foreman exposes, grouped by role, plus notable supporting behavior.
---

# Tool surface

The default server exposes 26 MCP tools. `retrieve_original` is omitted when output compression is disabled, reducing the live surface to 25. Codex mode adds `codex_agents_init`, raising its surface to 27.

On MCP SDK v2, every tool advertises a top-level display title, a strict JSON Schema 2020-12 input contract, and a validated scalar output schema. Results retain their existing text content and also provide `structuredContent`; the SDK projects scalar output into the legacy object envelope automatically for 2025-era clients.

## Protocol activation

`design_partner`, `spec_generator`, `pitboss_implementor`, `lighttask`, `spec_man`, `doc_man`

## State and metadata

`session_orient`, `read_ledger`, `write_ledger`, `read_progress`, `write_progress`, `read_journal`, `write_journal`, `bundle_status`, `host_status`, `changelog`, `ethos`

## Execution and review

`capability_check`, `invoke_advisor`, `invoke_worker`, `aider_worker`, `run_tests`, `normalize_review`, `verify_citations`, `retrieve_original`, `preview_diagram`

## Host-specific

`codex_agents_init` (codex host only) — writes `.codex/agents/` role TOMLs and the `[agents]` concurrency config for parallel fan-out

## Notable supporting behavior

- large test or failed-advisor output can be compressed with a recoverable `<<ccr:HASH>>` marker; call `retrieve_original` before acting when the digest is insufficient
- Codex-mode Claude review runs headless `claude-fable-5` at `max` effort, with tools and session persistence disabled; the observed CLI version is telemetry only
- `preview_diagram` serves a token-protected Mermaid preview on loopback only
- `run_tests` uses an allowlist; its defaults are `npm`, `pytest`, `go`, `cargo`, `dotnet`, and `make`
- other repository commands, including Gradle, Maven, CMake, or CTest, can be executed through the host shell and recorded as validation evidence

See [llms.txt](https://github.com/malindarathnayake/Foreman/blob/main/llms.txt) for the compact machine-readable tool contract.
