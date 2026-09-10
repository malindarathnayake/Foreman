/**
 * Seat receipts (0.6.19 slice 4). Foreman-authored provenance for external advisor
 * seats. When invoke_advisor runs a CLI, the server appends a receipt naming the
 * vendor (from the CLI, never from text), the served model it parsed, the exit code,
 * the failure reason, the prompt's hash and the byte counts. record_review can bind
 * one receipt to one independent record, once: the record's packet_hash must equal
 * the receipt's prompt hash, the run must have succeeded, the receipt must be
 * unconsumed and must post-date the newest verdict and attempt. The seat basis then
 * reads 'receipted_external' from provenance Foreman wrote, not from a stage string.
 *
 * The file is `.foreman-seats.jsonl` beside the ledger, hash-chained like the events
 * sidecar: each line carries `line_hash` (sha256 of its canonical form) and
 * `prev_hash`; a break is a loud read error, a torn final line is skipped on read and
 * refused on append. [CWE-345] [CWE-353] [CWE-354]
 *
 * What a receipt proves: a Foreman-launched process on a named vendor ran after the
 * newest verdict and attempt, was served the model it names, and produced this much
 * output from this exact prompt. It does not prove the findings came from that output,
 * and a pit-boss with a shell can still write the file; the chain makes that loud.
 */
import fs from "fs/promises"
import { createHash, randomBytes } from "crypto"
import type { Provider } from "../types.js"
import { canonicalStringify } from "./eventsSidecar.js"

// The file name and its path rule live in lib/foremanFiles.ts (v0.6.20), the single list the
// repository guard excludes; re-exported here for existing importers.
export { RECEIPTS_FILE, receiptsPathFor } from "./foremanFiles.js"
export type ReceiptCli = "claude" | "codex" | "gemini" | "council"
export type ReceiptFailure = "empty_stdout" | "echoed_prompt" | "model_substituted" | "resolution_failed" | "nonzero_exit"

/** Vendor from the CLI Foreman launched. Never parsed from output. */
export const CLI_PROVIDER: Readonly<Record<Exclude<ReceiptCli, "council">, Provider>> = { claude: "anthropic", codex: "openai", gemini: "google" }

/**
 * Vendor of a council seat from its configured model id, by a server-side prefix allowlist
 * (OpenRouter-style `vendor/model` or a bare vendor-specific id). Anything else is 'unknown',
 * which the basis classes as 'receipted', never as external: council seats are arbitrary
 * endpoints whose vendor is config text, so the allowlist attests nothing beyond the prefix.
 */
export function providerFromModelId(model: string): Provider {
  const id = model.trim().toLowerCase()
  if (id.startsWith("anthropic/") || id.startsWith("claude")) return "anthropic"
  if (id.startsWith("openai/") || id.startsWith("gpt-") || /^o[1-9]/.test(id)) return "openai"
  if (id.startsWith("google/") || id.startsWith("gemini")) return "google"
  return "unknown"
}

export interface SeatReceipt {
  v: 1
  kind: "receipt"
  id: string
  ts: string
  cli: ReceiptCli
  provider: Provider
  model_requested?: string
  model_served: string
  reasoning_effort?: string
  exit_code: number
  failure_reason: ReceiptFailure | null
  prompt_sha256: string
  bytes_in: number
  bytes_out: number
  tokens_used?: number
}
export interface ConsumedLine {
  v: 1
  kind: "consumed"
  id: string
  ts: string
  phase: string
  review_ts: string
}
type Chained<T> = T & { prev_hash?: string; line_hash: string }
export type ReceiptInput = Omit<SeatReceipt, "v" | "kind" | "id" | "ts">

export interface ReceiptsState {
  receipts: Map<string, SeatReceipt>
  consumed: Set<string>
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

function hashLine(line: Record<string, unknown>): string {
  const { line_hash: _drop, ...rest } = line
  return sha256Hex(canonicalStringify(rest))
}

const lockRegistry = new Map<string, Promise<void>>()
function withReceiptsLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockRegistry.get(filePath) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  lockRegistry.set(filePath, next.then(() => undefined, () => undefined))
  return next
}

/** Every line, chain-verified. Returns an empty state when the file is absent. */
export async function readReceipts(filePath: string): Promise<ReceiptsState> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { receipts: new Map(), consumed: new Set() }
    throw err
  }
  const lines = raw.split("\n")
  // A torn final line (no trailing LF) is an interrupted append: skipped here, refused by append.
  if (raw.length > 0 && !raw.endsWith("\n")) lines.pop()
  const state: ReceiptsState = { receipts: new Map(), consumed: new Set() }
  let prev: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") continue
    let parsed: Chained<SeatReceipt | ConsumedLine>
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`seatReceipts: '${filePath}' line ${i + 1} is not JSON; the receipts file is damaged`)
    }
    if (parsed.prev_hash !== prev || hashLine(parsed as unknown as Record<string, unknown>) !== parsed.line_hash) {
      throw new Error(`seatReceipts: hash chain broken at '${filePath}' line ${i + 1}; receipts after this point are not trusted`)
    }
    prev = parsed.line_hash
    if (parsed.kind === "receipt") state.receipts.set(parsed.id, parsed)
    else if (parsed.kind === "consumed") state.consumed.add(parsed.id)
  }
  return state
}

async function appendChained(filePath: string, body: Record<string, unknown>): Promise<void> {
  let raw = ""
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  if (raw.length > 0 && !raw.endsWith("\n")) {
    throw new Error(`seatReceipts: cannot append to '${filePath}' — file ends in a torn final line; repair or truncate it first`)
  }
  const lastLine = raw.split("\n").filter((l) => l.trim() !== "").at(-1)
  let prev: string | undefined
  if (lastLine !== undefined) {
    const parsed = JSON.parse(lastLine) as { line_hash?: unknown }
    if (typeof parsed.line_hash !== "string") throw new Error(`seatReceipts: cannot append to '${filePath}' — last line has no line_hash`)
    prev = parsed.line_hash
  }
  const line = prev !== undefined ? { ...body, prev_hash: prev } : { ...body }
  const chained = { ...line, line_hash: hashLine(line) }
  await fs.appendFile(filePath, JSON.stringify(chained) + "\n", "utf-8")
}

/** Write a receipt for one advisor run, successful or not. Returns it with its id. */
export async function appendReceipt(filePath: string, input: ReceiptInput): Promise<SeatReceipt> {
  const receipt: SeatReceipt = {
    v: 1, kind: "receipt", id: randomBytes(8).toString("hex"), ts: new Date().toISOString(), ...input,
  }
  await withReceiptsLock(filePath, () => appendChained(filePath, receipt as unknown as Record<string, unknown>))
  return receipt
}

/** Mark a receipt spent by one review record. */
export async function appendConsumed(filePath: string, id: string, phase: string, reviewTs: string): Promise<void> {
  const line: ConsumedLine = { v: 1, kind: "consumed", id, ts: new Date().toISOString(), phase, review_ts: reviewTs }
  await withReceiptsLock(filePath, () => appendChained(filePath, line as unknown as Record<string, unknown>))
}

/** The failure a receipt records for one run, from the same facts the advisor output shows. */
export function receiptFailure(exitCode: number, formatFailure: "empty_stdout" | "echoed_prompt" | "model_substituted" | null): ReceiptFailure | null {
  if (formatFailure !== null) return formatFailure
  if (exitCode === -1) return "resolution_failed"
  if (exitCode !== 0) return "nonzero_exit"
  return null
}
