import { type HostId, getProfile } from "../lib/hostProfiles.js"
import { unsupportedCapabilities } from "../lib/capabilitySet.js"
import { toKeyValue } from "../lib/toon.js"
import { CODEX_SEAT_MODELS } from "../tools/codexAgentsInit.js"
import { modelRankSummary, resolveModelRank, type ModelRank } from "../lib/modelRank.js"

/**
 * Read-only introspection of the active Foreman host configuration.
 *
 * The placeholder texts encode a model slug for each role; we extract those
 * so callers (LLM, tests, diagnostics) can see which model will run as worker
 * vs. each advisor without parsing skill text.
 */
export function hostStatus(host: HostId, modelRank: ModelRank = resolveModelRank()): string {
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

  // Codex pins its implementation seats in .codex/agents/<role>.toml rather than in the
  // placeholder text, so the single worker_model slug does not describe it. Report the
  // seat table instead of scraping prose that no longer carries a model.
  const workerModel =
    host === "codex"
      ? Object.entries(CODEX_SEAT_MODELS).map(([role, model]) => `${role}=${model}`).join(" ")
      : modelOf("worker_invoke")

  return toKeyValue({
    ...modelRankSummary(modelRank),
    host: profile.id,
    display_name: profile.displayName,
    ...(host === "codex" ? {
      review_mode: "native-subagents",
      review_stage: "native",
      external_advisors: "optional: claude,gemini,council",
      agent_visibility: "host-owned; native IDs are reported by the host, not discovered by Foreman",
    } : {}),
    worker_model: workerModel,
    advisor_a_model: modelOf("advisor_a"),
    advisor_b_model: modelOf("advisor_b"),
    advisor_b_fallback: advisorBFallback,
    unsupported_capabilities: unsupportedCapabilities(host),
  })
}
