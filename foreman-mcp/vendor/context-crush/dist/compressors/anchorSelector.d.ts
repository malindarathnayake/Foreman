/**
 * Dynamic anchor selection for SmartCrusher.
 *
 * LINE-FAITHFUL TypeScript port of headroom's anchor_selector.py.
 * AnchorConfig is inlined as constants; no project config dependency.
 */
export type AnchorDataPattern = "search_results" | "logs" | "time_series" | "generic";
/**
 * Select anchor indices for array compression.
 *
 * Line-faithful port of Python AnchorSelector.select_anchors().
 *
 * @param items     Array of items to compress.
 * @param maxItems  Target maximum items after compression.
 * @param pattern   Data pattern for strategy selection.
 * @param query     Optional user query for context-aware weight adjustment.
 * @param floatSet  Integral-float set from lexIntegralFloatLiterals (for hash fidelity).
 */
export declare function selectAnchors(items: unknown[], maxItems: number, pattern: AnchorDataPattern, query: string | null, floatSet: ReadonlySet<number>): Set<number>;
