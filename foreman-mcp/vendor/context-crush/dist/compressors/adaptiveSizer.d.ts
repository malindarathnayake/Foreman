/**
 * Adaptive sizer — shared module extracted from logCompressor.ts.
 *
 * LINE-FAITHFUL TypeScript port of headroom's adaptive_sizer.py.
 * Only `computeOptimalK` is exported; all helpers are module-private.
 */
/**
 * Compute the optimal number of items to keep using information saturation.
 */
export declare function computeOptimalK(items: readonly string[], bias?: number, minK?: number, maxK?: number | null): number;
