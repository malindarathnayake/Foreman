// 0.6.28: Foreman recorded a delegation's tier as audit evidence but, on Claude Code, the host
// profile told every worker to be sonnet — so `tier: "premium"` was a promise the operator kept
// by hand and restated each session. Codex already resolved the tier to a model through role
// config. Claude Code has the same mechanism (agent definitions carry their model in
// frontmatter); this writes the seats there.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { claudeAgentsInit, agentMarkdown, CLAUDE_SEAT_MODELS, CLAUDE_AGENT_ROLES } from "../src/tools/claudeAgentsInit.js"
import { resolveModelRank, modelRankSummary } from "../src/lib/modelRank.js"

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-agents-")) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const read = (role: string) => fs.readFile(path.join(dir, ".claude", "agents", `${role}.md`), "utf-8")

describe("claude_agents_init pins a model per implementation seat", () => {
  it("writes all three seats with the tier's model in frontmatter, creating the directory", async () => {
    const out = await claudeAgentsInit({ project_dir: dir })
    expect(out).toContain("status: ok")
    for (const role of CLAUDE_AGENT_ROLES) {
      const body = await read(role)
      expect(body).toMatch(new RegExp(`^name: ${role}$`, "m"))
      expect(body).toMatch(new RegExp(`^model: ${CLAUDE_SEAT_MODELS[role]}$`, "m"))
      // Every seat carries the shared-tree rule: a worker must never mutate repository state.
      expect(body).toContain("NEVER run git stash, reset, checkout")
      expect(body).toContain("Do not spawn further subagents")
    }
    expect(await read("foreman-worker-light")).toMatch(/^model: haiku$/m)
    expect(await read("foreman-worker")).toMatch(/^model: sonnet$/m)
    expect(await read("foreman-worker-heavy")).toMatch(/^model: opus$/m)
  })

  it("leaves an existing definition alone unless overwrite is asked for", async () => {
    await fs.mkdir(path.join(dir, ".claude", "agents"), { recursive: true })
    const target = path.join(dir, ".claude", "agents", "foreman-worker.md")
    await fs.writeFile(target, "---\nname: foreman-worker\nmodel: opus\n---\nmine\n")

    const skipped = await claudeAgentsInit({ project_dir: dir })
    expect(skipped).toContain(".claude/agents/foreman-worker.md")
    expect(skipped).toContain("files_skipped")
    expect(await read("foreman-worker")).toContain("mine")

    await claudeAgentsInit({ project_dir: dir, overwrite: true })
    expect(await read("foreman-worker")).not.toContain("mine")
    expect(await read("foreman-worker")).toMatch(/^model: sonnet$/m)
  })

  it("takes a per-role model override — an operator who wants no haiku in the loop", async () => {
    await claudeAgentsInit({ project_dir: dir, models: { "foreman-worker-light": "sonnet" } })
    expect(await read("foreman-worker-light")).toMatch(/^model: sonnet$/m)
    // the other seats keep their defaults
    expect(await read("foreman-worker-heavy")).toMatch(/^model: opus$/m)
  })

  it("writes only the roles asked for", async () => {
    await claudeAgentsInit({ project_dir: dir, roles: ["foreman-worker-heavy"] })
    const entries = await fs.readdir(path.join(dir, ".claude", "agents"))
    expect(entries).toEqual(["foreman-worker-heavy.md"])
  })

  it("quotes the description so a colon cannot break the frontmatter", () => {
    const md = agentMarkdown("x", 'tier: premium, and a "quoted" word', "opus", "body")
    expect(md).toContain('description: "tier: premium, and a \\"quoted\\" word"')
    expect(md.split("---")[1]).toContain("model: opus")
  })
})

describe("the declared rank says what the WORKER seat defaults to", () => {
  it("tells a frontier orchestrator not to spawn its own class for implementation", () => {
    const top = modelRankSummary(resolveModelRank("claude-fable-5-1"))
    expect(top.model_weight).toBe(3)
    expect(String(top.seat_guidance)).toContain("do not spawn frontier workers by default")
    // rank-keyed, not model-keyed: Astra at xhigh is the same expensive seat
    expect(String(modelRankSummary(resolveModelRank("gpt-6-astra", "xhigh")).seat_guidance))
      .toContain("do not spawn frontier workers by default")
  })

  it("gives every other rank the plain seat table instead of the cost reminder", () => {
    for (const m of ["claude-opus-5", "claude-sonnet-5", undefined]) {
      const s = String(modelRankSummary(resolveModelRank(m)).seat_guidance)
      expect(s).toContain("foreman-worker-light")
      expect(s).not.toContain("do not spawn frontier workers")
    }
  })
})
