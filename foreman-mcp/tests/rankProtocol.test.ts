import { describe, expect, it } from "vitest"
import path from "node:path"
import { loadSkill } from "../src/lib/skillLoader.js"
import { hostRuntimePreamble, KNOWN_HOSTS } from "../src/lib/hostProfiles.js"

describe("declared rank protocol rendering", () => {
  it.each(KNOWN_HOSTS)("%s gives automatic bounded shortcuts without retiring core requirements", async host => {
    const { content } = await loadSkill("implementor", path.resolve("src/skills"), host)
    expect(content).toContain('model: "<your model, or unknown>"')
    expect(content).toContain('operation: "declare_model"')
    expect(content).toContain("Standard and Unknown use normal Foreman protocol without blocking startup")
    expect(content).toContain("Use permitted shortcuts automatically")
    expect(content).toContain("Pit-boss NEVER writes implementation code, fixes, or tests")
    expect(content).toContain("**Rank-based corrections:**")
    expect(content).toContain('from_attempt: <previous attempt>')
    expect(content).toContain("new guard snapshot")
    expect(content).toContain("worker_delta")
    expect(content).toContain("verifier_id")
    expect(content).toContain("full checkpoint validation")
    expect(content).not.toContain("sole exception: a Direct Fix")
    expect(content).not.toContain("**Outer Loop (fresh worker, max 3 attempts)**")
    expect(content).not.toMatch(/\{\{[a-z_]+[\s:}]/)
  })
  it.each(KNOWN_HOSTS)("%s runtime preamble resolves conflicting older overrides", host => {
    const text = hostRuntimePreamble(host)
    expect(text).toContain("no host authentication is required for the pitboss rank")
    expect(text).toContain("Standard/unknown use normal protocol")
    expect(text).toContain("implementation, fixes and test edits always require workers")
    expect(text).toContain("supersede contrary direct-fix or unconditional fresh-worker/full-review instructions")
    expect(text).toContain("Rank does not change agent_class")
  })
})
