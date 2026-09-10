/**
 * Review predicates shared by the phase gate, review retention and the verification
 * paths (round 6, 0.6.5, 0.6.16, 0.6.18). Moved out of ledger.ts unchanged in 0.6.19
 * slice 1 so the gate, the escapes and the seat receipts can build on one module
 * instead of growing applyOperation. Pure functions over ledger data: no I/O, no
 * imports from ledger.ts.
 */
import type { Phase, PhaseReview, VerificationEvidence } from "../types.js"
import { NativeReviewEvidenceSchema } from "../types.js"
import { boundIdentifier, type SidecarEvent } from "./eventsSidecar.js"

// ─── Review enforcement helpers (round 6) ────────────────────────────────────
// Shared by the phase gate, review retention, and the verification predicates so all
// three agree on what a blocking record is. Field feedback 2026-09 round 6: a pitboss
// ran six paid review rounds on one phase because every LOW fix re-verdicted a unit,
// which staled the review, which demanded a fresh seat; the replay also showed four
// enforcement holes (failed baseline, hidden worker attempt, eviction of a blocking
// record, an unsupersedable failed seat). Each helper below closes one of them.

/** Newest unit verdict timestamp in the phase; "" when no unit has one. */
export function latestVerdictTs(phaseObj: Phase): string {
  return Object.values(phaseObj.units).reduce((max, u) => (u.v_ts && u.v_ts > max ? u.v_ts : max), "")
}

/** Why a review does not cover the phase (partial/failed, unclassified findings, silent), else null. */
export function reviewIncompleteness(r: PhaseReview): string | null {
  if (r.completion === "partial" || r.completion === "failed") return `completion=${r.completion}`
  if (r.stage === "verification" && r.evidence?.kind === "worker_delta") {
    if (r.completion !== "complete") return "worker_delta requires completion=complete"
    if (!r.checked?.length || r.checked.some((entry) => !entry.trim())) return "worker_delta verifier requires a non-empty checked list"
    if (r.findings.some((finding) => finding.classification === "unverified")) return "worker_delta has unresolved unverified findings"
    const { tests, probe } = r.evidence
    if (tests.outcome === "pass" && (!tests.command.trim() || !tests.result.trim())) return "worker_delta tests require a non-empty command and result"
    if (probe.outcome === "pass" && (!probe.method.trim() || !probe.result.trim())) return "worker_delta probe requires a non-empty method and result"
  }
  if (r.stage === "native") {
    if (r.completion !== "complete") return "native review requires completion=complete"
    const evidence = NativeReviewEvidenceSchema.safeParse(r.native)
    if (!evidence.success) return "native review requires reviewer and verifier provenance"
    const { reviewers, verifier_id } = evidence.data
    const ids = new Set(reviewers.map((seat) => seat.agent_id))
    if (ids.size !== reviewers.length || ids.has(verifier_id)) return "native reviewers and verifier must have distinct agent IDs"
    if (new Set(reviewers.map((seat) => seat.lens)).size !== reviewers.length) return "native reviewers must cover distinct lenses"
    if (reviewers.some((seat) => seat.completion !== "complete" || seat.checked.length === 0)) return "native reviewer coverage is incomplete"
    if (!r.checked?.length || r.checked.some((entry) => !entry.trim())) return "native verifier requires a non-empty checked list"
    if (r.findings.some((finding) => finding.classification === "unverified")) return "native review has unresolved unverified findings"
  }
  // Reviews recorded before 0.6.4 could carry unclassified findings; the gate blocks only
  // on 'confirmed', so an unclassified real finding slipped past.
  const unclassified = r.findings.filter((f) => f.classification === undefined).length
  if (unclassified > 0) return `${unclassified} finding(s) without a classification`
  if (r.findings.length === 0 && !(r.checked && r.checked.length > 0) && r.completion !== "complete") {
    return "zero findings with no examined list"
  }
  return null
}

export function hasConfirmed(r: PhaseReview): boolean {
  return r.findings.some((f) => f.classification === "confirmed")
}

export function effectiveStage(r: PhaseReview): NonNullable<PhaseReview["stage"]> {
  return r.stage ?? "independent"
}

/**
 * An incomplete record is superseded when the SAME advisor at the SAME stage later
 * recorded a complete one — the prescribed "record the failure, re-run the seat"
 * recovery. Before round 6 a failed seat blocked until a re-verdict staled it, and that
 * re-verdict demanded fresh seats. Supersession is narrow: it clears only the
 * incompleteness; a confirmed finding on the superseded record still blocks.
 */
export function isSuperseded(r: PhaseReview, pool: PhaseReview[]): boolean {
  return pool.some(
    (s) => s !== r && s.ts > r.ts && s.advisor === r.advisor && effectiveStage(s) === effectiveStage(r) && reviewIncompleteness(s) === null
  )
}

/** Whether a CURRENT record (at/after the latest verdict) blocks the gate. */
export function blocksGate(r: PhaseReview, current: PhaseReview[]): boolean {
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

export interface VerificationTarget {
  baseline_review_ts: string
  units: Array<{ unit_id: string; attempt: number }>
}

export function normalizedPaths(files: string[]): string[] {
  return [...new Set(files.map((file) => file.replace(/\\/g, "/")))].sort()
}

export function samePaths(left: string[], right: string[]): boolean {
  return JSON.stringify(normalizedPaths(left)) === JSON.stringify(normalizedPaths(right))
}

/** Verification records a baseline may carry (0.6.19 slice 6). Enforced at record time on a server scalar, never by counting reviews[]. */
export const MAX_DELTA_PER_BASELINE = 2

/** The record-level fields the 0.6.19 structural bounds read; absent on the prospective hint. */
export type DeltaReviewShape = Pick<PhaseReview, "checked" | "basis_version">

/** Worker delta reviews extend complete coverage, never an unaccounted interval of attempts. */
export function workerDeltaBlocker(
  phaseKey: string,
  phaseObj: Phase,
  evidence: VerificationEvidence,
  upperTs: string,
  allReviews: PhaseReview[],
  events: SidecarEvent[],
  /** 0.6.19: records with basis_version 2 carry structural bounds legacy deltas do not. */
  review?: DeltaReviewShape
): string | null {
  const baseline = allReviews.find((r) => r.ts === evidence.baseline_review_ts &&
    (r.stage === undefined || r.stage === "independent" || r.stage === "native"))
  if (!baseline) return "baseline_review_ts is not a retained independent or native review"
  const incomplete = reviewIncompleteness(baseline)
  if (incomplete) return `baseline review is not a complete seat (${incomplete})`
  if (phaseObj.scope?.hot_path || phaseObj.scope?.security_boundary) {
    return "phase is scoped hot_path or security_boundary; those need a seat"
  }
  if (!evidence.verifier_id?.trim()) return "worker_delta requires a distinct verifier_id"
  if (allReviews.some((r) => r.ts >= baseline.ts && r.ts <= upperTs &&
    r.findings.some((f) => f.classification === "confirmed" && f.severity !== "low"))) {
    return "confirmed finding(s) above LOW since the baseline review"
  }
  const changed: Array<{ unit_id: string; attempt: number }> = []
  const coveredFiles = new Set<string>()
  for (const [unitId, unit] of Object.entries(phaseObj.units)) {
    const delegations = unit.delegations ?? []
    // New baselines preserve exact attempt positions, independent of timestamp collisions
    // and bounded history. Legacy baselines need a retained prior attempt to prove coverage.
    const prior = [
      ...delegations.filter((d) => d.ts < baseline.ts),
      ...(unit.direct_fixes ?? []).filter((d) => d.ts < baseline.ts),
    ]
    const baselineAttempt = baseline.unit_attempts !== undefined
      ? baseline.unit_attempts[unitId] ?? 0
      : prior.reduce((max, d) => Math.max(max, d.attempt), 0)
    const currentAttempt = unit.attempt_seq ?? 0
    const remote = events.some((e) => e.phase === boundIdentifier(phaseKey) && e.unit_id === boundIdentifier(unitId) &&
      (e.attempt > baselineAttempt || e.ts > baseline.ts))
    if (remote) return `unit '${unitId}' had an invoke_worker attempt after the baseline review`
    const reverdicted = unit.v_ts !== undefined && unit.v_ts > baseline.ts
    if (currentAttempt <= baselineAttempt && !reverdicted) continue
    if (baseline.unit_attempts === undefined && prior.length === 0) {
      return `unit '${unitId}' has no retained attempt proving the baseline boundary`
    }
    if (currentAttempt <= baselineAttempt) return `unit '${unitId}' was re-verdicted without a recorded correction`
    if (unit.v !== "pass" || unit.via !== "worker" || unit.needs_attempt) {
      return `unit '${unitId}' is not a passing worker correction`
    }
    changed.push({ unit_id: unitId, attempt: currentAttempt })
    for (let attempt = baselineAttempt + 1; attempt <= currentAttempt; attempt++) {
      const delegation = delegations.find((d) => d.attempt === attempt)
      const permission = delegation?.correction?.kind === "mechanical" ? "reuse_worker_mechanical" : "reuse_worker_bounded"
      if (!delegation?.correction || !delegation.model_rank?.permissions[permission]) {
        return `unit '${unitId}' attempt #${attempt} is not a retained rank-eligible worker correction`
      }
      if (delegation.correction.from_attempt !== attempt - 1 || !delegation.worker_id || !delegation.session_id) {
        return `unit '${unitId}' attempt #${attempt} lacks its bounded worker provenance`
      }
      if (delegation.worker_id === evidence.verifier_id.trim()) {
        return `verifier_id matches implementation worker '${delegation.worker_id}'`
      }
      if (delegation.guard?.result !== "ok" || delegation.guard.override) {
        return `unit '${unitId}' attempt #${attempt} does not have a cleared ownership guard`
      }
      // The frozen authorization set bounds every actual file the guard permitted,
      // including paths omitted from the model's descriptive correction.files list.
      for (const file of normalizedPaths(delegation.guard.snapshot.allowed)) coveredFiles.add(file)
    }
    if ((unit.direct_fixes ?? []).some((d) => d.attempt > baselineAttempt)) {
      return `unit '${unitId}' had a direct fix after the baseline review`
    }
  }
  if (changed.length === 0) return "no worker correction followed the baseline review"
  const signature = (units: Array<{ unit_id: string; attempt: number }>) =>
    units.map((u) => JSON.stringify([u.unit_id, u.attempt])).sort()
  if (JSON.stringify(signature(changed)) !== JSON.stringify(signature(evidence.units))) {
    return "evidence.units must name exactly the current changed units and attempts"
  }
  if (!samePaths([...coveredFiles], evidence.files)) {
    return "evidence.files must cover exactly the frozen authorized files across worker corrections"
  }
  // 0.6.19 (slice 6): structural bounds on the verifier and its coverage. Declared ids are
  // strings compared for distinctness, not identities Foreman verifies; the bound is that the
  // verifier is a fresh string against every id already in play. [CWE-290]
  if (review?.basis_version === 2) {
    const verifier = evidence.verifier_id.trim()
    const inPlay = new Set<string>([
      ...(baseline.native ? [...baseline.native.reviewers.map((s) => s.agent_id), baseline.native.verifier_id] : []),
      ...Object.values(phaseObj.units).flatMap((u) => (u.delegations ?? []).map((d) => d.worker_id).filter((id): id is string => !!id)),
    ])
    if (inPlay.has(verifier)) return `verifier_id '${verifier}' is a baseline native agent or a worker in this phase; the verifier must be fresh`
    const checked = new Set(normalizedPaths(review.checked ?? []))
    const missing = normalizedPaths(evidence.files).filter((file) => !checked.has(file))
    if (missing.length > 0) return `checked must list every file in evidence.files (missing: ${missing.slice(0, 5).join(", ")})`
  }
  return null
}

/** The predicates over a (baseline, units) pair; `upperTs` closes the finding window (the record's ts, or now for a prospective check). */
export function verificationBlocker(
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
  if (ev.kind === "worker_delta") {
    const incomplete = reviewIncompleteness(review)
    if (incomplete) return incomplete
    if (!review.model_rank?.permissions.delta_review) return "worker_delta has no recorded TopRank authorization"
    return workerDeltaBlocker(phaseKey, phaseObj, ev, review.ts, allReviews, events, review)
  }
  return verificationBlocker(phaseKey, phaseObj, ev, review.ts, allReviews, events)
}

/**
 * Round 6: when the gate answers REVIEW REQUIRED it states whether a stage:'verification'
 * record would satisfy it right now — the exact record shape when it would, the single
 * blocker when it would not — so a pitboss neither pays for a seat the ledger would have
 * accepted a verification for, nor writes a record the ledger is about to refuse.
 */
export function prospectiveVerification(
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

/** Same predicates as recording/gating, surfaced before paying for another full seat. */
export function prospectiveWorkerDelta(phaseKey: string, phase: Phase, reviews: PhaseReview[], events: SidecarEvent[]): string {
  const baselines = reviews.filter((r) =>
    (r.stage === undefined || r.stage === "independent" || r.stage === "native") && reviewIncompleteness(r) === null
  ).sort((a, b) => b.ts.localeCompare(a.ts))
  const baseline = baselines[0]
  if (!baseline) return "WORKER DELTA NOT ELIGIBLE: no complete independent or native baseline; run a full checkpoint review."
  const units: Array<{ unit_id: string; attempt: number }> = []
  const files: string[] = []
  for (const [unit_id, unit] of Object.entries(phase.units)) {
    const before = baseline.unit_attempts?.[unit_id] ?? Math.max(0,
      ...(unit.delegations ?? []).filter((d) => d.ts < baseline.ts).map((d) => d.attempt),
      ...(unit.direct_fixes ?? []).filter((d) => d.ts < baseline.ts).map((d) => d.attempt))
    if ((unit.attempt_seq ?? 0) > before || (unit.v_ts !== undefined && unit.v_ts > baseline.ts)) {
      units.push({ unit_id, attempt: unit.attempt_seq ?? 0 })
      files.push(...(unit.delegations ?? []).filter((d) => d.attempt > before).flatMap((d) => d.guard?.snapshot.allowed ?? []))
    }
  }
  const usedIds = new Set(Object.values(phase.units).flatMap((u) => (u.delegations ?? []).map((d) => d.worker_id)))
  let placeholder = "<distinct verifier ID>"
  while (usedIds.has(placeholder)) placeholder += "_"
  const evidence: VerificationEvidence = {
    kind: "worker_delta", verifier_id: placeholder, baseline_review_ts: baseline.ts,
    units, files: normalizedPaths(files),
    tests: { outcome: "pass", command: "<actual command>", result: "<actual result>" },
    probe: { outcome: "pass", method: "<actual independent check>", result: "<actual result>" },
  }
  if (units.length > 50 || evidence.files.length > 50) return "WORKER DELTA NOT ELIGIBLE: evidence exceeds the bounded record size; run a full checkpoint review."
  const why = workerDeltaBlocker(phaseKey, phase, evidence, new Date().toISOString(), reviews, events)
  if (why) return `WORKER DELTA NOT ELIGIBLE: ${why}; run a full checkpoint review.`
  return `WORKER DELTA ELIGIBLE: retain the baseline and record stage:'verification', completion:'complete', checked:[<files independently read>], findings:[<classified findings>], evidence:${JSON.stringify(evidence)}. Supply actual independent verification and required validation evidence.`
}

