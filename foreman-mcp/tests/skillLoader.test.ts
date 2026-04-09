import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { loadSkill } from "../src/lib/skillLoader.js"

let tmpDir: string
let bundledDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillloader-test-"))
  bundledDir = path.join(tmpDir, "bundled")
  await fs.mkdir(bundledDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("loadSkill", () => {
  it("loads bundled skill when no overrides exist", async () => {
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "# Bundled Skill\nContent here"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.source).toBe("bundled")
    expect(result.content).toContain("# Bundled Skill")
    expect(result.path).toContain("test-skill.md")
  })

  it("throws when skill is not found anywhere", async () => {
    await expect(loadSkill("nonexistent", bundledDir)).rejects.toThrow(
      'Skill "nonexistent" not found'
    )
  })

  it("returns full file content from bundled skill", async () => {
    const skillContent = "---\nname: test\n---\n\n## Protocol\nDo the thing."
    await fs.writeFile(path.join(bundledDir, "my-skill.md"), skillContent)

    const result = await loadSkill("my-skill", bundledDir)
    expect(result.content).toBe(skillContent)
  })
})
