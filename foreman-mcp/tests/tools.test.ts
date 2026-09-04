import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { bundleStatus } from "../src/tools/bundleStatus.js"
import { changelog } from "../src/tools/changelog.js"
import { ethos, ETHOS_SECTIONS } from "../src/tools/ethos.js"
import { getStackProfile } from "../src/lib/stackProfiles.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { handleReadProgress } from "../src/tools/readProgress.js"
import { capabilityCheck } from "../src/tools/capabilityCheck.js"
import { writeLedger } from "../src/lib/ledger.js"
import { writeProgress } from "../src/lib/progress.js"

async function withNoCliOnPath(fn: () => Promise<void>): Promise<void> {
  const originalEnv: Record<string, string | undefined> = {}
  const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === "path")
  const keys = pathKeys.length > 0 ? pathKeys : ["PATH"]

  for (const key of keys) {
    originalEnv[key] = process.env[key]
    process.env[key] = ""
  }

  try {
    await fn()
  } finally {
    for (const key of keys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  }
}

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
  it("returns TOON output containing bundle_version matching package.json", async () => {
    const pkgRaw = await fs.readFile(new URL("../package.json", import.meta.url), "utf-8")
    const pkg = JSON.parse(pkgRaw) as { version: string }
    const result = await bundleStatus()
    expect(result).toContain(`bundle_version: ${pkg.version}`)
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

describe("ethos", () => {
  const reference = getStackProfile("reference")

  it("full doc contains all seven ## sections and rendered stack content", async () => {
    const doc = await ethos(reference)
    expect(doc).toContain("## Proportionality — declare a tier, don't assume one")
    expect(doc).toContain("## Pillar 1 — Mechanical Sympathy")
    expect(doc).toContain("## Pillar 2 — Security (framework-evaluated)")
    expect(doc).toContain("## Pillar 3 — Observability (contract-first)")
    expect(doc).toContain("## Cross-pillar rules")
    expect(doc).toContain("## Design-time question set (design sessions must cover)")
    expect(doc).toContain("## Review-time checklist (implementor Ethos Compliance gate G6 / council lenses)")
    expect(doc).toContain("InfluxDB")
    expect(doc).toContain("ATT&CK")
    expect(doc).not.toContain("{{stack:")
  })

  it("bundled doc never references ~/.claude", async () => {
    const doc = await ethos(reference)
    expect(doc).not.toContain("~/.claude")
    expect(doc).not.toContain(".claude/")
  })

  it("section=observability returns only Pillar 3", async () => {
    const out = await ethos(reference, "observability")
    expect(out).toContain("## Pillar 3 — Observability (contract-first)")
    expect(out).toContain("InfluxDB")
    expect(out).not.toContain("## Pillar 1")
    expect(out).not.toContain("## Cross-pillar rules")
  })

  it("section=security returns only Pillar 2 with the frameworks section rendered", async () => {
    const out = await ethos(reference, "security")
    expect(out).toContain("## Pillar 2 — Security (framework-evaluated)")
    expect(out).toContain("ATT&CK")
    expect(out).not.toContain("## Pillar 3")
  })

  it("ETHOS_SECTIONS is the bounded 7-slug enum", () => {
    expect(ETHOS_SECTIONS).toHaveLength(7)
    expect(ETHOS_SECTIONS).toContain("proportionality")
    expect(ETHOS_SECTIONS).toContain("review-checklist")
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
    // Must delegate before passing verdict (pitboss enforcement)
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec", tier: "standard", route_reason: "default sonnet worker" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "verdicts" })
    expect(result).toContain("total_rows: 1")
    expect(result).toContain("phase | unit | tier | verdict | via")
    expect(result).not.toContain(" | note")
    expect(result).toContain("p1")
    expect(result).toContain("u1")
    expect(result).toContain("pass")
    expect(result).toContain("standard")
  })

  it("verdicts table includes via and note values when present", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "worker", note: "manual smoke: ran CLI against fixture" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "verdicts", include_notes: true })
    expect(result).toContain("worker")
    expect(result).toContain("manual smoke: ran CLI against fixture")
  })

  it("pages and filters verdicts without emitting every ledger unit", async () => {
    for (const [phase, unit] of [["p1", "u1"], ["p1", "u2"], ["p2", "u3"]] as const) {
      await writeLedger(ledgerPath, {
        operation: "set_unit_status",
        phase,
        unit_id: unit,
        data: { s: "pending" },
      })
    }

    const first = await handleReadLedger(ledgerPath, { query: "verdicts", limit: 2 })
    expect(first).toContain("total_rows: 3")
    expect(first).toContain("returned: 2")
    expect(first).toContain("next_cursor: 2")
    expect(first).not.toContain("u3")

    const filtered = await handleReadLedger(ledgerPath, {
      query: "verdicts",
      phase: "p2",
      verdict: "pending",
    })
    expect(filtered).toContain("total_rows: 1")
    expect(filtered).toContain("p2 | u3")
    expect(filtered).not.toContain("p1 |")
  })

  it("bounds included notes per cell and directs callers to the single-unit view", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement a bounded ledger note regression test" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note: "n".repeat(1000) },
    })

    const result = await handleReadLedger(ledgerPath, { query: "verdicts", include_notes: true })
    expect(result).toContain("truncated_cells: 1")
    expect(result).toContain("…")
    expect(result).toContain("hint: full note: read_ledger({ phase, unit_id })")
    expect(result.length).toBeLessThan(1100)
  })

  it("rejections truncation hint points at the phase-scoped full view, not the per-unit view", async () => {
    await writeLedger(ledgerPath, {
      operation: "add_rejection",
      phase: "p1",
      unit_id: "u1",
      data: { r: "pitboss", msg: "m".repeat(1000), ts: "2026-08-07T00:00:00Z" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "rejections" })
    expect(result).toContain("truncated_cells: 1")
    expect(result).toContain('hint: full text: read_ledger({ query: "full", phase: "<phase>" })')
    expect(result).not.toContain("phase, unit_id })")
  })

  it("emits no hint when nothing was truncated", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: short note stays untruncated" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", note: "short note" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "verdicts", include_notes: true })
    expect(result).toContain("truncated_cells: 0")
    expect(result).not.toContain("hint:")
  })

  it("refuses an oversized full-ledger payload with bounded recovery guidance", async () => {
    const units = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [
      `u${i}`,
      { s: "done", v: "pass", w: "brief", rej: [], note: "n".repeat(10000) },
    ]))
    await fs.writeFile(ledgerPath, JSON.stringify({
      v: 1,
      ts: "2026-08-04T00:00:00Z",
      phases: { p1: { s: "ip", g: "pending", units } },
    }), "utf-8")

    const result = await handleReadLedger(ledgerPath, { query: "full" })
    expect(result).toContain("error: ledger_output_too_large")
    expect(result).toContain("max_output_chars: 50000")
    expect(result).toContain("Use session_orient")
    expect(result.length).toBeLessThan(1000)
  })

  it("single-unit view includes tier, route_reason, and delegation count", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief for unit u1 implementation work", tier: "cheap", route_reason: "mechanical rename" },
    })
    const result = await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })
    expect(result).toContain("tier: cheap")
    expect(result).toContain("route_reason: mechanical rename")
    expect(result).toContain("delegations: 1")
  })

  it("returns reviews table for query: reviews", async () => {
    await writeLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: { advisor: "gemini", findings: [{ severity: "high", file: "a.ts", line: "10", description: "boom", classification: "confirmed" }] },
    })
    const result = await handleReadLedger(ledgerPath, { query: "reviews" })
    expect(result).toContain("phase | advisor | severity | class | finding")
    expect(result).toContain("gemini")
    expect(result).toContain("confirmed")
    expect(result).toContain("boom")
  })

  it("single-unit view includes via and note", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass", via: "pitboss-direct", note: "artifact hash verified" },
    })

    const result = await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })
    expect(result).toContain("via: pitboss-direct")
    expect(result).toContain("note: artifact hash verified")
  })

  it("returns phase_gates table for query: phase_gates", async () => {
    // Gate pass requires all units passing — seed one passed unit first
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "phase_gates" })
    expect(result).toContain("phase | status | gate | stale")
    expect(result).toContain("p1")
    expect(result).toContain("pass")
  })

  it("phase_gates: fresh gate shows '-' (D2b)", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "phase_gates" })
    expect(result).toMatch(/p1 \| \w+ \| pass \| -/)
  })

  it("phase_gates: STALE after a post-pass unit add (D2b)", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "delegated", preflight: { symbols_grepped: 1, self_consistent: true }, brief: "Worker brief: implement unit u1 types and constants per spec" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_verdict",
      phase: "p1",
      unit_id: "u1",
      data: { v: "pass" },
    })
    await writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: { advisor: "test-seat", findings: [] } })  // gate requires ≥1 review (2026-09 R2)
    await writeLedger(ledgerPath, {
      operation: "update_phase_gate",
      phase: "p1",
      data: { g: "pass" },
    })
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u2",
      data: { s: "pending" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "phase_gates" })
    expect(result).toMatch(/p1 \| \w+ \| pass \| STALE/)
  })

  it("phase_gates: absent hash shows 'n/a', never 'STALE' (D2b)", async () => {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "p1",
      unit_id: "u1",
      data: { s: "done" },
    })

    const result = await handleReadLedger(ledgerPath, { query: "phase_gates" })
    expect(result).toMatch(/n\/a/)
    expect(result).not.toContain("STALE")
  })

  it("corrupt ledger → returns ledger_corrupt error WITHOUT renaming the file", async () => {
    await fs.writeFile(ledgerPath, "{ this is not valid json !!!", "utf-8")

    const result = await handleReadLedger(ledgerPath, { query: "full" })
    expect(result).toContain("error: ledger_corrupt")

    // File left untouched — no rename, no .corrupt.* sibling
    const stillExists = await fs.access(ledgerPath).then(() => true).catch(() => false)
    expect(stillExists).toBe(true)
    const siblings = await fs.readdir(path.dirname(ledgerPath))
    expect(siblings.filter((f) => f.includes(".corrupt."))).toHaveLength(0)
  })
})

describe("handleReadProgress", () => {
  it("marks progress as non-authoritative before STATUS", async () => {
    const result = await handleReadProgress(progressPath)
    expect(result).toContain("AUTHORITY")
    expect(result).toContain("role: planning_checklist_only")
    expect(result).toContain("resume: call session_orient")
    expect(result).not.toContain("Resume at")
    const hintIdx = result.indexOf("AUTHORITY")
    const statusIdx = result.indexOf("STATUS")
    expect(hintIdx).toBeLessThan(statusIdx)
  })

  it("does not synthesize a resume instruction when no units exist", async () => {
    const result = await handleReadProgress(progressPath)
    expect(result).not.toContain("mcp__foreman__spec_generator")
    expect(result).toContain("completed: 0/0 units")
  })

  it("shows pending units as checklist data without making them resume authority", async () => {
    await writeProgress(progressPath, {
      operation: "update_status",
      data: { unit_id: "u1", phase: "p1", status: "in_progress", notes: "working" },
    })
    const result = await handleReadProgress(progressPath)
    expect(result).toContain("u1 | p1 | in_progress | working")
    expect(result).not.toContain("Resume at u1")
  })

  it("shows completed checklist state without directing a phase checkpoint", async () => {
    await writeProgress(progressPath, {
      operation: "complete_unit",
      data: { unit_id: "u1", phase: "p1", completed_at: "2026-04-06T10:00:00Z", notes: "done" },
    })
    const result = await handleReadProgress(progressPath)
    expect(result).toContain("completed: 1/1 units")
    expect(result).not.toContain("Run phase checkpoint")
  })

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
    await withNoCliOnPath(async () => {
      const result = await capabilityCheck("codex")
      expect(result).toContain("cli: codex")
      expect(result).toContain("available: false")
      expect(result).toContain("auth_status: not_found")
    })
  }, 5000)

  it("returns available: false for codex on systems without it", async () => {
    await withNoCliOnPath(async () => {
      const result = await capabilityCheck("codex")
      const lines = result.split("\n")
      // Should have at least 4 lines (cli, available, version, auth_status)
      expect(lines.length).toBeGreaterThanOrEqual(4)
      // Each line should be key: value format
      for (const line of lines) {
        expect(line).toMatch(/^\w+: .+$/)
      }
    })
  }, 5000)
})
