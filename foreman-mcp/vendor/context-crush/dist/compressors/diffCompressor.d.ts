/**
 * Git diff output compressor for unified diff format.
 *
 * LINE-FAITHFUL TypeScript port of headroom's Python diff_compressor.py.
 * Deviations from Python: (1) cache_key is always null — CCR storage happens
 * in the router (a later unit); (2) _log_loss_signals is not ported — the
 * library has a zero-dependency/no-logger rule; (3) _store_in_ccr is not
 * ported — CCR storage happens in the router.
 */
import type { DiffCompressorConfig } from "../config.js";
export interface DiffCompressionResult {
    compressed: string;
    original_line_count: number;
    compressed_line_count: number;
    files_affected: number;
    additions: number;
    deletions: number;
    hunks_kept: number;
    hunks_removed: number;
    cache_key: string | null;
}
/**
 * Compress git diff output.
 *
 * @param content - Raw git diff output.
 * @param config  - Compression configuration.
 * @param context - User query context for relevance scoring (default "").
 * @returns DiffCompressionResult with compressed output and metadata.
 */
export declare function compressDiff(content: string, config: DiffCompressorConfig, context?: string): DiffCompressionResult;
