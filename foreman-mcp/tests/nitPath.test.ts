// 0.6.20 nit path: the finding rides the delegated write (set_unit_status data.rejection),
// the escape class rides the verdict (set_verdict data.escape_class), and repo_guard snapshot
// on a correction copies the frozen authorized set from the from_attempt baseline. Every
// case pins a boundary the review verified: a refused inline write persists nothing and
// says so, the cap still counts, the escape source is 'rejection' (never post_gate_attempt),
// the ledger still refuses a different authorized set, and an older unclassified escape
// still blocks the pass after escape_class classified the newest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { readLedger, recordRepoGuard, writeLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import { appendEvent, readEvents, type SidecarEventInput } from "../src/lib/eventsSidecar.js"
import { resolveModelRank, type ModelRank } from "../src/lib/modelRank.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { RepoSnapshot, WriteLedgerInput } from "../src/types.js"

const TOP = { ...resolveModelRank("astra", "high"), session_id: "session-one" }
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }
const FILES = ["src/a.ts", "tests/a.test.ts"]
const REJECTION = { r: "gemini", msg: "tests/a.test.ts:12 asserts the old literal" }
let directory: string
let ledgerPath: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-nit-path-"))
  ledgerPath = path.join(directory, "ledger.json")
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-09-10T12:00:00Z"))
})
afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(directory, { recursive: true, force: true })
})

async function write(operation: Record<string, unknown>, rank: ModelRank = TOP, host: HostId = "codex") {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, async () => [], host, rank)
  vi.setSystemTime(Date.now() + 10)
  return result
}
const unit = async () => (await readLedger(ledgerPath)).phases.p1.units.u1
const phase = async () => (await readLedger(ledgerPath)).phases.p1
const onDisk = () => fs.readFile(ledgerPath, "utf-8")
const snapshot = (allowed = FILES): RepoSnapshot => ({
  root: directory, branch: "main", head: "head", stash_ref: "none", stash_count: 0, autocrlf: "false",
  eol: [], entries: [], truncated: false, allowed, hash: "snapshot-hash",
})
async function guard(allowed = FILES) {
  await recordRepoGuard(ledgerPath, "p1", "u1", { snapshot: snapshot(allowed), snapshot_ts: new Date().toISOString() })
  await recordRepoGuard(ledgerPath, "p1", "u1", { result: "ok" })
}
const delegated = (extra: Record<string, unknown> = {}) => ({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
  s: "delegated", brief: "Implement the bounded unit with its specified tests.", preflight: PREFLIGHT, ...extra,
} })
const verdict = (v = "pass", extra: Record<string, unknown> = {}) =>
  ({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v, via: "worker", ...extra } })
const reject = (extra: Record<string, unknown> = {}) =>
  ({ operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "gemini", msg: "loses the error path", ts: "t", ...extra } })
async function correction(extra: Record<string, unknown> = {}) {
  return write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
    s: "delegated", brief: "Correct the reported assertion within the existing unit.", preflight: PREFLIGHT,
    worker_id: "worker-one", correction: { kind: "mechanical", from_attempt: (await unit()).attempt_seq!, files: FILES }, ...extra,
  } })
}
const independent = () => ({ advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: FILES })
/** One unit delegated, guarded, passed with worker-one, reviewed and gated: covered by gate #1. */
async function gated() {
  await write(delegated())
  await guard()
  await write(verdict("pass", { worker_id: "worker-one" }))
  await write({ operation: "record_review", phase: "p1", data: independent() })
  await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass" } })
}

// ─── Cut 2: the rejection rides the delegated write ─────────────────────────

describe("set_unit_status data.rejection", () => {
  it("records the rejection and the correction in one write with one timestamp, and the escape source is 'rejection'", async () => {
    await gated()
    const { warning } = await correction({ rejection: { ...REJECTION, escape_class: "test_gap" } })
    expect(warning).toMatch(/^verdict reopened: unit 'u1' was 'pass'; this rejection reset it to 'pending' — re-run set_verdict after the fix \(the phase gate is blocked until then\); post-gate escape #1 recorded \(declared_external\) \| RANK CORRECTION: mechanical follow-up recorded as a new worker attempt/)
    expect(warning).not.toContain("classify with record_escape")
    const u = await unit()
    expect(u.rej).toHaveLength(1)
    expect(u.rej[0]).toMatchObject({ r: "gemini", msg: REJECTION.msg, attempt: 1 })
    expect(u.rej[0].ts).toBe(u.delegations!.at(-1)!.ts)
    expect(u.delegations!.at(-1)).toMatchObject({ attempt: 2, correction: { from_attempt: 1 } })
    expect(u).toMatchObject({ attempt_seq: 2, epoch_failed: 1, needs_attempt: false, v: "pending" })
    const p = await phase()
    expect(p.escapes).toHaveLength(1)
    expect(p.escapes![0]).toMatchObject({ gate_seq: 1, sources: ["rejection"], class: "test_gap" })
    expect(p.escapes![0].sources).not.toContain("post_gate_attempt")
  })

  it("matches the two-write sequence exactly: add_rejection then delegated leaves the same unit state", async () => {
    await gated()
    await write(reject())
    await correction()
    const twoWrites = await unit()
    await fs.rm(ledgerPath)
    await gated()
    await correction({ rejection: { r: "gemini", msg: "loses the error path" } })
    const oneWrite = await unit()
    const strip = (u: Record<string, unknown>) => JSON.parse(JSON.stringify(u, (k, v) => (k === "ts" || k.endsWith("_ts") ? undefined : v)))
    expect(strip(oneWrite as never)).toEqual(strip(twoWrites as never))
  })

  it("works on a fresh-worker delegation without a correction", async () => {
    await write(delegated())
    const { warning } = await write(delegated({ rejection: REJECTION }))
    // 0.6.20: a project that has not run preflight_check gets the nudge and nothing else
    expect(warning).toContain("PREFLIGHT: attested only")
    const u = await unit()
    expect(u.rej[0]).toMatchObject({ attempt: 1 })
    expect(u).toMatchObject({ attempt_seq: 2, epoch_failed: 1, needs_attempt: false })
  })

  it("refuses data.rejection on any status but delegated (INLINE REJECTION) and persists nothing", async () => {
    await write(delegated())
    const before = await onDisk()
    await expect(write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip", rejection: REJECTION } }))
      .rejects.toThrow(/^INLINE REJECTION: data\.rejection is recorded with s:'delegated' only/)
    expect(await onDisk()).toBe(before)
  })

  it("at the cap the write is refused with DELEGATION CAP plus the not-recorded suffix, and the ledger is byte-identical", async () => {
    // two failed attempts recorded, a third attempt open: the inline rejection is the third failure
    await write(delegated())
    await write(reject())
    await write(delegated())
    await write(reject())
    await write(delegated())
    expect((await unit())).toMatchObject({ epoch_failed: 2, attempt_seq: 3 })
    const before = await onDisk()
    await expect(write(delegated({ rejection: REJECTION }))).rejects.toThrow(
      /^DELEGATION CAP: unit 'u1' has 3 failed attempts since its last pass \(cap 3\)\. .* The inline rejection was not recorded \(the write was refused whole\): record it with add_rejection, then authorize_attempts or user_override\.$/
    )
    expect(await onDisk()).toBe(before)
    expect((await unit()).epoch_failed).toBe(2)
    // the same write without the inline rejection keeps today's message, byte for byte
    await write(reject())
    await expect(write(delegated())).rejects.toThrow(/do not fix off the record\.$/)
  })

  it("does not count an inline rejection twice on an attempt already rejected", async () => {
    await write(delegated())
    await write(reject())
    await write(delegated({ rejection: REJECTION }))
    const u = await unit()
    expect(u.rej.map((r) => r.attempt)).toEqual([1, 1])
    expect(u).toMatchObject({ epoch_failed: 1, attempt_seq: 2, needs_attempt: false })
  })

  it("a RANK CORRECTION refusal carries the suffix, rej[] is unchanged on disk, and without the rejection the message is unchanged", async () => {
    await gated()
    const before = await onDisk()
    await expect(correction({ rejection: REJECTION, correction: { kind: "mechanical", from_attempt: 7, files: FILES } })).rejects.toThrow(
      /^RANK CORRECTION: from_attempt must name the current worker delegation\. The inline rejection was not recorded \(the write was refused whole\): record it with add_rejection before retrying this write\.$/
    )
    expect(await onDisk()).toBe(before)
    expect((await unit()).rej).toHaveLength(0)
    await expect(correction({ correction: { kind: "mechanical", from_attempt: 7, files: FILES } })).rejects.toThrow(
      /^RANK CORRECTION: from_attempt must name the current worker delegation\.$/
    )
  })

  it("DELEGATION REQUIRED and PREFLIGHT REQUIRED refusals carry the suffix only with an inline rejection", async () => {
    await expect(write(delegated({ brief: "short", rejection: REJECTION })))
      .rejects.toThrow(/^DELEGATION REQUIRED: .* The inline rejection was not recorded \(the write was refused whole\)/)
    await expect(write(delegated({ preflight: undefined, rejection: REJECTION })))
      .rejects.toThrow(/^PREFLIGHT REQUIRED: .* The inline rejection was not recorded/)
    await expect(write(delegated({ brief: "short" }))).rejects.toThrow(/pitboss_implementor to load the full protocol\.$/)
    expect((await readLedger(ledgerPath)).phases.p1?.units.u1?.rej ?? []).toHaveLength(0)
  })

  it("a repeat finding against an already-escaped gate keeps the existing escape unclassified and says so", async () => {
    await gated()
    await write(reject())      // escape #1 against gate #1; the unit is still on attempt 1 and covered
    const { warning } = await write(delegated({ rejection: { ...REJECTION, escape_class: "test_gap" } }))
    expect(warning).toBe("rejection recorded; post-gate escape #1 recorded (declared_external) — classify with record_escape")
    const p = await phase()
    expect(p.escapes).toHaveLength(1)
    expect(p.escapes![0]).toMatchObject({ sources: ["rejection"], class: "unclassified" })
    // step 5 of the nit path: the class goes on the verdict
    await write(verdict("pass", { escape_class: "test_gap" }))
    expect((await phase()).escapes![0].class).toBe("test_gap")
  })

  it("an inline rejection with r:'BLD_ERR' closes an open invoke_worker chain like add_rejection", async () => {
    const sidecar = path.join(directory, ".foreman-events.jsonl")
    await handleWriteLedger(ledgerPath, delegated())
    await appendEvent(sidecar, {
      v: 1, ts: new Date().toISOString(), event_id: "evt_nit00001", event_type: "delegation_started", phase: "p1", unit_id: "u1",
      attempt: 1, delegation_id: "del_nit00001", provider: "anthropic", model: "claude-sonnet", tier: "standard",
      capability_class: "capable", edit_format: "unified_diff", repair_attempt: 0, brief_hash: "h1", prompt_prefix_hash: "h2",
      base_file_hashes: { "src/a.ts": "h3" },
    } as SidecarEventInput)
    const out = await handleWriteLedger(ledgerPath, delegated({ rejection: { r: "BLD_ERR", msg: "tsc failed" } }))
    expect(out).not.toContain("sidecar_warning")
    const { events } = await readEvents(sidecar)
    expect(events.at(-1)).toMatchObject({ event_type: "validation_completed", failure_stage: "BLD_ERR", outcome: "fail", delegation_id: "del_nit00001" })
  })
})

// ─── Cut 3: the escape class rides the verdict ──────────────────────────────

describe("set_verdict data.escape_class", () => {
  it("classifies the escape a rejection-less correction recorded (post_gate_attempt) and the pass goes through", async () => {
    await gated()
    await correction()
    expect((await phase()).escapes![0]).toMatchObject({ sources: ["post_gate_attempt"], class: "unclassified" })
    await guard()
    await expect(write(verdict())).rejects.toThrow(/^ESCAPE UNCLASSIFIED: unit 'u1' escaped gate #1/)
    await write(verdict("pass", { escape_class: "remediation_defect" }))
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ class: "remediation_defect", classified_ts: p.escapes![0].classified_ts })
    expect(p.escape_totals?.by_class).toEqual({ unclassified: 0, remediation_defect: 1 })
    expect(p.units.u1.v).toBe("pass")
    expect(p.units.u1.cap_override).toBeUndefined()
  })

  it("on a non-pass verdict the reopen escape is recorded first, then classified", async () => {
    await gated()
    await write(verdict("fail", { escape_class: "original_defect" }))
    const p = await phase()
    expect(p.escapes![0]).toMatchObject({ sources: ["reopen"], class: "original_defect" })
    expect(p.units.u1.v).toBe("fail")
  })

  it("refuses ESCAPE CLASS when the unit has no unclassified escape, and persists nothing", async () => {
    await write(delegated())
    await guard()
    const before = await onDisk()
    await expect(write(verdict("pass", { escape_class: "test_gap" }))).rejects.toThrow(
      /^ESCAPE CLASS: unit 'u1' has no unclassified escape to classify; drop data\.escape_class, or record a defect found out of band with record_escape \{ class, source: 'later' \}\.$/
    )
    await expect(write(verdict("fail", { escape_class: "test_gap" }))).rejects.toThrow(/^ESCAPE CLASS: unit 'u1'/)
    expect(await onDisk()).toBe(before)
    expect((await unit()).v).toBe("pending")
  })

  it("classifies the NEWEST unclassified escape; an older one (after an escape_override) still refuses until record_escape clears it", async () => {
    await gated()
    await write(reject())                                          // escape #1 against gate #1, unclassified
    await write(delegated())
    await write(verdict("pass", { user_override: true }))          // waived: escape stays unclassified
    await write({ operation: "record_review", phase: "p1", data: independent() })
    await write({ operation: "update_phase_gate", phase: "p1", data: { g: "pass", user_override: true } })   // gate #2, escape_override
    expect((await phase()).escape_override).toMatchObject({ escapes: 1 })
    await write(reject())                                          // escape #2 against gate #2
    expect((await phase()).escapes!.map((e) => [e.gate_seq, e.class])).toEqual([[1, "unclassified"], [2, "unclassified"]])
    await write(delegated())
    await expect(write(verdict("pass", { escape_class: "remediation_defect" })))
      .rejects.toThrow(/^ESCAPE UNCLASSIFIED: unit 'u1' escaped gate #1 \(declared_external\) via rejection\. Record write_ledger record_escape/)
    // the refused write classified nothing on disk
    expect((await phase()).escapes!.map((e) => e.class)).toEqual(["unclassified", "unclassified"])
    await write({ operation: "record_escape", phase: "p1", unit_id: "u1", data: { class: "test_gap" } })   // newest: gate #2's
    expect((await phase()).escapes!.map((e) => e.class)).toEqual(["unclassified", "test_gap"])
    await write(verdict("pass", { escape_class: "original_defect" }))                                       // newest unclassified: gate #1's
    expect((await phase()).escapes!.map((e) => e.class)).toEqual(["original_defect", "test_gap"])
    expect((await unit()).v).toBe("pass")
  })

  it("leaves the add_rejection and record_escape paths on their existing messages", async () => {
    await gated()
    const { warning } = await write(reject())
    expect(warning).toBe("verdict reopened: unit 'u1' was 'pass'; this rejection reset it to 'pending' — re-run set_verdict after the fix (the phase gate is blocked until then); post-gate escape #1 recorded (declared_external) — classify with record_escape")
    await expect(write({ operation: "record_escape", phase: "p1", unit_id: "u1", data: { class: "test_gap" } })).resolves.toBeDefined()
  })
})

// ─── Cut 5: repo_guard snapshot inherits the frozen set on a correction ─────

describe("repo_guard snapshot on a correction attempt", () => {
  let repoDir: string
  function git(args: string[]): string {
    return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
  }
  beforeEach(async () => {
    repoDir = path.join(directory, "repo")
    await fs.mkdir(repoDir)
    git(["init", "-q", "-b", "main"])
    git(["config", "user.email", "t@example.com"])
    git(["config", "user.name", "T"])
    git(["config", "commit.gpgsign", "false"])
    git(["config", "core.autocrlf", "false"])
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 1\n")
    await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 1\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "init"])
  })
  const snap = (extra: Record<string, unknown> = {}) =>
    handleRepoGuard({ operation: "snapshot", phase: "p1", unit_id: "u1", project_dir: repoDir, ...extra } as never, { ledgerPath })
  const compare = () =>
    handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: repoDir } as never, { ledgerPath })
  const line = (text: string, key: string) => text.split("\n").find((l) => l.startsWith(`${key}:`))?.trim()

  async function correctionOnRealGuard() {
    await write(delegated())
    expect(line(await snap({ files: ["a.ts"], allowed_files: ["a.ts"], max_entries: 700 }), "status")).toBe("status: recorded")
    expect(line(await compare(), "status")).toBe("status: ok")
    await write(verdict("pass", { worker_id: "worker-one" }))
    await correction({ correction: { kind: "mechanical", from_attempt: 1, files: ["a.ts"] }, rejection: REJECTION })
  }

  it("copies allowed_files and max_entries from the from_attempt baseline when omitted", async () => {
    await correctionOnRealGuard()
    const out = await snap()
    expect(line(out, "status")).toBe("status: recorded")
    expect(line(out, "authorized_from")).toBe("authorized_from: attempt #1 (inherited)")
    expect(line(out, "authorized_files")).toBe("authorized_files: 1")
    expect(line(out, "entry_limit")).toBe("entry_limit: 700")
    const d = (await unit()).delegations!
    expect(d.at(-1)!.guard!.snapshot.allowed).toEqual(d[0].guard!.snapshot.allowed)
    expect(d.at(-1)!.guard!.snapshot.entry_limit).toBe(700)
    // and the inherited set still guards: a write outside it is a violation
    await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 2\n")
    expect(line(await compare(), "status")).toBe("status: violation")
  })

  it("still refuses a different explicit set through the ledger, and an explicit identical set is not marked inherited", async () => {
    await correctionOnRealGuard()
    await expect(snap({ allowed_files: ["b.ts"] })).rejects.toThrow(/^RANK CORRECTION: the new guard must preserve the previous repository root and frozen authorized file set\.$/)
    expect((await unit()).delegations!.at(-1)!.guard).toBeUndefined()
    const out = await snap({ allowed_files: ["a.ts"] })
    expect(line(out, "status")).toBe("status: recorded")
    expect(line(out, "authorized_from")).toBeUndefined()
  })

  it("inherits nothing on an ordinary attempt", async () => {
    await write(delegated())
    await snap({ files: ["a.ts"], allowed_files: ["a.ts"] })
    await compare()
    await write(verdict("pass", { worker_id: "worker-one" }))
    await write(reject())
    await write(delegated())
    const out = await snap()
    expect(line(out, "status")).toBe("status: recorded")
    expect(line(out, "authorized_from")).toBeUndefined()
    expect(line(out, "authorized_files")).toBe("authorized_files: 0")
  })
})
