import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import {
  appendEvent,
  readEvents,
  openDelegation,
  canonicalStringify,
  boundIdentifier,
  type SidecarEventInput,
} from "../src/lib/eventsSidecar.js"
import { resetForTest } from "../src/lib/redaction.js"

let tmpDir: string
let sidecarPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "events-sidecar-test-"))
  sidecarPath = path.join(tmpDir, "events.jsonl")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function fixtureEvent(overrides: Record<string, unknown> = {}): SidecarEventInput {
  return {
    v: 1,
    ts: new Date().toISOString(),
    event_id: "evt_4d000001",
    event_type: "delegation_started",
    phase: "4d",
    unit_id: "u1",
    attempt: 1,
    delegation_id: "del_4d000001",
    provider: "anthropic",
    model: "claude-sonnet",
    tier: "standard",
    capability_class: "capable",
    edit_format: "unified_diff",
    repair_attempt: 0,
    brief_hash: "hash_4d000001",
    prompt_prefix_hash: "hash_4d000002",
    base_file_hashes: { "src/foo.ts": "hash_4d000003" },
    ...overrides,
  } as SidecarEventInput
}

describe("eventsSidecar", () => {
  it("chain construction: 4 events append and read back in order with valid links", async () => {
    const e1 = await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    const e2 = await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e2", event_type: "worker_completed" })
    )
    const e3 = await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e3", event_type: "patch_checked" })
    )
    const e4 = await appendEvent(
      sidecarPath,
      fixtureEvent({ event_id: "e4", event_type: "validation_completed", outcome: "pass" })
    )

    const { events, absent, warning } = await readEvents(sidecarPath)
    expect(absent).toBeUndefined()
    expect(warning).toBeUndefined()
    expect(events).toHaveLength(4)
    expect(events.map((e) => e.event_id)).toEqual(["e1", "e2", "e3", "e4"])

    expect(events[0].prev_event_hash).toBeUndefined()
    expect(events[1].prev_event_hash).toBe(events[0].event_hash)
    expect(events[2].prev_event_hash).toBe(events[1].event_hash)
    expect(events[3].prev_event_hash).toBe(events[2].event_hash)

    for (const e of events) {
      const { event_hash, ...rest } = e
      const recomputed = createHash("sha256").update(canonicalStringify(rest), "utf-8").digest("hex")
      expect(event_hash).toBe(recomputed)
    }

    expect(e1.event_hash).toBe(events[0].event_hash)
    expect(e4.event_hash).toBe(events[3].event_hash)
  })

  it("append order preserved under concurrent appends (mutex proof)", async () => {
    const promises = Array.from({ length: 8 }, (_, i) =>
      appendEvent(sidecarPath, fixtureEvent({ event_id: `e${i}`, delegation_id: `del${i}` }))
    )
    await Promise.all(promises)

    // readEvents verifies the entire hash chain and throws on any break — reaching
    // this point with no throw already proves the mutex serialized the appends.
    const { events, warning } = await readEvents(sidecarPath)
    expect(warning).toBeUndefined()
    expect(events).toHaveLength(8)
    expect(new Set(events.map((e) => e.event_id)).size).toBe(8)
  })

  it("torn final line: skipped with a warning naming the line, no throw", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))
    await fs.appendFile(sidecarPath, '{"half":', "utf-8")

    const { events, warning } = await readEvents(sidecarPath)
    expect(events).toHaveLength(2)
    expect(warning).toBe("torn final line skipped (line 3)")
  })

  it("torn final line WITHOUT trailing LF is skipped even though it PARSES; earlier events returned", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))
    // Syntactically valid JSON, but with NO trailing LF → torn by definition. Under the
    // narrow (unparsable-only) rule this would have been hash-verified and thrown; the
    // no-LF rule must skip it before any parse/hash/chain check. [CWE-354]
    await fs.appendFile(sidecarPath, '{"parseable":"but torn"}', "utf-8")

    const { events, warning } = await readEvents(sidecarPath)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.event_id)).toEqual(["e1", "e2"])
    expect(warning).toBe("torn final line skipped (line 3)")
  })

  it("appendEvent refuses to write onto an LF-less (torn) tail and leaves the file byte-unchanged", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    // Manufacture a torn tail: valid content, no trailing LF.
    await fs.appendFile(sidecarPath, '{"parseable":"but torn"}', "utf-8")
    const before = await fs.readFile(sidecarPath, "utf-8")

    await expect(appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))).rejects.toThrow(/torn final line/)

    const after = await fs.readFile(sidecarPath, "utf-8")
    expect(after).toBe(before)
  })

  it("mid-file corruption throws with the 1-based line number", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e3" }))

    const raw = await fs.readFile(sidecarPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    lines[1] = "{not valid json"
    await fs.writeFile(sidecarPath, lines.join("\n") + "\n", "utf-8")

    await expect(readEvents(sidecarPath)).rejects.toThrow(/line 2/)
  })

  it("chain break: a tampered field mismatches its recomputed hash", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e3" }))

    const raw = await fs.readFile(sidecarPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    const line2 = JSON.parse(lines[1])
    line2.unit_id = "tampered"
    lines[1] = JSON.stringify(line2)
    await fs.writeFile(sidecarPath, lines.join("\n") + "\n", "utf-8")

    await expect(readEvents(sidecarPath)).rejects.toThrow(/line 2/)
  })

  it("chain break: a wrong prev_event_hash throws even with a correctly recomputed event_hash", async () => {
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e1" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e2" }))
    await appendEvent(sidecarPath, fixtureEvent({ event_id: "e3" }))

    const raw = await fs.readFile(sidecarPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    const line3 = JSON.parse(lines[2])
    line3.prev_event_hash = "a".repeat(64)
    const { event_hash, ...rest } = line3
    line3.event_hash = createHash("sha256").update(canonicalStringify(rest), "utf-8").digest("hex")
    lines[2] = JSON.stringify(line3)
    await fs.writeFile(sidecarPath, lines.join("\n") + "\n", "utf-8")

    await expect(readEvents(sidecarPath)).rejects.toThrow(/line 3/)
  })

  it("absent file returns empty events with the absent flag, no throw", async () => {
    const result = await readEvents(path.join(tmpDir, "does-not-exist.jsonl"))
    expect(result).toEqual({ events: [], absent: true })
  })

  it("oversize event throws and leaves the file untouched", async () => {
    const bigHashes: Record<string, string> = {}
    for (let i = 0; i < 150; i++) {
      const key = `src/generated/file_${String(i).padStart(4, "0")}.ts`
      bigHashes[key] = "b".repeat(64)
    }
    const oversized = fixtureEvent({ base_file_hashes: bigHashes })

    await expect(appendEvent(sidecarPath, oversized)).rejects.toThrow(/8192/)

    const exists = await fs
      .access(sidecarPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  describe("validation", () => {
    it("throws on unknown extra field (closed envelope)", async () => {
      const bad = fixtureEvent({ totally_unknown_field: "x" })
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/unknown field/)
    })

    it("throws on invalid enum value", async () => {
      const bad = fixtureEvent({ tier: "ultra" })
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/tier/)
    })

    it("throws on missing required field", async () => {
      const bad = fixtureEvent()
      delete (bad as Record<string, unknown>).provider
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/provider/)
    })

    it("throws when an identifier field exceeds the 64-char cap", async () => {
      const bad = fixtureEvent({ event_id: "x".repeat(65) })
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/64/)
    })

    it("accepts an identifier field at exactly the 64-char boundary", async () => {
      const boundary = fixtureEvent({ event_id: "a".repeat(64) })
      const result = await appendEvent(sidecarPath, boundary)
      expect(result.event_id).toBe("a".repeat(64))
    })

    it("throws when the caller supplies event_hash", async () => {
      const bad = { ...fixtureEvent(), event_hash: "x".repeat(64) }
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/event_hash/)
    })

    it("throws when the caller supplies prev_event_hash", async () => {
      const bad = { ...fixtureEvent(), prev_event_hash: "x".repeat(64) }
      await expect(appendEvent(sidecarPath, bad)).rejects.toThrow(/prev_event_hash/)
    })
  })

  describe("openDelegation", () => {
    it("returns the open delegation when its last event carries no outcome", async () => {
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e1", phase: "4d", unit_id: "u1", delegation_id: "del1", event_type: "delegation_started" })
      )
      const last = await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e2", phase: "4d", unit_id: "u1", delegation_id: "del1", event_type: "worker_completed" })
      )

      const open = await openDelegation(sidecarPath, "4d", "u1")
      expect(open).not.toBeNull()
      expect(open?.delegationId).toBe("del1")
      expect(open?.lastEvent.event_id).toBe(last.event_id)
    })

    it("returns null once the delegation reaches a terminal event with an outcome", async () => {
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e1", phase: "4d", unit_id: "u1", delegation_id: "del1", event_type: "delegation_started" })
      )
      await appendEvent(
        sidecarPath,
        fixtureEvent({
          event_id: "e2",
          phase: "4d",
          unit_id: "u1",
          delegation_id: "del1",
          event_type: "validation_completed",
          outcome: "pass",
        })
      )

      const open = await openDelegation(sidecarPath, "4d", "u1")
      expect(open).toBeNull()
    })

    it("returns the second delegation when the first is terminal and the second is open", async () => {
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e1", phase: "4d", unit_id: "u1", delegation_id: "del1", event_type: "delegation_started" })
      )
      await appendEvent(
        sidecarPath,
        fixtureEvent({
          event_id: "e2",
          phase: "4d",
          unit_id: "u1",
          delegation_id: "del1",
          event_type: "validation_completed",
          outcome: "fail",
        })
      )
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e3", phase: "4d", unit_id: "u1", delegation_id: "del2", event_type: "delegation_started" })
      )

      const open = await openDelegation(sidecarPath, "4d", "u1")
      expect(open?.delegationId).toBe("del2")
    })

    it("does not leak events belonging to a different unit", async () => {
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e1", phase: "4d", unit_id: "u1", delegation_id: "del1", event_type: "delegation_started" })
      )
      await appendEvent(
        sidecarPath,
        fixtureEvent({ event_id: "e2", phase: "4d", unit_id: "u2", delegation_id: "del2", event_type: "delegation_started" })
      )

      const open = await openDelegation(sidecarPath, "4d", "u2")
      expect(open?.delegationId).toBe("del2")
      expect(open?.lastEvent.unit_id).toBe("u2")
    })

    it("returns null for an absent file", async () => {
      const open = await openDelegation(path.join(tmpDir, "nope.jsonl"), "4d", "u1")
      expect(open).toBeNull()
    })
  })

  describe("scrub defense-in-depth", () => {
    const ENV_NAME = "SIDECAR_4D_TEST_KEY"
    const ENV_VALUE = "fixture_value_4d00000a"

    afterEach(() => {
      delete process.env[ENV_NAME]
      resetForTest()
    })

    it("redacts a smuggled secret value before hashing; the chain still verifies on read", async () => {
      process.env[ENV_NAME] = ENV_VALUE
      resetForTest()

      const event = fixtureEvent({ provider: ENV_VALUE })
      await appendEvent(sidecarPath, event)

      const raw = await fs.readFile(sidecarPath, "utf-8")
      expect(raw).not.toContain(ENV_VALUE)
      expect(raw).toContain(`[REDACTED:env:${ENV_NAME}]`)

      const { events, warning } = await readEvents(sidecarPath)
      expect(warning).toBeUndefined()
      expect(events).toHaveLength(1)
      expect(events[0].provider).toBe(`[REDACTED:env:${ENV_NAME}]`)
    })
  })

  describe("boundIdentifier", () => {
    it("passes a value at or under the 64-char cap through unchanged (incl. the 64-boundary)", () => {
      expect(boundIdentifier("short")).toBe("short")
      expect(boundIdentifier("")).toBe("")
      const exactly64 = "a".repeat(64)
      expect(boundIdentifier(exactly64)).toBe(exactly64)
    })

    it("collapses an over-cap value to a sha256:<16hex> digest", () => {
      const over = boundIdentifier("x".repeat(65))
      expect(over).toMatch(/^sha256:[0-9a-f]{16}$/)
      expect(over.length).toBe(23) // "sha256:" (7) + 16 hex chars
      expect(over.length).toBeLessThanOrEqual(64) // never re-trips the envelope cap
    })

    it("is deterministic for the same input and differs for different inputs", () => {
      const a = "y".repeat(200)
      const b = "z".repeat(200)
      expect(boundIdentifier(a)).toBe(boundIdentifier(a))
      expect(boundIdentifier(a)).not.toBe(boundIdentifier(b))
    })
  })
})
