import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { hostStatus } from "../src/tools/hostStatus.js"
import fsp from "fs/promises"
import os from "os"
import path from "path"

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

  it("cursor host reports inherit seat table + Agent CLI advisors (no stale Task slugs)", () => {
    const out = hostStatus("cursor")
    expect(out).toContain("host: cursor")
    expect(out).toContain("foreman-worker-light=inherit")
    expect(out).toContain("foreman-worker-heavy=inherit")
    expect(out).toContain("cursor_agents_init")
    expect(out).toContain("agent (alias cursor-agent)")
    expect(out).toContain("cursor --add-mcp")
    expect(out).not.toContain("claude-4.6-sonnet-medium-thinking")
    expect(out).toContain("advisor_a_model: n/a")
    expect(out).toContain("advisor_b_model: n/a")
    expect(out).not.toContain("gpt-5.6-sol-ultra")
    expect(out).not.toContain("gemini-3.1-pro")
  })

  it("codex host reports Claude Fable 5 advisor and host-selected worker", () => {
    const out = hostStatus("codex")
    expect(out).toContain("host: codex")
    expect(out).toContain("display_name: Codex")
    // v0.6.15: the seat table replaces the single scraped slug for Codex.
    expect(out).toContain("worker_light=gpt-5.6-terra")
    expect(out).toContain("advisor_a_model: claude-fable-5")
    expect(out).toContain("unsupported_capabilities: autonomy")
  })

  it("claude-code host echoes no unsupported capabilities", () => {
    const out = hostStatus("claude-code")
    expect(out).toContain("unsupported_capabilities: none")
  })

  it("cursor host echoes autonomy as unsupported", () => {
    const out = hostStatus("cursor")
    expect(out).toContain("unsupported_capabilities: autonomy")
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

  it("cursor-configured server reports cursor host with Agent CLI, not Task model slugs", async () => {
    await setup("cursor")
    const result = await client.callTool({ name: "host_status", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: cursor")
    expect(content[0].text).toContain("foreman-worker-light=inherit")
    expect(content[0].text).toContain("agent (alias cursor-agent)")
    expect(content[0].text).not.toContain("gpt-5.6-sol-ultra")
    expect(content[0].text).not.toContain("gemini-3.1-pro")
  })

  it("codex-configured server reports native Codex profile and Claude advisor", async () => {
    await setup("codex")
    const result = await client.callTool({ name: "host_status", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: codex")
    expect(content[0].text).toContain("display_name: Codex")
    expect(content[0].text).toContain("advisor_a_model: claude-fable-5")
  })

  it("codex activator renders spawn_agent and Claude Fable advisor", async () => {
    await setup("codex")
    const result = await client.callTool({ name: "pitboss_implementor", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: codex")
    expect(content[0].text).toContain("spawn_agent")
    expect(content[0].text).toContain("worker_heavy")
    expect(content[0].text).toContain("claude-fable-5")
    expect(content[0].text).not.toContain("{{advisor_checks}}")
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

  it("activator tool output includes host header (cursor) and Agent CLI spawn text", async () => {
    await setup("cursor")
    const result = await client.callTool({ name: "pitboss_implementor", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("host: cursor")
    expect(content[0].text).toContain("agent")
    expect(content[0].text).toContain("foreman-worker")
    expect(content[0].text).toContain("cursor_agents_init")
    expect(content[0].text).toContain("Task")
    expect(content[0].text).not.toContain("claude-4.6-sonnet-medium-thinking")
  })

  it("capability_check on cursor host probes the real CLI, not a synthetic Task seat", async () => {
    await setup("cursor")
    const result = await client.callTool({
      name: "capability_check",
      arguments: { cli: "codex" },
    })
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).not.toContain("cursor_subagent")
    expect(content[0].text).toContain("cli: codex")
    expect(content[0].text).toMatch(/auth_status: /)
  })
})

// 0.6.34 (Codex adversarial review 2026-09-25): host_status printed the shipped seat table as
// if it were the active pins, and said nothing about Codex's 60s default tool timeout.
describe("codex host_status reports what is on disk", () => {
  let cwd: string
  let home: string
  beforeEach(async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hs-cwd-"))
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "hs-home-"))
  })
  afterEach(async () => {
    await fsp.rm(cwd, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  })

  it("labels the table as defaults and reads the pin written in the project", async () => {
    await fsp.mkdir(path.join(cwd, ".codex", "agents"), { recursive: true })
    await fsp.writeFile(path.join(cwd, ".codex", "agents", "worker.toml"), 'name = "worker"\nmodel = "gpt-5.6-sol"\n')
    const out = hostStatus("codex", undefined, { cwd, home })
    expect(out).toContain("seat_defaults: worker_light=gpt-5.6-terra worker=gpt-6-sol")
    expect(out).toContain("worker=gpt-5.6-sol")
    expect(out).toContain("worker_light=missing")
    expect(out).not.toContain("worker_model:")
  })

  it("advises a longer tool timeout when none is set", () => {
    const out = hostStatus("codex", undefined, { cwd, home })
    expect(out).toContain("seat_pins_on_disk: none (run codex_agents_init)")
    expect(out).toContain("tool_timeout_sec: unset (Codex default 60)")
    expect(out).toMatch(/tool_timeout_advice: .*tool_timeout_sec = 1200/)
  })

  it("stays quiet when the foreman table sets a long enough timeout", async () => {
    await fsp.mkdir(path.join(home, ".codex"), { recursive: true })
    await fsp.writeFile(path.join(home, ".codex", "config.toml"),
      '[mcp_servers.foreman]\ncommand = "foreman-mcp"\ntool_timeout_sec = 1800\n\n[mcp_servers.other]\ntool_timeout_sec = 5\n')
    const out = hostStatus("codex", undefined, { cwd, home })
    expect(out).toMatch(/tool_timeout_sec: 1800 \(/)
    expect(out).not.toContain("tool_timeout_advice")
  })
})

// 0.9.7: the antigravity block reports the tier-word seat table, the bootstrap rule and the
// MCP call timeout from what is on disk.
describe("antigravity host_status", () => {
  let cwd: string
  let home: string
  beforeEach(async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "hs-ag-cwd-"))
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "hs-ag-home-"))
  })
  afterEach(async () => {
    await fsp.rm(cwd, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  })

  it("reports missing seats and rule, native review and Claude/Codex advisors", () => {
    const out = hostStatus("antigravity", undefined, { cwd, home })
    expect(out).toContain("host: antigravity")
    expect(out).toContain("worker_model: missing (run antigravity_agents_init)")
    expect(out).toMatch(/bootstrap_rule: missing/)
    expect(out).toContain("review_mode: native-subagents")
    expect(out).toContain("review_stage: native")
    expect(out).toMatch(/external_advisors: optional: claude,codex/)
    expect(out).toContain("gemini-4-hydrogen-tiered-xhigh")
    expect(out).toMatch(/mcp_timeout_sec: unknown \(set timeoutSeconds: 1200/)
    expect(out).not.toContain("workflows:")
  })

  it("reads the seat table and the rule written by antigravity_agents_init", async () => {
    const { antigravityAgentsInit } = await import("../src/tools/antigravityAgentsInit.js")
    await antigravityAgentsInit({ project_dir: cwd }, { home })
    const out = hostStatus("antigravity", undefined, { cwd, home })
    expect(out).toContain("foreman-worker-light=flash foreman-worker=flash foreman-worker-heavy=pro foreman-worker-frontier=pro foreman-reviewer=pro foreman-verifier=pro")
    expect(out).toContain("bootstrap_rule: present")
  })

  it("counts the global rule as present", async () => {
    await fsp.mkdir(path.join(home, ".gemini", "config", "rules"), { recursive: true })
    await fsp.writeFile(path.join(home, ".gemini", "config", "rules", "foreman.md"), "---\ntrigger: always_on\n---\n")
    expect(hostStatus("antigravity", undefined, { cwd, home })).toContain("bootstrap_rule: present")
  })

  it("reads timeoutSeconds from valid JSON and advises when it is short", async () => {
    await fsp.mkdir(path.join(home, ".gemini", "config"), { recursive: true })
    const file = path.join(home, ".gemini", "config", "mcp_config.json")
    await fsp.writeFile(file, JSON.stringify({ mcpServers: { foreman: { command: "foreman-mcp", timeoutSeconds: 1200 } } }))
    expect(hostStatus("antigravity", undefined, { cwd, home })).toMatch(/mcp_timeout_sec: 1200 \([^;]*\)/)
    await fsp.writeFile(file, JSON.stringify({ mcpServers: { foreman: { timeoutSeconds: 180 } } }))
    expect(hostStatus("antigravity", undefined, { cwd, home })).toMatch(/mcp_timeout_sec: 180 \(.*set timeoutSeconds: 1200/)
  })

  it("the workspace config wins over the user config", async () => {
    await fsp.mkdir(path.join(cwd, ".agents"), { recursive: true })
    await fsp.writeFile(path.join(cwd, ".agents", "mcp_config.json"), JSON.stringify({ mcpServers: { foreman: { timeoutSeconds: 1500 } } }))
    await fsp.mkdir(path.join(home, ".gemini", "config"), { recursive: true })
    await fsp.writeFile(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { foreman: { timeoutSeconds: 60 } } }))
    expect(hostStatus("antigravity", undefined, { cwd, home })).toMatch(/mcp_timeout_sec: 1500 \(/)
  })

  it("reports JSONC it cannot parse as unknown rather than guessing", async () => {
    await fsp.mkdir(path.join(home, ".gemini", "config"), { recursive: true })
    await fsp.writeFile(path.join(home, ".gemini", "config", "mcp_config.json"), '{ // comment\n "mcpServers": { "foreman": { "timeoutSeconds": 1200, } } }')
    expect(hostStatus("antigravity", undefined, { cwd, home })).toMatch(/mcp_timeout_sec: unknown/)
  })

  it("an unparseable workspace config makes the timeout unknown even when the user config parses", async () => {
    await fsp.mkdir(path.join(cwd, ".agents"), { recursive: true })
    await fsp.writeFile(path.join(cwd, ".agents", "mcp_config.json"), '{ // c\n "mcpServers": { "foreman": { "timeoutSeconds": 60 } } }')
    await fsp.mkdir(path.join(home, ".gemini", "config"), { recursive: true })
    await fsp.writeFile(path.join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: { foreman: { timeoutSeconds: 1200 } } }))
    const out = hostStatus("antigravity", undefined, { cwd, home })
    expect(out).toMatch(/mcp_timeout_sec: unknown/)
    expect(out).not.toMatch(/mcp_timeout_sec: 1200/)
  })

  it("reports no drift for freshly written seats and flags an edited seat", async () => {
    const { antigravityAgentsInit } = await import("../src/tools/antigravityAgentsInit.js")
    await antigravityAgentsInit({ project_dir: cwd }, { home })
    expect(hostStatus("antigravity", undefined, { cwd, home })).toContain("seat_drift: none")
    const file = path.join(cwd, ".agents", "agents", "foreman-reviewer.md")
    const text = await fsp.readFile(file, "utf8")
    await fsp.writeFile(file, text.replace("inheritMcp: false", "inheritMcp: true").replace(/\n/g, "\r\n"))
    expect(hostStatus("antigravity", undefined, { cwd, home }))
      .toMatch(/seat_drift: foreman-reviewer \(differs from the Foreman template\); isolation unverified/)
  })
})
