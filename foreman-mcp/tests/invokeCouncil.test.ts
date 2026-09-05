import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { handleInvokeCouncil, resetCouncilEgressNoticeForTest } from "../src/tools/invokeCouncil.js"
import { resetForTest } from "../src/lib/redaction.js"
import { initSession } from "../src/lib/journal.js"

// Behavioral contract under test, in priority order:
//   1. An unconfigured council degrades to `status: unavailable` and tells the host what to do
//      next. Foreman keeps working normally; nothing errors.
//   2. The outbound secret gate runs BEFORE any network call.
//   3. Nothing here ever reaches the network — every case is decided pre-flight.

let dirsToClean: string[] = []

async function makeWorkspace(): Promise<{ dir: string; journalPath: string; credentialsPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "invokecouncil-test-"))
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
  return { dir, journalPath, credentialsPath: path.join(dir, "absent-credentials.env") }
}

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "p1",
    objective: "review the council wiring change",
    evidence: "diff --git a/x.ts b/x.ts\n+const a = 1\n",
    ...overrides,
  }
}

beforeEach(() => {
  dirsToClean = []
  resetCouncilEgressNoticeForTest()
})

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  resetForTest()
})

describe("invoke_council — unconfigured is a supported state", () => {
  it("returns unavailable and names the next ladder rung when nothing is configured", async () => {
    const ws = await makeWorkspace()
    const text = await handleInvokeCouncil(baseInput(), {
      journalPath: ws.journalPath,
      envDir: ws.dir,
      credentialsPath: ws.credentialsPath,
    })

    expect(text).toContain("status: unavailable")
    // Must not read as a failure OR as a pass — both misreadings are dangerous.
    expect(text).toContain("NOT a failure and NOT a passed review")
    // Must name the fallback path explicitly so the host does not have to infer it.
    expect(text).toContain("capability_check")
    expect(text).toContain("invoke_advisor")
    expect(text).toContain("adversarial self-review")
    // Must not claim any review happened.
    expect(text).not.toContain("status: ok")
    expect(text).not.toContain("## Findings")
  })

  it("does not emit the egress notice when no request is made", async () => {
    const ws = await makeWorkspace()
    const text = await handleInvokeCouncil(baseInput(), {
      journalPath: ws.journalPath,
      envDir: ws.dir,
      credentialsPath: ws.credentialsPath,
    })

    expect(text).not.toContain("NOTICE:")
  })
})

describe("invoke_council — input validation", () => {
  it("rejects an objective below the minimum length before touching config", async () => {
    const ws = await makeWorkspace()
    const text = await handleInvokeCouncil(baseInput({ objective: "short" }), {
      journalPath: ws.journalPath,
      envDir: ws.dir,
      credentialsPath: ws.credentialsPath,
    })

    expect(text).toContain("status: error")
    expect(text).toContain("invalid invoke_council input")
    expect(text).toContain("objective")
  })

  it("rejects an unknown lens id", async () => {
    const ws = await makeWorkspace()
    const text = await handleInvokeCouncil(baseInput({ lenses: ["vibes"] }), {
      journalPath: ws.journalPath,
      envDir: ws.dir,
      credentialsPath: ws.credentialsPath,
    })

    expect(text).toContain("status: error")
    expect(text).toContain("lenses")
  })
})

describe("invoke_council — outbound secret gate", () => {
  it("blocks a packet carrying a configured secret value, naming the var but never the value", async () => {
    const ws = await makeWorkspace()
    const secret = "sk_council_secret_0001"
    await fs.writeFile(
      ws.credentialsPath,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        `FOREMAN_API_KEY=${secret}\n` +
        "FOREMAN_COUNCIL_SEAT_A=deepseek/deepseek-v4-flash\n",
      "utf-8"
    )

    const text = await handleInvokeCouncil(
      baseInput({ evidence: `config line: OPENROUTER_KEY=${secret}\n` }),
      { journalPath: ws.journalPath, envDir: ws.dir, credentialsPath: ws.credentialsPath }
    )

    expect(text).toContain("WORKER_PAYLOAD_SECRET_BLOCK")
    expect(text).toContain("FOREMAN_API_KEY")
    // The VALUE must never appear in the returned text.
    expect(text).not.toContain(secret)
    // And nothing left the machine.
    expect(text).toContain("nothing left this machine")
  })
})

describe("invoke_council — fan-out ceiling", () => {
  it("refuses an over-wide fan-out with the arithmetic instead of silently truncating", async () => {
    const ws = await makeWorkspace()
    await fs.writeFile(
      ws.credentialsPath,
      "FOREMAN_API_BASE=https://openrouter.ai/api/v1\n" +
        "FOREMAN_API_KEY=council_ceiling_key01\n" +
        "FOREMAN_COUNCIL_SEAT_A=a/model\n" +
        "FOREMAN_COUNCIL_SEAT_B=b/model\n" +
        "FOREMAN_COUNCIL_SEAT_C=c/model\n",
      "utf-8"
    )

    const text = await handleInvokeCouncil(
      baseInput({
        lenses: ["contract", "architecture", "state", "security", "data", "tests", "operability"],
      }),
      { journalPath: ws.journalPath, envDir: ws.dir, credentialsPath: ws.credentialsPath }
    )

    expect(text).toContain("status: config_error")
    expect(text).toContain("3 seats x 7 lenses = 21 calls")
    expect(text).toContain("FOREMAN_COUNCIL_MAX_CALLS")
  })
})

// ─── R2 regression (2026-09): a configured seat works end to end over loopback ──────
// Every other case in this file is decided before the network. This one proves the
// council can actually talk to an OpenAI-compatible endpoint: home-store credentials,
// bearer auth, streamed SSE reply, seat-schema parsing, and the ledger-ready payload.
// It exists so shared worker code (foremanEnv, chatTransport, redaction) can be refactored
// without silently breaking the council.
import http from "http"
import type { AddressInfo } from "net"

describe("invoke_council — configured seat over a loopback endpoint", () => {
  it("authenticates, streams, parses the seat reply, and prints a record_review payload", async () => {
    const seen: { auth?: string; path?: string; body?: Record<string, unknown> } = {}
    const reply = {
      completion: "complete",
      findings: [{ severity: "high", file: "x.ts", line: "1", description: "const a is assigned and never read", confidence: "high" }],
      checked: ["x.ts"],
      limitations: [],
    }
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        seen.auth = req.headers.authorization
        seen.path = req.url
        seen.body = JSON.parse(raw)
        res.writeHead(200, { "content-type": "text/event-stream" })
        const frame = JSON.stringify({
          choices: [{ delta: { content: JSON.stringify(reply) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        })
        res.end(`data: ${frame}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port

    try {
      const ws = await makeWorkspace()
      const credentialsPath = path.join(ws.dir, "home.env")
      await fs.writeFile(
        credentialsPath,
        [
          `FOREMAN_API_BASE=http://127.0.0.1:${port}/v1`,
          "FOREMAN_API_KEY=test-key-loopback-000001",
          "FOREMAN_COUNCIL_SEAT_A=loopback/mock-model",
        ].join("\n") + "\n",
        "utf-8"
      )

      const text = await handleInvokeCouncil(baseInput({ lenses: ["contract"] }), {
        journalPath: ws.journalPath,
        envDir: ws.dir,
        credentialsPath,
      })

      expect(text).toContain("status: ok")
      expect(text).toContain("seats_ok: 1/1")
      expect(text).toContain("record_review")
      expect(text).toContain("const a is assigned and never read")
      expect(seen.path).toBe("/v1/chat/completions")
      expect(seen.auth).toBe("Bearer test-key-loopback-000001")
      expect(seen.body?.stream).toBe(true)
      // The key is a registered secret: it must never surface in tool output.
      expect(text).not.toContain("test-key-loopback-000001")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
