import { computeKey, markerFor } from "./markers.js";
export class InMemoryCcrStore {
    ttlSeconds;
    maxEntries;
    clock;
    store;
    evictions;
    hits;
    misses;
    expiredMisses;
    constructor(opts) {
        this.ttlSeconds = opts?.ttlSeconds ?? 300;
        this.maxEntries = opts?.maxEntries ?? 1000;
        this.clock = opts?.clock ?? Date.now;
        this.store = new Map();
        this.evictions = 0;
        this.hits = 0;
        this.misses = 0;
        this.expiredMisses = 0;
    }
    put(original, meta, ttlSecondsOverride) {
        if (this.maxEntries <= 0) {
            return null;
        }
        const hash = computeKey(original);
        const ttl = ttlSecondsOverride ?? this.ttlSeconds;
        const now = this.clock();
        const createdAtMs = now;
        const expiresAtMs = createdAtMs + ttl * 1000;
        // If hash already present: refresh (delete + re-set for insertion order)
        if (this.store.has(hash)) {
            this.store.delete(hash);
            this.store.set(hash, {
                hash,
                original,
                toolName: meta.toolName,
                strategy: meta.strategy,
                createdAtMs,
                expiresAtMs,
            });
            return { hash, marker: markerFor(hash), expiresAtMs };
        }
        // New entry: sweep expired entries first
        for (const [key, entry] of this.store) {
            if (entry.expiresAtMs <= now) {
                this.store.delete(key);
            }
        }
        // If still at or over capacity, evict oldest insertion-order entries
        while (this.store.size >= this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (oldestKey === undefined)
                break;
            this.store.delete(oldestKey);
            this.evictions++;
        }
        this.store.set(hash, {
            hash,
            original,
            toolName: meta.toolName,
            strategy: meta.strategy,
            createdAtMs,
            expiresAtMs,
        });
        return { hash, marker: markerFor(hash), expiresAtMs };
    }
    get(hash) {
        const entry = this.store.get(hash);
        if (entry === undefined) {
            this.misses++;
            return null;
        }
        if (entry.expiresAtMs <= this.clock()) {
            this.store.delete(hash);
            this.expiredMisses++;
            return null;
        }
        this.hits++;
        return entry.original;
    }
    has(hash) {
        const entry = this.store.get(hash);
        if (entry === undefined)
            return false;
        if (entry.expiresAtMs <= this.clock())
            return false;
        return true;
    }
    stats() {
        return {
            entries: this.store.size,
            evictions: this.evictions,
            hits: this.hits,
            misses: this.misses,
            expiredMisses: this.expiredMisses,
        };
    }
    clear() {
        this.store.clear();
        this.evictions = 0;
        this.hits = 0;
        this.misses = 0;
        this.expiredMisses = 0;
    }
}
