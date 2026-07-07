/**
 * Single source of truth for the six-capability host contract surface (D4).
 * Consumed by the host_status + session_orient echoes and HOST-CONTRACT.md.
 */

import type { HostId } from "./hostProfiles.js"

/** The six host capabilities of the v0.5.0 host contract (HOST-CONTRACT.md). Closed set — add here ONLY alongside an implemented, smoked behavior. */
export const CAPABILITIES = [
  "spawn-worker",
  "invoke-advisor",
  "run-tests",
  "report-tokens",
  "honor-isolation",
  "autonomy",
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const SUPPORT: Record<HostId, Record<Capability, boolean>> = {
  "claude-code": { "spawn-worker": true, "invoke-advisor": true, "run-tests": true, "report-tokens": true, "honor-isolation": true, autonomy: true },
  cursor: { "spawn-worker": true, "invoke-advisor": true, "run-tests": true, "report-tokens": true, "honor-isolation": true, autonomy: false },
  // codex is an alias preset of claude-code minus autonomy (autonomy text is DRAFT in its host profile)
  codex: { "spawn-worker": true, "invoke-advisor": true, "run-tests": true, "report-tokens": true, "honor-isolation": true, autonomy: false },
  // generic: the bundled generic profile declares the full six-capability contract
  // (HOST-CONTRACT.md); a generic host is by definition a contract implementer.
  // Consumers narrow support via their own host profile/override — the echo
  // reflects the declaration, not a probe. (Recorded decision, PROGRESS 2026-07-06.)
  generic: { "spawn-worker": true, "invoke-advisor": true, "run-tests": true, "report-tokens": true, "honor-isolation": true, autonomy: true },
}

/** Every capability maps to its documented protocol degradation when unsupported. */
export const DEGRADATIONS: Record<Capability, string> = {
  "spawn-worker": "no worker seat — the pitboss implements directly in-session; disposable-worker isolation is lost and unit scope shrinks accordingly",
  "invoke-advisor": "no independent advisors — checkpoint review degrades to adversarial self-review (advisor_fallback) and is recorded as non-independent",
  "run-tests": "no bounded test runner — tests run via the shell with results pasted as evidence; run_tests exit-code/output telemetry unavailable",
  "report-tokens": "token telemetry recorded as 0/unknown; token-budget features and autonomy are refused",
  "honor-isolation": "no worktree/seat isolation — workers share one working tree; concurrent units must be serialized",
  autonomy: "no autonomous continuation — every phase gate requires an interactive user turn",
}

/** Comma-list of capabilities the host does NOT support, or "none". Fixed capability names only — no free text. */
export function unsupportedCapabilities(host: HostId): string {
  const unsupported = CAPABILITIES.filter((c) => !SUPPORT[host][c])
  return unsupported.length === 0 ? "none" : unsupported.join(",")
}
