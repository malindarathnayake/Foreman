import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger, recordRepoGuard, writeLedger, type SidecarReader } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { resolveModelRank, type ModelRank } from "../src/lib/modelRank.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { RepoSnapshot, VerificationEvidence, WriteLedgerInput } from "../src/types.js"
import type { SidecarEvent } from "../src/lib/eventsSidecar.js"

const TOP = { ...resolveModelRank("astra", "high"), session_id: "session-one" }
const MIDDLE = { ...resolveModelRank("terra"), session_id: "session-one" }
const UNKNOWN = { ...resolveModelRank(), session_id: "session-one" }
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }
const FILES = ["src/a.ts", "tests/a.test.ts"]
let directory: string
let ledgerPath: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-rank-workflow-"))
  ledgerPath = path.join(directory, "ledger.json")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"))
})
afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(directory, { recursive: true, force: true })
})

async function write(operation: WriteLedgerInput, rank: ModelRank = TOP, host: HostId = "codex", events?: SidecarReader) {
  const result = await writeLedger(ledgerPath, operation, undefined, events ?? (async () => []), host, rank)
  vi.setSystemTime(Date.now() + 10)
  return result
}
const unit = async () => (await readLedger(ledgerPath)).phases.p1.units.u1
const snapshot = (allowed = FILES, root = directory): RepoSnapshot => ({
  root, branch: "main", head: "head", stash_ref: "none", stash_count: 0, autocrlf: "false",
  eol: [], entries: [], truncated: false, allowed, hash: "snapshot-hash",
})
async function guard(allowed = FILES, root = directory) {
  await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot(allowed, root), snapshot_ts: new Date().toISOString() })
  await recordRepoGuard(ledgerPath, "p1", "u1", { result: "ok" })
}
async function delegate(rank = TOP, workerId?: string) {
  return write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
    s: "delegated", brief: "Implement the bounded unit with its specified tests.", preflight: PREFLIGHT, worker_id: workerId,
  } }, rank)
}
async function verdict(v: "pass" | "fail" = "pass", rank = TOP, workerId?: string) {
  return write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v, via: "worker", worker_id: workerId } }, rank)
}
async function initial(rank = TOP) {
  await delegate(rank)
  await guard()
  await verdict("pass", rank, "worker-one")
}
async function correction(rank = TOP, kind: "mechanical" | "bounded" = "bounded", extra: Record<string, unknown> = {}) {
  return write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
    s: "delegated", brief: "Correct the reported assertion within the existing unit.", preflight: PREFLIGHT,
    worker_id: "worker-one", correction: { kind, from_attempt: (await unit()).attempt_seq!, files: FILES }, ...extra,
  } } as WriteLedgerInput, rank)
}
async function baseline(native = false) {
  await write({ operation: "record_review", phase: "p1", data: {
    advisor: "baseline-reviewer", stage: native ? "native" : "independent", completion: "complete", findings: [], checked: FILES,
    ...(native ? { native: { verifier_id: "baseline-verifier", reviewers: [
      { agent_id: "reviewer-a", lens: "contract" as const, completion: "complete" as const, checked: FILES },
      { agent_id: "reviewer-b", lens: "tests" as const, completion: "complete" as const, checked: FILES },
    ] } } : {}),
  } })
  return (await readLedger(ledgerPath)).phases.p1.reviews!.at(-1)!.ts
}
function evidence(ts: string, patch: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return { kind: "worker_delta", verifier_id: "fresh-verifier", baseline_review_ts: ts,
    units: [{ unit_id: "u1", attempt: 2 }], files: FILES,
    tests: { outcome: "pass", command: "npm test -- a", result: "affected regression tests passed" },
    probe: { outcome: "pass", method: "independently inspect corrected assertion against fixture", result: "fixture agrees with contract" }, ...patch }
}
async function delta(ts: string, patch: Partial<VerificationEvidence> = {}, rank = TOP, host: HostId = "codex", events?: SidecarReader) {
  return write({ operation: "record_review", phase: "p1", data: {
    advisor: "fresh-verifier", stage: "verification", completion: "complete", checked: FILES, findings: [], evidence: evidence(ts, patch),
  } }, rank, host, events)
}
async function gate(rank = TOP, host: HostId = "codex") {
  return write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } }, rank, host)
}
async function ready(native = false) {
  await initial()
  const ts = await baseline(native)
  await correction()
  await guard()
  await verdict()
  return ts
}

describe("rank-directed bounded worker corrections", () => {
  it.each([UNKNOWN, { ...resolveModelRank("luna"), session_id: "session-one" }])("keeps $rank on the normal protocol", async (rank) => {
    await initial(rank)
    await expect(correction(rank, "mechanical")).rejects.toThrow(/normal Foreman protocol/)
    expect((await unit()).attempt_seq).toBe(1)
  })
  it("allows Middle mechanical follow-ups with normal validation", async () => {
    await initial(MIDDLE)
    const result = await correction(MIDDLE, "mechanical")
    expect(result.warning).toContain("Normal validation and review")
    expect((await unit()).delegations!.at(-1)).toMatchObject({ attempt: 2, worker_id: "worker-one", model_rank: { weight: 2 } })
    await guard()
    await verdict("pass", MIDDLE)
  })
  it("does not let Middle take bounded corrections", async () => {
    await initial(MIDDLE)
    await expect(correction(MIDDLE)).rejects.toThrow(/does not allow bounded/)
  })
  it("TopRank supports bounded test corrections but requires a new cleared verdict", async () => {
    await initial()
    const result = await correction()
    expect(result.warning).toContain("Focused intermediate validation")
    expect((await unit()).v).toBe("pending")
    await expect(verdict()).rejects.toThrow(/current attempt's cleared ownership/)
    await guard()
    await verdict()
    expect((await unit()).attempt_seq).toBe(2)
  })
  it("binds a returned worker after a failed first attempt and refuses rebinding", async () => {
    await delegate()
    await guard()
    await verdict("fail", TOP, "worker-one")
    await expect(verdict("fail", TOP, "different-worker")).rejects.toThrow(/cannot be rebound/)
    await correction()
    expect((await unit()).attempt_seq).toBe(2)
  })
  it("does not bind returned IDs across session switches", async () => {
    await delegate()
    await expect(verdict("fail", { ...TOP, session_id: "new-session" }, "worker-one")).rejects.toThrow(/current declared session/)
  })
  it.each([
    { rank: { ...TOP, session_id: "new-session" }, extra: {} },
    { rank: TOP, extra: { worker_id: "other-worker" } },
  ])("does not reuse a worker from another session or identity", async ({ rank, extra }) => {
    await initial()
    await expect(correction(rank, "bounded", extra)).rejects.toThrow(/same recorded worker_id/)
  })
  it("requires the exact prior attempt and frozen file scope", async () => {
    await initial()
    await expect(correction(TOP, "bounded", { correction: { kind: "bounded", from_attempt: 2, files: FILES } })).rejects.toThrow(/current worker delegation/)
    await expect(correction(TOP, "bounded", { correction: { kind: "bounded", from_attempt: 1, files: ["new.ts"] } })).rejects.toThrow(/frozen authorized file scope/)
  })
  it("cannot widen or move the guard root for a correction", async () => {
    await initial()
    await correction()
    await expect(guard([...FILES, "new.ts"])).rejects.toThrow(/previous repository root and frozen/)
    await expect(guard(FILES, "another-root")).rejects.toThrow(/previous repository root and frozen/)
    await guard()
    await verdict()
  })
  it("does not mistake an invoke_worker attempt for a resumable native worker", async () => {
    await initial()
    const events = async () => [{ phase: "p1", unit_id: "u1", attempt: 1 } as SidecarEvent]
    await expect(write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
      s: "delegated", brief: "Correct the bounded existing unit with its worker.", preflight: PREFLIGHT,
      worker_id: "worker-one", correction: { kind: "mechanical", from_attempt: 1, files: FILES },
    } }, TOP, "codex", events)).rejects.toThrow(/invoke_worker attempts cannot be resumed/)
  })
  it("does not let rank or user_override substitute for the correction guard", async () => {
    await initial()
    await correction()
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", via: "worker", user_override: true } })).rejects.toThrow(/cleared ownership/)
  })
  it("does not reuse a worker after an unresolved ownership violation", async () => {
    await initial()
    await recordRepoGuard(ledgerPath, "p1", "u1", { result: "violation", violations: ["lost user edit"] })
    await expect(correction()).rejects.toThrow(/cleared ownership guard/)
  })
  it.each(["hot_path", "security_boundary"] as const)("keeps %s on the normal workflow", async (flag) => {
    await initial()
    await write({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_build: true, has_api: false, [flag]: true } })
    await expect(correction()).rejects.toThrow(/normal workflow/)
  })
  it("counts reused workers toward the same attempt cap", async () => {
    await initial()
    for (let i = 0; i < 3; i++) {
      if (i > 0) { await correction(); await guard() }
      await verdict("fail")
    }
    await expect(correction()).rejects.toThrow(/DELEGATION CAP/)
    expect((await unit()).attempt_seq).toBe(3)
  })
})

describe("late-bound worker ids (0.6.20)", () => {
  // Field flow: the host returns the worker id after the delegation write and add_rejection
  // never carries it, so the correction is the first write that can record it.
  const reject = () => write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "tests", msg: "assertion fails", ts: "t" } })
  it("binds the correction's worker_id onto an id-less rejected attempt once", async () => {
    await delegate()
    await guard()
    await reject()
    const result = await correction()
    expect(result.warning).toContain("Worker id late-bound to attempt #1; it cannot be rebound.")
    const u = await unit()
    expect(u.delegations![0].worker_id).toBe("worker-one")
    expect(u.delegations![0].worker_id_bound).toMatchObject({ at: "correction", by_attempt: 2 })
    expect(u.delegations![0].worker_id_bound!.ts).toBe(new Date(Date.now() - 10).toISOString())
    expect(u.delegations![1]).toMatchObject({ attempt: 2, worker_id: "worker-one", session_id: "session-one" })
    expect(u.delegations![1].worker_id_bound).toBeUndefined()
    expect(u.attempt_seq).toBe(2)
    await guard()
    await expect(correction(TOP, "bounded", { worker_id: "other" })).rejects.toThrow(/same recorded worker_id/)
    await expect(verdict("fail", TOP, "other")).rejects.toThrow(/cannot be rebound/)
    await verdict("pass", TOP, "worker-one")
  })
  it("does not add the late-bound sentence when the id was already recorded", async () => {
    await initial()
    const result = await correction()
    expect(result.warning).not.toContain("late-bound")
    expect((await unit()).delegations![0].worker_id_bound).toBeUndefined()
  })
  it("binds onto an id-less attempt that received a fail verdict", async () => {
    await delegate()
    await guard()
    await verdict("fail")
    const result = await correction()
    expect(result.warning).toContain("late-bound to attempt #1")
    expect((await unit()).delegations![0]).toMatchObject({ worker_id: "worker-one", worker_id_bound: { at: "correction", by_attempt: 2 } })
  })
  it("binds onto an id-less gated attempt and records the post_gate_attempt escape", async () => {
    await delegate()
    await guard()
    await verdict("pass")
    await baseline()
    await gate()
    const result = await correction()
    expect(result.warning).toContain("late-bound to attempt #1")
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.units.u1.delegations![0]).toMatchObject({ worker_id: "worker-one", worker_id_bound: { at: "correction", by_attempt: 2 } })
    expect(phase.escapes!.map((e) => [e.unit_id, e.attempt, e.sources[0]])).toEqual([["u1", 1, "post_gate_attempt"]])
  })
  it("does not bind without a cleared ownership guard", async () => {
    await delegate()
    await reject()
    await expect(correction()).rejects.toThrow(/cleared ownership guard/)
    expect((await unit()).delegations![0].worker_id).toBeUndefined()
    expect((await unit()).delegations![0].worker_id_bound).toBeUndefined()
  })
  it("does not bind across a session switch", async () => {
    await delegate()
    await guard()
    await reject()
    await expect(correction({ ...TOP, session_id: "new-session" })).rejects.toThrow(/same recorded worker_id/)
    expect((await unit()).delegations![0].worker_id).toBeUndefined()
  })
  it("does not bind onto an invoke_worker attempt", async () => {
    await delegate()
    await guard()
    await reject()
    const events = async () => [{ phase: "p1", unit_id: "u1", attempt: 1 } as SidecarEvent]
    await expect(write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
      s: "delegated", brief: "Correct the bounded existing unit with its worker.", preflight: PREFLIGHT,
      worker_id: "worker-one", correction: { kind: "bounded", from_attempt: 1, files: FILES },
    } }, TOP, "codex", events)).rejects.toThrow(/invoke_worker attempts cannot be resumed/)
    expect((await unit()).delegations![0].worker_id).toBeUndefined()
    expect((await unit()).delegations![0].worker_id_bound).toBeUndefined()
  })
  it("counts a late-bound reuse toward the same attempt cap", async () => {
    await delegate()
    await guard()
    await reject()
    for (let i = 0; i < 2; i++) { await correction(); await guard(); await verdict("fail") }
    await expect(correction()).rejects.toThrow(/DELEGATION CAP/)
    expect((await unit()).attempt_seq).toBe(3)
  })
  it("discards the bind when the attempt cap refuses the correction", async () => {
    for (let i = 0; i < 3; i++) { await delegate(); await guard(); await reject() }
    await expect(correction()).rejects.toThrow(/DELEGATION CAP/)
    const u = await unit()
    expect(u.attempt_seq).toBe(3)
    expect(u.delegations!.map((d) => d.worker_id)).toEqual([undefined, undefined, undefined])
    expect(u.delegations!.some((d) => d.worker_id_bound)).toBe(false)
  })
})

describe("portable worker-delta verification", () => {
  it.each([false, true])("extends complete baseline (native=%s) and survives lower-rank host switch", async (native) => {
    const ts = await ready(native)
    await delta(ts, {}, TOP, "claude-code")
    await gate(UNKNOWN, "cursor")
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override).toBeUndefined()
    expect(phase.reviews!.at(-1)!.model_rank?.weight).toBe(3)
  })
  it.each([UNKNOWN, MIDDLE])("requires TopRank to record a new delta", async (rank) => {
    const ts = await ready()
    await expect(delta(ts, {}, rank)).rejects.toThrow(/requires TopRank/)
  })
  it("accepts a TopRank independent check of a valid Middle mechanical correction", async () => {
    await initial(MIDDLE)
    const ts = await baseline()
    await correction(MIDDLE, "mechanical")
    await guard()
    await verdict("pass", MIDDLE)
    await delta(ts)
    await gate()
  })
  it.each([
    { patch: { verifier_id: "worker-one" }, error: /matches implementation worker/ },
    { patch: { verifier_id: undefined }, error: /distinct verifier_id/ },
    { patch: { files: ["src/a.ts"] }, error: /frozen authorized files/ },
    { patch: { units: [{ unit_id: "u1", attempt: 1 }] }, error: /current changed units and attempts/ },
  ])("rejects incomplete or non-independent delta evidence", async ({ patch, error }) => {
    const ts = await ready()
    await expect(delta(ts, patch)).rejects.toThrow(error)
  })
  it("does not cover an ordinary worker attempt sandwiched before a correction", async () => {
    await initial()
    const ts = await baseline()
    await delegate(TOP, "worker-one")
    await guard()
    await verdict()
    await correction()
    await guard()
    await verdict()
    await expect(delta(ts, { units: [{ unit_id: "u1", attempt: 3 }] })).rejects.toThrow(/attempt #2 is not a retained rank-eligible/)
  })
  it("rejects post-baseline invoke_worker evidence even for a ledger-unchanged unit", async () => {
    await initial()
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u2", data: { s: "delegated", brief: "Implement another bounded isolated unit.", preflight: PREFLIGHT } })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u2", data: { v: "pass", via: "worker" } })
    const ts = await baseline()
    await correction(); await guard(); await verdict()
    const events = async () => [{ phase: "p1", unit_id: "u2", attempt: 2, ts: new Date().toISOString() } as SidecarEvent]
    await expect(delta(ts, {}, TOP, "codex", events)).rejects.toThrow(/u2.*invoke_worker/)
  })
  it("stales a recorded delta after another correction", async () => {
    const ts = await ready()
    await delta(ts)
    await correction(); await guard(); await verdict()
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED/)
    await delta(ts, { units: [{ unit_id: "u1", attempt: 3 }] })
    await gate()
  })
  it.each(["unverified", "unchecked", "blank"] as const)("refuses %s delta coverage at recording and when reading persisted evidence", async (kind) => {
    const ts = await ready()
    const invalid = {
      advisor: "fresh-verifier", stage: "verification" as const, completion: "complete" as const,
      checked: kind === "unchecked" ? [] : kind === "blank" ? [" "] : FILES,
      findings: kind === "unverified" ? [{ severity: "high" as const, file: "src/a.ts", line: "1", description: "not verified yet", classification: "unverified" as const }] : [],
      evidence: evidence(ts),
    }
    await expect(write({ operation: "record_review", phase: "p1", data: invalid })).rejects.toThrow(/RANK VERIFICATION INCOMPLETE/)
    await delta(ts)
    const ledger = await readLedger(ledgerPath)
    Object.assign(ledger.phases.p1.reviews!.at(-1)!, invalid)
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED.*worker_delta/)
  })
  it.each([
    { tests: { outcome: "pass" as const, command: " ", result: "passed" } },
    { tests: { outcome: "pass" as const, command: "npm test", result: "" } },
    { probe: { outcome: "pass" as const, method: "", result: "passed" } },
    { probe: { outcome: "pass" as const, method: "inspect fixture", result: " " } },
  ])("requires substantive pass evidence at recording and saved gate revalidation", async (patch) => {
    const ts = await ready()
    await expect(delta(ts, patch)).rejects.toThrow(/RANK VERIFICATION INCOMPLETE/)
    await delta(ts)
    const ledger = await readLedger(ledgerPath)
    ledger.phases.p1.reviews!.at(-1)!.evidence = evidence(ts, patch)
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED.*worker_delta/)
  })
  it.each(["unchecked", "unverified"] as const)("cannot supersede malformed %s saved delta with a complete but ineligible verification", async (kind) => {
    const ts = await ready()
    await delta(ts)
    const ledger = await readLedger(ledgerPath)
    const malformed = ledger.phases.p1.reviews!.at(-1)!
    if (kind === "unchecked") malformed.checked = []
    else malformed.findings = [{ severity: "high", file: "src/a.ts", line: "1", description: "not verified yet", classification: "unverified" }]
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await write({ operation: "record_review", phase: "p1", data: {
      advisor: "fresh-verifier", stage: "verification", completion: "complete", checked: FILES, findings: [],
      evidence: { ...evidence("nonexistent-baseline"), kind: undefined, verifier_id: undefined },
    } })
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED/)
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pending")
  })
  it("does not treat a same-millisecond pre-correction baseline as current", async () => {
    await initial()
    const ts = await baseline()
    vi.setSystemTime(new Date(ts))
    await correction(); await guard()
    vi.setSystemTime(new Date(ts))
    await verdict()
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED/)
    await delta(ts)
    await gate()
  })
  it("requires a full review when no baseline exists and exposes an eligible delta after one", async () => {
    await initial(); await correction(); await guard(); await verdict()
    await expect(gate()).rejects.toThrow(/WORKER DELTA NOT ELIGIBLE: no complete/)
    const ts = await baseline()
    await correction(); await guard(); await verdict()
    await expect(gate()).rejects.toThrow(/WORKER DELTA ELIGIBLE.*worker_delta/)
    await delta(ts, { units: [{ unit_id: "u1", attempt: 3 }] })
    await gate()
  })
  it("does not forget missing attempts when retained delegation history is truncated", async () => {
    const ts = await ready()
    for (let i = 0; i < 20; i++) { await correction(); await guard(); await verdict() }
    await expect(delta(ts, { units: [{ unit_id: "u1", attempt: 22 }] })).rejects.toThrow(/attempt #2 is not a retained/)
  })
  it.each(["confirmed", "partial"] as const)("preserves current %s review blocks", async (kind) => {
    const ts = await ready()
    await delta(ts)
    await write({ operation: "record_review", phase: "p1", data: { advisor: "another-seat", stage: "independent",
      completion: kind === "partial" ? "partial" : "complete", checked: FILES,
      findings: kind === "confirmed" ? [{ severity: "low", file: "src/a.ts", line: "1", description: "still wrong", classification: "confirmed" }] : [],
    } })
    await expect(gate()).rejects.toThrow(kind === "confirmed" ? /CONFIRMED FINDINGS/ : /INCOMPLETE REVIEW/)
  })
})

describe("0.6.19 structural bounds on worker-delta records", () => {
  it("refuses a verifier that is a baseline native agent or any worker in the phase", async () => {
    await initial()
    // a worker on another unit, never a correcting worker, is still in play
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u2", data: {
      s: "delegated", brief: "Implement the second unit of this phase.", preflight: PREFLIGHT, worker_id: "worker-two",
    } })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u2", data: { v: "pass", via: "worker" } })
    const ts = await baseline(true)
    await correction(); await guard(); await verdict()
    for (const id of ["baseline-verifier", "reviewer-a", "worker-two"]) {
      await expect(delta(ts, { verifier_id: id })).rejects.toThrow(/is a baseline native agent or a worker in this phase/)
    }
    await delta(ts)
    await gate()
  })
  it("requires checked to list every file in evidence.files; extra entries are fine", async () => {
    const ts = await ready()
    await expect(write({ operation: "record_review", phase: "p1", data: {
      advisor: "fresh-verifier", stage: "verification", completion: "complete", checked: ["src/a.ts"], findings: [], evidence: evidence(ts),
    } })).rejects.toThrow(/checked must list every file in evidence.files \(missing: tests\/a.test.ts\)/)
    await write({ operation: "record_review", phase: "p1", data: {
      advisor: "fresh-verifier", stage: "verification", completion: "complete", checked: [...FILES, "docs/spec.md"], findings: [], evidence: evidence(ts),
    } })
    await gate()
  })
  it("caps verification records per baseline on a server scalar and refuses the third", async () => {
    const ts = await ready()
    await delta(ts)
    await delta(ts)
    expect((await readLedger(ledgerPath)).phases.p1.reviews!.find((r) => r.ts === ts)!.delta_count).toBe(2)
    await expect(delta(ts)).rejects.toThrow(/already carries 2 verification record\(s\) \(cap 2\)/)
    await gate()
  })
  it("leaves legacy delta records (no basis_version) on the 0.6.18 predicates at the gate", async () => {
    const ts = await ready(true)
    await delta(ts)
    const ledger = await readLedger(ledgerPath)
    const rec = ledger.phases.p1.reviews!.at(-1)!
    delete rec.basis_version
    rec.checked = ["something-else"]
    rec.evidence!.verifier_id = "baseline-verifier"
    await fs.writeFile(ledgerPath, JSON.stringify(ledger))
    await gate()
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })

  // 0.6.20 soft limits: checked[] entries are cut with a marker instead of refused, but a
  // worker_delta compares checked paths to the frozen evidence.files. A cut path can never
  // match, so the record fails closed on the path check — never a SCHEMA ERROR, nothing written.
  it("a 401-char checked path on a worker_delta is cut, then refused because it cannot match evidence.files", async () => {
    const ts = await ready()
    const before = (await readLedger(ledgerPath)).phases.p1.reviews!.length
    const longPath = "src/" + "a".repeat(400) + ".ts"
    const attempt = handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: { advisor: "fresh-verifier", stage: "verification", completion: "complete", checked: [longPath, "tests/a.test.ts"], findings: [], evidence: evidence(ts) },
    }, "codex", TOP)
    await expect(attempt).rejects.toThrow(/^RANK VERIFICATION: checked must list every file in evidence\.files \(missing: src\/a\.ts\)\.$/)
    await expect(attempt).rejects.not.toThrow(/SCHEMA ERROR/)
    expect((await readLedger(ledgerPath)).phases.p1.reviews!.length).toBe(before)
  })
})
