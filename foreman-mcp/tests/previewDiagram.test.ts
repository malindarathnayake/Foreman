import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import http from "http"
import { previewDiagram } from "../src/tools/previewDiagram.js"
import {
  closeDiagramServer,
  ensureDiagramServer,
  isValidDiagramId,
} from "../src/lib/diagramServer.js"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-preview-"))
  process.env.FOREMAN_NO_OPEN = "1" // never spawn a browser in tests
  delete process.env.FOREMAN_PREVIEW
})

afterEach(async () => {
  await closeDiagramServer()
  await fs.rm(tmp, { recursive: true, force: true })
})

function httpGet(
  port: number,
  pathname: string,
  hostHeader?: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: { Host: hostHeader ?? `127.0.0.1:${port}` },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on("error", reject)
    req.end()
  })
}

const FLOW = "flowchart TD\n A-->B"

describe("id validation", () => {
  it("accepts slugs and rejects traversal / uppercase / slashes", () => {
    expect(isValidDiagramId("auth-flow")).toBe(true)
    expect(isValidDiagramId("a_b_2")).toBe(true)
    expect(isValidDiagramId("../x")).toBe(false)
    expect(isValidDiagramId("a/b")).toBe(false)
    expect(isValidDiagramId("UPPER")).toBe(false)
    expect(isValidDiagramId("")).toBe(false)
  })
})

describe("previewDiagram write contract", () => {
  it("rejects an invalid id with isError", async () => {
    const r = await previewDiagram({ id: "../evil", source: FLOW }, tmp)
    expect(r.isError).toBe(true)
  })

  it("writes the .mmd atomically and reports wrote -> updated", async () => {
    const r1 = await previewDiagram({ id: "flow", source: FLOW }, tmp)
    expect(r1.isError).toBeFalsy()
    const content = await fs.readFile(path.join(tmp, "diagrams", "flow.mmd"), "utf8")
    expect(content).toContain("A-->B")
    expect(r1.text).toContain("status: wrote")

    const r2 = await previewDiagram({ id: "flow", source: "flowchart TD\n A-->C" }, tmp)
    expect(r2.text).toContain("status: updated")
  })

  it("opens an existing diagram with no source, and errors when none exists", async () => {
    await previewDiagram({ id: "flow", source: FLOW }, tmp)
    const opened = await previewDiagram({ id: "flow" }, tmp)
    expect(opened.text).toContain("status: opened")

    const missing = await previewDiagram({ id: "ghost" }, tmp)
    expect(missing.isError).toBe(true)
  })

  it("honors FOREMAN_PREVIEW=0 — writes the file, starts no server", async () => {
    process.env.FOREMAN_PREVIEW = "0"
    const r = await previewDiagram({ id: "flow", source: FLOW }, tmp)
    expect(r.text).toContain("disabled")
    await fs.access(path.join(tmp, "diagrams", "flow.mmd"))
    delete process.env.FOREMAN_PREVIEW
  })
})

describe("preview server security", () => {
  it("serves source only with a valid token + Host, 403/404 otherwise", async () => {
    await previewDiagram({ id: "flow", source: FLOW }, tmp)
    const { port, token } = await ensureDiagramServer()

    const ok = await httpGet(port, `/t/${token}/api/source/flow`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain("A-->B")

    const badToken = await httpGet(port, `/t/deadbeefdeadbeefdeadbeefdeadbeef/api/source/flow`)
    expect(badToken.status).toBe(403)

    const unknownId = await httpGet(port, `/t/${token}/api/source/nope`)
    expect(unknownId.status).toBe(404)
  })

  it("rejects a rebound Host header (DNS-rebinding defense)", async () => {
    await previewDiagram({ id: "flow", source: FLOW }, tmp)
    const { port, token } = await ensureDiagramServer()

    const evil = await httpGet(port, `/t/${token}/api/source/flow`, `evil.test:${port}`)
    expect(evil.status).toBe(403)
  })

  it("sets a strict CSP (no unsafe-eval) + hardening headers, no inline script", async () => {
    await previewDiagram({ id: "flow", source: FLOW }, tmp)
    const { port, token } = await ensureDiagramServer()

    const view = await httpGet(port, `/t/${token}/view/flow`)
    expect(view.status).toBe(200)
    const csp = String(view.headers["content-security-policy"] ?? "")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("unsafe-eval")
    expect(view.headers["x-content-type-options"]).toBe("nosniff")
    expect(view.headers["cross-origin-resource-policy"]).toBe("same-origin")
    expect(view.body).not.toContain("<script>") // only <script src="…">, no inline

    const asset = await httpGet(port, `/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(String(asset.headers["content-type"])).toContain("javascript")
  })
})

describe("live reload", () => {
  it("pushes a reload event over SSE when the .mmd changes", async () => {
    await previewDiagram({ id: "flow", source: FLOW }, tmp)
    const { port, token } = await ensureDiagramServer()

    const chunks: string[] = []
    const sse = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/t/${token}/events/flow`,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        res.setEncoding("utf8")
        res.on("data", (c) => chunks.push(c))
      }
    )
    sse.end()

    await new Promise((r) => setTimeout(r, 200)) // let SSE attach
    await previewDiagram({ id: "flow", source: "flowchart TD\n A-->D" }, tmp) // overwrite -> watch fires
    await new Promise((r) => setTimeout(r, 500)) // debounce + delivery
    sse.destroy()

    expect(chunks.join("")).toContain("data: reload")
  })
})

describe("server lifecycle", () => {
  it("is an idempotent singleton (same port + token)", async () => {
    const a = await ensureDiagramServer()
    const b = await ensureDiagramServer()
    expect(a.port).toBe(b.port)
    expect(a.token).toBe(b.token)
  })
})
