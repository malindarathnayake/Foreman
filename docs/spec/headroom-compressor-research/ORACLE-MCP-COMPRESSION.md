<!-- spec-man:v1 -->

# Oracle-Schema MCP — Compression Integration (Quick Proposal)

## Status

draft (proposal; companion to [SPEC.md](./SPEC.md) and the arch-council design summary)

## Problem

oracle-schema-mcp tool results are dominated by JSON row arrays (`run_query`, `sample_data`, `dba_performance`) and large structured schema dumps (`get_schema`, `get_table_details`). These land verbatim in the consuming agent's context. Row arrays are exactly the content type headroom's SmartCrusher compresses 83–90% (benchmarks: 100-item JSON array 3,163 → 297 tokens). Today the only mitigation is hard row caps (`maxRows`), which throw data away irreversibly.

## Why oracle MCP over (or alongside) Foreman

- Payload shape: row arrays are SmartCrusher's native target; Foreman's payloads are mostly prose/logs.
- Volume evidence: real Foreman jobs on larger projects (intelihub_main/CICD/Docs) produce `.foreman-ledger.json` 58 KB (~14k tokens), `.foreman-progress.json` 35 KB, journal 9.5 KB — so Foreman benefits too, but a single unbounded `run_query` can exceed all of those in one call.
- Same stack: oracle-schema-mcp is Node (`@modelcontextprotocol/sdk` + `zod` + `oracledb`), so the TypeScript subsystem designed in the council report imports directly. No new runtime.

## Architecture

Build the compression subsystem once, as a standalone package (or vendored lib) shared by both servers:

```
context-compression (lifted from headroom, per council design)
├── detect / router / acceptance (0.85→0.65 byte-pressure gate)
├── smartCrusher / logCompressor / diffCompressor
├── ccrStore (in-memory, SHA-256 first-24, <<ccr:HASH>>, TTL 300s)
└── retrieve_original MCP tool factory
        ├── consumed by foreman-mcp        (run_tests, invoke_advisor, read_ledger)
        └── consumed by oracle-schema-mcp  (this doc)
```

Council-settled decisions inherited unchanged: Node-native SHA-256; retrieval via dedicated `retrieve_original {hash}` tool; sentinel object appended INSIDE crushed arrays (`{"_ccr_dropped": "<<ccr:HASH>>"}`) so results stay valid JSON; vendored headroom parity fixtures with legacy markers normalized; Apache-2.0 attribution carried in NOTICE.

## Per-tool strategy map

| Oracle tool | Strategy | Notes |
|---|---|---|
| `run_query`, `sample_data` | SmartCrusher | Row arrays; keep first/last K + anomalies + errors; sentinel carries CCR hash. Replaces lossy `maxRows` truncation as the primary guard |
| `dba_performance` | SmartCrusher | Diagnostic row sets; numeric-variance retention is a natural fit (outliers are the signal) |
| `get_schema`, `search_schema`, `get_table_details`, `get_relationships` | SmartCrusher (arrays only) | Recursive walk; crush column/index lists past threshold, never the table identity fields |
| `search_dump` | Search compressor (phase 2) | grep-shaped output; no upstream parity fixtures yet |
| `get_ddl`, `get_object_source`, `dump_source`, `read_dump_range` | EXCLUDE | Byte-exact source/DDL; same rule as Foreman's Read/Edit exclusion — compressing breaks copy-paste and diffing |
| `explain_plan`, `table_stats`, `help`, `oracle_guide` | Passthrough | Small or instructional |
| `search_confluence` | Passthrough (v1) | Prose; meaningful text compression needs ML (out of scope) |

## Safety rules

- MUST NOT compress excluded tools (DDL/source) under any pressure level.
- MUST keep error rows and anomalous numeric rows during crush (headroom retention guarantees).
- MUST return the exact original from `retrieve_original`; on TTL expiry return deterministic `ccr_missing_or_expired` — the agent can simply re-run the query.
- SHOULD set CCR TTL ≥ the typical analysis loop (default 300 s; env-overridable as in headroom's `HEADROOM_CCR_TTL_SECONDS` pattern).
- Read-only server invariant unaffected: compression touches responses only, never SQL.

## Rollout

1. Build shared lib + fixtures (already planned for Foreman lift).
2. Wire into oracle-schema-mcp behind a flag, default off.
3. Enable `sample_data` + `run_query` first (highest volume, lowest risk — sentinel-in-array).
4. Enable schema tools after array-walk behavior is proven.
5. Phase 2: `search_dump` via search compressor with self-recorded fixtures.

## Open questions

- [UNRESOLVED] Whether to publish the shared lib as a package or vendor it into both repos (oracle_mcp ships .tgz releases; vendoring may suit its supply-chain posture given Socket/semgrep scanning).
- [UNRESOLVED] Interaction with existing `maxRows` caps: keep caps as hard ceiling and compress below it, or raise caps once compression lands.
- [UNRESOLVED] oracle-schema-mcp is plain JS; decide whether the shared lib ships compiled JS + d.ts (likely) or the server migrates the consuming module to TS.
