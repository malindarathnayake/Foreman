/**
 * Log/build output compressor for test and compiler output.
 *
 * LINE-FAITHFUL TypeScript port of headroom's Python log_compressor.py.
 * Deviations from Python: (1) cache_key is always null — CCR storage happens
 * in the router (a later unit); (2) adaptive_sizer functions are inlined here
 * rather than living in a separate module.
 */
import { computeOptimalK } from "./adaptiveSizer.js";
// ---------------------------------------------------------------------------
// Pattern tables — order is semantically significant (first-match-wins)
// ---------------------------------------------------------------------------
// Format detection: arrays of [LogFormat, patterns[]] pairs — insertion order
// must match Python _FORMAT_PATTERNS dict order (PYTEST, NPM, CARGO, JEST, MAKE).
const FORMAT_PATTERNS = [
    [
        "pytest",
        [
            /^={3,} (FAILURES|ERRORS|test session|short test summary)/,
            /^(PASSED|FAILED|ERROR|SKIPPED)\s+\[/,
            /^collected \d+ items?/,
        ],
    ],
    [
        "npm",
        [
            /^npm (ERR!|WARN|info|http)/,
            /^(>|added|removed) .+ packages?/,
        ],
    ],
    [
        "cargo",
        [
            /^\s*(Compiling|Finished|Running|error\[E\d+\])/,
            /^warning: .+/,
        ],
    ],
    [
        "jest",
        [
            /^(PASS|FAIL)\s+.+\.test\.(js|ts)/,
            /^Test Suites:/,
        ],
    ],
    [
        "make",
        [
            /^make(\[\d+\])?: /,
            /^(gcc|g\+\+|clang).*-o /,
        ],
    ],
];
// Level detection: arrays of [LogLevel, pattern] pairs — insertion order
// must match Python _LEVEL_PATTERNS (ERROR, FAIL, WARN, INFO, DEBUG, TRACE).
const LEVEL_PATTERNS = [
    ["error", /\b(ERROR|error|Error|FATAL|fatal|Fatal|CRITICAL|critical)\b/],
    ["fail", /\b(FAIL|FAILED|fail|failed|Fail|Failed)\b/],
    ["warn", /\b(WARN|WARNING|warn|warning|Warn|Warning)\b/],
    ["info", /\b(INFO|info|Info)\b/],
    ["debug", /\b(DEBUG|debug|Debug)\b/],
    ["trace", /\b(TRACE|trace|Trace)\b/],
];
// Stack trace patterns
const STACK_TRACE_PATTERNS = [
    /^\s*Traceback \(most recent call last\)/,
    /^\s*File ".+", line \d+/,
    /^\s*at .+\(.+:\d+:\d+\)/, // JS stack trace
    /^\s+at [\w.$]+\(/, // Java stack trace
    /^\s*--> .+:\d+:\d+/, // Rust error
    /^\s*\d+:\s+0x[0-9a-f]+/, // Go stack trace
];
// Summary line patterns
const SUMMARY_PATTERNS = [
    /^={3,}/, // pytest separators
    /^-{3,}/,
    /^\d+ (passed|failed|skipped|error|warning)/,
    /^(Tests?|Suites?):?\s+\d+/,
    /^(TOTAL|Total|Summary)/,
    /^(Build|Compile|Test).*(succeeded|failed|complete)/,
];
// ---------------------------------------------------------------------------
// Core compressor logic
// ---------------------------------------------------------------------------
function _detectFormat(lines) {
    const sample = lines.slice(0, 100);
    const formatScores = new Map();
    for (const [logFormat, patterns] of FORMAT_PATTERNS) {
        let score = 0;
        for (const line of sample) {
            for (const pattern of patterns) {
                if (pattern.test(line)) {
                    score++;
                    break; // first-match-wins per line
                }
            }
        }
        if (score > 0) {
            formatScores.set(logFormat, score);
        }
    }
    if (formatScores.size === 0)
        return "generic";
    // max() returns FIRST key with max score in FORMAT_PATTERNS insertion order
    let bestFormat = "generic";
    let bestScore = -1;
    for (const [logFormat] of FORMAT_PATTERNS) {
        const score = formatScores.get(logFormat);
        if (score !== undefined && score > bestScore) {
            bestScore = score;
            bestFormat = logFormat;
        }
    }
    return bestFormat;
}
function _parseLines(lines, config) {
    const logLines = [];
    let inStackTrace = false;
    let stackTraceLines = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const logLine = {
            line_number: i,
            content: line,
            level: "unknown",
            is_stack_trace: false,
            is_summary: false,
            score: 0.0,
        };
        // Detect level — first-match-wins
        for (const [level, pattern] of LEVEL_PATTERNS) {
            if (pattern.test(line)) {
                logLine.level = level;
                break;
            }
        }
        // Detect stack trace — any matching pattern sets in_stack_trace AND resets counter
        for (const pattern of STACK_TRACE_PATTERNS) {
            if (pattern.test(line)) {
                inStackTrace = true;
                stackTraceLines = 0;
                break;
            }
        }
        if (inStackTrace) {
            logLine.is_stack_trace = true;
            stackTraceLines++;
            // End stack trace after max lines or blank line (blank line IS still marked)
            if (stackTraceLines > config.stack_trace_max_lines || !line.trim()) {
                inStackTrace = false;
            }
        }
        // Detect summary lines
        for (const pattern of SUMMARY_PATTERNS) {
            if (pattern.test(line)) {
                logLine.is_summary = true;
                break;
            }
        }
        // Score line
        logLine.score = _scoreLine(logLine);
        logLines.push(logLine);
    }
    return logLines;
}
function _scoreLine(logLine) {
    const levelScores = {
        error: 1.0,
        fail: 1.0,
        warn: 0.5,
        info: 0.1,
        debug: 0.05,
        trace: 0.02,
        unknown: 0.1,
    };
    let score = levelScores[logLine.level] ?? 0.1;
    if (logLine.is_stack_trace)
        score += 0.3;
    if (logLine.is_summary)
        score += 0.4;
    return Math.min(1.0, score);
}
function _selectWithFirstLast(lines, maxCount, config) {
    if (lines.length <= maxCount)
        return lines;
    const selected = [];
    if (config.keep_first_error && lines.length > 0) {
        selected.push(lines[0]);
    }
    // Compare by line_number for identity
    const lastLine = lines[lines.length - 1];
    if (config.keep_last_error && lines.length > 0) {
        const alreadyIn = selected.some((s) => s.line_number === lastLine.line_number);
        if (!alreadyIn) {
            selected.push(lastLine);
        }
    }
    const remaining = maxCount - selected.length;
    if (remaining > 0) {
        const selectedNums = new Set(selected.map((s) => s.line_number));
        const candidates = lines.filter((l) => !selectedNums.has(l.line_number));
        // Stable sort by score descending (JS sort is stable per ES2019)
        candidates.sort((a, b) => b.score - a.score);
        selected.push(...candidates.slice(0, remaining));
    }
    return selected;
}
function _dedupeSimilar(lines) {
    const seenPatterns = new Set();
    const deduped = [];
    for (const line of lines) {
        let normalized = line.content.replace(/\d+/g, "N");
        normalized = normalized.replace(/\/[\w/]+\//g, "/PATH/");
        normalized = normalized.replace(/0x[0-9a-f]+/g, "ADDR");
        if (!seenPatterns.has(normalized)) {
            seenPatterns.add(normalized);
            deduped.push(line);
        }
    }
    return deduped;
}
function _addContext(allLines, selected, config) {
    // Collect selected_indices FIRST
    const selectedIndices = new Set(selected.map((l) => l.line_number));
    const contextIndices = new Set();
    for (const idx of selectedIndices) {
        // Lines before
        const beforeStart = Math.max(0, idx - config.error_context_lines);
        for (let i = beforeStart; i < idx; i++) {
            contextIndices.add(i);
        }
        // Lines after
        const afterEnd = Math.min(allLines.length, idx + config.error_context_lines + 1);
        for (let i = idx + 1; i < afterEnd; i++) {
            contextIndices.add(i);
        }
    }
    // Append context lines not already selected
    for (const idx of contextIndices) {
        if (!selectedIndices.has(idx) && idx < allLines.length) {
            selected.push(allLines[idx]);
        }
    }
    return selected;
}
function _selectLines(logLines, config, bias) {
    const allLineStrings = logLines.map((l) => l.content);
    const adaptiveMax = computeOptimalK(allLineStrings, bias, 10, config.max_total_lines);
    const errors = [];
    const fails = [];
    let warnings = [];
    const stackTraces = [];
    const summaries = [];
    let currentStack = [];
    for (const logLine of logLines) {
        if (logLine.level === "error") {
            errors.push(logLine);
        }
        else if (logLine.level === "fail") {
            fails.push(logLine);
        }
        else if (logLine.level === "warn") {
            warnings.push(logLine);
        }
        if (logLine.is_stack_trace) {
            currentStack.push(logLine);
        }
        else if (currentStack.length > 0) {
            stackTraces.push(currentStack);
            currentStack = [];
        }
        if (logLine.is_summary) {
            summaries.push(logLine);
        }
    }
    if (currentStack.length > 0) {
        stackTraces.push(currentStack);
    }
    let selected = [];
    // Select errors (first, last, highest scoring)
    if (errors.length > 0) {
        const selectedErrors = _selectWithFirstLast(errors, config.max_errors, config);
        selected.push(...selectedErrors);
    }
    // Select fails
    if (fails.length > 0) {
        const selectedFails = _selectWithFirstLast(fails, config.max_errors, config);
        selected.push(...selectedFails);
    }
    // Select warnings (dedupe if configured)
    if (warnings.length > 0) {
        if (config.dedupe_warnings) {
            warnings = _dedupeSimilar(warnings);
        }
        selected.push(...warnings.slice(0, config.max_warnings));
    }
    // Select stack traces
    for (const stack of stackTraces.slice(0, config.max_stack_traces)) {
        selected.push(...stack.slice(0, config.stack_trace_max_lines));
    }
    // Always include summary lines
    if (config.keep_summary_lines) {
        selected.push(...summaries);
    }
    // Add context lines around errors
    selected = _addContext(logLines, selected, config);
    // Sort by line_number and dedupe by line_number (Map preserves insertion order;
    // sorted ascending by line_number via Map keyed on line_number)
    const dedupeMap = new Map();
    for (const l of selected) {
        if (!dedupeMap.has(l.line_number)) {
            dedupeMap.set(l.line_number, l);
        }
    }
    selected = Array.from(dedupeMap.values()).sort((a, b) => a.line_number - b.line_number);
    // Apply adaptive line limit
    if (selected.length > adaptiveMax) {
        selected.sort((a, b) => b.score - a.score);
        selected = selected.slice(0, adaptiveMax);
        selected.sort((a, b) => a.line_number - b.line_number);
    }
    return selected;
}
function _formatOutput(selected, allLines) {
    const stats = {
        errors: allLines.filter((l) => l.level === "error").length,
        fails: allLines.filter((l) => l.level === "fail").length,
        warnings: allLines.filter((l) => l.level === "warn").length,
        info: allLines.filter((l) => l.level === "info").length,
        total: allLines.length,
        selected: selected.length,
    };
    const outputLines = selected.map((l) => l.content);
    const omitted = allLines.length - selected.length;
    if (omitted > 0) {
        const summaryParts = [];
        for (const [levelName, countKey] of [
            ["ERROR", "errors"],
            ["FAIL", "fails"],
            ["WARN", "warnings"],
            ["INFO", "info"],
        ]) {
            const count = stats[countKey];
            if (count > 0) {
                summaryParts.push(`${count} ${levelName}`);
            }
        }
        if (summaryParts.length > 0) {
            outputLines.push(`[${omitted} lines omitted: ${summaryParts.join(", ")}]`);
        }
    }
    return [outputLines.join("\n"), stats];
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Compress log output. Line-faithful TypeScript port of Python LogCompressor.compress().
 *
 * @param content - Raw log output string.
 * @param config  - LogCompressorConfig (the `enabled` field is ignored here;
 *                  enablement is the router's responsibility).
 * @param bias    - Compression bias multiplier (>1 = keep more, <1 = keep fewer).
 *                  Default 1.0.
 */
export function compressLog(content, config, bias = 1.0) {
    const lines = content.split("\n");
    // Early return when below threshold — mirrors Python compress() early return
    if (lines.length < config.min_lines_for_ccr) {
        return {
            compressed: content,
            original: content,
            original_line_count: lines.length,
            compressed_line_count: lines.length,
            format_detected: "generic",
            compression_ratio: 1.0,
            cache_key: null,
            stats: {},
        };
    }
    // Detect format
    const logFormat = _detectFormat(lines);
    // Parse and categorize lines
    const logLines = _parseLines(lines, config);
    // Select important lines (with adaptive sizing)
    const selected = _selectLines(logLines, config, bias);
    // Format output with summaries
    const [compressed, stats] = _formatOutput(selected, logLines);
    const ratio = compressed.length / Math.max(content.length, 1);
    // cache_key is always null — CCR storage happens in the router (intentional deviation)
    return {
        compressed,
        original: content,
        original_line_count: lines.length,
        compressed_line_count: selected.length,
        format_detected: logFormat,
        compression_ratio: ratio,
        cache_key: null,
        stats,
    };
}
