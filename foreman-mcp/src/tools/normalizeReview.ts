import { toTable } from "../lib/toon.js"

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low"
  file: string
  line: string
  description: string
}

export interface NormalizedReview {
  reviewer: string
  findings: ReviewFinding[]
  raw_length: number
}

/**
 * Parse raw review text into structured findings.
 * Strategy: look for severity markers, file:line references, and description text.
 * Returns structured data + TOON table output.
 */
export function normalizeReview(
  reviewer: string,
  rawText: string
): { data: NormalizedReview; text: string } {
  const findings: ReviewFinding[] = []
  const lines = rawText.split("\n")

  // Pattern: look for lines with severity markers and file:line references
  // Common patterns in review output:
  // - "CRITICAL: description" or "[CRITICAL] description" or "**CRITICAL** description"
  // - "file.ts:42 — description" or "file.ts:42: description"
  const severityPattern = /^\s*\[?\*{0,2}(CRITICAL|HIGH|MEDIUM|LOW)\*{0,2}\]?[\s:—-]*/i
  const fileLinePattern = /([a-zA-Z0-9_/.-]+\.[a-zA-Z]+):(\d+)/

  let currentSeverity: ReviewFinding["severity"] = "medium"
  let currentFile = ""
  let currentLine = ""
  let currentDesc = ""

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Check for severity marker
    const severityMatch = trimmed.match(severityPattern)
    if (severityMatch) {
      // If we have accumulated a finding, push it
      if (currentDesc) {
        findings.push({
          severity: currentSeverity,
          file: currentFile,
          line: currentLine,
          description: currentDesc.trim(),
        })
      }
      currentSeverity = severityMatch[1].toLowerCase() as ReviewFinding["severity"]
      currentFile = ""
      currentLine = ""

      // Check if file:line is on the same line
      const fileMatch = trimmed.match(fileLinePattern)
      if (fileMatch) {
        currentFile = fileMatch[1]
        currentLine = fileMatch[2]
      }

      // Description is everything after the severity marker
      const afterSeverity = trimmed
        .replace(severityPattern, "")
        .replace(fileLinePattern, "")
        .replace(/[\[\]*:—-]+/g, " ")
        .trim()
      currentDesc = afterSeverity
    } else {
      // Check if it's a file:line reference
      const fileMatch = trimmed.match(fileLinePattern)
      if (fileMatch && !currentFile) {
        currentFile = fileMatch[1]
        currentLine = fileMatch[2]
      }

      // Append to current description (always accumulate, even when currentDesc starts empty)
      currentDesc = currentDesc ? currentDesc + " " + trimmed : trimmed
    }
  }

  // Push last accumulated finding
  if (currentDesc) {
    findings.push({
      severity: currentSeverity,
      file: currentFile,
      line: currentLine,
      description: currentDesc.trim(),
    })
  }

  const data: NormalizedReview = {
    reviewer,
    findings,
    raw_length: rawText.length,
  }

  // Format as TOON
  let text = `reviewer: ${reviewer}\nfindings: ${findings.length}\nraw_length: ${rawText.length}\n`
  if (findings.length > 0) {
    text +=
      "\n" +
      toTable(
        ["severity", "file", "line", "description"],
        findings.map((f) => [f.severity, f.file || "n/a", f.line || "n/a", f.description])
      )
  }

  return { data, text }
}
