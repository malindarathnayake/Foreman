import { z } from "zod"

// ─── Ledger Types ─────────────────────────────────────────────────────────────

export interface Rejection {
  r: string
  msg: string
  ts: string
}

export interface Unit {
  s: "pending" | "ip" | "done" | "fail"
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
  unit_id: z.string(),
  phase: z.string(),
  data: z.object({
    s: z.enum(["pending", "ip", "done", "fail"]),
  }),
})

const SetVerdictInput = z.object({
  operation: z.literal("set_verdict"),
  unit_id: z.string(),
  phase: z.string(),
  data: z.object({
    v: z.enum(["pass", "fail", "pending"]),
  }),
})

const AddRejectionInput = z.object({
  operation: z.literal("add_rejection"),
  unit_id: z.string(),
  phase: z.string(),
  data: z.object({
    r: z.string(),
    msg: z.string(),
    ts: z.string(),
  }),
})

const UpdatePhaseGateInput = z.object({
  operation: z.literal("update_phase_gate"),
  phase: z.string(),
  unit_id: z.string().optional(),
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
  unit_id: z.string().optional(),
  phase: z.string().optional(),
  query: z.enum(["verdicts", "rejections", "phase_gates", "full"]).optional(),
})

export type ReadLedgerInput = z.infer<typeof ReadLedgerInputSchema>

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
}

export interface TruncatedView {
  status: StatusSummary
  completed: ProgressUnit[]
  incomplete: ProgressUnit[]
  errors: ProgressError[]
}

// ─── write_progress Input Schema ─────────────────────────────────────────────

const UpdateStatusData = z.object({
  unit_id: z.string(),
  phase: z.string(),
  status: z.string(),
  notes: z.string(),
})

const CompleteUnitData = z.object({
  unit_id: z.string(),
  phase: z.string(),
  completed_at: z.string(),
  notes: z.string(),
})

const LogErrorData = z.object({
  date: z.string(),
  unit: z.string(),
  what_failed: z.string(),
  next_approach: z.string(),
})

const StartPhaseData = z.object({
  phase: z.string(),
  name: z.string(),
})

export const WriteProgressInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("update_status"), data: UpdateStatusData }),
  z.object({ operation: z.literal("complete_unit"), data: CompleteUnitData }),
  z.object({ operation: z.literal("log_error"), data: LogErrorData }),
  z.object({ operation: z.literal("start_phase"), data: StartPhaseData }),
])

export type WriteProgressInput = z.infer<typeof WriteProgressInputSchema>
