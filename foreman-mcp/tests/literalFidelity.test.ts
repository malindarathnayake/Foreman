// Protected-literal fidelity (v0.6.14). Foreman compresses run_tests and invoke_advisor
// output before the pit-boss reads it, and the pit-boss reads exactly what a lossy
// compressor mangles first: the failing file:line, the exit code, the counts, the flag.
// Before this check the only guard was "a marker survived and the output is non-empty",
// so a digest could drop every location in a failure report and still be served.
import { describe, it, expect, vi, afterEach } from "vitest"
import { checkLiteralFidelity, extractLiterals, describeFidelityFailure } from "../src/lib/literalFidelity.js"
import { lossyGuardsReject } from "../src/lib/compression.js"

afterEach(() => {
  vi.restoreAllMocks()
})

// Shaped like real run_tests output: a meta head, a failing assertion with a location,
// counts, and the command that produced it.
const TEST_OUTPUT = [
  "exit_code: 1",
  "passed: false",
  "",
  "FAIL src/lib/ledger.ts:675 — epoch_failed reset on pass",
  "  expected 3 received 0",
  "  at verifyAttempt (src/lib/ledger.ts:181:12)",
  "FAIL tests/gate.test.ts:42 — gate closed without a review",
  "",
  "Tests  2 failed | 1169 passed",
  "Duration 88.81s",
  "run: npx vitest run --reporter=dot",
].join("\n")

describe("extractLiterals", () => {
  it("finds the literals a reader cannot reconstruct", () => {
    const found = [...extractLiterals(TEST_OUTPUT).keys()]
    expect(found).toContain("file_line:src/lib/ledger.ts:675")
    expect(found).toContain("file_line:src/lib/ledger.ts:181:12")
    expect(found).toContain("file_line:tests/gate.test.ts:42")
    expect(found).toContain("long_flag:--reporter")
    expect(found.some((k) => k.startsWith("exit_code:"))).toBe(true)
    expect(found.some((k) => k === "number_unit:2 failed")).toBe(true)
    expect(found.some((k) => k === "number_unit:1169 passed")).toBe(true)
  })

  it("counts a repeated literal once per occurrence", () => {
    const counts = extractLiterals("a src/a.ts:1 b src/a.ts:1 c")
    expect(counts.get("file_line:src/a.ts:1")).toBe(2)
  })

  it("does not double-count a path inside a longer file:line", () => {
    const counts = extractLiterals("see src/lib/ledger.ts:675 now")
    expect(counts.get("file_line:src/lib/ledger.ts:675")).toBe(1)
    expect(counts.get("path:src/lib/ledger.ts")).toBeUndefined()
  })
})

describe("checkLiteralFidelity", () => {
  it("accepts a digest that only removes reconstructible prose", () => {
    // Every literal kept; only English scaffolding dropped.
    const compressed = TEST_OUTPUT.replace(" — epoch_failed reset on pass", "").replace("  expected 3 received 0\n", "")
    const report = checkLiteralFidelity(TEST_OUTPUT, compressed)
    expect(report.ok).toBe(true)
    expect(report.lost).toEqual([])
  })

  it("rejects a digest that drops a failing location", () => {
    const compressed = TEST_OUTPUT.replace("FAIL tests/gate.test.ts:42 — gate closed without a review\n", "")
    const report = checkLiteralFidelity(TEST_OUTPUT, compressed)
    expect(report.ok).toBe(false)
    expect(report.lost.join(" ")).toContain("tests/gate.test.ts:42")
  })

  it("rejects a digest that drops the exit code", () => {
    expect(checkLiteralFidelity(TEST_OUTPUT, TEST_OUTPUT.replace("exit_code: 1", "")).ok).toBe(false)
  })

  it("tolerates dropped bulk noise, which is what compression is for", () => {
    // Measured on this repo's own 5,000-line fixture: real compression keeps 4/4 paths and
    // drops 103/103 incidental timings. Gating on the timings would reject honest work.
    const noisy = `${TEST_OUTPUT}
  case_1 PASSED in 12ms
  case_2 PASSED in 13ms`
    expect(checkLiteralFidelity(noisy, TEST_OUTPUT).ok).toBe(true)
    // A summariser writing its own tally is not an invented location.
    expect(checkLiteralFidelity(TEST_OUTPUT, `${TEST_OUTPUT}
3 errors`).ok).toBe(true)
  })

  it("rejects an invented literal", () => {
    // The classic lossy-summarizer failure: a plausible line number that was never there.
    const compressed = TEST_OUTPUT.replace("src/lib/ledger.ts:675", "src/lib/ledger.ts:999")
    const report = checkLiteralFidelity(TEST_OUTPUT, compressed)
    expect(report.ok).toBe(false)
    expect(report.lost.join(" ")).toContain(":675")
    expect(report.invented.join(" ")).toContain(":999")
  })

  it("allows deduplication: a repeated literal may drop in count but not to zero", () => {
    const original = "fail src/a.ts:1\nfail src/a.ts:1\nfail src/a.ts:1"
    const compressed = "fail src/a.ts:1 (x3)"
    const report = checkLiteralFidelity(original, compressed)
    expect(report.ok).toBe(true)
    expect(report.deduped.join(" ")).toContain("3 -> 1")
  })

  it("holds every location and path, the classes a verdict depends on", () => {
    const original = "at src/db.ts:118 in /workspace/project/src/db.py and ./tests/a.test.ts:9"
    for (const drop of ["src/db.ts:118", "/workspace/project/src/db.py", "./tests/a.test.ts:9"]) {
      expect(checkLiteralFidelity(original, original.replace(drop, "")).ok, drop).toBe(false)
    }
  })

  it("describeFidelityFailure names both buckets", () => {
    const report = checkLiteralFidelity("a src/a.ts:1", "a src/a.ts:2")
    expect(describeFidelityFailure(report)).toMatch(/lost 1.*src\/a\.ts:1/)
    expect(describeFidelityFailure(report)).toMatch(/invented 1.*src\/a\.ts:2/)
  })
})

describe("lossyGuardsReject wires the check into compression", () => {
  // context-crush emits exactly 24 lowercase hex characters; findMarkers accepts nothing else.
  const withMarker = (body: string) => `${body}\n<<ccr:0123456789abcdef01234567>>`

  it("still rejects a missing marker and an empty digest", () => {
    expect(lossyGuardsReject(TEST_OUTPUT, "no marker here")).toBe(true)
    expect(lossyGuardsReject(TEST_OUTPUT, "")).toBe(true)
  })

  it("accepts a faithful digest", () => {
    expect(lossyGuardsReject(TEST_OUTPUT, withMarker(TEST_OUTPUT))).toBe(false)
  })

  it("rejects a digest that lost a location, and says why on stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const mangled = withMarker(TEST_OUTPUT.replace("src/lib/ledger.ts:675", "the ledger"))
    expect(lossyGuardsReject(TEST_OUTPUT, mangled)).toBe(true)
    expect(err).toHaveBeenCalledOnce()
    expect(String(err.mock.calls[0][0])).toMatch(/compression rejected — lost .*ledger\.ts:675/)
  })

  it("a digest that keeps every literal but drops prose is served", () => {
    // This is the case the guard must NOT block: real compression doing its job.
    const compressed = withMarker(
      TEST_OUTPUT.split("\n").filter((l) => !l.startsWith("  expected")).join("\n")
    )
    expect(lossyGuardsReject(TEST_OUTPUT, compressed)).toBe(false)
  })
})
