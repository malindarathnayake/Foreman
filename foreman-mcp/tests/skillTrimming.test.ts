import { describe, it, expect } from "vitest"
import fs from "fs/promises"
import path from "path"
import { renderIncludes } from "../src/lib/skillLoader"

const SKILLS_DIR = path.join(__dirname, "..", "src", "skills")

async function readSkill(name: string): Promise<string> {
  return fs.readFile(path.join(SKILLS_DIR, name), "utf-8")
}

function lineCount(content: string): number {
  return content.split("\n").length
}

describe("skillTrimming — design-partner", () => {
  it("line count is in the trimmed range (v0.0.7.5)", async () => {
    const content = await readSkill("design-partner.md")
    const lines = lineCount(content)
    expect(lines).toBeGreaterThanOrEqual(140)
    expect(lines).toBeLessThanOrEqual(210)
  })

  it("self-referential boilerplate is removed", async () => {
    const content = await readSkill("design-partner.md")
    expect(content).not.toContain("This skill is delivered by the Foreman MCP bundle")
  })

  it("all required sections remain present", async () => {
    const content = await readSkill("design-partner.md")
    const required = [
      "## Core Directive",
      "## Phase 1: Understand",
      "## Phase 2: Scoping Questions",
      "## Phase 3: Iterate",
      "## Phase 4: Design Synthesis",
      "## Phase 4b: Deliberation Protocol",
      "## Phase 5: Handoff",
      "## Push-Back Protocol",
      "## Block Conditions",
      "## Integration Discovery Decision Tree",
      "## Contract Tracing (all 6 checks)",
      "## Grounding Rule",
      "## Quality Bar",
      "## What This Skill Does NOT Do",
    ]
    for (const h of required) {
      expect(content).toContain(h)
    }
  })

  it("all three YIELD checkpoints remain present", async () => {
    const content = await readSkill("design-partner.md")
    // At minimum the file should contain YIELD markers for Phase 2, 3, and 4
    const yieldCount = (content.match(/YIELD/g) ?? []).length
    expect(yieldCount).toBeGreaterThanOrEqual(3)
  })

  it("write_journal init_session call is preserved", async () => {
    const content = await readSkill("design-partner.md")
    // init_session now lives inside the session-start include
    expect(content).toContain("{{include: session-start}}")
  })

  it("write_journal end_session call is preserved", async () => {
    const content = await readSkill("design-partner.md")
    expect(content).toContain("end_session")
  })

  it("include markers for deliberation and session-start are present", async () => {
    const content = await readSkill("design-partner.md")
    expect(content).toContain("{{include: deliberation-protocol}}")
    expect(content).toContain("{{include: session-start}}")
  })

  it("ledger-critical include is present at top", async () => {
    const content = await readSkill("design-partner.md")
    // Strip frontmatter (between first and second ---)
    const afterFrontmatter = content.replace(/^---[\s\S]*?---\n/, "")
    const bodyLines = afterFrontmatter.split("\n")
    // Check within first 20 lines of body
    const first20 = bodyLines.slice(0, 20).join("\n")
    expect(first20).toContain("{{include: ledger-critical}}")
  })

  it("all four required includes are present", async () => {
    const content = await readSkill("design-partner.md")
    const includes = [
      "{{include: ledger-critical}}",
      "{{include: session-start}}",
      "{{include: deliberation-protocol}}",
      "{{include: uncertainty-protocol}}",
    ]
    for (const marker of includes) {
      const count = content.split(marker).length - 1
      expect(count).toBe(1)
    }
  })

  it("rendered skill (via renderIncludes) contains the common-protocol bodies", async () => {
    const raw = await readSkill("design-partner.md")
    const skillPath = path.join(SKILLS_DIR, "design-partner.md")
    const rendered = await renderIncludes(raw, skillPath)
    expect(rendered).toContain("mcp__foreman__invoke_advisor")
    expect(rendered).toContain("UNKNOWN:")
    expect(rendered).toContain("CRITICAL: Never write")
  })
})

describe("skillTrimming — implementor", () => {
  it("line count is in the trimmed range (v0.0.7.5)", async () => {
    const content = await readSkill("implementor.md")
    const lines = lineCount(content)
    expect(lines).toBeGreaterThanOrEqual(180)
    expect(lines).toBeLessThanOrEqual(240)
  })

  it("self-referential boilerplate and disableSlashCommand are removed", async () => {
    const content = await readSkill("implementor.md")
    expect(content).not.toContain("This skill is delivered by the Foreman MCP bundle")
    expect(content).not.toContain("disableSlashCommand")
  })

  it("ledger-critical include is present at top", async () => {
    const content = await readSkill("implementor.md")
    // Check the marker is present
    expect(content).toContain("{{include: ledger-critical}}")
    // Strip frontmatter (between first and second ---) and check within first 20 non-blank body lines
    const afterFrontmatter = content.replace(/^---[\s\S]*?---\n/, "")
    const bodyLines = afterFrontmatter.split("\n").filter((l) => l.trim().length > 0)
    const first20 = bodyLines.slice(0, 20).join("\n")
    expect(first20).toContain("{{include: ledger-critical}}")
  })

  it("Model Check still mandates Opus", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toMatch(/Model Check/i)
    expect(content).toContain("Opus")
  })

  it("all Per-Unit Workflow step headings remain", async () => {
    const content = await readSkill("implementor.md")
    for (let i = 1; i <= 7; i++) {
      expect(content).toContain(`Step ${i}`)
    }
  })

  it("all five self-review gates remain with descriptive content", async () => {
    const content = await readSkill("implementor.md")
    // Gate names remain in expanded G5 sub-section and table rows
    expect(content).toContain("Contract Completeness")
    expect(content).toContain("Assertion Integrity")
    expect(content).toContain("Spec Fidelity")
    expect(content).toContain("Test-Suite Impact")
    expect(content).toContain("Worker Hygiene")
    // Gate row descriptions contain key phrases
    expect(content).toContain("Every return field populated")
    expect(content).toContain("or True")
    expect(content).toContain("spec directive has a corresponding code path")
    expect(content).toContain("Grep the full test suite")
    expect(content).toContain("dead imports")
  })

  it("Gate 5 operational instructions are preserved", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("How to run Gate 5")
    expect(content).toContain("How to run all gates")
  })

  it("anti-rationalization list is preserved", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Anti-rationalization")
  })

  it("Common Implementation Traps table is preserved", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Common Implementation Traps")
    // Sanity: specific trap rows still referenced
    expect(content).toContain("Caller fills it in")
    expect(content).toContain("Safety-valve assertions")
    expect(content).toContain("Mental paraphrase")
    expect(content).toContain("Scope creep in workers")
  })

  it("Worker Brief template (Step 4) is preserved", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Worker Brief")
    expect(content).toContain("BEFORE/AFTER")
    expect(content).toContain("DO NOT")
  })

  it("Checkpoint Protocol tier table lists codex and gemini", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Codex CLI")
    expect(content).toContain("Gemini CLI")
  })

  it("Brief Preflight Gate section is present", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Brief Preflight Gate")
    expect(content).toContain("Extract key symbols")
    expect(content).toContain("symbol footprint")
  })

  it("Brief Preflight Gate sits between Step 4 and Step 5", async () => {
    const content = await readSkill("implementor.md")
    const step4 = content.indexOf("Build Worker Brief")
    const preflight = content.indexOf("Brief Preflight Gate")
    const step5 = content.indexOf("Spawn Sonnet Worker")
    expect(step4).toBeGreaterThan(-1)
    expect(preflight).toBeGreaterThan(step4)
    expect(step5).toBeGreaterThan(preflight)
  })

  it("Preflight lists all five mechanical steps", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toMatch(/1\.\s*\*\*Extract key symbols\*\*/)
    expect(content).toMatch(/2\.\s*\*\*Grep `spec\.md`/)
    expect(content).toMatch(/3\.\s*\*\*Read each hit/)
    expect(content).toMatch(/4\.\s*\*\*Diff the brief/)
    expect(content).toMatch(/5\.\s*\*\*If any contradiction/)
  })

  it("required includes are present (7 markers)", async () => {
    const content = await readSkill("implementor.md")
    const markers = [
      "{{include: ledger-critical}}",
      "{{include: session-start}}",
      "{{include: agent-delegation}}",
      "{{include: error-handling-standard}}",
      "{{include: advisor-grounding}}",
      "{{include: context-budget}}",
      "{{include: no-test-attestation}}",
    ]
    for (const marker of markers) {
      const count = content.split(marker).length - 1
      expect(count).toBe(1)
    }
  })

  it("Self-Review Gates G1-G5 table format", async () => {
    const content = await readSkill("implementor.md")
    // Table header present exactly once
    const headerCount = content.split("| Gate | Applicability | Check |").length - 1
    expect(headerCount).toBe(1)
    // Each gate id appears as a table row
    for (const gid of ["G1 |", "G2 |", "G3 |", "G4 |", "G5 |"]) {
      expect(content).toContain(gid)
    }
    // scope.has_tests appears at least twice (G2 and G4 rows)
    const stCount = (content.match(/scope\.has_tests/g) ?? []).length
    expect(stCount).toBeGreaterThanOrEqual(2)
  })

  it("Gate skip protocol paragraph is present", async () => {
    const content = await readSkill("implementor.md")
    expect(content).toContain("Gate skip protocol")
    expect(content).toContain("G2 and G4 auto-skip")
  })

  it("rendered skill (via renderIncludes) contains the common-protocol bodies", async () => {
    const raw = await readSkill("implementor.md")
    const skillPath = path.join(SKILLS_DIR, "implementor.md")
    const rendered = await renderIncludes(raw, skillPath)
    // ledger-critical body
    expect(rendered).toContain("CRITICAL: Never write")
    // session-start five-questions table
    expect(rendered).toContain("Where am I?")
    // agent-delegation body
    expect(rendered).toContain("code-searcher")
    // error-handling-standard body
    expect(rendered).toContain("Worker timeout/crash")
    // advisor-grounding body
    expect(rendered).toContain("hallucinate library APIs")
    // context-budget body
    expect(rendered).toContain("ctx_used_pct")
    // no-test-attestation body
    expect(rendered).toContain("scope.has_tests === false")
  })

  it("include markers sit at section boundaries (blank line before and after)", async () => {
    const content = await readSkill("implementor.md")
    const lines = content.split("\n")
    const markers = [
      "{{include: ledger-critical}}",
      "{{include: session-start}}",
      "{{include: agent-delegation}}",
      "{{include: error-handling-standard}}",
      "{{include: advisor-grounding}}",
      "{{include: context-budget}}",
      "{{include: no-test-attestation}}",
    ]
    for (const marker of markers) {
      const idx = lines.findIndex((l) => l.trim() === marker)
      expect(idx).toBeGreaterThan(-1)
      // Line before must be blank OR the marker is at idx 0 (first line after frontmatter)
      const prevLine = idx > 0 ? lines[idx - 1].trim() : ""
      const nextLine = idx < lines.length - 1 ? lines[idx + 1].trim() : ""
      // Allow: prev blank, or prev is frontmatter close ("---")
      const prevOk = prevLine === "" || prevLine === "---"
      // Allow: next blank
      const nextOk = nextLine === ""
      expect(prevOk).toBe(true)
      expect(nextOk).toBe(true)
    }
  })

  it("no-test-attestation marker is NOT between ACCEPT and REJECT blocks (raw file)", async () => {
    const content = await readSkill("implementor.md")
    // In the raw file, the include marker must appear AFTER the REJECT block, not between ACCEPT and REJECT.
    const acceptIdx = content.indexOf("**ACCEPT:**")
    const rejectIdx = content.indexOf("**REJECT — enter fix protocol:**")
    const noTestIdx = content.indexOf("{{include: no-test-attestation}}")
    expect(acceptIdx).toBeGreaterThan(-1)
    expect(rejectIdx).toBeGreaterThan(acceptIdx)
    expect(noTestIdx).toBeGreaterThan(rejectIdx)
    // Also confirm it sits before ## Two-Tier Fix Protocol
    const twoTierIdx = content.indexOf("## Two-Tier Fix Protocol")
    expect(twoTierIdx).toBeGreaterThan(noTestIdx)
  })

  it("ACCEPT example includes the conditional note field", async () => {
    const content = await readSkill("implementor.md")
    // The set_verdict line in ACCEPT block must include a note: field
    expect(content).toContain('note: "<attestation')
    // The set_verdict operation line must be present with note
    expect(content).toMatch(/set_verdict.*note:/)
  })
})

describe("skillTrimming — _common-protocol", () => {
  const SECTION_IDS = [
    "ledger-critical",
    "session-start",
    "deliberation-protocol",
    "ambiguity-resolution",
    "uncertainty-protocol",
    "error-handling-standard",
    "agent-delegation",
    "advisor-grounding",
    "context-budget",
    "no-test-attestation",
  ]

  it("file exists and is non-empty (length > 500 chars)", async () => {
    const content = await readSkill("_common-protocol.md")
    expect(content.length).toBeGreaterThan(500)
  })

  it("each of the 10 section IDs appears as an opening marker exactly once", async () => {
    const content = await readSkill("_common-protocol.md")
    for (const id of SECTION_IDS) {
      const marker = `<!-- section: ${id} -->`
      const matches = content.split(marker).length - 1
      expect(matches).toBe(1)
    }
  })

  it("total count of closing markers equals 10", async () => {
    const content = await readSkill("_common-protocol.md")
    const closingCount = (content.match(/<!-- \/section -->/g) ?? []).length
    expect(closingCount).toBe(10)
  })

  it("total count of opening markers equals 10 (no stray openings)", async () => {
    const content = await readSkill("_common-protocol.md")
    const openingCount = (content.match(/<!-- section:/g) ?? []).length
    expect(openingCount).toBe(10)
  })

  it("body between each opening and closing marker is non-empty (> 20 chars after trim)", async () => {
    const content = await readSkill("_common-protocol.md")
    for (const id of SECTION_IDS) {
      const openMarker = `<!-- section: ${id} -->`
      const closeMarker = `<!-- /section -->`
      const start = content.indexOf(openMarker) + openMarker.length
      const end = content.indexOf(closeMarker, start)
      const body = content.slice(start, end).trim()
      expect(body.length).toBeGreaterThan(20)
    }
  })

  it("section IDs appear in the required order", async () => {
    const content = await readSkill("_common-protocol.md")
    let lastIdx = -1
    for (const id of SECTION_IDS) {
      const marker = `<!-- section: ${id} -->`
      const idx = content.indexOf(marker)
      expect(idx).toBeGreaterThan(lastIdx)
      lastIdx = idx
    }
  })

  it("no frontmatter — first non-blank line does not start with '---'", async () => {
    const content = await readSkill("_common-protocol.md")
    const firstNonBlank = content.split("\n").find((l) => l.trim().length > 0) ?? ""
    expect(firstNonBlank.startsWith("---")).toBe(false)
  })

  it("anchor checks — required strings present in body", async () => {
    const content = await readSkill("_common-protocol.md")
    expect(content).toContain("mcp__foreman__write_ledger")
    expect(content).toContain("mcp__foreman__invoke_advisor")
    expect(content).toContain("UNKNOWN:")
    expect(content).toContain("UNVERIFIED:")
    expect(content).toContain("code-searcher")
  })

  it("new-section rule anchors present — context-budget, no-test-attestation, advisor-grounding", async () => {
    const content = await readSkill("_common-protocol.md")
    expect(content).toContain("70%")
    expect(content).toContain("scope.has_tests")
    expect(content.toLowerCase()).toContain("imports")
  })
})

describe("skillTrimming — spec-generator", () => {
  it("line count is in the trimmed range (v0.0.7.5)", async () => {
    const content = await readSkill("spec-generator.md")
    const lines = lineCount(content)
    expect(lines).toBeGreaterThanOrEqual(200)
    expect(lines).toBeLessThanOrEqual(260)
  })

  it("self-referential boilerplate is removed", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).not.toContain("This skill is delivered by the Foreman MCP bundle")
  })

  it("ledger-critical include is present at top", async () => {
    const content = await readSkill("spec-generator.md")
    // Strip frontmatter (between first and second ---) and check within first 20 non-blank body lines
    const afterFrontmatter = content.replace(/^---[\s\S]*?---\n/, "")
    const bodyLines = afterFrontmatter.split("\n")
    const first20 = bodyLines.slice(0, 20).join("\n")
    expect(first20).toContain("{{include: ledger-critical}}")
  })

  it("all four document templates are preserved", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("## Document Templates")
    expect(content).toContain("spec.md")
    expect(content).toContain("handoff.md")
    expect(content).toContain("PROGRESS.md")
    expect(content).toContain("testing-harness.md")
  })

  it("all eight grounding checks G1 through G8 retain executable examples", async () => {
    const content = await readSkill("spec-generator.md")
    // All labels present
    for (let i = 1; i <= 8; i++) {
      expect(content).toContain(`G${i}:`)
    }
    // Specific preserved examples that make the checks actionable
    expect(content).toContain("bump version X → Y")
    expect(content).toContain("line 438")
    expect(content).toContain("Glob or ls")
    expect(content).toContain("return/throw/break")
    expect(content).toContain("Exact file path")
    expect(content).toContain("Catches:")
  })

  it("Quality Checks checklist is preserved", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("## Quality Checks")
    expect(content).toContain("G1-G8 grounding checks all completed")
  })

  it("write_journal init_session call is preserved in Session Start (via include)", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("{{include: session-start}}")
  })

  it("write_journal end_session call is preserved in Output + Handoff", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("end_session")
  })

  it("Ledger Seeding and Progress Seeding template blocks remain", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("## Ledger Seeding")
    expect(content).toContain("## Progress Seeding")
    expect(content).toContain("set_unit_status")
    expect(content).toContain("start_phase")
  })

  it("all five required includes are present (each exactly once)", async () => {
    const content = await readSkill("spec-generator.md")
    const includes = [
      "{{include: ledger-critical}}",
      "{{include: session-start}}",
      "{{include: ambiguity-resolution}}",
      "{{include: deliberation-protocol}}",
      "{{include: uncertainty-protocol}}",
    ]
    for (const marker of includes) {
      const count = content.split(marker).length - 1
      expect(count).toBe(1)
    }
  })

  it("agent-delegation is NOT an include (kept inline)", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).not.toContain("{{include: agent-delegation}}")
    expect(content).toContain("## Agent Delegation")
    expect(content).toContain("code-searcher")
  })

  it("grounding checks are prose, not a table", async () => {
    const content = await readSkill("spec-generator.md")
    expect(content).toContain("### G1:")
    expect(content).toContain("### G2:")
    expect(content).toContain("### G3:")
    expect(content).toContain("### G4:")
    expect(content).toContain("### G5:")
    expect(content).toContain("### G6:")
    expect(content).toContain("### G7:")
    expect(content).toContain("### G8:")
    expect(content).not.toContain("| Gate | Applicability |")
  })

  it("rendered skill (via renderIncludes) contains common-protocol bodies", async () => {
    const raw = await readSkill("spec-generator.md")
    const skillPath = path.join(SKILLS_DIR, "spec-generator.md")
    const rendered = await renderIncludes(raw, skillPath)
    // ledger-critical body
    expect(rendered).toContain("CRITICAL: Never write")
    // session-start five-questions table
    expect(rendered).toContain("Where am I?")
    // ambiguity-resolution body
    expect(rendered).toContain("What counts as ambiguous")
    // deliberation-protocol body
    expect(rendered).toContain("mcp__foreman__invoke_advisor")
    // uncertainty-protocol body
    expect(rendered).toContain("UNKNOWN:")
    expect(rendered).toContain("UNVERIFIED:")
  })
})
