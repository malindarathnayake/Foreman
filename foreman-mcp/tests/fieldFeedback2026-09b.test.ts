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
    expect(text).toContain("Expected data shape: { v: 'pass'|'fail'|'pending'|'inconclusive', via?: 'worker'|'pitboss-direct'|'n/a', note?: string (≤10000 chars), user_override?: boolean }")
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
        arguments: { operation: "log_event", data: { t: "INFO", u: "u1", msg: "x".repeat(401) } },
      })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toContain("SCHEMA ERROR — write_journal log_event rejected (3 issues):")
      expect(text).toContain("  data.t: ")
      expect(text).toContain("  data.tok: ")
      expect(text).toContain("  data.msg: ")
      expect(text).toContain("msg: string (≤400 chars)")
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

// ─── docs deliberation: confirmed findings block the gate ───────────────────

describe("update_phase_gate — confirmed findings and review currency", () => {
  const CONFIRMED = { severity: "high" as const, file: "src/a.ts", line: "42", description: "null deref on config.port", classification: "confirmed" as const }

  async function delegatePass(unit: string) {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: unit, data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT } })
    await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: unit, data: { v: "pass" } })
  }

  it("a confirmed finding in the current review blocks the gate and names it", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [CONFIRMED] } })
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/CONFIRMED FINDINGS: phase 'p1' has 1 confirmed review finding\(s\).*codex: src\/a\.ts:42 null deref/)
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pending")
  })

  it("rejected and unverified classifications do not block", async () => {
    // 0.6.4: a finding without a classification is refused at the schema and, when it
    // reached the ledger before then, reads as an incomplete review (fieldFeedback2026-09c).
    await delegatePass("u1")
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: { advisor: "codex", findings: [{ ...CONFIRMED, classification: "rejected" }, { ...CONFIRMED, classification: "unverified" }] },
    })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })

  it("resolution flow: reject → re-delegate → re-verdict → stale review is REVIEW REQUIRED → fresh clean review passes", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [CONFIRMED] } })
    await new Promise((r) => setTimeout(r, 5))
    await writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "codex", msg: "null deref", ts: "2026-09-04T00:00:00Z" } })
    await delegatePass("u1")
    // The confirmed review now predates the re-verdict: it does not count, and no current review exists.
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/REVIEW REQUIRED: phase 'p1' has no record_review entry recorded at or after its latest unit verdict\. 1 older review\(s\) exist but predate/)
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [], checked: ["src/a.ts"], completion: "complete" } })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.confirmed_override).toBeUndefined()
    expect(phase.review_override).toBeUndefined()
  })

  it("a zero-finding review with no examined list and no completion is INCOMPLETE; checked[] or completion:'complete' satisfies it", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "gemini", findings: [] } })
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/INCOMPLETE REVIEW: phase 'p1' has 1 review\(s\).*gemini: zero findings with no examined list/)
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "gemini", findings: [], checked: ["src/a.ts", "tests/a.test.ts"] } })
    // The silent record is still current, so it still blocks — the seat must be re-run or marked, not papered over.
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/INCOMPLETE REVIEW/)
  })

  it("completion:'partial' blocks even with findings; user_override records incomplete_override", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: { advisor: "codex", findings: [{ ...CONFIRMED, classification: "rejected" }], completion: "partial", checked: ["src/a.ts"] },
    })
    await expect(
      writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    ).rejects.toThrow(/INCOMPLETE REVIEW.*codex: completion=partial/)
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", user_override: true } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.incomplete_override?.reviews).toBe(1)
  })

  it("a stale silent review does not count: only reviews since the latest verdict are judged", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "gemini", findings: [] } })
    await new Promise((r) => setTimeout(r, 5))
    await writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "codex", msg: "x", ts: "2026-09-04T00:00:00Z" } })
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [], checked: ["src/a.ts"], completion: "complete" } })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })

  it("user_override waives a confirmed finding and records confirmed_override", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "codex", findings: [CONFIRMED, CONFIRMED] } })
    await writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", user_override: true } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.confirmed_override?.findings).toBe(2)
    expect(typeof phase.confirmed_override?.ts).toBe("string")
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
