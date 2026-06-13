// Public API barrel — everything the consumer needs, nothing internal.
export { compress } from "./router.js";
export { InMemoryCcrStore } from "./ccr/store.js";
export { createRetrieveOriginalTool } from "./mcp/retrieveOriginal.js";
export { defaultConfig, mergeConfig, MAX_INPUT_BYTES } from "./config.js";
export { DEFAULT_EXCLUDE_TOOLS, isExcluded } from "./safety.js";
export { detectContent } from "./detect.js";
export { MARKER_PATTERN, computeKey, markerFor, sentinelFor, findMarkers, } from "./ccr/markers.js";
