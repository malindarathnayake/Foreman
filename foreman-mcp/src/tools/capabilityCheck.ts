import { runExternalCli } from "../lib/externalCli.js"
import { toKeyValue } from "../lib/toon.js"

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

  // First check version
  let version: string | null = null
  try {
    const vResult = await runExternalCli(config.command, ["--version"], 5000)
    if (vResult.exitCode === 0) {
      version = vResult.stdout.trim().split("\n")[0] ?? null
    }
  } catch {
    // Version check failed — CLI probably not available
  }

  // If version check failed completely, CLI is not available
  // But runExternalCli doesn't throw for ENOENT — it returns exitCode: -1
  // So check the health command for availability
  const result = await runExternalCli(config.command, config.args, 15000)

  if (result.exitCode === -1 && !result.timedOut) {
    // ENOENT or similar — CLI not available
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
