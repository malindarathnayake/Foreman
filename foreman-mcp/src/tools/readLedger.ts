import path from "path"
import { computeGateUnitsHash, readLedgerWithStatus } from "../lib/ledger.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import { renderDelegationMetrics } from "../lib/delegationMetrics.js"
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
        // D2b read-time staleness: n/a = no hash recorded (pre-v0.5.0 gate — never stale).
        const stale = !phase.gate_units_hash
          ? "n/a"
          : computeGateUnitsHash(phase.units) === phase.gate_units_hash.hash
            ? "-"
            : "STALE"
        rows.push([phaseId, phase.s, phase.g, stale])
      }
      return toTable(["phase", "status", "gate", "stale"], rows)
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
    case "delegation_metrics": {
      // Sidecar lives next to the ledger — byte-identical path rule to writeLedger.ts:100 / invokeWorker.ts:380.
      const sidecarPath = path.join(path.dirname(filePath), ".foreman-events.jsonl")
      const metrics = await renderDelegationMetrics(ledger, sidecarPath)
      // 5b: S6 evidence footer — real savings accumulated in ledger.ccr_stats by
      // write_ledger folds. Rendered only when evidence exists, so ledgers without
      // ccr_stats produce byte-identical output to pre-5b (golden stability).
      const stats = ledger.ccr_stats
      if (!stats || Object.keys(stats).length === 0) return metrics
      let calls = 0
      let before = 0
      let after = 0
      for (const s of Object.values(stats)) {
        calls += s.calls
        before += s.tokens_before
        after += s.tokens_after
      }
      return `${metrics}\nccr_savings: ${before - after} tokens (${before}->${after}, ${calls} calls)`
    }
    case "full":
    default:
      // Return full ledger as compact JSON (it's already compact)
      return JSON.stringify(ledger)
  }
}
