// Secrets-redaction module (D1). Harvests secret values from the environment, scrubs
// them from text with loud one-way markers, detects secret values in outbound text, and
// detects redaction markers in inbound text. No entropy heuristics anywhere — every guard
// below is exactly the mechanical check the spec calls for. No logging in this module:
// secret VALUES must never appear in any log, error message, thrown Error, or return value
// other than scrub's replaced text.

const NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|BEARER|PRIVATE)/i

// R11 false-positive guard (docs/spec.md Decisions R11): harvest requires name-pattern
// match AND single-token value AND length >= 8 AND value not in this 12-entry literal
// denylist — bounded and mechanical (e.g. AUTH_MODE=disabled must not scrub the word
// "disabled" from artifacts). Compared case-insensitively (all entries are dictionary
// words; a real secret never equals one).
const DENYLIST = new Set([
  "true",
  "false",
  "disabled",
  "enabled",
  "standard",
  "default",
  "production",
  "development",
  "localhost",
  "undefined",
  "null",
  "none",
])

function isSingleToken(value: string): boolean {
  return !/\s/.test(value)
}

function qualifies(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false
  if (!isSingleToken(value)) return false
  if (value.length < 8) return false
  if (DENYLIST.has(value.toLowerCase())) return false
  return true
}

function harvestFrom(env: Record<string, string | undefined>): Map<string, string> {
  const names = Object.keys(env)
    .filter((name) => NAME_PATTERN.test(name) && qualifies(env[name]))
    .sort()
  const result = new Map<string, string>()
  for (const name of names) {
    result.set(name, env[name] as string)
  }
  return result
}

let processEnvCache: Map<string, string> | undefined

/**
 * Returns a Map of env-var NAME -> VALUE for every entry passing the four harvest guards.
 * With no argument, reads process.env and caches the result for the life of the process
 * (Performance Budgets: "redaction harvest computed once per process"). With an explicit
 * env argument, computes fresh and never reads or writes the cache.
 */
export function harvestSecrets(env?: Record<string, string | undefined>): Map<string, string> {
  if (env === undefined) {
    if (processEnvCache === undefined) {
      processEnvCache = harvestFrom(process.env)
    }
    return processEnvCache
  }
  return harvestFrom(env)
}

const registered = new Map<string, string>()

// Seam consumed by 4c (${ENV:NAME} resolution — docs/spec.md 4c directive 4): resolved
// key material is registered here explicitly so scrub and the outbound gate cover it
// even when the env-var name misses the harvest pattern. No caller passes it yet.
export function registerSecret(name: string, value: string): void {
  registered.set(name, value)
}

/** Merges the process-env harvest with explicitly registered secrets into one active set. */
function activeSecrets(): Map<string, string> {
  const merged = new Map<string, string>(harvestSecrets())
  for (const [name, value] of registered) {
    merged.set(name, value)
  }
  return merged
}

/** Active entries ordered longest-value-first, ties broken by name ascending. */
function orderedEntries(): Array<[string, string]> {
  return Array.from(activeSecrets().entries()).sort((a, b) => {
    const lenDiff = b[1].length - a[1].length
    if (lenDiff !== 0) return lenDiff
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
}

/**
 * Replaces every occurrence of every active secret VALUE with the literal marker
 * `[REDACTED:env:NAME]`. One-way, loud, grep-able — never a reversible placeholder, never
 * a plausible fake value (a reversible substitution on a patch pipe silently corrupts
 * code — spec 4a directive 2). Longer values are replaced first so a value that is a
 * substring of another cannot mangle the longer one's replacement. Literal string
 * replacement only (never RegExp) since secret values can contain regex metacharacters.
 */
export function scrub(text: string): string {
  const entries = orderedEntries()
  if (entries.length === 0) return text
  let result = text
  for (const [name, value] of entries) {
    if (value.length === 0) continue
    result = result.split(value).join(`[REDACTED:env:${name}]`)
  }
  return result
}

/** Returns the env NAMES (never values) of every active secret whose VALUE occurs in text. */
export function findSecrets(text: string): string[] {
  const found: string[] = []
  for (const [name, value] of activeSecrets()) {
    if (value.length > 0 && text.includes(value)) {
      found.push(name)
    }
  }
  return Array.from(new Set(found)).sort()
}

// Redaction placeholders DO appear inside model-generated patches in practice — this is
// the inbound scan primitive (consumed by 4e).
export const INBOUND_MARKER_PATTERNS: readonly RegExp[] = [/#[A-Z0-9]{4}#/, /\[REDACTED/, /\*\*\*/]

export function containsRedactionMarker(text: string): boolean {
  return INBOUND_MARKER_PATTERNS.some((pattern) => pattern.test(text))
}

/** Clears the process-env harvest cache and all registered secrets. Test-only reset seam. */
export function resetForTest(): void {
  processEnvCache = undefined
  registered.clear()
}
