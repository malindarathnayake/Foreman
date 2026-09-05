// 0.6.7: the Gemini seat is pinned to gemini-3.1-pro-preview and reads the served model
// from the CLI's JSON output. An accepted model id proved nothing: on one account the CLI
// served gemini-3.5-flash for a pinned 3.8-flash with exit 0 and a plausible answer.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
  runWithStdin: vi.fn(),
  runExternalCli: vi.fn(),
}))

import { resolveInvocation, runWithStdin, runExternalCli } from "../src/lib/externalCli.js"
import { GEMINI_ADVISOR_MODEL, formatAdvisorResult, invokeAdvisor, parseGeminiJson } from "../src/tools/invokeAdvisor.js"
import { capabilityCheck } from "../src/tools/capabilityCheck.js"
import type { ExternalCliResult } from "../src/lib/externalCli.js"

const OK: ExternalCliResult = { stdout: "", stderr: "", timedOut: false, exitCode: 0, truncated: false }

function geminiJson(mainModel: string, response = "[LOW] src/a.ts:7 typo", thoughts = 219, extraModel?: string): string {
  const models: Record<string, unknown> = {
    [mainModel]: { api: { totalRequests: 1, totalErrors: 0 }, tokens: { candidates: 12, thoughts }, roles: { main: { totalRequests: 1 } } },
  }
  if (extraModel) models[extraModel] = { api: { totalRequests: 1, totalErrors: 0 }, tokens: { candidates: 3, thoughts: 0 }, roles: { classifier: {} } }
  return JSON.stringify({ session_id: "s1", response, stats: { models, tools: {} } })
}

describe("parseGeminiJson", () => {
  it("reads the response and the model that served the main role, with its thinking tokens", () => {
    const run = parseGeminiJson(geminiJson("gemini-3.1-pro-preview", "text", 501, "gemini-3.5-flash"))
    expect(run).toEqual({ response: "text", mainModel: "gemini-3.1-pro-preview", thoughts: 501 })
  })

  it("falls back to the first model when no role is marked main, and rejects non-envelopes", () => {
    const noRoles = JSON.stringify({ response: "t", stats: { models: { "gemini-3.5-flash": { tokens: { thoughts: 7 } } } } })
    expect(parseGeminiJson(noRoles)).toEqual({ response: "t", mainModel: "gemini-3.5-flash", thoughts: 7 })
    expect(parseGeminiJson("plain text review")).toBeNull()
    expect(parseGeminiJson("{ not json")).toBeNull()
    expect(parseGeminiJson(JSON.stringify({ stats: {} }))).toBeNull()
  })
})

describe("formatAdvisorResult — gemini served-model check", () => {
  it("a served model other than the pinned one is a failed seat, text kept for the record", () => {
    const text = formatAdvisorResult("gemini", { ...OK, stdout: geminiJson("gemini-3.5-flash") }, "the prompt", GEMINI_ADVISOR_MODEL)
    expect(text).toContain(`model_requested: ${GEMINI_ADVISOR_MODEL}`)
    expect(text).toContain("model_served: gemini-3.5-flash")
    expect(text).toContain("completion: failed")
    expect(text).toContain("failure_reason: model_substituted")
    expect(text).toContain("did not run on the pinned model")
    expect(text).toContain("STDOUT\n[LOW] src/a.ts:7 typo")
    expect(text).toContain("exit_code: 0")
  })

  it("the pinned model served: the envelope is unwrapped and the thinking tokens are reported", () => {
    const text = formatAdvisorResult("gemini", { ...OK, stdout: geminiJson(GEMINI_ADVISOR_MODEL, "[HIGH] src/b.ts:3 leak", 1403) }, "the prompt", GEMINI_ADVISOR_MODEL)
    expect(text).not.toContain("completion: failed")
    expect(text).toContain(`model_served: ${GEMINI_ADVISOR_MODEL}`)
    expect(text).toContain("thoughts_tokens: 1403")
    expect(text).toContain("STDOUT\n[HIGH] src/b.ts:3 leak")
    expect(text).not.toContain('"stats"')
  })

  it("an empty response inside the envelope is still empty_stdout", () => {
    const text = formatAdvisorResult("gemini", { ...OK, stdout: geminiJson(GEMINI_ADVISOR_MODEL, "  ") }, "the prompt", GEMINI_ADVISOR_MODEL)
    expect(text).toContain("failure_reason: empty_stdout")
  })

  it("non-JSON output from an older CLI is treated as text with the served model unknown", () => {
    const text = formatAdvisorResult("gemini", { ...OK, stdout: "[LOW] src/a.ts:7 typo" }, "the prompt", GEMINI_ADVISOR_MODEL)
    expect(text).toContain("model_served: unknown")
    expect(text).not.toContain("completion: failed")
    expect(text).toContain("STDOUT\n[LOW] src/a.ts:7 typo")
  })

  it("other CLIs are untouched by the check", () => {
    const text = formatAdvisorResult("codex", { ...OK, stdout: geminiJson("gemini-3.5-flash") }, "the prompt")
    expect(text).not.toContain("model_served")
    expect(text).not.toContain("completion: failed")
  })
})

describe("invokeAdvisor — gemini arguments", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveInvocation).mockResolvedValue({ ok: true, plan: { command: "gemini", args: [] } })
    vi.mocked(runWithStdin).mockResolvedValue(OK)
  })

  it("pins gemini-3.1-pro-preview and asks for JSON output", async () => {
    await invokeAdvisor("gemini", "review this", 1_000)
    expect(runWithStdin).toHaveBeenCalledWith(
      "gemini",
      ["-p", "", "-m", "gemini-3.1-pro-preview", "--approval-mode", "plan", "--output-format", "json"],
      "review this",
      1_000
    )
  })
})

describe("capabilityCheck — gemini served-model check", () => {
  function mockRun(health: ExternalCliResult) {
    return vi.fn(async (_cmd: string, args: string[]) =>
      args.includes("--version") ? { ...OK, stdout: "0.57.0" } : health
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveInvocation).mockResolvedValue({ ok: true, plan: { command: "gemini", args: [] } })
  })

  it("reports model_substituted with both models when the CLI answered with another model", async () => {
    vi.mocked(runExternalCli).mockImplementation(mockRun({ ...OK, stdout: geminiJson("gemini-3.5-flash", "health check") }))
    const out = await capabilityCheck("gemini")
    expect(out).toContain("auth_status: model_substituted")
    expect(out).toContain(`model_requested: ${GEMINI_ADVISOR_MODEL}`)
    expect(out).toContain("model_served: gemini-3.5-flash")
    expect(out).toMatch(/^hint: .*pin a model the CLI serves/m)
    expect(out).toContain("available: true")
  })

  it("reports ok with the served model when the pinned model answered", async () => {
    vi.mocked(runExternalCli).mockImplementation(mockRun({ ...OK, stdout: geminiJson(GEMINI_ADVISOR_MODEL, "health check") }))
    const out = await capabilityCheck("gemini")
    expect(out).toContain("auth_status: ok")
    expect(out).toContain(`model_served: ${GEMINI_ADVISOR_MODEL}`)
    expect(out).not.toMatch(/^hint: /m)
  })

  it("stays ok with model_served unknown when the output is not the JSON envelope", async () => {
    vi.mocked(runExternalCli).mockImplementation(mockRun({ ...OK, stdout: "" }))
    const out = await capabilityCheck("gemini")
    expect(out).toContain("auth_status: ok")
    expect(out).toContain("model_served: unknown")
  })
})
