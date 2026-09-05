import path from "path"
import { computeGateUnitsHash, readLedgerWithStatus } from "../lib/ledger.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import { renderDelegationMetrics } from "../lib/delegationMetrics.js"
import type { ReadLedgerInput, Unit } from "../types.js"

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
const MAX_CELL_CHARS = 240
const MAX_OUTPUT_CHARS = 50000

function compactCell(value: string): { text: string; truncated: boolean } {
  const compact = value.replace(/\s+/g, " ").replace(/\|/g, "¦").trim()
  if (compact.length <= MAX_CELL_CHARS) return { text: compact, truncated: false }
  return { text: `${compact.slice(0, MAX_CELL_CHARS - 1)}…`, truncated: true }
}

function renderPage(headers: string[], rows: string[][], input: ReadLedgerInput, truncationHint?: string): string {
  const cursor = Math.max(0, Math.min(input.cursor ?? 0, rows.length))
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT))
  const selected = rows.slice(cursor, cursor + limit)
  let truncatedCells = 0
  const compactRows = selected.map((row) => row.map((cell) => {
    const compact = compactCell(cell)
    if (compact.truncated) truncatedCells++
    return compact.text
  }))
  const nextCursor = cursor + selected.length < rows.length ? cursor + selected.length : "none"
  const header: Record<string, string | number> = {
    total_rows: rows.length,
    cursor,
    returned: selected.length,
    next_cursor: nextCursor,
    truncated_cells: truncatedCells,
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
  if (input.phase && input.unit_id) {
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
    }), "unit", input.phase)
  }

  // query-based filtering
  switch (query) {
    case "verdicts": {
      const rows: string[][] = []
      for (const [phaseId, phase] of phaseEntries) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
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
          for (const rej of unit.rej) {
            rows.push([phaseId, unitId, rej.r, rej.msg, rej.ts])
          }
        }
      }
      return renderPage(
        ["phase", "unit", "reviewer", "message", "timestamp"],
        rows,
        input,
        'full text: read_ledger({ query: "full", phase: "<phase>" })'
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
      for (const [phaseId, phase] of phaseEntries) {
        for (const review of phase.reviews ?? []) {
          if (review.findings.length === 0) {
            // Silence is only approval when the seat says what it examined.
            const meta = [
              review.completion ? `completion=${review.completion}` : null,
              review.checked ? `checked=${review.checked.length}` : null,
              review.stage ? `stage=${review.stage}` : null,
            ].filter(Boolean).join("; ")
            rows.push([phaseId, review.advisor, "", "", meta ? `(no findings; ${meta})` : "(no findings)"])
            continue
          }
          for (const f of review.findings) {
            rows.push([phaseId, review.advisor, f.severity, f.classification ?? "", f.description])
          }
        }
      }
      return renderPage(
        ["phase", "advisor", "severity", "class", "finding"],
        rows,
        input,
        'full text: read_ledger({ query: "full", phase: "<phase>" })'
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
    case "full":
    default:
      if (input.phase && !ledger.phases[input.phase]) {
        return toKeyValue({ error: "phase not found", phase: input.phase })
      }
      // Full remains available for small ledgers and phase-scoped reads, but never emits
      // an unbounded payload into the host context.
      return boundNonPageOutput(
        JSON.stringify(input.phase
          ? { v: ledger.v, ts: ledger.ts, phases: { [input.phase]: ledger.phases[input.phase] } }
          : ledger),
        query,
        input.phase,
      )
  }
}
