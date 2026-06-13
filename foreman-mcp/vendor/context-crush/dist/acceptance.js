/**
 * Returns the acceptance threshold ratio for a given input size.
 *
 * - bytes <= relaxedAtBytes  → relaxed ratio
 * - bytes >= aggressiveAtBytes → aggressive ratio
 * - otherwise → linear interpolation between the two
 */
export function thresholdFor(originalBytes, ratio) {
    if (originalBytes <= ratio.relaxedAtBytes) {
        return ratio.relaxed;
    }
    if (originalBytes >= ratio.aggressiveAtBytes) {
        return ratio.aggressive;
    }
    const t = (originalBytes - ratio.relaxedAtBytes) /
        (ratio.aggressiveAtBytes - ratio.relaxedAtBytes);
    return ratio.relaxed + (ratio.aggressive - ratio.relaxed) * t;
}
/**
 * Returns true if the compression result meets the acceptance threshold.
 * Guards against originalBytes <= 0 (always returns false).
 */
export function accept(originalBytes, compressedBytes, ratio) {
    if (originalBytes <= 0)
        return false;
    return compressedBytes / originalBytes <= thresholdFor(originalBytes, ratio);
}
