// Field report 2026-09-10 (second batch): the wiring of preflight_check into the ledger,
// per-phase facts, orphan retirement, native review on Claude Code, the oracle record, and
// the guard's refusal of a fenced-block change that no Foreman progress write accompanied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, recordOracle, writeLedger } from "../src/lib/ledger.js"
import { appendPreflight, briefHash, preflightPathFor } from "../src/lib/preflight.js"
import { readProgress, writeProgress } from "../src/lib/progress.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { compareSnapshots, takeSnapshot } from "../src/lib/repoGuard.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { WriteLedgerInput, WriteProgressInput } from "../src/types.js"

let dir: string
let ledgerPath: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-ff0910-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
async function write(operation: Record<string, unknown>, host: HostId = "claude-code") {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, host)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const BRIEF = "Implement the bounded change for this unit with its specified tests."
const delegated = (unit_id: string, preflight: Record<string, unknown> = { symbols_grepped: ["x"], self_consistent: true }) =>
  ({ operation: "set_unit_status", phase: "p1", unit_id, data: { s: "delegated", brief: BRIEF, preflight } })

describe("preflight receipt on the delegation", () => {
  it("before the project runs preflight_check, an attested delegation is accepted with a note", async () => {
    const { warning } = await write(delegated("u1"))
    expect(warning).toContain("PREFLIGHT: attested only")
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.delegations![0].preflight.symbols_grepped).toEqual(["x"])
  })
  it("once a preflight record exists, the delegation must carry the passing brief hash", async () => {
    const file = preflightPathFor(ledgerPath)
    const hash = briefHash(BRIEF)
    const base = { v: 1 as const, ts: "t", phase: "p1", unit_id: "u1", brief_hash: hash, symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0 }
    await appendPreflight(file, { ...base, status: "fail" })
    // 0.6.26: the refusal names the CAUSE (the brief text differs from the hashed one), not
    // just the two hashes — a mismatch has exactly one cause and it used to be left to guess.
    await expect(write(delegated("u1"))).rejects.toThrow(/PREFLIGHT RECEIPT: no receipt was given\./)
    await expect(write(delegated("u1", { symbols_grepped: ["x"], self_consistent: true, receipt: "0000000000000000" })))
      .rejects.toThrow(/the brief text in this call differs from the one preflight_check hashed .* the receipt names 0000000000000000/)
    await expect(write(delegated("u1", { symbols_grepped: ["x"], self_consistent: true, receipt: hash }))).rejects.toThrow(/no passing preflight record/)
    await appendPreflight(file, { ...base, status: "pass" })
    const { warning } = await write(delegated("u1", { symbols_grepped: ["x"], self_consistent: true, receipt: hash }))
    expect(warning).toBeUndefined()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.delegations![0].preflight.receipt).toBe(hash)
    // a pass obtained on u1 does not carry to u2 (Codex review 2026-09-10): u2 needs its own record
    await expect(write(delegated("u2", { symbols_grepped: ["x"], self_consistent: true, receipt: hash }))).rejects.toThrow(/on unit 'u2' \(the newest record for this brief decides/)
    await appendPreflight(file, { ...base, unit_id: "u2", status: "pass" })
    // a legacy count is still accepted on a project that has adopted the check, with the receipt
    await write(delegated("u2", { symbols_grepped: 3, self_consistent: true, receipt: hash }))
  })
})

describe("per-phase facts and orphan retirement", () => {
  it("record_fact keeps bounded facts per phase, replaces by key, and read_ledger lists them", async () => {
    await write({ operation: "record_fact", phase: "p1", data: { key: "cf.settings.node", text: "Settings lives under AccountSettings.<dataset>", source: "bin/p111-gql-discover.py" } })
    const { warning } = await write({ operation: "record_fact", phase: "p1", data: { key: "cf.settings.node", text: "AccountSettings.<dataset>.settings" } })
    expect(warning).toContain("(1/50)")
    for (let i = 0; i < 55; i++) await write({ operation: "record_fact", phase: "p1", data: { key: `k${i}`, text: `fact ${i}` } })
    const facts = (await readLedger(ledgerPath)).phases.p1.facts!
    expect(facts).toHaveLength(50)
    expect(facts.at(-1)!.key).toBe("k54")
    const text = await handleReadLedger(ledgerPath, { query: "facts", phase: "p1" })
    expect(text).toContain("total_rows: 50")
    expect(text).toContain("k54")
  })
  it("write_progress retire_unit removes an orphan entry with a reason and refuses an unknown one", async () => {
    const progressPath = path.join(dir, "progress.json")
    await writeProgress(progressPath, { operation: "update_status", data: { unit_id: "p9.5", phase: "p9", status: "planned", notes: "Skill wheel" } } as WriteProgressInput)
    await expect(writeProgress(progressPath, { operation: "retire_unit", data: { unit_id: "nope", phase: "p9", reason: "never existed in the ledger" } } as WriteProgressInput)).rejects.toThrow(/RETIRE BLOCKED/)
    await writeProgress(progressPath, { operation: "retire_unit", data: { unit_id: "p9.5", phase: "p9", reason: "orphan: the unit was folded into p9.4" } } as WriteProgressInput)
    const progress = await readProgress(progressPath)
    expect(progress.phases.p9.units["p9.5"]).toBeUndefined()
    expect(progress.phases.p9.retired).toEqual([{ unit_id: "p9.5", ts: expect.any(String), reason: "orphan: the unit was folded into p9.4" }])
  })
})

describe("native review on Claude Code and the oracle record", () => {
  const nativeReview = () => ({
    advisor: "claude-workflow-fan", stage: "native", completion: "complete", findings: [], checked: ["src/a.ts"],
    native: { reviewers: [
      { agent_id: "find:contract", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
      { agent_id: "find:tests", lens: "tests", completion: "complete", checked: ["tests/a.test.ts"] },
    ], verifier_id: "verify:1" },
  })
  it("a complete native record carries the Claude Code gate as same-provider; cursor still refuses it", async () => {
    await write(delegated("u1"))
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
    await write({ operation: "record_review", phase: "p1", data: nativeReview() })
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.gate_history![0].basis).toBe("same_provider")
    expect(phase.reviews![0].limitations).toContain("same-provider review")
    await expect(write({ operation: "record_review", phase: "p1", data: nativeReview() }, "cursor")).rejects.toThrow(/requires a host with native subagents/)
  })
  it("recordOracle stores the latest run on the unit and refuses an unregistered unit", async () => {
    await write(delegated("u1"))
    const report = { ts: "2026-09-10T15:00:05.000Z", mutations: 6, killed: 6, survivors: [], invalid: [] }
    await recordOracle(ledgerPath, "p1", "u1", report)
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.oracle).toEqual(report)
    await recordOracle(ledgerPath, "p1", "u1", { ...report, killed: 5, survivors: ["drop-guard"] })
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.oracle?.survivors).toEqual(["drop-guard"])
    await expect(recordOracle(ledgerPath, "p1", "nope", report)).rejects.toThrow(/ORACLE BLOCKED/)
  })
})

describe("fenced-block change without a Foreman progress write", () => {
  it("is a violation; the same change beside a progress-state write is clean", async () => {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const run = promisify(execFile)
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-fence-"))
    try {
      await run("git", ["init", "-q"], { cwd: repo })
      await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo })
      await fs.mkdir(path.join(repo, "Docs"))
      const md = path.join(repo, "Docs", "PROGRESS.md")
      const state = path.join(repo, "Docs", ".foreman-progress.json")
      await fs.writeFile(md, "# Plan\n<!-- foreman:checklist-start -->\n- [ ] u1\n<!-- foreman:checklist-end -->\n")
      await fs.writeFile(state, '{"phases":{}}')
      await run("git", ["add", "."], { cwd: repo })
      await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs"], { cwd: repo })
      const scope = { ledgerPath: path.join(repo, "Docs", ".foreman-ledger.json"), progressPath: state, journalPath: path.join(repo, "Docs", ".foreman-journal.json"), docsDir: path.join(repo, "Docs") }
      const { foremanFileScope } = await import("../src/lib/foremanFiles.js")
      const fscope = foremanFileScope(scope)
      const before = await takeSnapshot(repo, [], [], undefined, fscope)
      expect(before.status).toBe("ok")
      if (before.status !== "ok") throw new Error("snapshot failed")
      // a worker ticks the checklist inside the fence; nothing else moves
      await fs.writeFile(md, "# Plan\n<!-- foreman:checklist-start -->\n- [x] u1 pass\n<!-- foreman:checklist-end -->\n")
      let after = await takeSnapshot(repo, [], [], undefined, fscope)
      if (after.status !== "ok") throw new Error("snapshot failed")
      expect(compareSnapshots(before.snapshot, after.snapshot, after.scope)).toContain("Foreman-fenced block changed with no Foreman progress write: Docs/PROGRESS.md")
      // Foreman's own write moves the progress state too: clean
      await fs.writeFile(state, '{"phases":{"p1":{}}}')
      after = await takeSnapshot(repo, [], [], undefined, fscope)
      if (after.status !== "ok") throw new Error("snapshot failed")
      expect(compareSnapshots(before.snapshot, after.snapshot, after.scope)).toEqual([])

      // Through the real tool path: recording the snapshot rewrites the ledger, which must
      // NOT count as the Foreman write that legitimises a fence edit (Codex review 2026-09-10).
      const toolLedger = path.join(repo, "Docs", ".foreman-ledger.json")
      await writeLedger(toolLedger, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
        s: "delegated", brief: "Implement the bounded change for this unit", preflight: { symbols_grepped: ["x"], self_consistent: true },
      } } as WriteLedgerInput)
      await fs.writeFile(md, "# Plan\n<!-- foreman:checklist-start -->\n- [ ] u1\n<!-- foreman:checklist-end -->\n")
      await fs.writeFile(state, '{"phases":{}}')
      const guardPaths = { ledgerPath: toolLedger, progressPath: state, journalPath: path.join(repo, "Docs", ".foreman-journal.json"), docsDir: path.join(repo, "Docs") }
      const snap = await handleRepoGuard({ operation: "snapshot", phase: "p1", unit_id: "u1", project_dir: repo, files: [], allowed_files: [] } as never, guardPaths)
      expect(snap).toContain("status: recorded")
      await fs.writeFile(md, "# Plan\n<!-- foreman:checklist-start -->\n- [x] u1 pass\n<!-- foreman:checklist-end -->\n")
      const cmp = await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: repo, files: [] } as never, guardPaths)
      expect(cmp).toContain("Foreman-fenced block changed with no Foreman progress write: Docs/PROGRESS.md")
    } finally {
      await fs.rm(repo, { recursive: true, force: true })
    }
  }, 30000)
})
