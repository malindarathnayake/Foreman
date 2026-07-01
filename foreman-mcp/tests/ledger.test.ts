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

  it("update_phase_gate sets the gate value correctly when all units pass", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("update_phase_gate pass is BLOCKED when a unit lacks a pass verdict", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    // u2 is pending — gate must not pass
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "pending" },
    })

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/PHASE GATE BLOCKED.*u2/s)
  })

  it("update_phase_gate pass is BLOCKED on an empty phase", async () => {
    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/PHASE GATE BLOCKED.*no units/s)
  })

  it("update_phase_gate fail/pending are allowed regardless of unit verdicts", async () => {
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "fail" },
    })
    let ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("fail")

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pending" },
    })
    ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pending")
  })

  // ─── No-test/no-build attestation enforcement ─────────────────────────────

  it("set_verdict pass is BLOCKED without note when scope has_tests:false", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: false, has_api: false, has_build: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass" },
      })
    ).rejects.toThrow(/ATTESTATION REQUIRED.*has_tests:false/s)

    // Whitespace-only note is also rejected
    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass", note: "   " },
      })
    ).rejects.toThrow(/ATTESTATION REQUIRED/)
  })

  it("set_verdict pass succeeds with attestation note when scope has_build:false", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: true, has_api: false, has_build: false },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })

    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note: "validated via manual smoke: ran CLI against fixture dir" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("pass")
    expect(ledger.phases.p1.units.u1.note).toContain("manual smoke")
  })

  it("set_verdict fail does not require attestation note on scopeless phases", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: false, has_api: false, has_build: false },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "fail" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("fail")
  })
})

describe("ledger v0.3.1 tier telemetry + reviews", () => {
  const brief = "Worker brief: implement unit per spec (>= 20 chars)"

  it("records tier + route_reason on delegation and appends a delegation entry", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief, tier: "premium", route_reason: "subtle concurrency unit" },
    })
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.tier).toBe("premium")
    expect(unit.route_reason).toBe("subtle concurrency unit")
    expect(unit.delegations).toHaveLength(1)
    expect(unit.delegations![0].attempt).toBe(1)
    expect(unit.delegations![0].tier).toBe("premium")
    expect(unit.delegations![0].brief).toBe(brief)
    expect(typeof unit.delegations![0].ts).toBe("string")
  })

  it("re-delegation appends history, monotonic attempt, latest tier + brief win", async () => {
    for (let i = 0; i < 3; i++) {
      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief: `${brief} attempt ${i}`, tier: i < 2 ? "standard" : "premium" },
      })
    }
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations!.map((d) => d.attempt)).toEqual([1, 2, 3])
    expect(unit.tier).toBe("premium")
    expect(unit.w).toContain("attempt 2")
  })

  it("caps delegations at 20 but keeps attempt monotonic across the slice", async () => {
    for (let i = 0; i < 25; i++) {
      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief: `${brief} #${i}`, tier: "cheap" },
      })
    }
    const dels = (await readLedger(ledgerPath)).phases.p1.units.u1.delegations!
    expect(dels).toHaveLength(20)
    expect(dels[dels.length - 1].attempt).toBe(25) // not reset to 20 after cap
    expect(dels[0].attempt).toBe(6)
  })

  it("re-delegating an old on-disk unit with no delegations field does not throw", async () => {
    const legacy = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: { p1: { s: "ip", g: "pending", units: { u1: { s: "done", v: "pass", w: "old brief", rej: [] } } } },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(legacy), "utf-8")
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief, tier: "standard" },
    })
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations).toHaveLength(1)
    expect(unit.delegations![0].attempt).toBe(1)
  })

  it("record_review persists findings under phase.reviews with a server timestamp", async () => {
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: {
        advisor: "codex",
        findings: [
          { severity: "high", file: "ledger.ts", line: "115", description: "overwrite bug", classification: "confirmed" },
          { severity: "low", file: "x.ts", line: "1", description: "nit", classification: "rejected" },
        ],
      },
    })
    const reviews = (await readLedger(ledgerPath)).phases.p1.reviews!
    expect(reviews).toHaveLength(1)
    expect(reviews[0].advisor).toBe("codex")
    expect(reviews[0].findings).toHaveLength(2)
    expect(reviews[0].findings[0].classification).toBe("confirmed")
    expect(typeof reviews[0].ts).toBe("string")
  })

  it("caps reviews at 20", async () => {
    for (let i = 0; i < 25; i++) {
      await writeLedger(ledgerPath, {
        operation: "record_review",
        phase: "p1",
        data: { advisor: `a${i}`, findings: [] },
      })
    }
    expect((await readLedger(ledgerPath)).phases.p1.reviews).toHaveLength(20)
  })

  it("rejects an unknown ledger operation at the applyOperation exhaustiveness guard", async () => {
    await expect(
      writeLedger(ledgerPath, { operation: "bogus_op", phase: "p1", data: {} } as any)
    ).rejects.toThrow(/unknown ledger operation/)
  })
})

describe("ledger v0.0.7.5 backward compat", () => {
  it("reads an existing ledger without via/scope and returns fields as undefined", async () => {
    const legacy = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: { s: "done", v: "pass", w: "worker brief", rej: [] },
          },
        },
      },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(legacy), "utf-8")

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.scope).toBeUndefined()
    expect(ledger.phases.p1.units.u1.via).toBeUndefined()
    expect(ledger.phases.p1.units.u1.note).toBeUndefined()
    // v0.3.1 fields are absent on ledgers written before they existed
    expect(ledger.phases.p1.units.u1.tier).toBeUndefined()
    expect(ledger.phases.p1.units.u1.delegations).toBeUndefined()
    expect(ledger.phases.p1.reviews).toBeUndefined()
  })

  it("reads an existing ledger with scope on phase — returns scope populated", async () => {
    const withScope = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          scope: { has_tests: true, has_api: false, has_build: true },
          units: {},
        },
      },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(withScope), "utf-8")

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.scope).toEqual({ has_tests: true, has_api: false, has_build: true })
  })

  it("set_verdict with via and note — roundtrips both fields", async () => {
    // Delegate first
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to pass the 20-char minimum check here" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "worker", note: "tests green" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("pass")
    expect(ledger.phases.p1.units.u1.via).toBe("worker")
    expect(ledger.phases.p1.units.u1.note).toBe("tests green")
  })

  it("set_verdict without via/note — on-disk JSON omits those keys entirely", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to pass the minimum length check" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    const raw = await fs.readFile(ledgerPath, "utf-8")
    // Keys should NOT appear in the serialized JSON when undefined
    expect(raw).not.toContain("\"via\"")
    expect(raw).not.toContain("\"note\"")
    // Sanity: the v field IS present
    expect(raw).toContain("\"v\":\"pass\"")
  })

  it("subsequent set_verdict without via clears a previously-set via", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to pass the minimum length check" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "worker", note: "first" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.via).toBeUndefined()
    expect(ledger.phases.p1.units.u1.note).toBeUndefined()
  })
})
