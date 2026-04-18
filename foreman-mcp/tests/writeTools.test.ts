import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleWriteProgress, FENCE_START, FENCE_END } from "../src/tools/writeProgress.js"
import { normalizeReview } from "../src/tools/normalizeReview.js"
import { readLedger } from "../src/lib/ledger.js"
import { readProgress } from "../src/lib/progress.js"
import { NormalizeReviewInputSchema, WriteLedgerInputSchema, PhaseScopeSchema } from "../src/types.js"
import { detectTestFiles } from "../src/lib/detectTestFiles.js"

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

    try {
      await handleWriteLedger(ledgerPath, {
        operation: "set_phase_scope",
        phase: "v75-p1",
        data: { has_tests: false, has_api: false, has_build: true },
      })
    } finally {
      console.error = origError
    }

    expect(warnings.some(w => w.includes("has_tests: false declared but") && w.includes("1 test files detected"))).toBe(true)

    // Scope is still stored despite the warning
    const ledger = await readLedger(ledgerPath)
    expect(ledger.phases["v75-p1"].scope?.has_tests).toBe(false)
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
