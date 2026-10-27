/** Legacy gate fixtures represent an owner-approved exception. Supply the newly
 * required provenance and fact link explicitly; negative authority tests use the
 * production writers directly (fieldFeedback2026-10-13.test.ts). Legacy passing
 * worker fixtures also supply a synthetic host observation of their pinned model.
 */
import { writeLedger as rawWriteLedger, readLedger } from "../../src/lib/ledger.js"
import { handleWriteLedger as rawHandleWriteLedger } from "../../src/tools/writeLedger.js"

async function withOwnerDecision(file: string, input: unknown): Promise<unknown> {
  const op = structuredClone(input) as { operation?: string; phase?: string; unit_id?: string; data?: { v?: string; worker_model?: string; user_override?: boolean; authority?: string } }
  if (op?.operation === "set_verdict" && op.data?.v === "pass" && !op.data.worker_model && op.phase && op.unit_id) {
    const unit = (await readLedger(file, { readOnly: true })).phases[op.phase]?.units[op.unit_id]
    const d = unit?.delegations?.find((d) => d.attempt === unit.attempt_seq)
    if (d?.required_model) Object.assign(op.data, { worker_model: d.required_model, model_evidence: "Synthetic host-confirmed model for this passing test fixture." })
  }
  if (op?.data?.user_override !== true || op.data.authority || !op.phase) return op
  const current = await readLedger(file, { readOnly: true })
  if (!current.phases[op.phase]?.facts?.some((f) => f.key === "fixture-owner-decision")) {
    await rawWriteLedger(file, { operation: "record_fact", phase: op.phase, data: { key: "fixture-owner-decision", text: "Owner approved this exception in the test scenario." } })
  }
  return { ...op, data: { ...op.data, authority: "direct", quote: "Owner approved this exception in the test scenario.", override_fact_key: "fixture-owner-decision" } }
}

export async function writeLedger(...args: Parameters<typeof rawWriteLedger>) {
  args[1] = await withOwnerDecision(args[0], args[1]) as typeof args[1]
  return rawWriteLedger(...args)
}

export async function handleWriteLedger(...args: Parameters<typeof rawHandleWriteLedger>) {
  args[1] = await withOwnerDecision(args[0], args[1])
  return rawHandleWriteLedger(...args)
}
