import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleWriteProgress } from "../src/tools/writeProgress.js"
import { normalizeReview } from "../src/tools/normalizeReview.js"
import { readLedger } from "../src/lib/ledger.js"
import { readProgress } from "../src/lib/progress.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-tools-test-"))
  ledgerPath = path.join(tmpDir, "ledger.json")
  progressPath = path.join(tmpDir, "progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── handleWriteLedger ────────────────────────────────────────────────────────

describe("handleWriteLedger", () => {
  it("valid input → returns TOON confirmation with 'status: ok'", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("operation: set_unit_status")
    expect(result).toContain("phase: p1")
    expect(result).toContain("unit_id: u1")
  })

  it("invalid input (missing operation) → throws Zod error", async () => {
    await expect(
      handleWriteLedger(ledgerPath, { phase: "p1", unit_id: "u1" })
    ).rejects.toThrow()
  })

  it("state is persisted → readLedger returns updated state", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["p1"]).toBeDefined()
    expect(ledger.phases["p1"].units["u1"]).toBeDefined()
    expect(ledger.phases["p1"].units["u1"].s).toBe("done")
  })

  it("set_verdict operation returns confirmation with correct operation", async () => {
    // Must delegate before passing verdict (pitboss enforcement)
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    const result = await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("operation: set_verdict")
  })

  it("update_phase_gate has unit_id: n/a in output", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("unit_id: n/a")
  })
})

// ─── handleWriteProgress ─────────────────────────────────────────────────────

describe("handleWriteProgress", () => {
  it("valid input → returns TOON confirmation with 'status: ok'", async () => {
    const result = await handleWriteProgress(progressPath, {
      operation: "update_status",
      data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "working on it" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("operation: update_status")
  })

  it("with docsDir → regenerates PROGRESS.md markdown file", async () => {
    await handleWriteProgress(
      progressPath,
      {
        operation: "complete_unit",
        data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "done" },
      },
      tmpDir
    )

    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    const exists = await fs
      .access(markdownPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  it("PROGRESS.md contains [x] checkbox for complete units", async () => {
    await handleWriteProgress(
      progressPath,
      {
        operation: "complete_unit",
        data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "done" },
      },
      tmpDir
    )

    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("[x]")
  })

  it("PROGRESS.md contains [ ] checkbox for pending units", async () => {
    await handleWriteProgress(
      progressPath,
      {
        operation: "update_status",
        data: { unit_id: "u1", phase: "p1", status: "pending", notes: "not started" },
      },
      tmpDir
    )

    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("[ ]")
  })

  it("invalid input → throws Zod error", async () => {
    await expect(
      handleWriteProgress(progressPath, { operation: "unknown_op", data: {} })
    ).rejects.toThrow()
  })

  it("state is persisted → readProgress returns updated state", async () => {
    await handleWriteProgress(progressPath, {
      operation: "complete_unit",
      data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "finished" },
    })

    const progress = await readProgress(progressPath)
    expect(progress.phases["p1"]).toBeDefined()
    expect(progress.phases["p1"].units["u1"]).toBeDefined()
    expect(progress.phases["p1"].units["u1"].status).toBe("complete")
  })

  it("log_error operation persists error to error_log", async () => {
    await handleWriteProgress(progressPath, {
      operation: "log_error",
      data: {
        date: "2026-04-01",
        unit: "u1",
        what_failed: "compilation error",
        next_approach: "fix imports",
      },
    })

    const progress = await readProgress(progressPath)
    expect(progress.error_log).toHaveLength(1)
    expect(progress.error_log[0].unit).toBe("u1")
    expect(progress.error_log[0].what_failed).toBe("compilation error")
  })
})

// ─── normalizeReview ──────────────────────────────────────────────────────────

describe("normalizeReview", () => {
  it("raw text with severity markers → parsed into findings array", () => {
    const rawText = `
CRITICAL: Missing null check in user validation
HIGH: Resource leak in connection pool
`
    const { data } = normalizeReview("reviewer-a", rawText)

    expect(data.findings).toHaveLength(2)
    expect(data.findings[0].severity).toBe("critical")
    expect(data.findings[1].severity).toBe("high")
  })

  it("raw text with file:line references → file and line populated", () => {
    const rawText = `
HIGH: src/lib/ledger.ts:42 memory leak in connection handler
`
    const { data } = normalizeReview("reviewer-a", rawText)

    expect(data.findings).toHaveLength(1)
    expect(data.findings[0].file).toBe("src/lib/ledger.ts")
    expect(data.findings[0].line).toBe("42")
  })

  it("empty text → empty findings array", () => {
    const { data } = normalizeReview("reviewer-a", "")

    expect(data.findings).toHaveLength(0)
    expect(data.raw_length).toBe(0)
  })

  it("multiple findings → all captured", () => {
    const rawText = `
CRITICAL: Null pointer dereference at startup
HIGH: src/tools/writeLedger.ts:10 unhandled promise rejection
MEDIUM: Missing input validation in handler
LOW: Variable name could be more descriptive
`
    const { data } = normalizeReview("reviewer-b", rawText)

    expect(data.findings).toHaveLength(4)
    expect(data.findings[0].severity).toBe("critical")
    expect(data.findings[1].severity).toBe("high")
    expect(data.findings[2].severity).toBe("medium")
    expect(data.findings[3].severity).toBe("low")
  })

  it("TOON output contains reviewer name", () => {
    const { text } = normalizeReview("my-reviewer", "CRITICAL: some issue")

    expect(text).toContain("reviewer: my-reviewer")
  })

  it("TOON output contains finding count", () => {
    const rawText = `
HIGH: issue one
LOW: issue two
`
    const { text } = normalizeReview("reviewer-x", rawText)

    expect(text).toContain("findings: 2")
  })

  it("TOON output contains table with severity/file/line/description when findings exist", () => {
    const rawText = "CRITICAL: src/foo.ts:99 some critical issue"
    const { text } = normalizeReview("reviewer-a", rawText)

    expect(text).toContain("severity | file | line | description")
    expect(text).toContain("critical")
  })

  it("raw_length reflects input length", () => {
    const rawText = "HIGH: some issue"
    const { data } = normalizeReview("r", rawText)

    expect(data.raw_length).toBe(rawText.length)
  })

  it("reviewer is set on normalized review data", () => {
    const { data } = normalizeReview("codex-reviewer", "LOW: minor style issue")

    expect(data.reviewer).toBe("codex-reviewer")
  })

  it("severity on its own line followed by file:line description on next line → single finding with file+description captured", () => {
    const rawText = `HIGH:
src/lib/ledger.ts:55 connection not closed after error`
    const { data } = normalizeReview("reviewer-a", rawText)

    expect(data.findings).toHaveLength(1)
    expect(data.findings[0].severity).toBe("high")
    expect(data.findings[0].file).toBe("src/lib/ledger.ts")
    expect(data.findings[0].line).toBe("55")
    expect(data.findings[0].description).toContain("connection not closed after error")
  })

  it("prose containing 'high' or 'low' in continuation lines doesn't create spurious findings", () => {
    const rawText = `CRITICAL: Important security issue
This has a high impact on the system and a low chance of being a false alarm.`
    const { data } = normalizeReview("reviewer-a", rawText)

    expect(data.findings).toHaveLength(1)
    expect(data.findings[0].severity).toBe("critical")
    expect(data.findings[0].description).toContain("high impact")
  })
})
