/**
 * Protected-literal fidelity check for lossy compression (v0.6.14).
 *
 * Foreman compresses `run_tests` and `invoke_advisor` output before the pit-boss reads
 * it, and the pit-boss reads exactly the things a lossy compressor is most likely to
 * mangle: the failing file and line, and the exit code. Until now the only guard was that
 * a retrieval marker survived and the output was non-empty (`lossyGuardsReject`) — a
 * digest could drop every location in a failure report and still be served.
 *
 * The principle is the one used when compressing text for a model to read: remove only
 * what a reader can reliably reconstruct, keep what a reader cannot safely invent.
 * Grammatical scaffolding is reconstructible. A line number is not.
 *
 * Failure semantics:
 *   - a critical literal in the original, ABSENT from the digest → reject
 *   - a critical literal absent from the original, PRESENT in the digest → reject
 *   - a repeated literal whose count drops but stays above zero → allow, since
 *     deduplication is what a compressor is for and the value is still recoverable
 *
 * This never rewrites anything. On any failure the caller serves the original text.
 */

/**
 * Literal classes a reader cannot reconstruct from context. Order matters: an earlier
 * pattern claims its span, so a path inside a longer `file:line` is counted once.
 *
 * `critical` decides what GATES rather than what is merely counted, and it was set from
 * measurement rather than taste. Compressing this repository's own 5,000-line test
 * fixture keeps 4 of 4 paths and drops 103 of 103 incidental `45ms`-style timings.
 * Dropping bulk repetition is the compressor's whole purpose, so gating on every class
 * would reject honest work, and gating on none would let a digest lose the failing
 * location. The critical set is therefore the literals a pit-boss reads to reach a
 * verdict AND that a working compressor was measured to preserve. Everything else is
 * counted for diagnosis and never blocks.
 */
const PROTECTED: Array<{ id: string; re: RegExp; critical?: boolean }> = [
  // Most specific first: `exit_code: 1` is one literal, not a bare number the generic
  // class would swallow.
  { id: "exit_code", re: /\bexit[_ ]code:?[ \t]*-?\d+/gi, critical: true },
  // file:line and file:line:col — the most load-bearing literal in test output. The
  // extension must START WITH A LETTER, otherwise an address such as 127.0.0.1:5432
  // reads as a source location and dropping it would block honest compression.
  { id: "file_line", re: /\b[\w./\\-]+\.[a-zA-Z]\w{0,9}:\d+(?::\d+)?\b/g, critical: true },
  // Absolute and relative paths with an extension.
  { id: "path", re: /\b(?:[a-zA-Z]:\\|\.{0,2}\/)?(?:[\w.-]+[/\\])+[\w.-]+\.[a-zA-Z]\w{0,9}\b/g, critical: true },
  { id: "url", re: /\bhttps?:\/\/[^\s"'<>)\]]+/g },
  { id: "sha", re: /\b[0-9a-f]{7,64}\b/g },
  { id: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { id: "env_var", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
  { id: "long_flag", re: /(?<![\w-])--[a-zA-Z][\w-]*/g },
  { id: "short_flag", re: /(?<![\w-])-[a-zA-Z]\b/g },
  // Numbers carrying meaning: counts, durations, sizes, percentages. The separator is a
  // space or tab, never \s — across a newline it would join a count to the next line's
  // first word and claim a span belonging to another class.
  { id: "number_unit", re: /\b\d+(?:\.\d+)?[ \t]?(?:ms|s|m|h|kb|mb|gb|%|passed|failed|skipped|errors?|warnings?)\b/gi },
]

export interface FidelityReport {
  ok: boolean
  /** Critical literals in the original that the candidate dropped entirely. */
  lost: string[]
  /** Critical literals the candidate introduced that the original never contained. */
  invented: string[]
  /** Non-fatal: a repeated literal whose count fell but did not reach zero. */
  deduped: string[]
}

/**
 * Retrieval markers are Foreman's own annotation rather than content. Counting the hash
 * inside one would make every compressed digest look as though it invented a literal.
 */
const CCR_MARKER = /<<ccr:[^>]*>>/g

/** Count every protected literal, consuming matched spans so classes cannot double-count. */
export function extractLiterals(text: string): Map<string, number> {
  const body = text.replace(CCR_MARKER, " ")
  const counts = new Map<string, number>()
  // Spans already claimed by an earlier, more specific class.
  const claimed: Array<[number, number]> = []
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s)

  for (const { id, re } of PROTECTED) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const start = m.index
      const end = start + m[0].length
      if (overlaps(start, end)) continue
      claimed.push([start, end])
      const key = `${id}:${m[0]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

const CRITICAL_CLASSES = new Set(PROTECTED.filter((c) => c.critical).map((c) => c.id))

/** Only a critical class gates; the rest are counted for diagnosis. */
function isCritical(key: string): boolean {
  return CRITICAL_CLASSES.has(key.slice(0, key.indexOf(":")))
}

/** Strip the class prefix for a readable report line. */
function display(key: string): string {
  const idx = key.indexOf(":")
  const cls = key.slice(0, idx)
  const value = key.slice(idx + 1)
  return `${cls} ${value.length > 120 ? `${value.slice(0, 120)}…` : value}`
}

/** Most entries reported per bucket; a corrupted digest can differ in hundreds of places. */
const MAX_REPORTED = 10

/**
 * Compare a candidate against its original. `ok` is false when a critical literal was
 * lost entirely or invented from nothing.
 */
export function checkLiteralFidelity(original: string, candidate: string): FidelityReport {
  const before = extractLiterals(original)
  const after = extractLiterals(candidate)
  const lost: string[] = []
  const deduped: string[] = []
  const invented: string[] = []

  for (const [key, count] of before) {
    const now = after.get(key) ?? 0
    if (now === 0) {
      if (isCritical(key)) lost.push(display(key))
    } else if (now < count) {
      deduped.push(`${display(key)} (${count} -> ${now})`)
    }
  }
  for (const [key, count] of after) {
    if (!before.has(key) && count > 0 && isCritical(key)) invented.push(display(key))
  }

  return {
    ok: lost.length === 0 && invented.length === 0,
    lost: lost.slice(0, MAX_REPORTED),
    invented: invented.slice(0, MAX_REPORTED),
    deduped: deduped.slice(0, MAX_REPORTED),
  }
}

/** One-line reason for the rejection, for stderr diagnostics. */
export function describeFidelityFailure(report: FidelityReport): string {
  const parts: string[] = []
  if (report.lost.length > 0) parts.push(`lost ${report.lost.length}: ${report.lost.join(", ")}`)
  if (report.invented.length > 0) parts.push(`invented ${report.invented.length}: ${report.invented.join(", ")}`)
  return parts.join("; ")
}
