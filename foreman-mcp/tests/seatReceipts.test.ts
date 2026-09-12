vi.mock("../src/tools/invokeAdvisor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/invokeAdvisor.js")>()),
  invokeAdvisor: vi.fn(),
}))

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { invokeAdvisor } from "../src/tools/invokeAdvisor.js"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import {
  appendConsumed, appendReceipt, providerFromModelId, readReceipts, receiptFailure, receiptsPathFor, sha256Hex, type ReceiptInput,
} from "../src/lib/seatReceipts.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let receiptsPath: string
let server: McpServer | undefined
let client: Client | undefined

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-receipt-"))
  ledgerPath = path.join(dir, "ledger.json")
  receiptsPath = receiptsPathFor(ledgerPath)
})
afterEach(async () => {
  await client?.close()
  await server?.close()
  client = undefined
  server = undefined
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const PROMPT = "Review these phase changes against the spec.\n" + "x".repeat(1200)
const OK_INPUT: ReceiptInput = {
  cli: "gemini", provider: "google", model_requested: "gemini-3.1-pro-preview", model_served: "gemini-3.1-pro-preview",
  exit_code: 0, failure_reason: null, prompt_sha256: sha256Hex(PROMPT), bytes_in: Buffer.byteLength(PROMPT), bytes_out: 900, tokens_used: 4100,
}
async function receipt(extra: Partial<ReceiptInput> = {}) {
  const r = await appendReceipt(receiptsPath, { ...OK_INPUT, ...extra })
  vi.setSystemTime(Date.now() + 1000)
  return r
}
async function write(operation: Record<string, unknown>, host: HostId = "claude-code") {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, host)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const delegated = (unit_id: string) => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: "Implement the bounded change for this unit", preflight: { symbols_grepped: 1, self_consistent: true },
} })
async function passingUnit(unit_id = "u1", host: HostId = "claude-code") {
  await write(delegated(unit_id), host)
  await write({ operation: "set_verdict", phase: "p1", unit_id, data: { v: "pass" } }, host)
}
const record = (data: Record<string, unknown>, host: HostId = "claude-code") =>
  write({ operation: "record_review", phase: "p1", data: { advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"], ...data } }, host)
const gate = (host: HostId = "claude-code") => write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } }, host)

// ─── The file ────────────────────────────────────────────────────────────────

describe("the receipts file is a hash chain Foreman alone writes", () => {
  it("appends receipts and consumption lines, reads them back, and stays consistent", async () => {
    const a = await receipt()
    const b = await receipt({ cli: "codex", provider: "openai", model_served: "gpt-6-astra", reasoning_effort: "xhigh" })
    await appendConsumed(receiptsPath, a.id, "p1", "2026-09-09T15:00:05.000Z")
    const state = await readReceipts(receiptsPath)
    expect([...state.receipts.keys()]).toEqual([a.id, b.id])
    expect(state.receipts.get(b.id)).toMatchObject({ provider: "openai", reasoning_effort: "xhigh" })
    // 0.6.26: consumption keeps the binding (phase + review_ts), not just the id, so the
    // ledger can tell "spent on a record that still exists" from "spent on a record that is gone".
    expect([...state.consumed.keys()]).toEqual([a.id])
    expect(state.consumed.get(a.id)).toMatchObject({ kind: "consumed", id: a.id, phase: "p1" })
    expect(a.id).toMatch(/^[0-9a-f]{16}$/)
    const lines = (await fs.readFile(receiptsPath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0].prev_hash).toBeUndefined()
    expect(lines[1].prev_hash).toBe(lines[0].line_hash)
    expect(lines[2].prev_hash).toBe(lines[1].line_hash)
  })
  it("an absent file is an empty state", async () => {
    expect(await readReceipts(receiptsPath)).toEqual({ receipts: new Map(), consumed: new Map() })
  })
  it("an edited line breaks the chain loudly [CWE-345]", async () => {
    const a = await receipt()
    await receipt()
    const raw = await fs.readFile(receiptsPath, "utf-8")
    await fs.writeFile(receiptsPath, raw.replace(`"exit_code":0`, `"exit_code":1`).replace(a.id, a.id))
    await expect(readReceipts(receiptsPath)).rejects.toThrow(/hash chain broken .* line 1/)
  })
  it("a torn final line is skipped on read and refused on append [CWE-354]", async () => {
    const a = await receipt()
    await fs.appendFile(receiptsPath, '{"v":1,"kind":"receipt","id":"deadbeefdeadbeef"')
    const state = await readReceipts(receiptsPath)
    expect([...state.receipts.keys()]).toEqual([a.id])
    await expect(receipt()).rejects.toThrow(/torn final line/)
  })
  it("receiptFailure names the run's failure from the same facts the output shows", () => {
    expect(receiptFailure(0, null)).toBeNull()
    expect(receiptFailure(0, "empty_stdout")).toBe("empty_stdout")
    expect(receiptFailure(-1, null)).toBe("resolution_failed")
    expect(receiptFailure(2, null)).toBe("nonzero_exit")
  })
})

// ─── The writer: invoke_advisor ──────────────────────────────────────────────

describe("invoke_advisor writes a receipt and names it in the meta block", () => {
  async function connect(host: HostId = "codex") {
    server = await createServer({ host, ledgerPath, docsDir: dir })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: "receipt-test", version: "1" })
    await client.connect(ct)
  }
  const codexStderr = (model: string) => `OpenAI Codex v0.153.4\n--------\nmodel: ${model}\nreasoning effort: xhigh\n--------\ntokens used\n12,345`

  it("a clean run: receipt with provider, served model, hash, bytes and tokens; meta carries seat_receipt and packet_sha256", async () => {
    await connect()
    vi.mocked(invokeAdvisor).mockResolvedValue({ stdout: "Here is my review.\n" + "y".repeat(400), stderr: codexStderr("gpt-6-astra"), exitCode: 0, timedOut: false, truncated: false })
    const result = await client!.callTool({ name: "invoke_advisor", arguments: { cli: "codex", prompt: PROMPT, timeout_ms: 5000 } })
    const text = (result.content as Array<{ text: string }>)[0].text
    const id = /seat_receipt: ([0-9a-f]{16})/.exec(text)?.[1]
    expect(id).toBeDefined()
    expect(text).toContain(`packet_sha256: ${sha256Hex(PROMPT)}`)
    expect(text).toContain("Here is my review.")
    const state = await readReceipts(receiptsPath)
    expect(state.receipts.get(id!)).toMatchObject({
      cli: "codex", provider: "openai", model_requested: "gpt-6-astra", model_served: "gpt-6-astra", reasoning_effort: "xhigh",
      exit_code: 0, failure_reason: null, prompt_sha256: sha256Hex(PROMPT), bytes_in: Buffer.byteLength(PROMPT), tokens_used: 12345,
    })
    expect(state.receipts.get(id!)!.bytes_out).toBeGreaterThan(400)
  })
  it("a failed run still gets a receipt, marked failed, so it can never be bound", async () => {
    await connect()
    vi.mocked(invokeAdvisor).mockResolvedValue({ stdout: "", stderr: codexStderr("gpt-6-astra"), exitCode: 0, timedOut: false, truncated: false })
    const result = await client!.callTool({ name: "invoke_advisor", arguments: { cli: "codex", prompt: PROMPT, timeout_ms: 5000 } })
    const text = (result.content as Array<{ text: string }>)[0].text
    const id = /seat_receipt: ([0-9a-f]{16})/.exec(text)![1]
    expect((await readReceipts(receiptsPath)).receipts.get(id)).toMatchObject({ failure_reason: "empty_stdout" })
    vi.mocked(invokeAdvisor).mockResolvedValue({ stdout: "", stderr: "claude: not found", exitCode: -1, timedOut: false, truncated: false })
    const failed = await client!.callTool({ name: "invoke_advisor", arguments: { cli: "claude", prompt: PROMPT, timeout_ms: 5000 } })
    const id2 = /seat_receipt: ([0-9a-f]{16})/.exec((failed.content as Array<{ text: string }>)[0].text)![1]
    expect((await readReceipts(receiptsPath)).receipts.get(id2)).toMatchObject({ cli: "claude", provider: "anthropic", failure_reason: "resolution_failed", model_served: "unknown" })
  })
  it("a receipts file that cannot be written is reported, and the review text still comes back", async () => {
    await connect()
    await fs.appendFile(receiptsPath, '{"torn":true')
    vi.mocked(invokeAdvisor).mockResolvedValue({ stdout: "Here is my review.", stderr: codexStderr("gpt-6-astra"), exitCode: 0, timedOut: false, truncated: false })
    const result = await client!.callTool({ name: "invoke_advisor", arguments: { cli: "codex", prompt: PROMPT, timeout_ms: 5000 } })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("seat_receipt: unavailable (")
    expect(text).toContain("Here is my review.")
  })
})

// ─── Binding at record_review ────────────────────────────────────────────────

describe("record_review binds one receipt to one independent record", () => {
  it("stamps provenance from the receipt and spends it before the ledger is written", async () => {
    await passingUnit()
    const r = await receipt()
    await record({ seat_receipt: r.id, packet_hash: r.prompt_sha256 })
    const review = (await readLedger(ledgerPath)).phases.p1.reviews![0]
    expect(review.provenance).toEqual({
      receipt: r.id, cli: "gemini", provider: "google", model_served: "gemini-3.1-pro-preview",
      bytes_in: OK_INPUT.bytes_in, bytes_out: 900, tokens_used: 4100,
    })
    expect([...(await readReceipts(receiptsPath)).consumed.keys()]).toEqual([r.id])
    await expect(record({ seat_receipt: r.id, packet_hash: r.prompt_sha256 })).rejects.toThrow(/already bound to the review recorded at/)
  })
  // 0.6.26 (field report 2026-09-11): the receipts file is append-only and survives a ledger
  // loss; the review records citing it do not. Both seats stayed bound while their records
  // were gone, and a completed gate review became permanently unrecordable. A receipt is
  // reclaimable exactly when the ledger can prove the consuming record is absent.
  it("reclaims a receipt whose review record the ledger no longer holds, and records the rebind", async () => {
    await passingUnit()
    const r = await receipt()
    await record({ seat_receipt: r.id, packet_hash: r.prompt_sha256 })
    const spentTs = (await readLedger(ledgerPath)).phases.p1.reviews![0].ts

    // Simulate the loss: the ledger comes back from git without the review record.
    const restored = await readLedger(ledgerPath)
    restored.phases.p1.reviews = []
    await fs.writeFile(ledgerPath, JSON.stringify(restored))

    const result = await record({ seat_receipt: r.id, packet_hash: r.prompt_sha256 })
    expect(JSON.stringify(result)).toContain("was reclaimed")
    expect((await readLedger(ledgerPath)).phases.p1.reviews![0].provenance).toMatchObject({ receipt: r.id })
    // Both bindings stay in the chain, the second naming the record it replaced.
    const consumed = (await readReceipts(receiptsPath)).consumed.get(r.id)
    expect(consumed!.reclaimed).toEqual({ from_review_ts: spentTs })
  })
  it("refuses an unknown receipt, a missing or mismatched packet hash, a failed seat, and a non-independent stage", async () => {
    await passingUnit()
    const r = await receipt()
    await expect(record({ seat_receipt: "0123456789abcdef", packet_hash: r.prompt_sha256 })).rejects.toThrow(/is not in the receipts file/)
    await expect(record({ seat_receipt: r.id })).rejects.toThrow(/packet_hash is required/)
    await expect(record({ seat_receipt: r.id, packet_hash: sha256Hex("other prompt") })).rejects.toThrow(/packet mismatch/)
    const failed = await receipt({ failure_reason: "model_substituted" })
    await expect(record({ seat_receipt: failed.id, packet_hash: failed.prompt_sha256 })).rejects.toThrow(/is a failed seat \(model_substituted\)/)
    const nonzero = await receipt({ exit_code: 1, failure_reason: "nonzero_exit" })
    await expect(record({ seat_receipt: nonzero.id, packet_hash: nonzero.prompt_sha256 })).rejects.toThrow(/is a failed seat/)
    await expect(record({ seat_receipt: r.id, packet_hash: r.prompt_sha256, stage: "cross_exam" })).rejects.toThrow(/stage undefined or 'independent' only/)
    // nothing was consumed by a refused bind
    expect((await readReceipts(receiptsPath)).consumed.size).toBe(0)
    expect((await readLedger(ledgerPath)).phases.p1.reviews).toBeUndefined()
  })
  it("refuses a receipt that ran before the newest verdict or attempt", async () => {
    await write(delegated("u1"))
    const early = await receipt()
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
    await expect(record({ seat_receipt: early.id, packet_hash: early.prompt_sha256 })).rejects.toThrow(/before the newest verdict or attempt/)
    await write(delegated("u2"))
    const mid = await receipt()
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u2", data: { v: "pass" } })
    await expect(record({ seat_receipt: mid.id, packet_hash: mid.prompt_sha256 })).rejects.toThrow(/before the newest verdict or attempt/)
    const late = await receipt()
    await record({ seat_receipt: late.id, packet_hash: late.prompt_sha256 })
  })
  it("on Codex an unreceipted independent record is stored with a warning, never refused", async () => {
    await passingUnit("u1", "codex")
    const { warning } = await record({}, "codex")
    expect(warning).toContain("SEAT RECEIPT: this independent record carries no receipt")
    expect((await readLedger(ledgerPath)).phases.p1.reviews![0].provenance).toBeUndefined()
    await passingUnit("u2")
    expect((await record({})).warning).toBeUndefined()
  })
})

// ─── What a receipt buys at the gate ─────────────────────────────────────────

describe("the gate basis reads provenance Foreman wrote", () => {
  it("a Gemini receipt on Codex is receipted_external; a Codex receipt on Codex is same_provider", async () => {
    await passingUnit("u1", "codex")
    const g = await receipt()
    await record({ seat_receipt: g.id, packet_hash: g.prompt_sha256 }, "codex")
    await gate("codex")
    let stamp = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(stamp.basis).toBe("receipted_external")
    expect(stamp.seats[0]).toMatchObject({ basis: "receipted_external", receipt: g.id })
    expect(stamp.tokens).toEqual({ receipted: 4100, declared: 0, unreported: 0 })

    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pending" } }, "codex")
    await passingUnit("u2", "codex")
    const c = await receipt({ cli: "codex", provider: "openai", model_served: "gpt-6-astra" })
    await record({ advisor: "codex", seat_receipt: c.id, packet_hash: c.prompt_sha256 }, "codex")
    await gate("codex")
    stamp = (await readLedger(ledgerPath)).phases.p1.gate_history![1]
    expect(stamp.basis).toBe("same_provider")
  })
  it("on a host with no known vendor one receipt is 'receipted'; two vendors make the gate receipted_external", async () => {
    await passingUnit("u1", "cursor")
    const g = await receipt()
    await record({ seat_receipt: g.id, packet_hash: g.prompt_sha256 }, "cursor")
    await gate("cursor")
    expect((await readLedger(ledgerPath)).phases.p1.gate_history![0].basis).toBe("receipted")
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pending" } }, "cursor")
    await passingUnit("u2", "cursor")
    const g2 = await receipt()
    const c = await receipt({ cli: "codex", provider: "openai", model_served: "gpt-6-astra" })
    await record({ seat_receipt: g2.id, packet_hash: g2.prompt_sha256 }, "cursor")
    await record({ advisor: "codex", seat_receipt: c.id, packet_hash: c.prompt_sha256 }, "cursor")
    await gate("cursor")
    expect((await readLedger(ledgerPath)).phases.p1.gate_history![1].basis).toBe("receipted_external")
  })
  it("a seat below the bytes floor is 'receipted' even across vendors", async () => {
    await passingUnit("u1", "codex")
    const tiny = await receipt({ bytes_out: 40 })
    await record({ seat_receipt: tiny.id, packet_hash: tiny.prompt_sha256 }, "codex")
    await gate("codex")
    expect((await readLedger(ledgerPath)).phases.p1.gate_history![0].basis).toBe("receipted")
  })
})

describe("council receipts", () => {
  it("providerFromModelId is a prefix allowlist; everything else is unknown", () => {
    expect(providerFromModelId("anthropic/claude-opus-5")).toBe("anthropic")
    expect(providerFromModelId("claude-fable-5-1")).toBe("anthropic")
    expect(providerFromModelId("openai/gpt-6-astra")).toBe("openai")
    expect(providerFromModelId("o3-pro")).toBe("openai")
    expect(providerFromModelId("google/gemini-3.1-pro")).toBe("google")
    expect(providerFromModelId("moonshotai/kimi-k2")).toBe("unknown")
    expect(providerFromModelId("loopback/mock-model")).toBe("unknown")
  })
  it("an unknown-vendor council receipt is 'receipted' on every host and never promotes to external", async () => {
    await passingUnit("u1", "codex")
    const unknownA = await receipt({ cli: "council", provider: "unknown", model_served: "moonshotai/kimi-k2" })
    const unknownB = await receipt({ cli: "council", provider: "unknown", model_served: "loopback/mock-model" })
    await record({ advisor: "kimi", seat_receipt: unknownA.id, packet_hash: unknownA.prompt_sha256 }, "codex")
    await record({ advisor: "mock", seat_receipt: unknownB.id, packet_hash: unknownB.prompt_sha256 }, "codex")
    await gate("codex")
    const stamp = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(stamp.basis).toBe("receipted")
    expect(stamp.seats.map((s) => s.basis)).toEqual(["receipted", "receipted"])
  })
})
