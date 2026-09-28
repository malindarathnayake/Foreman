// 0.6.31: Cursor host mode recorded a delegation's tier as audit evidence but told every
// worker to be Task + generalPurpose + a hardcoded model slug, so `tier: "premium"` was a
// promise the operator kept by hand. Claude Code and Codex already resolve the tier to a
// seat definition; Cursor has the same mechanism (`.cursor/agents/*.md` with a model in
// frontmatter). Default is inherit: Cursor ids rotate, and a guessed slug would reproduce
// the stale-hardcode this exists to remove.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  cursorAgentsInit,
  cursorAgentMarkdown,
  CURSOR_SEAT_MODELS,
  CURSOR_AGENT_ROLES,
  CURSOR_INHERIT_MODEL,
} from "../src/tools/cursorAgentsInit.js"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-cursor-agents-")) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const read = (role: string) => fs.readFile(path.join(dir, ".cursor", "agents", `${role}.md`), "utf-8")

describe("cursor_agents_init writes Cursor-native seats", () => {
  it("writes all three seats with inherit in frontmatter, creating the directory", async () => {
    const out = await cursorAgentsInit({ project_dir: dir })
    expect(out).toContain("status: ok")
    expect(out).toContain(".cursor/agents/")
    for (const role of CURSOR_AGENT_ROLES) {
      const body = await read(role)
      expect(body).toMatch(new RegExp(`^name: ${role}$`, "m"))
      expect(body).toMatch(new RegExp(`^model: "${CURSOR_SEAT_MODELS[role]}"$`, "m"))
      expect(body).toContain("NEVER run git stash, reset, checkout")
      expect(body).toContain("Do not spawn further subagents")
      expect(body).toContain("Do not call Foreman write tools")
      expect(body).not.toMatch(/^effort:/m)
    }
    expect(await read("foreman-worker-light")).toMatch(/^model: "inherit"$/m)
    expect(await read("foreman-worker")).toMatch(/^model: "inherit"$/m)
    expect(await read("foreman-worker-heavy")).toMatch(/^model: "inherit"$/m)
  })

  it("does not write or touch .claude/agents", async () => {
    await fs.mkdir(path.join(dir, ".claude", "agents"), { recursive: true })
    const claudeSeat = path.join(dir, ".claude", "agents", "foreman-worker.md")
    await fs.writeFile(claudeSeat, "---\nname: foreman-worker\nmodel: sonnet\neffort: medium\n---\nmine\n")
    await cursorAgentsInit({ project_dir: dir })
    expect(await fs.readFile(claudeSeat, "utf-8")).toContain("mine")
    await expect(fs.readdir(path.join(dir, ".claude", "agents"))).resolves.toEqual(["foreman-worker.md"])
  })

  it("leaves an existing definition alone unless overwrite is asked for", async () => {
    await fs.mkdir(path.join(dir, ".cursor", "agents"), { recursive: true })
    const target = path.join(dir, ".cursor", "agents", "foreman-worker.md")
    await fs.writeFile(target, "---\nname: foreman-worker\nmodel: \"composer-2.5[]\"\n---\nmine\n")

    const skipped = await cursorAgentsInit({ project_dir: dir })
    expect(skipped).toContain(".cursor/agents/foreman-worker.md")
    expect(skipped).toContain("files_skipped")
    expect(await read("foreman-worker")).toContain("mine")

    await cursorAgentsInit({ project_dir: dir, overwrite: true })
    expect(await read("foreman-worker")).not.toContain("mine")
    expect(await read("foreman-worker")).toMatch(/^model: "inherit"$/m)
  })

  it("takes per-role model overrides and quotes ids that carry brackets", async () => {
    await cursorAgentsInit({
      project_dir: dir,
      models: { "foreman-worker-heavy": "claude-opus-5[effort=high]" },
    })
    expect(await read("foreman-worker-light")).toMatch(/^model: "inherit"$/m)
    expect(await read("foreman-worker-heavy")).toMatch(/^model: "claude-opus-5\[effort=high\]"$/m)
  })

  it("emits only keys the documented Cursor frontmatter set accepts", async () => {
    await cursorAgentsInit({ project_dir: dir })
    const fm = (await read("foreman-worker")).split("---")[1]
    const keys = fm.trim().split("\n").map((l) => l.split(":")[0].trim())
    const ACCEPTED = new Set(["name", "description", "model", "readonly", "is_background"])
    for (const k of keys) expect(ACCEPTED.has(k), k).toBe(true)
    expect(keys).toEqual(["name", "description", "model"])
  })

  it("writes only the roles asked for", async () => {
    await cursorAgentsInit({ project_dir: dir, roles: ["foreman-worker-heavy"] })
    const entries = await fs.readdir(path.join(dir, ".cursor", "agents"))
    expect(entries).toEqual(["foreman-worker-heavy.md"])
  })

  it("quotes the description and the model so colons and brackets cannot break YAML", () => {
    const md = cursorAgentMarkdown("x", 'tier: premium, and a "quoted" word', "claude-opus-5[effort=high]", "body")
    expect(md).toContain('description: "tier: premium, and a \\"quoted\\" word"')
    expect(md).toContain('model: "claude-opus-5[effort=high]"')
    expect(md).not.toContain("effort:")
  })

  it("defaults every seat to inherit", () => {
    for (const role of CURSOR_AGENT_ROLES) {
      expect(CURSOR_SEAT_MODELS[role]).toBe(CURSOR_INHERIT_MODEL)
    }
  })
})

describe("cursor_agents_init is registered only on the cursor host", () => {
  let server: McpServer | undefined
  let client: Client | undefined
  afterEach(async () => {
    await client?.close()
    await server?.close()
    client = undefined
    server = undefined
  })

  async function toolNames(host: "claude-code" | "cursor" | "codex"): Promise<string[]> {
    server = await createServer({ host, ledgerPath: path.join(dir, "ledger.json"), docsDir: dir })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: "cursor-agents-host-test", version: "1" })
    await client.connect(ct)
    return (await client.listTools()).tools.map((t) => t.name)
  }

  it("registers on cursor and is absent on claude-code and codex", async () => {
    expect(await toolNames("cursor")).toContain("cursor_agents_init")
    await client?.close(); await server?.close()
    expect(await toolNames("claude-code")).not.toContain("cursor_agents_init")
    await client?.close(); await server?.close()
    expect(await toolNames("codex")).not.toContain("cursor_agents_init")
  })
})
