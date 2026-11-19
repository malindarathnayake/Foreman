// 0.9.7: review sufficiency, native review and the independence bound on the antigravity host.
// The host's own provider stays unknown (hostProvider null), so a single receipted seat is
// 'receipted' and two receipted seats from distinct vendors reach 'receipted_external' through
// the existing two-vendor rule. Declared model rank never enters sufficiency.
import { writeLedger } from "./helpers/authorizedLedger.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readLedger, writeLedger as rawWriteLedger } from "../src/lib/ledger.js"
import { appendReceipt, receiptsPathFor, sha256Hex, type ReceiptInput } from "../src/lib/seatReceipts.js"
import {
  classifyGate, hostProvider, independenceDecision, independenceHint, isWeakBasis, NATIVE_REVIEW_HOSTS, seatBasis, STREAK_MAX,
} from "../src/lib/reviewBasis.js"
import { resolveModelRank } from "../src/lib/modelRank.js"
import { handleInvokeCouncil } from "../src/tools/invokeCouncil.js"
import type { HostId } from "../src/lib/hostProfiles.js"
import type { GateEvidence, LedgerFile, Phase, PhaseReview, Provenance, WriteLedgerInput } from "../src/types.js"

let dir: string
let ledgerPath: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-18T15:00:00Z"))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-agy-basis-"))
  ledgerPath = path.join(dir, "ledger.json")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const HOST: HostId = "antigravity"

async function write(operation: Record<string, unknown>, host: HostId = HOST) {
  const result = await writeLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, host, undefined, undefined, { projectRoot: dir })
  vi.setSystemTime(Date.now() + 1000)
  return result
}
async function unit(phase: string, unit_id = "u1", host: HostId = HOST) {
  await write({ operation: "set_unit_status", phase, unit_id, data: {
    s: "delegated", brief: "Implement the bounded change for this unit", preflight: { symbols_grepped: 1, self_consistent: true },
  } }, host)
  await write({ operation: "set_verdict", phase, unit_id, data: { v: "pass" } }, host)
}
const nativeReview = () => ({
  advisor: "antigravity-native", stage: "native", completion: "complete", findings: [], checked: ["src/a.ts"],
  native: {
    reviewers: [
      { agent_id: "conv-contract", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
      { agent_id: "conv-tests", lens: "tests", completion: "complete", checked: ["tests/a.test.ts"] },
    ],
    verifier_id: "conv-verifier",
  },
})
const independent = (advisor: string) => ({ advisor, stage: "independent", completion: "complete", findings: [], checked: ["src/a.ts"] })

const PROMPT = "Review these phase changes against the spec.\n" + "x".repeat(1200)
const SEATS = {
  claude: { cli: "claude", provider: "anthropic", model_served: "claude-fable-5-2" },
  codex: { cli: "codex", provider: "openai", model_served: "gpt-6.2-astra" },
  gemini: { cli: "gemini", provider: "google", model_served: "gemini-4-hydrogen-tiered-xhigh" },
} as const
/** Record one receipted independent seat on the phase's current code. */
async function receiptedSeat(phase: string, seat: keyof typeof SEATS, host: HostId = HOST) {
  const input: ReceiptInput = {
    ...SEATS[seat], exit_code: 0, failure_reason: null,
    prompt_sha256: sha256Hex(PROMPT), bytes_in: Buffer.byteLength(PROMPT), bytes_out: 900,
  }
  const r = await appendReceipt(receiptsPathFor(ledgerPath), input)
  vi.setSystemTime(Date.now() + 1000)
  await write({ operation: "record_review", phase, data: { ...independent(seat), seat_receipt: r.id, packet_hash: r.prompt_sha256 } }, host)
}
const gate = (phase: string, data: Record<string, unknown> = { g: "pass" }, host: HostId = HOST) =>
  write({ operation: "update_phase_gate", phase, data }, host)
const stamp = async (phase: string) => (await readLedger(ledgerPath)).phases[phase].gate_history!.at(-1)!

// ─── Review basis through the ledger ─────────────────────────────────────────

describe("antigravity review basis: the host provider stays unknown", () => {
  it("hostProvider is null and only codex and antigravity are native-review hosts", () => {
    expect(hostProvider("antigravity")).toBeNull()
    expect([...NATIVE_REVIEW_HOSTS].sort()).toEqual(["antigravity", "codex"])
  })

  it("a single receipted claude seat is receipted, not external", async () => {
    await unit("p1")
    await receiptedSeat("p1", "claude")
    await gate("p1")
    expect((await stamp("p1")).basis).toBe("receipted")
    expect((await readLedger(ledgerPath)).phases.p1.reviews![0].provenance?.provider).toBe("anthropic")
  })

  it("claude + codex receipted seats are receipted_external", async () => {
    await unit("p1")
    await receiptedSeat("p1", "claude")
    await receiptedSeat("p1", "codex")
    await gate("p1")
    const g = await stamp("p1")
    expect(g.basis).toBe("receipted_external")
    expect(g.host).toBe("antigravity")
    expect(g.seats.map((s) => s.basis)).toEqual(["receipted", "receipted"])
  })

  it("gemini + claude receipted seats are receipted_external", async () => {
    await unit("p1")
    await receiptedSeat("p1", "gemini")
    await receiptedSeat("p1", "claude")
    await gate("p1")
    expect((await stamp("p1")).basis).toBe("receipted_external")
  })

  it("two receipted seats from one vendor stay receipted", async () => {
    await unit("p1")
    await receiptedSeat("p1", "claude")
    await receiptedSeat("p1", "claude")
    await gate("p1")
    expect((await stamp("p1")).basis).toBe("receipted")
  })

  it("the declared pit-boss model changes nothing in the basis", () => {
    const phase: Phase = { s: "ip", g: "pending", units: { u1: { s: "done", v: "pass", w: "b", rej: [], attempt_seq: 1 } } }
    const prov = (p: keyof typeof SEATS): Provenance => ({
      receipt: p.padEnd(16, "0"), cli: SEATS[p].cli, provider: SEATS[p].provider, model_served: SEATS[p].model_served, bytes_in: 4000, bytes_out: 900,
    })
    const seat = (p: keyof typeof SEATS, ts: string): PhaseReview =>
      ({ advisor: p, ts, findings: [], stage: "independent", host: "antigravity", provenance: prov(p) })
    const cases: Array<[PhaseReview[], string]> = [
      [[seat("claude", "2026-11-18T15:00:01.000Z")], "receipted"],
      [[seat("claude", "2026-11-18T15:00:01.000Z"), seat("codex", "2026-11-18T15:00:02.000Z")], "receipted_external"],
      [[seat("gemini", "2026-11-18T15:00:01.000Z"), seat("claude", "2026-11-18T15:00:02.000Z")], "receipted_external"],
    ]
    for (const [seats, expected] of cases) {
      for (const rank of [resolveModelRank(), resolveModelRank("gemini-4-hydrogen", "xhigh"), resolveModelRank("claude-opus-5-5", "high"), resolveModelRank("Gemini 4 Hydrogen (XHigh)")]) {
        const evidence = classifyGate({
          host: "antigravity", phaseObj: structuredClone(phase), currentReviews: seats, seats, allReviews: seats,
          modelRank: rank, overrides: [], ts: "2026-11-18T15:00:09.000Z",
        })
        expect(evidence.basis, `${rank.model ?? "undeclared"}`).toBe(expected)
      }
    }
    // A single gemini seat on antigravity is receipted, never same_provider: the host vendor is unknown.
    expect(seatBasis(seat("gemini", "2026-11-18T15:00:01.000Z"), "antigravity", [])).toBe("receipted")
  })
})

// ─── Native review on antigravity ────────────────────────────────────────────

describe("native review is accepted on antigravity", () => {
  it("a complete native review carries the gate as same_provider", async () => {
    await unit("p1")
    await write({ operation: "record_review", phase: "p1", data: nativeReview() })
    await gate("p1")
    const ledger = await readLedger(ledgerPath)
    const g = ledger.phases.p1.gate_history![0]
    expect(g.basis).toBe("same_provider")
    expect(g.seats[0].native_ids).toEqual(["conv-contract", "conv-tests", "conv-verifier"])
    expect(ledger.phases.p1.reviews![0].limitations).toMatch(/^Native antigravity subagents; same-provider review/)
  })

  it("stage:'native' is still refused on hosts without native subagents, naming antigravity", async () => {
    await unit("p1", "u1", "cursor")
    await expect(write({ operation: "record_review", phase: "p1", data: nativeReview() }, "cursor"))
      .rejects.toThrow("NATIVE REVIEW: stage:'native' requires a host with native subagents (codex, claude-code, antigravity).")
  })

  it("REVIEW REQUIRED names the native procedure on antigravity", async () => {
    await unit("p1")
    await expect(gate("p1")).rejects.toThrow(/REVIEW REQUIRED: .*Run a complete native subagent review \(stage:'native'/)
  })

  it("an unreceipted independent record warns on antigravity", async () => {
    await unit("p1")
    const out = await write({ operation: "record_review", phase: "p1", data: independent("claude") })
    expect(JSON.stringify(out)).toContain("SEAT RECEIPT: this independent record carries no receipt. On Antigravity an external seat run through invoke_advisor")
  })
})

// ─── The independence bound ──────────────────────────────────────────────────

describe("the independence bound on antigravity", () => {
  const ev = (basis: GateEvidence["basis"], host: HostId): GateEvidence => ({
    seq: 1, ts: "t", host, basis, seats: [], present: {}, unit_attempts: {}, units: 1, seat_agents: 1, regate: false, flagged: false,
    overrides: [], rank: { weight: 0, declared: false }, tokens: { receipted: 0, declared: 0, unreported: 0 }, policy_version: 1,
  })

  it("an unreceipted declared_external gate is weak, as on codex", () => {
    expect(isWeakBasis(ev("declared_external", "antigravity"))).toBe(true)
    expect(isWeakBasis(ev("receipted", "antigravity"))).toBe(false)
    expect(isWeakBasis(ev("receipted_external", "antigravity"))).toBe(false)
  })

  it("the refusal names two receipted seats from claude and codex", () => {
    const ledger = { independence: { streak: STREAK_MAX, phases: ["p1", "p2", "p3"] } } as unknown as LedgerFile
    const d = independenceDecision(ledger, "p4", ev("same_provider", "antigravity"))
    expect(d.refusal).toContain("Run two receipted seats from different vendors, e.g. invoke_advisor { cli: 'claude' } and invoke_advisor { cli: 'codex' }")
    expect(independenceHint("codex")).toBe("invoke_advisor { cli: 'claude' | 'gemini' }")
    expect(independenceHint("claude-code")).toBe("invoke_advisor { cli: 'codex' | 'gemini' }")
  })

  it("native passes are refused at the bound, and a claude + codex pair resets the streak", async () => {
    for (let i = 1; i <= STREAK_MAX; i++) {
      await unit(`p${i}`)
      await write({ operation: "record_review", phase: `p${i}`, data: nativeReview() })
      await gate(`p${i}`)
    }
    await unit("p4")
    await write({ operation: "record_review", phase: "p4", data: nativeReview() })
    await expect(gate("p4")).rejects.toThrow(/INDEPENDENCE BOUND: .*invoke_advisor \{ cli: 'claude' \} and invoke_advisor \{ cli: 'codex' \}/)
    await receiptedSeat("p4", "claude")
    await receiptedSeat("p4", "codex")
    await gate("p4")
    expect((await readLedger(ledgerPath)).independence).toEqual({ streak: 0, phases: [] })
  })

  it("a single receipted seat neither resets nor spends the streak", async () => {
    await unit("p1")
    await write({ operation: "record_review", phase: "p1", data: nativeReview() })
    await gate("p1")
    await unit("p2")
    await receiptedSeat("p2", "claude")
    await gate("p2")
    expect((await readLedger(ledgerPath)).independence).toEqual({ streak: 1, phases: ["p1"] })
  })
})

// ─── Worker seats named by a tier word ───────────────────────────────────────

describe("a tier-word worker seat on antigravity", () => {
  const raw = async (operation: Record<string, unknown>) => {
    const result = await rawWriteLedger(ledgerPath, operation as WriteLedgerInput, undefined, undefined, HOST, undefined, undefined, { projectRoot: dir })
    vi.setSystemTime(Date.now() + 1000)
    return result
  }
  const delegate = (tier: string) => raw({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
    s: "delegated", brief: "Implement the bounded change for this unit", tier, preflight: { symbols_grepped: 1, self_consistent: true },
  } })

  it("records no required model and does not block set_verdict pass", async () => {
    await delegate("premium")
    const d = (await readLedger(ledgerPath)).phases.p1.units.u1.delegations!.at(-1)!
    expect(d.required_model).toBeNull()
    await expect(raw({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).resolves.toBeDefined()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pass")
  })

  it("a concrete id from the mapping file is still enforced", async () => {
    await fs.writeFile(path.join(dir, ".foreman-worker-models.json"), JSON.stringify({ antigravity: { premium: "gemini-4-hydrogen-tiered-xhigh" } }))
    await delegate("premium")
    await expect(raw({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } }))
      .rejects.toThrow(/WORKER MODEL: .*tier premium requires gemini-4-hydrogen-tiered-xhigh/)
  })
})

// ─── Council-absent hint ─────────────────────────────────────────────────────

describe("invoke_council on antigravity", () => {
  it("names the claude and codex advisor seats when no council is configured", async () => {
    const deps = (host: HostId) => ({
      journalPath: path.join(dir, "journal.json"), envDir: dir, credentialsPath: path.join(dir, "missing.env"), host,
    })
    const args = { phase: "p1", objective: "Review the phase", evidence: "diff --git a/x.ts b/x.ts\n+const a = 1\n" }
    const agy = await handleInvokeCouncil(args, deps("antigravity"))
    expect(agy).toContain("status: unavailable")
    expect(agy).toContain("capability_check claude / codex, then invoke_advisor")
    const cc = await handleInvokeCouncil(args, deps("claude-code"))
    expect(cc).toContain("capability_check codex / gemini, then invoke_advisor")
  })
})
