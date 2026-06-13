const HASH_RE = /^[0-9a-f]{24}$/;
export function createRetrieveOriginalTool(store) {
    return {
        name: "retrieve_original",
        description: "Exchange a <<ccr:HASH>> marker's 24-hex hash for the full original tool output that was compressed away. " +
            "Entries expire after a configurable TTL; if the entry is missing or expired the tool returns an error.",
        inputSchema: {
            type: "object",
            properties: {
                hash: {
                    type: "string",
                    pattern: "^[0-9a-f]{24}$",
                    description: "The 24 lowercase hex characters from a <<ccr:HASH>> marker.",
                },
            },
            required: ["hash"],
        },
        handler(args) {
            const h = args.hash;
            if (typeof h !== "string" || !HASH_RE.test(h)) {
                return { error: "ccr_missing_or_expired", hash: String(h) };
            }
            const original = store.get(h);
            if (original === null) {
                return { error: "ccr_missing_or_expired", hash: h };
            }
            return { original };
        },
    };
}
