// EXPERIMENTAL Adaptive Review Council invoker.
//
// Runs N remote review seats over M risk lenses against ONE evidence packet, normalizes every
// reply into the ledger's ReviewFinding shape, and returns the result for the HOST to moderate.
// It is the machine-executable half of the deliberation protocol in _common-protocol.md: the
// council supplies independent perspectives, the host (pitboss) moderates, the USER arbitrates.
//
// SECURITY / SCOPE INVARIANTS (do not weaken):
//   * READ-ONLY. This tool never edits the tree, never applies a fix, and never writes the
//     ledger. Seats inspect and report; the host records via write_ledger record_review.
//   * A failed, partial, refused, or unparseable seat NEVER becomes approval. Every degraded
//     path is named in the output and carries its closed FailureStage.
//   * The API key VALUE goes ONLY into the Authorization header — never into a return line,
//     a trace event, or the request body.
//   * The outbound secret gate runs over the WHOLE serialized payload before any HTTP request.
//   * The council does not vote and does not merge. Cross-seat agreement is reported as a
//     COUNT, never resolved into a verdict — a single well-evidenced defect can outrank several
//     unsupported approvals, and that judgement belongs to the moderator.

import fs from "fs/promises"
import path from "path"
import { createHash, randomBytes, randomUUID } from "crypto"
import { appendReceipt, providerFromModelId } from "../lib/seatReceipts.js"
import { z } from "zod"
import type { CouncilSeatId } from "../lib/foremanEnv.js"
import { loadCouncilConfig, type CouncilSeatConfig } from "../lib/councilConfig.js"
import { findSecrets } from "../lib/redaction.js"
import { logEvent } from "../lib/journal.js"
import { toTable } from "../lib/toon.js"
import type { ReviewFinding } from "../types.js"
import type { FailureStage } from "../lib/eventsSidecar.js"
import {
  postChat,
  classifyHttpError,
  isReasoningParamRejection,
  readTransportBudgets,
  envInt,
  tryJson,
  parseSseChat,
} from "../lib/chatTransport.js"
import {
  LENS_CATALOG,
  LENS_CATALOG_VERSION,
  LENS_IDS,
  DEFAULT_LENSES,
  SEAT_RESPONSE_SCHEMA,
  buildSeatPrompt,
  type LensId,
} from "../lib/lensCatalog.js"
import { councilTracer } from "../lib/councilTrace.js"

const DEFAULT_PACKET_MAX_BYTES = 262144
const DEFAULT_MAX_CALLS = 12
/**
 * Total ceiling applied ONLY to a seat using `reasoning.effort`, which the API defines as a
 * percentage of this number. At xhigh (~95%) this leaves ~2k tokens for the findings JSON,
 * which comfortably fits the seat schema. Override with FOREMAN_COUNCIL_EFFORT_MAX_TOKENS.
 */
const DEFAULT_EFFORT_MAX_TOKENS = 40000
/**
 * Response byte cap for council calls, separate from the worker's.
 *
 * The cap is a MEMORY guard, not a cost guard — cost is bounded by tokens. The worker's 2 MiB
 * suits a non-streaming JSON patch reply; a STREAMED review is a different shape entirely, since
 * every few tokens arrive wrapped in their own ~200-byte SSE envelope. A legitimately bounded
 * 40k-token completion can therefore exceed 2 MiB in raw stream bytes while being perfectly
 * well-behaved. Overridable with FOREMAN_COUNCIL_RESPONSE_MAX_BYTES.
 */
const DEFAULT_COUNCIL_RESPONSE_MAX_BYTES = 16777216
/** Ledger record_review accepts at most 100 findings; stay well inside it per seat. */
const MAX_FINDINGS_PER_SEAT = 50

export const InvokeCouncilInputSchema = z.object({
  phase: z.string().max(10000),
  objective: z.string().min(10).max(2000),
  evidence: z.string().min(1),
  lenses: z.array(z.enum(LENS_IDS)).max(LENS_IDS.length).optional(),
  seats: z.array(z.enum(["a", "b", "c"])).max(3).optional(),
  files: z.array(z.string()).max(50).optional(),
  cross_examine: z.boolean().optional(),
})

export interface InvokeCouncilDeps {
  journalPath: string
  /** 0.6.19: receipts file beside the ledger; one receipt per seat when set. */
  receiptsPath?: string
  /** Directory holding `.foremanenv`. Defaults to process.cwd(). */
  envDir?: string
  /** Override for the home credential store. Test seam. */
  credentialsPath?: string
}

// ─── Seat reply schema (mirrors SEAT_RESPONSE_SCHEMA) ────────────────────────────
const SeatFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().max(4096),
  line: z.union([z.string(), z.number()]).transform((v) => String(v)),
  description: z.string().min(1).max(10000),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  reproduction: z.string().max(4000).optional(),
})

const SeatReplySchema = z.object({
  completion: z.enum(["complete", "partial"]).optional(),
  findings: z.array(SeatFindingSchema).default([]),
  limitations: z.array(z.string().max(2000)).default([]),
  checked: z.array(z.string().max(2000)).default([]),
})

type SeatReply = z.infer<typeof SeatReplySchema>

interface SeatResult {
  seat: CouncilSeatId
  label: string
  model: string
  lens: LensId
  status: "ok" | "fail"
  failureStage?: FailureStage
  detail?: string
  reply?: SeatReply
  tokensIn?: number
  tokensOut?: number
  reasoningTokens?: number
  cost?: number
  elapsedMs: number
  paramDowngraded?: boolean
}

/**
 * The council-absent response. This is the load-bearing "Foreman still works normally" path: it
 * is NOT an error, it names the exact next rung so the host does not have to infer one, and it
 * states plainly that absence is not a passed review.
 */
const UNAVAILABLE_TEXT = (reason: string): string =>
  [
    "status: unavailable",
    `reason: ${reason}`,
    "",
    "This is NOT a failure and NOT a passed review. Foreman proceeds on its normal flow —",
    "continue down the deliberation ladder:",
    "  1. check the host CLI advisor seats (capability_check codex / gemini, then invoke_advisor);",
    "  2. if no CLI advisor is available, run TWO adversarial self-review passes at the strongest",
    "     available tier and record in the ledger note that independent review was unavailable.",
    "",
    "To seat a council later, put these in ~/.foreman-mcp/.env (preferred — works with no repo",
    "config, and older Foreman versions ignore the file) or in the repo .foremanenv:",
    "  FOREMAN_API_BASE=https://openrouter.ai/api/v1",
    "  FOREMAN_API_KEY=<key>",
    "  FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash",
    "  FOREMAN_COUNCIL_REASONING_A=xhigh",
    "  FOREMAN_COUNCIL_SEAT_B=moonshotai/kimi-k3",
    "  FOREMAN_COUNCIL_REASONING_MAX_TOKENS_B=8000",
  ].join("\n")

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

// ─── One-time per-process egress notice ──────────────────────────────────────────
let councilEgressNoticed = false

/** Resets the one-time egress-notice flag. Test-only seam. */
export function resetCouncilEgressNoticeForTest(): void {
  councilEgressNoticed = false
}

async function maybeEgressNotice(hostname: string, journalPath: string, phase: string): Promise<string> {
  if (councilEgressNoticed) return ""
  councilEgressNoticed = true
  const notice =
    `NOTICE: the review evidence packet leaves this machine to ${hostname}. ` +
    "Review .foremanenv routing before convening the council on sensitive code."
  try {
    await logEvent(journalPath, {
      operation: "log_event",
      data: { t: "EGRESS_NOTICE", u: bounded(phase, 200), tok: 0, msg: bounded(`council egress to ${hostname}`, 200) },
    })
  } catch {
    // Best-effort only — journalling must never throw into the serve path.
  }
  return notice + "\n\n"
}

// ─── Request body ────────────────────────────────────────────────────────────────
/**
 * `provider` is an OpenRouter-native routing block. A strict OpenAI-compatible server (vLLM, a
 * local proxy) may reject an unknown top-level field with a 400, so it is sent ONLY when the
 * endpoint is actually OpenRouter. Everywhere else the request stays plain OpenAI-shaped.
 */
export function isOpenRouterEndpoint(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.toLowerCase()
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai")
  } catch {
    return false
  }
}

function buildSeatBody(
  seatCfg: CouncilSeatConfig,
  systemPrompt: string,
  userPacket: string,
  includeReasoning: boolean,
  openRouter: boolean
): string {
  const body: Record<string, unknown> = {
    model: seatCfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPacket },
    ],
    // Streaming is what makes the two-phase budget meaningful for a reasoning-heavy review:
    // headers arrive at once, so the connect budget measures the ENDPOINT rather than the
    // generation, and the activity budget then detects a genuine mid-generation stall. A
    // non-streaming reasoning call at high effort would otherwise trip the connect budget.
    stream: true,
    response_format: {
      type: "json_schema",
      json_schema: { name: "foreman_review", strict: true, schema: SEAT_RESPONSE_SCHEMA },
    },
    // Restrict routing to providers that actually support the parameters requested above.
    // Without it a route lacking structured-output support can be selected silently and the
    // reply degrades to prose. OpenRouter only — see isOpenRouterEndpoint.
    ...(openRouter ? { provider: { require_parameters: true } } : {}),
  }
  // REASONING BUDGET — bounded only where the API semantics REQUIRE it.
  //
  // `reasoning.effort` is defined as a PERCENTAGE OF max_tokens (xhigh/max ~= 95%, high ~= 80%),
  // so omitting max_tokens does not mean "a sensible default" — it means the model's ceiling,
  // which on a 1M-context reviewer is hundreds of thousands of tokens. A live smoke run with
  // effort=xhigh and no ceiling spent the whole budget thinking and overran the response cap
  // before answering. An effort seat therefore ALWAYS carries a ceiling; the value is an env
  // knob, not a hard-coded policy.
  //
  // `reasoning.max_tokens` is already an explicit thinking budget, so it needs no ceiling of its
  // own — the operator has stated the bound. A seat with no reasoning config at all gets no
  // ceiling either: a review answer is small by construction, and imposing an invisible cap on
  // an unconfigured seat would be a policy the operator never asked for.
  //
  // `exclude: true` is NOT a bound — it suppresses the reasoning TEXT from the response. Nothing
  // downstream parses it, and streaming it back is what turned a large think into megabytes of
  // SSE frames. The tokens are still generated and still billed.
  if (includeReasoning && seatCfg.reasoningEffort !== undefined) {
    body.reasoning = { effort: seatCfg.reasoningEffort, exclude: true }
    body.max_tokens = envInt("FOREMAN_COUNCIL_EFFORT_MAX_TOKENS", DEFAULT_EFFORT_MAX_TOKENS)
  } else if (includeReasoning && seatCfg.reasoningMaxTokens !== undefined) {
    body.reasoning = { max_tokens: seatCfg.reasoningMaxTokens, exclude: true }
  } else {
    // A seat with NO reasoning configuration still needs `exclude`. Thinking models reason by
    // default, and without this their chain-of-thought streams back in full — which is what put
    // an unconfigured Kimi seat over the response cap. This is not a bound on the model: it
    // generates and bills exactly the same tokens either way. It only declines to RECEIVE text
    // nothing downstream parses.
    body.reasoning = { exclude: true }
  }
  return JSON.stringify(body)
}

// ─── One seat × one lens ─────────────────────────────────────────────────────────
async function runSeat(
  seatCfg: CouncilSeatConfig,
  lens: LensId,
  userPacket: string,
  url: string,
  headers: Record<string, string>,
  budgets: ReturnType<typeof readTransportBudgets>,
  openRouter: boolean
): Promise<SeatResult> {
  const t0 = Date.now()
  const systemPrompt = buildSeatPrompt(LENS_CATALOG[lens])
  const hasReasoning = seatCfg.reasoningEffort !== undefined || seatCfg.reasoningMaxTokens !== undefined

  const base = { seat: seatCfg.seat, label: seatCfg.label, model: seatCfg.model, lens } as const
  const fail = (stage: FailureStage, detail?: string, paramDowngraded?: boolean): SeatResult => ({
    ...base,
    status: "fail",
    failureStage: stage,
    ...(detail !== undefined ? { detail: bounded(detail, 300) } : {}),
    elapsedMs: Date.now() - t0,
    ...(paramDowngraded ? { paramDowngraded } : {}),
  })

  let net = await postChat(url, headers, buildSeatBody(seatCfg, systemPrompt, userPacket, hasReasoning, openRouter), budgets)
  let paramDowngraded = false

  // One-shot param downgrade, mirroring invoke_worker: a seat whose endpoint rejects the reasoning
  // parameter is retried ONCE without it rather than lost. Never proactive, never twice.
  if (net.kind === "http" && net.status === 400 && hasReasoning) {
    const parsedErr = tryJson(net.bodyText)
    const code = parsedErr?.error?.code
    if (
      code !== "context_length_exceeded" &&
      code !== "model_not_found" &&
      (isReasoningParamRejection(parsedErr, "reasoning") || isReasoningParamRejection(parsedErr, "reasoning_effort"))
    ) {
      paramDowngraded = true
      net = await postChat(
        url,
        headers,
        buildSeatBody(seatCfg, systemPrompt, userPacket, false, openRouter),
        budgets
      )
    }
  }

  if (net.kind === "neterror") return fail(net.stage, net.detail, paramDowngraded)

  if (net.status < 200 || net.status >= 300) {
    const classified = classifyHttpError(net.status, net.bodyText)
    return fail(classified.stage, classified.detail, paramDowngraded)
  }

  // 2xx. The stream may be SSE (requested) or a plain JSON body (endpoint ignored `stream`).
  const sse = parseSseChat(net.bodyText)
  let content: string | undefined
  let usage: any
  if (sse.sawFrames) {
    content = sse.content
    usage = sse.usage
  } else {
    const json = tryJson(net.bodyText)
    const c = json?.choices?.[0]?.message?.content
    if (typeof c === "string") content = c
    usage = json?.usage
  }

  const tokens = {
    tokensIn: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    tokensOut: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined,
    reasoningTokens:
      typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined,
    cost: typeof usage?.cost === "number" ? usage.cost : undefined,
  }

  if (typeof content !== "string" || content.trim() === "") {
    return { ...fail("MODEL_SCHEMA_FAIL", "seat returned no message content", paramDowngraded), ...tokens }
  }

  const parsedJson = tryJson(content)
  if (parsedJson === undefined) {
    return {
      ...fail("MODEL_SCHEMA_FAIL", `seat reply was not JSON: ${bounded(content.trim(), 120)}`, paramDowngraded),
      ...tokens,
    }
  }

  const parsed = SeatReplySchema.safeParse(parsedJson)
  if (!parsed.success) {
    return {
      ...fail(
        "MODEL_SCHEMA_FAIL",
        `seat reply failed schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        paramDowngraded
      ),
      ...tokens,
    }
  }

  // Silence is not approval: an empty finding list with no account of what was examined is a
  // failed review, not a clean one. The contract in the seat prompt states this explicitly.
  if (parsed.data.findings.length === 0 && parsed.data.checked.length === 0) {
    return {
      ...fail("MODEL_SCHEMA_FAIL", "seat reported no findings and no record of what it checked", paramDowngraded),
      ...tokens,
    }
  }

  return {
    ...base,
    status: "ok",
    reply: parsed.data,
    elapsedMs: Date.now() - t0,
    ...(paramDowngraded ? { paramDowngraded } : {}),
    ...tokens,
  }
}

// ─── Cross-examination (protocol phase 3) ────────────────────────────────────────
const REFUTATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim_id", "verdict", "reason"],
        properties: {
          claim_id: { type: "string" },
          verdict: { type: "string", enum: ["refuted", "stands", "uncertain"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const

const RefutationSchema = z.object({
  verdicts: z
    .array(
      z.object({
        claim_id: z.string().max(40),
        verdict: z.enum(["refuted", "stands", "uncertain"]),
        reason: z.string().max(2000),
      })
    )
    .default([]),
})

interface Claim {
  id: string
  seat: CouncilSeatId
  label: string
  lens: LensId
  finding: z.infer<typeof SeatFindingSchema>
}

interface Refutation {
  bySeat: string
  claimId: string
  verdict: "refuted" | "stands" | "uncertain"
  reason: string
}

async function runCrossExam(
  seatCfg: CouncilSeatConfig,
  claims: Claim[],
  evidence: string,
  url: string,
  headers: Record<string, string>,
  budgets: ReturnType<typeof readTransportBudgets>,
  openRouter: boolean
): Promise<{ refutations: Refutation[]; failure?: string }> {
  // Anti-pattern guard from _common-protocol.md: a seat never sees another seat's RAW output.
  // Only the normalized claim (severity, location, one-line description) crosses.
  const claimList = claims
    .map((c) => `${c.id}. [${c.finding.severity}] ${c.finding.file}:${c.finding.line} — ${c.finding.description}`)
    .join("\n")

  const systemPrompt = [
    "You are cross-examining review claims made by OTHER reviewers on the same change.",
    "For each claim, try to REFUTE it against the evidence supplied below.",
    "",
    "- \"refuted\": the evidence shows the claim is wrong, already handled, or not reachable. Say where.",
    "- \"stands\": you independently confirm the defect against the evidence. Cite file:line.",
    "- \"uncertain\": the evidence is insufficient to decide. This is an honest answer; use it.",
    "",
    "Default to \"uncertain\" over \"stands\" when you cannot locate the defect yourself.",
    "Agreement without independent confirmation is worthless here — do not rubber-stamp.",
  ].join("\n")

  const body = JSON.stringify({
    model: seatCfg.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `CLAIMS TO EXAMINE:\n${claimList}\n\n---\n\nEVIDENCE:\n${evidence}` },
    ],
    stream: true,
    response_format: {
      type: "json_schema",
      json_schema: { name: "foreman_cross_exam", strict: true, schema: REFUTATION_SCHEMA },
    },
    ...(openRouter ? { provider: { require_parameters: true } } : {}),
  })

  const net = await postChat(url, headers, body, budgets)
  if (net.kind === "neterror") return { refutations: [], failure: `${seatCfg.label}: ${net.stage}` }
  if (net.status < 200 || net.status >= 300) {
    return { refutations: [], failure: `${seatCfg.label}: ${classifyHttpError(net.status, net.bodyText).stage}` }
  }

  const sse = parseSseChat(net.bodyText)
  const content = sse.sawFrames ? sse.content : tryJson(net.bodyText)?.choices?.[0]?.message?.content
  if (typeof content !== "string") return { refutations: [], failure: `${seatCfg.label}: no content` }

  const parsed = RefutationSchema.safeParse(tryJson(content))
  if (!parsed.success) return { refutations: [], failure: `${seatCfg.label}: MODEL_SCHEMA_FAIL` }

  const validIds = new Set(claims.map((c) => c.id))
  return {
    refutations: parsed.data.verdicts
      .filter((v) => validIds.has(v.claim_id))
      .map((v) => ({ bySeat: seatCfg.label, claimId: v.claim_id, verdict: v.verdict, reason: v.reason })),
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────────
export async function handleInvokeCouncil(rawInput: unknown, deps: InvokeCouncilDeps): Promise<string> {
  const parsedInput = InvokeCouncilInputSchema.safeParse(rawInput)
  if (!parsedInput.success) {
    return `status: error\n\ninvalid invoke_council input: ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  }
  const input = parsedInput.data

  const envDir = deps.envDir ?? process.cwd()
  const councilResult = await loadCouncilConfig({
    dir: envDir,
    journalPath: deps.journalPath,
    ...(deps.credentialsPath !== undefined ? { credentialsPath: deps.credentialsPath } : {}),
  })

  // A council that is simply NOT SET UP is a supported state, not a failure. Foreman keeps
  // working exactly as it did before the council existed; the host walks down the ladder.
  if (councilResult.status === "unavailable") {
    return UNAVAILABLE_TEXT(councilResult.reason)
  }
  if (councilResult.status === "config_error") return `status: config_error\n\n${councilResult.message}`
  if (councilResult.status === "refused") return `status: refused\n\n${councilResult.message}`
  const config = councilResult.config

  const configured = config.seats.map((s) => s.seat)
  const requestedSeats: CouncilSeatId[] = input.seats && input.seats.length > 0 ? input.seats : configured
  const seats = config.seats.filter((s) => requestedSeats.includes(s.seat))
  if (seats.length === 0) {
    return (
      `status: config_error\n\nrequested seats [${requestedSeats.join(", ")}] are not configured.\n\n` +
      `Configured seats: ${configured.map((s) => s.toUpperCase()).join(", ")}\n`
    )
  }

  const lenses: LensId[] = input.lenses && input.lenses.length > 0 ? input.lenses : DEFAULT_LENSES

  // Explicit budget, never a silent truncation: an over-wide fan-out is refused with the arithmetic.
  const maxCalls = envInt("FOREMAN_COUNCIL_MAX_CALLS", DEFAULT_MAX_CALLS)
  const callCount = seats.length * lenses.length
  if (callCount > maxCalls) {
    return (
      `status: config_error\n\n` +
      `council fan-out is ${seats.length} seats x ${lenses.length} lenses = ${callCount} calls, ` +
      `over the limit of ${maxCalls}.\n\n` +
      `Narrow 'lenses' or 'seats', or raise FOREMAN_COUNCIL_MAX_CALLS.\n`
    )
  }

  // ── Evidence packet. ──
  const fileBlocks: string[] = []
  for (const f of input.files ?? []) {
    try {
      const content = await fs.readFile(path.resolve(process.cwd(), f), "utf-8")
      fileBlocks.push(`--- FILE: ${f} ---\n${content}\n`)
    } catch {
      return (
        `status: error\n\ncannot read file '${f}' (resolved from ${process.cwd()}). ` +
        `Check the path is correct and relative to the working directory, then re-run invoke_council.\n`
      )
    }
  }

  const userPacket = [`REVIEW OBJECTIVE: ${input.objective}`, "", "EVIDENCE:", input.evidence, ...fileBlocks].join("\n")

  const packetMaxBytes = envInt("FOREMAN_COUNCIL_PACKET_MAX_BYTES", DEFAULT_PACKET_MAX_BYTES)
  const packetBytes = Buffer.byteLength(userPacket)
  if (packetBytes > packetMaxBytes) {
    return (
      `status: fail\nfailure_stage: BRIEF_TOO_LARGE\n\n` +
      `evidence packet is ${packetBytes} bytes; limit is ${packetMaxBytes} ` +
      `(FOREMAN_COUNCIL_PACKET_MAX_BYTES). Narrow the evidence or split the review.\n`
    )
  }

  // ── Outbound secret gate (whole payload, before ANY request). ──
  const secretHits = findSecrets(userPacket)
  if (secretHits.length > 0) {
    // Name the env var NAME(s) only — never the value. NO HTTP request is made.
    return (
      `status: fail\nfailure_stage: WORKER_PAYLOAD_SECRET_BLOCK\n\n` +
      `outbound evidence packet contains the value of: ${secretHits.join(", ")}\n` +
      `Remove it from the evidence and re-convene; nothing left this machine.\n`
    )
  }

  let hostname = ""
  try {
    hostname = new URL(config.apiBase).hostname
  } catch {
    hostname = config.apiBase
  }
  const noticePrefix = await maybeEgressNotice(hostname, deps.journalPath, input.phase)

  const url = `${config.apiBase}/chat/completions`
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // The key value lives ONLY here — never in the body, return text, or any trace event.
    authorization: `Bearer ${config.apiKey}`,
  }
  const budgets = {
    ...readTransportBudgets(),
    responseMaxBytes: envInt("FOREMAN_COUNCIL_RESPONSE_MAX_BYTES", DEFAULT_COUNCIL_RESPONSE_MAX_BYTES),
  }
  const openRouter = isOpenRouterEndpoint(config.apiBase)
  const packetHash = sha256hex(userPacket)
  const runId = randomUUID()

  const tracer = councilTracer()
  tracer?.beginCouncil({
    runId,
    objective: bounded(input.objective, 200),
    meta: {
      phase: bounded(input.phase, 200),
      packet_hash: packetHash,
      lens_catalog_version: LENS_CATALOG_VERSION,
      seat_count: seats.length,
      lens_count: lenses.length,
      packet_bytes: packetBytes,
      host: hostname,
    },
  })

  // ── Fan out: every (seat, lens) pair runs concurrently. ──
  const pairs: Array<{ seatCfg: CouncilSeatConfig; lens: LensId }> = []
  for (const lens of lenses) for (const seatCfg of seats) pairs.push({ seatCfg, lens })

  const results = await Promise.all(
    pairs.map(({ seatCfg, lens }) => runSeat(seatCfg, lens, userPacket, url, headers, budgets, openRouter))
  )

  for (const r of results) {
    tracer?.recordSeatCall({
      seatLabel: r.label,
      model: r.model,
      lensId: r.lens,
      status: r.status === "ok" ? "succeeded" : "failed",
      failureStage: r.failureStage ?? null,
      durationMs: r.elapsedMs,
      promptTokens: r.tokensIn ?? null,
      completionTokens: r.tokensOut ?? null,
      reasoningTokens: r.reasoningTokens ?? null,
      cost: r.cost ?? null,
      findingCount: r.reply?.findings.length ?? null,
      completion: r.reply?.completion ?? null,
      // Content is inert unless FOREMAN_LANGFUSE_CONTENT=1; the packet already passed the
      // secret gate above, so what would ship is exactly what the seat already received.
      promptText: tracer?.capturesContent ? userPacket : null,
      completionText: null,
    })
  }

  // ── Cross-examination (optional, one round). ──
  const claims: Claim[] = []
  for (const r of results) {
    if (r.status !== "ok" || !r.reply) continue
    for (const f of r.reply.findings) {
      claims.push({ id: `C${claims.length + 1}`, seat: r.seat, label: r.label, lens: r.lens, finding: f })
    }
  }

  let refutations: Refutation[] = []
  const crossExamFailures: string[] = []
  const crossExamRan = input.cross_examine === true && claims.length > 0 && seats.length > 1
  if (crossExamRan) {
    const rounds = await Promise.all(
      seats.map((seatCfg) => {
        // A seat never examines its own claims.
        const foreign = claims.filter((c) => c.seat !== seatCfg.seat)
        if (foreign.length === 0) {
          const empty: { refutations: Refutation[]; failure?: string } = { refutations: [] }
          return Promise.resolve(empty)
        }
        return runCrossExam(seatCfg, foreign, input.evidence, url, headers, budgets, openRouter)
      })
    )
    for (const round of rounds) {
      refutations.push(...round.refutations)
      if (round.failure) crossExamFailures.push(round.failure)
    }
  }

  await tracer?.flush()

  // ── Seat receipts (0.6.19 slice 7): one per seat, all lenses folded. The vendor comes
  // from a prefix allowlist over the configured model id, else 'unknown' (never external).
  const receipts: Partial<Record<CouncilSeatId, string>> = {}
  if (deps.receiptsPath !== undefined) {
    for (const seatCfg of seats) {
      const mine = results.filter((x) => x.seat === seatCfg.seat)
      const failed = mine.filter((x) => x.status !== "ok")
      const bytesOut = mine.reduce((a, x) => a + (x.reply ? Buffer.byteLength(JSON.stringify(x.reply)) : 0), 0)
      const tokens = mine.reduce((a, x) => a + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0)
      try {
        const receipt = await appendReceipt(deps.receiptsPath, {
          cli: "council", provider: providerFromModelId(seatCfg.model), model_requested: seatCfg.model, model_served: seatCfg.model,
          ...(seatCfg.reasoningEffort !== undefined ? { reasoning_effort: seatCfg.reasoningEffort } : {}),
          exit_code: failed.length === 0 ? 0 : 1, failure_reason: failed.length === 0 ? null : "nonzero_exit",
          prompt_sha256: packetHash, bytes_in: packetBytes, bytes_out: bytesOut, ...(tokens > 0 ? { tokens_used: tokens } : {}),
        })
        receipts[seatCfg.seat] = receipt.id
      } catch (err) {
        receipts[seatCfg.seat] = `unavailable (${err instanceof Error ? err.message : String(err)})`
      }
    }
  }

  return noticePrefix + renderCouncil({
    receipts,
    runId,
    phase: input.phase,
    packetHash,
    packetBytes,
    lenses,
    seats,
    results,
    claims,
    refutations,
    crossExamRan,
    crossExamFailures,
    requestedCrossExam: input.cross_examine === true,
  })
}

// ─── Output rendering ────────────────────────────────────────────────────────────
interface RenderInput {
  receipts: Partial<Record<CouncilSeatId, string>>
  runId: string
  phase: string
  packetHash: string
  packetBytes: number
  lenses: LensId[]
  seats: CouncilSeatConfig[]
  results: SeatResult[]
  claims: Claim[]
  refutations: Refutation[]
  crossExamRan: boolean
  crossExamFailures: string[]
  requestedCrossExam: boolean
}

function renderCouncil(r: RenderInput): string {
  const ok = r.results.filter((x) => x.status === "ok")
  const failed = r.results.filter((x) => x.status === "fail")
  const lines: string[] = []

  // Every seat failing is a FAILED review, never a clean one. Say so in the status itself.
  const status = ok.length === 0 ? "fail" : failed.length > 0 ? "partial" : "ok"
  lines.push(`status: ${status}`)
  lines.push(`run_id: ${r.runId}`)
  lines.push(`phase: ${r.phase}`)
  lines.push(`lens_catalog_version: ${LENS_CATALOG_VERSION}`)
  lines.push(`lenses: ${r.lenses.join(", ")}`)
  // Seat provenance is printed so a surprising model is always traceable to the file that set it.
  lines.push(
    `seats: ${r.seats.map((s) => `${s.seat.toUpperCase()}=${s.label} (${s.source})`).join(", ")}`
  )
  lines.push(`packet_hash: ${r.packetHash}`)
  lines.push(`packet_bytes: ${r.packetBytes}`)
  const receiptEntries = Object.entries(r.receipts)
  if (receiptEntries.length > 0) {
    // One receipt per seat; record_review binds one receipt per record with packet_hash above.
    lines.push(`seat_receipts: ${receiptEntries.map(([seat, id]) => `${seat.toUpperCase()}=${id}`).join(", ")}`)
  }
  lines.push(`seats_ok: ${ok.length}/${r.results.length}`)

  const totalIn = r.results.reduce((a, x) => a + (x.tokensIn ?? 0), 0)
  const totalOut = r.results.reduce((a, x) => a + (x.tokensOut ?? 0), 0)
  const totalCost = r.results.reduce((a, x) => a + (x.cost ?? 0), 0)
  lines.push(`tokens_in: ${totalIn || "n/a"}`)
  lines.push(`tokens_out: ${totalOut || "n/a"}`)
  if (totalCost > 0) lines.push(`cost_usd: ${totalCost.toFixed(6)}`)

  // Independence disclosure — protocol design principle 4. Same-provider seats add perspective,
  // not independent votes, and the moderator must weigh them knowing that.
  const distinctVendors = new Set(r.seats.map((s) => s.model.split("/")[0]))
  lines.push(
    `independence: ${r.seats.length} seat(s) across ${distinctVendors.size} vendor(s) — ` +
      (distinctVendors.size < r.seats.length
        ? "seats sharing a vendor are PERSPECTIVE, not independent votes; disclose this in synthesis"
        : "distinct vendors; still disclose shared training/tooling correlation in synthesis")
  )

  if (r.claims.length > 0) {
    lines.push("")
    lines.push("## Findings")
    // Agreement is a COUNT of seats reporting the same location, not a verdict and not a merge.
    const locationCount = new Map<string, number>()
    for (const c of r.claims) {
      const key = `${c.finding.file}:${c.finding.line}`
      locationCount.set(key, (locationCount.get(key) ?? 0) + 1)
    }
    lines.push(
      toTable(
        ["id", "severity", "seat", "lens", "file", "line", "conf", "seats_at_loc", "description"],
        r.claims.map((c) => [
          c.id,
          c.finding.severity,
          c.label,
          c.lens,
          c.finding.file || "n/a",
          c.finding.line || "n/a",
          c.finding.confidence ?? "n/a",
          String(locationCount.get(`${c.finding.file}:${c.finding.line}`) ?? 1),
          c.finding.description,
        ])
      )
    )
  } else if (ok.length > 0) {
    lines.push("")
    lines.push("## Findings")
    lines.push("none reported by any seat that completed.")
  }

  // Reproduction notes and per-seat limitations are the two things a moderator needs and a
  // table cannot hold. Emitted separately rather than truncated into the grid.
  const withRepro = r.claims.filter((c) => c.finding.reproduction)
  if (withRepro.length > 0) {
    lines.push("")
    lines.push("## Reproduction")
    for (const c of withRepro) lines.push(`${c.id}: ${c.finding.reproduction}`)
  }

  const limitationLines: string[] = []
  for (const s of ok) {
    if (s.reply && s.reply.limitations.length > 0) {
      for (const l of s.reply.limitations) limitationLines.push(`${s.label}/${s.lens}: ${l}`)
    }
    if (s.reply?.completion === "partial") {
      limitationLines.push(`${s.label}/${s.lens}: seat reported completion=partial`)
    }
  }
  if (limitationLines.length > 0) {
    lines.push("")
    lines.push("## Limitations (synthesize WITH these visible)")
    lines.push(...limitationLines)
  }

  if (r.crossExamRan) {
    lines.push("")
    lines.push("## Cross-examination")
    if (r.refutations.length > 0) {
      lines.push(
        toTable(
          ["claim", "by", "verdict", "reason"],
          r.refutations.map((v) => [v.claimId, v.bySeat, v.verdict, v.reason])
        )
      )
      const refutedIds = new Set(r.refutations.filter((v) => v.verdict === "refuted").map((v) => v.claimId))
      if (refutedIds.size > 0) {
        lines.push("")
        lines.push(
          `contested: ${[...refutedIds].join(", ")} — a refutation is EVIDENCE to weigh, not an` +
            " automatic dismissal. Verify against the files before dropping a claim."
        )
      }
    } else {
      lines.push("no verdicts returned.")
    }
    for (const f of r.crossExamFailures) lines.push(`cross_exam_failed: ${f}`)
  } else if (r.requestedCrossExam) {
    lines.push("")
    lines.push(
      "cross_examination: skipped — requires at least 2 seats and at least 1 finding" +
        ` (had ${r.seats.length} seat(s), ${r.claims.length} finding(s)).`
    )
  }

  if (failed.length > 0) {
    lines.push("")
    lines.push("## Failed seats (NOT approvals)")
    lines.push(
      toTable(
        ["seat", "lens", "failure_stage", "detail"],
        failed.map((f) => [f.label, f.lens, f.failureStage ?? "unknown", f.detail ?? ""])
      )
    )
  }

  const downgraded = r.results.filter((x) => x.paramDowngraded)
  if (downgraded.length > 0) {
    lines.push("")
    lines.push(
      `param_downgrade: reasoning dropped after endpoint rejection on: ${downgraded.map((d) => `${d.label}/${d.lens}`).join(", ")}`
    )
  }

  // Ledger-ready payloads. One record per seat, per the protocol's per-advisor review record.
  if (ok.length > 0) {
    lines.push("")
    lines.push("## Record these (write_ledger record_review, one call per seat)")
    const bySeat = new Map<string, SeatResult[]>()
    for (const s of ok) {
      const arr = bySeat.get(s.label) ?? []
      arr.push(s)
      bySeat.set(s.label, arr)
    }
    for (const [label, seatResults] of bySeat) {
      const findings: ReviewFinding[] = []
      for (const sr of seatResults) {
        for (const f of sr.reply?.findings ?? []) {
          findings.push({
            severity: f.severity,
            file: f.file,
            line: f.line,
            description: `[${sr.lens}] ${f.description}`,
            classification: "unverified",
          })
        }
      }
      const truncated = findings.length > MAX_FINDINGS_PER_SEAT
      const kept = truncated ? findings.slice(0, MAX_FINDINGS_PER_SEAT) : findings
      const tokens = seatResults.reduce((a, x) => a + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0)
      if (truncated) {
        lines.push(
          `# NOTE: ${label} reported ${findings.length} findings; ${MAX_FINDINGS_PER_SEAT} are in the payload below.`
        )
      }
      lines.push(
        JSON.stringify({
          operation: "record_review",
          phase: r.phase,
          data: {
            advisor: `council:${label}`,
            stage: "independent",
            findings: kept,
            packet_hash: r.packetHash,
            ...(tokens > 0 ? { tokens } : {}),
          },
        })
      )
    }
    lines.push("")
    lines.push(
      "classification is 'unverified' by design: the MODERATOR verifies each finding against the" +
        " files and reclassifies confirmed/rejected. Do not record a council claim as confirmed" +
        " without checking it yourself."
    )
  }

  lines.push("")
  if (status === "fail") {
    lines.push(
      "NEXT: every seat failed — this is NOT a passed review. Re-convene, fall back to the CLI" +
        " advisor rung, or record adversarial self-review as NON-INDEPENDENT."
    )
  } else {
    lines.push(
      "NEXT: moderate (verify each finding against files, classify AGREE/DISAGREE/NUANCE," +
        " normalize severity), then present to the USER for arbitration. Do not proceed on" +
        " council output alone."
    )
  }

  return lines.join("\n")
}
