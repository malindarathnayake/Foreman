import { runExternalCli, resolveInvocation, type SpawnPlan } from "../lib/externalCli.js"
import { toKeyValue } from "../lib/toon.js"
import { type HostId, getProfile } from "../lib/hostProfiles.js"
import type { AdvisorCli } from "../lib/advisorCli.js"
import { GEMINI_ADVISOR_MODEL } from "./invokeAdvisor.js"

// Module-level cache for resolved SpawnPlans
const resolvedPlans = new Map<string, SpawnPlan>()

const HEALTH_COMMANDS: Record<AdvisorCli, { command: string; args: string[] }> = {
  claude: {
    command: "claude",
    args: ["auth", "status"],
  },
  codex: {
    // `codex login status` is a fast, no-API-call auth probe: exit 0 = authenticated,
    // non-zero = expired/logged out. A full `codex exec` health call is slow, model-
    // dependent (a stale `-m` id alone makes it fail), and times out under the 15s
    // budget — all of which surface as a false `auth_status: expired`.
    command: "codex",
    args: ["login", "status"],
  },
  gemini: {
    command: "gemini",
    // Same model as the review seat, so a passing probe means the review's model resolves.
    args: ["-p", "echo health check", "-m", GEMINI_ADVISOR_MODEL, "--approval-mode", "plan", "--output-format", "text"],
  },
}

export type AuthStatus = "ok" | "not_found" | "not_trusted" | "auth_expired" | "probe_timeout" | "error"

interface SentinelRow {
  cli: AdvisorCli
  /** CLI version the sentinel was observed against. Re-verify rows on every CLI version bump. */
  cli_version_pin: string
  kind: "exit_code" | "stderr_substring"
  /** exit code number, "any_nonzero" wildcard, or stderr substring */
  value: number | "any_nonzero" | string
  maps_to: AuthStatus
  provenance: string
}

/**
 * Versioned per-CLI sentinel table (D11) — the recorded exemption to the
 * no-prose-classification rule: entries are bounded, version-pinned sentinels,
 * NOT unbounded regex corpora. Specific rows are checked before wildcards.
 * Rule: re-verify this table on every CLI version bump.
 */
export const SENTINEL_TABLE: readonly SentinelRow[] = [
  {
    cli: "gemini", cli_version_pin: "0.47.0", kind: "exit_code", value: 55, maps_to: "not_trusted",
    provenance: "Session-observed 2026-07-06 against gemini 0.47.0: exit 55 = folder-trust refusal. Version pin re-verified live at implementation (gemini --version -> 0.47.0).",
  },
  {
    cli: "gemini", cli_version_pin: "0.47.0", kind: "exit_code", value: 52, maps_to: "error",
    provenance: "Session-observed 2026-07-06 against gemini 0.47.0: exit 52 = config error (not an auth state). Version pin re-verified live at implementation.",
  },
  {
    cli: "codex", cli_version_pin: "0.142.4", kind: "exit_code", value: "any_nonzero", maps_to: "auth_expired",
    provenance: "Documented probe semantics of `codex login status`: exit 0 = authenticated, non-zero = expired/logged out. Re-verified live 2026-07-06 against codex-cli 0.142.4 (exit 0 while authenticated).",
  },
]

function hintFor(status: AuthStatus, cli: AdvisorCli): string | null {
  switch (status) {
    case "ok": return null
    case "not_found": return "install the CLI or fix PATH, then re-run capability_check"
    case "probe_timeout": return "probe exceeded its 15s budget — retry; if persistent, check login state and network"
    case "not_trusted": return "trust the folder: run the gemini CLI interactively in this directory once and accept the trust prompt"
    case "auth_expired": {
      if (cli === "claude") return "re-login: run `claude auth login`"
      if (cli === "codex") return "re-login: run `codex login`"
      return "re-authenticate: run the gemini CLI interactively (or fix GEMINI_API_KEY)"
    }
    case "error": return "unclassified CLI error — run the health command manually and inspect stderr"
  }
}

function classifyNonZeroExit(cli: AdvisorCli, exitCode: number, stderr: string): AuthStatus {
  // `claude auth status` is itself the stable auth contract. Its version is
  // reported as telemetry, but review availability must not be pinned to the
  // locally observed CLI version.
  if (cli === "claude") return "auth_expired"

  const rows = SENTINEL_TABLE.filter((r) => r.cli === cli)
  // specific exit codes first
  for (const r of rows) if (r.kind === "exit_code" && r.value === exitCode) return r.maps_to
  for (const r of rows) if (r.kind === "stderr_substring" && typeof r.value === "string" && stderr.includes(r.value)) return r.maps_to
  for (const r of rows) if (r.kind === "exit_code" && r.value === "any_nonzero") return r.maps_to
  return "error"
}

function respond(cli: AdvisorCli, available: boolean, version: string, status: AuthStatus): string {
  const hint = hintFor(status, cli)
  return toKeyValue({
    cli,
    available: String(available),
    version,
    auth_status: status,
    ...(hint ? { hint } : {}),
  })
}

/**
 * Synthetic capability response for non-CLI hosts. In Cursor mode the LLM has
 * Task subagent access by definition — there is no binary to probe. Returning
 * `available: true` with `mechanism: cursor_subagent` lets the deliberation
 * tier mapping treat both advisors as available without shelling out.
 *
 * Cursor keeps its historical semantic mapping for codex/gemini:
 * codex -> Advisor A (GPT-5.6-SOL), gemini -> Advisor B
 * (Gemini-3.1-pro / Composer fallback). An explicit claude check still probes
 * the local Claude CLI instead of pretending Cursor supplied that seat.
 */
function syntheticCursorResponse(cli: "codex" | "gemini"): string {
  const profile = getProfile("cursor")
  const advisorPlaceholder = cli === "codex" ? "advisor_a" : "advisor_b"
  const advisorText = profile.placeholders[advisorPlaceholder] ?? ""
  // Extract a model hint from the placeholder text for visibility (best-effort).
  const modelMatch = advisorText.match(/model:\s*"([^"]+)"/)
  const model = modelMatch ? modelMatch[1] : "unknown"
  return toKeyValue({
    cli,
    available: "true",
    version: "cursor_subagent",
    auth_status: "ok",
    mechanism: "cursor_subagent",
    model,
  })
}

export async function capabilityCheck(
  cli: AdvisorCli,
  host: HostId = "claude-code"
): Promise<string> {
  if (host === "cursor" && cli !== "claude") {
    return syntheticCursorResponse(cli)
  }

  const config = HEALTH_COMMANDS[cli]
  if (!config) {
    return respond(cli, false, "null", "not_found")
  }

  // Resolve CLI to a SpawnPlan (platform-aware: which/where, .cmd wrapping)
  let plan: SpawnPlan
  if (resolvedPlans.has(cli)) {
    plan = resolvedPlans.get(cli)!
  } else {
    const resolution = await resolveInvocation(config.command)
    if (!resolution.ok) {
      return respond(cli, false, "null", "not_found")
    }
    plan = resolution.plan
    resolvedPlans.set(cli, plan)
  }

  // First check version
  let version: string | null = null
  try {
    const vResult = await runExternalCli(plan.command, [...plan.args, "--version"], 5000)
    if (vResult.exitCode === 0) {
      version = vResult.stdout.trim().split(/\r?\n/)[0] ?? null
    }
  } catch {
    // Version check failed — CLI probably not available
  }

  // Health check
  const result = await runExternalCli(plan.command, [...plan.args, ...config.args], 15000)

  if (result.exitCode === -1 && !result.timedOut) {
    return respond(cli, false, "null", "not_found")
  }

  if (result.timedOut) {
    return respond(cli, true, version ?? "unknown", "probe_timeout")
  }

  if (result.exitCode !== 0) {
    return respond(cli, true, version ?? "unknown", classifyNonZeroExit(cli, result.exitCode, result.stderr ?? ""))
  }

  return respond(cli, true, version ?? "unknown", "ok")
}
