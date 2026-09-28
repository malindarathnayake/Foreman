// 0.6.39: the activity budget alone let an endpoint that trickles a chunk every few seconds
// run forever, and the host could not cancel a call. Both now stop the request.
import { describe, it, expect, afterEach } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { postChat } from "../src/lib/chatTransport.js"

let server: http.Server | undefined
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined })

async function trickle(): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const t = setInterval(() => res.write("data: .\n\n"), 200)
    res.on("close", () => clearInterval(t))
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`
}
const budgets = (total: number) => ({ connectTimeoutMs: 2000, activityTimeoutMs: 2000, responseMaxBytes: 1_000_000, totalTimeoutMs: total })

describe("chat transport stops a call that never ends", () => {
  it("the overall deadline ends a trickling response", async () => {
    const url = await trickle()
    const t = Date.now()
    const r = await postChat(url, {}, "{}", budgets(1000))
    expect(r).toMatchObject({ kind: "neterror", stage: "WORKER_TIMEOUT", refunded: true })
    expect((r as { detail?: string }).detail).toContain("overall deadline")
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it("the host's cancel signal ends it and says so", async () => {
    const url = await trickle()
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    const r = await postChat(url, {}, "{}", budgets(60_000), { signal: ac.signal })
    expect(r).toMatchObject({ kind: "neterror", stage: "WORKER_TIMEOUT" })
    expect((r as { detail?: string }).detail).toBe("cancelled by the host")
  })
})
