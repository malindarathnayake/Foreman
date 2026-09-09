// Field feedback 2026-09, round 5 (v0.6.5): a silent advisor seat reads as failed;
// drift blocks only on a contradiction and reports advisories; review currency ignores
// cross_exam-only records; stage:'verification' with evidence for direct-fix follow-ups;
// authorize_attempts as one recorded owner decision past the cap; checked[] to 400;
// legacy checkbox lines outside the fence are counted, never edited.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createServer } from "../src/server.js"
import { renderIncludes } from "../src/lib/skillLoader.js"
import { ATTEMPT_CAP, readLedger, writeLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { handleReadLedger } from "../src/tools/readLedger.js"
import { sessionOrient } from "../src/tools/sessionOrient.js"
import { formatAdvisorResult } from "../src/tools/invokeAdvisor.js"
import { countLegacyCheckboxes, handleWriteProgress } from "../src/tools/writeProgress.js"
import type { ExternalCliResult } from "../src/lib/externalCli.js"
import type { SidecarEvent } from "../src/lib/eventsSidecar.js"
import type { VerificationEvidence } from "../src/types.js"

let tmpDir: string
let ledgerPath: string
let progressPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ff-2026-09d-"))
  ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
  progressPath = path.join(tmpDir, ".foreman-progress.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }
const LOW = { severity: "low" as const, file: "src/a.ts", line: "7", description: "test name typo", classification: "confirmed" as const }
const HIGH = { severity: "high" as const, file: "src/a.ts", line: "42", description: "null deref", classification: "confirmed" as const }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function delegate(unit: string, opts: { user_override?: boolean } = {}) {
  return writeLedger(ledgerPath, {
    operation: "set_unit_status",
    phase: "p1",
    unit_id: unit,
    data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT, ...opts },
  })
}
async function directFix(unit: string, what = "src/a.ts: rename fooBar to foo_bar", opts: { user_override?: boolean } = {}) {
  return writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: unit, data: { s: "ip", direct_fix: what, ...opts } })
}
async function reject(unit: string, msg = "not what the spec says") {
  return writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: unit, data: { r: "reviewer", msg, ts: "2026-09-04T00:00:00Z" } })
}
async function verdict(
  unit: string,
  v: "pass" | "fail" | "inconclusive" | "pending",
  opts: { user_override?: boolean; via?: "worker" | "pitboss-direct" | "n/a" } = {}
) {
  return writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: unit, data: { v, ...opts } })
}
async function review(data: Record<string, unknown>, sidecar?: () => Promise<SidecarEvent[]>) {
  return writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data } as never, undefined, sidecar)
}
async function gate(opts: { user_override?: boolean; agent_class?: "frontier" } = {}, sidecar?: () => Promise<SidecarEvent[]>) {
  return writeLedger(ledgerPath, { operation: "update_phase_gate", phase: "p1", data: { g: "pass", ...opts } }, undefined, sidecar)
}
async function authorize(unit: string, attempts: number, reason = "owner accepts three more rounds on this unit") {
  return writeLedger(ledgerPath, { operation: "authorize_attempts", phase: "p1", unit_id: unit, data: { attempts, reason, user_override: true } })
}
async function unitOf(unit: string) {
  return (await readLedger(ledgerPath)).phases.p1.units[unit]
}
async function latestReviewTs(): Promise<string> {
  const reviews = (await readLedger(ledgerPath)).phases.p1.reviews!
  return reviews[reviews.length - 1].ts
}
async function delegatePass(unit: string) {
  await delegate(unit)
  await verdict(unit, "pass")
}
async function threeFailed(unit = "u1") {
  for (let i = 0; i < ATTEMPT_CAP; i++) {
    await delegate(unit)
    await reject(unit, `rejection ${i + 1}`)
  }
}

async function withServer<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = await createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "ff-2026-09d", version: "1.0.0" })
  await client.connect(clientTransport)
  try {
    return await fn(client)
  } finally {
    await client.close()
    await server.close()
  }
}
async function toolDescription(name: string): Promise<string> {
  return withServer(async (client) => (await client.listTools()).tools.find((t) => t.name === name)?.description ?? "")
}

function evidence(over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    baseline_review_ts: "",
    units: [{ unit_id: "u1", attempt: 2 }],
    files: ["src/a.ts"],
    tests: { outcome: "pass", command: "npm test", result: "12 passed" },
    probe: { outcome: "pass", method: "removed the guard", result: "focused suite failed as expected" },
    ...over,
  }
}

/** Independent LOW-only review, then a direct-fix re-verdict of u1 (attempt 2). Returns the baseline ts. */
async function baselineThenDirectFix(baseFindings: Array<typeof LOW | typeof HIGH> = [LOW]): Promise<string> {
  await delegatePass("u1")
  await sleep(5)
  await review({ advisor: "codex", stage: "independent", completion: "complete", findings: baseFindings, checked: ["src/a.ts"] })
  const baseline = await latestReviewTs()
  await sleep(5)
  await reject("u1", "nit")
  await directFix("u1")
  await verdict("u1", "pass", { via: "pitboss-direct" })
  await sleep(5)
  return baseline
}

// ─── item 5: checked[] entries up to 400 characters ────────────────────────────

describe("checked[] cap", () => {
  it("accepts 400-character entries and refuses 401", async () => {
    await handleWriteLedger(ledgerPath, {
      operation: "record_review",
      phase: "p1",
      data: { advisor: "codex", findings: [], completion: "complete", checked: ["x".repeat(400)] },
    })
    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "record_review",
        phase: "p1",
        data: { advisor: "codex", findings: [], completion: "complete", checked: ["x".repeat(401)] },
      })
    ).rejects.toThrow(/data\.checked\.0: [\s\S]*checked\?: string \(≤400 chars\)\[\] \(max 50\)/)
  })
})

// ─── item 1: a silent advisor seat is a failed seat ────────────────────────────

describe("invoke_advisor — empty or echoed output is a failed seat", () => {
  const base: ExternalCliResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false }

  it("exit 0 with whitespace stdout: completion failed, reason named, exit code kept, stderr tail kept", () => {
    const text = formatAdvisorResult("gemini", { ...base, stdout: "  \r\n", stderr: "Loaded 3 tools\nAgent execution stopped" })
    expect(text).toContain("exit_code: 0")
    expect(text).toContain("completion: failed")
    expect(text).toContain("failure_reason: empty_stdout")
    expect(text).toContain("empty_output: true")
    expect(text).toContain("record it with completion:'failed' and the reason in limitations, then retry once")
    expect(text).toContain("STDERR (tail 2 of 2 lines)\nLoaded 3 tools\nAgent execution stopped")
  })

  it("a truncation sentinel with nothing behind it is still empty", () => {
    const text = formatAdvisorResult("gemini", { ...base, stdout: "...(truncated)\n", truncated: true, stdoutTruncated: true })
    expect(text).toContain("failure_reason: empty_stdout")
  })

  it("stdout equal to the prompt is echoed_prompt, not a review", () => {
    const prompt = "Review these phase changes against the spec.\nList any gaps."
    const text = formatAdvisorResult("codex", { ...base, stdout: prompt.replace(/\n/g, "\r\n") + "\r\n" }, prompt)
    expect(text).toContain("completion: failed")
    expect(text).toContain("failure_reason: echoed_prompt")
    expect(text).not.toContain("empty_output")
  })

  it("real output on exit 0 and a non-zero exit are untouched", () => {
    const ok = formatAdvisorResult("gemini", { ...base, stdout: "[LOW] src/a.ts:7 typo" }, "the prompt")
    expect(ok).not.toContain("completion: failed")
    expect(ok).toContain("STDOUT\n[LOW] src/a.ts:7 typo")
    const failed = formatAdvisorResult("gemini", { ...base, stdout: "", stderr: "quota exceeded", exitCode: 2 })
    expect(failed).not.toContain("completion: failed")
    expect(failed).toContain("STDERR\nquota exceeded")
  })

  it("the description and the checkpoint protocol say so", async () => {
    expect(await toolDescription("invoke_advisor")).toContain("reported as completion: failed")
    const skillPath = fileURLToPath(new URL("../src/skills/implementor.md", import.meta.url))
    const implementor = await renderIncludes(await fs.readFile(skillPath, "utf-8"), skillPath)
    expect(implementor).toContain("An advisor result marked `completion: failed` (empty or echoed output, non-zero exit) is not a seat")
  })
})

// ─── item 4 (a): cross_exam never satisfies review currency ────────────────────

describe("review currency — cross_exam-only records do not count", () => {
  it("a cross_exam recorded after a re-verdict is REVIEW REQUIRED; an independent record passes", async () => {
    await baselineThenDirectFix()
    await review({ advisor: "gemini", stage: "cross_exam", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await expect(gate()).rejects.toThrow(
      /REVIEW REQUIRED: phase 'p1' has no record_review entry recorded at or after its latest unit verdict\. 1 older review\(s\) exist but predate[\s\S]*1 current record\(s\) do not count as a seat: a cross_exam never does/
    )
    await review({ advisor: "codex", stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await gate()
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override).toBeUndefined()
  })

  it("a confirmed finding in a current cross_exam still blocks even beside an independent record", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "complete", findings: [], checked: ["src/a.ts"] })
    await review({ advisor: "gemini", stage: "cross_exam", completion: "complete", findings: [HIGH] })
    await expect(gate()).rejects.toThrow(/CONFIRMED FINDINGS/)
  })

  it("council payloads carry stage: independent", async () => {
    const council = await fs.readFile(new URL("../src/tools/invokeCouncil.ts", import.meta.url), "utf-8")
    expect(council).toContain('stage: "independent",')
  })
})

// ─── item 4 (b): stage:'verification' for direct-fix follow-ups ────────────────

describe("stage: verification", () => {
  it("needs completion:'complete' and evidence; evidence is refused on other stages", async () => {
    await expect(
      review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [] })
    ).rejects.toThrow(/VERIFICATION INCOMPLETE: stage:'verification' needs completion:'complete' and data\.evidence/)
    await expect(
      review({ advisor: "pitboss", stage: "verification", completion: "partial", findings: [], evidence: evidence({ baseline_review_ts: "x" }) })
    ).rejects.toThrow(/VERIFICATION INCOMPLETE/)
    await expect(
      review({ advisor: "codex", stage: "independent", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: "x" }) })
    ).rejects.toThrow(/VERIFICATION EVIDENCE: data\.evidence is accepted with stage:'verification' only/)
  })

  it("an eligible verification closes a LOW-only direct-fix follow-up without a fresh seat", async () => {
    const baseline = await baselineThenDirectFix()
    await review({
      advisor: "pitboss",
      stage: "verification",
      completion: "complete",
      findings: [],
      checked: ["src/a.ts"],
      evidence: evidence({ baseline_review_ts: baseline }),
    })
    await gate()
    const phase = (await readLedger(ledgerPath)).phases.p1
    expect(phase.g).toBe("pass")
    expect(phase.review_override).toBeUndefined()
    expect(phase.reviews![phase.reviews!.length - 1].evidence?.units).toEqual([{ unit_id: "u1", attempt: 2 }])
  })

  it("is ineligible when the baseline is not a retained independent review", async () => {
    await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: "2020-01-01T00:00:00.000Z" }) })
    await expect(gate()).rejects.toThrow(/REVIEW REQUIRED[\s\S]*pitboss: baseline_review_ts 2020-01-01T00:00:00\.000Z is not a retained independent review/)
  })

  it("is ineligible when the re-verdict was a worker delegation, not a direct fix", async () => {
    await delegatePass("u1")
    await sleep(5)
    await review({ advisor: "codex", completion: "complete", findings: [LOW], checked: ["src/a.ts"] })
    const baseline = await latestReviewTs()
    await sleep(5)
    await reject("u1", "nit")
    await delegate("u1")
    await verdict("u1", "pass", { via: "worker" })
    await sleep(5)
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    await expect(gate()).rejects.toThrow(/unit 'u1' was re-verdicted after the baseline but not as a passing direct fix/)
  })

  it("is ineligible when evidence names the wrong attempt", async () => {
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline, units: [{ unit_id: "u1", attempt: 1 }] }) })
    await expect(gate()).rejects.toThrow(/evidence\.units does not name 'u1' attempt #2/)
  })

  it("is ineligible after a confirmed finding above LOW since the baseline", async () => {
    const baseline = await baselineThenDirectFix([HIGH])
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    await expect(gate()).rejects.toThrow(/1 confirmed finding\(s\) above LOW since the baseline review/)
  })

  it("is ineligible on a hot_path or security_boundary phase", async () => {
    await writeLedger(ledgerPath, { operation: "set_phase_scope", phase: "p1", data: { has_tests: true, has_api: false, has_build: true, security_boundary: true } })
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    // SEAT MINIMUM is sequenced first; declare the frontier seat so the currency check is reached.
    await expect(gate({ agent_class: "frontier" }, async () => [])).rejects.toThrow(/phase is scoped hot_path or security_boundary; those need a seat/)
  })

  it("is ineligible when the sidecar shows the attempt was an invoke_worker delegation", async () => {
    const baseline = await baselineThenDirectFix()
    await review({ advisor: "pitboss", stage: "verification", completion: "complete", findings: [], evidence: evidence({ baseline_review_ts: baseline }) })
    // A clean terminal chain, so DISCIPLINE ADHERENCE (sequenced first) passes and the
    // attempt-identity predicate is what refuses: attempt 2 was a worker, not a direct fix.
    const sidecar = async () => [
      { phase: "p1", unit_id: "u1", attempt: 2, delegation_id: "d2", event_type: "validation_completed", outcome: "pass" } as unknown as SidecarEvent,
    ]
    await expect(gate({}, sidecar)).rejects.toThrow(/unit 'u1' attempt #2 is an invoke_worker delegation in the sidecar, not a direct fix/)
  })

  it("the implementor names the verification path and its limits", async () => {
    const skillPath = fileURLToPath(new URL("../src/skills/implementor.md", import.meta.url))
    const implementor = await renderIncludes(await fs.readFile(skillPath, "utf-8"), skillPath)
    expect(implementor).toContain('record_review { stage: "verification", completion: "complete", checked:')
    expect(implementor).toContain('evidence: { kind: "worker_delta", verifier_id:')
    expect(implementor).toContain("a `cross_exam` record never counts as a seat")
  })
})

// ─── item 3: authorize_attempts — one owner decision past the cap ──────────────

describe("authorize_attempts", () => {
  it("is refused below the cap, on an unregistered unit, and on a passed unit", async () => {
    await expect(authorize("u9", 2)).rejects.toThrow(/AUTHORIZE BLOCKED: unit 'u9' is not registered in phase 'p1'/)
    await delegate("u1")
    await reject("u1")
    await expect(authorize("u1", 2)).rejects.toThrow(/AUTHORIZE BLOCKED: unit 'u1' has 1 failed attempt\(s\) since its last pass \(cap 3\)\. Below the cap attempts need no authorization/)
    await delegatePass("u2")
    await expect(authorize("u2", 1)).rejects.toThrow(/AUTHORIZE BLOCKED: unit 'u2' has a pass verdict/)
  })

  it("charges attempts to the grant, refuses a second open grant, closes on exhaustion, then the cap applies again", async () => {
    await threeFailed()
    const { warning } = await authorize("u1", 2)
    expect(warning).toMatch(/grant #1: 2 attempt\(s\) authorized on 'u1' past the cap/)
    await expect(authorize("u1", 1)).rejects.toThrow(/already has grant #1 with 2 attempt\(s\) remaining/)

    await delegate("u1")
    let unit = await unitOf("u1")
    expect(unit.delegations![3].cap_grant_id).toBe(1)
    expect(unit.delegations![3].user_override).toBeUndefined()
    expect(unit.cap_grants![0]).toMatchObject({ id: 1, granted: 2, remaining: 1, consumed: [4], failed_at_issue: 3, at_attempt: 3 })
    expect(unit.cap_override_attempt).toBe(4)

    await reject("u1", "fourth rejection")
    await expect(delegate("u1", { user_override: true })).rejects.toThrow(/AMBIGUOUS OVERRIDE: unit 'u1' has grant #1 with 1 attempt\(s\) remaining/)
    await directFix("u1")
    unit = await unitOf("u1")
    expect(unit.direct_fixes![0].cap_grant_id).toBe(1)
    expect(unit.cap_grants![0].remaining).toBe(0)
    expect(unit.cap_grants![0].closed?.reason).toBe("exhausted")

    await reject("u1", "fifth rejection")
    await expect(delegate("u1")).rejects.toThrow(/DELEGATION CAP: unit 'u1' has 5 failed attempts[\s\S]*record it once with authorize_attempts/)
    const second = await authorize("u1", 1, "one last round with the reviewer diagnosis added")
    expect(second.warning).toMatch(/grant #2/)
  })

  it("a granted attempt carries its pass; the pass closes what is left of the grant", async () => {
    await threeFailed()
    await authorize("u1", 3)
    await delegate("u1")
    await verdict("u1", "pass")
    const unit = await unitOf("u1")
    expect(unit.v).toBe("pass")
    expect(unit.cap_override).toBeUndefined()
    expect(unit.cap_grants![0]).toMatchObject({ remaining: 2, consumed: [4] })
    expect(unit.cap_grants![0].closed?.reason).toBe("pass")
    // A later reopen starts a fresh series with no inherited authorization.
    await reject("u1", "checkpoint finding")
    await delegate("u1")
    expect((await unitOf("u1")).delegations![4].cap_grant_id).toBeUndefined()
  })

  it("session_orient and read_ledger show the open grant instead of a cap block", async () => {
    await threeFailed()
    let orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("attempt_blocks: p1/u1:cap(3)")
    expect(orient).toContain("attempt_grants: none")
    await authorize("u1", 2)
    orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("attempt_blocks: p1/u1:needs_attempt")
    expect(orient).toContain("attempt_grants: p1/u1:#1(2 left)")
    expect(await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })).toContain("cap_grant: #1 open, 2 of 2 remaining")
    await delegate("u1")
    await verdict("u1", "pass")
    expect(await handleReadLedger(ledgerPath, { phase: "p1", unit_id: "u1" })).toContain("cap_grant: #1 closed (pass), 1/2 used")
  })

  it("the description lists the operation", async () => {
    expect(await toolDescription("write_ledger")).toContain("authorize_attempts (unit_id) — the owner's decision, once")
  })
})

// ─── item 2: drift blocks only on a contradiction; the rest are advisories ─────

describe("state_drift and progress_advisories", () => {
  async function seedProgress(units: Array<{ phase: string; id: string; status: string }>) {
    const phases: Record<string, { name: string; units: Record<string, unknown> }> = {}
    for (const u of units) {
      phases[u.phase] ??= { name: u.phase, units: {} }
      phases[u.phase].units[u.id] = { id: u.id, phase: u.phase, status: u.status, notes: "" }
    }
    await fs.writeFile(progressPath, JSON.stringify({ phases, error_log: [] }), "utf-8")
  }

  it("a pending entry for a later unit is 'ahead', not drift", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p5", unit_id: "u1", data: { s: "ip" } })
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p7", unit_id: "u4", data: { s: "pending" } })
    await seedProgress([{ phase: "p7", id: "u4", status: "pending" }])
    const orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("resume_target: p5/u1")
    expect(orient).toContain("state_drift: none")
    expect(orient).toContain("progress_advisories: ahead:p7/u4")
  })

  it("an open entry for a passed unit is 'stale'; an unknown unit is 'orphan'", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u2", data: { s: "pending" } })
    await seedProgress([
      { phase: "p1", id: "u1", status: "in_progress" },
      { phase: "P4", id: "U4.2", status: "in_progress" },
    ])
    const orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("state_drift: none")
    expect(orient).toContain("progress_advisories: stale:p1/u1;orphan:P4/U4.2")
  })

  it("progress marking an unpassed unit complete is the contradiction that blocks", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u2", data: { s: "pending" } })
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u3", data: { s: "pending" } })
    await seedProgress([
      { phase: "p1", id: "u2", status: "complete" },
      { phase: "p1", id: "u3", status: "complete" },
    ])
    const orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("state_drift: progress:complete(p1/u2);ledger:p1/u2 (+1 more)")
  })

  it("a declared-but-unregistered unit marked complete is a contradiction too", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "declare_phase_units", phase: "p1", data: { units: ["u1", "u2"] } })
    await seedProgress([{ phase: "p1", id: "u2", status: "complete" }])
    expect(await sessionOrient(ledgerPath, progressPath)).toContain("state_drift: progress:complete(p1/u2);ledger:p1/u2")
  })

  it("the resume target itself, open in progress, is neither drift nor an advisory", async () => {
    await delegatePass("u1")
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u2", data: { s: "ip" } })
    await seedProgress([{ phase: "p1", id: "u2", status: "in_progress" }])
    const orient = await sessionOrient(ledgerPath, progressPath)
    expect(orient).toContain("state_drift: none")
    expect(orient).toContain("progress_advisories: none")
  })

  it("progress units with no ledger phases still block", async () => {
    await seedProgress([{ phase: "p1", id: "u1", status: "complete" }])
    expect(await sessionOrient(ledgerPath, progressPath)).toContain("state_drift: progress:p1/u1;ledger:no_phases")
  })
})

// ─── item 6: legacy checkbox lines are counted, never edited ───────────────────

describe("legacy checkbox candidates", () => {
  it("matches an item whose text is the unit id, in backticks or not, and nothing looser", () => {
    const md = [
      "- [ ] p7.4 — wire the retry",
      "- [ ] `p7.4`: wire the retry",
      "* [ ] p7.4",
      "- [ ] p7.40 — other unit",
      "- [ ] Update p7.4 and validate p7.5",
      "- [ ] Confirm p7.4 remains disabled",
      "- [x] p7.4 — already ticked",
      "<!-- foreman:checklist-start -->",
      "- [ ] p7.4 — inside the fence",
      "<!-- foreman:checklist-end -->",
    ].join("\n")
    expect(countLegacyCheckboxes(md, "p7.4")).toBe(3)
    expect(countLegacyCheckboxes(md, "p7.40")).toBe(1)
    expect(countLegacyCheckboxes(md, "p7")).toBe(0)
  })

  it("complete_unit reports the count, changes nothing outside the fence, and stays silent when there is none", async () => {
    const md = "# Plan\n\n- [ ] p1.1 — first unit\n- [ ] p1.2 — second unit\n\n<!-- foreman:checklist-start -->\n<!-- foreman:checklist-end -->\n"
    await fs.writeFile(path.join(tmpDir, "PROGRESS.md"), md, "utf-8")
    const first = await handleWriteProgress(
      progressPath,
      { operation: "complete_unit", data: { unit_id: "p1.1", phase: "p1", completed_at: "2026-09-04", notes: "done" } },
      tmpDir,
      ledgerPath
    )
    expect(first).toContain("legacy_checkbox_candidates: 1")
    expect(first).toContain("legacy_checkbox_action: not_modified")
    expect(first).toContain("The ledger checklist inside the fence is authoritative")
    const after = await fs.readFile(path.join(tmpDir, "PROGRESS.md"), "utf-8")
    expect(after).toContain("- [ ] p1.1 — first unit\n- [ ] p1.2 — second unit\n")
    const second = await handleWriteProgress(
      progressPath,
      { operation: "complete_unit", data: { unit_id: "p9.9", phase: "p9", completed_at: "2026-09-04", notes: "done" } },
      tmpDir,
      ledgerPath
    )
    expect(second).not.toContain("legacy_checkbox")
    expect(await toolDescription("write_progress")).toContain("legacy_checkbox_candidates")
  })
})
