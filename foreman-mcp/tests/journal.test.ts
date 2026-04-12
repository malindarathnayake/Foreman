import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readJournal, initSession, logEvent, endSession, computeRollup } from "../src/lib/journal.js"
import { WriteJournalInputSchema, JournalEventCode } from "../src/types.js"
import type { JournalSession } from "../src/types.js"

let tmpDir: string
let journalPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "journal-test-"))
  journalPath = path.join(tmpDir, "journal.json")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeInitInput(overrides?: Record<string, unknown>) {
  return {
    operation: "init_session" as const,
    data: {
      target_version: "0.0.6",
      branch: "release/v0.0.6",
      phase: 1,
      units: ["1a", "1b"],
      env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
      ...overrides,
    },
  }
}

function makeLogEventInput(t = "W_FAIL" as const, u = "1a", tok = 1000, msg = "test event") {
  return {
    operation: "log_event" as const,
    data: { t, u, tok, msg },
  }
}

function makeEndSessionInput(overrides?: Record<string, unknown>) {
  return {
    operation: "end_session" as const,
    data: {
      dur_min: 45,
      ctx_used_pct: 72,
      summary: {
        units_ok: 2,
        units_rej: 0,
        w_spawned: 3,
        w_wasted: 0,
        tok_wasted: 0,
        delay_min: 0,
        blockers: [],
        friction: 15,
      },
      ...overrides,
    },
  }
}

describe("journal", () => {
  describe("readJournal", () => {
    it("returns fresh journal on ENOENT", async () => {
      const journal = await readJournal(journalPath)
      expect(journal.v).toBe(1)
      expect(journal.sessions).toHaveLength(0)
      expect(journal.next_sid).toBe(1)
    })

    it("recovers from corrupt JSON with backup", async () => {
      await fs.writeFile(journalPath, "{ not valid json", "utf-8")
      const journal = await readJournal(journalPath)
      expect(journal.sessions).toHaveLength(0)
      const files = await fs.readdir(tmpDir)
      expect(files.some(f => f.includes(".corrupt."))).toBe(true)
    })
  })

  describe("initSession", () => {
    it("creates file and auto-fills env.os/node/foreman", async () => {
      const journal = await initSession(journalPath, makeInitInput())
      expect(journal.sessions).toHaveLength(1)
      const session = journal.sessions[0] as any
      expect(session.id).toBe("s1")
      expect(session.branch).toBe("release/v0.0.6")
      expect(session.phase).toBe(1)
      expect(session.units).toEqual(["1a", "1b"])
      expect(session.env).toBeDefined()
      expect(session.env.os).toContain(process.platform)
      expect(session.env.node).toBe(process.version)
      expect(session.env.foreman).toBeDefined()
      expect(session.env.agent).toBe("opus")
    })

    it("increments session ID", async () => {
      await initSession(journalPath, makeInitInput())
      const journal = await initSession(journalPath, makeInitInput())
      expect(journal.sessions).toHaveLength(2)
      expect(journal.sessions[0].id).toBe("s1")
      expect(journal.sessions[1].id).toBe("s2")
    })

    it("updates file-level project and target_version", async () => {
      const journal = await initSession(journalPath, makeInitInput())
      expect(journal.project).toBe("foreman-mcp")
      expect(journal.target_version).toBe("0.0.6")
    })
  })

  describe("logEvent", () => {
    it("appends events to last session", async () => {
      await initSession(journalPath, makeInitInput())
      const result = await logEvent(journalPath, makeLogEventInput())
      expect(result).toBe("ok")

      const journal = await readJournal(journalPath)
      expect(journal.sessions[0].events).toHaveLength(1)
      expect(journal.sessions[0].events[0].t).toBe("W_FAIL")
      expect(journal.sessions[0].events[0].tok).toBe(1000)
    })

    it("returns error when no active session", async () => {
      // Write empty journal first
      await fs.writeFile(journalPath, JSON.stringify({ v: 1, project: "", target_version: "", next_sid: 1, sessions: [] }), "utf-8")
      const result = await logEvent(journalPath, makeLogEventInput())
      expect(result).toContain("error: no active session")
    })

    it("validates event code enum", async () => {
      await initSession(journalPath, makeInitInput())
      expect(() =>
        WriteJournalInputSchema.parse({
          operation: "log_event",
          data: { t: "INVALID_CODE", u: "1a", tok: 100, msg: "bad" },
        })
      ).toThrow()
    })

    it("rejects event when cap reached (200)", async () => {
      await initSession(journalPath, makeInitInput())
      // Write 200 events
      for (let i = 0; i < 200; i++) {
        await logEvent(journalPath, makeLogEventInput("W_FAIL", "1a", i, `event ${i}`))
      }
      // 201st should be rejected
      const result = await logEvent(journalPath, makeLogEventInput("W_FAIL", "1a", 201, "overflow"))
      expect(result).toContain("error: event cap reached")
    }, 30000)
  })

  describe("endSession", () => {
    it("fills summary on last session", async () => {
      await initSession(journalPath, makeInitInput())
      const journal = await endSession(journalPath, makeEndSessionInput())
      const session = journal.sessions[0]
      expect(session.dur_min).toBe(45)
      expect(session.ctx_used_pct).toBe(72)
      expect(session.summary).toBeDefined()
      expect(session.summary!.units_ok).toBe(2)
      expect(session.summary!.friction).toBe(15)
    })
  })

  describe("FIFO cap", () => {
    it("keeps at most 50 sessions", async () => {
      // Create 55 sessions
      for (let i = 0; i < 55; i++) {
        await initSession(journalPath, makeInitInput())
      }
      const journal = await readJournal(journalPath)
      expect(journal.sessions).toHaveLength(50)
      // First session should be s6 (sessions s1-s5 dropped)
      expect(journal.sessions[0].id).toBe("s6")
    }, 30000)
  })

  describe("rollup", () => {
    it("computed at 5+ sessions with endSession", async () => {
      for (let i = 0; i < 5; i++) {
        await initSession(journalPath, makeInitInput())
        await logEvent(journalPath, makeLogEventInput("W_FAIL", "1a", 100, `fail ${i}`))
        await endSession(journalPath, makeEndSessionInput())
      }
      const journal = await readJournal(journalPath)
      expect(journal.rollup).toBeDefined()
      expect(journal.rollup!.sessions).toBe(5)
      expect(journal.rollup!.avg_friction).toBe(15)
      expect(journal.rollup!.top_events.length).toBeGreaterThan(0)
    }, 30000)

    it("not computed with fewer than 5 sessions", async () => {
      for (let i = 0; i < 4; i++) {
        await initSession(journalPath, makeInitInput())
        await endSession(journalPath, makeEndSessionInput())
      }
      const journal = await readJournal(journalPath)
      expect(journal.rollup).toBeUndefined()
    }, 20000)
  })

  describe("readJournal with last_n", () => {
    it("returns all sessions when reading from file", async () => {
      for (let i = 0; i < 3; i++) {
        await initSession(journalPath, makeInitInput())
      }
      const journal = await readJournal(journalPath)
      expect(journal.sessions).toHaveLength(3)
    })
  })

  describe("computeRollup", () => {
    it("computes worst_unit_pattern from W_REJ events", () => {
      const sessions: JournalSession[] = [
        { id: "s1", ts: "2026-01-01", branch: "main", phase: 1, units: ["1a"], events: [
          { t: "W_REJ", u: "1a", tok: 100, msg: "rejected" },
          { t: "W_REJ", u: "1a", tok: 100, msg: "rejected again" },
          { t: "W_FAIL", u: "1b", tok: 50, msg: "failed" },
        ], dur_min: 30, ctx_used_pct: 50, summary: { units_ok: 1, units_rej: 1, w_spawned: 3, w_wasted: 1, tok_wasted: 200, delay_min: 5, blockers: [], friction: 20 } },
      ]
      const rollup = computeRollup(sessions)
      expect(rollup.worst_unit_pattern).toBe("1a")
      expect(rollup.best_unit_pattern).toBe("1b")
    })
  })

  describe("WriteJournalInputSchema", () => {
    it("rejects invalid event codes", () => {
      expect(() =>
        WriteJournalInputSchema.parse({
          operation: "log_event",
          data: { t: "NOT_A_CODE", u: "1a", tok: 100, msg: "bad" },
        })
      ).toThrow()
    })

    it("accepts valid event codes", () => {
      const validCodes = JournalEventCode.options
      expect(validCodes).toContain("W_FAIL")
      expect(validCodes).toContain("W_REJ")
      expect(validCodes).toContain("CTX_OVF")
      expect(validCodes.length).toBe(23)
    })
  })
})
