import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readProgress, writeProgress, truncateProgress } from "../src/lib/progress.js"
import type { ProgressFile } from "../src/types.js"

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
