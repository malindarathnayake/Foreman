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
  const declaredModel = model?.trim().toLowerCase() || null
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
      reuse_worker_bounded: weight === 3,
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
    workflow_permissions: Object.entries(modelRank.permissions).filter(([, allowed]) => allowed).map(([name]) => name).join(",") || "none",
  }
}
