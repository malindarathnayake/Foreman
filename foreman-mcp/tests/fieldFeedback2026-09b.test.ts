// Field feedback 2026-09, round 2 (v0.6.1): schema-error hints, required preflight
// attestation, SPEC_GAP / GATE_OVERRIDE journal codes, advisor stderr trimming,
// run_tests output shaping.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleWriteProgress } from "../src/tools/writeProgress.js"
import { formatSchemaError } from "../src/lib/schemaError.js"
import { formatAdvisorResult } from "../src/tools/invokeAdvisor.js"
import { applyOutputFilters, compileStripPatterns, runTests } from "../src/tools/runTests.js"
import {
  WriteLedgerInputSchema,
  WriteJournalInputSchema,
  LedgerOperationDataSchemas,
} from "../src/types.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-2026-09b-"))
  ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
  progressPath = path.join(tmpDir, ".foreman-progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"
const PREFLIGHT = { symbols_grepped: 3, self_consistent: true as const, telemetry: "n/a" as const }

// ─── item 1: schema errors are one line per field + expected shape ──────────

describe("schema errors — one hint per field, expected shape appended", () => {
  it("formatSchemaError names the operation, each field path, and the operation's data shape", () => {
    const result = WriteLedgerInputSchema.safeParse({
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "PASS", via: "direct", note: 42 },
    })
    expect(result.success).toBe(false)
    const text = formatSchemaError("write_ledger", result.error!, { operation: "set_verdict" }, LedgerOperationDataSchemas)
    expect(text).toMatch(/^SCHEMA ERROR — write_ledger set_verdict rejected \(3 issues\):/)
    expect(text).toContain("  data.v: ")
    expect(text).toContain("  data.via: ")
    expect(text).toContain("  data.note: ")
    expect(text).toContain("Expected data shape: { v: 'pass'|'fail'|'pending'|'inconclusive', via?: 'worker'|'pitboss-direct'|'n/a', note?: string (≤10000 chars) }")
  })

  it("handleWriteLedger surfaces the formatted error instead of a Zod dump", async () => {
    await expect(
      handleWriteLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", via: "direct" } })
    ).rejects.toThrow(/SCHEMA ERROR — write_ledger set_verdict rejected \(1 issue\):\n  data\.via: .*worker.*pitboss-direct.*n\/a[\s\S]*Expected data shape:/)
  })

  it("record_review: lowercase severity and string line are spelled out", async () => {
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "record_review",
        phase: "p1",
        data: { advisor: "codex", findings: [{ severity: "HIGH", file: "a.ts", line: 42, description: "x" }] },
      })
    ).rejects.toThrow(/data\.findings\.0\.severity: [\s\S]*data\.findings\.0\.line: [\s\S]*line: string \(≤20 chars\)/)
  })

  it("unknown operation lists the valid operations instead of a shape", async () => {
    await expect(
      handleWriteLedger(ledgerPath, { operation: "set_status", phase: "p1", data: {} })
    ).rejects.toThrow(/SCHEMA ERROR — write_ledger set_status rejected[\s\S]*Operations: set_unit_status, set_verdict/)
  })

  it("write_progress gets the same treatment", async () => {
    await expect(
      handleWriteProgress(progressPath, { operation: "complete_unit", data: { unit_id: "u1" } })
    ).rejects.toThrow(/SCHEMA ERROR — write_progress complete_unit rejected[\s\S]*data\.phase: [\s\S]*Expected data shape: \{ unit_id: string/)
  })

  it("write_journal over MCP: bad log_event returns an isError result with per-field hints", async () => {
    const server: McpServer = await createServer({ docsDir: tmpDir, ledgerPath, progressPath })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: "write_journal",
        arguments: { operation: "log_event", data: { t: "INFO", u: "u1", msg: "x".repeat(201) } },
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toContain("SCHEMA ERROR — write_journal log_event rejected (3 issues):")
      expect(text).toContain("  data.t: ")
      expect(text).toContain("  data.tok: ")
      expect(text).toContain("  data.msg: ")
      expect(text).toContain("msg: string (≤200 chars)")
      expect(text).not.toContain('"code":')
    } finally {
      await client.close()
      await server.close()
    }
  })
})

// ─── item 2: preflight attestation is required on the delegated write ───────

describe("set_unit_status s:'delegated' — preflight required", () => {
  it("refuses delegation without data.preflight and names the shape", async () => {
    await expect(
      writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: BRIEF } })
    ).rejects.toThrow(/PREFLIGHT REQUIRED: set_unit_status with s:'delegated' requires data\.preflight.*symbols_grepped.*self_consistent: true/)
    // A refused write never lands: the ledger file is not even created.
    expect((await readLedger(ledgerPath)).phases.p1?.units?.u1?.w ?? null).toBeNull()
  })

  it("brief check still fires first (existing DELEGATION REQUIRED message unchanged)", async () => {
    await expect(
      writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", preflight: PREFLIGHT } })
    ).rejects.toThrow(/^DELEGATION REQUIRED/)
  })

  it("stores the attestation on the delegation entry; non-delegating statuses need nothing", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip" } })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", brief: BRIEF, tier: "standard", preflight: PREFLIGHT },
    })
    const unit = (await readLedger(ledgerPath)).phases.p1.units.u1
    expect(unit.delegations?.[0].preflight).toEqual(PREFLIGHT)
    expect(unit.w).toBe(BRIEF)
  })

  it("schema rejects self_consistent:false and symbols_grepped:0 with field hints", async () => {
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_unit_status",
        phase: "p1",
        unit_id: "u1",
        data: { s: "delegated", brief: BRIEF, preflight: { symbols_grepped: 0, self_consistent: false } },
      })
    ).rejects.toThrow(/data\.preflight\.symbols_grepped: [\s\S]*data\.preflight\.self_consistent: /)
  })
})

// ─── items 3 + 4: journal codes ─────────────────────────────────────────────

describe("journal codes SPEC_GAP / GATE_OVERRIDE", () => {
  it("both validate as log_event codes; GATE_OVERRIDE carries the gate field", () => {
    expect(WriteJournalInputSchema.safeParse({ operation: "log_event", data: { t: "SPEC_GAP", u: "u3", tok: 0, msg: "decided: keep 400" } }).success).toBe(true)
    expect(WriteJournalInputSchema.safeParse({ operation: "log_event", data: { t: "GATE_OVERRIDE", u: "phase", tok: 0, msg: "--force-continue", gate: "p2" } }).success).toBe(true)
  })
})

// ─── item 5: advisor stderr on success ──────────────────────────────────────

describe("formatAdvisorResult — stderr on success", () => {
  const base = { stdout: "the answer", timedOut: false, exitCode: 0 }
  const noisyStderr = Array.from({ length: 120 }, (_, i) => `tool call ${i}`).join("\n")

  it("drops stderr when stdout is intact even though stderr alone tripped the cap", () => {
    const text = formatAdvisorResult("codex", { ...base, stderr: noisyStderr, truncated: true, stdoutTruncated: false, stderrTruncated: true })
    expect(text).toContain("STDOUT\nthe answer")
    expect(text).not.toContain("STDERR")
    expect(text).not.toContain("tool call")
  })

  it("keeps only a 40-line stderr tail when stdout itself was cut", () => {
    const text = formatAdvisorResult("codex", { ...base, stderr: noisyStderr, truncated: true, stdoutTruncated: true, stderrTruncated: true })
    expect(text).toContain("STDERR (tail 40 of 120 lines)")
    expect(text).toContain("tool call 119")
    expect(text).not.toContain("tool call 79\n")
  })

  it("legacy results without per-stream flags fall back to the combined flag", () => {
    const text = formatAdvisorResult("gemini", { ...base, stderr: "a\nb", truncated: true })
    expect(text).toContain("STDERR (tail 2 of 2 lines)")
  })

  it("failure keeps stderr whole", () => {
    const text = formatAdvisorResult("codex", { ...base, exitCode: 1, stderr: noisyStderr, truncated: false })
    expect(text).toContain("\nSTDERR\ntool call 0\n")
  })
})

// ─── item 6: run_tests output shaping ───────────────────────────────────────

describe("run_tests output shaping", () => {
  it("applyOutputFilters strips matching lines, counts them, then keeps the tail", () => {
    const buf = ["🐳 Testcontainers", "  ryuk started", "ok 1", "ok 2", "FAIL 3", "summary"].join("\n")
    const { regexes } = compileStripPatterns(["^🐳", "ryuk"]) as { ok: true; regexes: RegExp[] }
    const shaped = applyOutputFilters(buf, regexes, 2)
    expect(shaped.strippedLines).toBe(2)
    expect(shaped.text).toBe("FAIL 3\nsummary")
  })

  it("no options → byte-identical passthrough", () => {
    expect(applyOutputFilters("a\nb", [], undefined)).toEqual({ text: "a\nb", strippedLines: 0 })
  })

  it("compileStripPatterns rejects invalid regex, empty, over-long, and too many", () => {
    expect(compileStripPatterns(["("])).toMatchObject({ ok: false })
    expect((compileStripPatterns(["("]) as { error: string }).error).toContain("invalid strip_pattern")
    expect(compileStripPatterns([""])).toMatchObject({ ok: false })
    expect(compileStripPatterns(["x".repeat(201)])).toMatchObject({ ok: false })
    expect(compileStripPatterns(Array(11).fill("a"))).toMatchObject({ ok: false })
    expect(compileStripPatterns(undefined)).toEqual({ ok: true, regexes: [] })
  })

  it("runTests returns an error line for a bad pattern before spawning anything", async () => {
    const text = await runTests("npm", ["--version"], 5000, 8000, { stripPatterns: ["("] })
    expect(text).toMatch(/^error: invalid strip_pattern/)
  })

  it.runIf(process.platform === "win32" || process.platform === "linux")(
    "runTests reports stripped_lines and tail_lines only when shaping was requested",
    async () => {
      const shaped = await runTests("npm", ["--version"], 60000, 8000, { stripPatterns: ["^$"], tailLines: 3 })
      expect(shaped).toContain("exit_code: 0")
      expect(shaped).toMatch(/stripped_lines: \d+\ntail_lines: 3\n\nSTDOUT/)
      const plain = await runTests("npm", ["--version"], 60000, 8000)
      expect(plain).not.toContain("stripped_lines")
      expect(plain).toMatch(/truncated: false\n\nSTDOUT/)
    }
  )
})
