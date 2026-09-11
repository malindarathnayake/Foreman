// 0.6.24 (fifth field report + Codex deliberation, docs/codex-deliberation-2026-09-10-oracle.md):
// the verdict reads the attempt-frozen contract; the block is strict; digests cover complete
// bytes; deliverables are produced during the run, observed, evaluated and re-digested at the
// verdict; reviews cite the receipts they refer to; forward declarations are promises the
// verdict checks; -run selectors resolve as Go regexes; add_rejection stamps server time;
// a build failure is not a kill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { appendPreflight, checkCitations, extractCitations, findPreflight, preflightPathFor, testDeclared, forwardUnmet } from "../src/lib/preflight.js"
import { parseContracts, digestPaths, digestFile, evaluateDeliverable, selectValues, parseReference, MAX_DIGEST_FILES } from "../src/lib/specContract.js"
import { liveSmoke } from "../src/tools/liveSmoke.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { runOracle } from "../src/tools/verifyOracle.js"
import type { WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let specPath: string
const PLAN = { id: "emit", runner: "go", args: ["run", "./cmd/emit"], harness_files: ["cmd/emit/main.go"], input_files: ["internal"], checks: { stdout_contains: "ok" } }
const DELIVERABLE = { id: "map", path: "out/map.json", assertions: { max_bytes: 4096, json_array_length: { path: "rows", min: 1 }, values_in: { path: "rows[].country", reference: "Docs/countries.txt" } } }
const CONTRACT = { unit: "u1", claims: [], smoke: PLAN, deliverables: [DELIVERABLE] }
const SPEC = (contract: unknown = CONTRACT) => `# Spec\n\n#### u1 — map\n- Emit the country map to \`rows\`.\n\n\`\`\`foreman-contract\n${JSON.stringify(contract)}\n\`\`\`\n\n#### u2 — other\n- Nothing external.\n\n\`\`\`foreman-contract\n{"unit":"u2","claims":[],"smoke":null}\n\`\`\`\n`

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T22:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-oracle-"))
  ledgerPath = path.join(dir, "Docs", "ledger.json")
  specPath = path.join(dir, "Docs", "spec.md")
  for (const d of ["Docs", "cmd/emit", "internal", "out"]) await fs.mkdir(path.join(dir, d), { recursive: true })
  await fs.writeFile(specPath, SPEC())
  await fs.writeFile(path.join(dir, "cmd", "emit", "main.go"), "package main\n")
  await fs.writeFile(path.join(dir, "internal", "map.go"), "package internal\n")
  await fs.writeFile(path.join(dir, "Docs", "countries.txt"), "# ISO 3166-1 alpha-2, the ones we serve\nUS\nCA\nGB\n")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
const ctx = () => ({ specPath, projectRoot: dir })
async function write(operation: Record<string, unknown>) {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, "claude-code", undefined, undefined, ctx())
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const delegated = (unit_id = "u1", extra: Record<string, unknown> = {}) => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: `Implement ${unit_id} and emit the map with its tests`, preflight: { symbols_grepped: ["rows"], self_consistent: true }, ...extra,
} })
const pass = (unit_id = "u1", extra: Record<string, unknown> = {}) => ({ operation: "set_verdict", phase: "p1", unit_id, data: { v: "pass", ...extra } })
const unit = async (id = "u1") => (await readLedger(ledgerPath)).phases.p1.units[id]
/** A runner that writes the deliverable the way the real producer would. */
const emitting = (body: string, extraFile?: [string, string]) => async () => {
  await fs.writeFile(path.join(dir, "out", "map.json"), body)
  if (extraFile) await fs.writeFile(path.join(dir, extraFile[0]), extraFile[1])
  return "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n"
}
const GOOD = JSON.stringify({ rows: [{ country: "US", n: 1 }, { country: "CA", n: 2 }] })
const smoke = (runner: () => Promise<string>, unit_id = "u1") => liveSmoke({ phase: "p1", unit_id, plan_id: "emit" }, ledgerPath, specPath, dir, runner)
const runId = async () => (await unit()).smokes!.at(-1)!.run_id

describe("the contract block is strict and semantically checked", () => {
  it("refuses an unknown field instead of stripping it (a field the server does not enforce would digest the same)", () => {
    const r = parseContracts(SPEC({ ...CONTRACT, extra_rule: "ignored before 0.6.24" }))
    expect(r.contracts.has("u1")).toBe(false)
    expect(r.errors[0]).toMatch(/unit u1.*Unrecognized key/i)
    const nested = parseContracts(SPEC({ ...CONTRACT, smoke: { ...PLAN, retries: 3 } }))
    expect(nested.errors[0]).toMatch(/smoke.*Unrecognized key/i)
  })
  it("refuses a deliverable with nothing to observe, without a producer, inside input_files, or that is its own reference; a claim's array length needs a bound", () => {
    const err = (contract: unknown) => parseContracts(SPEC(contract)).errors.join(" | ")
    expect(err({ ...CONTRACT, deliverables: [{ id: "xx", path: "out/x.json", assertions: { min_bytes: 0 } }] })).toContain("declares no observable property")
    expect(err({ ...CONTRACT, deliverables: [{ id: "xx", path: "out/x.json", assertions: { json_array_length: { path: "rows" } } }] })).toContain("has no bound")
    expect(err({ ...CONTRACT, deliverables: [{ id: "xx", path: "out/x.json", assertions: { json_array_length: { path: "rows", exact: 2, min: 1 } } }] })).toContain("mixes exact with min/max")
    expect(err({ ...CONTRACT, smoke: null })).toContain("deliverables need a producer")
    expect(err({ ...CONTRACT, deliverables: [{ ...DELIVERABLE, path: "internal/map.json" }] })).toContain("inside input_files entry internal")
    expect(err({ ...CONTRACT, deliverables: [{ ...DELIVERABLE, path: "Docs/countries.txt" }] })).toContain("is itself a deliverable")
    expect(err({ ...CONTRACT, deliverables: [{ ...DELIVERABLE, path: "out/*.json" }] })).toContain("not a glob")
    expect(err({ unit: "u3", claims: [{ id: "cc", text: "eight chars", request: { url: "https://x.test/" }, assertions: { json_array_length: { path: "r" } } }], smoke: null })).toContain("claim cc: json_array_length on r has no bound")
    expect(parseContracts(SPEC({ ...CONTRACT, deliverables: [] })).contracts.get("u1")!.contract.deliverables).toEqual([])
  })
})

describe("digests cover complete bytes", () => {
  it("a same-size content swap in a large file changes the digest; a truncated inventory is reported; a link outside the root is missing", async () => {
    const big = path.join(dir, "internal", "big.bin")
    await fs.writeFile(big, Buffer.alloc(5 * 1024 * 1024, "a"))
    const a = await digestPaths(dir, ["internal"])
    await fs.writeFile(big, Buffer.alloc(5 * 1024 * 1024, "b"))
    const b = await digestPaths(dir, ["internal"])
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.truncated).toBe(false)
    const one = await digestFile(dir, "internal/big.bin")
    expect(one).toMatchObject({ exists: true, bytes: 5 * 1024 * 1024, problem: null })
    expect((await digestFile(dir, "../outside.txt")).problem).toContain("escapes")
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-outside-"))
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "x")
      try {
        await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "internal", "link.txt"), "file")
        const linked = await digestPaths(dir, ["internal/link.txt"])
        expect(linked.missing).toEqual(["internal/link.txt"])
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err   // symlink creation needs a privilege on some Windows hosts
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
    const many = path.join(dir, "many")
    await fs.mkdir(many)
    await Promise.all(Array.from({ length: MAX_DIGEST_FILES + 5 }, (_, i) => fs.writeFile(path.join(many, `f${i}.txt`), String(i))))
    expect((await digestPaths(dir, ["many"])).truncated).toBe(true)
  }, 30000)
})

describe("deliverable evaluation", () => {
  const refs = new Map([["Docs/countries.txt", parseReference("US\nCA\n# c\n\nGB\n")]])
  it("selects across records, fails a missing field, a non-string leaf, an empty selection, and names values outside the reference", () => {
    expect(selectValues(GOOD, "rows[].country")).toEqual({ values: ["US", "CA"], error: null })
    expect(selectValues(JSON.stringify({ rows: [{ country: "US" }, {}] }), "rows[].country").error).toBe("rows[1].country is absent")
    expect(selectValues(JSON.stringify({ rows: [{ country: 1 }] }), "rows[].country").error).toContain("not a string")
    expect(selectValues(JSON.stringify({ rows: [] }), "rows[].country").error).toContain("empty selection")
    expect(selectValues(JSON.stringify({ codes: ["US", "GB"] }), "codes")).toEqual({ values: ["US", "GB"], error: null })
    const zz = JSON.stringify({ rows: [{ country: "ZZ" }, { country: "QQ" }, { country: "US" }, { country: "ZZ" }] })
    expect(evaluateDeliverable(Buffer.from(zz), DELIVERABLE.assertions, refs)).toEqual(["values_in: 2 value(s) at rows[].country not in Docs/countries.txt: ZZ, QQ"])
    expect(evaluateDeliverable(Buffer.from(GOOD), DELIVERABLE.assertions, refs)).toEqual([])
    expect(evaluateDeliverable(Buffer.from(GOOD), { max_bytes: 10 }, refs)).toEqual([`${Buffer.byteLength(GOOD)} bytes (expected at most 10)`])
    expect(evaluateDeliverable(Buffer.from(GOOD), { values_in: { path: "rows[].country", reference: "Docs/none.txt" } }, refs)).toEqual(["values_in: reference Docs/none.txt is unreadable"])
  })
})

describe("the verdict reads the attempt-frozen contract", () => {
  it("smoke: null written after delegation does not lift the gate; the digest and the reference digests are frozen on the attempt", async () => {
    await write(delegated())
    const d = (await unit()).delegations!.at(-1)!
    expect(d.contract_sha256).toMatch(/^[0-9a-f]{16}$/)
    expect(d.references).toEqual({ "Docs/countries.txt": expect.stringMatching(/^[0-9a-f]{16}$/) })
    await fs.writeFile(specPath, SPEC({ unit: "u1", claims: [], smoke: null }))
    await expect(write(pass())).rejects.toThrow(/CONTRACT CHANGED: unit 'u1' attempt #1 was delegated under spec contract [0-9a-f]{16} and that contract changed/)
    await fs.writeFile(specPath, "#### u1 — map\n- no block any more\n")
    await expect(write(pass())).rejects.toThrow(/that contract was removed from the spec/)
    await fs.writeFile(specPath, SPEC())
    await expect(write(pass())).rejects.toThrow(/SMOKE REQUIRED: unit 'u1' cannot pass in phase 'p1': no live_smoke run for attempt #1 \(plan 'emit'\)/)
    await write(pass("u1", { user_override: true }))
    expect((await unit()).cap_override?.waived).toEqual(["smoke"])
  })
  it("a delegation refuses an invalid block and a missing reference file", async () => {
    await fs.writeFile(specPath, SPEC({ ...CONTRACT, bogus: 1 }))
    await expect(write(delegated())).rejects.toThrow(/CONTRACT INVALID/)
    await fs.writeFile(specPath, SPEC())
    await fs.rm(path.join(dir, "Docs", "countries.txt"))
    await expect(write(delegated())).rejects.toThrow(/CONTRACT REFERENCE: .*Docs\/countries.txt/)
  })
})

describe("live_smoke observes deliverables", () => {
  it("refuses a pre-existing deliverable, records the produced bytes and their evaluation, and the verdict recomputes them", async () => {
    await write(delegated())
    await fs.writeFile(path.join(dir, "out", "map.json"), GOOD)
    expect(await smoke(emitting(GOOD))).toContain("deliverable_present_before")
    await fs.rm(path.join(dir, "out", "map.json"))
    const notProduced = await smoke(async () => "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n")
    expect(notProduced).toContain("deliverable map: not produced by the run")
    await expect(write(pass())).rejects.toThrow(/the newest live_smoke for attempt #1 failed \(deliverable map: not produced by the run\)/)
    const zz = await smoke(emitting(JSON.stringify({ rows: [{ country: "ZZ" }, { country: "US" }] })))
    expect(zz).toContain("status: fail")
    expect(zz).toContain("not in Docs/countries.txt: ZZ")
    await fs.rm(path.join(dir, "out", "map.json"))
    const ok = await smoke(emitting(GOOD))
    expect(ok).toContain("status: pass")
    expect(ok).toMatch(/deliverables: map=[0-9a-f]{16} \(\d+ bytes, pass\)/)
    const receipt = (await unit()).smokes!.at(-1)!
    expect(receipt.deliverables![0]).toMatchObject({ id: "map", path: "out/map.json", passed: true })
    expect(receipt.references).toEqual((await unit()).delegations!.at(-1)!.references)
    // edited after the smoke: the verdict sees it
    await fs.writeFile(path.join(dir, "out", "map.json"), GOOD + "\n")
    await expect(write(pass())).rejects.toThrow(/deliverable 'map' \(out\/map.json\) changed since the smoke observed it/)
    await fs.writeFile(path.join(dir, "out", "map.json"), GOOD)
    await write(pass())
    expect((await unit()).v).toBe("pass")
  })
  it("a reference rewritten after delegation is refused by the smoke and by the verdict; an oversized deliverable fails", async () => {
    await write(delegated())
    await fs.appendFile(path.join(dir, "Docs", "countries.txt"), "ZZ\n")
    expect(await smoke(emitting(GOOD))).toContain("reference_changed")
    await fs.writeFile(path.join(dir, "Docs", "countries.txt"), "# ISO 3166-1 alpha-2, the ones we serve\nUS\nCA\nGB\n")
    await fs.rm(path.join(dir, "out", "map.json"), { force: true })
    expect(await smoke(emitting(GOOD))).toContain("status: pass")
    await fs.appendFile(path.join(dir, "Docs", "countries.txt"), "ZZ\n")
    await expect(write(pass())).rejects.toThrow(/values_in reference changed since delegation: Docs\/countries.txt/)
    await fs.writeFile(specPath, SPEC({ ...CONTRACT, deliverables: [{ id: "map", path: "out/map.json", assertions: { max_bytes: 20 } }] }))
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    await write(delegated())
    await fs.rm(path.join(dir, "out", "map.json"), { force: true })
    const big = await smoke(emitting(GOOD))
    expect(big).toContain("expected at most 20")
  })
  it("a truncated inventory refuses the run; a unit with an empty deliverable list needs the plan only", async () => {
    await fs.writeFile(specPath, SPEC({ ...CONTRACT, deliverables: [] }))
    await write(delegated())
    expect(await smoke(async () => "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n")).toContain("deliverables: none declared")
    await write(pass())
    const many = path.join(dir, "internal", "many")
    await fs.mkdir(many)
    await Promise.all(Array.from({ length: MAX_DIGEST_FILES + 5 }, (_, i) => fs.writeFile(path.join(many, `f${i}.txt`), String(i))))
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    await write(delegated())
    expect(await smoke(async () => "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n")).toContain("inventory_incomplete")
  }, 30000)
})

describe("reviews cite the receipts they refer to", () => {
  const review = (extra: Record<string, unknown> = {}) => ({ operation: "record_review", phase: "p1", data: { advisor: "gemini", findings: [], completion: "complete", checked: ["out/map.json"], ...extra } })
  it("a record that can carry the gate must cite the newest passing receipt of every covered unit with deliverables; the gate refuses a stale citation", async () => {
    await write(delegated())
    await expect(write(review())).rejects.toThrow(/DELIVERABLES: .*u1 \(no passing live_smoke for attempt #1 yet\)/)
    await smoke(emitting(GOOD))
    const first = await runId()
    await expect(write(review())).rejects.toThrow(new RegExp(`u1 \\(run_id ${first}\\)`))
    await expect(write(review({ smoke_receipts: ["0000000000000000"] }))).rejects.toThrow(/SMOKE RECEIPTS: no live_smoke run in phase 'p1' has id 0000000000000000/)
    await expect(write(review({ stage: "cross_exam", smoke_receipts: [first] }))).rejects.toThrow(/accepted on records that can carry the gate/)
    // a scoped record on u2 only needs nothing: u2 declares no deliverables
    await write(delegated("u2"))
    await write(pass("u2"))
    await write(review({ units: ["u2"] }))
    await write(pass())
    await write(review({ smoke_receipts: [first] }))
    expect((await readLedger(ledgerPath)).phases.p1.reviews!.at(-1)!.smoke_receipts).toEqual([first])
    // a newer smoke on the same attempt, after the review, moves the bytes the review referred to
    await fs.rm(path.join(dir, "out", "map.json"))
    await smoke(emitting(GOOD))
    const second = await runId()
    expect(second).not.toBe(first)
    await expect(write(review({ smoke_receipts: [first] }))).rejects.toThrow(new RegExp(`u1 \\(run_id ${second}\\)`))
    await expect(write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })).rejects.toThrow(new RegExp(`DELIVERABLES: phase 'p1' .*u1 \\(run_id ${second}\\)`))
    await write(review({ smoke_receipts: [second] }))
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
    expect((await readLedger(ledgerPath)).phases.p1.g).toBe("pass")
  })
})

describe("forward declarations and -run selectors", () => {
  const GO_SPEC = "#### u1 — map\n- Emit the map; test with `go test -run TestMapNormalises ./internal/...` and `TestMapRejectsUnknown`.\n"
  it("citations of promised files and tests are forward, a test in a comment is not a declaration, and the verdict checks the promise", async () => {
    await fs.writeFile(specPath, GO_SPEC)
    const brief = "Create internal/map_test.go with TestMapNormalises and TestMapRejectsUnknown; run go test -run TestMapNormalises ./internal/..."
    const args = { phase: "p1", unit_id: "u1", brief, symbols: ["map"], repo_root: dir, spec_path: "Docs/spec.md", files: ["internal/map.go", "internal/map_test.go"] }
    const dead = await preflightCheck(args, preflightPathFor(ledgerPath), ledgerPath, specPath)
    expect(dead).toContain("status: fail")
    expect(dead).toContain("DEAD CITATIONS")
    expect(dead).toContain("list it under creates")
    const creates = [{ file: "internal/map_test.go", tests: ["TestMapNormalises", "TestMapRejectsUnknown"] }]
    const fwd = await preflightCheck({ ...args, creates }, preflightPathFor(ledgerPath), ledgerPath, specPath)
    expect(fwd).toContain("status: pass")
    expect(fwd).toContain("forward_citations: 4")
    expect(fwd).toContain("FORWARD CITATIONS")
    const hash = /brief_hash: ([0-9a-f]{16})/.exec(fwd)![1]
    expect((await findPreflight(preflightPathFor(ledgerPath), hash, "u1", "p1"))!.forward).toEqual(creates)
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief, preflight: { symbols_grepped: ["map"], self_consistent: true, receipt: hash } } })
    expect((await unit()).delegations!.at(-1)!.forward).toEqual(creates)
    await expect(write(pass())).rejects.toThrow(/FORWARD CITATIONS UNMET: .*internal\/map_test.go: not created/)
    await fs.writeFile(path.join(dir, "internal", "map_test.go"), "package internal\n// TODO TestMapRejectsUnknown\nfunc TestMapNormalises(t *testing.T) {}\n")
    await expect(write(pass())).rejects.toThrow(/TestMapRejectsUnknown is not declared there \(a comment, call or reference does not count\)/)
    await fs.writeFile(path.join(dir, "internal", "map_test.go"), "package internal\nfunc TestMapNormalises(t *testing.T) {}\nfunc TestMapRejectsUnknown(t *testing.T) {}\n")
    await write(pass())
    expect((await unit()).v).toBe("pass")
  })
  it("a later attempt carries the promise; the override is recorded", async () => {
    await fs.writeFile(specPath, "#### u1 — map\n- no contract block in this test\n")
    await write(delegated("u1"))
    // the ledger looks the record up by the brief's hash: write the record for a brief we control
    const brief = "Implement u1 with internal/new_test.go and TestNew as promised"
    const { briefHash } = await import("../src/lib/preflight.js")
    await appendPreflight(preflightPathFor(ledgerPath), { v: 1, ts: "t", phase: "p1", unit_id: "u1", brief_hash: briefHash(brief), status: "pass", symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0, forward: [{ file: "internal/new_test.go", tests: ["TestNew"] }] })
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief, preflight: { symbols_grepped: ["x"], self_consistent: true, receipt: briefHash(brief) } } })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    const again = "Second attempt on u1 after the failure, same files"
    await appendPreflight(preflightPathFor(ledgerPath), { v: 1, ts: "t", phase: "p1", unit_id: "u1", brief_hash: briefHash(again), status: "pass", symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0 })
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: again, preflight: { symbols_grepped: ["x"], self_consistent: true, receipt: briefHash(again) } } })
    expect((await unit()).delegations!.at(-1)!.forward).toEqual([{ file: "internal/new_test.go", tests: ["TestNew"] }])
    await expect(write(pass())).rejects.toThrow(/FORWARD CITATIONS UNMET/)
    await write(pass("u1", { user_override: true }))
    expect((await unit()).cap_override?.waived).toEqual(["forward"])
  })
  it("-run operands resolve as Go regexes against declarations; anchored forms stay anchored; matches are reported", async () => {
    await fs.writeFile(path.join(dir, "internal", "map_test.go"), "package internal\nfunc TestMapNormalisesCountry(t *testing.T) {}\nfunc TestMapNormalisesRegion(t *testing.T) {}\n")
    const cites = extractCitations("run go test -run TestMapNormalises ./internal/... then -run '^TestMapNormalisesCountry$' and -run=TestOther/sub; also TestMapNormalisesRegion is cited plainly")
    expect(cites.map((c) => [c.kind, c.raw])).toEqual([
      ["test_selector", "-run TestMapNormalises"], ["test_selector", "-run '^TestMapNormalisesCountry$'"], ["test_selector", "-run=TestOther/sub"], ["test_name", "TestMapNormalisesRegion"],
    ])
    const checked = await checkCitations(dir, "go test -run TestMapNormalises ./internal/... and -run '^TestMapNormalises$' and -run TestOther and -run '(' plus TestMapNormalisesRegion")
    expect(checked.map((c) => [c.raw, c.status, c.detail])).toEqual([
      ["-run TestMapNormalises", "ok", "matches TestMapNormalisesCountry, TestMapNormalisesRegion"],
      ["-run '^TestMapNormalises$'", "dead", "no func Test… declaration under the root matches this selector; declare it under creates if the unit adds it"],
      ["-run TestOther", "dead", "no func Test… declaration under the root matches this selector; declare it under creates if the unit adds it"],
      ["-run '('", "dead", "'(' is not a valid regular expression"],
      ["TestMapNormalisesRegion", "ok", "defined or referenced in internal/map_test.go"],
    ])
    const promised = await checkCitations(dir, "-run TestOther", [{ file: "internal/other_test.go", tests: ["TestOtherThing"] }])
    expect(promised[0].status).toBe("forward")
    expect(testDeclared("func TestX(t *testing.T) {}", "TestX", "a_test.go")).toBe(true)
    expect(testDeclared("// func TestX(t *testing.T) {}", "TestX", "a_test.go")).toBe(false)
    expect(testDeclared("def test_thing():\n  pass\n", "test_thing", "test_a.py")).toBe(true)
    expect(testDeclared("it(\"handles ZZ\", () => {})", "handles ZZ", "a.test.ts")).toBe(true)
    expect(await forwardUnmet(dir, [{ file: "internal/map_test.go", tests: ["TestMapNormalisesCountry", "TestNope"] }])).toEqual(["internal/map_test.go: TestNope is not declared there (a comment, call or reference does not count)"])
  })
})

describe("small frictions", () => {
  it("add_rejection stamps server time when ts is absent and keeps a reported one", async () => {
    await write(delegated())
    const before = new Date().toISOString()
    await write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "gemini", msg: "the map admits ZZ" } })
    expect((await unit()).rej![0].ts).toBe(before)
    await write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "gemini", msg: "again", ts: "reported-by-caller" } })
    expect((await unit()).rej![1].ts).toBe("reported-by-caller")
  })
  it("verify_oracle: a mutation that breaks the build is invalid, not a kill", async () => {
    await fs.writeFile(path.join(dir, "internal", "map.go"), "package internal\nfunc keep() bool { return true }\n")
    let applied = false
    const runner = async () => {
      const src = await fs.readFile(path.join(dir, "internal", "map.go"), "utf-8")
      applied = src.includes("return tru")
      return applied
        ? "exit_code: 1\npassed: false\ntimed_out: false\nSTDOUT\n# internal\ninternal/map.go:2:28: undefined: tru\nFAIL\tinternal [build failed]\n"
        : "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n"
    }
    const report = await runOracle({ phase: "p1", unit_id: "u1", repo_root: dir, mutations: [{ label: "typo", file: "internal/map.go", old: "return true", new: "return tru", runner: "go", args: ["test", "./internal/..."] }], timeout_ms: 5000 } as never, runner)
    expect(report.results[0]).toMatchObject({ outcome: "invalid" })
    expect(report.results[0].detail).toContain("did not build")
  })
})
