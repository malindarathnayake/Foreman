// Field feedback 2026-09 — ledger + session_orient behavior fixed after the Codex
// deliberation: first-pass frontier, rejection reopens a pass, review-required gate,
// natural ordering, and the durable review-completion fields.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { sessionOrient } from "../src/tools/sessionOrient.js"
import { renderChecklist } from "../src/tools/writeProgress.js"
import { naturalCompare, naturalSort } from "../src/lib/naturalSort.js"
import type { LedgerFile } from "../src/types.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-2026-09-"))
  ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
  progressPath = path.join(tmpDir, ".foreman-progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"

async function delegateAndPass(phase: string, unit: string): Promise<void> {
  await writeLedger(ledgerPath, { operation: "set_unit_status", phase, unit_id: unit, data: { s: "delegated", brief: BRIEF } })
  await writeLedger(ledgerPath, { operation: "set_verdict", phase, unit_id: unit, data: { v: "pass" } })
}

async function seedLedger(data: object): Promise<void> {
  await fs.writeFile(ledgerPath, JSON.stringify(data), "utf-8")
}

// ─── natural ordering (Codex R3) ────────────────────────────────────────────

describe("naturalSort", () => {
  it("orders numeric runs by value and stays total", () => {
    expect(naturalSort(["p10", "p2", "p1"])).toEqual(["p1", "p2", "p10"])
    expect(naturalSort(["U0.18", "U0.9", "U0.10"])).toEqual(["U0.9", "U0.10", "U0.18"])
    expect(naturalCompare("a", "a")).toBe(0)
    // Case ties resolve by code point so the order is total and locale-independent.
    expect(naturalSort(["b", "B", "a"])).toEqual(["a", "B", "b"])
  })
})

describe("session_orient — natural phase/unit order", () => {
  it("resumes p2 before p10 and U0.9 before U0.18", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-09-01T00:00:00Z",
      phases: {
        p1: { s: "done", g: "pass", units: { u1: { s: "done", v: "pass", w: "b", rej: [] } } },
        p10: { s: "ip", g: "pending", units: { "U1.1": { s: "pending", v: "pending", w: null, rej: [] } } },
        p2: {
          s: "ip",
          g: "pending",
          units: {
            "U0.18": { s: "pending", v: "pending", w: null, rej: [] },
            "U0.9": { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    })
    const result = await sessionOrient(ledgerPath, progressPath)
    expect(result).toContain("current_phase: p2")
    expect(result).toContain("current_unit: U0.9")
    expect(result).toContain("resume_target: p2/U0.9")
    expect(result).toContain("next_pending_unit: p2/U0.9")
  })

  it("renderChecklist uses the same order", () => {
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-09-01T00:00:00Z",
      phases: {
        p10: { s: "ip", g: "pending", units: { u1: { s: "pending", v: "pending", w: null, rej: [] } } },
        p2: { s: "ip", g: "pending", units: { "U0.18": { s: "pending", v: "pending", w: null, rej: [] }, "U0.9": { s: "pending", v: "pending", w: null, rej: [] } } },
      },
    }
    const md = renderChecklist(ledger)
    expect(md.indexOf("### p2")).toBeLessThan(md.indexOf("### p10"))
    expect(md.indexOf("U0.9")).toBeLessThan(md.indexOf("U0.18"))
  })
})

// ─── completion frontier vs latest verdict (feedback #7 + decision D) ───────

describe("session_orient — last_completed_unit is the frontier, latest_pass_verdict_* is temporal", () => {
  it("re-verdicting earlier units does not move the frontier", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-09-01T00:00:00Z",
      phases: {
        p0: {
          s: "ip",
          g: "pending",
          units: {
            "p0.1": { s: "done", v: "pass", first_pass_ts: "2026-09-01T10:00:00Z", v_ts: "2026-09-01T12:00:00Z", w: "b", rej: [] },
            "p0.2": { s: "done", v: "pass", first_pass_ts: "2026-09-01T10:30:00Z", v_ts: "2026-09-01T12:30:00Z", w: "b", rej: [] },
            "p0.3": { s: "done", v: "pass", first_pass_ts: "2026-09-01T11:00:00Z", v_ts: "2026-09-01T11:00:00Z", w: "b", rej: [] },
            "p0.4": { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    })
    const result = await sessionOrient(ledgerPath, progressPath)
    expect(result).toContain("last_completed_unit: p0/p0.3")
    expect(result).toContain("latest_pass_verdict_unit: p0/p0.2")
    expect(result).toContain("latest_pass_verdict_ts: 2026-09-01T12:30:00Z")
    expect(result).toContain("current_unit: p0.4")
  })

  it("empty ledger reports null for the new fields", async () => {
    const result = await sessionOrient(ledgerPath, progressPath)
    expect(result).toContain("latest_pass_verdict_unit: null")
    expect(result).toContain("latest_pass_verdict_ts: null")
  })
})

describe("set_verdict — first_pass_ts is stamped once", () => {
  it("survives a re-verdict; v_ts moves", async () => {
    await delegateAndPass("p1", "u1")
    const first = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(first.first_pass_ts).toBe(first.v_ts)

    await new Promise((r) => setTimeout(r, 5))
    await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", note: "re-verified" } })
    const second = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(second.first_pass_ts).toBe(first.first_pass_ts)
    expect(second.v_ts! >= first.v_ts!).toBe(true)
  })

  it("is not stamped by fail/pending/inconclusive verdicts", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: BRIEF } })
    await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.first_pass_ts).toBeUndefined()
  })
})

// ─── rejection reopens a pass (Codex R1, decision B) ────────────────────────

describe("add_rejection — reopens a passed unit", () => {
  it("flips v to pending, returns a warning, blocks the gate, and surfaces in session_orient", async () => {
    await delegateAndPass("p1", "u1")
    const { warning } = await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "checkpoint", msg: "spec directive 3 not implemented", ts: "2026-09-01T12:00:00Z" },
    })
    expect(warning).toMatch(/verdict reopened: unit 'u1' was 'pass'/)

    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.v).toBe("pending")
    expect(unit.rej).toHaveLength(1)

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [] } })
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/PHASE GATE BLOCKED.*u1/s)

    const orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("active_rejections: 1")
    expect(orient).toContain("blocked_on: p1/u1")
    expect(orient).toContain("current_unit: u1")
  })

  it("does not warn or touch the verdict on a unit that is not passing", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip" } })
    const { warning } = await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer", msg: "nope", ts: "2026-09-01T12:00:00Z" },
    })
    expect(warning).toBeUndefined()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pending")
  })
})

// ─── gate requires a review (Codex R2, decision C) ──────────────────────────

describe("update_phase_gate — review required", () => {
  it("blocks pass with zero record_review entries, names the override", async () => {
    await delegateAndPass("p1", "u1")
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/REVIEW REQUIRED: phase 'p1' has no record_review entries.*user_override/s)
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pending")
  })

  it("passes once a review is recorded; no override marker written", async () => {
    await delegateAndPass("p1", "u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [] } })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override).toBeUndefined()
  })

  it("user_override passes without a review and records review_override on the phase", async () => {
    await delegateAndPass("p1", "u1")
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", user_override: true } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(typeof phase.review_override?.ts).toBe("string")
  })

  it("is sequenced last: unit-verdict block message is unchanged when reviews are also missing", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "pending" } })
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/PHASE GATE BLOCKED: phase 'p1' has units without a pass verdict/)
  })

  it("fail/pending gate values never require a review", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "pending" } })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "fail" } })
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("fail")
  })
})

// ─── record_review completion fields (feedback #5) ──────────────────────────

describe("record_review — completion / checked / limitations / stage", () => {
  it("round-trips the new optional fields and renders them on zero-finding rows", async () => {
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: {
        advisor: "gemini",
        findings: [],
        completion: "partial",
        checked: ["src/a.ts", "src/b.ts"],
        limitations: "did not open tests/",
        stage: "independent",
      },
    })
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: { advisor: "gemini", findings: [], stage: "cross_exam", completion: "complete", checked: ["src/a.ts"] },
    })
    const reviews = (await readLedger(ledgerPath)).phases.p1.reviews!
    expect(reviews[0]).toMatchObject({ completion: "partial", checked: ["src/a.ts", "src/b.ts"], limitations: "did not open tests/", stage: "independent" })
    expect(reviews[1]).toMatchObject({ stage: "cross_exam", completion: "complete" })

    const text = await handleReadLedger(ledgerPath, { query: "reviews" })
    expect(text).toContain("(no findings; completion=partial; checked=2; stage=independent)")
    expect(text).toContain("(no findings; completion=complete; checked=1; stage=cross_exam)")
  })

  it("legacy zero-finding reviews still render the bare marker", async () => {
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [] } })
    const text = await handleReadLedger(ledgerPath, { query: "reviews" })
    expect(text).toContain("(no findings)")
    expect(text).not.toContain("(no findings;")
  })

  it("rejects out-of-enum stage/completion and over-cap checked lists at the schema boundary", async () => {
    // handleWriteLedger is the MCP boundary that parses WriteLedgerInputSchema; lib writeLedger trusts typed input.
    await expect(
      handleWriteLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "x", findings: [], stage: "solo" } })
    ).rejects.toThrow()
    await expect(
      handleWriteLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "x", findings: [], completion: "done" } })
    ).rejects.toThrow()
    await expect(
      handleWriteLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "x", findings: [], checked: Array(51).fill("f") } })
    ).rejects.toThrow()
  })
})
