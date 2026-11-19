import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fsp from "fs/promises"
import os from "os"
import path from "path"
import {
  DEFAULT_WORKER_MODELS,
  WORKER_MODELS_FILE,
  configuredWorkerModels,
  resolveWorkerSeat,
  workerSeatStatus,
} from "../src/lib/workerSeats.js"
import { antigravityAgentsInit } from "../src/tools/antigravityAgentsInit.js"

// 0.9.7: Antigravity seats are `.agents/agents/*.md` files whose `model:` is a tier word. A tier
// word names the seat but no exact model, so it must never become an enforced required_model.
describe("worker seats on the antigravity host", () => {
  let dir: string
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ag-seats-")) })
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }) })

  it("ships tier-word defaults: flash for cheap and standard, pro for premium and frontier", () => {
    expect(DEFAULT_WORKER_MODELS.antigravity).toEqual({ cheap: "flash", standard: "flash", premium: "pro", frontier: "pro" })
  })

  it("a missing seat falls back to the tier word as a label, with no enforceable model", async () => {
    const seat = await resolveWorkerSeat(dir, "antigravity", "premium")
    expect(seat).toEqual({ role: "foreman-worker-heavy", missing: true, tier_label: "pro" })
    expect(seat.model).toBeUndefined()
  })

  it("reads the tier word from the .agents folder, not .antigravity", async () => {
    await antigravityAgentsInit({ project_dir: dir }, { home: path.join(dir, "home") })
    const seat = await resolveWorkerSeat(dir, "antigravity", "cheap")
    expect(seat).toEqual({ role: "foreman-worker-light", tier_label: "flash" })
    await expect(fsp.access(path.join(dir, ".antigravity"))).rejects.toThrow()
  })

  it("a concrete id in the mapping file is still enforced exactly", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { premium: "gemini-4-hydrogen-tiered-xhigh" } }))
    expect(await configuredWorkerModels(dir, "antigravity")).toEqual({ premium: "gemini-4-hydrogen-tiered-xhigh" })
    const seat = await resolveWorkerSeat(dir, "antigravity", "premium")
    expect(seat.model).toBe("gemini-4-hydrogen-tiered-xhigh")
    expect(seat.source).toBe(WORKER_MODELS_FILE)
  })

  it("a tier word in the mapping file stays a label", async () => {
    await fsp.writeFile(path.join(dir, WORKER_MODELS_FILE), JSON.stringify({ antigravity: { standard: "pro" } }))
    const seat = await resolveWorkerSeat(dir, "antigravity", "standard")
    expect(seat.model).toBeUndefined()
    expect(seat.tier_label).toBe("pro")
  })

  it("status renders the tier word and hints antigravity_agents_init when seats are missing", async () => {
    const status = await workerSeatStatus(dir, "antigravity")
    expect(status.worker_seats).toContain("cheap=foreman-worker-light:flash (missing agent)")
    expect(status.worker_seats).toContain("frontier=foreman-worker-frontier:pro (missing agent)")
    expect(status.worker_seat_hint).toContain("antigravity_agents_init")
  })

  it("status reports no missing agents after init", async () => {
    await antigravityAgentsInit({ project_dir: dir }, { home: path.join(dir, "home") })
    const status = await workerSeatStatus(dir, "antigravity")
    expect(status.missing_worker_agents).toBe("none")
    expect(status.worker_seats).toBe("cheap=foreman-worker-light:flash; standard=foreman-worker:flash; premium=foreman-worker-heavy:pro; frontier=foreman-worker-frontier:pro")
  })

  it("other hosts keep their behaviour: a claude-code alias is still a required model", async () => {
    const seat = await resolveWorkerSeat(dir, "claude-code", "premium")
    expect(seat.model).toBe("opus")
    expect(seat.tier_label).toBeUndefined()
  })
})
