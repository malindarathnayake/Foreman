import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import type { LedgerFile, Phase, Unit, WriteLedgerInput } from "../types.js"
import { detectTestFiles } from "./detectTestFiles.js"
import { atomicWriteFile } from "./atomicWrite.js"
import { scrub } from "./redaction.js"
import { readEvents, resolveUnitDelegation, boundIdentifier, type SidecarEvent } from "./eventsSidecar.js"

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

// ─── Gate-staleness snapshot (D2b) ───────────────────────────────────────────
// Hash of the phase's unit ids + verdicts + verdict timestamps at gate-pass time.
// Recomputed on read: a mismatch means units changed after the gate passed.
// Legacy units without v_ts (pre-v0.5.0) hash as empty string (R1).
export function computeGateUnitsHash(units: Record<string, Unit>): string {
  const material = Object.keys(units)
    .sort()
    .map((id) => `${id}:${units[id].v}:${units[id].v_ts ?? ""}`)
    .join("\n")
  return createHash("sha256").update(material, "utf-8").digest("hex")
}

// ─── Discipline-adherence gate (P5 5a — decision #4, normative spec §311-323) ───
// Server-side enforcement on update_phase_gate g:'pass', sequenced AFTER
// gate-pass-requires-all-pass and D13 seat-minimum. For each pass-verdict unit it
// reconciles the LEDGER verdict against that unit's LATEST hash-chained sidecar
// delegation's TERMINAL outcome: a prompt that talks the model into writing 'pass'
// into the ledger cannot forge a hash-chained validation_completed{outcome:'pass'}.
// The reader verifies the hash chain and THROWS LOUD on any break/tamper — that
// throw is deliberately NOT caught here (a broken chain must halt the gate).
export type SidecarReader = () => Promise<SidecarEvent[]>

async function disciplineAdherenceGate(
  phase: string,
  phaseObj: Phase,
  data: { user_override?: boolean },
  sidecarReader: SidecarReader
): Promise<void> {
  const events = await sidecarReader()
  for (const [unitId, unit] of Object.entries(phaseObj.units)) {
    if (unit.v !== "pass") continue
    const res = resolveUnitDelegation(events, phase, unitId)
    switch (res.kind) {
      case "none":
      case "pass":
        continue
      case "open":
        throw new Error(
          `DISCIPLINE ADHERENCE: unit '${boundIdentifier(unitId)}' passed in ledger but delegation ${res.delegationId} has no terminal sidecar event.`
        )
      case "contradiction":
        if (data.user_override !== true) {
          throw new Error(
            `DISCIPLINE ADHERENCE: unit '${boundIdentifier(unitId)}' ledger verdict 'pass' contradicts sidecar terminal outcome '${res.outcome}' (delegation ${res.delegationId}); server-side enforcement refuses gate-pass — reconcile or set data.user_override: true and escalate to the user.`
          )
        }
        phaseObj.discipline_overrides ??= []
        phaseObj.discipline_overrides.push({ discipline_override: true, unit_id: unitId, delegation_id: res.delegationId })
        break
    }
  }
}

// ─── Apply mutation ───────────────────────────────────────────────────────────
// Returns an optional warning string to surface in the tool result.
async function applyOperation(
  ledger: LedgerFile,
  operation: WriteLedgerInput,
  sidecarReader?: SidecarReader
): Promise<string | undefined> {
  switch (operation.operation) {
    case "set_unit_status": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      // Delegation requires a worker brief — this proves pitboss built one
      if (data.s === "delegated") {
        if (!data.brief || data.brief.trim().length < 20) {
          throw new Error(
            "DELEGATION REQUIRED: set_unit_status with s:'delegated' requires a 'brief' field (min 20 chars) " +
            "containing the worker brief summary. The pitboss must build a brief and delegate to a worker — " +
            "do NOT write implementation code directly. Call mcp__foreman__pitboss_implementor to load the full protocol."
          )
        }
        const unit = ledger.phases[phase].units[unit_id]
        // D2a delegation cap: count DISTINCT rejected attempts, not raw rejection count —
        // two reviewers rejecting the same attempt fire the cap once. Stamped entries
        // contribute their attempt number; unstamped legacy entries are conservatively
        // treated as distinct (unique synthetic key each). Stored entries are never mutated.
        const distinctRejectedAttempts = new Set(
          unit.rej.map((rej, i) => (rej.attempt !== undefined ? `a${rej.attempt}` : `legacy${i}`))
        )
        if (distinctRejectedAttempts.size >= 3 && data.user_override !== true) {
          throw new Error(
            `DELEGATION CAP: unit '${unit_id}' has ${distinctRejectedAttempts.size} distinct rejected attempts (cap 3). ` +
            "A 4th delegation requires data.user_override: true — escalate to the user with the rejection history."
          )
        }
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
          ...(data.user_override === true ? { user_override: true } : {}),
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
            "The pitboss must delegate to a worker through the active host before marking pass. " +
            "Call mcp__foreman__pitboss_implementor to load the full protocol."
          )
        }
        // No-test/no-build phases require an attestation note on every pass verdict
        const scope = ledger.phases[phase].scope
        if (scope && (scope.has_tests === false || scope.has_build === false)) {
          const missing = [
            scope.has_tests === false ? "has_tests:false" : null,
            scope.has_build === false ? "has_build:false" : null,
          ].filter(Boolean).join(", ")
          if (!data.note || data.note.trim().length === 0) {
            throw new Error(
              `ATTESTATION REQUIRED: phase '${phase}' declares scope ${missing}. ` +
              "set_verdict(v:'pass') must include a non-empty 'note' describing how the unit was " +
              "validated in place of automated tests/build (e.g. manual smoke, artifact hash, console inspection). " +
              "Silent verdicts on scopeless phases are forbidden — see No-Test Phase Attestation in the protocol."
            )
          }
          // D2e attestation floor: non-empty is not evidence. Applies ONLY on this
          // attestation path — unscoped phases keep accepting any note.
          const trimmed = data.note.trim()
          const words = trimmed.split(/\s+/).length
          if (words < 5 || trimmed.length < 32) {
            throw new Error(
              `ATTESTATION REQUIRED: phase '${phase}' declares scope ${missing}. ` +
              "The attestation note must carry at least 5 words and 32 characters of real evidence " +
              `(got ${words} words / ${trimmed.length} chars).`
            )
          }
        }
      }
      const unit = ledger.phases[phase].units[unit_id]
      unit.v = data.v
      // R1: verdict timestamp — consumed by the D2b gate-staleness snapshot (3d).
      unit.v_ts = new Date().toISOString()
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
        // D2a: stamp which delegation attempt this rejection belongs to.
        // 0 = rejected before any delegation. Legacy entries (pre-v0.5.0) stay unstamped.
        attempt: unit.delegations?.length ?? 0,
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
          // D2d: INCONCLUSIVE units are named in their own sentence — a reviewer non-answer
          // is re-run guidance, never a fail. First list stays the complete non-passing set
          // (existing message contract preserved; see PROGRESS Decisions).
          const inconclusive = notPassing.filter((id) => units[id].v === "inconclusive").sort()
          const inconclusiveSentence = inconclusive.length > 0
            ? `INCONCLUSIVE (reviewer gave no usable verdict — re-run review, do not treat as fail): ${inconclusive.join(", ")}. `
            : ""
          throw new Error(
            `PHASE GATE BLOCKED: phase '${phase}' has units without a pass verdict: ` +
            `${notPassing.sort().join(", ")}. ` +
            inconclusiveSentence +
            "Every unit must reach set_verdict(v:'pass') before the phase gate can pass."
          )
        }
        // D13 seat minimum: a flagged phase (hot_path / security_boundary) requires a
        // frontier-class judgment seat to pass its gate. Declared-input validation ONLY —
        // the class is never inferred from model ids or anything else.
        const scope = ledger.phases[phase].scope
        if (scope?.hot_path || scope?.security_boundary) {
          if (data.agent_class !== "frontier" && data.user_override !== true) {
            const flags = [
              scope.hot_path ? "hot_path" : null,
              scope.security_boundary ? "security_boundary" : null,
            ].filter(Boolean).join(", ")
            throw new Error(
              `SEAT MINIMUM: phase '${phase}' is scoped ${flags} — gate pass requires ` +
              "data.agent_class: 'frontier' (a frontier-class judgment seat) or data.user_override: true. " +
              `Declared: ${data.agent_class ?? "none"}.`
            )
          }
        }
        // P5 discipline-adherence gate (decision #4): the enforcement line, after the
        // gate-pass-requires-all-pass + D13 checks and before the D2b snapshot. A block
        // here (throw) prevents the snapshot and the g:'pass' write.
        if (sidecarReader) {
          await disciplineAdherenceGate(phase, ledger.phases[phase], data, sidecarReader)
        }
      }
      // D2b: snapshot only on a passing gate — never on fail/pending, never cleared.
      // Read paths recompute and flag STALE; nothing is ever blocked on staleness.
      if (data.g === "pass") {
        ledger.phases[phase].gate_units_hash = {
          hash: computeGateUnitsHash(ledger.phases[phase].units),
          ts: new Date().toISOString(),
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
  operation: WriteLedgerInput,
  preWrite?: (ledger: LedgerFile) => void,
  sidecarReader?: SidecarReader
): Promise<LedgerWriteResult> {
  return withLedgerLock(filePath, async () => {
    const read = await readLedgerWithStatus(filePath)
    const ledger = read.ledger

    // Default-on enforcement: derive the sidecar reader from the ledger path when the
    // caller does not inject one (tests inject a fake). The sidecar lives alongside the
    // ledger (same dir), matching writeLedger.ts / invokeWorker.ts / readLedger.ts.
    const reader: SidecarReader =
      sidecarReader ??
      (async () => (await readEvents(path.join(path.dirname(filePath), ".foreman-events.jsonl"))).events)

    let warning = await applyOperation(ledger, operation, reader)
    if (read.corrupt) {
      const corruptNote =
        `previous ledger was corrupt JSON and was backed up to '${read.backupPath}'; ` +
        "this write started from a fresh ledger. Restore from the backup if prior state matters."
      warning = warning ? `${warning} | ${corruptNote}` : corruptNote
    }
    ledger.ts = new Date().toISOString()

    // 5b seam: fold caller-held in-memory aggregates (ccr_stats) into the SAME atomic
    // write — runs only after applyOperation succeeded, so a rejected operation never
    // consumes the caller's pending state.
    preWrite?.(ledger)

    // Atomic write via shared helper (unique tmp suffix — cross-process safe, D2c)
    await atomicWriteFile(filePath, JSON.stringify(ledger), { scrub })

    return { ledger, warning }
  })
}
