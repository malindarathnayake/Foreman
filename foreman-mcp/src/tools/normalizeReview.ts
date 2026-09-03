import { toTable } from "../lib/toon.js"
import type { ReviewFinding } from "../types.js"

// ReviewFinding is defined in types.ts (shared with the ledger's durable review records).
// Re-exported here so existing importers of `normalizeReview` keep working.
export type { ReviewFinding }

export interface NormalizedReview {
  reviewer: string
  findings: ReviewFinding[]
  raw_length: number
  /**
   * Non-blank lines that appeared before any recognized finding header — preambles,
   * "what I checked" lists, "no findings" statements. They are counted, never turned
   * into findings: unmarked prose is not evidence of a defect.
   */
  unparsed_lines: number
}

type Severity = ReviewFinding["severity"]

/** Mirrors ReviewFindingSchema.description (types.ts) so every normalized finding is record_review-safe. */
const DESCRIPTION_MAX = 10000

// ─── Header grammar ──────────────────────────────────────────────────────────
// A finding starts ONLY at a line carrying an explicit severity token (or a
// "Finding N" heading, whose severity may arrive on the next line). Everything
// else is a continuation of the current finding, or unparsed when there is none.

/** Markdown list bullets and numbered items: "- ", "* ", "+ ", "• ", "1. ", "12) ". */
const LIST_PREFIX = /^(?:[-*+•]|\d{1,3}[.)])\s+/
/** Markdown headings: "## ". */
const HEADING_PREFIX = /^#{1,6}\s+/

/**
 * Leading severity in any common decoration: "HIGH:", "[HIGH]", "**HIGH**",
 * "**[HIGH]**", "[**HIGH**]", "High —". The token must be followed by a delimiter
 * or end of line so words like "Highlight" never start a finding.
 */
const LEADING_SEVERITY = /^[\[*]{0,3}(CRITICAL|HIGH|MEDIUM|LOW)[\]*]{0,3}(?=[\s:—–\-|(]|$)/i

/** "Severity: HIGH", "**Severity**: high", "Severity — Medium (rest of line)". */
const SEVERITY_FIELD = /^\**severity\**\s*[:—–\-]\s*\**(CRITICAL|HIGH|MEDIUM|LOW)\**(.*)$/i

/** Trailing "(HIGH)" / "[HIGH]" at the end of a list item or paragraph-opening line. */
const TRAILING_SEVERITY = /[\s—–\-]*[\[(]\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*[\])]\s*\.?\s*$/i

/** "### Finding 3", "Finding 3:", "## Finding #2". */
const FINDING_HEADING = /^finding\s*[#-]?\s*\d+\b/i

/** "File: src/a.ts:42", "Location — src/a.ts:42". */
const LOCATION_FIELD = /^\**(?:file|location|path|where)\**\s*[:—–\-]\s*/i

/** path.ext:line — forward or back slashes. */
const FILE_LINE = /([a-zA-Z0-9_/.\\-]+\.[a-zA-Z0-9]+):(\d+)/

/** Separators left over once a marker or location has been cut out of a line. Brackets are NOT stripped: a `[CWE-###]` prefix must survive. */
const LEADING_SEPARATORS = /^[\s:—–\-|*]+/

interface Draft {
  severity: Severity
  severityExplicit: boolean
  file: string
  line: string
  descParts: string[]
}

function newDraft(severity: Severity, explicit: boolean): Draft {
  return { severity, severityExplicit: explicit, file: "", line: "", descParts: [] }
}

/** Pull a file:line out of a header body (once) and push the remaining text as description. */
function absorbBody(draft: Draft, body: string): void {
  let desc = body
  const fm = FILE_LINE.exec(body)
  if (fm && !draft.file) {
    draft.file = fm[1]
    draft.line = fm[2]
    desc = body.replace(fm[0], " ")
  }
  desc = desc.replace(LEADING_SEPARATORS, "").replace(/\s+/g, " ").trim()
  if (desc) draft.descParts.push(desc)
}

function finalize(draft: Draft): ReviewFinding | null {
  let description = draft.descParts.join(" ").replace(/\s+/g, " ").trim()
  if (!description && !draft.file) return null
  if (description.length > DESCRIPTION_MAX) {
    description = description.slice(0, DESCRIPTION_MAX - 1) + "…"
  }
  return { severity: draft.severity, file: draft.file, line: draft.line, description }
}

/**
 * Parse raw review text into structured findings.
 *
 * Contract: a finding is created only from a recognized header (explicit severity
 * token, "Severity:" field, or "Finding N" heading). Unmarked prose before the first
 * header is counted in `unparsed_lines` and never becomes a finding — so a review
 * that says "Checked X, Y. No findings." normalizes to zero findings, not one.
 * Returns structured data + TOON text (table with `|` escaped) + a `findings_json:`
 * line the host can hand to `write_ledger record_review` verbatim.
 */
export function normalizeReview(
  reviewer: string,
  rawText: string
): { data: NormalizedReview; text: string } {
  const findings: ReviewFinding[] = []
  let current: Draft | null = null
  let unparsed = 0
  let prevBlank = true

  const flush = () => {
    if (current) {
      const f = finalize(current)
      if (f) findings.push(f)
    }
    current = null
  }

  /**
   * A header may adopt a draft that a "Finding N" heading opened but has not filled
   * yet — the heading and the severity line describe the same finding.
   */
  const startOrAdopt = (severity: Severity): Draft => {
    if (current && !current.severityExplicit && current.descParts.length === 0 && !current.file) {
      current.severity = severity
      current.severityExplicit = true
      return current
    }
    flush()
    current = newDraft(severity, true)
    return current
  }

  for (const rawLine of rawText.split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      prevBlank = true
      continue
    }

    const hadList = LIST_PREFIX.test(trimmed)
    const s = trimmed.replace(LIST_PREFIX, "").replace(HEADING_PREFIX, "").trim()
    let m: RegExpExecArray | null

    if (FINDING_HEADING.test(s)) {
      flush()
      current = newDraft("medium", false)
      const rest = s.replace(FINDING_HEADING, "").replace(LEADING_SEPARATORS, "").trim()
      if (rest) {
        if ((m = LEADING_SEVERITY.exec(rest))) {
          current.severity = m[1].toLowerCase() as Severity
          current.severityExplicit = true
          absorbBody(current, rest.slice(m[0].length))
        } else if ((m = TRAILING_SEVERITY.exec(rest))) {
          current.severity = m[1].toLowerCase() as Severity
          current.severityExplicit = true
          absorbBody(current, rest.slice(0, m.index))
        } else {
          absorbBody(current, rest)
        }
      }
    } else if ((m = SEVERITY_FIELD.exec(s))) {
      const d = startOrAdopt(m[1].toLowerCase() as Severity)
      absorbBody(d, m[2] ?? "")
    } else if ((m = LEADING_SEVERITY.exec(s))) {
      const d = startOrAdopt(m[1].toLowerCase() as Severity)
      absorbBody(d, s.slice(m[0].length))
    } else if (
      (m = TRAILING_SEVERITY.exec(s)) &&
      (hadList || prevBlank || s.search(FILE_LINE) === 0)
    ) {
      // A trailing token opens a finding only where a new item plausibly starts:
      // a list item, a paragraph opener, or a line led by a file:line reference.
      flush()
      current = newDraft(m[1].toLowerCase() as Severity, true)
      absorbBody(current, s.slice(0, m.index))
    } else if (current && LOCATION_FIELD.test(s)) {
      const rest = s.replace(LOCATION_FIELD, "")
      const fm = FILE_LINE.exec(rest)
      if (fm) {
        if (!current.file) {
          current.file = fm[1]
          current.line = fm[2]
        }
        const extra = rest.replace(fm[0], " ").replace(LEADING_SEPARATORS, "").trim()
        if (extra) current.descParts.push(extra)
      } else {
        current.descParts.push(s)
      }
    } else if (current) {
      const fm = FILE_LINE.exec(s)
      if (fm && !current.file) {
        current.file = fm[1]
        current.line = fm[2]
      }
      current.descParts.push(s)
    } else {
      unparsed++
    }

    prevBlank = false
  }

  flush()

  const data: NormalizedReview = {
    reviewer,
    findings,
    raw_length: rawText.length,
    unparsed_lines: unparsed,
  }

  // Format as TOON. Pipes inside cells are structural in this table, so they are
  // swapped for a broken bar; the JSON line below carries the untouched text.
  const cell = (v: string) => v.replace(/\|/g, "¦")
  let text =
    `reviewer: ${reviewer}\nfindings: ${findings.length}\n` +
    `unparsed_lines: ${unparsed}\nraw_length: ${rawText.length}\n`
  if (findings.length > 0) {
    text +=
      "\n" +
      toTable(
        ["severity", "file", "line", "description"],
        findings.map((f) => [f.severity, cell(f.file || "n/a"), f.line || "n/a", cell(f.description)])
      ) +
      "\n\nfindings_json: " +
      JSON.stringify(findings)
  }

  return { data, text }
}
