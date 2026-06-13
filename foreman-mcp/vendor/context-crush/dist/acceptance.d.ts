import type { RatioConfig } from "./config.js";
/**
 * Returns the acceptance threshold ratio for a given input size.
 *
 * - bytes <= relaxedAtBytes  → relaxed ratio
 * - bytes >= aggressiveAtBytes → aggressive ratio
 * - otherwise → linear interpolation between the two
 */
export declare function thresholdFor(originalBytes: number, ratio: RatioConfig): number;
/**
 * Returns true if the compression result meets the acceptance threshold.
 * Guards against originalBytes <= 0 (always returns false).
 */
export declare function accept(originalBytes: number, compressedBytes: number, ratio: RatioConfig): boolean;
