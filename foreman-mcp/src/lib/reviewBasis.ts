/**
 * Review outcomes (0.6.19). The seat predicate that decides gate sufficiency lives in
 * ledger.ts and reviewPredicates.ts and is unchanged. This module classifies WHAT
 * carried a counted gate pass (its basis), stamps that on the phase, keeps scalar totals
 * that survive every bounded history, and renders the read-time report. Nothing here
 * reads model rank as evidence of reviewer quality: Foreman has no source for the model
 * a native reviewer ran on, so the only quality signal is what accrues in arrears —
 * escapes per basis (slice 3).
 *
 * Pure functions over ledger data. No I/O. Never imports ledger.ts.
 */
import type {
  BasisClass, GateEvidence, GateTotals, LedgerFile, Phase, PhaseReview, Provider,
} from "../types.js"
import type { HostId } from "./hostProfiles.js"
import type { ModelRank } from "./modelRank.js"
import { toKeyValue, toTable } from "./toon.js"

// ─── Policy constants (a change is a visible bump) ───────────────────────────
export const OUTCOMES_POLICY_VERSION = 1 as const
export const GATE_HISTORY = 5
export const GATE_SEATS_MAX = 10
export const GATE_NATIVE_IDS_MAX = 6
/** A receipted seat below either floor is 'receipted', never 'receipted_external' (slice 4). */
export const RECEIPT_MIN_BYTES_IN = 1024
export const RECEIPT_MIN_BYTES_OUT = 200

/** Strongest first. Any non-null class is a seat; order only ranks which one names the gate. */
export const BASIS_PRECEDENCE: readonly BasisClass[] = [
  "receipted_external", "delta:receipted_external", "declared_external", "delta:declared_external",
  "receipted", "same_provider", "delta:same_provider", "override",
]

/** The vendor behind a host's own model, when Foreman can know it. */
export function hostProvider(host: HostId): Provider | null {
  if (host === "codex") return "openai"
  if (host === "claude-code") return "anthropic"
  return null
}

// ─── Per-record basis ────────────────────────────────────────────────────────

function baselineFor(r: PhaseReview, allReviews: PhaseReview[]): PhaseReview | undefined {
  const ts = r.evidence?.baseline_review_ts
  if (ts === undefined) return undefined
  // Same stage filter the admitting blocker used: worker_delta accepts native baselines,
  // the legacy direct-fix path does not (reviewPredicates.ts workerDeltaBlocker / verificationBlocker).
  const allowNative = r.evidence?.kind === "worker_delta"
  return allReviews.find((b) => b.ts === ts &&
    (b.stage === undefined || b.stage === "independent" || (allowNative && b.stage === "native")))
}

/**
 * Basis of one record the gate already accepted as a seat. Returns null for stages that
 * never are (fan, cross_exam). Callers pass only records that passed the gate's own
 * currency and eligibility filters; this function does not re-derive sufficiency.
 */
export function seatBasis(r: PhaseReview, host: HostId, allReviews: PhaseReview[]): BasisClass | null {
  if (r.stage === undefined || r.stage === "independent") {
    const prov = r.provenance
    if (!prov) return "declared_external"
    const hp = hostProvider(r.host ?? host)
    const trivial = prov.bytes_in < RECEIPT_MIN_BYTES_IN || prov.bytes_out < RECEIPT_MIN_BYTES_OUT
    if (trivial || hp === null) return "receipted"
    return prov.provider !== hp ? "receipted_external" : "same_provider"
  }
  if (r.stage === "native") return "same_provider"
  if (r.stage === "verification") {
    const baseline = baselineFor(r, allReviews)
    const base = baseline ? seatBasis(baseline, host, allReviews) : null
    const inner: BasisClass = base === null || base === "receipted" || base === "override" || base.startsWith("delta:")
      ? "declared_external"
      : base
    return `delta:${inner}` as BasisClass
  }
  return null
}

/** Strongest class among the seats; 'override' when there is none. */
export function phaseBasis(classes: BasisClass[]): BasisClass {
  for (const c of BASIS_PRECEDENCE) if (classes.includes(c)) return c
  return "override"
}

// ─── Gate stamp ──────────────────────────────────────────────────────────────

export interface ClassifyGateInput {
  host: HostId
  phaseObj: Phase
  /** Records that passed the gate's currency filter, seats or not. */
  currentReviews: PhaseReview[]
  /** The subset the gate accepted as seats: independent, native (codex), eligible verifications. */
  seats: PhaseReview[]
  allReviews: PhaseReview[]
  modelRank: ModelRank
  agentClass?: "frontier" | "capable" | "compact"
  overrides: GateEvidence["overrides"]
  ts: string
}

/** Server-authored evidence for one counted gate pass. */
export function classifyGate(input: ClassifyGateInput): GateEvidence {
  const { host, phaseObj, currentReviews, seats, allReviews, modelRank, ts } = input
  const history = phaseObj.gate_history ?? []
  const classes: BasisClass[] = []
  const seatRows: GateEvidence["seats"] = []
  let seatAgents = 0
  const tokens = { receipted: 0, declared: 0, unreported: 0 }
  let deltaUnits: string[] | undefined
  // Receipted seats from two distinct providers on a null-provider host: at least one is
  // cross-vendor to whatever the pit-boss is, so the gate is receipted_external.
  const receiptedProviders = new Set<Provider>()

  for (const r of seats) {
    const basis = seatBasis(r, host, allReviews)
    if (basis === null) continue
    classes.push(basis)
    if (r.provenance && basis === "receipted") receiptedProviders.add(r.provenance.provider)
    const nativeIds = r.native
      ? [...r.native.reviewers.map((s) => s.agent_id), r.native.verifier_id].slice(0, GATE_NATIVE_IDS_MAX)
      : undefined
    seatAgents += r.native ? r.native.reviewers.length + 1 : 1
    if (r.provenance?.tokens_used !== undefined) tokens.receipted += r.provenance.tokens_used
    else if (r.tokens !== undefined) tokens.declared += r.tokens
    else tokens.unreported += 1
    if (seatRows.length < GATE_SEATS_MAX) {
      seatRows.push({
        advisor: r.advisor, ts: r.ts, stage: r.stage ?? "independent", basis,
        ...(r.evidence ? { kind: r.evidence.kind ?? "direct_fix", baseline_ts: r.evidence.baseline_review_ts } : {}),
        ...(r.provenance ? { receipt: r.provenance.receipt } : {}),
        ...(r.evidence?.verifier_id ? { verifier_id: r.evidence.verifier_id } : {}),
        ...(nativeIds ? { native_ids: nativeIds } : {}),
      })
    }
  }
  if (receiptedProviders.size >= 2) classes.push("receipted_external")
  const basis = phaseBasis(classes)
  if (basis.startsWith("delta:")) {
    const carrying = seats.find((r) => r.stage === "verification" && seatBasis(r, host, allReviews) === basis)
    deltaUnits = carrying?.evidence?.units.map((u) => u.unit_id)
  }

  const present: GateEvidence["present"] = {}
  for (const r of currentReviews) {
    const stage = r.stage ?? "independent"
    present[stage] = (present[stage] ?? 0) + 1
  }
  const unitAttempts = Object.fromEntries(Object.entries(phaseObj.units).map(([id, u]) => [id, u.attempt_seq ?? 0]))
  const flagged = Boolean(phaseObj.scope?.hot_path || phaseObj.scope?.security_boundary)
  return {
    seq: (history.at(-1)?.seq ?? 0) + 1,
    ts,
    host,
    basis,
    seats: seatRows,
    present,
    unit_attempts: unitAttempts,
    units: Object.keys(phaseObj.units).length,
    seat_agents: seatAgents,
    regate: history.length > 0,
    flagged,
    ...(input.agentClass !== undefined ? { agent_class_declared: input.agentClass } : {}),
    overrides: [...input.overrides],
    rank: { weight: modelRank.weight, declared: modelRank.session_id !== undefined },
    ...(deltaUnits !== undefined ? { delta_units: deltaUnits } : {}),
    tokens,
    policy_version: OUTCOMES_POLICY_VERSION,
  }
}

/** Push the stamp (bounded) and fold it into the per-basis scalar totals. */
export function recordGatePass(phaseObj: Phase, evidence: GateEvidence): void {
  phaseObj.gate_history ??= []
  phaseObj.gate_history.push(evidence)
  if (phaseObj.gate_history.length > GATE_HISTORY) phaseObj.gate_history = phaseObj.gate_history.slice(-GATE_HISTORY)
  phaseObj.gate_totals ??= {}
  const t = (phaseObj.gate_totals[evidence.basis] ??= {
    gates: 0, regates: 0, units: 0, seat_agents: 0, tokens_receipted: 0, tokens_declared: 0, tokens_unreported: 0,
  })
  if (evidence.regate) t.regates += 1
  else t.gates += 1
  t.units += evidence.units
  t.seat_agents += evidence.seat_agents
  t.tokens_receipted += evidence.tokens.receipted
  t.tokens_declared += evidence.tokens.declared
  t.tokens_unreported += evidence.tokens.unreported
}

// ─── Report ──────────────────────────────────────────────────────────────────

function emptyTotals(): GateTotals {
  return { gates: 0, regates: 0, units: 0, seat_agents: 0, tokens_receipted: 0, tokens_declared: 0, tokens_unreported: 0 }
}

function k(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/**
 * Recomputed from scalar totals on every read (the delegation_metrics posture). Rates
 * are per unit-gate over FIRST gates; re-gates are shown, never folded in. Slice 3 adds
 * the escape columns from phase.escape_totals; until then they read 0.
 */
export function renderReviewOutcomes(ledger: LedgerFile, phaseFilter?: string): string {
  const phases = phaseFilter
    ? (ledger.phases[phaseFilter] ? [[phaseFilter, ledger.phases[phaseFilter]] as const] : [])
    : Object.entries(ledger.phases)
  if (phaseFilter && phases.length === 0) return toKeyValue({ error: "phase not found", phase: phaseFilter })

  const totals = new Map<BasisClass, GateTotals>()
  const hosts = new Map<BasisClass, Map<string, number>>()
  let gatedPhases = 0
  let countedPasses = 0
  let regates = 0
  for (const [, phase] of phases) {
    if (phase.gate_history?.length) gatedPhases += 1
    for (const [basis, t] of Object.entries(phase.gate_totals ?? {}) as Array<[BasisClass, GateTotals]>) {
      const agg = totals.get(basis) ?? emptyTotals()
      agg.gates += t.gates; agg.regates += t.regates; agg.units += t.units; agg.seat_agents += t.seat_agents
      agg.tokens_receipted += t.tokens_receipted; agg.tokens_declared += t.tokens_declared; agg.tokens_unreported += t.tokens_unreported
      totals.set(basis, agg)
      countedPasses += t.gates + t.regates
      regates += t.regates
    }
    for (const g of phase.gate_history ?? []) {
      const byHost = hosts.get(g.basis) ?? new Map<string, number>()
      byHost.set(g.host, (byHost.get(g.host) ?? 0) + 1)
      hosts.set(g.basis, byHost)
    }
  }

  const header = toKeyValue({
    report: "review_outcomes",
    policy_version: OUTCOMES_POLICY_VERSION,
    scope: phaseFilter ?? "all",
    gated_phases: gatedPhases,
    counted_passes: countedPasses,
    regates,
    note: "Basis is what carried each counted gate pass; the seat rule itself is unchanged. Rates are per unit-gate over first gates.",
  })
  const rows = BASIS_PRECEDENCE.filter((b) => totals.has(b)).map((basis) => {
    const t = totals.get(basis)!
    const gates = t.gates + t.regates
    const perGate = gates > 0 ? (t.seat_agents / gates).toFixed(1) : "-"
    const byHost = [...(hosts.get(basis) ?? new Map()).entries()].map(([h, n]) => `${h}:${n}`).join(" ") || "-"
    return [basis, String(t.gates), String(t.regates), String(t.units), perGate,
      `${k(t.tokens_receipted)}/${k(t.tokens_declared)}/${t.tokens_unreported}`, byHost]
  })
  const table = rows.length > 0
    ? toTable(["basis", "gates", "regates", "units", "agents/gate", "tok(receipted/declared/unreported)", "hosts"], rows)
    : "no counted gate passes recorded since 0.6.19"
  return `${header}\n${table}`
}
