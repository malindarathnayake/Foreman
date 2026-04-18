import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { sessionOrient } from "../src/tools/sessionOrient.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-orient-test-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
  progressPath = path.join(tmpDir, "progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// Helper: write ledger JSON to disk
async function seedLedger(data: object): Promise<void> {
  await fs.writeFile(ledgerPath, JSON.stringify(data), "utf-8")
}

// Helper: write empty progress JSON to disk
async function seedProgress(): Promise<void> {
  await fs.writeFile(progressPath, JSON.stringify({ phases: {}, error_log: [] }), "utf-8")
}

// ─── Test 1: empty ledger ─────────────────────────────────────────────────────

describe("sessionOrient", () => {
  it("empty ledger → no_phases_yet status with all fields null", async () => {
    await seedLedger({ v: 1, ts: "2026-04-16T00:00:00Z", phases: {} })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("status: no_phases_yet")
    expect(result).toContain("current_phase: null")
    expect(result).toContain("current_unit: null")
    expect(result).toContain("last_completed_unit: null")
    expect(result).toContain("next_pending_unit: null")
    expect(result).toContain("blocked_on: null")
    expect(result).toContain("active_rejections: 0")
    expect(result).toContain("phases_total: 0")
    expect(result).toContain("phases_done: 0")
  })

  // ─── Test 2: single-pending ledger ─────────────────────────────────────────

  it("single-pending ledger → current_phase and current_unit and next_pending_unit point to the single unit", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-04-16T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("status: in_progress")
    expect(result).toContain("current_phase: p1")
    expect(result).toContain("current_unit: u1")
    expect(result).toContain("next_pending_unit: p1/u1")
    expect(result).toContain("last_completed_unit: null")
    expect(result).toContain("blocked_on: null")
    expect(result).toContain("active_rejections: 0")
    expect(result).toContain("phases_total: 1")
    expect(result).toContain("phases_done: 0")
  })

  // ─── Test 3: mid-phase ledger ───────────────────────────────────────────────

  it("mid-phase ledger → current_unit is first non-pass, last_completed_unit is last pass", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-04-16T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: { s: "done",      v: "pass",    w: "brief", rej: [] },
            u2: { s: "done",      v: "pass",    w: "brief", rej: [] },
            u3: { s: "delegated", v: "pending", w: null,    rej: [] },
            u4: { s: "pending",   v: "pending", w: null,    rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("current_phase: p1")
    expect(result).toContain("current_unit: u3")
    expect(result).toContain("last_completed_unit: p1/u2")
    expect(result).toContain("next_pending_unit: p1/u4")
  })

  // ─── Test 4: all-done ledger ────────────────────────────────────────────────

  it("all-done ledger → status complete, current_phase null, phases_done equals phases_total", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-04-16T00:00:00Z",
      phases: {
        p1: {
          s: "done",
          g: "pass",
          units: {
            u1: { s: "done", v: "pass", w: "brief", rej: [] },
            u2: { s: "done", v: "pass", w: "brief", rej: [] },
          },
        },
        p2: {
          s: "done",
          g: "pass",
          units: {
            u3: { s: "done", v: "pass", w: "brief", rej: [] },
            u4: { s: "done", v: "pass", w: "brief", rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("status: complete")
    expect(result).toContain("current_phase: null")
    expect(result).toContain("current_unit: null")
    expect(result).toContain("phases_total: 2")
    expect(result).toContain("phases_done: 2")
    expect(result).toContain("last_completed_unit: p2/u4")
  })

  // ─── Test 5: blocked ledger ─────────────────────────────────────────────────

  it("blocked ledger → blocked_on and active_rejections populated", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-04-16T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: {
              s: "delegated",
              v: "pending",
              w: null,
              rej: [{ r: "codex", msg: "x", ts: "2026-04-16T00:00:00Z" }],
            },
            u2: { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("blocked_on: p1/u1")
    expect(result).toContain("active_rejections: 1")
    expect(result).toContain("current_unit: u1")
  })

  // ─── Test 6: unit with rejections but subsequent pass is NOT blocked ────────

  it("unit with rejections but v:pass is NOT counted as blocked", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-04-16T00:00:00Z",
      phases: {
        p1: {
          s: "done",
          g: "pass",
          units: {
            u1: {
              s: "done",
              v: "pass",
              w: "brief",
              rej: [{ r: "codex", msg: "prior rejection", ts: "2026-04-15T00:00:00Z" }],
            },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("blocked_on: null")
    expect(result).toContain("active_rejections: 0")
    expect(result).toContain("status: complete")
  })

  // ─── Test 7: corrupt ledger → empty-ledger shape, no .corrupt.* sibling ────

  it("corrupt ledger → returns empty-ledger shape AND does NOT rename the corrupt file", async () => {
    // Write invalid JSON to the ledger path
    await fs.writeFile(ledgerPath, "{ this is not valid json !!!", "utf-8")
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    // Returns the empty-ledger TOON output
    expect(result).toContain("status: no_phases_yet")
    expect(result).toContain("phases_total: 0")

    // The corrupt file must still exist un-renamed
    const stillExists = await fs.access(ledgerPath).then(() => true).catch(() => false)
    expect(stillExists).toBe(true)

    // No sibling .corrupt.* backup was created
    const siblings = await fs.readdir(tmpDir)
    const corrupted = siblings.filter((f) => f.includes(".corrupt."))
    expect(corrupted).toHaveLength(0)
  })
})
