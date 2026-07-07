// R3 lifecycle integration (Unit 4g): the write_ledger post-write hook closes out
// an OPEN S7 delegation's hash chain with the terminal event mapped from the
// ledger op that just landed. invoke_worker (4f) never appends its own terminal
// event for a successful patch — this hook is what does it, driven through the
// TOOL layer (handleWriteLedger), since that's where the hook lives.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import http from "http"
import { handleInvokeWorker, resetEgressNoticeForTest } from "../src/tools/invokeWorker.js"
import { PATCH_BEGIN, PATCH_END } from "../src/lib/workerResponse.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"
import { writeLedger, readLedger } from "../src/lib/ledger.js"
import { readEvents } from "../src/lib/eventsSidecar.js"
import { resetForTest } from "../src/lib/redaction.js"

// ── Obviously-fake, low-entropy fixture key (gitleaks-safe). Doubles as the API key. ──
const FIXTURE_KEY_NAME = "INVOKE_4G_FIXTURE_KEY"
const FIXTURE_KEY_VALUE = "fixture_key_4g000001"

// ── Fixtures ──────────────────────────────────────────────────────────────────────
const UNIFIED_DIFF_BODY = [
  "--- a/src.txt",
  "+++ b/src.txt",
  "@@ -1,2 +1,3 @@",
  " line1",
  "+line2",
  " line3",
].join("\n")

const METADATA_SUCCESS = '{"report":"success","files":["src.txt"],"confidence":0.7}'

function wrapPatch(body: string): string {
  return `${PATCH_BEGIN}\n${body}\n${PATCH_END}`
}

function workerText(metadata: string, patchBody?: string): string {
  return patchBody !== undefined ? `${metadata}\n${wrapPatch(patchBody)}` : metadata
}

function successResponse(res: http.ServerResponse, content: string, finish = "stop"): void {
  const payload = JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  })
  res.writeHead(200, { "content-type": "application/json" })
  res.end(payload)
}

// ── Mock endpoint (bare — request contents don't matter for this suite) ───────────
interface Mock {
  port: number
  close: () => Promise<void>
}

type MockHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

let serversToClose: Mock[] = []
let dirsToClean: string[] = []

async function startMock(handler: MockHandler): Promise<Mock> {
  const sockets = new Set<import("net").Socket>()
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf-8")
    req.on("data", (c) => (raw += c))
    req.on("end", () => handler(req, res))
  })
  server.on("connection", (s) => {
    sockets.add(s)
    s.on("close", () => sockets.delete(s))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as import("net").AddressInfo).port
  const mock: Mock = {
    port,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  serversToClose.push(mock)
  return mock
}

async function deadPort(): Promise<number> {
  const srv = http.createServer()
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
  const p = (srv.address() as import("net").AddressInfo).port
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return p
}

// ── Per-test workspace (mirrors the 4f scaffolding) ────────────────────────────────
interface Workspace {
  dir: string
  ledgerPath: string
  journalPath: string
  sidecarPath: string
  sourceFile: string
  deps: { docsDir: string; ledgerPath: string; journalPath: string; envDir: string }
}

function envContent(port: number): string {
  return [
    "schema_version=1",
    `FOREMAN_API_BASE=http://127.0.0.1:${port}/v1`,
    // Double-quoted (not a template literal) so ${ENV:...} stays literal.
    "FOREMAN_API_KEY=${ENV:INVOKE_4G_FIXTURE_KEY}",
    "FOREMAN_TIER_STANDARD=test/model-standard",
    "FOREMAN_WORKER_CLASS_STANDARD=capable",
    "FOREMAN_EDIT_FORMAT_STANDARD=unified_diff",
    "",
  ].join("\n")
}

async function makeWorkspace(opts: { port?: number; writeEnv?: boolean; seedDelegation?: boolean } = {}): Promise<Workspace> {
  const { port = 1, writeEnv = true, seedDelegation = true } = opts
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "invoke-4g-test-"))
  dirsToClean.push(dir)
  // Sidecar path MUST be <dir>/.foreman-events.jsonl where <dir> is also the
  // ledger file's directory — the hook derives the sidecar path from
  // path.dirname(ledgerPath), so both must live in the same directory.
  const ledgerPath = path.join(dir, "ledger.json")
  const journalPath = path.join(dir, "journal.json")
  const sidecarPath = path.join(dir, ".foreman-events.jsonl")
  const sourceFile = path.join(dir, "src.txt")

  await fs.writeFile(sourceFile, "line1\nline3\n", "utf-8")
  if (writeEnv) {
    await fs.writeFile(path.join(dir, ".foremanenv"), envContent(port), "utf-8")
  }
  if (seedDelegation) {
    // Seeding uses the lib layer directly (per brief) — everything that drives
    // the lifecycle under test goes through handleWriteLedger (the tool layer).
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "4g",
      unit_id: "u1",
      data: { s: "delegated", brief: "seed brief for delegated unit ok", tier: "standard" },
    })
  }
  return {
    dir,
    ledgerPath,
    journalPath,
    sidecarPath,
    sourceFile,
    deps: { docsDir: dir, ledgerPath, journalPath, envDir: dir },
  }
}

function baseInput(ws: Workspace, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "4g",
    unit_id: "u1",
    brief: "implement the change described in the brief summary",
    tier: "standard",
    files: [ws.sourceFile],
    ...overrides,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function eventCount(ws: Workspace): Promise<number> {
  return (await readEvents(ws.sidecarPath)).events.length
}

// ── Setup / teardown ────────────────────────────────────────────────────────────────
beforeEach(() => {
  serversToClose = []
  dirsToClean = []
  process.env[FIXTURE_KEY_NAME] = FIXTURE_KEY_VALUE
  resetForTest() // re-harvest with the fixture key present
  resetEgressNoticeForTest()
})

afterEach(async () => {
  for (const s of serversToClose) await s.close()
  for (const d of dirsToClean) await fs.rm(d, { recursive: true, force: true })
  delete process.env[FIXTURE_KEY_NAME]
  resetForTest()
  resetEgressNoticeForTest()
})

// ── 1. Full happy chain ──────────────────────────────────────────────────────────────
describe("write_ledger sidecar hook — full happy chain", () => {
  it("set_verdict pass closes a 4-event hash-linked chain ending outcome:pass, no failure_stage", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    const invokeText = await handleInvokeWorker(baseInput(ws), ws.deps)
    expect(invokeText).toContain("status: ok")

    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "pass", via: "worker", note: "worker patch applied and build passed" },
    })
    expect(ledgerText).toContain("status: ok")
    expect(ledgerText).not.toContain("sidecar_warning")

    const { events, warning } = await readEvents(ws.sidecarPath)
    expect(warning).toBeUndefined() // chain is valid — readEvents would throw/warn otherwise
    expect(events.map((e) => e.event_type)).toEqual([
      "delegation_started",
      "worker_completed",
      "patch_checked",
      "validation_completed",
    ])

    const first = events[0]
    const last = events[events.length - 1]
    expect(last.outcome).toBe("pass")
    expect(Object.prototype.hasOwnProperty.call(last, "failure_stage")).toBe(false)

    // Copied envelope fields match the first event's.
    expect(last.delegation_id).toBe(first.delegation_id)
    expect(last.attempt).toBe(first.attempt)
    expect(last.brief_hash).toBe(first.brief_hash)
    expect(last.model).toBe(first.model)
    expect(last.tier).toBe(first.tier)

    // Chain link.
    expect(events[3].prev_event_hash).toBe(events[2].event_hash)
  })
})

// ── 2. W_REJ ──────────────────────────────────────────────────────────────────────────
describe("write_ledger sidecar hook — set_verdict fail", () => {
  it("closes the chain with validation_completed / failure_stage W_REJ / outcome fail", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "fail" },
    })

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("validation_completed")
    expect(last.failure_stage).toBe("W_REJ")
    expect(last.outcome).toBe("fail")
  })
})

// ── 3. Inconclusive ───────────────────────────────────────────────────────────────────
describe("write_ledger sidecar hook — set_verdict inconclusive", () => {
  it("closes the chain with outcome:inconclusive and NO failure_stage key", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "inconclusive" },
    })

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("validation_completed")
    expect(last.outcome).toBe("inconclusive")
    expect(Object.prototype.hasOwnProperty.call(last, "failure_stage")).toBe(false)
  })
})

// ── 4. ED_STALE / PATCH_APPLY_FAIL via add_rejection ──────────────────────────────────
describe("write_ledger sidecar hook — add_rejection ED_STALE / PATCH_APPLY_FAIL", () => {
  it("ED_STALE closes the chain with terminal patch_checked / outcome fail", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "ED_STALE", msg: "base file changed since delegation", ts: new Date().toISOString() },
    })

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("patch_checked")
    expect(last.failure_stage).toBe("ED_STALE")
    expect(last.outcome).toBe("fail")
  })

  it("PATCH_APPLY_FAIL closes the chain with terminal patch_checked / outcome fail (fresh workspace)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "PATCH_APPLY_FAIL", msg: "hunks did not apply", ts: new Date().toISOString() },
    })

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("patch_checked")
    expect(last.failure_stage).toBe("PATCH_APPLY_FAIL")
    expect(last.outcome).toBe("fail")
  })
})

// ── 5. BLD_ERR via add_rejection ──────────────────────────────────────────────────────
describe("write_ledger sidecar hook — add_rejection BLD_ERR", () => {
  it("closes the chain with terminal validation_completed / failure_stage BLD_ERR / outcome fail", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "BLD_ERR", msg: "typecheck failed", ts: new Date().toISOString() },
    })

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("validation_completed")
    expect(last.failure_stage).toBe("BLD_ERR")
    expect(last.outcome).toBe("fail")
  })
})

// ── 6. Unmapped rejection is a no-op ──────────────────────────────────────────────────
describe("write_ledger sidecar hook — unmapped add_rejection reason", () => {
  it("a reviewer-name rejection is a no-op: event count unchanged, no error", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    await handleInvokeWorker(baseInput(ws), ws.deps)
    const before = await eventCount(ws)
    expect(before).toBe(3)

    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "reviewer", msg: "style nit", ts: new Date().toISOString() },
    })

    expect(ledgerText).toContain("status: ok")
    expect(ledgerText).not.toContain("sidecar_warning")
    expect(await eventCount(ws)).toBe(before)
  })
})

// ── 7. Early-terminal chains stay terminal (no double-append) ────────────────────────
describe("write_ledger sidecar hook — chains that are already terminal", () => {
  async function expectNoDoubleAppend(ws: Workspace): Promise<void> {
    const before = await eventCount(ws)
    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "fail" },
    })
    expect(ledgerText).toContain("status: ok")
    expect(await eventCount(ws)).toBe(before)
  }

  it("pre-send secret block (terminal on worker_completed)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws, { brief: `use this token ${FIXTURE_KEY_VALUE} to authenticate` }), ws.deps)
    await expectNoDoubleAppend(ws)
  })

  it("transport fail / dead port (terminal on worker_completed)", async () => {
    const port = await deadPort()
    const ws = await makeWorkspace({ port })
    await handleInvokeWorker(baseInput(ws), ws.deps)
    await expectNoDoubleAppend(ws)
  })

  it("ghost — metadata success, no patch (terminal on worker_completed)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS)))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws), ws.deps)
    await expectNoDoubleAppend(ws)
  })

  it("patch parse fail (terminal on patch_checked)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, "this is not a diff at all")))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws), ws.deps)
    await expectNoDoubleAppend(ws)
  })

  it("redaction marker reject (terminal on patch_checked)", async () => {
    const body = ["--- a/src.txt", "+++ b/src.txt", "@@ -1,2 +1,3 @@", " line1", "+[REDACTED:env:FOO]", " line3"].join("\n")
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, body)))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws), ws.deps)
    await expectNoDoubleAppend(ws)
  })

  it("protected path reject (terminal on patch_checked)", async () => {
    const body = ["--- a/.git/config", "+++ b/.git/config", "@@ -1,1 +1,2 @@", " x", "+y"].join("\n")
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, body)))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws), ws.deps)
    await expectNoDoubleAppend(ws)
  })
})

// ── 8. Native path no-op ──────────────────────────────────────────────────────────────
describe("write_ledger sidecar hook — native (never-invoked) path", () => {
  it("a unit delegated but never sent through invoke_worker leaves the sidecar absent", async () => {
    const ws = await makeWorkspace() // seeded delegation, invoke_worker never called
    expect(await fileExists(ws.sidecarPath)).toBe(false)

    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "pass" },
    })

    expect(ledgerText).toContain("status: ok")
    expect(ledgerText).not.toContain("sidecar_warning")
    expect(await fileExists(ws.sidecarPath)).toBe(false)
  })
})

// ── 9. Never-throws + ledger-first proof ──────────────────────────────────────────────
describe("write_ledger sidecar hook — never throws into the ledger write path", () => {
  it("a corrupted mid-file sidecar degrades to sidecar_warning while the ledger write still commits", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    await handleInvokeWorker(baseInput(ws), ws.deps)

    // Two garbage lines so the first is NOT the final line: readEvents (called
    // via openDelegation) tolerates a torn FINAL line but THROWS on invalid JSON
    // mid-file — this forces the hook's catch path.
    await fs.appendFile(ws.sidecarPath, "not json at all\nalso not json\n", "utf-8")

    // Pins sidecar-after-ledger: the hook runs strictly AFTER `await writeLedger`
    // inside handleWriteLedger (by construction), so the ledger write below has
    // already committed by the time the sidecar throws.
    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "pass", via: "worker" },
    })

    expect(ledgerText).toContain("status: ok")
    expect(ledgerText).toContain("sidecar_warning:")

    const ledger = await readLedger(ws.ledgerPath)
    expect(ledger.phases["4g"].units["u1"].v).toBe("pass")
  })
})

// ── 10. Two-reviewers-one-attempt cap-safe end-to-end ─────────────────────────────────
describe("write_ledger sidecar hook — two rejections on one attempt, then a second delegation", () => {
  it("terminates the SECOND delegation's chain, not the first's", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })

    // Attempt 1: success chain (3 events).
    await handleInvokeWorker(baseInput(ws), ws.deps)

    // Reviewer 1 rejects — terminal patch_checked appended (ED_STALE).
    await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "ED_STALE", msg: "stale base file", ts: new Date().toISOString() },
    })
    let events = (await readEvents(ws.sidecarPath)).events
    expect(events).toHaveLength(4)
    const delegationA = events[0].delegation_id

    // Reviewer 2 rejects the SAME attempt with an unmapped reason — no-op.
    await handleWriteLedger(ws.ledgerPath, {
      operation: "add_rejection",
      phase: "4g",
      unit_id: "u1",
      data: { r: "reviewer", msg: "also rejecting", ts: new Date().toISOString() },
    })
    events = (await readEvents(ws.sidecarPath)).events
    expect(events).toHaveLength(4)

    // D2a cap counts DISTINCT attempts — two rejections on attempt 1 is ONE
    // distinct attempt, so a second delegation succeeds without user_override.
    await handleWriteLedger(ws.ledgerPath, {
      operation: "set_unit_status",
      phase: "4g",
      unit_id: "u1",
      data: { s: "delegated", brief: "second attempt worker brief long enough to pass validation", tier: "standard" },
    })

    // Attempt 2: a second success chain — a SECOND delegation_id in the same file.
    await handleInvokeWorker(baseInput(ws), ws.deps)
    events = (await readEvents(ws.sidecarPath)).events
    expect(events).toHaveLength(7)
    const delegationB = events[4].delegation_id
    expect(delegationB).not.toBe(delegationA)
    expect(events[4].attempt).toBe(2)

    // Terminate — must close the SECOND (still-open) delegation.
    await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: "u1",
      data: { v: "pass" },
    })

    events = (await readEvents(ws.sidecarPath)).events
    expect(events).toHaveLength(8)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("validation_completed")
    expect(last.outcome).toBe("pass")
    expect(last.delegation_id).toBe(delegationB)
    expect(last.delegation_id).not.toBe(delegationA)
  })
})

// ── 12. Long unit_id: bounded chain terminates on the same digest [CWE-20] ────────────
describe("write_ledger sidecar hook — long unit_id digest-bounded chain", () => {
  it("a >64-char unit_id terminates on the SAME bounded chain (4 valid events)", async () => {
    const mock = await startMock((_req, res) => successResponse(res, workerText(METADATA_SUCCESS, UNIFIED_DIFF_BODY)))
    const ws = await makeWorkspace({ port: mock.port })
    const longUnitId = "u_" + "z".repeat(80) // 82 chars > 64-char cap

    // Ledger stores the RAW id; seed under the long id so invoke_worker + the hook
    // (which both read/join by raw phase/unit_id) resolve it.
    await writeLedger(ws.ledgerPath, {
      operation: "set_unit_status",
      phase: "4g",
      unit_id: longUnitId,
      data: { s: "delegated", brief: "seed brief for delegated unit ok", tier: "standard" },
    })

    const invokeText = await handleInvokeWorker(baseInput(ws, { unit_id: longUnitId }), ws.deps)
    expect(invokeText).toContain("status: ok")

    // Without join-key bounding in the hook, openDelegation(raw longUnitId) would miss the
    // digest-keyed events and the chain would stay open at 3 events. It must reach 4.
    const ledgerText = await handleWriteLedger(ws.ledgerPath, {
      operation: "set_verdict",
      phase: "4g",
      unit_id: longUnitId,
      data: { v: "pass", via: "worker", note: "worker patch applied and build passed" },
    })
    expect(ledgerText).toContain("status: ok")
    expect(ledgerText).not.toContain("sidecar_warning")

    const { events, warning } = await readEvents(ws.sidecarPath)
    expect(warning).toBeUndefined() // chain valid — readEvents throws/warns otherwise
    expect(events.map((e) => e.event_type)).toEqual([
      "delegation_started",
      "worker_completed",
      "patch_checked",
      "validation_completed",
    ])
    const last = events[events.length - 1]
    expect(last.outcome).toBe("pass")
    // Whole chain is keyed on the bounded digest; the hook's join found it.
    expect(events[0].unit_id).toMatch(/^sha256:[0-9a-f]{16}$/)
    expect(last.unit_id).toBe(events[0].unit_id)
    // Chain link intact through the terminal event.
    expect(events[3].prev_event_hash).toBe(events[2].event_hash)
  })
})

// ── 11. Gate/validation errors still propagate ────────────────────────────────────────
describe("write_ledger sidecar hook — ledger-layer errors still propagate", () => {
  it("set_verdict pass without prior delegation still rejects (hook only runs after success)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "invoke-4g-test-"))
    dirsToClean.push(dir)
    const ledgerPath = path.join(dir, "ledger.json")

    await expect(
      handleWriteLedger(ledgerPath, {
        operation: "set_verdict",
        phase: "4g",
        unit_id: "never-delegated",
        data: { v: "pass" },
      })
    ).rejects.toThrow(/VERDICT BLOCKED/)
  })
})
