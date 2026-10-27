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

let dir: string, ledger: string
let server: McpServer | undefined, client: Client | undefined
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-gate-followup-")); ledger = path.join(dir, "ledger.json") })
afterEach(async () => { await client?.close(); await server?.close(); client = undefined; server = undefined; await fs.rm(dir, { recursive: true, force: true }) })

function write(host: HostId, operation: string, data: object, unit_id?: string) {
  return handleWriteLedger(ledger, { operation, phase: "p1", ...(unit_id ? { unit_id } : {}), data }, host, undefined, { projectRoot: dir })
}
async function connect(host: HostId) {
  server = await createServer({ host, ledgerPath: ledger, progressPath: path.join(dir, "progress.json"), docsDir: dir })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "owner-gate-followup", version: "1.0.0" })
  await client.connect(clientTransport)
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client!.callTool({ name, arguments: args })
  return { error: result.isError, text: (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n") }
}

describe.each(KNOWN_HOSTS)("owner-gate follow-up on %s", (host) => {
  it("reports every missing override and model field on attempt 9, then accepts one complete retry", async () => {
    await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ [host]: { frontier: "verified-model" } }))
    for (let attempt = 1; attempt <= 9; attempt++) {
      if (attempt === 4) await write(host, "authorize_attempts", { attempts: 6, reason: "Owner permits another six bounded attempts.", user_override: true, authority: "direct", quote: "Try another six times." }, "u1")
      await write(host, "set_unit_status", { s: "delegated", tier: "frontier", brief: "Implement this bounded change and validate the result.", preflight: { symbols_grepped: 1, self_consistent: true } }, "u1")
      await write(host, "add_rejection", { r: "reviewer", msg: `Attempt ${attempt} has a finding the owner may accept.` }, "u1")
    }
    await connect(host)
    const before = await fs.readFile(ledger, "utf8")
    const refusal = await call("write_ledger", { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", user_override: true } })
    expect(refusal.error).toBe(true)
    for (const field of ["data.authority", "data.quote", "data.override_fact_key", "data.worker_model", "data.model_evidence"]) expect(refusal.text).toContain(field)
    expect(await fs.readFile(ledger, "utf8")).toBe(before)
    await write(host, "record_fact", { key: "owner-acceptance", text: "Owner accepts the remaining finding on attempt nine." })
    const retry = await call("write_ledger", { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", user_override: true, authority: "direct", quote: "Accept attempt nine.", override_fact_key: "owner-acceptance", worker_model: "verified-model", model_evidence: "Host transcript confirms verified-model for attempt nine." } })
    expect(retry.error).not.toBe(true)
    const u = (await readLedger(ledger)).phases.p1.units.u1
    expect(u.attempt_seq).toBe(9)
    expect(u.v).toBe("pass")
  })

  it("collects missing relay identity, bad fact link and mismatched model together", async () => {
    await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ [host]: { frontier: "verified-model" } }))
    await write(host, "set_unit_status", { s: "delegated", tier: "frontier", brief: "Implement this bounded change and validate the result.", preflight: { symbols_grepped: 1, self_consistent: true } }, "u1")
    const refusal = await write(host, "set_verdict", { v: "pass", user_override: true, authority: "relayed", quote: "Owner approved.", override_fact_key: "missing", worker_model: "different-model" }, "u1").then(() => "UNEXPECTED PASS", (e: Error) => e.message)
    for (const field of ["data.relayed_by", "data.override_fact_key", "data.model_evidence", "does not match"]) expect(refusal).toContain(field)
  })

  it("advertises registration and records B1/B2 progress through the actual MCP surface", async () => {
    await connect(host)
    const initial = await call("session_orient")
    expect(initial.text).toContain("pending_owner_gates: none")
    expect(initial.text).toContain("operation:'set_owner_gate'")
    const tools = (await client!.listTools()).tools
    const tool = tools.find((t) => t.name === "write_ledger")!
    expect(tool.description).toContain("Live gates: set_owner_gate")
    expect(JSON.stringify(tool.inputSchema)).toContain("in_progress")
    expect(JSON.stringify(tool.inputSchema)).toContain("failure")
    const gate = (data: object) => call("write_ledger", { operation: "set_owner_gate", phase: "p1", data })
    expect((await gate({ id: "B1", description: "Live validation gate", status: "in_progress", failure: { stage: "Deploy", reason: "Deployment health check failed." } })).error).not.toBe(true)
    expect((await gate({ id: "B2", description: "Owner acceptance gate", status: "pending" })).error).not.toBe(true)
    const state = await call("session_orient")
    expect(state.text).toContain("action: await_owner_gates")
    expect(state.text).toContain("p1/B1: in progress, failed once at Deploy")
    expect(state.text).toContain("p1/B2: pending")
    expect(state.text).toContain("Deployment health check failed.")

    await gate({ id: "B1", status: "failed", failure: { stage: "Deploy", reason: "Second deployment failed." } })
    await gate({ id: "B1", status: "in_progress", stage: "Validate", note: "Retry is validating the new deployment." })
    expect((await call("session_orient")).text).toContain("in progress, failed 2 times at Deploy")
    const phase = (await readLedger(ledger)).phases.p1
    expect(phase.pending_owner_gates!.find((g) => g.id === "B1")).toMatchObject({ failure_count: 2, stage: "Validate", last_failure: { stage: "Deploy", reason: "Second deployment failed." } })
    expect(phase.owner_gate_history![0]).toMatchObject({ failure_count: 1, status: "in_progress", last_failure: { reason: "Deployment health check failed." } })
    expect((await call("write_ledger", { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })).text).toContain("OWNER GATES PENDING")

    const approval = await gate({ id: "B1", status: "approved" })
    expect(approval.error).toBe(true)
    for (const field of ["data.decided_by", "data.authority", "data.quote"]) expect(approval.text).toContain(field)
    await gate({ id: "B1", status: "approved", decided_by: "owner", authority: "direct", quote: "I accept the live validation." })
    const after = await call("session_orient")
    expect(after.text).not.toContain("p1/B1:")
    expect(after.text).toContain("p1/B2: pending")
    expect((await readLedger(ledger)).phases.p1.owner_gate_history!.at(-1)).toMatchObject({ id: "B1", status: "approved", failure_count: 2 })
    await gate({ id: "B1", status: "in_progress", stage: "Recheck" })
    expect((await call("session_orient")).text).toContain("p1/B1: in progress, failed 2 times at Deploy")
  })

  it("keeps an in-progress or failed unit gate blocking and validates registration fields together", async () => {
    await write(host, "set_unit_status", { s: "delegated", brief: "Implement this bounded change and validate the result.", preflight: { symbols_grepped: 1, self_consistent: true } }, "u1")
    const invalid = await write(host, "set_owner_gate", { id: "B1", status: "failed" }, "u1").then(() => "UNEXPECTED PASS", (e: Error) => e.message)
    expect(invalid).toContain("data.description")
    expect(invalid).toContain("data.failure")
    for (const status of ["in_progress", "failed"] as const) {
      await write(host, "set_owner_gate", { id: "B1", description: "Live deployment gate", status, ...(status === "failed" ? { failure: { stage: "Deploy", reason: "Deployment failed." } } : {}) }, "u1")
      await expect(write(host, "set_verdict", { v: "pass" }, "u1")).rejects.toThrow("OWNER GATES PENDING")
    }
  })
})
