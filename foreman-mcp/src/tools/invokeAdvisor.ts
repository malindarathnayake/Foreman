import {
  type ExternalCliResult,
  resolveInvocation,
  runWithStdin,
} from "../lib/externalCli.js"
import type { AdvisorCli } from "../lib/advisorCli.js"

/**
 * Gemini seat model, shared with capability_check so the probe exercises the same model
 * the review uses. gemini-3.1-pro-preview (0.6.7): the CLI serves it faithfully and the
 * API defaults Pro to thinking level high. gemini-3.8-flash was pinned in 0.6.6 after a
 * probe that only proved the id was accepted; the run stats showed gemini-3.5-flash serving
 * the main request on this account, silently, and 3.7-flash the same. Whatever is pinned,
 * the served model is now read from the CLI's JSON output and a mismatch is a failed seat.
 */
export const GEMINI_ADVISOR_MODEL = "gemini-3.1-pro-preview"

/**
 * Codex seat model (0.6.8). Verified through the CLI on 2026-09-05: codex-cli 0.152.0 answers
 * "requires a newer version of Codex" for this id, 0.153.4 runs it at reasoning effort xhigh
 * and echoes `model: gpt-6-astra` in its header. Every other *-astra spelling is refused
 * outright on a ChatGPT account, so acceptance here is not a silent fallback.
 */
export const CODEX_ADVISOR_MODEL = "gpt-6-astra"
export const CODEX_ADVISOR_REASONING = "xhigh"

/** Codex prints `model: <id>` and `reasoning effort: <level>` in its stderr header. */
export function parseCodexHeader(stderr: string): { model?: string; reasoningEffort?: string } {
  const model = /^model:\s*(\S+)\s*$/m.exec(stderr)?.[1]
  const reasoningEffort = /^reasoning effort:\s*(\S+)\s*$/m.exec(stderr)?.[1]
  return { model, reasoningEffort }
}

/** What one gemini run reports in `--output-format json`. */
export interface GeminiRun {
  response: string
  /** The model the CLI recorded for the main role; undefined when the stats carry none. */
  mainModel?: string
  thoughts?: number
}

/**
 * Parses gemini's JSON output: `{ response, stats: { models: { <id>: { roles: { main }, tokens } } } }`.
 * Returns null for anything that is not that shape (older CLI printing text, truncated output).
 */
export function parseGeminiJson(stdout: string): GeminiRun | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith("{")) return null
  let doc: unknown
  try {
    doc = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof doc !== "object" || doc === null) return null
  const d = doc as {
    response?: unknown
    stats?: { models?: Record<string, { roles?: Record<string, unknown>; tokens?: { thoughts?: number } }> }
  }
  if (typeof d.response !== "string") return null
  const models = d.stats?.models ?? {}
  let mainModel: string | undefined
  let thoughts: number | undefined
  for (const [name, m] of Object.entries(models)) {
    if (m.roles && "main" in m.roles) {
      mainModel = name
      thoughts = m.tokens?.thoughts
      break
    }
  }
  if (mainModel === undefined) {
    const first = Object.keys(models)[0]
    if (first !== undefined) {
      mainModel = first
      thoughts = models[first].tokens?.thoughts
    }
  }
  return { response: d.response, mainModel, thoughts }
}

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
      "-m", CODEX_ADVISOR_MODEL,
      "-c", `model_reasoning_effort=${CODEX_ADVISOR_REASONING}`,
      "-c", "hide_agent_reasoning=true", "-"
    ],
  },
  gemini: {
    // The model id is passed directly (0.6.6); the earlier `arch-review` was a custom alias
    // that existed only in one machine's ~/.gemini/settings.json. JSON output (0.6.7) so the
    // served model and thinking tokens can be read from the run stats: an accepted id is no
    // proof of the model that answered. `-p ""` is appended to the prompt on stdin.
    buildArgs: () => [
      "-p", "", "-m", GEMINI_ADVISOR_MODEL,
      "--approval-mode", "plan", "--output-format", "json"
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

/** The facts one advisor run established, shared by the formatted output and the seat receipt (0.6.19). */
export interface AdvisorRunMeta {
  metaLines: string[]
  body: string
  failureReason: "empty_stdout" | "echoed_prompt" | "model_substituted" | null
  modelRequested?: string
  modelServed?: string
  reasoningEffort?: string
  tokensUsed?: number
}

export function advisorRunMeta(
  cli: string,
  result: ExternalCliResult,
  prompt?: string,
  requestedModel?: string
): AdvisorRunMeta {
  // Codex prints "tokens used\n<N>" to stderr; capture it as meta before any trim so the
  // telemetry survives even when we drop the (redundant) stderr on success.
  const tokensMatch = /tokens used\s*\n?\s*([\d,]+)/.exec(result.stderr)
  const metaLines = [
    `cli: ${cli}`,
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    `truncated: ${result.truncated}`,
  ]
  const tokensUsed = tokensMatch ? Number(tokensMatch[1].replace(/,/g, '')) : undefined
  if (tokensMatch) metaLines.push(`tokens_used: ${tokensMatch[1].replace(/,/g, '')}`)
  let modelServed: string | undefined
  let reasoningEffort: string | undefined

  let body = result.stdout.startsWith(TRUNCATION_SENTINEL)
    ? result.stdout.slice(TRUNCATION_SENTINEL.length)
    : result.stdout
  let failureReason: "empty_stdout" | "echoed_prompt" | "model_substituted" | null = null

  // 0.6.8: codex echoes the model and reasoning effort it ran with in its stderr header,
  // before stderr is dropped on success. Report both; a model other than the pinned one is
  // a failed seat, the same rule as gemini below.
  if (cli === "codex" && result.exitCode === 0) {
    const header = parseCodexHeader(result.stderr)
    modelServed = header.model
    reasoningEffort = header.reasoningEffort
    if (requestedModel !== undefined) metaLines.push(`model_requested: ${requestedModel}`)
    metaLines.push(`model_served: ${header.model ?? "unknown"}`)
    if (header.reasoningEffort !== undefined) metaLines.push(`reasoning_effort: ${header.reasoningEffort}`)
    if (requestedModel !== undefined && header.model !== undefined && header.model !== requestedModel) {
      failureReason = "model_substituted"
    }
  }

  // 0.6.7: gemini answers in JSON so the seat can say which model actually served the main
  // request. On one account the CLI served gemini-3.5-flash for a pinned 3.8-flash with exit 0
  // and a plausible answer; only the run stats told. A served model other than the pinned one
  // is a failed seat, with the text kept below for the record.
  if (cli === "gemini" && result.exitCode === 0) {
    const run = parseGeminiJson(body)
    if (run) {
      body = run.response
      modelServed = run.mainModel
      if (requestedModel !== undefined) metaLines.push(`model_requested: ${requestedModel}`)
      metaLines.push(`model_served: ${run.mainModel ?? "unknown"}`)
      if (run.thoughts !== undefined) metaLines.push(`thoughts_tokens: ${run.thoughts}`)
      if (requestedModel !== undefined && run.mainModel !== undefined && run.mainModel !== requestedModel) {
        failureReason = "model_substituted"
      }
    } else {
      metaLines.push("model_served: unknown (output was not the CLI's JSON envelope)")
    }
  }

  // Field feedback 2026-09 round 5: gemini exited 0 with empty stdout twice, and the
  // empty STDOUT section read like a clean seat. Exit 0 with nothing to review, or with
  // the prompt echoed back, is a failed seat. The exit code stays what the child said;
  // stderr's tail is the only diagnostic; no retry here, so the wasted call stays visible.
  const normalized = normalizeText(body)
  if (failureReason === null && result.exitCode === 0 && normalized === "") failureReason = "empty_stdout"
  else if (failureReason === null && result.exitCode === 0 && prompt !== undefined && normalized === normalizeText(prompt)) {
    failureReason = "echoed_prompt"
  }
  return { metaLines, body, failureReason, modelRequested: requestedModel, modelServed, reasoningEffort, tokensUsed }
}

export function formatAdvisorResult(
  cli: string,
  result: ExternalCliResult,
  prompt?: string,
  requestedModel?: string,
  /** 0.6.19: lines the server adds to the meta block (seat_receipt, packet_sha256). */
  extraMeta: string[] = []
): string {
  const { metaLines, body, failureReason } = advisorRunMeta(cli, result, prompt, requestedModel)
  metaLines.push(...extraMeta)
  if (failureReason !== null) {
    metaLines.push("completion: failed", `failure_reason: ${failureReason}`)
    if (failureReason === "empty_stdout") metaLines.push("empty_output: true")
    const lines = result.stderr.split("\n")
    const kept = Math.min(lines.length, STDERR_TAIL_LINES)
    const explanation =
      failureReason === "model_substituted"
        ? `This seat did not run on the pinned model: requested ${requestedModel}, served by the model named in model_served. ` +
          "The text below is kept for the record; it is not a review from the pinned seat. Record it with completion:'failed' " +
          "and the reason in limitations."
        : `This seat produced no review (exit 0, ${failureReason === "empty_stdout" ? "empty stdout" : "stdout equal to the prompt"}). ` +
          "It is not a clean seat: record it with completion:'failed' and the reason in limitations, then retry once."
    return (
      `${metaLines.join("\n")}\n\n${explanation}\n\n` +
      `STDOUT\n${body}\n\nSTDERR (tail ${kept} of ${lines.length} lines)\n${lines.slice(-kept).join("\n")}`
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
    return `${meta}\n\nSTDOUT\n${body}`
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
