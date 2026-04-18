import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { loadSkill, renderIncludes } from "../src/lib/skillLoader.js"

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

// ── helpers ────────────────────────────────────────────────────────────────

function makeCommonProtocol(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([id, body]) => `<!-- section: ${id} -->\n${body}\n<!-- /section -->`)
    .join("\n\n")
}

// ── new suite ──────────────────────────────────────────────────────────────

describe("loadSkill — includes", () => {
  // Test 1: single include — success
  it("single include — substitutes section body", async () => {
    await fs.writeFile(
      path.join(bundledDir, "_common-protocol.md"),
      makeCommonProtocol({ foo: "BODY_FOO" })
    )
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "before\n{{include: foo}}\nafter"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("BODY_FOO")
    expect(result.content).not.toContain("{{include: foo}}")
    expect(result.content).toContain("before")
    expect(result.content).toContain("after")
  })

  // Test 2: multiple includes — all substituted
  it("multiple includes — all substituted", async () => {
    await fs.writeFile(
      path.join(bundledDir, "_common-protocol.md"),
      makeCommonProtocol({ foo: "FOO_BODY", bar: "BAR_BODY" })
    )
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "{{include: foo}}\n---\n{{include: bar}}"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("FOO_BODY")
    expect(result.content).toContain("BAR_BODY")
    expect(result.content).not.toContain("{{include:")
  })

  // Test 3: missing section — [[MISSING: id]] placeholder
  it("missing section — replaces with [[MISSING: id]]", async () => {
    await fs.writeFile(
      path.join(bundledDir, "_common-protocol.md"),
      makeCommonProtocol({ foo: "FOO_BODY" })
    )
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "before\n{{include: missing-id}}\nafter"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("[[MISSING: missing-id]]")
    expect(result.content).not.toContain("{{include: missing-id}}")
    expect(result.content).toContain("before")
    expect(result.content).toContain("after")
  })

  // Test 4: missing _common-protocol.md — [[COMMON PROTOCOL FILE MISSING]] per include
  it("missing _common-protocol.md — replaces each include with file-missing placeholder", async () => {
    // No _common-protocol.md written
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "A\n{{include: anything}}\nB\n{{include: other}}\nC"
    )

    const result = await loadSkill("test-skill", bundledDir)
    // Should appear once per include marker
    const occurrences = result.content.split("[[COMMON PROTOCOL FILE MISSING]]").length - 1
    expect(occurrences).toBe(2)
    expect(result.content).not.toContain("{{include:")
  })

  // Test 5: no includes — content unchanged, no filesystem side effects
  it("no includes — file content returned byte-for-byte", async () => {
    const skillContent = "# No includes here\nJust plain content."
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      skillContent
    )
    // No _common-protocol.md present — if renderIncludes touches fs it would error
    // because the file doesn't exist. If it doesn't touch fs, no problem.

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toBe(skillContent)
  })

  // Test 6: whitespace tolerance — {{ include:   foo }} resolves to foo section
  it("whitespace tolerance — {{ include:   foo }} resolves correctly", async () => {
    await fs.writeFile(
      path.join(bundledDir, "_common-protocol.md"),
      makeCommonProtocol({ foo: "FOO_BODY" })
    )
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "before\n{{ include:   foo }}\nafter"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("FOO_BODY")
    expect(result.content).not.toContain("{{ include:")
    expect(result.content).toContain("before")
    expect(result.content).toContain("after")
  })

  // Test 7: renderIncludes direct call
  it("renderIncludes direct call — substitutes section body", async () => {
    const protocolDir = path.join(tmpDir, "direct-test")
    await fs.mkdir(protocolDir, { recursive: true })
    await fs.writeFile(
      path.join(protocolDir, "_common-protocol.md"),
      makeCommonProtocol({ mySection: "DIRECT_BODY" })
    )

    const skillPath = path.join(protocolDir, "skill.md")
    const content = "intro\n{{include: mySection}}\noutro"
    const rendered = await renderIncludes(content, skillPath)

    expect(rendered).toContain("DIRECT_BODY")
    expect(rendered).not.toContain("{{include: mySection}}")
    expect(rendered).toContain("intro")
    expect(rendered).toContain("outro")
  })

  // Test 9: _common-protocol.md is a directory — degrades gracefully (EISDIR triggers try/catch)
  it("common-protocol path is a directory — degrades gracefully", async () => {
    // Create a directory at the path where _common-protocol.md would be
    await fs.mkdir(path.join(bundledDir, "_common-protocol.md"), { recursive: true })
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "before\n{{include: anything}}\nafter"
    )

    // Must not throw; must replace include with MISSING placeholder
    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("[[COMMON PROTOCOL FILE MISSING]]")
    expect(result.content).not.toContain("{{include: anything}}")
    expect(result.content).toContain("before")
    expect(result.content).toContain("after")
  })

  // Test 8: include markers inside project-override path work
  it("project-override include markers resolved from override directory", async () => {
    const originalCwd = process.cwd()

    try {
      // Set cwd to tmpDir so that path.resolve(".claude/skills/...") lands in tmpDir
      process.chdir(tmpDir)

      const overrideDir = path.join(tmpDir, ".claude", "skills", "test-skill")
      await fs.mkdir(overrideDir, { recursive: true })

      await fs.writeFile(
        path.join(overrideDir, "_common-protocol.md"),
        makeCommonProtocol({ shared: "SHARED_BODY" })
      )
      await fs.writeFile(
        path.join(overrideDir, "SKILL.md"),
        "header\n{{include: shared}}\nfooter"
      )

      const result = await loadSkill("test-skill", bundledDir)
      expect(result.source).toBe("project-override")
      expect(result.content).toContain("SHARED_BODY")
      expect(result.content).not.toContain("{{include: shared}}")
      expect(result.content).toContain("header")
      expect(result.content).toContain("footer")
    } finally {
      process.chdir(originalCwd)
    }
  })
})
