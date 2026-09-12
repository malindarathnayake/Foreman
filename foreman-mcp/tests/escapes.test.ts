import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { applyEscape, coveringGate, ESCAPE_RETENTION } from "../src/lib/reviewBasis.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { sessionOrient } from "../src/tools/sessionOrient.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { Phase, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-escape-"))
  ledgerPath = path.join(dir, "ledger.json")
  progressPath = path.join(dir, "PROGRESS.md")
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
const verdict = (unit_id: string, v = "pass", extra: Record<string, unknown> = {}) =>
  ({ operation: "set_verdict", phase: "p1", unit_id, data: { v, ...extra } })
const reject = (unit_id: string, extra: Record<string, unknown> = {}) =>
  ({ operation: "add_rejection", phase: "p1", unit_id, data: { r: "gemini", msg: "loses the error path", ts: "t", ...extra } })
const escapeOp = (unit_id: string, data: Record<string, unknown>) => ({ operation: "record_escape", phase: "p1", unit_id, data })
const independent = () => ({ advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })

/** One unit delegated, passed, reviewed and gated: the unit is covered by gate #1. */
async function gatedPhase(units = ["u1"]) {
  for (const u of units) {
    await write(delegated(u))
    await write(verdict(u))
  }
  await write({ operation: "record_review", phase: "p1", data: independent() })
  await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
}
const phase = async () => (await readLedger(ledgerPath)).phases.p1

// ─── Server-authored escape events ───────────────────────────────────────────

describe("a contradiction of a gated unit is an escape of that gate", () => {
  it("a rejection records an unclassified escape against the covering gate and says so", async () => {
    await gatedPhase()
    const { warning } = await write(reject("u1"))
    expect(warning).toContain("verdict reopened")
    expect(warning).toContain("post-gate escape #1 recorded (declared_external) — classify with record_escape")
    const p = await phase()
    expect(p.escapes).toHaveLength(1)
    expect(p.escapes![0]).toMatchObject({
      unit_id: "u1", attempt: 1, gate_seq: 1, gate_ts: p.gate_history![0].ts, basis: "declared_external", host: "claude-code",
      sources: ["rejection"], class: "unclassified",
    })
    expect(p.escape_totals).toEqual({ total: 1, by_basis: { declared_external: 1 }, by_class: { unclassified: 1 } })
  })

  it("add_rejection with escape_class classifies in the same write", async () => {
    await gatedPhase()
    const { warning } = await write(reject("u1", { escape_class: "original_defect" }))
    expect(warning).not.toContain("classify with record_escape")
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ class: "original_defect", classified_ts: p.escapes![0].ts })
    expect(p.escape_totals?.by_class).toEqual({ original_defect: 1 })
  })

  it("a non-pass verdict on a covered unit is a reopen escape", async () => {
    await gatedPhase()
    await write(verdict("u1", "fail"))
    expect((await phase()).escapes![0].sources).toEqual(["reopen"])
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pending" } })
  })

  it("a new attempt on a covered pass unit is a post_gate_attempt escape, also for a direct fix", async () => {
    await gatedPhase(["u1", "u2"])
    await write(delegated("u1"))
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u2", data: { s: "ip", direct_fix: "rename the constant to match" } })
    const p = await phase()
    expect(p.escapes!.map((e) => [e.unit_id, e.sources[0]])).toEqual([["u1", "post_gate_attempt"], ["u2", "post_gate_attempt"]])
  })

  it("a pass→pass re-verdict keeps coverage: no escape, and a later rejection still attributes to gate #1", async () => {
    await gatedPhase()
    await write(verdict("u1", "pass"))
    expect((await phase()).escapes).toBeUndefined()
    await write(reject("u1"))
    expect((await phase()).escapes![0]).toMatchObject({ gate_seq: 1, sources: ["rejection"] })
  })

  it("events on the same (unit, gate) merge their sources; a rejection-less follow-up is still seen", async () => {
    await gatedPhase()
    await write(reject("u1"))
    await write(verdict("u1", "inconclusive"))   // unit is already pending: no reopen source
    await write(delegated("u1"))                 // v is pending: no post_gate_attempt source
    const p = await phase()
    expect(p.escapes).toHaveLength(1)
    expect(p.escapes![0].sources).toEqual(["rejection"])
    expect(p.escape_totals?.total).toBe(1)
    // the new attempt exits coverage: the unit is no longer attributable to gate #1
    expect(coveringGate(p, "u1", p.units.u1.attempt_seq!)).toBeNull()
  })

  it("a unit never gated records nothing", async () => {
    await write(delegated("u1"))
    await write(verdict("u1"))
    await write(reject("u1"))
    expect((await phase()).escapes).toBeUndefined()
  })
})

// ─── The demand for classification ───────────────────────────────────────────

describe("the ledger demands a class before the next pass", () => {
  it("set_verdict pass is refused while the unit's escape is unclassified; record_escape clears it", async () => {
    await gatedPhase()
    await write(reject("u1"))
    await write(delegated("u1"))
    await expect(write(verdict("u1"))).rejects.toThrow(/ESCAPE UNCLASSIFIED: unit 'u1' escaped gate #1 \(declared_external\) via rejection/)
    const { warning } = await write(escapeOp("u1", { class: "remediation_defect", found_by: "external_seat", note: "reviewer caught the regression" }))
    expect(warning).toBe("escape #1 on 'u1' classified remediation_defect (declared_external)")
    await write(verdict("u1"))
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ class: "remediation_defect", found_by: "external_seat", note: "reviewer caught the regression" })
    expect(p.escape_totals?.by_class).toEqual({ unclassified: 0, remediation_defect: 1 })
    expect(p.units.u1.cap_override).toBeUndefined()
  })

  it("user_override on the pass records the waiver as cap_override.waived:'escape'", async () => {
    await gatedPhase()
    await write(reject("u1"))
    await write(delegated("u1"))
    await write(verdict("u1", "pass", { user_override: true }))
    const p = await phase()
    expect(p.units.u1.cap_override).toMatchObject({ attempt: 2, waived: ["escape"] })
    expect(p.escapes![0].class).toBe("unclassified")
  })

  it("the gate is refused while any escape in the phase is unclassified; the override is recorded on the phase and the stamp", async () => {
    await gatedPhase(["u1", "u2"])
    await write(reject("u1"))
    await write(delegated("u1"))
    await write(verdict("u1", "pass", { user_override: true }))
    await write({ operation: "record_review", phase: "p1", data: independent() })
    await expect(write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } }))
      .rejects.toThrow(/ESCAPE UNCLASSIFIED: phase 'p1' has 1 post-gate escape\(s\) not yet classified: u1 \(gate #1, declared_external\)/)
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass", user_override: true } })
    const p = await phase()
    expect(p.escape_override).toEqual({ ts: p.gate_history![1].ts, escapes: 1 })
    expect(p.gate_history![1].overrides).toEqual(["escape"])
    expect(p.gate_history![1]).toMatchObject({ seq: 2, regate: true, unit_attempts: { u1: 2, u2: 1 } })
  })

  it("an idempotent re-pass does not demand classification", async () => {
    await gatedPhase()
    // an out-of-band escape leaves the snapshot intact
    await write(escapeOp("u1", { class: "original_defect", source: "later" }))
    const ledger = await readLedger(ledgerPath)
    ledger.phases.p1.escapes![0].class = "unclassified"
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    expect((await phase()).gate_history).toHaveLength(1)
  })
})

// ─── record_escape edge cases ────────────────────────────────────────────────

describe("record_escape", () => {
  it("source:'later' records a classified escape on a gated unit without touching its verdict", async () => {
    await gatedPhase()
    const { warning } = await write(escapeOp("u1", { class: "original_defect", source: "later", found_by: "production" }))
    expect(warning).toBe("escape #1 on 'u1' recorded original_defect (declared_external, found later)")
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ sources: ["later"], class: "original_defect", found_by: "production" })
    expect(p.units.u1.v).toBe("pass")
    expect(p.units.u1.attempt_seq).toBe(1)
    expect(p.g).toBe("pass")
  })
  it("refuses an unregistered unit instead of creating one", async () => {
    await gatedPhase()
    await expect(write(escapeOp("nope", { class: "process", source: "later" }))).rejects.toThrow(/ESCAPE BLOCKED: unit 'nope' is not registered/)
    expect((await phase()).units.nope).toBeUndefined()
  })
  it("refuses 'later' on a unit with an attempt after its gate", async () => {
    await gatedPhase()
    await write(reject("u1"))
    await write(escapeOp("u1", { class: "test_gap" }))
    await write(delegated("u1"))
    await expect(write(escapeOp("u1", { class: "process", source: "later" }))).rejects.toThrow(/has an attempt after its last counted gate/)
  })
  it("refuses a classification when nothing is unclassified and no source is given", async () => {
    await gatedPhase()
    await expect(write(escapeOp("u1", { class: "process" }))).rejects.toThrow(/no unclassified escape on 'u1'; pass data.source:'later'/)
  })
})

// ─── Legacy phases and retention ─────────────────────────────────────────────

describe("legacy phases and bounded history", () => {
  it("a phase gated before 0.6.19 attributes escapes to 'legacy' through the D2b stamp", async () => {
    await gatedPhase()
    const ledger = await readLedger(ledgerPath)
    delete ledger.phases.p1.gate_history
    delete ledger.phases.p1.gate_totals
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await write(reject("u1"))
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ gate_seq: 0, gate_ts: p.gate_units_hash!.ts, basis: "legacy", sources: ["rejection"] })
    expect(p.escape_totals?.by_basis).toEqual({ legacy: 1 })
  })

  it("keeps the newest ESCAPE_RETENTION escapes while totals keep counting", () => {
    const units: Phase["units"] = {}
    const attempts: Record<string, number> = {}
    for (let i = 0; i < ESCAPE_RETENTION + 1; i++) {
      units[`u${i}`] = { s: "done", v: "pass", w: "b", rej: [], attempt_seq: 1 }
      attempts[`u${i}`] = 1
    }
    const p: Phase = { s: "ip", g: "pass", units, gate_history: [{
      seq: 1, ts: "2026-09-09T15:00:00.000Z", host: "claude-code", basis: "same_provider", seats: [], present: {},
      unit_attempts: attempts, units: ESCAPE_RETENTION + 1, seat_agents: 3, regate: false, flagged: false, overrides: [],
      rank: { weight: 0, declared: false }, tokens: { receipted: 0, declared: 0, unreported: 1 }, policy_version: 1,
    }] }
    for (let i = 0; i < ESCAPE_RETENTION + 1; i++) applyEscape(p, `u${i}`, units[`u${i}`], "rejection", `t${i}`)
    expect(p.escapes).toHaveLength(ESCAPE_RETENTION)
    expect(p.escapes![0].unit_id).toBe("u1")
    expect(p.escape_totals).toEqual({ total: ESCAPE_RETENTION + 1, by_basis: { same_provider: ESCAPE_RETENTION + 1 }, by_class: { unclassified: ESCAPE_RETENTION + 1 } })
  })
})

// ─── Surfaces ────────────────────────────────────────────────────────────────

describe("escapes are visible where the pit-boss looks", () => {
  it("session_orient counts unclassified escapes", async () => {
    await gatedPhase()
    expect(await sessionOrient(ledgerPath, progressPath)).toContain("escapes_unclassified: 0")
    await write(reject("u1"))
    expect(await sessionOrient(ledgerPath, progressPath)).toContain("escapes_unclassified: 1")
  })
  it("review_outcomes renders escape columns and, per phase, the escape rows", async () => {
    await gatedPhase(["u1", "u2"])
    await write(reject("u1", { escape_class: "original_defect" }))
    await write(reject("u2"))
    const all = await handleReadLedger(ledgerPath, { query: "review_outcomes" })
    expect(all).toContain("escapes_unclassified: 1")
    expect(all).toMatch(/declared_external\s*\|\s*1\s*\|\s*0\s*\|\s*2\s*\|\s*1\.0\s*\|\s*1\s*\|\s*0\s*\|\s*1\s*\|/)
    expect(all).toContain("escape classes: original_defect 1  remediation_defect 0  test_gap 0  process 0  new_scope 0  unclassified 1")
    expect(all).not.toContain("| u1 |")
    const one = await handleReadLedger(ledgerPath, { query: "review_outcomes", phase: "p1" })
    expect(one).toMatch(/p1\s*\|\s*u1\s*\|\s*1\s*\|\s*#1\s*\|\s*declared_external\s*\|\s*rejection\s*\|\s*original_defect/)
  })
})
