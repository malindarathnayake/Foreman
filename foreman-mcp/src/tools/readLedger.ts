import { readLedgerWithStatus } from "../lib/ledger.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import type { ReadLedgerInput } from "../types.js"

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

  // If input has phase and unit_id → return single unit as key/value
  if (input.phase && input.unit_id) {
    const unit = ledger.phases[input.phase]?.units[input.unit_id]
    if (!unit) return toKeyValue({ error: "unit not found", phase: input.phase, unit_id: input.unit_id })
    return toKeyValue({
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
      rejections: String(unit.rej.length),
    })
  }

  // query-based filtering
  switch (query) {
    case "verdicts": {
      const rows: string[][] = []
      for (const [phaseId, phase] of Object.entries(ledger.phases)) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
          rows.push([phaseId, unitId, unit.tier ?? "", unit.v, unit.via ?? "", unit.note ?? ""])
        }
      }
      return toTable(["phase", "unit", "tier", "verdict", "via", "note"], rows)
    }
    case "rejections": {
      const rows: string[][] = []
      for (const [phaseId, phase] of Object.entries(ledger.phases)) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
          for (const rej of unit.rej) {
            rows.push([phaseId, unitId, rej.r, rej.msg, rej.ts])
          }
        }
      }
      return toTable(["phase", "unit", "reviewer", "message", "timestamp"], rows)
    }
    case "phase_gates": {
      const rows: string[][] = []
      for (const [phaseId, phase] of Object.entries(ledger.phases)) {
        rows.push([phaseId, phase.s, phase.g])
      }
      return toTable(["phase", "status", "gate"], rows)
    }
    case "reviews": {
      const rows: string[][] = []
      for (const [phaseId, phase] of Object.entries(ledger.phases)) {
        for (const review of phase.reviews ?? []) {
          if (review.findings.length === 0) {
            rows.push([phaseId, review.advisor, "", "", "(no findings)"])
            continue
          }
          for (const f of review.findings) {
            rows.push([phaseId, review.advisor, f.severity, f.classification ?? "", f.description])
          }
        }
      }
      return toTable(["phase", "advisor", "severity", "class", "finding"], rows)
    }
    case "full":
    default:
      // Return full ledger as compact JSON (it's already compact)
      return JSON.stringify(ledger)
  }
}
