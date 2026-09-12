import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BUNDLED_WORKFLOWS_DIR, FOREMAN_WORKFLOWS, claudeWorkflowsInit } from "../src/tools/claudeWorkflowsInit.js"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-workflows-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("bundled workflow scripts", () => {
  it("ship one script per workflow, each a valid Workflow script with a literal meta block naming itself", async () => {
    for (const name of FOREMAN_WORKFLOWS) {
      const body = await fs.readFile(path.join(BUNDLED_WORKFLOWS_DIR, `${name}.js`), "utf-8")
      expect(body).toMatch(/^\/\/ Foreman /)
      expect(body).toContain("export const meta = {")
      expect(body).toContain(`name: '${name}'`)
      // the harness resolves these globals; the script must use them, never Node APIs
      expect(body).toMatch(/\bagent\(/)
      expect(body).not.toMatch(/from ["']node:/)
      expect(body).not.toMatch(/\brequire\(/)
      // resume-safe: no wall clock or randomness
      expect(body).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random\(/)
      // The harness runs the script body inside an async function (top-level await and
      // return are legal there); parse it the same way so a syntax error fails here, not at run time.
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => unknown
      expect(() => new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", "workflow",
        body.replace("export const meta", "const meta"))).not.toThrow()
    }
  })
  it("the review workflow returns a fan record, never a seat", async () => {
    const body = await fs.readFile(path.join(BUNDLED_WORKFLOWS_DIR, "foreman-checkpoint-review.js"), "utf-8")
    expect(body).toContain("stage: 'fan'")
    expect(body).not.toContain("stage: 'independent'")
    expect(body).not.toContain("stage: 'native'")
  })
  it("the triage workflow never implements", async () => {
    const body = await fs.readFile(path.join(BUNDLED_WORKFLOWS_DIR, "foreman-triage.js"), "utf-8")
    expect(body).toContain("Implementation is NOT part of this")
    expect(body).not.toMatch(/isolation:\s*['"]worktree['"]/)
  })
})

describe("claude_workflows_init", () => {
  it("installs every script into .claude/workflows/ and skips existing files unless overwrite", async () => {
    const first = await claudeWorkflowsInit({ project_dir: dir })
    expect(first).toContain("status: ok")
    for (const name of FOREMAN_WORKFLOWS) {
      expect(first).toContain(`.claude/workflows/${name}.js`)
      const installed = await fs.readFile(path.join(dir, ".claude", "workflows", `${name}.js`), "utf-8")
      const bundled = await fs.readFile(path.join(BUNDLED_WORKFLOWS_DIR, `${name}.js`), "utf-8")
      expect(installed).toBe(bundled)
    }
    expect(first).toContain("usage: foreman-checkpoint-review: phase checkpoint review fan")
    expect(first).toContain("never counts as a gate seat")

    await fs.writeFile(path.join(dir, ".claude", "workflows", "foreman-triage.js"), "// user-edited\n")
    const second = await claudeWorkflowsInit({ project_dir: dir })
    expect(second).toMatch(/files_written: none/)
    expect(second).toContain("files_skipped: .claude/workflows/foreman-checkpoint-review.js,.claude/workflows/foreman-design-panel.js,.claude/workflows/foreman-triage.js")
    expect(await fs.readFile(path.join(dir, ".claude", "workflows", "foreman-triage.js"), "utf-8")).toBe("// user-edited\n")

    const third = await claudeWorkflowsInit({ project_dir: dir, workflows: ["foreman-triage"], overwrite: true })
    expect(third).toContain("files_written: .claude/workflows/foreman-triage.js")
    expect(await fs.readFile(path.join(dir, ".claude", "workflows", "foreman-triage.js"), "utf-8")).not.toBe("// user-edited\n")
  })
  it("refuses a missing project dir and reports a missing bundled script instead of writing nothing silently", async () => {
    expect(await claudeWorkflowsInit({ project_dir: path.join(dir, "nope") })).toContain("project_dir_invalid")
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-nobundle-"))
    try {
      const text = await claudeWorkflowsInit({ project_dir: dir }, empty)
      expect(text).toContain("status: error")
      expect(text).toContain("missing_bundled: foreman-checkpoint-review,foreman-design-panel,foreman-triage")
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })
})
