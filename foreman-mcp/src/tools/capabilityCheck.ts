import { runExternalCli, resolveInvocation, type SpawnPlan } from "../lib/externalCli.js"
import { toKeyValue } from "../lib/toon.js"

// Module-level cache for resolved SpawnPlans
const resolvedPlans = new Map<string, SpawnPlan>()

const HEALTH_COMMANDS: Record<string, { command: string; args: string[] }> = {
  codex: {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "-s", "read-only", "-m", "gpt-5.4", "echo health check"],
  },
  gemini: {
    command: "gemini",
    args: ["-p", "echo health check", "-m", "arch-review", "--approval-mode", "plan", "--output-format", "text"],
  },
}

export async function capabilityCheck(cli: "codex" | "gemini"): Promise<string> {
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
