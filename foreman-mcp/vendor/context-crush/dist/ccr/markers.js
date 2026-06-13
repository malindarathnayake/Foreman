import { createHash } from "node:crypto";
export const MARKER_PATTERN = /<<ccr:([0-9a-f]{24})>>/g;
export function computeKey(payload) {
    return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 24);
}
export function markerFor(hash) {
    return "<<ccr:" + hash + ">>";
}
export function sentinelFor(hash, droppedRows) {
    return { _ccr_dropped: `<<ccr:${hash}>> ${droppedRows} rows offloaded` };
}
export function findMarkers(text) {
    const pattern = new RegExp(/<<ccr:([0-9a-f]{24})>>/g);
    const results = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        results.push(match[1]);
    }
    return results;
}
