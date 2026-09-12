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
   * Non-blank lines that belonged to no emitted finding — preambles, "what I checked"
   * lists, "no findings" statements, and list items that never named a severity. They
   * are counted, never turned into findings: unmarked prose is not evidence of a defect.
   */
  unparsed_lines: number
}

type Severity = ReviewFinding["severity"]

/** Mirrors ReviewFindingSchema.description (types.ts) so every normalized finding is record_review-safe. */
const DESCRIPTION_MAX = 10000

// ─── Grammar ─────────────────────────────────────────────────────────────────
// The text is cut into BLOCKS at item boundaries (list items, headings, "Finding N",
// a line that opens with a severity token, a table row, or a paragraph that opens with
// a location or ends with a bracketed severity). Each block is then searched for an
// EXPLICIT severity token; a block without one is counted as unparsed and never emitted.
// That is the rule Codex insisted on in the 2026-09 deliberations: unmarked prose is
// not a finding, no matter how much it looks like one.

/** List bullets and numbered items, optionally bold-wrapped: "- ", "1. ", "12) ", "**1.** ", "**1. Title**". */
const LIST_PREFIX = /^(?:\*\*)?(?:[-*+•]|\d{1,3}[.)])(?:\*\*)?\s+/
/** Markdown headings: "## ". */
const HEADING_PREFIX = /^#{1,6}\s+/
/** "Finding 3", "Finding #2", "Finding 3:". */
const FINDING_HEADING = /^finding\s*[#-]?\s*\d+\b/i

const SEV = "(CRITICAL|HIGH|MEDIUM|LOW)"
/** Leading token in any decoration: "HIGH:", "[HIGH]", "**HIGH**", "**[HIGH]**", "[**HIGH**]", "High —". Followed by a delimiter so "Highlight" never matches. */
const LEADING_SEVERITY = new RegExp(`^[\\[*]{0,3}${SEV}[\\]*]{0,3}(?=[\\s:—–\\-|(]|$)`, "i")
/** Trailing "(HIGH)" / "[HIGH]" at the end of a line. */
const TRAILING_SEVERITY = new RegExp(`[\\s—–\\-]*[\\[(]\\s*${SEV}\\s*[\\])]\\s*\\.?\\s*$`, "i")
/** A whole line that is a severity field: "Severity: HIGH", "**Severity**: high", "Severity — Medium <rest>". */
const SEVERITY_FIELD_LINE = new RegExp(`^\\**severity\\**\\s*[:—–\\-]\\s*\\**${SEV}\\**\\.?(.*)$`, "i")
/** A severity field or " — HIGH:" appearing mid-line on an item line. Only honoured when the block also names a location. */
const SEVERITY_MIDLINE = new RegExp(`(?:\\**severity\\**\\s*[:—–\\-]\\s*\\**${SEV}\\**\\.?|[—–\\-]\\s*\\**${SEV}\\**\\s*:)`, "i")
/** Priority levels, exact, bracketed or as a field value. Only honoured with a location. */
const P_LEVEL = /(?:[\[(]\s*(P[0-3])\s*[\])]|\bseverity\s*[:—–-]\s*(P[0-3])\b)/i
const P_MAP: Record<string, Severity> = { P0: "critical", P1: "high", P2: "medium", P3: "low" }

/** "File: src/a.ts:42", "Location — src/a.ts:42". */
const LOCATION_FIELD = /^\**(?:file|location|path|where)\**\s*[:—–\-]\s*/i
/** path.ext:line — forward or back slashes. */
const FILE_LINE = /([a-zA-Z0-9_/.\\-]+\.[a-zA-Z0-9]+):(\d+)/
/** Separators left over once a decoration has been cut out. Brackets are NOT stripped: a `[CWE-###]` prefix must survive. */
const LEADING_SEPARATORS = /^[\s:—–\-|*]+/
/** Residue that trails a matched severity word: "**High severity**:" leaves " severity**:". */
const SEVERITY_RESIDUE = /^\s*severity\**\s*:?/i

interface Block {
  /** Raw lines, first line included. */
  lines: string[]
  /** The first line was a "Finding N" heading with nothing after it. */
  openedByFindingHeading: boolean
  /** A severity marker was seen on some line during scanning (used only to decide whether a later "Severity:" line attaches or opens a new block). */
  sawSeverity: boolean
  /** The first line is a markdown table row. */
  table: boolean
}

function stripItemPrefix(line: string): { text: string; hadPrefix: boolean } {
  let text = line
  let hadPrefix = false
  const heading = HEADING_PREFIX.exec(text)
  if (heading) {
    text = text.slice(heading[0].length)
    hadPrefix = true
  }
  const list = LIST_PREFIX.exec(text)
  if (list) {
    text = text.slice(list[0].length)
    hadPrefix = true
  }
  return { text: text.trim(), hadPrefix }
}

function lineHasSeverityMarker(stripped: string): boolean {
  return (
    LEADING_SEVERITY.test(stripped) ||
    TRAILING_SEVERITY.test(stripped) ||
    SEVERITY_FIELD_LINE.test(stripped) ||
    SEVERITY_MIDLINE.test(stripped) ||
    P_LEVEL.test(stripped)
  )
}

/** Final description cleanup: drop bold markers, brackets emptied by a lifted location, dangling separators. `[CWE-###]` survives (only EMPTY brackets go). */
function clip(description: string): string {
  const d = description
    .replace(/\*\*/g, "")
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(LEADING_SEPARATORS, "")
    .replace(/[\s:—–\-|*]+$/, "")
    .trim()
  return d.length > DESCRIPTION_MAX ? d.slice(0, DESCRIPTION_MAX - 1) + "…" : d
}

/** Parse a markdown table row into a finding, or null for header/separator rows. */
function parseTableRow(line: string): ReviewFinding | null {
  const cells = line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim())
  let severity: Severity | undefined
  let file = ""
  let lineNo = ""
  const rest: string[] = []
  for (const cell of cells) {
    const bare = cell.replace(/^\**|\**$/g, "").trim()
    if (severity === undefined && /^(CRITICAL|HIGH|MEDIUM|LOW)$/i.test(bare)) {
      severity = bare.toLowerCase() as Severity
      continue
    }
    const fm = !file ? FILE_LINE.exec(cell) : null
    if (fm && fm.index === 0 && fm[0].length === cell.length) {
      file = fm[1]
      lineNo = fm[2]
      continue
    }
    if (bare && !/^-{2,}:?$/.test(bare)) rest.push(cell)
  }
  if (severity === undefined) return null
  const description = clip(rest.join(" "))
  if (!description && !file) return null
  return { severity, file, line: lineNo, description }
}

/** Turn one block into a finding, or null when it carries no explicit severity. */
function parseBlock(block: Block): ReviewFinding | null {
  if (block.table) return parseTableRow(block.lines[0])

  const first = stripItemPrefix(block.lines[0])
  let firstText = first.text
  let severity: Severity | undefined
  let m: RegExpExecArray | null

  // A "Finding N" heading contributes no description text.
  if ((m = FINDING_HEADING.exec(firstText))) {
    firstText = firstText.slice(m[0].length).replace(LEADING_SEPARATORS, "").trim()
  }

  const blockText = block.lines.join("\n")
  const hasLocation = FILE_LINE.test(blockText)

  if ((m = LEADING_SEVERITY.exec(firstText))) {
    severity = m[1].toLowerCase() as Severity
    firstText = firstText.slice(m[0].length).replace(SEVERITY_RESIDUE, "")
  } else if ((m = TRAILING_SEVERITY.exec(firstText))) {
    severity = m[1].toLowerCase() as Severity
    firstText = firstText.slice(0, m.index)
  } else if ((m = SEVERITY_FIELD_LINE.exec(firstText))) {
    severity = m[1].toLowerCase() as Severity
    firstText = m[2] ?? ""
  } else if (hasLocation && (m = SEVERITY_MIDLINE.exec(firstText))) {
    severity = (m[1] ?? m[2]).toLowerCase() as Severity
    firstText = (firstText.slice(0, m.index) + " " + firstText.slice(m.index + m[0].length)).trim()
  } else if (hasLocation && (m = P_LEVEL.exec(firstText))) {
    severity = P_MAP[(m[1] ?? m[2]).toUpperCase()]
    firstText = (firstText.slice(0, m.index) + " " + firstText.slice(m.index + m[0].length)).trim()
  }

  // Remaining lines: a "Severity:" line sets the severity when the first line had none;
  // "File:" lines supply the location; everything else is description.
  const descParts: string[] = []
  let file = ""
  let lineNo = ""
  const takeLocation = (text: string): string => {
    const fm = FILE_LINE.exec(text)
    if (fm && !file) {
      file = fm[1]
      lineNo = fm[2]
      return text.replace(fm[0], " ")
    }
    return text
  }

  firstText = takeLocation(firstText)
  // Each part is tidied on both ends so a decoration cut out of the middle of a line
  // ("Title — Severity: High") does not leave a dangling separator at the join.
  const tidy = (s: string) => s.replace(LEADING_SEPARATORS, "").replace(/[\s:—–\-|*]+$/, "").replace(/\s+/g, " ").trim()
  const firstClean = tidy(firstText)
  if (firstClean) descParts.push(firstClean)

  for (const raw of block.lines.slice(1)) {
    const s = raw.trim()
    if (!s) continue
    if ((m = SEVERITY_FIELD_LINE.exec(s))) {
      if (severity === undefined) severity = m[1].toLowerCase() as Severity
      const rest = (m[2] ?? "").replace(LEADING_SEPARATORS, "").trim()
      if (rest) descParts.push(takeLocation(rest).replace(LEADING_SEPARATORS, "").trim())
      continue
    }
    if (severity === undefined && hasLocation && (m = P_LEVEL.exec(s)) && /^\s*\**severity/i.test(s)) {
      severity = P_MAP[(m[1] ?? m[2]).toUpperCase()]
      continue
    }
    if (LOCATION_FIELD.test(s)) {
      const rest = takeLocation(s.replace(LOCATION_FIELD, "")).replace(LEADING_SEPARATORS, "").trim()
      if (rest) descParts.push(rest)
      continue
    }
    // Plain continuation. A location on it is adopted only when none was found yet, and
    // then it leaves the prose (it is structured data now); a second file mentioned
    // later stays in the prose.
    if (!file) {
      const fm = FILE_LINE.exec(s)
      if (fm) {
        file = fm[1]
        lineNo = fm[2]
        const rest = s.replace(fm[0], " ").replace(LEADING_SEPARATORS, "").trim()
        if (rest) descParts.push(rest)
        continue
      }
    }
    descParts.push(s)
  }

  if (severity === undefined) return null
  const description = clip(descParts.join(" "))
  if (!description && !file) return null
  return { severity, file, line: lineNo, description }
}

/**
 * Parse raw review text into structured findings.
 *
 * Contract: a finding is emitted only from a block that carries an explicit severity
 * token somewhere in it. Layouts handled: leading tokens in any decoration, bracketed
 * trailing tokens, `Severity:` fields on the item line or the next line, mid-line
 * `— HIGH:` after a location, exact `[P0]`–`[P3]` levels with a location, `Finding N`
 * headings, and markdown table rows with a severity cell. Unmarked items and prose are
 * counted in `unparsed_lines` and never emitted. Returns structured data + TOON text
 * (table with `|` escaped) + a `findings_json:` line the host can hand to
 * `write_ledger record_review` verbatim.
 */
export function normalizeReview(
  reviewer: string,
  rawText: string
): { data: NormalizedReview; text: string } {
  const findings: ReviewFinding[] = []
  const blocks: Block[] = []
  let current: Block | null = null
  let prevBlank = true

  const open = (line: string, opts: Partial<Block> = {}): Block => {
    const block: Block = { lines: [line], openedByFindingHeading: false, sawSeverity: false, table: false, ...opts }
    blocks.push(block)
    return block
  }

  for (const rawLine of rawText.split("\n")) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      prevBlank = true
      continue
    }

    if (/^\|.*\|\s*$/.test(trimmed)) {
      current = open(trimmed, { table: true })
      prevBlank = false
      continue
    }

    const { text: stripped, hadPrefix } = stripItemPrefix(trimmed)
    const startsWithLocation = FILE_LINE.exec(stripped)?.index === 0
    const isFindingHeading = FINDING_HEADING.test(stripped)
    const hasMarker = lineHasSeverityMarker(stripped)
    const isSeverityFieldLine = SEVERITY_FIELD_LINE.test(stripped)

    let boundary = false
    if (hadPrefix || isFindingHeading) {
      boundary = true
    } else if (isSeverityFieldLine) {
      // "Severity: X" on its own line attaches to a block that has no severity yet.
      boundary = current === null || current.sawSeverity
    } else if (LEADING_SEVERITY.test(stripped)) {
      // A leading token opens a finding, unless it is filling in an empty "Finding N" heading.
      boundary = !(current !== null && current.openedByFindingHeading && current.lines.length === 1)
    } else if (prevBlank && (startsWithLocation || TRAILING_SEVERITY.test(stripped))) {
      boundary = true
    }

    if (boundary || current === null) {
      const rest = isFindingHeading ? stripped.replace(FINDING_HEADING, "").replace(LEADING_SEPARATORS, "").trim() : stripped
      current = open(trimmed, { openedByFindingHeading: isFindingHeading && rest.length === 0, sawSeverity: hasMarker })
    } else {
      current.lines.push(trimmed)
      if (hasMarker) current.sawSeverity = true
    }
    prevBlank = false
  }

  let unparsed = 0
  for (const block of blocks) {
    const finding = parseBlock(block)
    if (finding) findings.push(finding)
    else unparsed += block.lines.length
  }

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
  } else if (rawText.trim().length > 0) {
    // 0.6.26 (field report 2026-09-11): a structured review came back as `findings: 0` and
    // four bare numbers, so the reader could not tell "the reviewer found nothing" from
    // "this grammar does not read that shape" and recorded nine findings by hand. Zero
    // findings out of non-empty text always says what the parser looks for.
    text +=
      "\nNOT RECOGNISED\n" +
      "  Every finding needs an EXPLICIT severity token — CRITICAL, HIGH, MEDIUM, LOW, or P0-P3.\n" +
      "  Unmarked prose is never turned into a finding, however much it reads like one.\n" +
      "  Accepted shapes (severity leading, trailing, or as its own field):\n" +
      "    - HIGH: src/a.ts:42 — the retry loop never resets the backoff\n" +
      "    - **[MEDIUM]** `src/b.go:17` missing nil check\n" +
      "    - Finding 3\n" +
      "      Severity: LOW\n" +
      "      File: src/c.py:8\n" +
      "      The log line names the wrong field.\n" +
      "  Other vocabularies (blocker / major / minor / nit) are NOT severity tokens here.\n" +
      "  If the reviewer genuinely found nothing, record the review with findings: [] directly —\n" +
      "  normalize_review is a parser for prose, not a gate."
  }

  return { data, text }
}
