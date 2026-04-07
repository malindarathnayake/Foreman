import fs from "fs/promises"
import path from "path"
import type { LedgerFile, WriteLedgerInput } from "../types.js"

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
export async function readLedger(filePath: string): Promise<LedgerFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return freshLedger()
    }
    throw err
  }

  try {
    return JSON.parse(raw) as LedgerFile
  } catch {
    // Corrupt JSON — back it up and return a fresh ledger
    const backupPath = `${filePath}.corrupt.${Date.now()}`
    await fs.rename(filePath, backupPath)
    return freshLedger()
  }
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
function applyOperation(ledger: LedgerFile, operation: WriteLedgerInput): void {
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
            "do NOT write implementation code directly. Read skill://foreman/implementor for the full protocol."
          )
        }
        ledger.phases[phase].units[unit_id].w = data.brief
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
            "Read skill://foreman/implementor for the full protocol."
          )
        }
      }
      ledger.phases[phase].units[unit_id].v = data.v
      break
    }
    case "add_rejection": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      ledger.phases[phase].units[unit_id].rej.push({
        r: data.r,
        msg: data.msg,
        ts: data.ts,
      })
      break
    }
    case "update_phase_gate": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      ledger.phases[phase].g = data.g
      break
    }
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────
export async function writeLedger(
  filePath: string,
  operation: WriteLedgerInput
): Promise<LedgerFile> {
  return withLedgerLock(filePath, async () => {
    const ledger = await readLedger(filePath)

    applyOperation(ledger, operation)
    ledger.ts = new Date().toISOString()

    // Atomic write: write to .tmp then rename
    const tmpPath = `${filePath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(ledger), "utf-8")
    await fs.rename(tmpPath, filePath)

    return ledger
  })
}
