export const DEFAULT_EXCLUDE_TOOLS = new Set([
    "read", "glob", "grep", "write", "edit", "bash",
    "verify_citations", "read_progress",
    "get_ddl", "get_object_source", "dump_source", "read_dump_range",
]);
export function isExcluded(toolName, excludeTools) {
    return excludeTools.has(toolName.toLowerCase());
}
