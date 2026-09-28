import { describe, it, expect } from "vitest"
import {
  hostHygieneCommands,
  remainingWork,
  hygieneAfterLedgerWrite,
  hygieneForOrient,
  applySessionHygiene,
  skillActivationHeader,
} from "../src/lib/sessionHygiene.js"
import type { LedgerFile } from "../src/types.js"

function ledger(phases: LedgerFile["phases"]): LedgerFile {
  return { v: 1, ts: "2026-09-18T00:00:00Z", phases }
}

describe("hostHygieneCommands", () => {
  it("names Cursor and Claude slash commands", () => {
    expect(hostHygieneCommands("cursor")).toEqual({ compact: "/compact", clear: "/clear" })
    expect(hostHygieneCommands("claude-code")).toEqual({ compact: "/compact", clear: "/clear" })
    expect(hostHygieneCommands("codex").clear).toContain("new thread")
  })
})

describe("remainingWork / hygieneAfterLedgerWrite", () => {
  const twoUnits: LedgerFile["phases"] = {
    p1: {
      s: "ip",
      g: "pending",
      units: {
        u1: { s: "done", v: "pass", w: null, rej: [] },
        u2: { s: "pending", v: "pending", w: null, rej: [] },
      },
    },
  }

  it("counts unfinished units and phases", () => {
    expect(remainingWork(ledger(twoUnits))).toEqual({ unitsRemaining: 1, phasesRemaining: 1 })
  })

  // 0.6.34 (field report): a compact prompt after every unit pass was the most annoying
  // friction in the run. A unit pass never suggests anything.
  it("says nothing after a unit pass, even when work remains", () => {
    expect(hygieneAfterLedgerWrite("set_verdict", { v: "pass" }, ledger(twoUnits)).action).toBe("none")
  })

  // 0.6.37 (field report 2026-09-27): relayed as "Run /compact now" at 5% usage. The phase
  // boundary now asks the host to check its usage against a threshold instead.
  it("asks the host to check its usage when a phase gate passes and phases remain", () => {
    const two = ledger({
      p1: { s: "done", g: "pass", units: { u1: { s: "done", v: "pass", w: null, rej: [] } } },
      p2: { s: "pending", g: "pending", units: {} },
    })
    const h = hygieneAfterLedgerWrite("update_phase_gate", { g: "pass" }, two)
    expect(h.action).toBe("compact")
    const text = applySessionHygiene("status: ok", h.action, "claude-code", h.reason)
    expect(text).toContain("Only if it is above 80%")
    expect(text).toContain("do not mention it and keep working")
    expect(text).toContain("session_hygiene_command: /compact (only above 80% context usage)")
  })

  it("does not yield on a fail verdict", () => {
    expect(hygieneAfterLedgerWrite("set_verdict", { v: "fail" }, ledger(twoUnits)).action).toBe("none")
  })

  it("clears when the last gate passes", () => {
    const done = ledger({
      p1: { s: "done", g: "pass", units: { u1: { s: "done", v: "pass", w: null, rej: [] } } },
    })
    expect(hygieneAfterLedgerWrite("update_phase_gate", { g: "pass" }, done).action).toBe("clear")
    expect(hygieneForOrient("complete").action).toBe("clear")
  })

  it("does not yield compact on resume", () => {
    expect(hygieneForOrient("in_progress").action).toBe("none")
    expect(hygieneForOrient("no_phases_yet").action).toBe("none")
  })
})

describe("applySessionHygiene", () => {
  it("appends a suggestion, never an instruction to stop", () => {
    const text = applySessionHygiene("status: ok", "compact", "cursor", "Phase gate passed; 1 phase(s) remain.")
    expect(text).toContain("session_hygiene: compact")
    expect(text).toContain("session_hygiene_command: /compact (only above 80% context usage)")
    expect(text).toContain("SESSION HYGIENE: Phase gate passed")
    expect(text).toContain("Only if it is above 80%")
    expect(text).not.toMatch(/YIELD|Stop generating/)
  })

  it("adds nothing when action is none", () => {
    expect(applySessionHygiene("status: ok", "none", "cursor", "")).toBe("status: ok")
  })
})

describe("skillActivationHeader", () => {
  it("tells Cursor to /clear when switching jobs", () => {
    const header = skillActivationHeader({
      skill: "foreman:design-partner",
      source: "bundled",
      host: "cursor",
    })
    expect(header).toContain("session_hygiene_if_new_task: /clear")
  })
})
