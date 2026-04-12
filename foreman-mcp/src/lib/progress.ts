import fs from "fs/promises"
import path from "path"
import type { ProgressFile, ProgressUnit, WriteProgressInput, TruncatedView, StatusSummary } from "../types.js"

// ─── Per-path mutex registry ──────────────────────────────────────────────────
// Separate from ledger lock registry — do NOT share or import from ledger.ts
const progressLockRegistry = new Map<string, Promise<void>>()

function withProgressLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = progressLockRegistry.get(filePath) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  progressLockRegistry.set(filePath, next)
  return prev.then(fn).finally(() => resolve())
}

// ─── Fresh progress factory ───────────────────────────────────────────────────
function freshProgress(): ProgressFile {
  return { phases: {}, error_log: [] }
}

// ─── Read ─────────────────────────────────────────────────────────────────────
export async function readProgress(filePath: string): Promise<ProgressFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return freshProgress()
    }
    throw err
  }

  try {
    return JSON.parse(raw) as ProgressFile
  } catch {
    // Corrupt JSON — back it up and return fresh progress
    const backupPath = `${filePath}.corrupt.${Date.now()}`
    await fs.rename(filePath, backupPath)
    return freshProgress()
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────
export async function writeProgress(
  filePath: string,
  operation: WriteProgressInput
): Promise<ProgressFile> {
  return withProgressLock(filePath, async () => {
    const progress = await readProgress(filePath)

    switch (operation.operation) {
      case "start_phase": {
        const { phase, name } = operation.data
        if (!progress.phases[phase]) {
          progress.phases[phase] = { name, units: {} }
        } else {
          progress.phases[phase].name = name
        }
        break
      }
      case "update_status": {
        const { unit_id, phase, status, notes } = operation.data
        if (!progress.phases[phase]) {
          progress.phases[phase] = { name: phase, units: {} }
        }
        const existing = progress.phases[phase].units[unit_id]
        progress.phases[phase].units[unit_id] = {
          id: unit_id,
          phase,
          status,
          notes,
          completed_at: existing?.completed_at,
        }
        break
      }
      case "complete_unit": {
        const { unit_id, phase, completed_at, notes } = operation.data
        if (!progress.phases[phase]) {
          progress.phases[phase] = { name: phase, units: {} }
        }
        progress.phases[phase].units[unit_id] = {
          id: unit_id,
          phase,
          status: "complete",
          notes,
          completed_at,
        }
        break
      }
      case "log_error": {
        const { date, unit, what_failed, next_approach } = operation.data
        progress.error_log.push({ date, unit, what_failed, next_approach })
        if (progress.error_log.length > 20) progress.error_log = progress.error_log.slice(-20)
        break
      }
    }

    // Atomic write: write to .tmp then rename
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(progress), "utf-8")
    await fs.rename(tmpPath, filePath)

    return progress
  })
}

// ─── Truncation (PURE — no IO) ────────────────────────────────────────────────
export function truncateProgress(
  progress: ProgressFile,
  lastNCompleted: number = 10
): TruncatedView {
  // Gather all units across all phases
  const allUnits: ProgressUnit[] = []
  for (const phaseData of Object.values(progress.phases)) {
    for (const unit of Object.values(phaseData.units)) {
      allUnits.push({ ...unit, phase: phaseData.name })
    }
  }

  const completed = allUnits.filter((u) => u.status === "complete")
  const incomplete = allUnits.filter((u) => u.status !== "complete")

  // Sort completed by completed_at descending (most recent first)
  completed.sort((a, b) => {
    const aTime = a.completed_at ?? ""
    const bTime = b.completed_at ?? ""
    return bTime.localeCompare(aTime)
  })

  // Keep only the last N completed
  const truncatedCompleted = completed.slice(0, lastNCompleted)

  // Truncate error_log to last 5 entries
  const errors = progress.error_log.slice(-5)

  // Compute status summary
  const completedCount = completed.length
  const totalCount = allUnits.length

  // Find the phase with incomplete units (or last phase if all complete)
  let summaryPhase = ""
  const phaseKeys = Object.keys(progress.phases)

  // Find first phase that has incomplete units
  for (const phaseKey of phaseKeys) {
    const phaseData = progress.phases[phaseKey]
    const hasIncomplete = Object.values(phaseData.units).some((u) => u.status !== "complete")
    if (hasIncomplete) {
      summaryPhase = phaseData.name
      break
    }
  }

  // If all complete (no incomplete found), use the last phase
  if (!summaryPhase && phaseKeys.length > 0) {
    const lastPhaseKey = phaseKeys[phaseKeys.length - 1]
    summaryPhase = progress.phases[lastPhaseKey].name
  }

  // last_completed: most recent completed unit (first in sorted array)
  const lastCompletedUnit = completed[0]
  const lastCompleted = lastCompletedUnit
    ? `${lastCompletedUnit.id} (${lastCompletedUnit.phase}): ${lastCompletedUnit.notes}`
    : "none"

  // next_up: first incomplete unit
  const nextUnit = incomplete[0]
  const nextUp = nextUnit
    ? `${nextUnit.id} (${nextUnit.phase}): ${nextUnit.notes}`
    : "none"

  // session_hint: actionable directive for the LLM
  // This is the PRIMARY instruction a remote session sees — it must convey
  // both WHERE to resume and HOW to implement (pitboss pattern, not direct code).
  const workflowDirective =
    "WORKFLOW: Call mcp__foreman__pitboss_implementor to load the full protocol. " +
    "Do NOT write code directly — use the pitboss/worker pattern: " +
    "spawn Sonnet workers via Agent tool, validate against spec, run gates G1–G5. " +
    "At phase checkpoints, deliberate with Codex CLI (mcp__foreman__capability_check) before marking complete."

  let sessionHint: string
  if (totalCount === 0) {
    sessionHint = "No units found. Call mcp__foreman__spec_generator to create the implementation plan."
  } else if (completedCount === totalCount) {
    sessionHint =
      `All ${totalCount} units complete. Run phase checkpoint: ` +
      "deliberate with Codex CLI (capability_check → run-codex review), " +
      "then start a new session for the next phase."
  } else if (nextUnit) {
    sessionHint =
      `Resume at ${nextUnit.id} (${nextUnit.phase}). ${completedCount}/${totalCount} complete. ` +
      workflowDirective
  } else {
    sessionHint =
      `Phase ${summaryPhase} in progress. ${completedCount}/${totalCount} complete. ` +
      workflowDirective
  }

  const status: StatusSummary = {
    phase: summaryPhase,
    last_completed: lastCompleted,
    next_up: nextUp,
    blocked: "none",
    completed_count: completedCount,
    total_count: totalCount,
    session_hint: sessionHint,
  }

  return {
    status,
    completed: truncatedCompleted,
    incomplete,
    errors,
  }
}
