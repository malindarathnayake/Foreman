import type { ContentKind } from "./types.js";
/**
 * Detect the content kind of the given text.
 * Detection order: json → diff (on stripped) → log (on stripped) → text
 */
export declare function detectContent(text: string): ContentKind;
