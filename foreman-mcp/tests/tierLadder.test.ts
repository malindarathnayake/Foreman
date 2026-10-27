import { writeLedger } from "./helpers/authorizedLedger.js"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readLedger } from "../src/lib/ledger.js"
import { claudeAgentsInit } from "../src/tools/claudeAgentsInit.js"
import type { Tier } from "../src/types.js"

// 0.9.1 (field report 2026-10-12): a unit rejected at premium (opus) was retried there until the
// owner hand-picked Fable. A rejected premium attempt now sends the next one to the frontier seat.

let tmpDir: string
let ledgerPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tier-ladder-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const brief = "Worker brief: implement unit per spec (>= 20 chars)"

function delegate(tier: Tier, extra: Record<string, unknown> = {}, host: "claude-code" | "codex" = "claude-code") {
  return writeLedger(
    ledgerPath,
    {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief, tier, route_reason: `attempt at ${tier}`, ...extra },
    },
    undefined, undefined, host, undefined, null
  )
}

function reject(msg = "reviewer rejected the attempt", host: "claude-code" | "codex" = "claude-code") {
  return writeLedger(
    ledgerPath,
    { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "reviewer-a", msg, ts: new Date().toISOString() } },
    undefined, undefined, host, undefined, null
  )
}

describe("tier ladder: premium failure goes to frontier (claude-code)", () => {
  it("refuses a premium retry after a rejected premium attempt", async () => {
    await delegate("premium")
    await reject()
    await expect(delegate("premium")).rejects.toThrow(/TIER LADDER/)
    await expect(delegate("standard")).rejects.toThrow(/configured frontier seat/)
  })

  it("refuses a retry with no tier after a rejected premium attempt", async () => {
    await delegate("premium")
    await reject()
    await expect(writeLedger(ledgerPath, {
      operation: "set_unit_status", phase: "p1", unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief },
    }, undefined, undefined, "claude-code", undefined, null)).rejects.toThrow(/TIER LADDER/)
  })

  it("accepts the frontier attempt and records its tier", async () => {
    await delegate("premium")
    await reject()
    await delegate("frontier")
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.tier).toBe("frontier")
    expect(unit.delegations!.map((d) => d.tier)).toEqual(["premium", "frontier"])
  })

  it("lets the owner keep premium with user_override", async () => {
    await delegate("premium")
    await reject()
    await delegate("premium", { user_override: true })
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations!.at(-1)!.user_override).toBe(true)
  })

  it("treats a fail verdict on a premium attempt like a rejection", async () => {
    await delegate("premium")
    await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } }, undefined, undefined, "claude-code", undefined, null)
    await expect(delegate("premium")).rejects.toThrow(/TIER LADDER/)
  })

  it("an inline rejection on a premium retry is refused and not recorded", async () => {
    await delegate("premium")
    await expect(delegate("premium", { rejection: { r: "reviewer-a", msg: "still wrong" } })).rejects.toThrow(/TIER LADDER/)
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.rej).toHaveLength(0)
    expect(unit.delegations).toHaveLength(1)
  })

  it("standard -> premium -> frontier fits inside the attempt cap", async () => {
    await delegate("standard")
    await reject("standard attempt rejected")
    await delegate("premium")
    await reject("premium attempt rejected")
    await delegate("frontier")
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations!.map((d) => d.tier)).toEqual(["standard", "premium", "frontier"])
    expect(unit.delegations!.some((d) => d.user_override)).toBe(false)
  })

  it("does not constrain retries after a rejected standard or frontier attempt", async () => {
    await delegate("standard")
    await reject()
    await delegate("standard")
    await reject()
    await delegate("frontier")
    await reject()
    // Third failure hits the cap; the owner's override pays for the attempt, the ladder has nothing to say.
    await delegate("frontier", { user_override: true })
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.tier).toBe("frontier")
  })

  it("applies on codex as well as the other profiles", async () => {
    await delegate("premium", {}, "codex")
    await reject("rejected", "codex")
    await expect(delegate("premium", {}, "codex")).rejects.toThrow(/TIER LADDER/)
    await delegate("frontier", {}, "codex")
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.delegations).toHaveLength(2)
  })
})

describe("claude_agents_init frontier seat", () => {
  it("writes foreman-worker-frontier with the fable family alias", async () => {
    await claudeAgentsInit({ project_dir: tmpDir })
    const text = await fs.readFile(path.join(tmpDir, ".claude", "agents", "foreman-worker-frontier.md"), "utf-8")
    expect(text).toMatch(/^model: fable$/m)
    expect(text).toMatch(/^effort: high$/m)
  })

  it("defaults every seat to a family alias, never a versioned id", async () => {
    await claudeAgentsInit({ project_dir: tmpDir })
    for (const role of ["foreman-worker-light", "foreman-worker", "foreman-worker-heavy", "foreman-worker-frontier"]) {
      const text = await fs.readFile(path.join(tmpDir, ".claude", "agents", `${role}.md`), "utf-8")
      expect(text).toMatch(/^model: (sonnet|opus|fable|haiku)$/m)
    }
  })
})
