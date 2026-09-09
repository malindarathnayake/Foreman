import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { KNOWN_HOSTS } from "../src/lib/hostProfiles.js"
import { handleReadProgress } from "../src/tools/readProgress.js"
import { sessionOrient } from "../src/tools/sessionOrient.js"
import type { LedgerFile, ProgressFile, Unit } from "../src/types.js"

let dir: string
let ledgerPath: string
let progressPath: string
const unit = (s: Unit["s"] = "pending", v: Unit["v"] = "pending"): Unit => ({ s, v, w: null, rej: [] })
const ledgerStatus = (text: string) => text.split("\nLEDGER STATUS\n")[1].split("\n\nPLANNING CHECKLIST")[0]

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-progress-authority-"))
  ledgerPath = path.join(dir, "custom-ledger.json")
  progressPath = path.join(dir, "custom-progress.json")
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function seed(ledger: LedgerFile, progress: ProgressFile = { phases: {}, error_log: [] }) {
  await fs.writeFile(ledgerPath, JSON.stringify(ledger))
  await fs.writeFile(progressPath, JSON.stringify(progress))
}

function reportedMismatch(): { ledger: LedgerFile; progress: ProgressFile } {
  const ledger: LedgerFile = { v: 1, ts: "2026-09-09T00:00:00Z", phases: {} }
  const progress: ProgressFile = { phases: {}, error_log: [] }
  for (let n = 1; n <= 9; n++) {
    const phase = `p${n}`
    ledger.phases[phase] = { s: "done", g: "pass", units: {} }
    progress.phases[phase] = { name: phase, units: {} }
    for (let i = 1; i <= (n === 9 ? 11 : 7); i++) {
      const id = `u${i}`
      ledger.phases[phase].units[id] = unit("done", "pass")
      progress.phases[phase].units[id] = { id, phase, status: "complete", notes: "Historical completed work" }
    }
  }
  ledger.phases["p9.5"] = { s: "ip", g: "pending", units: { u1: unit("delegated") } }
  ledger.phases["p9.6"] = { s: "ip", g: "pending", units: { u1: unit() }, declared_units: ["u1"] }
  ledger.phases.p10 = { s: "ip", g: "pending", units: {}, declared_units: ["u1"] }
  ledger.phases.p11 = { s: "ip", g: "pending", units: { u1: unit() } }
  return { ledger, progress }
}

describe("ledger-authoritative progress across host profiles", () => {
  it.each(KNOWN_HOSTS)("%s MCP displays active work despite a 67/67 checklist", async host => {
    const { ledger, progress } = reportedMismatch()
    await seed(ledger, progress)
    const server = await createServer({ host, ledgerPath, progressPath, docsDir: dir })
    const client = new Client({ name: "progress-authority-test", version: "1" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(st)
      await client.connect(ct)
      const read = async (name: string) => {
        const response = await client.callTool({ name, arguments: {} })
        expect(response.isError).not.toBe(true)
        return (response.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text").map(c => c.text).join("\n")
      }
      const display = await read("read_progress")
      const resume = await read("session_orient")
      expect(ledgerStatus(display)).toBe(resume)
      expect(display).toContain("status: in_progress")
      expect(display).toContain("resume_target: p9.5/u1")
      expect(display).toContain("next_pending_unit: p9.6/u1")
      expect(display).toContain("phases_done: 9")
      expect(display).toContain("phases_total: 13")
      expect(display).toContain("units_passed: 67")
      expect(display).toContain("units_total: 71")
      expect(display).toContain("units_remaining: 4")
      expect(display).toContain("entries_marked_complete: 67")
      expect(display).toContain("entries_total: 67")
      expect(display).not.toContain("67/67")
      expect(display).not.toContain("next_up: none")
      expect(JSON.parse(await fs.readFile(ledgerPath, "utf8"))).toEqual(ledger)
      expect(JSON.parse(await fs.readFile(progressPath, "utf8"))).toEqual(progress)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it("does not call a project complete when all unit verdicts pass but a phase gate is pending", async () => {
    await seed({ v: 1, ts: "", phases: { p1: { s: "ip", g: "pending", units: { u1: unit("done", "pass") } } } })
    const output = await handleReadProgress(progressPath, undefined, ledgerPath)
    expect(output).toContain("units_passed: 1")
    expect(output).toContain("units_remaining: 0")
    expect(output).toContain("status: in_progress")
    expect(output).toContain("action: retry_phase_gate")
    expect(output).toContain("phases_done: 0")
    expect(ledgerStatus(output)).toBe(await sessionOrient(ledgerPath, progressPath))
  })

  it("reports actual completion when phase gates pass even with an unfinished checklist", async () => {
    await seed({ v: 1, ts: "", phases: { p1: { s: "ip", g: "pass", units: { u1: unit("done", "pass") } } } }, {
      phases: { p1: { name: "One", units: { u1: { id: "u1", phase: "p1", status: "pending", notes: "Old note" } } } }, error_log: [],
    })
    const output = await handleReadProgress(progressPath, undefined, ledgerPath)
    expect(output).toContain("status: complete")
    expect(output).toContain("units_passed: 1")
    expect(output).toContain("entries_marked_complete: 0")
    expect(output).toContain("progress_advisories: stale:p1/u1")
  })

  it("surfaces false checklist completion and declared units missing from the ledger", async () => {
    await seed({ v: 1, ts: "", phases: { p1: { s: "ip", g: "pending", declared_units: ["u1"], units: {} } } }, {
      phases: { p1: { name: "One", units: { u1: { id: "u1", phase: "p1", status: "complete", notes: "Premature" } } } }, error_log: [],
    })
    const output = await handleReadProgress(progressPath, undefined, ledgerPath)
    expect(output).toContain("units_total: 1")
    expect(output).toContain("units_passed: 0")
    expect(output).toContain("state_drift: progress:complete(p1/u1);ledger:p1/u1")
    expect(output).toContain("missing_declared_units: p1/u1")
  })

  it("does not infer project completion from a checklist without a ledger", async () => {
    const { progress } = reportedMismatch()
    await fs.writeFile(progressPath, JSON.stringify(progress))
    const output = await handleReadProgress(progressPath, undefined, ledgerPath)
    expect(output).toContain("status: no_phases_yet")
    expect(output).toContain("units_passed: 0")
    expect(output).toContain("ledger:no_phases")
    expect(output).not.toContain("status: complete")
    expect(await fs.readdir(dir)).toEqual(["custom-progress.json"])
  })

  it("leaves corrupt files untouched and reports unknown ledger state rather than zero completion", async () => {
    await fs.writeFile(ledgerPath, "{broken ledger")
    await fs.writeFile(progressPath, "{broken checklist")
    const output = await handleReadProgress(progressPath, undefined, ledgerPath)
    expect(output).toContain("status: ledger_corrupt")
    expect(output).not.toContain("units_passed:")
    expect(await fs.readFile(ledgerPath, "utf8")).toBe("{broken ledger")
    expect(await fs.readFile(progressPath, "utf8")).toBe("{broken checklist")
    expect((await fs.readdir(dir)).sort()).toEqual(["custom-ledger.json", "custom-progress.json"])
  })

  it("truncating recent checklist entries does not change authoritative totals", async () => {
    const { ledger, progress } = reportedMismatch()
    await seed(ledger, progress)
    const output = await handleReadProgress(progressPath, 1, ledgerPath)
    expect(output).toContain("CHECKLIST RECENT (last 1 marked complete)")
    expect(output).toContain("units_total: 71")
    expect(output).toContain("entries_total: 67")
  })
})
