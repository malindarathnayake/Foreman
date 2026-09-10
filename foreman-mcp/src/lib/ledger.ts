import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import type { CapGrant, DelegationGuard, GateEvidence, LedgerFile, Phase, PhaseReview, Unit, WriteLedgerInput } from "../types.js"
import type { HostId } from "./hostProfiles.js"
import { detectTestFiles } from "./detectTestFiles.js"
import { atomicWriteFile } from "./atomicWrite.js"
import { scrub } from "./redaction.js"
import { readEvents, resolveUnitDelegation, boundIdentifier, type SidecarEvent } from "./eventsSidecar.js"
import { resolveModelRank, type ModelRank } from "./modelRank.js"
import {
  latestVerdictTs, reviewIncompleteness, isSuperseded, REVIEW_RETENTION, trimReviews,
  normalizedPaths, samePaths, workerDeltaBlocker, verificationIneligibility,
  prospectiveVerification, prospectiveWorkerDelta,
} from "./reviewPredicates.js"
import { applyEscape, classifyEscape, classifyGate, coveringGate, recordGatePass, unclassifiedEscapes } from "./reviewBasis.js"
import { appendConsumed, readReceipts, receiptsPathFor, type ReceiptsState } from "./seatReceipts.js"

/** Receipts file access for one write: read on demand, consumption applied after the operation succeeds. */
export interface ReceiptsAccess {
  read: () => Promise<ReceiptsState>
  consumed: Array<{ id: string; phase: string; review_ts: string }>
}

// Re-exported so existing importers of the gate predicates keep one entry point.
export { reviewIncompleteness, REVIEW_RETENTION, trimReviews, verificationIneligibility }

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

// ─── Attempt accounting (field feedback 2026-09 round 4, Codex) ──────────────
// The delegation cap used to be recomputed from rej[] stamps and guarded only the
// delegation record: a capped unit could be fixed off the record and passed, a
// rejected unit could be passed with no fix attempt at all, and rej[] / delegations[]
// are capped at 20 with the oldest dropped (and rej[].ts is caller-supplied), so no
// array can answer "how many attempts failed" or "did an attempt follow the failure".
// Four server-authored scalars on the unit do:
//   attempt_seq          every recorded attempt: worker delegation or Direct Fix
//   epoch_failed         distinct attempts that failed since the unit last passed
//   last_failed_attempt  dedupes two rejections of one attempt
//   needs_attempt        a failure with no attempt recorded since; blocks a pass
// A pass closes the series (epoch_failed back to 0), so a unit reopened at three
// separate checkpoints over weeks is not treated as one non-converging attempt series.
export const ATTEMPT_CAP = 3

/** Derives the scalars once for a unit written before v0.6.4. Never mutates rej[] or delegations[]. */
function ensureAttemptState(unit: Unit): void {
  if (unit.attempt_seq !== undefined) return
  const delegated = unit.delegations ?? []
  // Greatest retained attempt id, not the array length: the array is sliced at 20.
  const maxAttempt = delegated.reduce((m, d) => Math.max(m, d.attempt ?? 0), 0)
  unit.attempt_seq = Math.max(maxAttempt, delegated.length)
  if (unit.v === "pass") {
    unit.epoch_failed = 0
    unit.needs_attempt = false
    return
  }
  // Same count the pre-0.6.4 cap used: distinct stamped attempts, each unstamped
  // (pre-v0.5.0) rejection conservatively its own.
  const distinct = new Set(unit.rej.map((rej, i) => (rej.attempt !== undefined ? `a${rej.attempt}` : `legacy${i}`)))
  unit.epoch_failed = distinct.size
  const stamped = unit.rej.filter((rej) => rej.attempt !== undefined).map((rej) => rej.attempt as number)
  if (stamped.length > 0) {
    const latest = Math.max(...stamped)
    unit.last_failed_attempt = latest
    // A rejection stamped with the current attempt count was recorded after the last
    // attempt. Unstamped history cannot say, and is resolved toward not blocking.
    unit.needs_attempt = latest >= unit.attempt_seq
  } else {
    unit.needs_attempt = false
  }
}

/** A rejection or fail verdict: counts once per attempt, and demands a new attempt before a pass. */
function recordFailure(unit: Unit): void {
  ensureAttemptState(unit)
  unit.needs_attempt = true
  const current = unit.attempt_seq ?? 0
  if (unit.last_failed_attempt !== current) {
    unit.epoch_failed = (unit.epoch_failed ?? 0) + 1
    unit.last_failed_attempt = current
  }
}

/** The newest grant while it has attempts left and was not closed. Enforcement reads only this entry. */
function activeGrant(unit: Unit): CapGrant | undefined {
  const grant = unit.cap_grants?.[unit.cap_grants.length - 1]
  return grant && !grant.closed && grant.remaining > 0 ? grant : undefined
}

function closeGrant(unit: Unit, reason: "exhausted" | "pass"): void {
  const grant = unit.cap_grants?.[unit.cap_grants.length - 1]
  if (grant && !grant.closed) grant.closed = { ts: new Date().toISOString(), reason }
}

/**
 * Allocates the next attempt id. Past the cap the attempt is charged to an open grant
 * (authorize_attempts, v0.6.5) or needs a per-write user_override; both on one write is
 * refused so the audit trail says which decision paid for the attempt.
 */
function allocateAttempt(
  unit: Unit,
  unitId: string,
  kind: "delegation" | "direct fix",
  userOverride: boolean | undefined
): { attempt: number; cap_grant_id?: number } {
  ensureAttemptState(unit)
  const failed = unit.epoch_failed ?? 0
  const grant = failed >= ATTEMPT_CAP ? activeGrant(unit) : undefined
  if (failed >= ATTEMPT_CAP) {
    if (grant && userOverride === true) {
      throw new Error(
        `AMBIGUOUS OVERRIDE: unit '${unitId}' has grant #${grant.id} with ${grant.remaining} attempt(s) remaining. ` +
        "Drop data.user_override so this attempt is charged to the grant, or exhaust the grant first."
      )
    }
    if (!grant && userOverride !== true) {
      throw new Error(
        `DELEGATION CAP: unit '${unitId}' has ${failed} failed attempts since its last pass (cap ${ATTEMPT_CAP}). ` +
        `A further ${kind} needs the owner's decision: record it once with authorize_attempts { attempts, reason, user_override: true } ` +
        "(one grant covers several attempts) or set data.user_override: true on this write — escalate with the rejection history. " +
        "A pass verdict is blocked the same way until a granted or overridden attempt, or an overridden verdict, is recorded; do not fix off the record."
      )
    }
  }
  unit.attempt_seq = (unit.attempt_seq ?? 0) + 1
  unit.needs_attempt = false
  if (failed >= ATTEMPT_CAP) {
    unit.cap_override_attempt = unit.attempt_seq
    if (grant) {
      grant.remaining -= 1
      grant.consumed.push(unit.attempt_seq)
      if (grant.remaining === 0) closeGrant(unit, "exhausted")
    }
  }
  return { attempt: unit.attempt_seq, ...(grant ? { cap_grant_id: grant.id } : {}) }
}

// ─── Gate-staleness snapshot (D2b) ───────────────────────────────────────────
// Hash of the phase's unit ids + verdicts + verdict timestamps at gate-pass time.
// Recomputed on read: a mismatch means units changed after the gate passed.
// Legacy units without v_ts (pre-v0.5.0) hash as empty string (R1).
// The declared-unit set joins the material ONLY when the field exists — legacy
// phases keep the pre-v0.5.11 material so recorded hashes never flag false STALE.
// declare_phase_units is rejected on passed gates, so a post-pass declared change
// can only come from a manual edit — which this correctly surfaces as STALE.
export function computeGateUnitsHash(units: Record<string, Unit>, declaredUnits?: string[]): string {
  const unitMaterial = Object.keys(units)
    .sort()
    .map((id) => `${id}:${units[id].v}:${units[id].v_ts ?? ""}`)
    .join("\n")
  const material = declaredUnits === undefined
    ? unitMaterial
    : `${unitMaterial}\ndeclared:${[...declaredUnits].sort().join(",")}`
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
  sidecarReader?: SidecarReader,
  host: HostId = "claude-code",
  modelRank: ModelRank = resolveModelRank(),
  receipts?: ReceiptsAccess
): Promise<string | undefined> {
  switch (operation.operation) {
    case "set_unit_status": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      if (data.correction && (data.s !== "delegated" || data.direct_fix !== undefined)) {
        throw new Error("RANK CORRECTION: correction requires s:'delegated' and cannot be combined with direct_fix.")
      }
      if (data.direct_fix !== undefined && data.s !== "ip") {
        throw new Error(
          "DIRECT FIX: data.direct_fix is recorded with s:'ip' only — the fix is in progress until its verdict."
        )
      }
      // Delegation requires a worker brief — this proves pitboss built one
      if (data.s === "delegated") {
        if (!data.brief || data.brief.trim().length < 20) {
          throw new Error(
            "DELEGATION REQUIRED: set_unit_status with s:'delegated' requires a 'brief' field (min 20 chars) " +
            "containing the worker brief summary. The pitboss must build a brief and delegate to a worker — " +
            "do NOT write implementation code directly. Call mcp__foreman__pitboss_implementor to load the full protocol."
          )
        }
        // Field feedback 2026-09 round 2: the Step 4.5 preflight was a mental checklist.
        // Requiring its attestation here makes it as mechanical as the brief rule above,
        // and the delegation entry keeps the evidence. Sequenced AFTER the brief check so
        // existing DELEGATION REQUIRED messages are unchanged.
        if (!data.preflight) {
          throw new Error(
            "PREFLIGHT REQUIRED: set_unit_status with s:'delegated' requires data.preflight — the Brief Preflight " +
            "Gate attestation: { symbols_grepped: <brief symbols grepped across spec.md, ≥1>, self_consistent: true, " +
            "telemetry?: 'checked'|'n/a' }. Run Step 4.5 (symbol grep, spec-footprint diff, brief self-consistency, " +
            "telemetry names) and record it; a delegation without it is unaudited."
          )
        }
        const unit = ledger.phases[phase].units[unit_id]
        if (data.correction) {
          const permission = data.correction.kind === "mechanical" ? "reuse_worker_mechanical" : "reuse_worker_bounded"
          if (!modelRank.permissions[permission]) {
            throw new Error(`RANK CORRECTION: ${modelRank.rank} rank does not allow ${data.correction.kind} worker reuse; use the normal Foreman protocol.`)
          }
          const previous = unit.delegations?.at(-1)
          ensureAttemptState(unit)
          if (!previous || previous.attempt !== unit.attempt_seq || data.correction.from_attempt !== previous.attempt) {
            throw new Error("RANK CORRECTION: from_attempt must name the current worker delegation.")
          }
          if (!modelRank.session_id || previous.session_id !== modelRank.session_id ||
            !data.worker_id || data.worker_id !== previous.worker_id) {
            throw new Error("RANK CORRECTION: reuse requires the same recorded worker_id in the current declared session.")
          }
          const events = sidecarReader ? await sidecarReader() : []
          if (events.some((event) => event.phase === boundIdentifier(phase) && event.unit_id === boundIdentifier(unit_id) &&
            event.attempt === previous.attempt)) {
            throw new Error("RANK CORRECTION: invoke_worker attempts cannot be resumed as native workers; use the normal workflow.")
          }
          if (ledger.phases[phase].scope?.hot_path || ledger.phases[phase].scope?.security_boundary) {
            throw new Error("RANK CORRECTION: hot_path or security_boundary phases require the normal workflow.")
          }
          if (previous.guard?.result !== "ok" || previous.guard.override || unit.delegations?.some((d) => d.guard?.result === "violation")) {
            throw new Error("RANK CORRECTION: the previous worker attempt needs a cleared ownership guard.")
          }
          const allowed = new Set(normalizedPaths(previous.guard.snapshot.allowed))
          if (data.correction.files.length === 0 || normalizedPaths(data.correction.files).some((file) => !allowed.has(file))) {
            throw new Error("RANK CORRECTION: correction.files must remain inside the previous frozen authorized file scope.")
          }
        }
        // 0.6.19: a new attempt on a unit its gate still covers is a contradiction of that
        // gate. Recorded before the attempt is allocated, while the snapshot still matches.
        if (unit.v === "pass") applyEscape(ledger.phases[phase], unit_id, unit, "post_gate_attempt", new Date().toISOString())
        // D2a delegation cap, on server-authored counters since 0.6.4 (see
        // ensureAttemptState): two reviewers rejecting one attempt still fire it once.
        const { attempt, cap_grant_id } = allocateAttempt(unit, unit_id, "delegation", data.user_override)
        // `w` is the latest brief (the pass-gate reads it). tier/route_reason are audit evidence.
        unit.w = data.brief
        if (data.tier !== undefined) unit.tier = data.tier
        if (data.route_reason !== undefined) unit.route_reason = data.route_reason
        // Append-only history — survives the `w` overwrite when a fix worker re-delegates.
        // Optional field: lazily created so units that never delegate stay lean, and old
        // on-disk units (which bypass the new-unit initializer) are handled here.
        unit.delegations ??= []
        unit.delegations.push({
          brief: data.brief,
          tier: data.tier,
          route_reason: data.route_reason,
          ts: new Date().toISOString(),
          attempt,   // from attempt_seq: monotonic even after the cap slice below
          ...(data.user_override === true ? { user_override: true } : {}),
          ...(cap_grant_id !== undefined ? { cap_grant_id } : {}),
          preflight: data.preflight,
          ...(data.worker_id ? { worker_id: data.worker_id } : {}),
          ...(modelRank.session_id ? { session_id: modelRank.session_id, model_rank: modelRank } : {}),
          ...(data.correction ? { correction: data.correction } : {}),
        })
        if (data.correction) unit.v = "pending"
        if (unit.delegations.length > 20) unit.delegations = unit.delegations.slice(-20)
      } else if (data.direct_fix !== undefined) {
        // Field feedback 2026-09 round 4: the protocol counted a Direct Fix as an
        // outer-loop attempt but the ledger never saw one, so a rejected direct fix
        // collapsed onto the previous worker attempt and a pass after one had no
        // attempt to point at. Recording it here gives the pass its attempt.
        const unit = ledger.phases[phase].units[unit_id]
        if (!unit.w) {
          throw new Error(
            "DIRECT FIX BLOCKED: a Direct Fix is a literal substitution on a unit that already had a worker delegation; " +
            `unit '${unit_id}' has none — delegate first.`
          )
        }
        if (unit.v === "pass") applyEscape(ledger.phases[phase], unit_id, unit, "post_gate_attempt", new Date().toISOString())
        const { attempt, cap_grant_id } = allocateAttempt(unit, unit_id, "direct fix", data.user_override)
        unit.direct_fixes ??= []
        unit.direct_fixes.push({
          attempt,
          what: data.direct_fix,
          ts: new Date().toISOString(),
          ...(cap_grant_id !== undefined ? { cap_grant_id } : {}),
        })
        if (unit.direct_fixes.length > 20) unit.direct_fixes = unit.direct_fixes.slice(-20)
      }
      ledger.phases[phase].units[unit_id].s = data.s
      if (data.correction) {
        return `RANK CORRECTION: ${data.correction.kind} follow-up recorded as a new worker attempt; compact brief accepted. ` +
          (modelRank.permissions.focused_validation ? "Focused intermediate validation is available; mandated checks and checkpoint validation still apply." :
            "Normal validation and review requirements still apply.") +
          " Take a fresh guard snapshot with the previous frozen authorized scope before resuming the worker."
      }
      break
    }
    case "set_verdict": {
      const { phase, unit_id, data } = operation
      ensureUnit(ledger, phase, unit_id)
      if (data.worker_id) {
        const unit = ledger.phases[phase].units[unit_id]
        const current = unit.delegations?.at(-1)
        if (!current || current.attempt !== unit.attempt_seq || !modelRank.session_id || current.session_id !== modelRank.session_id) {
          throw new Error("WORKER ID: bind the returned worker only to its current delegation in the current declared session.")
        }
        if (current.worker_id && current.worker_id !== data.worker_id) throw new Error("WORKER ID: an existing worker identity cannot be rebound.")
        current.worker_id = data.worker_id
      }
      // Pass verdict requires prior delegation — cannot skip the worker pattern
      if (data.v === "pass") {
        const unit = ledger.phases[phase].units[unit_id]
        const correction = unit.delegations?.find((d) => d.attempt === unit.attempt_seq && d.correction)
        if (correction && (data.via !== "worker" || correction.guard?.result !== "ok" || correction.guard.override)) {
          throw new Error("RANK CORRECTION: pass requires via:'worker' and the current attempt's cleared ownership comparison.")
        }
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
        // Field feedback 2026-09 round 4: the cap guarded the delegation record only, so a
        // capped unit could be fixed off the record and passed, and a rejected unit could be
        // passed with no fix attempt at all. The cap is checked first: past it, a fresh
        // attempt needs an override anyway, so that is the message to send the model to.
        ensureAttemptState(unit)
        const failed = unit.epoch_failed ?? 0
        const waived: Array<"cap" | "attempt" | "escape"> = []
        if (failed >= ATTEMPT_CAP && unit.cap_override_attempt !== unit.attempt_seq) {
          if (data.user_override !== true) {
            throw new Error(
              `DELEGATION CAP: unit '${unit_id}' has ${failed} failed attempts since its last pass (cap ${ATTEMPT_CAP}) ` +
              `and its current attempt #${unit.attempt_seq} was not recorded with user_override. ` +
              "A pass needs data.user_override: true (recorded as cap_override) — escalate to the user with the rejection history."
            )
          }
          waived.push("cap")
        }
        if (unit.needs_attempt) {
          if (data.user_override !== true) {
            throw new Error(
              `ATTEMPT REQUIRED: unit '${unit_id}' was rejected or failed after its latest recorded attempt #${unit.attempt_seq}. ` +
              "Record the fix attempt first — set_unit_status s:'delegated' (fresh worker) or s:'ip' with data.direct_fix " +
              "(literal substitution) — then set_verdict. data.user_override: true waives it and is recorded as cap_override."
            )
          }
          waived.push("attempt")
        }
        if (waived.length > 0) {
          unit.cap_override = { ts: new Date().toISOString(), attempt: unit.attempt_seq ?? 0, failed, waived }
        }
        // v0.6.10: the shared-tree ownership check. Sequenced LAST so every earlier block
        // message is unchanged. Enforcement is scoped to delegations that actually carry a
        // guard: a repo without git, a host that never called repo_guard, and every ledger
        // written before this version keep their existing behavior. Once a snapshot exists,
        // the pass needs its comparison to have cleared — Foreman wrote both, so this is a
        // fact about the tree rather than an attestation about it.
        //
        // v0.6.11: a RECORDED VIOLATION outlives its attempt. Matching only the current
        // attempt let a violation be abandoned by allocating another one — a direct fix
        // bumps attempt_seq without adding a delegation, and the block fell away with it.
        // An unfinished guard still only gates its own attempt; a violation gates until a
        // later comparison clears it.
        const guarded = unit.delegations?.filter((d) => d.guard !== undefined) ?? []
        const latestGuarded = guarded.length > 0 ? guarded[guarded.length - 1] : undefined
        const gatesThisPass =
          latestGuarded?.guard !== undefined &&
          (latestGuarded.attempt === unit.attempt_seq || latestGuarded.guard.result === "violation")
        if (latestGuarded?.guard && gatesThisPass) {
          const g = latestGuarded.guard
          if (g.result !== "ok") {
            if (data.user_override !== true) {
              const detail =
                g.result === "violation"
                  ? `the comparison found ${g.violations?.length ?? 0} violation(s): ${(g.violations ?? []).slice(0, 3).join("; ").slice(0, 400)}`
                  : "no comparison was recorded after the worker returned"
              throw new Error(
                `REPOSITORY GUARD: unit '${unit_id}' attempt #${unit.attempt_seq} has a repository snapshot but ${detail}. ` +
                "Run repo_guard { operation: 'compare', phase, unit_id, allowed_files } after the worker returns and before the verdict. " +
                "A violation is a hard stop: preserve the evidence and escalate to the owner — do not attempt automatic recovery. " +
                "data.user_override: true records the waiver on the delegation as guard_override."
              )
            }
            g.override = { ts: new Date().toISOString() }
          }
        }
        // 0.6.19: a post-gate defect on this unit must be classified before it passes again.
        // The verdict is the write the pit-boss cannot skip after a fix, so the demand is
        // never optional. Sequenced after the repository guard so earlier messages are unchanged.
        const open = unclassifiedEscapes(ledger.phases[phase], unit_id)
        if (open.length > 0) {
          const e = open[open.length - 1]
          if (data.user_override !== true) {
            throw new Error(
              `ESCAPE UNCLASSIFIED: unit '${unit_id}' escaped gate #${e.gate_seq} (${e.basis}) via ${e.sources.join("+")}. ` +
              "Record write_ledger record_escape { class: original_defect | remediation_defect | test_gap | process | new_scope, found_by?, note? } " +
              "before the pass verdict, or set data.user_override: true (recorded as cap_override.waived:'escape')."
            )
          }
          waived.push("escape")
          unit.cap_override = { ts: new Date().toISOString(), attempt: unit.attempt_seq ?? 0, failed, waived }
        }
      }
      const unit = ledger.phases[phase].units[unit_id]
      // 0.6.19: any non-pass verdict on a unit its gate still covers is a contradiction of
      // that gate (fail, pending, inconclusive alike). Recorded before the verdict lands.
      if (data.v !== "pass" && unit.v === "pass") applyEscape(ledger.phases[phase], unit_id, unit, "reopen", new Date().toISOString())
      unit.v = data.v
      // R1: verdict timestamp — consumed by the D2b gate-staleness snapshot (3d).
      unit.v_ts = new Date().toISOString()
      // Completion frontier: the FIRST pass sticks. Re-verdicting an old unit after a
      // checkpoint fix must not move session_orient's last_completed_unit backwards.
      if (data.v === "pass") {
        unit.first_pass_ts ??= unit.v_ts
        // A pass closes the failed-attempt series; a later reopen starts a fresh cap.
        unit.epoch_failed = 0
        unit.needs_attempt = false
        delete unit.last_failed_attempt
        delete unit.cap_override_attempt
        // An open grant never carries into a reopened series: the owner authorized this
        // one. The closed entry keeps the decision and what it was spent on.
        closeGrant(unit, "pass")
      } else if (data.v === "fail") {
        // A fail verdict is a failed attempt too; otherwise delegate→fail→delegate→fail
        // never meets the cap (Codex, round 4).
        recordFailure(unit)
      }
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
      ensureAttemptState(unit)
      unit.rej.push({
        r: data.r,
        msg: data.msg,
        ts: data.ts,
        // D2a: stamp which attempt this rejection belongs to (0 = before any attempt).
        // From attempt_seq, not delegations.length: the array is sliced at 20 and its
        // length stops counting there (Codex, round 4). Legacy entries stay unstamped.
        attempt: unit.attempt_seq ?? 0,
      })
      if (unit.rej.length > 20) unit.rej = unit.rej.slice(-20)
      recordFailure(unit)
      // 0.6.19: a rejection of a unit its gate still covers is an escape of that gate.
      // Recorded before the reopen below, while the legacy coverage fallback can still
      // see the pass verdict. data.escape_class classifies it in the same write.
      const escape = applyEscape(ledger.phases[phase], unit_id, unit, "rejection", new Date().toISOString(), data.escape_class)
      const escapeNote = escape
        ? `; post-gate escape #${escape.gate_seq} recorded (${escape.basis})${escape.class === "unclassified" ? " — classify with record_escape" : ""}`
        : ""
      // Field feedback 2026-09 (Codex R1): a rejection contradicts a standing pass verdict.
      // Leaving v:'pass' in place let a rejected unit stay gate-passable and hid it from
      // session_orient's active_rejections. Reopen to 'pending'; the fix must re-verdict.
      if (unit.v === "pass") {
        unit.v = "pending"
        unit.v_ts = new Date().toISOString()
        return (
          `verdict reopened: unit '${unit_id}' was 'pass'; this rejection reset it to 'pending' — ` +
          "re-run set_verdict after the fix (the phase gate is blocked until then)" + escapeNote
        )
      }
      if (escapeNote) return `rejection recorded${escapeNote}`
      break
    }
    case "declare_phase_units": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      const phaseObj = ledger.phases[phase]
      if (!data.units?.length && !data.retire?.length) {
        throw new Error(
          "DECLARE REQUIRED: declare_phase_units needs data.units (add declared ids) and/or data.retire (remove declared-only ids)."
        )
      }
      // Declaring against a passed gate would leave session_orient reporting
      // status:complete while missing_declared_units contradicts it. Reopening
      // the gate IS the auditable action — no override.
      if (phaseObj.g === "pass") {
        throw new Error(
          `DECLARE BLOCKED: phase '${phase}' gate is 'pass'. Reopen the gate first ` +
          "(update_phase_gate g:'pending') before changing its declared unit set."
        )
      }
      if (data.retire?.length) {
        if (!data.reason) {
          throw new Error(
            "RETIRE REQUIRES REASON: data.reason is mandatory when retiring declared ids — the tombstone is the audit trail."
          )
        }
        const registered = data.retire.filter((id) => phaseObj.units[id]).sort()
        if (registered.length > 0) {
          throw new Error(
            `RETIRE BLOCKED: ids are registered units, not declarations: ${registered.join(", ")}. ` +
            "Registered units are facts — only declared-but-unregistered ids can be retired."
          )
        }
        const declared = phaseObj.declared_units ?? []
        const notDeclared = data.retire.filter((id) => !declared.includes(id)).sort()
        if (notDeclared.length > 0) {
          throw new Error(
            `RETIRE BLOCKED: ids are not in the declared set: ${notDeclared.join(", ")}.`
          )
        }
        const retireSet = new Set(data.retire)
        phaseObj.declared_units = declared.filter((id) => !retireSet.has(id))
        phaseObj.declared_log ??= []
        phaseObj.declared_log.push({
          ts: new Date().toISOString(),
          retired: [...data.retire].sort(),
          reason: data.reason,
        })
        if (phaseObj.declared_log.length > 10) phaseObj.declared_log = phaseObj.declared_log.slice(-10)
        // Retiring the last declared id returns the phase to legacy (undeclared) semantics.
        if (phaseObj.declared_units.length === 0 && !data.units?.length) delete phaseObj.declared_units
      }
      if (data.units?.length) {
        const merged = new Set([...(phaseObj.declared_units ?? []), ...data.units])
        if (merged.size > 200) {
          throw new Error(
            `DECLARE CAP: merged declared set for phase '${phase}' would be ${merged.size} ids (cap 200).`
          )
        }
        phaseObj.declared_units = [...merged].sort()
      }
      break
    }
    case "update_phase_gate": {
      const { phase, data } = operation
      ensurePhase(ledger, phase)
      // Gate pass requires every unit in the phase to carry a pass verdict
      if (data.g === "pass") {
        const units = ledger.phases[phase].units
        const unitIds = Object.keys(units)
        // Declared-unit coverage first: a declared id with no registered unit is a
        // partially-implemented phase, not a passable one. Sequenced before the
        // empty-phase check so the error names the missing ids.
        const declared = ledger.phases[phase].declared_units
        if (declared !== undefined && declared.length > 0) {
          const missing = declared.filter((id) => !units[id]).sort()
          if (missing.length > 0) {
            const shown = missing.slice(0, 10).join(", ")
            const more = missing.length > 10 ? ` (+${missing.length - 10} more)` : ""
            throw new Error(
              `PHASE GATE BLOCKED: phase '${phase}' declares units never registered in the ledger: ` +
              `${shown}${more}. Seed them via set_unit_status and bring them to pass verdicts before the gate can pass.`
            )
          }
        }
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
        // 0.6.19: every waiver the gate accepts is listed on the gate stamp (gate_history).
        const gateOverrides: GateEvidence["overrides"] = []
        const scope = ledger.phases[phase].scope
        if (scope?.hot_path || scope?.security_boundary) {
          if (data.agent_class !== "frontier" && data.user_override === true) gateOverrides.push("seat_minimum")
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
          const before = ledger.phases[phase].discipline_overrides?.length ?? 0
          await disciplineAdherenceGate(phase, ledger.phases[phase], data, sidecarReader)
          if ((ledger.phases[phase].discipline_overrides?.length ?? 0) > before) gateOverrides.push("discipline")
        }
        // Field feedback 2026-09 (Codex R2) + docs deliberation: a gate is a reviewed
        // checkpoint of the CURRENT state. Reviews count only when recorded at or after
        // the newest unit verdict — a review that predates a re-verdict covered old code —
        // and a finding classified 'confirmed' in those reviews blocks the gate until the
        // fix has been re-verdicted and a fresh review shows it resolved. Sequenced LAST so
        // every earlier block message is unchanged; overrides are durable on the phase.
        const gatePhase = ledger.phases[phase]
        const allReviews = gatePhase.reviews ?? []
        const verdictTs = latestVerdictTs(gatePhase)
        const currentReviews = allReviews.filter((r) => r.ts >= verdictTs &&
          (r.unit_attempts === undefined || Object.entries(gatePhase.units).every(([id, u]) =>
            (r.unit_attempts?.[id] ?? 0) === (u.attempt_seq ?? 0))))
        // Round 5 (Codex): currency counted every current record, so a pit-boss cross_exam
        // written after a re-verdict satisfied the gate. A cross_exam never counts as a
        // seat; a verification record counts only under verificationIneligibility; an
        // absent stage is independent (records written before stages existed).
        //
        // v0.6.13: a 'fan' record is the same-model subagent review fan a host runs when no
        // advisor CLI is reachable. Separate contexts and one lens each buy perspective, not
        // independence — one model's blind spots stay correlated — so it never counts as a
        // seat either. It is recorded because the evidence is real and the owner decides the
        // gate with it in hand, not because it replaces a seat.
        const independent = currentReviews.filter((r) => r.stage === undefined || r.stage === "independent")
        // Native review is an explicit Codex path, not an independence claim or
        // an automatic promotion of legacy fan records. Validate saved metadata
        // again here so an incomplete record cannot become a gate credential.
        const native = host === "codex"
          ? currentReviews.filter((r) => r.stage === "native" && reviewIncompleteness(r) === null)
          : []
        const ineligible: string[] = []
        const eligibleVerifications: PhaseReview[] = []
        const verifications = currentReviews.filter((r) => r.stage === "verification")
        const events = sidecarReader ? await sidecarReader() : []
        if (verifications.length > 0) {
          for (const r of verifications) {
            const why = verificationIneligibility(phase, gatePhase, r, allReviews, events)
            if (why === null) eligibleVerifications.push(r)
            else ineligible.push(`${r.advisor}: ${why}`)
          }
        }
        if (independent.length === 0 && native.length === 0 && eligibleVerifications.length === 0) {
          if (data.user_override !== true) {
            const stale = allReviews.length > currentReviews.length
              ? ` ${allReviews.length - currentReviews.length} older review(s) exist but predate the latest unit verdict — a review recorded before a re-verdict does not cover the current code; re-run the review.`
              : ""
            const notSeats = currentReviews.length > 0
              ? ` ${currentReviews.length} current record(s) do not count as a seat: a cross_exam never does, a fan never does (same-model perspective, not independence — present its report and take the owner's decision), and a verification counts only when eligible (a legacy direct-fix re-verdict, or a TopRank worker_delta on a retained complete baseline)${ineligible.length > 0 ? ` (${ineligible.join("; ")})` : ""}.`
              : ""
            throw new Error(
              `REVIEW REQUIRED: phase '${phase}' has no record_review entry recorded at or after its latest unit verdict.${stale}${notSeats} ` +
              (host === "codex" ? "Run a complete native subagent review (stage:'native', distinct reviewer/verifier IDs and checked lists) or an optional external advisor review " : "Run the checkpoint deliberation and persist at least one advisor review ") +
              "(write_ledger record_review) before the gate can pass, or set data.user_override: true " +
              "to pass without independent review — the override is recorded on the phase. " +
              (modelRank.permissions.delta_review
                ? prospectiveWorkerDelta(phase, gatePhase, allReviews, events)
                : prospectiveVerification(phase, gatePhase, allReviews, events, verdictTs))
            )
          }
          gatePhase.review_override = { ts: new Date().toISOString() }
          gateOverrides.push("review")
        } else {
          const confirmed = currentReviews.flatMap((r) =>
            r.findings
              .filter((f) => f.classification === "confirmed")
              .map((f) => `${r.advisor}: ${(f.file || "?").slice(0, 120)}:${f.line || "?"} ${f.description.slice(0, 80)}`)
          )
          if (confirmed.length > 0) {
            if (data.user_override !== true) {
              const shown = confirmed.slice(0, 5).join("; ")
              const more = confirmed.length > 5 ? ` (+${confirmed.length - 5} more)` : ""
              throw new Error(
                `CONFIRMED FINDINGS: phase '${phase}' has ${confirmed.length} confirmed review finding(s) recorded since its latest unit verdict: ${shown}${more}. ` +
                "Reject the affected unit(s) (add_rejection → fix → set_verdict), then record a fresh review that shows the finding resolved before the gate can pass — " +
                "or set data.user_override: true to waive it; the waiver is recorded on the phase as confirmed_override."
              )
            }
            gatePhase.confirmed_override = { ts: new Date().toISOString(), findings: confirmed.length }
            gateOverrides.push("confirmed")
          }
          // Round 3 (Codex): a collapsed parse yields a review with zero findings and no
          // examined list, which used to satisfy the gate. Silence is approval only when
          // the seat says what it examined or the moderator marks it complete.
          // Round 6: an incomplete record superseded by the same advisor's later complete
          // record at the same stage no longer blocks — re-run the seat, never re-verdict
          // to clear it. A confirmed finding on the superseded record still blocked above.
          const incomplete = currentReviews
            .map((r) => {
              const why = reviewIncompleteness(r)
              return why !== null && !isSuperseded(r, currentReviews) ? `${r.advisor}: ${why}` : null
            })
            .filter((s): s is string => s !== null)
          if (incomplete.length > 0) {
            if (data.user_override !== true) {
              throw new Error(
                `INCOMPLETE REVIEW: phase '${phase}' has ${incomplete.length} review(s) recorded since its latest unit verdict that do not cover the phase: ${incomplete.join("; ")}. ` +
                "A seat that reports nothing must list what it examined (record_review data.checked) or be marked completion:'complete'; a partial or failed seat must be re-run — " +
                "or set data.user_override: true to waive it; the waiver is recorded on the phase as incomplete_override."
              )
            }
            gatePhase.incomplete_override = { ts: new Date().toISOString(), reviews: incomplete.length }
            gateOverrides.push("incomplete")
          }
        }
        // 0.6.19: a COUNTED pass is one that changes the gate — first pass, or a re-pass
        // over a different unit set. Re-issuing g:'pass' over the same snapshot stamps
        // nothing, so the totals and the independence streak cannot be inflated by
        // repeating the call. The stamp records what carried the pass (its basis); the
        // seat predicate above is unchanged.
        const now = new Date().toISOString()
        const newHash = computeGateUnitsHash(gatePhase.units, gatePhase.declared_units)
        const counted = gatePhase.g !== "pass" || newHash !== gatePhase.gate_units_hash?.hash
        if (counted) {
          // 0.6.19: the field data must be complete or it is noise — a phase cannot be
          // counted passed while a post-gate defect in it is still unclassified.
          const openEscapes = unclassifiedEscapes(gatePhase)
          if (openEscapes.length > 0) {
            if (data.user_override !== true) {
              const shown = openEscapes.slice(0, 5).map((e) => `${e.unit_id} (gate #${e.gate_seq}, ${e.basis})`).join("; ")
              throw new Error(
                `ESCAPE UNCLASSIFIED: phase '${phase}' has ${openEscapes.length} post-gate escape(s) not yet classified: ${shown}. ` +
                "Record write_ledger record_escape { class } for each before the gate can pass, " +
                "or set data.user_override: true to waive it; the waiver is recorded on the phase as escape_override."
              )
            }
            gatePhase.escape_override = { ts: now, escapes: openEscapes.length }
            gateOverrides.push("escape")
          }
          const evidence = classifyGate({
            host, phaseObj: gatePhase, currentReviews, allReviews, modelRank, ts: now,
            seats: [...independent, ...native, ...eligibleVerifications],
            agentClass: data.agent_class, overrides: gateOverrides,
          })
          recordGatePass(gatePhase, evidence)
        }
        // D2b: snapshot only on a passing gate — never on fail/pending, never cleared.
        // Read paths recompute and flag STALE; nothing is ever blocked on staleness.
        gatePhase.gate_units_hash = { hash: newHash, ts: now }
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
      if (data.stage === "native") {
        if (host !== "codex") throw new Error("NATIVE REVIEW: stage:'native' requires the Codex host.")
        if (data.completion !== "partial" && data.completion !== "failed") {
          const why = reviewIncompleteness({ ...data, ts: "" })
          if (why) throw new Error(`NATIVE REVIEW INCOMPLETE: ${why}. Record partial/failed or finish the native review.`)
        }
      } else if (data.native !== undefined) {
        throw new Error("NATIVE REVIEW EVIDENCE: data.native is accepted with stage:'native' only.")
      }
      // v0.6.5: a verification record stands in for a seat only with its evidence; the
      // evidence shape is meaningless on any other stage.
      if (data.stage === "verification") {
        if (data.completion !== "complete" || data.evidence === undefined) {
          throw new Error(
            "VERIFICATION INCOMPLETE: stage:'verification' needs completion:'complete' and data.evidence " +
            "{ baseline_review_ts, units: [{ unit_id, attempt }], files: [...], tests: { outcome, ... }, probe: { outcome, ... } }. " +
            "It stands in for a seat only for eligible direct-fix re-verdicts or a TopRank worker_delta with a distinct verifier, and only with the evidence recorded."
          )
        }
        if (data.evidence.kind === "worker_delta") {
          if (!modelRank.permissions.delta_review) {
            throw new Error("RANK VERIFICATION: recording a worker_delta requires TopRank; use a complete checkpoint review.")
          }
          const incomplete = reviewIncompleteness({ ...data, ts: "" })
          if (incomplete) throw new Error(`RANK VERIFICATION INCOMPLETE: ${incomplete}.`)
          const why = workerDeltaBlocker(phase, p, data.evidence, new Date().toISOString(), p.reviews ?? [],
            sidecarReader ? await sidecarReader() : [])
          if (why) throw new Error(`RANK VERIFICATION: ${why}.`)
        }
      } else if (data.evidence !== undefined) {
        throw new Error("VERIFICATION EVIDENCE: data.evidence is accepted with stage:'verification' only.")
      }
      const reviewTs = new Date().toISOString()   // per-review timestamp, distinct from the file ts
      // 0.6.19 (slice 4): a seat receipt binds this record to one Foreman-launched advisor
      // run. Every check reads the receipts file Foreman wrote, never the record's text.
      let provenance: PhaseReview["provenance"]
      let warning: string | undefined
      if (data.seat_receipt !== undefined) {
        if (data.stage !== undefined && data.stage !== "independent") {
          throw new Error("SEAT RECEIPT: data.seat_receipt is accepted with stage undefined or 'independent' only.")
        }
        if (!receipts) throw new Error("SEAT RECEIPT: receipts are not available on this write path.")
        const state = await receipts.read()
        const receipt = state.receipts.get(data.seat_receipt)
        if (!receipt) {
          throw new Error(`SEAT RECEIPT: '${data.seat_receipt}' is not in the receipts file beside the ledger; copy seat_receipt from the invoke_advisor meta block.`)
        }
        if (!data.packet_hash) {
          throw new Error("SEAT RECEIPT: data.packet_hash is required with seat_receipt — copy packet_sha256 from the invoke_advisor meta block.")
        }
        if (data.packet_hash !== receipt.prompt_sha256) {
          throw new Error("SEAT RECEIPT: packet mismatch — the record's packet_hash does not equal the receipt's prompt hash; the record names a different prompt than the seat ran.")
        }
        if (receipt.exit_code !== 0 || receipt.failure_reason !== null) {
          throw new Error(`SEAT RECEIPT: '${receipt.id}' is a failed seat (${receipt.failure_reason ?? `exit ${receipt.exit_code}`}); record it completion:'failed' without a receipt.`)
        }
        if (state.consumed.has(receipt.id)) {
          throw new Error(`SEAT RECEIPT: '${receipt.id}' was already bound to a review record; one receipt covers one record.`)
        }
        const attemptTs = Object.values(p.units).flatMap((u) => [
          ...(u.delegations ?? []).map((d) => d.ts), ...(u.direct_fixes ?? []).map((d) => d.ts),
        ])
        const newest = [latestVerdictTs(p), ...attemptTs].reduce((max, t) => (t > max ? t : max), "")
        if (receipt.ts < newest) {
          throw new Error(`SEAT RECEIPT: '${receipt.id}' ran at ${receipt.ts}, before the newest verdict or attempt in phase '${phase}' (${newest}); it reviewed old code. Run the seat again.`)
        }
        provenance = {
          receipt: receipt.id, cli: receipt.cli, provider: receipt.provider, model_served: receipt.model_served,
          ...(receipt.reasoning_effort !== undefined ? { reasoning_effort: receipt.reasoning_effort } : {}),
          bytes_in: receipt.bytes_in, bytes_out: receipt.bytes_out,
          ...(receipt.tokens_used !== undefined ? { tokens_used: receipt.tokens_used } : {}),
        }
        receipts.consumed.push({ id: receipt.id, phase, review_ts: reviewTs })
      } else if (host === "codex" && (data.stage === undefined || data.stage === "independent")) {
        warning =
          "SEAT RECEIPT: this independent record carries no receipt. On Codex an external seat run through invoke_advisor " +
          "returns seat_receipt and packet_sha256 in its meta block; only a receipted seat counts as cross-vendor for the independence bound."
      }
      // Optional field: lazily created (absent on pre-v0.3.1 phases loaded from disk).
      p.reviews ??= []
      p.reviews.push({
        advisor: data.advisor,
        ts: reviewTs,
        findings: data.findings,
        packet_hash: data.packet_hash,
        tokens: data.tokens,
        completion: data.completion,
        checked: data.checked,
        limitations: data.stage === "native"
          ? `Native Codex subagents; same-provider review, not cross-vendor independence.${data.limitations ? ` ${data.limitations}` : ""}`
          : data.limitations,
        stage: data.stage,
        // 0.6.19: presence of basis_version is the legacy switch for the independence bound.
        basis_version: 2,
        host,
        ...(provenance !== undefined ? { provenance } : {}),
        ...(data.native !== undefined ? { native: data.native } : {}),
        ...(data.evidence !== undefined ? { evidence: data.evidence } : {}),
        ...(data.evidence?.kind === "worker_delta" ? { model_rank: modelRank } : {}),
        ...(data.stage === undefined || data.stage === "independent" || data.stage === "native"
          ? { unit_attempts: Object.fromEntries(Object.entries(p.units).map(([id, unit]) => [id, unit.attempt_seq ?? 0])) }
          : {}),
      })
      // Round 6: bounded history that never evicts a record the gate is blocking on.
      p.reviews = trimReviews(p.reviews, latestVerdictTs(p))
      return warning
    }
    case "record_escape": {
      // 0.6.19 (slice 3). Classifies the newest unclassified escape on a registered unit,
      // or records an out-of-band defect (source:'later') on a unit its gate still covers.
      // Never creates a unit, never touches verdicts, attempts, grants or the gate.
      const { phase, unit_id, data } = operation
      const phaseObj = ledger.phases[phase]
      const unit = phaseObj?.units[unit_id]
      if (!phaseObj || !unit) {
        throw new Error(`ESCAPE BLOCKED: unit '${unit_id}' is not registered in phase '${phase}'; an escape is attributed to an existing gated unit.`)
      }
      const now = new Date().toISOString()
      const classified = classifyEscape(phaseObj, unit_id, data.class, now, { found_by: data.found_by, note: data.note })
      if (classified) {
        return `escape #${classified.gate_seq} on '${unit_id}' classified ${data.class} (${classified.basis})`
      }
      if (data.source === "later") {
        if (!coveringGate(phaseObj, unit_id, unit.attempt_seq ?? 0)) {
          throw new Error(
            `ESCAPE BLOCKED: unit '${unit_id}' has an attempt after its last counted gate (or was never gated), so a later defect cannot be attributed to that gate. ` +
            "Reject the unit instead; the rejection records the escape against the gate that covers the current attempt, if any."
          )
        }
        const escape = applyEscape(phaseObj, unit_id, unit, "later", now, data.class, { found_by: data.found_by, note: data.note })
        return `escape #${escape!.gate_seq} on '${unit_id}' recorded ${data.class} (${escape!.basis}, found later)`
      }
      throw new Error(
        `ESCAPE BLOCKED: no unclassified escape on '${unit_id}'; pass data.source:'later' to record an out-of-band defect on a gated unit.`
      )
    }
    case "authorize_attempts": {
      const { phase, unit_id, data } = operation
      const unit = ledger.phases[phase]?.units[unit_id]
      if (!unit) {
        throw new Error(
          `AUTHORIZE BLOCKED: unit '${unit_id}' is not registered in phase '${phase}'; a grant covers an existing unit at the cap.`
        )
      }
      ensureAttemptState(unit)
      if (unit.v === "pass") {
        throw new Error(`AUTHORIZE BLOCKED: unit '${unit_id}' has a pass verdict; there is no failed series to authorize.`)
      }
      const failed = unit.epoch_failed ?? 0
      if (failed < ATTEMPT_CAP) {
        throw new Error(
          `AUTHORIZE BLOCKED: unit '${unit_id}' has ${failed} failed attempt(s) since its last pass (cap ${ATTEMPT_CAP}). ` +
          "Below the cap attempts need no authorization; a grant issued early would defeat the cap."
        )
      }
      const open = activeGrant(unit)
      if (open) {
        throw new Error(
          `AUTHORIZE BLOCKED: unit '${unit_id}' already has grant #${open.id} with ${open.remaining} attempt(s) remaining; exhaust it before issuing another.`
        )
      }
      unit.cap_grants ??= []
      const id = (unit.cap_grants[unit.cap_grants.length - 1]?.id ?? 0) + 1
      unit.cap_grants.push({
        id,
        ts: new Date().toISOString(),
        at_attempt: unit.attempt_seq ?? 0,
        failed_at_issue: failed,
        granted: data.attempts,
        remaining: data.attempts,
        consumed: [],
        reason: data.reason,
      })
      if (unit.cap_grants.length > 20) unit.cap_grants = unit.cap_grants.slice(-20)
      return (
        `grant #${id}: ${data.attempts} attempt(s) authorized on '${unit_id}' past the cap — each further delegation or ` +
        "direct fix is charged to it (no per-write user_override); a pass closes it"
      )
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
  sidecarReader?: SidecarReader,
  host: HostId = "claude-code",
  modelRank: ModelRank = resolveModelRank(),
  /** 0.6.19: receipts file; derived from the ledger path when absent, disabled with null. */
  receiptsPath?: string | null
): Promise<LedgerWriteResult> {
  return withLedgerLock(filePath, async () => {
    const read = await readLedgerWithStatus(filePath)
    const ledger = read.ledger
    const receiptsFile = receiptsPath === undefined ? receiptsPathFor(filePath) : receiptsPath
    const receipts: ReceiptsAccess | undefined = receiptsFile === null
      ? undefined
      : { read: () => readReceipts(receiptsFile), consumed: [] }

    // Default-on enforcement: derive the sidecar reader from the ledger path when the
    // caller does not inject one (tests inject a fake). The sidecar lives alongside the
    // ledger (same dir), matching writeLedger.ts / invokeWorker.ts / readLedger.ts.
    const reader: SidecarReader =
      sidecarReader ??
      (async () => (await readEvents(path.join(path.dirname(filePath), ".foreman-events.jsonl"))).events)

    let warning = await applyOperation(ledger, operation, reader, host, modelRank, receipts)
    // 0.6.19: a bound receipt is spent in the receipts file BEFORE the ledger is written:
    // a torn state loses a receipt, never double-spends one. [CWE-345]
    for (const c of receipts?.consumed ?? []) await appendConsumed(receiptsFile!, c.id, c.phase, c.review_ts)
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

/**
 * Record the repository guard on a unit's newest delegation (v0.6.10).
 *
 * Deliberately NOT a `write_ledger` operation: the guard is a fact Foreman observed, and
 * routing it through the public write path would let the pit-boss author its own
 * clearance. `repo_guard` is the only caller, and it supplies values it computed itself
 * from git. The model chooses when to run the check, never what it found.
 */
export async function recordRepoGuard(
  filePath: string,
  phase: string,
  unitId: string,
  patch: DelegationGuard | { result: "ok" | "violation"; violations?: string[] }
): Promise<{ attempt: number; reopened: boolean }> {
  return withLedgerLock(filePath, async () => {
    const read = await readLedgerWithStatus(filePath)
    const ledger = read.ledger
    const unit = ledger.phases[phase]?.units[unitId]
    if (!unit) {
      throw new Error(
        `GUARD BLOCKED: unit '${unitId}' is not registered in phase '${phase}'. ` +
        "Record the delegation first (set_unit_status s:'delegated'), then take the snapshot."
      )
    }
    const delegations = unit.delegations ?? []
    const latest = delegations.length > 0 ? delegations[delegations.length - 1] : undefined
    if (!latest) {
      throw new Error(
        `GUARD BLOCKED: unit '${unitId}' has no delegation to attach the guard to. ` +
        "The order is set_unit_status s:'delegated' → repo_guard snapshot → spawn the worker → repo_guard compare."
      )
    }
    let reopened = false
    if ("snapshot" in patch) {
      if (latest.guard) {
        throw new Error(
          `GUARD BLOCKED: unit '${unitId}' attempt #${latest.attempt} already has a baseline. ` +
          "A baseline is frozen for the life of an attempt — replacing it would discard the comparison recorded against it. " +
          "Record a new delegation for the next attempt, or compare against this baseline."
        )
      }
      if (latest.correction) {
        const prior = delegations.find((d) => d.attempt === latest.correction?.from_attempt)
        if (!prior?.guard || prior.guard.snapshot.root !== patch.snapshot.root ||
          !samePaths(prior.guard.snapshot.allowed, patch.snapshot.allowed)) {
          throw new Error("RANK CORRECTION: the new guard must preserve the previous repository root and frozen authorized file set.")
        }
      }
      latest.guard = patch
    } else {
      if (!latest.guard) {
        throw new Error(
          `GUARD BLOCKED: unit '${unitId}' attempt #${latest.attempt} has no snapshot to compare against. ` +
          "Take repo_guard { operation: 'snapshot' } before the worker runs; a comparison with no baseline proves nothing."
        )
      }
      latest.guard = { ...latest.guard, ...patch, checked_ts: new Date().toISOString() }
      // A violation found after the unit already passed reopens it, the same way a
      // rejection does (v0.6.0). A standing pass must not outlive its own guard.
      if (patch.result === "violation" && unit.v === "pass") {
        unit.v = "pending"
        unit.needs_attempt = true
        reopened = true
      }
    }
    ledger.ts = new Date().toISOString()
    await atomicWriteFile(filePath, JSON.stringify(ledger), { scrub })
    return { attempt: latest.attempt, reopened }
  })
}
