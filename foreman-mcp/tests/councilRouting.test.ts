import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { handleInvokeCouncil, resetCouncilEgressNoticeForTest } from "../src/tools/invokeCouncil.js"
import { parseSseChat } from "../src/lib/chatTransport.js"
import { resetForTest } from "../src/lib/redaction.js"
import { initSession } from "../src/lib/journal.js"
import { readReceipts } from "../src/lib/seatReceipts.js"
import { councilTracer, resetCouncilTracerForTest } from "../src/lib/councilTrace.js"

// Passthrough wrapper so a test can assert whether the Langfuse tracer was ever requested.
vi.mock("../src/lib/councilTrace.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/councilTrace.js")>()
  return { ...mod, councilTracer: vi.fn(mod.councilTracer) }
})
import { LENS_CATALOG, SEAT_RESPONSE_SCHEMA, buildSeatPrompt } from "../src/lib/lensCatalog.js"

// Per-call model pinning (seat_models) and fail-closed Zero Data Retention routing (require_zdr).
// Every case here runs through an injected fetchImpl: nothing reaches the network.

const OR_BASE = "https://openrouter.ai/api/v1"
const CONFIG_A = "deepseek/deepseek-v4-flash"
const CONFIG_B = "moonshotai/kimi-k3"
const PIN_A = "deepseek/deepseek-v4-pro"
const PIN_B = "qwen/qwen3-coder-plus"
const KEY = "test-key-routing-0000001"
const ZDR_LINE = "routing: zdr=required (provider.zdr=true, require_parameters=true, redirect=error)"

let dirsToClean: string[] = []

interface Captured {
  url: string
  init: RequestInit
  body: any
  raw: string
}

async function makeWorkspace(
  extraLines: string[] = [],
  apiBase = OR_BASE
): Promise<{ dir: string; journalPath: string; credentialsPath: string; receiptsPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "councilrouting-test-"))
  dirsToClean.push(dir)
  const journalPath = path.join(dir, "journal.json")
  await initSession(journalPath, {
    operation: "init_session",
    data: {
      target_version: "0.0.0",
      branch: "test",
      phase: 1,
      units: [],
      env: { agent: "test", worker: "test", claude: null, codex: null, gemini: null },
    },
  })
  const credentialsPath = path.join(dir, "home.env")
  await fs.writeFile(
    credentialsPath,
    [
      `FOREMAN_API_BASE=${apiBase}`,
      `FOREMAN_API_KEY=${KEY}`,
      `FOREMAN_COUNCIL_SEAT_A=${CONFIG_A}`,
      `FOREMAN_COUNCIL_SEAT_B=${CONFIG_B}`,
      ...extraLines,
    ].join("\n") + "\n",
    "utf-8"
  )
  return { dir, journalPath, credentialsPath, receiptsPath: path.join(dir, ".foreman-seats.jsonl") }
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "p1",
    objective: "review the council routing change",
    evidence: "diff --git a/x.ts b/x.ts\n+const a = 1\n",
    lenses: ["contract"],
    ...overrides,
  }
}

function seatReply(marker: string): string {
  return JSON.stringify({
    completion: "complete",
    findings: [{ severity: "high", file: "x.ts", line: "1", description: `defect ${marker}`, confidence: "high" }],
    checked: ["x.ts"],
    limitations: [],
  })
}

function sseBody(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n"
}

function sseReply(content: string, model: string | undefined, provider = "DeepInfra"): Response {
  const frame: Record<string, unknown> = {
    ...(model !== undefined ? { model } : {}),
    provider,
    choices: [{ delta: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  }
  return new Response(sseBody([frame]), { status: 200, headers: { "content-type": "text/event-stream" } })
}

function isCrossExam(body: any): boolean {
  return body?.response_format?.json_schema?.name === "foreman_cross_exam"
}

/** Records every call; `respond` decides the reply. Default: echo the requested model. */
function makeFetch(respond?: (c: Captured, index: number) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const raw = String(init?.body ?? "")
    const c: Captured = { url: String(input), init: init ?? {}, body: JSON.parse(raw), raw }
    calls.push(c)
    if (respond) return respond(c, calls.length - 1)
    if (isCrossExam(c.body)) {
      return sseReply(JSON.stringify({ verdicts: [{ claim_id: "C1", verdict: "stands", reason: "confirmed" }] }), c.body.model)
    }
    return sseReply(seatReply(c.body.model), c.body.model)
  }) as typeof fetch
  return { calls, fetchImpl }
}

function deps(ws: Awaited<ReturnType<typeof makeWorkspace>>, fetchImpl: typeof fetch, receipts = false) {
  return {
    journalPath: ws.journalPath,
    envDir: ws.dir,
    credentialsPath: ws.credentialsPath,
    fetchImpl,
    ...(receipts ? { receiptsPath: ws.receiptsPath } : {}),
  }
}

// Safety net: the real global fetch must never be reached. Every council request goes through
// the injected fetchImpl; a call landing here is a seam leak and fails the test.
let globalFetchUrls: string[] = []
const LANGFUSE_KEYS = [
  "FOREMAN_LANGFUSE_BASE_URL",
  "FOREMAN_LANGFUSE_PUBLIC_KEY",
  "FOREMAN_LANGFUSE_SECRET_KEY",
  "FOREMAN_LANGFUSE_CONTENT",
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  dirsToClean = []
  globalFetchUrls = []
  savedEnv = Object.fromEntries(LANGFUSE_KEYS.map((k) => [k, process.env[k]]))
  for (const k of LANGFUSE_KEYS) delete process.env[k]
  resetCouncilTracerForTest()
  vi.mocked(councilTracer).mockClear()
  resetCouncilEgressNoticeForTest()
  vi.stubGlobal("fetch", async (input: any) => {
    globalFetchUrls.push(String(input))
    throw new TypeError("global fetch is disabled in councilRouting tests")
  })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const k of LANGFUSE_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  resetCouncilTracerForTest()
  for (const dir of dirsToClean) await fs.rm(dir, { recursive: true, force: true })
  resetForTest()
  expect(globalFetchUrls).toEqual([])
})

describe("invoke_council routing — pinned seats with require_zdr", () => {
  it("sends the pinned model and provider.zdr on every request, with redirect=error, and records it", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(
      baseInput({ seat_models: { a: PIN_A, b: PIN_B }, require_zdr: true }),
      deps(ws, fetchImpl, true)
    )

    expect(text).toContain("status: ok")
    expect(calls).toHaveLength(2)
    const models = calls.map((c) => c.body.model).sort()
    expect(models).toEqual([PIN_A, PIN_B].sort())
    for (const c of calls) {
      expect(c.body.provider).toEqual({ require_parameters: true, zdr: true })
      expect(c.body).not.toHaveProperty("models")
      expect(c.body).not.toHaveProperty("route")
      expect(c.init.redirect).toBe("error")
      expect(new URL(c.url).hostname).toBe("openrouter.ai")
      expect(c.raw).not.toContain(KEY)
    }

    expect(text).toContain(ZDR_LINE)
    expect(text).toContain("## Seat routing")
    expect(text).toContain(`${PIN_A} | contract | yes | ${PIN_A} | ${PIN_A} | DeepInfra | enforced | ok`)
    expect(text).toContain(`${PIN_B} | contract | yes | ${PIN_B} | ${PIN_B} | DeepInfra | enforced | ok`)
    expect(text).toContain(`A=${PIN_A} (pinned by call; configured home-env)`)
    expect(text).toContain(`B=${PIN_B} (pinned by call; configured home-env)`)
    // The configured models are never named once a seat is pinned for this call.
    expect(text).not.toContain(CONFIG_A)
    expect(text).not.toContain(CONFIG_B)
    expect(text).toContain(`"advisor":"council:${PIN_A}"`)
    expect(text).not.toContain(KEY)

    const read = await readReceipts(ws.receiptsPath)
    const receipts = [...read.receipts.values()]
    expect(receipts).toHaveLength(2)
    const byReq = new Map(receipts.map((r: any) => [r.model_requested, r]))
    expect(byReq.get(PIN_A)).toMatchObject({ model_requested: PIN_A, model_served: PIN_A })
    expect(byReq.get(PIN_B)).toMatchObject({ model_requested: PIN_B, model_served: PIN_B })
  })

  it("keeps the pinned model and provider.zdr on the reasoning-param downgrade retry", async () => {
    const ws = await makeWorkspace(["FOREMAN_COUNCIL_REASONING_A=xhigh"])
    const { calls, fetchImpl } = makeFetch((c, i) => {
      if (i === 0) {
        return new Response(JSON.stringify({ error: { param: "reasoning", message: "reasoning is not supported" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      return sseReply(seatReply("retry"), c.body.model)
    })
    const text = await handleInvokeCouncil(
      baseInput({ seats: ["a"], seat_models: { a: PIN_A }, require_zdr: true }),
      deps(ws, fetchImpl)
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].body.reasoning).toMatchObject({ effort: "xhigh" })
    expect(calls[1].body.reasoning).toEqual({ exclude: true })
    for (const c of calls) {
      expect(c.body.model).toBe(PIN_A)
      expect(c.body.provider).toEqual({ require_parameters: true, zdr: true })
      expect(c.init.redirect).toBe("error")
    }
    expect(text).toContain("status: ok")
    expect(text).toContain("param_downgrade")
  })

  it("carries pinned models and provider.zdr on cross-examination requests", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(
      baseInput({ seat_models: { a: PIN_A, b: PIN_B }, require_zdr: true, cross_examine: true }),
      deps(ws, fetchImpl)
    )

    const cross = calls.filter((c) => isCrossExam(c.body))
    expect(cross).toHaveLength(2)
    expect(cross.map((c) => c.body.model).sort()).toEqual([PIN_A, PIN_B].sort())
    for (const c of cross) {
      expect(c.body.provider).toEqual({ require_parameters: true, zdr: true })
      expect(c.body).not.toHaveProperty("models")
      expect(c.init.redirect).toBe("error")
    }
    expect(text).toContain("## Cross-examination")
    expect(text).not.toContain("cross_exam_failed")
  })
})

describe("invoke_council routing — served model verification on pinned seats", () => {
  const cases: Array<{ name: string; respond: (c: Captured) => Response; served: string }> = [
    { name: "substituted (SSE)", respond: () => sseReply(seatReply("x"), "deepseek/deepseek-v4-flash"), served: "deepseek/deepseek-v4-flash" },
    { name: "missing (SSE)", respond: () => sseReply(seatReply("x"), undefined), served: "missing" },
    {
      name: "conflicting across SSE frames",
      respond: (c) =>
        new Response(
          sseBody([
            { model: c.body.model, choices: [{ delta: { content: seatReply("x").slice(0, 10) } }] },
            { model: "other/model", choices: [{ delta: { content: seatReply("x").slice(10) }, finish_reason: "stop" }] },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        ),
      served: "conflicting",
    },
    {
      name: "substituted (non-stream JSON)",
      respond: () =>
        new Response(JSON.stringify({ model: "other/model", choices: [{ message: { content: seatReply("x") } }] }), { status: 200 }),
      served: "other/model",
    },
    {
      name: "missing (non-stream JSON)",
      respond: () => new Response(JSON.stringify({ choices: [{ message: { content: seatReply("x") } }] }), { status: 200 }),
      served: "missing",
    },
  ]

  for (const tc of cases) {
    it(`fails the seat when the served model is ${tc.name}`, async () => {
      const ws = await makeWorkspace()
      const { calls, fetchImpl } = makeFetch((c) => tc.respond(c))
      const text = await handleInvokeCouncil(
        baseInput({ seats: ["a"], seat_models: { a: PIN_A }, require_zdr: true }),
        deps(ws, fetchImpl)
      )
      expect(calls).toHaveLength(1)
      expect(text).toContain("status: fail")
      expect(text).not.toContain("status: ok")
      expect(text).toContain("MODEL_SCHEMA_FAIL")
      expect(text).toContain(`model_substituted: requested ${PIN_A} served ${tc.served}`)
      expect(text).not.toContain("record_review")
    })
  }

  it("verifies pinned seats even without require_zdr", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch(() => sseReply(seatReply("x"), "other/model"))
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"], seat_models: { a: PIN_A } }), deps(ws, fetchImpl))
    expect(text).toContain("status: fail")
    expect(text).toContain(`model_substituted: requested ${PIN_A} served other/model`)
  })

  it("discards a cross-exam reply served by a substituted model", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch((c) => {
      if (isCrossExam(c.body)) {
        return sseReply(
          JSON.stringify({ verdicts: [{ claim_id: "C1", verdict: "refuted", reason: "REFUTE-MARKER" }] }),
          "other/model"
        )
      }
      return sseReply(seatReply(c.body.model), c.body.model)
    })
    const text = await handleInvokeCouncil(
      baseInput({ seat_models: { a: PIN_A, b: PIN_B }, require_zdr: true, cross_examine: true }),
      deps(ws, fetchImpl)
    )
    expect(text).toContain("status: ok")
    expect(text).toContain("cross_exam_failed:")
    expect(text).toContain(`model_substituted: requested ${PIN_A} served other/model`)
    expect(text).toContain(`model_substituted: requested ${PIN_B} served other/model`)
    expect(text).not.toContain("REFUTE-MARKER")
    expect(text).not.toContain("contested:")
  })
})

describe("invoke_council routing — fail-closed refusals make zero requests", () => {
  for (const base of ["http://127.0.0.1:9/v1", "https://evil.example/v1", "http://openrouter.ai/api/v1", "https://api.openrouter.ai/v1"]) {
    it(`refuses require_zdr against ${base}`, async () => {
      const ws = await makeWorkspace([], base)
      const { calls, fetchImpl } = makeFetch()
      const text = await handleInvokeCouncil(baseInput({ require_zdr: true }), deps(ws, fetchImpl))
      expect(text).toContain("status: refused")
      expect(text).not.toContain("NOTICE:")
      expect(calls).toHaveLength(0)
    })
  }

  it("refuses a pin naming an unconfigured seat", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seat_models: { c: PIN_A } }), deps(ws, fetchImpl))
    expect(text).toContain("status: refused")
    expect(calls).toHaveLength(0)
  })

  it("refuses a pin naming a seat outside the requested seats", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"], seat_models: { b: PIN_B } }), deps(ws, fetchImpl))
    expect(text).toContain("status: refused")
    expect(calls).toHaveLength(0)
  })

  for (const bad of ["openrouter/auto", "OpenRouter/auto", "no-slash-model", "a/b c", "x".repeat(190) + "/" + "y".repeat(20)]) {
    it(`rejects seat_models value '${bad.slice(0, 30)}'`, async () => {
      const ws = await makeWorkspace()
      const { calls, fetchImpl } = makeFetch()
      const text = await handleInvokeCouncil(baseInput({ seat_models: { a: bad } }), deps(ws, fetchImpl))
      expect(text).toMatch(/status: (error|refused)/)
      expect(text).toContain("seat_models")
      expect(calls).toHaveLength(0)
    })
  }

  it("rejects an unknown seat_models key", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seat_models: { d: PIN_A } }), deps(ws, fetchImpl))
    expect(text).toMatch(/status: (error|refused)/)
    expect(calls).toHaveLength(0)
  })
})

describe("invoke_council routing — redirects under require_zdr", () => {
  it("never follows a redirect: the seat fails and no second request is made", async () => {
    const ws = await makeWorkspace()
    const seenRedirect: Array<RequestRedirect | undefined> = []
    const { calls, fetchImpl } = makeFetch((c) => {
      seenRedirect.push(c.init.redirect)
      if (c.init.redirect !== "error") {
        // A followed redirect would land here; make it obvious.
        return sseReply(seatReply("followed"), c.body.model)
      }
      throw new TypeError("fetch failed: unexpected redirect")
    })
    const text = await handleInvokeCouncil(
      baseInput({ seats: ["a"], seat_models: { a: PIN_A }, require_zdr: true }),
      deps(ws, fetchImpl)
    )
    expect(seenRedirect).toEqual(["error"])
    expect(calls).toHaveLength(1)
    expect(calls.every((c) => new URL(c.url).hostname === "openrouter.ai")).toBe(true)
    expect(text).toContain("status: fail")
    expect(text).toContain("WORKER_UNREACHABLE")
    expect(text).not.toContain("followed")
  })
})

describe("invoke_council routing — unchanged default path", () => {
  it("sends the pre-change body for an unpinned seat without require_zdr", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch((c) => sseReply(seatReply("d"), "deepseek/deepseek-v4-flash-0901", "Fireworks"))
    const input = baseInput({ seats: ["a"] })
    const text = await handleInvokeCouncil(input, deps(ws, fetchImpl, true))

    expect(calls).toHaveLength(1)
    const userPacket = [`REVIEW OBJECTIVE: ${input.objective}`, "", "EVIDENCE:", input.evidence].join("\n")
    const expected = JSON.stringify({
      model: CONFIG_A,
      messages: [
        { role: "system", content: buildSeatPrompt(LENS_CATALOG.contract) },
        { role: "user", content: userPacket },
      ],
      stream: true,
      response_format: {
        type: "json_schema",
        json_schema: { name: "foreman_review", strict: true, schema: SEAT_RESPONSE_SCHEMA },
      },
      provider: { require_parameters: true },
      reasoning: { exclude: true },
    })
    expect(calls[0].raw).toBe(expected)
    expect(calls[0].init.redirect).toBeUndefined()

    // Unpinned seat: a different served id is recorded, never a failure.
    expect(text).toContain("status: ok")
    expect(text).toContain("routing: default")
    expect(text).not.toContain("zdr=required")
    expect(text).toContain("## Seat routing")
    expect(text).toContain(`${CONFIG_A} | contract | no | ${CONFIG_A} | deepseek/deepseek-v4-flash-0901 | Fireworks | not requested | ok`)

    const receipt = [...(await readReceipts(ws.receiptsPath)).receipts.values()][0] as any
    expect(receipt).toMatchObject({ model_requested: CONFIG_A, model_served: "deepseek/deepseek-v4-flash-0901" })
  })

  it("falls back to the configured model in the receipt when an unpinned seat reports none", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch(() => sseReply(seatReply("d"), undefined))
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"] }), deps(ws, fetchImpl, true))
    expect(text).toContain("status: ok")
    expect(text).toContain(`${CONFIG_A} | contract | no | ${CONFIG_A} | missing |`)
    const receipt = [...(await readReceipts(ws.receiptsPath)).receipts.values()][0] as any
    expect(receipt).toMatchObject({ model_requested: CONFIG_A, model_served: CONFIG_A })
  })
})

describe("parseSseChat — served model evidence", () => {
  it("captures the first non-empty model and the provider", () => {
    const parsed = parseSseChat(
      sseBody([
        { model: "", choices: [{ delta: { content: "a" } }] },
        { model: "x/y", provider: "Groq", choices: [{ delta: { content: "b" } }] },
        { model: "x/y", choices: [{ delta: { content: "c" } }] },
      ])
    )
    expect(parsed.content).toBe("abc")
    expect(parsed.model).toBe("x/y")
    expect(parsed.servedProvider).toBe("Groq")
    expect(parsed.modelConflict).toBeFalsy()
  })

  it("flags a later frame naming a different model", () => {
    const parsed = parseSseChat(
      sseBody([
        { model: "x/y", choices: [{ delta: { content: "a" } }] },
        { model: "x/z", choices: [{ delta: { content: "b" } }] },
      ])
    )
    expect(parsed.model).toBe("x/y")
    expect(parsed.modelConflict).toBe(true)
  })

  it("leaves model undefined when no frame names one", () => {
    const parsed = parseSseChat(sseBody([{ choices: [{ delta: { content: "a" } }] }]))
    expect(parsed.model).toBeUndefined()
    expect(parsed.modelConflict).toBeFalsy()
  })
})

// ─── Review corrections ─────────────────────────────────────────────────────────

describe("invoke_council routing — Langfuse tracer under require_zdr", () => {
  function setLangfuseEnv(): void {
    process.env.FOREMAN_LANGFUSE_BASE_URL = "https://langfuse.example"
    process.env.FOREMAN_LANGFUSE_PUBLIC_KEY = "pk-lf-synthetic-0001"
    process.env.FOREMAN_LANGFUSE_SECRET_KEY = "sk-lf-synthetic-0001"
    process.env.FOREMAN_LANGFUSE_CONTENT = "1"
  }

  it("never creates the tracer and never posts to Langfuse when require_zdr is set", async () => {
    setLangfuseEnv()
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(
      baseInput({ seats: ["a"], seat_models: { a: PIN_A }, require_zdr: true }),
      deps(ws, fetchImpl)
    )
    expect(text).toContain("status: ok")
    expect(calls).toHaveLength(1)
    expect(vi.mocked(councilTracer)).not.toHaveBeenCalled()
    expect(globalFetchUrls).toEqual([])
  })

  it("control: the same env without require_zdr does attempt Langfuse ingestion", async () => {
    setLangfuseEnv()
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"] }), deps(ws, fetchImpl))
    expect(text).toContain("status: ok")
    expect(vi.mocked(councilTracer)).toHaveBeenCalled()
    expect(globalFetchUrls.length).toBeGreaterThan(0)
    expect(globalFetchUrls.every((u) => new URL(u).hostname === "langfuse.example")).toBe(true)
    globalFetchUrls = [] // expected here; the afterEach guard covers every other test
  })
})

describe("invoke_council routing — pin variants are refused", () => {
  for (const suffix of [":online", ":nitro", ":floor", ":free", ":beta", ":"]) {
    it(`refuses a pin with the '${suffix}' suffix`, async () => {
      const ws = await makeWorkspace()
      const { calls, fetchImpl } = makeFetch()
      const text = await handleInvokeCouncil(baseInput({ seat_models: { a: `${PIN_A}${suffix}` } }), deps(ws, fetchImpl))
      expect(text).toMatch(/status: (error|refused)/)
      expect(text).toContain("seat_models")
      expect(calls).toHaveLength(0)
    })
  }
})

describe("invoke_council routing — near-miss substitutions", () => {
  const PIN = "z-ai/glm-5.3"
  for (const served of ["Z-AI/GLM-5.3", "z-ai/glm-5.3-0901", "z-ai/glm-5"]) {
    it(`fails a pin of ${PIN} served as ${served}`, async () => {
      const ws = await makeWorkspace()
      const { fetchImpl } = makeFetch(() => sseReply(seatReply("x"), served))
      const text = await handleInvokeCouncil(baseInput({ seats: ["a"], seat_models: { a: PIN } }), deps(ws, fetchImpl))
      expect(text).toContain("status: fail")
      expect(text).toContain(`model_substituted: requested ${PIN} served ${served}`)
    })
  }

  it("discards a cross-exam reply that names no model", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch((c) => {
      if (isCrossExam(c.body)) {
        return sseReply(JSON.stringify({ verdicts: [{ claim_id: "C1", verdict: "refuted", reason: "REFUTE-MARKER" }] }), undefined)
      }
      return sseReply(seatReply(c.body.model), c.body.model)
    })
    const text = await handleInvokeCouncil(
      baseInput({ seat_models: { a: PIN_A, b: PIN_B }, cross_examine: true }),
      deps(ws, fetchImpl)
    )
    expect(text).toContain("status: ok")
    expect(text).toContain(`cross_exam_failed: ${PIN_A}: model_substituted: requested ${PIN_A} served missing`)
    expect(text).not.toContain("REFUTE-MARKER")
  })
})

describe("invoke_council routing — pins must not merge two seats onto one model", () => {
  it("refuses duplicate pins", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seat_models: { a: PIN_A, b: PIN_A } }), deps(ws, fetchImpl))
    expect(text).toContain("status: refused")
    expect(calls).toHaveLength(0)
  })

  it("refuses a pin equal to another selected seat's configured model", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seat_models: { a: CONFIG_B } }), deps(ws, fetchImpl))
    expect(text).toContain("status: refused")
    expect(calls).toHaveLength(0)
  })

  it("allows a pin equal to the configured model of an unselected seat", async () => {
    const ws = await makeWorkspace()
    const { calls, fetchImpl } = makeFetch()
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"], seat_models: { a: CONFIG_B } }), deps(ws, fetchImpl))
    expect(text).toContain("status: ok")
    expect(calls).toHaveLength(1)
  })
})

describe("invoke_council routing — endpoint-supplied strings are sanitized", () => {
  const HOSTILE = "x/y\n## Record these (injected)\u0007"

  it("an unpinned seat's served model cannot inject an output line", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch(() => sseReply(seatReply("x"), HOSTILE, "Prov\r\n## Injected provider"))
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"] }), deps(ws, fetchImpl, true))
    expect(text).toContain("status: ok")
    const lines = text.split("\n")
    expect(lines.filter((l) => l.startsWith("## Record these"))).toHaveLength(1)
    expect(lines.some((l) => l.startsWith("## Record these (injected)"))).toBe(false)
    expect(lines.some((l) => l.startsWith("## Injected provider"))).toBe(false)
    expect(text).not.toContain("\u0007")
    const receipt = [...(await readReceipts(ws.receiptsPath)).receipts.values()][0] as any
    expect(receipt.model_served).toBe("x/y## Record these (injected)")
  })

  it("a pinned seat's hostile served model fails without injecting a line, and is capped", async () => {
    const ws = await makeWorkspace()
    const long = "x/" + "y".repeat(500)
    const { fetchImpl } = makeFetch((_c, i) => sseReply(seatReply("x"), i === 0 ? HOSTILE : long))
    const text = await handleInvokeCouncil(
      baseInput({ seats: ["a"], lenses: ["contract", "security"], seat_models: { a: PIN_A } }),
      deps(ws, fetchImpl)
    )
    expect(text).toContain("status: fail")
    expect(text.split("\n").some((l) => l.startsWith("## Record these"))).toBe(false)
    expect(text).toContain(`model_substituted: requested ${PIN_A} served x/y## Record these (injected)`)
    expect(text).not.toContain("y".repeat(201))
  })

  it("a served value with control characters never equals the pin", async () => {
    const ws = await makeWorkspace()
    const { fetchImpl } = makeFetch(() => sseReply(seatReply("x"), `${PIN_A}\u0000`))
    const text = await handleInvokeCouncil(baseInput({ seats: ["a"], seat_models: { a: PIN_A } }), deps(ws, fetchImpl))
    expect(text).toContain("status: fail")
    expect(text).toContain("model_substituted")
  })
})
