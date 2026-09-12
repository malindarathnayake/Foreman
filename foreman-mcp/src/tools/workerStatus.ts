/**
 * worker_status (0.6.21). Field report 2026-09-10: a healthy worker and a thrashing one look
 * identical for ten to twenty minutes because host transcripts flush on completion; one
 * was killed at ten minutes having done nothing wrong.
 *
 * Workers append one JSON line per few tool calls to `.foreman-heartbeat.jsonl` beside the
 * ledger (a Foreman-owned file, excluded from the repository guard and NOT one of the
 * fence marks). This reader keys the answer on the unit's CURRENT attempt: a line from an
 * abandoned attempt is reported as stale, never as life (Codex review, 2026-09-10). It is
 * self-reported activity, bounded on read, and advisory: it never clears, rejects or
 * terminates an attempt.
 */
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { readLedgerWithStatus } from "../lib/ledger.js"
import { HEARTBEAT_FILE } from "../lib/foremanFiles.js"
import { toKeyValue } from "../lib/toon.js"

export const WorkerStatusInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
})
export type WorkerStatusInput = z.infer<typeof WorkerStatusInputSchema>

/** Lines kept when the file is trimmed on read; the file never grows without bound. */
export const HEARTBEAT_KEEP = 500
const HEARTBEAT_TRIM_AT = 2000
const MAX_LINE = 2000

export interface Heartbeat {
  ts: string
  phase: string
  unit: string
  attempt: number
  files?: string[]
  note?: string
}

export function heartbeatPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), HEARTBEAT_FILE)
}

function parseLine(line: string): Heartbeat | null {
  if (line.length > MAX_LINE) return null
  try {
    const j = JSON.parse(line) as Partial<Heartbeat>
    if (typeof j.ts !== "string" || typeof j.phase !== "string" || typeof j.unit !== "string" || typeof j.attempt !== "number") return null
    return { ts: j.ts, phase: j.phase, unit: j.unit, attempt: j.attempt, ...(Array.isArray(j.files) ? { files: j.files.filter((f): f is string => typeof f === "string").slice(0, 50) } : {}), ...(typeof j.note === "string" ? { note: j.note.slice(0, 200) } : {}) }
  } catch {
    return null
  }
}

/** Read every parseable line; trim the file to the newest HEARTBEAT_KEEP when it has grown past the threshold. */
export async function readHeartbeats(filePath: string): Promise<Heartbeat[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "")
  if (lines.length > HEARTBEAT_TRIM_AT) {
    const kept = lines.slice(-HEARTBEAT_KEEP)
    await fs.writeFile(filePath, kept.join("\n") + "\n", "utf-8")
    return kept.map(parseLine).filter((h): h is Heartbeat => h !== null)
  }
  return lines.map(parseLine).filter((h): h is Heartbeat => h !== null)
}

export async function workerStatus(raw: WorkerStatusInput, ledgerPath: string, now: Date = new Date()): Promise<string> {
  const input = WorkerStatusInputSchema.parse(raw)
  const { ledger } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
  const unit = ledger.phases[input.phase]?.units[input.unit_id]
  if (!unit) return toKeyValue({ status: "unknown_unit", phase: input.phase, unit_id: input.unit_id, hint: "no such unit in the ledger" })
  const attempt = unit.attempt_seq ?? 0
  const beats = (await readHeartbeats(heartbeatPathFor(ledgerPath))).filter((h) => h.phase === input.phase && h.unit === input.unit_id)
  const current = beats.filter((h) => h.attempt === attempt)
  const stale = beats.length - current.length
  const last = current.at(-1)
  const age = last ? Math.max(0, Math.round((now.getTime() - Date.parse(last.ts)) / 1000)) : null
  const files = [...new Set(current.flatMap((h) => h.files ?? []))]
  return toKeyValue({
    status: last ? "alive" : current.length === 0 && stale > 0 ? "stale_only" : "silent",
    phase: input.phase,
    unit_id: input.unit_id,
    attempt,
    unit_status: unit.s,
    heartbeats_this_attempt: current.length,
    last_heartbeat_age_s: age === null ? "n/a" : age,
    files_touched_so_far: files.length ? files.join(",") : "none reported",
    last_note: last?.note ?? "none",
    stale_lines_from_earlier_attempts: stale,
    note: "Self-reported by the worker and keyed on the current attempt; a fresh heartbeat is activity, not progress, and a silent one is a reason to look, not a verdict. This never clears, rejects or terminates an attempt.",
  })
}
