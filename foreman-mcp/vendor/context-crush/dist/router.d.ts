import type { CompressionInput, CompressionResult } from "./types.js";
import type { PartialCompressionConfig } from "./config.js";
import { InMemoryCcrStore } from "./ccr/store.js";
export declare function compress(input: CompressionInput, config?: PartialCompressionConfig, store?: InMemoryCcrStore | null): CompressionResult;
