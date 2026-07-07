// Unit 5a. Every number rendered here is recomputed from the events-sidecar JSONL
// lines on EVERY call — never trusted from ledger rollups (D5/D8). The ledger is
// consulted for exactly one purpose: the drift check at the bottom, which never
// feeds back into any count or denominator above it.

import { readEvents, type SidecarEvent, type FailureStage, type Tier, type Outcome } from "./eventsSidecar.js"
import { toTable } from "./toon.js"
import type { LedgerFile } from "../types.js"

// ─── Normative stage → code mapping ───────────────────────────────────────────
const PRESEND_CODES = new Set<FailureStage>([
  "BRIEF_TOO_LARGE",
  "WORKER_PAYLOAD_SECRET_BLOCK",
  "WORKER_UNREACHABLE",
  "WORKER_TIMEOUT",
  "WORKER_AUTH_FAIL",
  "WORKER_QUOTA_FAIL",
  "WORKER_MODEL_NOT_FOUND",
])

const STAGE0_CODES = new Set<FailureStage>(["WORKER_GHOST", "WORKER_RESPONSE_TOO_LARGE", "MODEL_SCHEMA_FAIL"])

const PARSE_APPLY_CODES = new Set<FailureStage>([
  "PATCH_PARSE_FAIL",
  "PATCH_REDACTION_MARKER_FAIL",
  "PATCH_PROTECTED_PATH_FAIL",
  "ED_STALE",
  "PATCH_APPLY_FAIL",
])

const BUILD_CODES = new Set<FailureStage>(["BLD_ERR"])
const SEMANTIC_CODES = new Set<FailureStage>(["W_REJ"])

const TIER_ORDER: Record<Tier, number> = { cheap: 0, standard: 1, premium: 2 }

// ─── Delegation grouping ────────────────────────────────────────────────────────
interface DelegationGroup {
  delegationId: string
  events: SidecarEvent[]
  phase: string
  unitId: string
  tier: Tier
  model: string
  terminal: boolean
  outcome?: Outcome
  /** Only set for terminal groups: last event's failure_stage, else the last event carrying one. */
  failureStage?: FailureStage
}

function buildGroups(events: SidecarEvent[]): DelegationGroup[] {
  const map = new Map<string, DelegationGroup>()
  const order: string[] = []
  for (const e of events) {
    let g = map.get(e.delegation_id)
    if (!g) {
      g = {
        delegationId: e.delegation_id,
        events: [],
        phase: e.phase,
        unitId: e.unit_id,
        tier: e.tier,
        model: e.model,
        terminal: false,
      }
      map.set(e.delegation_id, g)
      order.push(e.delegation_id)
    }
    g.events.push(e)
  }
  for (const g of map.values()) {
    const last = g.events[g.events.length - 1]
    g.terminal = last.outcome !== undefined
    g.outcome = last.outcome
    if (g.terminal) {
      g.failureStage = last.failure_stage
      if (g.failureStage === undefined) {
        for (let i = g.events.length - 2; i >= 0; i--) {
          if (g.events[i].failure_stage !== undefined) {
            g.failureStage = g.events[i].failure_stage
            break
          }
        }
      }
    }
  }
  return order.map((id) => map.get(id) as DelegationGroup)
}

type StageClass = "stage0" | "parse_apply" | "build" | "semantic" | "defensive" | "clean"

function classify(g: DelegationGroup): StageClass {
  const fs = g.failureStage
  if (fs !== undefined && STAGE0_CODES.has(fs)) return "stage0"
  if (fs !== undefined && PARSE_APPLY_CODES.has(fs)) return "parse_apply"
  if (fs !== undefined && BUILD_CODES.has(fs)) return "build"
  if (fs !== undefined && SEMANTIC_CODES.has(fs)) return "semantic"
  if (fs === undefined && g.outcome === "fail") return "defensive"
  return "clean"
}

// ─── Formatting helpers ─────────────────────────────────────────────────────────
function pct(num: number, denom: number): string {
  if (denom === 0) return "n/a"
  return `${((100 * num) / denom).toFixed(1)}%`
}

function sortStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function histogram(gs: DelegationGroup[]): string {
  const counts = new Map<string, number>()
  for (const g of gs) {
    if (g.failureStage === undefined) continue
    counts.set(g.failureStage, (counts.get(g.failureStage) ?? 0) + 1)
  }
  if (counts.size === 0) return "-"
  return Array.from(counts.entries())
    .sort((a, b) => sortStrings(a[0], b[0]))
    .map(([code, count]) => `${code}:${count}`)
    .join(",")
}

// ─── Main entry point ───────────────────────────────────────────────────────────
export async function renderDelegationMetrics(ledger: LedgerFile, sidecarPath: string): Promise<string> {
  let readResult: { events: SidecarEvent[]; absent?: boolean; warning?: string }
  try {
    readResult = await readEvents(sidecarPath)
  } catch (err) {
    return `error: sidecar_corrupt\ndetail: ${(err as Error).message}`
  }

  const { events, absent, warning } = readResult
  const groups = buildGroups(events)

  const openGroups = groups.filter((g) => !g.terminal)
  const terminalGroups = groups.filter((g) => g.terminal)
  const refundedGroups = terminalGroups.filter(
    (g) => g.failureStage !== undefined && PRESEND_CODES.has(g.failureStage)
  )
  const refundedIds = new Set(refundedGroups.map((g) => g.delegationId))
  const countedGroups = terminalGroups.filter((g) => !refundedIds.has(g.delegationId))
  const countedIds = new Set(countedGroups.map((g) => g.delegationId))

  const passes = countedGroups.filter((g) => g.outcome === "pass")
  const inconclusive = countedGroups.filter((g) => g.outcome === "inconclusive")
  const ghosts = countedGroups.filter((g) => g.failureStage === "WORKER_GHOST")

  // ── Stage-survival chain ──────────────────────────────────────────────────
  const stage0Failures = countedGroups.filter((g) => classify(g) === "stage0")
  const defensiveUnstaged = countedGroups.filter((g) => classify(g) === "defensive")
  const stage0Survivors = countedGroups.filter((g) => {
    const c = classify(g)
    return c !== "stage0" && c !== "defensive"
  })
  const parseApplyFailures = stage0Survivors.filter((g) => classify(g) === "parse_apply")
  const cleanApplies = stage0Survivors.filter((g) => classify(g) !== "parse_apply")
  const cleanAppliesIds = new Set(cleanApplies.map((g) => g.delegationId))
  const buildFailures = cleanApplies.filter((g) => classify(g) === "build")
  const cleanBuilds = cleanApplies.filter((g) => classify(g) !== "build")
  const semanticFailures = cleanBuilds.filter((g) => classify(g) === "semantic")
  const semanticPasses = cleanBuilds.filter((g) => g.outcome === "pass")

  const stage0Survived = countedGroups.length - stage0Failures.length - defensiveUnstaged.length
  const parseApplySurvived = stage0Survivors.length - parseApplyFailures.length
  const buildSurvived = cleanApplies.length - buildFailures.length
  const semanticSurvived = semanticPasses.length

  // ── Header block ───────────────────────────────────────────────────────────
  const headerLines: string[] = []
  headerLines.push(absent ? "sidecar: absent" : "sidecar: present")
  if (!absent && warning) headerLines.push(`sidecar_warning: ${warning}`)
  headerLines.push(`delegations: ${groups.length}`)
  headerLines.push(`open: ${openGroups.length}`)
  headerLines.push(`refunded: ${refundedGroups.length}`)
  headerLines.push(`counted: ${countedGroups.length}`)
  headerLines.push(`task_success: ${passes.length}/${countedGroups.length} (${pct(passes.length, countedGroups.length)})`)
  headerLines.push(`inconclusive: ${inconclusive.length}`)
  headerLines.push(`ghosts: ${ghosts.length}`)

  // ── STAGE SURVIVAL ──────────────────────────────────────────────────────────
  const stageTable = toTable(
    ["stage", "denominator", "denom", "survived", "pct", "failures"],
    [
      [
        "stage0_model_discipline",
        "counted delegations",
        String(countedGroups.length),
        String(stage0Survived),
        pct(stage0Survived, countedGroups.length),
        histogram(stage0Failures),
      ],
      [
        "parse_apply",
        "stage-0 survivors",
        String(stage0Survivors.length),
        String(parseApplySurvived),
        pct(parseApplySurvived, stage0Survivors.length),
        histogram(parseApplyFailures),
      ],
      [
        "build",
        "clean applies",
        String(cleanApplies.length),
        String(buildSurvived),
        pct(buildSurvived, cleanApplies.length),
        histogram(buildFailures),
      ],
      [
        "semantic",
        "clean builds",
        String(cleanBuilds.length),
        String(semanticSurvived),
        pct(semanticSurvived, cleanBuilds.length),
        histogram(semanticFailures),
      ],
    ]
  )

  // ── REFUNDED ─────────────────────────────────────────────────────────────────
  const refundedCounts = new Map<string, number>()
  for (const g of refundedGroups) {
    const code = g.failureStage as string
    refundedCounts.set(code, (refundedCounts.get(code) ?? 0) + 1)
  }
  const refundedRows = Array.from(refundedCounts.entries())
    .sort((a, b) => sortStrings(a[0], b[0]))
    .map(([code, count]) => [code, String(count)])
  const refundedTable = toTable(["code", "count"], refundedRows)

  // ── SCORECARD ───────────────────────────────────────────────────────────────
  interface PairBucket {
    tier: Tier
    model: string
    list: DelegationGroup[]
  }
  const pairMap = new Map<string, PairBucket>()
  for (const g of groups) {
    const key = `${g.tier} ${g.model}`
    let bucket = pairMap.get(key)
    if (!bucket) {
      bucket = { tier: g.tier, model: g.model, list: [] }
      pairMap.set(key, bucket)
    }
    bucket.list.push(g)
  }
  const pairs = Array.from(pairMap.values()).sort(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || sortStrings(a.model, b.model)
  )
  const scorecardRows: string[][] = []
  for (const { tier, model, list } of pairs) {
    const refundedInPair = list.filter((g) => refundedIds.has(g.delegationId))
    const countedInPair = list.filter((g) => countedIds.has(g.delegationId))
    const cleanAppliesInPair = countedInPair.filter((g) => cleanAppliesIds.has(g.delegationId))
    const passesInPair = countedInPair.filter((g) => g.outcome === "pass")
    const ghostsInPair = countedInPair.filter((g) => g.failureStage === "WORKER_GHOST")
    scorecardRows.push([
      tier,
      model,
      String(list.length),
      String(refundedInPair.length),
      pct(cleanAppliesInPair.length, countedInPair.length),
      pct(passesInPair.length, countedInPair.length),
      String(ghostsInPair.length),
      histogram(countedInPair),
    ])
  }
  const scorecardTable = toTable(
    ["tier", "model", "delegations", "refunded", "patch_apply_pct", "task_success_pct", "ghosts", "failure_stages"],
    scorecardRows
  )

  // ── WORKER_CONFIDENCE ────────────────────────────────────────────────────────
  interface ConfEntry {
    confidence: number
    outcome: Outcome
    count: number
  }
  const confMap = new Map<string, ConfEntry>()
  for (const g of countedGroups) {
    let conf: number | undefined
    for (let i = g.events.length - 1; i >= 0; i--) {
      if (g.events[i].worker_confidence !== undefined) {
        conf = g.events[i].worker_confidence
        break
      }
    }
    if (conf === undefined || g.outcome === undefined) continue
    const key = `${conf} ${g.outcome}`
    const existing = confMap.get(key)
    if (existing) {
      existing.count++
    } else {
      confMap.set(key, { confidence: conf, outcome: g.outcome, count: 1 })
    }
  }
  const confRows = Array.from(confMap.values())
    .sort((a, b) => a.confidence - b.confidence || sortStrings(a.outcome, b.outcome))
    .map((entry) => [String(entry.confidence), entry.outcome, String(entry.count)])
  const confidenceTable = toTable(["confidence", "outcome", "count"], confRows)

  // ── Drift check (ledger consulted ONLY here; never feeds back into any count above) ──
  // Keyed on unit.v (verdict), never on unit.s (status): set_verdict (ledger.ts) mutates
  // only v/v_ts/via/note and never touches s, so a healthy completed S7 delegation leaves
  // s:"delegated" forever after a pass/fail verdict — consulting s here would false-positive
  // on every normal completion. The two real drift shapes are: (1) ledger behind sidecar —
  // sidecar shows a terminal delegation but the unit's verdict is still pending/missing; (2)
  // sidecar behind ledger — the unit already has a resolved verdict but its latest sidecar
  // delegation for that unit never reached a terminal event (append likely degraded; see
  // sidecar_warning above). An outcome-vs-verdict VALUE mismatch (e.g. sidecar says fail,
  // unit says pass) is explicitly NOT drift — a legitimate history where an S7 delegation
  // failed terminal and the pitboss re-delegated via a native worker, which writes no
  // sidecar events, and the unit legitimately reached v:"pass".
  interface UnitBucket {
    phase: string
    unitId: string
    groups: DelegationGroup[]
  }
  const byUnit = new Map<string, UnitBucket>()
  for (const g of groups) {
    const key = `${g.phase} ${g.unitId}`
    let bucket = byUnit.get(key)
    if (!bucket) {
      bucket = { phase: g.phase, unitId: g.unitId, groups: [] }
      byUnit.set(key, bucket)
    }
    bucket.groups.push(g)
  }

  const driftLines: string[] = []
  for (const { phase, unitId, groups: unitGroups } of byUnit.values()) {
    const latest = unitGroups[unitGroups.length - 1]
    const unit = ledger.phases[phase]?.units[unitId]
    const verdictText = unit ? unit.v : "missing"
    if (latest.terminal) {
      // Ledger behind sidecar: a terminal delegation whose unit has no matching verdict yet.
      // (Covers both spec cases — "delegated units with terminal events" and "terminal events
      // without matching verdicts" — which are the same join keyed on v. An outcome-vs-verdict
      // VALUE mismatch is NOT drift: after a terminal S7 failure the pitboss may re-delegate
      // via a native worker, which writes no sidecar events, and legitimately reach v:'pass'.)
      if (!unit || unit.v === "pending") {
        driftLines.push(
          `drift_warning: delegation ${latest.delegationId} terminal (${latest.outcome}) but unit ${phase}/${unitId} has verdict ${verdictText}`
        )
      }
    } else {
      // Sidecar behind ledger: the unit was resolved while its latest delegation chain never
      // closed — the write-ledger hook's sidecar append degraded (sidecar_warning path).
      // NOTE: set_verdict does not mutate unit.s, so 's' is meaningless here — key on v.
      if (!unit || unit.v !== "pending") {
        driftLines.push(
          `drift_warning: delegation ${latest.delegationId} open in sidecar but unit ${phase}/${unitId} already has verdict ${verdictText}`
        )
      }
    }
  }
  for (const g of defensiveUnstaged) {
    driftLines.push(`drift_warning: delegation ${g.delegationId} terminal fail without failure_stage`)
  }
  driftLines.sort(sortStrings)

  // ── Assemble ─────────────────────────────────────────────────────────────────
  const blocks: string[] = [
    headerLines.join("\n"),
    `STAGE SURVIVAL (conditional rates, explicit denominators; refunded excluded)\n${stageTable}`,
    `REFUNDED (excluded from all scorecards)\n${refundedTable}`,
    `SCORECARD (per tier+model; refunded excluded from all denominators)\n${scorecardTable}`,
    `WORKER_CONFIDENCE (advisory-only, never gates)\n${confidenceTable}`,
  ]
  if (driftLines.length > 0) {
    blocks.push(driftLines.join("\n"))
  }
  return blocks.join("\n\n")
}
