import { DEFAULT_EXCLUDE_TOOLS } from "./safety.js";
export const MAX_INPUT_BYTES = 10_485_760;
// ---- defaultConfig ----
export function defaultConfig() {
    // ENV RULE: only env read in the entire src/ tree
    const rawTtl = process.env["CONTEXT_CRUSH_CCR_TTL_SECONDS"];
    let ttlSeconds = 300;
    if (rawTtl !== undefined) {
        const parsed = Number(rawTtl);
        if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
            ttlSeconds = parsed;
        }
    }
    return {
        enabled: false,
        excludeTools: DEFAULT_EXCLUDE_TOOLS,
        minBytes: 2048,
        ratio: {
            relaxed: 0.85,
            aggressive: 0.65,
            relaxedAtBytes: 4096,
            aggressiveAtBytes: 65536,
        },
        ccr: {
            ttlSeconds,
            maxEntries: 1000,
        },
        smartCrusher: {
            enabled: true,
            min_tokens_to_crush: 200,
            min_items_to_analyze: 5,
            max_items_after_crush: 15,
            first_fraction: 0.3,
            last_fraction: 0.15,
            dedup_identical_items: true,
            preserve_change_points: true,
            factor_out_constants: false,
            include_summaries: false,
            variance_threshold: 2.0,
            uniqueness_threshold: 0.1,
            similarity_threshold: 0.8,
            use_feedback_hints: true,
            toin_confidence_threshold: 0.5,
        },
        logCompressor: {
            enabled: true,
            max_errors: 10,
            error_context_lines: 3,
            keep_first_error: true,
            keep_last_error: true,
            max_stack_traces: 3,
            stack_trace_max_lines: 20,
            max_warnings: 5,
            dedupe_warnings: true,
            keep_summary_lines: true,
            max_total_lines: 100,
            enable_ccr: true,
            min_lines_for_ccr: 50,
        },
        diffCompressor: {
            enabled: true,
            max_context_lines: 2,
            max_hunks_per_file: 10,
            max_files: 20,
            always_keep_additions: true,
            always_keep_deletions: true,
            enable_ccr: true,
            min_lines_for_ccr: 50,
        },
    };
}
// ---- mergeConfig ----
export function mergeConfig(partial) {
    const base = defaultConfig();
    if (!partial)
        return base;
    return {
        enabled: partial.enabled !== undefined ? partial.enabled : base.enabled,
        excludeTools: partial.excludeTools !== undefined ? partial.excludeTools : base.excludeTools,
        minBytes: partial.minBytes !== undefined ? partial.minBytes : base.minBytes,
        clock: partial.clock !== undefined ? partial.clock : base.clock,
        onResult: partial.onResult !== undefined ? partial.onResult : base.onResult,
        ratio: partial.ratio !== undefined
            ? { ...base.ratio, ...partial.ratio }
            : base.ratio,
        ccr: partial.ccr !== undefined
            ? { ...base.ccr, ...partial.ccr }
            : base.ccr,
        smartCrusher: partial.smartCrusher !== undefined
            ? { ...base.smartCrusher, ...partial.smartCrusher }
            : base.smartCrusher,
        logCompressor: partial.logCompressor !== undefined
            ? { ...base.logCompressor, ...partial.logCompressor }
            : base.logCompressor,
        diffCompressor: partial.diffCompressor !== undefined
            ? { ...base.diffCompressor, ...partial.diffCompressor }
            : base.diffCompressor,
    };
}
