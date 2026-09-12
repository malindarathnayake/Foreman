import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import type { JournalFile, JournalSession, JournalRollup, WriteJournalInput } from "../types.js"
import type { ModelRank } from "./modelRank.js"
import { WriteJournalInputSchema, JournalSoftLimits } from "../types.js"
import { atomicWriteFile } from "./atomicWrite.js"
import { scrub } from "./redaction.js"
import { softLimitWarning } from "./softLimits.js"
import { resolveModelRank } from "./modelRank.js"
import type { HostId } from "./hostProfiles.js"

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
export async function initSession(filePath: string, input: WriteJournalInput, host?: HostId): Promise<JournalFile> {
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

    // Per spec: update file-level project and target_version
    journal.project = "foreman-mcp"
    journal.target_version = data.target_version

    const modelRank = { ...resolveModelRank(data.env.model, data.env.effort), session_id: sessionId }
    newSession.env = {
      model: modelRank.model,
      effort: modelRank.effort,
      model_rank: modelRank,
      os: osStr,
      node: nodeStr,
      foreman: foremanVersion,
      // Server-authored, never from input: rank rehydration compares against it.
      ...(host !== undefined ? { host } : {}),
      agent: data.env.agent,
      worker: data.env.worker,
      ...(data.env.claude !== undefined ? { claude: data.env.claude } : {}),
      codex: data.env.codex,
      gemini: data.env.gemini,
      // R8: declared capability classes — pass-through only, absent keys stay absent.
      ...(data.env.agent_class !== undefined ? { agent_class: data.env.agent_class } : {}),
      ...(data.env.worker_class !== undefined ? { worker_class: data.env.worker_class } : {}),
    }

    journal.sessions.push(newSession)

    // FIFO: keep at most 50 sessions
    if (journal.sessions.length > 50) {
      journal.sessions = journal.sessions.slice(-50)
    }

    // Atomic write via shared helper (unique tmp suffix — cross-process safe, D2c)
    await atomicWriteFile(filePath, JSON.stringify(journal), { scrub })

    return journal
  })
}

/** Replace the declaration only on the current live session; historical ranks are evidence. */
export async function declareModel(
  filePath: string, input: WriteJournalInput, sessionId: string, host?: HostId
): Promise<JournalFile> {
  return withJournalLock(filePath, async () => {
    const parsed = WriteJournalInputSchema.parse(input)
    if (parsed.operation !== "declare_model") throw new Error(`Expected operation "declare_model", got "${parsed.operation}"`)
    const journal = await readJournal(filePath)
    const session = journal.sessions.at(-1)
    // 0.6.27: after a mid-session Foreman restart this process holds no session id, so the old
    // equality check could never match and declare_model threw — leaving init_session, which
    // appends a spurious session, as the ONLY way to recover a rank the journal already holds.
    // With no session id, adopt the newest still-open session declared under the SAME host.
    const adoptable = sessionId === "" && session !== undefined && !session.summary &&
      session.env !== undefined && session.env.host !== undefined && session.env.host === host
    if (!session || (!adoptable && session.id !== sessionId) || session.summary || !session.env) {
      throw new Error("error: no current active session; call init_session before declare_model")
    }
    // Codex review: a MATCHING session id used to bypass the host check entirely, so a process on
    // one host could rewrite the declaration of a session stamped with another — and two servers
    // racing init_session over one journal can both hold "s1". Host is checked on every path.
    // `host === undefined` is a caller that did not declare one, which cannot prove same-host.
    // A session carrying NO host stamp predates 0.6.27; the id match governs it as it always did.
    // Once a session IS stamped, the caller must prove the same host — including a caller that
    // names none, which cannot prove it.
    if (session.env.host !== undefined && session.env.host !== host) {
      throw new Error(
        `error: session '${session.id}' was declared under host '${session.env.host}', not ` +
        `'${host ?? "none declared"}'; a declaration made under another host describes another host`
      )
    }
    const modelRank = { ...resolveModelRank(parsed.data.model, parsed.data.effort), session_id: session.id }
    const history = session.model_declarations ?? []
    if (history.length === 0 && session.env.model_rank) history.push({ ts: session.ts, model_rank: session.env.model_rank })
    history.push({ ts: new Date().toISOString(), model_rank: modelRank })
    session.model_declarations = history.slice(-20)
    session.env.model = modelRank.model
    session.env.effort = modelRank.effort
    session.env.model_rank = modelRank
    await atomicWriteFile(filePath, JSON.stringify(journal), { scrub })
    return journal
  })
}

/**
 * The rank to resume with after a mid-session Foreman restart (0.6.27).
 *
 * The declaration was always durable — `env.model_rank` is written by init_session and
 * declare_model — but the process held it only in memory, so a `/mcp` restart dropped every
 * operator to weight 0 and no workflow permissions, with init_session (which appends a whole
 * spurious session) as the only recovery. Nothing read the record back; this does.
 *
 * Fail closed on every doubt: the session must still be OPEN (no summary), must carry a rank,
 * and must name the SAME host. A journal written before 0.6.27 records no host, so it never
 * rehydrates — the original rule this preserves is that a declaration made under another host
 * describes another host, and an absent host cannot prove otherwise.
 */
export async function rehydrateRank(filePath: string, host: HostId): Promise<ModelRank | undefined> {
  let session: JournalSession | undefined
  try {
    const journal = await readJournal(filePath)
    // Codex review: readJournal parses JSON without validating shape, so '{}' or
    // '{"sessions":null}' reached `.at(-1)` and threw INSIDE createServer — a hand-edited or
    // truncated journal would stop the whole MCP server from starting, taking every unrelated
    // tool with it. The shape check belongs inside the guard.
    if (!Array.isArray(journal?.sessions)) return undefined
    session = journal.sessions.at(-1)
  } catch {
    return undefined   // an unreadable journal is never a reason to fail startup
  }
  if (!session || session.summary || !session.env) return undefined
  if (session.env.host === undefined || session.env.host !== host) return undefined
  if (typeof session.id !== "string" || typeof session.ts !== "string") return undefined

  // Codex review: the persisted rank carries DERIVED fields — weight and the permission
  // booleans the ledger consumes directly. Adopting them verbatim would make a hand-edited
  // journal an authorization grant. Recompute from the declared model and effort, which are the
  // only things the operator actually declared, and take session_id from the enclosing session
  // rather than from the blob that claims it.
  const declared = resolveModelRank(session.env.model, session.env.effort)
  if (declared.weight === 0) return undefined

  return {
    ...declared,
    session_id: session.id,
    // A rehydrated rank restores ORIENTATION, never authorization. The operator may have changed
    // model during the restart and Foreman cannot tell; granting relaxations on that guess is the
    // wrongly-allowed failure the whole policy is built to avoid. One declare_model — which this
    // release also repairs — turns the permissions back on, and no longer costs a spurious session.
    permissions: { reuse_worker_mechanical: false, reuse_worker_bounded: false, compact_followup: false, focused_validation: false, delta_review: false },
    rehydrated: { session_id: session.id, session_ts: session.ts },
  }
}

// ─── logEvent ─────────────────────────────────────────────────────────────────
export async function logEvent(filePath: string, input: WriteJournalInput): Promise<string> {
  return withJournalLock(filePath, async () => {
    const parsed = WriteJournalInputSchema.parse(input)
    if (parsed.operation !== "log_event") {
      throw new Error(`Expected operation "log_event", got "${parsed.operation}"`)
    }
    // 0.6.20: an over-long msg is cut with a marker by the schema and reported, never refused.
    const truncated = softLimitWarning(input, parsed, JournalSoftLimits.log_event)

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

    // Atomic write via shared helper (unique tmp suffix — cross-process safe, D2c)
    await atomicWriteFile(filePath, JSON.stringify(journal), { scrub })

    return truncated ? `ok\nwarning: ${truncated}` : "ok"
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

    // Atomic write via shared helper (unique tmp suffix — cross-process safe, D2c)
    await atomicWriteFile(filePath, JSON.stringify(journal), { scrub })

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
