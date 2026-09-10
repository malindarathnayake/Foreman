import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { getProfile, hostRuntimePreamble, KNOWN_HOSTS, type HostId } from "../src/lib/hostProfiles.js"
import { hostStatus } from "../src/tools/hostStatus.js"

let server: McpServer | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  await server?.close()
  client = undefined
  server = undefined
})

async function tools(host: HostId, dir: string): Promise<string[]> {
  server = await createServer({ host, ledgerPath: path.join(dir, "ledger.json"), docsDir: dir })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  client = new Client({ name: "workflows-host-test", version: "1" })
  await client.connect(ct)
  return (await client.listTools()).tools.map((t) => t.name)
}

describe("saved workflows are a Claude Code surface only", () => {
  it("the claude-code preamble names the hook, the confirmation, and the fan-not-seat rule; other hosts say there is no surface", () => {
    const cc = hostRuntimePreamble("claude-code")
    expect(cc).toContain("**Workflows:**")
    expect(cc).toContain("claude_workflows_init")
    expect(cc).toContain("foreman-checkpoint-review")
    expect(cc).toContain("AskUserQuestion")
    expect(cc).toContain("never a gate seat")
    expect(cc).toContain("Never implement inside a workflow")
    for (const host of KNOWN_HOSTS.filter((h) => h !== "claude-code")) {
      const text = hostRuntimePreamble(host)
      expect(text, host).toContain("**Workflows:** No saved-workflow surface on this host")
      expect(text, host).not.toContain("claude_workflows_init")
      expect(getProfile(host).placeholders.workflows).not.toContain("foreman-")
    }
  })
  it("host_status reports the surface on claude-code only", () => {
    expect(hostStatus("claude-code")).toContain("workflows: claude_workflows_init installs foreman-checkpoint-review")
    for (const host of KNOWN_HOSTS.filter((h) => h !== "claude-code")) expect(hostStatus(host), host).not.toContain("claude_workflows_init")
  })
  it("the tool is registered on claude-code and absent elsewhere", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-wf-host-"))
    try {
      expect(await tools("claude-code", dir)).toContain("claude_workflows_init")
      await client?.close(); await server?.close()
      expect(await tools("codex", dir)).not.toContain("claude_workflows_init")
      await client?.close(); await server?.close()
      expect(await tools("cursor", dir)).not.toContain("claude_workflows_init")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
