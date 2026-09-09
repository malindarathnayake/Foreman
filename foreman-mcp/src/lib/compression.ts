import { compress, InMemoryCcrStore, createRetrieveOriginalTool, defaultConfig, findMarkers } from "context-crush"
import type { RetrieveOriginalTool } from "context-crush"
import { checkLiteralFidelity, describeFidelityFailure } from "./literalFidelity.js"

let store: InMemoryCcrStore | null = null

// Maps every emitted <<ccr:HASH>> marker to its originating tool, so an expired-hash
// retrieval can tell the agent WHICH tool to re-run. Must outlive vendor-store expiry:
// the store's sweep (vendor store.js:44-48) and expired get (store.js:73-76) delete the
// entry AND its stashed toolName. Bounded; oldest insertion evicted first.
const MAX_HASH_TOOL_ENTRIES = 2000
const hashToolMap = new Map<string, string>()

export function toolNameForHash(hash: string): string | undefined {
  return hashToolMap.get(hash)
}

// S6 CCR evidence accumulator (5b): per-tool aggregate of compression outcomes since the
// last drain. Token counts use the chars/4 estimate (rough English/code tokenizer heuristic —
// evidence-grade, not billing-grade). Recorded ONLY for outcomes actually SERVED compressed
// (post-guards, final text): a guard-rejected digest or exemption passthrough saved nothing
// and must not claim savings. In-memory and best-effort: pending entries not yet folded into
// the ledger by a write_ledger call are lost on process restart (documented restart-loss).
// Bounded: keys are tool names from the compression allowlist (allowedTools()).
const pendingCcrStats: Record<string, { calls: number; tokens_before: number; tokens_after: number }> = {}

function recordCcrOutcome(toolName: string, beforeChars: number, afterChars: number): void {
  const entry = (pendingCcrStats[toolName] ??= { calls: 0, tokens_before: 0, tokens_after: 0 })
  entry.calls += 1
  entry.tokens_before += Math.ceil(beforeChars / 4)
  entry.tokens_after += Math.ceil(afterChars / 4)
}

/** Returns the pending per-tool CCR aggregates and clears them (drain semantics). */
export function drainCcrStats(): Record<string, { calls: number; tokens_before: number; tokens_after: number }> {
  const drained = { ...pendingCcrStats }
  for (const key of Object.keys(pendingCcrStats)) delete pendingCcrStats[key]
  return drained
}

export function compressionEnabled(): boolean {
  // Default ON (0.2.0 pilot). Kill switch: FOREMAN_COMPRESSION=0. Any other value (incl. unset, "1") = on.
  return process.env.FOREMAN_COMPRESSION !== "0"
}

function allowedTools(): string[] {
  const raw = process.env.FOREMAN_COMPRESSION_TOOLS
  const src = raw === undefined ? "run_tests,invoke_advisor" : raw
  return src.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
}

// CCR TTL default, Foreman-side (R7): upstream context-crush raised 5→30 min because
// agent sessions outlive 5 minutes; our vendored config.js keeps its pristine 300 s
// default to minimize fork divergence, so the raise lives here. A valid
// CONTEXT_CRUSH_CCR_TTL_SECONDS (integer > 0, same validation as vendor config.js:8-13)
// still wins; unset or invalid falls back to 1800.
export function ccrTtlSeconds(): number {
  const raw = process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS
  if (raw !== undefined) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return 1800
}

export function getStore(): InMemoryCcrStore {
  if (store === null) {
    const ccr = defaultConfig().ccr
    store = new InMemoryCcrStore({ ttlSeconds: ccrTtlSeconds(), maxEntries: ccr.maxEntries })
  }
  return store
}

// Lossy compressors keep error/summary lines only, which can drop the leading meta
// block our tools emit (run_tests: "exit_code/passed/timed_out/truncated"; invoke_advisor:
// "cli/exit_code/timed_out/truncated"). Re-prepend it so agents keep at-a-glance status
// without retrieving the original (pilot finding #1).
const META_HEAD_MAX_LINES = 6
const META_HEAD_MAX_CHARS = 400

// Failure-output exemption threshold (chars). Upstream context-crush #847:
// "compressing tracebacks measurably hurts agent recovery" — small failure
// outputs pass through verbatim so the agent sees the raw error.
const FAILURE_OUTPUT_COMPRESS_MIN = 8192

function metaHead(text: string): string | null {
  const idx = text.indexOf("\n\n")
  if (idx <= 0 || idx > META_HEAD_MAX_CHARS) return null
  const block = text.slice(0, idx)
  if (block.split("\n").length > META_HEAD_MAX_LINES) return null
  return block
}

export function maybeCompress(toolName: string, text: string): string {
  if (!compressionEnabled()) {
    return text
  }
  if (!allowedTools().includes(toolName)) {
    return text
  }
  // Failure-output exemption (S8): non-zero exit_code in the meta head + small output
  // → pass through verbatim (upstream #847). smart_crusher JSON never has an
  // "exit_code:" meta head, so this cannot fire for JSON inputs — no strategy check.
  const head = metaHead(text)
  if (head !== null && /^exit_code: (?!0$)/m.test(head) && text.length <= FAILURE_OUTPUT_COMPRESS_MIN) {
    return text
  }
  const result = compress({ toolName, text }, { enabled: true }, getStore())
  if (result.reason !== "compressed") {
    return result.text
  }
  // Never prepend onto smart_crusher output — that strategy emits valid JSON.
  const served =
    result.strategy === "smart_crusher"
      ? result.text
      : head === null
        ? result.text
        : dedupeMetaHead(head, result.text)
  // Guard the text that is actually SERVED, not the raw digest. The meta head carrying
  // exit_code is re-prepended above, so checking before that step would fail every
  // compression for losing a literal Foreman itself puts back.
  if (lossyGuardsReject(text, served)) {
    return text
  }
  for (const hash of findMarkers(served)) {
    hashToolMap.delete(hash) // refresh insertion order on re-emit (mirrors vendor put())
    hashToolMap.set(hash, toolName)
  }
  while (hashToolMap.size > MAX_HASH_TOOL_ENTRIES) {
    const oldest = hashToolMap.keys().next().value
    if (oldest === undefined) break
    hashToolMap.delete(oldest)
  }
  recordCcrOutcome(toolName, text.length, served.length)
  return served
}

// S8 fail-open guards on a lossy "compressed" result. A result with no retrievable
// <<ccr:...>> marker breaks the retrieval contract (vendor router step 12.5 fail-opens
// store-side; this is the Foreman-side belt). Empty output from non-empty input would
// 400 the entire Anthropic request. Either case: discard the digest, keep the original.
//
// v0.6.14 adds the third guard, and it is the one that protects meaning rather than
// plumbing: the compressed tools are run_tests and invoke_advisor, whose output the
// pit-boss reads to decide a verdict. A digest that drops the failing file:line, the
// exit code, or a test count is structurally valid and semantically useless. The
// protected-literal check rejects a digest that lost or invented any literal a reader
// cannot reconstruct; deduplicating a repeated one is allowed.
export function lossyGuardsReject(original: string, compressedText: string): boolean {
  if (findMarkers(compressedText).length === 0) return true
  if (compressedText.trim() === "" && original.trim() !== "") return true
  const fidelity = checkLiteralFidelity(original, compressedText)
  if (!fidelity.ok) {
    // Diagnostic only: the caller serves the original, so this is never a hard failure.
    console.error(`[foreman] compression rejected — ${describeFidelityFailure(fidelity)}`)
    return true
  }
  return false
}

// Re-prepend the meta head exactly once. The lossy compressor may have retained a contiguous
// SUFFIX of the head block (the lines adjacent to body content); strip that retained run from
// the front of the body before prepending the full head, so no meta line is duplicated.
export function dedupeMetaHead(head: string, body: string): string {
  const headLines = head.split("\n")
  const bodyLines = body.split("\n")
  let strip = 0
  // Largest k such that the last k head lines equal the first k body lines, in order.
  for (let k = Math.min(headLines.length, bodyLines.length); k >= 1; k--) {
    const headSuffix = headLines.slice(headLines.length - k)
    const bodyPrefix = bodyLines.slice(0, k)
    if (headSuffix.every((l, i) => l === bodyPrefix[i])) { strip = k; break }
  }
  let remainder = bodyLines.slice(strip)
  if (strip > 0) {
    while (remainder.length > 0 && remainder[0] === "") remainder = remainder.slice(1)
  }
  return head + "\n\n" + remainder.join("\n")
}

export function getRetrieveOriginalTool(): RetrieveOriginalTool {
  return createRetrieveOriginalTool(getStore())
}
