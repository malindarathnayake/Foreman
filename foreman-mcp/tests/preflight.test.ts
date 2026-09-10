import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  appendPreflight, briefHash, consistencyFlags, directiveCoverage, directiveSentences, findPreflight, missingSymbols, ownershipSweep, preflightPathFor,
} from "../src/lib/preflight.js"

const DIRECTIVE = `#### p11.1 — GraphQL client
- Files: internal/cfsource/graphql/client.go, classify.go
- Retry on transport failure and 429/5xx only, using the §7.4 policy (2 retries, 500 ms base, full jitter); never retry a 4xx.
- The classifier keeps four end states apart: \`authz\`, \`forbidden\`, \`empty\`, \`unknown_field\`.
- Raise an ops finding naming the missing permission on a 403.
- Guard the cfapi read failure: a nil client must return \`ErrClientUnavailable\`, not panic.
| Signal | Meaning |
|---|---|
| 200 with extensions.code == "authz" | not entitled |
Test: go test ./internal/cfsource/graphql/...`

const BRIEF = `Implement client.go and classify.go. Retry transport failures and 429/5xx with 2 retries, 500 ms base and full jitter; never retry a 4xx.
Keep the four classifier states apart: \`authz\`, \`forbidden\`, \`empty\`, \`unknown_field\`.
Run go test ./internal/cfsource/graphql/...`

describe("directive coverage", () => {
  it("splits bullets, table rows and sentences, skipping headings and rules", () => {
    const s = directiveSentences(DIRECTIVE)
    expect(s[0]).toMatch(/^Files:/)
    expect(s.some((x) => x.startsWith("Retry on transport failure"))).toBe(true)
    expect(s.some((x) => x.startsWith("200 with extensions.code"))).toBe(true)
    expect(s.some((x) => x.startsWith("#### "))).toBe(false)
  })
  it("reports the directive sentences the brief does not echo", () => {
    const report = directiveCoverage(DIRECTIVE, BRIEF)
    expect(report.uncovered.some((s) => s.includes("ops finding"))).toBe(true)
    expect(report.uncovered.some((s) => s.includes("ErrClientUnavailable"))).toBe(true)
    expect(report.uncovered.some((s) => s.startsWith("Retry on transport"))).toBe(false)
    expect(report.uncovered.some((s) => s.includes("four end states"))).toBe(false)
    expect(report.ratio).toBeGreaterThan(0.3)
    expect(report.ratio).toBeLessThan(1)
  })
  it("a code span dropped from a paraphrase is an omission", () => {
    const report = directiveCoverage("- The nil client returns `ErrClientUnavailable`, never a panic.", "The nil client returns an error, never a panic.")
    expect(report.uncovered).toHaveLength(1)
    expect(directiveCoverage("", BRIEF)).toEqual({ sentences: 0, uncovered: [], ratio: 1 })
  })
})

describe("symbols and contradiction markers", () => {
  it("every claimed symbol must appear in the spec", () => {
    expect(missingSymbols(["ErrClientUnavailable", "unknown_field", "NotInSpec", " "], DIRECTIVE)).toEqual(["NotInSpec"])
  })
  it("flags a rule defined two ways, draft markers, and one path asserted with two statuses", () => {
    const brief = `Rule 2: return 404 when the zone is missing.
Some text. Rule 2: return 200 with an empty array when the zone is missing.
DRAFT — still deciding.
GET /zones/{id} returns 404 for a missing zone. Later the handler for GET /zones/{id} responds with 200 for a missing zone.`
    const flags = consistencyFlags(brief)
    expect(flags.map((f) => f.kind)).toEqual(expect.arrayContaining(["duplicate_rule", "draft_marker", "status_conflict"]))
    expect(consistencyFlags(BRIEF)).toEqual([])
  })
})

describe("ownership sweep", () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-own-"))
    await fs.mkdir(path.join(root, "internal", "runner"), { recursive: true })
    await fs.mkdir(path.join(root, "node_modules", "x"), { recursive: true })
    await fs.writeFile(path.join(root, "internal", "kinds.go"), "package internal\ntype Kind int\nconst (KindA Kind = iota\nKindB)\n")
    await fs.writeFile(path.join(root, "internal", "runner", "runner.go"), "package runner\nfunc dispatch(k Kind) {\n switch k {\n case KindA:\n  run()\n default:\n  reject()\n }\n}\n")
    await fs.writeFile(path.join(root, "internal", "runner", "quality.go"), "package runner\nvar names = map[Kind]string{KindA: \"a\"}\n")
    await fs.writeFile(path.join(root, "internal", "unrelated.go"), "package internal\nfunc x() {}\n")
    await fs.writeFile(path.join(root, "node_modules", "x", "index.js"), "Kind KindA switch default:")
    await fs.writeFile(path.join(root, "README.md"), "Kind")
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  it("lists files outside the declared set that reference the type, dispatch sites with default arms first", async () => {
    const report = await ownershipSweep(root, ["Kind"], ["KindB"], ["internal/kinds.go"])
    expect(report.outside.map((h) => h.file)).toEqual(["internal/runner/runner.go", "internal/runner/quality.go"])
    expect(report.outside[0]).toMatchObject({ dispatch: true, default_arm: true, references: ["Kind"] })
    expect(report.outside[1]).toMatchObject({ dispatch: true, default_arm: false })
    expect(report.truncated).toBe(false)
  })
  it("returns nothing to scan when no names are given", async () => {
    expect(await ownershipSweep(root, [], [], [])).toEqual({ scanned: 0, truncated: false, outside: [] })
  })
})

describe("preflight records", () => {
  it("hashes the brief stably across line endings and whitespace, and finds a passing record by hash", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-pf-"))
    try {
      const file = preflightPathFor(path.join(dir, "ledger.json"))
      expect(briefHash("a\r\nb\n")).toBe(briefHash("a\nb"))
      expect(briefHash("a")).toMatch(/^[0-9a-f]{16}$/)
      const h = briefHash(BRIEF)
      expect(await findPreflight(file, h)).toBeNull()
      const base = { v: 1 as const, ts: "t", phase: "p1", unit_id: "u1", brief_hash: h, symbols: 2, coverage_ratio: 0.5, uncovered: 2, flags: 0, dead_citations: 0, ownership_outside: 0 }
      await appendPreflight(file, { ...base, status: "fail" })
      expect(await findPreflight(file, h)).toBeNull()
      await appendPreflight(file, { ...base, status: "pass" })
      expect((await findPreflight(file, h))?.status).toBe("pass")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
