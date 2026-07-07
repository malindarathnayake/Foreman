import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import http from "http"
import { createHash } from "crypto"
import {
  handleInvokeWorker,
  buildSystemPrompt,
  resetEgressNoticeForTest,
  PLAYBOOK,
} from "../src/tools/invokeWorker.js"
import { PATCH_BEGIN, PATCH_END } from "../src/lib/workerResponse.js"
import { writeLedger } from "../src/lib/ledger.js"
import { readEvents } from "../src/lib/eventsSidecar.js"
import { initSession } from "../src/lib/journal.js"
import { resetForTest } from "../src/lib/redaction.js"

// ── Obviously-fake, low-entropy fixture key (gitleaks-safe). Doubles as the API key. ──
const FIXTURE_KEY_NAME = "INVOKE_4F_FIXTURE_KEY"
const FIXTURE_KEY_VALUE = "fixture_key_4f000001"

// ── Fixtures ──────────────────────────────────────────────────────────────────────
const UNIFIED_DIFF_BODY = [
  "--- a/src.txt",
  "+++ b/src.txt",
  "@@ -1,2 +1,3 @@",
  " line1",
  "+line2",
  " line3",
].join("\n")

const METADATA_SUCCESS = '{"report":"success","files":["src.txt"],"confidence":0.7}'

// A well-formed, NON-protected diff that targets a file NOT in the delegated files[]
// (files[] carries only <tmp>/src.txt). The parser classifies it OK; the listed-files
// gate in invoke_worker is what must reject it. [CWE-73]
const OUT_OF_SCOPE_DIFF = [
  "--- a/other.txt",
  "+++ b/other.txt",
  "@@ -1,2 +1,3 @@",
  " line1",
  "+line2",
  " line3",
].join("\n")

function sha256hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

function wrapPatch(body: string): string {
  return `${PATCH_BEGIN}\n${body}\n${PATCH_END}`
}

function workerText(metadata: string, patchBody?: string): string {
  return patchBody !== undefined ? `${metadata}\n${wrapPatch(patchBody)}` : metadata
}

function successResponse(res: http.ServerResponse, content: string, finish = "stop"): void {
  const payload = JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  })
  res.writeHead(200, { "content-type": "application/json" })
  res.end(payload)
}

function errorResponse(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(obj))
}

function extractReturnedPatch(text: string): string {
  const lines = text.split("\n")
  const b = lines.indexOf(PATCH_BEGIN)
  const e = lines.indexOf(PATCH_END, b + 1)
  if (b === -1 || e === -1) return "<no patch block>"
  return lines.slice(b + 1, e).join("\n")
}

// ── Mock endpoint (records requests; headers snapshot excludes the auth VALUE) ──────
interface RecordedRequest {
  body: any
  rawBody: string
  authorization: string | undefined
  headers: Record<string, unknown>
}
interface Mock {
  port: number
  requests: RecordedRequest[]
  close: () => Promise<void>
}

type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse, idx: number) => void

let serversToClose: Mock[] = []
let dirsToClean: string[] = []

async function startMock(handler: MockHandler): Promise<Mock> {
  const requests: RecordedRequest[] = []
  const sockets = new Set<import("net").Socket>()
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf-8")
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const idx = requests.length
      let body: any
      try {
        body = JSON.parse(raw)
      } catch {
        body = undefined
      }
      const headers: Record<string, unknown> = { ...req.headers }
      delete headers["authorization"] // recorder keeps headers MINUS the auth value
      requests.push({ body, rawBody: raw, authorization: req.headers["authorization"], headers })
      handler(req, res, idx)
    })
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as import("net").AddressInfo).port
  const mock: Mock = {
    port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  serversToClose.push(mock)
  return mock
}

async function deadPort(): Promise<number> {
  const srv = http.createServer()
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
  const p = (srv.address() as import("net").AddressInfo).port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return p
}

// ── Per-test workspace ──────────────────────────────────────────────────────────────
interface Workspace {
  dir: string
  ledgerPath: string
  journalPath: string
  sidecarPath: string
  sourceFile: string
  deps: { docsDir: string; ledgerPath: string; journalPath: string; envDir: string }
}

function envContent(port: number, opts: { reasoning?: boolean } = {}): string {
  return [
    "schema_version=1",
    `FOREMAN_API_BASE=http://127.0.0.1:${port}/v1`,
    // Double-quoted (not a template literal) so ${ENV:...} stays literal.
    "FOREMAN_API_KEY=${ENV:INVOKE_4F_FIXTURE_KEY}",
    "FOREMAN_TIER_STANDARD=test/model-standard",
    "FOREMAN_WORKER_CLASS_STANDARD=capable",
    "FOREMAN_EDIT_FORMAT_STANDARD=unified_diff",
    ...(opts.reasoning ? ["FOREMAN_REASONING_EFFORT_STANDARD=high"] : []),
    "",
  ].join("\n")
}

async function makeWorkspace(opts: { port?: number; writeEnv?: boolean; seedDelegation?: boolean; reasoning?: boolean } = {}): Promise<Workspace> {
  const {
    port = 1, // unused unless a mock is wired
    writeEnv = true,
    seedDelegation = true,
    reasoning = false,
  } = opts
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "invoke-4f-test-"))
  dirsToClean.push(dir)
  const ledgerPath = path.join(dir, "ledger.json")
  const journalPath = path.join(dir, "journal.json")
  const sidecarPath = path.join(dir, ".foreman-events.jsonl")
  const sourceFile = path.join(dir, "src.txt")

  await fs.writeFile(sourceFile, "line1\nline3\n", "utf-8")
  if (writeEnv) {
    await fs.writeFile(path.join(dir, ".foremanenv"), envContent(port, { reasoning }), "utf-8")
  }
  if (seedDelegation) {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "4f",
      unit_id: "u1",
      data: { s: "delegated", brief: "seed brief for delegated unit ok", tier: "standard" },
    })
  }
  return {
    dir,
    ledgerPath,
    journalPath,
    sidecarPath,
    sourceFile,
    deps: { docsDir: dir, ledgerPath, journalPath, envDir: dir },
  }
}

function baseInput(ws: Workspace, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "4f",
    unit_id: "u1",
    brief: "implement the change described in the brief summary",
    tier: "standard",
    files: [ws.sourceFile],
    ...overrides,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ── Setup / teardown ────────────────────────────────────────────────────────────────
beforeEach(() => {
  serversToClose = []
  dirsToClean = []
  process.env[FIXTURE_KEY_NAME] = FIXTURE_KEY_VALUE
  resetForTest() // re-harvest with the fixture key present
  resetEgressNoticeForTest()
})

afterEach(async () => {
  for (const s of serversToClose) await s.close()
  for (const d of dirsToClean) await fs.rm(d, { recursive: true, force: true })
  delete process.env[FIXTURE_KEY_NAME]
  delete process.env.FOREMAN_BRIEF_MAX_BYTES
  delete process.env.FOREMAN_WORKER_RESPONSE_MAX_BYTES
  delete process.env.FOREMAN_WORKER_CONNECT_TIMEOUT_MS
  delete process.env.FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS
  resetForTest()
  resetEgressNoticeForTest()
})

// ── 1. Success (unified_diff) ────────────────────────────────────────────────────────
describe("invoke_worker — success", () => {
  it("returns status ok, verbatim patch, correct sha, and a 3-event NO-outcome chain", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("status: ok")
    expect(text).toContain("tokens_in: 10")
    expect(text).toContain("tokens_out: 20")
    expect(text).toContain("finish_reason_class: stop")
    expect(text).toContain("edit_format: unified_diff")
    expect(text).toContain("capability_class: capable")

    // Patch is byte-verbatim between the exact sentinels.
    expect(extractReturnedPatch(text)).toBe(UNIFIED_DIFF_BODY)
    const expectedSha = sha256hex(UNIFIED_DIFF_BODY)
    expect(text).toContain(`patch_sha256: ${expectedSha}`)

    const { events, warning } = await readEvents(ws.sidecarPath)
    expect(warning).toBeUndefined()
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed", "patch_checked"])
    expect(events.every((e) => e.outcome === undefined)).toBe(true)
    // Chain links (readEvents already throws on any break).
    expect(events[1].prev_event_hash).toBe(events[0].event_hash)
    expect(events[2].prev_event_hash).toBe(events[1].event_hash)
    // patch_checked carries the patch digest + diff bytes.
    expect(events[2].patch_sha256).toBe(expectedSha)
    expect(events[2].diff_bytes).toBe(Buffer.byteLength(UNIFIED_DIFF_BODY))
    // worker_completed carries tokens + finish reason.
    expect(events[1].tokens).toEqual({ in: 10, out: 20 })
    expect(events[1].finish_reason_class).toBe("stop")
  })
})

// ── 2. Egress notice ──────────────────────────────────────────────────────────────────
describe("invoke_worker — egress notice", () => {
  it("prepends NOTICE on the first call only and journals EGRESS_NOTICE once", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    await initSession(ws.journalPath, {
      operation: "init_session",
      data: {
        target_version: "0.5.0",
        branch: "test",
        phase: 1,
        units: ["u1"],
        env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
      },
    })

    const first = await handleInvokeWorker(baseInput(ws), ws.deps)
    const second = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(first.startsWith("NOTICE: briefs and file excerpts leave this machine")).toBe(true)
    expect(second.startsWith("NOTICE:")).toBe(false)
    expect(second.startsWith("status: ok")).toBe(true)

    const journalRaw = await fs.readFile(ws.journalPath, "utf-8")
    const count = journalRaw.split("EGRESS_NOTICE").length - 1
    expect(count).toBe(1)
  })
})

// ── 3. No .foremanenv ─────────────────────────────────────────────────────────────────
describe("invoke_worker — missing config", () => {
  it("returns config_error, creates no sidecar, and never contacts the endpoint", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port, writeEnv: false })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("status: config_error")
    expect(text).toContain(".foremanenv not found")
    expect(text).toContain("schema_version=1")
    expect(await fileExists(ws.sidecarPath)).toBe(false)
    expect(mock.requests.length).toBe(0)
  })
})

// ── 4. Unknown tier ───────────────────────────────────────────────────────────────────
describe("invoke_worker — unknown tier", () => {
  it("names the exact line to add and which tiers ARE configured", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws, { tier: "premium" }), ws.deps)

    expect(text).toContain("status: config_error")
    expect(text).toContain("FOREMAN_TIER_PREMIUM=<model-id>")
    expect(text).toContain("Configured tiers: standard")
    expect(mock.requests.length).toBe(0)
  })
})

// ── 5. No ledger delegation ───────────────────────────────────────────────────────────
describe("invoke_worker — no recorded delegation", () => {
  it("returns a corrected-call error and writes no events", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port, seedDelegation: false })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("set_unit_status")
    expect(text).toContain("'delegated'")
    expect(await fileExists(ws.sidecarPath)).toBe(false)
    expect(mock.requests.length).toBe(0)
  })
})

// ── 6. Outbound secret gate ───────────────────────────────────────────────────────────
describe("invoke_worker — secret block", () => {
  it("blocks the payload, names the env var (never the value), and makes no request", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(
      baseInput(ws, { brief: `use this token ${FIXTURE_KEY_VALUE} to authenticate the call` }),
      ws.deps
    )

    expect(text).toContain("failure_stage: WORKER_PAYLOAD_SECRET_BLOCK")
    expect(text).toContain("refunded: true")
    expect(text).toContain(FIXTURE_KEY_NAME)
    expect(text).not.toContain(FIXTURE_KEY_VALUE)
    expect(mock.requests.length).toBe(0)

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed"])
    expect(events[1].failure_stage).toBe("WORKER_PAYLOAD_SECRET_BLOCK")
    expect(events[1].outcome).toBe("fail")
  })
})

// ── 7. Pre-send BRIEF_TOO_LARGE ───────────────────────────────────────────────────────
describe("invoke_worker — pre-send brief cap", () => {
  it("refuses an oversize brief without contacting the endpoint", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    process.env.FOREMAN_BRIEF_MAX_BYTES = "10"

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: BRIEF_TOO_LARGE")
    expect(text).toContain("refunded: true")
    expect(mock.requests.length).toBe(0)

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed"])
    expect(events[1].failure_stage).toBe("BRIEF_TOO_LARGE")
    expect(events[1].outcome).toBe("fail")
  })
})

// ── 8. Provider BRIEF_TOO_LARGE (400 context_length_exceeded) ─────────────────────────
describe("invoke_worker — provider brief-too-large", () => {
  it("maps a context_length_exceeded 400 to BRIEF_TOO_LARGE, refunded", async () => {
    const mock = await startMock((_req, res) => errorResponse(res, 400, { error: { code: "context_length_exceeded" } }))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: BRIEF_TOO_LARGE")
    expect(text).toContain("refunded: true")
    expect(mock.requests.length).toBe(1)
  })
})

// ── 9. WORKER_UNREACHABLE (closed port) ──────────────────────────────────────────────
describe("invoke_worker — unreachable", () => {
  it("maps a connection refusal to WORKER_UNREACHABLE, refunded", async () => {
    const port = await deadPort()
    const ws = await makeWorkspace({ port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_UNREACHABLE")
    expect(text).toContain("refunded: true")

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed"])
    expect(events[1].failure_stage).toBe("WORKER_UNREACHABLE")
  })
})

// ── 10. Connect timeout ───────────────────────────────────────────────────────────────
describe("invoke_worker — connect timeout", () => {
  it("aborts to WORKER_UNREACHABLE when headers never arrive", async () => {
    // Accepts the request but NEVER writes a response → no headers ever arrive.
    const mock = await startMock(() => {
      /* intentionally silent */
    })
    const ws = await makeWorkspace({ port: mock.port })
    process.env.FOREMAN_WORKER_CONNECT_TIMEOUT_MS = "200"

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_UNREACHABLE")
    expect(text).toContain("refunded: true")
  })
})

// ── 11. Activity timeout ──────────────────────────────────────────────────────────────
describe("invoke_worker — activity timeout", () => {
  it("aborts to WORKER_TIMEOUT when the stream stalls mid-body", async () => {
    const mock = await startMock((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"partial":"data"') // one chunk, then stall forever
    })
    const ws = await makeWorkspace({ port: mock.port })
    process.env.FOREMAN_WORKER_ACTIVITY_TIMEOUT_MS = "200"

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_TIMEOUT")
    expect(text).toContain("refunded: true")
  })
})

// ── 12. Status mapping: 401 / 429 / 404 ──────────────────────────────────────────────
describe("invoke_worker — status mapping", () => {
  const cases: Array<{ status: number; stage: string }> = [
    { status: 401, stage: "WORKER_AUTH_FAIL" },
    { status: 429, stage: "WORKER_QUOTA_FAIL" },
    { status: 404, stage: "WORKER_MODEL_NOT_FOUND" },
  ]
  for (const { status, stage } of cases) {
    it(`HTTP ${status} → ${stage}, refunded, terminal chain`, async () => {
      const mock = await startMock((_req, res) => errorResponse(res, status, { error: { message: "nope" } }))
      const ws = await makeWorkspace({ port: mock.port })

      const text = await handleInvokeWorker(baseInput(ws), ws.deps)

      expect(text).toContain(`failure_stage: ${stage}`)
      expect(text).toContain("refunded: true")

      const { events } = await readEvents(ws.sidecarPath)
      expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed"])
      expect(events[1].failure_stage).toBe(stage)
      expect(events[1].outcome).toBe("fail")
    })
  }
})

// ── 13. WORKER_RESPONSE_TOO_LARGE ─────────────────────────────────────────────────────
describe("invoke_worker — response too large", () => {
  it("discards an oversize response, NOT refunded (model output discipline)", async () => {
    const big = "x".repeat(5000)
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, big)))
    const ws = await makeWorkspace({ port: mock.port })
    process.env.FOREMAN_WORKER_RESPONSE_MAX_BYTES = "50"

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_RESPONSE_TOO_LARGE")
    expect(text).toContain("refunded: false")

    const { events } = await readEvents(ws.sidecarPath)
    expect(events[events.length - 1].failure_stage).toBe("WORKER_RESPONSE_TOO_LARGE")
  })
})

// ── 14. Param downgrade (once) ────────────────────────────────────────────────────────
describe("invoke_worker — reasoning_effort downgrade", () => {
  it("retries once without the param and records the downgrade", async () => {
    const mock = await startMock((_req, res, idx) => {
      if (idx === 0) {
        errorResponse(res, 400, { error: { param: "reasoning_effort", message: "unknown parameter" } })
      } else {
        successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY))
      }
    })
    const ws = await makeWorkspace({ port: mock.port, reasoning: true })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("status: ok")
    expect(text).toContain('param_downgrade: {field:"reasoning_effort", from:"high"')
    expect(text).toContain("endpoint rejected the parameter (HTTP 400)")

    expect(mock.requests.length).toBe(2)
    expect(mock.requests[0].body.reasoning_effort).toBe("high")
    expect(mock.requests[1].body.reasoning_effort).toBeUndefined()
  })
})

// ── 15. Never proactive ───────────────────────────────────────────────────────────────
describe("invoke_worker — no proactive downgrade", () => {
  it("does not retry a generic 400 when no reasoning_effort was configured", async () => {
    const mock = await startMock((_req, res) => errorResponse(res, 400, { error: { message: "bad request" } }))
    const ws = await makeWorkspace({ port: mock.port }) // no reasoning configured

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_UNREACHABLE")
    expect(mock.requests.length).toBe(1)
  })
})

// ── 16. WORKER_GHOST / MODEL_SCHEMA_FAIL / honest failure ────────────────────────────
describe("invoke_worker — model-discipline failures", () => {
  it("metadata success but no patch → WORKER_GHOST, not refunded, terminal worker_completed", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_GHOST")
    expect(text).toContain("refunded: false")

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed"])
    expect(events[1].failure_stage).toBe("WORKER_GHOST")
    expect(events[1].outcome).toBe("fail")
  })

  it("no JSON metadata → MODEL_SCHEMA_FAIL, not refunded", async () => {
    const mock = await startMock((_req, res) => successResponse(res, "no structured metadata here at all"))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: MODEL_SCHEMA_FAIL")
    expect(text).toContain("refunded: false")

    const { events } = await readEvents(ws.sidecarPath)
    expect(events[events.length - 1].failure_stage).toBe("MODEL_SCHEMA_FAIL")
    expect(events[events.length - 1].outcome).toBe("fail")
  })

  it("honest no-patch failure → WORKER_GHOST staging with the report echoed in detail", async () => {
    const content = workerText('{"report":"failed: could not do it","files":[]}')
    const mock = await startMock((_req, res) => successResponse(res, content))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: WORKER_GHOST")
    expect(text).toContain("refunded: false")
    expect(text).toContain("worker reported failure: failed: could not do it")
  })
})

// ── 17. Patch-shape failures ──────────────────────────────────────────────────────────
describe("invoke_worker — patch-shape failures", () => {
  const REDACTION_BODY = [
    "--- a/src.txt",
    "+++ b/src.txt",
    "@@ -1,2 +1,3 @@",
    " line1",
    "+[REDACTED:env:FOO]",
    " line3",
  ].join("\n")
  const PROTECTED_BODY = ["--- a/.git/config", "+++ b/.git/config", "@@ -1,1 +1,2 @@", " x", "+y"].join("\n")

  const cases: Array<{ name: string; body: string; stage: string }> = [
    { name: "PATCH_PARSE_FAIL", body: "this is not a diff at all", stage: "PATCH_PARSE_FAIL" },
    { name: "PATCH_REDACTION_MARKER_FAIL", body: REDACTION_BODY, stage: "PATCH_REDACTION_MARKER_FAIL" },
    { name: "PATCH_PROTECTED_PATH_FAIL", body: PROTECTED_BODY, stage: "PATCH_PROTECTED_PATH_FAIL" },
  ]

  for (const { name, body, stage } of cases) {
    it(`${name}: worker_completed (no outcome) → TERMINAL patch_checked (outcome fail)`, async () => {
      const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, body)))
      const ws = await makeWorkspace({ port: mock.port })

      const text = await handleInvokeWorker(baseInput(ws), ws.deps)

      expect(text).toContain(`failure_stage: ${stage}`)
      expect(text).toContain("refunded: false")

      const { events } = await readEvents(ws.sidecarPath)
      expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed", "patch_checked"])
      expect(events[1].outcome).toBeUndefined()
      expect(events[2].event_type).toBe("patch_checked")
      expect(events[2].outcome).toBe("fail")
      expect(events[2].failure_stage).toBe(stage)
    })
  }
})

// ── 18. Key hygiene ──────────────────────────────────────────────────────────────────
describe("invoke_worker — key hygiene", () => {
  it("success: key value never appears in return/sidecar/journal; endpoint got the Bearer header", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    await initSession(ws.journalPath, {
      operation: "init_session",
      data: {
        target_version: "0.5.0",
        branch: "test",
        phase: 1,
        units: ["u1"],
        env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
      },
    })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)
    expect(text).toContain("status: ok")
    expect(text).not.toContain(FIXTURE_KEY_VALUE)

    const sidecarRaw = await fs.readFile(ws.sidecarPath, "utf-8")
    expect(sidecarRaw).not.toContain(FIXTURE_KEY_VALUE)
    const journalRaw = await fs.readFile(ws.journalPath, "utf-8")
    expect(journalRaw).not.toContain(FIXTURE_KEY_VALUE)

    // The one legitimate egress: the Authorization header carried the key.
    expect(mock.requests[0].authorization).toBe(`Bearer ${FIXTURE_KEY_VALUE}`)
    // And no request BODY ever carried it.
    expect(mock.requests[0].rawBody).not.toContain(FIXTURE_KEY_VALUE)
  })

  it("failure (401): key value never appears in return/sidecar; endpoint still got the Bearer header", async () => {
    const mock = await startMock((_req, res) => errorResponse(res, 401, { error: { message: "unauthorized" } }))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)
    expect(text).toContain("failure_stage: WORKER_AUTH_FAIL")
    expect(text).not.toContain(FIXTURE_KEY_VALUE)

    const sidecarRaw = await fs.readFile(ws.sidecarPath, "utf-8")
    expect(sidecarRaw).not.toContain(FIXTURE_KEY_VALUE)
    expect(mock.requests[0].authorization).toBe(`Bearer ${FIXTURE_KEY_VALUE}`)
  })
})

// ── 19. buildSystemPrompt byte-stability + prompt_prefix_hash ─────────────────────────
describe("buildSystemPrompt", () => {
  it("is byte-stable and differs across edit formats", () => {
    expect(buildSystemPrompt("unified_diff")).toBe(buildSystemPrompt("unified_diff"))
    expect(buildSystemPrompt("unified_diff")).not.toBe(buildSystemPrompt("search_replace"))
    expect(buildSystemPrompt("search_replace")).not.toBe(buildSystemPrompt("whole_file"))
    expect(buildSystemPrompt("unified_diff")).not.toBe(buildSystemPrompt("whole_file"))
  })

  it("prompt_prefix_hash in events equals sha256 of the built prompt", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)

    const { events } = await readEvents(ws.sidecarPath)
    expect(events[0].prompt_prefix_hash).toBe(sha256hex(buildSystemPrompt("unified_diff")))
  })
})

// ── 20. PLAYBOOK completeness ─────────────────────────────────────────────────────────
describe("PLAYBOOK", () => {
  const ALL_STAGES = [
    "BRIEF_TOO_LARGE",
    "WORKER_PAYLOAD_SECRET_BLOCK",
    "WORKER_UNREACHABLE",
    "WORKER_TIMEOUT",
    "WORKER_AUTH_FAIL",
    "WORKER_QUOTA_FAIL",
    "WORKER_MODEL_NOT_FOUND",
    "WORKER_RESPONSE_TOO_LARGE",
    "WORKER_GHOST",
    "MODEL_SCHEMA_FAIL",
    "PATCH_PARSE_FAIL",
    "PATCH_REDACTION_MARKER_FAIL",
    "PATCH_PROTECTED_PATH_FAIL",
    "ED_STALE",
    "PATCH_APPLY_FAIL",
    "BLD_ERR",
    "W_REJ",
  ] as const

  it("has a non-empty hint for every one of the 17 stages", () => {
    expect(Object.keys(PLAYBOOK).length).toBe(17)
    for (const stage of ALL_STAGES) {
      expect(typeof PLAYBOOK[stage]).toBe("string")
      expect(PLAYBOOK[stage].length).toBeGreaterThan(0)
    }
  })
})

// ── 21. Listed-files enforcement [CWE-73] ─────────────────────────────────────────────
describe("invoke_worker — patch scoped to delegated files", () => {
  it("an OK patch targeting a file NOT in files[] → PATCH_PROTECTED_PATH_FAIL, terminal, not refunded", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, OUT_OF_SCOPE_DIFF)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("failure_stage: PATCH_PROTECTED_PATH_FAIL")
    expect(text).toContain("refunded: false")
    expect(text).toContain('target path "other.txt" is not in the delegated files list')

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual(["delegation_started", "worker_completed", "patch_checked"])
    expect(events[1].outcome).toBeUndefined()
    expect(events[2].event_type).toBe("patch_checked")
    expect(events[2].failure_stage).toBe("PATCH_PROTECTED_PATH_FAIL")
    expect(events[2].outcome).toBe("fail")
  })

  it("a patch targeting the LISTED file (relative echo of the absolute listed path) is accepted", async () => {
    // Positive control for the suffix rule: files[]=[<tmp>/src.txt], patch targets src.txt.
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    const text = await handleInvokeWorker(baseInput(ws), ws.deps)

    expect(text).toContain("status: ok")
    expect(text).not.toContain("PATCH_PROTECTED_PATH_FAIL")
  })
})

// ── 22. Long unit_id keeps the audit chain alive [CWE-20] ─────────────────────────────
describe("invoke_worker — identifier bounding", () => {
  it("a >64-char unit_id still succeeds and writes digest-bounded events (no sidecar_warning)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    const longUnitId = "u_" + "z".repeat(80) // 82 chars > 64-char cap

    // The ledger stores the RAW id; seed the delegation under the long id so invoke_worker
    // (which reads the ledger by raw phase/unit_id) finds it.
    await writeLedger(ws.ledgerPath, {
      operation: "set_unit_status",
      phase: "4f",
      unit_id: longUnitId,
      data: { s: "delegated", brief: "seed brief for delegated unit ok", tier: "standard" },
    })

    const text = await handleInvokeWorker(baseInput(ws, { unit_id: longUnitId }), ws.deps)

    expect(text).toContain("status: ok")
    expect(text).not.toContain("sidecar_warning")

    const { events, warning } = await readEvents(ws.sidecarPath)
    expect(warning).toBeUndefined()
    expect(events).toHaveLength(3)
    // The envelope carries the bounded digest, never the raw 82-char id.
    expect(events[0].unit_id).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(events[0].unit_id.length).toBeLessThanOrEqual(64)
  })
})

// ── 23. Sidecar co-locates with the ledger, not docsDir [CWE-706] ─────────────────────
describe("invoke_worker — sidecar path unification", () => {
  it("split config: events land next to the LEDGER even when docsDir differs", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    // Point docsDir at a DIFFERENT directory than the ledger's dir.
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "invoke-4f-docs-"))
    dirsToClean.push(otherDir)
    const splitDeps = { ...ws.deps, docsDir: otherDir }

    const text = await handleInvokeWorker(baseInput(ws), splitDeps)
    expect(text).toContain("status: ok")

    // Sidecar co-locates with the ledger (ws.sidecarPath = dirname(ledger)/.foreman-events.jsonl).
    const { events } = await readEvents(ws.sidecarPath)
    expect(events).toHaveLength(3)
    // And nothing was written under docsDir.
    expect(await fileExists(path.join(otherDir, ".foreman-events.jsonl"))).toBe(false)
  })
})
