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

describe("list tools — verify all 15 present, update_bundle absent", () => {
  beforeEach(async () => {
    await setupServer()
  })

  it("lists exactly 15 tools", async () => {
    const result = await client.listTools()
    expect(result.tools).toHaveLength(15)
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

  it("design-partner contains frontmatter, deliberation, and override notice", async () => {
    const result = await client.readResource({ uri: "skill://foreman/design-partner" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("name: foreman:design-partner")
    expect(text).toContain("version: 0.0.5")
    expect(text).toContain("mcp__foreman__capability_check")
    expect(text).toContain("Foreman MCP bundle")
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

  it("implementor contains disableSlashCommand, slash-command guard, and MCP tool refs", async () => {
    const result = await client.readResource({ uri: "skill://foreman/implementor" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("version: 0.0.5")
    expect(text).toContain("mcp__foreman__pitboss_implementor")
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
