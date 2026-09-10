import { ATTEMPT_CAP, computeGateUnitsHash, readLedgerWithStatus } from "../lib/ledger.js"
import { readProgress } from "../lib/progress.js"
import { toKeyValue } from "../lib/toon.js"
import { naturalSort } from "../lib/naturalSort.js"
import type { Phase, ProgressFile, Unit } from "../types.js"
import type { HostId } from "../lib/hostProfiles.js"
import { unsupportedCapabilities } from "../lib/capabilitySet.js"
import { modelRankSummary, resolveModelRank, type ModelRank } from "../lib/modelRank.js"

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

/** First unit the progress file mentions, any status. Only the no-phases contradiction uses it. */
function firstProgressUnit(progress: ProgressFile): string | null {
  for (const [phaseKey, phase] of Object.entries(progress.phases)) {
    for (const [unitId, unit] of Object.entries(phase.units)) {
      return `${unit.phase || phaseKey}/${unitId}`
    }
  }
  return null
}

/** Registered ∪ declared unit ids for a phase, in natural order. */
function unitUniverse(phase: Phase): string[] {
  return naturalSort(new Set([...Object.keys(phase.units), ...(phase.declared_units ?? [])]))
}

// ─── sessionOrient ─────────────────────────────────────────────────────────────

/** One read-only snapshot shared by resume routing and the progress display. */
export async function readSessionState(
  ledgerPath: string,
  progressPath: string,
  host: HostId = "claude-code",
  modelRank: ModelRank = resolveModelRank()
): Promise<{ summary: Record<string, string | number | boolean>; progress: ProgressFile }> {
  const { ledger, corrupt } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
  const progress = await readProgress(progressPath, { readOnly: true })
  const progressTarget = firstProgressUnit(progress)

  // Corrupt ledger must not masquerade as a fresh project
  if (corrupt) {
    return { progress, summary: {
      ...modelRankSummary(modelRank),
      status: "ledger_corrupt",
      ledger_path: ledgerPath,
      hint:
        "Ledger JSON failed to parse. File left untouched. Prior project state is NOT gone — " +
        "inspect/restore the file before any write_ledger call (writes rename it to .corrupt.<ts> and start fresh).",
    } }
  }

  // Natural order: p2 before p10, U0.9 before U0.18. Plain lexicographic sort resumed
  // the wrong phase on any project with ten or more phases (field feedback 2026-09).
  const phaseKeys = naturalSort(Object.keys(ledger.phases))
  const phases_total = phaseKeys.length

  // Empty ledger special case
  if (phases_total === 0) {
    return { progress, summary: {
      ...modelRankSummary(modelRank),
      status: "no_phases_yet",
      action: "plan_project",
      resume_target: "null",
      current_phase: "null",
      current_unit: "null",
      last_completed_unit: "null",
      latest_pass_verdict_unit: "null",
      latest_pass_verdict_ts: "null",
      next_pending_unit: "null",
      blocked_on: "null",
      active_rejections: 0,
      phases_total: 0,
      phases_done: 0,
      units_total: 0,
      units_passed: 0,
      units_remaining: 0,
      escapes_unclassified: 0,
      unsupported_capabilities: unsupportedCapabilities(host),
      stale_gates: "none",
      state_drift: progressTarget ? `progress:${progressTarget};ledger:no_phases` : "none",
      progress_advisories: "none",
      attempt_grants: "none",
      missing_declared_units: "none",
    } }
  }

  // ── phases_done ──────────────────────────────────────────────────────────────
  let phases_done = 0
  let units_total = 0
  let units_passed = 0
  let escapes_unclassified = 0
  for (const key of phaseKeys) {
    const phase = ledger.phases[key]
    if (isPhaseDone(phase)) phases_done++
    // 0.6.19: a post-gate defect awaiting classification blocks the next pass on its unit.
    escapes_unclassified += (phase.escapes ?? []).filter((e) => e.class === "unclassified").length
    // Declared-but-unregistered units are pending, just as they are for resume routing.
    units_total += unitUniverse(phase).length
    units_passed += Object.values(phase.units).filter(unit => unit.v === "pass").length
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
    for (const unitId of unitUniverse(phase)) {
      const unit = phase.units[unitId]
      if (!unit || unit.v !== "pass") {
        current_unit = unitId
        break
      }
    }
  }

  // ── last_completed_unit: the completion FRONTIER ─────────────────────────────
  // Newest first-pass timestamp wins (first_pass_ts sticks across re-verdicts; v_ts
  // is the fallback for ledgers written before first_pass_ts existed). A checkpoint
  // fix that re-verdicts p0.1 therefore does not move the frontier back from p0.3.
  // Legacy ledgers with no timestamps at all fall back to the last pass in natural order.
  // ── latest_pass_verdict_unit/ts: the newest pass VERDICT by timestamp ────────
  // This is the temporal fact (re-verdicts DO move it) — named for what it is.
  let last_completed_unit = "null"
  let frontier_ts = ""
  let legacy_last_completed = "null"
  let latest_pass_verdict_unit = "null"
  let latest_pass_verdict_ts = ""
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const unitId of naturalSort(Object.keys(phase.units))) {
      const unit = phase.units[unitId]
      if (unit.v !== "pass") continue
      legacy_last_completed = `${phaseKey}/${unitId}`
      const completedAt = unit.first_pass_ts ?? unit.v_ts
      if (completedAt && completedAt >= frontier_ts) {
        frontier_ts = completedAt
        last_completed_unit = `${phaseKey}/${unitId}`
      }
      if (unit.v_ts && unit.v_ts >= latest_pass_verdict_ts) {
        latest_pass_verdict_ts = unit.v_ts
        latest_pass_verdict_unit = `${phaseKey}/${unitId}`
      }
    }
  }
  if (frontier_ts === "") last_completed_unit = legacy_last_completed

  // ── next_pending_unit: first unit with s==="pending" starting from current_phase ──
  let next_pending_unit = "null"
  let inCurrentOrAfter = current_phase === "null"
  outer: for (const phaseKey of phaseKeys) {
    if (!inCurrentOrAfter) {
      if (phaseKey === current_phase) inCurrentOrAfter = true
      else continue
    }
    const phase = ledger.phases[phaseKey]
    for (const unitId of unitUniverse(phase)) {
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

  // ── state_drift + progress_advisories (round 5, Codex) ──────────────────────
  // The progress file is descriptive. Comparing its first-open pointer to the ledger
  // target as strings stopped the next session on a pending entry for a later unit, or a
  // stale one for an earlier unit, and no write could clear it. Drift now blocks only on
  // a contradiction the file cannot honestly hold: a unit marked complete that the ledger
  // has not passed (declared-but-unregistered counts as not passed). Everything else is
  // an advisory: stale (open in progress, passed in the ledger), ahead (open, later than
  // the target), orphan (not a ledger unit at all).
  const contradictions: string[] = []
  const stale: string[] = []
  const ahead: string[] = []
  const orphan: string[] = []
  for (const [progressPhaseKey, progressPhase] of Object.entries(progress.phases)) {
    for (const [unitId, pu] of Object.entries(progressPhase.units)) {
      const phaseKey = pu.phase || progressPhaseKey
      const ledgerPhase = ledger.phases[phaseKey]
      const unit = ledgerPhase?.units[unitId]
      const declared = ledgerPhase?.declared_units?.includes(unitId) ?? false
      const pathKey = `${phaseKey}/${unitId}`
      if (!unit && !declared) {
        orphan.push(pathKey)
        continue
      }
      if (pu.status === "complete") {
        if (!unit || unit.v !== "pass") contradictions.push(pathKey)
        continue
      }
      if (unit && unit.v === "pass") stale.push(pathKey)
      else if (pathKey !== resume_target) ahead.push(pathKey)
    }
  }
  const state_drift = contradictions.length === 0
    ? "none"
    : `progress:complete(${naturalSort(contradictions)[0]});ledger:${resume_target}` +
      (contradictions.length > 1 ? ` (+${contradictions.length - 1} more)` : "")
  const advisory = (label: string, list: string[]): string | null =>
    list.length === 0
      ? null
      : `${label}:${naturalSort(list).slice(0, 5).join(",")}${list.length > 5 ? `(+${list.length - 5})` : ""}`
  const progress_advisories =
    [advisory("stale", stale), advisory("ahead", ahead), advisory("orphan", orphan)]
      .filter((s): s is string => s !== null)
      .join(";") || "none"

  // ── missing_declared_units: declared ids with no registered unit (all phases) ──
  const missingDeclared: string[] = []
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const id of naturalSort(phase.declared_units ?? [])) {
      if (!phase.units[id]) missingDeclared.push(`${phaseKey}/${id}`)
    }
  }
  const missing_declared_units = missingDeclared.length === 0
    ? "none"
    : missingDeclared.slice(0, 10).join(",") +
      (missingDeclared.length > 10 ? ` (+${missingDeclared.length - 10} more)` : "")

  // ── blocked_on + active_rejections + attempt_blocks: iterate ALL phases ───────
  // attempt_blocks (0.6.4): units the ledger will refuse a pass on — at the cap, or
  // rejected with no attempt recorded since. Surfaced here so the model learns it before
  // a refused verdict, which is exactly the moment it used to fix off the record.
  let blocked_on = "null"
  let active_rejections = 0
  const attemptBlocks: string[] = []
  const attemptGrants: string[] = []
  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    for (const unitId of naturalSort(Object.keys(phase.units))) {
      const unit = phase.units[unitId]
      if (unitHasActiveRejections(unit)) {
        if (blocked_on === "null") {
          blocked_on = `${phaseKey}/${unitId}`
        }
        active_rejections++
      }
      if (unit.v !== "pass") {
        const failed = unit.epoch_failed ?? 0
        // An open grant (0.6.5) means the owner already decided: the next attempt is charged
        // to it, so the unit is not cap-blocked and the model must not ask for another override.
        const newest = unit.cap_grants?.[unit.cap_grants.length - 1]
        const open = newest && !newest.closed && newest.remaining > 0 ? newest : undefined
        if (open) attemptGrants.push(`${phaseKey}/${unitId}:#${open.id}(${open.remaining} left)`)
        if (failed >= ATTEMPT_CAP && !open) attemptBlocks.push(`${phaseKey}/${unitId}:cap(${failed})`)
        else if (unit.needs_attempt) attemptBlocks.push(`${phaseKey}/${unitId}:needs_attempt`)
      }
    }
  }
  const attempt_blocks = attemptBlocks.length === 0
    ? "none"
    : attemptBlocks.slice(0, 10).join(",") + (attemptBlocks.length > 10 ? ` (+${attemptBlocks.length - 10} more)` : "")
  const attempt_grants = attemptGrants.length === 0 ? "none" : attemptGrants.slice(0, 10).join(",")

  // ── stale_gates: phases whose gate snapshot no longer matches their units (D2b) ──
  const staleGates = phaseKeys.filter((key) => {
    const phase = ledger.phases[key]
    return phase.gate_units_hash !== undefined &&
      computeGateUnitsHash(phase.units, phase.declared_units) !== phase.gate_units_hash.hash
  })

  return { progress, summary: {
    ...modelRankSummary(modelRank),
    status,
    action,
    resume_target,
    current_phase,
    current_unit,
    last_completed_unit,
    latest_pass_verdict_unit,
    latest_pass_verdict_ts: latest_pass_verdict_ts || "null",
    next_pending_unit,
    blocked_on,
    active_rejections,
    attempt_blocks,
    attempt_grants,
    phases_total,
    phases_done,
    units_total,
    units_passed,
    units_remaining: units_total - units_passed,
    escapes_unclassified,
    unsupported_capabilities: unsupportedCapabilities(host),
    stale_gates: staleGates.length === 0 ? "none" : staleGates.join(","),
    state_drift,
    progress_advisories,
    missing_declared_units,
  } }
}

export async function sessionOrient(
  ledgerPath: string,
  progressPath: string,
  host: HostId = "claude-code",
  modelRank: ModelRank = resolveModelRank()
): Promise<string> {
  return toKeyValue((await readSessionState(ledgerPath, progressPath, host, modelRank)).summary)
}
