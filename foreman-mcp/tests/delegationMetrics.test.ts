import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { appendEvent, type SidecarEventInput } from "../src/lib/eventsSidecar.js"
import { resetForTest } from "../src/lib/redaction.js"
import { renderDelegationMetrics } from "../src/lib/delegationMetrics.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import type { LedgerFile, Unit } from "../src/types.js"

let tmpDir: string
let sidecarPath: string
let tsCounter: number

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-metrics-test-"))
  sidecarPath = path.join(tmpDir, "events.jsonl")
  tsCounter = 0
  resetForTest()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// Pinned, monotonically increasing timestamps — no wall-clock dependence.
function nextTs(): string {
  tsCounter++
  return `2026-07-06T00:00:${String(tsCounter).padStart(2, "0")}.000Z`
}

function fixtureEvent(overrides: Record<string, unknown> = {}): SidecarEventInput {
  return {
    v: 1,
    ts: nextTs(),
    event_id: `evt_${String(tsCounter).padStart(6, "0")}`,
    event_type: "delegation_started",
    phase: "5a",
    unit_id: "u1",
    attempt: 1,
    delegation_id: "del1",
    provider: "anthropic",
    model: "model-a",
    tier: "standard",
    capability_class: "capable",
    edit_format: "unified_diff",
    repair_attempt: 0,
    brief_hash: "hash_0000000000000001",
    prompt_prefix_hash: "hash_0000000000000002",
    base_file_hashes: { "src/foo.ts": "hash_0000000000000003" },
    ...overrides,
  } as SidecarEventInput
}

function buildLedger(phase: string, units: Record<string, { s: Unit["s"]; v: Unit["v"] }>): LedgerFile {
  const builtUnits: Record<string, Unit> = {}
  for (const [id, u] of Object.entries(units)) {
    builtUnits[id] = { s: u.s, v: u.v, w: null, rej: [] }
  }
  return {
    v: 1,
    ts: "2026-07-06T00:00:00.000Z",
    phases: {
      [phase]: { s: "ip", g: "pending", units: builtUnits },
    },
  }
}

// ─── Golden fixture shared by tests 1-4 ────────────────────────────────────────
// del1 (u1): full pass chain, tier standard/model-a.
// del2 (u2): ghost — terminal worker_completed, WORKER_GHOST, fail.
// del3 (u3): refunded — terminal worker_completed, WORKER_TIMEOUT, fail.
// del4 (u4): parse/apply fail — terminal patch_checked, PATCH_PARSE_FAIL, fail.
// del5 (u5): build fail — terminal validation_completed, BLD_ERR, fail.
// del6 (u6): semantic fail — terminal validation_completed, W_REJ, fail, tier premium/model-b.
// del7 (u7): open — delegation_started only.
async function seedGoldenFixture(): Promise<void> {
  // del1 — pass
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1", unit_id: "u1", delegation_id: "del1", event_type: "delegation_started" }))
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2", unit_id: "u1", delegation_id: "del1", event_type: "worker_completed" }))
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e3", unit_id: "u1", delegation_id: "del1", event_type: "patch_checked" }))
  await appendEvent(
    sidecarPath,
    fixtureEvent({ event_id: "e4", unit_id: "u1", delegation_id: "del1", event_type: "validation_completed", outcome: "pass" })
  )

  // del2 — ghost
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e5", unit_id: "u2", delegation_id: "del2", event_type: "delegation_started" }))
  await appendEvent(
    sidecarPath,
    fixtureEvent({
      event_id: "e6",
      unit_id: "u2",
      delegation_id: "del2",
      event_type: "worker_completed",
      failure_stage: "WORKER_GHOST",
      outcome: "fail",
    })
  )

  // del3 — refunded (WORKER_TIMEOUT)
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e7", unit_id: "u3", delegation_id: "del3", event_type: "delegation_started" }))
  await appendEvent(
    sidecarPath,
    fixtureEvent({
      event_id: "e8",
      unit_id: "u3",
      delegation_id: "del3",
      event_type: "worker_completed",
      failure_stage: "WORKER_TIMEOUT",
      outcome: "fail",
    })
  )

  // del4 — PATCH_PARSE_FAIL
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e9", unit_id: "u4", delegation_id: "del4", event_type: "delegation_started" }))
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e10", unit_id: "u4", delegation_id: "del4", event_type: "worker_completed" }))
  await appendEvent(
    sidecarPath,
    fixtureEvent({
      event_id: "e11",
      unit_id: "u4",
      delegation_id: "del4",
      event_type: "patch_checked",
      failure_stage: "PATCH_PARSE_FAIL",
      outcome: "fail",
    })
  )

  // del5 — BLD_ERR
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e12", unit_id: "u5", delegation_id: "del5", event_type: "delegation_started" }))
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e13", unit_id: "u5", delegation_id: "del5", event_type: "worker_completed" }))
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e14", unit_id: "u5", delegation_id: "del5", event_type: "patch_checked" }))
  await appendEvent(
    sidecarPath,
    fixtureEvent({
      event_id: "e15",
      unit_id: "u5",
      delegation_id: "del5",
      event_type: "validation_completed",
      failure_stage: "BLD_ERR",
      outcome: "fail",
    })
  )

  // del6 — W_REJ, tier premium / model-b
  await appendEvent(
    sidecarPath,
    fixtureEvent({ event_id: "e16", unit_id: "u6", delegation_id: "del6", event_type: "delegation_started", tier: "premium", model: "model-b" })
  )
  await appendEvent(
    sidecarPath,
    fixtureEvent({ event_id: "e17", unit_id: "u6", delegation_id: "del6", event_type: "worker_completed", tier: "premium", model: "model-b" })
  )
  await appendEvent(
    sidecarPath,
    fixtureEvent({ event_id: "e18", unit_id: "u6", delegation_id: "del6", event_type: "patch_checked", tier: "premium", model: "model-b" })
  )
  await appendEvent(
    sidecarPath,
    fixtureEvent({
      event_id: "e19",
      unit_id: "u6",
      delegation_id: "del6",
      event_type: "validation_completed",
      tier: "premium",
      model: "model-b",
      failure_stage: "W_REJ",
      outcome: "fail",
    })
  )

  // del7 — open
  await appendEvent(sidecarPath, fixtureEvent({ event_id: "e20", unit_id: "u7", delegation_id: "del7", event_type: "delegation_started" }))
}

// Realistic post-verdict state: set_verdict never mutates unit.s (ledger.ts:210-224 sets
// only v/v_ts/via/note), so every completed S7-delegated unit keeps s:"delegated" forever.
function goldenLedgerNoDrift(): LedgerFile {
  return buildLedger("5a", {
    u1: { s: "delegated", v: "pass" },
    u2: { s: "delegated", v: "fail" },
    u3: { s: "delegated", v: "fail" },
    u4: { s: "delegated", v: "fail" },
    u5: { s: "delegated", v: "fail" },
    u6: { s: "delegated", v: "fail" },
    u7: { s: "delegated", v: "pending" },
  })
}

const GOLDEN_OUTPUT = [
  "sidecar: present",
  "delegations: 7",
  "open: 1",
  "refunded: 1",
  "counted: 5",
  "task_success: 1/5 (20.0%)",
  "inconclusive: 0",
  "ghosts: 1",
  "",
  "STAGE SURVIVAL (conditional rates, explicit denominators; refunded excluded)",
  "stage | denominator | denom | survived | pct | failures",
  "stage0_model_discipline | counted delegations | 5 | 4 | 80.0% | WORKER_GHOST:1",
  "parse_apply | stage-0 survivors | 4 | 3 | 75.0% | PATCH_PARSE_FAIL:1",
  "build | clean applies | 3 | 2 | 66.7% | BLD_ERR:1",
  "semantic | clean builds | 2 | 1 | 50.0% | W_REJ:1",
  "",
  "REFUNDED (excluded from all scorecards)",
  "code | count",
  "WORKER_TIMEOUT | 1",
  "",
  "SCORECARD (per tier+model; refunded excluded from all denominators)",
  "tier | model | delegations | refunded | patch_apply_pct | task_success_pct | ghosts | failure_stages",
  "standard | model-a | 6 | 1 | 50.0% | 25.0% | 1 | BLD_ERR:1,PATCH_PARSE_FAIL:1,WORKER_GHOST:1",
  "premium | model-b | 1 | 0 | 100.0% | 0.0% | 0 | W_REJ:1",
  "",
  "WORKER_CONFIDENCE (advisory-only, never gates)",
  "confidence | outcome | count",
].join("\n")

describe("renderDelegationMetrics", () => {
  it("golden: full-string match on the mixed-outcome fixture", async () => {
    await seedGoldenFixture()
    const out = await renderDelegationMetrics(goldenLedgerNoDrift(), sidecarPath)
    expect(out).toBe(GOLDEN_OUTPUT)
  })

  it("denominator correctness: each stage row matches hand-computed values", async () => {
    await seedGoldenFixture()
    const out = await renderDelegationMetrics(goldenLedgerNoDrift(), sidecarPath)
    expect(out).toContain("stage0_model_discipline | counted delegations | 5 | 4 | 80.0% | WORKER_GHOST:1")
    expect(out).toContain("parse_apply | stage-0 survivors | 4 | 3 | 75.0% | PATCH_PARSE_FAIL:1")
    expect(out).toContain("build | clean applies | 3 | 2 | 66.7% | BLD_ERR:1")
    expect(out).toContain("semantic | clean builds | 2 | 1 | 50.0% | W_REJ:1")
  })

  it("refund exclusion: WORKER_TIMEOUT appears only in the REFUNDED table, never in a stage histogram or scorecard", async () => {
    await seedGoldenFixture()
    const out = await renderDelegationMetrics(goldenLedgerNoDrift(), sidecarPath)
    expect(out).toContain("WORKER_TIMEOUT | 1")
    // Exactly one occurrence of the code string in the whole output (the REFUNDED row).
    expect(out.split("WORKER_TIMEOUT").length - 1).toBe(1)
    // Scorecard denominators exclude the refunded attempt: counted-of-pair is 4, not 5.
    expect(out).toContain("standard | model-a | 6 | 1 | 50.0% | 25.0% | 1 | BLD_ERR:1,PATCH_PARSE_FAIL:1,WORKER_GHOST:1")
  })

  it("CLI-transport stages: all four are refunded (infra + pre-send), excluded from stage-survival + scorecard", async () => {
    // Each of the 4 new CLI stages, terminal fail on worker_completed — all REFUNDED per spec
    // (infra faults binary/exit/llm AND the pre-send dirty-tree operator setup fault; none is
    // the model's fault, so none pollutes the model scorecard).
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n1", unit_id: "uA", delegation_id: "delA", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n2", unit_id: "uA", delegation_id: "delA", event_type: "worker_completed", failure_stage: "WORKER_AIDER_EXIT", outcome: "fail" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n3", unit_id: "uB", delegation_id: "delB", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n4", unit_id: "uB", delegation_id: "delB", event_type: "worker_completed", failure_stage: "WORKER_AIDER_LLM_ERROR", outcome: "fail" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n5", unit_id: "uC", delegation_id: "delC", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n6", unit_id: "uC", delegation_id: "delC", event_type: "worker_completed", failure_stage: "WORKER_BINARY_NOT_FOUND", outcome: "fail" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n7", unit_id: "uD", delegation_id: "delD", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "n8", unit_id: "uD", delegation_id: "delD", event_type: "worker_completed", failure_stage: "WORKER_DIRTY_TREE_REFUSAL", outcome: "fail" }))

    const ledger = buildLedger("5a", {
      uA: { s: "delegated", v: "fail" },
      uB: { s: "delegated", v: "fail" },
      uC: { s: "delegated", v: "fail" },
      uD: { s: "delegated", v: "fail" },
    })
    const out = await renderDelegationMetrics(ledger, sidecarPath)

    // All 4 refunded, none counted.
    expect(out).toContain("refunded: 4")
    expect(out).toContain("counted: 0")

    // Each stage appears EXACTLY ONCE in the whole output — the REFUNDED table row only.
    expect(out.split("WORKER_AIDER_EXIT").length - 1).toBe(1)
    expect(out.split("WORKER_AIDER_LLM_ERROR").length - 1).toBe(1)
    expect(out.split("WORKER_BINARY_NOT_FOUND").length - 1).toBe(1)
    expect(out.split("WORKER_DIRTY_TREE_REFUSAL").length - 1).toBe(1)
    expect(out).toContain("WORKER_AIDER_EXIT | 1")
    expect(out).toContain("WORKER_AIDER_LLM_ERROR | 1")
    expect(out).toContain("WORKER_BINARY_NOT_FOUND | 1")
    expect(out).toContain("WORKER_DIRTY_TREE_REFUSAL | 1")

    // Nothing counted -> stage0 denominator is 0 and no stage is attributed to it.
    expect(out).toContain("stage0_model_discipline | counted delegations | 0 | 0 | n/a | -")
  })

  it("ghost counting: counted as a failure in the headline denominator, in the stage0 histogram, and in the scorecard ghosts column", async () => {
    await seedGoldenFixture()
    const out = await renderDelegationMetrics(goldenLedgerNoDrift(), sidecarPath)
    expect(out).toContain("ghosts: 1")
    expect(out).toContain("task_success: 1/5 (20.0%)") // ghost is in the counted denominator, not the numerator
    expect(out).toContain("WORKER_GHOST:1") // stage0 histogram
    expect(out).toContain("standard | model-a | 6 | 1 | 50.0% | 25.0% | 1 |") // ghosts column = 1
  })

  it("drift loudness: three independent mismatches each produce their exact drift line; rates stay unchanged", async () => {
    // del A: terminal pass, unit_a
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "a1", unit_id: "unit_a", delegation_id: "delA", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "a2", unit_id: "unit_a", delegation_id: "delA", event_type: "validation_completed", outcome: "pass" })
    )
    // del B: terminal fail (BLD_ERR), unit_b
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "b1", unit_id: "unit_b", delegation_id: "delB", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "b2",
        unit_id: "unit_b",
        delegation_id: "delB",
        event_type: "validation_completed",
        failure_stage: "BLD_ERR",
        outcome: "fail",
      })
    )
    // del C: open, unit_c
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "c1", unit_id: "unit_c", delegation_id: "delC", event_type: "delegation_started" }))

    const matchingLedger = buildLedger("5a", {
      unit_a: { s: "delegated", v: "pass" },
      unit_b: { s: "delegated", v: "fail" },
      unit_c: { s: "delegated", v: "pending" },
    })
    const mismatchedLedger = buildLedger("5a", {
      unit_a: { s: "delegated", v: "pending" }, // ledger behind sidecar: terminal pass, verdict still pending
      unit_c: { s: "delegated", v: "pass" }, // sidecar behind ledger: open delegation, verdict already resolved
      // unit_b intentionally omitted from the ledger entirely: unit missing for a terminal delegation
    })

    const cleanOut = await renderDelegationMetrics(matchingLedger, sidecarPath)
    const driftOut = await renderDelegationMetrics(mismatchedLedger, sidecarPath)

    expect(cleanOut).not.toContain("drift_warning")

    expect(driftOut).toContain(
      "drift_warning: delegation delA terminal (pass) but unit 5a/unit_a has verdict pending"
    )
    expect(driftOut).toContain(
      "drift_warning: delegation delB terminal (fail) but unit 5a/unit_b has verdict missing"
    )
    expect(driftOut).toContain(
      "drift_warning: delegation delC open in sidecar but unit 5a/unit_c already has verdict pass"
    )

    // Same counted/task_success regardless of the ledger's drift status.
    expect(cleanOut).toContain("counted: 2")
    expect(cleanOut).toContain("task_success: 1/2 (50.0%)")
    expect(driftOut).toContain("counted: 2")
    expect(driftOut).toContain("task_success: 1/2 (50.0%)")
  })

  it("mixed-path history is not drift: terminal fail + native re-delegation verdict pass", async () => {
    // S7 delegation fails terminal (W_REJ); pitboss re-delegates via a native worker, which
    // writes no sidecar events, and the unit legitimately reaches v:"pass". Not drift.
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "m1", unit_id: "u_mixed", delegation_id: "delMixed", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "m2",
        unit_id: "u_mixed",
        delegation_id: "delMixed",
        event_type: "validation_completed",
        failure_stage: "W_REJ",
        outcome: "fail",
      })
    )
    const ledger = buildLedger("5a", { u_mixed: { s: "delegated", v: "pass" } })
    const out = await renderDelegationMetrics(ledger, sidecarPath)
    expect(out).not.toContain("drift_warning")
  })

  it("healthy completed S7 delegation (s stays delegated) produces no drift", async () => {
    // set_verdict never mutates unit.s, so a normal pass chain still leaves s:"delegated"
    // forever. Consulting s (not v) would false-positive on every healthy completion.
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "h1", unit_id: "u_healthy", delegation_id: "delHealthy", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "h2", unit_id: "u_healthy", delegation_id: "delHealthy", event_type: "worker_completed" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "h3", unit_id: "u_healthy", delegation_id: "delHealthy", event_type: "patch_checked" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "h4", unit_id: "u_healthy", delegation_id: "delHealthy", event_type: "validation_completed", outcome: "pass" })
    )
    const ledger = buildLedger("5a", { u_healthy: { s: "delegated", v: "pass" } })
    const out = await renderDelegationMetrics(ledger, sidecarPath)
    expect(out).not.toContain("drift_warning")
  })

  it("defensive case: a terminal fail delegation with no failure_stage anywhere stays counted but emits a loud drift warning", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "d1", unit_id: "u_def", delegation_id: "delDef", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "d2", unit_id: "u_def", delegation_id: "delDef", event_type: "validation_completed", outcome: "fail" })
    )
    const ledger = buildLedger("5a", { u_def: { s: "fail", v: "fail" } })
    const out = await renderDelegationMetrics(ledger, sidecarPath)
    expect(out).toContain("counted: 1")
    expect(out).toContain("drift_warning: delegation delDef terminal fail without failure_stage")
    // Not attributed to any stage histogram.
    expect(out).toContain("stage0_model_discipline | counted delegations | 1 | 0 | 0.0% | -")
  })

  it("absent sidecar file: not an error, every denominator is zero", async () => {
    const ledger = buildLedger("5a", {})
    const out = await renderDelegationMetrics(ledger, path.join(tmpDir, "does-not-exist.jsonl"))
    expect(out.startsWith("sidecar: absent")).toBe(true)
    expect(out).toContain("task_success: 0/0 (n/a)")
    expect(out).toContain("stage0_model_discipline | counted delegations | 0 | 0 | n/a | -")
    expect(out).toContain("parse_apply | stage-0 survivors | 0 | 0 | n/a | -")
    expect(out).toContain("build | clean applies | 0 | 0 | n/a | -")
    expect(out).toContain("semantic | clean builds | 0 | 0 | n/a | -")
    expect(out).not.toContain("error")
  })

  it("corrupt sidecar file: readEvents throws, output is exactly the two error lines with the line number preserved", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "x1", unit_id: "ux1", delegation_id: "delX1", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "x2", unit_id: "ux2", delegation_id: "delX2", event_type: "delegation_started" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "x3", unit_id: "ux3", delegation_id: "delX3", event_type: "delegation_started" }))

    const raw = await fs.readFile(sidecarPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    const line2 = JSON.parse(lines[1])
    line2.unit_id = "tampered"
    lines[1] = JSON.stringify(line2)
    await fs.writeFile(sidecarPath, lines.join("\n") + "\n", "utf-8")

    const ledger = buildLedger("5a", {})
    const out = await renderDelegationMetrics(ledger, sidecarPath)
    const outLines = out.split("\n")
    expect(outLines[0]).toBe("error: sidecar_corrupt")
    expect(outLines[1]).toContain("detail:")
    expect(outLines[1]).toContain("line 2")
  })

  it("worker_confidence: last-carrying-event confidence paired with the delegation's terminal outcome", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "wc1", unit_id: "u_wc1", delegation_id: "delWC1", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "wc2",
        unit_id: "u_wc1",
        delegation_id: "delWC1",
        event_type: "validation_completed",
        worker_confidence: 0.4,
        outcome: "fail",
      })
    )
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "wc3", unit_id: "u_wc2", delegation_id: "delWC2", event_type: "delegation_started" }))
    await appendEvent(
      sidecarPath,
      fixtureEvent({
        event_id: "wc4",
        unit_id: "u_wc2",
        delegation_id: "delWC2",
        event_type: "validation_completed",
        worker_confidence: 0.9,
        outcome: "pass",
      })
    )
    const ledger = buildLedger("5a", { u_wc1: { s: "fail", v: "fail" }, u_wc2: { s: "done", v: "pass" } })
    const out = await renderDelegationMetrics(ledger, sidecarPath)
    expect(out).toContain("0.4 | fail | 1")
    expect(out).toContain("0.9 | pass | 1")
  })

  it("wiring round-trip: handleReadLedger('delegation_metrics') resolves the sidecar next to the ledger file", async () => {
    const ledgerPath = path.join(tmpDir, "ledger.json")
    const realSidecarPath = path.join(tmpDir, ".foreman-events.jsonl")

    const ledger: LedgerFile = { v: 1, ts: "2026-07-06T00:00:00.000Z", phases: {} }
    await fs.writeFile(ledgerPath, JSON.stringify(ledger), "utf-8")

    await appendEvent(realSidecarPath, fixtureEvent({ event_id: "w1", unit_id: "u_w", delegation_id: "delW", event_type: "delegation_started" }))
    await appendEvent(
      realSidecarPath,
      fixtureEvent({ event_id: "w2", unit_id: "u_w", delegation_id: "delW", event_type: "validation_completed", outcome: "pass" })
    )

    const viaTool = await handleReadLedger(ledgerPath, { query: "delegation_metrics" })
    const direct = await renderDelegationMetrics(ledger, realSidecarPath)
    expect(viaTool).toBe(direct)
    expect(viaTool).toContain("counted: 1")
  })
})
