import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import type { JournalFile, JournalSession, JournalRollup, WriteJournalInput } from "../types.js"
import { WriteJournalInputSchema } from "../types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Per-path mutex registry ──────────────────────────────────────────────────
// Separate from ledger/progress lock registries — do NOT share or import from those files
const journalLockRegistry = new Map<string, Promise<void>>()

function withJournalLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = journalLockRegistry.get(filePath) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  journalLockRegistry.set(filePath, next)
  return prev.then(fn).finally(() => resolve())
}

// ─── Fresh journal factory ────────────────────────────────────────────────────
function freshJournal(): JournalFile {
  return { v: 1, project: "", target_version: "", next_sid: 1, sessions: [] }
}

// ─── Read ─────────────────────────────────────────────────────────────────────
export async function readJournal(filePath: string): Promise<JournalFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return freshJournal()
    }
    throw err
  }

  try {
    return JSON.parse(raw) as JournalFile
  } catch {
    // Corrupt JSON — back it up and return fresh journal
    const backupPath = `${filePath}.corrupt.${Date.now()}`
    await fs.rename(filePath, backupPath)
    return freshJournal()
  }
}

// ─── initSession ──────────────────────────────────────────────────────────────
export async function initSession(filePath: string, input: WriteJournalInput): Promise<JournalFile> {
  return withJournalLock(filePath, async () => {
    const parsed = WriteJournalInputSchema.parse(input)
    if (parsed.operation !== "init_session") {
      throw new Error(`Expected operation "init_session", got "${parsed.operation}"`)
    }

    const journal = await readJournal(filePath)
    const { data } = parsed

    // Auto-detect env
    const osStr = `${process.platform}-${process.arch}`
    const nodeStr = process.version

    let foremanVersion = "unknown"
    try {
      const pkgPath = path.resolve(__dirname, "..", "..", "package.json")
      const pkgRaw = await fs.readFile(pkgPath, "utf-8")
      const pkg = JSON.parse(pkgRaw) as { version?: string }
      if (pkg.version) foremanVersion = pkg.version
    } catch {
      // default to "unknown"
    }

    const sessionId = `s${journal.next_sid}`
    journal.next_sid += 1

    const newSession: JournalSession = {
      id: sessionId,
      ts: new Date().toISOString(),
      branch: data.branch,
      phase: data.phase,
      units: data.units,
      events: [],
    }

    // Attach env onto the session (not part of JournalSession interface, stored via augmentation)
    // The JournalSession interface does not include env — store as extra field if needed.
    // Per spec: update file-level project and target_version
    journal.project = "foreman-mcp"
    journal.target_version = data.target_version

    // We store the env info; since JournalSession doesn't have an env field we attach it as an
    // extra property. The JournalEnv is recorded here for completeness per the spec.
    const sessionWithEnv = newSession as JournalSession & { env?: unknown }
    sessionWithEnv.env = {
      os: osStr,
      node: nodeStr,
      foreman: foremanVersion,
      agent: data.env.agent,
      worker: data.env.worker,
      codex: data.env.codex,
      gemini: data.env.gemini,
    }

    journal.sessions.push(sessionWithEnv)

    // FIFO: keep at most 50 sessions
    if (journal.sessions.length > 50) {
      journal.sessions = journal.sessions.slice(-50)
    }

    // Atomic write
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(journal), "utf-8")
    await fs.rename(tmpPath, filePath)

    return journal
  })
}

// ─── logEvent ─────────────────────────────────────────────────────────────────
export async function logEvent(filePath: string, input: WriteJournalInput): Promise<string> {
  return withJournalLock(filePath, async () => {
    const parsed = WriteJournalInputSchema.parse(input)
    if (parsed.operation !== "log_event") {
      throw new Error(`Expected operation "log_event", got "${parsed.operation}"`)
    }

    const journal = await readJournal(filePath)

    if (journal.sessions.length === 0) {
      return "error: no active session"
    }

    const lastSession = journal.sessions[journal.sessions.length - 1]

    if (lastSession.events.length >= 200) {
      return "error: event cap reached (200)"
    }

    const { data } = parsed
    lastSession.events.push({
      t: data.t,
      u: data.u,
      tok: data.tok,
      msg: data.msg,
      ...(data.wait !== undefined ? { wait: data.wait } : {}),
      ...(data.gate !== undefined ? { gate: data.gate } : {}),
    })

    // Atomic write
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(journal), "utf-8")
    await fs.rename(tmpPath, filePath)

    return "ok"
  })
}

// ─── endSession ───────────────────────────────────────────────────────────────
export async function endSession(filePath: string, input: WriteJournalInput): Promise<JournalFile> {
  return withJournalLock(filePath, async () => {
    const parsed = WriteJournalInputSchema.parse(input)
    if (parsed.operation !== "end_session") {
      throw new Error(`Expected operation "end_session", got "${parsed.operation}"`)
    }

    const journal = await readJournal(filePath)

    if (journal.sessions.length === 0) {
      throw new Error("error: no active session")
    }

    const lastSession = journal.sessions[journal.sessions.length - 1]
    const { data } = parsed

    lastSession.dur_min = data.dur_min
    lastSession.ctx_used_pct = data.ctx_used_pct
    lastSession.summary = {
      units_ok: data.summary.units_ok,
      units_rej: data.summary.units_rej,
      w_spawned: data.summary.w_spawned,
      w_wasted: data.summary.w_wasted,
      tok_wasted: data.summary.tok_wasted,
      delay_min: data.summary.delay_min,
      blockers: data.summary.blockers,
      friction: data.summary.friction,
    }

    // Compute rollup if we have >= 5 sessions
    if (journal.sessions.length >= 5) {
      journal.rollup = computeRollup(journal.sessions)
    }

    // Atomic write
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(journal), "utf-8")
    await fs.rename(tmpPath, filePath)

    return journal
  })
}

// ─── computeRollup ────────────────────────────────────────────────────────────
export function computeRollup(sessions: JournalSession[]): JournalRollup {
  const count = sessions.length

  // avg_friction: average across sessions that have a summary
  const sessionsWithSummary = sessions.filter((s) => s.summary !== undefined)
  const avg_friction =
    sessionsWithSummary.length > 0
      ? sessionsWithSummary.reduce((sum, s) => sum + s.summary!.friction, 0) /
        sessionsWithSummary.length
      : 0

  // top_events: count all event codes across all sessions
  const eventCounts = new Map<string, number>()
  for (const session of sessions) {
    for (const event of session.events) {
      eventCounts.set(event.t, (eventCounts.get(event.t) ?? 0) + 1)
    }
  }
  const top_events = Array.from(eventCounts.entries())
    .map(([t, count]) => ({ t, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // tok_total_wasted: sum across sessions with summary
  const tok_total_wasted = sessionsWithSummary.reduce(
    (sum, s) => sum + s.summary!.tok_wasted,
    0
  )

  // delay_total_min: sum across sessions with summary
  const delay_total_min = sessionsWithSummary.reduce(
    (sum, s) => sum + s.summary!.delay_min,
    0
  )

  // worst_unit_pattern: unit (by u field) with most W_REJ events
  const rejCountByUnit = new Map<string, number>()
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.t === "W_REJ") {
        rejCountByUnit.set(event.u, (rejCountByUnit.get(event.u) ?? 0) + 1)
      }
    }
  }
  let worst_unit_pattern = "none"
  let maxRej = 0
  for (const [unit, rejCount] of rejCountByUnit.entries()) {
    if (rejCount > maxRej) {
      maxRej = rejCount
      worst_unit_pattern = unit
    }
  }

  // best_unit_pattern: unit with zero W_REJ that has the most total events
  const totalEventsByUnit = new Map<string, number>()
  for (const session of sessions) {
    for (const event of session.events) {
      totalEventsByUnit.set(event.u, (totalEventsByUnit.get(event.u) ?? 0) + 1)
    }
  }
  let best_unit_pattern = "none"
  let maxTotal = 0
  for (const [unit, total] of totalEventsByUnit.entries()) {
    if ((rejCountByUnit.get(unit) ?? 0) === 0 && total > maxTotal) {
      maxTotal = total
      best_unit_pattern = unit
    }
  }

  return {
    sessions: count,
    avg_friction,
    top_events,
    tok_total_wasted,
    delay_total_min,
    worst_unit_pattern,
    best_unit_pattern,
  }
}
