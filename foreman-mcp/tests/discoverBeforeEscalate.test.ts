// Field report 2026-09-10: a pit-boss wrote a 117-line owner-decision packet for a spec gap
// (no GraphQL document text) that a read-only introspection probe answered in minutes, after
// the owner said "if you need to discover the API do it". The protocol now carries a Probe
// check the pit-boss answers itself before classifying any gap about an external system:
// probe when side-effect-free with a held credential, one line to the user for side effects
// or a missing credential, an owner decision only for what no probe can settle. Prose rule;
// this test pins it on every host and in the shared ambiguity classifier.
import { describe, expect, it } from "vitest"
import path from "node:path"
import { loadSkill } from "../src/lib/skillLoader.js"
import { KNOWN_HOSTS } from "../src/lib/hostProfiles.js"

const BLOCK = ["- Docs:", "- What would answer it:", "- Side effects:", "- Credentials:", "- Cost:", "- Decision: PROBE NOW | ASK ONE LINE"]

describe("probe check: discover before you escalate", () => {
  it("the implementor carries the checklist ahead of the SPEC_GAP procedure on every host", async () => {
    for (const host of KNOWN_HOSTS) {
      const text = (await loadSkill("implementor", path.resolve("src/skills"), host)).content
      expect(text, host).toContain("**Probe check — answer it yourself, before any packet.**")
      for (const line of BLOCK) expect(text, host).toContain(line)
      expect(text, host).toContain("A gap is never escalated while a probe could still answer it")
      expect(text, host).toContain("discovery replaces the packet, not the unit protocol")
      expect(text, host).toContain("`ASK ONE LINE` is one sentence to the user, who is present")
      expect(text, host).toContain("never cite a document whose version you could not match")
      expect(text, host).toContain("Docs and probe are a pair")
      expect(text.indexOf("**Probe check"), host).toBeLessThan(text.indexOf("When preflight or validation shows the SPEC is wrong"))
    }
  })
  it("the shared ambiguity classifier has an Empirical class probed before it can be escalated", async () => {
    let seen = 0
    for (const skill of ["design-partner", "spec-generator", "implementor", "lighttask"]) {
      const text = (await loadSkill(skill, path.resolve("src/skills"), "claude-code")).content
      // every procedure that can escalate carries the block
      for (const line of BLOCK) expect(text, skill).toContain(line)
      if (!text.includes("**Resolution flow:**")) continue
      seen += 1
      expect(text, skill).toContain("Empirical (a fact about a system outside the repository")
      expect(text, skill).toContain("An ambiguity is never escalated while a probe could still answer it")
    }
    expect(seen).toBeGreaterThan(0)
  })
})
