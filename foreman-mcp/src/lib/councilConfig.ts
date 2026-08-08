// Review-council configuration resolver.
//
// The council is ENTIRELY OPTIONAL. Foreman with no council configured behaves exactly as it did
// before the council existed: `invoke_council` reports `status: unavailable`, the deliberation
// ladder drops to the CLI advisor rung, and every other tool, skill, and ledger flow is untouched.
// That is why this module never returns a hard error for absence — only for a file that IS present
// and IS malformed. "Not configured" is a supported state, not a misconfiguration.
//
// TWO SOURCES:
//   1. `<repo>/.foremanenv`      — the project's default bench, reviewable alongside the code.
//   2. `~/.foreman-mcp/.env`     — the operator's own machine.
//
// PRECEDENCE, and the two rules point in OPPOSITE directions on purpose:
//   * SEATS: home store WINS. A seat describes the bench you prefer, and swapping one model must
//     not require editing (or dirtying) a shared repo file.
//   * API KEY: process env WINS over the home store. A key describes the session you are actually
//     in, so an explicitly exported value must beat a stored default.
//
// Either file may supply the endpoint and key, so a machine with no repo `.foremanenv` at all can
// still seat a council from the home store alone.

import fs from "fs/promises"
import path from "path"
import {
  loadForemanEnv,
  readHomeCredentials,
  homeCredentialsPath,
  registerHomeSecrets,
  homeMayResolveRepoKeys,
  isUnresolvedIndirection,
  seatKey,
  COUNCIL_SEATS,
  SEAT_SUFFIX,
  type CouncilSeatId,
} from "./foremanEnv.js"
import { registerSecret } from "./redaction.js"

export interface CouncilSeatConfig {
  seat: CouncilSeatId
  model: string
  /** Display/ledger name for this seat. Defaults to the model id. */
  label: string
  /** Passed VERBATIM as reasoning.effort. Mutually exclusive with reasoningMaxTokens. */
  reasoningEffort?: string
  /** Passed VERBATIM as reasoning.max_tokens. Bounds spend on an expensive seat. */
  reasoningMaxTokens?: number
  /** Which file seated this model. Surfaced in output so a surprising seat is always traceable. */
  source: "foremanenv" | "home-env"
}

export interface CouncilConfig {
  apiBase: string
  /** Env-var NAME the key resolved from, or "(home store)". NEVER the value. */
  apiKeyRef: string
  /** Resolved key value. Registered for redaction; never logged, returned, or traced. */
  apiKey: string
  seats: CouncilSeatConfig[]
}

export type CouncilConfigResult =
  | { status: "ok"; config: CouncilConfig }
  | { status: "unavailable"; reason: string }
  | { status: "config_error"; message: string }
  | { status: "refused"; message: string }

const SEAT_PREFIX = "FOREMAN_COUNCIL_SEAT_"
const LABEL_PREFIX = "FOREMAN_COUNCIL_LABEL_"
const REASONING_PREFIX = "FOREMAN_COUNCIL_REASONING_"
const REASONING_MAX_PREFIX = "FOREMAN_COUNCIL_REASONING_MAX_TOKENS_"

function parseConfigInt(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

interface Resolved {
  value: string
  source: "foremanenv" | "home-env"
}

/**
 * Parses council seats from a merged key lookup. Absence of every seat key is NOT an error —
 * it yields an empty list, which the caller reports as `unavailable`.
 */
export function resolveCouncilSeats(
  lookup: (key: string) => Resolved | undefined
): { ok: true; seats: CouncilSeatConfig[] } | { ok: false; message: string } {
  const seats: CouncilSeatConfig[] = []

  for (const seat of COUNCIL_SEATS) {
    const seatEntry = lookup(seatKey(SEAT_PREFIX, seat))
    const labelEntry = lookup(seatKey(LABEL_PREFIX, seat))
    const reasoningEntry = lookup(seatKey(REASONING_PREFIX, seat))
    const reasoningMaxEntry = lookup(seatKey(REASONING_MAX_PREFIX, seat))

    if (!seatEntry || seatEntry.value === "") {
      // Orphan: a per-seat key set without its FOREMAN_COUNCIL_SEAT_<S> anchor. This IS an error —
      // the operator clearly intended a seat, and silently dropping it would review with fewer
      // seats than they think they configured.
      if (labelEntry || reasoningEntry || reasoningMaxEntry) {
        const orphan = labelEntry ? LABEL_PREFIX : reasoningEntry ? REASONING_PREFIX : REASONING_MAX_PREFIX
        return {
          ok: false,
          message:
            `${seatKey(orphan, seat)} is set but council seat '${SEAT_SUFFIX[seat]}' has no model.\n\n` +
            `Add this line:\n  ${seatKey(SEAT_PREFIX, seat)}=<model-id>\n`,
        }
      }
      continue
    }

    // Reasoning effort and an explicit reasoning token budget are mutually exclusive at the
    // endpoint (OpenRouter: `effort` OR `max_tokens`, never both). Rejecting the pair here fails
    // fast with the offending keys instead of surfacing as an HTTP 400 mid-review.
    if (reasoningEntry && reasoningMaxEntry) {
      return {
        ok: false,
        message:
          `council seat '${SEAT_SUFFIX[seat]}' sets both ${seatKey(REASONING_PREFIX, seat)} and ` +
          `${seatKey(REASONING_MAX_PREFIX, seat)}.\n\n` +
          "These are mutually exclusive — reasoning takes an effort level OR a token budget.\n" +
          "Remove one of the two lines.\n",
      }
    }

    let reasoningMaxTokens: number | undefined
    if (reasoningMaxEntry) {
      const n = parseConfigInt(reasoningMaxEntry.value)
      if (n === null || n <= 0) {
        return {
          ok: false,
          message:
            `unsupported value for '${seatKey(REASONING_MAX_PREFIX, seat)}': '${reasoningMaxEntry.value}'.\n\n` +
            "Supported values: a positive integer (reasoning token budget)\n",
        }
      }
      reasoningMaxTokens = n
    }

    // reasoningEffort is NOT validated against an enum: it goes to the endpoint verbatim, exactly
    // as FOREMAN_REASONING_EFFORT_<TIER> does for workers. Endpoints disagree on the accepted set,
    // and a rejected value is recovered by the council's one-shot param downgrade.
    seats.push({
      seat,
      model: seatEntry.value,
      label: labelEntry && labelEntry.value !== "" ? labelEntry.value : seatEntry.value,
      ...(reasoningEntry ? { reasoningEffort: reasoningEntry.value } : {}),
      ...(reasoningMaxTokens !== undefined ? { reasoningMaxTokens } : {}),
      source: seatEntry.source,
    })
  }

  return { ok: true, seats }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the council across both stores.
 *
 * Returns `unavailable` — never an error — when the council simply is not set up: no
 * `.foremanenv` and no home store, or no seats, or no endpoint/key. The caller turns that into a
 * message naming the next rung of the deliberation ladder.
 */
export async function loadCouncilConfig(opts?: {
  dir?: string
  journalPath?: string
  env?: Record<string, string | undefined>
  credentialsPath?: string
}): Promise<CouncilConfigResult> {
  const dir = opts?.dir ?? process.cwd()
  const credentialsPath = opts?.credentialsPath ?? homeCredentialsPath()
  const processEnv = opts?.env ?? process.env

  // ── Home store ──
  const home = await readHomeCredentials(credentialsPath)
  if (!home.ok) return { status: "config_error", message: home.message }
  const homeValues = home.values
  registerHomeSecrets(homeValues)

  // ── Repo store (optional — absence is a supported state) ──
  let repoApiBase: string | undefined
  let repoApiKeyRef: string | undefined
  let repoEntries: Record<string, string> = {}

  const foremanEnvPath = path.join(dir, ".foremanenv")
  if (await fileExists(foremanEnvPath)) {
    const loaded = await loadForemanEnv({
      dir,
      ...(opts?.journalPath !== undefined ? { journalPath: opts.journalPath } : {}),
      env: processEnv,
      credentialsPath,
      // Routing only. The council resolves its OWN key against its OWN endpoint below, so an
      // unset worker credential must not block a council the home store fully describes.
      requireKey: false,
    })
    // A malformed or git-tracked `.foremanenv` is a REAL error and must not be masked into
    // "unavailable" — the operator has a broken file, not an absent council.
    if (loaded.status === "config_error") return { status: "config_error", message: loaded.message }
    if (loaded.status === "refused") return { status: "refused", message: loaded.message }
    repoApiBase = loaded.config.apiBase
    repoApiKeyRef = loaded.config.apiKeyRef
    repoEntries = await readForemanEnvCouncilKeys(foremanEnvPath)
  }

  // ── Seats: home WINS. ──
  const seatResult = resolveCouncilSeats((key) => {
    const fromHome = homeValues[key]
    if (fromHome !== undefined) return { value: fromHome, source: "home-env" }
    const fromRepo = repoEntries[key]
    if (fromRepo !== undefined) return { value: fromRepo, source: "foremanenv" }
    return undefined
  })
  if (!seatResult.ok) return { status: "config_error", message: seatResult.message }
  if (seatResult.seats.length === 0) {
    return {
      status: "unavailable",
      reason:
        repoApiBase === undefined && Object.keys(homeValues).length === 0
          ? "no .foremanenv and no ~/.foreman-mcp/.env"
          : "no FOREMAN_COUNCIL_SEAT_<A|B|C> configured",
    }
  }

  // ── Endpoint: home may override, or supply it outright when there is no repo file. ──
  const apiBase = homeValues.FOREMAN_API_BASE ?? repoApiBase
  const endpointSource: "home-env" | "foremanenv" =
    homeValues.FOREMAN_API_BASE !== undefined ? "home-env" : "foremanenv"
  if (apiBase === undefined) {
    return { status: "unavailable", reason: "council seats are configured but FOREMAN_API_BASE is not" }
  }
  try {
    const parsed = new URL(apiBase)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        status: "config_error",
        message: `unsupported value for 'FOREMAN_API_BASE': '${apiBase}'.\n\nSupported values: an http:// or https:// URL\n`,
      }
    }
  } catch {
    return {
      status: "config_error",
      message: `unsupported value for 'FOREMAN_API_BASE': '${apiBase}'.\n\nSupported values: an http:// or https:// URL\n`,
    }
  }

  // ── Key: resolved from the SAME source that supplied the endpoint. ──
  const homeUsableForRepoKeys = homeMayResolveRepoKeys(repoApiBase, homeValues.FOREMAN_API_BASE)
  const keyResolution = resolveApiKey(
    endpointSource,
    repoApiKeyRef,
    homeValues,
    processEnv,
    homeUsableForRepoKeys
  )
  if (keyResolution === undefined) {
    return {
      status: "unavailable",
      reason:
        endpointSource === "home-env"
          ? `council seats are configured but no key resolved — export FOREMAN_API_KEY or set it in ${credentialsPath}`
          : "council seats are configured but no API key resolved — " +
            `export ${repoApiKeyRef ?? "your key variable"} or set FOREMAN_API_BASE + FOREMAN_API_KEY in ${credentialsPath}`,
    }
  }
  // Belt and braces: the harvest guards in registerHomeSecrets are name-pattern based, so a key
  // stored under an unusual name could slip past them. The value we are about to send is always
  // registered explicitly, exactly as loadForemanEnv does for the worker path.
  registerSecret(keyResolution.ref, keyResolution.value)

  return {
    status: "ok",
    config: { apiBase, apiKeyRef: keyResolution.ref, apiKey: keyResolution.value, seats: seatResult.seats },
  }
}

/**
 * Resolves the API key FROM THE SAME SOURCE THAT SUPPLIED THE ENDPOINT.
 *
 * [CWE-522] This coupling is a security control, not a convenience. The two stores routinely
 * describe DIFFERENT endpoints — a repo `.foremanenv` pointing at a local vLLM box while the home
 * store seats the council on a hosted provider is the expected setup, not an edge case. Resolving
 * the key independently of the endpoint would then misdeliver a credential in whichever direction
 * the precedence rules happened to fall: a hosted API key POSTed to a LAN address, or a local
 * placeholder sent to a public provider as a bearer token. Neither is recoverable once sent.
 *
 * So:
 *   - endpoint from the HOME store  -> key from the home store only.
 *   - endpoint from `.foremanenv`   -> key from that file's ${ENV:NAME} ref (process env first,
 *                                      then the home store as a fallback for the same NAME).
 *
 * Inline values are accepted in the HOME store only. `.foremanenv` forbids them because it sits
 * next to a git repo and a careless commit would publish the key; `~/.foreman-mcp/.env` is the
 * designated secret store outside every repo, so holding the value is its whole purpose.
 */
function resolveApiKey(
  endpointSource: "home-env" | "foremanenv",
  apiKeyRef: string | undefined,
  homeValues: Record<string, string>,
  processEnv: Record<string, string | undefined>,
  homeUsableForRepoKeys: boolean
): { ref: string; value: string } | undefined {
  /** Never return a value that is itself an unresolved indirection token — see C5 below. */
  const usable = (value: string | undefined): value is string =>
    value !== undefined && value !== "" && !isUnresolvedIndirection(value)

  if (endpointSource === "home-env") {
    // The process environment WINS, exactly as it does on the repo branch. Previously this branch
    // read the stored value only, so an exported key was silently ignored in favour of a stale
    // one — and a home store holding endpoint + seats but no key reported the council
    // "unavailable" even when a perfectly good key was exported.
    if (usable(processEnv.FOREMAN_API_KEY)) {
      return { ref: "FOREMAN_API_KEY", value: processEnv.FOREMAN_API_KEY }
    }
    const inline = homeValues.FOREMAN_API_KEY
    if (inline === undefined || inline === "") return undefined
    // Tolerate the ${ENV:NAME} indirection here too, so one file shape works in both places.
    const match = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(inline)
    if (match) {
      const name = match[1]
      const value = processEnv[name] ?? homeValues[name]
      // A self-referential entry (FOREMAN_API_KEY=${ENV:FOREMAN_API_KEY} with nothing exported)
      // resolves back to the literal token. Returning it would send "${ENV:...}" as a bearer
      // credential and surface as an opaque 401 rather than an honest "no key".
      if (usable(value)) return { ref: name, value }
      return undefined
    }
    return { ref: "FOREMAN_API_KEY", value: inline }
  }

  if (apiKeyRef === undefined) return undefined
  const fromProcess = processEnv[apiKeyRef]
  if (usable(fromProcess)) return { ref: apiKeyRef, value: fromProcess }
  // [CWE-522] The home store answers a repo `${ENV:NAME}` reference ONLY when it is not
  // describing a different endpoint. See homeMayResolveRepoKeys — without this, a repo file
  // naming ${ENV:FOREMAN_API_KEY} for a LAN box collects a hosted provider's key of the same
  // name from the home store and authenticates the LAN address with it.
  if (!homeUsableForRepoKeys) return undefined
  const fromHome = homeValues[apiKeyRef]
  if (usable(fromHome)) return { ref: apiKeyRef, value: fromHome }
  return undefined
}

/**
 * Re-reads `.foremanenv` for council keys only. loadForemanEnv validates the file (including
 * refusing a git-tracked one) but deliberately does not return council keys, so this second pass
 * runs ONLY after that validation has already passed.
 */
async function readForemanEnvCouncilKeys(filePath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf-8")
  } catch {
    return out
  }
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  for (const line of body.split(/\r\n|\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key.startsWith("FOREMAN_COUNCIL_")) continue
    let value = trimmed.slice(eq + 1)
    // Same trailing-comment rule as the main parser: `#` preceded by whitespace starts a comment.
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "#" && /\s/.test(value[i - 1])) {
        value = value.slice(0, i)
        break
      }
    }
    out[key] = value.trim()
  }
  return out
}
