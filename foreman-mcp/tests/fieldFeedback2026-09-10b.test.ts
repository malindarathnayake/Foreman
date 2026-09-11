// Field report 2026-09-10, third batch, built after a Codex deliberation: typed attempt
// outcomes (failure evidence server-authored, everything else labelled once), worker
// heartbeats keyed on the current attempt, per-unit phase ownership, and the server-executed
// contract probe that preflight demands in a has_api phase.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { heartbeatPathFor, readHeartbeats, workerStatus, HEARTBEAT_KEEP } from "../src/tools/workerStatus.js"
import { phaseOwnership } from "../src/tools/phaseOwnership.js"
import { contractProbe, evaluate, ContractProbeInputSchema } from "../src/tools/contractProbe.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { preflightPathFor } from "../src/lib/preflight.js"
import { foremanFileScope, isForemanStateFile, relativeScope, HEARTBEAT_FILE } from "../src/lib/foremanFiles.js"
import { hostRuntimePreamble, getProfile } from "../src/lib/hostProfiles.js"
import type { WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T18:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-ff0910b-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})
async function write(operation: Record<string, unknown>) {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput)
  vi.setSystemTime(Date.now() + 1000)
  return result
}
const delegated = (unit_id = "u1") => ({ operation: "set_unit_status", phase: "p1", unit_id, data: {
  s: "delegated", brief: "Implement the bounded change for this unit with tests", preflight: { symbols_grepped: ["x"], self_consistent: true },
} })
const close = (attempt: number, outcome: string, unit_id = "u1") =>
  ({ operation: "close_attempt", phase: "p1", unit_id, data: { attempt, outcome, note: "worker stopped on a discovered blocker and reported it" } })
const unit = async () => (await readLedger(ledgerPath)).phases.p1.units.u1

describe("typed attempt outcomes", () => {
  it("labels a non-failure ending once, keeps lifetime counters, and changes no attempt accounting", async () => {
    await write(delegated())
    const { warning } = await write(close(1, "blocked"))
    expect(warning).toContain("attempt #1 closed as blocked (lifetime blocked:1)")
    expect(warning).toContain("the failure cap and needs_attempt are unchanged")
    let u = await unit()
    expect(u.delegations![0]).toMatchObject({ attempt: 1, outcome: "blocked" })
    expect(u.outcomes).toEqual({ blocked: 1 })
    expect(u.epoch_failed ?? 0).toBe(0)
    expect(u.needs_attempt ?? false).toBe(false)
    expect(u.attempt_seq).toBe(1)
    // idempotent, never relabelled
    expect((await write(close(1, "delivered"))).warning).toContain("already closed as blocked; nothing changed")
    u = await unit()
    expect(u.outcomes).toEqual({ blocked: 1 })
    await write(delegated())
    await write(close(2, "validation_only"))
    expect((await unit()).outcomes).toEqual({ blocked: 1, validation_only: 1 })
    await expect(write(close(9, "delivered"))).rejects.toThrow(/no retained delegation for attempt #9/)
    await expect(write(close(1, "delivered", "nope"))).rejects.toThrow(/CLOSE BLOCKED: unit 'nope'/)
  })
  it("a rejection or fail verdict marks the attempt rejected, overrides a prior label once, and cannot be relabelled", async () => {
    await write(delegated())
    await write(close(1, "delivered"))
    await write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "gemini", msg: "loses the error path", ts: "t" } })
    let u = await unit()
    expect(u.delegations![0].outcome).toBe("rejected")
    expect(u.outcomes).toEqual({ delivered: 0, rejected: 1 })
    // a second rejection of the same attempt does not count twice
    await write({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "codex", msg: "same finding", ts: "t" } })
    expect((await unit()).outcomes).toEqual({ delivered: 0, rejected: 1 })
    await expect(write(close(1, "blocked"))).rejects.toThrow(/carries failure evidence/)
    await write(delegated())
    await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "fail" } })
    u = await unit()
    expect(u.delegations![1].outcome).toBe("rejected")
    expect(u.outcomes).toEqual({ delivered: 0, rejected: 2 })
    expect(u.epoch_failed).toBe(2)
  })
  it("the delegation result names the attempt, and the unit view shows outcomes", async () => {
    const text = await handleWriteLedger(ledgerPath, delegated())
    expect(text).toContain("attempt: 1")
    await write(close(1, "blocked"))
    expect(await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })).toContain("outcomes: blocked:1")
  })
})

describe("worker heartbeats", () => {
  it("reports the newest heartbeat for the current attempt and treats earlier attempts as stale", async () => {
    await write(delegated())
    const file = heartbeatPathFor(ledgerPath)
    const line = (attempt: number, ts: string, files: string[] = []) => JSON.stringify({ ts, phase: "p1", unit: "u1", attempt, files, note: `beat ${attempt}` }) + "\n"
    await fs.appendFile(file, line(1, "2026-09-10T17:59:00Z", ["src/a.go"]))
    let text = await workerStatus({ phase: "p1", unit_id: "u1" }, ledgerPath, new Date("2026-09-10T18:00:00Z"))
    expect(text).toContain("status: alive")
    expect(text).toContain("last_heartbeat_age_s: 60")
    expect(text).toContain("files_touched_so_far: src/a.go")
    await write(delegated())   // attempt 2: the old line is stale, not life
    text = await workerStatus({ phase: "p1", unit_id: "u1" }, ledgerPath, new Date("2026-09-10T18:00:00Z"))
    expect(text).toContain("status: stale_only")
    expect(text).toContain("stale_lines_from_earlier_attempts: 1")
    await fs.appendFile(file, "not json\n" + line(2, "2026-09-10T18:00:30Z", ["src/b.go"]))
    text = await workerStatus({ phase: "p1", unit_id: "u1" }, ledgerPath, new Date("2026-09-10T18:01:00Z"))
    expect(text).toContain("status: alive")
    expect(text).toContain("last_heartbeat_age_s: 30")
    expect(text).toContain("files_touched_so_far: src/b.go")
    expect(await workerStatus({ phase: "p1", unit_id: "nope" }, ledgerPath)).toContain("unknown_unit")
  })
  it("trims the file on read once it grows past the threshold, keeping the newest lines", async () => {
    const file = heartbeatPathFor(ledgerPath)
    const lines = Array.from({ length: 2001 }, (_, i) => JSON.stringify({ ts: "t", phase: "p1", unit: "u1", attempt: 1, note: String(i) })).join("\n") + "\n"
    await fs.writeFile(file, lines)
    const beats = await readHeartbeats(file)
    expect(beats).toHaveLength(HEARTBEAT_KEEP)
    expect(beats.at(-1)!.note).toBe("2000")
    expect((await fs.readFile(file, "utf-8")).split("\n").filter(Boolean)).toHaveLength(HEARTBEAT_KEEP)
  })
  it("the heartbeat file is Foreman-owned for the guard, and the brief tells the worker to write it", async () => {
    const scope = foremanFileScope({ ledgerPath, progressPath: path.join(dir, "p.json"), journalPath: path.join(dir, "j.json"), docsDir: dir })
    expect(scope.state.some((p) => p.endsWith(HEARTBEAT_FILE))).toBe(true)
    const rel = await relativeScope(scope, dir)
    expect(isForemanStateFile(HEARTBEAT_FILE, rel)).toBe(true)
    for (const host of ["claude-code", "codex", "cursor", "generic"] as const) {
      const invoke = getProfile(host).placeholders.worker_invoke
      expect(invoke, host).toContain("Docs/.foreman-heartbeat.jsonl")
      expect(invoke, host).toContain("never write there")
      expect(hostRuntimePreamble(host), host).toContain("**Two actors, one tree:**")
    }
  })
})

describe("phase ownership", () => {
  it("sweeps each unit against its own files and assigns outside sites to owners or UNASSIGNED", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-po-"))
    try {
      await fs.mkdir(path.join(root, "internal", "runner"), { recursive: true })
      await fs.writeFile(path.join(root, "internal", "kinds.go"), "package internal\ntype Kind int\n")
      await fs.writeFile(path.join(root, "internal", "runner", "runner.go"), "package runner\nfunc d(k Kind) { switch k { default: } }\n")
      await fs.writeFile(path.join(root, "internal", "runner", "quality.go"), "package runner\nvar m = map[Kind]string{}\n")
      await fs.writeFile(path.join(root, "internal", "runner", "labels.go"), "package runner\nvar l = map[Kind]string{KindGraphQL: \"g\"}\n")
      const text = await phaseOwnership({ phase: "p11", repo_root: root, units: [
        { unit_id: "p11.2", files: ["internal/kinds.go"], type_names: ["Kind"], introduces: ["KindGraphQL"] },
        { unit_id: "p11.5", files: ["internal/runner/runner.go"], type_names: [], introduces: [] },
      ] })
      expect(text).toContain("sites_outside_declared_files: 3")
      expect(text).toContain("at_risk: 1 (")
      expect(text).toContain("present: 1 (")
      expect(text).toContain("unassigned_files: internal/runner/labels.go,internal/runner/quality.go")
      expect(text).toMatch(/p11\.2\s*\|\s*internal\/runner\/runner\.go\s*\|\s*p11\.5\s*\|\s*at_risk\s*\|\s*Kind\s*\|\s*yes\s*\|\s*yes/)
      expect(text).toMatch(/p11\.2\s*\|\s*internal\/runner\/labels\.go\s*\|\s*UNASSIGNED\s*\|\s*present/)
      // at_risk rows come first, present rows last
      expect(text.indexOf("at_risk |")).toBeLessThan(text.indexOf("present |"))
      expect(text).toContain("report_hash:")
      expect(text).toContain("stale once any unit lands")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("contract probe", () => {
  const fakeFetch = (status: number, body: string) => (async () => ({ status, text: async () => body })) as unknown as typeof fetch
  const input = (extra: Record<string, unknown> = {}) => ({ phase: "p1", unit_id: "u1", url: "https://api.example.test/v1/zones?token=SECRET&id=7", ...extra })

  it("evaluate: 2xx by default, and a 200 with zero rows fails a json_nonempty_path assertion", () => {
    const base = ContractProbeInputSchema.parse(input())
    expect(evaluate(base, 200, "{\"result\":[1]}")).toEqual([])
    expect(evaluate(base, 403, "")).toEqual(["status 403 (expected 2xx)"])
    const rows = ContractProbeInputSchema.parse(input({ expect: { json_nonempty_path: "result", min_bytes: 5, contains: "result" } }))
    expect(evaluate(rows, 200, "{\"result\":[]}")).toEqual([expect.stringContaining("json path result is empty")])
    expect(evaluate(rows, 200, "{\"result\":[{\"a\":1}]}")).toEqual([])
  })
  it("executes the request itself, records origin+path only, never the credential, and preflight demands a pass in a has_api phase", async () => {
    await write({ operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: true, has_build: true } })
    await write(delegated())
    process.env.FOREMAN_TEST_PROBE_TOKEN = "hunter2"
    try {
      const failed = await contractProbe(input({ headers: { authorization: "Bearer ${ENV:FOREMAN_TEST_PROBE_TOKEN}" }, expect: { json_nonempty_path: "result" } }), ledgerPath, fakeFetch(200, "{\"result\":[]}"))
      expect(failed).toContain("status: fail")
      expect(failed).toContain("target: https://api.example.test/v1/zones")
      expect(failed).not.toContain("SECRET")
      expect(failed).not.toContain("hunter2")
      expect(failed).toContain("credentials_from_env: FOREMAN_TEST_PROBE_TOKEN")
      await fs.mkdir(path.join(dir, "Docs"), { recursive: true })
      await fs.writeFile(path.join(dir, "Docs", "spec.md"), "#### u1 — zones\n- List zones with `result`.\n")
      const pf = await preflightCheck({ phase: "p1", unit_id: "u1", brief: "Implement the zones list using `result` from the live endpoint.", symbols: ["result"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath)
      expect(pf).toContain("status: fail")
      expect(pf).toContain("contract_probe: REQUIRED")
      const passed = await contractProbe(input({ expect: { json_nonempty_path: "result" } }), ledgerPath, fakeFetch(200, "{\"result\":[{\"id\":7}]}"))
      expect(passed).toContain("status: pass")
      const u = await unit()
      expect(u.probes).toHaveLength(2)
      expect(u.probes![1]).toMatchObject({ passed: true, status: 200, target: "https://api.example.test/v1/zones" })
      expect(JSON.stringify(u.probes)).not.toContain("SECRET")
      const pf2 = await preflightCheck({ phase: "p1", unit_id: "u1", brief: "Implement the zones list using `result` from the live endpoint.", symbols: ["result"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath)
      expect(pf2).toContain("status: pass")
      expect(pf2).toContain("contract_probe: passed")
      expect(await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })).toContain("probes: 1 passed / 2")
    } finally {
      delete process.env.FOREMAN_TEST_PROBE_TOKEN
    }
    expect(await contractProbe(input({ headers: { authorization: "${ENV:FOREMAN_TEST_MISSING}" } }), ledgerPath, fakeFetch(200, "{}"))).toContain("credential_missing")
    expect(await contractProbe(input(), ledgerPath, (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch)).toContain("failed: transport: ECONNREFUSED")
  })
  it("a phase without has_api does not require a probe", async () => {
    await write(delegated())
    await fs.mkdir(path.join(dir, "Docs"), { recursive: true })
    await fs.writeFile(path.join(dir, "Docs", "spec.md"), "#### u1 — zones\n- List zones with `result`.\n")
    const pf = await preflightCheck({ phase: "p1", unit_id: "u1", brief: "Implement the zones list using `result` locally.", symbols: ["result"], repo_root: dir, spec_path: "Docs/spec.md" }, preflightPathFor(ledgerPath), ledgerPath)
    expect(pf).toContain("contract_probe: not required")
  })
})
