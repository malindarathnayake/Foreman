// Field report 2026-09-25 (hubble-api BDI-219), items #9 and #6: rules that existed only in
// refusals. Every write_ledger operation requires phase, record_fact had no description line,
// and native review's two-reviewer minimum was enforced but never rendered.
import { describe, it, expect } from "vitest"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"

async function writeLedgerTool() {
  const server = await createServer()
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "t", version: "1" })
  await client.connect(ct)
  const tool = (await client.listTools()).tools.find((t) => t.name === "write_ledger")!
  await client.close()
  await server.close()
  return tool
}

describe("write_ledger advertises what it enforces", () => {
  it("phase is required and record_fact is described", async () => {
    const tool = await writeLedgerTool()
    expect(tool.inputSchema.required).toContain("phase")
    expect(tool.description).toContain("record_fact — { key, text, source? }")
  })

  it("renders the native reviewers minimum and the stage rules beside the data shapes", async () => {
    const tool = await writeLedgerTool()
    const data = JSON.stringify((tool.inputSchema.properties as Record<string, { description?: string }>).data.description)
    expect(data).toMatch(/\(min 2, max \d+\)/)
    expect(data).toContain("record_review stages:")
    expect(data).toContain("evidence.units (not data.units)")
  })
})

// Item #4 (reduced after Codex review): a bounded budget override and classified failures.
// No automatic fallback — it would mislabel which vendor reviewed.
import { claudeAdvisorBudgetUsd, classifyAdvisorFailure, formatAdvisorResult } from "../src/tools/invokeAdvisor.js"
import { receiptFailure } from "../src/lib/seatReceipts.js"

const run = (over: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>) =>
  ({ stdout: "", stderr: "", exitCode: 1, timedOut: false, truncated: false, ...over })

describe("advisor budget override", () => {
  it("defaults to $1 and accepts only a finite positive value up to the ceiling", () => {
    expect(claudeAdvisorBudgetUsd({})).toBe(1)
    expect(claudeAdvisorBudgetUsd({ FOREMAN_CLAUDE_ADVISOR_BUDGET_USD: "5" })).toBe(5)
    expect(claudeAdvisorBudgetUsd({ FOREMAN_CLAUDE_ADVISOR_BUDGET_USD: "2.5" })).toBe(2.5)
    for (const bad of ["0", "-3", "abc", "1e3", "26", "Infinity", ""]) {
      expect(claudeAdvisorBudgetUsd({ FOREMAN_CLAUDE_ADVISOR_BUDGET_USD: bad }), bad).toBe(1)
    }
  })
})

describe("advisor failure classes", () => {
  it("reads structured timeout first, then the stderr tail", () => {
    expect(classifyAdvisorFailure(run({ exitCode: -1, timedOut: true }))).toBe("timed_out")
    expect(classifyAdvisorFailure(run({ stderr: "ERROR: unexpected status 401 Unauthorized: Incorrect API key provided" }))).toBe("auth_failed")
    expect(classifyAdvisorFailure(run({ stderr: "Error: Exceeded USD budget (1)" }))).toBe("budget_exceeded")
    expect(classifyAdvisorFailure(run({ stderr: "The 'gpt-6-terra' model is not supported when using Codex with a ChatGPT account." }))).toBe("model_rejected")
    expect(classifyAdvisorFailure(run({ stderr: "segfault" }))).toBeNull()
    expect(classifyAdvisorFailure(run({ exitCode: 0, stderr: "401 Unauthorized" }))).toBeNull()
  })

  it("a prompt echoed at the top of stderr does not read as an auth failure", () => {
    const echoed = "user\nTest that the API returns 401 Unauthorized on a bad token\n" + "transcript line\n".repeat(40) + "ERROR: stream disconnected"
    expect(classifyAdvisorFailure(run({ stderr: echoed }))).toBeNull()
  })

  it("the output and the receipt name the cause and the fix", () => {
    const r = run({ stderr: "ERROR: unexpected status 401 Unauthorized" })
    const text = formatAdvisorResult("codex", r, "prompt")
    expect(text).toContain("failure_reason: auth_failed")
    expect(text).toMatch(/hint: .*codex logout && codex login/)
    expect(receiptFailure(1, null, classifyAdvisorFailure(r))).toBe("auth_failed")
    expect(receiptFailure(-1, null, classifyAdvisorFailure(run({ exitCode: -1, timedOut: true })))).toBe("timed_out")
    expect(receiptFailure(2, null, null)).toBe("nonzero_exit")
  })
})

// Item #8 (reduced after Codex review): fences are skipped for coverage scoring only; a bare
// prose path resolves against the unit's own files when exactly one ends with it.
import { directiveSentences, checkCitations } from "../src/lib/preflight.js"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("preflight noise", () => {
  it("fenced JSON is not scored as directive prose, but surrounding sentences are", () => {
    const d = "#### u1\n- Emit the OracleCheck result per run.\n\n```foreman-contract\n{\"unit\":\"u1\",\"claims\":[],\"smoke\":null}\n```\nTest: go test ./..."
    const s = directiveSentences(d)
    expect(s.some((x) => x.includes("OracleCheck"))).toBe(true)
    expect(s.some((x) => x.includes("\"unit\""))).toBe(false)
  })

  it("a fenced citation is still checked", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-cite-"))
    try {
      const r = await checkCitations(root, "```\nRead src/nonexistent_review_target.ts:99\n```", [], [])
      expect(r.find((c) => c.raw.startsWith("src/nonexistent"))?.status).toBe("dead")
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })

  it("a bare prose path resolves when exactly one listed file ends with it; two stay ambiguous", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-path-"))
    try {
      await fsp.mkdir(path.join(root, "Observability", "Checks"), { recursive: true })
      await fsp.mkdir(path.join(root, "Legacy", "Checks"), { recursive: true })
      await fsp.writeFile(path.join(root, "Observability", "Checks", "OracleCheck.cs"), "class X {}\n")
      await fsp.writeFile(path.join(root, "Legacy", "Checks", "OracleCheck.cs"), "class Y {}\n")
      const one = await checkCitations(root, "Update Checks/OracleCheck.cs to emit the result.", [], ["Observability/Checks/OracleCheck.cs"])
      expect(one[0]).toMatchObject({ status: "ok" })
      expect(one[0].detail).toContain("Observability/Checks/OracleCheck.cs")
      const two = await checkCitations(root, "Update Checks/OracleCheck.cs to emit the result.", [], ["Observability/Checks/OracleCheck.cs", "Legacy/Checks/OracleCheck.cs"])
      expect(two[0]).toMatchObject({ status: "dead" })
      expect(two[0].detail).toContain("ambiguous")
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

// 0.6.36 (field report 2026-09-27): a linked correction brief is not scored for directive coverage.
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { preflightPathFor } from "../src/lib/preflight.js"
import { writeLedger } from "../src/lib/ledger.js"

describe("correction briefs and directive coverage", () => {
  it("skips coverage only for an attempt the ledger holds, and still checks symbols", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-corr-"))
    try {
      const ledger = path.join(root, "Docs", "ledger.json")
      const spec = path.join(root, "Docs", "spec.md")
      await fsp.mkdir(path.join(root, "Docs"), { recursive: true })
      await fsp.writeFile(spec, "#### u1 — parser\n- Parse the header with `parseHeader` and reject empty names.\n- Emit one metric per request with its latency.\n")
      const pf = (extra: Record<string, unknown>) => preflightCheck({ phase: "p1", unit_id: "u1", brief: "Fix the assertion in the header test to expect the rejection.", symbols: ["parseHeader"], repo_root: root, spec_path: "Docs/spec.md", ...extra }, preflightPathFor(ledger), ledger, spec)
      const refused = await pf({ correcting_attempt: 1 })
      expect(refused).toContain("status: refused")
      await writeLedger(ledger, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: "Implement the parser unit as the spec says.", preflight: { symbols_grepped: 1, self_consistent: true } } } as never)
      const scored = await pf({})
      expect(scored).toContain("coverage_ratio:")
      const corr = await pf({ correcting_attempt: 1 })
      expect(corr).toContain("coverage: n/a (correction of attempt #1")
      expect(corr).not.toContain("NO ECHO")
      expect(await pf({ correcting_attempt: 1, symbols: ["notInSpec"] })).toContain("status: fail")
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

// 0.6.39 (field report 2026-09-27, item 5): the refusal named the rank while the phase's
// security_boundary would have refused any correction; and claude-opus-5-5 resolved to unknown.
import { resolveModelRank } from "../src/lib/modelRank.js"

describe("correction refusals name the real cause", () => {
  it("claude-opus-5-5 is middle rank", () => {
    expect(resolveModelRank("claude-opus-5-5").weight).toBe(2)
  })

  it("a security_boundary phase refuses a correction before the rank check", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-sec-"))
    try {
      const ledger = path.join(root, "ledger.json")
      const w = (op: Record<string, unknown>, rank = resolveModelRank("sonnet")) =>
        writeLedger(ledger, op as never, undefined, undefined, "claude-code", rank)
      await w({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: false, has_build: true, security_boundary: true } })
      await w({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: "Implement the unit as the spec says.", preflight: { symbols_grepped: 1, self_consistent: true } } })
      await expect(w({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
        s: "delegated", brief: "Fix the assertion in the unit test.", preflight: { symbols_grepped: 1, self_consistent: true },
        correction: { kind: "bounded", from_attempt: 1, files: ["a.ts"] } } })).rejects.toThrow(/security_boundary phases require the normal workflow/)
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })
})

// 0.7.0 (field report 2026-09-28): a brief naming the TYPE TestOpts failed preflight as a dead
// test citation. Exempt only names in `symbols` that the server spec names as whole words, and
// only where the brief does not use them as a test.
import { specNamedTestSymbols, inTestPosition, extractCitations } from "../src/lib/preflight.js"

describe("test-shaped type names in a brief", () => {
  const brief = "Add a Timeout field to the TestOptions struct the runner reads."
  it("the field case passes when symbols lists it and the spec names it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-testopts-"))
    try {
      const names = specNamedTestSymbols(["TestOptions"], "Unit u1: extend `TestOptions` with Timeout.")
      const r = await checkCitations(root, brief, [], [], names)
      expect(r.find((c) => c.raw === "TestOptions")).toMatchObject({ status: "ok" })
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })

  it("stays dead when the spec only contains it inside a longer word, or symbols omit it", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-testopts-"))
    try {
      expect(specNamedTestSymbols(["TestOptions"], "OldTestOptionsLegacy is removed")).toEqual(new Set())
      const r = await checkCitations(root, brief, [], [], specNamedTestSymbols([], "TestOptions"))
      expect(r.find((c) => c.raw === "TestOptions")).toMatchObject({ status: "dead" })
    } finally { await fsp.rm(root, { recursive: true, force: true }) }
  })

  it("a name used as a test in the brief is still checked as a test", () => {
    expect(inTestPosition("Add func TestOptions(t *testing.T) for the runner.", "TestOptions")).toBe(true)
    expect(inTestPosition("Call TestOptions() in setup.", "TestOptions")).toBe(true)
    expect(inTestPosition(brief, "TestOptions")).toBe(false)
  })

  it("a file path is not also read as a test name", () => {
    const c = extractCitations("Update tests/test_config_loader.py to cover the empty case.")
    expect(c.map((x) => x.kind)).toEqual(["file"])
  })
})

// 0.7.0 (Codex review): test positions the first exemption missed, and containment that
// follows links instead of trusting the lexical path.
import { forwardUnmet, normalizeObligations } from "../src/lib/preflight.js"

describe("test positions in context", () => {
  it("test vocabulary, renames and outcomes reach every name in a list", () => {
    expect(inTestPosition("Tests TestAlpha and TestBravo cover retries.", "TestBravo")).toBe(true)
    expect(inTestPosition("Tests TestAlpha and TestBravo cover retries.", "TestAlpha")).toBe(true)
    expect(inTestPosition("Rename TestBefore to TestAfter.", "TestBefore")).toBe(true)
    expect(inTestPosition("Rename TestBefore to TestAfter.", "TestAfter")).toBe(true)
    expect(inTestPosition("TestAlpha, TestBravo fail today.", "TestAlpha")).toBe(true)
    expect(inTestPosition("Make sure TestAlpha passes.", "TestAlpha")).toBe(true)
  })

  it("a constructor, a type mention, or a parenthesis on the next line is not a test", () => {
    expect(inTestPosition("Build it with new TestOptions() and pass it in.", "TestOptions")).toBe(false)
    expect(inTestPosition("Extend TestOptions.\n(the runner reads it)", "TestOptions")).toBe(false)
    expect(inTestPosition("The TestOptions struct gains Timeout. Tests stay green.", "TestOptions")).toBe(false)
  })
})

describe("preflight containment follows links", () => {
  it("a junction inside the root to a directory outside is an escape; '..fixtures' is not", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-out-"))
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fr-root-"))
    try {
      await fsp.writeFile(path.join(outside, "secret.go"), "package x\n")
      await fsp.symlink(outside, path.join(root, "link"), "junction")
      await fsp.mkdir(path.join(root, "..fixtures"))
      await fsp.writeFile(path.join(root, "..fixtures", "data.go"), "package f\n")

      const r = await checkCitations(root, "Read link/secret.go and ..fixtures/data.go first.")
      expect(r.find((c) => c.raw.includes("secret.go"))).toMatchObject({ status: "dead", detail: "path escapes the repository root" })
      const fixture = r.find((c) => c.raw.includes("data.go"))
      expect(fixture).toBeDefined()
      expect(fixture?.status).not.toBe("dead")

      const unmet = await forwardUnmet(root, normalizeObligations([{ file: "link/new_test.go" }, { file: "..fixtures/new.go" }]))
      expect(unmet.join("\n")).toContain("link/new_test.go: escapes the repository root")
      expect(unmet.join("\n")).not.toContain("..fixtures/new.go: escapes")
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
      await fsp.rm(outside, { recursive: true, force: true })
    }
  })
})
