// Review fan (v0.6.13): when a Codex host has no advisor CLI, it reviews with its own
// subagents instead of running a self-review pass — one read-only reviewer per risk lens,
// then a verifier that re-derives every claim from the code and writes the single report
// the orchestrator sees.
//
// The line these tests hold: a fan is PERSPECTIVE, not independence. Separate contexts and
// one lens each remove shared reasoning, but one model's blind spots stay correlated, so a
// fan record is durable evidence for the owner's decision and never a seat for the gate.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { buildVerifierPrompt, buildSeatPrompt, LENS_CATALOG, LENS_IDS, VERIFIER_RESPONSE_SCHEMA } from "../src/lib/lensCatalog.js"
import { codexAgentsInit, CODEX_AGENT_ROLES } from "../src/tools/codexAgentsInit.js"
import { getProfile } from "../src/lib/hostProfiles.js"
import { loadSkill } from "../src/lib/skillLoader.js"

let dir: string
let ledgerPath: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-fan-"))
  ledgerPath = path.join(dir, ".foreman-ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }
const CONFIRMED_HIGH = {
  severity: "high" as const,
  file: "src/a.ts",
  line: "42",
  description: "null deref on the error path",
  classification: "confirmed" as const,
}

async function passingUnit(unit = "u1") {
  await writeLedger(ledgerPath, {
    operation: "set_unit_status", phase: "p1", unit_id: unit,
    data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT },
  })
  await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: unit, data: { v: "pass" } })
}
async function record(data: Record<string, unknown>) {
  return writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data } as never)
}
async function gate(opts: Record<string, unknown> = {}) {
  return writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", ...opts } })
}

// ─── the roles Foreman ships ──────────────────────────────────────────────────

describe("codex_agents_init writes the fan roles", () => {
  it("reviewer and verifier are read-only and never spawn further agents", async () => {
    const result = await codexAgentsInit({ project_dir: dir, roles: ["reviewer", "verifier"] })
    expect(result).toContain(".codex/agents/reviewer.toml")
    expect(result).toContain(".codex/agents/verifier.toml")

    for (const role of ["reviewer", "verifier"]) {
      const toml = await fs.readFile(path.join(dir, ".codex", "agents", `${role}.toml`), "utf-8")
      expect(toml, role).toContain('sandbox_mode = "read-only"')
      expect(toml, role).toMatch(/Never write files\./)
      expect(toml, role).toMatch(/Never spawn further subagents\./)
      expect(toml, role).toMatch(/Never produce a Foreman ledger verdict\./)
    }
  })

  it("the reviewer is lens-bounded and the verifier is told the findings are claims", async () => {
    await codexAgentsInit({ project_dir: dir, roles: ["reviewer", "verifier"] })
    const reviewer = await fs.readFile(path.join(dir, ".codex", "agents", "reviewer.toml"), "utf-8")
    expect(reviewer).toMatch(/ONLY the lens question/)
    expect(reviewer).toMatch(/silence with no/)
    const verifier = await fs.readFile(path.join(dir, ".codex", "agents", "verifier.toml"), "utf-8")
    expect(verifier).toMatch(/same model you are running on/)
    expect(verifier).toMatch(/claims to test/)
    expect(verifier).toMatch(/a finding you drop is gone/)
  })

  it("the fan roles sit alongside the implementation seats", () => {
    // The full ordering is pinned in codexSeatTiers.test.ts; here only the fan's own
    // roles matter, plus the fact that they did not displace an implementation seat.
    expect(CODEX_AGENT_ROLES).toContain("reviewer")
    expect(CODEX_AGENT_ROLES).toContain("verifier")
    expect(CODEX_AGENT_ROLES).toContain("worker")
    expect(CODEX_AGENT_ROLES).toContain("explorer")
  })
})

// ─── the prompts ──────────────────────────────────────────────────────────────

describe("fan prompts", () => {
  it("each reviewer gets one distinct lens question", () => {
    const questions = new Set(LENS_IDS.map((id) => LENS_CATALOG[id].question))
    expect(questions.size).toBe(LENS_IDS.length)
    const prompt = buildSeatPrompt(LENS_CATALOG.security)
    expect(prompt).toContain("LENS: Security and abuse")
    expect(prompt).toContain("Findings that belong to another lens are noise here.")
  })

  it("the verifier prompt names the fan's lenses and demands a classification", () => {
    const prompt = buildVerifierPrompt(["contract", "security"])
    expect(prompt).toContain("contract — Contract and correctness")
    expect(prompt).toContain("security — Security and abuse")
    expect(prompt).toMatch(/same model you are running on/)
    expect(prompt).toMatch(/never as evidence/)
    expect(prompt).toMatch(/unverified/)
  })

  it("the verifier response shape matches what record_review stores", () => {
    const finding = VERIFIER_RESPONSE_SCHEMA.properties.findings.items
    expect(finding.required).toEqual(["severity", "file", "line", "description", "classification"])
    expect(finding.properties.classification.enum).toEqual(["confirmed", "rejected", "unverified"])
    expect(finding.properties.severity.enum).toEqual(["critical", "high", "medium", "low"])
  })
})

// ─── the honesty line ─────────────────────────────────────────────────────────

describe("a fan is recorded but never counts as a seat", () => {
  it("a fan alone leaves the gate blocked and the message says why", async () => {
    await passingUnit()
    await record({ advisor: "codex-fan", stage: "fan", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*a fan never does \(same-model perspective, not independence/)
  })

  it("the owner can still decide the gate with the fan's evidence in hand", async () => {
    await passingUnit()
    await record({
      advisor: "codex-fan", stage: "fan", completion: "complete",
      findings: [{ ...CONFIRMED_HIGH, classification: "rejected" as const }],
      checked: ["src/a.ts"], limitations: "claude and gemini CLIs unavailable",
    })
    await gate({ user_override: true })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override?.ts).toBeTruthy()
    // The evidence survives the override: this is why the record exists at all.
    const fan = phase.reviews!.find((r) => r.stage === "fan")!
    expect(fan.limitations).toMatch(/unavailable/)
    expect(fan.findings).toHaveLength(1)
  })

  it("a confirmed finding in a fan still blocks beside a real seat", async () => {
    await passingUnit()
    await record({ advisor: "claude", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await record({ advisor: "codex-fan", stage: "fan", completion: "complete", findings: [CONFIRMED_HIGH] })
    await expect(gate()).rejects.toThrow(/CONFIRMED FINDINGS[\s\S]*null deref/)
  })

  it("an independent seat still closes the gate on its own", async () => {
    await passingUnit()
    await record({ advisor: "claude", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })
})

// ─── the rendered protocol ────────────────────────────────────────────────────

describe("the Codex profile promotes new native reviews without upgrading legacy fan records", () => {
  it("names the roles, the order, and the honesty rule", () => {
    const text = getProfile("codex").placeholders.advisor_fallback
    expect(text).toMatch(/codex_agents_init/)
    expect(text).toMatch(/spawn_agent` one `reviewer` per risk lens/)
    expect(text).toMatch(/spawn_agent` one `verifier`/)
    expect(text).toContain("stage:'native'")
    expect(text).toMatch(/PERSPECTIVE, not independence/)
    expect(text).toMatch(/max_depth=1/)
    // The fan replaces the two self-review passes, which were the weaker rung.
    expect(text).not.toMatch(/TWO adversarial self-review passes/)
  })

  it("the other hosts keep their own fallback and never learn the Codex one", () => {
    for (const host of ["claude-code", "cursor", "generic"] as const) {
      expect(getProfile(host).placeholders.advisor_fallback, host).not.toMatch(/spawn_agent/)
    }
  })

  it("the implementor renders the fan text for codex and nothing unresolved", async () => {
    const skillsDir = path.resolve("src", "skills")
    const codex = await loadSkill("implementor", skillsDir, "codex")
    expect(codex.content).toMatch(/spawn_agent` one `reviewer` per risk lens/)
    expect(codex.content).not.toMatch(/\{\{[a-z_]+\}\}/)

    // The same skill on the Claude Code host never mentions the Codex fan.
    const claude = await loadSkill("implementor", skillsDir, "claude-code")
    expect(claude.content).not.toMatch(/spawn_agent/)
  })
})
