// EXPERIMENTAL patch-worker invoker (Unit 4f). Delegates a single patch task to a
// remote OpenAI-compatible /chat/completions endpoint configured in `.foremanenv`,
// enforces the outbound-secret gate, records a hash-chained event trail in the
// sidecar, classifies every outcome into the closed FailureStage set, and returns
// the worker's patch VERBATIM for the HOST to apply.
//
// SECURITY / SCOPE INVARIANTS (do not weaken):
//   * Foreman NEVER applies patches and NEVER writes the ledger from this tool.
//   * The API key VALUE goes ONLY into the Authorization header — never into any
//     return text, event, log, thrown message, or the request body.
//   * One-shot: no retries beyond a single automatic reasoning_effort downgrade.
//   * Telemetry never throws into the serve path — a sidecar failure degrades to a
//     `sidecar_warning:` line appended to the returned text.

import fs from "fs/promises"
import path from "path"
import { createHash, randomBytes } from "crypto"
import { z } from "zod"
import { loadForemanEnv, type EditFormat, type ForemanEnvConfig } from "../lib/foremanEnv.js"
import { findSecrets } from "../lib/redaction.js"
import { appendEvent, boundIdentifier, type SidecarEventInput, type FailureStage as SidecarFailureStage } from "../lib/eventsSidecar.js"
import {
  parseWorkerResponse,
  normalizeFinishReason,
  PATCH_BEGIN,
  PATCH_END,
  type FinishReasonClass,
} from "../lib/workerResponse.js"
import { readLedger } from "../lib/ledger.js"
import { logEvent } from "../lib/journal.js"
import {
  postChat,
  classifyHttpError,
  isReasoningParamRejection,
  readTransportBudgets,
  envInt,
  tryJson,
  type NetResult,
} from "../lib/chatTransport.js"

// The closed 21-value failure taxonomy is owned by the sidecar envelope — reuse it
// verbatim so telemetry and this tool can never drift apart.
export type FailureStage = SidecarFailureStage

/**
 * Recovery hint per failure stage. Unit 4h sources this const for the HOST-CONTRACT
 * catalog, so EVERY one of the 21 stages carries an entry — including the four this
 * tool never emits itself (ED_STALE / PATCH_APPLY_FAIL / BLD_ERR / W_REJ), whose hints
 * describe the pitboss-side `write_ledger add_rejection` flow that owns them.
 */
export const PLAYBOOK: Record<FailureStage, string> = {
  BRIEF_TOO_LARGE:
    "Brief or file payload exceeds the size budget. Trim the brief, split the unit into smaller files, or raise FOREMAN_BRIEF_MAX_BYTES.",
  WORKER_PAYLOAD_SECRET_BLOCK:
    "A configured secret's value appears in the outbound payload (named in detail). Remove it from the brief/files and re-delegate; nothing left this machine.",
  WORKER_UNREACHABLE:
    "The endpoint could not be reached or returned an unclassifiable status. Check FOREMAN_API_BASE routing and network access, then re-delegate.",
  WORKER_TIMEOUT:
    "The worker stalled mid-response (inter-chunk timeout). Re-delegate; if it recurs, raise FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS or pick a faster model.",
  WORKER_AUTH_FAIL:
    "The endpoint rejected the API key (401/403). Fix the key referenced by FOREMAN_API_KEY in .foremanenv and re-delegate.",
  WORKER_QUOTA_FAIL:
    "The endpoint is rate-limited or out of quota (429). Wait and re-delegate, or switch to a tier with available quota.",
  WORKER_MODEL_NOT_FOUND:
    "The configured model id was not found (404 / model_not_found). Correct FOREMAN_TIER_<TIER> in .foremanenv and re-delegate.",
  WORKER_RESPONSE_TOO_LARGE:
    "The worker's response exceeded the byte budget and was discarded (model output discipline). Tighten the brief or raise FOREMAN_WORKER_RESPONSE_MAX_BYTES.",
  WORKER_GHOST:
    "The worker produced no usable patch. Re-delegate with a sharper brief; if it reported a blocker (see detail), resolve that first.",
  MODEL_SCHEMA_FAIL:
    "The worker's response did not match the required JSON-metadata-plus-patch schema. Re-delegate; if it recurs, pick a more capable tier.",
  PATCH_PARSE_FAIL:
    "The returned patch is not well-formed for the requested edit format. Re-delegate, or switch the tier's FOREMAN_EDIT_FORMAT_<TIER>.",
  PATCH_REDACTION_MARKER_FAIL:
    "The patch contains a redaction marker (a removed-secret placeholder). Re-delegate; do NOT apply — applying would write the marker into source.",
  PATCH_PROTECTED_PATH_FAIL:
    "The patch targets a protected path (docs/state dir, .foreman* file, .git/, or outside the listed files). Re-delegate scoped to the listed files only.",
  ED_STALE:
    "The base files changed since delegation (host-side CAS mismatch at apply time). Re-read the files, rebuild the brief, record the attempt with write_ledger add_rejection, then re-delegate.",
  PATCH_APPLY_FAIL:
    "The host could not apply the returned patch (hunks did not apply). Record the failure with write_ledger add_rejection and re-delegate with refreshed file contents.",
  BLD_ERR:
    "The patch applied but the build/typecheck failed. Record it with write_ledger add_rejection (include the build error) and re-delegate a fix.",
  W_REJ:
    "A reviewer rejected the applied patch. Record it with write_ledger add_rejection and re-delegate addressing the review findings.",
  WORKER_BINARY_NOT_FOUND:
    "aider or its python interpreter was not found (capability probe failed). Install aider (pip install aider-chat) or set FOREMAN_AIDER_PYTHON; until resolved this tier fails open with a recorded waiver.",
  WORKER_DIRTY_TREE_REFUSAL:
    "The editable/read-only set was not tracked-and-clean at delegation (incoherent base for the host CAS). Do not stash, commit, reset, or rewrite user-owned repository state. Wait for an owner-approved stable base or use a patch-only path that preserves the current files; this one counts.",
  WORKER_AIDER_EXIT:
    "aider (or the Python harness) exited non-zero with no parseable result — a crash or opaque exit (exit code / traceback class in detail). Re-delegate; if it recurs on one model, raise FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS or switch tier.",
  WORKER_AIDER_LLM_ERROR:
    "aider's own call to the serving endpoint failed (status in detail). Check the headroom-proxy/vLLM route and FOREMAN_API_BASE, then re-delegate; nothing counts against the model.",
}

// ─── Input schema (mirrors the inline zod in server.ts registration) ─────────────
const InputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  brief: z.string(),
  tier: z.enum(["cheap", "standard", "premium"]),
  files: z.array(z.string()).max(100),
  edit_format: z.enum(["unified_diff", "search_replace", "whole_file"]).optional(),
})

export interface InvokeWorkerDeps {
  docsDir: string
  ledgerPath: string
  journalPath: string
  /** Directory holding `.foremanenv`. Defaults to process.cwd(). */
  envDir?: string
}

interface ParamDowngrade {
  field: "reasoning_effort"
  from: string
  reason: string
}

// ─── Env knobs (read per call; invalid value → documented default) ───────────────
// The three TRANSPORT budgets (connect / activity / response cap) and `envInt` now live
// in lib/chatTransport.ts, shared byte-for-byte with the review-council path.
const DEFAULT_BRIEF_MAX_BYTES = 262144

// ─── Small helpers ───────────────────────────────────────────────────────────────
function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * The event copy of base_file_hashes: the sidecar caps every identifier (INCLUDING
 * base_file_hashes keys) at 64 chars and THROWS over the cap. Full (often absolute)
 * paths routinely exceed that, so an over-long key is replaced by a bounded, stable
 * digest via boundIdentifier (the ONE implementation of the cap-and-digest rule, shared
 * with the sidecar). The RETURN map keeps the full paths for the host's content-addressed-
 * storage check — only the telemetry copy is bounded.
 */
function boundBaseFileHashes(full: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, h] of Object.entries(full)) {
    out[boundIdentifier(p)] = h
  }
  return out
}

/**
 * True when a worker-supplied target path matches one of the delegated files[]. Both
 * sides are normalized (`\`→`/`) first; a target T matches a listed entry F when T and F
 * are string-equal, resolve to the same absolute path, or one is a segment-boundary
 * suffix of the other — the suffix rule tolerates the model echoing a repo-relative form
 * of an absolute listed path (and the `a/`/`b/` prefix stripping the parser already did).
 */
function targetInListedFiles(target: string, files: string[]): boolean {
  const t = target.replace(/\\/g, "/")
  const tResolved = path.resolve(process.cwd(), t)
  for (const file of files) {
    const f = file.replace(/\\/g, "/")
    if (t === f) return true
    if (tResolved === path.resolve(process.cwd(), f)) return true
    if (f.endsWith("/" + t)) return true
    if (t.endsWith("/" + f)) return true
  }
  return false
}

// ─── System prompt (byte-stable; feeds prompt_prefix_hash) ───────────────────────
function editFormatGrammar(editFormat: EditFormat): string {
  switch (editFormat) {
    case "unified_diff":
      return [
        "Edit format: unified_diff.",
        "For each changed file emit a standard unified diff with these exact headers and hunks:",
        "--- a/<path>",
        "+++ b/<path>",
        "@@ -<start>,<len> +<start>,<len> @@",
        "then context lines (leading space), removals (leading -), and additions (leading +).",
      ].join("\n")
    case "search_replace":
      return [
        "Edit format: search_replace.",
        "For each change emit a plain path line, then a block delimited exactly like this:",
        "<path>",
        "<<<<<<< SEARCH",
        "<exact existing content to find>",
        "=======",
        "<replacement content>",
        ">>>>>>> REPLACE",
      ].join("\n")
    case "whole_file":
      return [
        "Edit format: whole_file.",
        "For each file emit a marker line then the COMPLETE new file content:",
        "===== FILE: <path> =====",
        "<entire file content>",
      ].join("\n")
  }
}

/**
 * Builds the worker system prompt. PURE function of editFormat — the same input
 * always yields byte-identical output, which is what makes prompt_prefix_hash a
 * stable delegation fingerprint. Exported for tests.
 */
export function buildSystemPrompt(editFormat: EditFormat): string {
  return [
    "You are a Foreman patch worker. Produce a single patch that implements the brief for the listed files ONLY.",
    "",
    "Respond in EXACTLY two parts, in this order:",
    "",
    "PART 1 — first, a single strict JSON object (nothing before it but optional whitespace):",
    '  {"report": "success" | "<short failure reason>", "files": ["<paths touched>"], "confidence": <0..1 optional>, "finish_note": "<optional>"}',
    '  "report" MUST be exactly "success" when you produce a patch. If you cannot produce a patch, set "report" to a short failure reason and omit the patch entirely.',
    "",
    "PART 2 — immediately after the JSON, the patch between these two sentinel lines, each on its own line with no leading or trailing characters:",
    PATCH_BEGIN,
    "<your patch here>",
    PATCH_END,
    "",
    editFormatGrammar(editFormat),
    "",
    "Rules:",
    "- Never modify files outside the listed files.",
    "- Never touch paths under the docs/state directories, any .foreman* file, or .git/.",
    "- Any [REDACTED:...] token in the input is an intentionally removed secret: treat it as opaque, never reproduce or guess it, and never emit [REDACTED in your patch.",
  ].join("\n")
}

// ─── One-time per-process egress notice ──────────────────────────────────────────
let egressNoticed = false

/** Resets the one-time egress-notice flag. Test-only seam. */
export function resetEgressNoticeForTest(): void {
  egressNoticed = false
}

async function maybeEgressNotice(hostname: string, journalPath: string, unitId: string): Promise<string> {
  if (egressNoticed) return ""
  egressNoticed = true
  const notice =
    `NOTICE: briefs and file excerpts leave this machine to ${hostname}. ` +
    "Review .foremanenv routing before delegating sensitive code."
  try {
    await logEvent(journalPath, {
      operation: "log_event",
      data: { t: "EGRESS_NOTICE", u: bounded(unitId, 200), tok: 0, msg: bounded(`egress to ${hostname}`, 200) },
    })
  } catch {
    // Best-effort only — journalling must never throw into the serve path.
  }
  return notice + "\n\n"
}

// ─── Main handler ─────────────────────────────────────────────────────────────────
export async function handleInvokeWorker(rawInput: unknown, deps: InvokeWorkerDeps): Promise<string> {
  const parsedInput = InputSchema.safeParse(rawInput)
  if (!parsedInput.success) {
    // The MCP surface validates first; this is a defensive fallback for direct calls.
    return `status: error\n\ninvalid invoke_worker input: ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  }
  const input = parsedInput.data

  // ── Step 1: load config. Failures return verbatim and open no delegation. ──
  const envDir = deps.envDir ?? process.cwd()
  const envResult = await loadForemanEnv({ dir: envDir, journalPath: deps.journalPath })
  if (envResult.status === "config_error") {
    return `status: config_error\n\n${envResult.message}`
  }
  if (envResult.status === "refused") {
    return `status: refused\n\n${envResult.message}`
  }
  const config = envResult.config

  // Past step 1 → the first such call this process emits the egress notice.
  let hostname = ""
  try {
    hostname = new URL(config.apiBase).hostname
  } catch {
    hostname = config.apiBase
  }
  const noticePrefix = await maybeEgressNotice(hostname, deps.journalPath, input.unit_id)

  const body = await runDelegation(input, deps, config, hostname)
  return noticePrefix + body
}

async function runDelegation(
  input: z.infer<typeof InputSchema>,
  deps: InvokeWorkerDeps,
  config: ForemanEnvConfig,
  hostname: string
): Promise<string> {
  const { phase, unit_id, brief, tier, files } = input

  // ── Step 2: resolve tier. ──
  const tierCfg = config.tiers[tier]
  if (!tierCfg) {
    const configured = Object.keys(config.tiers)
    return (
      `status: config_error\n\n` +
      `tier '${tier}' is not configured in .foremanenv.\n\n` +
      `Add this line:\n  FOREMAN_TIER_${tier.toUpperCase()}=<model-id>\n\n` +
      `Configured tiers: ${configured.length > 0 ? configured.join(", ") : "none"}\n`
    )
  }
  const editFormat: EditFormat = input.edit_format ?? tierCfg.editFormat

  // ── Step 3: ledger delegation check (READ-ONLY; never writes). ──
  const ledger = await readLedger(deps.ledgerPath, { readOnly: true })
  const unit = ledger.phases?.[phase]?.units?.[unit_id]
  const delegations = unit?.delegations
  if (!unit || !delegations || delegations.length === 0) {
    return (
      `status: error\n\n` +
      `unit '${unit_id}' in phase '${phase}' has no recorded delegation. Record it first, then re-run invoke_worker:\n` +
      `  write_ledger set_unit_status { phase: '${phase}', unit_id: '${unit_id}', data: { s: 'delegated', brief: '<worker brief summary>', tier: '${tier}' } }\n`
    )
  }
  const latest = delegations[delegations.length - 1]
  // Fallback: legacy delegation entries may lack the `attempt` field.
  const attempt = typeof latest.attempt === "number" ? latest.attempt : delegations.length

  // ── Step 4: read files (paths resolved relative to process.cwd()). ──
  const fileContents: string[] = []
  for (const f of files) {
    try {
      const content = await fs.readFile(path.resolve(process.cwd(), f), "utf-8")
      fileContents.push(content)
    } catch {
      // Pre-delegation input error — no events, no failure_stage.
      return (
        `status: error\n\n` +
        `cannot read file '${f}' (resolved from ${process.cwd()}). ` +
        `Check the path is correct and relative to the working directory, then re-run invoke_worker.\n`
      )
    }
  }

  // ── Step 5: hashes. ──
  const systemPrompt = buildSystemPrompt(editFormat)
  const promptPrefixHash = sha256hex(systemPrompt)
  const briefHash = sha256hex(brief)
  const fullHashes: Record<string, string> = {}
  files.forEach((f, i) => {
    fullHashes[path.resolve(process.cwd(), f)] = sha256hex(fileContents[i])
  })
  const boundedHashes = boundBaseFileHashes(fullHashes)

  // ── Step 6: ids + provider. ──
  const delegationId = `dlg_${randomBytes(8).toString("hex")}`
  const provider = bounded(hostname, 64)

  // ── Sidecar plumbing (telemetry never throws into the serve path). ──
  // [CWE-706] The sidecar co-locates with the ledger — derived from the LEDGER path's
  // directory, byte-identical to the write_ledger hook's rule — so the invoke-side writer
  // and the ledger-hook reader can never diverge under a custom ServerConfig where docsDir
  // and the ledger dir differ. With default config this is Docs/.foreman-events.jsonl
  // exactly as the spec states. deps.docsDir is retained ONLY for the parser's
  // protected-path option below.
  const sidecarPath = path.join(path.dirname(deps.ledgerPath), ".foreman-events.jsonl")
  const warnings: string[] = []

  function makeEvent(
    eventType: SidecarEventInput["event_type"],
    extra: Partial<SidecarEventInput>
  ): SidecarEventInput {
    return {
      v: 1,
      ts: new Date().toISOString(),
      event_id: `evt_${randomBytes(8).toString("hex")}`,
      event_type: eventType,
      // [CWE-20] Legal inputs are ≤10000 chars but the envelope caps identifiers at 64
      // and appendEvent throws over the cap; bounding here keeps the audit chain alive
      // (a digest) instead of degrading every event to a sidecar warning. The ledger hook
      // bounds phase/unit_id the same way, so the openDelegation join key stays consistent.
      phase: boundIdentifier(phase),
      unit_id: boundIdentifier(unit_id),
      attempt,
      delegation_id: delegationId,
      provider,
      model: bounded(tierCfg!.model, 64),
      tier,
      capability_class: tierCfg!.workerClass,
      edit_format: editFormat,
      repair_attempt: 0,
      brief_hash: briefHash,
      prompt_prefix_hash: promptPrefixHash,
      base_file_hashes: boundedHashes,
      ...extra,
    }
  }

  async function safeAppend(event: SidecarEventInput): Promise<void> {
    try {
      await appendEvent(sidecarPath, event)
    } catch (err) {
      // A sidecar failure degrades to a warning line — it never masks the primary result.
      warnings.push(`sidecar_warning: ${(err as Error).message}`)
    }
  }

  function withWarnings(text: string): string {
    return warnings.length > 0 ? `${text}\n${warnings.join("\n")}` : text
  }

  // ── Return builders ──
  function failureText(
    stage: FailureStage,
    refunded: boolean,
    detail?: string,
    paramDowngrade?: ParamDowngrade
  ): string {
    const lines = [
      "status: fail",
      `failure_stage: ${stage}`,
      `refunded: ${refunded}`,
      `hint: ${PLAYBOOK[stage]}`,
      `delegation_id: ${delegationId}`,
    ]
    if (detail && detail.length > 0) lines.push(`detail: ${bounded(detail, 200)}`)
    if (paramDowngrade) {
      lines.push(
        `param_downgrade: {field:"${paramDowngrade.field}", from:"${paramDowngrade.from}", reason:"${paramDowngrade.reason}"}`
      )
    }
    return withWarnings(lines.join("\n"))
  }

  // ── Step 7 preamble: open the delegation (non-terminal). ──
  await safeAppend(makeEvent("delegation_started", {}))

  // ── Step 7: pre-send brief cap. ──
  const briefMaxBytes = envInt("FOREMAN_BRIEF_MAX_BYTES", DEFAULT_BRIEF_MAX_BYTES)
  const briefBytes = Buffer.byteLength(brief)
  if (briefBytes > briefMaxBytes) {
    await safeAppend(makeEvent("worker_completed", { failure_stage: "BRIEF_TOO_LARGE", outcome: "fail" }))
    return failureText("BRIEF_TOO_LARGE", true, `brief is ${briefBytes} bytes; limit is ${briefMaxBytes} (FOREMAN_BRIEF_MAX_BYTES)`)
  }

  // ── Message + body construction. ──
  const userMessage = brief + "\n\n" + files.map((f, i) => `--- FILE: ${f} ---\n${fileContents[i]}\n`).join("")
  const hasReasoning = tierCfg.reasoningEffort !== undefined
  function buildBody(includeReasoning: boolean): string {
    const b: Record<string, unknown> = {
      model: tierCfg!.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }
    // reasoning_effort is passed through VERBATIM, only when configured.
    if (includeReasoning && tierCfg!.reasoningEffort !== undefined) {
      b.reasoning_effort = tierCfg!.reasoningEffort
    }
    return JSON.stringify(b)
  }

  // ── Step 8: outbound secret gate (brief + file contents + full serialized body). ──
  const firstBody = buildBody(hasReasoning)
  const secretHits = findSecrets([brief, ...fileContents, firstBody].join("\n"))
  if (secretHits.length > 0) {
    await safeAppend(makeEvent("worker_completed", { failure_stage: "WORKER_PAYLOAD_SECRET_BLOCK", outcome: "fail" }))
    // Name the env var NAME(s) only — never the value. NO HTTP request is made.
    return failureText(
      "WORKER_PAYLOAD_SECRET_BLOCK",
      true,
      `outbound payload contains the value of: ${secretHits.join(", ")}`
    )
  }

  // ── Steps 9–12: request + two-phase timeout + bounded streaming. ──
  const budgets = readTransportBudgets()
  const url = `${config.apiBase}/chat/completions`
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // The key value lives ONLY here — never in the body, return text, or any event.
    authorization: `Bearer ${process.env[config.apiKeyRef] ?? ""}`,
  }

  // The two-phase timeout + byte-capped read lives in lib/chatTransport.ts (shared with
  // invoke_council). This wrapper only supplies the per-attempt body.
  async function doRequest(includeReasoning: boolean): Promise<NetResult> {
    return postChat(url, headers, buildBody(includeReasoning), budgets)
  }

  // ── Step 9: clean → append delegation_started already done; POST now. ──
  const t0 = Date.now()

  async function finishNetError(net: Extract<NetResult, { kind: "neterror" }>, paramDowngrade?: ParamDowngrade): Promise<string> {
    await safeAppend(makeEvent("worker_completed", { elapsed_ms: Date.now() - t0, failure_stage: net.stage, outcome: "fail" }))
    return failureText(net.stage, net.refunded, net.detail, paramDowngrade)
  }

  let net = await doRequest(hasReasoning)
  let paramDowngrade: ParamDowngrade | undefined

  if (net.kind === "neterror") {
    return finishNetError(net)
  }

  // ── Step 14: param-downgrade retry (ONCE, never proactive). ──
  if (net.status === 400 && hasReasoning) {
    const parsedErr = tryJson(net.bodyText)
    const code = parsedErr?.error?.code
    // Never retry a genuine size/model error as a param rejection.
    if (code !== "context_length_exceeded" && code !== "model_not_found" && isReasoningParamRejection(parsedErr)) {
      paramDowngrade = {
        field: "reasoning_effort",
        from: String(tierCfg.reasoningEffort),
        reason: "endpoint rejected the parameter (HTTP 400)",
      }
      net = await doRequest(false)
      if (net.kind === "neterror") {
        return finishNetError(net, paramDowngrade)
      }
    }
  }

  // net is now an HTTP response. ── Steps 13 + 15: status mapping. ──
  const status = net.status
  if (status < 200 || status >= 300) {
    const classified = classifyHttpError(status, net.bodyText)
    await safeAppend(makeEvent("worker_completed", { elapsed_ms: Date.now() - t0, failure_stage: classified.stage, outcome: "fail" }))
    return failureText(classified.stage, classified.refunded, classified.detail, paramDowngrade)
  }

  // ── Step 15: 2xx — parse and classify the worker response. ──
  const json = tryJson(net.bodyText)
  const content = json?.choices?.[0]?.message?.content
  const usage = json?.usage
  const tokens =
    typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number"
      ? { in: usage.prompt_tokens, out: usage.completion_tokens }
      : undefined
  const finishClass: FinishReasonClass = normalizeFinishReason(json?.choices?.[0]?.finish_reason)
  const elapsedMs = Date.now() - t0

  if (typeof content !== "string") {
    await safeAppend(
      makeEvent("worker_completed", {
        ...(tokens ? { tokens } : {}),
        elapsed_ms: elapsedMs,
        finish_reason_class: finishClass,
        failure_stage: "MODEL_SCHEMA_FAIL",
        outcome: "fail",
      })
    )
    return failureText("MODEL_SCHEMA_FAIL", false, "response missing choices[0].message.content", paramDowngrade)
  }

  const parsed = parseWorkerResponse(content, { editFormat, docsDir: deps.docsDir })
  const confidence = typeof parsed.metadata?.confidence === "number" ? parsed.metadata.confidence : undefined

  switch (parsed.classification) {
    case "OK": {
      const patch = parsed.patch
      if (!patch || patch.trim().length === 0) {
        // CONSERVATIVE RECORDED READING (spec 4f step 15 gray zone): classification OK
        // with no patch means report != "success" — an honest failure. It is staged as
        // WORKER_GHOST (a delegation that yields no usable patch counts against the model,
        // stage-0 model-discipline, NOT refunded), keeping the closed enum intact, with
        // the worker's own report echoed in `detail`.
        await safeAppend(
          makeEvent("worker_completed", {
            ...(tokens ? { tokens } : {}),
            elapsed_ms: elapsedMs,
            finish_reason_class: finishClass,
            ...(confidence !== undefined ? { worker_confidence: confidence } : {}),
            failure_stage: "WORKER_GHOST",
            outcome: "fail",
          })
        )
        const report = parsed.metadata?.report ?? ""
        return failureText("WORKER_GHOST", false, `worker reported failure: ${bounded(report, 120)}`, paramDowngrade)
      }
      // [CWE-73] Checkpoint finding (Threat row "Worker-returned patch"): the parser
      // rejects patches targeting PROTECTED paths, but an OK-classified patch may still
      // target a file OUTSIDE the delegated files[] scope. Enforce delegation scope here
      // — this makes the PLAYBOOK / HOST-CONTRACT "or outside the listed files" clause
      // mechanically true. Any unlisted target is treated exactly like the parser's
      // PATCH_PROTECTED_PATH_FAIL: non-terminal worker_completed → TERMINAL patch_checked,
      // not refunded, detail naming the offending path.
      const unlistedTarget = (parsed.targetPaths ?? []).find((t) => !targetInListedFiles(t, files))
      if (unlistedTarget !== undefined) {
        await safeAppend(
          makeEvent("worker_completed", {
            ...(tokens ? { tokens } : {}),
            elapsed_ms: elapsedMs,
            finish_reason_class: finishClass,
            ...(confidence !== undefined ? { worker_confidence: confidence } : {}),
          })
        )
        await safeAppend(makeEvent("patch_checked", { failure_stage: "PATCH_PROTECTED_PATH_FAIL", outcome: "fail" }))
        return failureText(
          "PATCH_PROTECTED_PATH_FAIL",
          false,
          `target path "${unlistedTarget}" is not in the delegated files list`,
          paramDowngrade
        )
      }
      // OK with a usable patch — non-terminal worker_completed then non-terminal
      // patch_checked. NO outcome: the terminal validation_completed is appended later
      // by the ledger hook (unit 4g).
      await safeAppend(
        makeEvent("worker_completed", {
          ...(tokens ? { tokens } : {}),
          elapsed_ms: elapsedMs,
          finish_reason_class: finishClass,
          ...(confidence !== undefined ? { worker_confidence: confidence } : {}),
        })
      )
      const patchSha = sha256hex(patch)
      await safeAppend(makeEvent("patch_checked", { patch_sha256: patchSha, diff_bytes: Buffer.byteLength(patch) }))
      return withWarnings(
        successText(
          { delegationId, model: tierCfg.model, tier, capabilityClass: tierCfg.workerClass, editFormat, files, fullHashes },
          patch,
          patchSha,
          tokens,
          elapsedMs,
          finishClass,
          confidence,
          paramDowngrade
        )
      )
    }
    case "WORKER_GHOST":
    case "MODEL_SCHEMA_FAIL": {
      // Terminal worker_completed with the stage; not refunded.
      await safeAppend(
        makeEvent("worker_completed", {
          ...(tokens ? { tokens } : {}),
          elapsed_ms: elapsedMs,
          finish_reason_class: finishClass,
          ...(confidence !== undefined ? { worker_confidence: confidence } : {}),
          failure_stage: parsed.classification,
          outcome: "fail",
        })
      )
      return failureText(parsed.classification, false, bounded(parsed.detail ?? "", 200), paramDowngrade)
    }
    case "PATCH_PARSE_FAIL":
    case "PATCH_REDACTION_MARKER_FAIL":
    case "PATCH_PROTECTED_PATH_FAIL": {
      // Non-terminal worker_completed, then TERMINAL patch_checked carrying the stage.
      await safeAppend(
        makeEvent("worker_completed", {
          ...(tokens ? { tokens } : {}),
          elapsed_ms: elapsedMs,
          finish_reason_class: finishClass,
          ...(confidence !== undefined ? { worker_confidence: confidence } : {}),
        })
      )
      await safeAppend(makeEvent("patch_checked", { failure_stage: parsed.classification, outcome: "fail" }))
      return failureText(parsed.classification, false, bounded(parsed.detail ?? "", 200), paramDowngrade)
    }
    default: {
      // Exhaustiveness backstop — ResponseClassification is a closed union.
      const _exhaustive: never = parsed.classification
      return failureText("MODEL_SCHEMA_FAIL", false, `unclassified worker response: ${String(_exhaustive)}`, paramDowngrade)
    }
  }
}

// ─── Success return builder ──────────────────────────────────────────────────────
interface SuccessMeta {
  delegationId: string
  model: string
  tier: string
  capabilityClass: string
  editFormat: EditFormat
  files: string[]
  fullHashes: Record<string, string>
}

function successText(
  meta: SuccessMeta,
  patch: string,
  patchSha: string,
  tokens: { in: number; out: number } | undefined,
  elapsedMs: number,
  finishClass: FinishReasonClass,
  confidence: number | undefined,
  paramDowngrade?: ParamDowngrade
): string {
  const lines = [
    "status: ok",
    `delegation_id: ${meta.delegationId}`,
    `model: ${meta.model}`,
    `tier: ${meta.tier}`,
    `capability_class: ${meta.capabilityClass}`,
    `edit_format: ${meta.editFormat}`,
    `tokens_in: ${tokens ? tokens.in : "n/a"}`,
    `tokens_out: ${tokens ? tokens.out : "n/a"}`,
    `elapsed_ms: ${elapsedMs}`,
    `finish_reason_class: ${finishClass}`,
  ]
  if (confidence !== undefined) lines.push(`worker_confidence: ${confidence}`)
  lines.push(`files: ${meta.files.join(", ")}`)
  lines.push("base_file_hashes:")
  for (const [p, h] of Object.entries(meta.fullHashes)) lines.push(`  ${p}: ${h}`)
  lines.push(`patch_sha256: ${patchSha}`)
  if (paramDowngrade) {
    lines.push(
      `param_downgrade: {field:"${paramDowngrade.field}", from:"${paramDowngrade.from}", reason:"${paramDowngrade.reason}"}`
    )
  }
  lines.push("")
  // The patch is emitted BYTE-VERBATIM between the exact sentinels — never trimmed or rewritten.
  lines.push(PATCH_BEGIN)
  lines.push(patch)
  lines.push(PATCH_END)
  return lines.join("\n")
}
