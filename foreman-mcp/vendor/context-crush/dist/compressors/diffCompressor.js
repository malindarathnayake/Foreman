/**
 * Git diff output compressor for unified diff format.
 *
 * LINE-FAITHFUL TypeScript port of headroom's Python diff_compressor.py.
 * Deviations from Python: (1) cache_key is always null — CCR storage happens
 * in the router (a later unit); (2) _log_loss_signals is not ported — the
 * library has a zero-dependency/no-logger rule; (3) _store_in_ccr is not
 * ported — CCR storage happens in the router.
 */
// ---------------------------------------------------------------------------
// Module-private constants
// ---------------------------------------------------------------------------
// Pattern for `diff --git a/X b/Y` header (regular diff).
const _DIFF_GIT_PATTERN = /^diff --git a\/(.+) b\/(.+)$/;
// Bug-fix (2026-04-25): merge-commit headers — `diff --combined <path>`
// and `diff --cc <path>`. Both produce a single-path file diff with
// combined-diff hunk syntax (`@@@`+). Previously the parser only
// recognized `diff --git`, so merge-commit diffs from `git log -p`
// of merges fell through to "no files parsed" and were passed
// through unchanged — even though ContentRouter had routed them here
// because `--- a/` triggered the detector.
const _DIFF_COMBINED_PATTERN = /^diff --combined (.+)$/;
const _DIFF_CC_PATTERN = /^diff --cc (.+)$/;
// Pattern for --- a/file or --- /dev/null
const _OLD_FILE_PATTERN = /^--- (a\/(.+)|\/dev\/null)$/;
// Pattern for +++ b/file or +++ /dev/null
const _NEW_FILE_PATTERN = /^\+\+\+ (b\/(.+)|\/dev\/null)$/;
// Pattern for ANY hunk header — matches both regular `@@ -A,B +C,D @@`
// and combined-diff `@@@ -A,B -C,D +E,F @@@` (and 4-way `@@@@ ... @@@@`).
// Group 1 is the @-prefix (so closing @@ can backreference). Bug-fix:
// previously hardcoded to `@@`, which silently dropped all content from
// combined-diff hunks (merge commits) — `current_hunk` was never set so
// subsequent +/- lines fell through to the no-op branch.
const _HUNK_HEADER_PATTERN = /^(@@+) (?:-\d+(?:,\d+)? )+\+\d+(?:,\d+)? \1(.*)$/;
// Used to extract the new-file starting line number for in-order resort
// after middle-hunk selection. Works for both regular and combined diffs.
const _HUNK_NEW_RANGE_PATTERN = /\+(\d+)/;
// Pattern for binary file indication
const _BINARY_PATTERN = /^Binary files .+ differ$/;
// Patterns for new/deleted file mode
const _NEW_FILE_MODE_PATTERN = /^new file mode/;
const _DELETED_FILE_MODE_PATTERN = /^deleted file mode/;
// Bug-fix: extended to include `dissimilarity` (low-similarity rename
// marker, real git output). Previously dropped silently.
const _RENAME_PATTERN = /^(rename|similarity|copy|dissimilarity) /;
// Priority patterns for context-aware hunk selection (inlined from
// headroom.transforms.error_detection.PRIORITY_PATTERNS_DIFF)
const PRIORITY_PATTERNS = [
    /\b(error|exception|fail(?:ed|ure)?|fatal|critical|crash|panic)\b/i,
    /\b(important|note|todo|fixme|hack|xxx|bug|fix)\b/i,
    /\b(security|auth|password|secret|token)\b/i,
];
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function _makeDiffFile(header) {
    return {
        header,
        old_file: "",
        new_file: "",
        hunks: [],
        is_binary: false,
        is_new_file: false,
        is_deleted_file: false,
        is_renamed: false,
        rename_lines: [],
        original_new_file_mode_line: null,
        original_deleted_file_mode_line: null,
        original_binary_line: null,
    };
}
function _makeDiffHunk(header) {
    return {
        header,
        lines: [],
        additions: 0,
        deletions: 0,
        context_lines: 0,
        score: 0.0,
    };
}
function _totalAdditions(f) {
    return f.hunks.reduce((sum, h) => sum + h.additions, 0);
}
function _totalDeletions(f) {
    return f.hunks.reduce((sum, h) => sum + h.deletions, 0);
}
// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
function _parseDiff(lines) {
    const diff_files = [];
    let current_file = null;
    let current_hunk = null;
    const pre_diff_lines = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Check for diff --git header (new file section). Bug-fix:
        // `diff --combined <path>` and `diff --cc <path>` (merge
        // commits) also start a new file section — single-path,
        // combined-diff hunk syntax. Treat them the same as
        // `diff --git` for sectioning purposes; the path goes in
        // `header` verbatim.
        if (_DIFF_GIT_PATTERN.test(line) ||
            _DIFF_COMBINED_PATTERN.test(line) ||
            _DIFF_CC_PATTERN.test(line)) {
            // Save previous hunk and file
            if (current_hunk !== null && current_file !== null) {
                current_file.hunks.push(current_hunk);
            }
            if (current_file !== null) {
                diff_files.push(current_file);
            }
            current_file = _makeDiffFile(line);
            current_hunk = null;
            i += 1;
            continue;
        }
        // Bug-fix: any line before the first `diff --git` is pre-diff
        // content (commit headers, email headers). Capture for verbatim
        // re-emission rather than dropping.
        if (current_file === null) {
            pre_diff_lines.push(line);
            i += 1;
            continue;
        }
        // Check for file mode indicators / rename / binary markers.
        // Capture the original line in addition to the boolean so the
        // logger / sidecar observability can surface emit-time
        // normalization losses.
        // NOTE: this block does NOT continue — control falls through to the
        // next checks below.
        if (current_file !== null) {
            if (_NEW_FILE_MODE_PATTERN.test(line)) {
                current_file.is_new_file = true;
                current_file.original_new_file_mode_line = line;
            }
            else if (_DELETED_FILE_MODE_PATTERN.test(line)) {
                current_file.is_deleted_file = true;
                current_file.original_deleted_file_mode_line = line;
            }
            else if (_RENAME_PATTERN.test(line)) {
                current_file.is_renamed = true;
                // Bug-fix: capture rename marker lines so they get
                // re-emitted. Previously the boolean was set but the
                // actual `rename from` / `rename to` / `similarity index`
                // lines were discarded — output looked like a plain
                // modification and the LLM had no way to know a file
                // was renamed.
                current_file.rename_lines.push(line);
            }
            else if (_BINARY_PATTERN.test(line)) {
                current_file.is_binary = true;
                current_file.original_binary_line = line;
            }
        }
        // Check for --- a/file
        if (_OLD_FILE_PATTERN.test(line)) {
            if (current_file !== null) {
                current_file.old_file = line;
            }
            i += 1;
            continue;
        }
        // Check for +++ b/file
        if (_NEW_FILE_PATTERN.test(line)) {
            if (current_file !== null) {
                current_file.new_file = line;
            }
            i += 1;
            continue;
        }
        // Check for hunk header (regular `@@` or combined-diff `@@@`+).
        // Bug-fix: previously `@@@` headers didn't match, so combined
        // diffs (merge commits) had ALL their content silently dropped.
        if (_HUNK_HEADER_PATTERN.test(line)) {
            // Save previous hunk
            if (current_hunk !== null && current_file !== null) {
                current_file.hunks.push(current_hunk);
            }
            current_hunk = _makeDiffHunk(line);
            i += 1;
            continue;
        }
        // Process hunk content lines
        if (current_hunk !== null) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                current_hunk.additions += 1;
                current_hunk.lines.push(line);
            }
            else if (line.startsWith("-") && !line.startsWith("---")) {
                current_hunk.deletions += 1;
                current_hunk.lines.push(line);
            }
            else if (line.startsWith(" ") || line === "") {
                current_hunk.context_lines += 1;
                current_hunk.lines.push(line);
            }
            else {
                // Other line (e.g., "\ No newline at end of file" — note
                // leading backslash). Preserved here; `_reduce_context`
                // force-keeps `\` lines regardless of distance from
                // changes, so they survive the context trim.
                current_hunk.lines.push(line);
            }
        }
        i += 1;
    }
    // Save final hunk and file
    if (current_hunk !== null && current_file !== null) {
        current_file.hunks.push(current_hunk);
    }
    if (current_file !== null) {
        diff_files.push(current_file);
    }
    return [pre_diff_lines, diff_files];
}
// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function _scoreHunks(diff_files, context) {
    const context_lower = context.toLowerCase();
    const context_words = context ? new Set(context_lower.split(/\s+/)) : new Set();
    for (const diff_file of diff_files) {
        for (const hunk of diff_file.hunks) {
            let score = 0.0;
            // Base score from change count (more changes = more important)
            const change_count = hunk.additions + hunk.deletions;
            score += Math.min(0.3, change_count * 0.03);
            const hunk_content = hunk.lines.join("\n").toLowerCase();
            // Score by context word overlap
            for (const word of context_words) {
                if (word.length > 2 && hunk_content.includes(word)) {
                    score += 0.2;
                }
            }
            // Boost for priority patterns
            for (const pattern of PRIORITY_PATTERNS) {
                if (pattern.test(hunk_content)) {
                    score += 0.3;
                    break;
                }
            }
            hunk.score = Math.min(1.0, score);
        }
    }
}
// ---------------------------------------------------------------------------
// Context reduction
// ---------------------------------------------------------------------------
function _extractLineNumber(header) {
    const match = _HUNK_NEW_RANGE_PATTERN.exec(header);
    if (match !== null) {
        return Math.trunc(parseInt(match[1], 10));
    }
    return 0;
}
function _reduceContext(hunk, max_context) {
    // Identify change positions
    const change_positions = [];
    for (let i = 0; i < hunk.lines.length; i++) {
        const line = hunk.lines[i];
        if (line.startsWith("+") || line.startsWith("-")) {
            change_positions.push(i);
        }
    }
    if (change_positions.length === 0) {
        // No changes, just context - keep minimal
        const sliced = hunk.lines.slice(0, max_context);
        return {
            header: hunk.header,
            lines: sliced,
            additions: 0,
            deletions: 0,
            context_lines: Math.min(hunk.lines.length, max_context),
            score: hunk.score,
        };
    }
    // Determine which lines to keep
    const keep_indices = new Set();
    for (const pos of change_positions) {
        // Always keep the change line
        keep_indices.add(pos);
        // Keep context before
        for (let i = Math.max(0, pos - max_context); i < pos; i++) {
            keep_indices.add(i);
        }
        // Keep context after
        for (let i = pos + 1; i < Math.min(hunk.lines.length, pos + max_context + 1); i++) {
            keep_indices.add(i);
        }
    }
    // Bug-fix: ALWAYS keep `\ No newline at end of file` markers (and
    // any other backslash-prefixed metadata) regardless of distance
    // from a change. These are structural patch markers, not context —
    // losing them breaks round-trippable patches and changes the
    // semantic meaning of the trailing line in the file.
    for (let i = 0; i < hunk.lines.length; i++) {
        if (hunk.lines[i].startsWith("\\")) {
            keep_indices.add(i);
        }
    }
    // Build new lines list
    const new_lines = [];
    let additions = 0;
    let deletions = 0;
    let context_lines = 0;
    const sorted_indices = Array.from(keep_indices).sort((a, b) => a - b);
    for (const i of sorted_indices) {
        const line = hunk.lines[i];
        new_lines.push(line);
        if (line.startsWith("+")) {
            additions += 1;
        }
        else if (line.startsWith("-")) {
            deletions += 1;
        }
        else {
            context_lines += 1;
        }
    }
    return {
        header: hunk.header,
        lines: new_lines,
        additions,
        deletions,
        context_lines,
        score: hunk.score,
    };
}
// ---------------------------------------------------------------------------
// Hunk compression
// ---------------------------------------------------------------------------
function _compressHunks(hunks, config) {
    if (hunks.length === 0) {
        return [];
    }
    let selected_hunks;
    // Sort by score if we need to limit
    if (hunks.length > config.max_hunks_per_file) {
        // Keep first and last hunks (often important)
        const first_hunk = hunks[0];
        const last_hunk = hunks.length > 1 ? hunks[hunks.length - 1] : null;
        // Sort middle hunks by score (stable sort descending)
        const middle_hunks = (last_hunk !== null ? hunks.slice(1, -1) : []).slice();
        middle_hunks.sort((a, b) => b.score - a.score);
        // Take top scoring middle hunks
        const remaining_slots = last_hunk !== null
            ? config.max_hunks_per_file - 2
            : config.max_hunks_per_file - 1;
        const selected_middle = middle_hunks.slice(0, remaining_slots);
        // Rebuild list in original order by re-sorting by appearance
        const selected = [first_hunk, ...selected_middle];
        if (last_hunk !== null) {
            selected.push(last_hunk);
        }
        // Sort back to original order (using header line numbers as proxy)
        selected.sort((a, b) => _extractLineNumber(a.header) - _extractLineNumber(b.header));
        selected_hunks = selected;
    }
    else {
        selected_hunks = hunks;
    }
    // Reduce context in each hunk (always, capped or not)
    const compressed_hunks = [];
    for (const hunk of selected_hunks) {
        compressed_hunks.push(_reduceContext(hunk, config.max_context_lines));
    }
    return compressed_hunks;
}
function _compressFiles(diff_files, config) {
    const stats = {
        files_affected: 0,
        total_additions: 0,
        total_deletions: 0,
        hunks_kept: 0,
        hunks_removed: 0,
    };
    // Limit files if too many
    let files_to_process = diff_files;
    if (diff_files.length > config.max_files) {
        // Sort by total changes (most changes first) — sort a COPY, stable
        files_to_process = diff_files.slice().sort((a, b) => (_totalAdditions(b) + _totalDeletions(b)) -
            (_totalAdditions(a) + _totalDeletions(a)));
        files_to_process = files_to_process.slice(0, config.max_files);
    }
    const compressed_files = [];
    for (const diff_file of files_to_process) {
        stats.files_affected += 1;
        stats.total_additions += _totalAdditions(diff_file);
        stats.total_deletions += _totalDeletions(diff_file);
        // Compress hunks within file
        const compressed_hunks = _compressHunks(diff_file.hunks, config);
        stats.hunks_kept += compressed_hunks.length;
        stats.hunks_removed += diff_file.hunks.length - compressed_hunks.length;
        // Create compressed file with reduced context in hunks. Bug-fix:
        // previously this constructor dropped `rename_lines` and the
        // `original_*_line` fields by omission — they were captured in
        // the parser but never propagated to `_format_output`, so the
        // emit looked exactly like the buggy old behavior. Carry them
        // all through.
        const new_file = {
            header: diff_file.header,
            old_file: diff_file.old_file,
            new_file: diff_file.new_file,
            hunks: compressed_hunks,
            is_binary: diff_file.is_binary,
            is_new_file: diff_file.is_new_file,
            is_deleted_file: diff_file.is_deleted_file,
            is_renamed: diff_file.is_renamed,
            rename_lines: diff_file.rename_lines,
            original_new_file_mode_line: diff_file.original_new_file_mode_line,
            original_deleted_file_mode_line: diff_file.original_deleted_file_mode_line,
            original_binary_line: diff_file.original_binary_line,
        };
        compressed_files.push(new_file);
    }
    return [compressed_files, stats];
}
// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------
function _formatOutput(diff_files, stats) {
    const output_lines = [];
    for (const diff_file of diff_files) {
        // File header
        output_lines.push(diff_file.header);
        // Bug-fix: emit rename / similarity / dissimilarity / copy
        // marker lines immediately after `diff --git`, matching git's
        // canonical output order. Previously these were captured as
        // `is_renamed=True` and dropped — output looked like a plain
        // modification of the old file's path.
        if (diff_file.rename_lines.length > 0) {
            for (const rl of diff_file.rename_lines) {
                output_lines.push(rl);
            }
        }
        // File mode indicators if present. Note: parity-bound
        // normalization to `100644` (the original mode is captured in
        // `original_new_file_mode_line` for observability).
        if (diff_file.is_new_file) {
            output_lines.push("new file mode 100644");
        }
        else if (diff_file.is_deleted_file) {
            output_lines.push("deleted file mode 100644");
        }
        if (diff_file.is_binary) {
            output_lines.push("Binary files differ");
            continue;
        }
        // Old/new file markers
        if (diff_file.old_file) {
            output_lines.push(diff_file.old_file);
        }
        if (diff_file.new_file) {
            output_lines.push(diff_file.new_file);
        }
        // Hunks
        for (const hunk of diff_file.hunks) {
            output_lines.push(hunk.header);
            for (const l of hunk.lines) {
                output_lines.push(l);
            }
        }
    }
    // Add summary
    if (stats.hunks_removed > 0 || stats.files_affected > 0) {
        const summary_parts = [
            `${stats.files_affected} files changed`,
            `+${stats.total_additions} -${stats.total_deletions} lines`,
        ];
        if (stats.hunks_removed > 0) {
            summary_parts.push(`${stats.hunks_removed} hunks omitted`);
        }
        output_lines.push(`[${summary_parts.join(", ")}]`);
    }
    return output_lines.join("\n");
}
// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * Compress git diff output.
 *
 * @param content - Raw git diff output.
 * @param config  - Compression configuration.
 * @param context - User query context for relevance scoring (default "").
 * @returns DiffCompressionResult with compressed output and metadata.
 */
export function compressDiff(content, config, context = "") {
    const lines = content.split("\n");
    const original_line_count = lines.length;
    if (original_line_count < config.min_lines_for_ccr) {
        return {
            compressed: content,
            original_line_count,
            compressed_line_count: original_line_count,
            files_affected: 0,
            additions: 0,
            deletions: 0,
            hunks_kept: 0,
            hunks_removed: 0,
            cache_key: null,
        };
    }
    // Parse diff into structured format. Returns pre-diff content
    // (commit headers, email headers from `git format-patch`, etc.)
    // alongside the parsed files. Bug-fix: previously this content was
    // silently dropped; now it's preserved verbatim before the
    // compressed file sections in the output.
    const [pre_diff_lines, diff_files] = _parseDiff(lines);
    if (diff_files.length === 0) {
        return {
            compressed: content,
            original_line_count,
            compressed_line_count: original_line_count,
            files_affected: 0,
            additions: 0,
            deletions: 0,
            hunks_kept: 0,
            hunks_removed: 0,
            cache_key: null,
        };
    }
    // Score hunks by relevance
    _scoreHunks(diff_files, context);
    // Compress each file's hunks
    const [compressed_files, stats] = _compressFiles(diff_files, config);
    // Format output
    let compressed_output = _formatOutput(compressed_files, stats);
    // Pre-diff prepend: if pre_diff_lines is non-empty, prepend verbatim.
    // Bug-fix: previously this content was silently dropped.
    if (pre_diff_lines.length > 0) {
        compressed_output = pre_diff_lines.join("\n") + "\n" + compressed_output;
    }
    // compressed_line_count is computed BEFORE the footer would be appended
    // in Python. Since we don't append a footer, this is simply the line count.
    const compressed_line_count = compressed_output.split("\n").length;
    // cache_key is always null — CCR storage happens in the router
    return {
        compressed: compressed_output,
        original_line_count,
        compressed_line_count,
        files_affected: stats.files_affected,
        additions: stats.total_additions,
        deletions: stats.total_deletions,
        hunks_kept: stats.hunks_kept,
        hunks_removed: stats.hunks_removed,
        cache_key: null,
    };
}
