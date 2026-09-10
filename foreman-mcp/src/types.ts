import { z } from "zod"
import type { ModelRank } from "./lib/modelRank.js"
import type { HostId } from "./lib/hostProfiles.js"
import { softText, softCut, type SoftLimit } from "./lib/softLimits.js"

// ─── Ledger Types ─────────────────────────────────────────────────────────────

export interface Rejection {
  r: string
  msg: string
  ts: string
  /** Delegation attempt this rejection belongs to (stamped by add_rejection since v0.5.0). 0 = pre-delegation. Absent on legacy entries. */
  attempt?: number
}

export type Tier = "cheap" | "standard" | "premium"

/**
 * Step 4.5 Brief Preflight attestation, recorded on the delegated write. Required for
 * s:'delegated' since v0.6.1 (field feedback 2026-09 round 2) — makes the preflight as
 * mechanical as the brief rule. `self_consistent` must be literally true: a brief that
 * contradicts itself is not delegated, it is rewritten.
 */
export interface DelegationPreflight {
  /** Brief symbols grepped across spec.md (Step 4.5 steps 1–4): the array since 0.6.20 (checked by preflight_check), a count on older records. */
  symbols_grepped: number | string[]
  /** Every test expectation in the brief agrees with its implementation instruction (step 6). */
  self_consistent: true
  /** 0.6.20: the brief_hash preflight_check returned; required once the project has run the tool. */
  receipt?: string
  /** Custom telemetry names checked against the stack profile (step 7), or n/a when the unit emits no signals. */
  telemetry?: "checked" | "n/a"
}

/**
 * One changed path in a repository snapshot (v0.6.11). Content fingerprints are what make
 * an overwrite of an already-dirty file visible; comparing path sets alone did not.
 */
export interface RepoEntry {
  path: string
  /** Two-column porcelain status, or "R<"/"C<" for a rename/copy origin record. */
  code: string
  /** Work-tree content: short sha256, "absent", "dir", or "big:<bytes>". */
  wt: string
  /** Index blob id for the path, or "none". */
  idx: string
  /**
   * Set when the path is a Foreman-fenced file (Docs/PROGRESS.md) read by a fence-aware
   * snapshot (v0.6.20). `wt` stays the full-content fingerprint; `fwt` is the fingerprint
   * with Foreman's fenced block removed, present only when the file was hashed. Absent on
   * legacy entries.
   */
  fenced?: true
  fwt?: string
}

/**
 * Repository state that defines shared-tree ownership, captured by Foreman rather than
 * described to the model (v0.6.10; content fingerprints and frozen authorization in
 * v0.6.11). Entry lists are capped in lib/repoGuard.ts.
 */
export interface RepoSnapshot {
  /** 0.6.20: content marks of Foreman state files (progress state) so a fenced-block change can be tied to a Foreman write. */
  marks?: Record<string, string>
  /** Repository root, so a comparison cannot be run against a different checkout. */
  root: string
  /** Branch name, or "detached". */
  branch: string
  /** Commit sha, or "none" in a repository with no commits yet. */
  head: string
  /** refs/stash sha, or "none". */
  stash_ref: string
  stash_count: number
  /** core.autocrlf, or "unset". */
  autocrlf: string
  /** `git ls-files --eol` rows for the unit's files. */
  eol: string[]
  entries: RepoEntry[]
  /** True when more changed paths existed than the limit retains; blocks a clearance. */
  truncated: boolean
  /** The entry limit this snapshot was taken under (v0.6.12). */
  entry_limit?: number
  /** The authorized file set, frozen before the worker ran. */
  allowed: string[]
  /**
   * Repo-relative paths of the Foreman-fenced files this snapshot was taken with (v0.6.20).
   * Present (possibly empty) on every fence-aware snapshot; absent on a legacy baseline.
   */
  fenced?: string[]
  /** Short sha256 over the fields above. */
  hash: string
}

/**
 * The guard recorded on a delegation. `snapshot` is taken before the worker runs;
 * `result` is written by Foreman after it returns. A pass verdict is refused while a
 * snapshot exists whose result is not `ok` (see REPOSITORY GUARD in lib/ledger.ts).
 */
export interface DelegationGuard {
  snapshot: RepoSnapshot
  snapshot_ts: string
  result?: "ok" | "violation"
  violations?: string[]
  checked_ts?: string
  /** A pass verdict taken past an uncleared guard by explicit user approval. */
  override?: { ts: string }
}

/** One delegation attempt. Appended per (re-)delegation so retry history survives the `w` overwrite. */
export interface Delegation {
  brief: string
  tier?: Tier
  route_reason?: string
  ts: string
  attempt: number
  /** True when the delegation-cap was overridden by explicit user approval (D2a). */
  user_override?: boolean
  /** Brief Preflight attestation. Absent on delegations recorded before v0.6.1. */
  preflight?: DelegationPreflight
  /** The cap grant this attempt was charged to (v0.6.5). */
  cap_grant_id?: number
  /** Foreman-authored repository-state guard (v0.6.10). Never written by the model. */
  guard?: DelegationGuard
  /** Native worker identity and originating journal session, used only for bounded reuse. */
  worker_id?: string
  /**
   * 0.6.20: set only when the id was bound by a later correction write (the attempt carried
   * no id when the correction arrived). Absent when bound at delegation or at set_verdict.
   * `by_attempt` is the correction attempt that supplied it. Server-authored; never model input.
   */
  worker_id_bound?: { at: "correction"; ts: string; by_attempt: number }
  session_id?: string
  /** Server-resolved orchestration policy when this attempt was recorded. */
  model_rank?: ModelRank
  correction?: { kind: "mechanical" | "bounded"; from_attempt: number; files: string[] }
}

/**
 * Owner authorization for attempts past the cap (v0.6.5, field feedback round 5). One
 * recorded decision instead of a user_override on every later write. The newest entry is
 * the active one; closed entries are the audit trail of how each decision was spent.
 */
export interface CapGrant {
  id: number
  ts: string
  /** attempt_seq when the grant was issued. */
  at_attempt: number
  /** epoch_failed when the grant was issued. */
  failed_at_issue: number
  granted: number
  remaining: number
  /** Attempt ids allocated against this grant. */
  consumed: number[]
  reason: string
  closed?: { ts: string; reason: "exhausted" | "pass" }
}

/** A pit-boss literal substitution recorded as an attempt (implementor Direct Fix rule). Absent before v0.6.4. */
export interface DirectFix {
  attempt: number
  what: string
  ts: string
  /** The cap grant this attempt was charged to (v0.6.5). */
  cap_grant_id?: number
}

export interface Unit {
  s: "pending" | "ip" | "delegated" | "done" | "fail"
  v: "pass" | "fail" | "pending" | "inconclusive"
  /** ISO timestamp of the latest set_verdict (R1). Absent on ledgers written before v0.5.0. */
  v_ts?: string
  /** ISO timestamp of the FIRST pass verdict — set once, never overwritten by re-verdicts. Completion-frontier signal for session_orient. Absent before v0.6.0. */
  first_pass_ts?: string
  via?: "worker" | "pitboss-direct" | "n/a"
  note?: string
  w: string | null
  rej: Rejection[]
  /** Capability tier the delegated worker ran at. Audit evidence, not a mechanical gate. */
  tier?: Tier
  route_reason?: string
  /** Append-only delegation history. Optional: ledgers written before v0.3.1 lack it. */
  delegations?: Delegation[]
  // ── Attempt accounting (v0.6.4). Server-authored scalars: rej[] and delegations[] are
  // capped at 20 with the oldest dropped, so neither can carry the enforcement count.
  // Absent on older ledgers; derived from the stamps on the first write that touches the unit.
  /** Monotonic count of recorded attempts: worker delegations plus direct fixes. */
  attempt_seq?: number
  /** Distinct attempts that failed (rejection or fail verdict) since the unit last passed. Reset to 0 on pass. */
  epoch_failed?: number
  /** Attempt id that last raised epoch_failed, so a second rejection of one attempt does not count twice. */
  last_failed_attempt?: number
  /** True from a rejection or fail verdict until a new attempt is recorded; a pass verdict is refused while set. */
  needs_attempt?: boolean
  /** Attempt id recorded with user_override past the cap; a pass on that attempt needs no second override. */
  cap_override_attempt?: number
  /** Direct fixes recorded as attempts, newest last, capped at 20. */
  direct_fixes?: DirectFix[]
  /** A pass verdict that waived ATTEMPT REQUIRED or the cap through data.user_override. */
  cap_override?: { ts: string; attempt: number; failed: number; waived: Array<"cap" | "attempt" | "escape"> }
  /** Owner grants for attempts past the cap, newest last, capped at 20. Enforcement reads the newest only. */
  cap_grants?: CapGrant[]
  /** 0.6.20: the latest verify_oracle run on this unit. Server-authored. */
  oracle?: { ts: string; mutations: number; killed: number; survivors: string[]; invalid: string[] }
}

/** A single classified review finding. Shared with normalize_review output. */
export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low"
  file: string
  line: string
  description: string
  classification?: "confirmed" | "rejected" | "unverified"
}

/** A durable record of an advisor review at a phase checkpoint. */
export interface PhaseReview {
  advisor: string
  ts: string
  findings: ReviewFinding[]
  packet_hash?: string
  tokens?: number
  /** Seat completion as judged by the moderator. 'partial' = zero findings with no account of what was examined. Absent before v0.6.0. */
  completion?: "complete" | "partial" | "failed"
  /** What the seat says it examined (files/functions/categories). Silence without this list is not approval. */
  checked?: string[]
  /** Seat-reported limitations (timeouts, unread files, refused categories). */
  limitations?: string
  /** 'independent' = external blind pass; 'cross_exam' = informed follow-up; 'verification' = evidence-linked direct-fix check; legacy 'fan' never qualifies alone; 'native' = complete Codex subagent review with provenance, eligible only on the Codex host. */
  stage?: "independent" | "cross_exam" | "verification" | "fan" | "native"
  /** Host-reported provenance for the native Codex review path, not cross-vendor independence. */
  native?: NativeReviewEvidence
  /** Present on stage:'verification' only. */
  evidence?: VerificationEvidence
  /** Server-resolved authorization for a worker-delta verification; survives host switches. */
  model_rank?: ModelRank
  /** Server snapshot of attempts covered by this independent/native baseline. */
  unit_attempts?: Record<string, number>
  /** Declared scope of a scoped seat (0.6.20): the registered unit ids the seat examined, sorted. unit_attempts is restricted to these. Absent = whole-phase snapshot. Narrowing only: it never adds coverage. */
  units?: string[]
  /** Stamped on every record written since 0.6.19; absent = legacy record (neutral to the independence bound). */
  basis_version?: 2
  /** Host that wrote the record (server-authored). */
  host?: HostId
  /** Server-authored from a seat receipt; present only when record_review bound one (0.6.19 slice 4). */
  provenance?: SeatProvenance
  /** Server scalar on a baseline: verification records recorded against it (survives review trimming). */
  delta_count?: number
}

// ─── Review outcomes (0.6.19): what kind of evidence carried a gate ───────────
// Closed enums only: every value below is a metric key. Ids, hashes and timestamps
// stay on records. The seat predicate is unchanged; these classify what satisfied it.

/** Basis class of one seat or of a whole gate pass. */
export type BasisClass =
  | "receipted_external"   // Foreman-launched CLI seat, provider differs from the host provider, bound to the packet
  | "receipted"            // Foreman-launched CLI seat whose vendor relation to the pit-boss is unknowable, or below the bytes floor
  | "declared_external"    // stage undefined/'independent' with no receipt (every record before 0.6.19)
  | "same_provider"        // complete stage:'native' on the Codex host, or a receipted seat on the host's own vendor
  | "delta:receipted_external" | "delta:declared_external" | "delta:same_provider"   // eligible verification, by its baseline's class
  | "override"             // review_override: no seat at all

export type Provider = "anthropic" | "openai" | "google" | "unknown"

/** Server-authored provenance copied from a seat receipt at record_review (slice 4). */
export interface SeatProvenance {
  receipt: string
  cli: "claude" | "codex" | "gemini" | "council"
  provider: Provider
  model_served: string
  reasoning_effort?: string
  bytes_in: number
  bytes_out: number
  tokens_used?: number
}

/** One counted gate pass. Server-authored; copies advisor/ts/stage so evicted reviews stay attributable. */
export interface GateEvidence {
  seq: number
  ts: string
  host: HostId
  basis: BasisClass
  /** ≤10 seats. native_ids ≤6. */
  seats: Array<{
    advisor: string; ts: string; stage: string; basis: BasisClass
    kind?: "worker_delta" | "direct_fix"; baseline_ts?: string; receipt?: string; verifier_id?: string; native_ids?: string[]
    /** Units this seat covers at the stamp (0.6.20). Present only when the seat covers fewer than every unit; absent on a whole-phase seat and on stamps written before 0.6.20. */
    units?: number
  }>
  /** Current records by stage, seats or not. */
  present: Partial<Record<"independent" | "native" | "verification" | "fan" | "cross_exam", number>>
  /** Same shape as PhaseReview.unit_attempts: the coverage key for escapes. */
  unit_attempts: Record<string, number>
  units: number
  /** Native reviewers + verifier, 1 per independent record, 1 per verification. Cost proxy. */
  seat_agents: number
  regate: boolean
  flagged: boolean
  agent_class_declared?: "frontier" | "capable" | "compact"
  overrides: Array<"seat_minimum" | "discipline" | "review" | "confirmed" | "incomplete" | "escape" | "independence">
  rank: { weight: 0 | 1 | 2 | 3; declared: boolean }
  /** evidence.units of the carrying verification when basis is delta:*. */
  delta_units?: string[]
  tokens: { receipted: number; declared: number; unreported: number }
  /** 1 = phase basis is the strongest seat (0.6.19); 2 = the weakest per-unit class (0.6.20). */
  policy_version: 1 | 2
}

// ─── Escapes (0.6.19 slice 3): a gated unit contradicted after its gate ─────────
// Existence is server-authored from the writes the pit-boss must make anyway (a
// rejection, a non-pass verdict, a new attempt); only the class is declared, from a
// closed enum, and the ledger demands it before the next pass.
export type EscapeClass = "original_defect" | "remediation_defect" | "test_gap" | "process" | "new_scope" | "unclassified"
export type EscapeSource = "rejection" | "reopen" | "post_gate_attempt" | "later"
export type EscapeFinder = "external_seat" | "native_review" | "worker_delta" | "tests" | "user" | "production" | "other"
export interface Escape {
  ts: string
  unit_id: string
  attempt: number
  /** 0 / gate_units_hash.ts for a phase gated before 0.6.19. */
  gate_seq: number
  gate_ts: string
  basis: BasisClass | "legacy"
  host?: HostId
  /** Deduped; the first entry is the detector. */
  sources: EscapeSource[]
  in_delta_scope?: boolean
  class: EscapeClass
  classified_ts?: string
  found_by?: EscapeFinder
  note?: string
}
export interface EscapeTotals {
  total: number
  by_basis: Partial<Record<BasisClass | "legacy", number>>
  by_class: Partial<Record<EscapeClass, number>>
}

export interface GateTotals {
  gates: number
  regates: number
  units: number
  seat_agents: number
  tokens_receipted: number
  tokens_declared: number
  tokens_unreported: number
}

export interface Phase {
  s: "ip" | "done" | "blocked"
  g: "pass" | "fail" | "pending"
  scope?: PhaseScope
  units: Record<string, Unit>
  /** Spec-declared unit ids — gate pass requires every declared id to be registered in `units`. Absent on ledgers written before v0.5.11 (legacy behavior unchanged). */
  declared_units?: string[]
  /** Audit tombstones for retired declared ids (bounded to last 10). */
  declared_log?: { ts: string; retired: string[]; reason: string }[]
  /** Durable advisor reviews recorded at checkpoints. Optional: absent on pre-v0.3.1 ledgers. */
  reviews?: PhaseReview[]
  /** Snapshot hash of (unit id, verdict, v_ts) taken when the gate passed (D2b staleness detection). Absent pre-v0.5.0. */
  gate_units_hash?: { hash: string; ts: string }
  /** Units whose discipline-adherence contradiction was overridden at gate-pass via data.user_override (durable, auditable — P5 5a). Absent when no override occurred. */
  discipline_overrides?: { discipline_override: true; unit_id: string; delegation_id: string }[]
  /** Gate passed with zero record_review entries via data.user_override (durable, auditable). Absent when at least one review was recorded. */
  review_override?: { ts: string }
  /** Gate passed via data.user_override while the current reviews carried `findings` confirmed findings (durable, auditable). Absent when no confirmed finding was waived. */
  confirmed_override?: { ts: string; findings: number }
  /** Gate passed via data.user_override while `reviews` current reviews were partial, failed, or silent without an examined list (durable, auditable). */
  incomplete_override?: { ts: string; reviews: number }
  /** Counted gate passes, newest last, ≤ GATE_HISTORY (0.6.19). An idempotent re-pass stamps nothing. */
  gate_history?: GateEvidence[]
  /** Scalar totals per basis class; survive gate_history and review trimming. */
  gate_totals?: Partial<Record<BasisClass, GateTotals>>
  /** Post-gate contradictions of gated units, newest last, ≤ ESCAPE_RETENTION. */
  escapes?: Escape[]
  /** Scalar totals; survive escapes[] trimming. */
  escape_totals?: EscapeTotals
  /** Gate passed via data.user_override while `escapes` unclassified escapes stood (durable, auditable). */
  escape_override?: { ts: string; escapes: number }
  /** Gate passed via data.user_override at the independence bound; `streak` is the count it would have exceeded. */
  independence_override?: { ts: string; streak: number }
  /** 0.6.20: facts gathered during preflight that later units in the phase can reuse; newest last, ≤50. */
  facts?: Array<{ ts: string; key: string; text: string; source?: string }>
}

export interface PhaseScope {
  has_tests: boolean
  has_api: boolean
  has_build: boolean
  /** D10/D13 proportionality flags — trigger the seat-minimum gate check (3f). Optional: absent on pre-v0.5.0 scopes. */
  hot_path?: boolean
  security_boundary?: boolean
}

export interface LedgerFile {
  v: number
  ts: string
  phases: Record<string, Phase>
  /** CCR compression aggregate keyed by tool name (bounded: names come from the compression allowlist). Consumed by 5b. */
  ccr_stats?: Record<string, { calls: number; tokens_before: number; tokens_after: number }>
  /** 0.6.19: consecutive weak-basis counted gate passes since the last receipted cross-vendor pass; phases ≤ STREAK_MAX + 1. */
  independence?: { streak: number; phases: string[] }
}

// ─── Zod Schemas for MCP Tool Input Validation ───────────────────────────────

// 0.6.20: hoisted above SetUnitStatusInput — the inline rejection and the verdict carry it too.
const EscapeClassSchema = z.enum(["original_defect", "remediation_defect", "test_gap", "process", "new_scope"])

const SetUnitStatusInput = z.object({
  operation: z.literal("set_unit_status"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    s: z.enum(["pending", "ip", "delegated", "done", "fail"]),
    brief: z.string().max(50000).optional(),
    tier: z.enum(["cheap", "standard", "premium"]).optional(),
    route_reason: z.string().max(2000).optional(),
    worker_id: z.string().trim().min(1).max(400).optional(),
    correction: z.object({
      kind: z.enum(["mechanical", "bounded"]),
      from_attempt: z.number().int().min(1),
      files: z.array(z.string().trim().min(1).max(4096)).min(1).max(50),
    }).optional(),
    user_override: z.boolean().optional(),
    // Optional at the schema so non-delegating statuses need nothing; the ledger
    // refuses s:'delegated' without it (see PREFLIGHT REQUIRED in lib/ledger.ts).
    preflight: z.object({
      // 0.6.20: an array of symbols (checked by preflight_check against the spec); the
      // legacy count is still accepted so ledgers written by older sessions replay.
      symbols_grepped: z.union([z.number().int().min(1), z.array(z.string().trim().min(1).max(200)).min(1).max(100)]),
      self_consistent: z.literal(true),
      telemetry: z.enum(["checked", "n/a"]).optional(),
      // 0.6.20: the brief hash preflight_check returned; the ledger checks it against the
      // preflight record file, so the attestation is something the pit-boss cannot type.
      receipt: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    }).optional(),
    // With s:'ip' only: records a pit-boss literal substitution as an attempt (Direct Fix rule).
    direct_fix: z.string().min(10).max(2000).optional(),
    // 0.6.20: the finding this delegation answers, recorded in the same write as the
    // attempt (same semantics as add_rejection; ts is server-authored). s:'delegated' only.
    rejection: z.object({
      r: z.string().max(10000),
      msg: z.string().max(10000),
      escape_class: EscapeClassSchema.optional(),
    }).optional(),
  }),
})

const SetVerdictInput = z.object({
  operation: z.literal("set_verdict"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    v: z.enum(["pass", "fail", "pending", "inconclusive"]),
    via: z.enum(["worker", "pitboss-direct", "n/a"]).optional(),
    worker_id: z.string().trim().min(1).max(400).optional(),
    note: z.string().max(10000).optional(),
    // Waives ATTEMPT REQUIRED and the delegation cap on a pass; recorded as cap_override.
    user_override: z.boolean().optional(),
    // 0.6.20: classifies the unit's newest unclassified escape in the verdict write.
    escape_class: EscapeClassSchema.optional(),
  }),
})

const AddRejectionInput = z.object({
  operation: z.literal("add_rejection"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    r: z.string().max(10000),
    msg: z.string().max(10000),
    ts: z.string().max(10000),
    // 0.6.19: classify the escape at the moment of rejection when the unit is gated.
    escape_class: EscapeClassSchema.optional(),
  }),
})

// 0.6.19 (slice 3): classify a post-gate defect, or record one found out of band.
// The unit must be registered; a typo never creates a phantom unit that blocks the gate.
const RecordEscapeInput = z.object({
  operation: z.literal("record_escape"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    class: EscapeClassSchema,
    // 'later' = a defect in this unit's gated code found in a later phase, in production, or by the user.
    source: z.literal("later").optional(),
    found_by: z.enum(["external_seat", "native_review", "worker_delta", "tests", "user", "production", "other"]).optional(),
    note: z.string().max(500).optional(),
  }),
})

const UpdatePhaseGateInput = z.object({
  operation: z.literal("update_phase_gate"),
  phase: z.string().max(10000),
  unit_id: z.string().max(10000).optional(),
  data: z.object({
    g: z.enum(["pass", "fail", "pending"]),
    // D13 seat-minimum inputs. These MUST be declared here: z.object strips unknown
    // keys, so without them the gate handler could never see agent_class/user_override.
    agent_class: z.enum(["frontier", "capable", "compact"]).optional(),
    user_override: z.boolean().optional(),
  }),
})

export const PhaseScopeSchema = z.object({
  has_tests: z.boolean(),
  has_api: z.boolean(),
  has_build: z.boolean(),
  hot_path: z.boolean().optional(),
  security_boundary: z.boolean().optional(),
})

const SetPhaseScopeInput = z.object({
  operation: z.literal("set_phase_scope"),
  phase: z.string().max(10000),
  data: PhaseScopeSchema,
})

// Declared ids feed unescaped TOON output (comma-joined lists) and gate error
// messages — newlines and commas are structural there, so they are rejected here.
const DeclaredUnitId = z.string().min(1).max(200).refine(
  (s) => s.trim() === s && !/[\r\n,]/.test(s),
  { message: "declared unit ids must be trimmed and contain no newlines or commas" }
)

const DeclarePhaseUnitsInput = z.object({
  operation: z.literal("declare_phase_units"),
  phase: z.string().max(10000),
  data: z.object({
    units: z.array(DeclaredUnitId).max(200).optional(),
    retire: z.array(DeclaredUnitId).max(200).optional(),
    reason: z.string().min(10).max(2000).optional(),
  }),
})

const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().max(4096),
  line: z.string().max(20),
  description: z.string().max(10000),
  classification: z.enum(["confirmed", "rejected", "unverified"]).optional(),
})

// v0.6.4 (Codex, field feedback round 4): the gate blocks only on `confirmed`, so a
// finding recorded without a classification slipped past it. The moderator's call is
// required on every recorded finding; the parser's output (above) stays unclassified.
const ClassifiedFindingSchema = ReviewFindingSchema.extend({
  classification: z.enum(["confirmed", "rejected", "unverified"]),
})

// v0.6.5 (Codex, field feedback round 5): a pit-boss re-verification of direct fixes,
// recorded with structured evidence. The gate accepts it in place of a fresh seat only
// under the predicates in lib/ledger.ts verificationIneligibility; the ledger cannot
// check the evidence, so the record's value is that it is linked to exact attempts and
// to the independent review it extends.
const TestsEvidence = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pass"), command: z.string().max(2000), result: z.string().max(2000) }),
  z.object({ outcome: z.literal("n/a"), reason: z.string().min(10).max(2000) }),
])
const ProbeEvidence = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pass"), method: z.string().max(2000), result: z.string().max(2000) }),
  z.object({ outcome: z.literal("n/a"), reason: z.string().min(10).max(2000) }),
])
const VerificationEvidenceSchema = z.object({
  kind: z.literal("worker_delta").optional(),
  verifier_id: z.string().trim().min(1).max(400).optional(),
  baseline_review_ts: z.string().max(100),
  units: z.array(z.object({ unit_id: z.string().max(200), attempt: z.number().int().min(1) })).min(1).max(50),
  files: z.array(z.string().max(4096)).min(1).max(50),
  tests: TestsEvidence,
  probe: ProbeEvidence,
})
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>

// 0.6.20: identity and coverage text split. Ids are refused when over the limit (the
// distinct-id rule reads them); coverage entries are scrubbed and cut with a marker.
const NativeId = z.string().trim().min(1).max(400)
const NativeChecked = z.string().trim().overwrite((v) => softCut(v, 400)).min(1).max(400)
export const NativeReviewEvidenceSchema = z.object({
  reviewers: z.array(z.object({
    agent_id: NativeId,
    lens: z.enum(["contract", "architecture", "state", "security", "data", "tests", "operability"]),
    completion: z.enum(["complete", "partial", "failed"]),
    checked: z.array(NativeChecked).max(50),
  })).min(2).max(5),
  verifier_id: NativeId,
})
export type NativeReviewEvidence = z.infer<typeof NativeReviewEvidenceSchema>

const RecordReviewInput = z.object({
  operation: z.literal("record_review"),
  phase: z.string().max(10000),
  data: z.object({
    advisor: z.string().max(200),
    findings: z.array(ClassifiedFindingSchema).max(100),
    packet_hash: z.string().max(200).optional(),
    tokens: z.number().min(0).optional(),
    completion: z.enum(["complete", "partial", "failed"]).optional(),
    // 400 since 0.6.5: 200 bit on any review with real content (field feedback round 5).
    // Soft since 0.6.20: over-long entries are cut with a marker, not refused.
    checked: z.array(softText(400)).max(50).optional(),
    limitations: softText(2000).optional(),
    stage: z.enum(["independent", "cross_exam", "verification", "fan", "native"]).optional(),
    native: NativeReviewEvidenceSchema.optional(),
    // Required with stage:'verification', refused with any other stage (lib/ledger.ts).
    evidence: VerificationEvidenceSchema.optional(),
    // 0.6.19: binds this independent record to one invoke_advisor receipt (meta block
    // seat_receipt); needs packet_hash equal to that block's packet_sha256.
    seat_receipt: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    // 0.6.20: a scoped seat names the registered units it examined; the server restricts the
    // snapshot to them. Narrowing only — omit for a whole-phase seat. Refused with any stage
    // that carries no snapshot (cross_exam, verification, fan). Ids reuse DeclaredUnitId
    // (trimmed, no newline/comma) because they land in TOON lists and gate messages.
    // Renders as `units?: string (≥1 chars, ≤200 chars)[] (max 200)` (minItems is not rendered).
    units: z.array(DeclaredUnitId).min(1).max(200).optional(),
  }),
})

// v0.6.5: the owner's decision to allow attempts past the cap, recorded once. Refused
// below the cap (a grant issued early would defeat it) and while a grant is still open.
const AuthorizeAttemptsInput = z.object({
  operation: z.literal("authorize_attempts"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    attempts: z.number().int().min(1).max(10),
    reason: z.string().min(10).max(2000),
    user_override: z.literal(true),
  }),
})

// 0.6.20 (field report): preflight knowledge is gathered per unit but useful per phase, and
// had nowhere to live. A bounded per-phase fact store, surfaced by read_ledger facts.
const RecordFactInput = z.object({
  operation: z.literal("record_fact"),
  phase: z.string().max(10000),
  data: z.object({
    key: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(2000),
    source: z.string().trim().min(1).max(400).optional(),
  }),
})

export const WriteLedgerInputSchema = z.discriminatedUnion("operation", [
  SetUnitStatusInput,
  SetVerdictInput,
  AddRejectionInput,
  DeclarePhaseUnitsInput,
  UpdatePhaseGateInput,
  SetPhaseScopeInput,
  RecordReviewInput,
  AuthorizeAttemptsInput,
  RecordEscapeInput,
  RecordFactInput,
])

export type WriteLedgerInput = z.infer<typeof WriteLedgerInputSchema>

export const ReadLedgerInputSchema = z.object({
  unit_id: z.string().max(10000).optional(),
  phase: z.string().max(10000).optional(),
  query: z.enum(["verdicts", "rejections", "phase_gates", "reviews", "full", "delegation_metrics", "review_outcomes", "facts"]).optional(),
  verdict: z.enum(["pass", "fail", "pending", "inconclusive"]).optional(),
  include_notes: z.boolean().optional(),
  cursor: z.number().int().min(0).max(1000000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export type ReadLedgerInput = z.infer<typeof ReadLedgerInputSchema>

export const NormalizeReviewInputSchema = z.strictObject({
  reviewer: z.string().max(200),
  raw_text: z.string().max(50000),
})
export type NormalizeReviewInput = z.infer<typeof NormalizeReviewInputSchema>

// ─── Verify Citations Types ──────────────────────────────────────────────────

export const VerifyCitationsInputSchema = z.strictObject({
  spec_text: z.string().max(500000).optional(),
  spec_path: z.string().max(4096).optional(),
  source_format: z.enum(["markdown", "machine_json", "auto"]).default("auto"),
  repo_root: z.string().max(4096).optional(),
  drift_window: z.number().int().min(0).max(200).default(25),
  min_anchor_chars: z.number().int().min(0).max(200).default(8),
  case_insensitive_path: z.boolean().default(true),
})
export type VerifyCitationsInput = z.infer<typeof VerifyCitationsInputSchema>

// ─── Progress Types ───────────────────────────────────────────────────────────

export interface ProgressUnit {
  id: string
  phase: string
  status: string
  notes: string
  completed_at?: string
}

export interface ProgressError {
  date: string
  unit: string
  what_failed: string
  next_approach: string
}

export interface ProgressFile {
  phases: Record<
    string,
    {
      name: string
      units: Record<string, ProgressUnit>
      /** 0.6.20: checklist entries removed by retire_unit, with the reason; newest last, ≤20. */
      retired?: Array<{ unit_id: string; ts: string; reason: string }>
    }
  >
  error_log: ProgressError[]
}

export interface StatusSummary {
  phase: string
  last_completed: string
  next_up: string
  blocked: string
  completed_count: number
  total_count: number
  planning_note: string
}

export interface TruncatedView {
  status: StatusSummary
  completed: ProgressUnit[]
  incomplete: ProgressUnit[]
  errors: ProgressError[]
}

// ─── write_progress Input Schema ─────────────────────────────────────────────

const UpdateStatusData = z.object({
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  status: z.string().max(10000),
  notes: z.string().max(10000),
})

const CompleteUnitData = z.object({
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  completed_at: z.string().max(10000),
  notes: z.string().max(10000),
})

const LogErrorData = z.object({
  date: z.string().max(10000),
  unit: z.string().max(10000),
  what_failed: z.string().max(10000),
  next_approach: z.string().max(10000),
})

const StartPhaseData = z.object({
  phase: z.string().max(10000),
  name: z.string().max(10000),
})

// 0.6.20 (field report): an orphan checklist entry (no ledger unit, no declaration) persisted
// all session with no clear path. retire_unit removes it with a recorded reason.
const RetireUnitData = z.object({
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  reason: z.string().min(10).max(2000),
})

export const WriteProgressInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("retire_unit"), data: RetireUnitData }),
  z.object({ operation: z.literal("update_status"), data: UpdateStatusData }),
  z.object({ operation: z.literal("complete_unit"), data: CompleteUnitData }),
  z.object({ operation: z.literal("log_error"), data: LogErrorData }),
  z.object({ operation: z.literal("start_phase"), data: StartPhaseData }),
])

export type WriteProgressInput = z.infer<typeof WriteProgressInputSchema>

/** Per-operation `data` schemas for write_progress (schema-error hints; see lib/schemaError.ts). */
export const ProgressOperationDataSchemas = {
  retire_unit: RetireUnitData,
  update_status: UpdateStatusData,
  complete_unit: CompleteUnitData,
  log_error: LogErrorData,
  start_phase: StartPhaseData,
} as const

// ─── Journal Types ──────────────────────────────────────────────────────────

export interface JournalEnv {
  model?: string | null
  effort?: string | null
  model_rank?: import("./lib/modelRank.js").ModelRank
  os: string
  node: string
  foreman: string
  agent: string
  worker: string
  claude?: string | null
  codex: string | null
  gemini: string | null
  /** R8: declared capability classes (additive, v0.5.0). */
  agent_class?: "frontier" | "capable" | "compact"
  worker_class?: "frontier" | "capable" | "compact"
}

export interface JournalEvent {
  t: string
  u: string
  tok: number
  msg: string
  wait?: number
  gate?: string
}

export interface SessionSummary {
  units_ok: number
  units_rej: number
  w_spawned: number
  w_wasted: number
  tok_wasted: number
  delay_min: number
  blockers: string[]
  friction: number
}

export interface JournalSession {
  env?: JournalEnv
  model_declarations?: Array<{ ts: string; model_rank: import("./lib/modelRank.js").ModelRank }>
  id: string
  ts: string
  branch: string
  /** String phase ids are canonical; number remains readable/writable for legacy clients. */
  phase: string | number
  units: string[]
  dur_min?: number
  ctx_used_pct?: number
  events: JournalEvent[]
  summary?: SessionSummary
}

export interface JournalRollup {
  sessions: number
  avg_friction: number
  top_events: { t: string; count: number }[]
  tok_total_wasted: number
  delay_total_min: number
  worst_unit_pattern: string
  best_unit_pattern: string
}

export interface JournalFile {
  v: number
  project: string
  target_version: string
  next_sid: number
  sessions: JournalSession[]
  rollup?: JournalRollup
}

// ─── Journal Zod Schemas ────────────────────────────────────────────────────

// Anomaly-only, and only codes something actually emits: the implementor's friction table
// (11), TOOL_ERR from the write_journal description, SEC_BLOCK from the .foremanenv loader,
// EGRESS_NOTICE from the worker and council tools, and ED_STALE for a stale patch base.
// 0.6.3 removed twelve codes no protocol text or code path ever emitted, plus CAP_WAIVER
// (aider-only). Journals written earlier still parse: readJournal does not revalidate.
export const JournalEventCode = z.enum([
  "W_FAIL", "W_REJ", "W_RETRY",
  "CX_ERR", "ED_STALE",
  "T_FLAKE", "BLD_ERR",
  "SPEC_AMB", "SPEC_GAP", "GATE_FIX", "GATE_OVERRIDE",
  // 0.6.20: a green suite that cannot observe the defect (field report); distinct from W_REJ.
  "T_BLIND",
  "TOOL_ERR", "USR_INT",
  "SEC_BLOCK", "EGRESS_NOTICE",
])

const InitSessionData = z.object({
  target_version: z.string().max(20),
  branch: z.string().max(200),
  phase: z.union([
    z.string().min(1).max(100),
    z.number().int().min(1).max(100),
  ]),
  units: z.array(z.string().max(100)).max(50),
  env: z.object({
    agent: z.string().max(100),
    worker: z.string().max(100),
    claude: z.string().max(50).nullable().optional(),
    codex: z.string().max(50).nullable(),
    gemini: z.string().max(50).nullable(),
    // R8: capability class per seat — declared, never self-assessed.
    agent_class: z.enum(["frontier", "capable", "compact"]).optional(),
    worker_class: z.enum(["frontier", "capable", "compact"]).optional(),
    model: z.string().max(100).nullable().optional(),
    effort: z.string().max(30).nullable().optional(),
  }),
})

const DeclareModelData = z.object({
  model: z.string().max(100).nullable().optional(),
  effort: z.string().max(30).nullable().optional(),
})

const LogEventData = z.object({
  t: JournalEventCode,
  u: z.string().max(200),
  tok: z.number().min(0),
  msg: softText(400),
  wait: z.number().min(0).optional(),
  gate: z.string().max(10).optional(),
})

const EndSessionData = z.object({
  dur_min: z.number().min(0).max(10000),
  ctx_used_pct: z.number().min(0).max(100),
  summary: z.object({
    units_ok: z.number().min(0),
    units_rej: z.number().min(0),
    w_spawned: z.number().min(0),
    w_wasted: z.number().min(0),
    tok_wasted: z.number().min(0),
    delay_min: z.number().min(0),
    blockers: z.array(z.string().max(100)).max(20),
    friction: z.number().min(0).max(100),
  }),
})

export const WriteJournalInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("init_session"), data: InitSessionData }),
  z.object({ operation: z.literal("declare_model"), data: DeclareModelData }),
  z.object({ operation: z.literal("log_event"), data: LogEventData }),
  z.object({ operation: z.literal("end_session"), data: EndSessionData }),
])

export type WriteJournalInput = z.infer<typeof WriteJournalInputSchema>

/**
 * Per-operation `data` schemas, keyed by operation name. The MCP tool inputSchema
 * cannot express "data depends on operation", so server.ts renders these into the
 * tool descriptions (lib/schemaDoc.ts) and a contract test keeps them in sync.
 */
export const JournalOperationDataSchemas = {
  init_session: InitSessionData,
  declare_model: DeclareModelData,
  log_event: LogEventData,
  end_session: EndSessionData,
} as const

/**
 * Soft-limited fields per operation (0.6.20). Path + limit are the contract the TRUNCATED
 * warning is computed from; tests/softLimits.test.ts round-trips each entry through its
 * operation schema so this table cannot drift from the zod checks.
 */
export const JournalSoftLimits: Record<string, readonly SoftLimit[]> = {
  log_event: [{ path: "data.msg", max: 400 }],
}
export const LedgerSoftLimits: Record<string, readonly SoftLimit[]> = {
  record_review: [
    { path: "data.checked.[]", max: 400 },
    { path: "data.limitations", max: 2000 },
    { path: "data.native.reviewers.[].checked.[]", max: 400 },
  ],
}

export const LedgerOperationDataSchemas = {
  set_unit_status: SetUnitStatusInput.shape.data,
  set_verdict: SetVerdictInput.shape.data,
  add_rejection: AddRejectionInput.shape.data,
  declare_phase_units: DeclarePhaseUnitsInput.shape.data,
  update_phase_gate: UpdatePhaseGateInput.shape.data,
  set_phase_scope: SetPhaseScopeInput.shape.data,
  record_review: RecordReviewInput.shape.data,
  authorize_attempts: AuthorizeAttemptsInput.shape.data,
  record_escape: RecordEscapeInput.shape.data,
  record_fact: RecordFactInput.shape.data,
} as const

export const ReadJournalInputSchema = z.object({
  last_n: z.number().min(1).max(100).optional(),
  rollup_only: z.boolean().optional(),
})

export type ReadJournalInput = z.infer<typeof ReadJournalInputSchema>
