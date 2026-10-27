import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { KNOWN_HOSTS, type HostId } from "../src/lib/hostProfiles.js"
import { readLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { appendPreflight, briefHash, preflightPathFor, PREFLIGHT_POLICY_VERSION } from "../src/lib/preflight.js"
import { readSessionState } from "../src/tools/sessionOrient.js"
import { checkpointFromSpec, checkpointReach } from "../src/lib/checkpoint.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import { reviewIncompleteness, trimReviews } from "../src/lib/reviewPredicates.js"
import { workerSeatStatus } from "../src/lib/workerSeats.js"
import { claudeAgentsInit } from "../src/tools/claudeAgentsInit.js"
import { cursorAgentsInit } from "../src/tools/cursorAgentsInit.js"
import { codexAgentsInit } from "../src/tools/codexAgentsInit.js"
import { writeProgress } from "../src/lib/progress.js"
import { loadForemanEnv } from "../src/lib/foremanEnv.js"

let dir: string, ledger: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-1013-")); ledger = path.join(dir, ".foreman-ledger.json") })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
const brief = "Implement the bounded change and validate the result."
const delegate = { s: "delegated", brief, preflight: { symbols_grepped: 1, self_consistent: true } }
const finding = { severity: "medium", classification: "confirmed", description: "The input loses a required value.", file: "app.ts", line: "1" }
const auth = { authority: "direct", quote: "I approve this exception.", override_fact_key: "owner-decision" }
function write(operation: string, data: object, host: HostId, unit_id?: string) {
  return handleWriteLedger(ledger, { operation, phase: "p1", ...(unit_id ? { unit_id } : {}), data }, host, undefined, { projectRoot: dir })
}

describe.each(KNOWN_HOSTS)("OSC feedback on %s", (host) => {
  it("filters rejection and review records by unit and exposes full text", async () => {
    for (const id of ["u1", "u2"]) await write("set_unit_status", delegate, host, id)
    const long = "first rejection " + "details ".repeat(100)
    await write("add_rejection", { r: "reviewer", msg: long }, host, "u1")
    await write("add_rejection", { r: "reviewer", msg: "other unit rejection" }, host, "u2")
    const text = await handleReadLedger(ledger, { phase: "p1", unit_id: "u1", query: "rejections", include_full_text: true })
    expect(text).toContain(long.trim())
    expect(text).not.toContain("other unit rejection")
    await write("record_review", { advisor: "seat", units: ["u1"], findings: [finding] }, host)
    await write("record_review", { advisor: "other-seat", units: ["u2"], findings: [{ ...finding, description: "other finding" }] }, host)
    const reviews = await handleReadLedger(ledger, { phase: "p1", unit_id: "u1", query: "reviews" })
    expect(reviews).toContain("The input loses")
    expect(reviews).toContain("review_ts")
    expect(reviews).not.toContain("other finding")
  })

  it("delegates by hash alone, refuses changed text, wrong unit, failed or tampered receipts", async () => {
    const record = { v: PREFLIGHT_POLICY_VERSION, ts: new Date().toISOString(), phase: "p1", unit_id: "u1", brief, brief_hash: briefHash(brief), status: "pass" as const, symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0 }
    await appendPreflight(preflightPathFor(ledger), record)
    await write("set_unit_status", { s: "delegated", brief_hash: record.brief_hash }, host, "u1")
    expect((await readLedger(ledger)).phases.p1.units.u1.w).toBe(brief)
    await expect(write("set_unit_status", { s: "delegated", brief_hash: record.brief_hash, brief: brief + " Changed." }, host, "u1")).rejects.toThrow("PREFLIGHT RECEIPT")
    await expect(write("set_unit_status", { s: "delegated", brief_hash: record.brief_hash }, host, "u2")).rejects.toThrow("PREFLIGHT RECEIPT")
    await appendPreflight(preflightPathFor(ledger), { ...record, status: "fail" })
    await expect(write("set_unit_status", { s: "delegated", brief_hash: record.brief_hash }, host, "u1")).rejects.toThrow("PREFLIGHT RECEIPT")
    await appendPreflight(preflightPathFor(ledger), { ...record, brief: brief + " tampered" })
    await expect(write("set_unit_status", { s: "delegated", brief_hash: record.brief_hash }, host, "u1")).rejects.toThrow("DELEGATION REQUIRED")
  })

  it("accepts scoped reviews quietly and adjudicates without changing the original", async () => {
    for (const id of ["u1", "u2"]) {
      await write("set_unit_status", delegate, host, id)
      await write("set_verdict", { v: "pass" }, host, id)
    }
    const result = await write("record_review", { advisor: "seat", units: ["u1"], completion: "complete", findings: [{ ...finding, verifier_severity: "low", final_severity: "medium", decided_by: "supervisor" }] }, host)
    expect(result).not.toContain("REVIEW SCOPE")
    await expect(write("update_phase_gate", { g: "pass" }, host)).rejects.toThrow()
    await write("record_review", { advisor: "second", units: ["u2"], completion: "complete", findings: [] }, host)
    await expect(write("update_phase_gate", { g: "pass" }, host)).rejects.toThrow("CONFIRMED FINDINGS")
    const review = (await readLedger(ledger)).phases.p1.reviews![0]
    await write("adjudicate_finding", { review_ts: review.ts, finding_index: 0, severity: "low", decided_by: "owner", reason: "Limited impact confirmed by owner." }, host)
    await write("update_phase_gate", { g: "pass" }, host)
    const phase = (await readLedger(ledger)).phases.p1
    expect(phase.reviews![0].findings[0].severity).toBe("medium")
    expect(phase.reviews![0].findings[0].adjudications![0].severity).toBe("low")
    expect(phase.advisory_findings?.findings).toHaveLength(1)
    expect(trimReviews([...phase.reviews!, ...Array.from({ length: 30 }, (_, i) => ({ advisor: "later", ts: `later-${i}`, findings: [], completion: "complete" as const }))], phase)).toContain(phase.reviews![0])
  })

  it("requires linked authority on overrides and freezes the fact version used", async () => {
    await write("set_unit_status", delegate, host, "u1")
    await write("add_rejection", { r: "reviewer", msg: "Owner may choose to accept this." }, host, "u1")
    await expect(write("set_verdict", { v: "pass", user_override: true }, host, "u1")).rejects.toThrow("AUTHORITY REQUIRED")
    await expect(write("set_verdict", { v: "pass", user_override: true, ...auth }, host, "u1")).rejects.toThrow("OVERRIDE FACT REQUIRED")
    await write("record_fact", { key: "owner-decision", text: auth.quote }, host)
    await expect(write("set_verdict", { v: "pass", user_override: true, ...auth, authority: "relayed" }, host, "u1")).rejects.toThrow("relayed_by")
    await write("set_verdict", { v: "pass", user_override: true, ...auth, authority: "relayed", relayed_by: "supervising-agent" }, host, "u1")
    await write("record_fact", { key: "owner-decision", text: "A later correction to the decision." }, host)
    const phase = (await readLedger(ledger)).phases.p1
    expect(phase.facts!.map((f) => f.version)).toEqual([1, 2])
    expect(phase.authorizations![0]).toMatchObject({ fact_version: 1, fact_text: auth.quote, authority: "relayed", relayed_by: "supervising-agent" })
    const latest = await handleReadLedger(ledger, { phase: "p1", query: "facts" })
    expect(latest).not.toContain(auth.quote)
    expect(await handleReadLedger(ledger, { phase: "p1", query: "facts", include_history: true })).toContain(auth.quote)
  })

  it("logs aborted launches without spending attempts or satisfying a rejected unit", async () => {
    await write("set_unit_status", delegate, host, "u1")
    await write("add_rejection", { r: "reviewer", msg: "Fix is still required." }, host, "u1")
    const before = (await readLedger(ledger)).phases.p1.units.u1
    await write("record_launch", { worker_id: "wrong-worker", outcome: "aborted_no_work", note: "Stopped after two reads; no edits or validation." }, host, "u1")
    const after = (await readLedger(ledger)).phases.p1.units.u1
    expect(after.attempt_seq).toBe(before.attempt_seq)
    expect(after.epoch_failed).toBe(before.epoch_failed)
    expect(after.needs_attempt).toBe(true)
    await expect(write("set_verdict", { v: "pass" }, host, "u1")).rejects.toThrow("ATTEMPT REQUIRED")
  })

  it("records attributed attempt grants and rejects missing provenance", async () => {
    for (let n = 0; n < 3; n++) {
      await write("set_unit_status", delegate, host, "u1")
      await write("add_rejection", { r: "reviewer", msg: "The attempt did not satisfy the brief." }, host, "u1")
    }
    await expect(write("authorize_attempts", { attempts: 2, reason: "Owner authorized another two attempts.", user_override: true }, host, "u1")).rejects.toThrow("AUTHORITY REQUIRED")
    await write("authorize_attempts", { attempts: 2, reason: "Owner authorized another two attempts.", user_override: true, authority: "relayed", quote: "Proceed with two more attempts.", relayed_by: "supervisor" }, host, "u1")
    const grant = (await readLedger(ledger)).phases.p1.units.u1.cap_grants![0]
    expect(grant.authorization).toMatchObject({ authority: "relayed", relayed_by: "supervisor" })
    await write("set_unit_status", delegate, host, "u1")
    expect((await readLedger(ledger)).phases.p1.units.u1.cap_grants![0].remaining).toBe(1)
  })

  it("applies the premium-to-frontier ladder on this profile", async () => {
    await write("set_unit_status", { ...delegate, tier: "premium" }, host, "u1")
    await write("add_rejection", { r: "reviewer", msg: "The premium attempt failed." }, host, "u1")
    await expect(write("set_unit_status", { ...delegate, tier: "premium" }, host, "u1")).rejects.toThrow("TIER LADDER")
    await write("set_unit_status", { ...delegate, tier: "frontier" }, host, "u1")
  })

  it("enforces model evidence against the frozen configured tier mapping", async () => {
    await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ [host]: { frontier: "verified-frontier-model" } }))
    await write("set_unit_status", { ...delegate, tier: "frontier" }, host, "u1")
    await expect(write("set_verdict", { v: "pass" }, host, "u1")).rejects.toThrow("WORKER MODEL")
    await expect(write("set_verdict", { v: "pass", worker_model: "wrong-model", model_evidence: "Host transcript line 2" }, host, "u1")).rejects.toThrow("WORKER MODEL")
    await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ [host]: { frontier: "changed-model" } }))
    await write("set_verdict", { v: "pass", worker_model: "verified-frontier-model", model_evidence: "Host transcript line 2: verified-frontier-model" }, host, "u1")
    expect((await readLedger(ledger)).phases.p1.units.u1.delegations![0].worker_model).toBe("verified-frontier-model")
  })

  it("surfaces pending owner gates, blocks passes and retains approved decisions", async () => {
    await write("set_unit_status", delegate, host, "u1")
    await write("set_owner_gate", { id: "B1", status: "pending", description: "Owner must authorize the live run." }, host, "u1")
    await expect(write("set_verdict", { v: "pass" }, host, "u1")).rejects.toThrow("OWNER GATES PENDING")
    let state = await readSessionState(ledger, path.join(dir, "progress.json"), host)
    expect(state.summary.action).toBe("await_owner_gates")
    expect(state.summary.pending_owner_gates).toContain("B1")
    await write("set_owner_gate", { id: "B1", status: "approved", decided_by: "owner", authority: "standing_delegation", quote: "You may run this approved suite." }, host, "u1")
    await write("set_verdict", { v: "pass" }, host, "u1")
    await write("set_owner_gate", { id: "B2", status: "pending", description: "Owner accepts live results." }, host)
    await expect(write("update_phase_gate", { g: "pass" }, host)).rejects.toThrow("OWNER GATES PENDING")
    state = await readSessionState(ledger, path.join(dir, "progress.json"), host)
    expect(state.summary.action).toBe("await_owner_gates")
    expect((await readLedger(ledger)).phases.p1.units.u1.owner_gate_history).toHaveLength(2)
  })

  it("gives an executable fix for a stale progress entry", async () => {
    await write("set_unit_status", delegate, host, "u1")
    await write("set_verdict", { v: "pass" }, host, "u1")
    const progress = path.join(dir, "progress.json")
    await writeProgress(progress, { operation: "update_status", data: { phase: "p1", unit_id: "u1", status: "in_progress", notes: "Earlier progress." } })
    const stale = await readSessionState(ledger, progress, host)
    expect(stale.summary.progress_advisories).toContain("stale:p1/u1")
    expect(stale.summary.progress_advisories_hint).toContain("operation:'update_status'")
    await writeProgress(progress, { operation: "update_status", data: { phase: "p1", unit_id: "u1", status: "complete", notes: "Reconciled to ledger pass" } })
    expect((await readSessionState(ledger, progress, host)).summary.progress_advisories).toBe("none")
  })
})

it("names the top-level verifier checked field", () => {
  expect(reviewIncompleteness({ advisor: "native", ts: "", stage: "native", completion: "complete", findings: [], native: { verifier_id: "v", reviewers: [
    { agent_id: "a", lens: "contract", completion: "complete", checked: ["app"] }, { agent_id: "b", lens: "tests", completion: "complete", checked: ["tests"] },
  ] } })).toContain("top-level data.checked")
})

it("recognizes PowerShell suites on Test lines and fenced standalone commands", async () => {
  for (const command of ["Test: pwsh -File ./tests/check.ps1", "Test:\n```powershell\npwsh -File ./tests/check.ps1\n```", "```powershell\npowershell.exe -File ./tests/check.ps1\n```", "Checkpoint: npm test"]) {
    const result = checkpointFromSpec(`# Spec\n#### u1 — test\n${command}\n`, "u1")
    expect(result.def?.commands).toHaveLength(1)
    expect((await checkpointReach(dir, result.def!, ["app.ts"])).status).toBe("unknown")
  }
})

it("hash guards non-git trees, freezes exclusions, and detects same-size, added and deleted files", async () => {
  await fs.writeFile(path.join(dir, "app.txt"), "aaaa")
  await fs.writeFile(path.join(dir, "other.txt"), "bbbb")
  await fs.writeFile(path.join(dir, "deleted.txt"), "cccc")
  await fs.mkdir(path.join(dir, "cache"))
  await write("set_unit_status", { ...delegate, guard: { mode: "hash", allowed_files: ["app.txt"], exclude_globs: ["cache/**"] } }, "generic", "u1")
  await fs.writeFile(path.join(dir, "app.txt"), "dddd")
  await fs.writeFile(path.join(dir, "other.txt"), "eeee")
  await fs.unlink(path.join(dir, "deleted.txt"))
  await fs.writeFile(path.join(dir, "new.txt"), "ffff")
  await fs.writeFile(path.join(dir, "cache", "ignored.txt"), "gggg")
  expect(await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: dir, exclude_globs: ["**"] }, { ledgerPath: ledger })).toContain("status: refused")
  const result = await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: dir }, { ledgerPath: ledger })
  expect(result).toContain("status: violation")
  expect(result).toContain("other.txt")
  expect(result).toContain("deleted.txt")
  expect(result).toContain("new.txt")
  expect(result).not.toContain("ignored.txt")
  await expect(write("set_verdict", { v: "pass" }, "generic", "u1")).rejects.toThrow("REPOSITORY GUARD")
})

it.each(["claude-code", "codex", "cursor"] as const)("detects missing frontier agents and installs them for %s", async (host) => {
  await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ [host]: { frontier: "configured-frontier" } }))
  expect((await workerSeatStatus(dir, host)).missing_worker_agents).toMatch(/frontier/)
  if (host === "claude-code") await claudeAgentsInit({ project_dir: dir })
  else if (host === "codex") await codexAgentsInit({ project_dir: dir })
  else await cursorAgentsInit({ project_dir: dir })
  expect((await workerSeatStatus(dir, host)).missing_worker_agents).toBe("none")
  expect((await workerSeatStatus(dir, host)).worker_seats).toContain("configured-frontier")
  const file = host === "codex" ? ".codex/agents/worker_frontier.toml" : `${host === "cursor" ? ".cursor" : ".claude"}/agents/foreman-worker-frontier.md`
  expect(await fs.readFile(path.join(dir, file), "utf8")).toContain("configured-frontier")
})

it("refuses incomplete hash baselines and exclusions hiding authorized paths", async () => {
  await fs.writeFile(path.join(dir, "a.txt"), "aaa")
  await fs.writeFile(path.join(dir, "b.txt"), "bbb")
  await expect(write("set_unit_status", { ...delegate, guard: { mode: "hash", allowed_files: ["a.txt"], max_entries: 1 } }, "generic", "u1")).rejects.toThrow("GUARD BLOCKED")
  expect((await readLedger(ledger)).phases).toEqual({})
  await expect(write("set_unit_status", { ...delegate, guard: { mode: "hash", allowed_files: ["cache/a.txt"], exclude_globs: ["cache"] } }, "generic", "u1")).rejects.toThrow("authorized file or its parent")
})

it("clears a hash guard when only authorized and excluded files change", async () => {
  await fs.writeFile(path.join(dir, "allowed.txt"), "one")
  await fs.writeFile(path.join(dir, "untouched.txt"), "same")
  await write("set_unit_status", { ...delegate, guard: { mode: "hash", allowed_files: ["allowed.txt"], exclude_globs: ["*.log"] } }, "generic", "u1")
  await fs.writeFile(path.join(dir, "allowed.txt"), "two")
  await fs.writeFile(path.join(dir, "test.log"), "run output")
  expect(await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: "u1", project_dir: dir }, { ledgerPath: ledger })).toContain("status: ok")
  await write("set_verdict", { v: "pass" }, "generic", "u1")
})

it("supports frontier routing in generic .foremanenv configurations", async () => {
  await fs.writeFile(path.join(dir, ".foremanenv"), "schema_version=1\nFOREMAN_API_BASE=https://example.test/v1\nFOREMAN_API_KEY=${ENV:TEST_WORKER_KEY}\nFOREMAN_TIER_FRONTIER=frontier-model\nFOREMAN_WORKER_CLASS_FRONTIER=frontier\n")
  const result = await loadForemanEnv({ dir, requireKey: false })
  expect(result.status).toBe("ok")
  if (result.status === "ok") expect(result.config.tiers.frontier?.model).toBe("frontier-model")
})

it.each([
  ["claude-code", "opus", "claude-opus-5-5"],
  ["codex", "gpt-6-astra", "gpt-6-astra"],
] as const)("enforces the shipped model pin even without installed agents on %s", async (host, required, observed) => {
  await write("set_unit_status", { ...delegate, tier: "premium" }, host, "u1")
  expect((await readLedger(ledger)).phases.p1.units.u1.delegations![0].required_model).toBe(required)
  await expect(write("set_verdict", { v: "pass" }, host, "u1")).rejects.toThrow("WORKER MODEL")
  await expect(write("set_verdict", { v: "pass", worker_model: "claude-sonnet-4-6", model_evidence: "Observed another family" }, host, "u1")).rejects.toThrow("WORKER MODEL")
  await write("set_verdict", { v: "pass", worker_model: observed, model_evidence: "Host transcript confirms " + observed }, host, "u1")
})

it("requires model evidence for a declared tier in a pre-upgrade attempt", async () => {
  await write("set_unit_status", { ...delegate, tier: "premium" }, "claude-code", "u1")
  const old = await readLedger(ledger)
  delete old.phases.p1.units.u1.delegations![0].required_model
  await fs.writeFile(ledger, JSON.stringify(old))
  await expect(write("set_verdict", { v: "pass" }, "claude-code", "u1")).rejects.toThrow("WORKER MODEL")
  await write("set_verdict", { v: "pass", worker_model: "opus", model_evidence: "Host transcript names opus" }, "claude-code", "u1")
})

it("keeps an explicitly inherited model unpinned when configuration changes later", async () => {
  await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ cursor: { frontier: "inherit" } }))
  await write("set_unit_status", { ...delegate, tier: "frontier" }, "cursor", "u1")
  await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ cursor: { frontier: "new-model" } }))
  await write("set_verdict", { v: "pass" }, "cursor", "u1")
  expect((await readLedger(ledger)).phases.p1.units.u1.delegations![0].required_model).toBeNull()
})
