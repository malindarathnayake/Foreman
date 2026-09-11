// Architecture council 2026-09-10: reality as a source of truth. The spec contract block,
// claim-bound probes with streaming capture, live smoke with the verdict gate and digests,
// the repository window, and the guard's baseline binding; plus the five defects the council
// found in 0.6.21 (any-passing-probe, prefix hash, phase-less lookup, unexcluded preflight
// file, comparison migrating to a newer attempt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, recordRepoGuard, writeLedger } from "../src/lib/ledger.js"
import { appendPreflight, briefHash, findPreflight, preflightPathFor } from "../src/lib/preflight.js"
import { parseContracts, digestPaths, contractDigest } from "../src/lib/specContract.js"
import { contractProbe, evaluate, MAX_CAPTURE } from "../src/tools/contractProbe.js"
import { liveSmoke } from "../src/tools/liveSmoke.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { FOREMAN_STATE_NAMES, PREFLIGHT_FILE } from "../src/lib/foremanFiles.js"
import { resolveNamedCredentials } from "../src/lib/foremanEnv.js"
import type { RepoSnapshot, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
let specPath: string
const CONTRACT = {
  unit: "u1",
  claims: [{ id: "C-zones", text: "The zones endpoint returns the account's zones with ids.", request: { method: "GET", url: "https://api.example.test/v1/zones?per_page=50", headers: { authorization: "Bearer ${ENV:FOREMAN_TEST_CT}" } }, assertions: { json_nonempty_path: "result", json_array_length: { path: "result", max: 49 } } }],
  smoke: { id: "fetch-live", runner: "go", args: ["test", "-count=1", "./internal/..."], harness_files: ["internal/live_test.go"], input_files: ["internal"], env: ["FOREMAN_TEST_CT"], checks: { stdout_contains: "ok" } },
}
const SPEC = (contract: unknown = CONTRACT) => `# Spec\n\n#### u1 — zones\n- List zones with \`result\`.\n\n\`\`\`foreman-contract\n${JSON.stringify(contract)}\n\`\`\`\n\n#### u2 — other\n- Nothing external.\n\n\`\`\`foreman-contract\n{"unit":"u2","claims":[],"smoke":null}\n\`\`\`\n`

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T20:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-reality-"))
  ledgerPath = path.join(dir, "Docs", "ledger.json")
  specPath = path.join(dir, "Docs", "spec.md")
  await fs.mkdir(path.join(dir, "Docs"), { recursive: true })
  await fs.mkdir(path.join(dir, "internal"), { recursive: true })
  await fs.writeFile(specPath, SPEC())
  await fs.writeFile(path.join(dir, "internal", "client.go"), "package internal\n")
  await fs.writeFile(path.join(dir, "internal", "live_test.go"), "package internal\n// live\n")
  process.env.FOREMAN_TEST_CT = "hunter2"
})
afterEach(async () => {
  delete process.env.FOREMAN_TEST_CT
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
const ctx = () => ({ specPath, projectRoot: dir })
async function write(operation: Record<string, unknown>, withContext = true) {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, "claude-code", undefined, undefined, withContext ? ctx() : undefined)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const delegated = (unit_id = "u1", extra: Record<string, unknown> = {}) => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: `Implement ${unit_id} with its specified tests against the live endpoint`, preflight: { symbols_grepped: ["result"], self_consistent: true }, ...extra,
} })
const scope = () => ({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: true, has_build: true } })
const fakeFetch = (status: number, body: string) => (async () => ({ status, text: async () => body, body: null })) as unknown as typeof fetch
const unit = async (id = "u1") => (await readLedger(ledgerPath)).phases.p1.units[id]
const goodSmoke = (cwd?: string) => async (_r: string, _a: string[], _t: number, c: string) => { if (cwd) expect(c).toBe(cwd); return "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\tinternal\n" }

describe("the spec contract block", () => {
  it("parses one block per unit, digests canonically, and fails closed on duplicates and malformed blocks", () => {
    const r = parseContracts(SPEC())
    expect([...r.contracts.keys()]).toEqual(["u1", "u2"])
    expect(r.errors).toEqual([])
    expect(r.contracts.get("u2")!.contract.smoke).toBeNull()
    expect(r.contracts.get("u1")!.contract_sha256).toMatch(/^[0-9a-f]{16}$/)
    // key order does not change the digest; content does
    const parsed = r.contracts.get("u1")!.contract
    const reordered = Object.fromEntries(Object.entries(parsed).reverse()) as typeof parsed
    expect(contractDigest(reordered)).toBe(r.contracts.get("u1")!.contract_sha256)
    expect(contractDigest({ ...parsed, claims: [{ ...parsed.claims[0], text: "changed text here" }] })).not.toBe(r.contracts.get("u1")!.contract_sha256)
    const dup = parseContracts(SPEC() + "\n```foreman-contract\n{\"unit\":\"u1\",\"claims\":[],\"smoke\":null}\n```\n")
    expect(dup.contracts.has("u1")).toBe(false)
    expect(dup.errors.some((e) => e.includes("more than one contract block"))).toBe(true)
    const bad = parseContracts("```foreman-contract\n{\"unit\":\"u9\",\"claims\":[{\"id\":\"x\"}]}\n```\n")
    expect(bad.contracts.size).toBe(0)
    expect(bad.errors[0]).toContain("block 1")
  })
  it("digestPaths is stable, sensitive to content, bounded, and reports missing paths", async () => {
    const a = await digestPaths(dir, ["internal", "internal/live_test.go"])
    const b = await digestPaths(dir, ["internal/live_test.go", "internal"])
    expect(a.sha256).toBe(b.sha256)
    expect(a.files).toBe(2)
    await fs.writeFile(path.join(dir, "internal", "client.go"), "package internal\n// changed\n")
    expect((await digestPaths(dir, ["internal"])).sha256).not.toBe(a.sha256)
    const m = await digestPaths(dir, ["internal", "nowhere.go", "../outside"])
    expect(m.missing).toEqual(["../outside", "nowhere.go"])
  })
})

describe("contract_probe in claim mode", () => {
  it("loads the request and assertions from the claim, refuses caller overrides, and records claim id and contract digest", async () => {
    await write(scope())
    await write(delegated())
    const text = await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[{\"id\":1}]}"))
    expect(text).toContain("status: pass")
    expect(text).toContain("mode: claim C-zones")
    expect(text).toContain("target: https://api.example.test/v1/zones")
    expect(text).not.toContain("per_page")
    expect(text).not.toContain("hunter2")
    const p = (await unit()).probes![0]
    expect(p).toMatchObject({ claim_id: "C-zones", passed: true, capture_complete: true, credentials: ["FOREMAN_TEST_CT"] })
    expect(p.contract_sha256).toMatch(/^[0-9a-f]{16}$/)
    expect(await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones", url: "https://evil.test/" }, ledgerPath, specPath, fakeFetch(200, "{}"))).toContain("claim_mode_takes_no_request")
    expect(await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "nope" }, ledgerPath, specPath, fakeFetch(200, "{}"))).toContain("claim_unknown")
    expect(await contractProbe({ phase: "p1", unit_id: "u9", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, "{}"))).toContain("contract_missing")
  })
  it("a diagnostic probe is recorded as diagnostic and never satisfies a claim; exactly-limit rows fail json_array_length max", async () => {
    await write(scope())
    await write(delegated())
    const d = await contractProbe({ phase: "p1", unit_id: "u1", url: "https://api.example.test/v1/zones", expect: { json_nonempty_path: "result" } }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[1]}"))
    expect(d).toContain("mode: diagnostic")
    expect((await unit()).probes![0].diagnostic).toBe(true)
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }))
    const full = await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, JSON.stringify({ result: rows })))
    expect(full).toContain("status: fail")
    expect(full).toContain("expected at most 49); exactly the requested limit is possibly truncated")
    expect(evaluate({ json_array_length: { path: "result", exact: 2 } }, 200, "{\"result\":[1,2]}")).toEqual([])
    expect(evaluate({ json_array_length: { path: "result", min: 3 } }, 200, "{\"result\":[1,2]}")).toEqual(["json path result has 2 items (expected at least 3)"])
    expect(evaluate({ json_array_length: { path: "result" } }, 200, "{\"result\":{}}")).toEqual(["json path result is not an array"])
  })
  it("streams the body with a cap: an over-cap body is capture_complete:false and fails every body assertion", async () => {
    await write(scope())
    await write(delegated())
    const big = "x".repeat(MAX_CAPTURE + 10)
    const chunks = [big.slice(0, MAX_CAPTURE / 2), big.slice(MAX_CAPTURE / 2)]
    const streamFetch = (async () => ({
      status: 200,
      body: { getReader: () => { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: Buffer.from(chunks[i++]) } : { done: true, value: undefined }), cancel: async () => undefined } } },
    })) as unknown as typeof fetch
    const text = await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, streamFetch)
    expect(text).toContain("capture_complete: false")
    expect(text).toContain("status: fail")
    expect(text).toContain("capture incomplete")
    expect((await unit()).probes![0]).toMatchObject({ passed: false, capture_complete: false })
  })
})

describe("preflight requires every registered claim under the current contract", () => {
  const pf = () => preflightCheck({ phase: "p1", unit_id: "u1", brief: "Implement u1 using `result` from the live zones endpoint.", symbols: ["result"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath, specPath)
  it("refuses with no block, with an unprobed claim, and after the contract changes; passes only on a claim-mode pass under the current digest", async () => {
    await write(scope())
    await write(delegated())
    await fs.writeFile(specPath, "#### u1 — zones\n- List zones with `result`.\n")
    expect(await pf()).toContain("contract: REQUIRED: phase scope has_api and no foreman-contract block")
    await fs.writeFile(specPath, SPEC())
    expect(await pf()).toContain("contract: REQUIRED: claims without a passing claim-mode probe under the current contract: C-zones")
    // a diagnostic probe of the very same URL does not count
    await contractProbe({ phase: "p1", unit_id: "u1", url: "https://api.example.test/v1/zones", expect: {} }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[1]}"))
    expect(await pf()).toContain("contract: REQUIRED")
    await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[1]}"))
    const ok = await pf()
    expect(ok).toContain("status: pass")
    expect(ok).toContain("contract: satisfied (1 claim(s), smoke 'fetch-live')")
    // newest run decides: a later failure supersedes
    await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(500, ""))
    expect(await pf()).toContain("contract: REQUIRED")
    await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[1]}"))
    expect(await pf()).toContain("status: pass")
    // editing the claim text changes the digest: the old pass no longer counts
    await fs.writeFile(specPath, SPEC({ ...CONTRACT, claims: [{ ...CONTRACT.claims[0], text: "The zones endpoint returns zones AND their plan." }] }))
    expect(await pf()).toContain("contract: REQUIRED")
    // u2's reviewed opt-out satisfies preflight with nothing to probe
    const u2 = await preflightCheck({ phase: "p1", unit_id: "u2", brief: "Implement u2 with nothing external and its tests.", symbols: ["Nothing"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath, specPath)
    expect(u2).toContain("contract: satisfied (0 claim(s), smoke null)")
  })
  it("the delegation refuses a preflight whose contract digest is stale, and freezes the digest", async () => {
    await write(scope())
    await write(delegated())
    await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, fakeFetch(200, "{\"result\":[1]}"))
    const brief = "Implement u1 using `result` from the live zones endpoint."
    const text = await preflightCheck({ phase: "p1", unit_id: "u1", brief, symbols: ["result"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath, specPath)
    const hash = /brief_hash: ([0-9a-f]{16})/.exec(text)![1]
    await fs.writeFile(specPath, SPEC({ ...CONTRACT, claims: [] }))
    await expect(write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief, preflight: { symbols_grepped: ["result"], self_consistent: true, receipt: hash } } }))
      .rejects.toThrow(/PREFLIGHT RECEIPT: the spec contract for unit 'u1' changed since preflight/)
    await fs.writeFile(specPath, SPEC())
    await write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief, preflight: { symbols_grepped: ["result"], self_consistent: true, receipt: hash } } })
    expect((await unit()).delegations!.at(-1)!.contract_sha256).toMatch(/^[0-9a-f]{16}$/)
  })
  it("the lookup binds phase as well as unit, and the preflight file is Foreman-owned", async () => {
    const file = preflightPathFor(ledgerPath)
    const h = briefHash("x")
    await appendPreflight(file, { v: 1, ts: "t", phase: "p1", unit_id: "u1", brief_hash: h, status: "pass", symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0 })
    expect(await findPreflight(file, h, "u1", "p1")).not.toBeNull()
    expect(await findPreflight(file, h, "u1", "p2")).toBeNull()
    expect(FOREMAN_STATE_NAMES.has(PREFLIGHT_FILE)).toBe(true)
  })
})

describe("live_smoke and the verdict gate", () => {
  it("runs the frozen plan through the runner in the plan's cwd, records digests, and the verdict requires it in a has_api phase", async () => {
    await write(scope())
    await write(delegated())
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/SMOKE REQUIRED: unit 'u1' cannot pass in has_api phase 'p1': no live_smoke run for attempt #1 \(plan 'fetch-live'\)/)
    expect(await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "wrong" }, ledgerPath, specPath, dir, goodSmoke())).toContain("plan_unknown")
    const text = await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, goodSmoke(dir))
    expect(text).toContain("status: pass")
    expect(text).toContain("observations: exit 0; stdout contains \"ok\"")
    const s = (await unit()).smokes![0]
    expect(s).toMatchObject({ attempt: 1, plan_id: "fetch-live", passed: true, exit_code: 0 })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
    expect((await unit()).v).toBe("pass")
    expect((await unit()).cap_override).toBeUndefined()
  })
  it("a smoke goes stale when the application inputs or the harness change, when a newer run fails, or when the attempt advances; the override is recorded", async () => {
    await write(scope())
    await write(delegated())
    await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, goodSmoke())
    await fs.writeFile(path.join(dir, "internal", "client.go"), "package internal\n// edited after the smoke\n")
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/application inputs changed since the smoke ran/)
    await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, goodSmoke())
    await fs.writeFile(path.join(dir, "internal", "live_test.go"), "package internal\n// harness edited\n")
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/harness files changed since the smoke ran/)
    await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, goodSmoke())
    const failing = await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, async () => "exit_code: 1\npassed: false\ntimed_out: false\nSTDOUT\nFAIL\n")
    expect(failing).toContain("status: fail")
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/the newest live_smoke for attempt #1 failed \(exit 1 \(expected 0\); stdout does not contain "ok"\)/)
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", user_override: true } })
    expect((await unit()).cap_override?.waived).toEqual(["smoke"])
    // a new attempt needs its own smoke
    await write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "gemini", msg: "still broken over TLS", ts: "t", escape_class: "original_defect" } })
    await write(delegated())
    await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/no live_smoke run for attempt #2/)
  })
  it("a run whose inputs change while it executes is invalid; a missing harness file is a broken plan; a null plan has nothing to run", async () => {
    await write(scope())
    await write(delegated())
    const mutating = async () => { await fs.writeFile(path.join(dir, "internal", "client.go"), "package internal\n// mid-run\n"); return "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n" }
    const text = await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, mutating)
    expect(text).toContain("failed: application inputs changed during the run")
    await fs.rm(path.join(dir, "internal", "live_test.go"))
    expect(await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, goodSmoke())).toContain("harness_missing")
    await write(delegated("u2"))
    expect(await liveSmoke({ phase: "p1", unit_id: "u2", plan_id: "x" }, ledgerPath, specPath, dir, goodSmoke())).toContain("smoke_null")
    // and u2's verdict needs no smoke: the reviewed null is the opt-out
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u2", data: { v: "pass" } })
  })
  it("a ledger without a spec context keeps today's behaviour", async () => {
    await write(scope(), false)
    await write(delegated("u1"), false)
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } }, false)
    expect((await unit()).v).toBe("pass")
  })
})

describe("credentials resolve through the home store (0.6.23)", () => {
  // Field report: the operator populated ~/.foreman-mcp/.env, the store that exists so a variable
  // can be defined without exporting it into every shell, and contract_probe said credential_missing.
  const store = () => path.join(dir, "home.env")
  const absent = () => path.join(dir, "nowhere", ".env")
  it("resolveNamedCredentials: process env wins, the store fills the gaps, a malformed store is an error", async () => {
    await fs.writeFile(store(), "FOREMAN_TEST_CT=from-store\nFOREMAN_TEST_OTHER=\"quoted-store\"\n")
    const r = await resolveNamedCredentials(["FOREMAN_TEST_CT", "FOREMAN_TEST_OTHER", "FOREMAN_TEST_NONE"], { credentialsPath: store(), env: { FOREMAN_TEST_CT: "from-process" } })
    expect(r).toEqual({ ok: true, values: { FOREMAN_TEST_CT: "from-process", FOREMAN_TEST_OTHER: "quoted-store" }, sources: { FOREMAN_TEST_CT: "process", FOREMAN_TEST_OTHER: "store" }, missing: ["FOREMAN_TEST_NONE"] })
    expect(await resolveNamedCredentials(["X"], { credentialsPath: absent(), env: {} })).toEqual({ ok: true, values: {}, sources: {}, missing: ["X"] })
    await fs.writeFile(store(), "not a valid line\n")
    expect((await resolveNamedCredentials(["X"], { credentialsPath: store(), env: {} })).ok).toBe(false)
  })
  it("contract_probe sends a header resolved from the store, names the source, and never prints the value", async () => {
    delete process.env.FOREMAN_TEST_CT
    await write(scope())
    await write(delegated())
    let sent: Record<string, string> | undefined
    const capturing = (async (_u: unknown, init: RequestInit) => { sent = init.headers as Record<string, string>; return { status: 200, text: async () => "{\"result\":[1]}", body: null } }) as unknown as typeof fetch
    const miss = await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, capturing, { credentialsPath: absent() })
    expect(miss).toContain("credential_missing")
    expect(miss).toContain("~/.foreman-mcp/.env")
    await fs.writeFile(store(), "FOREMAN_TEST_CT=store-secret-value\n")
    const text = await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, capturing, { credentialsPath: store() })
    expect(text).toContain("status: pass")
    expect(text).toContain("credentials_from_env: FOREMAN_TEST_CT (store)")
    expect(text).not.toContain("store-secret-value")
    expect(sent?.authorization).toBe("Bearer store-secret-value")
    expect(JSON.stringify(await unit())).not.toContain("store-secret-value")
    process.env.FOREMAN_TEST_CT = "process-wins"
    await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, capturing, { credentialsPath: store() })
    expect(sent?.authorization).toBe("Bearer process-wins")
    await fs.writeFile(store(), "garbage line\n")
    expect(await contractProbe({ phase: "p1", unit_id: "u1", claim_id: "C-zones" }, ledgerPath, specPath, capturing, { credentialsPath: store() })).toContain("credential_store_invalid")
  })
  it("live_smoke hands the plan's variables from the store to the runner's child environment", async () => {
    delete process.env.FOREMAN_TEST_CT
    await write(scope())
    await write(delegated())
    let seen: Record<string, string> | undefined
    const runner = async (_r: string, _a: string[], _t: number, _c: string, env: Record<string, string>) => { seen = env; return "exit_code: 0\npassed: true\ntimed_out: false\nSTDOUT\nok\n" }
    expect(await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, runner, { credentialsPath: absent() })).toContain("credential_missing")
    await fs.writeFile(store(), "FOREMAN_TEST_CT=store-secret-value\n")
    const text = await liveSmoke({ phase: "p1", unit_id: "u1", plan_id: "fetch-live" }, ledgerPath, specPath, dir, runner, { credentialsPath: store() })
    expect(text).toContain("status: pass")
    expect(text).toContain("credentials: FOREMAN_TEST_CT (store)")
    expect(text).not.toContain("store-secret-value")
    expect(seen).toEqual({ FOREMAN_TEST_CT: "store-secret-value" })
    expect(JSON.stringify(await unit())).not.toContain("store-secret-value")
  })
})

describe("the repository window and baseline binding", () => {
  // 0.6.24: a declared smoke plan is required in any phase; these tests are about the window.
  beforeEach(async () => { await fs.writeFile(specPath, SPEC({ ...CONTRACT, smoke: null })) })
  const snapshot = (hash: string, root = dir): RepoSnapshot => ({ root, branch: "main", head: "h", stash_ref: "none", stash_count: 0, autocrlf: "false", eol: [], entries: [], truncated: false, allowed: ["src/a.ts"], hash })
  it("one window per root: a second unit cannot delegate or snapshot while the first holds it; a verdict releases it", async () => {
    await write(delegated("u1"))
    await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot("b1"), snapshot_ts: "t" })
    expect((await readLedger(ledgerPath)).window).toMatchObject({ phase: "p1", unit_id: "u1", attempt: 1, stage: "editing" })
    await expect(write(delegated("u2"))).rejects.toThrow(/WINDOW BUSY: unit 'u1' in phase 'p1' holds the repository window \(attempt #1, editing\)/)
    await recordRepoGuard(ledgerPath, "p1", "u1", { result: "ok", baseline_hash: "b1" })
    expect((await readLedger(ledgerPath)).window?.stage).toBe("validation")
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
    expect((await readLedger(ledgerPath)).window).toBeUndefined()
    await write(delegated("u2"))
  })
  it("close_attempt on the owning attempt releases the window; a new attempt on the same unit supersedes it", async () => {
    await write(delegated("u1"))
    await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot("b1"), snapshot_ts: "t" })
    await write({ operation: "close_attempt", phase: "p1", unit_id: "u1", data: { attempt: 1, outcome: "blocked", note: "worker stopped on a discovered blocker" } })
    expect((await readLedger(ledgerPath)).window).toBeUndefined()
    await write(delegated("u1"))
    await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot("b2"), snapshot_ts: "t" })
    await write(delegated("u1"))
    expect((await readLedger(ledgerPath)).window).toBeUndefined()
  })
  it("a comparison binds to the baseline it was taken against; one that lands on a newer baseline is refused", async () => {
    await write(delegated("u1"))
    await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot("b1"), snapshot_ts: "t" })
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    await write(delegated("u1"))
    await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot("b2"), snapshot_ts: "t" })
    await expect(recordRepoGuard(ledgerPath, "p1", "u1", { result: "ok", baseline_hash: "b1" })).rejects.toThrow(/taken against baseline b1 but unit 'u1' attempt #2 holds baseline b2/)
    await recordRepoGuard(ledgerPath, "p1", "u1", { result: "ok", baseline_hash: "b2" })
    expect((await unit()).delegations!.at(-1)!.guard?.result).toBe("ok")
  })
})
