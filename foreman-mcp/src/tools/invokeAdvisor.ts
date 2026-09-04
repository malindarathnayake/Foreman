import {
  type ExternalCliResult,
  resolveInvocation,
  runWithStdin,
} from "../lib/externalCli.js"
import type { AdvisorCli } from "../lib/advisorCli.js"

const ADVISOR_CONFIGS: Record<AdvisorCli, { buildArgs: () => string[] }> = {
  claude: {
    buildArgs: () => [
      "-p",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--model", "claude-fable-5",
      "--effort", "max",
      "--tools=",
      "--max-budget-usd", "1",
      "--output-format", "text",
    ],
  },
  codex: {
    buildArgs: () => [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      "-m", "gpt-5.6-sol",
      "-c", "model_reasoning_effort=xhigh",
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
  cli: AdvisorCli,
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
  // Only STDOUT truncation matters for that decision: Codex streams its own tool-call
  // transcript to stderr, which alone trips the cap on every big review and used to
  // ship 16k of transcript with a successful answer (field feedback 2026-09 round 2).
  // On failure, stderr may hold the only diagnostic signal — keep it whole.
  const stdoutCut = result.stdoutTruncated ?? result.truncated
  if (result.exitCode === 0 && !stdoutCut) {
    return `${meta}\n\nSTDOUT\n${result.stdout}`
  }
  if (result.exitCode === 0) {
    // stdout was cut: the answer's tail may only survive in stderr's echo. Keep that tail.
    const lines = result.stderr.split("\n")
    const kept = Math.min(lines.length, STDERR_TAIL_LINES)
    return `${meta}\n\nSTDOUT\n${result.stdout}\n\nSTDERR (tail ${kept} of ${lines.length} lines)\n${lines.slice(-kept).join("\n")}`
  }
  return `${meta}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}`
}

/** Lines of stderr kept when a successful call's stdout was truncated. */
const STDERR_TAIL_LINES = 40
