// Per-unit review coverage (0.6.20). The gate keys review currency on each unit's attempt
// instead of the phase's newest verdict; record_review data.units scopes a seat's snapshot;
// the stamp basis is the weakest per-unit class. Every pre-0.6.20 message is pinned
// elsewhere (fieldFeedback2026-09b/d/e, reviewBasis) and stays byte-identical — the tests
// here cover the appended sentences and the new behaviour, plus the two critique attacks
// (legacy whole-phase keying; a verification's self-declared units are not a credential).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import {
  coversUnit, coveredUnits, isFullyCurrent, isSuperseded, seatCoverage, trimReviews, REVIEW_RETENTION,
} from "../src/lib/reviewPredicates.js"
import { classifyGate, weakestBasis, OUTCOMES_POLICY_VERSION } from "../src/lib/reviewBasis.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { resolveModelRank } from "../src/lib/modelRank.js"
import { renderShape } from "../src/lib/schemaDoc.js"
import { LedgerOperationDataSchemas, WriteLedgerInputSchema } from "../src/types.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { Phase, PhaseReview, WriteLedgerInput } from "../src/types.js"

// ─── Fixtures ────────────────────────────────────────────────────────────────

let dir: string
let ledgerPath: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T09:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-coverage-"))
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
const pass = (unit_id: string, extra: Record<string, unknown> = {}) =>
  ({ operation: "set_verdict", phase: "p1", unit_id, data: { v: "pass", ...extra } })
const reject = (unit_id: string) =>
  ({ operation: "add_rejection", phase: "p1", unit_id, data: { r: "gemini", msg: "assertion names the old symbol", ts: "t" } })
const directFix = (unit_id: string) =>
  ({ operation: "set_unit_status", phase: "p1", unit_id, data: { s: "ip", direct_fix: "tests/a.test.ts: rename the expectation" } })
async function passingUnit(unit_id: string, host: HostId = "claude-code") {
  await write(delegated(unit_id), host)
  await write(pass(unit_id), host)
}
/** Reject, re-delegate and pass again: the unit's attempt moves to the next number. */
async function moveUnit(unit_id: string, host: HostId = "claude-code") {
  await write(reject(unit_id), host)
  await write(delegated(unit_id), host)
  await write(pass(unit_id), host)
}
/** Reject, direct-fix and pass as pitboss-direct: the legacy verification path's shape. */
async function directFixUnit(unit_id: string) {
  await write(reject(unit_id))
  await write(directFix(unit_id))
  await write(pass(unit_id, { via: "pitboss-direct" }))
}
const HIGH = { severity: "high", file: "src/a.ts", line: "42", description: "null deref", classification: "confirmed" }
const independent = (extra: Record<string, unknown> = {}) => ({
  advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"], ...extra,
})
const nativeReview = (extra: Record<string, unknown> = {}) => ({
  advisor: "codex-native", stage: "native", completion: "complete", findings: [], checked: ["src/a.ts"],
  native: {
    reviewers: [
      { agent_id: "r-contract", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
      { agent_id: "r-tests", lens: "tests", completion: "complete", checked: ["tests/a.test.ts"] },
    ],
    verifier_id: "v-1",
  },
  ...extra,
})
const record = (data: Record<string, unknown>, host: HostId = "claude-code") =>
  write({ operation: "record_review", phase: "p1", data }, host)
const gate = (data: Record<string, unknown> = { g: "pass" }, host: HostId = "claude-code") =>
  write({ operation: "update_phase_gate", phase: "p1", data }, host)
const phase = async () => (await readLedger(ledgerPath)).phases.p1
const reviews = async () => (await phase()).reviews ?? []
const lastReviewTs = async () => (await reviews()).at(-1)!.ts
const verification = (baseline_review_ts: string, units: Array<{ unit_id: string; attempt: number }>) => ({
  advisor: "pitboss", stage: "verification", completion: "complete", findings: [], checked: ["src/a.ts"],
  evidence: {
    baseline_review_ts, units, files: ["src/a.ts"],
    tests: { outcome: "pass", command: "npm test", result: "12 passed" },
    probe: { outcome: "pass", method: "removed the guard", result: "focused suite failed as expected" },
  },
})

const review = (extra: Partial<PhaseReview>): PhaseReview => ({ advisor: "x", ts: "2026-09-10T09:00:00.000Z", findings: [], ...extra })
const unit = (attempt_seq: number, v_ts: string) => ({ s: "done" as const, v: "pass" as const, w: "b", rej: [], attempt_seq, v_ts })
const NO_NATIVE = { nativeSeat: () => false, verificationSeat: () => false }
const LOOSE = { nativeSeat: () => true, verificationSeat: () => true }

// ─── The predicates ──────────────────────────────────────────────────────────

describe("coversUnit is the pre-0.6.20 currency filter decomposed per unit", () => {
  const p: Phase = { s: "ip", g: "pending", units: {
    u1: unit(1, "2026-09-10T09:00:01.000Z"), u2: unit(2, "2026-09-10T09:00:05.000Z"),
  } }
  it("a snapshot record covers a unit when written at/after its verdict with its current attempt", () => {
    const r = review({ ts: "2026-09-10T09:00:03.000Z", unit_attempts: { u1: 1, u2: 2 } })
    expect(coversUnit(r, "u1", p)).toBe(true)
    expect(coversUnit(r, "u2", p)).toBe(false)   // written before u2's verdict
    expect(coversUnit(review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 2, u2: 2 } }), "u1", p)).toBe(false)   // attempt moved
    expect(coversUnit(review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u2: 2 } }), "u1", p)).toBe(false)   // registered after the record
    expect(coversUnit(r, "nope", p)).toBe(false)
    expect(coversUnit(review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } }), "constructor", p)).toBe(false)
  })
  it("a legacy record (no snapshot) covers every unit at/after the latest verdict and none before it", () => {
    expect(coveredUnits(review({ ts: "2026-09-10T09:00:05.000Z" }), p)).toEqual(["u1", "u2"])
    expect(coveredUnits(review({ ts: "2026-09-10T09:00:04.000Z" }), p)).toEqual([])
    expect(isFullyCurrent(review({ ts: "2026-09-10T09:00:04.000Z" }), p)).toBe(false)
  })
  it("isFullyCurrent equals the whole-phase filter: at/after the latest verdict and every key matches", () => {
    const phaseLike = (r: PhaseReview) =>
      r.ts >= "2026-09-10T09:00:05.000Z" && (r.unit_attempts === undefined ||
        Object.entries(p.units).every(([id, u]) => (r.unit_attempts?.[id] ?? 0) === u.attempt_seq))
    for (const r of [
      review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } }),
      review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 1 } }),
      review({ ts: "2026-09-10T09:00:04.000Z", unit_attempts: { u1: 1, u2: 2 } }),
      review({ ts: "2026-09-10T09:00:06.000Z" }),
      review({ ts: "2026-09-10T09:00:04.000Z" }),
      review({ ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u2: 2 } }),
    ]) expect(isFullyCurrent(r, p)).toBe(phaseLike(r))
  })
})

describe("seatCoverage", () => {
  const p: Phase = { s: "ip", g: "pending", units: {
    u1: unit(1, "2026-09-10T09:00:01.000Z"), u2: unit(2, "2026-09-10T09:00:05.000Z"),
  } }
  const whole = review({ advisor: "gemini", stage: "independent", ts: "2026-09-10T09:00:02.000Z", unit_attempts: { u1: 1, u2: 1 } })
  it("cross_exam and fan never cover; native covers only when the caller says it is a seat", () => {
    const fan = review({ stage: "fan", ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } })
    const cross = review({ stage: "cross_exam", ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } })
    const native = review({ stage: "native", ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } })
    expect(seatCoverage(p, [fan, cross, native], NO_NATIVE).uncovered).toEqual(["u1", "u2"])
    const cov = seatCoverage(p, [whole, fan, cross, native], LOOSE)
    expect(cov.uncovered).toEqual([])
    expect([...cov.carries.keys()]).toEqual([native])
    expect(cov.byRecord.get(whole)).toEqual(new Set(["u1"]))
  })
  it("carries names the NEWEST seat-grade cover per unit; an older whole seat carries what a scoped one does not", () => {
    const scoped = review({ advisor: "claude", stage: "independent", ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u2: 2 }, units: ["u2"] })
    const cov = seatCoverage(p, [whole, scoped], NO_NATIVE)
    expect(cov.uncovered).toEqual([])
    expect(cov.carries.get(whole)).toEqual(["u1"])
    expect(cov.carries.get(scoped)).toEqual(["u2"])
    expect(cov.byUnit.get("u2")).toEqual([scoped])
  })
  it("a verification extends its retained baseline; a named unit counts only where the blocker validated it [CWE-345]", () => {
    const ev = (units: Array<{ unit_id: string; attempt: number }>, kind?: "worker_delta") => ({
      ...(kind ? { kind } : {}), baseline_review_ts: whole.ts, units, files: ["src/a.ts"],
      tests: { outcome: "pass" as const, command: "npm test", result: "ok" }, probe: { outcome: "pass" as const, method: "read", result: "ok" },
    })
    // u2 re-verdicted after the baseline and named at its current attempt: covered through the verification
    const v = review({ advisor: "pitboss", stage: "verification", ts: "2026-09-10T09:00:07.000Z", evidence: ev([{ unit_id: "u2", attempt: 2 }]) })
    expect(seatCoverage(p, [whole, v], LOOSE).byRecord.get(v)).toEqual(new Set(["u1", "u2"]))
    // the same name with the baseline evicted: nothing
    expect(seatCoverage(p, [v], LOOSE).byRecord.has(v)).toBe(false)
    // u1 re-delegated without a re-verdict (attempt 2, verdict ts unchanged): a legacy direct-fix
    // verification naming u1@2 does not cover it — verificationBlocker never checked it
    const moved: Phase = { ...p, units: { ...p.units, u1: unit(2, "2026-09-10T09:00:01.000Z") } }
    const v2 = review({ advisor: "pitboss", stage: "verification", ts: "2026-09-10T09:00:07.000Z", evidence: ev([{ unit_id: "u1", attempt: 2 }, { unit_id: "u2", attempt: 2 }]) })
    const cov = seatCoverage(moved, [whole, v2], LOOSE)
    expect(cov.byRecord.get(v2)).toEqual(new Set(["u2"]))
    expect(cov.uncovered).toEqual(["u1"])
    // a worker_delta keys "changed" on the attempt (its blocker demands the exact set): u1@2 counts
    const wd = review({ advisor: "pitboss", stage: "verification", ts: "2026-09-10T09:00:07.000Z", evidence: ev([{ unit_id: "u1", attempt: 2 }, { unit_id: "u2", attempt: 2 }], "worker_delta") })
    expect(seatCoverage(moved, [whole, wd], LOOSE).uncovered).toEqual([])
    // the caller's eligibility verdict decides whether it is a seat at all
    expect(seatCoverage(p, [whole, v], { ...LOOSE, verificationSeat: () => false }).uncovered).toEqual(["u2"])
  })
  it("isSuperseded with a phase requires the superseding record to cover every unit the superseded one covers", () => {
    const partial = review({ advisor: "codex", stage: "independent", completion: "partial", ts: "2026-09-10T09:00:06.000Z", unit_attempts: { u1: 1, u2: 2 } })
    const scopedRerun = review({ advisor: "codex", stage: "independent", completion: "complete", checked: ["a"], ts: "2026-09-10T09:00:07.000Z", unit_attempts: { u2: 2 }, units: ["u2"] })
    const wholeRerun = review({ advisor: "codex", stage: "independent", completion: "complete", checked: ["a"], ts: "2026-09-10T09:00:08.000Z", unit_attempts: { u1: 1, u2: 2 } })
    expect(isSuperseded(partial, [partial, scopedRerun])).toBe(true)          // pure pool, no phase: as before
    expect(isSuperseded(partial, [partial, scopedRerun], p)).toBe(false)
    expect(isSuperseded(partial, [partial, scopedRerun, wholeRerun], p)).toBe(true)
  })
})

describe("weakestBasis", () => {
  it("names the weakest class present and 'override' when there is none", () => {
    expect(weakestBasis([])).toBe("override")
    expect(weakestBasis(["receipted_external"])).toBe("receipted_external")
    expect(weakestBasis(["declared_external", "same_provider", "receipted_external"])).toBe("same_provider")
    expect(weakestBasis(["delta:declared_external", "declared_external"])).toBe("delta:declared_external")
    expect(weakestBasis(["receipted", "override"])).toBe("override")
  })
  it("classifyGate without a coverage map is the pre-0.6.20 arithmetic: strongest seat, no units on the rows", () => {
    const p: Phase = { s: "ip", g: "pending", units: { u1: unit(1, "t"), u2: unit(1, "t") } }
    const ext = review({ advisor: "gemini", stage: "independent", ts: "2026-09-10T09:00:01.000Z" })
    const nat = review({ advisor: "codex-native", stage: "native", ts: "2026-09-10T09:00:02.000Z" })
    const g = classifyGate({ host: "codex", phaseObj: p, currentReviews: [ext, nat], seats: [ext, nat], allReviews: [ext, nat], modelRank: resolveModelRank(), overrides: [], ts: "t" })
    expect(g.basis).toBe("declared_external")
    expect(g.seats.map((s) => s.units)).toEqual([undefined, undefined])
    expect(g.policy_version).toBe(2)
    expect(OUTCOMES_POLICY_VERSION).toBe(2)
    // with a map: per unit, weakest; a seat missing from the map covers nothing
    const g2 = classifyGate({ host: "codex", phaseObj: p, currentReviews: [ext, nat], seats: [ext, nat], allReviews: [ext, nat], modelRank: resolveModelRank(), overrides: [], ts: "t",
      coverage: new Map([[ext, new Set(["u1"])], [nat, new Set(["u2"])]]) })
    expect(g2.basis).toBe("same_provider")
    expect(g2.seats.map((s) => s.units)).toEqual([1, 1])
    const g3 = classifyGate({ host: "codex", phaseObj: p, currentReviews: [ext], seats: [ext], allReviews: [ext], modelRank: resolveModelRank(), overrides: [], ts: "t", coverage: new Map() })
    expect(g3.basis).toBe("override")
  })
})

// ─── The gate through the ledger ─────────────────────────────────────────────

describe("REVIEW REQUIRED names the uncovered units after one unit moves", () => {
  it("keeps the pinned lead sentence and appends UNCOVERED UNITS with the attempt and what is still covered", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record(independent())
    await moveUnit("u3")
    const err = await gate().catch((e: Error) => e) as Error
    expect(err.message).toMatch(/^REVIEW REQUIRED: phase 'p1' has no record_review entry recorded at or after its latest unit verdict\. 1 older review\(s\) exist but predate the latest unit verdict — a review recorded before a re-verdict does not cover the current code; re-run the review\. Run the checkpoint deliberation/)
    expect(err.message).toContain(" UNCOVERED UNITS: u3 (attempt #2) — no seat-grade record matches the unit's current attempt at or after its verdict. Cover them with a later independent/native review — record it with data.units: [<the units the seat examined>] when it examined only those, omit data.units for a whole-phase seat — or with an eligible verification naming the unit and attempt. Still covered by earlier records: u1, u2.")
    expect(err.message.indexOf("VERIFICATION NOT ELIGIBLE")).toBeLessThan(err.message.indexOf("UNCOVERED UNITS"))
  })
  it("a unit registered after the only record is uncovered by it", async () => {
    await passingUnit("u1")
    await record(independent())
    await passingUnit("u2")
    await expect(gate()).rejects.toThrow(/UNCOVERED UNITS: u2 \(attempt #1\)[\s\S]*Still covered by earlier records: u1\.$/)
  })
  it("with every unit uncovered there is no 'still covered' clause", async () => {
    await passingUnit("u1")
    await expect(gate()).rejects.toThrow(/UNCOVERED UNITS: u1 \(attempt #1\)[\s\S]*naming the unit and attempt\.$/)
  })
  it("a review override with uncovered units stamps no seat and counts only fully-current records, as before", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    await record(independent({ tokens: 500 }))
    await moveUnit("u2")
    await record({ advisor: "pitboss", stage: "cross_exam", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await gate({ g: "pass", user_override: true })
    const g = (await phase()).gate_history![0]
    expect(g.basis).toBe("override")
    expect(g.seats).toEqual([])
    expect(g.present).toEqual({ cross_exam: 1 })
    expect(g.seat_agents).toBe(0)
    expect(g.tokens).toEqual({ receipted: 0, declared: 0, unreported: 0 })
    expect(g.overrides).toEqual(["review"])
    expect((await phase()).gate_totals).toEqual({ override: { gates: 1, regates: 0, units: 2, seat_agents: 0, tokens_receipted: 0, tokens_declared: 0, tokens_unreported: 0 } })
  })
})

describe("a scoped record covers the units it names and the earlier seat keeps the rest", () => {
  it("passes the gate; the stamp lists both carrying seats with their unit counts and the phase's attempts", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record(independent({ tokens: 1000 }))
    const wholeTs = await lastReviewTs()
    await moveUnit("u3")
    const { warning } = await record(independent({ advisor: "claude", units: ["u3"], tokens: 100 }))
    expect(warning).toBe("REVIEW SCOPE: record covers 1 of 3 unit(s); not covered by this record: u1, u2.")
    const scoped = (await reviews()).at(-1)!
    expect(scoped.units).toEqual(["u3"])
    expect(scoped.unit_attempts).toEqual({ u3: 2 })
    await gate()
    const p = await phase()
    expect(p.g).toBe("pass")
    const g = p.gate_history![0]
    expect(g.seats).toEqual([
      { advisor: "gemini", ts: wholeTs, stage: "independent", basis: "declared_external", units: 2 },
      { advisor: "claude", ts: scoped.ts, stage: "independent", basis: "declared_external", units: 1 },
    ])
    expect(g.present).toEqual({ independent: 2 })
    expect(g.unit_attempts).toEqual({ u1: 1, u2: 1, u3: 2 })
    expect(g.basis).toBe("declared_external")
    expect(g.seat_agents).toBe(2)
    expect(g.tokens).toEqual({ receipted: 0, declared: 1100, unreported: 0 })
    expect(g.policy_version).toBe(2)
    expect(p.gate_totals?.declared_external).toMatchObject({ gates: 1, units: 3, seat_agents: 2 })
    // escapes still attribute through the stamp's attempt snapshot
    await write(reject("u1"))
    expect(p.escapes ?? (await phase()).escapes).toMatchObject([{ unit_id: "u1", attempt: 1, gate_seq: 1, basis: "declared_external" }])
  })
  it("narrowing only: a scoped record over an unmoved unit covers nothing new", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    await record(independent())
    await moveUnit("u2")
    await record(independent({ advisor: "claude", units: ["u1"] }))
    await expect(gate()).rejects.toThrow(/UNCOVERED UNITS: u2 \(attempt #2\)/)
  })
  it("read_ledger reviews shows the scope size on a zero-finding row", async () => {
    await passingUnit("u1")
    await record(independent({ units: ["u1"] }))
    const text = await handleReadLedger(ledgerPath, { query: "reviews" })
    expect(text).toContain("(no findings; completion=complete; checked=1; units=1; stage=independent)")
  })
  it("dedupes and sorts the scope", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    await record(independent({ units: ["u2", "u1", "u2"] }))
    const r = (await reviews()).at(-1)!
    expect(r.units).toEqual(["u1", "u2"])
    expect(r.unit_attempts).toEqual({ u1: 1, u2: 1 })
    const { warning } = await record(independent({ units: ["u1", "u2"] }))
    expect(warning).toBe("REVIEW SCOPE: record covers 2 of 2 unit(s).")
  })
})

describe("REVIEW SCOPE refusals", () => {
  it("refuses data.units with a stage that carries no snapshot, before any other check", async () => {
    await passingUnit("u1")
    for (const stage of ["cross_exam", "fan", "verification"]) {
      await expect(record({ advisor: "x", stage, findings: [], units: ["u1"] }))
        .rejects.toThrow("REVIEW SCOPE: data.units is accepted with stage undefined, 'independent' or 'native' only.")
    }
    // a scoped verification is refused on scope, not on its missing evidence
    await expect(record({ advisor: "x", stage: "verification", completion: "complete", findings: [], units: ["u1"] }))
      .rejects.toThrow(/^REVIEW SCOPE/)
  })
  it("refuses unregistered ids and prototype keys [CWE-20]", async () => {
    await passingUnit("u1")
    await expect(record(independent({ units: ["u1", "u9"] })))
      .rejects.toThrow("REVIEW SCOPE: phase 'p1' has no registered unit(s) u9; data.units names registered units only — omit it to snapshot the whole phase.")
    await expect(record(independent({ units: ["constructor"] }))).rejects.toThrow(/REVIEW SCOPE: phase 'p1' has no registered unit\(s\) constructor;/)
    await expect(record(independent({ units: ["__proto__"] }))).rejects.toThrow(/REVIEW SCOPE: phase 'p1' has no registered unit\(s\) __proto__;/)
    // an unregistered id that only the schema would refuse is still unregistered here
    await expect(record(independent({ units: ["a,b"] }))).rejects.toThrow(/REVIEW SCOPE: phase 'p1' has no registered unit\(s\) a,b;/)
    // the ledger refuses an empty scope on its own; the schema refuses it and comma/newline ids first
    await expect(record(independent({ units: [] })))
      .rejects.toThrow("REVIEW SCOPE: data.units names at least one registered unit; omit it to snapshot the whole phase.")
    expect(await reviews()).toEqual([])
    const parse = (units: string[]) => WriteLedgerInputSchema.safeParse({ operation: "record_review", phase: "p1", data: independent({ units }) }).success
    expect(parse([])).toBe(false)
    expect(parse(["a,b"])).toBe(false)
    expect(parse(["a\nb"])).toBe(false)
    expect(parse([" u1"])).toBe(false)
    expect(parse(["u1"])).toBe(true)
  })
  it("the data schema renders the field", () => {
    expect(renderShape(LedgerOperationDataSchemas.record_review)).toContain("units?: string (≥1 chars, ≤200 chars)[] (max 200)")
  })
})

describe("earlier seats keep blocking while they carry a unit", () => {
  it("a confirmed finding on the older whole seat blocks until its units are re-covered", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record(independent({ findings: [HIGH] }))
    const older = await lastReviewTs()
    await moveUnit("u3")
    await record(independent({ advisor: "claude", units: ["u3"] }))
    await expect(gate()).rejects.toThrow(
      `CONFIRMED FINDINGS: phase 'p1' has 1 confirmed review finding(s) recorded since its latest unit verdict: gemini: src/a.ts:42 null deref. ` +
      "Reject the affected unit(s) (add_rejection → fix → set_verdict), then record a fresh review that shows the finding resolved before the gate can pass — " +
      "or set data.user_override: true to waive it; the waiver is recorded on the phase as confirmed_override." +
      ` 1 of these record(s) predate the latest verdict but still carry unit(s) no later seat covers: gemini@${older} → u1, u2.`
    )
    // a scoped clean record over exactly the carried units retires it
    await record(independent({ advisor: "claude", units: ["u1", "u2"] }))
    await gate()
    const g = (await phase()).gate_history![0]
    expect(g.seats.map((s) => [s.advisor, s.units])).toEqual([["claude", 1], ["claude", 2]])
    expect(g.present).toEqual({ independent: 2 })
  })
  it("an incomplete older seat is superseded only by a re-run covering what it still carries", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record({ advisor: "codex", stage: "independent", completion: "partial", findings: [] })
    const older = await lastReviewTs()
    await moveUnit("u3")
    await record({ advisor: "codex", stage: "independent", completion: "complete", findings: [], checked: ["src/c.ts"], units: ["u3"] })
    await expect(gate()).rejects.toThrow(
      /INCOMPLETE REVIEW: phase 'p1' has 1 review\(s\) recorded since its latest unit verdict that do not cover the phase: codex: completion=partial\. [\s\S]*incomplete_override\. 1 of these record\(s\) predate the latest verdict but still carry unit\(s\) no later seat covers: codex@\S+ → u1, u2\.$/
    )
    expect((await gate().catch((e: Error) => e.message)) as string).toContain(`codex@${older} → u1, u2.`)
    await record({ advisor: "codex", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await gate()
    expect((await phase()).g).toBe("pass")
    expect((await phase()).incomplete_override).toBeUndefined()
  })
})

describe("legacy records stay whole-phase keyed (critique regression)", () => {
  it("a legacy record beside a new whole seat does not carry a unit re-delegated without a re-verdict", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record(independent())
    const ledger = await readLedger(ledgerPath)
    delete ledger.phases.p1.reviews![0].unit_attempts   // a record written before 0.6.18
    delete ledger.phases.p1.reviews![0].basis_version
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await write(pass("u3"))                             // pass → pass re-verdict stales the legacy record
    await record(independent({ advisor: "claude" }))    // new-format whole seat: u1:1, u2:1, u3:1
    await gate()                                        // sanity: the new seat covers everything
    await gate({ g: "pending" })
    await write(delegated("u1"))                        // attempt 2, verdict untouched (still pass)
    expect((await phase()).units.u1).toMatchObject({ v: "pass", attempt_seq: 2 })
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*UNCOVERED UNITS: u1 \(attempt #2\)[\s\S]*Still covered by earlier records: u2, u3\.$/)
  })
  // Verifier regression (0.6.20): a legacy baseline covers nothing once a unit is re-verdicted,
  // so the verification that extends it must carry the untouched units itself — the blocker
  // validated the whole-phase claim, and before 0.6.20 that record was the seat for the phase.
  async function legacyBaseline(): Promise<string> {
    await record(independent())
    const ledger = await readLedger(ledgerPath)
    delete ledger.phases.p1.reviews![0].unit_attempts   // a record written before 0.6.18
    delete ledger.phases.p1.reviews![0].basis_version
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    return lastReviewTs()
  }
  it("a legacy baseline anchoring an eligible direct-fix verification still covers the untouched units (pre-0.6.20 outcome)", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    const baseline = await legacyBaseline()
    await directFixUnit("u2")
    await record(verification(baseline, [{ unit_id: "u2", attempt: 2 }]))
    await gate()
    const g = (await phase()).gate_history![0]
    expect(g.seats).toHaveLength(1)
    expect(g.seats[0]).toMatchObject({ advisor: "pitboss", stage: "verification", kind: "direct_fix", baseline_ts: baseline })
    expect(g.seats[0].units).toBeUndefined()            // covers every unit: no count on the row
    expect(g.present).toEqual({ verification: 1 })
  })
  it("a legacy baseline never covers a unit that recorded an attempt after it without a re-verdict", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    const baseline = await legacyBaseline()
    await directFixUnit("u2")
    await write(delegated("u1"))                        // attempt 2, verdict still pass: outside the blocker's checks
    await record(verification(baseline, [{ unit_id: "u2", attempt: 2 }]))
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*UNCOVERED UNITS: u1 \(attempt #2\)[\s\S]*Still covered by earlier records: u2\.$/)
  })
})

describe("a verification's named units are not a credential (critique regression) [CWE-345]", () => {
  it("naming a unit re-delegated without a re-verdict does not cover it; the gate names it", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u)
    await record(independent())
    const baseline = await lastReviewTs()
    await directFixUnit("u2")                           // attempt 2, re-verdicted as a direct fix
    await write(delegated("u1"))                        // attempt 2, verdict still pass
    await record(verification(baseline, [{ unit_id: "u1", attempt: 2 }, { unit_id: "u2", attempt: 2 }]))
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*UNCOVERED UNITS: u1 \(attempt #2\)[\s\S]*Still covered by earlier records: u2\.$/)
  })
  it("an eligible verification over a re-verdicted direct fix still passes with the baseline's LOW tolerated and a delta stamp", async () => {
    await passingUnit("u1")
    await record(independent({ findings: [{ ...HIGH, severity: "low", description: "test name typo" }] }))
    const baseline = await lastReviewTs()
    await directFixUnit("u1")
    await record(verification(baseline, [{ unit_id: "u1", attempt: 2 }]))
    await gate()
    const g = (await phase()).gate_history![0]
    expect(g.basis).toBe("delta:declared_external")
    expect(g.seats).toHaveLength(1)
    expect(g.seats[0]).toMatchObject({ advisor: "pitboss", stage: "verification", kind: "direct_fix", baseline_ts: baseline })
    expect(g.seats[0].units).toBeUndefined()
    expect(g.delta_units).toEqual(["u1"])
    expect(g.present).toEqual({ verification: 1 })
  })
  it("a scoped record cannot anchor a verification and is not offered as a prospective baseline", async () => {
    await passingUnit("u1")
    await record(independent({ units: ["u1"] }))
    const scoped = await lastReviewTs()
    await directFixUnit("u1")
    await expect(gate()).rejects.toThrow(/VERIFICATION NOT ELIGIBLE \(a fresh seat is needed\): no complete independent review predates the latest unit verdict\./)
    await record(verification(scoped, [{ unit_id: "u1", attempt: 2 }]))
    await expect(gate()).rejects.toThrow(/pitboss: baseline review is scoped to 1 unit\(s\); a verification extends a whole-phase baseline only\)/)
  })
})

describe("the gate basis is the weakest per-unit class", () => {
  it("a moved unit covered only by native review makes the pass same_provider on Codex", async () => {
    for (const u of ["u1", "u2"]) await passingUnit(u, "codex")
    await record(independent(), "codex")
    await moveUnit("u2", "codex")
    await record(nativeReview({ units: ["u2"] }), "codex")
    await gate({ g: "pass" }, "codex")
    const g = (await phase()).gate_history![0]
    expect(g.basis).toBe("same_provider")
    expect(g.seats.map((s) => [s.stage, s.basis, s.units])).toEqual([["independent", "declared_external", 1], ["native", "same_provider", 1]])
    expect(g.seat_agents).toBe(4)
    expect((await readLedger(ledgerPath)).independence).toEqual({ streak: 1, phases: ["p1"] })
  })
  it("two whole seats on one snapshot both count and the stamp carries no unit counts", async () => {
    await passingUnit("u1")
    await record(independent())
    await record(independent({ advisor: "claude" }))
    await gate()
    const g = (await phase()).gate_history![0]
    expect(g.seats.map((s) => s.units)).toEqual([undefined, undefined])
    expect(g.basis).toBe("declared_external")
  })
})

describe("retention protects carrying and covering records", () => {
  it("N scoped records over N units all survive: the bound is unit count, not REVIEW_RETENTION", async () => {
    const n = REVIEW_RETENTION + 2
    for (let i = 0; i < n; i++) await passingUnit(`u${i}`)
    for (let i = 0; i < n; i++) await record(independent({ advisor: `seat${i}`, units: [`u${i}`] }))
    expect(await reviews()).toHaveLength(n)
    for (let i = 0; i < 5; i++) await record({ advisor: "pitboss", stage: "cross_exam", completion: "complete", findings: [], checked: ["src/a.ts"] })
    const kept = await reviews()
    expect(kept).toHaveLength(n)
    expect(kept.every((r) => r.units !== undefined)).toBe(true)
    await gate()
    expect((await phase()).gate_history![0].seats).toHaveLength(10)   // GATE_SEATS_MAX
  })
  it("an older confirmed-HIGH whole seat behind an ineligible verification survives twenty fillers and still blocks", async () => {
    for (const u of ["u1", "u2", "u3"]) await passingUnit(u)
    await record(independent())
    const clean = await lastReviewTs()
    await record(independent({ advisor: "claude", findings: [HIGH] }))
    const blocking = await lastReviewTs()
    await directFixUnit("u3")
    await record(verification(clean, [{ unit_id: "u3", attempt: 2 }]))   // ineligible: a HIGH sits in its window
    for (let i = 0; i < 20; i++) await record({ advisor: `pb${i}`, stage: "cross_exam", completion: "complete", findings: [], checked: ["src/a.ts"] })
    const kept = await reviews()
    expect(kept.some((r) => r.ts === blocking)).toBe(true)
    expect(kept.some((r) => r.ts === clean)).toBe(true)
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*claude: 1 confirmed finding\(s\) above LOW since the baseline review|REVIEW REQUIRED[\s\S]*pitboss: 1 confirmed finding\(s\) above LOW/)
    // re-cover u3 with a scoped seat: the carried HIGH is what blocks, not eviction letting it pass
    await record(independent({ advisor: "fresh", units: ["u3"] }))
    await expect(gate()).rejects.toThrow(/CONFIRMED FINDINGS[\s\S]*claude: src\/a\.ts:42 null deref[\s\S]*claude@\S+ → u1, u2\.$/)
  })
  it("trimReviews is pure over a phase and evicts the oldest unprotected first", () => {
    const p: Phase = { s: "ip", g: "pending", units: { u1: unit(1, "2026-09-10T09:00:01.000Z") } }
    const list: PhaseReview[] = []
    for (let i = 0; i < REVIEW_RETENTION + 3; i++) {
      list.push(review({ advisor: `s${i}`, stage: "cross_exam", completion: "complete", ts: `2026-09-10T09:00:${String(10 + i).padStart(2, "0")}.000Z` }))
    }
    const kept = trimReviews(list, p)
    expect(kept).toHaveLength(REVIEW_RETENTION)
    expect(kept[0]).toBe(list[3])
  })
})
