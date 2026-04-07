import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"

let tmpDir: string
let ledgerPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-test-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("ledger", () => {
  it("concurrent writes are serialized — no data loss", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: `u${i}`,
        data: { s: "done" },
      })
    )

    await Promise.all(writes)

    const ledger = await readLedger(ledgerPath)
    expect(Object.keys(ledger.phases.p1.units)).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(ledger.phases.p1.units[`u${i}`]).toBeDefined()
      expect(ledger.phases.p1.units[`u${i}`].s).toBe("done")
    }
  })

  it("corrupt file triggers recovery — backup created, fresh ledger returned", async () => {
    await fs.writeFile(ledgerPath, "{ this is not valid json !!!", "utf-8")

    const ledger = await readLedger(ledgerPath)

    // Fresh ledger returned
    expect(ledger.v).toBe(1)
    expect(Object.keys(ledger.phases)).toHaveLength(0)

    // Backup file created
    const files = await fs.readdir(tmpDir)
    const backups = files.filter((f) => f.includes(".corrupt."))
    expect(backups).toHaveLength(1)
  })

  it("missing file auto-creates — returns fresh empty ledger", async () => {
    const ledger = await readLedger(ledgerPath)

    expect(ledger.v).toBe(1)
    expect(typeof ledger.ts).toBe("string")
    expect(Object.keys(ledger.phases)).toHaveLength(0)

    // readLedger on ENOENT should NOT write the file
    const exists = await fs
      .access(ledgerPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("atomic write produces valid JSON in the final file", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    const raw = await fs.readFile(ledgerPath, "utf-8")
    expect(() => JSON.parse(raw)).not.toThrow()

    const parsed = JSON.parse(raw)
    expect(parsed.v).toBe(1)
    expect(parsed.phases.p1.units.u1.s).toBe("ip")
  })

  it("set_unit_status creates phase and unit if they do not exist", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "new_phase",
      unit_id: "new_unit",
      data: { s: "done" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["new_phase"]).toBeDefined()
    expect(ledger.phases["new_phase"].units["new_unit"]).toBeDefined()
    expect(ledger.phases["new_phase"].units["new_unit"].s).toBe("done")
  })

  it("add_rejection appends to history — both rejections preserved", async () => {
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-a", msg: "Missing error handling", ts: "2026-04-02T11:00:00Z" },
    })

    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-b", msg: "Insufficient tests", ts: "2026-04-02T12:00:00Z" },
    })

    const ledger = await readLedger(ledgerPath)
    const rej = ledger.phases.p1.units.u1.rej
    expect(rej).toHaveLength(2)
    expect(rej[0].r).toBe("reviewer-a")
    expect(rej[0].msg).toBe("Missing error handling")
    expect(rej[1].r).toBe("reviewer-b")
    expect(rej[1].msg).toBe("Insufficient tests")
  })

  // ─── Pitboss enforcement tests ───────────────────────────────────────────

  it("set_verdict pass is BLOCKED without prior delegation", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass" },
      })
    ).rejects.toThrow("VERDICT BLOCKED")
  })

  it("set_verdict pass succeeds after delegation with brief", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "Worker brief: implement unit u1 types and constants per handoff spec section 1a" },
    })

    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("pass")
    expect(ledger.phases.p1.units.u1.w).toContain("Worker brief")
  })

  it("delegation with too-short brief is rejected", async () => {
    await expect(
      writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief: "short" },
      })
    ).rejects.toThrow("DELEGATION REQUIRED")
  })

  it("set_verdict fail is allowed without delegation", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "fail" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("fail")
  })

  it("update_phase_gate sets the gate value correctly", async () => {
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })
})
