import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { readLedger, reviewIncompleteness, writeLedger } from "../src/lib/ledger.js"
import { loadSkill } from "../src/lib/skillLoader.js"
import { hostRuntimePreamble } from "../src/lib/hostProfiles.js"
import { hostStatus } from "../src/tools/hostStatus.js"
import type { PhaseReview, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let server: McpServer | undefined
let client: Client | undefined
const native = () => ({
  reviewers: [
    { agent_id: "agent-contract", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
    { agent_id: "agent-tests", lens: "tests", completion: "complete", checked: ["tests/a.test.ts"] },
  ],
  verifier_id: "agent-verifier",
})
const review = (extra: Record<string, unknown> = {}) => ({
  advisor: "codex-native", stage: "native", completion: "complete", findings: [],
  checked: ["src/a.ts", "tests/a.test.ts"], native: native(), ...extra,
})
const finding = { severity: "high", file: "src/a.ts", line: "12", description: "error path loses data", classification: "confirmed" }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-native-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await client?.close()
  await server?.close()
  client = undefined
  server = undefined
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
async function write(operation: Record<string, unknown>) {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, "codex")
  vi.setSystemTime(Date.now() + 1000)
  return result
}
async function passingUnit() {
  await write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
    s: "delegated", brief: "Implement the bounded error handling change", preflight: { symbols_grepped: 1, self_consistent: true },
  } })
  await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
}
const record = (data = review()) => write({ operation: "record_review", phase: "p1", data })
const gate = (data: Record<string, unknown> = { g: "pass" }) => write({ operation: "update_phase_gate", phase: "p1", data })

describe("native review through MCP", () => {
  it("finishes a Codex checkpoint without external CLIs or overrides and exposes provenance", async () => {
    server = await createServer({ host: "codex", ledgerPath, docsDir: dir })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: "native-review-test", version: "1" })
    await client.connect(ct)
    const roles = await client.callTool({ name: "codex_agents_init", arguments: {
      project_dir: dir, roles: ["worker_light", "worker_heavy"],
      models: { worker_light: "test-light", worker_heavy: "test-heavy" },
    } })
    expect(roles.isError).not.toBe(true)
    expect(await fs.readFile(path.join(dir, ".codex/agents/worker_light.toml"), "utf-8")).toContain('model = "test-light"')
    await passingUnit()
    const result = await client.callTool({ name: "write_ledger", arguments: { operation: "record_review", phase: "p1", data: review() } })
    expect(result.isError).not.toBe(true)
    const passed = await client.callTool({ name: "write_ledger", arguments: { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } } })
    expect(passed.isError).not.toBe(true)
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override).toBeUndefined()
    expect(phase.reviews![0].native).toEqual(native())
    expect(phase.reviews![0].limitations).toContain("not cross-vendor independence")
    const full = await client.callTool({ name: "read_ledger", arguments: { query: "full", phase: "p1" } })
    expect(JSON.stringify(full.content)).toContain("agent-verifier")
  })
})

describe("native review gate invariants", () => {
  it("does not qualify a legacy fan or a native review on another host", async () => {
    await passingUnit()
    await write({ operation: "record_review", phase: "p1", data: { advisor: "fan", stage: "fan", completion: "complete", findings: [] } })
    await expect(gate()).rejects.toThrow("REVIEW REQUIRED")
    // 0.6.20: claude-code runs the same shape (a Workflow fan); cursor and generic do not.
    await expect(writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: review() } as WriteLedgerInput, undefined, undefined, "cursor")).rejects.toThrow("requires a host with native subagents")
    await record()
    // a native record recorded on Codex does not carry the gate on a host without native subagents
    await expect(writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } }, undefined, undefined, "cursor")).rejects.toThrow("REVIEW REQUIRED")
  })

  it.each([
    ["missing provenance", { native: undefined }],
    ["one reviewer", { native: { ...native(), reviewers: native().reviewers.slice(0, 1) } }],
    ["reused reviewer", { native: { ...native(), reviewers: native().reviewers.map((r) => ({ ...r, agent_id: "same" })) } }],
    ["reused verifier", { native: { ...native(), verifier_id: "agent-contract" } }],
    ["duplicate lens", { native: { ...native(), reviewers: native().reviewers.map((r) => ({ ...r, lens: "contract" })) } }],
    ["failed reviewer", { native: { ...native(), reviewers: native().reviewers.map((r) => ({ ...r, completion: "failed" })) } }],
    ["silent reviewer", { native: { ...native(), reviewers: native().reviewers.map((r) => ({ ...r, checked: [] })) } }],
    ["blank reviewer coverage", { native: { ...native(), reviewers: native().reviewers.map((r) => ({ ...r, checked: [" "] })) } }],
    ["silent verifier", { checked: [] }],
    ["unverified finding", { findings: [{ ...finding, classification: "unverified" }] }],
  ])("rejects a claimed complete review with %s", async (_name, extra) => {
    await passingUnit()
    await expect(record(review(extra))).rejects.toThrow("NATIVE REVIEW INCOMPLETE")
    await expect(gate()).rejects.toThrow("REVIEW REQUIRED")
  })

  it("allows an incomplete native run to be recorded and then superseded by a complete rerun", async () => {
    await passingUnit()
    await record(review({ completion: "failed", native: undefined, limitations: "reviewer timed out" }))
    await expect(gate()).rejects.toThrow("REVIEW REQUIRED")
    await record()
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })

  it("requires a fresh native review after a new verdict", async () => {
    await passingUnit()
    await record()
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
    await expect(gate()).rejects.toThrow("REVIEW REQUIRED")
    await record()
    await gate()
  })

  it("does not turn native metadata on a different stage into an independence claim", async () => {
    await passingUnit()
    await expect(record(review({ stage: "independent" }))).rejects.toThrow("data.native is accepted with stage:'native' only")
  })

  it("records an optional CLI failure without blocking complete native review", async () => {
    await passingUnit()
    await record(review({ limitations: "claude: completion:failed, authentication expired; gemini: unavailable" }))
    await gate()
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.review_override).toBeUndefined()
    expect(phase.reviews![0].limitations).toContain("authentication expired")
  })

  it.each(["native", "independent"])("blocks confirmed findings from %s review even beside a clean native review", async (stage) => {
    await passingUnit()
    await record()
    await record(review({ advisor: stage === "native" ? "codex-native" : "claude", stage, native: stage === "native" ? native() : undefined, findings: [finding] }))
    await expect(gate()).rejects.toThrow("CONFIRMED FINDINGS")
  })

  it("retains incomplete-review and scoped frontier requirements", async () => {
    await passingUnit()
    await record()
    await record(review({ advisor: "other-native", completion: "partial" }))
    await expect(gate()).rejects.toThrow("INCOMPLETE REVIEW")
    await record(review({ advisor: "other-native" }))
    await write({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: false, has_build: false, security_boundary: true } })
    await expect(gate()).rejects.toThrow("SEAT MINIMUM")
    await gate({ g: "pass", agent_class: "frontier" })
  })

  it("checks persisted native provenance again instead of trusting completion", () => {
    expect(reviewIncompleteness({ ...review({ native: undefined }), ts: "" } as PhaseReview)).toContain("provenance")
  })
})

describe("native host procedures", () => {
  it.each(["implementor", "design-partner", "spec-generator"])("renders %s without the missing-CLI waiver ladder", async (skill) => {
    const result = await loadSkill(skill, path.resolve("src/skills"), "codex")
    expect(result.content).toContain("Native Codex subagents are the default")
    expect(result.content).toContain("stage:'native'")
    expect(result.content).toContain("major checkpoints")
    expect(result.content).toContain('cli: "claude"')
    expect(result.content).toContain('cli: "gemini"')
    expect(result.content).not.toContain("Ask user for explicit waiver")
    expect(result.content).not.toContain("Proceed with pit-boss gates only?")
    expect(result.content).not.toMatch(/\{\{[a-z_]+[\s:}]/)
  })
  it("exposes the default and overrides stale external-first instructions", () => {
    expect(hostStatus("codex")).toContain("review_mode: native-subagents")
    expect(hostRuntimePreamble("codex")).toContain("supersedes external-first review ladders")
  })
})
