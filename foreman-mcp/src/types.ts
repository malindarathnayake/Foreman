import { z } from "zod"

// ─── Ledger Types ─────────────────────────────────────────────────────────────

export interface Rejection {
  r: string
  msg: string
  ts: string
}

export interface Unit {
  s: "pending" | "ip" | "delegated" | "done" | "fail"
  v: "pass" | "fail" | "pending"
  w: string | null
  rej: Rejection[]
}

export interface Phase {
  s: "ip" | "done" | "blocked"
  g: "pass" | "fail" | "pending"
  units: Record<string, Unit>
}

export interface LedgerFile {
  v: number
  ts: string
  phases: Record<string, Phase>
}

// ─── Zod Schemas for MCP Tool Input Validation ───────────────────────────────

const SetUnitStatusInput = z.object({
  operation: z.literal("set_unit_status"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    s: z.enum(["pending", "ip", "delegated", "done", "fail"]),
    brief: z.string().max(50000).optional(),
  }),
})

const SetVerdictInput = z.object({
  operation: z.literal("set_verdict"),
  unit_id: z.string().max(10000),
  phase: z.string().max(10000),
  data: z.object({
    v: z.enum(["pass", "fail", "pending"]),
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
  }),
})

const UpdatePhaseGateInput = z.object({
  operation: z.literal("update_phase_gate"),
  phase: z.string().max(10000),
  unit_id: z.string().max(10000).optional(),
  data: z.object({
    g: z.enum(["pass", "fail", "pending"]),
  }),
})

export const WriteLedgerInputSchema = z.discriminatedUnion("operation", [
  SetUnitStatusInput,
  SetVerdictInput,
  AddRejectionInput,
  UpdatePhaseGateInput,
])

export type WriteLedgerInput = z.infer<typeof WriteLedgerInputSchema>

export const ReadLedgerInputSchema = z.object({
  unit_id: z.string().max(10000).optional(),
  phase: z.string().max(10000).optional(),
  query: z.enum(["verdicts", "rejections", "phase_gates", "full"]).optional(),
})

export type ReadLedgerInput = z.infer<typeof ReadLedgerInputSchema>

export const NormalizeReviewInputSchema = z.object({
  reviewer: z.string().max(200),
  raw_text: z.string().max(50000),
})
export type NormalizeReviewInput = z.infer<typeof NormalizeReviewInputSchema>

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
  session_hint: string
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

export const WriteProgressInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("update_status"), data: UpdateStatusData }),
  z.object({ operation: z.literal("complete_unit"), data: CompleteUnitData }),
  z.object({ operation: z.literal("log_error"), data: LogErrorData }),
  z.object({ operation: z.literal("start_phase"), data: StartPhaseData }),
])

export type WriteProgressInput = z.infer<typeof WriteProgressInputSchema>

// ─── Journal Types ──────────────────────────────────────────────────────────

export interface JournalEnv {
  os: string
  node: string
  foreman: string
  agent: string
  worker: string
  codex: string | null
  gemini: string | null
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
  id: string
  ts: string
  branch: string
  phase: number
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

export const JournalEventCode = z.enum([
  "W_FAIL", "W_REJ", "W_RETRY", "W_DRIFT",
  "CX_ERR", "CX_FP",
  "ED_FAIL", "ED_STALE",
  "T_FLAKE", "T_INFRA",
  "BLD_ERR", "CTX_OVF", "CTX_COMP",
  "SPEC_AMB", "GATE_FIX", "TOOL_ERR",
  "USR_INT", "MODEL_DEG", "PERM_DENY",
  "HOOK_BLOCK", "DEP_MISS", "SCHEMA_DRIFT", "MERGE_CONF",
])

const InitSessionData = z.object({
  target_version: z.string().max(20),
  branch: z.string().max(200),
  phase: z.number().min(1).max(100),
  units: z.array(z.string().max(100)).max(50),
  env: z.object({
    agent: z.string().max(100),
    worker: z.string().max(100),
    codex: z.string().max(50).nullable(),
    gemini: z.string().max(50).nullable(),
  }),
})

const LogEventData = z.object({
  t: JournalEventCode,
  u: z.string().max(200),
  tok: z.number().min(0),
  msg: z.string().max(200),
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
  z.object({ operation: z.literal("log_event"), data: LogEventData }),
  z.object({ operation: z.literal("end_session"), data: EndSessionData }),
])

export type WriteJournalInput = z.infer<typeof WriteJournalInputSchema>

export const ReadJournalInputSchema = z.object({
  last_n: z.number().min(1).max(100).optional(),
  rollup_only: z.boolean().optional(),
})

export type ReadJournalInput = z.infer<typeof ReadJournalInputSchema>
