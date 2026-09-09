// Field feedback 2026-09, round 6 (v0.6.9): the paid review loop at the phase gate.
// A pitboss on another project ran six review rounds (two seats each) on one phase
// because every LOW fix re-verdicted a unit, which staled the review, which demanded a
// fresh seat. Codex (gpt-6-astra) replayed the ledger and found the enforcement holes
// fixed here; each test below mirrors one replayed sequence.
//   1. a failed/partial/silent review could be the verification baseline
//   2. a worker attempt between the baseline and a direct fix got no seat
//   3. review retention (20) could evict a current confirmed finding — gate passed
//   4. a failed/silent seat could never be superseded by a successful re-run
//   5. REVIEW REQUIRED now states whether a verification record is eligible right now
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import type { SidecarEvent } from "../src/lib/eventsSidecar.js"
import type { VerificationEvidence } from "../src/types.js"

let tmpDir: string
let ledgerPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-2026-09e-"))
  ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }
const LOW = { severity: "low" as const, file: "src/a.ts", line: "7", description: "test name typo", classification: "confirmed" as const }
const HIGH = { severity: "high" as const, file: "src/a.ts", line: "42", description: "null deref", classification: "confirmed" as const }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function delegate(unit: string) {
  return writeLedger(ledgerPath, {
    operation: "set_unit_status",
    phase: "p1",
    unit_id: unit,
    data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT },
  })
}
async function directFix(unit: string, what = "src/a.ts: rename fooBar to foo_bar") {
  return writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: unit, data: { s: "ip", direct_fix: what } })
}
async function reject(unit: string, msg = "not what the spec says") {
  return writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: unit, data: { r: "reviewer", msg, ts: "2026-09-08T00:00:00Z" } })
}
async function verdict(unit: string, v: "pass" | "fail", opts: { via?: "worker" | "pitboss-direct" } = {}) {
  return writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: unit, data: { v, ...opts } })
}
async function review(data: Record<string, unknown>) {
  return writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data } as never)
}
async function gate(opts: { user_override?: boolean } = {}, sidecar?: () => Promise<SidecarEvent[]>) {
  return writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", ...opts } }, undefined, sidecar)
}
async function delegatePass(unit: string) {
  await delegate(unit)
  await verdict(unit, "pass")
}
async function reviews() {
  return (await readLedger(ledgerPath)).phases.p1.reviews ?? []
}
async function latestReviewTs(): Promise<string> {
  const all = await reviews()
  return all[all.length - 1].ts
}
function evidence(over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    baseline_review_ts: "",
    units: [{ unit_id: "u1", attempt: 2 }],
    files: ["src/a.ts"],
    tests: { outcome: "pass", command: "npm test", result: "12 passed" },
    probe: { outcome: "pass", method: "removed the guard", result: "focused suite failed as expected" },
    ...over,
  }
}
const CLEAN = { completion: "complete", findings: [], checked: ["src/a.ts"] }

/** Independent review (default LOW-only, complete), then a direct-fix re-verdict of u1 (attempt 2). Returns the baseline ts. */
async function baselineThenDirectFix(baseline: Record<string, unknown> = { advisor: "codex", stage: "independent", completion: "complete", findings: [LOW], checked: ["src/a.ts"] }): Promise<string> {
  await delegatePass("u1")
  await sleep(5)
  await review(baseline)
  const ts = await latestReviewTs()
  await sleep(5)
  await reject("u1", "nit")
  await directFix("u1")
  await verdict("u1", "pass", { via: "pitboss-direct" })
  await sleep(5)
  return ts
}

// ─── 1. baseline completeness ──────────────────────────────────────────────────

describe("verification baseline must be a complete seat", () => {
  it("a completion:'failed' baseline is refused", async () => {
    const baseline = await baselineThenDirectFix({ advisor: "codex", stage: "independent", completion: "failed", findings: [], limitations: "timeout" })
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*pitboss: baseline review codex@[^ ]+ is not a complete seat \(completion=failed\)/)
  })

  it("a silent baseline (zero findings, no examined list) is refused", async () => {
    const baseline = await baselineThenDirectFix({ advisor: "codex", findings: [] })
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    await expect(gate()).rejects.toThrow(/is not a complete seat \(zero findings with no examined list\)/)
  })

  it("a complete LOW-only baseline still qualifies (regression)", async () => {
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], checked: ["src/a.ts"], evidence: evidence({ baseline_review_ts: baseline }) })
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })
})

// ─── 2. every attempt since the baseline must be a direct fix ──────────────────

describe("verification covers every attempt since the baseline", () => {
  it("a worker delegation between the baseline and the direct fix is refused", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", stage: "independent", completion: "complete", findings: [LOW], checked: ["src/a.ts"] })
    const baseline = await latestReviewTs()
    await sleep(5)
    // attempt 2: a worker changes behaviour and passes
    await reject("u1", "behaviour")
    await delegate("u1")
    await verdict("u1", "pass", { via: "worker" })
    await sleep(5)
    // attempt 3: a literal direct fix passes — the unit's current state looks like a direct fix
    await reject("u1", "nit")
    await directFix("u1")
    await verdict("u1", "pass", { via: "pitboss-direct" })
    await sleep(5)
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline, units: [{ unit_id: "u1", attempt: 3 }] }) })
    await expect(gate()).rejects.toThrow(/unit 'u1' had a worker delegation \(attempt #2\) after the baseline review/)
  })

  it("an invoke_worker delegation in the sidecar after the baseline is refused", async () => {
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    const later = new Date(Date.now() + 1000).toISOString()
    // A closed, passing chain for a remote attempt that is NOT the current attempt: the
    // discipline gate is satisfied, the verification predicate is what refuses.
    const sidecar = async () => [
      { phase: "p1", unit_id: "u1", attempt: 9, delegation_id: "d9", event_type: "validation_completed", outcome: "pass", ts: later } as unknown as SidecarEvent,
    ]
    await expect(gate({}, sidecar)).rejects.toThrow(/unit 'u1' has an invoke_worker delegation \(attempt #9\) after the baseline review/)
  })
})

// ─── 3. retention never evicts live enforcement state ──────────────────────────

describe("review retention keeps blocking records", () => {
  it("a current confirmed finding survives twenty clean appends and still blocks", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", ...CLEAN, findings: [HIGH] })
    const blocking = await latestReviewTs()
    for (let i = 0; i < 20; i++) await review({ advisor: `seat${i}`, ...CLEAN })
    const retained = await reviews()
    expect(retained).toHaveLength(20)
    expect(retained.some((r) => r.ts === blocking)).toBe(true)
    await expect(gate()).rejects.toThrow(/CONFIRMED FINDINGS[\s\S]*null deref/)
  })

  it("a current failed seat survives eviction until superseded", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "failed", findings: [], limitations: "timeout" })
    const failed = await latestReviewTs()
    for (let i = 0; i < 20; i++) await review({ advisor: `seat${i}`, ...CLEAN })
    expect((await reviews()).some((r) => r.ts === failed)).toBe(true)
    await expect(gate()).rejects.toThrow(/INCOMPLETE REVIEW[\s\S]*codex: completion=failed/)
  })

  it("the baseline of a current verification record is protected", async () => {
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], checked: ["src/a.ts"], evidence: evidence({ baseline_review_ts: baseline }) })
    for (let i = 0; i < 20; i++) await review({ advisor: `seat${i}`, ...CLEAN })
    const retained = await reviews()
    expect(retained).toHaveLength(20)
    expect(retained.some((r) => r.ts === baseline)).toBe(true)
  })

  it("stale clean reviews are still capped at 20", async () => {
    await delegatePass("u1")
    for (let i = 0; i < 25; i++) await review({ advisor: `seat${i}`, ...CLEAN })
    expect(await reviews()).toHaveLength(20)
  })
})

// ─── 4. a successful re-run supersedes a failed or silent seat ─────────────────

describe("failed or silent seats are superseded by a later complete record", () => {
  it("same advisor, later complete record: the failure no longer blocks", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "failed", findings: [], limitations: "timeout" })
    await expect(gate()).rejects.toThrow(/INCOMPLETE REVIEW/)
    await sleep(5)
    await review({ advisor: "codex", ...CLEAN })
    await gate()
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.incomplete_override).toBeUndefined()
  })

  it("a different advisor does not supersede", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "failed", findings: [], limitations: "timeout" })
    await sleep(5)
    await review({ advisor: "gemini", ...CLEAN })
    await expect(gate()).rejects.toThrow(/INCOMPLETE REVIEW[\s\S]*codex: completion=failed/)
  })

  it("a later record that is itself incomplete does not supersede", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "failed", findings: [], limitations: "timeout" })
    await sleep(5)
    await review({ advisor: "codex", completion: "partial", findings: [], checked: ["src/a.ts"] })
    await expect(gate()).rejects.toThrow(/INCOMPLETE REVIEW[\s\S]*codex: completion=failed[\s\S]*codex: completion=partial/)
  })

  it("supersession never retires a confirmed finding on the superseded record", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "partial", findings: [HIGH], checked: ["src/a.ts"] })
    await sleep(5)
    await review({ advisor: "codex", ...CLEAN })
    await expect(gate()).rejects.toThrow(/CONFIRMED FINDINGS[\s\S]*null deref/)
  })

  it("a cross_exam record does not supersede an independent failure", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", stage: "independent", completion: "failed", findings: [], limitations: "timeout" })
    await sleep(5)
    await review({ advisor: "codex", stage: "cross_exam", ...CLEAN })
    await expect(gate()).rejects.toThrow(/INCOMPLETE REVIEW[\s\S]*codex: completion=failed/)
  })
})

// ─── 5. REVIEW REQUIRED states verification eligibility ────────────────────────

describe("REVIEW REQUIRED names the verification path when it is open", () => {
  it("eligible: the message carries the record shape with the baseline ts and the direct-fix attempt", async () => {
    const baseline = await baselineThenDirectFix()
    const err = await gate().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const msg = (err as Error).message
    expect(msg).toMatch(/REVIEW REQUIRED/)
    expect(msg).toMatch(/VERIFICATION ELIGIBLE/)
    expect(msg).toContain(`baseline_review_ts: "${baseline}"`)
    expect(msg).toContain('{ unit_id: "u1", attempt: 2 }')
    expect(msg).toMatch(/stage: "verification"/)
  })

  it("not eligible after a worker re-verdict: the blocker is named", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", stage: "independent", completion: "complete", findings: [LOW], checked: ["src/a.ts"] })
    await sleep(5)
    await reject("u1", "nit")
    await delegate("u1")
    await verdict("u1", "pass", { via: "worker" })
    await sleep(5)
    await expect(gate()).rejects.toThrow(/VERIFICATION NOT ELIGIBLE \(a fresh seat is needed\): unit 'u1' was re-verdicted after the baseline but not as a passing direct fix/)
  })

  it("not eligible when a confirmed finding above LOW was recorded since the baseline", async () => {
    await baselineThenDirectFix({ advisor: "codex", stage: "independent", completion: "complete", findings: [HIGH], checked: ["src/a.ts"] })
    await expect(gate()).rejects.toThrow(/VERIFICATION NOT ELIGIBLE[^\n]*1 confirmed finding\(s\) above LOW since the baseline review/)
  })

  it("not eligible when no complete independent review predates the latest verdict", async () => {
    await baselineThenDirectFix({ advisor: "codex", completion: "failed", findings: [], limitations: "timeout" })
    await expect(gate()).rejects.toThrow(/VERIFICATION NOT ELIGIBLE[^\n]*no complete independent review predates the latest unit verdict/)
  })

  it("not eligible on a security_boundary phase", async () => {
    await writeLedger(ledgerPath, { operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: false, has_build: true, security_boundary: true } })
    await baselineThenDirectFix()
    await expect(gate({ agent_class: "frontier" } as never, async () => [])).rejects.toThrow(/VERIFICATION NOT ELIGIBLE[^\n]*phase is scoped hot_path or security_boundary/)
  })

  it("an eligible hint followed by the exact record passes the gate", async () => {
    const baseline = await baselineThenDirectFix()
    const msg = ((await gate().catch((e: Error) => e)) as Error).message
    expect(msg).toMatch(/VERIFICATION ELIGIBLE/)
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], checked: ["src/a.ts"], evidence: evidence({ baseline_review_ts: baseline }) })
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })
})
