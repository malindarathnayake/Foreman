import { vi } from "vitest"
vi.mock("../src/tools/runTests.js", () => ({ runTests: vi.fn() }))
vi.mock("../src/tools/invokeAdvisor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/invokeAdvisor.js")>()),
  invokeAdvisor: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { runTests } from "../src/tools/runTests.js"
import { invokeAdvisor } from "../src/tools/invokeAdvisor.js"
import { dedupeMetaHead, lossyGuardsReject, getStore, ccrTtlSeconds, maybeCompress, drainCcrStats } from "../src/lib/compression.js"

// Real run_tests compression of the multi-thousand-line SYNTHETIC_LOG takes a few seconds;
// give this suite ample headroom over vitest's 5s default so it never flakes under CI/host load.
vi.setConfig({ testTimeout: 30000 })
// ---------------------------------------------------------------------------
// Synthetic pytest-style failing log — fully deterministic, NO Date.now,
// NO randomness. Must be ≥5000 lines and far exceed 2048 bytes.
// ---------------------------------------------------------------------------
function buildSyntheticLog(): string {
  const lines: string[] = []

  lines.push("============================= test session starts ==============================")
  lines.push("platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0")
  lines.push("rootdir: /workspace/project")
  lines.push("collected 4950 items")
  lines.push("")

  // Traceback block
  lines.push("Traceback (most recent call last):")
  lines.push("  File \"/workspace/project/tests/conftest.py\", line 42, in setup_module")
  lines.push("    db.connect(timeout=5)")
  lines.push("  File \"/workspace/project/src/db.py\", line 118, in connect")
  lines.push("    raise ConnectionError(\"database unavailable\")")
  lines.push("  File \"/workspace/project/src/db.py\", line 99, in _try_connect")
  lines.push("    socket.create_connection((host, port), timeout)")
  lines.push("  File \"/usr/lib/python3.11/socket.py\", line 851, in create_connection")
  lines.push("    raise err")
  lines.push("  File \"/usr/lib/python3.11/socket.py\", line 840, in create_connection")
  lines.push("    sock.connect(sa)")
  lines.push("ConnectionError: database unavailable")

  // Intersperse FAILED/ERROR/INFO lines up to ~4950 more lines
  const failedIndices = new Set([100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500])
  const errorIndices = new Set([200, 600, 1200])

  for (let i = 0; i < 5010; i++) {
    if (failedIndices.has(i)) {
      lines.push(`FAILED tests/test_foo.py::test_bar_${i} - AssertionError: expected True but got False`)
    } else if (errorIndices.has(i)) {
      lines.push(`ERROR tests/test_foo.py::test_setup_${i} - RuntimeError: fixture teardown failed at step ${i}`)
    } else if (i % 7 === 0) {
      lines.push(`INFO  [${i}] Running scenario ${i}: validating input schema for endpoint /api/v${i % 10}/resource`)
    } else if (i % 11 === 0) {
      lines.push(`DEBUG [${i}] Cache miss for key="item:${i}" — fetching from upstream service`)
    } else if (i % 13 === 0) {
      lines.push(`WARN  [${i}] Retry attempt ${(i % 3) + 1} for request id=${i * 7} after timeout`)
    } else {
      lines.push(`INFO  [${i}] test_module_${i % 50}.test_case_${i} PASSED in ${(i % 100) + 1}ms`)
    }
  }

  lines.push("")
  lines.push("=== 10 failed, 4940 passed in 12.34s ===")

  return lines.join("\n")
}

const SYNTHETIC_LOG = buildSyntheticLog()

// ---------------------------------------------------------------------------
// Deterministic failure-output fixture for the S8 failure-output exemption
// suite. Builds a synthetic exit_code/passed/timed_out/truncated meta head
// followed by a repeated traceback block padded to at least minBodyChars.
// ---------------------------------------------------------------------------
function buildFailureOutput(exitCode: number, minBodyChars: number): string {
  const block = [
    "ERROR: TestSuite.test_connect failed with RuntimeError",
    "FAILED: connection refused on 127.0.0.1:5432 after 3 retries",
    "Traceback (most recent call last):",
    '  File "/workspace/tests/test_db.py", line 88, in test_connect',
    "    conn = db.connect(dsn, timeout=5)",
    '  File "/workspace/src/db.py", line 44, in connect',
    "    raise RuntimeError('connection refused')",
    "RuntimeError: connection refused: postgresql://localhost:5432/mydb",
  ].join("\n")
  let body = ""
  while (body.length < minBodyChars) body += block + "\n"
  return `exit_code: ${exitCode}\npassed: false\ntimed_out: false\ntruncated: false\n\nSTDOUT\n${body}\n\nSTDERR\n`
}

// ---------------------------------------------------------------------------
// Deterministic must-keep fixture (1c) — a compressible pytest-style log whose
// five embedded irreplaceable tokens (hex id, path, CLI flag, CamelCase,
// ALLCAPS constant) must survive log compression's line selection.
// ---------------------------------------------------------------------------
function buildMustKeepFixture(): string {
  const lines: string[] = []
  lines.push("============================= test session starts ==============================")
  lines.push("collected 200 items")
  lines.push("")
  for (let i = 0; i < 160; i++) {
    if (i === 30) lines.push("request trace deadbeef01 retried once and then settled quietly")
    else if (i === 60) lines.push("slow module load observed importing src/lib/foo.ts during collection")
    else if (i === 90) lines.push("deprecated invocation detected passing --flag to the harness binary")
    else if (i === 120) lines.push("serializer emitted CamelCaseId during fixture setup without incident")
    else if (i === 150) lines.push("upstream gateway answered HTTP_500 once and then recovered on retry")
    else lines.push(`step ${i} of warmup completed without incident in module alpha`)
  }
  lines.push("FAILED tests/test_gateway.py::test_retry - AssertionError: retry budget exceeded")
  lines.push("Traceback (most recent call last):")
  lines.push('  File "/workspace/tests/test_gateway.py", line 12, in test_retry')
  lines.push("    assert budget.remaining > 0")
  lines.push("AssertionError: retry budget exceeded")
  lines.push("")
  lines.push("=== 1 failed, 199 passed in 3.21s ===")
  return lines.join("\n")
}

// Sanity: the log must be ≥5000 lines and exceed 2048 bytes
// (these are compile-time-ish invariants we can verify with a single assertion
//  inside the test suite rather than throwing at module load)

// ---------------------------------------------------------------------------
// Server/client setup (shared across suites)
// ---------------------------------------------------------------------------
let server: McpServer
let client: Client

async function setupServer() {
  server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
}

// ---------------------------------------------------------------------------
// Env hygiene — saved/restored around every test
// ---------------------------------------------------------------------------
let savedCompression: string | undefined
let savedCompressionTools: string | undefined

beforeEach(() => {
  savedCompression = process.env.FOREMAN_COMPRESSION
  savedCompressionTools = process.env.FOREMAN_COMPRESSION_TOOLS
})

afterEach(async () => {
  await client?.close()
  await server?.close()

  if (savedCompression === undefined) {
    delete process.env.FOREMAN_COMPRESSION
  } else {
    process.env.FOREMAN_COMPRESSION = savedCompression
  }

  if (savedCompressionTools === undefined) {
    delete process.env.FOREMAN_COMPRESSION_TOOLS
  } else {
    process.env.FOREMAN_COMPRESSION_TOOLS = savedCompressionTools
  }
})

// ---------------------------------------------------------------------------
// Suite 1 — compression ON
// ---------------------------------------------------------------------------
describe("compression ON (FOREMAN_COMPRESSION=1)", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()
  })

  it("SYNTHETIC_LOG meets size requirements (≥5000 lines, >2048 bytes)", () => {
    const lineCount = SYNTHETIC_LOG.split("\n").length
    expect(lineCount).toBeGreaterThanOrEqual(5000)
    expect(Buffer.byteLength(SYNTHETIC_LOG, "utf8")).toBeGreaterThan(2048)
  })

  it("run_tests returns compressed output with <<ccr:HASH>> marker and round-trips to exact original", async () => {
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    // Must contain a CCR marker
    expect(text).toContain("<<ccr:")

    // Must be compressed to ≤35% of original byte size
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      0.35 * Buffer.byteLength(SYNTHETIC_LOG, "utf8")
    )

    // Extract hash and retrieve original
    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()
    const hash = match![1]

    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash },
    })
    expect((res.content as any)[0].text).toBe(SYNTHETIC_LOG)
  })

  it("listTools includes retrieve_original", async () => {
    const result = await client.listTools()
    const names = result.tools.map((t: any) => t.name)
    expect(names).toContain("retrieve_original")
  })

  it("retrieve_original with unknown hash returns isError and ccr_missing_or_expired JSON", async () => {
    const unknownHash = "0".repeat(24)
    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash: unknownHash },
    })
    expect(res.isError).toBe(true)
    const parsed = JSON.parse((res.content as any)[0].text)
    expect(parsed).toEqual({ error: "ccr_missing_or_expired", hash: unknownHash })
  })
})

// ---------------------------------------------------------------------------
// Suite 2 — compression OFF
// ---------------------------------------------------------------------------
describe("kill switch (FOREMAN_COMPRESSION=0)", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "0"
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()
  })

  it("run_tests returns byte-identical passthrough (no compression) when =0", async () => {
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toBe(SYNTHETIC_LOG)
    expect(Buffer.byteLength(text, "utf8")).toBe(Buffer.byteLength(SYNTHETIC_LOG, "utf8"))
  })

  it("listTools does NOT include retrieve_original when =0", async () => {
    const result = await client.listTools()
    const names = result.tools.map((t: any) => t.name)
    expect(names).not.toContain("retrieve_original")
  })
})

// ---------------------------------------------------------------------------
// Suite 3 — per-tool allowlist (FOREMAN_COMPRESSION_TOOLS)
// ---------------------------------------------------------------------------
describe("per-tool allowlist (FOREMAN_COMPRESSION_TOOLS)", () => {
  it("run_tests excluded from allowlist → byte-identical passthrough", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    process.env.FOREMAN_COMPRESSION_TOOLS = "invoke_advisor"
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toBe(SYNTHETIC_LOG)
    expect(text).not.toContain("<<ccr:")
  })

  it("run_tests explicitly allowlisted → compressed", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    process.env.FOREMAN_COMPRESSION_TOOLS = " run_tests "
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      0.35 * Buffer.byteLength(SYNTHETIC_LOG, "utf8")
    )
  })

  it("empty allowlist → nothing compresses", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    process.env.FOREMAN_COMPRESSION_TOOLS = ""
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toBe(SYNTHETIC_LOG)
  })
})

// ---------------------------------------------------------------------------
// Suite 4 — default behavior (FOREMAN_COMPRESSION unset → ON)
// ---------------------------------------------------------------------------
describe("default behavior (FOREMAN_COMPRESSION unset → ON)", () => {
  it("unset flag → run_tests output is compressed", async () => {
    delete process.env.FOREMAN_COMPRESSION
    delete process.env.FOREMAN_COMPRESSION_TOOLS
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      0.35 * Buffer.byteLength(SYNTHETIC_LOG, "utf8")
    )
  })

  it("unset flag → retrieve_original is registered", async () => {
    delete process.env.FOREMAN_COMPRESSION
    delete process.env.FOREMAN_COMPRESSION_TOOLS
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()

    const result = await client.listTools()
    const names = result.tools.map((t: any) => t.name)
    expect(names).toContain("retrieve_original")
  })
})

// ---------------------------------------------------------------------------
// Suite 5 — meta head preservation
// ---------------------------------------------------------------------------
const META_HEAD = "exit_code: 0\npassed: false\ntimed_out: false\ntruncated: false"
const FORMATTED_LOG = `${META_HEAD}\n\nSTDOUT\n${SYNTHETIC_LOG}\n\nSTDERR\n`

describe("meta head preservation", () => {
  it("compressed run_tests output starts with the original meta block", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    vi.mocked(runTests).mockResolvedValue(FORMATTED_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
    expect(text.startsWith(META_HEAD + "\n\n")).toBe(true)
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      0.35 * Buffer.byteLength(FORMATTED_LOG, "utf8")
    )
  })

  it("meta-prepended digest still round-trips to the exact formatted original", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    vi.mocked(runTests).mockResolvedValue(FORMATTED_LOG)
    await setupServer()

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()
    const hash = match![1]

    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash },
    })
    expect((res.content as any)[0].text).toBe(FORMATTED_LOG)
  })
})

// ---------------------------------------------------------------------------
// Suite 5b — failure-output exemption (S8) — server-driven via mocked runTests
// ---------------------------------------------------------------------------
describe("failure-output exemption (S8)", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    await setupServer()
  })

  it("failed 4k-class output passes through verbatim", async () => {
    const fixture = buildFailureOutput(1, 6500)
    expect(fixture.length).toBeLessThanOrEqual(8192)
    expect(fixture.length).toBeGreaterThanOrEqual(5000)

    vi.mocked(runTests).mockResolvedValue(fixture)

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toBe(fixture)
    expect(text).not.toContain("<<ccr:")
  })

  it("same-size exit_code 0 output still compresses (proves exemption, not size, drove passthrough)", async () => {
    const fixture = buildFailureOutput(0, 6500)
    vi.mocked(runTests).mockResolvedValue(fixture)

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
  })

  it("failed 20k output still compresses", async () => {
    const fixture = buildFailureOutput(1, 20000)
    expect(fixture.length).toBeGreaterThan(8192)
    vi.mocked(runTests).mockResolvedValue(fixture)

    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
    expect(text.startsWith("exit_code: 1")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CCR miss recovery (1b) — expired-hash retrieval names the originating tool
// ---------------------------------------------------------------------------
describe("CCR miss recovery (1b)", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    vi.mocked(runTests).mockResolvedValue(SYNTHETIC_LOG)
    await setupServer()
  })

  it("expired-hash retrieval names the originating tool", async () => {
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string
    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()
    const hash = match![1]

    // Simulate expiry via the vendor store's public API — reproduces exactly what the
    // expiry sweep does (entry + stashed toolName gone) without any timing dependence.
    getStore().clear()

    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash },
    })
    expect(res.isError).toBe(true)
    const parsed = JSON.parse((res.content as any)[0].text)
    expect(parsed).toEqual({ error: "ccr_missing_or_expired", hint: "expired — re-run run_tests to regenerate the output" })
  })

  it("unknown hash keeps the bare error", async () => {
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string
    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()

    getStore().clear()

    const unknownHash = "f".repeat(24)
    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash: unknownHash },
    })
    expect(res.isError).toBe(true)
    const parsed = JSON.parse((res.content as any)[0].text)
    expect(parsed).toEqual({ error: "ccr_missing_or_expired", hash: unknownHash })
  })

  describe("ccrTtlSeconds", () => {
    let savedTtl: string | undefined

    beforeEach(() => {
      savedTtl = process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS
    })

    afterEach(() => {
      if (savedTtl === undefined) {
        delete process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS
      } else {
        process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS = savedTtl
      }
    })

    it("env unset → 1800", () => {
      delete process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS
      expect(ccrTtlSeconds()).toBe(1800)
    })

    it("env \"600\" → 600", () => {
      process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS = "600"
      expect(ccrTtlSeconds()).toBe(600)
    })

    it("env \"0\" → 1800 (invalid: must be integer > 0)", () => {
      process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS = "0"
      expect(ccrTtlSeconds()).toBe(1800)
    })

    it("env \"abc\" → 1800 (invalid: not a number)", () => {
      process.env.CONTEXT_CRUSH_CCR_TTL_SECONDS = "abc"
      expect(ccrTtlSeconds()).toBe(1800)
    })
  })
})

// ---------------------------------------------------------------------------
// S8 must-keep guard (1c) — irreplaceable tokens survive log compression
// ---------------------------------------------------------------------------
describe("S8 must-keep guard (1c) — irreplaceable tokens survive log compression", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    vi.mocked(runTests).mockResolvedValue(buildMustKeepFixture())
    await setupServer()
  })

  it("compressible log keeps hex id, path, flag, CamelCase, and ALLCAPS tokens", async () => {
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string

    expect(text).toContain("<<ccr:")
    expect(text).toContain("deadbeef01")
    expect(text).toContain("src/lib/foo.ts")
    expect(text).toContain("--flag")
    expect(text).toContain("CamelCaseId")
    expect(text).toContain("HTTP_500")
  })

  it("must-keep digest still round-trips to the exact original", async () => {
    const fixture = buildMustKeepFixture()
    const result = await client.callTool({
      name: "run_tests",
      arguments: { runner: "npm", args: [] },
    })
    const text = (result.content as any)[0].text as string
    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()
    const hash = match![1]

    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash },
    })
    expect((res.content as any)[0].text).toBe(fixture)
  })
})

// ---------------------------------------------------------------------------
// Suite 6 — advisor compression (0.2.2) — server-driven via mocked invokeAdvisor
// ---------------------------------------------------------------------------
describe("advisor compression (0.2.2)", () => {
  beforeEach(async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    await setupServer()
  })

  it("success: prose passes through, stderr trimmed, tokens preserved", async () => {
    vi.mocked(invokeAdvisor).mockResolvedValue({
      stdout: "Here is my review.\n\nRecommendation: do X.",
      stderr:
        "OpenAI Codex v0.139.0\n--------\nmodel: gpt-5.5\n\nuser\nreview this\n\ncodex\nHere is my review.\n\nRecommendation: do X.\ntokens used\n12,345",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })

    const result = await client.callTool({
      name: "invoke_advisor",
      arguments: { cli: "codex", prompt: "review this", timeout_ms: 5000 },
    })
    const text = (result.content as any)[0].text as string

    // Prose content passes through verbatim
    expect(text).toContain("Here is my review.")
    // No lossy compression marker
    expect(text).not.toContain("<<ccr:")
    // STDERR section is trimmed on clean success
    expect(text).not.toContain("STDERR")
    // Banner from stderr is gone
    expect(text).not.toContain("OpenAI Codex v0.139.0")
    // Token count is extracted and preserved (commas stripped)
    expect(text).toContain("tokens_used: 12345")
  })

  it("success: large review quoting errors is NOT misrouted to log compression", async () => {
    // ~3KB review with [ERROR] lines and Fix: recommendations — the 0.2.2 regression fix
    const errorLines = [
      "[ERROR] Missing Content-Security-Policy header on /api/v1/login",
      "[ERROR] MIME type mismatch: text/plain served as application/json on /static/bundle.js",
      "[ERROR] X-Frame-Options absent — clickjacking vector on payment page",
      "[ERROR] Strict-Transport-Security max-age too low (3600 < 15768000) on www.example.com",
      "[ERROR] Referrer-Policy not set — full URL leaked on cross-origin navigation",
    ]
    const fixLines = [
      "Fix: Add `Content-Security-Policy: default-src 'self'; script-src 'nonce-{random}'` to all responses.",
      "Fix: Set correct MIME types via Express `serve-static` options or explicit `res.type()` calls.",
      "Fix: Add `X-Frame-Options: DENY` or use CSP `frame-ancestors 'none'` on checkout pages.",
      "Fix: Raise HSTS max-age to at least 15768000 (6 months) and add `includeSubDomains`.",
    ]

    // Build ~3KB prose
    const paragraphs = [
      "## Security Header Audit — CSP / MIME Triage",
      "",
      "I reviewed the HTTP response headers for the five endpoints listed below. " +
        "The analysis covers Content-Security-Policy, MIME-type consistency, framing protection, " +
        "HSTS configuration, and referrer leakage. Several issues were identified that require " +
        "remediation before the next production release.",
      "",
      "### Findings",
      "",
      ...errorLines,
      "",
      "### Recommended Fixes",
      "",
      ...fixLines,
      "",
      "### Priority",
      "",
      "All four fixes above are HIGH priority. The CSP absence is the most severe because it " +
        "allows inline script injection. The HSTS misconfiguration is the easiest to address " +
        "and should be deployed immediately via infrastructure config rather than application code.",
      "",
      "### Additional Notes",
      "",
      "The endpoints were tested with curl and the responses inspected with `curl -I`. " +
        "No authentication bypass was found. The MIME mismatch on /static/bundle.js may " +
        "be a CDN misconfiguration rather than an application bug — verify the CDN origin " +
        "response headers match the cached ones.",
      "",
      "Reviewed by: codex model gpt-5.5. Confidence: high for CSP/HSTS, medium for MIME/Referrer.",
    ]

    // Pad to ~3 KB with repeated context
    const padding = " Detailed remediation steps are available in the internal wiki at /security/headers.".repeat(15)
    const stdout = paragraphs.join("\n") + "\n" + padding

    vi.mocked(invokeAdvisor).mockResolvedValue({
      stdout,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    })

    const result = await client.callTool({
      name: "invoke_advisor",
      arguments: { cli: "codex", prompt: "review this", timeout_ms: 5000 },
    })
    const text = (result.content as any)[0].text as string

    // Prose must NOT be lossy-compressed (this is the 0.2.2 regression fix)
    expect(text).not.toContain("<<ccr:")

    // Every Fix: recommendation must survive intact
    expect(text).toContain(fixLines[0])
    expect(text).toContain(fixLines[1])
    expect(text).toContain(fixLines[2])
    expect(text).toContain(fixLines[3])
  })

  it("success but truncated: stderr retained", async () => {
    vi.mocked(invokeAdvisor).mockResolvedValue({
      stdout: "partial",
      stderr: "warning: near limit",
      exitCode: 0,
      timedOut: false,
      truncated: true,
    })

    const result = await client.callTool({
      name: "invoke_advisor",
      arguments: { cli: "codex", prompt: "review this", timeout_ms: 5000 },
    })
    const text = (result.content as any)[0].text as string

    // Trim does NOT apply when truncated=true — stderr section must be present
    expect(text).toContain("STDERR")
    expect(text).toContain("warning: near limit")
  })

  it("failure: diagnostic dump compresses and round-trips", async () => {
    // Build a large log-shaped stderr (≥3000 bytes, highly repetitive for compression)
    const stackBlock = [
      "ERROR: TestSuite.test_connect failed with RuntimeError",
      "FAILED: connection refused on 127.0.0.1:5432 after 3 retries",
      "Traceback (most recent call last):",
      "  File \"/workspace/tests/test_db.py\", line 88, in test_connect",
      "    conn = db.connect(dsn, timeout=5)",
      "  File \"/workspace/src/db.py\", line 44, in connect",
      "    raise RuntimeError(f'connection refused: {dsn}')",
      "RuntimeError: connection refused: postgresql://localhost:5432/mydb",
      "ERROR: cleanup hook raised DatabaseError: relation 'sessions' does not exist",
      "FAILED: teardown failed for fixture 'db_session' — state may be dirty",
      "ERROR: rollback failed after transaction abort — manual intervention required",
    ].join("\n")

    // Repeat the block enough times to exceed 3000 bytes and be highly compressible
    let dumpLines = ""
    // ≥12000 so the formatted output exceeds FAILURE_OUTPUT_COMPRESS_MIN (8192) —
    // the 1a failure exemption passes small failure dumps through verbatim;
    // the ≤8192 verbatim path is covered by the failure-exemption suite.
    while (Buffer.byteLength(dumpLines, "utf8") < 12000) {
      dumpLines += stackBlock + "\n"
    }
    const distinctiveLine = "ERROR: cleanup hook raised DatabaseError: relation 'sessions' does not exist"

    vi.mocked(invokeAdvisor).mockResolvedValue({
      stdout: "",
      stderr: dumpLines,
      exitCode: 1,
      timedOut: false,
      truncated: false,
    })

    const result = await client.callTool({
      name: "invoke_advisor",
      arguments: { cli: "codex", prompt: "review this", timeout_ms: 5000 },
    })
    const text = (result.content as any)[0].text as string

    // Meta-head must carry exit_code: 1
    expect(text).toContain("exit_code: 1")
    // Failure dump must be compressed
    expect(text).toContain("<<ccr:")

    // Extract hash and round-trip
    const match = /<<ccr:([0-9a-f]{24})>>/.exec(text)
    expect(match).not.toBeNull()
    const hash = match![1]

    const res = await client.callTool({
      name: "retrieve_original",
      arguments: { hash },
    })
    const retrieved = (res.content as any)[0].text as string

    // Full formatted original is recovered
    expect(retrieved).toContain(distinctiveLine)
    expect(retrieved).toContain("exit_code: 1")
  })
})

// ---------------------------------------------------------------------------
// Suite 7 — dedupeMetaHead pure-function unit tests
// ---------------------------------------------------------------------------
describe("dedupeMetaHead", () => {
  const HEAD = "exit_code: 0\npassed: false\ntimed_out: false\ntruncated: false"

  it("kept-none: body with no head suffix overlap → HEAD + body unchanged", () => {
    const body = "STDOUT\n...error..."
    const result = dedupeMetaHead(HEAD, body)
    expect(result).toBe(HEAD + "\n\n" + body)
  })

  it("kept-last-line: body starts with head's last line → stripped once, appears exactly once", () => {
    const body = "truncated: false\n\nSTDOUT\nx"
    const result = dedupeMetaHead(HEAD, body)
    // 'truncated: false' must appear exactly once in the output (not duplicated)
    expect((result.match(/truncated: false/g) || []).length).toBe(1)
    // Result must start with the full HEAD block
    expect(result.startsWith(HEAD + "\n\n")).toBe(true)
  })

  it("kept-suffix-2: body starts with last TWO head lines → both stripped, each appears exactly once", () => {
    const body = "timed_out: false\ntruncated: false\n\nbody content"
    const result = dedupeMetaHead(HEAD, body)
    // Result must start with full HEAD block
    expect(result.startsWith(HEAD + "\n\n")).toBe(true)
    // Neither line must be duplicated
    expect((result.match(/timed_out: false/g) || []).length).toBe(1)
    expect((result.match(/truncated: false/g) || []).length).toBe(1)
  })

  it("kept-full-head: body === HEAD + separator + body content → no duplication", () => {
    const body = HEAD + "\n\nbody content"
    const result = dedupeMetaHead(HEAD, body)
    // Result equals HEAD + separator + body content — no double HEAD
    expect(result).toBe(HEAD + "\n\nbody content")
    // Each head line appears exactly once
    expect((result.match(/exit_code: 0/g) || []).length).toBe(1)
    expect((result.match(/passed: false/g) || []).length).toBe(1)
    expect((result.match(/timed_out: false/g) || []).length).toBe(1)
    expect((result.match(/truncated: false/g) || []).length).toBe(1)
  })

  it("coincidental-non-suffix: body first line matches a non-tail head line → body line is NOT stripped", () => {
    // 'exit_code: 0' is the FIRST head line, not the last — so headSuffix(k=1) = 'truncated: false' ≠ 'exit_code: 0'
    // No suffix alignment exists, so NOTHING should be stripped
    const body = "exit_code: 0\nsome real log line"
    const result = dedupeMetaHead(HEAD, body)
    // Result = HEAD + sep + body (body's exit_code: 0 line is preserved)
    expect(result).toBe(HEAD + "\n\n" + body)
    // exit_code: 0 appears twice: once in head, once in body
    expect((result.match(/exit_code: 0/g) || []).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Suite 8 — lossyGuardsReject (S8 guards) pure-function unit tests
// ---------------------------------------------------------------------------
describe("lossyGuardsReject (S8 guards)", () => {
  it("compressed text with no marker → reject (synthetic lossy-no-marker result returns original)", () => {
    expect(lossyGuardsReject("original body", "digest without any marker")).toBe(true)
  })

  it("empty compressed text from non-empty original → reject", () => {
    expect(lossyGuardsReject("original body", "")).toBe(true)
  })

  it("whitespace-only compressed text from non-empty original → reject", () => {
    expect(lossyGuardsReject("original body", "   \n\t  ")).toBe(true)
  })

  it("compressed text with a valid marker → accept (not rejected)", () => {
    expect(
      lossyGuardsReject("original body", "digest <<ccr:0123456789abcdef01234567>> tail")
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CCR stats evidence (5b) — per-tool accumulator recording actually-served
// compression outcomes, drained by write_ledger. Pure calls to maybeCompress
// (no server/client needed) — mirrors Suite 7/8's pure-function style.
// ---------------------------------------------------------------------------
describe("CCR stats evidence (5b)", () => {
  it("a compressed outcome records calls/tokens_before/tokens_after", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "1"
    const input = SYNTHETIC_LOG
    const out = maybeCompress("run_tests", input)
    expect(out).not.toBe(input)
    const stats = drainCcrStats()
    expect(stats).toEqual({
      run_tests: {
        calls: 1,
        tokens_before: Math.ceil(input.length / 4),
        tokens_after: Math.ceil(out.length / 4),
      },
    })
  })

  it("drain clears — an immediate second drain returns {}", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "1"
    const out = maybeCompress("run_tests", SYNTHETIC_LOG)
    expect(out).not.toBe(SYNTHETIC_LOG)
    drainCcrStats() // first drain — discard result, just clears state
    expect(drainCcrStats()).toEqual({})
  })

  it("two compressions on the same tool aggregate", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "1"
    const out1 = maybeCompress("run_tests", SYNTHETIC_LOG)
    const out2 = maybeCompress("run_tests", SYNTHETIC_LOG)
    expect(out1).not.toBe(SYNTHETIC_LOG)
    expect(out2).not.toBe(SYNTHETIC_LOG)
    const stats = drainCcrStats()
    expect(stats.run_tests.calls).toBe(2)
    expect(stats.run_tests.tokens_before).toBe(2 * Math.ceil(SYNTHETIC_LOG.length / 4))
    expect(stats.run_tests.tokens_after).toBe(
      Math.ceil(out1.length / 4) + Math.ceil(out2.length / 4)
    )
  })

  it("FOREMAN_COMPRESSION=0 passthrough records nothing", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "0"
    const out = maybeCompress("run_tests", SYNTHETIC_LOG)
    expect(out).toBe(SYNTHETIC_LOG)
    expect(drainCcrStats()).toEqual({})
  })

  it("non-allowlisted tool name records nothing", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "1"
    delete process.env.FOREMAN_COMPRESSION_TOOLS // default allowlist: run_tests,invoke_advisor
    const out = maybeCompress("some_other_tool", SYNTHETIC_LOG)
    expect(out).toBe(SYNTHETIC_LOG)
    expect(drainCcrStats()).toEqual({})
  })

  it("failure-output exemption records nothing", () => {
    drainCcrStats()
    process.env.FOREMAN_COMPRESSION = "1"
    const fixture = buildFailureOutput(1, 6500)
    const out = maybeCompress("run_tests", fixture)
    expect(out).toBe(fixture)
    expect(drainCcrStats()).toEqual({})
  })
})
