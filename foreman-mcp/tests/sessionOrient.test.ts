import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { sessionOrient } from "../src/tools/sessionOrient.js"
import { writeLedger } from "../src/lib/ledger.js"

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

  // ─── Test 7: corrupt ledger → explicit corrupt status, no .corrupt.* sibling ────

  it("corrupt ledger → returns ledger_corrupt status AND does NOT rename the corrupt file", async () => {
    // Write invalid JSON to the ledger path
    await fs.writeFile(ledgerPath, "{ this is not valid json !!!", "utf-8")
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    // Corruption is surfaced explicitly — must NOT masquerade as a fresh project
    expect(result).toContain("status: ledger_corrupt")
    expect(result).not.toContain("no_phases_yet")

    // The corrupt file must still exist un-renamed
    const stillExists = await fs.access(ledgerPath).then(() => true).catch(() => false)
    expect(stillExists).toBe(true)

    // No sibling .corrupt.* backup was created
    const siblings = await fs.readdir(tmpDir)
    const corrupted = siblings.filter((f) => f.includes(".corrupt."))
    expect(corrupted).toHaveLength(0)
  })

  // ─── Test 8: unsupported_capabilities echo ───────────────────────────────────

  it("default host (empty ledger) → unsupported_capabilities: none", async () => {
    await seedLedger({ v: 1, ts: "2026-04-16T00:00:00Z", phases: {} })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("unsupported_capabilities: none")
  })

  it('cursor host → unsupported_capabilities: "autonomy"', async () => {
    await seedLedger({ v: 1, ts: "2026-04-16T00:00:00Z", phases: {} })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath, "cursor")

    expect(result).toContain("unsupported_capabilities: autonomy")
  })

  // ─── Test 9: stale_gates echo (D2b) ──────────────────────────────────────────

  it("normal in-progress ledger → stale_gates: none", async () => {
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

    expect(result).toContain("stale_gates: none")
  })

  it("gate pass + post-pass unit add → stale_gates: p1", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [], completion: "complete" } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "pending" },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("stale_gates: p1")
  })

  it("all unit verdicts pass but gate does not → retry_phase_gate", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-04T00:00:00Z",
      phases: {
        "V20-P0": {
          s: "ip",
          g: "fail",
          units: {
            "U0.17": { s: "done", v: "pass", w: "brief", rej: [] },
            "U0.18": { s: "done", v: "pass", w: "brief", rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("action: retry_phase_gate")
    expect(result).toContain("resume_target: V20-P0/phase_gate")
    expect(result).toContain("current_unit: null")
  })

  it("reports explicit ledger/progress drift instead of trusting stale progress", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-04T00:00:00Z",
      phases: {
        "V20-P0": {
          s: "ip",
          g: "fail",
          units: {
            "U0.18": { s: "done", v: "pass", w: "brief", rej: [] },
          },
        },
      },
    })
    await fs.writeFile(progressPath, JSON.stringify({
      phases: {
        P4: {
          name: "legacy v1 phase",
          units: {
            "U4.2": { id: "U4.2", phase: "P4", status: "in_progress", notes: "stale" },
          },
        },
      },
      error_log: [],
    }), "utf-8")

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("action: retry_phase_gate")
    expect(result).toContain("resume_target: V20-P0/phase_gate")
    // 0.6.5: a progress entry the ledger does not know is an advisory, not a stop —
    // pointer-order disagreement between unrelated id schemes never blocked for a real reason.
    expect(result).toContain("state_drift: none")
    expect(result).toContain("progress_advisories: orphan:P4/U4.2")
  })

  it("uses verdict timestamps rather than lexical unit ids for last_completed_unit", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-04T00:00:00Z",
      phases: {
        p1: {
          s: "done",
          g: "pass",
          units: {
            "U0.9": { s: "done", v: "pass", v_ts: "2026-08-04T10:00:00Z", w: "brief", rej: [] },
            "U0.18": { s: "done", v: "pass", v_ts: "2026-08-04T12:00:00Z", w: "brief", rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("last_completed_unit: p1/U0.18")
  })
})

// ─── declared units + bidirectional drift (field-feedback fixes #1/#3) ───────

describe("sessionOrient — declared units", () => {
  it("declared-but-unregistered unit → implement_unit, not retry_phase_gate", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-07T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          declared_units: ["u1", "u2"],
          units: {
            u1: { s: "done", v: "pass", v_ts: "2026-08-07T00:01:00Z", w: "brief", rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("action: implement_unit")
    expect(result).toContain("resume_target: p1/u2")
    expect(result).toContain("current_unit: u2")
    expect(result).toContain("next_pending_unit: p1/u2")
    expect(result).toContain("missing_declared_units: p1/u2")
    expect(result).not.toContain("retry_phase_gate")
  })

  it("all declared units registered and passing → retry_phase_gate as before", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-07T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          declared_units: ["u1"],
          units: {
            u1: { s: "done", v: "pass", v_ts: "2026-08-07T00:01:00Z", w: "brief", rej: [] },
          },
        },
      },
    })
    await seedProgress()

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("action: retry_phase_gate")
    expect(result).toContain("missing_declared_units: none")
  })

  it("legacy ledger without declared_units is unchanged and reports none", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-07T00:00:00Z",
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

    expect(result).toContain("action: implement_unit")
    expect(result).toContain("missing_declared_units: none")
  })
})

describe("sessionOrient — bidirectional state drift", () => {
  async function seedProgressWith(units: Record<string, { phase: string; status: string }>): Promise<void> {
    const phases: Record<string, { name: string; units: Record<string, object> }> = {}
    for (const [unitId, u] of Object.entries(units)) {
      phases[u.phase] ??= { name: u.phase, units: {} }
      phases[u.phase].units[unitId] = { id: unitId, phase: u.phase, status: u.status, notes: "" }
    }
    await fs.writeFile(progressPath, JSON.stringify({ phases, error_log: [] }), "utf-8")
  }

  it("progress marks the ledger resume unit complete → drift flagged", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-07T00:00:00Z",
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
    await seedProgressWith({ u1: { phase: "p1", status: "complete" } })

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("state_drift: progress:complete(p1/u1);ledger:p1/u1")
  })

  it("partial progress file (earlier phase only) is NOT drift on a later-phase resume", async () => {
    await seedLedger({
      v: 1,
      ts: "2026-08-07T00:00:00Z",
      phases: {
        p1: {
          s: "ip",
          g: "pass",
          units: {
            u1: { s: "done", v: "pass", v_ts: "2026-08-07T00:01:00Z", w: "brief", rej: [] },
          },
        },
        p2: {
          s: "ip",
          g: "pending",
          units: {
            u2: { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    })
    await seedProgressWith({ u1: { phase: "p1", status: "complete" } })

    const result = await sessionOrient(ledgerPath, progressPath)

    expect(result).toContain("resume_target: p2/u2")
    expect(result).toContain("state_drift: none")
  })
})
