import { describe, expect, it } from "vitest"
import fs from "node:fs/promises"

// Runs the bundled design gauntlet against a mock Workflow host. agent() is a plain function so a verifier
// can throw synchronously as well as reject. parallel() is deliberately stricter than the documented host
// (which resolves a throwing thunk to null): it rejects outright, so a thunk that throws fails the test.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const script = (await fs.readFile(new URL("../src/workflows/foreman-design-gauntlet.js", import.meta.url), "utf8"))
  .replace("export const meta", "const meta")
const run = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", script)

const ARGS = {
  repo: "C:/repo", out_dir: "C:/out", slug: "cache", brief: "Bound the cache.", research_context: "One process.",
  topics: [{ key: "limits", q: "Which eviction policy?" }], grounding: "Read src/cache.ts.",
  design_requirements: "Bound memory.", attack_focus: "Races and memory limits.",
}
const finding = (id: string, severity: string, title: string) => ({ id, severity, title, location: "design §2", scenario: `${title} scenario` })
const verdict = (id: string, classification = "AGREE") => ({ id, classification, severity: "HIGH", reasoning: "traced", evidence: "design §2" })

type Lenses = { codex?: unknown[]; soc?: unknown[]; complexity?: unknown[] }
async function gauntlet(lensFindings: Lenses, verify: (title: string) => unknown, extra: Record<string, unknown> = {}) {
  let critic = ""
  const logs: string[] = []
  const verifyLabels: string[] = []
  const agent = (prompt: string, opts: { label?: string } = {}) => {
    const label = opts.label ?? ""
    if (label.startsWith("verify:")) {
      verifyLabels.push(label)
      return verify(/\): (.*)\nLocation:/.exec(prompt)?.[1] ?? "")
    }
    if (label === "critic") critic = prompt
    if (label.startsWith("research:")) return Promise.resolve({ topic: "limits", findings: [], risks: [] })
    if (label.startsWith("attack:")) {
      const lens = label.slice("attack:".length) as keyof Lenses
      return Promise.resolve({ ran: true, model_header: `mock:${lens}`, findings: lensFindings[lens] ?? [] })
    }
    return Promise.resolve(label.startsWith("design:") ? "# Design" : "text")
  }
  const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()))
  const result = await run({ ...ARGS, ...extra }, agent, parallel, null, () => {}, (m: string) => logs.push(m))
  return { result, critic, logs, verifyLabels }
}

describe("design gauntlet verification accounting", () => {
  it("accounts for every occurrence: verified, UNVERIFIED, empty, sync throw, rejection, malformed, mismatched, overflow", async () => {
    const codex = [finding("F1", "CRITICAL", "ok"), finding("F2", "HIGH", "empty"), finding("F3", "MEDIUM", "throws"), finding("F4", "LOW", "overflow")]
    const soc = [finding("SOC-1", "HIGH", "dup ok"), finding("SOC-1", "MEDIUM", "dup mismatched"), finding("SOC-2", "MEDIUM", "rejects")]
    const complexity = [finding("CX-1", "MEDIUM", "malformed"), finding("CX-2", "MEDIUM", "inconclusive")]
    const { result, critic, logs, verifyLabels } = await gauntlet({ codex, soc, complexity }, (title) => {
      if (title === "ok") return Promise.resolve(verdict("F1"))
      if (title === "empty") return Promise.resolve(null)
      if (title === "throws") throw new Error("verifier crashed")
      if (title === "rejects") return Promise.reject(new Error("verifier rejected"))
      if (title === "dup ok") return Promise.resolve(verdict("SOC-1"))
      if (title === "dup mismatched") return Promise.resolve(verdict("F9"))
      if (title === "malformed") return Promise.resolve({ id: "CX-1", classification: "MAYBE" })
      if (title === "inconclusive") return Promise.resolve(verdict("CX-2", "UNVERIFIED"))
      throw new Error(`overflow finding ${title} must not be verified`)
    }, { max_verifiers: 8 })

    expect(result.findings.map((f: { id: string; title: string }) => `${f.id}:${f.title}`)).toEqual([
      "F1:ok", "F2:empty", "F3:throws", "F4:overflow", "SOC-1:dup ok", "SOC-1:dup mismatched", "SOC-2:rejects", "CX-1:malformed", "CX-2:inconclusive"])
    expect(result.verification.map((v: { ref: number; id: string; status: string }) => [v.ref, v.id, v.status])).toEqual([
      [0, "F1", "verified"], [1, "F2", "empty"], [2, "F3", "failed"], [3, "F4", "not_selected"], [4, "SOC-1", "verified"],
      [5, "SOC-1", "mismatched"], [6, "SOC-2", "failed"], [7, "CX-1", "malformed"], [8, "CX-2", "unverified"]])
    expect(result.verification[2].detail).toContain("verifier crashed")
    expect(result.verification[6].detail).toContain("verifier rejected")
    expect(result.verification[5].detail).toContain("F9")
    expect(result.verification[7].detail).toMatch(/classification/)
    expect(result.verification_summary).toEqual({ findings: 9, selected: 8, verified: 2, unverified: 1, empty: 1, failed: 2, malformed: 1, mismatched: 1, not_selected: 1 })
    expect(result.duplicate_ids).toEqual(["SOC-1"])
    expect(new Set(verifyLabels).size).toBe(verifyLabels.length)
    expect(verifyLabels).toEqual(expect.arrayContaining(["verify:0:F1", "verify:4:SOC-1", "verify:5:SOC-1"]))
    expect(result.verdicts.map((v: { id: string; ref: number; classification: string }) => [v.id, v.ref, v.classification]))
      .toEqual([["F1", 0, "AGREE"], ["SOC-1", 4, "AGREE"], ["CX-2", 8, "UNVERIFIED"]])
    expect(result.unverified_ids).toEqual(["F2", "F3", "F4", "SOC-1", "SOC-2", "CX-1", "CX-2"])
    expect(result.stage).toBe("fan")
    expect(result.next).toContain("Nothing in the repository changes until the user approves")

    expect(critic).not.toMatch(/each finding verified/)
    expect(critic).toContain("2 of 9 findings were independently verified")
    for (const status of ["unverified", "empty", "failed", "malformed", "mismatched", "not_selected"]) expect(critic).toContain(status)
    expect(critic).toContain("SOC-1")
    expect(logs.some((l) => l.includes("2/9 findings verified"))).toBe(true)
  })

  it("keeps severity-first selection and the default cap; a capped same-id sibling stays unverified", async () => {
    const codex = Array.from({ length: 32 }, (_, i) => finding(`F${i + 1}`, i < 2 ? "LOW" : "HIGH", `t${i + 1}`))
    const all = await gauntlet({ codex }, (title) => Promise.resolve(verdict(`F${title.slice(1)}`)), { lenses: ["codex"] })
    expect(all.result.verification_summary).toMatchObject({ findings: 32, selected: 30, verified: 30, not_selected: 2 })
    expect(all.result.unverified_ids).toEqual(["F1", "F2"])
    expect(all.critic).toContain("30 of 32 findings")

    const pair = await gauntlet({ codex: [finding("F1", "LOW", "capped"), finding("F1", "HIGH", "kept")] },
      () => Promise.resolve(verdict("F1")), { lenses: ["codex"], max_verifiers: 1 })
    expect(pair.verifyLabels).toEqual(["verify:1:F1"])
    expect(pair.result.verification.map((v: { ref: number; status: string }) => [v.ref, v.status])).toEqual([[0, "not_selected"], [1, "verified"]])
    expect(pair.result.verdicts.map((v: { ref: number }) => v.ref)).toEqual([1])
    expect(pair.result.unverified_ids).toEqual(["F1"])
  })

  it("rejects a malformed optional field and keeps labels unique for cross-lens ids that collide with suffixes", async () => {
    const { result, critic, verifyLabels } = await gauntlet(
      { codex: [finding("F1", "HIGH", "a")], soc: [finding("F1", "HIGH", "b")], complexity: [finding("F1#0", "HIGH", "c")] },
      (title) => Promise.resolve(title === "a" ? verdict("F1") : title === "b" ? { ...verdict("F1"), tags: 42 } : { ...verdict("F1#0"), tags: "CWE-400" }))
    expect(verifyLabels).toEqual(["verify:0:F1", "verify:1:F1", "verify:2:F1#0"])
    expect(result.verification.map((v: { ref: number; status: string }) => [v.ref, v.status])).toEqual([[0, "verified"], [1, "malformed"], [2, "verified"]])
    expect(result.verification[1].detail).toContain("tags")
    expect(result.duplicate_ids).toEqual(["F1"])
    expect(result.unverified_ids).toEqual(["F1"])
    expect(critic).toContain("2 of 3 findings were independently verified")
  })

  it("reports full coverage honestly when every verifier succeeds, and zero findings as zero", async () => {
    const ok = await gauntlet({ codex: [finding("F1", "HIGH", "a")], soc: [finding("SOC-1", "LOW", "b")] },
      (title) => Promise.resolve(verdict(title === "a" ? "F1" : "SOC-1", "DISAGREE")), { lenses: ["codex", "soc"] })
    expect(ok.result.verification_summary).toMatchObject({ findings: 2, selected: 2, verified: 2 })
    expect(ok.result.unverified_ids).toEqual([])
    expect(ok.result.duplicate_ids).toEqual([])
    expect(ok.critic).toContain("2 of 2 findings were independently verified")
    expect(ok.critic).not.toContain("UNVERIFIED (")

    const none = await gauntlet({}, () => { throw new Error("no verifier expected") })
    expect(none.result.verification).toEqual([])
    expect(none.result.verdicts).toEqual([])
    expect(none.result.unverified_ids).toEqual([])
    expect(none.result.verification_summary.findings).toBe(0)
    expect(none.critic).toContain("0 of 0 findings")
  })
})
