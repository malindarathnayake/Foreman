import { Buffer } from "node:buffer";
import { mergeConfig, MAX_INPUT_BYTES } from "./config.js";
import { isExcluded } from "./safety.js";
import { detectContent } from "./detect.js";
import { accept } from "./acceptance.js";
import { computeKey, markerFor, findMarkers } from "./ccr/markers.js";
import { crushSmart } from "./compressors/smartCrusher.js";
import { compressLog } from "./compressors/logCompressor.js";
import { compressDiff } from "./compressors/diffCompressor.js";
// Footer appended to log and diff compressed output (NOT json — crushed JSON
// must remain valid JSON; in-array sentinels from crushSmart are the markers).
const footerFor = (hash) => `\n\n[context-crush: original stored — retrieve_original ${markerFor(hash)}]`;
export function compress(input, config, store) {
    const cfg = mergeConfig(config);
    const originalBytes = Buffer.byteLength(input.text, "utf8");
    // Helper: build a passthrough result for a given reason and invoke onResult.
    const passthrough = (reason) => {
        const result = {
            strategy: "passthrough",
            text: input.text,
            originalBytes,
            compressedBytes: originalBytes,
            ratio: 1.0,
            accepted: false,
            reason,
        };
        return finish(result);
    };
    // Helper: invoke cfg.onResult callback, swallowing any throw, then return result.
    const finish = (result) => {
        if (cfg.onResult) {
            try {
                cfg.onResult(result);
            }
            catch {
                // swallow — a throwing callback must not affect the returned value
            }
        }
        return result;
    };
    // ── Step 2: disabled guard ──────────────────────────────────────────────────
    if (!cfg.enabled) {
        return passthrough("disabled");
    }
    // ── Step 3: tool exclusion ─────────────────────────────────────────────────
    if (isExcluded(input.toolName, cfg.excludeTools)) {
        return passthrough("tool_excluded");
    }
    // ── Step 4: below minBytes ─────────────────────────────────────────────────
    if (originalBytes < cfg.minBytes) {
        return passthrough("below_min_bytes");
    }
    // ── Step 5: oversized input guard ─────────────────────────────────────────
    if (originalBytes > MAX_INPUT_BYTES) {
        return passthrough("detect_passthrough");
    }
    // ── Step 6: content detection ─────────────────────────────────────────────
    const kind = detectContent(input.text);
    if (kind === "text") {
        return passthrough("detect_passthrough");
    }
    // ── Step 7: no-store guard ─────────────────────────────────────────────────
    // crushSmart without a store drops rows irreversibly; the fail-open invariant
    // (lossy output MUST NOT escape without a stored original) makes a store a
    // precondition for ALL lossy strategies.
    if (store == null) {
        return passthrough("ccr_store_failed");
    }
    // ── Step 8: strategy dispatch ──────────────────────────────────────────────
    let candidateBody;
    let strategy;
    try {
        switch (kind) {
            case "json": {
                const r = crushSmart(input.text, cfg.smartCrusher, { store, toolName: input.toolName });
                candidateBody = r.compressed;
                strategy = "smart_crusher";
                break;
            }
            case "log": {
                const r = compressLog(input.text, cfg.logCompressor);
                candidateBody = r.compressed;
                strategy = "log";
                break;
            }
            case "diff": {
                const r = compressDiff(input.text, cfg.diffCompressor);
                candidateBody = r.compressed;
                strategy = "diff";
                break;
            }
        }
    }
    catch {
        return passthrough("compressor_error");
    }
    // ── Step 9: byte-equal check ───────────────────────────────────────────────
    if (candidateBody === input.text) {
        return passthrough("ratio_rejected");
    }
    // ── Step 10: build final candidate text ───────────────────────────────────
    let candidate;
    if (kind === "json") {
        // Council decision: crushed JSON output must remain valid JSON;
        // the in-array sentinels are the markers — NO footer.
        candidate = candidateBody;
    }
    else {
        // log and diff: append the deterministic footer (hash computed without storing)
        const hash = computeKey(input.text);
        candidate = candidateBody + footerFor(hash);
    }
    // ── Step 11: acceptance check ─────────────────────────────────────────────
    const compressedBytes = Buffer.byteLength(candidate, "utf8");
    if (!accept(originalBytes, compressedBytes, cfg.ratio)) {
        return passthrough("ratio_rejected");
    }
    // ── Step 12: store the full original ──────────────────────────────────────
    // put() computes the same sha256-24 key, so ref.hash === computeKey(input.text) —
    // the footer marker and ref agree by construction.
    let ref;
    try {
        ref = store.put(input.text, { toolName: input.toolName, strategy: strategy });
    }
    catch {
        return passthrough("ccr_store_failed");
    }
    if (ref === null) {
        return passthrough("ccr_store_failed");
    }
    // ── Step 12.5: verify every emitted marker is still retrievable ───────────
    // The full-original put can evict dropped-rows payloads that crushSmart
    // already referenced from in-text sentinels (capacity pressure). A marker
    // that is dead at emission time violates the retrieval contract — fail open.
    for (const hash of findMarkers(candidate)) {
        if (!store.has(hash)) {
            return passthrough("ccr_store_failed");
        }
    }
    // ── Step 13: success result ────────────────────────────────────────────────
    const result = {
        strategy: strategy,
        text: candidate,
        originalBytes,
        compressedBytes,
        ratio: compressedBytes / originalBytes,
        accepted: true,
        reason: "compressed",
        ccr: ref,
    };
    return finish(result);
}
