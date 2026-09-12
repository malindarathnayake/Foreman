// Soft limits (0.6.20): text with no gate weight is cut to its limit with a trailing marker
// instead of refusing the whole write. A field is soft only when the ledger and the gate read
// nothing from its content beyond presence (journal msg, record_review checked[] entries and
// limitations, native reviewer checked[] entries). Ids, findings, verification evidence and
// notes keep hard limits: the gate or the distinct-id rule reads their content.
//
// One exception, stated so the classification is honest: a stage:'verification' worker_delta
// record compares checked[] paths against evidence.files (lib/reviewPredicates.ts,
// workerDeltaBlocker, basis_version 2). A truncated path can never equal a frozen guard path,
// so such a record is refused with `RANK VERIFICATION: checked must list every file in
// evidence.files (missing: ...)` — fails closed, no credential widened.
//
// [CWE-20] Bounded: output length is at most `max`, the marker is server-generated, and no
// truncated field feeds a gate predicate beyond presence (or the fail-closed path match above).
// [CWE-532] The value is scrubbed BEFORE it is cut so an env-harvested secret straddling the
// cut cannot survive as an unredacted prefix (the write-time scrub matches exact literals only).
import { z } from "zod"
import { scrub } from "./redaction.js"

/** Trailing marker written by truncateWithMarker; the number is the count of dropped UTF-16 code units. */
export const TRUNCATION_MARKER_RE = /…\[truncated (\d+) chars\]$/

/** A lone high surrogate (no low surrogate follows) — never present in truncateWithMarker output. */
const LONE_HIGH_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/

/**
 * Cuts `value` to at most `max` characters when it is longer, ending in
 * `…[truncated N chars]` where N is the number of characters not kept. A value at or under
 * `max` is returned unchanged, so the function is idempotent on its own output.
 *
 * Two guards on the cut:
 *  - a surrogate pair is never split: when the cut would land after a high surrogate the kept
 *    prefix loses one more unit (the result is then max-1 long and N counts that unit);
 *  - a kept prefix that is blank stores the empty string with no marker, so a whitespace-only
 *    entry longer than the limit still reads as blank to the non-blank rules in
 *    lib/reviewPredicates.ts (the marker must never manufacture content).
 *
 * Converges in a few iterations: the marker length is non-decreasing in N.
 */
export function truncateWithMarker(value: string, max: number): string {
  if (value.length <= max) return value
  let dropped = value.length - max
  for (let i = 0; i < 6; i++) {
    const marker = `…[truncated ${dropped} chars]`
    let keep = max - marker.length
    if (keep < 0) break
    const next = value.length - keep
    if (next !== dropped) { dropped = next; continue }
    const code = value.charCodeAt(keep - 1)
    if (code >= 0xd800 && code <= 0xdbff) keep -= 1
    const prefix = value.slice(0, keep)
    if (prefix.trim() === "") return ""
    return `${prefix}…[truncated ${value.length - keep} chars]`
  }
  throw new Error(`truncateWithMarker: no fixed point (length ${value.length}, max ${max})`)  // unreachable for max ≥ 40
}

/** Scrub, then cut: the overwrite every soft field runs. */
export function softCut(value: string, max: number): string {
  return truncateWithMarker(scrub(value), max)
}

/**
 * Text with no gate weight: over-long input is cut with a marker instead of refused.
 * `.max` stays so the rendered shape documents the limit (z.toJSONSchema still emits maxLength).
 */
export const softText = (max: number) => z.string().overwrite((v) => softCut(v, max)).max(max)

/** Path segments dotted; "[]" is a segment meaning every element of the array at that point. */
export interface SoftLimit { path: string; max: number }

interface Leaf { where: string; raw: unknown; parsed: unknown }

/**
 * Resolves every (raw, parsed) leaf pair under `segments`. Array indices are iterated on the
 * PARSED side (zod-capped: checked ≤50, reviewers ≤5) and read at the same index on the raw
 * side; returns [] whenever either side is not an object/array at an intermediate segment
 * (e.g. data.native absent).
 */
function leaves(raw: unknown, parsed: unknown, segments: readonly string[], prefix: string): Leaf[] {
  if (segments.length === 0) return [{ where: prefix, raw, parsed }]
  const [head, ...rest] = segments
  if (head === "[]") {
    if (!Array.isArray(raw) || !Array.isArray(parsed)) return []
    return parsed.flatMap((item, i) => leaves(raw[i], item, rest, `${prefix}[${i}]`))
  }
  if (!isRecord(raw) || !isRecord(parsed)) return []
  return leaves(raw[head], parsed[head], rest, prefix ? `${prefix}.${head}` : head)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Warning line for fields the schema cut, or undefined. Predicate per leaf: the raw value is a
 * string over `max` and the parsed value differs from it. `was N chars` is the RAW length —
 * before any `.trim()` the schema ran (native reviewer checked[]), so kept + marker N can be
 * smaller than N by the trimmed whitespace. A blank-prefix cut (stored empty, no marker) is
 * itemised as such. At most 5 fields are itemised; the rest are counted.
 */
export function softLimitWarning(raw: unknown, parsed: unknown, limits: readonly SoftLimit[]): string | undefined {
  const items: string[] = []
  for (const { path, max } of limits) {
    for (const leaf of leaves(raw, parsed, path.split("."), "")) {
      if (typeof leaf.raw !== "string" || leaf.raw.length <= max || typeof leaf.parsed !== "string") continue
      if (leaf.parsed === leaf.raw) continue
      const m = TRUNCATION_MARKER_RE.exec(leaf.parsed)
      if (m) {
        items.push(`${leaf.where} was ${leaf.raw.length} chars (limit ${max}), kept ${leaf.parsed.length - m[0].length} + marker '${m[0]}'`)
      } else if (leaf.parsed === "") {
        items.push(`${leaf.where} was ${leaf.raw.length} chars (limit ${max}), kept prefix was blank so the entry is stored empty`)
      }
    }
  }
  if (items.length === 0) return undefined
  const extra = items.length > 5 ? `; +${items.length - 5} more` : ""
  return `TRUNCATED: ${items.slice(0, 5).join("; ")}${extra}. The write went through; shorten or split the text if the dropped tail matters.`
}

/** True when `value` carries a high surrogate with no low surrogate after it. */
export function hasLoneHighSurrogate(value: string): boolean {
  return LONE_HIGH_SURROGATE_RE.test(value)
}
