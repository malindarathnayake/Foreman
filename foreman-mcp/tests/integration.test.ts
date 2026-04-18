import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/server.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

let server: McpServer
let client: Client

async function setupServer(config?: { ledgerPath?: string; progressPath?: string; docsDir?: string }) {
  server = await createServer(config)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
}

afterEach(async () => {
  await client?.close()
  await server?.close()
})

describe("list tools — verify all 16 present, update_bundle absent", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("lists exactly 16 tools", async () => {
    const result = await client.listTools()
    expect(result.tools).toHaveLength(16)
  })

  it("includes all required tool names", async () => {
    const result = await client.listTools()
    const names = result.tools.map((t) => t.name)
    expect(names).toContain("bundle_status")
    expect(names).toContain("changelog")
    expect(names).toContain("read_ledger")
    expect(names).toContain("read_progress")
    expect(names).toContain("capability_check")
    expect(names).toContain("write_ledger")
    expect(names).toContain("write_progress")
    expect(names).toContain("normalize_review")
    expect(names).toContain("pitboss_implementor")
    expect(names).toContain("design_partner")
    expect(names).toContain("spec_generator")
    expect(names).toContain("run_tests")
    expect(names).toContain("write_journal")
    expect(names).toContain("read_journal")
    expect(names).toContain("invoke_advisor")
    expect(names).toContain("session_orient")
  })

  it("session_orient invocation returns a non-empty string", async () => {
    const result = await client.callTool({
      name: "session_orient",
      arguments: {},
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe("text")
    expect(typeof content[0].text).toBe("string")
    expect(content[0].text.length).toBeGreaterThan(0)
    // On the default test setup the ledger is fresh (or non-existent),
    // so the orient tool returns the empty-ledger shape.
    expect(content[0].text).toContain("status:")
    expect(content[0].text).toContain("phases_total:")
  })

  it("session_orient tool description matches spec exactly", async () => {
    const result = await client.listTools()
    const tool = result.tools.find((t) => t.name === "session_orient")
    expect(tool).toBeDefined()
    expect(tool!.description).toBe(
      "Returns current Foreman session state: current phase, unit, next pending, blocked status. Call at session start for orientation."
    )
  })

  it("does not include update_bundle", async () => {
    const result = await client.listTools()
    const names = result.tools.map((t) => t.name)
    expect(names).not.toContain("update_bundle")
  })
})

describe("list resources — verify skill URIs", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("lists exactly 3 skill resources", async () => {
    const result = await client.listResources()
    expect(result.resources).toHaveLength(3)
    for (const r of result.resources) {
      expect(r.uri).not.toContain("_common-protocol")
      expect(r.uri).not.toMatch(/\/_[^/]+$/)
    }
  })

  it("includes skill://foreman/design-partner", async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r) => r.uri)
    expect(uris).toContain("skill://foreman/design-partner")
  })

  it("includes skill://foreman/spec-generator", async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r) => r.uri)
    expect(uris).toContain("skill://foreman/spec-generator")
  })

  it("includes skill://foreman/implementor", async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r) => r.uri)
    expect(uris).toContain("skill://foreman/implementor")
  })
})

describe("read skill resource — verify content", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("design-partner contains frontmatter and deliberation", async () => {
    const result = await client.readResource({ uri: "skill://foreman/design-partner" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("name: foreman:design-partner")
    expect(text).toContain("version: 0.0.5")
    expect(text).toContain("mcp__foreman__capability_check")
  })

  it("spec-generator contains frontmatter, ledger prohibition, and grounding checks", async () => {
    const result = await client.readResource({ uri: "skill://foreman/spec-generator" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("name: foreman:spec-generator")
    expect(text).toContain("version: 0.0.5")
    expect(text).toContain("mcp__foreman__write_ledger")
    expect(text).toContain("G1:")
  })

  it("implementor contains frontmatter and MCP tool refs", async () => {
    const result = await client.readResource({ uri: "skill://foreman/implementor" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("version: 0.0.5")
    expect(text).toContain("mcp__foreman__read_ledger")
    expect(text).toContain("mcp__foreman__write_ledger")
  })
})

describe("bundle_status round-trip", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("returns bundle_version and 0.0.6", async () => {
    const result = await client.callTool({ name: "bundle_status", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("bundle_version")
    expect(content[0].text).toContain("0.0.7")
  })
})

describe("write_ledger → read_ledger round-trip", () => {
  let tmpDir: string
  let ledgerPath: string
  let progressPath: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-test-"))
    ledgerPath = path.join(tmpDir, "ledger.json")
    progressPath = path.join(tmpDir, "progress.json")
    await setupServer({ ledgerPath, progressPath })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("writes and reads back unit status", async () => {
    // Write a unit status
    const writeResult = await client.callTool({
      name: "write_ledger",
      arguments: {
        operation: "set_unit_status",
        unit_id: "1a",
        phase: "phase1",
        data: { s: "ip" },
      },
    })
    const writeContent = writeResult.content as Array<{ type: string; text: string }>
    expect(writeContent[0].text).toContain("ok")

    // Read it back
    const readResult = await client.callTool({
      name: "read_ledger",
      arguments: {
        unit_id: "1a",
        phase: "phase1",
        query: "full",
      },
    })
    const readContent = readResult.content as Array<{ type: string; text: string }>
    expect(readContent[0].text).toContain("phase1")
    expect(readContent[0].text).toContain("1a")
  })
})

describe("pitboss_implementor round-trip", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("returns skill header and implementor protocol content", async () => {
    const result = await client.callTool({ name: "pitboss_implementor", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("skill: foreman:pitboss-implementor")
    expect(content[0].text).toMatch(/source: (bundled|user-override|project-override)/)
    expect(content[0].text).toContain("Pit-boss NEVER writes implementation code")
    expect(content[0].text).toContain("mcp__foreman__write_ledger")
  })

  it("includes activation_context when provided", async () => {
    const result = await client.callTool({
      name: "pitboss_implementor",
      arguments: { context: "resume phase 2" },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("activation_context: resume phase 2")
  })
})

describe("design_partner round-trip", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("returns skill header and design-partner protocol content", async () => {
    const result = await client.callTool({ name: "design_partner", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("skill: foreman:design-partner")
    expect(content[0].text).toMatch(/source: (bundled|user-override|project-override)/)
    expect(content[0].text).toContain("Design")
  })

  it("includes activation_context when provided", async () => {
    const result = await client.callTool({
      name: "design_partner",
      arguments: { context: "new MCP plugin for Slack" },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("activation_context: new MCP plugin for Slack")
  })
})

describe("spec_generator round-trip", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("returns skill header and spec-generator protocol content", async () => {
    const result = await client.callTool({ name: "spec_generator", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("skill: foreman:spec-generator")
    expect(content[0].text).toMatch(/source: (bundled|user-override|project-override)/)
    expect(content[0].text).toContain("Ledger Seeding")
    expect(content[0].text).toContain("mcp__foreman__write_ledger")
  })

  it("includes activation_context when provided", async () => {
    const result = await client.callTool({
      name: "spec_generator",
      arguments: { context: "Docs/design-summary.md" },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("activation_context: Docs/design-summary.md")
  })
})

describe("normalize_review round-trip", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("returns structured findings from sample review text", async () => {
    const rawText = `
HIGH: src/server.ts:42 — Missing error handling in tool callback
MEDIUM: src/tools/writeLedger.ts:15 — Input not sanitized before passing to handler
LOW: src/lib/toon.ts:8 — Variable name could be more descriptive
`
    const result = await client.callTool({
      name: "normalize_review",
      arguments: {
        reviewer: "test-reviewer",
        raw_text: rawText,
      },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("test-reviewer")
    expect(content[0].text).toContain("findings")
  })
})

describe("set_phase_scope round-trip via MCP", () => {
  let tmpDir: string
  let ledgerPath: string
  let progressPath: string
  let originalCwd: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-scope-"))
    ledgerPath = path.join(tmpDir, "ledger.json")
    progressPath = path.join(tmpDir, "progress.json")
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    await setupServer({ ledgerPath, progressPath })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("writes scope via MCP client and reads it back", async () => {
    const writeResult = await client.callTool({
      name: "write_ledger",
      arguments: {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: true, has_api: false, has_build: true },
      },
    })
    const writeContent = writeResult.content as Array<{ type: string; text: string }>
    expect(writeContent[0].text).toContain("ok")
    expect(writeContent[0].text).toContain("set_phase_scope")

    const readResult = await client.callTool({
      name: "read_ledger",
      arguments: { phase: "v75-p1", query: "full" },
    })
    const readContent = readResult.content as Array<{ type: string; text: string }>
    const text = readContent[0].text
    // read_ledger returns JSON-ish body; just check the scope fields are present
    expect(text).toContain("has_tests")
    expect(text).toContain("has_api")
    expect(text).toContain("has_build")
  })

  it("rejects unknown operation at the MCP surface", async () => {
    // The enum at server.ts line 167 is the MCP-surface gate.
    // Unknown operation should produce an error response rather than a silent pass-through.
    const result = await client.callTool({
      name: "write_ledger",
      arguments: {
        operation: "set_phase_scope_typo" as any,
        phase: "v75-p1",
        data: { has_tests: true, has_api: false, has_build: true },
      },
    })
    // MCP client errors are surfaced via `isError: true` on the result
    expect(result.isError).toBe(true)
  })

  it("write_ledger tool inputSchema.operation enum includes set_phase_scope", async () => {
    const result = await client.listTools()
    const writeLedgerTool = result.tools.find((t) => t.name === "write_ledger")
    expect(writeLedgerTool).toBeDefined()
    const operationSchema = (writeLedgerTool!.inputSchema as any).properties.operation
    expect(operationSchema.enum).toContain("set_phase_scope")
    expect(operationSchema.enum).toContain("set_unit_status")
    expect(operationSchema.enum).toContain("set_verdict")
    expect(operationSchema.enum).toContain("add_rejection")
    expect(operationSchema.enum).toContain("update_phase_gate")
  })
})
