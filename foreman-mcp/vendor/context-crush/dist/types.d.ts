export type CompressionStrategy = "smart_crusher" | "log" | "diff" | "passthrough";
export type CompressionReason = "compressed" | "below_min_bytes" | "ratio_rejected" | "tool_excluded" | "detect_passthrough" | "compressor_error" | "ccr_store_failed" | "disabled";
export type ContentKind = "json" | "diff" | "log" | "text";
export type Clock = () => number;
export interface CompressionInput {
    toolName: string;
    text: string;
}
export interface CcrRef {
    hash: string;
    marker: string;
    expiresAtMs: number;
}
export interface CcrEntry {
    hash: string;
    original: string;
    toolName: string;
    strategy: CompressionStrategy;
    createdAtMs: number;
    expiresAtMs: number;
}
export interface CompressionResult {
    strategy: CompressionStrategy;
    text: string;
    originalBytes: number;
    compressedBytes: number;
    ratio: number;
    accepted: boolean;
    reason: CompressionReason;
    ccr?: CcrRef;
}
