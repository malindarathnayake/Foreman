import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readProgress, writeProgress, truncateProgress } from "../src/lib/progress.js"
import type { ProgressFile } from "../src/types.js"
import { parseFencedBlock, FENCE_START, FENCE_END, renderChecklist, handleWriteProgress } from "../src/tools/writeProgress.js"
import type { LedgerFile } from "../src/types.js"

let tmpDir: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "progress-test-"))
  progressPath = path.join(tmpDir, "progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── Helper ───────────────────────────────────────────────────────────────────
function makeProgress(
  completedCount: number,
  incompleteCount: number,
  errorCount: number = 0
): ProgressFile {
  const progress: ProgressFile = { phases: {}, error_log: [] }

  // Put all units in a single phase "phase1"
  progress.phases["phase1"] = { name: "Phase One", units: {} }

  // Completed units with staggered completed_at timestamps
  for (let i = 0; i < completedCount; i++) {
    const unitId = `completed-${i}`
    // Stagger by i hours from a base date
    const completedAt = new Date(Date.UTC(2026, 0, 1, i, 0, 0)).toISOString()
    progress.phases["phase1"].units[unitId] = {
      id: unitId,
      phase: "phase1",
      status: "complete",
      notes: `notes for completed unit ${i}`,
      completed_at: completedAt,
    }
  }

  // Incomplete units
  for (let i = 0; i < incompleteCount; i++) {
    const unitId = `incomplete-${i}`
    progress.phases["phase1"].units[unitId] = {
      id: unitId,
      phase: "phase1",
      status: "pending",
      notes: `notes for incomplete unit ${i}`,
    }
  }

  // Error log entries
  for (let i = 0; i < errorCount; i++) {
    progress.error_log.push({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      unit: `unit-${i}`,
      what_failed: `failure ${i}`,
      next_approach: `approach ${i}`,
    })
  }

  return progress
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("truncateProgress", () => {
  it("50 completed + 5 incomplete, truncated to 10 + 5", () => {
    const progress = makeProgress(50, 5)
    const view = truncateProgress(progress, 10)

    expect(view.completed).toHaveLength(10)
    expect(view.incomplete).toHaveLength(5)

    // completed[0] should be the most recently completed unit
    // Unit i has completed_at at hour i, so unit 49 is most recent
    expect(view.completed[0].id).toBe("completed-49")

    // All incomplete units are present
    const incompleteIds = view.incomplete.map((u) => u.id)
    for (let i = 0; i < 5; i++) {
      expect(incompleteIds).toContain(`incomplete-${i}`)
    }
  })

  it("0 completed → only incomplete shown", () => {
    const progress = makeProgress(0, 3)
    const view = truncateProgress(progress)

    expect(view.completed).toHaveLength(0)
    expect(view.incomplete).toHaveLength(3)
  })

  it("error log capped at 5", () => {
    const progress = makeProgress(0, 0, 10)
    const view = truncateProgress(progress)

    expect(view.errors).toHaveLength(5)
    // Should be the last 5 entries (indices 5-9)
    expect(view.errors[0].unit).toBe("unit-5")
    expect(view.errors[4].unit).toBe("unit-9")
  })

  it("status summary computed correctly", () => {
    const progress: ProgressFile = {
      phases: {
        phase1: {
          name: "Phase One",
          units: {
            u1: { id: "u1", phase: "phase1", status: "complete", notes: "done", completed_at: "2026-01-01T01:00:00.000Z" },
            u2: { id: "u2", phase: "phase1", status: "complete", notes: "also done", completed_at: "2026-01-01T02:00:00.000Z" },
            u3: { id: "u3", phase: "phase1", status: "pending", notes: "not yet" },
          },
        },
      },
      error_log: [],
    }

    const view = truncateProgress(progress, 10)

    expect(view.status.completed_count).toBe(2)
    expect(view.status.total_count).toBe(3)
    expect(view.status.phase).toBe("Phase One")
    // last_completed should reference u2 (most recently completed)
    expect(view.status.last_completed).toContain("u2")
    expect(view.status.last_completed).toContain("Phase One")
    // next_up should reference u3 (first incomplete)
    expect(view.status.next_up).toContain("u3")
    expect(view.status.next_up).toContain("Phase One")
  })
})

describe("writeProgress / readProgress", () => {
  it("writeProgress creates phase and unit", async () => {
    await writeProgress(progressPath, {
      operation: "start_phase",
      data: { phase: "p1", name: "Phase One" },
    })

    await writeProgress(progressPath, {
      operation: "update_status",
      data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "working on it" },
    })

    const progress = await readProgress(progressPath)

    expect(progress.phases["p1"]).toBeDefined()
    expect(progress.phases["p1"].name).toBe("Phase One")
    expect(progress.phases["p1"].units["u1"]).toBeDefined()
    expect(progress.phases["p1"].units["u1"].status).toBe("in_progress")
    expect(progress.phases["p1"].units["u1"].notes).toBe("working on it")
  })

  it("writeProgress complete_unit sets completed_at", async () => {
    await writeProgress(progressPath, {
      operation: "start_phase",
      data: { phase: "p1", name: "Phase One" },
    })

    const completedAt = "2026-04-02T10:00:00Z"
    await writeProgress(progressPath, {
      operation: "complete_unit",
      data: { unit_id: "u1", phase: "p1", completed_at: completedAt, notes: "finished" },
    })

    const progress = await readProgress(progressPath)
    const unit = progress.phases["p1"].units["u1"]

    expect(unit).toBeDefined()
    expect(unit.status).toBe("complete")
    expect(unit.completed_at).toBe(completedAt)
    expect(unit.notes).toBe("finished")
  })

  it("writeProgress log_error appends", async () => {
    await writeProgress(progressPath, {
      operation: "log_error",
      data: {
        date: "2026-04-01",
        unit: "u1",
        what_failed: "first failure",
        next_approach: "try again",
      },
    })

    await writeProgress(progressPath, {
      operation: "log_error",
      data: {
        date: "2026-04-02",
        unit: "u2",
        what_failed: "second failure",
        next_approach: "different approach",
      },
    })

    const progress = await readProgress(progressPath)

    expect(progress.error_log).toHaveLength(2)
    expect(progress.error_log[0].unit).toBe("u1")
    expect(progress.error_log[0].what_failed).toBe("first failure")
    expect(progress.error_log[1].unit).toBe("u2")
    expect(progress.error_log[1].what_failed).toBe("second failure")
  })

  it("readProgress on missing file returns fresh", async () => {
    const nonExistentPath = path.join(tmpDir, "nonexistent.json")
    const progress = await readProgress(nonExistentPath)

    expect(progress.phases).toBeDefined()
    expect(Object.keys(progress.phases)).toHaveLength(0)
    expect(progress.error_log).toHaveLength(0)

    // File should NOT have been created
    const exists = await fs
      .access(nonExistentPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("readProgress on corrupt file recovers — backup created and fresh returned", async () => {
    await fs.writeFile(progressPath, "{ this is not valid json !!!", "utf-8")

    const progress = await readProgress(progressPath)

    // Fresh progress returned
    expect(Object.keys(progress.phases)).toHaveLength(0)
    expect(progress.error_log).toHaveLength(0)

    // Backup file created
    const files = await fs.readdir(tmpDir)
    const backups = files.filter((f) => f.includes(".corrupt."))
    expect(backups).toHaveLength(1)
  })

  it("error_log FIFO caps at 20 entries on disk", async () => {
    // Write 25 error log entries
    for (let i = 0; i < 25; i++) {
      await writeProgress(progressPath, {
        operation: "log_error",
        data: {
          date: `2026-01-${String(i + 1).padStart(2, "0")}`,
          unit: `unit-${i}`,
          what_failed: `failure ${i}`,
          next_approach: `approach ${i}`,
        },
      })
    }

    const progress = await readProgress(progressPath)
    expect(progress.error_log).toHaveLength(20)
    // First entry should be entry #5 (0-indexed), since entries 0-4 were dropped
    expect(progress.error_log[0].unit).toBe("unit-5")
    expect(progress.error_log[19].unit).toBe("unit-24")
  })
})

describe("parseFencedBlock", () => {
  it("detects both fences in normal fence content", () => {
    const inner = "\n- [x] task one\n"
    const content = `preamble\n${FENCE_START}${inner}${FENCE_END}\npostamble`
    const result = parseFencedBlock(content)

    const expectedStartIdx = content.indexOf(FENCE_START)
    const expectedEndIdx = content.indexOf(FENCE_END)

    expect(result.hasStart).toBe(true)
    expect(result.hasEnd).toBe(true)
    expect(result.startIdx).toBe(expectedStartIdx)
    expect(result.endIdx).toBe(expectedEndIdx)
    expect(result.existing).toBe(inner)
  })

  it("returns all-absent fields when fenceless content has no markers", () => {
    const content = "no markers here at all"
    const result = parseFencedBlock(content)

    expect(result.hasStart).toBe(false)
    expect(result.hasEnd).toBe(false)
    expect(result.startIdx).toBe(-1)
    expect(result.endIdx).toBe(-1)
    expect(result.existing).toBe("")
  })

  it("handles fence only-start present with absent end marker", () => {
    const content = `before ${FENCE_START} after but no end`
    const result = parseFencedBlock(content)

    const expectedStartIdx = content.indexOf(FENCE_START)

    expect(result.hasStart).toBe(true)
    expect(result.hasEnd).toBe(false)
    expect(result.startIdx).toBe(expectedStartIdx)
    expect(result.endIdx).toBe(-1)
    expect(result.existing).toBe("")
  })

  it("handles fence only-end present with absent start marker", () => {
    const content = `before ${FENCE_END} after but no start`
    const result = parseFencedBlock(content)

    const expectedEndIdx = content.indexOf(FENCE_END)

    expect(result.hasStart).toBe(false)
    expect(result.hasEnd).toBe(true)
    expect(result.startIdx).toBe(-1)
    expect(result.endIdx).toBe(expectedEndIdx)
    expect(result.existing).toBe("")
  })

  it("uses first fence occurrence when multiple pairs are present", () => {
    const inner1 = " first block content "
    const inner2 = " second block content "
    const content =
      `A${FENCE_START}${inner1}${FENCE_END}B` +
      `${FENCE_START}${inner2}${FENCE_END}C`

    const result = parseFencedBlock(content)

    // First FENCE_START is at index 1 (after "A")
    const expectedStartIdx = 1
    // First FENCE_END is right after inner1
    const expectedEndIdx = 1 + FENCE_START.length + inner1.length

    expect(result.hasStart).toBe(true)
    expect(result.hasEnd).toBe(true)
    expect(result.startIdx).toBe(expectedStartIdx)
    expect(result.endIdx).toBe(expectedEndIdx)
    expect(result.existing).toBe(inner1)
  })
})

describe("renderChecklist", () => {
  it("renders empty ledger", () => {
    const ledger: LedgerFile = { v: 1, ts: "2026-04-17T00:00:00Z", phases: {} }
    expect(renderChecklist(ledger)).toBe("_No phases yet._\n")
  })

  it("renders phases in lexicographic order", () => {
    // Insert v75-p2 before v75-p1 in object-literal order
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "v75-p2": {
          s: "ip",
          g: "pending",
          units: {
            "2a": { s: "done", v: "pass", w: null, rej: [] },
          },
        },
        "v75-p1": {
          s: "ip",
          g: "pending",
          units: {
            "1a": { s: "done", v: "pass", w: null, rej: [] },
          },
        },
      },
    }
    const output = renderChecklist(ledger)
    const p1Idx = output.indexOf("### v75-p1")
    const p2Idx = output.indexOf("### v75-p2")
    expect(p1Idx).toBeGreaterThanOrEqual(0)
    expect(p2Idx).toBeGreaterThanOrEqual(0)
    expect(p1Idx).toBeLessThan(p2Idx)
  })

  it("renders units in lexicographic order within a phase", () => {
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "v75-p1": {
          s: "ip",
          g: "pending",
          units: {
            "1c": { s: "pending", v: "pending", w: null, rej: [] },
            "1a": { s: "pending", v: "pending", w: null, rej: [] },
            "1b": { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    }
    const output = renderChecklist(ledger)
    const idx1a = output.indexOf("1a")
    const idx1b = output.indexOf("1b")
    const idx1c = output.indexOf("1c")
    expect(idx1a).toBeGreaterThanOrEqual(0)
    expect(idx1b).toBeGreaterThanOrEqual(0)
    expect(idx1c).toBeGreaterThanOrEqual(0)
    expect(idx1a).toBeLessThan(idx1b)
    expect(idx1b).toBeLessThan(idx1c)
  })

  it("renders done (pass) vs pending units with correct icons", () => {
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "v75-p1": {
          s: "ip",
          g: "pending",
          units: {
            "1a": { s: "done", v: "pass", w: null, rej: [] },
            "1b": { s: "pending", v: "pending", w: null, rej: [] },
          },
        },
      },
    }
    const output = renderChecklist(ledger)
    expect(output).toContain("- [x] 1a — pass")
    expect(output).toContain("- [ ] 1b — pending")
  })

  it("renders note suffix with trimming and length cap", () => {
    // Build a note that spans multiple lines and exceeds 120 characters
    const longNote = "A".repeat(60) + "\n" + "B".repeat(70)
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "v75-p1": {
          s: "ip",
          g: "pending",
          units: {
            "1a": { s: "done", v: "pass", w: null, rej: [], note: longNote },
          },
        },
      },
    }
    const output = renderChecklist(ledger)
    // Note suffix is present
    expect(output).toContain("- [x] 1a — pass —")
    // No literal newline in the note suffix (single-line)
    const suffixStart = output.indexOf("- [x] 1a — pass — ")
    const lineEnd = output.indexOf("\n", suffixStart)
    const noteSuffix = output.slice(suffixStart, lineEnd)
    expect(noteSuffix).not.toContain("\n")
    // The note part after " — " (second em dash) must be ≤120 chars
    const noteContent = noteSuffix.split(" — ").slice(2).join(" — ")
    expect(noteContent.length).toBeLessThanOrEqual(120)
    // Must end with ellipsis since original is > 120 chars
    expect(noteContent.endsWith("…")).toBe(true)
  })

  it("excludes non-checklist content", () => {
    const ledger: LedgerFile = {
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "v75-p1": {
          s: "ip",
          g: "fail",
          scope: { has_tests: true, has_api: false, has_build: true },
          units: {
            "1a": {
              s: "fail",
              v: "fail",
              via: "worker",
              w: "some brief",
              rej: [{ r: "REJ-1", msg: "bad output", ts: "2026-04-17T00:00:00Z" }],
              note: "a real note",
            },
          },
        },
      },
    }
    const output = renderChecklist(ledger)
    // Must NOT contain raw ledger fields
    expect(output).not.toContain('"rej"')
    expect(output).not.toContain("scope")
    expect(output).not.toContain("has_tests")
    expect(output).not.toContain('"g":')
    expect(output).not.toContain("2026-04-17T00:00:00Z")
    expect(output).not.toContain("gate")
    // Must still render the unit correctly
    expect(output).toContain("- [ ] 1a — fail — a real note")
  })
})

describe("handleWriteProgress docsDir fence integration", () => {
  let fenceDir: string
  let fenceProgressPath: string

  beforeEach(async () => {
    fenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fence-test-"))
    fenceProgressPath = path.join(fenceDir, "progress.json")
  })

  afterEach(async () => {
    await fs.rm(fenceDir, { recursive: true, force: true })
  })

  it("fence-splice: substitutes checklist between existing fences", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "p1": {
          s: "ip",
          g: "pending",
          units: { "u1": { s: "done", v: "pass", w: null, rej: [] } },
        },
      },
    }))

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    await fs.writeFile(
      markdownPath,
      `preamble\n${FENCE_START}\nOLD OLD OLD\n${FENCE_END}\npostamble\n`,
    )

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("preamble")
    expect(content).toContain("postamble")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("- [x] u1")
    expect(content).not.toContain("OLD OLD OLD")
  })

  it("fence-append: appends fenced block to fenceless file", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "p1": {
          s: "ip",
          g: "pending",
          units: { "u1": { s: "done", v: "pass", w: null, rej: [] } },
        },
      },
    }))

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    await fs.writeFile(markdownPath, "# My notes\nSome hand-written content.\n")

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("My notes")
    expect(content).toContain("Some hand-written content.")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("- [x] u1")
  })

  it("fence-malformed-only-start: warns and appends", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1, ts: "2026-04-17T00:00:00Z", phases: {},
    }))

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    await fs.writeFile(markdownPath, `# Notes\n${FENCE_START}\nno end marker here\n`)

    const warnSpy = vi.spyOn(console, "warn")

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "pending", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("malformed"))
    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("# Notes")

    warnSpy.mockRestore()
  })

  it("fence-malformed-only-end: warns and appends", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1, ts: "2026-04-17T00:00:00Z", phases: {},
    }))

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    await fs.writeFile(markdownPath, `# Notes\nno start marker here\n${FENCE_END}\n`)

    const warnSpy = vi.spyOn(console, "warn")

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "pending", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("malformed"))
    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("# Notes")

    warnSpy.mockRestore()
  })

  it("fence-missing-file: does not create PROGRESS.md when absent", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1, ts: "2026-04-17T00:00:00Z", phases: {},
    }))

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    // Ensure it does not pre-exist
    await fs.rm(markdownPath, { force: true })

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "pending", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    const exists = await fs.access(markdownPath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it("fence-preserves-hand-written-content-around-block", async () => {
    const ledgerPath = path.join(fenceDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1,
      ts: "2026-04-17T00:00:00Z",
      phases: {
        "p1": {
          s: "ip",
          g: "pending",
          units: { "u1": { s: "done", v: "pass", w: null, rej: [] } },
        },
      },
    }))

    const preamble = "# My Docs\n\nHand-written preamble.\n\n"
    const postamble = "\n## More Hand-Written Content\n\nThis must survive verbatim.\n"
    const originalContent = `${preamble}${FENCE_START}\nOLD CONTENT\n${FENCE_END}${postamble}`

    const markdownPath = path.join(fenceDir, "PROGRESS.md")
    await fs.writeFile(markdownPath, originalContent)

    await handleWriteProgress(
      fenceProgressPath,
      { operation: "update_status", data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "n" } },
      fenceDir,
      ledgerPath,
    )

    const content = await fs.readFile(markdownPath, "utf-8")
    // Preamble preserved
    expect(content).toContain("Hand-written preamble.")
    // Postamble byte-identical (present verbatim)
    expect(content).toContain(postamble)
    // Old fence content replaced
    expect(content).not.toContain("OLD CONTENT")
    // New checklist present
    expect(content).toContain("- [x] u1")
  })
})
