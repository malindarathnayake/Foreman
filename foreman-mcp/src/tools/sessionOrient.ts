import { computeGateUnitsHash, readLedgerWithStatus } from "../lib/ledger.js"
import { readProgress } from "../lib/progress.js"
import { toKeyValue } from "../lib/toon.js"
import type { Phase, ProgressFile, Unit } from "../types.js"
import type { HostId } from "../lib/hostProfiles.js"
import { unsupportedCapabilities } from "../lib/capabilitySet.js"

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isPhaseDone(phase: Phase): boolean {
  // A phase is "done" when its gate has passed.
  // (Phase.s is "ip" by default and rarely transitions to "done" in practice;
  //  gate result is the authoritative completion signal.)
  return phase.g === "pass"
}

function unitHasActiveRejections(unit: Unit): boolean {
  // A unit has active rejections when it has rej entries AND is not (yet) passing.
  return unit.rej.length > 0 && unit.v !== "pass"
}

function firstIncompleteProgressTarget(progress: ProgressFile): string | null {
  for (const [phaseKey, phase] of Object.entries(progress.phases)) {
    for (const [unitId, unit] of Object.entries(phase.units)) {
      if (unit.status !== "complete") return `${unit.phase || phaseKey}/${unitId}`
    }
  }
  return null
}

// ─── sessionOrient ─────────────────────────────────────────────────────────────

export async function sessionOrient(
  ledgerPath: string,
  progressPath: string,
  host: HostId = "claude-code"
): Promise<string> {
  const { ledger, corrupt } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
  const progress = await readProgress(progressPath, { readOnly: true })
  const progressTarget = firstIncompleteProgressTarget(progress)

  // Corrupt ledger must not masquerade as a fresh project
  if (corrupt) {
    return toKeyValue({
      status: "ledger_corrupt",
      ledger_path: ledgerPath,
      hint:
        "Ledger JSON failed to parse. File left untouched. Prior project state is NOT gone — " +
        "inspect/restore the file before any write_ledger call (writes rename it to .corrupt.<ts> and start fresh).",
    })
  }

  const phaseKeys = Object.keys(ledger.phases).sort()
  const phases_total = phaseKeys.length

  // Empty ledger special case
  if (phases_total === 0) {
    return toKeyValue({
      status: "no_phases_yet",
      action: "plan_project",
      resume_target: "null",
      current_phase: "null",
      current_unit: "null",
      last_completed_unit: "null",
      next_pending_unit: "null",
      blocked_on: "null",
      active_rejections: 0,
      phases_total: 0,
      phases_done: 0,
      unsupported_capabilities: unsupportedCapabilities(host),
      stale_gates: "none",
      state_drift: progressTarget ? `progress:${progressTarget};ledger:no_phases` : "none",
      missing_declared_units: "none",
    })
  }

  // ── phases_done ──────────────────────────────────────────────────────────────
  let phases_done = 0
  for (const key of phaseKeys) {
    if (isPhaseDone(ledger.phases[key])) phases_done++
  }

  // ── status ───────────────────────────────────────────────────────────────────
  const status =
    phases_total === phases_done ? "complete" : "in_progress"

  // ── current_phase: first phase where isPhaseDone === false ───────────────────
  let current_phase = "null"
  for (const key of phaseKeys) {
    if (!isPhaseDone(ledger.phases[key])) {
      current_phase = key
      break
    }
  }

  // ── current_unit: first unit in current_phase where v !== "pass" ─────────────
  // Universe = registered ∪ declared: a declared-but-unregistered unit is
  // implicitly pending, so a partially-seeded phase resumes at implement_unit
  // instead of misreporting retry_phase_gate.
  let current_unit = "null"
  if (current_phase !== "null") {
    const phase = ledger.phases[current_phase]
    const universe = [...new Set([...Object.keys(phase.units), ...(phase.declared_units ?? [])])].sort()
    for (const unitId of universe) {
      const unit = phase.units[unitId]
      if (!unit || unit.v !== "pass") {
        current_unit = unitId
        break
      }
    }
  }

  // ── last_completed_unit: newest verdict timestamp, with lexicographic fallback
  // Legacy ledgers may lack v_ts; once timestamped pass verdicts exist they are the
  // only reliable completion ordering signal.
  let last_completed_unit = "null"
  let last_completed_ts = ""
  let legacy_last_completed = "null"
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const unitId of Object.keys(phase.units).sort()) {
      const unit = phase.units[unitId]
      if (unit.v === "pass") {
        legacy_last_completed = `${phaseKey}/${unitId}`
        if (unit.v_ts && unit.v_ts >= last_completed_ts) {
          last_completed_ts = unit.v_ts
          last_completed_unit = `${phaseKey}/${unitId}`
        }
      }
    }
  }
  if (last_completed_ts === "") last_completed_unit = legacy_last_completed

  // ── next_pending_unit: first unit with s==="pending" starting from current_phase ──
  let next_pending_unit = "null"
  let inCurrentOrAfter = current_phase === "null"
  outer: for (const phaseKey of phaseKeys) {
    if (!inCurrentOrAfter) {
      if (phaseKey === current_phase) inCurrentOrAfter = true
      else continue
    }
    const phase = ledger.phases[phaseKey]
    const universe = [...new Set([...Object.keys(phase.units), ...(phase.declared_units ?? [])])].sort()
    for (const unitId of universe) {
      const unit = phase.units[unitId]
      if (!unit || unit.s === "pending") {
        next_pending_unit = `${phaseKey}/${unitId}`
        break outer
      }
    }
  }

  let action = "resolve_phase_state"
  let resume_target = current_phase === "null" ? "null" : current_phase
  if (status === "complete") {
    action = "complete"
    resume_target = "null"
  } else if (current_unit !== "null") {
    action = "implement_unit"
    resume_target = `${current_phase}/${current_unit}`
  } else if (current_phase !== "null") {
    const units = Object.values(ledger.phases[current_phase].units)
    if (units.length > 0 && units.every((unit) => unit.v === "pass")) {
      action = "retry_phase_gate"
      resume_target = `${current_phase}/phase_gate`
    }
  }

  let state_drift = progressTarget && progressTarget !== resume_target
    ? `progress:${progressTarget};ledger:${resume_target}`
    : "none"

  // Reverse-direction drift: progress marks the ledger's resume unit itself as
  // complete — a unit-level contradiction. A progress file that simply doesn't
  // track the unit is NOT drift (progress is seeded per-phase, so partial files
  // are the normal case for later-phase resumes).
  if (state_drift === "none" && current_phase !== "null" && current_unit !== "null") {
    for (const [phaseKey, progressPhase] of Object.entries(progress.phases)) {
      const pu = progressPhase.units[current_unit]
      if (pu && (pu.phase || phaseKey) === current_phase && pu.status === "complete") {
        state_drift = `progress:complete(${current_phase}/${current_unit});ledger:${resume_target}`
        break
      }
    }
  }

  // ── missing_declared_units: declared ids with no registered unit (all phases) ──
  const missingDeclared: string[] = []
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const id of [...(phase.declared_units ?? [])].sort()) {
      if (!phase.units[id]) missingDeclared.push(`${phaseKey}/${id}`)
    }
  }
  const missing_declared_units = missingDeclared.length === 0
    ? "none"
    : missingDeclared.slice(0, 10).join(",") +
      (missingDeclared.length > 10 ? ` (+${missingDeclared.length - 10} more)` : "")

  // ── blocked_on + active_rejections: iterate ALL phases ──────────────────────
  let blocked_on = "null"
  let active_rejections = 0
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const unitId of Object.keys(phase.units).sort()) {
      const unit = phase.units[unitId]
      if (unitHasActiveRejections(unit)) {
        if (blocked_on === "null") {
          blocked_on = `${phaseKey}/${unitId}`
        }
        active_rejections++
      }
    }
  }

  // ── stale_gates: phases whose gate snapshot no longer matches their units (D2b) ──
  const staleGates = phaseKeys.filter((key) => {
    const phase = ledger.phases[key]
    return phase.gate_units_hash !== undefined &&
      computeGateUnitsHash(phase.units, phase.declared_units) !== phase.gate_units_hash.hash
  })

  return toKeyValue({
    status,
    action,
    resume_target,
    current_phase,
    current_unit,
    last_completed_unit,
    next_pending_unit,
    blocked_on,
    active_rejections,
    phases_total,
    phases_done,
    unsupported_capabilities: unsupportedCapabilities(host),
    stale_gates: staleGates.length === 0 ? "none" : staleGates.join(","),
    state_drift,
    missing_declared_units,
  })
}
