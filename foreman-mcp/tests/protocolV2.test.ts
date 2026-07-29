import { execSync, spawnSync } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { beforeAll, describe, expect, it } from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, "..")
const serverPath = path.join(packageRoot, "dist", "server.js")

beforeAll(async () => {
  try {
    await fs.access(serverPath)
  } catch {
    execSync("npm run build", { cwd: packageRoot, stdio: "ignore" })
  }
}, 120_000)

describe("MCP SDK v2 protocol negotiation", () => {
  it("serves the 2026-07-28 era over stdio and calls a real Foreman tool", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-mcp-v2-"))
    const client = new Client(
      { name: "foreman-v2-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: { ...process.env, FOREMAN_NO_OPEN: "1", FOREMAN_COMPRESSION: "0" },
    })

    try {
      await client.connect(transport)
      expect(client.getProtocolEra()).toBe("modern")
      expect(client.getServerCapabilities()).toEqual({
        resources: { listChanged: true },
        tools: { listChanged: true },
      })

      const tools = await client.listTools()
      for (const tool of tools.tools) {
        expect(tool.title, `${tool.name} title`).toBeTypeOf("string")
        expect(tool.inputSchema, `${tool.name} input schema`).toMatchObject({
          type: "object",
          additionalProperties: false,
        })
        expect(tool.outputSchema, `${tool.name} output schema`).toMatchObject({
          type: "string",
        })
      }
      const bundleStatusTool = tools.tools.find((tool) => tool.name === "bundle_status")
      expect(bundleStatusTool).toMatchObject({
        name: "bundle_status",
        title: "Bundle Status",
        inputSchema: {
          type: "object",
          additionalProperties: false,
        },
        outputSchema: {
          type: "string",
        },
      })

      const result = await client.callTool({ name: "bundle_status", arguments: {} })
      expect(result).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("version") }),
        ]),
        structuredContent: expect.stringContaining("version"),
      })

      const invalidArgs = await client.callTool({
        name: "bundle_status",
        arguments: { unexpected: true },
      })
      expect(invalidArgs).toMatchObject({
        isError: true,
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('Unrecognized key: "unexpected"'),
          }),
        ]),
      })

      await expect(
        client.callTool({ name: "not_a_foreman_tool", arguments: {} })
      ).rejects.toMatchObject({ code: -32602 })
    } finally {
      await client.close()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it("keeps the 2025 legacy era compatible while projecting v2 scalar output", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-mcp-legacy-"))
    const client = new Client(
      { name: "foreman-legacy-test", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } }
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd,
      env: { ...process.env, FOREMAN_NO_OPEN: "1", FOREMAN_COMPRESSION: "0" },
    })

    try {
      await client.connect(transport)
      expect(client.getProtocolEra()).toBe("legacy")

      const tools = await client.listTools()
      const bundleStatusTool = tools.tools.find((tool) => tool.name === "bundle_status")
      expect(bundleStatusTool).toMatchObject({
        name: "bundle_status",
        title: "Bundle Status",
        inputSchema: {
          type: "object",
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: "string" },
          },
          required: ["result"],
        },
      })

      const result = await client.callTool({ name: "bundle_status", arguments: {} })
      expect(result).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("version") }),
        ]),
        structuredContent: {
          result: expect.stringContaining("version"),
        },
      })
    } finally {
      await client.close()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

  it("reports the split server SDK version in diagnostics", () => {
    const result = spawnSync(process.execPath, [serverPath, "--diag"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, FOREMAN_NO_OPEN: "1" },
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toMatch(/server SDK version\s+2\./)
    expect(result.stderr).not.toContain("UNKNOWN (could not read server package.json)")
  }, 30_000)
})
