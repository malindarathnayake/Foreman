// 0.6.20: soft limits. Text with no gate weight (journal msg, record_review checked[] entries
// and limitations, native reviewer checked[] entries) is cut to its limit with a trailing
// `…[truncated N chars]` marker and a TRUNCATED warning instead of refusing the whole write.
// Ids, findings, evidence and notes keep hard limits. The marker never manufactures content:
// a blank prefix is stored empty so the non-blank rules still see a blank entry.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import {
  TRUNCATION_MARKER_RE, truncateWithMarker, softText, softLimitWarning, hasLoneHighSurrogate, type SoftLimit,
} from "../src/lib/softLimits.js"
import {
  JournalSoftLimits, LedgerSoftLimits, WriteJournalInputSchema, WriteLedgerInputSchema, NativeReviewEvidenceSchema,
} from "../src/types.js"
import { renderShape } from "../src/lib/schemaDoc.js"
import { initSession, logEvent, readJournal } from "../src/lib/journal.js"
import { readLedger } from "../src/lib/ledger.js"
import { handleWriteLedger } from "../src/tools/writeLedger.js"

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/

let tmpDir: string
let ledgerPath: string
let journalPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "soft-limits-"))
  ledgerPath = path.join(tmpDir, ".foreman-ledger.json")
  journalPath = path.join(tmpDir, ".foreman-journal.json")
})
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ─── truncateWithMarker ───────────────────────────────────────────────────────

describe("truncateWithMarker", () => {
  it("returns a value at or under the limit unchanged", () => {
    expect(truncateWithMarker("x".repeat(400), 400)).toBe("x".repeat(400))
    expect(truncateWithMarker("", 400)).toBe("")
  })

  it("cuts a BMP value to exactly max, ending in the marker, and the marker count adds up", () => {
    for (const len of [401, 450, 1000, 12000]) {
      const out = truncateWithMarker("x".repeat(len), 400)
      expect(out).toHaveLength(400)
      const m = TRUNCATION_MARKER_RE.exec(out)!
      expect(m).not.toBeNull()
      const kept = out.length - m[0].length
      expect(kept + Number(m[1])).toBe(len)
      expect(out.slice(0, kept)).toBe("x".repeat(kept))
    }
  })

  it("is idempotent on its own output", () => {
    const once = truncateWithMarker("y".repeat(900), 400)
    expect(truncateWithMarker(once, 400)).toBe(once)
  })

  it("never splits a surrogate pair: an astral run across the cut yields no lone surrogate", () => {
    for (const value of ["😀".repeat(300), "a" + "😀".repeat(300), "a".repeat(370) + "😀".repeat(40)]) {
      const out = truncateWithMarker(value, 400)
      expect(out.length).toBeLessThanOrEqual(400)
      expect(out.length).toBeGreaterThanOrEqual(399)
      expect(LONE_HIGH.test(out)).toBe(false)
      expect(hasLoneHighSurrogate(out)).toBe(false)
      expect(out).toMatch(TRUNCATION_MARKER_RE)
      expect(truncateWithMarker(out, 400)).toBe(out)
    }
  })

  it("stores a blank prefix as the empty string with no marker", () => {
    expect(truncateWithMarker(" ".repeat(401), 400)).toBe("")
    expect(truncateWithMarker("\t\n".repeat(300), 400)).toBe("")
    // Whitespace padding with content past the cut: the kept prefix is blank, so blank it stays.
    expect(truncateWithMarker(" ".repeat(390) + "real content here", 400)).toBe("")
  })
})

// ─── schemas ──────────────────────────────────────────────────────────────────

describe("softText and NativeChecked", () => {
  it("cuts over-long input to the limit and keeps the rendered shape byte-identical", () => {
    const s = softText(400)
    const out = s.parse("x".repeat(450))
    expect(out).toHaveLength(400)
    expect(out).toMatch(TRUNCATION_MARKER_RE)
    expect(s.parse(out)).toBe(out)
    expect(renderShape(z.object({ msg: s }))).toBe("{ msg: string (≤400 chars) }")
    expect(renderShape(z.object({ checked: z.array(s).max(50).optional() }))).toBe("{ checked?: string (≤400 chars)[] (max 50) }")
  })

  it("native reviewer checked[] entries are trimmed then cut; ids and blank entries are refused", () => {
    const reviewer = (checked: string[], agent_id = "reviewer-a") => ({ agent_id, lens: "contract" as const, completion: "complete" as const, checked })
    const base = { verifier_id: "verifier", reviewers: [reviewer(["ok"]), { ...reviewer(["ok"], "reviewer-b"), lens: "tests" as const }] }
    const cut = NativeReviewEvidenceSchema.parse({ ...base, reviewers: [reviewer(["  " + "y".repeat(600) + "  "]), base.reviewers[1]] })
    expect(cut.reviewers[0].checked[0]).toHaveLength(400)
    expect(cut.reviewers[0].checked[0]).toMatch(TRUNCATION_MARKER_RE)
    expect(NativeReviewEvidenceSchema.safeParse({ ...base, reviewers: [reviewer([" ".repeat(450)]), base.reviewers[1]] }).success).toBe(false)
    expect(NativeReviewEvidenceSchema.safeParse({ ...base, reviewers: [reviewer(["ok"], "a".repeat(401)), base.reviewers[1]] }).success).toBe(false)
    expect(NativeReviewEvidenceSchema.safeParse({ ...base, verifier_id: "v".repeat(401) }).success).toBe(false)
    expect(renderShape(NativeReviewEvidenceSchema)).toContain("checked: string (≥1 chars, ≤400 chars)[] (max 50)")
  })
})

// ─── the soft-limit table cannot drift from the zod checks ────────────────────

function inputFor(operation: string, limit: SoftLimit, value: string, base: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = { operation, phase: "p1", ...structuredClone(base) }
  const segments = limit.path.split(".")
  let cursor: unknown = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const nextIsArray = segments[i + 1] === "[]"
    if (seg === "[]") {
      const arr = cursor as unknown[]
      arr[0] ??= nextIsArray ? [] : {}
      cursor = arr[0]
    } else {
      const obj = cursor as Record<string, unknown>
      obj[seg] ??= nextIsArray ? [] : {}
      cursor = obj[seg]
    }
  }
  const last = segments[segments.length - 1]
  if (last === "[]") (cursor as unknown[])[0] = value
  else (cursor as Record<string, unknown>)[last] = value
  return root
}

const NATIVE_BASE = {
  data: {
    advisor: "codex-native", stage: "native", completion: "complete", findings: [], checked: ["src/a.ts"],
    native: { verifier_id: "verifier", reviewers: [
      { agent_id: "reviewer-a", lens: "contract", completion: "complete", checked: ["src/a.ts"] },
      { agent_id: "reviewer-b", lens: "tests", completion: "complete", checked: ["src/a.ts"] },
    ] },
  },
}

describe("soft-limit tables round-trip through the operation schemas", () => {
  it("every LedgerSoftLimits entry is cut by WriteLedgerInputSchema and reported by softLimitWarning", () => {
    for (const [operation, limits] of Object.entries(LedgerSoftLimits)) {
      for (const limit of limits) {
        const raw = inputFor(operation, limit, "z".repeat(limit.max + 37), NATIVE_BASE)
        const parsed = WriteLedgerInputSchema.parse(raw)
        const warning = softLimitWarning(raw, parsed, [limit])
        expect(warning, limit.path).toContain(`was ${limit.max + 37} chars (limit ${limit.max})`)
        // One over the limit is cut too, and exactly at the limit is untouched.
        const one = inputFor(operation, limit, "z".repeat(limit.max + 1), NATIVE_BASE)
        expect(softLimitWarning(one, WriteLedgerInputSchema.parse(one), [limit]), limit.path).toContain(`was ${limit.max + 1} chars (limit ${limit.max})`)
        const exact = inputFor(operation, limit, "z".repeat(limit.max), NATIVE_BASE)
        expect(softLimitWarning(exact, WriteLedgerInputSchema.parse(exact), [limit])).toBeUndefined()
      }
    }
  })

  it("every JournalSoftLimits entry is cut by WriteJournalInputSchema and reported by softLimitWarning", () => {
    for (const [operation, limits] of Object.entries(JournalSoftLimits)) {
      for (const limit of limits) {
        const raw = { operation, data: { t: "W_FAIL", u: "u1", tok: 0, msg: "m".repeat(limit.max + 100) } }
        const parsed = WriteJournalInputSchema.parse(raw)
        expect(softLimitWarning(raw, parsed, [limit])).toContain(`${limit.path} was ${limit.max + 100} chars (limit ${limit.max}), kept`)
      }
    }
  })
})

// ─── softLimitWarning ─────────────────────────────────────────────────────────

describe("softLimitWarning", () => {
  const cut = (v: string, max = 400) => truncateWithMarker(v, max)

  it("renders where as data.msg / data.checked[i] / data.native.reviewers[i].checked[j]", () => {
    const raw = { data: { msg: "a".repeat(401), checked: ["ok", "b".repeat(500)], native: { reviewers: [{ checked: ["ok", "c".repeat(402)] }] } } }
    const parsed = { data: { msg: cut(raw.data.msg), checked: ["ok", cut(raw.data.checked[1])], native: { reviewers: [{ checked: ["ok", cut("c".repeat(402))] }] } } }
    const w = softLimitWarning(raw, parsed, [
      { path: "data.msg", max: 400 }, { path: "data.checked.[]", max: 400 }, { path: "data.native.reviewers.[].checked.[]", max: 400 },
    ])!
    expect(w).toMatch(/^TRUNCATED: data\.msg was 401 chars \(limit 400\), kept \d+ \+ marker '…\[truncated \d+ chars\]'; data\.checked\[1\] was 500 chars \(limit 400\), kept \d+ \+ marker '…\[truncated \d+ chars\]'; data\.native\.reviewers\[0\]\.checked\[1\] was 402 chars \(limit 400\), kept \d+ \+ marker '…\[truncated \d+ chars\]'\. The write went through; shorten or split the text if the dropped tail matters\.$/)
  })

  it("returns undefined when nothing was cut or an intermediate segment is absent", () => {
    expect(softLimitWarning({ data: { msg: "short" } }, { data: { msg: "short" } }, [{ path: "data.msg", max: 400 }])).toBeUndefined()
    expect(softLimitWarning({ data: {} }, { data: {} }, LedgerSoftLimits.record_review)).toBeUndefined()
    expect(softLimitWarning({ data: { native: "nope" } }, { data: { native: "nope" } }, LedgerSoftLimits.record_review)).toBeUndefined()
    expect(softLimitWarning(undefined, undefined, LedgerSoftLimits.record_review)).toBeUndefined()
  })

  it("itemises at most 5 fields and counts the rest", () => {
    const raw = { data: { checked: Array.from({ length: 8 }, (_, i) => String(i).repeat(450)) } }
    const parsed = { data: { checked: raw.data.checked.map((v) => cut(v)) } }
    const w = softLimitWarning(raw, parsed, [{ path: "data.checked.[]", max: 400 }])!
    expect(w).toContain("data.checked[4] was 450 chars")
    expect(w).not.toContain("data.checked[5]")
    expect(w).toContain("; +3 more. The write went through")
  })

  it("reports the raw pre-trim length: kept + marker N can be smaller than N", () => {
    const rawValue = "  " + "y".repeat(600) + "  "
    const parsedValue = truncateWithMarker(rawValue.trim(), 400)
    const w = softLimitWarning({ data: { x: rawValue } }, { data: { x: parsedValue } }, [{ path: "data.x", max: 400 }])!
    const m = /kept (\d+) \+ marker '…\[truncated (\d+) chars\]'/.exec(w)!
    expect(w).toContain("data.x was 604 chars (limit 400)")
    expect(Number(m[1]) + Number(m[2])).toBe(600)
  })

  it("names a blank-prefix cut that stored an empty entry", () => {
    const w = softLimitWarning({ data: { checked: [" ".repeat(401)] } }, { data: { checked: [""] } }, [{ path: "data.checked.[]", max: 400 }])!
    expect(w).toContain("data.checked[0] was 401 chars (limit 400), kept prefix was blank so the entry is stored empty")
  })
})

// ─── journal ──────────────────────────────────────────────────────────────────

describe("write_journal log_event msg", () => {
  const init = () => initSession(journalPath, {
    operation: "init_session",
    data: { target_version: "0.6.20", branch: "release/v0.6.0", phase: 1, units: ["u1"], env: { agent: "opus", worker: "sonnet", codex: null, gemini: null } },
  })

  it("returns plain ok when nothing was cut", async () => {
    await init()
    expect(await logEvent(journalPath, { operation: "log_event", data: { t: "W_FAIL", u: "u1", tok: 0, msg: "x".repeat(400) } })).toBe("ok")
  })

  it("a 500-char SEC_BLOCK msg (bestEffortSecBlock's unbounded reason) is stored cut to 400 with a marker and a warning", async () => {
    await init()
    const result = await logEvent(journalPath, { operation: "log_event", data: { t: "SEC_BLOCK", u: "foremanenv", tok: 0, msg: "r".repeat(500) } })
    expect(result.split("\n")[0]).toBe("ok")
    expect(result).toContain("\nwarning: TRUNCATED: data.msg was 500 chars (limit 400), kept 378 + marker '…[truncated 122 chars]'. The write went through")
    const stored = (await readJournal(journalPath)).sessions[0].events[0].msg
    expect(stored).toHaveLength(400)
    expect(stored).toMatch(TRUNCATION_MARKER_RE)
    expect(stored.startsWith("r".repeat(378))).toBe(true)
  })
})

// ─── ledger ───────────────────────────────────────────────────────────────────

describe("write_ledger record_review soft fields", () => {
  it("limitations over 2000 is cut and stored at 2000 with the warning naming it", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: { advisor: "codex", findings: [], completion: "complete", checked: ["src/a.ts"], limitations: "L".repeat(2500) },
    })
    expect(result).toContain("status: ok")
    expect(result).toContain("warning: TRUNCATED: data.limitations was 2500 chars (limit 2000), kept")
    const review = (await readLedger(ledgerPath)).phases.p1.reviews!.at(-1)!
    expect(review.limitations).toHaveLength(2000)
    expect(review.limitations).toMatch(TRUNCATION_MARKER_RE)
  })

  it("native reviewer checked[] over 400 and limitations are cut on a native record; the warning names both (raw pre-trim length)", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: {
        ...NATIVE_BASE.data,
        limitations: "L".repeat(2500),
        native: { ...NATIVE_BASE.data.native, reviewers: [
          { ...NATIVE_BASE.data.native.reviewers[0], checked: ["src/a.ts", "  " + "p".repeat(450)] },
          NATIVE_BASE.data.native.reviewers[1],
        ] },
      },
    }, "codex")
    expect(result).toContain("status: ok")
    expect(result).toContain("warning: TRUNCATED: data.limitations was 2500 chars (limit 2000), kept")
    expect(result).toContain("; data.native.reviewers[0].checked[1] was 452 chars (limit 400), kept")
    const review = (await readLedger(ledgerPath)).phases.p1.reviews!.at(-1)!
    // The ledger prefixes a native record's limitations with its same-provider note; the cut text follows it.
    expect(review.limitations).toMatch(/^Native Codex subagents; same-provider review, not cross-vendor independence\. L+…\[truncated \d+ chars\]$/)
    expect(review.native!.reviewers[0].checked[1]).toHaveLength(400)
    expect(review.native!.reviewers[0].checked[1]).toMatch(TRUNCATION_MARKER_RE)
  })

  it("a whitespace-only checked[] entry over the limit still reads as blank on stage:'native'", async () => {
    await expect(handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1", data: { ...NATIVE_BASE.data, checked: [" ".repeat(401)] },
    }, "codex")).rejects.toThrow(/NATIVE REVIEW INCOMPLETE: native verifier requires a non-empty checked list/)
    await expect(fs.access(ledgerPath)).rejects.toThrow()
  })

  it("hard limits still refuse: native ids, finding text, verifier ids", async () => {
    await expect(handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: { ...NATIVE_BASE.data, native: { ...NATIVE_BASE.data.native, verifier_id: "v".repeat(401) } },
    }, "codex")).rejects.toThrow(/SCHEMA ERROR[\s\S]*data\.native\.verifier_id/)
    await expect(handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: { advisor: "codex", completion: "complete", findings: [{ severity: "low", file: "src/a.ts", line: "1", description: "d".repeat(10001), classification: "rejected" }] },
    })).rejects.toThrow(/SCHEMA ERROR[\s\S]*data\.findings\.0\.description/)
    await expect(fs.access(ledgerPath)).rejects.toThrow()
  })

  it("no warning key when nothing was cut", async () => {
    const result = await handleWriteLedger(ledgerPath, {
      operation: "record_review", phase: "p1",
      data: { advisor: "codex", findings: [], completion: "complete", checked: ["x".repeat(400)], limitations: "l".repeat(2000) },
    })
    expect(result).not.toContain("warning")
  })
})
