import { runExternalCli, resolveInvocation, type SpawnPlan } from "../lib/externalCli.js"
import { toKeyValue } from "../lib/toon.js"
import { type HostId, getProfile } from "../lib/hostProfiles.js"

// Module-level cache for resolved SpawnPlans
const resolvedPlans = new Map<string, SpawnPlan>()

const HEALTH_COMMANDS: Record<string, { command: string; args: string[] }> = {
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
    args: ["-p", "echo health check", "-m", "arch-review", "--approval-mode", "plan", "--output-format", "text"],
  },
}

/**
 * Synthetic capability response for non-CLI hosts. In Cursor mode the LLM has
 * Task subagent access by definition — there is no binary to probe. Returning
 * `available: true` with `mechanism: cursor_subagent` lets the deliberation
 * tier mapping treat both advisors as available without shelling out.
 *
 * The `cli` enum stays as `"codex" | "gemini"` for backward compatibility.
 * Semantic mapping in cursor mode: codex -> Advisor A (GPT-5.5),
 * gemini -> Advisor B (Gemini-3.1-pro / Composer fallback).
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
  cli: "codex" | "gemini",
  host: HostId = "claude-code"
): Promise<string> {
  if (host === "cursor") {
    return syntheticCursorResponse(cli)
  }

  const config = HEALTH_COMMANDS[cli]
  if (!config) {
    return toKeyValue({ cli, available: "false", version: "null", auth_status: "unknown" })
  }

  // Resolve CLI to a SpawnPlan (platform-aware: which/where, .cmd wrapping)
  let plan: SpawnPlan
  if (resolvedPlans.has(cli)) {
    plan = resolvedPlans.get(cli)!
  } else {
    const resolution = await resolveInvocation(config.command)
    if (!resolution.ok) {
      return toKeyValue({ cli, available: "false", version: "null", auth_status: "unknown" })
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
    return toKeyValue({ cli, available: "false", version: "null", auth_status: "unknown" })
  }

  if (result.timedOut) {
    return toKeyValue({ cli, available: "true", version: version ?? "unknown", auth_status: "expired" })
  }

  if (result.exitCode !== 0) {
    return toKeyValue({ cli, available: "true", version: version ?? "unknown", auth_status: "expired" })
  }

  return toKeyValue({ cli, available: "true", version: version ?? "unknown", auth_status: "ok" })
}
