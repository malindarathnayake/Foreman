// Field feedback 2026-09 #1: write_journal / write_ledger data shapes were undocumented
// in the tool descriptions and agents learned them one failed call at a time. The
// descriptions are now GENERATED from the validation schemas (lib/schemaDoc.ts). This
// contract test fails the moment a schema key, enum value, or limit is missing from
// what the client sees in listTools — so prose and schema cannot drift apart again.
import { describe, it, expect, afterEach } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { JournalOperationDataSchemas, LedgerOperationDataSchemas, JournalEventCode } from "../src/types.js"
import { renderShape, shapeKeys } from "../src/lib/schemaDoc.js"
import { z } from "zod"

let server: McpServer
let client: Client

async function setupServer() {
  server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
}

afterEach(async () => {
  await client?.close()
  await server?.close()
})

async function descriptionOf(name: string): Promise<string> {
  const tools = await client.listTools()
  const tool = tools.tools.find((t) => t.name === name)
  expect(tool, name).toBeDefined()
  return tool!.description ?? ""
}

describe("schemaDoc.renderShape", () => {
  it("renders keys, optionality, enums, nullable unions, and limits", () => {
    const shape = renderShape(
      z.object({
        t: z.enum(["A", "B"]),
        u: z.string().max(200),
        tok: z.number().min(0),
        codex: z.string().max(50).nullable(),
        wait: z.number().min(0).optional(),
        units: z.array(z.string().max(100)).max(50),
      })
    )
    expect(shape).toBe(
      "{ t: 'A'|'B', u: string (≤200 chars), tok: number (≥0), codex: string (≤50 chars) | null, wait?: number (≥0), units: string (≤100 chars)[] (max 50) }"
    )
  })

  it("shapeKeys lists top-level properties", () => {
    expect(shapeKeys(JournalOperationDataSchemas.log_event)).toEqual(["t", "u", "tok", "msg", "wait", "gate"])
  })
})

describe("write_journal description carries every data shape", () => {
  it("names each operation, every data key, the full event-code enum, and the target_version limit", async () => {
    await setupServer()
    const desc = await descriptionOf("write_journal")
    for (const [op, schema] of Object.entries(JournalOperationDataSchemas)) {
      expect(desc, op).toContain(`${op} — data: `)
      for (const key of shapeKeys(schema)) expect(desc, `${op}.${key}`).toMatch(new RegExp(`\\b${key}\\??: `))
    }
    for (const code of JournalEventCode.options) expect(desc, code).toContain(`'${code}'`)
    expect(desc).toContain("target_version: string (≤20 chars)")
    // Nested env shape and the eight summary fields are spelled out, not summarized.
    expect(desc).toContain("env: { agent: string")
    expect(desc).toContain("summary: { units_ok: number (≥0)")
    expect(desc).toContain("blockers: string (≤100 chars)[] (max 20)")
    // The anomaly-only contract is stated where the agent reads it.
    expect(desc).toContain("anomaly-only")
    expect(desc).toContain("TOOL_ERR")
  })
})

describe("write_ledger description carries every data shape", () => {
  it("renders each operation's data schema, including via/inconclusive and the review fields", async () => {
    await setupServer()
    const desc = await descriptionOf("write_ledger")
    for (const [op, schema] of Object.entries(LedgerOperationDataSchemas)) {
      expect(desc, op).toContain(`  ${op}: ${renderShape(schema)}`)
    }
    expect(desc).toContain("'pass'|'fail'|'pending'|'inconclusive'")
    expect(desc).toContain("via?: 'worker'|'pitboss-direct'|'n/a'")
    expect(desc).toContain("line: string (≤20 chars)")
    expect(desc).toContain("completion?: 'complete'|'partial'|'failed'")
    expect(desc).toContain("stage?: 'independent'|'cross_exam'")
  })
})

describe("write_progress description states the fence contract", () => {
  it("names the fence markers, the replace semantics, and the ledger dependency", async () => {
    await setupServer()
    const desc = await descriptionOf("write_progress")
    expect(desc).toContain("<!-- foreman:checklist-start -->")
    expect(desc).toContain("REPLACED")
    expect(desc).toContain("_No phases yet._")
  })
})
