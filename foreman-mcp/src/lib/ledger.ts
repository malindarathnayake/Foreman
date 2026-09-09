import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import type { CapGrant, DelegationGuard, LedgerFile, Phase, PhaseReview, Unit, WriteLedgerInput } from "../types.js"
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

// ─── Review enforcement helpers (round 6) ────────────────────────────────────
// Shared by the phase gate, review retention, and the verification predicates so all
// three agree on what a blocking record is. Field feedback 2026-09 round 6: a pitboss
// ran six paid review rounds on one phase because every LOW fix re-verdicted a unit,
// which staled the review, which demanded a fresh seat; the replay also showed four
// enforcement holes (failed baseline, hidden worker attempt, eviction of a blocking
// record, an unsupersedable failed seat). Each helper below closes one of them.

/** Newest unit verdict timestamp in the phase; "" when no unit has one. */
function latestVerdictTs(phaseObj: Phase): string {
  return Object.values(phaseObj.units).reduce((max, u) => (u.v_ts && u.v_ts > max ? u.v_ts : max), "")
}

/** Why a review does not cover the phase (partial/failed, unclassified findings, silent), else null. */
export function reviewIncompleteness(r: PhaseReview): string | null {
  if (r.completion === "partial" || r.completion === "failed") return `completion=${r.completion}`
  // Reviews recorded before 0.6.4 could carry unclassified findings; the gate blocks only
  // on 'confirmed', so an unclassified real finding slipped past.
  const unclassified = r.findings.filter((f) => f.classification === undefined).length
  if (unclassified > 0) return `${unclassified} finding(s) without a classification`
  if (r.findings.length === 0 && !(r.checked && r.checked.length > 0) && r.completion !== "complete") {
    return "zero findings with no examined list"
  }
  return null
}

function hasConfirmed(r: PhaseReview): boolean {
  return r.findings.some((f) => f.classification === "confirmed")
}

function effectiveStage(r: PhaseReview): NonNullable<PhaseReview["stage"]> {
  return r.stage ?? "independent"
}

/**
 * An incomplete record is superseded when the SAME advisor at the SAME stage later
 * recorded a complete one — the prescribed "record the failure, re-run the seat"
 * recovery. Before round 6 a failed seat blocked until a re-verdict staled it, and that
 * re-verdict demanded fresh seats. Supersession is narrow: it clears only the
 * incompleteness; a confirmed finding on the superseded record still blocks.
 */
function isSuperseded(r: PhaseReview, pool: PhaseReview[]): boolean {
  return pool.some(
    (s) => s !== r && s.ts > r.ts && s.advisor === r.advisor && effectiveStage(s) === effectiveStage(r) && reviewIncompleteness(s) === null
  )
}

/** Whether a CURRENT record (at/after the latest verdict) blocks the gate. */
function blocksGate(r: PhaseReview, current: PhaseReview[]): boolean {
  return hasConfirmed(r) || (reviewIncompleteness(r) !== null && !isSuperseded(r, current))
}

export const REVIEW_RETENTION = 20

/**
 * Review retention. The cap bounds the on-disk history, but enforcement state must not
 * live only in a bounded presentation list (the rule attempt counters already follow):
 * a record that currently blocks the gate, and the baseline of a current verification
 * record, are never evicted. Oldest evictable records go first; when every record is
 * protected the list keeps them all rather than forgetting a block.
 */
export function trimReviews(reviews: PhaseReview[], verdictTs: string): PhaseReview[] {
  if (reviews.length <= REVIEW_RETENTION) return reviews
  const current = reviews.filter((r) => r.ts >= verdictTs)
  const verifications = current.filter((r) => r.stage === "verification")
  const baselines = new Set(verifications.map((r) => r.evidence?.baseline_review_ts))
  // Protected: a current blocking record, a current verification record (the seat the
  // gate may be resting on), and the baseline such a record names.
  const protectedSet = new Set(
    reviews.filter((r) => baselines.has(r.ts) || verifications.includes(r) || (r.ts >= verdictTs && blocksGate(r, current)))
  )
  const kept: PhaseReview[] = []
  let excess = reviews.length - REVIEW_RETENTION
  for (const r of reviews) {
    if (excess > 0 && !protectedSet.has(r)) {
      excess--
      continue
    }
    kept.push(r)
  }
  return kept
}

// ─── Verification eligibility (round 5, Codex; round 6 predicates) ───────────
// A stage:'verification' record stands in for an independent seat only when it is a
// tightly linked, low-risk extension of one: every predicate below is checkable from
// the ledger and the sidecar, and each one names the exact thing the reporter's
// cross_exam loophole left unchecked. Returns null when eligible, else the reason.

interface VerificationTarget {
  baseline_review_ts: string
  units: Array<{ unit_id: string; attempt: number }>
}

/** The predicates over a (baseline, units) pair; `upperTs` closes the finding window (the record's ts, or now for a prospective check). */
function verificationBlocker(
  phaseKey: string,
  phaseObj: Phase,
  target: VerificationTarget,
  upperTs: string,
  allReviews: PhaseReview[],
  events: SidecarEvent[]
): string | null {
  const baseline = allReviews.find(
    (r) => r.ts === target.baseline_review_ts && (r.stage === undefined || r.stage === "independent")
  )
  if (!baseline) return `baseline_review_ts ${target.baseline_review_ts} is not a retained independent review`
  // Round 6: a failed, partial, or silent seat is not coverage and cannot anchor a verification.
  const incomplete = reviewIncompleteness(baseline)
  if (incomplete) return `baseline review ${baseline.advisor}@${baseline.ts} is not a complete seat (${incomplete})`
  if (phaseObj.scope?.hot_path || phaseObj.scope?.security_boundary) {
    return "phase is scoped hot_path or security_boundary; those need a seat"
  }
  const serious = allReviews
    .filter((r) => r.ts >= baseline.ts && r.ts <= upperTs)
    .flatMap((r) => r.findings.filter((f) => f.classification === "confirmed" && f.severity !== "low"))
  if (serious.length > 0) return `${serious.length} confirmed finding(s) above LOW since the baseline review`
  const changed = Object.entries(phaseObj.units).filter(([, u]) => u.v_ts !== undefined && u.v_ts > baseline.ts)
  if (changed.length === 0) return "no unit was re-verdicted after the baseline review"
  const boundedPhase = boundIdentifier(phaseKey)
  for (const [unitId, u] of changed) {
    if (u.v !== "pass" || u.via !== "pitboss-direct") {
      return `unit '${unitId}' was re-verdicted after the baseline but not as a passing direct fix`
    }
    // Round 6: EVERY attempt since the baseline must be a direct fix. A worker attempt
    // sandwiched between the baseline and the final literal fix received no seat.
    const worker = (u.delegations ?? []).find((d) => d.ts > baseline.ts)
    if (worker) return `unit '${unitId}' had a worker delegation (attempt #${worker.attempt}) after the baseline review`
    const fix = u.direct_fixes?.find((d) => d.attempt === u.attempt_seq)
    if (!fix) return `unit '${unitId}' has no direct_fix record at its current attempt #${u.attempt_seq}`
    if (!target.units.some((x) => x.unit_id === unitId && x.attempt === u.attempt_seq)) {
      return `evidence.units does not name '${unitId}' attempt #${u.attempt_seq}`
    }
    const boundedUnit = boundIdentifier(unitId)
    const unitEvents = events.filter((e) => e.phase === boundedPhase && e.unit_id === boundedUnit)
    if (unitEvents.some((e) => e.attempt === u.attempt_seq)) {
      return `unit '${unitId}' attempt #${u.attempt_seq} is an invoke_worker delegation in the sidecar, not a direct fix`
    }
    const remote = unitEvents.find((e) => typeof e.ts === "string" && e.ts > baseline.ts)
    if (remote) return `unit '${unitId}' has an invoke_worker delegation (attempt #${remote.attempt}) after the baseline review`
  }
  return null
}

export function verificationIneligibility(
  phaseKey: string,
  phaseObj: Phase,
  review: PhaseReview,
  allReviews: PhaseReview[],
  events: SidecarEvent[]
): string | null {
  const ev = review.evidence
  if (!ev) return "no evidence recorded"
  return verificationBlocker(phaseKey, phaseObj, ev, review.ts, allReviews, events)
}

/**
 * Round 6: when the gate answers REVIEW REQUIRED it states whether a stage:'verification'
 * record would satisfy it right now — the exact record shape when it would, the single
 * blocker when it would not — so a pitboss neither pays for a seat the ledger would have
 * accepted a verification for, nor writes a record the ledger is about to refuse.
 */
function prospectiveVerification(
  phaseKey: string,
  phaseObj: Phase,
  allReviews: PhaseReview[],
  events: SidecarEvent[],
  verdictTs: string
): string {
  const notEligible = (why: string) => `VERIFICATION NOT ELIGIBLE (a fresh seat is needed): ${why}.`
  const candidates = allReviews
    .filter((r) => (r.stage === undefined || r.stage === "independent") && r.ts < verdictTs && reviewIncompleteness(r) === null)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  if (candidates.length === 0) return notEligible("no complete independent review predates the latest unit verdict")
  const baseline = candidates[0]
  const units = Object.entries(phaseObj.units)
    .filter(([, u]) => u.v_ts !== undefined && u.v_ts > baseline.ts)
    .map(([unit_id, u]) => ({ unit_id, attempt: u.attempt_seq ?? 0 }))
  if (units.length > 50) return notEligible(`${units.length} units were re-verdicted since the baseline; verification evidence names at most 50`)
  const now = new Date().toISOString()
  const why = verificationBlocker(phaseKey, phaseObj, { baseline_review_ts: baseline.ts, units }, now, allReviews, events)
  if (why) return notEligible(why)
  // Recording the verification must not evict its own baseline from the retained history.
  const synthetic = {
    advisor: "pitboss",
    ts: now,
    findings: [],
    stage: "verification",
    completion: "complete",
    evidence: { baseline_review_ts: baseline.ts, units },
  } as unknown as PhaseReview
  if (!trimReviews([...allReviews, synthetic], verdictTs).includes(baseline)) {
    return notEligible("recording the verification would evict its baseline review from the retained history")
  }
  const unitList = units.map((u) => `{ unit_id: "${u.unit_id}", attempt: ${u.attempt} }`).join(", ")
  return (
    "VERIFICATION ELIGIBLE: a stage:'verification' record can stand in for a seat — " +
    `write_ledger record_review { phase: "${phaseKey}", data: { advisor: "pitboss", stage: "verification", completion: "complete", findings: [], ` +
    `checked: [<files re-read>], evidence: { baseline_review_ts: "${baseline.ts}", units: [${unitList}], files: [<files re-verified>], ` +
    "tests: { outcome, command, result }, probe: { outcome, method, result } } } } — supply real test and probe evidence; the gate re-checks every predicate on the record."
  )
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
        })
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
        // Field feedback 2026-09 round 4: the cap guarded the delegation record only, so a
        // capped unit could be fixed off the record and passed, and a rejected unit could be
        // passed with no fix attempt at all. The cap is checked first: past it, a fresh
        // attempt needs an override anyway, so that is the message to send the model to.
        ensureAttemptState(unit)
        const failed = unit.epoch_failed ?? 0
        const waived: Array<"cap" | "attempt"> = []
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
      }
      const unit = ledger.phases[phase].units[unit_id]
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
      // Field feedback 2026-09 (Codex R1): a rejection contradicts a standing pass verdict.
      // Leaving v:'pass' in place let a rejected unit stay gate-passable and hid it from
      // session_orient's active_rejections. Reopen to 'pending'; the fix must re-verdict.
      if (unit.v === "pass") {
        unit.v = "pending"
        unit.v_ts = new Date().toISOString()
        return (
          `verdict reopened: unit '${unit_id}' was 'pass'; this rejection reset it to 'pending' — ` +
          "re-run set_verdict after the fix (the phase gate is blocked until then)"
        )
      }
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
        // Field feedback 2026-09 (Codex R2) + docs deliberation: a gate is a reviewed
        // checkpoint of the CURRENT state. Reviews count only when recorded at or after
        // the newest unit verdict — a review that predates a re-verdict covered old code —
        // and a finding classified 'confirmed' in those reviews blocks the gate until the
        // fix has been re-verdicted and a fresh review shows it resolved. Sequenced LAST so
        // every earlier block message is unchanged; overrides are durable on the phase.
        const gatePhase = ledger.phases[phase]
        const allReviews = gatePhase.reviews ?? []
        const verdictTs = latestVerdictTs(gatePhase)
        const currentReviews = allReviews.filter((r) => r.ts >= verdictTs)
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
        const ineligible: string[] = []
        let eligibleVerification = false
        const verifications = currentReviews.filter((r) => r.stage === "verification")
        const events = sidecarReader ? await sidecarReader() : []
        if (verifications.length > 0) {
          for (const r of verifications) {
            const why = verificationIneligibility(phase, gatePhase, r, allReviews, events)
            if (why === null) eligibleVerification = true
            else ineligible.push(`${r.advisor}: ${why}`)
          }
        }
        if (independent.length === 0 && !eligibleVerification) {
          if (data.user_override !== true) {
            const stale = allReviews.length > currentReviews.length
              ? ` ${allReviews.length - currentReviews.length} older review(s) exist but predate the latest unit verdict — a review recorded before a re-verdict does not cover the current code; re-run the review.`
              : ""
            const notSeats = currentReviews.length > 0
              ? ` ${currentReviews.length} current record(s) do not count as a seat: a cross_exam never does, a fan never does (same-model perspective, not independence — present its report and take the owner's decision), and a verification counts only for direct-fix re-verdicts${ineligible.length > 0 ? ` (${ineligible.join("; ")})` : ""}.`
              : ""
            throw new Error(
              `REVIEW REQUIRED: phase '${phase}' has no record_review entry recorded at or after its latest unit verdict.${stale}${notSeats} ` +
              "Run the checkpoint deliberation and persist at least one advisor review " +
              "(write_ledger record_review) before the gate can pass, or set data.user_override: true " +
              "to pass without independent review — the override is recorded on the phase. " +
              prospectiveVerification(phase, gatePhase, allReviews, events, verdictTs)
            )
          }
          gatePhase.review_override = { ts: new Date().toISOString() }
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
          }
        }
      }
      // D2b: snapshot only on a passing gate — never on fail/pending, never cleared.
      // Read paths recompute and flag STALE; nothing is ever blocked on staleness.
      if (data.g === "pass") {
        ledger.phases[phase].gate_units_hash = {
          hash: computeGateUnitsHash(ledger.phases[phase].units, ledger.phases[phase].declared_units),
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
      // v0.6.5: a verification record stands in for a seat only with its evidence; the
      // evidence shape is meaningless on any other stage.
      if (data.stage === "verification") {
        if (data.completion !== "complete" || data.evidence === undefined) {
          throw new Error(
            "VERIFICATION INCOMPLETE: stage:'verification' needs completion:'complete' and data.evidence " +
            "{ baseline_review_ts, units: [{ unit_id, attempt }], files: [...], tests: { outcome, ... }, probe: { outcome, ... } }. " +
            "It stands in for a seat only for direct-fix re-verdicts, and only with the evidence recorded."
          )
        }
      } else if (data.evidence !== undefined) {
        throw new Error("VERIFICATION EVIDENCE: data.evidence is accepted with stage:'verification' only.")
      }
      // Optional field: lazily created (absent on pre-v0.3.1 phases loaded from disk).
      p.reviews ??= []
      p.reviews.push({
        advisor: data.advisor,
        ts: new Date().toISOString(),   // per-review timestamp, distinct from the file ts
        findings: data.findings,
        packet_hash: data.packet_hash,
        tokens: data.tokens,
        completion: data.completion,
        checked: data.checked,
        limitations: data.limitations,
        stage: data.stage,
        ...(data.evidence !== undefined ? { evidence: data.evidence } : {}),
      })
      // Round 6: bounded history that never evicts a record the gate is blocking on.
      p.reviews = trimReviews(p.reviews, latestVerdictTs(p))
      break
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
