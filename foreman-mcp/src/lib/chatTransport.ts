// Shared HTTP transport for Foreman's remote OpenAI-compatible /chat/completions calls.
//
// Lifted VERBATIM out of invokeWorker.ts (unit 4f) so the patch-worker path and the
// review-council path share ONE implementation of the network discipline. Nothing here
// is worker-specific: it is a byte pipe with two independent time budgets and a hard
// response cap, plus the status→FailureStage mapping.
//
// INVARIANTS (do not weaken — invoke_worker's recorded behavior depends on them):
//   * TWO independent budgets. `connect` bounds time-to-response-headers; `activity`
//     bounds the gap BETWEEN body chunks. A slow-but-alive stream is never killed by
//     the connect budget, and a stalled one is never allowed to hang on the activity
//     budget's back.
//   * The response cap is enforced DURING the read, not after — a hostile or runaway
//     endpoint cannot force unbounded buffering.
//   * WORKER_RESPONSE_TOO_LARGE is NOT refunded (stage-0 model-output discipline).
//     Every other transport failure IS refunded — the model never produced anything.
//   * Callers own the Authorization header. This module never reads, logs, or stores
//     an API key; it passes `headers` through to fetch untouched.

import type { FailureStage } from "./eventsSidecar.js"

// ─── Env knobs (read per call; invalid value → documented default) ───────────────
export const DEFAULT_RESPONSE_MAX_BYTES = 2097152
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000
export const DEFAULT_ACTIVITY_TIMEOUT_MS = 180000

/**
 * Non-negative integer env knob. Any non-finite, non-integer, or non-positive value
 * silently falls back to the documented default — a malformed knob must never break
 * a delegation or a review.
 */
export function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return def
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return def
  return n
}

export function tryJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export interface TransportBudgets {
  /** Time-to-response-headers. Exceeded → WORKER_UNREACHABLE. */
  connectTimeoutMs: number
  /** Max gap between body chunks. Exceeded → WORKER_TIMEOUT. */
  activityTimeoutMs: number
  /** Hard cap on total body bytes. Exceeded → WORKER_RESPONSE_TOO_LARGE (not refunded). */
  responseMaxBytes: number
}

/**
 * Reads the three FOREMAN_WORKER_* budget knobs. Council calls share these knobs
 * deliberately: an operator tunes endpoint behavior in ONE place, and a timeout that
 * is right for a delegation is right for a review against the same endpoint.
 */
export function readTransportBudgets(): TransportBudgets {
  return {
    connectTimeoutMs: envInt("FOREMAN_WORKER_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS),
    activityTimeoutMs: envInt("FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS", DEFAULT_ACTIVITY_TIMEOUT_MS),
    responseMaxBytes: envInt("FOREMAN_WORKER_RESPONSE_MAX_BYTES", DEFAULT_RESPONSE_MAX_BYTES),
  }
}

export type NetResult =
  | { kind: "neterror"; stage: FailureStage; refunded: boolean; detail?: string }
  | { kind: "http"; status: number; bodyText: string }

/**
 * POSTs `body` to `url` under both time budgets and the byte cap, returning the raw
 * response text. SSE and plain-JSON responses are treated identically — this is a byte
 * pipe; parsing belongs to the caller.
 */
export async function postChat(
  url: string,
  headers: Record<string, string>,
  body: string,
  budgets: TransportBudgets
): Promise<NetResult> {
  const { connectTimeoutMs, activityTimeoutMs, responseMaxBytes } = budgets
  const controller = new AbortController()
  let connectFired = false
  let activityFired = false

  // (a) CONNECT budget: time-to-response-headers.
  const connectTimer = setTimeout(() => {
    connectFired = true
    controller.abort()
  }, connectTimeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    })
  } catch {
    clearTimeout(connectTimer)
    // Connect-timeout abort OR a connection error (ECONNREFUSED etc.) → WORKER_UNREACHABLE.
    return {
      kind: "neterror",
      stage: "WORKER_UNREACHABLE",
      refunded: true,
      detail: connectFired ? `connect timeout after ${connectTimeoutMs}ms` : "endpoint unreachable",
    }
  }
  clearTimeout(connectTimer)

  // (b) ACTIVITY budget: inter-chunk stall while reading the body stream.
  const buffers: Buffer[] = []
  let total = 0
  let tooLarge = false
  const reader = response.body?.getReader()
  if (reader) {
    let activityTimer = setTimeout(() => {
      activityFired = true
      controller.abort()
    }, activityTimeoutMs)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(activityTimer)
        if (value && value.byteLength > 0) {
          total += value.byteLength
          if (total > responseMaxBytes) {
            tooLarge = true
            controller.abort()
            try {
              await reader.cancel()
            } catch {
              /* stream already errored by abort */
            }
            break
          }
          buffers.push(Buffer.from(value))
        }
        activityTimer = setTimeout(() => {
          activityFired = true
          controller.abort()
        }, activityTimeoutMs)
      }
      clearTimeout(activityTimer)
    } catch {
      clearTimeout(activityTimer)
      if (tooLarge) {
        // Stage-0 model-output discipline: NOT refunded.
        return {
          kind: "neterror",
          stage: "WORKER_RESPONSE_TOO_LARGE",
          refunded: false,
          detail: `response exceeded ${responseMaxBytes} bytes`,
        }
      }
      if (activityFired) {
        return {
          kind: "neterror",
          stage: "WORKER_TIMEOUT",
          refunded: true,
          detail: `activity timeout after ${activityTimeoutMs}ms`,
        }
      }
      return { kind: "neterror", stage: "WORKER_UNREACHABLE", refunded: true, detail: "response stream error" }
    }
  }
  if (tooLarge) {
    return {
      kind: "neterror",
      stage: "WORKER_RESPONSE_TOO_LARGE",
      refunded: false,
      detail: `response exceeded ${responseMaxBytes} bytes`,
    }
  }
  return { kind: "http", status: response.status, bodyText: Buffer.concat(buffers).toString("utf-8") }
}

// ─── Non-2xx status mapping (status-code-FIRST; structured 400 fields only) ───────
export function classifyHttpError(
  status: number,
  bodyText: string
): { stage: FailureStage; refunded: boolean; detail?: string } {
  if (status === 401 || status === 403) return { stage: "WORKER_AUTH_FAIL", refunded: true }
  if (status === 429) return { stage: "WORKER_QUOTA_FAIL", refunded: true }
  if (status === 404) return { stage: "WORKER_MODEL_NOT_FOUND", refunded: true }
  if (status === 400) {
    const parsed = tryJson(bodyText)
    const code = parsed?.error?.code
    if (code === "context_length_exceeded") return { stage: "BRIEF_TOO_LARGE", refunded: true }
    if (code === "model_not_found") return { stage: "WORKER_MODEL_NOT_FOUND", refunded: true }
    // Unclassifiable 400 → conservative WORKER_UNREACHABLE bucket with the numeric status.
    return { stage: "WORKER_UNREACHABLE", refunded: true, detail: "HTTP 400" }
  }
  // Any other non-2xx (incl. 5xx) → conservative WORKER_UNREACHABLE bucket, numeric status in detail.
  return { stage: "WORKER_UNREACHABLE", refunded: true, detail: `HTTP ${status}` }
}

/** True only for a genuine reasoning-parameter rejection (structured fields only). */
export function isReasoningParamRejection(parsedErr: any, field = "reasoning_effort"): boolean {
  const err = parsedErr?.error
  if (!err || typeof err !== "object") return false
  if (err.param === field) return true
  // "structured message field contains the literal token" — never a free-text regex.
  if (typeof err.message === "string" && err.message.includes(field)) return true
  return false
}

// ─── SSE accumulation ────────────────────────────────────────────────────────────

export interface SseChat {
  content: string
  finishReason?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  /** True when at least one well-formed `data:` frame was seen. */
  sawFrames: boolean
}

/**
 * Concatenates `choices[0].delta.content` across an SSE chat-completion stream.
 *
 * Streaming is what makes the two-phase budget meaningful for a reasoning-heavy review:
 * headers arrive immediately, so the connect budget measures the endpoint rather than
 * the generation, and the activity budget then detects a genuine mid-generation stall.
 * Malformed frames are skipped rather than fatal — a single bad frame must not discard
 * a complete review; the caller decides what an empty `content` means.
 */
export function parseSseChat(bodyText: string): SseChat {
  let content = ""
  let finishReason: string | undefined
  let usage: SseChat["usage"]
  let sawFrames = false

  for (const rawLine of bodyText.split(/\r?\n/)) {
    const line = rawLine.trimStart()
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "" || payload === "[DONE]") continue
    const frame = tryJson(payload)
    if (frame === undefined) continue
    sawFrames = true
    const choice = frame?.choices?.[0]
    const delta = choice?.delta?.content
    if (typeof delta === "string") content += delta
    // Some providers emit the full message on the terminal frame instead of a delta.
    else if (typeof choice?.message?.content === "string") content += choice.message.content
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason
    if (frame?.usage && typeof frame.usage === "object") usage = frame.usage
  }

  return { content, finishReason, usage, sawFrames }
}
