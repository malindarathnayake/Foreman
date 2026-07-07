import { describe, it, expect } from "vitest"
import fs from "fs/promises"
import path from "path"
import { loadSkill } from "../src/lib/skillLoader.js"
import { KNOWN_HOSTS } from "../src/lib/hostProfiles.js"
import { CAPABILITIES } from "../src/lib/capabilitySet.js"

const SKILLS_DIR = path.join(__dirname, "..", "src", "skills")
const SKILLS = ["design-partner", "spec-generator", "implementor", "lighttask", "spec-man", "doc-man"]
const DOC_PATH = path.join(__dirname, "..", "HOST-CONTRACT.md")

describe("HOST-CONTRACT — bundled skill renders leave no unresolved markers", () => {
  for (const host of KNOWN_HOSTS) {
    for (const skill of SKILLS) {
      it(`${skill} renders cleanly under host "${host}"`, async () => {
        const result = await loadSkill(skill, SKILLS_DIR, host)
        expect(
          result.content,
          `skill "${skill}" under host "${host}" leaks an unresolved {{...}} marker`
        ).not.toMatch(/\{\{[^}]*\}\}/)
        expect(
          result.content,
          `skill "${skill}" under host "${host}" leaks an unresolved {{include: ...}} marker`
        ).not.toContain("{{include:")
      })
    }
  }
})

describe("HOST-CONTRACT.md — existence and required content", () => {
  it("exists at foreman-mcp/HOST-CONTRACT.md", async () => {
    await expect(fs.access(DOC_PATH)).resolves.not.toThrow()
  })

  it("names all six capabilities from the CAPABILITIES const", async () => {
    const doc = await fs.readFile(DOC_PATH, "utf-8")
    for (const cap of CAPABILITIES) {
      expect(doc, `HOST-CONTRACT.md missing capability "${cap}"`).toContain(cap)
    }
  })

  it("contains all required section headings", async () => {
    const doc = await fs.readFile(DOC_PATH, "utf-8")
    const headings = [
      "Smoke taxonomy",
      "Capability readiness matrix",
      "Isolation semantics checklist",
      "Seat declaration",
      "Autonomy capability",
      "Inner loops per path",
      "Seat minimum (D13)",
      "Completion report",
      "S7 error-code catalog",
    ]
    for (const heading of headings) {
      expect(doc, `HOST-CONTRACT.md missing heading "${heading}"`).toContain(heading)
    }
  })

  it("every capability section carries the full readiness-matrix shape", async () => {
    const doc = await fs.readFile(DOC_PATH, "utf-8")
    const requiredFields = ["**Readiness:**", "**Use when:**", "**Do not use when:**", "**NOT-claims:**", "**Smoke:**"]
    for (const cap of CAPABILITIES) {
      const start = doc.indexOf(`### ${cap}`)
      expect(start, `missing ### ${cap} section`).toBeGreaterThan(-1)
      const nextHeading = doc.indexOf("\n### ", start + 1)
      const sectionEndCandidates = [nextHeading, doc.indexOf("\n## ", start + 1)].filter((i) => i > -1)
      const end = sectionEndCandidates.length > 0 ? Math.min(...sectionEndCandidates) : doc.length
      const section = doc.slice(start, end)
      for (const field of requiredFields) {
        expect(section, `### ${cap} missing ${field}`).toContain(field)
      }
    }
  })

  it("contains the required normative strings", async () => {
    const doc = await fs.readFile(DOC_PATH, "utf-8")
    const normativeStrings = [
      "fails closed",
      "Config DECLARES, tools VALIDATE",
      "not privileged modes",
      "must not fail CI",
    ]
    for (const str of normativeStrings) {
      expect(doc, `HOST-CONTRACT.md missing normative string "${str}"`).toContain(str)
    }
  })
})
