import fs from "fs/promises"
import path from "path"
import { runExternalCli } from "./externalCli.js"
import { logEvent } from "./journal.js"
import { registerSecret } from "./redaction.js"

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
 * configured, nothing inferred or defaulted beyond the single documented default
 * (`editFormat` -> "unified_diff"). Per-call tier *resolution* (e.g. what happens
 * when a caller asks for a tier that isn't configured) is unit 4f's job.
 */

export type Tier = "cheap" | "standard" | "premium"
export type WorkerClass = "frontier" | "capable" | "compact"
export type EditFormat = "unified_diff" | "search_replace" | "whole_file"

export interface TierConfig {
  model: string
  workerClass: WorkerClass
  editFormat: EditFormat
  reasoningEffort?: string
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

const SIMPLE_KEYS = new Set(["schema_version", "FOREMAN_API_BASE", "FOREMAN_API_KEY"])

const TIER_KEY_PREFIXES: readonly string[] = [
  "FOREMAN_TIER_",
  "FOREMAN_WORKER_CLASS_",
  "FOREMAN_EDIT_FORMAT_",
  "FOREMAN_REASONING_EFFORT_",
]

const RECOGNIZED_KEYS_TEXT =
  "schema_version, FOREMAN_API_BASE, FOREMAN_API_KEY, " +
  "FOREMAN_TIER_<CHEAP|STANDARD|PREMIUM>, FOREMAN_WORKER_CLASS_<CHEAP|STANDARD|PREMIUM>, " +
  "FOREMAN_EDIT_FORMAT_<CHEAP|STANDARD|PREMIUM>, FOREMAN_REASONING_EFFORT_<CHEAP|STANDARD|PREMIUM>"

function tierForSuffix(suffix: string): Tier | undefined {
  return TIERS.find((t) => TIER_SUFFIX[t] === suffix)
}

function isRecognizedKey(key: string): boolean {
  if (SIMPLE_KEYS.has(key)) return true
  for (const prefix of TIER_KEY_PREFIXES) {
    if (key.startsWith(prefix) && tierForSuffix(key.slice(prefix.length)) !== undefined) {
      return true
    }
  }
  return false
}

function tierKey(prefix: string, tier: Tier): string {
  return `${prefix}${TIER_SUFFIX[tier]}`
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
  envSource: Record<string, string | undefined>
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
  if (resolvedValue === undefined || resolvedValue === "") {
    return {
      status: "config_error",
      message: `environment variable '${envName}' is not set — export it before starting the server`,
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

    if (!tierEntry) {
      // Orphan: a per-tier key present without its FOREMAN_TIER_<T> anchor.
      const orphan = workerClassEntry ?? editFormatEntry ?? reasoningEffortEntry
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

    let editFormat: EditFormat = "unified_diff"
    if (editFormatEntry) {
      if (!(EDIT_FORMATS as readonly string[]).includes(editFormatEntry.value)) {
        return {
          status: "config_error",
          message: unsupportedValueMessage(editFormatEntry.key, editFormatEntry.value, EDIT_FORMATS.join(", ")),
        }
      }
      editFormat = editFormatEntry.value as EditFormat
    }

    tiers[tier] = {
      model: tierEntry.value,
      workerClass: workerClassEntry.value as WorkerClass,
      editFormat,
      ...(reasoningEffortEntry ? { reasoningEffort: reasoningEffortEntry.value } : {}),
    }
  }

  return {
    status: "ok",
    name: envName,
    value: resolvedValue,
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

// ─── Public entry point ──────────────────────────────────────────────────────────

export async function loadForemanEnv(opts?: {
  dir?: string
  journalPath?: string
  env?: Record<string, string | undefined>
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

  const validated = validateForemanEnv(parsed.entries, opts?.env ?? process.env)
  if (validated.status === "config_error") {
    return validated
  }

  // On success only: register the resolved key material with the redaction module.
  // The resolved value itself is discarded here — only validated.config (which
  // carries apiKeyRef, the NAME, never the value) is returned to the caller.
  registerSecret(validated.name, validated.value)
  return { status: "ok", config: validated.config }
}
