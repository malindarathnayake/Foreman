// Optional Langfuse tracing for review-council runs.
//
// PROVENANCE: derived from crucible's src/telemetry/langfuse.ts (Apache-2.0, same author),
// trimmed to the council's needs. Vendored rather than depended on for the same reason Foreman
// talks to OpenRouter over plain fetch: this server ships as a bundled tarball whose identity is
// fingerprinted, and the official SDKs cost either a transitive dependency (langfuse-core) or the
// whole OpenTelemetry tree (@langfuse/otel) to send what is, at bottom, a batched POST.
//
// DESIGN CONSTRAINTS, in priority order — the first two are inherited verbatim from crucible and
// are the reason this file is safe to enable on a real repository:
//
// 1. TRACING MUST NEVER CHANGE A REVIEW. Every entry point swallows its own errors and returns
//    void. A tracing failure (unreachable host, bad key, malformed payload) degrades to silence,
//    never to a failed or altered council run. Unconfigured — the default — every entry point is
//    a null check.
//
// 2. NO CONTENT LEAVES THE PROCESS BY DEFAULT. scalar() drops every object and array, so the
//    shapes an evidence packet or a model reply would arrive in cannot survive the metadata path
//    at any setting. There is exactly ONE content channel — FOREMAN_LANGFUSE_CONTENT=1 — and it
//    carries only the two typed fields below, hard-capped, after the caller has already run the
//    payload through Foreman's redaction. Enabling it ships evidence packets and model output to
//    the configured host: point it at infrastructure you would trust with the repository.
//
// 3. NO CREDENTIALS ANYWHERE BUT HERE. Keys are read from the environment at configure time and
//    held in this module. They never enter a return value, an event, or a log line.

const INGESTION_PATH = "/api/public/ingestion"
const MAX_BATCH = 50
const MAX_BUFFERED_EVENTS = 500
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_STRING = 200
const MAX_CONTENT_CHARS = 24_000

interface IngestionEvent {
  id: string
  type: "trace-create" | "generation-create"
  timestamp: string
  body: Record<string, unknown>
}

export interface CouncilTraceConfig {
  baseUrl: string
  publicKey: string
  secretKey: string
  environment?: string
  release?: string
  captureContent: boolean
  timeoutMs: number
}

/** One settled seat call. Mirrors what the council already returns to the host. */
export interface CouncilSeatCall {
  seatLabel: string
  model: string
  lensId: string
  status: "succeeded" | "failed"
  failureStage?: string | null
  durationMs: number
  promptTokens?: number | null
  completionTokens?: number | null
  reasoningTokens?: number | null
  cost?: number | null
  findingCount?: number | null
  completion?: string | null
  /** Inert unless captureContent. Caller must have redacted before passing. */
  promptText?: string | null
  /** Inert unless captureContent. Caller must have redacted before passing. */
  completionText?: string | null
}

/** Bounds a value to a Langfuse-safe scalar. Objects and arrays become null — never stringified. */
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  // Objects, arrays, functions, symbols: dropped. This is the rule that makes it structurally
  // impossible for a prompt or an evidence packet to reach the wire through metadata.
  return null
}

function metadata(record: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(record)) out[key] = scalar(value)
  return out
}

function content(text: string | null | undefined, capture: boolean): string | null {
  if (!capture || typeof text !== "string" || text.length === 0) return null
  return text.length > MAX_CONTENT_CHARS
    ? text.slice(0, MAX_CONTENT_CHARS) + "\n[truncated by foreman council tracer]"
    : text
}

class CouncilTracer {
  readonly #endpoint: string
  readonly #authorization: string
  readonly #config: CouncilTraceConfig
  #buffer: IngestionEvent[] = []
  #chain: Promise<void> = Promise.resolve()
  #sequence = 0
  #traceId: string | null = null
  #dropped = 0

  constructor(config: CouncilTraceConfig) {
    this.#config = config
    this.#endpoint = config.baseUrl.replace(/\/+$/, "") + INGESTION_PATH
    this.#authorization =
      "Basic " + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")
  }

  get capturesContent(): boolean {
    return this.#config.captureContent
  }

  #enqueue(event: IngestionEvent): void {
    // Bounded: a long session must not accumulate unbounded telemetry. trace-create is exempt —
    // it is rare, tiny, and losing it orphans every generation that follows.
    if (this.#buffer.length >= MAX_BUFFERED_EVENTS && event.type !== "trace-create") {
      this.#dropped += 1
      return
    }
    this.#buffer.push(event)
    // Serialised live delivery — batches keep order and never overlap. Detached from the caller:
    // a review never awaits telemetry except at the explicit flush.
    this.#chain = this.#chain.then(() => this.#drain()).catch(() => undefined)
  }

  #nextId(kind: string): string {
    this.#sequence += 1
    return `${this.#traceId ?? "orphan"}-${kind}${this.#sequence}`
  }

  beginCouncil(run: { runId: string; objective: string; meta: Record<string, unknown> }): void {
    try {
      this.#traceId = run.runId
      this.#sequence = 0
      const ts = new Date().toISOString()
      this.#enqueue({
        id: `${run.runId}-open`,
        type: "trace-create",
        timestamp: ts,
        body: {
          id: run.runId,
          name: "foreman-review-council",
          timestamp: ts,
          ...(this.#config.environment ? { environment: this.#config.environment } : {}),
          ...(this.#config.release ? { release: this.#config.release } : {}),
          tags: ["foreman", "review-council"],
          // The objective is a caller-authored one-liner, not repository content, but it is still
          // bounded through scalar() rather than trusted.
          metadata: metadata({ objective: run.objective, ...run.meta }),
        },
      })
    } catch {
      /* tracing never throws */
    }
  }

  recordSeatCall(call: CouncilSeatCall): void {
    try {
      if (this.#traceId === null) return
      const duration = Number.isFinite(call.durationMs) && call.durationMs >= 0 ? call.durationMs : 0
      const end = Date.now()
      const start = end - duration
      const id = this.#nextId("gen")
      const capture = this.#config.captureContent
      const input = content(call.promptText, capture)
      const output = content(call.completionText, capture)
      this.#enqueue({
        id,
        type: "generation-create",
        timestamp: new Date(start).toISOString(),
        body: {
          id,
          traceId: this.#traceId,
          name: `${call.lensId}:${call.seatLabel}`,
          ...(this.#config.environment ? { environment: this.#config.environment } : {}),
          startTime: new Date(start).toISOString(),
          endTime: new Date(end).toISOString(),
          model: call.model,
          level: call.status === "succeeded" ? "DEFAULT" : "ERROR",
          ...(call.failureStage ? { statusMessage: call.failureStage } : {}),
          ...(input === null ? {} : { input }),
          ...(output === null ? {} : { output }),
          ...(call.promptTokens == null && call.completionTokens == null
            ? {}
            : {
                usage: {
                  ...(call.promptTokens == null ? {} : { input: call.promptTokens }),
                  ...(call.completionTokens == null ? {} : { output: call.completionTokens }),
                },
              }),
          metadata: metadata({
            seat: call.seatLabel,
            lens: call.lensId,
            status: call.status,
            failure_stage: call.failureStage ?? null,
            duration_ms: duration,
            prompt_tokens: call.promptTokens ?? null,
            completion_tokens: call.completionTokens ?? null,
            reasoning_tokens: call.reasoningTokens ?? null,
            cost: call.cost ?? null,
            finding_count: call.findingCount ?? null,
            completion_state: call.completion ?? null,
          }),
        },
      })
    } catch {
      /* tracing never throws */
    }
  }

  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0, MAX_BATCH)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs)
      try {
        await fetch(this.#endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: this.#authorization,
          },
          body: JSON.stringify({ batch }),
          signal: controller.signal,
        })
      } catch {
        // Delivery failure is silent and the batch is dropped rather than retried forever —
        // an unreachable telemetry host must not become backpressure on reviews.
        this.#dropped += batch.length
      } finally {
        clearTimeout(timer)
      }
    }
  }

  async flush(): Promise<void> {
    try {
      this.#chain = this.#chain.then(() => this.#drain()).catch(() => undefined)
      await this.#chain
    } catch {
      /* tracing never throws */
    }
  }

  get dropped(): number {
    return this.#dropped
  }
}

let active: CouncilTracer | null = null

/**
 * Reads FOREMAN_LANGFUSE_* from the environment and activates the tracer if — and only if — all
 * three required values are present. Returns the active tracer or null. Idempotent per process.
 */
export function councilTracer(): CouncilTracer | null {
  if (active !== null) return active
  const baseUrl = process.env.FOREMAN_LANGFUSE_BASE_URL
  const publicKey = process.env.FOREMAN_LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.FOREMAN_LANGFUSE_SECRET_KEY
  if (!baseUrl || !publicKey || !secretKey) return null
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  } catch {
    return null
  }
  const timeoutRaw = Number(process.env.FOREMAN_LANGFUSE_TIMEOUT_MS)
  active = new CouncilTracer({
    baseUrl,
    publicKey,
    secretKey,
    environment: process.env.FOREMAN_LANGFUSE_ENVIRONMENT || undefined,
    release: process.env.FOREMAN_LANGFUSE_RELEASE || undefined,
    captureContent: process.env.FOREMAN_LANGFUSE_CONTENT === "1",
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_TIMEOUT_MS,
  })
  return active
}

/** Test seam: drops the process-wide tracer so a test can reconfigure from a clean slate. */
export function resetCouncilTracerForTest(): void {
  active = null
}

export type { CouncilTracer }
