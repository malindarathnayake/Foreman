<!-- spec-man:v1 -->

# Headroom Compressor Subsystem — Implementation Spec (External Repo Research)

## Status

implemented (implementation spec of an external repo, recorded for Foreman_2 lift evaluation)

Repo under study: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom` (not a Foreman_2 component). All paths below are relative to that repo root unless absolute.

## Scope

In:
- Compressor implementations, selection/dispatch, chaining, thresholds
- CCR (Compress-Cache-Retrieve) reversibility and TTL interplay
- Cache-safety invariants (live zone, auth-mode gating)
- Learn mode / TOIN adaptation
- Rust/Python split and parity strategy
- Lift candidates for Foreman_2

Out:
- Proxy networking internals, SSE streaming, billing/subscription handling
- Image compression details, dashboard, install tooling

## System Overview

[OBSERVED] Headroom is a context-compression layer between agents and LLM APIs; it compresses tool outputs, logs, RAG chunks, files, and conversation history before they reach the model.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/README.md:40` `compresses everything your AI agent reads`

[OBSERVED] Marketing header claims 60–95% token reduction via 6 algorithms, deployable as library, proxy, agent wrap, or MCP server, with reversible compression.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/README.md:11` `6 algorithms · local-first · reversible`

[OBSERVED] Claimed real-workload savings, e.g. code search 17,765 → 1,408 tokens (92%).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/README.md:110` `| Code search (100 results)`

## Compressor Inventory

| ID | Compressor | File (headroom/) | Target content | Algorithm summary | Source |
|---|---|---|---|---|---|
| C1 | CodeAwareCompressor | `transforms/code_compressor.py` | Source code (8 languages) | tree-sitter AST; preserves imports/signatures; compresses ranked function bodies | [OBSERVED] |
| C2 | SmartCrusher | `transforms/smart_crusher.py` | JSON arrays / structured tool output | dedupe + variance filtering + importance scoring; schema-preserving | [OBSERVED] |
| C3 | SearchCompressor | `transforms/search_compressor.py` | grep/ripgrep results | relevance scoring, error boost, keep top-N + first/last | [OBSERVED] (Rust-backed) |
| C4 | LogCompressor | `transforms/log_compressor.py` | Build/test logs | stack-trace detection; level-weighted line scoring; dedupe warnings | [OBSERVED] (Rust-backed) |
| C5 | DiffCompressor | `transforms/diff_compressor.py` | Unified git diffs | hunk parsing; keep additions/deletions; cap context lines and hunks | [OBSERVED] (Rust-backed) |
| C6 | KompressCompressor | `transforms/kompress_compressor.py` | Plain text / unknown | ModernBERT token-classifier (ONNX) predicts keep/drop per token | [OBSERVED] |
| C7 | HTMLExtractor | (trafilatura, conditional) | HTML | main-text extraction, drops boilerplate | [UNVERIFIED] agent-reported, not line-verified |

Key per-compressor thresholds (defaults):

| ID | Requirement | Source | Verification |
|---|---|---|---|
| T1 | SmartCrusher MUST skip inputs under 200 tokens. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/smart_crusher.py:169` `min_tokens_to_crush: int = 200` | [OBSERVED] | config read |
| T2 | SmartCrusher MUST NOT keep more than 15 items after crush. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/smart_crusher.py:173` `max_items_after_crush: int = 15` | [OBSERVED] | config read |
| T3 | CodeAware MUST skip inputs under 100 tokens. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/code_compressor.py:373` `min_tokens_for_compression: int = 100` | [OBSERVED] | config read |
| T4 | CodeAware SHOULD fall back to Kompress for unknown languages. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/code_compressor.py:377` `fallback_to_kompress: bool = True` | [OBSERVED] | config read |
| T5 | Router MUST skip blocks under 500 chars. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:487` `min_chars_for_block_compression: int = 500` | [OBSERVED] | config read |

## Selection and Dispatch

[OBSERVED] ContentRouter detects content type (Rust detector chain: Magika → unidiff parser → plaintext fallback) and maps each `ContentType` to a `CompressionStrategy` via a static mapping.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:1045` `def _strategy_from_detection(self, detection: Any) -> CompressionStrategy:`

[OBSERVED] Unmatched content types route to a configurable fallback strategy.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:1064` `strategy = mapping.get(detection.content_type, self.config.fallback_strategy)`

[OBSERVED] The default fallback strategy is Kompress (ML text compressor).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:454` `fallback_strategy: CompressionStrategy = CompressionStrategy.KOMPRESS`

[UNVERIFIED] Mixed content (2+ detected types in one block) is split into sections and each section routed independently (agent-reported; `is_mixed_content` / `split_into_sections` around content_router.py:533-620, not line-verified).

## Chaining and Fallback

Fallback chains (agent-traced in `_apply_strategy_to_content`, content_router.py ~1191-1349; chain membership [UNVERIFIED] at line level, behavior consistent with T4 and the fallback_strategy default):

- CODE_AWARE → Kompress when AST compression yields nothing
- SMART_CRUSHER → Kompress when result equals original (no savings)
- KOMPRESS → passthrough when model unavailable or no savings
- All strategies record a `strategy_chain` for observability

## Adaptive Acceptance Thresholds

[OBSERVED] Acceptance ratio is pressure-adaptive: when context is mostly empty, compression must keep ≤85% of tokens to be accepted; near-full, ≤65%.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:501` `min_ratio_relaxed: float = 0.85`
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:502` `min_ratio_aggressive: float = 0.65`

[OBSERVED] An in-process two-tier compression cache (skip-set + result cache) defaults to a 30-minute TTL.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:209` `def __init__(self, ttl_seconds: int = 1800):`

## CCR: Compress-Cache-Retrieve (Reversibility)

[OBSERVED] Design intent: nothing is permanently lost; originals are cached locally and the LLM can retrieve them on demand.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/docs/content/docs/ccr.mdx:8` `Nothing is ever thrown away`

[OBSERVED] CCR storage is abstracted behind a `CcrStore` trait (in-memory, SQLite, Redis backends).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/src/ccr/mod.rs:40` `pub trait CcrStore: Send + Sync {`

[OBSERVED] CCR keys are BLAKE3 hashes of the payload.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/src/ccr/mod.rs:70` `let h = blake3::hash(payload);`

[OBSERVED] Compressed blocks carry a stable retrieval marker of the form `<<ccr:HASH>>`.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/src/ccr/mod.rs:82` `format!("<<ccr:{hash}>>")`

TTL model:

| ID | Requirement | Source |
|---|---|---|
| TTL1 | CCR originals MUST be retained 300 s by default. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/config.py:422` `store_ttl_seconds: int = 300  # Cache TTL in seconds` | [OBSERVED] |
| TTL2 | CCR TTL MAY be overridden via environment for long agent runs. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/cache/compression_store.py:57` `CCR_TTL_SECONDS_ENV = "HEADROOM_CCR_TTL_SECONDS"` | [OBSERVED] |
| TTL3 | CodeAware CCR entries default to a 300 s TTL. Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/code_compressor.py:384` `ccr_ttl: int = 300  # 5 minutes` | [OBSERVED] |

## Cache-Safety Invariants (Prompt-Cache Aware)

[OBSERVED] The Rust live-zone dispatcher only mutates message content above a `frozen_message_count` floor; everything below is treated as inside the provider prompt cache and is never touched.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/src/transforms/live_zone.rs:348` `Block is in a message at index`

[OBSERVED] Compression aggressiveness is gated by an auth-mode policy enum (Payg / OAuth / Subscription).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/src/auth_mode.rs:41` `pub enum AuthMode {`

[OBSERVED] In Subscription mode, TOIN telemetry becomes read-only (no writes during request handling).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/transforms/content_router.py:833` `if policy is not None and policy.toin_read_only:`

[OBSERVED] Tools whose outputs must remain byte-exact (Read, Glob, Grep, Write, Edit, Bash) are excluded from compression by default.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/config.py:211` `DEFAULT_EXCLUDE_TOOLS: frozenset[str] = frozenset(`

[OBSERVED] Cache optimizer only considers blocks of ≥1024 tokens cacheable.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/headroom/config.py:385` `min_cacheable_tokens: int = 1024`

[UNVERIFIED] Ten architecture invariants (byte-faithful passthrough via RawValue, determinism, token-aware fallback when compressed ≥ original tokens, position preservation, sacrosanct signature/encrypted fields) are documented in `REALIGNMENT/02-architecture.md` (agent-reported, not line-verified).

## Learn Mode and TOIN

[OBSERVED] Learn mode's core mechanism is success correlation: it finds what the model did to fix each failure, rather than cataloging failures.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/wiki/learn.md:40` `finds what the model did to fix each failure`

[UNVERIFIED] Learn pipeline: agent-specific log plugins (Claude Code / Codex / Gemini CLI) → session analyzer (LLM digest) → writes corrections to CLAUDE.md / AGENTS.md / GEMINI.md. TOIN (Tool Output Importance Network) records every compression and CCR retrieval to bias future keep-decisions toward frequently retrieved content (agent-reported; `telemetry/toin.py`, `learn/analyzer.py`).

## Rust/Python Split

[OBSERVED] Rust (`headroom-core`) is the canonical home for compression transform types.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-core/Cargo.toml:8` `Core Headroom types and compression transform traits (Rust).`

[OBSERVED] Python calls Rust compressors in-process via PyO3, releasing the GIL during compression.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-py/src/lib.rs:712` `py.allow_threads(|| self.inner.crush(&content, &query, bias));`

[OBSERVED] A parity harness replays JSON fixtures recorded from the Python implementation against the Rust port to lock behavior during migration.
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-parity/src/lib.rs:1` `load JSON fixtures recorded from the Python implementation,`

[OBSERVED] The Rust proxy classifies compressible endpoints per provider (Anthropic messages, OpenAI chat/responses).
Evidence: `/Users/malinda.rathnayake/Coding_Workspace/Github_P/headroom/crates/headroom-proxy/src/compression/mod.rs:81` `Some(CompressibleEndpoint::AnthropicMessages),`

## Open Questions

- [UNRESOLVED] Exact fallback-chain line evidence in `_apply_strategy_to_content` (content_router.py ~1191-1349) not line-verified; verify before porting chain semantics.
- [UNRESOLVED] Kompress ONNX model licensing/size constraints if Foreman_2 were to adopt the ML text compressor.
- [UNRESOLVED] Whether `claude_analysis_ttl.py` conclusions (5 m vs 1 h cache-write strategies by idle-gap bucket) fed into a shipped feature or remain analysis-only.

## Lift Candidates for Foreman_2 (Assessment)

Ranked by value-to-effort for Foreman_2's pipeline (worker outputs, ledger/journal payloads, advisor transcripts):

| Rank | Pattern | Why it fits Foreman_2 | Effort |
|---|---|---|---|
| 1 | Content-type router → strategy mapping with configurable fallback (Selection and Dispatch above) | Foreman workers emit logs, diffs, JSON, search results — exactly headroom's content taxonomy | Low: it is a dispatch table + detectors |
| 2 | CCR marker + store (`<<ccr:HASH>>`, BLAKE3 key, TTL store) | Reversible truncation of ledger/journal/tool payloads with on-demand retrieval beats lossy truncation | Low-medium |
| 3 | Pressure-adaptive acceptance ratio (0.85 relaxed → 0.65 aggressive) | Compress harder only as context fills; avoids degrading quality early in a session | Low |
| 4 | Tool exclusion list (Read/Edit/Grep byte-exact outputs never compressed) | Same failure mode exists in Foreman pitboss/worker loops (Edit old_string matching) | Trivial: config frozenset |
| 5 | Frozen-floor / live-zone rule (never mutate below prompt-cache boundary) | Critical if Foreman_2 ever rewrites history in cached Anthropic conversations | Medium: needs cache-boundary tracking |
| 6 | Parity-fixture harness for any Rust/Python port | Reusable migration QA pattern | Low |
| 7 | TOIN-style retrieval feedback (keep more of what gets retrieved) | Valuable but requires telemetry plumbing | High |

Stop point per spec-man: specification and assessment only; no implementation performed.
