import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyCitations } from "../src/tools/verifyCitations"
import { VerifyCitationsInputSchema } from "../src/types"

// Fixture file under the temp repo root.
// 1: export function handleRetry(context) {
// 2:   const escalateAfterMinutes = 10
// 3:   writeAuditLog(context)
// 4:   return context
// 5: }
// 6: // note: escalateAfterMinutes is duplicated on this comment line
const ROUTER = [
  "export function handleRetry(context) {",
  "  const escalateAfterMinutes = 10",
  "  writeAuditLog(context)",
  "  return context",
  "}",
  "// note: escalateAfterMinutes is duplicated on this comment line",
].join("\n")

// Same phrase appears single-spaced (L2) and multi-spaced (L5): the raw forms
// differ but the whitespace-normalized form is identical on both lines.
const DUP = [
  "alpha",
  "the config value set here",
  "gamma",
  "delta",
  "the config  value   set here",
].join("\n")

let tmpRoot: string

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "verify-citations-"))
  await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true })
  await fs.writeFile(path.join(tmpRoot, "src", "router.ts"), ROUTER, "utf8")
  await fs.writeFile(path.join(tmpRoot, "src", "dup.ts"), DUP, "utf8")
  await fs.writeFile(path.join(tmpRoot, "LICENSE"), "MIT License\nCopyright holder\n", "utf8")
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function verdicts(specText: string) {
  const { data } = await verifyCitations({ spec_text: specText, repo_root: tmpRoot } as any)
  return data.verdicts
}

async function verdictOf(specText: string) {
  const v = await verdicts(specText)
  expect(v.length).toBe(1)
  return v[0].verdict
}

describe("verifyCitations — anchored confirmation", () => {
  it("anchor present at the cited line → CONFIRMED", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:2` `escalateAfterMinutes = 10`")).toBe("CONFIRMED")
  })

  it("anchor present after whitespace normalization → CONFIRMED_NORMALIZED", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:2` `const escalateAfterMinutes  =  10`")).toBe(
      "CONFIRMED_NORMALIZED"
    )
  })

  it("anchor on a neighbor line (off-by-one) → DRIFTED, not CONFIRMED", async () => {
    const v = await verdicts("Evidence: `src/router.ts:1` `escalateAfterMinutes = 10`")
    expect(v[0].verdict).toBe("DRIFTED")
    expect(v[0].detail).toContain("line 2")
  })
})

describe("verifyCitations — false-CONFIRMED guards", () => {
  it("single common keyword anchor → ANCHOR_TOO_GENERIC", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:4` `return`")).toBe("ANCHOR_TOO_GENERIC")
  })

  it("pure-punctuation anchor → ANCHOR_TOO_GENERIC", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:5` `}`")).toBe("ANCHOR_TOO_GENERIC")
  })

  it("too-short anchor (< min_anchor_chars) → ANCHOR_TOO_GENERIC", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:3` `Log`")).toBe("ANCHOR_TOO_GENERIC")
  })

  it("anchor occurring on more than one line → ANCHOR_TOO_GENERIC", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:2` `escalateAfterMinutes`")).toBe("ANCHOR_TOO_GENERIC")
  })

  it("case-only match → CASE_MISMATCH, never CONFIRMED or DRIFTED", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:2` `ESCALATEAFTERMINUTES = 10`")).toBe("CASE_MISMATCH")
  })
})

describe("verifyCitations — anchorless and missing", () => {
  it("file+line exist, no anchor → UNANCHORED, passes the machine gate", async () => {
    const { data } = await verifyCitations({ spec_text: "Evidence: `src/router.ts:2`", repo_root: tmpRoot } as any)
    expect(data.verdicts[0].verdict).toBe("UNANCHORED")
    expect(data.passed).toBe(true)
  })

  it("line beyond EOF → MISSING", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:999` `anything here`")).toBe("MISSING")
  })

  it("line 0 → MALFORMED", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:0` `escalateAfterMinutes = 10`")).toBe("MALFORMED")
  })

  it("nonexistent file → MISSING (PATH_NOT_FOUND)", async () => {
    const v = await verdicts("Evidence: `src/nope.ts:1` `whatever text`")
    expect(v[0].verdict).toBe("MISSING")
    expect(v[0].detail).toContain("PATH_NOT_FOUND")
  })

  it("path traversal outside repo_root → MALFORMED, not followed", async () => {
    const v = await verdicts("Evidence: `../../etc/passwd:1` `root`")
    expect(v[0].verdict).toBe("MALFORMED")
    expect(v[0].detail).toContain("PATH_TRAVERSAL")
  })

  it("anchor absent anywhere in window → MISSING (ANCHOR_NOT_FOUND_IN_WINDOW)", async () => {
    const v = await verdicts("Evidence: `src/router.ts:2` `this string is not in the file at all`")
    expect(v[0].verdict).toBe("MISSING")
    expect(v[0].detail).toContain("ANCHOR_NOT_FOUND_IN_WINDOW")
  })
})

describe("verifyCitations — non-file and parsing", () => {
  it("commands, tickets, and URLs → NON_FILE (not errors), gate stays true", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `npm test`, `JIRA-123`, `https://example.com/x`",
      repo_root: tmpRoot,
    } as any)
    expect(data.verdicts).toHaveLength(3)
    expect(data.verdicts.every((v) => v.verdict === "NON_FILE")).toBe(true)
    expect(data.passed).toBe(true)
  })

  it("multiple anchored refs on one line split-then-pair correctly", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `src/router.ts:2` `escalateAfterMinutes = 10`, `src/router.ts:3` `writeAuditLog`",
      repo_root: tmpRoot,
    } as any)
    expect(data.verdicts).toHaveLength(2)
    expect(data.verdicts[0].verdict).toBe("CONFIRMED")
    expect(data.verdicts[1].verdict).toBe("CONFIRMED")
  })

  it("'or'-separated file ref + discovery ref → one UNANCHORED + one NON_FILE", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `src/router.ts:2` or `discovery: SLA review`",
      repo_root: tmpRoot,
    } as any)
    expect(data.verdicts).toHaveLength(2)
    const kinds = data.verdicts.map((v) => v.verdict).sort()
    expect(kinds).toEqual(["NON_FILE", "UNANCHORED"])
  })

  it("Windows drive-colon does not split as file:line", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `C:\\nope\\x.ts:12`",
      repo_root: tmpRoot,
    } as any)
    expect(data.verdicts[0].path).toBe("C:\\nope\\x.ts")
    expect(data.verdicts[0].line).toBe("12")
  })
})

describe("verifyCitations — machine JSON corpus shapes", () => {
  const MACHINE = JSON.stringify({
    schema: "spec-man.machine.v1",
    sources: [
      { id: "source.001", ref: "src/router.ts:2", anchor: "escalateAfterMinutes = 10", type: "code" },
      { id: "source.002", ref: "JIRA-9", type: "ticket" },
    ],
    requirements: [{ id: "R001", source_ids: ["source.001"] }],
    surfaces: [{ claims: [{ text: "writes audit log", evidence: ["src/router.ts:3"] }] }],
    mismatches: [{ id: "M001", evidence: ["src/router.ts:2", "src/router.ts:4"] }],
  })

  it("parses surfaces[].claims[].evidence[] and flat mismatches[].evidence[] (scope-gap regression)", async () => {
    const { data } = await verifyCitations({ spec_text: MACHINE, repo_root: tmpRoot } as any)
    expect(data.total_refs).toBeGreaterThanOrEqual(4)
    expect(data.counts.CONFIRMED ?? 0).toBeGreaterThanOrEqual(1)
    expect(data.counts.UNANCHORED ?? 0).toBeGreaterThanOrEqual(1)
  })

  it("ticket-typed source is NON_FILE, not MISSING", async () => {
    const { data } = await verifyCitations({ spec_text: MACHINE, repo_root: tmpRoot } as any)
    expect(data.verdicts.some((v) => v.verdict === "NON_FILE")).toBe(true)
  })

  it("auto format detects JSON via leading brace", async () => {
    const { data } = await verifyCitations({ spec_text: MACHINE, repo_root: tmpRoot, source_format: "auto" } as any)
    expect(data.total_refs).toBeGreaterThan(0)
  })
})

describe("verifyCitations — gate", () => {
  it("any MISSING ref fails the gate; UNANCHORED alone does not", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `src/router.ts:2`\nEvidence: `src/nope.ts:1` `x`",
      repo_root: tmpRoot,
    } as any)
    expect(data.passed).toBe(false)
  })

  it("TOON output carries preamble keys and a verdict table", async () => {
    const { text } = await verifyCitations({
      spec_text: "Evidence: `src/router.ts:2` `escalateAfterMinutes = 10`",
      repo_root: tmpRoot,
    } as any)
    expect(text).toContain("passed:")
    expect(text).toContain("counts:")
    expect(text).toContain("verdict | path | line | anchor | detail | origin")
  })

  it("empty spec → zero refs, passed true", async () => {
    const { data } = await verifyCitations({ spec_text: "no citations here", repo_root: tmpRoot } as any)
    expect(data.total_refs).toBe(0)
    expect(data.passed).toBe(true)
  })
})

describe("verifyCitations — input contract", () => {
  it("throws when both spec_text and spec_path are given", async () => {
    await expect(
      verifyCitations({ spec_text: "x", spec_path: "y", repo_root: tmpRoot } as any)
    ).rejects.toThrow()
  })

  it("throws when neither spec_text nor spec_path is given", async () => {
    await expect(verifyCitations({ repo_root: tmpRoot } as any)).rejects.toThrow()
  })
})

describe("verifyCitations — review-fix regressions", () => {
  it("M2: anchor whose normalized form matches >1 line is ANCHOR_TOO_GENERIC, not CONFIRMED_NORMALIZED", async () => {
    expect(await verdictOf("Evidence: `src/dup.ts:5` `config value set`")).toBe("ANCHOR_TOO_GENERIC")
  })

  it("M3: Evidence lines inside fenced code blocks are not verified", async () => {
    const { data } = await verifyCitations({
      spec_text: "```\nEvidence: `src/ghost.ts:1` `phantom text here`\n```",
      repo_root: tmpRoot,
    } as any)
    expect(data.total_refs).toBe(0)
    expect(data.passed).toBe(true)
  })

  it("M3: a real out-of-fence ref is still verified alongside a fenced example", async () => {
    const { data } = await verifyCitations({
      spec_text:
        "```\nEvidence: `src/ghost.ts:1` `phantom`\n```\nEvidence: `src/router.ts:2` `escalateAfterMinutes = 10`",
      repo_root: tmpRoot,
    } as any)
    expect(data.total_refs).toBe(1)
    expect(data.verdicts[0].verdict).toBe("CONFIRMED")
  })

  it("L2: 'Evidence:' as a substring (PriorEvidence:) does not produce a ref", async () => {
    const { data } = await verifyCitations({
      spec_text: "The word PriorEvidence: `src/router.ts:2` should not parse",
      repo_root: tmpRoot,
    } as any)
    expect(data.total_refs).toBe(0)
  })

  it("M5: prose ending in a dotted token (see Node.js) stays NON_FILE, not MISSING", async () => {
    const { data } = await verifyCitations({ spec_text: "Evidence: `see Node.js`", repo_root: tmpRoot } as any)
    expect(data.verdicts[0].verdict).toBe("NON_FILE")
    expect(data.passed).toBe(true)
  })

  it("M4: extensionless real file cited bare resolves to UNANCHORED", async () => {
    expect(await verdictOf("Evidence: `LICENSE`")).toBe("UNANCHORED")
  })

  it("M4: bare token that is not a real file stays NON_FILE (gate not poisoned)", async () => {
    const { data } = await verifyCitations({ spec_text: "Evidence: `madeupbareword`", repo_root: tmpRoot } as any)
    expect(data.verdicts[0].verdict).toBe("NON_FILE")
    expect(data.passed).toBe(true)
  })

  it("M6: trailing-dash line spec on a present file is MALFORMED, not MISSING", async () => {
    expect(await verdictOf("Evidence: `src/router.ts:1-` `escalateAfterMinutes = 10`")).toBe("MALFORMED")
  })

  it("L1: file:line:col editor format parses the line and ignores the column", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `src/router.ts:2:15` `escalateAfterMinutes = 10`",
      repo_root: tmpRoot,
    } as any)
    expect(data.verdicts[0].path).toBe("src/router.ts")
    expect(data.verdicts[0].line).toBe("2")
    expect(data.verdicts[0].verdict).toBe("CONFIRMED")
  })

  it("H2: wrong-case path with default case_insensitive_path -> CASE_MISMATCH", async () => {
    expect(await verdictOf("Evidence: `src/ROUTER.TS:2` `escalateAfterMinutes = 10`")).toBe("CASE_MISMATCH")
  })

  it("H2: wrong-case path with case_insensitive_path=false -> MISSING", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence: `src/ROUTER.TS:2` `escalateAfterMinutes = 10`",
      repo_root: tmpRoot,
      case_insensitive_path: false,
    } as any)
    expect(data.verdicts[0].verdict).toBe("MISSING")
  })

  it("H3: a long whitespace-only Evidence remainder returns promptly with zero refs", async () => {
    const { data } = await verifyCitations({
      spec_text: "Evidence:" + " ".repeat(200000),
      repo_root: tmpRoot,
    } as any)
    expect(data.total_refs).toBe(0)
  })

  it("M8: deeply nested machine JSON does not throw (returns a deterministic result)", async () => {
    const deep = '{"a":'.repeat(400) + '{"evidence":["src/router.ts:1"]}' + "}".repeat(400)
    const { data } = await verifyCitations({ spec_text: deep, repo_root: tmpRoot, source_format: "machine_json" } as any)
    expect(data).toBeDefined()
    expect(Array.isArray(data.verdicts)).toBe(true)
  })

  it("M1: spec_path that escapes repo_root is rejected", async () => {
    await expect(
      verifyCitations({ spec_path: "../../etc/passwd", repo_root: tmpRoot } as any)
    ).rejects.toThrow(/PATH_TRAVERSAL/)
  })

  it("H1: a UTF-16 spec file is rejected, never silently parsed to zero refs", async () => {
    const content = "Evidence: `src/router.ts:2` `escalateAfterMinutes = 10`"
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")])
    await fs.writeFile(path.join(tmpRoot, "utf16spec.md"), buf)
    await expect(
      verifyCitations({ spec_path: "utf16spec.md", repo_root: tmpRoot } as any)
    ).rejects.toThrow(/UTF-16|not UTF-8/)
  })

  it("L3: a missing spec_path throws a clean error, not a raw ENOENT", async () => {
    await expect(
      verifyCitations({ spec_path: "does/not/exist.md", repo_root: tmpRoot } as any)
    ).rejects.toThrow(/not found/)
  })
})

describe("VerifyCitationsInputSchema caps", () => {
  it("rejects spec_text over 500000 chars", () => {
    expect(() => VerifyCitationsInputSchema.parse({ spec_text: "a".repeat(500001) })).toThrow()
  })

  it("rejects drift_window over 200", () => {
    expect(() => VerifyCitationsInputSchema.parse({ spec_text: "a", drift_window: 201 })).toThrow()
  })

  it("rejects min_anchor_chars over 200", () => {
    expect(() => VerifyCitationsInputSchema.parse({ spec_text: "a", min_anchor_chars: 201 })).toThrow()
  })

  it("applies defaults (source_format auto, drift_window 25, min_anchor_chars 8)", () => {
    const parsed = VerifyCitationsInputSchema.parse({ spec_text: "a" })
    expect(parsed.source_format).toBe("auto")
    expect(parsed.drift_window).toBe(25)
    expect(parsed.min_anchor_chars).toBe(8)
    expect(parsed.case_insensitive_path).toBe(true)
  })
})
