import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  loadSkill,
  renderHostPlaceholders,
  renderIncludes,
} from "../src/lib/skillLoader.js"
import { KNOWN_HOSTS } from "../src/lib/hostProfiles.js"

let tmpDir: string
let bundledDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillloader-host-test-"))
  bundledDir = path.join(tmpDir, "bundled")
  await fs.mkdir(bundledDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("renderHostPlaceholders — direct unit", () => {
  it("substitutes worker_invoke for claude-code by default", () => {
    const out = renderHostPlaceholders("before {{worker_invoke}} after", "claude-code")
    expect(out).toContain("Agent tool")
    expect(out).toContain('model: "sonnet"')
    expect(out).not.toContain("{{worker_invoke}}")
  })

  it("substitutes worker_invoke for cursor", () => {
    const out = renderHostPlaceholders("before {{worker_invoke}} after", "cursor")
    expect(out).toContain("Task")
    expect(out).toContain("claude-4.6-sonnet-medium-thinking")
    expect(out).not.toContain("{{worker_invoke}}")
  })

  it("substitutes native spawn_agent worker instructions for codex", () => {
    const out = renderHostPlaceholders("before {{worker_invoke}} after", "codex")
    expect(out).toContain("spawn_agent")
    expect(out).toContain("worker_heavy")
    expect(out).toContain("record the model Codex reports")
    expect(out).not.toContain("Agent tool")
    expect(out).not.toContain("{{worker_invoke}}")
  })

  it("substitutes worker_fanout for every known host with non-empty text", () => {
    for (const host of KNOWN_HOSTS) {
      const out = renderHostPlaceholders("{{worker_fanout}}", host)
      expect(out, `${host} leaks {{worker_fanout}}`).not.toContain("{{worker_fanout}}")
      expect(out.length, `${host} worker_fanout non-empty`).toBeGreaterThan(0)
      expect(out, `${host} fanout mentions delegated`).toContain("delegated")
    }
  })

  it("codex worker_fanout contains spawn_agent and explorer", () => {
    const out = renderHostPlaceholders("{{worker_fanout}}", "codex")
    expect(out).toContain("spawn_agent")
    expect(out).toContain("explorer")
    expect(out).toContain("max_threads")
  })

  it("substitutes advisor_a / advisor_b for cursor with model slugs", () => {
    const out = renderHostPlaceholders(
      "A: {{advisor_a}}\nB: {{advisor_b}}",
      "cursor"
    )
    expect(out).toContain("gpt-5.6-sol-ultra")
    expect(out).toContain("gemini-3.1-pro")
    expect(out).toContain("composer-2-fast")
  })

  it("substitutes Claude Fable and Gemini advisors for codex", () => {
    const out = renderHostPlaceholders(
      "CHECKS: {{advisor_checks}}\nA: {{advisor_a}}\nB: {{advisor_b}}",
      "codex"
    )
    expect(out).toContain('capability_check({ cli: "claude" })')
    expect(out).toContain('invoke_advisor({ cli: "claude"')
    expect(out).toContain("claude-fable-5")
    expect(out).toContain('invoke_advisor({ cli: "gemini"')
    expect(out).not.toContain("{{advisor_checks}}")
  })

  it("leaves unknown placeholders untouched (forward compat)", () => {
    const out = renderHostPlaceholders("{{not_a_real_placeholder}} stays", "cursor")
    expect(out).toContain("{{not_a_real_placeholder}}")
  })

  it("does not touch {{include: ...}} markers", () => {
    const out = renderHostPlaceholders("{{include: foo}} {{worker_invoke}}", "claude-code")
    expect(out).toContain("{{include: foo}}")
    expect(out).not.toContain("{{worker_invoke}}")
  })

  it("tolerates whitespace inside braces ({{ name }})", () => {
    const out = renderHostPlaceholders("X {{  worker_invoke  }} Y", "cursor")
    expect(out).toContain("Task")
    expect(out).not.toContain("{{")
  })

  it("substitutes worker_invoke for generic in cost-tier vocabulary", () => {
    const out = renderHostPlaceholders("X {{worker_invoke}} Y", "generic")
    expect(out).toContain("tier")
    expect(out).toContain("HOST-CONTRACT.md")
    expect(out).not.toContain("{{worker_invoke}}")
  })

  it("substitutes autonomy for every known host with non-empty text", () => {
    for (const host of KNOWN_HOSTS) {
      const out = renderHostPlaceholders("{{autonomy}}", host)
      expect(out, `${host} leaks {{autonomy}}`).not.toContain("{{autonomy}}")
      expect(out.length, `${host} autonomy non-empty`).toBeGreaterThan(0)
    }
  })
})

describe("loadSkill — host placeholder integration", () => {
  it("default host is claude-code (backwards-compat)", async () => {
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "intro\n{{worker_invoke}}\noutro"
    )

    const result = await loadSkill("test-skill", bundledDir)
    expect(result.content).toContain("Agent tool")
    expect(result.content).toContain('model: "sonnet"')
    expect(result.content).not.toContain("{{worker_invoke}}")
  })

  it("loads with cursor host — renders Task subagent text", async () => {
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "intro\n{{worker_invoke}}\noutro"
    )

    const result = await loadSkill("test-skill", bundledDir, "cursor")
    expect(result.content).toContain("Task")
    expect(result.content).toContain("claude-4.6-sonnet-medium-thinking")
    expect(result.content).not.toContain("{{worker_invoke}}")
  })

  it("renders host placeholders AFTER includes (so included sections also resolve)", async () => {
    // _common-protocol.md style file with a section that contains a host placeholder.
    const protocol =
      "<!-- section: foo -->\nINSIDE {{advisor_a}}\n<!-- /section -->"
    await fs.writeFile(path.join(bundledDir, "_common-protocol.md"), protocol)
    await fs.writeFile(
      path.join(bundledDir, "test-skill.md"),
      "header\n{{include: foo}}\nfooter"
    )

    const ccResult = await loadSkill("test-skill", bundledDir, "claude-code")
    expect(ccResult.content).toContain("INSIDE")
    expect(ccResult.content).toContain("mcp__foreman__invoke_advisor")
    expect(ccResult.content).not.toContain("{{advisor_a}}")
    expect(ccResult.content).not.toContain("{{include:")

    const cursorResult = await loadSkill("test-skill", bundledDir, "cursor")
    expect(cursorResult.content).toContain("INSIDE")
    expect(cursorResult.content).toContain("gpt-5.6-sol-ultra")
    expect(cursorResult.content).not.toContain("{{advisor_a}}")
  })
})

describe("loadSkill — bundled skills render correctly under both hosts", () => {
  const SKILLS_DIR = path.join(__dirname, "..", "src", "skills")

  it("implementor renders worker_invoke under claude-code (Agent tool / sonnet)", async () => {
    const result = await loadSkill("implementor", SKILLS_DIR, "claude-code")
    expect(result.content).toContain("Agent tool")
    expect(result.content).toContain('model: "sonnet"')
    expect(result.content).not.toContain("{{worker_invoke}}")
  })

  it("implementor renders worker_invoke under cursor (Task / claude-4.6-sonnet)", async () => {
    const result = await loadSkill("implementor", SKILLS_DIR, "cursor")
    expect(result.content).toContain("Task")
    expect(result.content).toContain("claude-4.6-sonnet-medium-thinking")
    expect(result.content).not.toContain("{{worker_invoke}}")
  })

  it("implementor renders native Codex worker and Claude advisor paths", async () => {
    const result = await loadSkill("implementor", SKILLS_DIR, "codex")
    if (result.source !== "bundled") {
      expect(result.content).toContain("Active Host Runtime (authoritative)")
      expect(result.content).toContain("supersede")
    }
    expect(result.content).toContain("spawn_agent")
    expect(result.content).toContain("worker_heavy")
    expect(result.content).toContain('cli: "claude"')
    expect(result.content).toContain("claude-fable-5")
    const legacyModelCheck = result.content.indexOf("Model Check")
    if (legacyModelCheck >= 0) {
      expect(result.content.indexOf("Active Host Runtime (authoritative)")).toBeLessThan(legacyModelCheck)
    }
    expect(result.content).not.toContain("{{advisor_checks}}")
  })

  it("design-partner renders advisor_a / advisor_b via deliberation include — claude-code", async () => {
    const result = await loadSkill("design-partner", SKILLS_DIR, "claude-code")
    expect(result.content).toContain("mcp__foreman__invoke_advisor")
    expect(result.content).not.toContain("{{advisor_a}}")
    expect(result.content).not.toContain("{{advisor_b}}")
  })

  it("design-partner renders advisor_a / advisor_b via deliberation include — cursor", async () => {
    const result = await loadSkill("design-partner", SKILLS_DIR, "cursor")
    expect(result.content).toContain("gpt-5.6-sol-ultra")
    expect(result.content).toContain("gemini-3.1-pro")
    expect(result.content).not.toContain("{{advisor_a}}")
    expect(result.content).not.toContain("{{advisor_b}}")
  })

  it("spec-generator renders advisor placeholders under cursor", async () => {
    const result = await loadSkill("spec-generator", SKILLS_DIR, "cursor")
    expect(result.content).toContain("gpt-5.6-sol-ultra")
    expect(result.content).toContain("gemini-3.1-pro")
    expect(result.content).not.toContain("{{advisor_a}}")
  })

  it("no host placeholder leaks through under any host (claude-code)", async () => {
    for (const skill of ["implementor", "design-partner", "spec-generator"]) {
      const result = await loadSkill(skill, SKILLS_DIR, "claude-code")
      expect(result.content, `${skill} leaks {{worker_invoke}}`).not.toContain("{{worker_invoke}}")
      expect(result.content, `${skill} leaks {{worker_fanout}}`).not.toContain("{{worker_fanout}}")
      expect(result.content, `${skill} leaks {{advisor_a}}`).not.toContain("{{advisor_a}}")
      expect(result.content, `${skill} leaks {{advisor_b}}`).not.toContain("{{advisor_b}}")
      expect(result.content, `${skill} leaks {{advisor_checks}}`).not.toContain("{{advisor_checks}}")
      expect(result.content, `${skill} leaks {{advisor_fallback}}`).not.toContain("{{advisor_fallback}}")
    }
  })

  it("no host placeholder leaks through under any host (cursor)", async () => {
    for (const skill of ["implementor", "design-partner", "spec-generator"]) {
      const result = await loadSkill(skill, SKILLS_DIR, "cursor")
      expect(result.content, `${skill} leaks {{worker_invoke}}`).not.toContain("{{worker_invoke}}")
      expect(result.content, `${skill} leaks {{worker_fanout}}`).not.toContain("{{worker_fanout}}")
      expect(result.content, `${skill} leaks {{advisor_a}}`).not.toContain("{{advisor_a}}")
      expect(result.content, `${skill} leaks {{advisor_b}}`).not.toContain("{{advisor_b}}")
      expect(result.content, `${skill} leaks {{advisor_checks}}`).not.toContain("{{advisor_checks}}")
      expect(result.content, `${skill} leaks {{advisor_fallback}}`).not.toContain("{{advisor_fallback}}")
    }
  })

  it("no host placeholder leaks through under any host (generic)", async () => {
    for (const skill of ["implementor", "design-partner", "spec-generator"]) {
      const result = await loadSkill(skill, SKILLS_DIR, "generic")
      expect(result.content, `${skill} leaks {{worker_invoke}}`).not.toContain("{{worker_invoke}}")
      expect(result.content, `${skill} leaks {{worker_fanout}}`).not.toContain("{{worker_fanout}}")
      expect(result.content, `${skill} leaks {{advisor_a}}`).not.toContain("{{advisor_a}}")
      expect(result.content, `${skill} leaks {{advisor_b}}`).not.toContain("{{advisor_b}}")
      expect(result.content, `${skill} leaks {{advisor_checks}}`).not.toContain("{{advisor_checks}}")
      expect(result.content, `${skill} leaks {{advisor_fallback}}`).not.toContain("{{advisor_fallback}}")
    }
  })

  it("no host placeholder leaks through under codex", async () => {
    for (const skill of ["implementor", "design-partner", "spec-generator"]) {
      const result = await loadSkill(skill, SKILLS_DIR, "codex")
      expect(result.content, `${skill} leaks {{worker_invoke}}`).not.toContain("{{worker_invoke}}")
      expect(result.content, `${skill} leaks {{worker_fanout}}`).not.toContain("{{worker_fanout}}")
      expect(result.content, `${skill} leaks {{advisor_a}}`).not.toContain("{{advisor_a}}")
      expect(result.content, `${skill} leaks {{advisor_b}}`).not.toContain("{{advisor_b}}")
      expect(result.content, `${skill} leaks {{advisor_checks}}`).not.toContain("{{advisor_checks}}")
      expect(result.content, `${skill} leaks {{advisor_fallback}}`).not.toContain("{{advisor_fallback}}")
    }
  })

  it("implementor renders worker_fanout under codex with spawn_agent + explorer", async () => {
    const result = await loadSkill("implementor", SKILLS_DIR, "codex")
    expect(result.content).toContain("spawn_agent")
    expect(result.content).toContain("explorer")
    expect(result.content).toContain("max_threads")
    expect(result.content).not.toContain("{{worker_fanout}}")
  })
})

describe("renderIncludes still works without host arg (backwards compat)", () => {
  // Pre-existing renderIncludes signature must not break — host placeholders
  // are not its responsibility, so it should leave them alone.
  it("preserves host placeholders for the loadSkill pipeline to handle", async () => {
    const protocolDir = path.join(tmpDir, "include-only")
    await fs.mkdir(protocolDir, { recursive: true })
    await fs.writeFile(
      path.join(protocolDir, "_common-protocol.md"),
      "<!-- section: foo -->\nIN {{advisor_a}}\n<!-- /section -->"
    )
    const skillPath = path.join(protocolDir, "skill.md")
    const rendered = await renderIncludes(
      "{{include: foo}}",
      skillPath
    )
    expect(rendered).toContain("IN {{advisor_a}}")
  })
})
