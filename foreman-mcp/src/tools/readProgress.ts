import { readProgress, truncateProgress } from "../lib/progress.js"
import { toKeyValue, toTable } from "../lib/toon.js"

export async function handleReadProgress(filePath: string, lastNCompleted?: number): Promise<string> {
  const progress = await readProgress(filePath)
  const view = truncateProgress(progress, lastNCompleted)

  // Format as TOON sections
  let output = "STATUS\n"
  output += toKeyValue({
    phase: view.status.phase,
    last_completed: view.status.last_completed,
    next_up: view.status.next_up,
    blocked: view.status.blocked,
    completed: `${view.status.completed_count}/${view.status.total_count} units`,
  })

  if (view.completed.length > 0) {
    output += `\nRECENT (last ${view.completed.length} completed)\n`
    output += toTable(
      ["unit", "phase", "status", "notes"],
      view.completed.map(u => [u.id, u.phase, u.status, u.notes])
    )
  }

  if (view.incomplete.length > 0) {
    output += "\n\nINCOMPLETE\n"
    output += toTable(
      ["unit", "phase", "status", "notes"],
      view.incomplete.map(u => [u.id, u.phase, u.status, u.notes])
    )
  }

  if (view.errors.length > 0) {
    output += "\n\nERRORS\n"
    output += toTable(
      ["date", "unit", "what_failed", "next_approach"],
      view.errors.map(e => [e.date, e.unit, e.what_failed, e.next_approach])
    )
  }

  return output
}
