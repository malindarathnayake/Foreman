import path from "node:path"
import { truncateProgress } from "../lib/progress.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import type { HostId } from "../lib/hostProfiles.js"
import { readSessionState } from "./sessionOrient.js"
import { resolveModelRank, type ModelRank } from "../lib/modelRank.js"

export async function handleReadProgress(
  filePath: string,
  lastNCompleted?: number,
  ledgerPath = path.join(path.dirname(filePath), ".foreman-ledger.json"),
  host: HostId = "claude-code",
  modelRank: ModelRank = resolveModelRank()
): Promise<string> {
  const { progress, summary } = await readSessionState(ledgerPath, filePath, host, modelRank)
  const view = truncateProgress(progress, lastNCompleted)

  // Use the exact resume calculation, never checklist completion or its next_up pointer.
  let output = "AUTHORITY\n"
  output += toKeyValue({
    role: "ledger_summary_with_planning_checklist",
    resume: "call session_orient",
    note: "Ledger verdicts count passed units; phase gates determine project completion. Checklist entries are descriptive only.",
  })

  output += "\nLEDGER STATUS\n"
  output += toKeyValue(summary)

  output += "\n\nPLANNING CHECKLIST (not project completion)\n"
  output += toKeyValue({
    entries_marked_complete: view.status.completed_count,
    entries_total: view.status.total_count,
  })

  if (view.completed.length > 0) {
    output += `\nCHECKLIST RECENT (last ${view.completed.length} marked complete)\n`
    output += toTable(
      ["unit", "phase", "checklist_status", "notes"],
      view.completed.map(u => [u.id, u.phase, u.status, u.notes])
    )
  }

  if (view.incomplete.length > 0) {
    output += "\n\nCHECKLIST INCOMPLETE\n"
    output += toTable(
      ["unit", "phase", "checklist_status", "notes"],
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
