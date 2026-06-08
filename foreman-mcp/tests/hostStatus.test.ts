import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/server.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { hostStatus } from "../src/tools/hostStatus.js"

describe("hostStatus — direct unit", () => {
  it("claude-code host reports sonnet worker + codex/gemini advisors", () => {
    const out = hostStatus("claude-code")
    expect(out).toContain("host: claude-code")
    expect(out).toContain("worker_model: sonnet")
    // advisor_a / advisor_b for claude-code do not declare model: "..." slugs
    // (they invoke a CLI), so the model hint is "n/a".
    expect(out).toContain("advisor_a_model: n/a")
    expect(out).toContain("advisor_b_model: n/a")
  })

  it("cursor host reports sonnet-4.6 worker + GPT-5.5/Gemini-3.1 advisors", () => {
    const out = hostStatus("cursor")
    expect(out).toContain("host: cursor")
    expect(out).toContain("worker_model: claude-4.6-sonnet-medium-thinking")
    expect(out).toContain("advisor_a_model: gpt-5.5-high")
    expect(out).toContain("advisor_b_model: gemini-3.1-pro")
    expect(out).toContain("advisor_b_fallback: composer-2-fast")
  })
})

describe("host_status — MCP round-trip", () => {
  let server: McpServer
  let client: Client

  async function setup(host?: "claude-code" | "cursor" | "codex") {
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

  it("default server reports claude-code host", async () => {
    await setup()
    const result = await client.callTool({ name: "host_status", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("host: claude-code")
    expect(content[0].text).toContain("worker_model: sonnet")
  })

  it("cursor-configured server reports cursor host with Cursor-specific models", async () => {
    await setup("cursor")
    const result = await client.callTool({ name: "host_status", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: cursor")
    expect(content[0].text).toContain("worker_model: claude-4.6-sonnet-medium-thinking")
    expect(content[0].text).toContain("advisor_a_model: gpt-5.5-high")
    expect(content[0].text).toContain("advisor_b_model: gemini-3.1-pro")
  })

  it("host_status tool is listed and has expected description shape", async () => {
    await setup()
    const result = await client.listTools()
    const tool = result.tools.find((t) => t.name === "host_status")
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/host/i)
    expect(tool!.description).toMatch(/cursor/i)
  })

  it("activator tool output includes host header (claude-code)", async () => {
    await setup()
    const result = await client.callTool({ name: "pitboss_implementor", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: claude-code")
  })

  it("activator tool output includes host header (cursor) and rendered Task subagent text", async () => {
    await setup("cursor")
    const result = await client.callTool({ name: "pitboss_implementor", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: cursor")
    expect(content[0].text).toContain("Task")
    expect(content[0].text).toContain("claude-4.6-sonnet-medium-thinking")
  })

  it("capability_check returns synthetic-available under cursor host (MCP surface)", async () => {
    await setup("cursor")
    const result = await client.callTool({
      name: "capability_check",
      arguments: { cli: "codex" },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("mechanism: cursor_subagent")
    expect(content[0].text).toContain("model: gpt-5.5-high")
  })
})
