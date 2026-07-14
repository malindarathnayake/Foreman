import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { handleWriteProgress, FENCE_START, FENCE_END } from "../src/tools/writeProgress.js"
import { normalizeReview } from "../src/tools/normalizeReview.js"
import { readLedger } from "../src/lib/ledger.js"
import { readProgress } from "../src/lib/progress.js"
import { appendEvent, type SidecarEventInput } from "../src/lib/eventsSidecar.js"
import { NormalizeReviewInputSchema, WriteLedgerInputSchema, PhaseScopeSchema, WriteJournalInputSchema, JournalEventCode } from "../src/types.js"
import { detectTestFiles } from "../src/lib/detectTestFiles.js"
import { atomicWriteFile } from "../src/lib/atomicWrite.js"
import { maybeCompress, drainCcrStats } from "../src/lib/compression.js"

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

describe("handleWriteLedger — v0.3.1 tier telemetry + record_review (Zod path)", () => {
  it("accepts and persists tier + route_reason on delegation", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "Worker brief for u1 — implement per spec", tier: "premium", route_reason: "high-risk unit" },
    })
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.tier).toBe("premium")
    expect(unit.route_reason).toBe("high-risk unit")
    expect(unit.delegations).toHaveLength(1)
  })

  it("rejects an invalid tier value at the Zod boundary", async () => {
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief: "Worker brief for u1 — implement per spec", tier: "turbo" },
      })
    ).rejects.toThrow()
  })

  it("record_review round-trips findings through the Zod schema and handler", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: {
        advisor: "codex",
        findings: [{ severity: "high", file: "ledger.ts", line: "115", description: "overwrite", classification: "confirmed" }],
      },
    })
    expect(result).toContain("status: ok")
    expect(result).toContain("operation: record_review")
    const reviews = (await readLedger(ledgerPath)).phases.p1.reviews!
    expect(reviews).toHaveLength(1)
    expect(reviews[0].findings[0].classification).toBe("confirmed")
  })

  it("WriteLedgerInputSchema parses a record_review operation", () => {
    const parsed = WriteLedgerInputSchema.parse({
      operation: "record_review",
      phase: "p1",
      data: { advisor: "gemini", findings: [] },
    })
    expect(parsed.operation).toBe("record_review")
  })
})

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
    // Gate pass requires all units passing — seed one passed unit first
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    const result = await handleWriteLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("unit_id: n/a")
  })

  it("write on corrupt ledger surfaces a warning naming the backup file", async () => {
    await fs.writeFile(ledgerPath, "{ this is not valid json !!!", "utf-8")

    const result = await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    expect(result).toContain("status: ok")
    expect(result).toContain("warning:")
    expect(result).toContain(".corrupt.")

    // Backup sibling exists
    const siblings = await fs.readdir(path.dirname(ledgerPath))
    expect(siblings.filter((f) => f.includes(".corrupt.")).length).toBe(1)
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

  it("with docsDir + existing PROGRESS.md + ledger → splices checklist into fenced block", async () => {
    // Seed ledger with one passing unit
    const ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
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

    // Seed PROGRESS.md with empty fenced block
    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    await fs.writeFile(
      markdownPath,
      `preamble\n${FENCE_START}\nOLD\n${FENCE_END}\npostamble\n`,
    )

    await handleWriteProgress(
      progressPath,
      {
        operation: "update_status",
        data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "n" },
      },
      tmpDir,
      ledgerPath,
    )

    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("preamble")
    expect(content).toContain("postamble")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("- [x] u1")
    expect(content).not.toContain("OLD")
  })

  it("with docsDir + fenceless PROGRESS.md → appends fenced checklist block", async () => {
    const ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
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

    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    await fs.writeFile(markdownPath, "# Notes\nHand-written content.\n")

    await handleWriteProgress(
      progressPath,
      {
        operation: "complete_unit",
        data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-02T10:00:00Z", notes: "done" },
      },
      tmpDir,
      ledgerPath,
    )

    const content = await fs.readFile(markdownPath, "utf-8")
    expect(content).toContain("# Notes")
    expect(content).toContain("Hand-written content.")
    expect(content).toContain(FENCE_START)
    expect(content).toContain(FENCE_END)
    expect(content).toContain("- [x] u1")
  })

  it("with docsDir but missing PROGRESS.md → does NOT create it", async () => {
    const ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1, ts: "2026-04-17T00:00:00Z", phases: {},
    }))

    const markdownPath = path.join(tmpDir, "PROGRESS.md")
    // ensure it doesn't pre-exist
    await fs.rm(markdownPath, { force: true })

    await handleWriteProgress(
      progressPath,
      {
        operation: "update_status",
        data: { unit_id: "u1", phase: "p1", status: "pending", notes: "n" },
      },
      tmpDir,
      ledgerPath,
    )

    const exists = await fs.access(markdownPath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
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

describe("NormalizeReviewInputSchema caps", () => {
  it("rejects reviewer exceeding 200 chars", () => {
    expect(() =>
      NormalizeReviewInputSchema.parse({ reviewer: "x".repeat(201), raw_text: "ok" })
    ).toThrow()
  })

  it("rejects raw_text exceeding 50000 chars", () => {
    expect(() =>
      NormalizeReviewInputSchema.parse({ reviewer: "ok", raw_text: "x".repeat(50001) })
    ).toThrow()
  })
})

// ─── v0.0.7.5: VerdictInput + PhaseScope schema extensions ───────────────
describe("WriteLedgerInputSchema — verdict with via/note", () => {
  it("accepts set_verdict without via/note (backward compat)", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    expect(result.success).toBe(true)
  })

  it("accepts set_verdict with via and note present", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "worker", note: "delegated and validated" },
    })
    expect(result.success).toBe(true)
  })

  it("accepts all three via enum values", () => {
    for (const via of ["worker", "pitboss-direct", "n/a"] as const) {
      const result = WriteLedgerInputSchema.safeParse({
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u1",
        data: { v: "pass", via },
      })
      expect(result.success).toBe(true)
    }
  })

  it("rejects invalid via enum value", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "auto" },
    })
    expect(result.success).toBe(false)
  })

  it("accepts note up to 10000 chars", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note: "x".repeat(10000) },
    })
    expect(result.success).toBe(true)
  })

  it("rejects note > 10000 chars", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note: "x".repeat(10001) },
    })
    expect(result.success).toBe(false)
  })
})

describe("PhaseScopeSchema", () => {
  it("accepts valid scope with all three booleans", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: true,
      has_api: false,
      has_build: true,
    })
    expect(result.success).toBe(true)
  })

  it("rejects scope with non-boolean value", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: "yes",
      has_api: false,
      has_build: true,
    })
    expect(result.success).toBe(false)
  })

  it("rejects scope missing a field", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: true,
      has_api: false,
    })
    expect(result.success).toBe(false)
  })
})

// ─── v0.0.7.5: set_verdict via/note — handler end-to-end ─────────────────
describe("handleWriteLedger — set_verdict via/note end-to-end", () => {
  // delegation helper — every v:"pass" test needs it
  async function delegate(unit: string) {
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: unit,
      data: { s: "delegated", brief: "worker brief long enough to clear the 20 char minimum" },
    })
  }

  it("persists via on the unit when set_verdict includes via: 'worker'", async () => {
    await delegate("u1")
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "worker" },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u1.via).toBe("worker")
  })

  it("persists note on the unit when set_verdict includes note", async () => {
    await delegate("u2")
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u2",
      data: { v: "pass", via: "pitboss-direct", note: "downloaded JAR manually" },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u2.via).toBe("pitboss-direct")
    expect(ledger.phases.p1.units.u2.note).toBe("downloaded JAR manually")
  })

  it("stores via: undefined when set_verdict omits via (backward compat)", async () => {
    await delegate("u3")
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u3",
      data: { v: "pass" },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u3.via).toBeUndefined()
    expect(ledger.phases.p1.units.u3.note).toBeUndefined()
  })

  it("rejects invalid via enum value via schema", async () => {
    await delegate("u4")
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u4",
        data: { v: "pass", via: "auto" }, // not a valid enum value
      })
    ).rejects.toThrow()
  })

  it("accepts note at exactly 10000 chars", async () => {
    await delegate("u5")
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u5",
      data: { v: "pass", note: "x".repeat(10000) },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.units.u5.note).toHaveLength(10000)
  })

  it("rejects note > 10000 chars via schema (no truncation)", async () => {
    await delegate("u6")
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: "u6",
        data: { v: "pass", note: "x".repeat(10001) },
      })
    ).rejects.toThrow()
  })

  it("accepts all three via enum values through the handler", async () => {
    for (const via of ["worker", "pitboss-direct", "n/a"] as const) {
      const unit = `u-${via}`
      await delegate(unit)
      await handleWriteLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "p1",
        unit_id: unit,
        data: { v: "pass", via },
      })
      const ledger = await readLedger(ledgerPath)
      expect(ledger.phases.p1.units[unit].via).toBe(via)
    }
  })
})

// ─── detectTestFiles ──────────────────────────────────────────────────────────

describe("detectTestFiles", () => {
  it("returns empty array for empty directory", async () => {
    const result = await detectTestFiles(tmpDir)
    expect(result).toEqual([])
  })

  it("detects .test.ts files at project root", async () => {
    await fs.writeFile(path.join(tmpDir, "foo.test.ts"), "")
    await fs.writeFile(path.join(tmpDir, "bar.ts"), "")
    const result = await detectTestFiles(tmpDir)
    expect(result).toContain("foo.test.ts")
    expect(result).not.toContain("bar.ts")
  })

  it("detects all 7 test-file patterns", async () => {
    const patterns = [
      "a.test.ts",
      "b.test.js",
      "c.spec.ts",
      "test_d.py",
      "e_test.go",
      "FTest.java",
      "GSpec.scala",
    ]
    for (const p of patterns) {
      await fs.writeFile(path.join(tmpDir, p), "")
    }
    const result = await detectTestFiles(tmpDir)
    for (const p of patterns) {
      expect(result).toContain(p)
    }
  })

  it("finds files buried in nested subdirectories", async () => {
    const nested = path.join(tmpDir, "src", "deep", "inside")
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, "buried.test.ts"), "")
    const result = await detectTestFiles(tmpDir)
    expect(result).toContain(path.join("src", "deep", "inside", "buried.test.ts"))
  })

  it("skips node_modules even if test files exist inside", async () => {
    const nm = path.join(tmpDir, "node_modules", "some-pkg")
    await fs.mkdir(nm, { recursive: true })
    await fs.writeFile(path.join(nm, "buried.test.ts"), "")
    const result = await detectTestFiles(tmpDir)
    expect(result).toEqual([])
  })

  it("skips all 5 excluded directories", async () => {
    for (const dir of ["node_modules", "dist", "build", "target", ".git"]) {
      const d = path.join(tmpDir, dir)
      await fs.mkdir(d, { recursive: true })
      await fs.writeFile(path.join(d, "trap.test.ts"), "")
    }
    const result = await detectTestFiles(tmpDir)
    expect(result).toEqual([])
  })

  it("enforces the MAX_FILES cap at 500 and logs a warning", async () => {
    // Create 501 test files
    for (let i = 0; i < 501; i++) {
      await fs.writeFile(path.join(tmpDir, `t${i}.test.ts`), "")
    }
    const errors: string[] = []
    const origError = console.error
    console.error = (msg: string) => { errors.push(String(msg)) }
    try {
      const result = await detectTestFiles(tmpDir)
      expect(result).toHaveLength(500)
      expect(errors.some(e => e.includes("capped at 500"))).toBe(true)
    } finally {
      console.error = origError
    }
  })

  it("does not recurse beyond depth 10", async () => {
    // Build 11 levels of nesting
    let current = tmpDir
    for (let i = 0; i < 11; i++) {
      current = path.join(current, `level${i}`)
      await fs.mkdir(current)
    }
    await fs.writeFile(path.join(current, "too-deep.test.ts"), "")
    const result = await detectTestFiles(tmpDir)
    expect(result).not.toContain(path.join(
      "level0","level1","level2","level3","level4",
      "level5","level6","level7","level8","level9","level10","too-deep.test.ts"
    ))
  })
})

// ─── handleWriteLedger — set_phase_scope operation ───────────────────────────

describe("handleWriteLedger — set_phase_scope operation", () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it("stores scope on the phase (happy path)", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "v75-p1",
      data: { has_tests: true, has_api: false, has_build: true },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["v75-p1"].scope).toEqual({
      has_tests: true,
      has_api: false,
      has_build: true,
    })
  })

  it("creates the phase entry if it doesn't exist yet", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "brand-new",
      data: { has_tests: false, has_api: true, has_build: false },
    })
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["brand-new"]).toBeDefined()
    expect(ledger.phases["brand-new"].scope).toEqual({
      has_tests: false,
      has_api: true,
      has_build: false,
    })
  })

  it("throws scope_already_set when scope declared twice on same phase", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "v75-p1",
      data: { has_tests: true, has_api: false, has_build: true },
    })
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: false, has_api: false, has_build: true },
      })
    ).rejects.toThrow(/scope_already_set/)
  })

  it("rejects invalid scope (non-boolean) via schema", async () => {
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: "yes" as any, has_api: false, has_build: true },
      })
    ).rejects.toThrow()
  })

  it("logs warning to stderr when has_tests:false but test files detected", async () => {
    // Plant a test file in the fixture cwd
    await fs.writeFile(path.join(tmpDir, "mock.test.ts"), "")

    const warnings: string[] = []
    const origError = console.error
    console.error = (msg: string) => { warnings.push(String(msg)) }

    let result: string
    try {
      result = await handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: false, has_api: false, has_build: true },
      })
    } finally {
      console.error = origError
    }

    expect(warnings.some(w => w.includes("has_tests: false declared but") && w.includes("1 test files detected"))).toBe(true)

    // Warning is also surfaced in the tool result text — not stderr-only
    expect(result).toContain("warning:")
    expect(result).toContain("1 test files detected")

    // Scope is still stored despite the warning
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["v75-p1"].scope?.has_tests).toBe(false)
  })

  it("does NOT include warning key in result when has_tests:false and no test files", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "set_phase_scope",
      phase: "v75-p1",
      data: { has_tests: false, has_api: false, has_build: true },
    })
    expect(result).not.toContain("warning:")
  })

  it("does NOT log warning when has_tests:false and no test files present", async () => {
    const warnings: string[] = []
    const origError = console.error
    console.error = (msg: string) => { warnings.push(String(msg)) }

    try {
      await handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: false, has_api: false, has_build: true },
      })
    } finally {
      console.error = origError
    }

    expect(warnings.filter(w => w.includes("has_tests: false declared")).length).toBe(0)
  })

  it("does NOT log warning when has_tests:true (detection skipped)", async () => {
    // Even with test files present, no warning because has_tests:true
    await fs.writeFile(path.join(tmpDir, "present.test.ts"), "")

    const warnings: string[] = []
    const origError = console.error
    console.error = (msg: string) => { warnings.push(String(msg)) }

    try {
      await handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: true, has_api: false, has_build: true },
      })
    } finally {
      console.error = origError
    }

    expect(warnings.filter(w => w.includes("has_tests: false declared")).length).toBe(0)
  })
})

// ─── 3a: v0.5.0 schema extensions ───

describe("PhaseScopeSchema — v0.5.0 hot_path/security_boundary flags", () => {
  it("accepts scope with hot_path and security_boundary present", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: true,
      has_api: false,
      has_build: true,
      hot_path: true,
      security_boundary: true,
    })
    expect(result.success).toBe(true)
  })

  it("still accepts a scope WITHOUT the two flags (backward compat)", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: true,
      has_api: false,
      has_build: true,
    })
    expect(result.success).toBe(true)
  })

  it("rejects non-boolean hot_path", () => {
    const result = PhaseScopeSchema.safeParse({
      has_tests: true,
      has_api: false,
      has_build: true,
      hot_path: "yes",
    })
    expect(result.success).toBe(false)
  })
})

describe("WriteLedgerInputSchema — update_phase_gate agent_class/user_override (anti-strip)", () => {
  it("retains agent_class and user_override after parse", () => {
    const parsed = WriteLedgerInputSchema.parse({
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", agent_class: "frontier", user_override: true },
    })
    expect(parsed.operation).toBe("update_phase_gate")
    if (parsed.operation === "update_phase_gate") {
      expect(parsed.data.agent_class).toBe("frontier")
      expect(parsed.data.user_override).toBe(true)
    }
  })

  it("rejects an invalid agent_class value", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", agent_class: "mega" },
    })
    expect(result.success).toBe(false)
  })
})

describe("WriteLedgerInputSchema — set_verdict inconclusive", () => {
  it("accepts v: 'inconclusive'", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "inconclusive" },
    })
    expect(result.success).toBe(true)
  })

  it("rejects v: 'maybe'", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "maybe" },
    })
    expect(result.success).toBe(false)
  })
})

describe("WriteLedgerInputSchema — set_unit_status user_override (anti-strip)", () => {
  it("retains data.user_override === true after parse", () => {
    const parsed = WriteLedgerInputSchema.parse({
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: {
        s: "delegated",
        brief: "worker brief long enough to clear the 20 char minimum",
        user_override: true,
      },
    })
    expect(parsed.operation).toBe("set_unit_status")
    if (parsed.operation === "set_unit_status") {
      expect(parsed.data.user_override).toBe(true)
    }
  })
})

describe("JournalEventCode — v0.5.0 codes", () => {
  it("accepts SEC_BLOCK", () => {
    expect(JournalEventCode.safeParse("SEC_BLOCK").success).toBe(true)
  })

  it("accepts EGRESS_NOTICE", () => {
    expect(JournalEventCode.safeParse("EGRESS_NOTICE").success).toBe(true)
  })

  it("rejects an unknown code", () => {
    expect(JournalEventCode.safeParse("NOT_A_CODE").success).toBe(false)
  })
})

describe("WriteJournalInputSchema — init_session agent_class/worker_class (R8)", () => {
  it("accepts env with agent_class and worker_class", () => {
    const result = WriteJournalInputSchema.safeParse({
      operation: "init_session",
      data: {
        target_version: "0.5.0",
        branch: "release/v0.5.0",
        phase: 1,
        units: ["u1", "u2"],
        env: {
          agent: "claude",
          worker: "claude",
          claude: "2.1.206",
          codex: null,
          gemini: null,
          agent_class: "frontier",
          worker_class: "capable",
        },
      },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.data.env.claude).toBe("2.1.206")
  })

  it("rejects an invalid agent_class value", () => {
    const result = WriteJournalInputSchema.safeParse({
      operation: "init_session",
      data: {
        target_version: "0.5.0",
        branch: "release/v0.5.0",
        phase: 1,
        units: ["u1", "u2"],
        env: {
          agent: "claude",
          worker: "claude",
          codex: null,
          gemini: null,
          agent_class: "gigantic",
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("still accepts env WITHOUT the class fields (backward compat)", () => {
    const result = WriteJournalInputSchema.safeParse({
      operation: "init_session",
      data: {
        target_version: "0.5.0",
        branch: "release/v0.5.0",
        phase: 1,
        units: ["u1", "u2"],
        env: {
          agent: "claude",
          worker: "claude",
          codex: null,
          gemini: null,
        },
      },
    })
    expect(result.success).toBe(true)
  })
})

// ─── handleWriteLedger — set_verdict inconclusive (D2d) end-to-end ───────────

describe("handleWriteLedger — set_verdict inconclusive end-to-end", () => {
  it("persists inconclusive and shows up in the read_ledger verdicts table", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "inconclusive" },
    })

    const table = await handleReadLedger(ledgerPath, { query: "verdicts" })
    expect(table).toContain("inconclusive")
  })
})

// ─── 3e: atomicWriteFile helper (D2c) ───

describe("atomicWriteFile", () => {
  it("two concurrent writes to one path → final file is valid JSON matching one of the payloads", async () => {
    const p = path.join(tmpDir, "concurrent.json")
    const payloadA = JSON.stringify({ a: 1 })
    const payloadB = JSON.stringify({ b: 2 })

    await Promise.all([atomicWriteFile(p, payloadA), atomicWriteFile(p, payloadB)])

    const content = await fs.readFile(p, "utf-8")
    const parsed = JSON.parse(content)
    expect([JSON.parse(payloadA), JSON.parse(payloadB)]).toContainEqual(parsed)
  })

  it("no tmp siblings left behind after several writes to the same path", async () => {
    const p = path.join(tmpDir, "repeated.json")

    for (let i = 0; i < 5; i++) {
      await atomicWriteFile(p, JSON.stringify({ i }))
    }

    const siblings = await fs.readdir(tmpDir)
    expect(siblings).toContain("repeated.json")
    expect(siblings.filter((f) => f.includes(".tmp"))).toHaveLength(0)
  })

  it("scrub seam redacts content before write", async () => {
    const p = path.join(tmpDir, "scrubbed.txt")

    await atomicWriteFile(p, "hello SECRETVAL world", {
      scrub: (s) => s.replaceAll("SECRETVAL", "[REDACTED]"),
    })

    const content = await fs.readFile(p, "utf-8")
    expect(content).toContain("[REDACTED]")
    expect(content).not.toContain("SECRETVAL")
  })

  it("rename failure cleans up the tmp file and rethrows", async () => {
    const p = path.join(tmpDir, "target-is-dir")
    await fs.mkdir(p)

    await expect(atomicWriteFile(p, "x")).rejects.toThrow()

    const siblings = await fs.readdir(tmpDir)
    expect(siblings.filter((f) => f.includes(".tmp"))).toHaveLength(0)
  })

  it("write failure (ENOENT on tmp path) leaves no tmp orphan", async () => {
    await expect(
      atomicWriteFile(path.join(tmpDir, "nonexistent-subdir", "f.json"), "x")
    ).rejects.toThrow()

    const siblings = await fs.readdir(tmpDir)
    expect(siblings.filter((f) => f.includes(".tmp"))).toHaveLength(0)
  })

  it("end-to-end regression guard: handleWriteLedger produces a parseable ledger with no tmp sibling", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    const content = await fs.readFile(ledgerPath, "utf-8")
    expect(() => JSON.parse(content)).not.toThrow()

    const siblings = await fs.readdir(path.dirname(ledgerPath))
    expect(siblings.filter((f) => f.includes(".tmp"))).toHaveLength(0)
  })
})

// ─── ccr_stats fold (Unit 5b) ─────────────────────────────────────────────────

describe("ccr_stats fold (5b)", () => {
  let savedCompression: string | undefined

  // Deterministic large fixture that reliably compresses via the log strategy —
  // mirrors compression.test.ts's SYNTHETIC_LOG shape (mixed FAILED/ERROR/INFO/DEBUG/WARN
  // lines) so maybeCompress("run_tests", ...) actually produces a smaller <<ccr:...>> digest.
  function bigFixture(): string {
    const lines: string[] = []
    lines.push("============================= test session starts ==============================")
    lines.push("platform linux -- Python 3.11.4, pytest-7.4.0, pluggy-1.2.0")
    lines.push("rootdir: /workspace/project")
    lines.push("collected 4950 items")
    lines.push("")
    lines.push("Traceback (most recent call last):")
    lines.push("  File \"/workspace/project/tests/conftest.py\", line 42, in setup_module")
    lines.push("    db.connect(timeout=5)")
    lines.push("ConnectionError: database unavailable")

    const failedIndices = new Set([100, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500])
    const errorIndices = new Set([200, 600, 1200])

    for (let i = 0; i < 5010; i++) {
      if (failedIndices.has(i)) {
        lines.push(`FAILED tests/test_foo.py::test_bar_${i} - AssertionError: expected True but got False`)
      } else if (errorIndices.has(i)) {
        lines.push(`ERROR tests/test_foo.py::test_setup_${i} - RuntimeError: fixture teardown failed at step ${i}`)
      } else if (i % 7 === 0) {
        lines.push(`INFO  [${i}] Running scenario ${i}: validating input schema for endpoint /api/v${i % 10}/resource`)
      } else if (i % 11 === 0) {
        lines.push(`DEBUG [${i}] Cache miss for key="item:${i}" — fetching from upstream service`)
      } else if (i % 13 === 0) {
        lines.push(`WARN  [${i}] Retry attempt ${(i % 3) + 1} for request id=${i * 7} after timeout`)
      } else {
        lines.push(`INFO  [${i}] test_module_${i % 50}.test_case_${i} PASSED in ${(i % 100) + 1}ms`)
      }
    }

    lines.push("")
    lines.push("=== 10 failed, 4940 passed in 12.34s ===")

    return lines.join("\n")
  }

  beforeEach(() => {
    savedCompression = process.env.FOREMAN_COMPRESSION
    drainCcrStats() // flush anything left pending by another test file/suite
  })

  afterEach(() => {
    if (savedCompression === undefined) {
      delete process.env.FOREMAN_COMPRESSION
    } else {
      process.env.FOREMAN_COMPRESSION = savedCompression
    }
    drainCcrStats()
  })

  // Real compression of bigFixture (context-crush, not mocked) takes a few seconds —
  // give these tests headroom over vitest's 5s default (mirrors compression.test.ts:18).
  it("fold on write: handleWriteLedger persists the seeded accumulator into ledger.ccr_stats", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    const input = bigFixture()
    const out = maybeCompress("run_tests", input)
    expect(out).not.toBe(input) // confirm it actually compressed

    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    const ledger = await readLedger(ledgerPath)
    expect(ledger.ccr_stats?.run_tests).toBeDefined()
    expect(ledger.ccr_stats!.run_tests.calls).toBe(1)
    expect(ledger.ccr_stats!.run_tests.tokens_before).toBeGreaterThan(ledger.ccr_stats!.run_tests.tokens_after)
    expect(ledger.ccr_stats!.run_tests.tokens_after).toBeGreaterThan(0)
  }, 30000)

  it("read_ledger full surfaces ccr_stats", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    const input = bigFixture()
    const out = maybeCompress("run_tests", input)
    expect(out).not.toBe(input)

    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    const full = await handleReadLedger(ledgerPath, { query: "full" })
    expect(full).toContain("ccr_stats")
    expect(full).toContain("run_tests")
  }, 30000)

  it("no-pending write leaves ccr_stats untouched (no zero-entry creation, no growth)", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    const input = bigFixture()
    const out = maybeCompress("run_tests", input)
    expect(out).not.toBe(input)

    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })
    const afterFirst = (await readLedger(ledgerPath)).ccr_stats

    // Nothing pending this time — foldCcrStats should no-op.
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "ip" },
    })
    const afterSecond = (await readLedger(ledgerPath)).ccr_stats

    expect(afterSecond).toEqual(afterFirst)
  }, 30000)

  it("accumulates across writes: calls:2 and sums increase", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    const input = bigFixture()

    const out1 = maybeCompress("run_tests", input)
    expect(out1).not.toBe(input)
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })
    const afterFirst = (await readLedger(ledgerPath)).ccr_stats!.run_tests

    const out2 = maybeCompress("run_tests", input)
    expect(out2).not.toBe(input)
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "ip" },
    })
    const afterSecond = (await readLedger(ledgerPath)).ccr_stats!.run_tests

    expect(afterFirst.calls).toBe(1)
    expect(afterSecond.calls).toBe(2)
    expect(afterSecond.tokens_before).toBeGreaterThan(afterFirst.tokens_before)
    expect(afterSecond.tokens_after).toBeGreaterThan(afterFirst.tokens_after)
  }, 30000)

  it("ccr_savings footer appears on delegation_metrics only when ccr_stats evidence exists", async () => {
    process.env.FOREMAN_COMPRESSION = "1"
    const input = bigFixture()
    const out = maybeCompress("run_tests", input)
    expect(out).not.toBe(input)

    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "ip" },
    })

    const metrics = await handleReadLedger(ledgerPath, { query: "delegation_metrics" })
    expect(metrics).toContain("sidecar: absent")
    const lastLine = metrics.trimEnd().split("\n").pop() as string
    expect(lastLine).toMatch(/^ccr_savings: \d+ tokens \(\d+->\d+, \d+ calls\)$/)

    // Fresh ledger path, never written to — no ccr_stats, no footer.
    const freshLedgerPath = path.join(tmpDir, "fresh-ledger.json")
    const freshMetrics = await handleReadLedger(freshLedgerPath, { query: "delegation_metrics" })
    expect(freshMetrics).not.toContain("ccr_savings")
  }, 30000)
})

// ─── P5 5a: discipline-adherence gate — default-on through handleWriteLedger ──

describe("handleWriteLedger — P5 discipline-adherence gate (default-on)", () => {
  const brief = "worker brief long enough to clear the 20 char minimum"

  function fixtureEvent(overrides: Record<string, unknown> = {}): SidecarEventInput {
    return {
      v: 1,
      ts: new Date().toISOString(),
      event_id: "evt_5a100001",
      event_type: "delegation_started",
      phase: "p1",
      unit_id: "u1",
      attempt: 1,
      delegation_id: "del_5a100001",
      provider: "anthropic",
      model: "claude-sonnet",
      tier: "standard",
      capability_class: "capable",
      edit_format: "unified_diff",
      repair_attempt: 0,
      brief_hash: "hash_5a100001",
      prompt_prefix_hash: "hash_5a100002",
      base_file_hashes: { "src/foo.ts": "hash_5a100003" },
      ...overrides,
    } as SidecarEventInput
  }

  it("default-on: contradiction rejects through handleWriteLedger; data.user_override survives zod and lets it through, recording the override", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief },
    })
    await handleWriteLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    // Seed a contradicting sidecar delegation AFTER the ledger writes above, so the
    // tool's own post-write sidecar hook (which only closes an OPEN delegation) has
    // nothing to touch — this file is purely the discipline-gate's read input.
    const sidecarPath = path.join(path.dirname(ledgerPath), ".foreman-events.jsonl")
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

    // No override: gate is default-on through the tool path — REJECTS.
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "update_phase_gate",
        phase: "p1",
        data: { g: "pass" },
      })
    ).rejects.toThrow(/DISCIPLINE ADHERENCE:.*contradicts sidecar terminal outcome 'fail'/)

    let ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).not.toBe("pass")

    // Same call with data.user_override: true — zod must not strip it — SUCCEEDS.
    const result = await handleWriteLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass", user_override: true },
    })
    expect(result).toContain("status: ok")

    ledger = await readLedger(ledgerPath)
    expect(ledger.phases.p1.g).toBe("pass")
    expect(ledger.phases.p1.discipline_overrides).toEqual([
      { discipline_override: true, unit_id: "u1", delegation_id: "del1" },
    ])
  })
})
