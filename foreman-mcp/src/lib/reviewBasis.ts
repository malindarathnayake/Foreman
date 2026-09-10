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
  BasisClass, Escape, EscapeClass, EscapeFinder, EscapeSource, GateEvidence, GateTotals, LedgerFile, Phase, PhaseReview, Provider, Unit,
} from "../types.js"
import type { HostId } from "./hostProfiles.js"
import type { ModelRank } from "./modelRank.js"
import { toKeyValue, toTable } from "./toon.js"

// ─── Policy constants (a change is a visible bump) ───────────────────────────
export const OUTCOMES_POLICY_VERSION = 1 as const
export const GATE_HISTORY = 5
export const GATE_SEATS_MAX = 10
export const GATE_NATIVE_IDS_MAX = 6
export const ESCAPE_RETENTION = 20
/** Classes that count as defects in the report; the rest are recorded and rendered apart. */
export const DEFECT_CLASSES: ReadonlySet<EscapeClass> = new Set<EscapeClass>(["original_defect", "remediation_defect"])
// ─── Independence bound (slice 5) ─────────────────────────────────────────────
// A streak, not a weight: a weight sums claims about actors Foreman cannot identify; a
// streak counts gates the ledger authored and needs no opinion of how good a same-provider
// review was, only how long it has been the sole basis. 'override' is weak so a seatless
// pass can never buy independence back. Only a receipted cross-vendor seat resets it.
export const STREAK_MAX = 3
export const WEAK_BASES: ReadonlySet<BasisClass> = new Set<BasisClass>(["same_provider", "delta:same_provider", "override"])
export const RESET_BASES: ReadonlySet<BasisClass> = new Set<BasisClass>(["receipted_external"])
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
    // An unknown vendor (a council seat outside the prefix allowlist) is receipted, never
    // external: Foreman holds no proof it differs from the host's.
    if (trivial || hp === null || prov.provider === "unknown") return "receipted"
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
    if (r.provenance && basis === "receipted" && r.provenance.provider !== "unknown") receiptedProviders.add(r.provenance.provider)
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

// ─── Escapes ─────────────────────────────────────────────────────────────────
// Coverage is keyed on the per-unit attempt snapshot the gate stamped, never on a
// verdict timestamp: a pass→pass re-verdict bumps v_ts with no new attempt and must not
// exit coverage, while a new attempt is itself the contradiction. Nothing here reads
// phase.g, so reopening the gate before a rejection changes nothing.

export type Covering = { legacy: false; gate: GateEvidence } | { legacy: true; ts: string }

/** The counted gate whose snapshot still covers this unit at this attempt, or null. */
export function coveringGate(phase: Phase, unitId: string, attempt: number): Covering | null {
  const history = phase.gate_history
  if (history?.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      const g = history[i]
      if (g.unit_attempts[unitId] === attempt) return { legacy: false, gate: g }
    }
    return null
  }
  // A phase gated before 0.6.19 has no snapshot: fall back to the D2b stamp.
  const unit = phase.units[unitId]
  if (phase.gate_units_hash && unit?.v === "pass" && (unit.v_ts ?? "") <= phase.gate_units_hash.ts) {
    return { legacy: true, ts: phase.gate_units_hash.ts }
  }
  return null
}

function bumpEscapeTotals(phase: Phase, basis: Escape["basis"], from: EscapeClass | null, to: EscapeClass): void {
  phase.escape_totals ??= { total: 0, by_basis: {}, by_class: {} }
  const t = phase.escape_totals
  if (from === null) {
    t.total += 1
    t.by_basis[basis] = (t.by_basis[basis] ?? 0) + 1
  } else {
    t.by_class[from] = Math.max(0, (t.by_class[from] ?? 0) - 1)
  }
  t.by_class[to] = (t.by_class[to] ?? 0) + 1
}

/**
 * Record that a covered unit was contradicted. Keyed by (unit_id, gate_seq): the first
 * event creates the escape, later ones on the same key only add their source. Returns
 * the escape when the unit is covered, else null (nothing to attribute).
 */
export function applyEscape(
  phase: Phase, unitId: string, unit: Unit, source: EscapeSource, ts: string,
  cls?: EscapeClass, extra?: { found_by?: EscapeFinder; note?: string }
): Escape | null {
  const attempt = unit.attempt_seq ?? 0
  const covering = coveringGate(phase, unitId, attempt)
  if (!covering) return null
  const gateSeq = covering.legacy ? 0 : covering.gate.seq
  phase.escapes ??= []
  const existing = phase.escapes.find((e) => e.unit_id === unitId && e.gate_seq === gateSeq)
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source)
    return existing
  }
  const escape: Escape = covering.legacy
    ? { ts, unit_id: unitId, attempt, gate_seq: 0, gate_ts: covering.ts, basis: "legacy", sources: [source], class: cls ?? "unclassified" }
    : {
      ts, unit_id: unitId, attempt, gate_seq: covering.gate.seq, gate_ts: covering.gate.ts, basis: covering.gate.basis,
      host: covering.gate.host, sources: [source],
      ...(covering.gate.delta_units ? { in_delta_scope: covering.gate.delta_units.includes(unitId) } : {}),
      class: cls ?? "unclassified",
    }
  if (cls) escape.classified_ts = ts
  if (extra?.found_by) escape.found_by = extra.found_by
  if (extra?.note) escape.note = extra.note
  phase.escapes.push(escape)
  if (phase.escapes.length > ESCAPE_RETENTION) phase.escapes = phase.escapes.slice(-ESCAPE_RETENTION)
  bumpEscapeTotals(phase, escape.basis, null, escape.class)
  return escape
}

/** Unclassified escapes in a phase, optionally for one unit. Array position is the order, never ts. */
export function unclassifiedEscapes(phase: Phase, unitId?: string): Escape[] {
  return (phase.escapes ?? []).filter((e) => e.class === "unclassified" && (unitId === undefined || e.unit_id === unitId))
}

/** Classify the newest unclassified escape on a unit. Returns it, or null when there is none. */
export function classifyEscape(
  phase: Phase, unitId: string, cls: EscapeClass, ts: string, extra?: { found_by?: EscapeFinder; note?: string }
): Escape | null {
  const open = unclassifiedEscapes(phase, unitId)
  const escape = open.at(-1)
  if (!escape) return null
  bumpEscapeTotals(phase, escape.basis, "unclassified", cls)
  escape.class = cls
  escape.classified_ts = ts
  if (extra?.found_by) escape.found_by = extra.found_by
  if (extra?.note) escape.note = extra.note
  return escape
}

// ─── Independence bound ──────────────────────────────────────────────────────

/**
 * Weak on every host for the weak set; on a Codex-host record an unreceipted
 * 'declared_external' is weak too (arbitration C2): there Foreman provides the receipted
 * path, and an unreceipted independent record cannot be told apart from relabelled native
 * output. On other hosts it is neutral: native does not exist there, so neither does the
 * erosion the bound targets.
 */
export function isWeakBasis(evidence: GateEvidence): boolean {
  return WEAK_BASES.has(evidence.basis) || (evidence.basis === "declared_external" && evidence.host === "codex")
}

export interface IndependenceDecision {
  weak: boolean
  reset: boolean
  /** A re-gate of a phase already in the streak neither spends nor resets. */
  already: boolean
  streak: number
  phases: string[]
  /** Set when the pass would exceed STREAK_MAX without an override. */
  refusal?: string
}

/** Evaluate the bound for one counted pass. Pure; the caller applies `commitIndependence`. */
export function independenceDecision(ledger: LedgerFile, phase: string, evidence: GateEvidence): IndependenceDecision {
  const s = ledger.independence ?? { streak: 0, phases: [] }
  const weak = isWeakBasis(evidence)
  const reset = RESET_BASES.has(evidence.basis)
  const already = s.phases.includes(phase)
  const decision: IndependenceDecision = { weak, reset, already, streak: s.streak, phases: s.phases }
  if (weak && !already && s.streak >= STREAK_MAX) {
    const hint = evidence.host === "codex" ? "invoke_advisor { cli: 'claude' | 'gemini' }" : "invoke_advisor { cli: 'codex' | 'gemini' }"
    decision.refusal =
      `INDEPENDENCE BOUND: phase '${phase}' would be counted pass #${s.streak + 1} on ${evidence.basis} review since the last receipted cross-vendor seat ` +
      `(prior: ${s.phases.join(", ") || "none"}; bound ${STREAK_MAX}). Run ${hint} and record it stage:'independent' with seat_receipt and packet_hash ` +
      "copied from its meta block, or set data.user_override: true (recorded on the phase as independence_override)."
  }
  return decision
}

/** Apply a decision after the pass is accepted (with or without an override). */
export function commitIndependence(ledger: LedgerFile, phase: string, decision: IndependenceDecision): void {
  if (decision.reset) {
    ledger.independence = { streak: 0, phases: [] }
  } else if (decision.weak && !decision.already) {
    ledger.independence = { streak: decision.streak + 1, phases: [...decision.phases, phase].slice(-(STREAK_MAX + 1)) }
  }
}

// ─── Owner-review triggers ───────────────────────────────────────────────────
// Rendered, never statistical, and none changes a gate rule by itself. Each names the
// change the owner would consider and the count that puts it on the table.

export const TRIGGER_T1_DEFECTS = 3
export const TRIGGER_T1_UNIT_GATES = 10
export const TRIGGER_T4_OVERRIDES = 3

export interface OutcomeAggregate {
  /** Per basis: first-gate unit count and defect-class escape count. */
  byBasis: Map<BasisClass | "legacy", { unitGates: number; defects: number }>
  declaredExternalOnCodex: number
  independenceOverrides: number
}

/** Fold every phase of a ledger into the counts the triggers read. Pure. */
export function aggregateOutcomes(ledger: LedgerFile): OutcomeAggregate {
  const byBasis = new Map<BasisClass | "legacy", { unitGates: number; defects: number }>()
  const bump = (basis: BasisClass | "legacy") => {
    const agg = byBasis.get(basis) ?? { unitGates: 0, defects: 0 }
    byBasis.set(basis, agg)
    return agg
  }
  let declaredExternalOnCodex = 0
  let independenceOverrides = 0
  for (const phase of Object.values(ledger.phases)) {
    for (const [basis, t] of Object.entries(phase.gate_totals ?? {}) as Array<[BasisClass, GateTotals]>) bump(basis).unitGates += t.units
    for (const e of phase.escapes ?? []) if (DEFECT_CLASSES.has(e.class)) bump(e.basis).defects += 1
    for (const g of phase.gate_history ?? []) if (g.basis === "declared_external" && g.host === "codex") declaredExternalOnCodex += 1
    if (phase.independence_override) independenceOverrides += 1
  }
  return { byBasis, declaredExternalOnCodex, independenceOverrides }
}

export function renderTriggers(agg: OutcomeAggregate): string[] {
  const lines: string[] = ["owner-review triggers:"]
  const weak: Array<BasisClass | "legacy"> = ["same_provider", "delta:same_provider", "declared_external", "delta:declared_external"]
  for (const basis of weak) {
    const a = agg.byBasis.get(basis)
    if (!a) continue
    const met = a.defects >= TRIGGER_T1_DEFECTS && a.unitGates >= TRIGGER_T1_UNIT_GATES
    lines.push(`  T1 ${basis} loses seat status: ${a.defects} defect escape(s) / ${a.unitGates} unit-gate(s) (needs >=${TRIGGER_T1_DEFECTS} and >=${TRIGGER_T1_UNIT_GATES}) — ${met ? "ON THE TABLE" : "not yet"}`)
  }
  lines.push(`  T2 receipts mandatory on codex: ${agg.declaredExternalOnCodex} unreceipted external gate(s) on a codex host — ${agg.declaredExternalOnCodex > 0 ? "ON THE TABLE" : "not yet"}`)
  lines.push("  T3 reviewer-rank rule (weight/threshold): precondition ABSENT — the host returns no served model or effort for native agents")
  lines.push(`  T4 bound constant or weak set: ${agg.independenceOverrides} independence override(s) (needs >=${TRIGGER_T4_OVERRIDES}) — ${agg.independenceOverrides >= TRIGGER_T4_OVERRIDES ? "ON THE TABLE" : "not yet"}`)
  return lines
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
  const escapes = new Map<BasisClass | "legacy", { defect: number; other: number; unclassified: number }>()
  const byClass: Partial<Record<EscapeClass, number>> = {}
  let gatedPhases = 0
  let countedPasses = 0
  let regates = 0
  let unclassified = 0
  const phaseRows: string[][] = []
  for (const [phaseId, phase] of phases) {
    if (phase.gate_history?.length) gatedPhases += 1
    for (const e of phase.escapes ?? []) {
      const agg = escapes.get(e.basis) ?? { defect: 0, other: 0, unclassified: 0 }
      if (e.class === "unclassified") { agg.unclassified += 1; unclassified += 1 }
      else if (DEFECT_CLASSES.has(e.class)) agg.defect += 1
      else agg.other += 1
      escapes.set(e.basis, agg)
      byClass[e.class] = (byClass[e.class] ?? 0) + 1
      if (phaseFilter) phaseRows.push([phaseId, e.unit_id, String(e.attempt), `#${e.gate_seq}`, e.basis, e.sources.join("+"), e.class, e.found_by ?? "-", e.note ?? ""])
    }
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
    escapes_unclassified: unclassified,
    independence: `streak ${ledger.independence?.streak ?? 0}/${STREAK_MAX}${ledger.independence?.phases.length ? ` (${ledger.independence.phases.join(", ")})` : ""}`,
    note: "Basis is what carried each counted gate pass; the seat rule itself is unchanged. Rates are per unit-gate over first gates. Escape counts are a floor: only contradictions written to the ledger are seen.",
  })
  const basisKeys: Array<BasisClass | "legacy"> = [
    ...BASIS_PRECEDENCE.filter((b) => totals.has(b) || escapes.has(b)),
    ...(escapes.has("legacy") ? ["legacy" as const] : []),
  ]
  const rows = basisKeys.map((basis) => {
    const t = basis === "legacy" ? undefined : totals.get(basis)
    const e = escapes.get(basis) ?? { defect: 0, other: 0, unclassified: 0 }
    const gates = t ? t.gates + t.regates : 0
    const perGate = t && gates > 0 ? (t.seat_agents / gates).toFixed(1) : "-"
    const hostMap = basis === "legacy" ? undefined : hosts.get(basis)
    const byHost = [...(hostMap ?? new Map<string, number>()).entries()].map(([h, n]) => `${h}:${n}`).join(" ") || "-"
    return [basis, t ? String(t.gates) : "-", t ? String(t.regates) : "-", t ? String(t.units) : "-", perGate,
      String(e.defect), String(e.other), String(e.unclassified),
      t ? `${k(t.tokens_receipted)}/${k(t.tokens_declared)}/${t.tokens_unreported}` : "-", byHost]
  })
  const table = rows.length > 0
    ? toTable(["basis", "gates", "regates", "units", "agents/gate", "esc(defect)", "other", "uncls", "tok(receipted/declared/unreported)", "hosts"], rows)
    : "no counted gate passes recorded since 0.6.19"
  const classes = (["original_defect", "remediation_defect", "test_gap", "process", "new_scope", "unclassified"] as EscapeClass[])
    .map((c) => `${c} ${byClass[c] ?? 0}`).join("  ")
  const footer = `escape classes: ${classes}`
  const detail = phaseFilter && phaseRows.length > 0
    ? "\n" + toTable(["phase", "unit", "attempt", "gate", "basis", "sources", "class", "found_by", "note"], phaseRows)
    : ""
  const scoped: LedgerFile = { ...ledger, phases: Object.fromEntries(phases) }
  const triggers = renderTriggers(aggregateOutcomes(scoped)).join("\n")
  return `${header}\n${table}\n${footer}${detail}\n${triggers}`
}
