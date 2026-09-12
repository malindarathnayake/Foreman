import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { appendReceipt, receiptsPathFor, sha256Hex, type ReceiptInput } from "../src/lib/seatReceipts.js"
import { STREAK_MAX, isWeakBasis } from "../src/lib/reviewBasis.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { loadSkill } from "../src/lib/skillLoader.js"
import { hostRuntimePreamble } from "../src/lib/hostProfiles.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { GateEvidence, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-bound-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

async function write(operation: Record<string, unknown>, host: HostId = "codex") {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, host)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
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
const independent = () => ({ advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })
async function unit(phase: string, unit_id: string, host: HostId = "codex") {
  await write({ operation: "set_unit_status", phase, unit_id, data: {
    s: "delegated", brief: "Implement the bounded change for this unit", preflight: { symbols_grepped: 1, self_consistent: true },
  } }, host)
  await write({ operation: "set_verdict", phase, unit_id, data: { v: "pass" } }, host)
}
/** One phase: one unit, one review of the given shape, one gate pass. */
async function phasePass(phase: string, review: Record<string, unknown>, host: HostId = "codex", gateData: Record<string, unknown> = { g: "pass" }) {
  await unit(phase, "u1", host)
  await write({ operation: "record_review", phase, data: review }, host)
  return write({ operation: "update_phase_gate", phase, data: gateData }, host)
}
const PROMPT = "Review these phase changes against the spec.\n" + "x".repeat(1200)
async function receiptedExternal(phase: string, host: HostId = "codex") {
  await unit(phase, "u1", host)
  const input: ReceiptInput = {
    cli: "gemini", provider: "google", model_served: "gemini-3.1-pro-preview", exit_code: 0, failure_reason: null,
    prompt_sha256: sha256Hex(PROMPT), bytes_in: Buffer.byteLength(PROMPT), bytes_out: 900,
  }
  const r = await appendReceipt(receiptsPathFor(ledgerPath), input)
  vi.setSystemTime(Date.now() + 1000)
  await write({ operation: "record_review", phase, data: { ...independent(), seat_receipt: r.id, packet_hash: r.prompt_sha256 } }, host)
  return write({ operation: "update_phase_gate", phase, data: { g: "pass" } }, host)
}
const independence = async () => (await readLedger(ledgerPath)).independence

describe("isWeakBasis", () => {
  const ev = (basis: GateEvidence["basis"], host: HostId): GateEvidence => ({
    seq: 1, ts: "t", host, basis, seats: [], present: {}, unit_attempts: {}, units: 1, seat_agents: 1, regate: false, flagged: false,
    overrides: [], rank: { weight: 0, declared: false }, tokens: { receipted: 0, declared: 0, unreported: 0 }, policy_version: 1,
  })
  it("same_provider, its delta, and override are weak everywhere; declared_external is weak on Codex only", () => {
    for (const host of ["codex", "claude-code", "cursor", "generic"] as HostId[]) {
      expect(isWeakBasis(ev("same_provider", host))).toBe(true)
      expect(isWeakBasis(ev("delta:same_provider", host))).toBe(true)
      expect(isWeakBasis(ev("override", host))).toBe(true)
      expect(isWeakBasis(ev("receipted_external", host))).toBe(false)
      expect(isWeakBasis(ev("receipted", host))).toBe(false)
      expect(isWeakBasis(ev("declared_external", host))).toBe(host === "codex")
    }
  })
})

describe("the independence bound at the gate", () => {
  it(`the ${STREAK_MAX + 1}th consecutive native pass is refused with the receipted path named`, async () => {
    for (let i = 1; i <= STREAK_MAX; i++) await phasePass(`p${i}`, nativeReview())
    expect(await independence()).toEqual({ streak: STREAK_MAX, phases: ["p1", "p2", "p3"] })
    await unit("p4", "u1")
    await write({ operation: "record_review", phase: "p4", data: nativeReview() })
    await expect(write({ operation: "update_phase_gate", phase: "p4", data: { g: "pass" } })).rejects.toThrow(
      /INDEPENDENCE BOUND: phase 'p4' would be counted pass #4 on same_provider review since the last receipted cross-vendor seat \(prior: p1, p2, p3; bound 3\)\. Run invoke_advisor \{ cli: 'claude' \| 'gemini' \}/
    )
    // nothing moved: the gate stayed pending, no stamp, streak unchanged
    const p4 = (await readLedger(ledgerPath)).phases.p4
    expect(p4.g).toBe("pending")
    expect(p4.gate_history).toBeUndefined()
    expect(await independence()).toEqual({ streak: STREAK_MAX, phases: ["p1", "p2", "p3"] })
  })

  it("the override is recorded on the phase and on the stamp, and the streak keeps counting", async () => {
    for (let i = 1; i <= STREAK_MAX; i++) await phasePass(`p${i}`, nativeReview())
    await phasePass("p4", nativeReview(), "codex", { g: "pass", user_override: true })
    const p4 = (await readLedger(ledgerPath)).phases.p4
    expect(p4.independence_override).toEqual({ ts: p4.gate_history![0].ts, streak: STREAK_MAX })
    expect(p4.gate_history![0].overrides).toEqual(["independence"])
    expect(await independence()).toEqual({ streak: STREAK_MAX + 1, phases: ["p1", "p2", "p3", "p4"] })
  })

  it("a receipted cross-vendor seat resets the streak; a declared external record on Codex does not", async () => {
    await phasePass("p1", nativeReview())
    await phasePass("p2", nativeReview())
    await phasePass("p3", independent())      // unreceipted on Codex: weak
    expect(await independence()).toEqual({ streak: 3, phases: ["p1", "p2", "p3"] })
    await receiptedExternal("p4")
    expect(await independence()).toEqual({ streak: 0, phases: [] })
    await phasePass("p5", nativeReview())
    expect(await independence()).toEqual({ streak: 1, phases: ["p5"] })
  })

  it("on claude-code a declared external record is neutral and an override is weak", async () => {
    await phasePass("p1", independent(), "claude-code")
    expect(await independence()).toBeUndefined()
    await unit("p2", "u1", "claude-code")
    await write({ operation: "update_phase_gate", phase: "p2", data: { g: "pass", user_override: true } }, "claude-code")
    expect(await independence()).toEqual({ streak: 1, phases: ["p2"] })
    await phasePass("p3", independent(), "claude-code")
    expect(await independence()).toEqual({ streak: 1, phases: ["p2"] })
  })

  it("a re-gate of a phase already in the streak neither spends nor resets; an idempotent re-pass changes nothing", async () => {
    await phasePass("p1", nativeReview())
    await phasePass("p2", nativeReview())
    await write({ operation: "update_phase_gate", phase: "p2", data: { g: "pass" } })
    expect(await independence()).toEqual({ streak: 2, phases: ["p1", "p2"] })
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pending" } })
    await unit("p1", "u2")
    await write({ operation: "record_review", phase: "p1", data: nativeReview() })
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    expect(await independence()).toEqual({ streak: 2, phases: ["p1", "p2"] })
    expect((await readLedger(ledgerPath)).phases.p1.gate_history).toHaveLength(2)
  })

  it("the phase list is bounded at STREAK_MAX + 1 while the count keeps growing", async () => {
    for (let i = 1; i <= STREAK_MAX; i++) await phasePass(`p${i}`, nativeReview())
    for (let i = STREAK_MAX + 1; i <= STREAK_MAX + 3; i++) await phasePass(`p${i}`, nativeReview(), "codex", { g: "pass", user_override: true })
    const s = await independence()
    expect(s?.streak).toBe(STREAK_MAX + 3)
    expect(s?.phases).toHaveLength(STREAK_MAX + 1)
    expect(s?.phases.at(-1)).toBe(`p${STREAK_MAX + 3}`)
  })

  it("the report shows the streak", async () => {
    await phasePass("p1", nativeReview())
    await phasePass("p2", nativeReview())
    expect(await handleReadLedger(ledgerPath, { query: "review_outcomes" })).toContain(`independence: streak 2/${STREAK_MAX} (p1, p2)`)
  })
})

describe("the procedure text names the bound, receipts and escapes", () => {
  it("in the Codex protocol sections and the host preamble", async () => {
    const skill = (await loadSkill("implementor", path.resolve("src/skills"), "codex")).content
    expect(skill).toContain("INDEPENDENCE BOUND")
    expect(skill).toContain("seat_receipt and packet_hash")
    expect(skill).toContain("record_escape")
    expect(hostRuntimePreamble("codex")).toContain("never enters review sufficiency")
  })
  it("in the shared checkpoint step on the other hosts", async () => {
    const skill = (await loadSkill("implementor", path.resolve("src/skills"), "claude-code")).content
    expect(skill).toContain("INDEPENDENCE BOUND")
    expect(skill).toContain("packet_sha256")
    expect(skill).toContain('read_ledger { query: "review_outcomes" }')
  })
})
