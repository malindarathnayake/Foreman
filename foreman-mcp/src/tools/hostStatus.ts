import { type HostId, getProfile } from "../lib/hostProfiles.js"
import { toKeyValue } from "../lib/toon.js"

/**
 * Read-only introspection of the active Foreman host configuration.
 *
 * The placeholder texts encode a model slug for each role; we extract those
 * so callers (LLM, tests, diagnostics) can see which model will run as worker
 * vs. each advisor without parsing skill text.
 */
export function hostStatus(host: HostId): string {
  const profile = getProfile(host)
  const ph = profile.placeholders

  const modelOf = (key: string): string => {
    const text = ph[key] ?? ""
    const match = text.match(/model:\s*"([^"]+)"/)
    return match ? match[1] : "n/a"
  }

  // Cursor's advisor_b carries an explicit fallback note. Best-effort extraction.
  const advisorBText = ph.advisor_b ?? ""
  const fallbackMatch = advisorBText.match(/fall back to[^"]*"([^"]+)"/i)
  const advisorBFallback = fallbackMatch ? fallbackMatch[1] : "n/a"

  return toKeyValue({
    host: profile.id,
    display_name: profile.displayName,
    worker_model: modelOf("worker_invoke"),
    advisor_a_model: modelOf("advisor_a"),
    advisor_b_model: modelOf("advisor_b"),
    advisor_b_fallback: advisorBFallback,
  })
}
