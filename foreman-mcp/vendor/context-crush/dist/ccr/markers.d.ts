export declare const MARKER_PATTERN: RegExp;
export declare function computeKey(payload: string): string;
export declare function markerFor(hash: string): string;
export declare function sentinelFor(hash: string, droppedRows: number): {
    _ccr_dropped: string;
};
export declare function findMarkers(text: string): string[];
