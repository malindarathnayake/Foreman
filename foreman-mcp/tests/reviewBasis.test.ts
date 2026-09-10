import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { classifyGate, phaseBasis, recordGatePass, renderReviewOutcomes, seatBasis, GATE_HISTORY } from "../src/lib/reviewBasis.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { resolveModelRank } from "../src/lib/modelRank.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { Phase, PhaseReview, WriteLedgerInput } from "../src/types.js"

// ─── Fixtures ────────────────────────────────────────────────────────────────

let dir: string
let ledgerPath: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-basis-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

async function write(operation: Record<string, unknown>, host: HostId = "claude-code") {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, host)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const delegated = (unit_id: string) => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: "Implement the bounded change for this unit", preflight: { symbols_grepped: 1, self_consistent: true },
} })
const pass = (unit_id: string) => ({ operation: "set_verdict", phase: "p1", unit_id, data: { v: "pass" } })
async function passingUnit(unit_id = "u1", host: HostId = "claude-code") {
  await write(delegated(unit_id), host)
  await write(pass(unit_id), host)
}
const independent = (extra: Record<string, unknown> = {}) => ({
  advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"], ...extra,
})
const nativeReview = () => ({
  advisor: "codex-native", stage: "native", completion: "complete", findings: [], checked: ["src/a.ts"],
  native: {
    reviewers: [
      { agent_id: "r-contract", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
      { agent_id: "r-tests", lens: "tests", completion: "complete", checked: ["tests/a.test.ts"] },
    ],
    verifier_id: "v-1",
  },
})
const record = (data: Record<string, unknown>, host: HostId = "claude-code") =>
  write({ operation: "record_review", phase: "p1", data }, host)
const gate = (data: Record<string, unknown> = { g: "pass" }, host: HostId = "claude-code") =>
  write({ operation: "update_phase_gate", phase: "p1", data }, host)

const review = (extra: Partial<PhaseReview>): PhaseReview => ({ advisor: "x", ts: "2026-09-09T15:00:00.000Z", findings: [], ...extra })

// ─── seatBasis: class per stage and host ─────────────────────────────────────

describe("seatBasis classifies what a seat is, never whether it is one", () => {
  it("an unreceipted independent record is declared_external on every host", () => {
    for (const host of ["claude-code", "codex", "cursor", "generic"] as HostId[]) {
      expect(seatBasis(review({ stage: "independent" }), host, [])).toBe("declared_external")
      expect(seatBasis(review({}), host, [])).toBe("declared_external")
    }
  })
  it("a native record is same_provider", () => {
    expect(seatBasis(review({ stage: "native" }), "codex", [])).toBe("same_provider")
  })
  it("fan and cross_exam are never a basis", () => {
    expect(seatBasis(review({ stage: "fan" }), "codex", [])).toBeNull()
    expect(seatBasis(review({ stage: "cross_exam" }), "claude-code", [])).toBeNull()
  })
  it("a receipted seat is external only when Foreman can prove the vendor differs from the host's", () => {
    const prov = { receipt: "a".repeat(16), cli: "gemini" as const, provider: "google" as const, model_served: "gemini-3.1-pro", bytes_in: 4000, bytes_out: 900 }
    expect(seatBasis(review({ stage: "independent", host: "codex", provenance: prov }), "codex", [])).toBe("receipted_external")
    const sameVendor = { ...prov, cli: "codex" as const, provider: "openai" as const }
    expect(seatBasis(review({ stage: "independent", host: "codex", provenance: sameVendor }), "codex", [])).toBe("same_provider")
    // cursor has no known provider: receipted, never external on one seat
    expect(seatBasis(review({ stage: "independent", host: "cursor", provenance: prov }), "cursor", [])).toBe("receipted")
    // below the bytes floor: receipted
    expect(seatBasis(review({ stage: "independent", host: "codex", provenance: { ...prov, bytes_out: 10 } }), "codex", [])).toBe("receipted")
  })
  it("a verification inherits its baseline's class under the admitting stage filter", () => {
    const nativeBaseline = review({ advisor: "codex-native", stage: "native", ts: "2026-09-09T15:00:01.000Z" })
    const extBaseline = review({ advisor: "gemini", stage: "independent", ts: "2026-09-09T15:00:02.000Z" })
    const evidence = (baseline_review_ts: string, kind?: "worker_delta") => ({
      ...(kind ? { kind } : {}), baseline_review_ts, units: [{ unit_id: "u1", attempt: 2 }], files: ["src/a.ts"],
      tests: { outcome: "pass" as const, command: "npm test", result: "ok" }, probe: { outcome: "pass" as const, method: "read", result: "ok" },
    })
    const all = [nativeBaseline, extBaseline]
    expect(seatBasis(review({ stage: "verification", evidence: evidence(nativeBaseline.ts, "worker_delta") }), "codex", all)).toBe("delta:same_provider")
    expect(seatBasis(review({ stage: "verification", evidence: evidence(extBaseline.ts, "worker_delta") }), "codex", all)).toBe("delta:declared_external")
    // legacy direct-fix verification never sees a native baseline: falls back to declared_external
    expect(seatBasis(review({ stage: "verification", evidence: evidence(nativeBaseline.ts) }), "codex", all)).toBe("delta:declared_external")
  })
  it("phaseBasis names the strongest class present and 'override' when there is none", () => {
    expect(phaseBasis(["same_provider", "declared_external"])).toBe("declared_external")
    expect(phaseBasis(["delta:same_provider", "same_provider"])).toBe("same_provider")
    expect(phaseBasis(["receipted", "delta:receipted_external"])).toBe("delta:receipted_external")
    expect(phaseBasis([])).toBe("override")
  })
})

// ─── The gate stamp through the ledger ───────────────────────────────────────

describe("a counted gate pass is stamped with its basis", () => {
  it("stamps a declared_external first pass and records basis_version/host on the review", async () => {
    await passingUnit()
    await record(independent({ tokens: 1200 }))
    await gate()
    const ledger = await readLedger(ledgerPath)
    const phase = ledger.phases.p1
    expect(phase.reviews?.[0].basis_version).toBe(2)
    expect(phase.reviews?.[0].host).toBe("claude-code")
    expect(phase.gate_history).toHaveLength(1)
    const g = phase.gate_history![0]
    expect(g.seq).toBe(1)
    expect(g.basis).toBe("declared_external")
    expect(g.regate).toBe(false)
    expect(g.seats).toEqual([{ advisor: "gemini", ts: phase.reviews![0].ts, stage: "independent", basis: "declared_external" }])
    expect(g.present).toEqual({ independent: 1 })
    expect(g.unit_attempts).toEqual({ u1: 1 })
    expect(g.units).toBe(1)
    expect(g.seat_agents).toBe(1)
    expect(g.tokens).toEqual({ receipted: 0, declared: 1200, unreported: 0 })
    expect(g.overrides).toEqual([])
    expect(g.rank).toEqual({ weight: 0, declared: false })
    expect(g.ts).toBe(phase.gate_units_hash?.ts)
    expect(phase.gate_totals).toEqual({ declared_external: {
      gates: 1, regates: 0, units: 1, seat_agents: 1, tokens_receipted: 0, tokens_declared: 1200, tokens_unreported: 0,
    } })
  })

  it("a native pass on Codex is same_provider with every native id and no token surface", async () => {
    await passingUnit("u1", "codex")
    await record(nativeReview(), "codex")
    await gate({ g: "pass" }, "codex")
    const g = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(g.basis).toBe("same_provider")
    expect(g.host).toBe("codex")
    expect(g.seats[0].native_ids).toEqual(["r-contract", "r-tests", "v-1"])
    expect(g.seat_agents).toBe(3)
    expect(g.tokens).toEqual({ receipted: 0, declared: 0, unreported: 1 })
  })

  it("an external seat beside a native one names the gate declared_external; fan and cross_exam are counted as present only", async () => {
    await passingUnit("u1", "codex")
    await record(nativeReview(), "codex")
    await record(independent(), "codex")
    await record({ advisor: "codex-native", stage: "fan", completion: "complete", findings: [], checked: ["src/a.ts"] }, "codex")
    await gate({ g: "pass" }, "codex")
    const g = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(g.basis).toBe("declared_external")
    expect(g.seats.map((s) => s.basis).sort()).toEqual(["declared_external", "same_provider"])
    expect(g.present).toEqual({ native: 1, independent: 1, fan: 1 })
  })

  it("a review override is basis 'override' with the waiver listed; a D13 waiver is listed too", async () => {
    await write({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: false, has_build: true, security_boundary: true } })
    await passingUnit()
    await gate({ g: "pass", user_override: true, agent_class: "capable" })
    const g = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(g.basis).toBe("override")
    expect(g.seats).toEqual([])
    expect(g.flagged).toBe(true)
    expect(g.agent_class_declared).toBe("capable")
    expect(g.overrides).toEqual(["seat_minimum", "review"])
  })

  it("confirmed and incomplete waivers are listed on the stamp", async () => {
    await passingUnit()
    await record(independent({ findings: [{ severity: "high", file: "src/a.ts", line: "3", description: "loses the error", classification: "confirmed" }] }))
    await record({ advisor: "claude", stage: "independent", completion: "partial", findings: [] })
    await gate({ g: "pass", user_override: true })
    const g = (await readLedger(ledgerPath)).phases.p1.gate_history![0]
    expect(g.basis).toBe("declared_external")
    expect(g.overrides).toEqual(["confirmed", "incomplete"])
  })

  it("re-issuing g:'pass' over the same snapshot stamps nothing; a re-pass over new units is a counted re-gate", async () => {
    await passingUnit()
    await record(independent())
    await gate()
    await gate()   // idempotent
    let phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.gate_history).toHaveLength(1)
    expect(phase.gate_totals?.declared_external?.gates).toBe(1)
    // reopen, add a unit, review, pass again: counted, and a re-gate
    await gate({ g: "pending" })
    await passingUnit("u2")
    await record(independent())
    await gate()
    phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.gate_history).toHaveLength(2)
    expect(phase.gate_history![1]).toMatchObject({ seq: 2, regate: true, units: 2, unit_attempts: { u1: 1, u2: 1 } })
    expect(phase.gate_totals?.declared_external).toMatchObject({ gates: 1, regates: 1, units: 3 })
  })

  it("a gate that never passes is never stamped", async () => {
    await passingUnit()
    await gate({ g: "fail" })
    await gate({ g: "pending" })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.gate_history).toBeUndefined()
    expect(phase.gate_totals).toBeUndefined()
  })

  it("a legacy review without basis_version still classifies by stage", async () => {
    await passingUnit()
    await record(independent())
    const ledger = await readLedger(ledgerPath)
    delete ledger.phases.p1.reviews![0].basis_version
    delete ledger.phases.p1.reviews![0].host
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.gate_history![0].basis).toBe("declared_external")
  })
})

describe("gate history is bounded and totals survive it", () => {
  it("keeps the newest GATE_HISTORY stamps while totals keep counting", () => {
    const phase: Phase = { s: "ip", g: "pending", units: { u1: { s: "done", v: "pass", w: "b", rej: [], attempt_seq: 1 } } }
    const seat = review({ advisor: "gemini", stage: "independent", tokens: 10 })
    for (let i = 0; i < GATE_HISTORY + 2; i++) {
      const evidence = classifyGate({
        host: "claude-code", phaseObj: phase, currentReviews: [seat], seats: [seat], allReviews: [seat],
        modelRank: resolveModelRank(), overrides: [], ts: `2026-09-09T15:00:0${i}.000Z`,
      })
      recordGatePass(phase, evidence)
    }
    expect(phase.gate_history).toHaveLength(GATE_HISTORY)
    expect(phase.gate_history![0].seq).toBe(3)
    expect(phase.gate_history!.at(-1)!.seq).toBe(GATE_HISTORY + 2)
    expect(phase.gate_totals?.declared_external).toMatchObject({ gates: 1, regates: GATE_HISTORY + 1, tokens_declared: 10 * (GATE_HISTORY + 2) })
  })
})

// ─── The report ──────────────────────────────────────────────────────────────

describe("read_ledger review_outcomes", () => {
  it("reports nothing before any counted pass", async () => {
    await passingUnit()
    const text = await handleReadLedger(ledgerPath, { query: "review_outcomes" })
    expect(text).toContain("report: review_outcomes")
    expect(text).toContain("counted_passes: 0")
    expect(text).toContain("no counted gate passes recorded since 0.6.19")
  })
  it("renders one row per basis from the scalar totals, with hosts and tokens", async () => {
    await passingUnit("u1", "codex")
    await record(nativeReview(), "codex")
    await gate({ g: "pass" }, "codex")
    const text = await handleReadLedger(ledgerPath, { query: "review_outcomes" })
    expect(text).toContain("gated_phases: 1")
    expect(text).toContain("counted_passes: 1")
    expect(text).toMatch(/same_provider\s*\|\s*1\s*\|\s*0\s*\|\s*1\s*\|\s*3\.0\s*\|\s*0\/0\/1\s*\|\s*codex:1/)
    expect(await handleReadLedger(ledgerPath, { query: "review_outcomes", phase: "nope" })).toContain("phase not found")
  })
  it("renderReviewOutcomes is a pure function of the ledger", async () => {
    await passingUnit()
    await record(independent())
    await gate()
    const ledger = await readLedger(ledgerPath)
    expect(renderReviewOutcomes(ledger)).toBe(renderReviewOutcomes(ledger))
    expect(renderReviewOutcomes(ledger, "p1")).toContain("scope: p1")
  })
})
