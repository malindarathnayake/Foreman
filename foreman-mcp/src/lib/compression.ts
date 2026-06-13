import { compress, InMemoryCcrStore, createRetrieveOriginalTool, defaultConfig } from "context-crush"
import type { RetrieveOriginalTool } from "context-crush"

let store: InMemoryCcrStore | null = null

export function compressionEnabled(): boolean {
  // Default ON (0.2.0 pilot). Kill switch: FOREMAN_COMPRESSION=0. Any other value (incl. unset, "1") = on.
  return process.env.FOREMAN_COMPRESSION !== "0"
}

function allowedTools(): string[] {
  const raw = process.env.FOREMAN_COMPRESSION_TOOLS
  const src = raw === undefined ? "run_tests,invoke_advisor" : raw
  return src.split(",").map((t) => t.trim()).filter((t) => t.length > 0)
}

export function getStore(): InMemoryCcrStore {
  if (store === null) {
    const ccr = defaultConfig().ccr
    store = new InMemoryCcrStore({ ttlSeconds: ccr.ttlSeconds, maxEntries: ccr.maxEntries })
  }
  return store
}

// Lossy compressors keep error/summary lines only, which can drop the leading meta
// block our tools emit (run_tests: "exit_code/passed/timed_out/truncated"; invoke_advisor:
// "cli/exit_code/timed_out/truncated"). Re-prepend it so agents keep at-a-glance status
// without retrieving the original (pilot finding #1).
const META_HEAD_MAX_LINES = 6
const META_HEAD_MAX_CHARS = 400

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
  const result = compress({ toolName, text }, { enabled: true }, getStore())
  if (result.reason !== "compressed") {
    return result.text
  }
  // Never prepend onto smart_crusher output — that strategy emits valid JSON.
  if (result.strategy === "smart_crusher") {
    return result.text
  }
  const head = metaHead(text)
  if (head === null) return result.text
  return dedupeMetaHead(head, result.text)
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
