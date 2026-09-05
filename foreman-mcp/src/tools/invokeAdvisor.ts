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

/** Prefix runWithStdin puts on a stream it cut (lib/externalCli.ts). Stripped before the emptiness test. */
const TRUNCATION_SENTINEL = "...(truncated)\n"

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

export function formatAdvisorResult(cli: string, result: ExternalCliResult, prompt?: string): string {
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

  // Field feedback 2026-09 round 5: gemini exited 0 with empty stdout twice, and the
  // empty STDOUT section read like a clean seat. Exit 0 with nothing to review, or with
  // the prompt echoed back, is a failed seat. The exit code stays what the child said;
  // stderr's tail is the only diagnostic; no retry here, so the wasted call stays visible.
  const body = result.stdout.startsWith(TRUNCATION_SENTINEL)
    ? result.stdout.slice(TRUNCATION_SENTINEL.length)
    : result.stdout
  const normalized = normalizeText(body)
  let failureReason: "empty_stdout" | "echoed_prompt" | null = null
  if (result.exitCode === 0 && normalized === "") failureReason = "empty_stdout"
  else if (result.exitCode === 0 && prompt !== undefined && normalized === normalizeText(prompt)) failureReason = "echoed_prompt"
  if (failureReason !== null) {
    metaLines.push("completion: failed", `failure_reason: ${failureReason}`)
    if (failureReason === "empty_stdout") metaLines.push("empty_output: true")
    const lines = result.stderr.split("\n")
    const kept = Math.min(lines.length, STDERR_TAIL_LINES)
    const what = failureReason === "empty_stdout" ? "empty stdout" : "stdout equal to the prompt"
    return (
      `${metaLines.join("\n")}\n\n` +
      `This seat produced no review (exit 0, ${what}). It is not a clean seat: record it with completion:'failed' ` +
      "and the reason in limitations, then retry once.\n\n" +
      `STDOUT\n${result.stdout}\n\nSTDERR (tail ${kept} of ${lines.length} lines)\n${lines.slice(-kept).join("\n")}`
    )
  }
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
