// Append-only delegation-telemetry sidecar (Unit 4d). A hash-chained JSONL audit
// stream: one JSON line per event, each line carrying `event_hash` (sha256 of its
// own canonical form) and `prev_event_hash` (the previous line's `event_hash`), so
// tampering or truncation mid-file is LOUDLY detectable — readEvents throws on any
// break in the chain rather than silently accepting a doctored or truncated file.
//
// Torn final line: a final line lacking a trailing LF — whether or not it parses — is
// treated as an interrupted append. readEvents SKIPS it with a warning (never hashes or
// chains it), and appendEvent REFUSES to write (throws) rather than concatenate a new
// line onto the torn tail and corrupt the stream. [CWE-354]
//
// Single-active-session assumption: this sidecar assumes ONE active Foreman session
// writes to a given path at a time. There is deliberately NO lock file here —
// multi-writer coordination across processes is out of scope for v0.5.0 (v0.6).
//
// Append-only: lines are NEVER rewritten, updated, compacted, or rotated. A terminal
// state (e.g. `outcome: "pass"`) is always recorded as a NEW event, never as an edit
// to a prior line.

import fs from "fs/promises"
import { createHash, randomBytes } from "crypto"
import { scrub } from "./redaction.js"

// ─── Closed enums ─────────────────────────────────────────────────────────────
export type EventType =
  | "delegation_started"
  | "worker_completed"
  | "patch_checked"
  | "validation_completed"

export type FailureStage =
  | "BRIEF_TOO_LARGE"
  | "WORKER_PAYLOAD_SECRET_BLOCK"
  | "WORKER_UNREACHABLE"
  | "WORKER_TIMEOUT"
  | "WORKER_AUTH_FAIL"
  | "WORKER_QUOTA_FAIL"
  | "WORKER_MODEL_NOT_FOUND"
  | "WORKER_RESPONSE_TOO_LARGE"
  | "WORKER_GHOST"
  | "MODEL_SCHEMA_FAIL"
  | "PATCH_PARSE_FAIL"
  | "PATCH_REDACTION_MARKER_FAIL"
  | "PATCH_PROTECTED_PATH_FAIL"
  | "ED_STALE"
  | "PATCH_APPLY_FAIL"
  | "BLD_ERR"
  | "W_REJ"

export type FinishReasonClass = "stop" | "length" | "content_filter" | "other"
export type Tier = "cheap" | "standard" | "premium"
export type CapabilityClass = "frontier" | "capable" | "compact"
export type EditFormat = "unified_diff" | "search_replace" | "whole_file"
export type Outcome = "pass" | "fail" | "inconclusive"

const EVENT_TYPES = new Set<string>([
  "delegation_started",
  "worker_completed",
  "patch_checked",
  "validation_completed",
])

const FAILURE_STAGES = new Set<string>([
  "BRIEF_TOO_LARGE",
  "WORKER_PAYLOAD_SECRET_BLOCK",
  "WORKER_UNREACHABLE",
  "WORKER_TIMEOUT",
  "WORKER_AUTH_FAIL",
  "WORKER_QUOTA_FAIL",
  "WORKER_MODEL_NOT_FOUND",
  "WORKER_RESPONSE_TOO_LARGE",
  "WORKER_GHOST",
  "MODEL_SCHEMA_FAIL",
  "PATCH_PARSE_FAIL",
  "PATCH_REDACTION_MARKER_FAIL",
  "PATCH_PROTECTED_PATH_FAIL",
  "ED_STALE",
  "PATCH_APPLY_FAIL",
  "BLD_ERR",
  "W_REJ",
])

const FINISH_REASON_CLASSES = new Set<string>(["stop", "length", "content_filter", "other"])
const TIERS = new Set<string>(["cheap", "standard", "premium"])
const CAPABILITY_CLASSES = new Set<string>(["frontier", "capable", "compact"])
const EDIT_FORMATS = new Set<string>(["unified_diff", "search_replace", "whole_file"])
const OUTCOMES = new Set<string>(["pass", "fail", "inconclusive"])

// ─── Envelope shape ────────────────────────────────────────────────────────────
// Input accepted by appendEvent — everything in the envelope EXCEPT the two
// hash-chain fields, which are computed and must never be caller-supplied.
export interface SidecarEventInput {
  v: number
  ts: string
  event_id: string
  event_type: EventType
  session_id?: string
  phase: string
  unit_id: string
  attempt: number
  delegation_id: string
  provider: string
  model: string
  tier: Tier
  capability_class: CapabilityClass
  edit_format: EditFormat
  repair_attempt: number
  brief_hash: string
  prompt_prefix_hash: string
  base_file_hashes: Record<string, string>
  diff_bytes?: number
  tokens?: { in: number; out: number }
  elapsed_ms?: number
  finish_reason_class?: FinishReasonClass
  failure_stage?: FailureStage
  worker_confidence?: number
  outcome?: Outcome
  patch_sha256?: string
}

// Full envelope as it exists on disk / in memory once appended: the hash-chain
// fields are always present (prev_event_hash absent only on the first line).
export interface SidecarEvent extends SidecarEventInput {
  prev_event_hash?: string
  event_hash: string
}

const REQUIRED_FIELDS = [
  "v",
  "ts",
  "event_id",
  "event_type",
  "phase",
  "unit_id",
  "attempt",
  "delegation_id",
  "provider",
  "model",
  "tier",
  "capability_class",
  "edit_format",
  "repair_attempt",
  "brief_hash",
  "prompt_prefix_hash",
  "base_file_hashes",
] as const

const OPTIONAL_FIELDS = [
  "session_id",
  "diff_bytes",
  "tokens",
  "elapsed_ms",
  "finish_reason_class",
  "failure_stage",
  "worker_confidence",
  "outcome",
  "patch_sha256",
] as const

const ALLOWED_INPUT_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])

// Identifier fields carry the length-64 cap (plus every key/value of base_file_hashes,
// handled separately below since it is a map, not a single string).
const IDENTIFIER_FIELDS = [
  "event_id",
  "session_id",
  "phase",
  "unit_id",
  "delegation_id",
  "provider",
  "model",
  "tier",
  "capability_class",
  "edit_format",
  "brief_hash",
  "prompt_prefix_hash",
  "patch_sha256",
] as const

const IDENTIFIER_CAP = 64
const MAX_LINE_BYTES = 8192

// ─── Identifier bounding ────────────────────────────────────────────────────────
// The envelope caps every identifier at IDENTIFIER_CAP chars and appendEvent THROWS
// over the cap. Callers whose LEGAL inputs may exceed the cap — invoke_worker's
// phase/unit_id (the input schema allows up to 10000 chars) and absolute file paths
// used as base_file_hashes keys — run them through this first: a value at or under the
// cap passes through unchanged; an over-cap value collapses to a bounded, deterministic
// digest (`sha256:<first-16-hex>`). ONE implementation guarantees the telemetry copy can
// never drift from the cap the envelope enforces, so a legal long id keeps the audit
// chain alive instead of silently degrading every event to a warning. [CWE-20]
export function boundIdentifier(value: string): string {
  if (value.length <= IDENTIFIER_CAP) return value
  return `sha256:${createHash("sha256").update(value, "utf-8").digest("hex").slice(0, 16)}`
}

// ─── Canonical JSON (exported for tests) ──────────────────────────────────────
// Sorts every object's keys recursively before stringifying, so two calls given
// the same logical object always produce byte-identical output — required for a
// stable, reproducible hash.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

// ─── Validation ────────────────────────────────────────────────────────────────
function validateEnum(field: string, value: unknown, allowed: ReadonlySet<string>): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(
      `eventsSidecar: '${field}' has invalid value ${JSON.stringify(value)} — must be one of: ${Array.from(allowed).join(", ")}`
    )
  }
}

function validateNonNegativeInt(field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`eventsSidecar: '${field}' must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
}

function validateEnvelope(event: Record<string, unknown>): void {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("eventsSidecar: event must be a plain object")
  }

  for (const key of Object.keys(event)) {
    if (key === "event_hash") {
      throw new Error("eventsSidecar: caller must not supply 'event_hash' — it is computed by appendEvent")
    }
    if (key === "prev_event_hash") {
      throw new Error("eventsSidecar: caller must not supply 'prev_event_hash' — it is computed by appendEvent")
    }
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      throw new Error(`eventsSidecar: unknown field '${key}' (closed envelope)`)
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (event[field] === undefined) {
      throw new Error(`eventsSidecar: missing required field '${field}'`)
    }
  }

  if (event.v !== 1) {
    throw new Error(`eventsSidecar: 'v' must be 1, got ${JSON.stringify(event.v)}`)
  }
  if (typeof event.ts !== "string" || Number.isNaN(Date.parse(event.ts))) {
    throw new Error(`eventsSidecar: 'ts' must be an ISO date string, got ${JSON.stringify(event.ts)}`)
  }

  validateEnum("event_type", event.event_type, EVENT_TYPES)
  validateEnum("tier", event.tier, TIERS)
  validateEnum("capability_class", event.capability_class, CAPABILITY_CLASSES)
  validateEnum("edit_format", event.edit_format, EDIT_FORMATS)
  if (event.finish_reason_class !== undefined) {
    validateEnum("finish_reason_class", event.finish_reason_class, FINISH_REASON_CLASSES)
  }
  if (event.failure_stage !== undefined) {
    validateEnum("failure_stage", event.failure_stage, FAILURE_STAGES)
  }
  if (event.outcome !== undefined) {
    validateEnum("outcome", event.outcome, OUTCOMES)
  }

  for (const field of IDENTIFIER_FIELDS) {
    const value = event[field]
    if (value === undefined) continue
    if (typeof value !== "string") {
      throw new Error(`eventsSidecar: '${field}' must be a string, got ${typeof value}`)
    }
    if (value.length > IDENTIFIER_CAP) {
      throw new Error(`eventsSidecar: '${field}' exceeds ${IDENTIFIER_CAP}-char identifier cap (${value.length} chars)`)
    }
  }

  validateNonNegativeInt("attempt", event.attempt)
  validateNonNegativeInt("repair_attempt", event.repair_attempt)
  if (event.diff_bytes !== undefined) validateNonNegativeInt("diff_bytes", event.diff_bytes)
  if (event.elapsed_ms !== undefined) validateNonNegativeInt("elapsed_ms", event.elapsed_ms)
  if (event.worker_confidence !== undefined && typeof event.worker_confidence !== "number") {
    throw new Error("eventsSidecar: 'worker_confidence' must be a number")
  }

  const bfh = event.base_file_hashes
  if (typeof bfh !== "object" || bfh === null || Array.isArray(bfh)) {
    throw new Error("eventsSidecar: 'base_file_hashes' must be an object")
  }
  for (const [k, v] of Object.entries(bfh as Record<string, unknown>)) {
    if (k.length > IDENTIFIER_CAP) {
      throw new Error(`eventsSidecar: base_file_hashes key '${k}' exceeds ${IDENTIFIER_CAP}-char identifier cap`)
    }
    if (typeof v !== "string") {
      throw new Error(`eventsSidecar: base_file_hashes['${k}'] must be a string`)
    }
    if (v.length > IDENTIFIER_CAP) {
      throw new Error(`eventsSidecar: base_file_hashes['${k}'] value exceeds ${IDENTIFIER_CAP}-char identifier cap (${v.length} chars)`)
    }
  }

  if (event.tokens !== undefined) {
    const tokens = event.tokens
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
      throw new Error("eventsSidecar: 'tokens' must be an object with 'in' and 'out' numbers")
    }
    const tokensObj = tokens as Record<string, unknown>
    for (const k of Object.keys(tokensObj)) {
      if (k !== "in" && k !== "out") {
        throw new Error(`eventsSidecar: unknown field 'tokens.${k}' (closed envelope)`)
      }
    }
    if (typeof tokensObj.in !== "number" || typeof tokensObj.out !== "number") {
      throw new Error("eventsSidecar: 'tokens.in' and 'tokens.out' must both be numbers")
    }
  }
}

// ─── Deep scrub (defense-in-depth) ─────────────────────────────────────────────
// Events are hashes/enums/numbers by construction, so this is normally a no-op —
// but it guarantees no secret can ride ANY string field (including base_file_hashes
// keys/values) into the durable stream. Applied BEFORE hashing so the stored bytes
// are exactly what was hashed.
function deepScrub<T>(value: T): T {
  if (typeof value === "string") {
    return scrub(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepScrub(item)) as unknown as T
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[scrub(k)] = deepScrub(v)
    }
    return result as unknown as T
  }
  return value
}

// ─── Per-path mutex registry ────────────────────────────────────────────────────
// Separate from ledger/journal/progress lock registries — do NOT share or import
// from those files. The read-tail + append sequence runs inside this lock.
const sidecarLockRegistry = new Map<string, Promise<void>>()

function withSidecarLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = sidecarLockRegistry.get(filePath) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>((r) => {
    resolve = r
  })
  sidecarLockRegistry.set(filePath, next)
  return prev.then(fn).finally(() => resolve())
}

// ─── Read the file's tail (last non-empty line + torn-tail flag; no chain verify) ───
// Returns null when the file is absent (ENOENT). `torn` is true when the file has
// content that does NOT end in a trailing LF — an interrupted append — in which case
// appendEvent must refuse to write rather than concatenate onto the torn tail.
async function readTail(filePath: string): Promise<{ lastLine: string | null; torn: boolean } | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") return null
    throw err
  }
  const torn = raw.length > 0 && !raw.endsWith("\n")
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0)
  const lastLine = lines.length === 0 ? null : lines[lines.length - 1]
  return { lastLine, torn }
}

// ─── Append ──────────────────────────────────────────────────────────────────
export async function appendEvent(filePath: string, event: SidecarEventInput): Promise<SidecarEvent> {
  validateEnvelope(event as unknown as Record<string, unknown>)
  const scrubbed = deepScrub(event as unknown as Record<string, unknown>)

  return withSidecarLock(filePath, async () => {
    const tail = await readTail(filePath)
    let prevEventHash: string | undefined

    if (tail !== null) {
      // A torn final line (existing content with no trailing LF) means a prior append
      // was interrupted. Never chain onto or concatenate after it — fs.appendFile would
      // glue the new line onto the torn tail and corrupt the file. Throw, write nothing. [CWE-354]
      if (tail.torn) {
        throw new Error(
          `eventsSidecar: cannot append to '${filePath}' — file ends in a torn final line (no trailing LF); repair or truncate the torn tail first`
        )
      }
      const lastLine = tail.lastLine
      if (lastLine !== null) {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(lastLine)
        } catch (err) {
          throw new Error(
            `eventsSidecar: cannot append to '${filePath}' — last line is not valid JSON: ${(err as Error).message}`
          )
        }
        if (typeof parsed.event_hash !== "string") {
          throw new Error(`eventsSidecar: cannot append to '${filePath}' — last line has no event_hash`)
        }
        prevEventHash = parsed.event_hash
      }
    }

    const withPrev: Record<string, unknown> =
      prevEventHash !== undefined ? { ...scrubbed, prev_event_hash: prevEventHash } : { ...scrubbed }

    const eventHash = createHash("sha256").update(canonicalStringify(withPrev), "utf-8").digest("hex")
    const full = { ...withPrev, event_hash: eventHash } as SidecarEvent

    const line = canonicalStringify(full)
    const byteLength = Buffer.byteLength(line, "utf-8")
    if (byteLength > MAX_LINE_BYTES) {
      throw new Error(
        `eventsSidecar: event line exceeds ${MAX_LINE_BYTES}-byte cap (${byteLength} bytes) — refusing to write`
      )
    }

    await fs.appendFile(filePath, line + "\n", "utf-8")
    return full
  })
}

// ─── Read ────────────────────────────────────────────────────────────────────
export interface ReadEventsResult {
  events: SidecarEvent[]
  absent?: boolean
  warning?: string
}

export async function readEvents(filePath: string): Promise<ReadEventsResult> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") return { events: [], absent: true }
    throw err
  }

  // A final line WITHOUT a trailing LF is torn by definition (an append interrupted
  // mid-write) and is excluded from the chain regardless of parseability. [CWE-354]
  const endsWithNewline = raw.endsWith("\n")

  // CRLF-tolerant split. A single trailing empty/whitespace-only segment after the
  // final LF is normal termination, not a torn line — drop it before processing.
  const rawLines = raw.split("\n")
  if (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
    rawLines.pop()
  }
  const lines = rawLines.map((l) => l.replace(/\r$/, ""))

  if (lines.length === 0) return { events: [] }

  const events: SidecarEvent[] = []
  let warning: string | undefined
  let prevHash: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i]
    const isFinal = i === lines.length - 1

    // Torn final line: no trailing LF → skip BEFORE any parse/hash/chain check, even if
    // the line would parse. A parseable-but-LF-less tail must never be hashed or chained. [CWE-354]
    if (isFinal && !endsWithNewline) {
      warning = `torn final line skipped (line ${lineNo})`
      break
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      if (isFinal) {
        warning = `torn final line skipped (line ${lineNo})`
        break
      }
      throw new Error(`eventsSidecar: invalid JSON at line ${lineNo} of '${filePath}': ${(err as Error).message}`)
    }

    const claimedHash = parsed.event_hash
    const withoutHash: Record<string, unknown> = { ...parsed }
    delete withoutHash.event_hash
    const recomputed = createHash("sha256").update(canonicalStringify(withoutHash), "utf-8").digest("hex")
    if (claimedHash !== recomputed) {
      throw new Error(`eventsSidecar: hash mismatch at line ${lineNo} of '${filePath}' — event may be tampered`)
    }

    if (lineNo === 1) {
      if (parsed.prev_event_hash !== undefined) {
        throw new Error(`eventsSidecar: line 1 of '${filePath}' must not carry prev_event_hash (missing head link)`)
      }
    } else if (parsed.prev_event_hash !== prevHash) {
      throw new Error(
        `eventsSidecar: chain break at line ${lineNo} of '${filePath}' — prev_event_hash does not match line ${lineNo - 1}'s event_hash`
      )
    }

    events.push(parsed as unknown as SidecarEvent)
    prevHash = parsed.event_hash as string
  }

  return warning ? { events, warning } : { events }
}

// ─── Open-delegation lookup (consumed by the 4g ledger hook) ──────────────────
export async function openDelegation(
  filePath: string,
  phase: string,
  unitId: string
): Promise<{ delegationId: string; lastEvent: SidecarEvent } | null> {
  const { events } = await readEvents(filePath)

  const filtered = events.filter((e) => e.phase === phase && e.unit_id === unitId)
  if (filtered.length === 0) return null

  // Group by delegation_id, preserving file order; remember first-seen order so
  // "latest" means "the group whose first event appears last in the file".
  const groups = new Map<string, SidecarEvent[]>()
  const firstSeenOrder: string[] = []
  for (const e of filtered) {
    let group = groups.get(e.delegation_id)
    if (!group) {
      group = []
      groups.set(e.delegation_id, group)
      firstSeenOrder.push(e.delegation_id)
    }
    group.push(e)
  }

  for (let i = firstSeenOrder.length - 1; i >= 0; i--) {
    const delegationId = firstSeenOrder[i]
    const groupEvents = groups.get(delegationId) as SidecarEvent[]
    const last = groupEvents[groupEvents.length - 1]
    if (last.outcome === undefined) {
      return { delegationId, lastEvent: last }
    }
  }

  return null
}

// ─── Follow-up event builder (consumed by the 4g ledger hook) ─────────────────
/**
 * Builds the input for a follow-up event on an existing delegation: copies the
 * delegation-scoped envelope fields from a prior event, stamps a fresh event_id/ts,
 * and merges the given extras. Pure — consumed by the write_ledger post-write hook (4g).
 */
export function followUpEventInput(
  lastEvent: SidecarEvent,
  eventType: SidecarEventInput["event_type"],
  extra: Partial<SidecarEventInput>
): SidecarEventInput {
  const base: SidecarEventInput = {
    v: lastEvent.v,
    ts: new Date().toISOString(),
    event_id: `evt_${randomBytes(8).toString("hex")}`,
    event_type: eventType,
    phase: lastEvent.phase,
    unit_id: lastEvent.unit_id,
    attempt: lastEvent.attempt,
    delegation_id: lastEvent.delegation_id,
    provider: lastEvent.provider,
    model: lastEvent.model,
    tier: lastEvent.tier,
    capability_class: lastEvent.capability_class,
    edit_format: lastEvent.edit_format,
    repair_attempt: lastEvent.repair_attempt,
    brief_hash: lastEvent.brief_hash,
    prompt_prefix_hash: lastEvent.prompt_prefix_hash,
    base_file_hashes: lastEvent.base_file_hashes,
    ...(lastEvent.session_id !== undefined ? { session_id: lastEvent.session_id } : {}),
  }
  return { ...base, ...extra }
}
