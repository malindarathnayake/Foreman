import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { KNOWN_HOSTS, getProfile } from "../src/lib/hostProfiles.js"
import { FOREMAN_WORKFLOWS, WORKFLOW_DEFS, agentEstimate } from "../src/lib/workflowDefs.js"
import { workflow, workflowThreadLimit, WORKFLOW_DESCRIPTION } from "../src/tools/workflow.js"
import { CODEX_AGENT_ROLES } from "../src/tools/codexAgentsInit.js"
import { hostStatus } from "../src/tools/hostStatus.js"
import { LedgerOperationDataSchemas } from "../src/types.js"
// @ts-expect-error Plain JavaScript smoke module owns host tool lists.
import { expectedToolsForHost } from "../scripts/publish-smoke.mjs"

const args = {
  "foreman-design-panel": { question: "Should the cache be bounded?" },
  "foreman-checkpoint-review": { phase: "p1", files: ["src/cache.ts"] },
  "foreman-triage": { reports: ["Cache grows without a limit."] },
  "foreman-design-gauntlet": { repo: "C:/repo", out_dir: "C:/out", slug: "cache", brief: "Bound the cache.", research_context: "One process.", topics: [{ key: "limits", q: "Which eviction policy?" }], grounding: "Read src/cache.ts.", design_requirements: "Bound memory.", attack_focus: "Races and memory limits." },
}
let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-workflow-test-")) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const env = () => ({ cwd: dir, home: path.join(dir, "home") })

describe("workflow host surface", () => {
  for (const host of KNOWN_HOSTS) it(`registers the exact ${host} tool surface`, async () => {
    const server = await createServer({ host, journalPath: path.join(dir, "journal.json") })
    const client = new Client({ name: "workflow-test", version: "1" })
    const [c, s] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(s)
      await client.connect(c)
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual(expectedToolsForHost(host).sort())
      const supported = host === "codex" || host === "cursor"
      expect(listed.tools.some((t) => t.name === "workflow")).toBe(supported)
      if (supported) {
        const result = await client.callTool({ name: "workflow", arguments: { name: "foreman-design-panel", args: {} } })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain("args.question")
        expect(getProfile(host).placeholders.workflows).toContain("workflow mode:'describe'")
        expect(hostStatus(host, undefined, env())).toContain("workflows: workflow")
      } else {
        expect(await workflow({ name: "foreman-design-panel", mode: "describe" }, host, env())).toContain("only in Codex and Cursor")
      }
    } finally { await client.close(); await server.close() }
  })
  it("keeps the description within the host clip", () => { expect(WORKFLOW_DESCRIPTION.length).toBeLessThan(1800) })
})

describe("definitions and procedures", () => {
  for (const name of FOREMAN_WORKFLOWS) {
    it(`${name} agrees with the existing Claude script metadata and required guards`, async () => {
      const def = WORKFLOW_DEFS[name]
      const script = await fs.readFile(new URL(`../src/workflows/${name}.js`, import.meta.url), "utf8")
      expect(script).toContain(`name: '${name}'`)
      const meta = script.slice(script.indexOf("export const meta"), script.indexOf("\n}\n", script.indexOf("export const meta")) + 2)
      expect([...meta.matchAll(/title: '([^']+)'/g)].map((m) => m[1])).toEqual(def.phases.map((p) => p.title))
      for (const field of Object.keys(def.args.shape)) expect(script, field).toMatch(new RegExp(`\\b${field}\\b`))
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
      const run = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", script.replace("export const meta", "const meta"))
      const unexpected = () => { throw new Error("reached execution before validation") }
      for (const [field, schema] of Object.entries(def.args.shape)) {
        if (schema.safeParse(undefined).success) continue
        const missing: Record<string, unknown> = { ...args[name] }
        delete missing[field]
        await expect(run(missing, unexpected, unexpected, unexpected, unexpected, unexpected)).rejects.toThrow(/needs args/)
      }
      expect(def.invariants).toEqual({ never_implements: true, never_writes_ledger: true, record_stage: "fan", user_arbitrates: true })
      if (name === "foreman-checkpoint-review" || name === "foreman-design-gauntlet") expect(script).toContain("stage: 'fan'")
      if (name === "foreman-design-gauntlet") expect(script).toContain("Nothing in the repository changes until the user approves")
      if (name === "foreman-triage") expect(script).toContain("Implementation is NOT part of this")
    })
    for (const host of ["codex", "cursor"] as const) {
      it(`${name} describes ${host} without args`, async () => {
        const text = await workflow({ name, mode: "describe" }, host, env())
        expect(text).toContain("Agent-count estimate:")
        expect(text).toContain("Cost: paid")
        for (const phase of WORKFLOW_DEFS[name].phases) expect(text).toContain(`${phase.title} [`)
      })
      it(`${name} renders an executable bounded ${host} procedure`, async () => {
        const text = await workflow({ name, args: args[name] }, host, env())
        expect(text).toContain(`1. Confirm ${name}`)
        expect(text).toContain("never write the ledger")
        expect(text).not.toContain("write_ledger")
        expect(text).toContain("Validated args")
        expect(text).toContain("partial")
        expect(text).toContain("Result schema:")
        expect(text).toContain("sequentially in the main session")
        const batches = [...text.matchAll(/batch size <= (\d+)/g)]
        expect(batches.length).toBeGreaterThan(0)
        for (const m of batches) expect(Number(m[1])).toBeLessThanOrEqual(6)
        for (const m of text.matchAll(/spawn_agent with role (\w+)/g)) expect(CODEX_AGENT_ROLES).toContain(m[1])
        expect(text).not.toMatch(/role (?:design|advisor|worker\w*)/)
        if (name === "foreman-design-gauntlet") {
          expect(text).toContain('invoke_advisor { cli: "claude"')
          expect(text).toContain('cli: "gemini"')
          expect(text).not.toContain("codex exec")
          expect(text).toContain("BOTH Perplexity")
          expect(text).toContain("Codex web search")
          expect(text).toContain("raw advisor output")
          expect(text).toContain("receipt stays separate")
        }
      })
    }
  }
  it("counts output-dependent fanouts and honors chosen lenses", () => {
    const def = WORKFLOW_DEFS["foreman-design-panel"]
    expect(agentEstimate(def, def.args.parse(args[def.name]))).toEqual([10, 10])
    expect(agentEstimate(def, def.args.parse({ question: "q", stances: ["s"] }))).toEqual([4, 4])
    const gauntlet = WORKFLOW_DEFS["foreman-design-gauntlet"]
    expect(agentEstimate(gauntlet, gauntlet.args.parse({ ...args[gauntlet.name], lenses: ["soc"], max_verifiers: 2 }))).toEqual([5, 7])
  })
  it("returns checkpoint findings compatible with record_review", () => {
    const reportSchema = WORKFLOW_DEFS["foreman-checkpoint-review"].phases[2].tasks[0].result
    const report = reportSchema.parse({ advisor: "workflow-fan", stage: "fan", completion: "partial", checked: ["src/cache.ts:12"], limitations: "Second verification missing.", findings: [{ severity: "high", file: "src/cache.ts", line: "12", description: "Cache limit cannot be verified.", classification: "unverified" }] })
    expect(LedgerOperationDataSchemas.record_review.safeParse(report).success).toBe(true)
  })
  it("refuses invalid fields, unknown args and traversal slugs", async () => {
    const bad = await workflow({ name: "foreman-design-gauntlet", args: { ...args["foreman-design-gauntlet"], slug: "../escape", topics: [], max_verifiers: 0 } }, "codex", env())
    expect(bad).toContain("SCHEMA ERROR")
    for (const field of ["slug", "topics", "max_verifiers"]) expect(bad.match(new RegExp(`args\\.${field}:`, "g"))).toHaveLength(1)
    expect(await workflow({ name: "foreman-design-panel", args: { question: "q", surprise: true } }, "codex", env())).toContain("SCHEMA ERROR")
  })
  it("uses worker_heavy's effective model for read-only Codex design and respects explicit overrides", async () => {
    await fs.mkdir(path.join(dir, ".codex", "agents"), { recursive: true })
    await fs.writeFile(path.join(dir, ".codex", "agents", "worker_heavy.toml"), 'model = "test-heavy"\n')
    const input = { name: "foreman-design-gauntlet", args: args["foreman-design-gauntlet"] }
    const result = await workflow(input, "codex", env())
    expect(result).toContain('Use worker_heavy\'s model "test-heavy"')
    expect(result).toContain("read-only reviewer role")
    expect(result).not.toContain("spawn_agent with role worker_heavy")
    expect(await workflow({ ...input, args: { ...input.args, model_design: "chosen-design" } }, "codex", env())).toContain("Design model: chosen-design")
  })
})

describe("batch configuration", () => {
  it("uses project before user, caps at 12 and ignores unrelated tables", async () => {
    for (const root of [dir, env().home]) await fs.mkdir(path.join(root, ".codex"), { recursive: true })
    const project = path.join(dir, ".codex", "config.toml")
    await fs.writeFile(path.join(env().home, ".codex", "config.toml"), "[agents]\nmax_threads = 2\n")
    expect((await workflowThreadLimit(env())).count).toBe(2)
    await fs.writeFile(project, "[other]\nmax_threads = 1\n[agents]\nmax_threads = 3 # comment\n[next]\nmax_threads = 8\n")
    expect((await workflowThreadLimit(env())).count).toBe(3)
    const text = await workflow({ name: "foreman-design-panel", args: args["foreman-design-panel"] }, "codex", env())
    expect(text).toContain("batch size <= 3")
    expect(text).not.toContain("batch size <= 6")
    await fs.writeFile(project, "[agents]\nmax_threads = 99\n")
    expect((await workflowThreadLimit(env())).count).toBe(12)
    await fs.writeFile(project, '[agents]\nmax_threads = "unknown"\n')
    expect((await workflowThreadLimit(env())).count).toBe(1)
    await fs.writeFile(project, '[agents]\nmax_threads = 8\nmax_concurrent_threads_per_session = 2\n')
    expect((await workflowThreadLimit(env())).count).toBe(2)
    await fs.writeFile(project, 'agents.max_threads = 1\n')
    expect((await workflowThreadLimit(env())).count).toBe(1)
  })
})
