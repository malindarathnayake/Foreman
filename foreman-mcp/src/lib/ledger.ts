import fs from "fs/promises"
import path from "path"
import type { LedgerFile, WriteLedgerInput } from "../types.js"
import { detectTestFiles } from "./detectTestFiles.js"

// ─── Per-path mutex registry ──────────────────────────────────────────────────
// Each ledger path gets its own promise-chain lock so different files can be
// written independently without contention.
const lockRegistry = new Map<string, Promise<void>>()

function withLedgerLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockRegistry.get(filePath) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  lockRegistry.set(filePath, next)
  return prev.then(fn).finally(() => resolve())
}

// ─── Fresh ledger factory ─────────────────────────────────────────────────────
function freshLedger(): LedgerFile {
  return { v: 1, ts: new Date().toISOString(), phases: {} }
}

// ─── Read ─────────────────────────────────────────────────────────────────────
export interface LedgerReadResult {
  ledger: LedgerFile
  /** True when the on-disk file existed but failed to parse. */
  corrupt: boolean
  /** Set when corrupt recovery renamed the file (write path only). */
  backupPath?: string
}

export async function readLedgerWithStatus(
  filePath: string,
  opts?: { readOnly?: boolean }
): Promise<LedgerReadResult> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return { ledger: freshLedger(), corrupt: false }
    }
    throw err
  }

  try {
    return { ledger: JSON.parse(raw) as LedgerFile, corrupt: false }
  } catch {
    // Corrupt JSON — back it up and return a fresh ledger (unless read-only)
    if (!opts?.readOnly) {
      const backupPath = `${filePath}.corrupt.${Date.now()}`
      await fs.rename(filePath, backupPath)
      return { ledger: freshLedger(), corrupt: true, backupPath }
    }
    return { ledger: freshLedger(), corrupt: true }
  }
}

export async function readLedger(
  filePath: string,
  opts?: { readOnly?: boolean }
): Promise<LedgerFile> {
  return (await readLedgerWithStatus(filePath, opts)).ledger
}

// ─── Ensure phase/unit exist ──────────────────────────────────────────────────
function ensureUnit(ledger: LedgerFile, phase: string, unitId: string): void {
  if (!ledger.phases[phase]) {
    ledger.phases[phase] = {
      s: "ip",
      g: "pending",
      units: {},
    }
  }
  if (!ledger.phases[phase].units[unitId]) {
    ledger.phases[phase].units[unitId] = {
      s: "pending",
      v: "pending",
      w: null,
      rej: [],
    }
  }
}

function ensurePhase(ledger: LedgerFile, phase: string): void {
  if (!ledger.phases[phase]) {
    ledger.phases[phase] = {
      s: "ip",
      g: "pending",
      units: {},
    }
  }
}

// ─── Apply mutation ───────────────────────────────────────────────────────────
// Returns an optional warning string to surface in the tool result.
async function applyOperation(ledger: LedgerFile, operation: WriteLedgerInput): Promise<string | undefined> {
  switch (operation.operation) {
    case "set_unit_status": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      // Delegation requires a worker brief — this proves pitboss built one
      if (data.s === "delegated") {
        if (!data.brief || data.brief.trim().length < 20) {
          throw new Error(
            "DELEGATION REQUIRED: set_unit_status with s:'delegated' requires a 'brief' field (min 20 chars) " +
            "containing the worker brief summary. The pitboss must build a brief and spawn a Sonnet worker — " +
            "do NOT write implementation code directly. Call mcp__foreman__pitboss_implementor to load the full protocol."
          )
        }
        const unit = ledger.phases[phase].units[unit_id]
        // `w` is the latest brief (the pass-gate reads it). tier/route_reason are audit evidence.
        unit.w = data.brief
        if (data.tier !== undefined) unit.tier = data.tier
        if (data.route_reason !== undefined) unit.route_reason = data.route_reason
        // Append-only history — survives the `w` overwrite when a fix worker re-delegates.
        // Optional field: lazily created so units that never delegate stay lean, and old
        // on-disk units (which bypass the new-unit initializer) are handled here.
        unit.delegations ??= []
        const lastAttempt = unit.delegations.length
          ? unit.delegations[unit.delegations.length - 1].attempt
          : 0
        unit.delegations.push({
          brief: data.brief,
          tier: data.tier,
          route_reason: data.route_reason,
          ts: new Date().toISOString(),
          attempt: lastAttempt + 1,   // monotonic even after the cap slice below
        })
        if (unit.delegations.length > 20) unit.delegations = unit.delegations.slice(-20)
      }
      ledger.phases[phase].units[unit_id].s = data.s
      break
    }
    case "set_verdict": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      // Pass verdict requires prior delegation — cannot skip the worker pattern
      if (data.v === "pass") {
        const unit = ledger.phases[phase].units[unit_id]
        if (!unit.w) {
          throw new Error(
            "VERDICT BLOCKED: Cannot set verdict 'pass' without prior delegation. " +
            "Unit must go through: set_unit_status(s:'ip') → set_unit_status(s:'delegated', brief:'...') → set_verdict(v:'pass'). " +
            "The pitboss must spawn a Sonnet worker via Agent tool before marking pass. " +
            "Call mcp__foreman__pitboss_implementor to load the full protocol."
          )
        }
        // No-test/no-build phases require an attestation note on every pass verdict
        const scope = ledger.phases[phase].scope
        if (scope && (scope.has_tests === false || scope.has_build === false)) {
          if (!data.note || data.note.trim().length === 0) {
            const missing = [
              scope.has_tests === false ? "has_tests:false" : null,
              scope.has_build === false ? "has_build:false" : null,
            ].filter(Boolean).join(", ")
            throw new Error(
              `ATTESTATION REQUIRED: phase '${phase}' declares scope ${missing}. ` +
              "set_verdict(v:'pass') must include a non-empty 'note' describing how the unit was " +
              "validated in place of automated tests/build (e.g. manual smoke, artifact hash, console inspection). " +
              "Silent verdicts on scopeless phases are forbidden — see No-Test Phase Attestation in the protocol."
            )
          }
        }
      }
      const unit = ledger.phases[phase].units[unit_id]
      unit.v = data.v
      if (data.via !== undefined) {
        unit.via = data.via
      } else {
        delete unit.via
      }
      if (data.note !== undefined) {
        unit.note = data.note
      } else {
        delete unit.note
      }
      break
    }
    case "add_rejection": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      const unit = ledger.phases[phase].units[unit_id]
      unit.rej.push({
        r: data.r,
        msg: data.msg,
        ts: data.ts,
      })
      if (unit.rej.length > 20) unit.rej = unit.rej.slice(-20)
      break
    }
    case "update_phase_gate": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      // Gate pass requires every unit in the phase to carry a pass verdict
      if (data.g === "pass") {
        const units = ledger.phases[phase].units
        const unitIds = Object.keys(units)
        if (unitIds.length === 0) {
          throw new Error(
            `PHASE GATE BLOCKED: phase '${phase}' has no units recorded. ` +
            "A gate cannot pass for an empty phase — seed units via set_unit_status first, " +
            "or verify the phase id is correct."
          )
        }
        const notPassing = unitIds.filter((id) => units[id].v !== "pass")
        if (notPassing.length > 0) {
          throw new Error(
            `PHASE GATE BLOCKED: phase '${phase}' has units without a pass verdict: ` +
            `${notPassing.sort().join(", ")}. ` +
            "Every unit must reach set_verdict(v:'pass') before the phase gate can pass."
          )
        }
      }
      ledger.phases[phase].g = data.g
      break
    }
    case "set_phase_scope": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      if (ledger.phases[phase].scope !== undefined) {
        throw new Error(
          `scope_already_set: phase '${phase}' already has scope declared. ` +
          `Existing: ${JSON.stringify(ledger.phases[phase].scope)}. ` +
          `Clear manually if re-declaration is intended (out of scope for v0.0.7.5).`
        )
      }
      let warning: string | undefined
      if (!data.has_tests) {
        const found = await detectTestFiles(process.cwd())
        if (found.length > 0) {
          warning =
            `has_tests: false declared but ${found.length} test files detected ` +
            `(e.g. ${found.slice(0, 3).join(", ")}). If these tests cover this phase, declare has_tests: true ` +
            "— otherwise pass verdicts will require manual attestation notes."
          console.error(`[foreman write_ledger] ${warning}`)
        }
      }
      ledger.phases[phase].scope = { ...data }
      return warning
    }
    case "record_review": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      const p = ledger.phases[phase]
      // Optional field: lazily created (absent on pre-v0.3.1 phases loaded from disk).
      p.reviews ??= []
      p.reviews.push({
        advisor: data.advisor,
        ts: new Date().toISOString(),   // per-review timestamp, distinct from the file ts
        findings: data.findings,
        packet_hash: data.packet_hash,
        tokens: data.tokens,
      })
      if (p.reviews.length > 20) p.reviews = p.reviews.slice(-20)
      break
    }
    default: {
      // Exhaustiveness guard: the switch has no implicit fallthrough safety, so a new
      // WriteLedgerInput variant without a case would otherwise silently no-op. This makes
      // TypeScript fail the build (never-assignment) and throws at runtime as a backstop.
      const _exhaustive: never = operation
      throw new Error(`unknown ledger operation: ${JSON.stringify(_exhaustive)}`)
    }
  }
  return undefined
}

// ─── Write ────────────────────────────────────────────────────────────────────
export interface LedgerWriteResult {
  ledger: LedgerFile
  /** Non-fatal warning to surface in the tool result (e.g. scope/test-file mismatch). */
  warning?: string
}

export async function writeLedger(
  filePath: string,
  operation: WriteLedgerInput
): Promise<LedgerWriteResult> {
  return withLedgerLock(filePath, async () => {
    const read = await readLedgerWithStatus(filePath)
    const ledger = read.ledger

    let warning = await applyOperation(ledger, operation)
    if (read.corrupt) {
      const corruptNote =
        `previous ledger was corrupt JSON and was backed up to '${read.backupPath}'; ` +
        "this write started from a fresh ledger. Restore from the backup if prior state matters."
      warning = warning ? `${warning} | ${corruptNote}` : corruptNote
    }
    ledger.ts = new Date().toISOString()

    // Atomic write: write to .tmp then rename
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(ledger), "utf-8")
    await fs.rename(tmpPath, filePath)

    return { ledger, warning }
  })
}
