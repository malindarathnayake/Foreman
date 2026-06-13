/**
 * SmartCrusher — LINE-FAITHFUL TypeScript port of headroom's smart_crusher.py
 * (the core compressor logic, with TOIN/feedback/telemetry/Kompress omitted).
 *
 * Subsystem neutralization map (per worker brief):
 *  - TOIN, CompressionFeedback, Telemetry → OMIT
 *  - RelevanceScorer → every score = 0.0; score >= threshold blocks never fire
 *  - Kompress _compress_text_within_items → identity (returns same array ref)
 *  - Legacy CCR → replaced by OUR sentinel rule (see crushArray)
 *  - Thread locks, logging → OMIT
 */
import type { SmartCrusherConfig } from "../config.js";
import type { InMemoryCcrStore } from "../ccr/store.js";
export interface SmartCrushResult {
    compressed: string;
    original: string;
    was_modified: boolean;
    strategy: string;
}
export interface SmartCrushOptions {
    store?: InMemoryCcrStore | null;
    toolName?: string;
    query?: string;
    bias?: number;
}
export declare function extractQueryAnchors(text: string): Set<string>;
export declare function itemMatchesAnchors(item: Record<string, unknown>, anchors: Set<string>, floatSet: ReadonlySet<number>): boolean;
export declare function crushSmart(content: string, config: SmartCrusherConfig, opts?: SmartCrushOptions): SmartCrushResult;
