import { describe, it, expect, afterEach } from "vitest"
import fs from "fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "../src/server.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

// The smoke script is the single owner of the expected-tool list (1g); this
// invariant makes drift between that list and the live registry a test failure.
// @ts-expect-error — plain .mjs module without type declarations
import { EXPECTED_TOOLS } from "../scripts/publish-smoke.mjs"

let server: McpServer
let client: Client

async function setupServer(): Promise<void> {
  server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "release-invariants-test", version: "1.0.0" })
  await client.connect(clientTransport)
}

afterEach(async () => {
  await client?.close()
  await server?.close()
})

async function readPackageJson(): Promise<{ version: string }> {
  const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf-8")
  return JSON.parse(raw) as { version: string }
}

async function readRootChangelog(): Promise<string> {
  return fs.readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf-8")
}

describe("release invariants", () => {
  it("package.json version === server-reported version", async () => {
    await setupServer()
    const pkg = await readPackageJson()
    expect(client.getServerVersion()?.version).toBe(pkg.version)
  })

  it("package.json version === newest CHANGELOG heading", async () => {
    const pkg = await readPackageJson()
    const changelog = await readRootChangelog()
    const match = changelog.match(/^## (\d+\.\d+\.\d+)/m)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe(pkg.version)
  })

  it("every workflow pins node-version 22", async () => {
    const workflowsDir = new URL("../../.github/workflows/", import.meta.url)
    const entries = await fs.readdir(workflowsDir)
    const workflowFiles = entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    expect(workflowFiles.length).toBeGreaterThan(0)

    let occurrences = 0
    for (const file of workflowFiles) {
      const contents = await fs.readFile(new URL(file, workflowsDir), "utf-8")
      const matches = contents.matchAll(/node-version:\s*['"]?([^\s'"]+)['"]?/g)
      for (const m of matches) {
        occurrences += 1
        expect(m[1]).toBe("22")
      }
    }
    expect(occurrences).toBeGreaterThan(0)
  })

  it("publish-smoke EXPECTED_TOOLS matches the live registry", async () => {
    await setupServer()
    const result = await client.listTools()
    const actualNames = result.tools.map((t) => t.name).sort()
    const expectedNames = [...EXPECTED_TOOLS].sort()
    expect(actualNames).toEqual(expectedNames)
  })
})
