/**
 * Adaptive sizer — shared module extracted from logCompressor.ts.
 *
 * LINE-FAITHFUL TypeScript port of headroom's adaptive_sizer.py.
 * Only `computeOptimalK` is exported; all helpers are module-private.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
/**
 * Compute a 64-bit SimHash fingerprint for a text string.
 * Uses character 4-grams hashed to 64-bit values, aggregated via bit voting.
 */
function _simhash(text) {
    const v = new Array(64).fill(0);
    const textLower = text.toLowerCase();
    const len = textLower.length;
    for (let i = 0; i < Math.max(1, len - 3); i++) {
        const gram = textLower.slice(i, i + 4);
        const hexDigest = createHash("md5").update(gram).digest("hex");
        const h = BigInt("0x" + hexDigest.slice(0, 16));
        for (let j = 0; j < 64; j++) {
            if ((h >> BigInt(j)) & 1n) {
                v[j]++;
            }
            else {
                v[j]--;
            }
        }
    }
    let fingerprint = 0n;
    for (let j = 0; j < 64; j++) {
        if (v[j] > 0) {
            fingerprint |= 1n << BigInt(j);
        }
    }
    return fingerprint;
}
/**
 * Count differing bits between two 64-bit integers (Hamming distance).
 */
function _hammingDistance(a, b) {
    const x = a ^ b;
    return _popcount32(Number(x & 0xffffffffn)) + _popcount32(Number(x >> 32n));
}
// Foreman divergence (0.6.39): the string-based bit count ran ~11.6M times on a 5,000-line
// log (quadratic clustering) and took ~4 s. Same result, counted arithmetically; the
// clustering loop below compares pre-split 32-bit halves so the hot path avoids BigInt.
function _popcount32(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
/**
 * Count items with distinct content using SimHash.
 * Greedy clustering with Hamming distance threshold = 3.
 */
function countUniqueSimhash(items, threshold = 3) {
    if (items.length === 0)
        return 0;
    const fingerprints = items.map(_simhash).map((fp) => [Number(fp >> 32n), Number(fp & 0xffffffffn)]);
    const clusters = []; // representative fingerprints as [hi, lo]
    for (const fp of fingerprints) {
        let matched = false;
        for (const rep of clusters) {
            if (_popcount32((fp[0] ^ rep[0]) >>> 0) + _popcount32((fp[1] ^ rep[1]) >>> 0) <= threshold) {
                matched = true;
                break;
            }
        }
        if (!matched) {
            clusters.push(fp);
        }
    }
    return clusters.length;
}
/**
 * Build cumulative unique bigram coverage curve.
 * curve[k] = number of unique bigrams after seeing items[0..k].
 */
function computeUniqueBigramCurve(items) {
    // Python uses set of tuples; TS: set of strings joined with " "
    const seenBigrams = new Set();
    const curve = [];
    for (const item of items) {
        // Python: item.lower().split() — splits on whitespace runs, no empty strings
        const words = item.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
        if (words.length < 2) {
            // Single-word or empty item: "unigram bigram"
            const w0 = words[0] !== undefined ? words[0] : "";
            seenBigrams.add(w0 + " ");
        }
        else {
            for (let j = 0; j < words.length - 1; j++) {
                seenBigrams.add(words[j] + " " + words[j + 1]);
            }
        }
        curve.push(seenBigrams.size);
    }
    return curve;
}
/**
 * Find the knee point in a monotonically increasing curve using Kneedle algorithm.
 * Returns index+1 (count), or null if no clear knee.
 */
function findKnee(curve) {
    const n = curve.length;
    if (n < 3)
        return null;
    const xMin = 0;
    const xMax = n - 1;
    const yMin = curve[0];
    const yMax = curve[n - 1];
    if (yMax === yMin) {
        // Flat curve — all items are identical
        return 1;
    }
    const xRange = xMax - xMin;
    const yRange = yMax - yMin;
    let maxDiff = -1.0;
    let kneeIdx = null;
    for (let i = 0; i < n; i++) {
        const xNorm = (i - xMin) / xRange;
        const yNorm = (curve[i] - yMin) / yRange;
        const diff = yNorm - xNorm;
        if (diff > maxDiff) {
            maxDiff = diff;
            kneeIdx = i;
        }
    }
    if (maxDiff < 0.05)
        return null;
    return kneeIdx !== null ? kneeIdx + 1 : null;
}
/**
 * Validate K using zlib compression ratio comparison.
 */
function _validateWithZlib(items, k, maxK) {
    if (k >= items.length || k >= maxK)
        return k;
    const fullText = Buffer.from(items.join("\n"), "utf8");
    const subsetText = Buffer.from(items.slice(0, k).join("\n"), "utf8");
    // Skip validation for very small content
    if (fullText.length < 200)
        return k;
    const fullCompressed = deflateSync(fullText, { level: 1 }).length;
    const subsetCompressed = deflateSync(subsetText, { level: 1 }).length;
    const fullRatio = fullText.length > 0 ? fullCompressed / fullText.length : 1.0;
    const subsetRatio = subsetText.length > 0 ? subsetCompressed / subsetText.length : 1.0;
    const ratioDiff = Math.abs(fullRatio - subsetRatio);
    if (ratioDiff > 0.15) {
        return Math.min(Math.trunc(k * 1.2), maxK);
    }
    return k;
}
/**
 * Compute the optimal number of items to keep using information saturation.
 */
export function computeOptimalK(items, bias = 1.0, minK = 3, maxK = null) {
    const n = items.length;
    const effectiveMax = maxK !== null ? maxK : n;
    // Tier 1: Fast path — n <= 8 returns n directly (NOT clamped to min_k/max_k)
    if (n <= 8)
        return n;
    // Check for near-total redundancy
    const uniqueCount = countUniqueSimhash(items);
    if (uniqueCount <= 3) {
        const k = Math.max(minK, uniqueCount);
        return Math.min(k, effectiveMax);
    }
    // Tier 2: Kneedle on unique bigram coverage
    const curve = computeUniqueBigramCurve(items);
    let knee = findKnee(curve);
    const diversityRatio = uniqueCount / n;
    if (knee === null) {
        const keepFraction = 0.3 + 0.7 * diversityRatio;
        knee = Math.max(minK, Math.trunc(n * keepFraction));
    }
    else {
        if (diversityRatio > 0.7) {
            const diversityFloor = Math.max(minK, Math.trunc(n * (0.3 + 0.7 * diversityRatio)));
            knee = Math.max(knee, diversityFloor);
        }
    }
    // Apply bias multiplier
    let k = Math.max(minK, Math.trunc(knee * bias));
    k = Math.min(k, effectiveMax);
    // Tier 3: Validate with zlib compression ratio
    k = _validateWithZlib(items, k, effectiveMax);
    k = Math.max(minK, Math.min(k, effectiveMax));
    return k;
}
