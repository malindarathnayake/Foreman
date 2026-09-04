import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { computeGateUnitsHash, readLedger, writeLedger } from "../src/lib/ledger.js"
import { appendEvent, type SidecarEventInput } from "../src/lib/eventsSidecar.js"

let tmpDir: string
let ledgerPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-test-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── P5 discipline-adherence gate fixture helper ───────────────────────────────
// Mirrors tests/eventsSidecar.test.ts's fixtureEvent — same required-field set.
function fixtureEvent(overrides: Record<string, unknown> = {}): SidecarEventInput {
  return {
    v: 1,
    ts: new Date().toISOString(),
    event_id: "evt_5a000001",
    event_type: "delegation_started",
    phase: "p1",
    unit_id: "u1",
    attempt: 1,
    delegation_id: "del_5a000001",
    provider: "anthropic",
    model: "claude-sonnet",
    tier: "standard",
    capability_class: "capable",
    edit_format: "unified_diff",
    repair_attempt: 0,
    brief_hash: "hash_5a000001",
    prompt_prefix_hash: "hash_5a000002",
    base_file_hashes: { "src/foo.ts": "hash_5a000003" },
    ...overrides,
  } as SidecarEventInput
}

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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per handoff spec section 1a" },
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
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "short" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief, tier: "premium", route_reason: "subtle concurrency unit" },
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
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} attempt ${i}`, tier: i < 2 ? "standard" : "premium" },
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
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} #${i}`, tier: "cheap" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief, tier: "standard" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to pass the 20-char minimum check here" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to pass the minimum length check" },
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
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to pass the minimum length check" },
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

describe("ledger v0.5.0 delegation cap (D2a)", () => {
  const brief = "Worker brief: implement unit per spec (>= 20 chars)"

  it("add_rejection stamps the current delegation attempt", async () => {
    // Pre-delegation rejection stamps attempt 0
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-a", msg: "pre-delegation issue", ts: "2026-04-02T11:00:00Z" },
    })

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })

    // Post-delegation rejection stamps attempt 1
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-b", msg: "post-delegation issue", ts: "2026-04-02T12:00:00Z" },
    })

    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.rej).toHaveLength(2)
    expect(unit.rej[0].attempt).toBe(0)
    expect(unit.rej[1].attempt).toBe(1)
  })

  it("3 distinct stamped attempts blocks the 4th delegation", async () => {
    for (let i = 0; i < 3; i++) {
      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} #${i}` },
      })
      await writeLedger(ledgerPath, {
        operation: "add_rejection",
        phase: "p1",
        unit_id: "u1",
        data: { r: "reviewer-a", msg: `rejection ${i}`, ts: `2026-04-0${i + 1}T00:00:00Z` },
      })
    }

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} #3` },
      })
    ).rejects.toThrow(/DELEGATION CAP: unit 'u1' has 3 distinct rejected attempts \(cap 3\)/)
  })

  it("user_override:true passes the cap and is recorded on the delegation entry", async () => {
    for (let i = 0; i < 3; i++) {
      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} #${i}` },
      })
      await writeLedger(ledgerPath, {
        operation: "add_rejection",
        phase: "p1",
        unit_id: "u1",
        data: { r: "reviewer-a", msg: `rejection ${i}`, ts: `2026-04-0${i + 1}T00:00:00Z` },
      })
    }

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief, user_override: true },
    })

    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    const delegations = unit.delegations!
    expect(delegations).toHaveLength(4)
    expect(delegations[3].user_override).toBe(true)
    expect(delegations[0]).not.toHaveProperty("user_override")
    expect(delegations[1]).not.toHaveProperty("user_override")
    expect(delegations[2]).not.toHaveProperty("user_override")
  })

  it("two reviewers rejecting the same attempt count as one distinct attempt — cap not fired", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-a", msg: "issue A", ts: "2026-04-02T11:00:00Z" },
    })
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "reviewer-b", msg: "issue B", ts: "2026-04-02T11:05:00Z" },
    })

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: `${brief} retry` },
    })

    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations).toHaveLength(2)
    expect(unit.w).toContain("retry")
  })

  it("3 legacy unstamped rejections block delegation (conservative treatment)", async () => {
    const legacy = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: {
              s: "ip",
              v: "pending",
              w: "old brief",
              rej: [
                { r: "reviewer-a", msg: "legacy issue 1", ts: "2026-01-01T00:00:00Z" },
                { r: "reviewer-b", msg: "legacy issue 2", ts: "2026-01-01T01:00:00Z" },
                { r: "reviewer-c", msg: "legacy issue 3", ts: "2026-01-01T02:00:00Z" },
              ],
            },
          },
        },
      },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(legacy), "utf-8")

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
      })
    ).rejects.toThrow(/DELEGATION CAP/)
  })

  it("2 legacy unstamped rejections allow delegation", async () => {
    const legacy = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: {
              s: "ip",
              v: "pending",
              w: "old brief",
              rej: [
                { r: "reviewer-a", msg: "legacy issue 1", ts: "2026-01-01T00:00:00Z" },
                { r: "reviewer-b", msg: "legacy issue 2", ts: "2026-01-01T01:00:00Z" },
              ],
            },
          },
        },
      },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(legacy), "utf-8")

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })

    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations).toHaveLength(1)
    expect(unit.w).toBe(brief)
  })

  it("legacy rejection entries are never mutated by a successful delegation", async () => {
    const legacy = {
      v: 1,
      ts: "2026-01-01T00:00:00.000Z",
      phases: {
        p1: {
          s: "ip",
          g: "pending",
          units: {
            u1: {
              s: "ip",
              v: "pending",
              w: "old brief",
              rej: [
                { r: "reviewer-a", msg: "legacy issue 1", ts: "2026-01-01T00:00:00Z" },
                { r: "reviewer-b", msg: "legacy issue 2", ts: "2026-01-01T01:00:00Z" },
              ],
            },
          },
        },
      },
    }
    await fs.writeFile(ledgerPath, JSON.stringify(legacy), "utf-8")

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })

    const raw = await fs.readFile(ledgerPath, "utf-8")
    const parsed = JSON.parse(raw)
    const rej = parsed.phases.p1.units.u1.rej
    expect(rej).toHaveLength(2)
    expect(Object.keys(rej[0])).not.toContain("attempt")
    expect(Object.keys(rej[1])).not.toContain("attempt")
    expect(rej[0].attempt).toBeUndefined()
    expect(rej[1].attempt).toBeUndefined()
  })
})

describe("ledger v0.5.0 inconclusive + attestation floor (D2d/D2e)", () => {
  it("inconclusive needs no delegation", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "inconclusive" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("inconclusive")
  })

  it("v_ts stamped on every verdict", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "fail" },
    })
    let unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(typeof unit.v_ts).toBe("string")
    expect(Number.isNaN(Date.parse(unit.v_ts!))).toBe(false)

    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "inconclusive" },
    })
    unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(typeof unit.v_ts).toBe("string")
    expect(Number.isNaN(Date.parse(unit.v_ts!))).toBe(false)
  })

  it("INCONCLUSIVE blocks the gate with its own sentence", async () => {
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
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u2",
      data: { v: "inconclusive" },
    })

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/PHASE GATE BLOCKED: phase 'p1' has units without a pass verdict: u2/)
    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/INCONCLUSIVE \(reviewer gave no usable verdict — re-run review, do not treat as fail\): u2\./)
  })

  it("gate message without inconclusive units is unchanged", async () => {
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
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "pending" },
    })

    let caught: Error | undefined
    try {
      await writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/PHASE GATE BLOCKED.*u2/s)
    expect(caught!.message).not.toContain("INCONCLUSIVE")
  })

  it("floor boundary — exactly 5 words + 32 chars passes", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: false, has_api: false, has_build: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
    })

    const note = "abcdef abcdef abcdef abcdef abcd"
    expect(note.split(/\s+/).length).toBe(5)
    expect(note.length).toBe(32)

    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("pass")
    expect(ledger.phases.p1.units.u1.note).toBe(note)
  })

  it("floor — 4 words rejected", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: false, has_api: false, has_build: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
    })

    const note = "aaaaaaaaaa bbbbbbbbbb cccccccccc dd"
    expect(note.split(/\s+/).length).toBe(4)
    expect(note.length).toBe(35)

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass", note },
      })
    ).rejects.toThrow(/ATTESTATION REQUIRED/)
    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass", note },
      })
    ).rejects.toThrow("(got 4 words / 35 chars)")
  })

  it("floor — 31 chars rejected", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: false, has_api: false, has_build: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "worker brief long enough to clear the 20 char minimum" },
    })

    const note = "aaaaa bbbbb ccccc ddddd eeeeeee"
    expect(note.split(/\s+/).length).toBe(5)
    expect(note.length).toBe(31)

    await expect(
      writeLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass", note },
      })
    ).rejects.toThrow("(got 5 words / 31 chars)")
  })

  it("sub-floor note on an unscoped phase still passes", async () => {
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
      data: { v: "pass", note: "short note" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.v).toBe("pass")
    expect(ledger.phases.p1.units.u1.note).toBe("short note")
  })
})

describe("ledger v0.5.0 gate staleness hash (D2b)", () => {
  it("gate pass writes the snapshot with a sha256 hash and ISO timestamp", async () => {
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
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    const snapshot = ledger.phases.p1.gate_units_hash
    expect(snapshot).toBeDefined()
    expect(snapshot!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isNaN(Date.parse(snapshot!.ts))).toBe(false)
  })

  it("gate fail/pending do NOT write the snapshot", async () => {
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "fail" },
    })
    let ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.gate_units_hash).toBeUndefined()

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pending" },
    })
    ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.gate_units_hash).toBeUndefined()
  })

  it("hash is deterministic and recomputable — mismatches after a new unit is added", async () => {
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
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    let ledger = await readLedger(ledgerPath)
    const stored = ledger.phases.p1.gate_units_hash!.hash
    expect(computeGateUnitsHash(ledger.phases.p1.units)).toBe(stored)

    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "pending" },
    })
    ledger = await readLedger(ledgerPath)
    expect(computeGateUnitsHash(ledger.phases.p1.units)).not.toBe(stored)
  })
})

describe("ledger v0.5.0 seat minimum (D13)", () => {
  const brief = "worker brief long enough to clear the 20 char minimum"

  // Flagged, passing phase: one unit delegated + verdict pass, scope carries the flag(s).
  async function setupFlaggedPhase(scopeOverrides: Record<string, unknown> = {}) {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: {
        has_tests: true,
        has_api: false,
        has_build: true,
        security_boundary: true,
        ...scopeOverrides,
      },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
  }

  it("flagged + undeclared agent_class rejects with SEAT MINIMUM (Declared: none.)", async () => {
    await setupFlaggedPhase()

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/SEAT MINIMUM: phase 'p1' is scoped security_boundary/)

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow("Declared: none.")
  })

  it("flagged + agent_class:'capable' rejects (Declared: capable.)", async () => {
    await setupFlaggedPhase()

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass", agent_class: "capable" },
      })
    ).rejects.toThrow("Declared: capable.")
  })

  it("flagged + agent_class:'frontier' passes — gate is pass, gate_units_hash present", async () => {
    await setupFlaggedPhase()

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", agent_class: "frontier" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
    expect(ledger.phases.p1.gate_units_hash).toBeDefined()
  })

  it("flagged + user_override:true (no agent_class) passes", async () => {
    await setupFlaggedPhase()

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", user_override: true },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("unflagged scope + undeclared agent_class passes — field never required", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: true, has_api: false, has_build: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("ordering: non-passing unit on a flagged phase blocks with PHASE GATE BLOCKED, not SEAT MINIMUM", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: true, has_api: false, has_build: true, security_boundary: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "pending" },
    })

    let caught: Error | undefined
    try {
      await writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass", agent_class: "frontier" },
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/PHASE GATE BLOCKED/)
    expect(caught!.message).not.toContain("SEAT MINIMUM")
  })

  it("both flags set — message names both: 'scoped hot_path, security_boundary'", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: {
        has_tests: true,
        has_api: false,
        has_build: true,
        hot_path: true,
        security_boundary: true,
      },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow("scoped hot_path, security_boundary")
  })

  it("hot_path-only (no security_boundary) names hot_path but not security_boundary", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "p1",
      data: { has_tests: true, has_api: false, has_build: true, hot_path: true },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    let caught: Error | undefined
    try {
      await writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain("scoped hot_path")
    expect(caught!.message).not.toContain("security_boundary")
  })
})

describe("ledger P5 discipline-adherence gate", () => {
  const brief = "worker brief long enough to clear the 20 char minimum"

  // Seeds a phase with one unit that has passed set_unit_status(delegated) +
  // set_verdict(pass) on the LEDGER side. The sidecar side is seeded separately
  // per-test via appendEvent, exercising the real readEvents/resolveUnitDelegation
  // path through the default-on reader (no 4th arg passed to writeLedger anywhere
  // in this describe block).
  async function seedPassingUnit() {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
  }

  function sidecarPathFor(): string {
    return path.join(path.dirname(ledgerPath), ".foreman-events.jsonl")
  }

  it("native pass (no sidecar file at all) passes the gate", async () => {
    await seedPassingUnit()

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("sidecar file exists but only has events for a different unit — target unit resolves 'none', gate passes", async () => {
    await seedPassingUnit()
    await appendEvent(
      sidecarPathFor(),
      fixtureEvent({
        event_id: "e1",
        unit_id: "other_unit",
        delegation_id: "del_other",
        event_type: "delegation_started",
      })
    )

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("terminal pass reconciles — gate passes", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "e2",
        delegation_id: "del1",
        event_type: "validation_completed",
        outcome: "pass",
      })
    )

    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
  })

  it("contradiction blocks the gate — pass verdict vs sidecar terminal 'fail'", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "e2",
        delegation_id: "del1",
        event_type: "validation_completed",
        outcome: "fail",
        failure_stage: "W_REJ",
      })
    )

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/DISCIPLINE ADHERENCE:.*contradicts sidecar terminal outcome 'fail'/)

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pending")
    expect(ledger.phases.p1.g).not.toBe("pass")
  })

  it("open delegation blocks the gate — no terminal sidecar event", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e2", delegation_id: "del1", event_type: "patch_checked" })
    )

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/DISCIPLINE ADHERENCE:.*no terminal sidecar event/)

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).not.toBe("pass")
  })

  it("user_override lets a contradiction through and records it in discipline_overrides", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "e2",
        delegation_id: "del1",
        event_type: "validation_completed",
        outcome: "fail",
        failure_stage: "W_REJ",
      })
    )

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", user_override: true },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
    expect(ledger.phases.p1.discipline_overrides).toEqual([
      { discipline_override: true, unit_id: "u1", delegation_id: "del1" },
    ])
  })

  it("refunded terminal (e.g. WORKER_AIDER_EXIT) is a contradiction under strict reconciliation — blocks without override, passes with override", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "e2",
        delegation_id: "del1",
        event_type: "worker_completed",
        outcome: "fail",
        failure_stage: "WORKER_AIDER_EXIT",
      })
    )

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/DISCIPLINE ADHERENCE:.*contradicts sidecar terminal outcome 'fail'/)

    const blocked = await readLedger(ledgerPath)
    expect(blocked.phases.p1.g).not.toBe("pass")

    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", user_override: true },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
    expect(ledger.phases.p1.discipline_overrides).toEqual([
      { discipline_override: true, unit_id: "u1", delegation_id: "del1" },
    ])
  })

  it("broken/tampered sidecar hash chain throws LOUD — not absorbed by the gate", async () => {
    await seedPassingUnit()
    const sidecarPath = sidecarPathFor()
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e1", delegation_id: "del1", event_type: "delegation_started" })
    )
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "e2",
        delegation_id: "del1",
        event_type: "validation_completed",
        outcome: "pass",
      })
    )

    // Tamper the first line's payload — its stored event_hash no longer matches the
    // recomputed hash. Keep the trailing newline so the line is not "torn".
    const raw = await fs.readFile(sidecarPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    const line1 = JSON.parse(lines[0])
    line1.unit_id = "tampered"
    lines[0] = JSON.stringify(line1)
    await fs.writeFile(sidecarPath, lines.join("\n") + "\n", "utf-8")

    await expect(
      writeLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/hash mismatch|chain break|tamper/)

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).not.toBe("pass")
  })
})
