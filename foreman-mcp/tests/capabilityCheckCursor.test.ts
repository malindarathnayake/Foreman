import { describe, it, expect } from "vitest"
import { capabilityCheck } from "../src/tools/capabilityCheck.js"

describe("capabilityCheck — cursor host", () => {
  it("returns synthetic available for codex without shelling out", async () => {
    const out = await capabilityCheck("codex", "cursor")
    expect(out).toContain("cli: codex")
    expect(out).toContain("available: true")
    expect(out).toContain("mechanism: cursor_subagent")
    expect(out).toContain("model: gpt-5.5-medium")
    expect(out).toContain("auth_status: ok")
  })

  it("returns synthetic available for gemini and exposes gemini-3.1-pro model hint", async () => {
    const out = await capabilityCheck("gemini", "cursor")
    expect(out).toContain("cli: gemini")
    expect(out).toContain("available: true")
    expect(out).toContain("mechanism: cursor_subagent")
    expect(out).toContain("model: gemini-3.1-pro")
  })

  it("does not include cursor-only fields when host is claude-code (default)", async () => {
    // The actual CLI may or may not be installed in CI; we only assert that
    // the cursor-specific synthetic fields are NOT present in claude-code mode.
    // The real shelling result is whatever it is.
    const out = await capabilityCheck("codex")
    expect(out).not.toContain("cursor_subagent")
    expect(out).toContain("cli: codex")
  })
})
