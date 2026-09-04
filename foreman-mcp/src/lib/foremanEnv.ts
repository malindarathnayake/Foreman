import fs from "fs/promises"
import path from "path"
import os from "os"
import { runExternalCli } from "./externalCli.js"
import { logEvent } from "./journal.js"
import { registerSecret, harvestSecrets } from "./redaction.js"

/**
 * `.foremanenv` config loader for the worker-invoker (unit 4c/4f).
 *
 * `.foremanenv` is a consumer-owned, git-ignored INI-style file that names the API
 * base/key indirection and per-tier model routing for delegated workers. This is a
 * SECURITY BOUNDARY (D1): the file holds the API-key indirection, so the loader:
 *
 *   1. Refuses to load if the file is git-tracked, or exists but is not git-ignored
 *      (a leaked `.foremanenv` leaks the key-env-var name, and — worse — a careless
 *      edit could put a raw key inline where git would then commit it).
 *   2. Validates fail-fast with corrected-call errors: every failure message names
 *      the exact line to add/fix and, where relevant, what IS currently configured —
 *      never a bare "invalid config".
 *   3. Never lets the resolved API key VALUE escape this module: it is registered
 *      with the redaction module (`registerSecret`) and otherwise appears nowhere —
 *      not in the returned config, not in any error message, not in any log.
 *
 * Tier substitution never happens here — the loader returns exactly what is
 * configured, nothing inferred or defaulted beyond the documented per-tier defaults
 * (`editFormat` -> class-dependent: "whole_file" for the `compact` class else
 * "unified_diff"; `workerKind` -> "remote-chat"). Per-call tier
 * *resolution* (e.g. what happens when a caller asks for a tier that isn't configured)
 * is unit 4f's job.
 */

export type Tier = "cheap" | "standard" | "premium"
export type WorkerClass = "frontier" | "capable" | "compact"
export type EditFormat = "unified_diff" | "search_replace" | "whole_file"
/** Only remote-chat remains (aider-cli left with aider_worker in 0.6.3). The key stays accepted for config compatibility. */
export type WorkerKind = "remote-chat"

export interface TierConfig {
  model: string
  workerClass: WorkerClass
  editFormat: EditFormat
  reasoningEffort?: string
  workerKind: WorkerKind        // defaults to "remote-chat" when FOREMAN_WORKER_KIND_<T> is unset
}

export interface ForemanEnvConfig {
  apiBase: string
  apiKeyRef: string
  tiers: Partial<Record<Tier, TierConfig>>
  schemaVersion: number
}

export type ForemanEnvResult =
  | { status: "ok"; config: ForemanEnvConfig }
  | { status: "config_error"; message: string }
  | { status: "refused"; message: string }

// ─── Recognized keys ────────────────────────────────────────────────────────────

const TIERS: readonly Tier[] = ["cheap", "standard", "premium"]

const TIER_SUFFIX: Record<Tier, string> = {
  cheap: "CHEAP",
  standard: "STANDARD",
  premium: "PREMIUM",
}

const WORKER_CLASSES: readonly WorkerClass[] = ["frontier", "capable", "compact"]
const EDIT_FORMATS: readonly EditFormat[] = ["unified_diff", "search_replace", "whole_file"]
const WORKER_KINDS: readonly WorkerKind[] = ["remote-chat"]

const SIMPLE_KEYS = new Set(["schema_version", "FOREMAN_API_BASE", "FOREMAN_API_KEY"])

const TIER_KEY_PREFIXES: readonly string[] = [
  "FOREMAN_TIER_",
  "FOREMAN_WORKER_CLASS_",
  "FOREMAN_EDIT_FORMAT_",
  "FOREMAN_REASONING_EFFORT_",
  "FOREMAN_WORKER_KIND_",
]

/**
 * Council-seat key vocabulary. Seats are INDEPENDENT REVIEWERS, not worker tiers: they never
 * edit and carry no edit format, and they are addressed by LETTER so an operator can swap one
 * seat's model without disturbing the others.
 *
 * The vocabulary lives here (with the rest of the `.foremanenv` key allowlist) but the seats are
 * PARSED in lib/councilConfig.ts. That split is deliberate: `.foremanenv` must ACCEPT these keys
 * — an unrecognized key is a hard config_error, so an operator putting seats here would otherwise
 * break `invoke_worker` — while the council's own resolution spans two files and must degrade to
 * "unavailable" rather than error. Keeping council parsing out of this module leaves the
 * worker's ForemanEnvConfig shape, and its security boundary, untouched.
 */
export type CouncilSeatId = "a" | "b" | "c"

export const COUNCIL_SEATS: readonly CouncilSeatId[] = ["a", "b", "c"]

export const SEAT_SUFFIX: Record<CouncilSeatId, string> = { a: "A", b: "B", c: "C" }

// NOTE: FOREMAN_COUNCIL_REASONING_ is a strict prefix of FOREMAN_COUNCIL_REASONING_MAX_TOKENS_.
// Recognition checks EVERY prefix rather than the first match, so the longer key resolves by its
// own prefix instead of being rejected on the shorter one's failed suffix lookup.
const COUNCIL_KEY_PREFIXES: readonly string[] = [
  "FOREMAN_COUNCIL_SEAT_",
  "FOREMAN_COUNCIL_LABEL_",
  "FOREMAN_COUNCIL_REASONING_",
  "FOREMAN_COUNCIL_REASONING_MAX_TOKENS_",
]

const RECOGNIZED_KEYS_TEXT =
  "schema_version, FOREMAN_API_BASE, FOREMAN_API_KEY, " +
  "FOREMAN_TIER_<CHEAP|STANDARD|PREMIUM>, FOREMAN_WORKER_CLASS_<CHEAP|STANDARD|PREMIUM>, " +
  "FOREMAN_EDIT_FORMAT_<CHEAP|STANDARD|PREMIUM>, FOREMAN_REASONING_EFFORT_<CHEAP|STANDARD|PREMIUM>, " +
  "FOREMAN_WORKER_KIND_<CHEAP|STANDARD|PREMIUM>, " +
  "FOREMAN_COUNCIL_SEAT_<A|B|C>, FOREMAN_COUNCIL_LABEL_<A|B|C>, " +
  "FOREMAN_COUNCIL_REASONING_<A|B|C>, FOREMAN_COUNCIL_REASONING_MAX_TOKENS_<A|B|C>"

function tierForSuffix(suffix: string): Tier | undefined {
  return TIERS.find((t) => TIER_SUFFIX[t] === suffix)
}

export function seatForSuffix(suffix: string): CouncilSeatId | undefined {
  return COUNCIL_SEATS.find((s) => SEAT_SUFFIX[s] === suffix)
}

function isRecognizedKey(key: string): boolean {
  if (SIMPLE_KEYS.has(key)) return true
  for (const prefix of TIER_KEY_PREFIXES) {
    if (key.startsWith(prefix) && tierForSuffix(key.slice(prefix.length)) !== undefined) {
      return true
    }
  }
  for (const prefix of COUNCIL_KEY_PREFIXES) {
    if (key.startsWith(prefix) && seatForSuffix(key.slice(prefix.length)) !== undefined) {
      return true
    }
  }
  return false
}

function tierKey(prefix: string, tier: Tier): string {
  return `${prefix}${TIER_SUFFIX[tier]}`
}

export function seatKey(prefix: string, seat: CouncilSeatId): string {
  return `${prefix}${SEAT_SUFFIX[seat]}`
}

// ─── Message builders ───────────────────────────────────────────────────────────

function missingKeyMessage(key: string, exactLine: string): string {
  return `.foremanenv is missing required key '${key}'.\n\nAdd this line:\n  ${exactLine}\n`
}

function unsupportedValueMessage(key: string, value: string, supported: string): string {
  return `unsupported value for '${key}': '${value}'.\n\nSupported values: ${supported}\n`
}

function buildMissingFileMessage(filePath: string): string {
  return (
    `.foremanenv not found at ${filePath}.\n\n` +
    "Create one with (minimal example):\n\n" +
    "schema_version=1\n" +
    "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
    "FOREMAN_API_KEY=${ENV:YOUR_KEY_ENV_VAR}\n"
  )
}

// ─── Parsing ─────────────────────────────────────────────────────────────────────

interface ParsedEntry {
  key: string
  value: string
  line: number
}

type ParseResult =
  | { ok: true; entries: Map<string, ParsedEntry> }
  | { ok: false; message: string }

/**
 * A `#` starts a trailing comment only when it is preceded by whitespace (the
 * normative example file has trailing comments like `whole_file        # optional`,
 * so this rule is mandatory, not incidental). A `#` glued to the value (e.g. a value
 * that legitimately contains `#`) is left alone.
 */
function stripTrailingComment(raw: string): string {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === "#" && /\s/.test(raw[i - 1])) {
      return raw.slice(0, i)
    }
  }
  return raw
}

/**
 * Parses `.foremanenv` text into an ordered key -> entry map. Handles LF/CRLF,
 * a stripped UTF-8 BOM, blank-line and full-line-comment skipping, trailing-comment
 * stripping, and value trimming. Duplicate keys fail fast at the second occurrence.
 */
function parseForemanEnv(text: string): ParseResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r\n|\n/)
  const entries = new Map<string, ParsedEntry>()

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const trimmedLine = lines[i].trim()
    if (trimmedLine === "" || trimmedLine.startsWith("#")) continue

    const eq = trimmedLine.indexOf("=")
    if (eq === -1) {
      return {
        ok: false,
        message: `.foremanenv line ${lineNo} is malformed (expected KEY=VALUE): '${trimmedLine}'`,
      }
    }

    const key = trimmedLine.slice(0, eq).trim()
    if (key === "") {
      return {
        ok: false,
        message: `.foremanenv line ${lineNo} is malformed (empty key before '='): '${trimmedLine}'`,
      }
    }

    if (entries.has(key)) {
      return {
        ok: false,
        message: `.foremanenv has duplicate key '${key}' (line ${lineNo}).`,
      }
    }

    const valueRaw = trimmedLine.slice(eq + 1)
    const value = stripTrailingComment(valueRaw).trim()
    entries.set(key, { key, value, line: lineNo })
  }

  return { ok: true, entries }
}

// ─── Validation ──────────────────────────────────────────────────────────────────

type ValidationOutcome =
  | { status: "config_error"; message: string }
  | { status: "ok"; config: ForemanEnvConfig; name: string; value: string }

function validateForemanEnv(
  entries: Map<string, ParsedEntry>,
  envSource: Record<string, string | undefined>,
  credentialsPath: string,
  requireKey: boolean
): ValidationOutcome {
  for (const key of entries.keys()) {
    if (!isRecognizedKey(key)) {
      return {
        status: "config_error",
        message: `.foremanenv has unknown key '${key}'.\n\nRecognized keys: ${RECOGNIZED_KEYS_TEXT}\n`,
      }
    }
  }

  const schemaVersionEntry = entries.get("schema_version")
  if (!schemaVersionEntry) {
    return { status: "config_error", message: missingKeyMessage("schema_version", "schema_version=1") }
  }
  if (schemaVersionEntry.value !== "1") {
    return {
      status: "config_error",
      message: unsupportedValueMessage("schema_version", schemaVersionEntry.value, "1"),
    }
  }

  const apiBaseEntry = entries.get("FOREMAN_API_BASE")
  if (!apiBaseEntry) {
    return {
      status: "config_error",
      message: missingKeyMessage("FOREMAN_API_BASE", "FOREMAN_API_BASE=https://openrouter.ai/api/v1"),
    }
  }
  let urlOk = false
  try {
    const parsedUrl = new URL(apiBaseEntry.value)
    urlOk = parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:"
  } catch {
    urlOk = false
  }
  if (!urlOk) {
    return {
      status: "config_error",
      message: unsupportedValueMessage(
        "FOREMAN_API_BASE",
        apiBaseEntry.value,
        "an http:// or https:// URL (e.g. https://openrouter.ai/api/v1)"
      ),
    }
  }

  const apiKeyEntry = entries.get("FOREMAN_API_KEY")
  if (!apiKeyEntry) {
    return {
      status: "config_error",
      message: missingKeyMessage("FOREMAN_API_KEY", "FOREMAN_API_KEY=${ENV:YOUR_KEY_ENV_VAR}"),
    }
  }
  const match = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKeyEntry.value)
  if (!match) {
    return {
      status: "config_error",
      // NEVER echo apiKeyEntry.value here — a malformed value may itself be an inline secret.
      message:
        "unsupported value for 'FOREMAN_API_KEY': keys are never inline — the value must be " +
        "exactly ${ENV:NAME} (e.g. FOREMAN_API_KEY=${ENV:OPENROUTER_API_KEY}).\n",
    }
  }
  const envName = match[1]
  const resolvedValue = envSource[envName]
  // requireKey === false: the caller wants the file's ROUTING (api base, tiers, key NAME) without
  // demanding the worker's credential. The council uses this — it resolves its own key against its
  // own endpoint, and must not be blocked because an unrelated worker key happens to be unset.
  // The ${ENV:NAME} FORMAT above is still validated either way; only resolution is skipped.
  if (requireKey) {
    // A value that is ITSELF an unresolved ${ENV:...} token is not key material. Accepting it
    // would ship the literal token as a bearer credential and fail as an opaque 401 instead of
    // naming the real problem here (e.g. a home store with FOREMAN_API_KEY=${ENV:FOREMAN_API_KEY}).
    if (resolvedValue !== undefined && isUnresolvedIndirection(resolvedValue)) {
      return {
        status: "config_error",
        message:
          `environment variable '${envName}' resolves to an unresolved indirection token, not a key.\n\n` +
          `Set a real value for '${envName}', or remove the self-referential '\${ENV:...}' entry.\n`,
      }
    }
    if (resolvedValue === undefined || resolvedValue === "") {
      return {
        status: "config_error",
        message:
          `environment variable '${envName}' is not set.\n\n` +
          `Define it in EITHER place:\n` +
          `  1. export it in the environment that starts the server, or\n` +
          `  2. add this line to ${credentialsPath}:\n` +
          `       ${envName}=<your key>\n\n` +
          `The exported value wins when both are present.\n`,
      }
    }
  }

  // ── Tiers ────────────────────────────────────────────────────────────────────
  const configuredTiers = TIERS.filter((t) => entries.has(tierKey("FOREMAN_TIER_", t)))
  const configuredTiersText = configuredTiers.length > 0 ? configuredTiers.join(", ") : "none"

  const tiers: Partial<Record<Tier, TierConfig>> = {}

  for (const tier of TIERS) {
    const tierEntry = entries.get(tierKey("FOREMAN_TIER_", tier))
    const workerClassEntry = entries.get(tierKey("FOREMAN_WORKER_CLASS_", tier))
    const editFormatEntry = entries.get(tierKey("FOREMAN_EDIT_FORMAT_", tier))
    const reasoningEffortEntry = entries.get(tierKey("FOREMAN_REASONING_EFFORT_", tier))
    const workerKindEntry = entries.get(tierKey("FOREMAN_WORKER_KIND_", tier))

    if (!tierEntry) {
      // Orphan: a per-tier key present without its FOREMAN_TIER_<T> anchor.
      const orphan =
        workerClassEntry ?? editFormatEntry ?? reasoningEffortEntry ?? workerKindEntry
      if (orphan) {
        return {
          status: "config_error",
          message:
            `${orphan.key} is set but tier '${tier}' is not configured.\n\n` +
            `Add this line:\n  ${tierKey("FOREMAN_TIER_", tier)}=<model-id>\n`,
        }
      }
      continue
    }

    if (tierEntry.value === "") {
      return {
        status: "config_error",
        message: unsupportedValueMessage(tierEntry.key, tierEntry.value, "any non-empty model id"),
      }
    }

    if (!workerClassEntry) {
      return {
        status: "config_error",
        message:
          `tier '${tier}' is configured (${tierEntry.key}) but is missing its required worker class.\n\n` +
          `Add this line:\n  ${tierKey("FOREMAN_WORKER_CLASS_", tier)}=<frontier|capable|compact>\n\n` +
          `Configured tiers: ${configuredTiersText}\n`,
      }
    }
    if (!(WORKER_CLASSES as readonly string[]).includes(workerClassEntry.value)) {
      return {
        status: "config_error",
        message: unsupportedValueMessage(workerClassEntry.key, workerClassEntry.value, WORKER_CLASSES.join(", ")),
      }
    }

    // Per-tier default: compact/experimental models START on whole_file (most parseable);
    // promote to search_replace/unified_diff only via the later M1 edit-format gate.
    let editFormat: EditFormat =
      (workerClassEntry.value as WorkerClass) === "compact" ? "whole_file" : "unified_diff"
    if (editFormatEntry) {
      if (!(EDIT_FORMATS as readonly string[]).includes(editFormatEntry.value)) {
        return {
          status: "config_error",
          message: unsupportedValueMessage(editFormatEntry.key, editFormatEntry.value, EDIT_FORMATS.join(", ")),
        }
      }
      editFormat = editFormatEntry.value as EditFormat
    }

    if (workerKindEntry && !(WORKER_KINDS as readonly string[]).includes(workerKindEntry.value)) {
      return {
        status: "config_error",
        message: unsupportedValueMessage(workerKindEntry.key, workerKindEntry.value, WORKER_KINDS.join(", ")),
      }
    }

    // worker_kind resolves to remote-chat when unset (back-compat: preserves 0.5.0 behavior).
    const workerKind: WorkerKind = workerKindEntry
      ? (workerKindEntry.value as WorkerKind)
      : "remote-chat"

    tiers[tier] = {
      model: tierEntry.value,
      workerClass: workerClassEntry.value as WorkerClass,
      editFormat,
      workerKind,
      ...(reasoningEffortEntry ? { reasoningEffort: reasoningEffortEntry.value } : {}),
    }
  }

  // Council seats are recognized as valid keys above but are NOT parsed here — lib/councilConfig.ts
  // owns them, because council resolution spans this file AND the home store and must degrade to
  // "unavailable" instead of erroring. The worker's config shape stays exactly as it was.

  return {
    status: "ok",
    name: envName,
    value: resolvedValue ?? "",
    config: {
      apiBase: apiBaseEntry.value,
      apiKeyRef: envName,
      tiers,
      schemaVersion: 1,
    },
  }
}

// ─── Git refusal probes ──────────────────────────────────────────────────────────

const GIT_PROBE_TIMEOUT_MS = 5000

function runGit(dir: string, args: string[]): Promise<{ exitCode: number }> {
  return runExternalCli("git", ["-C", dir, ...args], GIT_PROBE_TIMEOUT_MS)
}

interface Refusal {
  reason: string
  message: string
}

/**
 * Runs the git refusal probes. Returns null when the probes pass (proceed to parse).
 * A directory that is not inside a git work tree (or where `git` itself is
 * unavailable/erroring) is NOT a refusal — consumer repos without git are legal, and
 * the worst case of failing open here is the pre-existing (no-loader) behavior.
 * Once inside a work tree, failure to positively prove "ignored" is treated as a
 * refusal (fail CLOSED) — this is the security boundary, not a convenience check.
 */
async function checkGitRefusal(dir: string): Promise<Refusal | null> {
  const repoCheck = await runGit(dir, ["rev-parse", "--is-inside-work-tree"])
  if (repoCheck.exitCode !== 0) {
    return null
  }

  const tracked = await runGit(dir, ["ls-files", "--error-unmatch", ".foremanenv"])
  if (tracked.exitCode === 0) {
    return {
      reason: ".foremanenv is git-tracked",
      message:
        ".foremanenv is tracked by git — refusing to load a git-tracked secrets file.\n\n" +
        "Fix:\n" +
        "  echo .foremanenv >> .gitignore\n" +
        "  git rm --cached .foremanenv\n",
    }
  }

  const ignored = await runGit(dir, ["check-ignore", ".foremanenv"])
  if (ignored.exitCode !== 0) {
    return {
      reason: ".foremanenv is not git-ignored",
      message:
        ".foremanenv is not git-ignored — refusing to load an unprotected secrets file.\n\n" +
        "Fix:\n" +
        "  echo .foremanenv >> .gitignore\n",
    }
  }

  return null
}

async function bestEffortSecBlock(journalPath: string | undefined, reason: string): Promise<void> {
  if (!journalPath) return
  try {
    await logEvent(journalPath, {
      operation: "log_event",
      data: { t: "SEC_BLOCK", u: "foremanenv", tok: 0, msg: reason },
    })
  } catch {
    // Best-effort only — must never throw into the loader.
  }
}

// ─── Home credential store ───────────────────────────────────────────────────────

/**
 * Operator-owned credential file, outside every repository: `~/.foreman-mcp/.env`.
 *
 * This is an ENV-VAR SOURCE, not a second config file. `.foremanenv` still names WHICH variable
 * holds the key (`FOREMAN_API_KEY=${ENV:NAME}`); this file is one place that variable can be
 * defined without exporting it into every shell. Nothing else is read from it — routing, tiers,
 * and council seats stay in the repo's `.foremanenv`, where they are reviewable.
 *
 * Precedence is process env FIRST, file second: an explicitly exported variable describes the
 * session the operator is actually in and must win over a stored default.
 */
export function homeCredentialsPath(): string {
  return path.join(os.homedir(), ".foreman-mcp", ".env")
}

/**
 * Reads the home credential store. An absent file is NOT an error — it is the common case, and
 * the key simply has to come from the process environment instead. A malformed file IS an error:
 * silently ignoring it would surface later as a confusing "variable is not set".
 */
export async function readHomeCredentials(
  filePath: string
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; message: string }> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT" || nodeErr.code === "ENOTDIR") return { ok: true, values: {} }
    if (nodeErr.code === "EACCES" || nodeErr.code === "EPERM") {
      return { ok: false, message: `${filePath} exists but is not readable (${nodeErr.code}).\n` }
    }
    throw err
  }

  const parsed = parseForemanEnv(raw)
  if (!parsed.ok) {
    // parseForemanEnv's message names `.foremanenv`; re-point it at the file actually at fault.
    return {
      ok: false,
      message: parsed.message.replace(".foremanenv", filePath) + "\n",
    }
  }

  const values: Record<string, string> = {}
  for (const [key, entry] of parsed.entries) {
    // dotenv convention: allow (and strip) one matching pair of surrounding quotes. Never echo
    // the value anywhere — this loop is the only place it is touched before redaction registers it.
    let value = entry.value
    if (value.length >= 2) {
      const first = value[0]
      if ((first === '"' || first === "'") && value[value.length - 1] === first) {
        value = value.slice(1, -1)
      }
    }
    values[key] = value
  }
  return { ok: true, values }
}

/** True when a value is still an unresolved `${ENV:NAME}` token rather than real key material. */
export function isUnresolvedIndirection(value: string): boolean {
  return /^\$\{ENV:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
}

/** Normalizes an endpoint for comparison: lowercased origin plus path, trailing slash removed. */
function normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/\/+$/, "")
    return `${u.protocol}//${u.host.toLowerCase()}${p}`
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase()
  }
}

/**
 * [CWE-522] Decides whether the home store may satisfy a `${ENV:NAME}` reference made by
 * `.foremanenv`.
 *
 * The danger is a NAME COLLISION, and the colliding name is the likeliest one anyone would pick.
 * If `.foremanenv` says `FOREMAN_API_KEY=${ENV:FOREMAN_API_KEY}` for a LAN serving box, while the
 * home store defines `FOREMAN_API_KEY=sk-or-...` for a hosted provider, a naive lookup hands the
 * hosted credential to the LAN address. The endpoint-coupling rule already covers WHICH FILE the
 * council takes its endpoint from; this covers the variable-name path, which is the same hole
 * reached from the other side.
 *
 * The rule: a home store that declares NO endpoint of its own is a pure credential store and may
 * answer any reference. A home store that declares a DIFFERENT endpoint is describing another
 * service, and its values must not be used to authenticate against the repo's endpoint.
 */
export function homeMayResolveRepoKeys(
  repoApiBase: string | undefined,
  homeApiBase: string | undefined
): boolean {
  if (homeApiBase === undefined || homeApiBase === "") return true
  if (repoApiBase === undefined || repoApiBase === "") return true
  return normalizeEndpoint(repoApiBase) === normalizeEndpoint(homeApiBase)
}

/**
 * Registers every home-store value that clears the redaction harvest guards. Exported so the
 * council loader — which may read the home store WITHOUT going through loadForemanEnv — applies
 * the identical protection rather than a second, divergent rule.
 */
export function registerHomeSecrets(values: Record<string, string>): void {
  for (const [name, value] of harvestSecrets(values)) {
    registerSecret(name, value)
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────────

export async function loadForemanEnv(opts?: {
  dir?: string
  journalPath?: string
  env?: Record<string, string | undefined>
  /** Override for the home credential store. Test seam. */
  credentialsPath?: string
  /**
   * Default true. Set false to load routing (api base, tiers, key NAME) WITHOUT requiring the
   * key to resolve — the council needs this file's endpoint and seats but authenticates against
   * its own endpoint with its own credential, and must not fail because a worker key is unset.
   */
  requireKey?: boolean
}): Promise<ForemanEnvResult> {
  const dir = opts?.dir ?? process.cwd()
  const filePath = path.join(dir, ".foremanenv")

  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === "ENOENT") {
      return { status: "config_error", message: buildMissingFileMessage(filePath) }
    }
    throw err
  }

  // Refusal outranks parse errors — run BEFORE parsing.
  const refusal = await checkGitRefusal(dir)
  if (refusal) {
    await bestEffortSecBlock(opts?.journalPath, refusal.reason)
    return { status: "refused", message: refusal.message }
  }

  const parsed = parseForemanEnv(raw)
  if (!parsed.ok) {
    return { status: "config_error", message: parsed.message }
  }

  // Credential resolution: process env wins, `~/.foreman-mcp/.env` fills the gaps.
  const credentialsPath = opts?.credentialsPath ?? homeCredentialsPath()
  const homeCreds = await readHomeCredentials(credentialsPath)
  if (!homeCreds.ok) {
    return { status: "config_error", message: homeCreds.message }
  }
  // [CWE-532] The redaction module harvests secrets from process.env ONLY (redaction.ts
  // harvestSecrets). A key that lives solely in the home store is therefore invisible to both
  // scrub() and the outbound secret gate — and a `.env` is exactly where several keys collect.
  // Register every value that clears the harvest guards (name pattern, single token, >=8 chars,
  // not a dictionary word), not just the one FOREMAN_API_KEY resolves to.
  registerHomeSecrets(homeCreds.values)

  // [CWE-522] The home store may satisfy a ${ENV:NAME} reference ONLY when it is not describing a
  // different endpoint. Without this guard, a repo `.foremanenv` naming ${ENV:FOREMAN_API_KEY} for
  // a LAN box would silently pick up a hosted provider's key of the same name from the home store
  // and POST it to the LAN address. Redaction registration above is deliberately unconditional —
  // those values still must never appear in a brief or a log, whether or not they are usable here.
  const repoApiBase = parsed.entries.get("FOREMAN_API_BASE")?.value
  const homeApiBase = homeCreds.values.FOREMAN_API_BASE
  const homeUsable = homeMayResolveRepoKeys(repoApiBase, homeApiBase)

  const processEnv = opts?.env ?? process.env
  const envSource: Record<string, string | undefined> = homeUsable
    ? { ...homeCreds.values, ...processEnv }
    : { ...processEnv }

  const validated = validateForemanEnv(parsed.entries, envSource, credentialsPath, opts?.requireKey !== false)
  if (validated.status === "config_error") {
    return validated
  }

  // On success only: register the resolved key material with the redaction module.
  // The resolved value itself is discarded here — only validated.config (which
  // carries apiKeyRef, the NAME, never the value) is returned to the caller.
  // Empty when requireKey was false: nothing was resolved, so there is nothing to register.
  if (validated.value !== "") registerSecret(validated.name, validated.value)
  return { status: "ok", config: validated.config }
}
