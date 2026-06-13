import type { InMemoryCcrStore } from "../ccr/store.js";
export interface RetrieveOriginalSuccess {
    original: string;
}
export interface RetrieveOriginalError {
    error: "ccr_missing_or_expired";
    hash: string;
}
export type RetrieveOriginalResult = RetrieveOriginalSuccess | RetrieveOriginalError;
export interface RetrieveOriginalTool {
    name: "retrieve_original";
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            hash: {
                type: "string";
                pattern: string;
                description: string;
            };
        };
        required: ["hash"];
    };
    handler: (args: {
        hash: string;
    }) => RetrieveOriginalResult;
}
export declare function createRetrieveOriginalTool(store: InMemoryCcrStore): RetrieveOriginalTool;
