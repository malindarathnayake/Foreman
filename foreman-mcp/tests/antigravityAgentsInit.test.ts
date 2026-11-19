import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import {
  ANTIGRAVITY_AGENT_ROLES,
  ANTIGRAVITY_READONLY_TOOLS,
  ANTIGRAVITY_RULE_BODY,
  ANTIGRAVITY_WORKER_TOOLS,
  antigravityAgentsInit,
} from "../src/tools/antigravityAgentsInit.js"
import { WORKER_MODELS_FILE } from "../src/lib/workerSeats.js"

function frontmatter(text: string): Record<string, string> {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
  return Object.fromEntries(header.split(/\r?\n/).map((l) => {
    const i = l.indexOf(":")
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }))
}

describe("antigravity_agents_init", () => {
  let dir: string
  let home: string
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ag-init-"))
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "ag-home-"))
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  })

  const read = (rel: string) => fsp.readFile(path.join(dir, rel), "utf8")

  it("pins the agy tool names exactly", () => {
    expect([...ANTIGRAVITY_WORKER_TOOLS]).toEqual(["read_file", "edit_file", "write_file", "run_command", "manage_task"])
    expect([...ANTIGRAVITY_READONLY_TOOLS]).toEqual(["read_file"])
  })

  it("writes six seat files and the rule with the verified frontmatter", async () => {
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(out).toContain("status: ok")
    expect(out).toContain("New agent files load in a new agy session.")
    const expected: Record<string, { model: string; tools: string }> = {
      "foreman-worker-light": { model: "flash", tools: "[read_file, edit_file, write_file, run_command, manage_task]" },
      "foreman-worker": { model: "flash", tools: "[read_file, edit_file, write_file, run_command, manage_task]" },
      "foreman-worker-heavy": { model: "pro", tools: "[read_file, edit_file, write_file, run_command, manage_task]" },
      "foreman-worker-frontier": { model: "pro", tools: "[read_file, edit_file, write_file, run_command, manage_task]" },
      "foreman-reviewer": { model: "pro", tools: "[read_file]" },
      "foreman-verifier": { model: "pro", tools: "[read_file]" },
    }
    expect(Object.keys(expected).sort()).toEqual([...ANTIGRAVITY_AGENT_ROLES].sort())
    for (const [role, want] of Object.entries(expected)) {
      const fm = frontmatter(await read(`.agents/agents/${role}.md`))
      expect(Object.keys(fm)).toEqual(["name", "description", "subagent", "mainAgent", "inheritCustomizations", "inheritMcp", "model", "tools"])
      expect(fm).toMatchObject({
        name: role, subagent: "true", mainAgent: "false", inheritCustomizations: "false", inheritMcp: "false",
        model: want.model, tools: want.tools,
      })
      // Unquoted YAML scalars: a ": " or " #" in the description would change its meaning.
      expect(fm.description).not.toMatch(/: | #/)
    }
    expect(await read(".agents/rules/foreman.md")).toBe(ANTIGRAVITY_RULE_BODY)
  })

  it("reviewer and verifier bodies say the brief carries the diff and forbid writes", async () => {
    await antigravityAgentsInit({ project_dir: dir }, { home })
    for (const role of ["foreman-reviewer", "foreman-verifier"]) {
      const text = await read(`.agents/agents/${role}.md`)
      expect(text).toContain("brief carries the full diff")
      expect(text).toContain("Never write files.")
    }
    expect(await read(".agents/agents/foreman-worker.md")).toContain("Never call Foreman tools")
  })

  it("keeps the rule under 1 KB with the exact bootstrap text", () => {
    expect(Buffer.byteLength(ANTIGRAVITY_RULE_BODY, "utf8")).toBeLessThan(1024)
    expect(ANTIGRAVITY_RULE_BODY).toMatch(/^---\ntrigger: always_on\n---\n/)
    expect(ANTIGRAVITY_RULE_BODY).toContain('call_mcp_tool ServerName:"foreman" ToolName:"session_orient"')
    expect(ANTIGRAVITY_RULE_BODY).toContain("If you are a subagent (worker, reviewer or verifier), ignore this rule")
  })

  it("refuses a concrete model id and writes nothing", async () => {
    const out = await antigravityAgentsInit({ project_dir: dir, models: { "foreman-worker-heavy": "gemini-4-hydrogen-xhigh" } }, { home })
    expect(out).toContain("error: model_not_tier_word")
    await expect(fsp.access(path.join(dir, ".agents"))).rejects.toThrow()
  })

  it("accepts a tier-word override", async () => {
    await antigravityAgentsInit({ project_dir: dir, roles: ["foreman-worker"], models: { "foreman-worker": "pro" } }, { home })
    expect(frontmatter(await read(".agents/agents/foreman-worker.md")).model).toBe("pro")
  })

  it("never writes a concrete id from the mapping file into frontmatter", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { premium: "gemini-4-hydrogen-tiered-xhigh", cheap: "flash_lite" } }))
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(frontmatter(await read(".agents/agents/foreman-worker-heavy.md")).model).toBe("pro")
    expect(frontmatter(await read(".agents/agents/foreman-worker-light.md")).model).toBe("flash_lite")
    expect(out).toMatch(/warnings: .*gemini-4-hydrogen-tiered-xhigh/)
  })

  it("writes the tier word that serves a measured served id from the mapping file", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { standard: "gemini-4-hydrogen-tiered-xhigh" } }))
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(out).toContain("status: ok")
    expect(frontmatter(await read(".agents/agents/foreman-worker.md")).model).toBe("pro")
  })

  it("refuses a mapping id the verdict could never match and writes nothing", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { premium: "gemini-4-hydrogen-xhigh" } }))
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(out).toContain("error: mapping_not_enforceable")
    expect(out).toContain("gemini-4-hydrogen-tiered-xhigh (pro)")
    await expect(fsp.access(path.join(dir, ".agents"))).rejects.toThrow()
  })

  it("refuses a tier override that conflicts with a served id in the mapping file", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { premium: "gemini-4-hydrogen-tiered-xhigh" } }))
    const out = await antigravityAgentsInit({ project_dir: dir, models: { "foreman-worker-heavy": "flash" } }, { home })
    expect(out).toContain("error: mapping_conflict")
  })

  it("reports an existing seat file that drifted from the template", async () => {
    await antigravityAgentsInit({ project_dir: dir }, { home })
    const clean = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(clean).toContain("seat_drift: none")
    expect(clean).not.toContain("isolation:")
    const file = path.join(dir, ".agents", "agents", "foreman-reviewer.md")
    await fsp.writeFile(file, (await read(".agents/agents/foreman-reviewer.md")).replace("tools: [read_file]", "tools: [read_file, call_mcp_tool]"))
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(out).toMatch(/seat_drift: \.agents\/agents\/foreman-reviewer\.md \(differs from the Foreman template\)/)
    expect(out).toMatch(/isolation: unverified/)
    expect(out).toMatch(/hints: drifted seat files/)
  })

  it("worker discipline forbids nested agent CLIs and seat edits", async () => {
    await antigravityAgentsInit({ project_dir: dir, roles: ["foreman-worker"] }, { home })
    const text = await read(".agents/agents/foreman-worker.md")
    expect(text).toContain("Never start agy, gemini, claude, codex or foreman-mcp from run_command")
    expect(text).toContain("never edit files\nunder .agents/")
  })

  it("skips existing files unless overwrite is set", async () => {
    await fsp.mkdir(path.join(dir, ".agents", "agents"), { recursive: true })
    await fsp.mkdir(path.join(dir, ".agents", "rules"), { recursive: true })
    await fsp.writeFile(path.join(dir, ".agents", "agents", "foreman-worker.md"), "custom")
    await fsp.writeFile(path.join(dir, ".agents", "rules", "foreman.md"), "custom rule")
    const out = await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(out).toMatch(/files_skipped: .*\.agents\/agents\/foreman-worker\.md/)
    expect(out).toMatch(/files_skipped: .*\.agents\/rules\/foreman\.md/)
    expect(await read(".agents/agents/foreman-worker.md")).toBe("custom")
    expect(await read(".agents/rules/foreman.md")).toBe("custom rule")
    await antigravityAgentsInit({ project_dir: dir, overwrite: true }, { home })
    expect(await read(".agents/agents/foreman-worker.md")).toContain("name: foreman-worker")
    expect(await read(".agents/rules/foreman.md")).toBe(ANTIGRAVITY_RULE_BODY)
  })

  it("rule: false leaves the rule alone", async () => {
    await antigravityAgentsInit({ project_dir: dir, rule: false }, { home })
    await expect(fsp.access(path.join(dir, ".agents", "rules"))).rejects.toThrow()
  })

  it("refuses a project directory under ~/.gemini", async () => {
    const gemini = path.join(home, ".gemini", "config")
    await fsp.mkdir(gemini, { recursive: true })
    const out = await antigravityAgentsInit({ project_dir: gemini }, { home })
    expect(out).toContain("error: project_dir_refused")
    await expect(fsp.access(path.join(gemini, ".agents"))).rejects.toThrow()
  })

  it("refuses a missing project directory", async () => {
    const out = await antigravityAgentsInit({ project_dir: path.join(dir, "nope") }, { home })
    expect(out).toContain("error: project_dir_invalid")
  })

  it("refuses when .agents is a link that leaves the project", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "ag-out-"))
    try {
      try { await fsp.symlink(outside, path.join(dir, ".agents"), "junction") }
      catch { return } // Symlinks unavailable to this user: nothing to test.
      await expect(antigravityAgentsInit({ project_dir: dir }, { home })).rejects.toThrow(/outside the project directory/)
      expect(await fsp.readdir(outside)).toEqual([])
    } finally {
      await fsp.rm(path.join(dir, ".agents"), { force: true, recursive: false }).catch(() => {})
      await fsp.rm(outside, { recursive: true, force: true })
    }
  })

  it("writes only under the project directory", async () => {
    await antigravityAgentsInit({ project_dir: dir }, { home })
    expect(await fsp.readdir(home)).toEqual([])
    const files = (await fsp.readdir(dir, { recursive: true })).map((f) => f.replace(/\\/g, "/")).sort()
    expect(files.filter((f) => f.endsWith(".md"))).toEqual([
      ".agents/agents/foreman-reviewer.md", ".agents/agents/foreman-verifier.md", ".agents/agents/foreman-worker-frontier.md",
      ".agents/agents/foreman-worker-heavy.md", ".agents/agents/foreman-worker-light.md", ".agents/agents/foreman-worker.md",
      ".agents/rules/foreman.md",
    ])
  })
})
