// 0.9.6: the gemini seat prefers the Antigravity CLI (agy) and falls back to gemini-cli when
// agy is not on PATH. agy takes the prompt as a stream-json event on stdin and names the
// served model only in its log, so both are covered here with the CLI mocked.
import fs from "fs/promises"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
  resolveFirst: vi.fn(),
  runWithStdin: vi.fn(),
  runExternalCli: vi.fn(),
}))

import { resolveInvocation, runWithStdin, runExternalCli } from "../src/lib/externalCli.js"
import {
  AGY_ADVISOR_MODEL,
  AGY_ADVISOR_MODEL_LABEL,
  AGY_ADVISOR_SETTINGS,
  GEMINI_ADVISOR_MODEL,
  advisorRunMeta,
  agyArgs,
  agyServedLabels,
  agyServedModel,
  agyStdin,
  classifyAdvisorFailure,
  formatAdvisorResult,
  invokeAdvisor,
  parseAgyStream,
  pinnedAdvisorModel,
} from "../src/tools/invokeAdvisor.js"
import { capabilityCheck } from "../src/tools/capabilityCheck.js"
import type { ExternalCliResult } from "../src/lib/externalCli.js"

const OK: ExternalCliResult = { stdout: "", stderr: "", timedOut: false, exitCode: 0, truncated: false }

function agyStream(response: string, opts: { status?: string; error?: string; thinking?: number; total?: number } = {}): string {
  const init = { event: "init", conversation_id: "c1", init: { model: AGY_ADVISOR_MODEL, tools: ["view_file"], permission_mode: "request-review" } }
  const delta = { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: response } }
  const result = {
    event: "result",
    result: {
      conversation_id: "c1", status: opts.status ?? "SUCCESS", response, ...(opts.error ? { error: opts.error } : {}),
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: opts.thinking ?? 68, total_tokens: opts.total ?? 83 },
    },
  }
  return [init, delta, result].map((e) => JSON.stringify(e)).join("\n") + "\n"
}

function propagateLog(...labels: string[]): string {
  return [
    `I1117 13:22:47.754491 1 resolver.go:85] Model ID ${AGY_ADVISOR_MODEL} not in local config, defaulting to CCPA`,
    ...labels.map((l) => `I1117 13:22:48.299010 1 model_config_manager.go:375] Propagating selected model override to backend: label="${l}"`),
  ].join("\n")
}

describe("agy stream and log parsing", () => {
  it("reads the response, status, init model and token counts", () => {
    expect(parseAgyStream(agyStream("[LOW] a.ts:1 typo", { thinking: 12, total: 40 }))).toEqual({
      initModel: AGY_ADVISOR_MODEL, status: "SUCCESS", response: "[LOW] a.ts:1 typo", error: undefined, thinkingTokens: 12, totalTokens: 40,
    })
  })

  it("skips a cut head line and non-JSON noise, and returns null without events", () => {
    const stream = "...(truncated)\n" + '"tail of a cut line"}\n' + agyStream("ok")
    expect(parseAgyStream(stream)?.response).toBe("ok")
    expect(parseAgyStream("plain text")).toBeNull()
  })

  it("names the pinned id only when every propagated label is the pinned model's", () => {
    expect(agyServedLabels(propagateLog(AGY_ADVISOR_MODEL_LABEL, AGY_ADVISOR_MODEL_LABEL))).toEqual([AGY_ADVISOR_MODEL_LABEL, AGY_ADVISOR_MODEL_LABEL])
    expect(agyServedModel([AGY_ADVISOR_MODEL_LABEL, AGY_ADVISOR_MODEL_LABEL])).toBe(AGY_ADVISOR_MODEL)
    expect(agyServedModel([AGY_ADVISOR_MODEL_LABEL, "Gemini 3.8 Flash (Low)"])).toBe("Gemini 3.8 Flash (Low)")
    expect(agyServedModel([])).toBeUndefined()
  })
})

describe("agy arguments", () => {
  it("sends the prompt as one stream-json event and never on the command line", () => {
    const prompt = 'review "this"\nline two'
    expect(JSON.parse(agyStdin(prompt).trim())).toEqual({ event: "user", message: { content: prompt } })
    expect(agyArgs("/tmp/l.log", 900_000).join(" ")).not.toContain("review")
  })

  it("pins the model, sandboxes, denies writes, commands, MCP and URLs, and stops before Foreman's kill", () => {
    const args = agyArgs("/tmp/l.log", 900_000)
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json", "--sandbox"]))
    expect(args[args.indexOf("--model") + 1]).toBe(AGY_ADVISOR_MODEL)
    expect(args[args.indexOf("--log-file") + 1]).toBe("/tmp/l.log")
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("870s")
    expect(agyArgs("/tmp/l.log", 5_000)[agyArgs("/tmp/l.log", 5_000).indexOf("--print-timeout") + 1]).toBe("5s")
    expect(args).not.toContain("--dangerously-skip-permissions")
    const settings = JSON.parse(args[args.indexOf("--settings") + 1])
    expect(settings).toEqual(JSON.parse(AGY_ADVISOR_SETTINGS))
    for (const rule of ["write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "download_url(*)"]) {
      expect(settings.permissions.deny).toContain(rule)
    }
    expect(settings.permissions.allow).toEqual(["read_file(*)"])
  })
})

describe("invokeAdvisor — gemini seat backend choice", () => {
  beforeEach(() => vi.clearAllMocks())

  it("runs agy when it is on PATH, with a large stdout budget, and reads the served labels from its log", async () => {
    vi.mocked(resolveInvocation).mockResolvedValue({ ok: true, plan: { command: "agy", args: [] } })
    vi.mocked(runWithStdin).mockImplementation(async (_cmd, args) => {
      await fs.writeFile(args[args.indexOf("--log-file") + 1], propagateLog(AGY_ADVISOR_MODEL_LABEL))
      return { ...OK, stdout: agyStream("[HIGH] b.ts:3 leak") }
    })
    const result = await invokeAdvisor("gemini", "review this", 60_000)
    expect(resolveInvocation).toHaveBeenCalledWith("agy")
    const call = vi.mocked(runWithStdin).mock.calls[0]
    expect(call[0]).toBe("agy")
    expect(call[2]).toBe(agyStdin("review this"))
    expect(call[6]).toBe(1_000_000)
    expect(result.agy).toEqual({ servedLabels: [AGY_ADVISOR_MODEL_LABEL] })
    expect(pinnedAdvisorModel("gemini", result)).toBe(AGY_ADVISOR_MODEL)
  })

  it("falls back to gemini-cli and its pin when agy is not installed", async () => {
    vi.mocked(resolveInvocation).mockImplementation(async (name: string) =>
      name === "agy" ? { ok: false, reason: "agy not found" } : { ok: true, plan: { command: "gemini", args: [] } })
    vi.mocked(runWithStdin).mockResolvedValue(OK)
    const result = await invokeAdvisor("gemini", "review this", 60_000)
    expect(vi.mocked(runWithStdin).mock.calls[0][1]).toContain(GEMINI_ADVISOR_MODEL)
    expect(result.agy).toBeUndefined()
    expect(pinnedAdvisorModel("gemini", result)).toBe(GEMINI_ADVISOR_MODEL)
  })
})

describe("advisorRunMeta / formatAdvisorResult — agy", () => {
  const agyResult = (stdout: string, labels: string[], over: Partial<ExternalCliResult> = {}): ExternalCliResult =>
    ({ ...OK, stdout, agy: { servedLabels: labels }, ...over })

  it("the pinned model served: the response is unwrapped with backend, served model and tokens", () => {
    const r = agyResult(agyStream("[HIGH] b.ts:3 leak", { thinking: 1403, total: 2000 }), [AGY_ADVISOR_MODEL_LABEL])
    const meta = advisorRunMeta("gemini", r, "the prompt", AGY_ADVISOR_MODEL)
    expect(meta.body).toBe("[HIGH] b.ts:3 leak")
    expect(meta.modelServed).toBe(AGY_ADVISOR_MODEL)
    expect(meta.tokensUsed).toBe(2000)
    expect(meta.failureReason).toBeNull()
    const text = formatAdvisorResult("gemini", r, "the prompt", AGY_ADVISOR_MODEL)
    expect(text).toContain("backend: agy")
    expect(text).toContain(`model_served: ${AGY_ADVISOR_MODEL}`)
    expect(text).toContain("thoughts_tokens: 1403")
    expect(text).toContain("STDOUT\n[HIGH] b.ts:3 leak")
    expect(text).not.toContain('"event"')
  })

  it("another propagated label is a failed seat with model_substituted", () => {
    const r = agyResult(agyStream("text"), ["Gemini 3.8 Flash (Low)"])
    const text = formatAdvisorResult("gemini", r, "the prompt", AGY_ADVISOR_MODEL)
    expect(text).toContain("model_served: Gemini 3.8 Flash (Low)")
    expect(text).toContain("failure_reason: model_substituted")
  })

  it("no label in the log leaves the served model unknown, not a failure", () => {
    const meta = advisorRunMeta("gemini", agyResult(agyStream("text"), []), "the prompt", AGY_ADVISOR_MODEL)
    expect(meta.modelServed).toBeUndefined()
    expect(meta.metaLines).toContain("model_served: unknown (agy log named no model)")
    expect(meta.failureReason).toBeNull()
  })

  it("an empty response is still empty_stdout", () => {
    const meta = advisorRunMeta("gemini", agyResult(agyStream("  "), [AGY_ADVISOR_MODEL_LABEL]), "the prompt", AGY_ADVISOR_MODEL)
    expect(meta.failureReason).toBe("empty_stdout")
  })

  it("classifies an unknown model and a missing login from the result event, whatever stderr's tail holds", () => {
    const models = Array.from({ length: 40 }, (_, i) => `  Model ${i}`).join("\n")
    const rejected = agyResult(agyStream("", { status: "ERROR", error: 'invalid model selection (--model "x")' }), [], { exitCode: 1, stderr: `error: invalid model selection\nAvailable models:\n${models}` })
    expect(classifyAdvisorFailure(rejected)).toBe("model_rejected")
    const auth = agyResult(agyStream("", { status: "ERROR", error: "authentication required" }), [], { exitCode: 1 })
    expect(classifyAdvisorFailure(auth)).toBe("auth_failed")
  })
})

describe("capabilityCheck — gemini seat through agy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveInvocation).mockResolvedValue({ ok: true, plan: { command: "agy", args: [] } })
    vi.mocked(runExternalCli).mockResolvedValue({ ...OK, stdout: "1.5.10\n" })
  })

  it("probes agy with a real call and reports ok with the served model", async () => {
    vi.mocked(runWithStdin).mockImplementation(async (_cmd, args) => {
      await fs.writeFile(args[args.indexOf("--log-file") + 1], propagateLog(AGY_ADVISOR_MODEL_LABEL))
      return { ...OK, stdout: agyStream("OK") }
    })
    const out = await capabilityCheck("gemini")
    expect(out).toContain("backend: agy")
    expect(out).toContain("version: 1.5.10")
    expect(out).toContain("auth_status: ok")
    expect(out).toContain(`model_requested: ${AGY_ADVISOR_MODEL}`)
    expect(out).toContain(`model_served: ${AGY_ADVISOR_MODEL}`)
  })

  it("reports auth_expired when agy is not signed in", async () => {
    vi.mocked(runWithStdin).mockResolvedValue({ ...OK, exitCode: 1, stdout: agyStream("", { status: "ERROR", error: "authentication required" }) })
    const out = await capabilityCheck("gemini")
    expect(out).toContain("auth_status: auth_expired")
    expect(out).toMatch(/^hint: .*agy/m)
  })
})
