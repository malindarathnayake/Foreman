// 0.6.30: Foreman's existing caps (2 MB worker response, 16 MB council response, 16 KB advisor
// stdout) are crash guards — three orders of magnitude away from the length that makes a review
// unreadable, so they never fire on a merely verbose seat. This is the economy budget they are
// not. The point under test is WHO owns the number: the caller and the operator, never the
// responding model, because "be brief unless you judge more is needed" collapses to "be as long
// as you want".
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_REPORT_MAX_LINES,
  REPORT_MAX_LINES_CEILING,
  REPORT_MAX_LINES_ENV,
  resolveReportMaxLines,
  reportEconomyInstruction,
  withReportBudget,
  seatReportEconomy,
  OVERRUN_MARKER,
} from "../src/lib/outputBudget.js"
import { claudeAgentsInit, CLAUDE_AGENT_ROLES } from "../src/tools/claudeAgentsInit.js"
import { codexAgentsInit, CODEX_AGENT_ROLES } from "../src/tools/codexAgentsInit.js"

const saved = process.env[REPORT_MAX_LINES_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[REPORT_MAX_LINES_ENV]
  else process.env[REPORT_MAX_LINES_ENV] = saved
})

describe("resolveReportMaxLines — the caller and the operator own the number", () => {
  it("falls back to the built-in default with no env and no override", () => {
    delete process.env[REPORT_MAX_LINES_ENV]
    expect(resolveReportMaxLines()).toBe(DEFAULT_REPORT_MAX_LINES)
  })

  it("takes the operator's env default when the caller passes nothing", () => {
    process.env[REPORT_MAX_LINES_ENV] = "40"
    expect(resolveReportMaxLines()).toBe(40)
  })

  it("lets an explicit caller argument beat the env default", () => {
    process.env[REPORT_MAX_LINES_ENV] = "40"
    expect(resolveReportMaxLines(80)).toBe(80)
  })

  it("clamps a caller override to the ceiling", () => {
    expect(resolveReportMaxLines(100000)).toBe(REPORT_MAX_LINES_CEILING)
  })

  it("clamps an operator env value to the ceiling too", () => {
    process.env[REPORT_MAX_LINES_ENV] = String(REPORT_MAX_LINES_CEILING * 10)
    expect(resolveReportMaxLines()).toBe(REPORT_MAX_LINES_CEILING)
  })

  it("ignores a malformed env knob rather than failing the review", () => {
    for (const bad of ["", "   ", "abc", "-5", "0", "12.5", "NaN", "Infinity"]) {
      process.env[REPORT_MAX_LINES_ENV] = bad
      expect(resolveReportMaxLines()).toBe(DEFAULT_REPORT_MAX_LINES)
    }
  })

  it("ignores a malformed caller override rather than treating it as unbounded", () => {
    delete process.env[REPORT_MAX_LINES_ENV]
    for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveReportMaxLines(bad)).toBe(DEFAULT_REPORT_MAX_LINES)
    }
  })
})

describe("the instruction states a number and a closed escape list", () => {
  it("names the resolved budget", () => {
    expect(reportEconomyInstruction(15)).toContain("at most 15 lines")
    expect(reportEconomyInstruction(60)).toContain("at most 60 lines")
  })

  it("is byte-stable for a given budget, so a hashed packet stays reproducible", () => {
    expect(reportEconomyInstruction(15)).toBe(reportEconomyInstruction(15))
  })

  it("grants escapes by NAME, never by the seat's own judgement", () => {
    const text = reportEconomyInstruction(15)
    expect(text).toContain("not by your judgement")
    expect(text).toContain("named exception")
    expect(text).toContain("Name the one that applies before you exceed")
    expect(text).not.toMatch(/unless you (judge|feel|think|decide)/i)
    expect(text).not.toMatch(/use your (own )?judge?ment/i)
  })

  // Measured regression. The first cut said only "report in at most 15 lines"; against the same
  // review prompt a live seat answered with 4 findings where the unbounded arm gave 7. It met the
  // bound by dropping findings rather than prose — a correctness regression wearing a conciseness
  // win. These pin the ordering that fixes it.
  it("orders the trade: completeness beats the bound", () => {
    const text = reportEconomyInstruction(15)
    expect(text).toContain("Report EVERY finding you have")
    expect(text).toContain("Never drop, merge or omit a finding")
    expect(text).toContain("Completeness outranks the bound")
    expect(text).toContain("Cut the words around the findings, never the findings")
  })

  it("gives the seat a way to stay complete AND honest when findings alone overflow", () => {
    const text = reportEconomyInstruction(15)
    expect(text).toContain(OVERRUN_MARKER)
    expect(text).toContain("keep going")
    expect(text).toContain("the bound working, not a violation")
  })

  it("never tells a seat to shorten by reporting less", () => {
    const text = [reportEconomyInstruction(15), seatReportEconomy()].join(" ")
    expect(text).not.toMatch(/(only the )?(most )?(important|significant|top|key) findings/i)
    expect(text).not.toMatch(/limit (yourself|the report) to the .* findings/i)
    expect(text).not.toMatch(/prioriti[sz]e .* findings/i)
  })

  it("sends the evidence somewhere other than the report", () => {
    expect(reportEconomyInstruction(15)).toContain("ledger record")
  })
})

describe("withReportBudget", () => {
  it("appends the budget without disturbing the caller's prompt", () => {
    delete process.env[REPORT_MAX_LINES_ENV]
    const out = withReportBudget("Review handler.go for races.")
    expect(out.startsWith("Review handler.go for races.")).toBe(true)
    expect(out).toContain(`at most ${DEFAULT_REPORT_MAX_LINES} lines`)
  })

  it("carries a caller override through to the text the seat reads", () => {
    expect(withReportBudget("x", 60)).toContain("at most 60 lines")
  })
})

describe("generated seat definitions carry the same rule", () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-econ-")) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it("bakes the default budget into every Claude seat", async () => {
    await claudeAgentsInit({ project_dir: dir })
    for (const role of CLAUDE_AGENT_ROLES) {
      const body = await fs.readFile(path.join(dir, ".claude", "agents", `${role}.md`), "utf-8")
      expect(body, role).toContain(`at most ${DEFAULT_REPORT_MAX_LINES} lines`)
      expect(body, role).toContain("named exception")
    }
  })

  it("bakes it into every Codex role, reviewer and verifier included", async () => {
    await codexAgentsInit({ project_dir: dir })
    for (const role of CODEX_AGENT_ROLES) {
      const body = await fs.readFile(path.join(dir, ".codex", "agents", `${role}.toml`), "utf-8")
      expect(body, role).toContain(`at most ${DEFAULT_REPORT_MAX_LINES} lines`)
    }
  })

  it("keeps the seat text free of a discretion clause", () => {
    expect(seatReportEconomy()).not.toMatch(/unless you (judge|feel|think|decide)/i)
    expect(seatReportEconomy()).toContain("An")
    expect(seatReportEconomy()).toContain("unnamed overrun is a defect in the report")
    expect(seatReportEconomy()).toContain("completeness outranks the bound")
  })
})

describe("the council seats carry the budget too", () => {
  it("every lens seat prompt ends with the economy rule", async () => {
    const { buildSeatPrompt, LENS_CATALOG, LENS_IDS } = await import("../src/lib/lensCatalog.js")
    for (const id of LENS_IDS) {
      const text = buildSeatPrompt(LENS_CATALOG[id])
      expect(text, id).toContain(`at most ${DEFAULT_REPORT_MAX_LINES} lines`)
      expect(text, id).toContain("Never drop, merge or omit a finding")
    }
  })

  it("a caller-raised budget reaches the lens seat", async () => {
    const { buildSeatPrompt, LENS_CATALOG, LENS_IDS } = await import("../src/lib/lensCatalog.js")
    expect(buildSeatPrompt(LENS_CATALOG[LENS_IDS[0]], 60)).toContain("at most 60 lines")
  })
})
