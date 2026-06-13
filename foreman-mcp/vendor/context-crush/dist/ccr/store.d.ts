import type { CcrRef, Clock, CompressionStrategy } from "../types.js";
export interface CcrStoreOptions {
    ttlSeconds?: number;
    maxEntries?: number;
    clock?: Clock;
}
export interface CcrStoreStats {
    entries: number;
    evictions: number;
    hits: number;
    misses: number;
    expiredMisses: number;
}
export declare class InMemoryCcrStore {
    private readonly ttlSeconds;
    private readonly maxEntries;
    private readonly clock;
    private readonly store;
    private evictions;
    private hits;
    private misses;
    private expiredMisses;
    constructor(opts?: CcrStoreOptions);
    put(original: string, meta: {
        toolName: string;
        strategy: CompressionStrategy;
    }, ttlSecondsOverride?: number): CcrRef | null;
    get(hash: string): string | null;
    has(hash: string): boolean;
    stats(): CcrStoreStats;
    clear(): void;
}
