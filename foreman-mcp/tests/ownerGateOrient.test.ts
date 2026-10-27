import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { KNOWN_HOSTS, type HostId } from "../src/lib/hostProfiles.js"
import { readLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"

// 0.9.4 (field report 2026-10-13): one-call approval, approval kept on reopen, only pending
// gates replace the next action, and orientation names each gate's full text once.
let dir: string, ledger: string
let server: McpServer | undefined, client: Client | undefined
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-gate-orient-")); ledger = path.join(dir, "ledger.json") })
afterEach(async () => { await client?.close(); await server?.close(); client = undefined; server = undefined; await fs.rm(dir, { recursive: true, force: true }) })

const approve = { status: "approved", decided_by: "owner", authority: "direct", quote: "Run the live validation." }
function write(host: HostId, operation: string, data: object, unit_id?: string) {
  return handleWriteLedger(ledger, { operation, phase: "p1", ...(unit_id ? { unit_id } : {}), data }, host, undefined, { projectRoot: dir })
}
async function orient(host: HostId) {
  if (!client) {
    server = await createServer({ host, ledgerPath: ledger, progressPath: path.join(dir, "progress.json"), docsDir: dir })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: "owner-gate-orient", version: "1.0.0" })
    await client.connect(clientTransport)
  }
  const result = await client.callTool({ name: "session_orient", arguments: {} })
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n")
}
const field = (text: string, key: string) => text.split("\n").find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim()

describe.each(KNOWN_HOSTS)("owner gates in orientation on %s", (host) => {
  it("registers and approves a gate in one call, and refuses a second approval", async () => {
    await write(host, "set_owner_gate", { id: "B1", description: "Owner approval for the live run", ...approve })
    const phase = (await readLedger(ledger)).phases.p1
    expect(phase.pending_owner_gates ?? []).toHaveLength(0)
    expect(phase.owner_gate_history!.at(-1)).toMatchObject({ id: "B1", status: "approved", approval: { decided_by: "owner", authorization: { authority: "direct" } } })
    await expect(write(host, "set_owner_gate", { id: "B1", ...approve })).rejects.toThrow("already approved")
  })

  it("keeps the approval visible after reopening, and an in-progress gate does not replace the next action", async () => {
    await write(host, "set_unit_status", { s: "delegated", brief: "Implement this bounded change and validate the result.", preflight: { symbols_grepped: 1, self_consistent: true } }, "u1")
    await write(host, "set_owner_gate", { id: "B1", description: "Owner approval for the live run", ...approve }, "u1")
    await write(host, "set_owner_gate", { id: "B1", status: "in_progress", stage: "Deploy" }, "u1")
    const text = await orient(host)
    expect(field(text, "action")).not.toBe("await_owner_gates")
    expect(field(text, "pending_owner_gates")).toContain('p1/u1/B1: in progress — Owner approval for the live run; stage: Deploy; approved by owner (direct')
    expect(field(text, "pending_owner_gates")).toContain('"Run the live validation."')
    await expect(write(host, "set_verdict", { v: "pass" }, "u1")).rejects.toThrow("OWNER GATES PENDING")
  })

  it("names pending gates by id in blocked_on and drops the hint once a gate exists", async () => {
    expect(await orient(host)).toContain("owner_gates_hint:")
    await write(host, "set_owner_gate", { id: "B1", description: "Owner approval for the live run", status: "pending" })
    await write(host, "set_owner_gate", { id: "B2", description: "Owner accepts live results", status: "pending" })
    const text = await orient(host)
    expect(field(text, "action")).toBe("await_owner_gates")
    expect(field(text, "blocked_on")).toBe("p1/B1, p1/B2")
    expect(text.split("Owner approval for the live run").length - 1).toBe(1)
    expect(text).not.toContain("owner_gates_hint:")
  })

  it("keeps the write_ledger description under the host clip limit and lists the approval fields", async () => {
    await orient(host)
    const tool = (await client!.listTools()).tools.find((t) => t.name === "write_ledger")!
    expect(tool.description!.length).toBeLessThan(2000)
    expect(tool.description).toContain("decided_by?,authority?,quote?")
    expect(JSON.stringify(tool.inputSchema)).toContain("set_owner_gate")
  })
})
