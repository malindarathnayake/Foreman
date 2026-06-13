import {
  type ExternalCliResult,
  resolveInvocation,
  runWithStdin,
} from "../lib/externalCli.js"

const ADVISOR_CONFIGS: Record<string, { buildArgs: () => string[] }> = {
  codex: {
    buildArgs: () => [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      "-m", "gpt-5.5",
      "-c", "model_reasoning_effort=high",
      "-c", "hide_agent_reasoning=true", "-"
    ],
  },
  gemini: {
    buildArgs: () => [
      "-p", "", "-m", "arch-review",
      "--approval-mode", "plan", "--output-format", "text"
    ],
  },
}

export async function invokeAdvisor(
  cli: "codex" | "gemini",
  prompt: string,
  timeoutMs: number,
): Promise<ExternalCliResult> {
  const config = ADVISOR_CONFIGS[cli]
  if (!config) {
    return { stdout: '', stderr: `unknown cli: ${cli}`, timedOut: false, exitCode: -1, truncated: false }
  }

  const resolution = await resolveInvocation(cli)
  if (!resolution.ok) {
    return { stdout: '', stderr: resolution.reason, timedOut: false, exitCode: -1, truncated: false }
  }

  const plan = resolution.plan
  const fullArgs = [...plan.args, ...config.buildArgs()]

  return runWithStdin(plan.command, fullArgs, prompt, timeoutMs)
}

export function formatAdvisorResult(cli: string, result: ExternalCliResult): string {
  // Codex prints "tokens used\n<N>" to stderr; capture it as meta before any trim so the
  // telemetry survives even when we drop the (redundant) stderr on success.
  const tokensMatch = /tokens used\s*\n?\s*([\d,]+)/.exec(result.stderr)
  const metaLines = [
    `cli: ${cli}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
  ]
  if (tokensMatch) metaLines.push(`tokens_used: ${tokensMatch[1].replace(/,/g, '')}`)
  const meta = metaLines.join('\n')

  // On clean success the CLI's stderr is pure scaffolding — banner + the echoed prompt +
  // a verbatim DUPLICATE of stdout + the tokens line (already captured above). Drop it.
  // On failure OR truncation, stderr may hold the only diagnostic signal — keep it.
  if (result.exitCode === 0 && result.truncated === false) {
    return `${meta}\n\nSTDOUT\n${result.stdout}`
  }
  return `${meta}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}`
}
