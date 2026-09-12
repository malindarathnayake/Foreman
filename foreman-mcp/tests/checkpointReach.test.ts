// 0.6.25 (sixth field report + Codex deliberation, docs/codex-deliberation-2026-09-11-reach.md):
// the checkpoint is frozen from the server's spec; a Go package selection that omits the
// owning package of an authorized file refuses; opaque clauses block refusal; the verdict
// re-checks the frozen definition over the guard's authorized set; a direct fix inherits
// the newest delegation's frozen obligations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, recordRepoGuard, writeLedger } from "../src/lib/ledger.js"
import { appendPreflight, briefHash, preflightPathFor } from "../src/lib/preflight.js"
import { checkpointFromSpec, checkpointReach, classifyClause, owningPackage, parseCheckpointLines, parseClauses } from "../src/lib/checkpoint.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import type { RepoSnapshot, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let specPath: string
const FILES = "internal/web/handlers/testdata/a.golden, internal/web/handlers/testdata/b.golden, internal/web/handlers/render.go"
const SPEC = (test = "go test ./internal/ops/ && go test ./internal/cfsource/graphql/", files = FILES) =>
  `# Spec\n\n#### p11.8 — goldens\n- Files: ${files}\n- Regenerate the goldens with \`render\`.\nTest: ${test}\n\n#### p11.9 — other\n- Files: internal/ops/x.go\n- Nothing here.\nTest: go test ./internal/ops/\n`

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-11T09:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-reach-"))
  ledgerPath = path.join(dir, "Docs", "ledger.json")
  specPath = path.join(dir, "Docs", "spec.md")
  for (const d of ["Docs", "internal/web/handlers/testdata", "internal/ops", "internal/cfsource/graphql", "plugins/payments"]) await fs.mkdir(path.join(dir, d), { recursive: true })
  await fs.writeFile(specPath, SPEC())
  await fs.writeFile(path.join(dir, "internal", "web", "handlers", "render.go"), "package handlers\n")
  await fs.writeFile(path.join(dir, "go.mod"), "module example.test\n")
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
const delegated = (unit_id = "p11.8", extra: Record<string, unknown> = {}) => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: `Regenerate the goldens for ${unit_id} with render and its tests`, preflight: { symbols_grepped: ["render"], self_consistent: true }, ...extra,
} })
const pass = (unit_id = "p11.8", extra: Record<string, unknown> = {}) => ({ operation: "set_verdict", phase: "p1", unit_id, data: { v: "pass", ...extra } })
const unit = async (id = "p11.8") => (await readLedger(ledgerPath)).phases.p1.units[id]
const snapshot = (allowed: string[], hash = "b1"): RepoSnapshot => ({ root: dir, branch: "main", head: "h", stash_ref: "none", stash_count: 0, autocrlf: "false", eol: [], entries: [], truncated: false, allowed, hash })

describe("parsing the checkpoint", () => {
  it("reads Files and Test lines, splits clauses, and classifies go test selectors; everything else is opaque", () => {
    expect(parseCheckpointLines("- Files: a/b.go, `c/d.go` e/testdata/f.golden\nTest: go test ./a/...\n**Checkpoint:** `go test ./c/`\n")).toEqual({ files: ["a/b.go", "c/d.go", "e/testdata/f.golden"], commands: ["go test ./a/...", "go test ./c/"] })
    const [a, b] = parseClauses("go test ./internal/ops/ && go test -run 'TestX' -count=1 -coverprofile ./out/c.out ./internal/cfsource/graphql/...")
    expect(a).toMatchObject({ kind: "go_test", cwd: "", selectors: [{ dir: "internal/ops", recursive: false }], filters: [] })
    expect(b).toMatchObject({ kind: "go_test", selectors: [{ dir: "internal/cfsource/graphql", recursive: true }], filters: ["-run TestX"] })
    expect(classifyClause("go -C services/api test ./internal/auth")).toMatchObject({ kind: "go_test", cwd: "services/api", selectors: [{ dir: "internal/auth", recursive: false }] })
    expect(classifyClause("go test ./...")).toMatchObject({ kind: "go_test", selectors: [{ dir: "", recursive: true }] })
    expect(classifyClause("go test")).toMatchObject({ kind: "go_test", selectors: [{ dir: "", recursive: false }] })
    expect(classifyClause("go test -c ./internal/auth").kind).toBe("opaque")
    expect(classifyClause("go vet ./internal/auth").reason).toContain("selects paths without running tests")
    expect(classifyClause("go test example.test/internal/auth").reason).toContain("import path")
    expect(classifyClause("go test ./internal/auth/x_test.go").reason).toContain("names a file")
    expect(classifyClause("npm test").reason).toContain("not go test")
    expect(parseClauses("go test ./a | tee log")[0].reason).toContain("pipe")
    expect(owningPackage("internal/web/handlers/testdata/x.golden")).toBe("internal/web/handlers")
    expect(owningPackage("internal/web/handlers/testdata/deep/x.golden")).toBe("internal/web/handlers")
    expect(owningPackage("internal/web/handlers/render.go")).toBe("internal/web/handlers")
    expect(owningPackage("Docs/spec.md")).toBeNull()
    expect(owningPackage("config/app.yaml")).toBeNull()
    expect(checkpointFromSpec(SPEC(), "p11.8").def!.digest).toMatch(/^[0-9a-f]{16}$/)
    // 0.6.26: the three causes of an absent definition are distinguished, not collapsed to null.
    expect(checkpointFromSpec("#### u9 — no test line\n- Files: a.go\n", "u9")).toEqual({ def: null, absence: "no_test_line" })
    expect(checkpointFromSpec("#### u9 — no test line\n- Files: a.go\n", "u404")).toEqual({ def: null, absence: "unit_not_found" })
  })
  it("reach: the p11.8 omission; exact vs recursive; nested modules; -C; opaque blocks; unclassified reported", async () => {
    const def = (test: string) => checkpointFromSpec(SPEC(test), "p11.8").def!
    const files = FILES.split(", ")
    const omitted = await checkpointReach(dir, def("go test ./internal/ops/ && go test ./internal/cfsource/graphql/"), files)
    expect(omitted.status).toBe("omitted")
    expect(omitted.omitted.map((o) => o.pkg)).toEqual(["internal/web/handlers", "internal/web/handlers", "internal/web/handlers"])
    expect((await checkpointReach(dir, def("go test ./internal/web/handlers/"), files)).status).toBe("ok")
    expect((await checkpointReach(dir, def("go test ./internal/web/..."), files)).status).toBe("ok")
    expect((await checkpointReach(dir, def("go test ./internal/web/"), files)).status).toBe("omitted")
    expect((await checkpointReach(dir, def("go test ./..."), files)).status).toBe("ok")
    // a nested module is not selected by ./...
    await fs.writeFile(path.join(dir, "plugins", "payments", "go.mod"), "module example.test/plugins/payments\n")
    const nested = await checkpointReach(dir, def("go test ./..."), ["plugins/payments/check.go"])
    expect(nested.status).toBe("omitted")
    expect((await checkpointReach(dir, def("go test ./plugins/payments/"), ["plugins/payments/check.go"])).status).toBe("ok")
    // -C resolves selectors under the subdirectory
    expect((await checkpointReach(dir, def("go -C internal test ./web/handlers/"), files)).status).toBe("ok")
    // an opaque clause blocks any refusal; a -run filter is reported, not inferred against
    const opaque = await checkpointReach(dir, def("go test ./internal/ops/ && npm test"), files)
    expect(opaque.status).toBe("unknown")
    expect(opaque.opaque[0]).toContain("npm test")
    const filtered = await checkpointReach(dir, def("go test -run '^TestRender$' ./internal/web/handlers/"), files)
    expect(filtered).toMatchObject({ status: "ok", filters: ["-run ^TestRender$"] })
    // files with no owning package are reported, never refused; a Markdown fixture under testdata IS classified
    const mixed = await checkpointReach(dir, def("go test ./internal/web/handlers/"), ["Docs/spec.md", "internal/web/handlers/testdata/response.md"])
    expect(mixed).toMatchObject({ status: "ok", unclassified: ["Docs/spec.md"] })
    expect((await checkpointReach(dir, def("go test ./internal/ops/"), ["internal/web/handlers/testdata/response.md"])).status).toBe("omitted")
  })
})

describe("preflight_check reports reach from the server's spec", () => {
  const pf = (extra: Record<string, unknown> = {}) => preflightCheck({ phase: "p1", unit_id: "p11.8", brief: "Regenerate the goldens with `render` and keep the handlers tests green.", symbols: ["render"], repo_root: dir, spec_path: "Docs/spec.md", ...extra }, preflightPathFor(ledgerPath), ledgerPath, specPath)
  it("fails on the p11.8 omission as a reach-only failure, passes once the Test line selects the package, and ignores a caller directive that says otherwise", async () => {
    const text = await pf()
    expect(text).toContain("status: fail")
    expect(text).toContain("checkpoint_reach: REACH: internal/web/handlers/testdata/a.golden maps to package internal/web/handlers")
    expect(text).toContain("This is a package-selection check; cross-package readers and assertion coverage are not inferred.")
    expect(text).toContain("reach is the only failure here")
    // the caller's directive text cannot widen the checkpoint
    const lied = await pf({ directive: "Regenerate the goldens with `render`.\nTest: go test ./..." })
    expect(lied).toContain("checkpoint_reach: REACH")
    await fs.writeFile(specPath, SPEC("go test ./internal/web/handlers/ && go test ./internal/ops/"))
    const ok = await pf()
    expect(ok).toContain("status: pass")
    expect(ok).toContain("checkpoint_reach: ok: every authorized Go package or testdata fixture is selected by go test ./internal/web/handlers/ && go test ./internal/ops/")
    // the call's files widen the scope checked
    const wider = await pf({ files: ["internal/cfsource/graphql/client.go"] })
    expect(wider).toContain("checkpoint_reach: REACH: internal/cfsource/graphql/client.go maps to package internal/cfsource/graphql")
    await fs.writeFile(specPath, SPEC("make test"))
    expect(await pf()).toContain("checkpoint_reach: unknown: make test")
  })
})

describe("the delegation freezes the checkpoint and refuses an omission", () => {
  it("refuses CHECKPOINT REACH, delegates with the owner override recorded, and freezes the definition", async () => {
    await expect(write(delegated())).rejects.toThrow(/CHECKPOINT REACH: unit 'p11.8': internal\/web\/handlers\/testdata\/a.golden maps to package internal\/web\/handlers.*no declared go test selector includes \(go test \.\/internal\/ops\/ && go test \.\/internal\/cfsource\/graphql\/\)/)
    await write(delegated("p11.8", { user_override: true }))
    const d = (await unit()).delegations!.at(-1)!
    expect(d.checkpoint).toMatchObject({ reach: "omitted", commands: ["go test ./internal/ops/ && go test ./internal/cfsource/graphql/"], reach_override: { files: FILES.split(", ").filter((f) => f.includes("handlers")) } })
    expect(d.checkpoint!.omitted).toHaveLength(3)
    // p11.9 selects its own package: no refusal, reach ok
    await write({ operation: "set_verdict", phase: "p1", unit_id: "p11.8", data: { v: "fail" } })
    await write(delegated("p11.9"))
    expect((await unit("p11.9")).delegations!.at(-1)!.checkpoint).toMatchObject({ reach: "ok", files: ["internal/ops/x.go"] })
  })
  it("a reach-only preflight record is consumable with the override; any other failure still refuses", async () => {
    const brief = "Regenerate the goldens with `render` and keep the handlers tests green."
    const text = await preflightCheck({ phase: "p1", unit_id: "p11.8", brief, symbols: ["render"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath, specPath)
    const hash = /brief_hash: ([0-9a-f]{16})/.exec(text)![1]
    const del = (extra: Record<string, unknown> = {}) => write({ operation: "set_unit_status", phase: "p1", unit_id: "p11.8", data: { s: "delegated", brief, preflight: { symbols_grepped: ["render"], self_consistent: true, receipt: hash }, ...extra } })
    await expect(del()).rejects.toThrow(/PREFLIGHT RECEIPT: no passing preflight record/)
    await del({ user_override: true })
    expect((await unit()).delegations!.at(-1)!.checkpoint!.reach_override).toBeTruthy()
    // a record that also failed a dead citation is not consumable
    const brief2 = "Regenerate with `render`; see internal/web/handlers/nope.go for the shape."
    await appendPreflight(preflightPathFor(ledgerPath), { v: 1, ts: "t", phase: "p1", unit_id: "p11.8", brief_hash: briefHash(brief2), status: "fail", symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 1, ownership_outside: 0, reach: "omitted" })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "p11.8", data: { v: "fail" } })
    await expect(write({ operation: "set_unit_status", phase: "p1", unit_id: "p11.8", data: { s: "delegated", brief: brief2, preflight: { symbols_grepped: ["render"], self_consistent: true, receipt: briefHash(brief2) }, user_override: true } })).rejects.toThrow(/PREFLIGHT RECEIPT: no passing preflight record/)
  })
})

describe("the verdict re-checks the frozen checkpoint", () => {
  it("refuses when the spec's definition moved, when the guard's authorized set is wider than the selection, and honours the recorded override", async () => {
    await fs.writeFile(specPath, SPEC("go test ./internal/web/handlers/"))
    await write(delegated())
    // the spec's Test line is narrowed after delegation
    await fs.writeFile(specPath, SPEC("go test ./internal/ops/"))
    await expect(write(pass())).rejects.toThrow(/CHECKPOINT CHANGED: unit 'p11.8' attempt #1 was delegated under checkpoint [0-9a-f]{16} \(go test \.\/internal\/web\/handlers\/\)/)
    await fs.writeFile(specPath, SPEC("go test ./internal/web/handlers/"))
    // the guard froze a wider authorized set than the checkpoint selects
    await recordRepoGuard(ledgerPath, "p1", "p11.8", { snapshot: snapshot([...FILES.split(", "), "internal/ops/x.go"]), snapshot_ts: "t" })
    await recordRepoGuard(ledgerPath, "p1", "p11.8", { result: "ok", baseline_hash: "b1" })
    await expect(write(pass())).rejects.toThrow(/CHECKPOINT REACH: unit 'p11.8': internal\/ops\/x.go maps to package internal\/ops.*The authorized set the guard froze is wider than the checkpoint selects/)
    await write(pass("p11.8", { user_override: true }))
    expect((await unit()).cap_override?.waived).toEqual(["reach"])
  })
  it("an owner-overridden omission at delegation does not refuse again at the verdict for the same files; a direct fix inherits the frozen checkpoint", async () => {
    await write(delegated("p11.8", { user_override: true }))
    await write(pass())
    expect((await unit()).v).toBe("pass")
    // narrow the spec, then a direct fix: the frozen definition still binds the new attempt
    await fs.writeFile(specPath, SPEC("go test ./internal/ops/"))
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "p11.8", data: { s: "ip", direct_fix: "internal/web/handlers/render.go: rename" } })
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "p11.8", data: { v: "pass", via: "pitboss-direct", note: "direct-fix: rename applied and the suite is green" } })).rejects.toThrow(/CHECKPOINT CHANGED/)
  })
})
