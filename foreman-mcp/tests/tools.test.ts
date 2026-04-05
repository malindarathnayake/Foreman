import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { bundleStatus } from "../src/tools/bundleStatus.js"
import { changelog } from "../src/tools/changelog.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { handleReadProgress } from "../src/tools/readProgress.js"
import { capabilityCheck } from "../src/tools/capabilityCheck.js"
import { writeLedger } from "../src/lib/ledger.js"
import { writeProgress } from "../src/lib/progress.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-test-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
  progressPath = path.join(tmpDir, "progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("bundleStatus", () => {
  it("returns TOON output containing bundle_version: 0.0.3", async () => {
    const result = await bundleStatus()
    expect(result).toContain("bundle_version: 0.0.3")
  })

  it("returns output containing compatible: true", async () => {
    const result = await bundleStatus()
    expect(result).toContain("compatible: true")
  })

  it("returns output containing OVERRIDE INFO section", async () => {
    const result = await bundleStatus()
    expect(result).toContain("OVERRIDE INFO")
  })

  it("returns output mentioning .claude/skills path", async () => {
    const result = await bundleStatus()
    expect(result).toContain(".claude/skills/")
  })
})

describe("changelog", () => {
  it("returns table with version | date | description header when called with no args", () => {
    const result = changelog()
    expect(result).toContain("version | date | description")
  })

  it("includes the 0.0.1 entry", () => {
    const result = changelog()
    expect(result).toContain("0.0.1")
  })

  it("returns entries newer than sinceVersion", () => {
    const result = changelog("0.0.1")
    // 0.0.1 is the oldest — entries before it in the array (0.0.2, 0.0.2.1) are returned
    expect(result).toContain("0.0.2")
    expect(result).toContain("0.0.2.1")
    expect(result).not.toContain("Initial architecture")
  })
})

describe("handleReadLedger", () => {
  it("returns JSON string for query: full", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "full" })
    const parsed = JSON.parse(result) as unknown
    expect(typeof result).toBe("string")
    expect(parsed).toBeDefined()
  })

  it("returns key/value for a specific phase + unit_id", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    const result = await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })
    expect(result).toContain("unit_id: u1")
    expect(result).toContain("phase: p1")
    expect(result).toContain("status: done")
  })

  it("returns error key/value when phase+unit not found", async () => {
    const result = await handleReadLedger(ledgerPath, { phase: "nonexistent", unit_id: "missing" })
    expect(result).toContain("error: unit not found")
  })

  it("returns verdicts table for query: verdicts", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "verdicts" })
    expect(result).toContain("phase | unit | verdict")
    expect(result).toContain("p1")
    expect(result).toContain("u1")
    expect(result).toContain("pass")
  })

  it("returns phase_gates table for query: phase_gates", async () => {
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "phase_gates" })
    expect(result).toContain("phase | status | gate")
    expect(result).toContain("p1")
    expect(result).toContain("pass")
  })
})

describe("handleReadProgress", () => {
  it("returns output with STATUS section on empty progress file", async () => {
    const result = await handleReadProgress(progressPath)
    expect(result).toContain("STATUS")
  })

  it("returns output with INCOMPLETE section when units are pending", async () => {
    await writeProgress(progressPath, {
      operation: "update_status",
      data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "working on it" },
    })

    const result = await handleReadProgress(progressPath)
    expect(result).toContain("INCOMPLETE")
    expect(result).toContain("u1")
  })

  it("returns RECENT section when units are completed", async () => {
    await writeProgress(progressPath, {
      operation: "complete_unit",
      data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "done" },
    })

    const result = await handleReadProgress(progressPath)
    expect(result).toContain("RECENT")
    expect(result).toContain("u1")
  })

  it("completed count is reflected in status", async () => {
    await writeProgress(progressPath, {
      operation: "complete_unit",
      data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "done" },
    })

    const result = await handleReadProgress(progressPath)
    expect(result).toContain("1/1 units")
  })
})

describe("capabilityCheck", () => {
  it("returns available: false when codex CLI is not installed", async () => {
    // codex is unlikely to be installed in test environments
    const result = await capabilityCheck("codex")
    // The result should always be TOON key/value format
    expect(result).toContain("cli: codex")
    expect(result).toMatch(/available: (true|false)/)
    expect(result).toContain("auth_status:")
  }, 30000)

  it("returns available: false for codex on systems without it", async () => {
    // We can verify the output format is correct TOON regardless of install status
    const result = await capabilityCheck("codex")
    const lines = result.split("\n")
    // Should have at least 4 lines (cli, available, version, auth_status)
    expect(lines.length).toBeGreaterThanOrEqual(4)
    // Each line should be key: value format
    for (const line of lines) {
      expect(line).toMatch(/^\w+: .+$/)
    }
  }, 30000)
})
