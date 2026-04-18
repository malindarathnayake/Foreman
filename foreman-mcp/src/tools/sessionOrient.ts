import { readLedger } from "../lib/ledger.js"
import { readProgress } from "../lib/progress.js"
import { toKeyValue } from "../lib/toon.js"
import type { Phase, Unit } from "../types.js"

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

// ─── sessionOrient ─────────────────────────────────────────────────────────────

export async function sessionOrient(
  ledgerPath: string,
  progressPath: string
): Promise<string> {
  const ledger = await readLedger(ledgerPath, { readOnly: true })
  await readProgress(progressPath, { readOnly: true }) // read for spec compliance; unused in output this version

  const phaseKeys = Object.keys(ledger.phases).sort()
  const phases_total = phaseKeys.length

  // Empty ledger special case
  if (phases_total === 0) {
    return toKeyValue({
      status: "no_phases_yet",
      current_phase: "null",
      current_unit: "null",
      last_completed_unit: "null",
      next_pending_unit: "null",
      blocked_on: "null",
      active_rejections: 0,
      phases_total: 0,
      phases_done: 0,
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
  let current_unit = "null"
  if (current_phase !== "null") {
    const phase = ledger.phases[current_phase]
    for (const unitId of Object.keys(phase.units).sort()) {
      if (phase.units[unitId].v !== "pass") {
        current_unit = unitId
        break
      }
    }
  }

  // ── last_completed_unit: last unit (phase then unit lex order) with v==="pass" ──
  let last_completed_unit = "null"
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const unitId of Object.keys(phase.units).sort()) {
      if (phase.units[unitId].v === "pass") {
        last_completed_unit = `${phaseKey}/${unitId}`
      }
    }
  }

  // ── next_pending_unit: first unit with s==="pending" starting from current_phase ──
  let next_pending_unit = "null"
  let inCurrentOrAfter = current_phase === "null"
  outer: for (const phaseKey of phaseKeys) {
    if (!inCurrentOrAfter) {
      if (phaseKey === current_phase) inCurrentOrAfter = true
      else continue
    }
    const phase = ledger.phases[phaseKey]
    for (const unitId of Object.keys(phase.units).sort()) {
      if (phase.units[unitId].s === "pending") {
        next_pending_unit = `${phaseKey}/${unitId}`
        break outer
      }
    }
  }

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

  return toKeyValue({
    status,
    current_phase,
    current_unit,
    last_completed_unit,
    next_pending_unit,
    blocked_on,
    active_rejections,
    phases_total,
    phases_done,
  })
}
