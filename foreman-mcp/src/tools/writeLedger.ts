import { WriteLedgerInputSchema } from "../types.js"
import { writeLedger } from "../lib/ledger.js"
import { toKeyValue } from "../lib/toon.js"

/**
 * Validates input with Zod schema, delegates to lib/ledger.ts,
 * returns TOON key/value confirmation.
 */
export async function handleWriteLedger(filePath: string, rawInput: unknown): Promise<string> {
  const parsed = WriteLedgerInputSchema.parse(rawInput)
  const ledger = await writeLedger(filePath, parsed)

  // Return confirmation with key details
  return toKeyValue({
    operation: parsed.operation,
    phase: parsed.phase,
    unit_id: ("unit_id" in parsed ? parsed.unit_id : "n/a") ?? "n/a",
    timestamp: ledger.ts,
    status: "ok",
  })
}
