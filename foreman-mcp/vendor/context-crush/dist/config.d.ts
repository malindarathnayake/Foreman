import type { Clock, CompressionResult } from "./types.js";
export declare const MAX_INPUT_BYTES = 10485760;
/**
 * Mirror of Python SmartCrusherConfig dataclass — all 15 dataclass fields mirrored verbatim.
 * Note: `use_feedback_hints` and `toin_confidence_threshold` are accepted for fixture
 * compatibility but INERT — the TOIN feedback subsystem is not ported to TypeScript.
 */
export interface SmartCrusherConfig {
    enabled: boolean;
    min_tokens_to_crush: number;
    min_items_to_analyze: number;
    max_items_after_crush: number;
    first_fraction: number;
    last_fraction: number;
    dedup_identical_items: boolean;
    preserve_change_points: boolean;
    factor_out_constants: boolean;
    include_summaries: boolean;
    variance_threshold: number;
    uniqueness_threshold: number;
    similarity_threshold: number;
    use_feedback_hints: boolean;
    toin_confidence_threshold: number;
}
/**
 * Mirror of Python LogCompressorConfig dataclass (primitive fields only).
 * Skipped fields: none — all fields are primitives.
 */
export interface LogCompressorConfig {
    enabled: boolean;
    max_errors: number;
    error_context_lines: number;
    keep_first_error: boolean;
    keep_last_error: boolean;
    max_stack_traces: number;
    stack_trace_max_lines: number;
    max_warnings: number;
    dedupe_warnings: boolean;
    keep_summary_lines: boolean;
    max_total_lines: number;
    enable_ccr: boolean;
    min_lines_for_ccr: number;
}
/**
 * Mirror of Python DiffCompressorConfig dataclass (primitive fields only).
 * Skipped fields: none — all fields are primitives.
 */
export interface DiffCompressorConfig {
    enabled: boolean;
    max_context_lines: number;
    max_hunks_per_file: number;
    max_files: number;
    always_keep_additions: boolean;
    always_keep_deletions: boolean;
    enable_ccr: boolean;
    min_lines_for_ccr: number;
}
export interface RatioConfig {
    relaxed: number;
    aggressive: number;
    relaxedAtBytes: number;
    aggressiveAtBytes: number;
}
export interface CcrConfig {
    ttlSeconds: number;
    maxEntries: number;
}
export interface CompressionConfig {
    enabled: boolean;
    excludeTools: ReadonlySet<string>;
    minBytes: number;
    ratio: RatioConfig;
    ccr: CcrConfig;
    smartCrusher: SmartCrusherConfig;
    logCompressor: LogCompressorConfig;
    diffCompressor: DiffCompressorConfig;
    clock?: Clock;
    onResult?: (r: CompressionResult) => void;
}
type Atomic = ReadonlySet<string> | ((...args: unknown[]) => unknown);
type DeepPartial<T> = T extends Atomic ? T : T extends object ? {
    [K in keyof T]?: DeepPartial<T[K]>;
} : T;
export type PartialCompressionConfig = DeepPartial<CompressionConfig>;
export declare function defaultConfig(): CompressionConfig;
export declare function mergeConfig(partial?: PartialCompressionConfig): CompressionConfig;
export {};
