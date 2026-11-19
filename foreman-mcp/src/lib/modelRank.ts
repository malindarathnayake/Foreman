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
  /**
   * 0.9.7: the declared effort and the effort carried in the model id ("gemini-4-hydrogen-xhigh")
   * disagree. The declared effort wins; this flag is present only when they differ.
   */
  effort_conflict?: true
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
// "astra" and "gemini" entries are effort-gated: they rank only at the efforts their gate lists.
const MODELS = new Map<string, "astra" | "gemini" | 1 | 2 | 3>([
  ["astra", "astra"], ["gpt-6.2-astra", "astra"], ["gpt-6-astra", "astra"],
  // Host-emitted ids first (what a pitboss actually reports), display names after.
  ["claude-fable-5-2", 3], ["claude-fable-5.2", 3], ["fable 5.2", 3], ["fable5.2", 3], ["fable-5.2", 3],
  ["claude-fable-5-1", 3], ["claude-fable-5", 3], ["claude-fable-5.1", 3],
  ["fable 5.1", 3], ["fable5.1", 3], ["fable-5.1", 3],
  ["claude-opus-5-5", 2], ["claude-opus-5", 2], ["opus", 2], ["terra", 2], ["gpt-5.6-terra", 2],
  ["claude-sonnet-5", 1], ["sonnet", 1], ["claude-4.6-sonnet-medium-thinking", 1],
  ["luna", 1], ["gpt-5.6-luna", 1],
  // 0.9.7 (Antigravity host): Hydrogen and Argon rank middle only at high effort and above;
  // the Orchestrator has no effort knob and ranks middle outright. Carbon, Flash and gpt-oss
  // are deliberately unmapped.
  ["gemini-4-hydrogen", "gemini"], ["gemini-4-argon", "gemini"],
  // agy's served ids carry a "-tiered-" infix ("gemini-4-hydrogen-tiered-xhigh"), and that is
  // the id a pit-boss reads from its own transcript; the effort suffix still gates the rank.
  ["gemini-4-hydrogen-tiered", "gemini"],
  ["gemini-pro-orchestrator-g1-pro", 2],
])
const ASTRA_EFFORTS = new Set(["high", "xhigh", "max", "ultra"])
const GEMINI_EFFORTS = new Set(["high", "xhigh", "max"])
const EFFORT_LABEL = /\s*\((low|medium|high|xhigh|max)\)\s*$/
const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/
// Antigravity reports display labels ("Gemini 4 Hydrogen (XHigh)", "Orchestrator (Argon)").
// They map to the canonical ids after the effort label and context tail are stripped.
const DISPLAY_LABELS = new Map<string, string>([
  ["gemini 4 hydrogen", "gemini-4-hydrogen"],
  ["gemini 4 argon", "gemini-4-argon"],
  ["orchestrator", "gemini-pro-orchestrator-g1-pro"],
])

export function resolveModelRank(model?: string | null, effort?: string | null): ModelRank {
  let declaredModel = model?.trim().toLowerCase() || null
  // An Antigravity display label carries its effort in a trailing parenthesis; take it before
  // the context-suffix strip below would discard it.
  let labelEffort: string | null = null
  const label = declaredModel?.match(EFFORT_LABEL)
  if (declaredModel && label) {
    labelEffort = label[1]
    declaredModel = declaredModel.slice(0, label.index).trim()
  }
  // Hosts decorate the id with a context suffix ("claude-opus-5[1m]"); the suffix is not
  // part of the model and must not zero the rank. Strip bracketed and parenthesised tails.
  declaredModel = declaredModel?.replace(/\s*[\[(][^\])]*[\])]\s*$/, "").trim() || null
  if (declaredModel) declaredModel = DISPLAY_LABELS.get(declaredModel) ?? declaredModel
  // An id that is not a key may still be a key plus an effort suffix ("gemini-4-hydrogen-xhigh").
  let suffixEffort: string | null = null
  if (declaredModel && !MODELS.has(declaredModel)) {
    const suffix = declaredModel.match(EFFORT_SUFFIX)
    if (suffix && MODELS.has(suffix[1])) {
      declaredModel = suffix[1]
      suffixEffort = suffix[2]
    }
  }
  const explicitEffort = effort?.trim().toLowerCase() || null
  const declaredEffort = explicitEffort ?? suffixEffort ?? labelEffort
  const effortConflict = explicitEffort !== null && suffixEffort !== null && explicitEffort !== suffixEffort
  const entry = declaredModel ? MODELS.get(declaredModel) : undefined
  const weight = entry === "astra" ? (ASTRA_EFFORTS.has(declaredEffort ?? "") ? 3 : 0)
    : entry === "gemini" ? (GEMINI_EFFORTS.has(declaredEffort ?? "") ? 2 : 0)
    : entry ?? 0
  return {
    model: declaredModel,
    effort: declaredEffort,
    rank: weight === 3 ? "top" : weight === 2 ? "middle" : weight === 1 ? "standard" : "unknown",
    weight,
    ...(effortConflict ? { effort_conflict: true as const } : {}),
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
      ? "you are a frontier orchestrator — do not spawn frontier workers by default: implementation goes to foreman-worker (standard), foreman-worker-light for a fully specified edit, and foreman-worker-heavy only for concurrency, migrations, error-handling semantics, public contracts or security paths, or a unit a lower seat already failed; foreman-worker-frontier only after a rejected premium attempt (Claude Code; the ledger enforces it). Each seat carries its own model AND reasoning effort; spawn by subagent_type and pass neither"
      : "seat per unit: foreman-worker-light (cheap) / foreman-worker (standard) / foreman-worker-heavy (premium) / foreman-worker-frontier (frontier, after a rejected premium attempt); below premium, escalate only on evidence cited in route_reason",
  }
}
