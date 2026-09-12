// Field report 2026-09-11 (seventh): a crash mid-write left the ledger 4.2 MB of NUL and a
// source file 46 KB of NUL, and the recovery exposed a chain of problems around it — a guard
// that authorized nothing and hard-stopped on every edit, seat receipts that outlived the
// records citing them, an oracle fooled by a guard that ran zero tests, and three advisories
// that named the wrong cause. These are the checks for each.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { atomicWriteFile, appendFileDurable } from "../src/lib/atomicWrite.js"
import { readLedger, writeLedger, PHASE_FACTS_BUDGET } from "../src/lib/ledger.js"
import { isZeroFilled, zeroFilledFiles, takeSnapshot } from "../src/lib/repoGuard.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { normalizeReview } from "../src/tools/normalizeReview.js"
import { runOracle, testsObserved } from "../src/tools/verifyOracle.js"
import { reconstruct } from "../src/lib/reconstruct.js"
import { appendPreflight, briefHash, preflightPathFor } from "../src/lib/preflight.js"
import type { WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-ff0911-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const write = (operation: Record<string, unknown>) => writeLedger(ledgerPath, operation as WriteLedgerInput)

// ─── 2. The ledger write is flushed before the rename ─────────────────────────

describe("a rewritten ledger reaches the disk before anything points at it", () => {
  it("writes atomically, leaves no tmp sibling behind, and cleans up after a failed write", async () => {
    const target = path.join(dir, "state.json")
    await atomicWriteFile(target, JSON.stringify({ v: 1 }))
    expect(JSON.parse(await fs.readFile(target, "utf-8"))).toEqual({ v: 1 })
    // The tmp file is the window the crash landed in; nothing may survive the call.
    expect((await fs.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([])

    // A write whose destination cannot be replaced still cleans up its tmp file.
    const asDir = path.join(dir, "occupied")
    await fs.mkdir(asDir)
    await expect(atomicWriteFile(asDir, "x")).rejects.toThrow()
    expect((await fs.readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("appends sidecar lines durably and keeps the chain readable", async () => {
    const jsonl = path.join(dir, "side.jsonl")
    await appendFileDurable(jsonl, '{"a":1}\n')
    await appendFileDurable(jsonl, '{"a":2}\n')
    expect((await fs.readFile(jsonl, "utf-8")).split("\n").filter(Boolean)).toHaveLength(2)
  })
})

// ─── 8. A zeroed file is destroyed, not edited ────────────────────────────────

describe("a file that is entirely NUL is reported as destroyed", () => {
  it("detects only non-empty all-NUL files, not empty ones, text, or binaries with content", async () => {
    const zeroed = path.join(dir, "zeroed.go")
    await fs.writeFile(zeroed, Buffer.alloc(46_137, 0))
    expect(await isZeroFilled(zeroed)).toBe(true)

    // A NUL-prefixed file with real content further in is NOT damage.
    const mixed = path.join(dir, "mixed.bin")
    await fs.writeFile(mixed, Buffer.concat([Buffer.alloc(70_000, 0), Buffer.from("real")]))
    expect(await isZeroFilled(mixed)).toBe(false)

    await fs.writeFile(path.join(dir, "empty.go"), "")
    await fs.writeFile(path.join(dir, "ok.go"), "package main\n")
    expect(await isZeroFilled(path.join(dir, "empty.go"))).toBe(false)
    expect(await isZeroFilled(path.join(dir, "ok.go"))).toBe(false)
    expect(await isZeroFilled(path.join(dir, "absent.go"))).toBe(false)
    expect(await zeroFilledFiles(dir, ["zeroed.go", "ok.go", "empty.go", "absent.go"])).toEqual(["zeroed.go"])
  })
})

// ─── 4. The oracle cannot be fooled by a guard that runs nothing ──────────────

describe("a guard run that executed no test is never a verdict", () => {
  it("reads Go, vitest, pytest, cargo and dotnet zero-test markers without misreading a mixed run", () => {
    expect(testsObserved("exit_code: 0\nok  \tex/pkg\t0.002s [no tests to run]\ntesting: warning: no tests to run\n")).toBe("none")
    expect(testsObserved("exit_code: 0\n?   \tex/pkg\t[no test files]\n")).toBe("none")
    expect(testsObserved("No test files found, exiting with code 1")).toBe("none")
    expect(testsObserved("collected 0 items\n\nno tests ran in 0.01s")).toBe("none")
    expect(testsObserved("running 0 tests\n")).toBe("none")
    // Evidence a test ran always wins: `./...` over a tree where one package has no tests.
    expect(testsObserved("?   \tex/a\t[no test files]\nok  \tex/b\t0.104s\n")).toBe("yes")
    expect(testsObserved("--- PASS: TestThing (0.00s)\nok  \tex/b\t0.104s [no tests to run]\n")).toBe("yes")
    expect(testsObserved("Tests:  3 passed, 3 total")).toBe("yes")
    expect(testsObserved("exit_code: 0\nsome unrecognised runner output")).toBe("unknown")
  })

  it("refuses the whole guard when the BASELINE runs no tests, before a mutation is written", async () => {
    const file = path.join(dir, "m.go")
    const original = "package m\n\nfunc F() bool { return true }\n"
    await fs.writeFile(file, original)
    const report = await runOracle(
      { phase: "p1", unit_id: "u1", repo_root: dir, timeout_ms: 5000, mutations: [
        { label: "control", file: "m.go", old: "return true", new: "return false", runner: "go", args: ["test", "./...", "-run", "TestNothingMatches"] },
      ] } as never,
      async () => "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\ntesting: warning: no tests to run\nok  \tex/m\t0.001s [no tests to run]\n",
    )
    expect(report.results[0].outcome).toBe("invalid")
    expect(report.results[0].detail).toContain("ran NO TESTS unmutated")
    expect(report.killed).toBe(0)
    // The tree is untouched: an invalid baseline writes no mutation at all.
    expect(await fs.readFile(file, "utf-8")).toBe(original)
  })

  it("calls a renamed test invalid, not survived: exit 0 with nothing executed observed nothing", async () => {
    await fs.writeFile(path.join(dir, "m_test.go"), "package m\n\nfunc TestF(t *T) { _ = 1 }\n")
    let call = 0
    const report = await runOracle(
      { phase: "p1", unit_id: "u1", repo_root: dir, timeout_ms: 5000, mutations: [
        { label: "rename the guard test", file: "m_test.go", old: "TestF", new: "TestRenamed", runner: "go", args: ["test", "./...", "-run", "TestF"] },
      ] } as never,
      async () => (++call === 1
        // baseline: the guard really runs
        ? "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\n--- PASS: TestF (0.00s)\nok  \tex/m\t0.104s\n"
        // mutated: -run now matches nothing, so go exits 0 having executed nothing
        : "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\ntesting: warning: no tests to run\nok  \tex/m\t0.001s [no tests to run]\n"),
    )
    expect(report.results[0].outcome).toBe("invalid")
    expect(report.results[0].detail).toContain("ran NO TESTS with the mutation applied")
    expect(report.survivors).toEqual([])
  })

  it("marks a survivor from an additive mutation as possibly a no-op rather than a gap", async () => {
    await fs.writeFile(path.join(dir, "m.go"), "package m\n\nfunc F() bool { return true }\n")
    const report = await runOracle(
      { phase: "p1", unit_id: "u1", repo_root: dir, timeout_ms: 5000, mutations: [
        { label: "insert a no-op defer", file: "m.go", old: "return true", new: "defer func() {}()\n\treturn true", runner: "go", args: ["test", "./..."] },
      ] } as never,
      async () => "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\n--- PASS: TestF (0.00s)\nok  \tex/m\t0.104s\n",
    )
    expect(report.results[0].outcome).toBe("survived")
    expect(report.results[0].detail).toContain("only ADDS text")
  })
})

// ─── 10a. normalize_review says what it could not read ────────────────────────

describe("normalize_review explains a zero-finding parse", () => {
  it("names the grammar when nothing parsed, and stays quiet when findings were found", () => {
    const none = normalizeReview("codex", "The retry loop looks wrong to me.\nAlso the nil check is missing.\nOverall: two blockers.")
    expect(none.data.findings).toHaveLength(0)
    expect(none.text).toContain("NOT RECOGNISED")
    expect(none.text).toContain("CRITICAL, HIGH, MEDIUM, LOW, or P0-P3")
    expect(none.text).toContain("blocker / major / minor / nit")

    const some = normalizeReview("codex", "- HIGH: src/a.ts:42 — the retry loop never resets the backoff")
    expect(some.data.findings).toHaveLength(1)
    expect(some.text).not.toContain("NOT RECOGNISED")
    // An empty review is a legitimate answer, not a parse failure.
    expect(normalizeReview("codex", "").text).not.toContain("NOT RECOGNISED")
  })
})

// ─── 10b. record_fact budgets the store, not the entry ────────────────────────

describe("record_fact makes room for the fact most worth keeping", () => {
  it("accepts an incident record far past the old 2000-character cap and evicts oldest to stay in budget", async () => {
    for (let i = 0; i < 8; i++) {
      await write({ operation: "record_fact", phase: "p1", data: { key: `k${i}`, text: "x".repeat(4000) } })
    }
    const incident = "The interrupted write left the ledger 100% NUL. ".repeat(160).slice(0, 7900)
    const { warning } = await write({ operation: "record_fact", phase: "p1", data: { key: "incident", text: incident } })
    const facts = (await readLedger(ledgerPath)).phases.p1.facts!
    expect(facts.at(-1)!.text).toBe(incident)
    expect(facts.reduce((n, f) => n + f.text.length + f.key.length, 0)).toBeLessThanOrEqual(PHASE_FACTS_BUDGET)
    expect(warning).toContain("evicted")
  })
})

// ─── 9. The sidecars carry a replay worksheet ─────────────────────────────────

describe("after a ledger loss the append-only sidecars say what to replay", () => {
  it("names units and attempts the sidecars attest that the ledger no longer holds, and writes nothing", async () => {
    const brief = "Implement the bounded change for this unit with its specified tests"
    const hash = briefHash(brief)
    await write({ operation: "declare_phase_units", phase: "p1", data: { units: ["u1"] } })
    await appendPreflight(preflightPathFor(ledgerPath), {
      v: 1, ts: "2026-09-11T10:00:00Z", phase: "p1", unit_id: "u1", brief_hash: hash, status: "pass",
      symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0,
    })

    const before = await fs.readFile(ledgerPath, "utf-8")
    const report = await reconstruct(ledgerPath, await readLedger(ledgerPath))
    expect(report.units[0]).toMatchObject({ phase: "p1", unit_id: "u1", missing_unit: false })
    expect(report.units[0].unrecorded_attempts.map((p) => p.brief_hash)).toEqual([hash])

    const text = await handleReadLedger(ledgerPath, { query: "reconstruct" })
    expect(text).toContain("unrecorded_attempts: 1")
    expect(text).toContain(hash)
    expect(text).toContain("Foreman holds only the hash")
    expect(text).toContain("Nothing in this report has been written to the ledger")
    // A recovery read must never mutate the thing being recovered.
    expect(await fs.readFile(ledgerPath, "utf-8")).toBe(before)
  })

  it("reports a unit the sidecars attest that the ledger has lost entirely", async () => {
    await write({ operation: "declare_phase_units", phase: "p1", data: { units: ["u1"] } })
    await appendPreflight(preflightPathFor(ledgerPath), {
      v: 1, ts: "2026-09-11T10:00:00Z", phase: "p1", unit_id: "u-lost", brief_hash: "abc123abc123abc1", status: "pass",
      symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0,
    })
    const text = await handleReadLedger(ledgerPath, { query: "reconstruct" })
    expect(text).toContain("u-lost")
    expect(text).toContain("MISSING")
    expect(text).toContain("units_missing_from_ledger: 1")
  })
})

// ─── 1 + 8 together, through the real guard on a real repository ──────────────

describe("the guard on a real tree", () => {
  let repoDir: string
  const git = (args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff0911-repo-"))
    git(["init", "-q", "-b", "main"])
    git(["config", "user.email", "t@example.com"])
    git(["config", "user.name", "T"])
    git(["config", "commit.gpgsign", "false"])
    git(["config", "core.autocrlf", "false"])
    await fs.writeFile(path.join(repoDir, "grid_rows.go"), "package web\n\nfunc Rows() int { return 1 }\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "init"])
  })
  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true })
  })

  const guardPaths = () => ({ ledgerPath: path.join(repoDir, ".foreman-ledger.json") })
  const delegate = () => writeLedger(guardPaths().ledgerPath, {
    operation: "set_unit_status", phase: "p1", unit_id: "u1",
    data: { s: "delegated", brief: "Implement the grid rows change with its tests", preflight: { symbols_grepped: ["Rows"], self_consistent: true } },
  } as WriteLedgerInput)

  it("refuses a baseline whose authorized set is empty rather than hard-stopping on every edit later", async () => {
    await delegate()
    const out = await handleRepoGuard({ operation: "snapshot", phase: "p1", unit_id: "u1", project_dir: repoDir }, guardPaths())
    expect(out).toContain("status: refused")
    expect(out).toContain("the authorized file set is empty")
  })

  it("takes `files` as the allow-list when allowed_files is omitted, and says where the list came from", async () => {
    await delegate()
    const out = await handleRepoGuard(
      { operation: "snapshot", phase: "p1", unit_id: "u1", files: ["grid_rows.go"], project_dir: repoDir }, guardPaths()
    )
    expect(out).toContain("status: recorded")
    expect(out).toContain("authorized_from: files (allowed_files was not given)")
    expect(out).toContain("authorized_files: 1")

    // And the guard then does its actual job on that set.
    await fs.writeFile(path.join(repoDir, "grid_rows.go"), "package web\n\nfunc Rows() int { return 2 }\n")
    expect(await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: repoDir }, guardPaths())).toContain("status: ok")
  })

  it("refuses to baseline onto an authorized file that is already destroyed", async () => {
    await delegate()
    await fs.writeFile(path.join(repoDir, "grid_rows.go"), Buffer.alloc(46_137, 0))
    const out = await handleRepoGuard(
      { operation: "snapshot", phase: "p1", unit_id: "u1", allowed_files: ["grid_rows.go"], project_dir: repoDir }, guardPaths()
    )
    expect(out).toContain("status: damaged")
    expect(out).toContain("grid_rows.go")
    expect(out).toContain("entirely NUL")
    // Nothing was recorded, so no worker can be spawned against this tree.
    expect((await readLedger(guardPaths().ledgerPath)).phases.p1.units.u1.delegations![0].guard).toBeUndefined()
  })

  it("names a file zeroed DURING the attempt, which the ownership diff alone cannot see", async () => {
    await delegate()
    await handleRepoGuard(
      { operation: "snapshot", phase: "p1", unit_id: "u1", allowed_files: ["grid_rows.go"], project_dir: repoDir }, guardPaths()
    )
    // The path IS authorized, so the ownership comparison clears it; only the NUL scan sees it.
    await fs.writeFile(path.join(repoDir, "grid_rows.go"), Buffer.alloc(46_137, 0))
    const out = await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: repoDir }, guardPaths())
    expect(out).toContain("status: violation")
    expect(out).toContain("destroyed, not edited")
    expect(out).toContain("zeroed_files: grid_rows.go")
    const guard = (await readLedger(guardPaths().ledgerPath)).phases.p1.units.u1.delegations![0].guard!
    expect(guard.damaged).toEqual(["grid_rows.go"])
  })

  it("still reports the snapshot outcome for a tree with no git before it complains about an allow-list", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "ff0911-nogit-"))
    try {
      expect((await takeSnapshot(plain, [])).status).toBe("n/a")
      const out = await handleRepoGuard(
        { operation: "snapshot", phase: "p1", unit_id: "u1", project_dir: plain },
        { ledgerPath: path.join(plain, ".foreman-ledger.json") }
      )
      expect(out).toContain("status: n/a")
      expect(out).not.toContain("authorized file set is empty")
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })
})
