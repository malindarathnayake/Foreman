import { readLedger } from "../lib/ledger.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import type { ReadLedgerInput } from "../types.js"

export async function handleReadLedger(filePath: string, input: ReadLedgerInput): Promise<string> {
  const ledger = await readLedger(filePath)
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
      worker: unit.w ?? "none",
      rejections: String(unit.rej.length),
    })
  }

  // query-based filtering
  switch (query) {
    case "verdicts": {
      const rows: string[][] = []
      for (const [phaseId, phase] of Object.entries(ledger.phases)) {
        for (const [unitId, unit] of Object.entries(phase.units)) {
          rows.push([phaseId, unitId, unit.v])
        }
      }
      return toTable(["phase", "unit", "verdict"], rows)
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
    case "full":
    default:
      // Return full ledger as compact JSON (it's already compact)
      return JSON.stringify(ledger)
  }
}
