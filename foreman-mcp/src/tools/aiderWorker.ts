// EXPERIMENTAL aider-CLI patch-worker invoker (Unit 2c). A SIBLING to invoke_worker
// (fork, not an extension): instead of talking to a remote /chat/completions endpoint,
// this tool drives the `aider` CLI inside an ISOLATED git worktree via an external
// harness process, computes the `git diff` ITSELF, and returns that diff.
//
// SECURITY / SCOPE INVARIANTS (do not weaken):
//   * Foreman NEVER mutates the tree and NEVER applies patches from this tool — it
//     returns a diff for the HOST to apply. The worktree is a throwaway sandbox.
//   * This tool NEVER writes the ledger.
//   * The API key VALUE goes ONLY into the harness request stdin (analogous to
//     invoke_worker's Authorization header) — never into any return text, event, or log.
//   * Telemetry never throws into the serve path — a sidecar failure degrades to a
//     `sidecar_warning:` line appended to the returned text.
//   * The worktree is torn down on EVERY exit path (try/finally around the harness run).

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { createHash, randomBytes } from "crypto"
import { z } from "zod"
import { loadForemanEnv, aiderEditFormat, type EditFormat, type ForemanEnvConfig } from "../lib/foremanEnv.js"
import { findSecrets, scrub } from "../lib/redaction.js"
import { appendEvent, boundIdentifier, type SidecarEventInput, type FailureStage } from "../lib/eventsSidecar.js"
import { parseWorkerResponse, PATCH_BEGIN, PATCH_END } from "../lib/workerResponse.js"
import { readLedger } from "../lib/ledger.js"
import {
  getBaseCommit,
  checkTrackedClean,
  computeBaseFileHashes,
  createWorktree,
  diffWorktree,
  teardownWorktree,
  reclaimOrphanWorktrees,
} from "../lib/aiderWorktree.js"
import { probeAiderCapability, runWithStdin, buildFilteredChildEnv } from "../lib/externalCli.js"
import { logEvent } from "../lib/journal.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Input schema ─────────────────────────────────────────────────────────────────
export const AiderWorkerInput = z
  .object({
    phase: z.string().min(1),
    unit_id: z.string().min(1),
    brief: z.string().min(20),
    tier: z.enum(["cheap", "standard", "premium"]),
    files: z.array(z.string().min(1)).min(1),
    read_only_files: z.array(z.string().min(1)).optional(),
    edit_format: z.enum(["whole_file", "search_replace", "unified_diff"]).optional(),
  })
  .strict()

export interface AiderWorkerDeps {
  docsDir: string
  ledgerPath: string
  journalPath: string
  /** Directory holding `.foremanenv`. Defaults to process.cwd(). */
  envDir?: string
}

// ─── Env knobs (read per call; invalid value → documented default) ───────────────
const DEFAULT_BRIEF_MAX_BYTES = 262144
const DEFAULT_ACTIVITY_TIMEOUT_MS = 600000
const DEFAULT_WORKTREE_MAX_AGE_MS = 86400000
const DEFAULT_CONNECT_TIMEOUT_MS = 10000

function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return def
  const n = Number(raw)
  // Fallback rule: any non-finite, non-integer, or non-positive value silently falls
  // back to the documented default — a malformed knob must never break a delegation.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return def
  return n
}

// ─── Small helpers (forked from invoke_worker's idioms) ──────────────────────────
function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

function bounded(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * Best-effort journal waiver for a fail-open capability miss (decision #2). Names the
 * missing capability only — never a secret value, env value, or filesystem path.
 * Mirrors foremanEnv's bestEffortSecBlock pattern; telemetry must never throw into serve.
 */
async function bestEffortWaiver(
  journalPath: string | undefined,
  unitId: string,
  missing: string,
): Promise<void> {
  if (!journalPath) return
  try {
    await logEvent(journalPath, {
      operation: "log_event",
      data: {
        t: "CAP_WAIVER",
        u: boundIdentifier(unitId),
        tok: 0,
        msg: `aider-cli capability unavailable (missing: ${missing}); failed open, refunded, tool stays registered`,
      },
    })
  } catch {
    // Best-effort only — a journal failure must never break the fail-open path.
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Event copy of base_file_hashes: sidecar caps every identifier (incl. keys) at 64 chars. */
function boundedBaseFileHashesForEvent(full: Record<string, string>): Record<string, string> {
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
 * suffix of the other. Forked verbatim from invoke_worker.ts.
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

// ─── System prompt addendum (byte-stable; feeds prompt_prefix_hash) ──────────────
// A short, byte-stable Foreman discipline addendum handed to the aider harness as
// `system_prompt_prefix`. Pure constant → stable prompt_prefix_hash across calls.
const DISCIPLINE_ADDENDUM = [
  "Foreman discipline addendum:",
  "- Edit ONLY the files explicitly listed as editable for this task.",
  "- Never touch any .foreman* file, anything under .git/, or the docs/state directory.",
  "- Never emit a `[REDACTED` token anywhere in your output — treat any such token already",
  "  present in the input as an opaque, intentionally removed secret; never reproduce or guess it.",
  "- Implement exactly what the brief describes for the listed files; do not expand scope.",
].join("\n")

// ─── Harness result shape (loose — every field is defensively coerced) ───────────
interface HarnessResult {
  ok: boolean
  aider_edited_files?: unknown
  num_malformed_responses?: unknown
  num_reflections?: unknown
  num_exhausted_context_windows?: unknown
  total_tokens_sent?: unknown
  total_tokens_received?: unknown
  total_cost?: unknown
  reflections_capped?: unknown
  error_kind?: unknown
  error_detail?: unknown
}

function isHarnessResultShape(value: unknown): value is HarnessResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return typeof (value as Record<string, unknown>).ok === "boolean"
}

function coerceNonNegInt(value: unknown, def: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : def
}

function coerceNonNegFinite(value: unknown, def: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : def
}

// The subset of the shared closed FailureStage enum that THIS tool can surface. All are now
// enum members; Extract<> keeps this list a compile-checked subset so it can never drift from
// the enum. Emission split: the pre-send stages WORKER_BINARY_NOT_FOUND and
// WORKER_DIRTY_TREE_REFUSAL open no delegation, so they are returned in tool TEXT / journal
// waiver only (no sidecar event); the rest ride their sidecar event's `failure_stage` field.
type TextFailureStage = Extract<
  FailureStage,
  | "BRIEF_TOO_LARGE"
  | "WORKER_PAYLOAD_SECRET_BLOCK"
  | "WORKER_DIRTY_TREE_REFUSAL"
  | "WORKER_BINARY_NOT_FOUND"
  | "WORKER_AIDER_EXIT"
  | "WORKER_AIDER_LLM_ERROR"
  | "MODEL_SCHEMA_FAIL"
  | "WORKER_RESPONSE_TOO_LARGE"
  | "WORKER_GHOST"
  | "PATCH_PARSE_FAIL"
  | "PATCH_REDACTION_MARKER_FAIL"
  | "PATCH_PROTECTED_PATH_FAIL"
>

// ─── Main handler ─────────────────────────────────────────────────────────────────
export async function handleAiderWorker(rawInput: unknown, deps: AiderWorkerDeps): Promise<string> {
  const parsedInput = AiderWorkerInput.safeParse(rawInput)
  if (!parsedInput.success) {
    // The MCP surface validates first; this is a defensive fallback for direct calls.
    return `status: error\n\ninvalid aider_worker input: ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
  }
  const input = parsedInput.data

  // ── Step 2: load config. Failures return verbatim and open no delegation. ──
  const envDir = deps.envDir ?? process.cwd()
  const envResult = await loadForemanEnv({ dir: envDir, journalPath: deps.journalPath })
  if (envResult.status === "config_error") {
    return `status: config_error\n\n${envResult.message}`
  }
  if (envResult.status === "refused") {
    return `status: refused\n\n${envResult.message}`
  }
  const config = envResult.config

  return runDelegation(input, deps, config)
}

async function runDelegation(
  input: z.infer<typeof AiderWorkerInput>,
  deps: AiderWorkerDeps,
  config: ForemanEnvConfig
): Promise<string> {
  const { phase, unit_id, brief, tier, files } = input
  const readOnly = input.read_only_files ?? []

  // ── Step 3: resolve tier + require worker_kind aider-cli. ──
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
  if (tierCfg.workerKind !== "aider-cli") {
    return (
      `status: config_error\n\n` +
      `tier '${tier}' is worker_kind '${tierCfg.workerKind}' — aider_worker only drives 'aider-cli' tiers.\n\n` +
      `Add this line:\n  FOREMAN_WORKER_KIND_${tier.toUpperCase()}=aider-cli\n\n` +
      `(Use invoke_worker instead for a remote-chat tier.)\n`
    )
  }
  const editFormat: EditFormat = input.edit_format ?? tierCfg.editFormat
  // Captured as plain locals (not `tierCfg.model`/`tierCfg.workerClass` directly) so the
  // nested `makeEvent` closure below keeps the narrowed (non-undefined) type — TS does
  // not carry a guard's narrowing of an outer `const` into a nested function declaration.
  const tierModel = tierCfg.model
  const tierWorkerClass = tierCfg.workerClass

  // ── Step 4: ledger delegation check (READ-ONLY; never writes). ──
  const ledger = await readLedger(deps.ledgerPath, { readOnly: true })
  const unit = ledger.phases?.[phase]?.units?.[unit_id]
  const delegations = unit?.delegations
  if (!unit || !delegations || delegations.length === 0) {
    return (
      `status: error\n\n` +
      `unit '${unit_id}' in phase '${phase}' has no recorded delegation. Record it first, then re-run aider_worker:\n` +
      `  write_ledger set_unit_status { phase: '${phase}', unit_id: '${unit_id}', data: { s: 'delegated', brief: '<worker brief summary>', tier: '${tier}' } }\n`
    )
  }
  const latest = delegations[delegations.length - 1]
  const attempt = typeof latest.attempt === "number" ? latest.attempt : delegations.length

  // ── Step 5: files ∩ read_only_files must be empty. ──
  const overlap = files.filter((f) => readOnly.includes(f))
  if (overlap.length > 0) {
    return (
      `status: error\n\n` +
      `files and read_only_files overlap: ${overlap.join(", ")}. A file must be editable OR read-only, not both.\n`
    )
  }

  // ── Step 6: read editable + read-only file contents (for the secret gate). ──
  const fileContents: string[] = []
  for (const f of files) {
    try {
      const content = await fs.readFile(path.resolve(process.cwd(), f), "utf-8")
      fileContents.push(content)
    } catch {
      return (
        `status: error\n\n` +
        `cannot read file '${f}' (resolved from ${process.cwd()}). ` +
        `Check the path is correct and relative to the working directory, then re-run aider_worker.\n`
      )
    }
  }
  const readOnlyContents: string[] = []
  for (const f of readOnly) {
    try {
      const content = await fs.readFile(path.resolve(process.cwd(), f), "utf-8")
      readOnlyContents.push(content)
    } catch {
      return (
        `status: error\n\n` +
        `cannot read file '${f}' (resolved from ${process.cwd()}). ` +
        `Check the path is correct and relative to the working directory, then re-run aider_worker.\n`
      )
    }
  }

  // ── Step 7: hashes. ──
  const briefHash = sha256hex(brief)
  const baseFileHashes = await computeBaseFileHashes(process.cwd(), files)
  const systemPromptPrefix = DISCIPLINE_ADDENDUM
  const promptPrefixHash = sha256hex(systemPromptPrefix)

  // ── Step 8: PRE-SEND gates. Return text, open NO delegation, emit NO sidecar event. ──
  const briefMaxBytes = envInt("FOREMAN_BRIEF_MAX_BYTES", DEFAULT_BRIEF_MAX_BYTES)
  const briefBytes = Buffer.byteLength(brief)
  if (briefBytes > briefMaxBytes) {
    return (
      `status: fail\n` +
      `failure_stage: BRIEF_TOO_LARGE\n` +
      `refunded: true\n` +
      `hint: brief is ${briefBytes} bytes; limit is ${briefMaxBytes} (FOREMAN_BRIEF_MAX_BYTES). Trim the brief or raise the limit.\n`
    )
  }

  // [CWE-200] Outbound secret gate: brief + editable file contents + read-only file
  // contents (never the api key or the harness request itself — the key goes into
  // stdin, never scanned here). Read-only files are sent to the harness as
  // `read_only_fnames` and read by aider, so a secret living in one leaks to the
  // endpoint exactly as surely as one in an editable file — both must be scanned.
  const secretHits = findSecrets([brief, ...fileContents, ...readOnlyContents].join("\n"))
  if (secretHits.length > 0) {
    return (
      `status: fail\n` +
      `failure_stage: WORKER_PAYLOAD_SECRET_BLOCK\n` +
      `refunded: true\n` +
      `detail: outbound payload contains the value of: ${secretHits.join(", ")}\n`
    )
  }

  const clean = await checkTrackedClean(process.cwd(), [...files, ...readOnly])
  if (!clean.ok) {
    // NOTE: WORKER_DIRTY_TREE_REFUSAL is NOT yet in the sidecar's closed FailureStage
    // enum (that taxonomy extension is a later phase) — return it in tool TEXT only.
    return (
      `status: fail\n` +
      `failure_stage: WORKER_DIRTY_TREE_REFUSAL\n` +
      `refunded: true\n` +
      `hint: commit or stash the editable+read-only set first (dirty: ${clean.dirtyPaths.join(", ")})\n`
    )
  }

  // ── Step 8b: PRE-SEND capability probe (decision #2, FAIL OPEN). ──
  // Resolve python + verify aider is importable BEFORE opening a delegation or worktree.
  // Absence is NOT an error: record a best-effort journal waiver naming the missing
  // capability (never a value or path) and return WORKER_BINARY_NOT_FOUND (refunded).
  // The tool stays registered — tools/list is unchanged. WORKER_BINARY_NOT_FOUND is NOT
  // yet a sidecar FailureStage enum member (P4 owns that), so the waiver lives in the
  // journal, and this pre-send failure opens no delegation and writes no sidecar event.
  const pythonCmd = process.env.FOREMAN_AIDER_PYTHON
  const harnessPath = process.env.FOREMAN_AIDER_HARNESS ?? path.join(__dirname, "aider_harness.py")
  const connectTimeoutMs = envInt("FOREMAN_WORKER_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS)
  // [CWE-200] Filter the child env for BOTH harness spawns (probe + real run): strip the
  // API-key-bearing var (config.apiKeyRef) and any secret-named var. The key reaches the
  // harness ONLY via the stdin request (harness self-injects OPENAI_API_KEY), never env.
  const childEnv = buildFilteredChildEnv([config.apiKeyRef])
  const probe = await probeAiderCapability(pythonCmd, harnessPath, connectTimeoutMs, childEnv)
  if (!probe.ok) {
    await bestEffortWaiver(deps.journalPath, unit_id, probe.missing)
    return (
      `status: fail\n` +
      `failure_stage: WORKER_BINARY_NOT_FOUND\n` +
      `refunded: true\n` +
      `hint: aider transport unavailable (missing: ${probe.missing}). Install aider (pip install aider-chat) or set FOREMAN_AIDER_PYTHON to a python that can import aider.\n`
    )
  }

  // ── Step 9: sidecar plumbing (telemetry never throws into the serve path). ──
  const sidecarPath = path.join(path.dirname(deps.ledgerPath), ".foreman-events.jsonl")
  const warnings: string[] = []

  let apiBaseHost = config.apiBase
  try {
    apiBaseHost = new URL(config.apiBase).hostname
  } catch {
    // Keep the raw apiBase string as a fallback.
  }
  const provider = bounded(apiBaseHost, 64)
  const delegationId = `dlg_${randomBytes(8).toString("hex")}`
  // [B] Set only by failText (in-delegation failures) so the teardown event below can
  // carry outcome:"fail" for a FAILED delegation only — a successful delegation's
  // worktree_torn_down event carries no outcome and stays open for the ledger hook.
  let terminalOutcome: "fail" | undefined

  function makeEvent(
    eventType: SidecarEventInput["event_type"],
    extra: Partial<SidecarEventInput>
  ): SidecarEventInput {
    return {
      v: 1,
      ts: new Date().toISOString(),
      event_id: `evt_${randomBytes(8).toString("hex")}`,
      event_type: eventType,
      phase: boundIdentifier(phase),
      unit_id: boundIdentifier(unit_id),
      attempt,
      delegation_id: delegationId,
      provider,
      model: bounded(tierModel, 64),
      tier,
      capability_class: tierWorkerClass,
      edit_format: editFormat,
      repair_attempt: 0,
      brief_hash: briefHash,
      prompt_prefix_hash: promptPrefixHash,
      base_file_hashes: boundedBaseFileHashesForEvent(baseFileHashes),
      worker_kind: "aider-cli",
      ...extra,
    }
  }

  async function safeAppend(event: SidecarEventInput): Promise<void> {
    try {
      await appendEvent(sidecarPath, event)
    } catch (err) {
      // A sidecar failure degrades to a warning line — it never masks the primary result.
      // [CWE-209] scrub + bound: the error message could echo back secret values or
      // large blobs (e.g. base_file_hashes content) — never forward it raw.
      warnings.push(`sidecar_warning: ${bounded(scrub((err as Error).message), 200)}`)
    }
  }

  function withWarnings(text: string): string {
    return warnings.length > 0 ? `${text}\n${warnings.join("\n")}` : text
  }

  function failText(stage: TextFailureStage, refunded: boolean, opts?: { detail?: string; hint?: string }): string {
    terminalOutcome = "fail" // [B] marks this delegation as terminally failed
    const lines = ["status: fail", `failure_stage: ${stage}`, `refunded: ${refunded}`]
    if (opts?.hint) lines.push(`hint: ${opts.hint}`)
    lines.push(`delegation_id: ${delegationId}`)
    if (opts?.detail && opts.detail.length > 0) lines.push(`detail: ${bounded(opts.detail, 200)}`)
    return withWarnings(lines.join("\n"))
  }

  // ── Step 10: orphan reclaim (crash recovery; best-effort, never throws). ──
  const worktreeRoot = process.env.FOREMAN_AIDER_WORKTREE_ROOT ?? path.join(deps.docsDir, ".foreman-worktrees")
  await reclaimOrphanWorktrees(
    process.cwd(),
    worktreeRoot,
    envInt("FOREMAN_AIDER_WORKTREE_MAX_AGE_MS", DEFAULT_WORKTREE_MAX_AGE_MS)
  ).catch(() => {})

  // ── Step 11: open the delegation (non-terminal). ──
  await safeAppend(makeEvent("delegation_started", {}))

  // ── Step 12: base commit + worktree creation. ──
  const baseCommit = await getBaseCommit(process.cwd())
  const worktree = await createWorktree(process.cwd(), worktreeRoot, delegationId, baseCommit)
  await safeAppend(
    makeEvent("worktree_created", { base_commit: boundIdentifier(baseCommit), editable_count: files.length })
  )

  // ── Step 13: harness run. The worktree MUST be torn down on EVERY exit path. ──
  try {
    const request = {
      model: tierCfg.model,
      edit_format: aiderEditFormat(editFormat),
      api_base: config.apiBase,
      // The key VALUE goes ONLY into this stdin payload — never into return text,
      // events, or logs (analogous to invoke_worker's Authorization header).
      api_key: process.env[config.apiKeyRef] ?? "",
      num_ctx: tierCfg.numCtx,
      reasoning_tag: tierCfg.reasoningTag ?? "",
      max_reflections: tierCfg.maxReflections,
      system_prompt_prefix: systemPromptPrefix,
      fnames: files,
      read_only_fnames: readOnly,
      message: brief,
      cwd: worktree.path,
    }

    const t0 = Date.now()
    const activityTimeoutMs = envInt("FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS", DEFAULT_ACTIVITY_TIMEOUT_MS)
    const res = await runWithStdin(
      probe.plan.command,
      [...probe.plan.args, harnessPath],
      JSON.stringify(request),
      activityTimeoutMs,
      childEnv,
    )
    const elapsedMs = Date.now() - t0

    // Transport failure: harness timed out or exited non-zero with no parseable result.
    // Carry the closed WORKER_AIDER_EXIT stage on the terminal worker_completed (refunded infra).
    if (res.timedOut || res.exitCode !== 0) {
      await safeAppend(makeEvent("worker_completed", { elapsed_ms: elapsedMs, failure_stage: "WORKER_AIDER_EXIT", outcome: "fail" }))
      // [CWE-532] res.stderr may carry the api key or raw file contents (e.g. a crash
      // dump echoing the request) — scrub known secrets, THEN bound, before it is ever
      // forwarded in return text. Never forward raw stderr verbatim.
      return failText("WORKER_AIDER_EXIT", true, { detail: bounded(scrub(res.stderr), 200) })
    }

    const parsedHarness = tryJson(res.stdout)
    if (!isHarnessResultShape(parsedHarness)) {
      await safeAppend(
        makeEvent("worker_completed", { elapsed_ms: elapsedMs, failure_stage: "MODEL_SCHEMA_FAIL", outcome: "fail" })
      )
      return failText("MODEL_SCHEMA_FAIL", false, { detail: "harness emitted malformed JSON" })
    }
    const harness = parsedHarness

    if (harness.error_kind !== undefined && harness.error_kind !== "none") {
      // aider surfaced an endpoint/LLM error through its own loop; carry the closed
      // WORKER_AIDER_LLM_ERROR stage on the terminal worker_completed (refunded infra).
      await safeAppend(makeEvent("worker_completed", { elapsed_ms: elapsedMs, failure_stage: "WORKER_AIDER_LLM_ERROR", outcome: "fail" }))
      const errorDetail = typeof harness.error_detail === "string" ? harness.error_detail : ""
      // [CWE-532] Same scrub-then-bound discipline as stderr above.
      return failText("WORKER_AIDER_LLM_ERROR", true, { detail: bounded(scrub(errorDetail), 200) })
    }

    // Clean harness result — map diagnostics onto a non-terminal worker_completed.
    const editedFiles = Array.isArray(harness.aider_edited_files)
      ? (harness.aider_edited_files as unknown[]).filter((f): f is string => typeof f === "string")
      : []
    const numMalformed = coerceNonNegInt(harness.num_malformed_responses, 0)
    const numReflections = coerceNonNegInt(harness.num_reflections, 0)
    const numExhausted = coerceNonNegInt(harness.num_exhausted_context_windows, 0)
    const tokensSent = coerceNonNegInt(harness.total_tokens_sent, 0)
    const tokensReceived = coerceNonNegInt(harness.total_tokens_received, 0)
    const totalCost = coerceNonNegFinite(harness.total_cost, 0)
    const reflectionsCapped = harness.reflections_capped === true

    await safeAppend(
      makeEvent("worker_completed", {
        elapsed_ms: elapsedMs,
        aider_edited_files_count: editedFiles.length,
        num_malformed_responses: numMalformed,
        num_reflections: numReflections,
        num_exhausted_context_windows: numExhausted,
        reflections_capped: reflectionsCapped,
        total_cost: totalCost,
        tokens_sent: tokensSent,
        tokens_received: tokensReceived,
      })
    )

    // ── Cross-back: reuse workerResponse verbatim. ──
    const dr = await diffWorktree(worktree.path, files)
    if (dr.truncated) {
      await safeAppend(makeEvent("patch_checked", { failure_stage: "WORKER_RESPONSE_TOO_LARGE", outcome: "fail" }))
      return failText("WORKER_RESPONSE_TOO_LARGE", false)
    }

    // R1: the returned patch is ALWAYS a unified git diff regardless of the tier's
    // model-facing edit_format, so parse as "unified_diff".
    const synthetic =
      JSON.stringify({ report: "success", files: editedFiles }) + "\n" + PATCH_BEGIN + "\n" + dr.diff + "\n" + PATCH_END
    const parsed = parseWorkerResponse(synthetic, { editFormat: "unified_diff", docsDir: deps.docsDir })

    switch (parsed.classification) {
      case "WORKER_GHOST": {
        await safeAppend(makeEvent("patch_checked", { failure_stage: "WORKER_GHOST", outcome: "fail" }))
        return failText("WORKER_GHOST", false, { detail: bounded(parsed.detail ?? "", 200) })
      }
      case "PATCH_PARSE_FAIL":
      case "PATCH_REDACTION_MARKER_FAIL":
      case "PATCH_PROTECTED_PATH_FAIL": {
        await safeAppend(makeEvent("patch_checked", { failure_stage: parsed.classification, outcome: "fail" }))
        return failText(parsed.classification, false, { detail: bounded(parsed.detail ?? "", 200) })
      }
      case "OK": {
        const patch = parsed.patch ?? ""
        // [CWE-73] Enforce delegation scope: an OK-classified patch may still target a
        // file outside the delegated files[] scope. Treat exactly like the parser's
        // PATCH_PROTECTED_PATH_FAIL.
        const unlistedTarget = (parsed.targetPaths ?? []).find((t) => !targetInListedFiles(t, files))
        if (unlistedTarget !== undefined) {
          await safeAppend(makeEvent("patch_checked", { failure_stage: "PATCH_PROTECTED_PATH_FAIL", outcome: "fail" }))
          return failText("PATCH_PROTECTED_PATH_FAIL", false, {
            detail: `target path "${unlistedTarget}" is not in the delegated files list`,
          })
        }
        const patchSha = sha256hex(patch)
        await safeAppend(makeEvent("patch_checked", { patch_sha256: patchSha, diff_bytes: Buffer.byteLength(patch) }))
        return withWarnings(
          successText({
            delegationId,
            model: tierCfg.model,
            tier,
            capabilityClass: tierCfg.workerClass,
            editFormat,
            editedFiles,
            numMalformed,
            numReflections,
            totalCost,
            elapsedMs,
            baseFileHashes,
            patch,
            patchSha,
          })
        )
      }
      default: {
        // Exhaustiveness backstop — ResponseClassification is a closed union; the only
        // remaining member is MODEL_SCHEMA_FAIL, unreachable here since the synthetic
        // metadata JSON is constructed by this module and always well-shaped.
        const _exhaustive: never = parsed.classification as never
        await safeAppend(makeEvent("patch_checked", { failure_stage: "MODEL_SCHEMA_FAIL", outcome: "fail" }))
        return failText("MODEL_SCHEMA_FAIL", false, {
          detail: `unclassified worker response: ${String(_exhaustive)}`,
        })
      }
    }
  } finally {
    const td = await teardownWorktree(process.cwd(), worktree.path)
    // [B] Only a FAILED delegation's teardown event carries outcome:"fail" (terminal,
    // matching invoke_worker's convention where the failure event is terminal); a
    // successful delegation's teardown event carries no outcome and stays open for
    // the ledger hook to finalize.
    await safeAppend(
      makeEvent("worktree_torn_down", { torn_down_ok: td.ok, ...(terminalOutcome ? { outcome: terminalOutcome } : {}) })
    )
  }
}

// ─── Success return builder ──────────────────────────────────────────────────────
interface SuccessMeta {
  delegationId: string
  model: string
  tier: string
  capabilityClass: string
  editFormat: EditFormat
  editedFiles: string[]
  numMalformed: number
  numReflections: number
  totalCost: number
  elapsedMs: number
  baseFileHashes: Record<string, string>
  patch: string
  patchSha: string
}

function successText(meta: SuccessMeta): string {
  const lines = [
    "status: ok",
    `delegation_id: ${meta.delegationId}`,
    `model: ${meta.model}`,
    `tier: ${meta.tier}`,
    "worker_kind: aider-cli",
    `capability_class: ${meta.capabilityClass}`,
    `edit_format: ${meta.editFormat}`,
    `aider_edited_files: ${meta.editedFiles.join(", ")}`,
    `num_malformed_responses: ${meta.numMalformed}`,
    `num_reflections: ${meta.numReflections}`,
    `total_cost: ${meta.totalCost}`,
    `elapsed_ms: ${meta.elapsedMs}`,
    "base_file_hashes:",
  ]
  for (const [p, h] of Object.entries(meta.baseFileHashes)) lines.push(`  ${p}: ${h}`)
  lines.push(`patch_sha256: ${meta.patchSha}`)
  lines.push("")
  // The patch is emitted BYTE-VERBATIM between the exact sentinels — never trimmed or rewritten.
  lines.push(PATCH_BEGIN)
  lines.push(meta.patch)
  lines.push(PATCH_END)
  return lines.join("\n")
}
