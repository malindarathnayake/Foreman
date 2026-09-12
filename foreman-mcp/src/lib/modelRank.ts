/** Declared orchestration policy, separate from worker/reviewer capability classes. */
export interface ModelRankPermissions {
  reuse_worker_mechanical: boolean
  reuse_worker_bounded: boolean
  compact_followup: boolean
  focused_validation: boolean
  delta_review: boolean
}

export interface ModelRank {
  model: string | null
  effort: string | null
  rank: "top" | "middle" | "standard" | "unknown"
  weight: 0 | 1 | 2 | 3
  policy_version: 1
  permissions: ModelRankPermissions
  /** Current journal session; absent until this server receives init_session. */
  session_id?: string
  /**
   * 0.6.27: this rank was read back from the journal after a restart rather than declared to
   * this process. Present only on a rehydrated rank, and always reported, because the operator
   * may have changed model during the restart and Foreman cannot tell.
   */
  rehydrated?: { session_id: string; session_ts: string }
}

// Explicit policy aliases only. A new provider version requires an intentional mapping.
const MODELS = new Map<string, "astra" | 1 | 2 | 3>([
  ["astra", "astra"], ["gpt-6-astra", "astra"],
  // Host-emitted ids first (what a pitboss actually reports), display names after.
  ["claude-fable-5-1", 3], ["claude-fable-5", 3], ["claude-fable-5.1", 3],
  ["fable 5.1", 3], ["fable5.1", 3], ["fable-5.1", 3],
  ["claude-opus-5", 2], ["opus", 2], ["terra", 2], ["gpt-5.6-terra", 2],
  ["claude-sonnet-5", 1], ["sonnet", 1], ["claude-4.6-sonnet-medium-thinking", 1],
  ["luna", 1], ["gpt-5.6-luna", 1],
])
const ASTRA_EFFORTS = new Set(["high", "xhigh", "max", "ultra"])

export function resolveModelRank(model?: string | null, effort?: string | null): ModelRank {
  // Hosts decorate the id with a context suffix ("claude-opus-5[1m]"); the suffix is not
  // part of the model and must not zero the rank. Strip bracketed and parenthesised tails.
  const declaredModel = model?.trim().toLowerCase().replace(/\s*[\[(][^\])]*[\])]\s*$/, "").trim() || null
  const declaredEffort = effort?.trim().toLowerCase() || null
  const entry = declaredModel ? MODELS.get(declaredModel) : undefined
  const weight = entry === "astra" ? (ASTRA_EFFORTS.has(declaredEffort ?? "") ? 3 : 0) : entry ?? 0
  return {
    model: declaredModel,
    effort: declaredEffort,
    rank: weight === 3 ? "top" : weight === 2 ? "middle" : weight === 1 ? "standard" : "unknown",
    weight,
    policy_version: 1,
    permissions: {
      reuse_worker_mechanical: weight >= 2,
      // 0.6.26 (field report 2026-09-11): middle rank was mechanical-only, so a BEHAVIOURAL
      // correction forced a fresh worker carrying none of the previous attempt's context —
      // strictly more risk than reusing the worker that had just done the work. The policy
      // was choosing the riskier option in the name of caution. Reuse is not the loose path
      // here: the ledger already requires the same declared session, the same recorded
      // worker id, a cleared ownership guard on the previous attempt, a non-hot-path and
      // non-security-boundary phase, and correction.files inside that attempt's frozen
      // authorized set — and it is still an outer attempt against the failure cap. Top rank
      // keeps the wider allowance (focused_validation, delta_review) that is genuinely
      // rank-sensitive.
      reuse_worker_bounded: weight >= 2,
      compact_followup: weight >= 2,
      focused_validation: weight === 3,
      delta_review: weight === 3,
    },
  }
}

/** Shared flat representation for read-only host, orientation and progress views. */
export function modelRankSummary(modelRank: ModelRank): Record<string, string | number> {
  return {
    declared_model: modelRank.model ?? "unknown",
    declared_effort: modelRank.effort ?? "unknown",
    model_rank: modelRank.rank,
    model_weight: modelRank.weight,
    model_rank_policy: modelRank.policy_version,
    model_rank_session: modelRank.session_id ?? "none",
    model_rank_source: modelRank.rehydrated
      ? `rehydrated from session ${modelRank.rehydrated.session_id} (declared ${modelRank.rehydrated.session_ts}) — orientation only, NO workflow permissions until write_journal declare_model confirms the current model`
      : "declared",
    workflow_permissions: Object.entries(modelRank.permissions).filter(([, allowed]) => allowed).map(([name]) => name).join(",") || "none",
    // 0.6.28: a top-rank orchestrator is the expensive seat in the room, and the cost of it
    // spawning its own class for ordinary implementation compounds over a phase. The rank already
    // decides workflow permissions; it should also say what the WORKER seat defaults to. Rank-keyed,
    // not model-keyed, so Astra at xhigh gets the same reminder Fable does.
    seat_guidance: modelRank.weight === 3
      ? "you are a frontier orchestrator — do not spawn frontier workers by default: implementation goes to foreman-worker (standard), foreman-worker-light for a fully specified edit, and foreman-worker-heavy only for concurrency, migrations, error-handling semantics, public contracts or security paths, or a unit a lower seat already failed"
      : "seat per unit: foreman-worker-light (cheap) / foreman-worker (standard) / foreman-worker-heavy (premium); escalate only on evidence cited in route_reason",
  }
}
