// 0.7.0 (owner request): a repository's root CHANGELOG.md in Keep a Changelog 1.1.0 format.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectChangelog } from "../src/tools/projectChangelog.js"
import { checkChangelog, cutRelease, KAC_HEADER } from "../src/lib/changelogFormat.js"
import { writeLedger } from "../src/lib/ledger.js"

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-")) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const read = () => fs.readFile(path.join(root, "CHANGELOG.md"), "utf-8")

describe("Keep a Changelog check", () => {
  it("the standard header conforms", () => { expect(checkChangelog(KAC_HEADER)).toEqual([]) })

  it("names each departure with its line", () => {
    const bad = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Improvements\n- x\n\n## [2.0.0] - 2026-02-01\n\n### Added\n"
    const issues = checkChangelog(bad).map((i) => i.issue)
    expect(issues.some((i) => i.includes("release heading must be"))).toBe(true)
    expect(issues.some((i) => i.includes("'### Improvements' is not a Keep a Changelog category"))).toBe(true)
    expect(issues.some((i) => i.includes("has no entries"))).toBe(true)
    expect(issues.some((i) => i.includes("missing '## [Unreleased]'"))).toBe(true)
  })

  it("refuses releases out of order", () => {
    const t = KAC_HEADER + "\n## [1.0.0] - 2026-01-01\n\n### Added\n- a\n\n## [2.0.0] - 2026-02-01\n\n### Added\n- b\n"
    expect(checkChangelog(t).some((i) => i.issue.includes("not older than"))).toBe(true)
  })
})

describe("project_changelog", () => {
  it("init creates the file once; check reports ok", async () => {
    expect(await projectChangelog({ operation: "check" }, root)).toContain("status: missing")
    expect(await projectChangelog({ operation: "init" }, root)).toContain("status: created")
    expect(await projectChangelog({ operation: "init" }, root)).toContain("status: exists")
    expect(await projectChangelog({ operation: "check" }, root)).toContain("status: ok")
  })

  it("release moves [Unreleased] under the version and notes returns it; empty and older versions are refused", async () => {
    await projectChangelog({ operation: "init" }, root)
    expect(await projectChangelog({ operation: "release", version: "1.0.0" }, root)).toMatch(/\[Unreleased\] is empty/)
    await fs.writeFile(path.join(root, "CHANGELOG.md"), KAC_HEADER + "\n### Added\n\n- Export to CSV.\n")
    expect(await projectChangelog({ operation: "release", version: "1.0.0", date: "2026-10-01" }, root)).toContain("status: released")
    const text = await read()
    expect(text).toMatch(/## \[Unreleased\]\s+## \[1\.0\.0\] - 2026-10-01\s+### Added\s+- Export to CSV\./)
    expect(checkChangelog(text)).toEqual([])
    expect(await projectChangelog({ operation: "notes", version: "1.0.0" }, root)).toContain("- Export to CSV.")
    await fs.writeFile(path.join(root, "CHANGELOG.md"), text.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- A crash.\n"))
    expect(await projectChangelog({ operation: "release", version: "0.9.0" }, root)).toMatch(/not newer than the latest release 1\.0\.0/)
  })

  it("writes are refused while a worker holds the repository window", async () => {
    const ledger = path.join(root, "ledger.json")
    await writeLedger(ledger, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: "Implement the unit as the spec says.", preflight: { symbols_grepped: 1, self_consistent: true } } } as never)
    const l = JSON.parse(await fs.readFile(ledger, "utf-8"))
    l.window = { root, phase: "p1", unit_id: "u1", attempt: 1, stage: "editing", opened_ts: "2026-10-01T00:00:00Z" }
    await fs.writeFile(ledger, JSON.stringify(l))
    expect(await projectChangelog({ operation: "init" }, root, ledger)).toMatch(/holds the repository window/)
    expect(await projectChangelog({ operation: "check" }, root, ledger)).toContain("status: missing")
  })

  it("cutRelease refuses a bad version or date", () => {
    expect(cutRelease(KAC_HEADER, "v1", "2026-10-01")).toMatchObject({ refused: expect.stringContaining("not SemVer") })
    expect(cutRelease(KAC_HEADER, "1.0.0", "2026-13-40")).toMatchObject({ refused: expect.stringContaining("YYYY-MM-DD") })
  })
})

// Codex review of 0.7.0: SemVer precedence, fences, link footers, calendar dates, reference links.
describe("Keep a Changelog edge cases", () => {
  it("a release follows its prereleases; malformed versions and impossible dates are refused", () => {
    const t = KAC_HEADER + "\n### Added\n\n- x\n\n## [1.0.0-rc.1] - 2026-09-01\n\n### Added\n\n- rc\n"
    const cut = cutRelease(t, "1.0.0", "2026-10-01")
    expect("text" in cut).toBe(true)
    if ("text" in cut) expect(checkChangelog(cut.text)).toEqual([])
    expect(cutRelease(t, "01.0.0", "2026-10-01")).toMatchObject({ refused: expect.stringContaining("SemVer") })
    expect(cutRelease(t, "1.0.0", "2026-02-30")).toMatchObject({ refused: expect.stringContaining("real") })
  })

  it("a '## ' line inside a code fence is content: notes keep everything after it", async () => {
    const t = KAC_HEADER + "\n## [1.0.0] - 2026-10-01\n\n### Added\n\n- Templates:\n\n```md\n## Template\n```\n\n- Second change.\n"
    expect(checkChangelog(t)).toEqual([])
    await fs.writeFile(path.join(root, "CHANGELOG.md"), t)
    const notes = await projectChangelog({ operation: "notes", version: "1.0.0" }, root)
    expect(notes).toContain("- Second change.")
  })

  it("a link footer alone is not releasable content", () => {
    const t = KAC_HEADER + "\n[Unreleased]: https://example.test/compare/v1.0.0...HEAD\n"
    expect(cutRelease(t, "1.1.0", "2026-10-01")).toMatchObject({ refused: expect.stringContaining("empty") })
  })

  it("release advances the [Unreleased] comparison link and adds the version link; notes carry used definitions", async () => {
    const t = KAC_HEADER + "\n### Fixed\n\n- A [parser][issue] crash.\n\n## [1.0.0] - 2026-09-01\n\n### Added\n\n- First.\n\n[Unreleased]: https://example.test/compare/v1.0.0...HEAD\n[1.0.0]: https://example.test/releases/tag/v1.0.0\n[issue]: https://example.test/issues/7\n"
    const cut = cutRelease(t, "1.1.0", "2026-10-01")
    expect("text" in cut).toBe(true)
    if (!("text" in cut)) return
    expect(cut.text).toContain("[Unreleased]: https://example.test/compare/v1.1.0...HEAD")
    expect(cut.text).toContain("[1.1.0]: https://example.test/compare/v1.0.0...v1.1.0")
    expect(checkChangelog(cut.text)).toEqual([])
    await fs.writeFile(path.join(root, "CHANGELOG.md"), cut.text)
    expect(await projectChangelog({ operation: "notes", version: "1.1.0" }, root)).toContain("[issue]: https://example.test/issues/7")
  })
})
