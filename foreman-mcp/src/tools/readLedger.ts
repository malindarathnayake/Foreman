import path from "path"
import { effectiveSeverity, effectiveClassification, isSuperseded, reviewIncompleteness } from "../lib/reviewPredicates.js"
import { computeGateUnitsHash, readLedgerWithStatus } from "../lib/ledger.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import { renderDelegationMetrics } from "../lib/delegationMetrics.js"
import { renderReviewOutcomes } from "../lib/reviewBasis.js"
import { reconstruct, type ReconstructReport } from "../lib/reconstruct.js"
import type { ReadLedgerInput, Unit } from "../types.js"

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const MAX_CELL_CHARS = 240
const MAX_OUTPUT_CHARS = 50000

/**
 * Neutralise one cell so a stored value can never start a line, add a column or imitate a
 * header line: whitespace (newlines included) collapses to one space, pipe lookalikes become
 * a broken bar, and control, bidi, zero-width and tag characters become U+FFFD.
 * [CWE-74] [CWE-116] [CWE-150]
 */
function encodeCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[|\uFF5C\u2502]/g, "¦")
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200C\u200E\u200F\u2060-\u2064\u061C\u00AD\u034F\u180E]|[\u{E0000}-\u{E007F}]/gu, "\uFFFD")
    .trim()
}

function clipCell(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CELL_CHARS) return { text, truncated: false }
  let head = text.slice(0, MAX_CELL_CHARS - 1)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return { text: `${head}…`, truncated: true }
}

/** A stored enum as a closed set: the value, "unspecified" when absent, "invalid" for anything else. */
function closedValue(value: unknown, allowed: readonly string[]): string {
  if (value === undefined) return "unspecified"
  return typeof value === "string" && allowed.includes(value) ? value : "invalid"
}

function renderPage(
  headers: string[],
  rows: string[][],
  input: ReadLedgerInput,
  truncationHint?: string,
  extraHeader?: Record<string, string | number>,
): string {
  const cursor = Math.max(0, Math.min(input.cursor ?? 0, rows.length))
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
  const candidates = rows.slice(cursor, cursor + limit)
  const selected: string[][] = []
  let size = 0
  for (const row of candidates) {
    const length = row.reduce((n, cell) => n + (input.include_full_text ? cell.length : Math.min(cell.length, MAX_CELL_CHARS)), 0) + row.length * 4
    if (size + length > MAX_OUTPUT_CHARS - 2000) break
    selected.push(row)
    size += length
  }
  // Stall guard: a single row over the budget must still advance the cursor, so it is clipped and counted.
  const forceClip = selected.length === 0 && candidates.length > 0
  if (forceClip) selected.push(candidates[0])
  let truncatedCells = 0
  const compactRows = selected.map((row) => row.map((cell) => {
    const encoded = encodeCell(cell)
    if (input.include_full_text && !forceClip) return encoded
    const clipped = clipCell(encoded)
    if (clipped.truncated) truncatedCells++
    return clipped.text
  }))
  const nextCursor = cursor + selected.length < rows.length ? cursor + selected.length : "none"
  const header: Record<string, string | number> = {
    total_rows: rows.length,
    cursor,
    returned: selected.length,
    next_cursor: nextCursor,
    truncated_cells: truncatedCells,
    ...extraHeader,
  }
  // Query-specific recovery path, emitted only when something was actually
  // clipped — untruncated output stays byte-identical.
  if (truncatedCells > 0 && truncationHint) header.hint = truncationHint
  return [toKeyValue(header), toTable(headers, compactRows)].join("\n")
}

function boundNonPageOutput(text: string, query: string, phase?: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return toKeyValue({
    error: "ledger_output_too_large",
    query,
    phase: phase ?? "all",
    characters: text.length,
    max_output_chars: MAX_OUTPUT_CHARS,
    hint:
      "Use session_orient for resume state, add a phase filter, or use a paged table query with cursor/limit. " +
      "Use phase+unit_id for one unit.",
  })
}

/** The newest owner grant on a unit, as one line: open with what is left, or closed with how it was spent. */
function describeGrant(unit: Unit): string {
  const g = unit.cap_grants?.[unit.cap_grants.length - 1]
  if (!g) return "none"
  const used = `${g.granted - g.remaining}/${g.granted} used`
  return g.closed ? `#${g.id} closed (${g.closed.reason}), ${used}` : `#${g.id} open, ${g.remaining} of ${g.granted} remaining`
}

/**
 * The recovery worksheet (0.6.26). Deliberately a worksheet and not a writer: a preflight
 * record may hold the verified brief text as well as its hash. This read-only report
 * names replayable records; legacy hash-only records still need the operator's brief.
 */
function renderReconstruct(r: ReconstructReport): string {
  const head = toKeyValue({
    ledger_phases: r.ledger_phases.join(", ") || "none",
    phases_attested: [...r.phases.keys()].join(", ") || "none",
    units_attested: r.units.length,
    units_missing_from_ledger: r.units.filter((u) => u.missing_unit).length,
    unrecorded_attempts: r.units.reduce((n, u) => n + u.unrecorded_attempts.length, 0),
    orphaned_receipts: r.orphaned_receipts.length,
  })
  const sources = toTable(["sidecar", "status", "detail"], r.sources.map((s) => [s.file, s.status, s.detail]))
  const missing = r.units.filter((u) => u.missing_unit || u.unrecorded_attempts.length > 0)
  const body = missing.length === 0
    ? "\nNothing to replay: every unit the sidecars attest is registered in the ledger, and every passing preflight record has a delegation carrying its brief_hash."
    : "\n" + toTable(
        ["phase", "unit", "in_ledger", "attempts_attested", "unrecorded_brief_hashes", "files_promised"],
        missing.map((u) => [
          u.phase,
          u.unit_id,
          u.missing_unit ? "MISSING" : "yes",
          String(u.preflights.length),
          u.unrecorded_attempts.map((p) => `${p.brief_hash}@${p.ts}`).join(" ") || "none",
          [...new Set(u.unrecorded_attempts.flatMap((p) => (p.forward ?? []).map((f) => f.file)))].join(" ") || "none",
        ]),
      )
  const receipts = r.orphaned_receipts.length === 0 ? "" :
    "\n\nORPHANED SEAT RECEIPTS (a review was recorded against each and the record is gone)\n" +
    toTable(["receipt", "phase", "review_ts", "seat"], r.orphaned_receipts.map((c) => [c.id, c.phase, c.review_ts, `${c.cli ?? "?"}/${c.model_served ?? "?"}`])) +
    "\nThese receipts are reclaimable: record_review with the same seat_receipt is accepted now that the ledger " +
    "holds no record citing it, and the rebind is written into the receipts chain."
  return [
    head,
    "\nSIDECARS READ\n" + sources,
    "\nREPLAY WORKSHEET" + body,
    receipts,
    "\nHOW TO USE THIS\n" +
    "  1. declare_phase_units for every phase above whose units the ledger is missing.\n" +
    "  2. For each unrecorded attempt, set_unit_status s:'delegated' with data.brief_hash to reuse the stored brief.\n" +
    "     For legacy records, Foreman holds only the hash: supply the ORIGINAL brief text as well.\n" +
    "     Different text is refused. When the original is gone, run preflight_check on the reconstructed\n" +
    "     brief and delegate under its new hash — a re-attested attempt, not a forged one.\n" +
    "  3. Re-record verdicts and reviews last, so the gate predicates see a complete unit history.\n" +
    "  Nothing in this report has been written to the ledger.",
  ].join("\n")
}

export async function handleReadLedger(filePath: string, input: ReadLedgerInput): Promise<string> {
  // Read-only: never rename a corrupt ledger from a read path
  const { ledger, corrupt } = await readLedgerWithStatus(filePath, { readOnly: true })
  if (corrupt) {
    return toKeyValue({
      error: "ledger_corrupt",
      path: filePath,
      hint:
        "Ledger JSON failed to parse. File left untouched. Inspect/restore it manually before writing — " +
        "the next write_ledger call will rename it to .corrupt.<ts> and start a fresh ledger.",
    })
  }
  const query = input.query ?? "full"

  const phaseEntries: Array<[string, (typeof ledger.phases)[string]]> = input.phase
    ? ledger.phases[input.phase]
      ? [[input.phase, ledger.phases[input.phase]]]
      : []
    : Object.entries(ledger.phases)

  // If input has phase and unit_id → return single unit as key/value
  if (input.phase && input.unit_id && input.query === undefined) {
    const unit = ledger.phases[input.phase]?.units[input.unit_id]
    if (!unit) return toKeyValue({ error: "unit not found", phase: input.phase, unit_id: input.unit_id })
    return boundNonPageOutput(toKeyValue({
      unit_id: input.unit_id,
      phase: input.phase,
      status: unit.s,
      verdict: unit.v,
      tier: unit.tier ?? "n/a",
      route_reason: unit.route_reason ?? "n/a",
      via: unit.via ?? "n/a",
      note: unit.note ?? "n/a",
      worker: unit.w ?? "none",
      delegations: String(unit.delegations?.length ?? 0),
      direct_fixes: String(unit.direct_fixes?.length ?? 0),
      rejections: String(unit.rej.length),
      attempts: String(unit.attempt_seq ?? unit.delegations?.length ?? 0),
      failed_since_pass: unit.epoch_failed === undefined ? "n/a" : String(unit.epoch_failed),
      needs_attempt: unit.needs_attempt ? "true" : "false",
      cap_grant: describeGrant(unit),
      outcomes: Object.entries(unit.outcomes ?? {}).map(([k, v]) => `${k}:${v}`).join(" ") || "none recorded",
      probes: unit.probes?.length ? `${unit.probes.filter((p) => p.passed).length} passed / ${unit.probes.length} (newest ${unit.probes.at(-1)!.method} ${unit.probes.at(-1)!.target} -> ${unit.probes.at(-1)!.status ?? "transport error"})` : "none",
      oracle: unit.oracle ? `${unit.oracle.killed}/${unit.oracle.mutations} killed, survivors ${unit.oracle.survivors.join(",") || "none"}` : "none",
    }), "unit", input.phase)
  }

  // query-based filtering
  switch (query) {
    case "verdicts": {
      const rows: string[][] = []
      for (const [phaseId, phase] of phaseEntries) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
          if (input.unit_id && unitId !== input.unit_id) continue
          if (input.verdict && unit.v !== input.verdict) continue
          const row = [phaseId, unitId, unit.tier ?? "", unit.v, unit.via ?? ""]
          if (input.include_notes === true) row.push(unit.note ?? "")
          rows.push(row)
        }
      }
      const headers = ["phase", "unit", "tier", "verdict", "via"]
      if (input.include_notes === true) headers.push("note")
      return renderPage(headers, rows, input, "full note: read_ledger({ phase, unit_id })")
    }
    case "rejections": {
      const rows: string[][] = []
      for (const [phaseId, phase] of phaseEntries) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
          if (input.unit_id && unitId !== input.unit_id) continue
          for (const rej of unit.rej) {
            rows.push([phaseId, unitId, rej.r, rej.msg, rej.ts])
          }
        }
      }
      return renderPage(
        ["phase", "unit", "reviewer", "message", "timestamp"],
        rows,
        input,
        'full text: repeat this query with include_full_text:true and cursor/limit'
      )
    }
    case "phase_gates": {
      const rows: string[][] = []
      for (const [phaseId, phase] of phaseEntries) {
        // D2b read-time staleness: n/a = no hash recorded (pre-v0.5.0 gate — never stale).
        const stale = !phase.gate_units_hash
          ? "n/a"
          : computeGateUnitsHash(phase.units, phase.declared_units) === phase.gate_units_hash.hash
            ? "-"
            : "STALE"
        rows.push([phaseId, phase.s, phase.g, stale])
      }
      return renderPage(["phase", "status", "gate", "stale"], rows, input)
    }
    case "reviews": {
      const rows: string[][] = []
      const tally = { complete: 0, partial: 0, failed: 0, unspecified: 0, invalid: 0 }
      for (const [phaseId, phase] of phaseEntries) {
        const pool = phase.reviews ?? []
        for (const review of pool) {
          const unitId = input.unit_id
          // Same reading as the gate (ledger.ts:1389): a finding with no or empty units is unattributed.
          const namesUnit = (f: (typeof review.findings)[number]) =>
            Array.isArray(f.units) && f.units.length > 0 && unitId !== undefined && f.units.includes(unitId)
          const attributed = (f: (typeof review.findings)[number]) => Array.isArray(f.units) && f.units.length > 0
          let inScope = true
          if (unitId) {
            const scope = review.units ?? Object.keys(review.unit_attempts ?? phase.units ?? {})
            inScope = Array.isArray(scope) && scope.includes(unitId)
            if (!inScope && !review.findings.some(namesUnit)) continue
          }
          // Unattributed findings belong to the review's own scope, so they show only when the review covers the unit.
          const findingOnUnit = (f: (typeof review.findings)[number]) => !unitId || (attributed(f) ? namesUnit(f) : inScope)
          const completion = closedValue(review.completion, ["complete", "partial", "failed"])
          const stage = closedValue(review.stage, ["independent", "cross_exam", "verification", "fan", "native"])
          tally[completion as keyof typeof tally]++
          const visible = review.findings.map((f, index) => ({ f, index })).filter(({ f }) => findingOnUnit(f))
          const parts = [`[review] findings=${review.findings.length}`]
          if (unitId) {
            parts.push(`unit_findings=${visible.length}`)
            const snapshot = review.unit_attempts && Object.hasOwn(review.unit_attempts, unitId) ? review.unit_attempts[unitId] : undefined
            const current = phase.units && Object.hasOwn(phase.units, unitId) ? phase.units[unitId]?.attempt_seq : undefined
            parts.push(`unit_attempt=${snapshot ?? "unspecified"}/${current ?? "unspecified"}`)
          }
          parts.push(`checked=${Array.isArray(review.checked) ? review.checked.length : "unspecified"}`)
          parts.push(`units=${Array.isArray(review.units) ? review.units.length : "unscoped"}`)
          // A malformed hand-edited record must not take down the whole query; say the marks are unavailable.
          try {
            if (isSuperseded(review, pool, phase)) parts.push("superseded=yes")
            const incomplete = reviewIncompleteness(review)
            if (incomplete !== null) parts.push(`gate_incomplete=${encodeCell(incomplete)}`)
          } catch {
            parts.push("gate_marks=unavailable (malformed record)")
          }
          const limitations = review.limitations === undefined ? "" : encodeCell(String(review.limitations))
          parts.push(limitations === "" ? "limitations=none" : `limitations: ${limitations}`)
          rows.push([phaseId, review.advisor, review.ts, completion, stage, "-", "-", "-", parts.join("; ")])
          for (const { f, index } of visible) {
            rows.push([phaseId, review.advisor, review.ts, completion, stage, String(index), effectiveSeverity(f), effectiveClassification(f) ?? "unclassified", f.description])
          }
        }
      }
      const rollup = `complete=${tally.complete} partial=${tally.partial} failed=${tally.failed}` +
        (tally.unspecified > 0 ? ` unspecified=${tally.unspecified}` : "") +
        (tally.invalid > 0 ? ` invalid=${tally.invalid}` : "")
      return renderPage(
        ["phase", "advisor", "review_ts", "completion", "stage", "finding_index", "severity", "class", "finding"],
        rows,
        input,
        'full text: repeat this query with include_full_text:true and cursor/limit',
        { review_completion: rollup },
      )
    }
    case "delegation_metrics": {
      // Sidecar lives next to the ledger — byte-identical path rule to writeLedger.ts:100 / invokeWorker.ts:380.
      const sidecarPath = path.join(path.dirname(filePath), ".foreman-events.jsonl")
      const metrics = await renderDelegationMetrics(ledger, sidecarPath)
      // 5b: S6 evidence footer — real savings accumulated in ledger.ccr_stats by
      // write_ledger folds. Rendered only when evidence exists, so ledgers without
      // ccr_stats produce byte-identical output to pre-5b (golden stability).
      const stats = ledger.ccr_stats
      if (!stats || Object.keys(stats).length === 0) return boundNonPageOutput(metrics, query, input.phase)
      let calls = 0
      let before = 0
      let after = 0
      for (const s of Object.values(stats)) {
        calls += s.calls
        before += s.tokens_before
        after += s.tokens_after
      }
      return boundNonPageOutput(
        `${metrics}\nccr_savings: ${before - after} tokens (${before}->${after}, ${calls} calls)`,
        query,
        input.phase,
      )
    }
    case "facts": {
      // 0.6.20: per-phase facts gathered during preflight, reusable by later units.
      const rows: string[][] = []
      for (const [phaseId, phase] of phaseEntries) {
        const facts = input.include_history ? phase.facts ?? [] : [...new Map((phase.facts ?? []).map((f) => [f.key, f])).values()]
        for (const f of facts) {
          if (input.fact_key && f.key !== input.fact_key) continue
          rows.push([phaseId, f.key, String(f.version ?? 1), f.text, f.source ?? "", f.ts])
        }
      }
      return renderPage(["phase", "key", "version", "fact", "source", "recorded"], rows, input, 'full text: repeat this query with include_full_text:true and cursor/limit')
    }
    case "reconstruct":
      // 0.6.26: read-only recovery worksheet assembled from the append-only sidecars.
      return boundNonPageOutput(renderReconstruct(await reconstruct(filePath, ledger)), query, input.phase)
    case "review_outcomes":
      // 0.6.19: recomputed from per-phase scalar totals on every read; never a rollup.
      return boundNonPageOutput(renderReviewOutcomes(ledger, input.phase), query, input.phase)
    case "full":
    default:
      if (input.phase && !ledger.phases[input.phase]) {
        return toKeyValue({ error: "phase not found", phase: input.phase })
      }
      // Full remains available for small ledgers and phase-scoped reads, but never emits
      // an unbounded payload into the host context.
      return boundNonPageOutput(
        JSON.stringify(input.unit_id ? { v: ledger.v, ts: ledger.ts, phases: Object.fromEntries(phaseEntries.filter(([, p]) => Object.hasOwn(p.units, input.unit_id!)).map(([id, p]) => [id, { ...p, units: { [input.unit_id!]: p.units[input.unit_id!] }, reviews: (p.reviews ?? []).filter((r) => (r.units ?? Object.keys(r.unit_attempts ?? p.units)).includes(input.unit_id!)) }])) } : input.phase
          ? { v: ledger.v, ts: ledger.ts, phases: { [input.phase]: ledger.phases[input.phase] } }
          : ledger),
        query,
        input.phase,
      )
  }
}
