// Field feedback 2026-09 #1 and round 3: write_journal / write_ledger data shapes were
// undocumented, then documented in a place the host clips. Claude Code truncates MCP
// tool descriptions at ~2,000 characters (measured live: write_ledger was cut
// mid-sentence before its shapes) but shows the input schema in full. The shapes are
// therefore generated into the `data` property's schema description (lib/schemaDoc.ts),
// every tool description is held under the clip, and this contract test fails the
// moment a schema key, enum value, or limit is missing from what the client sees.
import { describe, it, expect, afterEach } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import {
  JournalOperationDataSchemas,
  LedgerOperationDataSchemas,
  ProgressOperationDataSchemas,
  JournalEventCode,
} from "../src/types.js"
import { renderShape, shapeKeys } from "../src/lib/schemaDoc.js"
import { z } from "zod"

/** Measured host clip (~2,000). Kept with margin so a future edit cannot push a description past it. */
const DESCRIPTION_CLIP_GUARD = 1900

let server: McpServer
let client: Client

async function setupServer(host?: "claude-code" | "cursor" | "codex") {
  server = await createServer(host ? { host } : undefined)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
}

afterEach(async () => {
  await client?.close()
  await server?.close()
})

type Tool = { name: string; description?: string; inputSchema: { properties?: Record<string, { description?: string }> } }

async function toolNamed(name: string): Promise<Tool> {
  const tools = await client.listTools()
  const tool = tools.tools.find((t) => t.name === name) as Tool | undefined
  expect(tool, name).toBeDefined()
  return tool!
}

function dataDescription(tool: Tool): string {
  return tool.inputSchema.properties?.data?.description ?? ""
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

describe("every tool description stays under the host clip", () => {
  for (const host of ["claude-code", "codex"] as const) {
    it(`${host}: no description reaches ${DESCRIPTION_CLIP_GUARD} characters`, async () => {
      await setupServer(host)
      const tools = await client.listTools()
      for (const tool of tools.tools) {
        expect((tool.description ?? "").length, `${tool.name} description length`).toBeLessThan(DESCRIPTION_CLIP_GUARD)
      }
    })
  }
})

describe("write_journal shapes live in the data schema description", () => {
  it("names each operation, every data key, the full event-code enum, and the limits", async () => {
    await setupServer()
    const tool = await toolNamed("write_journal")
    const shapes = dataDescription(tool)
    for (const [op, schema] of Object.entries(JournalOperationDataSchemas)) {
      expect(shapes, op).toContain(`${op}: ${renderShape(schema)}`)
      for (const key of shapeKeys(schema)) expect(shapes, `${op}.${key}`).toMatch(new RegExp(`\\b${key}\\??: `))
    }
    for (const code of JournalEventCode.options) expect(shapes, code).toContain(`'${code}'`)
    expect(shapes).toContain("target_version: string (≤20 chars)")
    expect(shapes).toContain("msg: string (≤400 chars)")
    expect(shapes).toContain("env: { agent: string")
    expect(shapes).toContain("summary: { units_ok: number (≥0)")
    // The prose keeps the contract that is not a shape, and points at the schema.
    expect(tool.description).toContain("anomaly-only")
    expect(tool.description).toContain("TOOL_ERR")
    expect(tool.description).toContain("input schema")
  })
})

describe("write_ledger shapes live in the data schema description", () => {
  it("renders each operation's data schema, including via/inconclusive and the review fields", async () => {
    await setupServer()
    const tool = await toolNamed("write_ledger")
    const shapes = dataDescription(tool)
    for (const [op, schema] of Object.entries(LedgerOperationDataSchemas)) {
      expect(shapes, op).toContain(`${op}: ${renderShape(schema)}`)
    }
    expect(shapes).toContain("'pass'|'fail'|'pending'|'inconclusive'")
    expect(shapes).toContain("via?: 'worker'|'pitboss-direct'|'n/a'")
    expect(shapes).toContain("line: string (≤20 chars)")
    expect(shapes).toContain("preflight?: { symbols_grepped: integer (≥1), self_consistent: true")
    expect(shapes).toContain("completion?: 'complete'|'partial'|'failed'")
    expect(shapes).toContain("stage?: 'independent'|'cross_exam'")
    // The prose names every refusal class the reporter hit, and points at the schema.
    for (const word of ["preflight", "user_override", "confirmed", "checked[]", "input schema"]) {
      expect(tool.description, word).toContain(word)
    }
  })
})

describe("write_progress", () => {
  it("states the fence contract in prose and carries shapes in the schema", async () => {
    await setupServer()
    const tool = await toolNamed("write_progress")
    expect(tool.description).toContain("<!-- foreman:checklist-start -->")
    expect(tool.description).toContain("REPLACED")
    expect(tool.description).toContain("_No phases yet._")
    const shapes = dataDescription(tool)
    for (const [op, schema] of Object.entries(ProgressOperationDataSchemas)) {
      expect(shapes, op).toContain(`${op}: ${renderShape(schema)}`)
    }
  })
})
