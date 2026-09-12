import path from "path"
import { WriteLedgerInputSchema, LedgerOperationDataSchemas, LedgerSoftLimits, type WriteLedgerInput, type LedgerFile } from "../types.js"
import { writeLedger } from "../lib/ledger.js"
import { formatSchemaError, isZodError } from "../lib/schemaError.js"
import { toKeyValue } from "../lib/toon.js"
import { appendEvent, boundIdentifier, openDelegation, followUpEventInput, type SidecarEventInput } from "../lib/eventsSidecar.js"
import { drainCcrStats } from "../lib/compression.js"
import type { HostId } from "../lib/hostProfiles.js"
import { resolveModelRank, type ModelRank } from "../lib/modelRank.js"
import { softLimitWarning } from "../lib/softLimits.js"

/**
 * Validates input with Zod schema, delegates to lib/ledger.ts,
 * returns TOON key/value confirmation.
 */
export async function handleWriteLedger(filePath: string, rawInput: unknown, host: HostId = "claude-code", modelRank: ModelRank = resolveModelRank(), context?: { specPath?: string; projectRoot?: string }): Promise<string> {
  let parsed: WriteLedgerInput
  try {
    parsed = WriteLedgerInputSchema.parse(rawInput)
  } catch (err) {
    if (isZodError(err)) throw new Error(formatSchemaError("write_ledger", err, rawInput, LedgerOperationDataSchemas))
    throw err
  }
  // 0.6.20: soft-limited fields the schema cut are reported, never refused.
  const truncated = softLimitWarning(rawInput, parsed, LedgerSoftLimits[parsed.operation] ?? [])
  const { ledger, warning } = await writeLedger(filePath, parsed, foldCcrStats, undefined, host, modelRank, undefined, context)

  // Return confirmation with key details
  const result: Record<string, string> = {
    operation: parsed.operation,
    phase: parsed.phase,
    unit_id: ("unit_id" in parsed ? parsed.unit_id : "n/a") ?? "n/a",
    timestamp: ledger.ts,
    status: "ok",
  }
  const combined = [warning, truncated].filter(Boolean).join(" | ")
  if (combined) result.warning = combined
  // 0.6.21: a delegation's attempt id is what the worker's heartbeat and close_attempt name.
  if (parsed.operation === "set_unit_status" && parsed.data.s === "delegated") {
    result.attempt = String(ledger.phases[parsed.phase]?.units[parsed.unit_id]?.attempt_seq ?? 0)
  }

  // ─── R3 sidecar hook (Unit 4g) ────────────────────────────────────────────
  // Runs strictly AFTER the `writeLedger` call above has already succeeded and
  // been folded into `result` — this ordering (sidecar-after-ledger by
  // construction) means a sidecar failure can never mask or precede the
  // ledger write's own confirmation.
  await appendTerminalSidecarEvent(filePath, parsed, result)

  return toKeyValue(result)
}

// ─── S6 CCR evidence fold (Unit 5b) ────────────────────────────────────────────
// Folds pending compression aggregates into the ledger on every successful write.
// The drain happens HERE, inside the write itself, so a rejected/throwing ledger
// operation never discards pending stats. In-memory pending is best-effort: stats
// accumulated since the last write_ledger call are lost on process restart.
// Bounded: keys come from the compression allowlist — never per-call entries.
function foldCcrStats(ledger: LedgerFile): void {
  const pending = drainCcrStats()
  const names = Object.keys(pending)
  if (names.length === 0) return
  ledger.ccr_stats ??= {}
  for (const name of names) {
    const p = pending[name]
    const agg = (ledger.ccr_stats[name] ??= { calls: 0, tokens_before: 0, tokens_after: 0 })
    agg.calls += p.calls
    agg.tokens_before += p.tokens_before
    agg.tokens_after += p.tokens_after
  }
}

// ─── R3 emission map (exhaustive) ──────────────────────────────────────────────
// Maps a successful ledger write to the terminal sidecar event it closes out, if
// any. Every ledger operation other than add_rejection/set_verdict/set_unit_status
// (data.rejection, 0.6.20) — and every value of those not listed below — is a no-op.
function mapToTerminalEvent(
  operation: WriteLedgerInput
): { eventType: SidecarEventInput["event_type"]; extra: Partial<SidecarEventInput> } | null {
  switch (operation.operation) {
    case "add_rejection": {
      const r = operation.data.r
      if (r === "ED_STALE" || r === "PATCH_APPLY_FAIL") {
        return { eventType: "patch_checked", extra: { failure_stage: r, outcome: "fail" } }
      }
      if (r === "BLD_ERR") {
        return { eventType: "validation_completed", extra: { failure_stage: "BLD_ERR", outcome: "fail" } }
      }
      return null
    }
    case "set_unit_status": {
      // 0.6.20: an inline rejection closes an open invoke_worker chain the way add_rejection
      // does; otherwise the gate's discipline check would find no terminal event.
      const r = operation.data.rejection?.r
      if (r === "ED_STALE" || r === "PATCH_APPLY_FAIL") {
        return { eventType: "patch_checked", extra: { failure_stage: r, outcome: "fail" } }
      }
      if (r === "BLD_ERR") {
        return { eventType: "validation_completed", extra: { failure_stage: "BLD_ERR", outcome: "fail" } }
      }
      return null
    }
    case "set_verdict": {
      const v = operation.data.v
      if (v === "fail") {
        return { eventType: "validation_completed", extra: { failure_stage: "W_REJ", outcome: "fail" } }
      }
      if (v === "inconclusive") {
        return { eventType: "validation_completed", extra: { outcome: "inconclusive" } }
      }
      if (v === "pass") {
        return { eventType: "validation_completed", extra: { outcome: "pass" } }
      }
      return null
    }
    default:
      return null
  }
}

/**
 * Closes out an OPEN S7 delegation's hash chain after a successful ledger write —
 * the terminal event that `invoke_worker`'s own chain (delegation_started /
 * worker_completed / patch_checked) never appends itself. NEVER throws into the
 * ledger write path: any failure here (including a corrupt/tampered sidecar)
 * degrades to `result.sidecar_warning` and returns normally, because the ledger
 * write has already committed and its confirmation must stand regardless.
 */
async function appendTerminalSidecarEvent(
  ledgerFilePath: string,
  operation: WriteLedgerInput,
  result: Record<string, string>
): Promise<void> {
  try {
    const mapped = mapToTerminalEvent(operation)
    if (!mapped) return
    if (!("unit_id" in operation) || !operation.unit_id || !operation.phase) return
    const { phase, unit_id } = operation

    // [CWE-20] invoke_worker stores phase/unit_id in the sidecar envelope through
    // boundIdentifier (the envelope caps identifiers at 64 chars). Bound the join key the
    // same way here so a legal long id still matches the open delegation instead of
    // silently missing it and leaving the chain unterminated.
    const boundedPhase = boundIdentifier(phase)
    const boundedUnitId = boundIdentifier(unit_id)

    // The sidecar lives alongside the ledger file — both live in the docs dir —
    // so the ledger path's directory IS the docs dir. Derived here (rather than
    // threaded through as a param) so this unit never has to touch server.ts.
    const sidecarPath = path.join(path.dirname(ledgerFilePath), ".foreman-events.jsonl")

    const open = await openDelegation(sidecarPath, boundedPhase, boundedUnitId)
    if (!open) return // absent sidecar, no delegation for this unit, or already terminal — native-worker no-op

    await appendEvent(sidecarPath, followUpEventInput(open.lastEvent, mapped.eventType, mapped.extra))
  } catch (err) {
    result.sidecar_warning = (err as Error).message
  }
}
