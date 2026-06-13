/**
 * Log/build output compressor for test and compiler output.
 *
 * LINE-FAITHFUL TypeScript port of headroom's Python log_compressor.py.
 * Deviations from Python: (1) cache_key is always null — CCR storage happens
 * in the router (a later unit); (2) adaptive_sizer functions are inlined here
 * rather than living in a separate module.
 */
import type { LogCompressorConfig } from "../config.js";
export type LogFormat = "pytest" | "npm" | "cargo" | "make" | "jest" | "generic";
export interface LogCompressionResult {
    compressed: string;
    original: string;
    original_line_count: number;
    compressed_line_count: number;
    format_detected: LogFormat;
    compression_ratio: number;
    cache_key: string | null;
    stats: Record<string, number>;
}
/**
 * Compress log output. Line-faithful TypeScript port of Python LogCompressor.compress().
 *
 * @param content - Raw log output string.
 * @param config  - LogCompressorConfig (the `enabled` field is ignored here;
 *                  enablement is the router's responsibility).
 * @param bias    - Compression bias multiplier (>1 = keep more, <1 = keep fewer).
 *                  Default 1.0.
 */
export declare function compressLog(content: string, config: LogCompressorConfig, bias?: number): LogCompressionResult;
