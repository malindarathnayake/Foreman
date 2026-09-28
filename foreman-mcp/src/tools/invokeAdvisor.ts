import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  type ExternalCliResult,
  type SpawnControls,
  resolveFirst,
  resolveInvocation,
  runExternalCli,
  runWithStdin,
} from "../lib/externalCli.js"
import { CURSOR_AGENT_BINS, type AdvisorCli } from "../lib/advisorCli.js"

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

/**
 * Cursor Agent CLI print-mode flags for a read-only advisor.
 * Never `--approve-mcps` (the child must not load Foreman MCP) and never a
 * pinned `--model` (Cursor ids rotate; inherit). Prompt is a tempfile because
 * Windows cmd.exe wrapping the `.cmd` shim caps argv at ~8191 characters.
 */
export const CURSOR_ADVISOR_ARGS = ["-p", "--mode=ask", "--trust", "--output-format", "text"] as const

export function cursorPromptArg(filePath: string): string {
  return `Follow the instructions in this file verbatim and reply with the review only. Do not mention the file path. File: ${filePath}`
}

/**
 * 0.6.35 (field report 2026-09-25): the Claude seat's $1 cap was fixed, so a 3-file packet at
 * max effort failed with no way to raise it. FOREMAN_CLAUDE_ADVISOR_BUDGET_USD overrides it with
 * a finite positive value up to a ceiling; anything else keeps the default. The default stays $1
 * until there is cost evidence for more, and there is no "0 = uncapped".
 */
export const CLAUDE_ADVISOR_BUDGET_DEFAULT_USD = 1
export const CLAUDE_ADVISOR_BUDGET_CEILING_USD = 25
export function claudeAdvisorBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FOREMAN_CLAUDE_ADVISOR_BUDGET_USD?.trim()
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return CLAUDE_ADVISOR_BUDGET_DEFAULT_USD
  const n = Number(raw)
  return n > 0 && n <= CLAUDE_ADVISOR_BUDGET_CEILING_USD ? n : CLAUDE_ADVISOR_BUDGET_DEFAULT_USD
}

/**
 * 0.6.35: why a seat that exited non-zero failed, read from structured state first and then
 * from the TAIL of stderr only — Codex echoes the prompt at the top of stderr, so a prompt
 * that mentions a 401 must not read as an auth failure. Unknown stays unknown.
 */
export type AdvisorFailureClass = "cancelled" | "timed_out" | "auth_failed" | "budget_exceeded" | "model_rejected"
const FAILURE_TAIL_LINES = 25
export function classifyAdvisorFailure(result: ExternalCliResult): AdvisorFailureClass | null {
  if (result.cancelled) return "cancelled"
  if (result.timedOut) return "timed_out"
  if (result.exitCode === 0) return null
  const tail = result.stderr.split("\n").slice(-FAILURE_TAIL_LINES).join("\n")
  if (/Exceeded USD budget/i.test(tail)) return "budget_exceeded"
  if (/\b401 Unauthorized\b|\b403 Forbidden\b|Incorrect API key|invalid[_ ]api[_ ]key|not logged in|please (run )?\S*\s*login/i.test(tail)) return "auth_failed"
  if (/model is not supported|requires a newer version of Codex|model[_ ]not[_ ]found|unknown model|issue with the selected model|unrecognized_model|not have access to it/i.test(tail)) return "model_rejected"
  return null
}
export const ADVISOR_FAILURE_HINT: Readonly<Record<AdvisorFailureClass, string>> = {
  cancelled: "the host cancelled the call (or disconnected); the seat's output is incomplete and cannot be bound as a review — re-run it",
  timed_out: "the seat ran out of time; narrow the packet or raise timeout_ms (and the host's tool timeout, see host_status)",
  auth_failed: "the CLI's credential was rejected; re-authenticate it (codex: codex logout && codex login; claude: /login). capability_check reports local login state only, not whether the service accepts it",
  budget_exceeded: "the Claude seat hit its USD cap; set FOREMAN_CLAUDE_ADVISOR_BUDGET_USD (max 25) or shrink the packet",
  model_rejected: "the CLI refused the pinned model; upgrade the CLI or pick a model the account tier allows",
}

/**
 * 0.6.39: the Claude seat runs Fable 5.1 (probe 2026-09-27: the CLI reported serving
 * claude-fable-5-1). When the CLI refuses it — not on this account or CLI version — the seat
 * retries once on Opus, same CLI and vendor, and says so; provenance is unchanged.
 */
export const CLAUDE_ADVISOR_MODEL = "claude-fable-5-1"
export const CLAUDE_FALLBACK_MODEL = "claude-opus-5-5"

const ADVISOR_CONFIGS: Record<AdvisorCli, { binaries: readonly string[]; buildArgs: (model?: string) => string[]; prompt: "stdin" | "tempfile" }> = {
  claude: {
    binaries: ["claude"],
    prompt: "stdin",
    buildArgs: (model = CLAUDE_ADVISOR_MODEL) => [
      "-p",
      "--no-session-persistence",
      "--permission-mode", "dontAsk",
      "--model", model,
      "--effort", "max",
      "--tools=",
      "--max-budget-usd", String(claudeAdvisorBudgetUsd()),
      "--output-format", "text",
    ],
  },
  codex: {
    binaries: ["codex"],
    prompt: "stdin",
    buildArgs: () => [
      "exec", "--skip-git-repo-check", "-s", "read-only",
      "-m", CODEX_ADVISOR_MODEL,
      "-c", `model_reasoning_effort=${CODEX_ADVISOR_REASONING}`,
      "-c", "hide_agent_reasoning=true", "-"
    ],
  },
  gemini: {
    binaries: ["gemini"],
    prompt: "stdin",
    // The model id is passed directly (0.6.6); the earlier `arch-review` was a custom alias
    // that existed only in one machine's ~/.gemini/settings.json. JSON output (0.6.7) so the
    // served model and thinking tokens can be read from the run stats: an accepted id is no
    // proof of the model that answered. `-p ""` is appended to the prompt on stdin.
    buildArgs: () => [
      "-p", "", "-m", GEMINI_ADVISOR_MODEL,
      "--approval-mode", "plan", "--output-format", "json"
    ],
  },
  cursor: {
    binaries: CURSOR_AGENT_BINS,
    prompt: "tempfile",
    buildArgs: () => [...CURSOR_ADVISOR_ARGS],
  },
}

async function withTempPrompt<T>(prompt: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-cursor-"))
  const filePath = path.join(dir, "prompt.txt")
  await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 })
  try {
    return await fn(filePath)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function invokeAdvisor(
  cli: AdvisorCli,
  prompt: string,
  timeoutMs: number,
  controls?: SpawnControls,
): Promise<ExternalCliResult> {
  const config = ADVISOR_CONFIGS[cli]
  if (!config) {
    return { stdout: '', stderr: `unknown cli: ${cli}`, timedOut: false, exitCode: -1, truncated: false }
  }

  const resolution = config.binaries.length === 1
    ? await resolveInvocation(config.binaries[0])
    : await resolveFirst(config.binaries)
  if (!resolution.ok) {
    return { stdout: '', stderr: resolution.reason, timedOut: false, exitCode: -1, truncated: false }
  }

  const plan = resolution.plan
  const built = config.buildArgs()

  if (config.prompt === "tempfile") {
    return withTempPrompt(prompt, (filePath) =>
      runExternalCli(plan.command, [...plan.args, ...built, cursorPromptArg(filePath)], timeoutMs, controls)
    )
  }

  const first = await runWithStdin(plan.command, [...plan.args, ...built], prompt, timeoutMs, undefined, controls)
  if (cli !== "claude" || classifyAdvisorFailure(first) !== "model_rejected") return first
  const retry = await runWithStdin(plan.command, [...plan.args, ...config.buildArgs(CLAUDE_FALLBACK_MODEL)], prompt, timeoutMs, undefined, controls)
  return { ...retry, modelFallback: { from: CLAUDE_ADVISOR_MODEL, to: CLAUDE_FALLBACK_MODEL, reason: "model_rejected", first } }
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
  const failed = classifyAdvisorFailure(result)
  const why = failed ? `\ncompletion: failed\nfailure_reason: ${failed}\nhint: ${ADVISOR_FAILURE_HINT[failed]}` : ""
  return `${meta}${why}\n\nSTDOUT\n${result.stdout}\n\nSTDERR\n${result.stderr}`
}

/** Lines of stderr kept when a successful call's stdout was truncated. */
const STDERR_TAIL_LINES = 40
