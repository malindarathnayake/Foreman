// 0.6.8: the Codex seat is pinned to gpt-6-astra at xhigh and the seat reports the model
// and reasoning effort Codex echoes in its stderr header, failing on a substituted model.
import { describe, expect, it } from "vitest"
import { CODEX_ADVISOR_MODEL, CODEX_ADVISOR_REASONING, formatAdvisorResult, parseCodexHeader } from "../src/tools/invokeAdvisor.js"
import type { ExternalCliResult } from "../src/lib/externalCli.js"

const OK: ExternalCliResult = { stdout: "", stderr: "", timedOut: false, exitCode: 0, truncated: false }

const HEADER = (model: string, effort = "xhigh") =>
  [
    "OpenAI Codex v0.153.4 (research preview)",
    "--------",
    "workdir: C:\\repo",
    `model: ${model}`,
    "provider: openai",
    "approval: never",
    "sandbox: read-only",
    `reasoning effort: ${effort}`,
    "reasoning summaries: none",
    "--------",
    "user",
    "review this",
    "tokens used",
    "12,345",
  ].join("\n")

describe("parseCodexHeader", () => {
  it("reads the model and reasoning effort lines", () => {
    expect(parseCodexHeader(HEADER("gpt-6-astra"))).toEqual({ model: "gpt-6-astra", reasoningEffort: "xhigh" })
    expect(parseCodexHeader("no header here")).toEqual({ model: undefined, reasoningEffort: undefined })
  })
})

describe("formatAdvisorResult — codex served-model check", () => {
  it("the pinned model at xhigh: meta names both, stderr is still dropped on success", () => {
    const text = formatAdvisorResult("codex", { ...OK, stdout: "[LOW] src/a.ts:7 typo", stderr: HEADER(CODEX_ADVISOR_MODEL) }, "review this", CODEX_ADVISOR_MODEL)
    expect(text).toContain(`model_requested: ${CODEX_ADVISOR_MODEL}`)
    expect(text).toContain(`model_served: ${CODEX_ADVISOR_MODEL}`)
    expect(text).toContain(`reasoning_effort: ${CODEX_ADVISOR_REASONING}`)
    expect(text).toContain("tokens_used: 12345")
    expect(text).not.toContain("completion: failed")
    expect(text).not.toContain("STDERR")
    expect(text).toContain("STDOUT\n[LOW] src/a.ts:7 typo")
  })

  it("a different model in the header is a failed seat with the text kept", () => {
    const text = formatAdvisorResult("codex", { ...OK, stdout: "[LOW] src/a.ts:7 typo", stderr: HEADER("gpt-5.6-sol") }, "review this", CODEX_ADVISOR_MODEL)
    expect(text).toContain("model_served: gpt-5.6-sol")
    expect(text).toContain("completion: failed")
    expect(text).toContain("failure_reason: model_substituted")
    expect(text).toContain("STDOUT\n[LOW] src/a.ts:7 typo")
  })

  it("no header (older CLI) leaves the seat clean with model_served unknown", () => {
    const text = formatAdvisorResult("codex", { ...OK, stdout: "[LOW] src/a.ts:7 typo", stderr: "" }, "review this", CODEX_ADVISOR_MODEL)
    expect(text).toContain("model_served: unknown")
    expect(text).not.toContain("completion: failed")
  })

  it("a non-zero exit keeps the whole stderr and adds no served-model lines", () => {
    const text = formatAdvisorResult("codex", { ...OK, exitCode: 1, stderr: HEADER("gpt-6-astra") + "\nERROR: quota" }, "review this", CODEX_ADVISOR_MODEL)
    expect(text).not.toContain("model_served")
    expect(text).toContain("STDERR\n")
    expect(text).toContain("ERROR: quota")
  })
})
