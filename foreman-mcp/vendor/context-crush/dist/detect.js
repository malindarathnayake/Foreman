/**
 * Strip markdown fenced code blocks from text.
 * CommonMark: opening fence is 0–3 spaces of indent followed by 3+ backticks or 3+ tildes.
 * 4+ spaces of indent does NOT open a fence (it would be an indented code block).
 * The closing fence must use the same character family (backtick vs tilde) as the opening.
 * A tilde line inside an open backtick fence is content, not a close (and vice versa).
 * If a fence is unclosed, strips from the opening fence to end of text.
 */
function stripFencedBlocks(text) {
    const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
    const lines = text.split("\n");
    const out = [];
    let inFence = false;
    let fenceChar = ""; // "`" or "~"
    for (const line of lines) {
        if (!inFence) {
            const m = FENCE_RE.exec(line);
            if (m) {
                inFence = true;
                fenceChar = m[1][0]; // first char of the fence run: "`" or "~"
                // skip the opening fence line
            }
            else {
                out.push(line);
            }
        }
        else {
            const m = FENCE_RE.exec(line);
            if (m && m[1][0] === fenceChar) {
                inFence = false;
                fenceChar = "";
                // skip the closing fence line
            }
            // skip all lines inside the fence (including mismatched fence chars)
        }
    }
    return out.join("\n");
}
/**
 * Detect the content kind of the given text.
 * Detection order: json → diff (on stripped) → log (on stripped) → text
 */
export function detectContent(text) {
    // Step 1: JSON — parse the whole raw text
    if (text.trim().length > 0) {
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null) {
                return "json";
            }
        }
        catch {
            // Not JSON
        }
    }
    // Step 2: fence stripping for subsequent checks
    const stripped = stripFencedBlocks(text);
    // Step 3: diff
    if (/^diff --git |^--- a\/|^\+\+\+ b\/|^@@ -\d/m.test(stripped)) {
        return "diff";
    }
    // Step 4: log
    // (a) At least 3 distinct lines matching keyword pattern
    const keywordLines = stripped
        .split("\n")
        .filter((line) => /\b(ERROR|FAIL|FAILED|WARN|Traceback|panicked|Exception)\b/.test(line));
    if (keywordLines.length >= 3) {
        return "log";
    }
    // (b) Session-header patterns
    if (/^={3,} (FAILURES|ERRORS|test session|short test summary)/m.test(stripped) ||
        /^npm (ERR!|WARN|info|http)/m.test(stripped) ||
        /^\s*(Compiling|Finished|Running|error\[E\d+\])/m.test(stripped)) {
        return "log";
    }
    return "text";
}
