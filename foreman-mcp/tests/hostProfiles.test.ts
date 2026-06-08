import { describe, it, expect, vi } from "vitest"
import {
  resolveHost,
  parseHostFlag,
  getProfile,
  KNOWN_HOSTS,
  type HostId,
} from "../src/lib/hostProfiles.js"

describe("hostProfiles — resolveHost precedence", () => {
  it("returns claude-code when neither flag nor env is set", () => {
    expect(resolveHost({ flag: null, env: null })).toBe("claude-code")
    expect(resolveHost({})).toBe("claude-code")
    expect(resolveHost({ flag: "", env: "" })).toBe("claude-code")
  })

  it("flag wins over env", () => {
    expect(resolveHost({ flag: "cursor", env: "claude-code" })).toBe("cursor")
    expect(resolveHost({ flag: "claude-code", env: "cursor" })).toBe("claude-code")
  })

  it("env is used when flag is absent", () => {
    expect(resolveHost({ flag: null, env: "cursor" })).toBe("cursor")
    expect(resolveHost({ flag: "", env: "cursor" })).toBe("cursor")
  })

  it("trims whitespace from flag and env", () => {
    expect(resolveHost({ flag: "  cursor  ", env: null })).toBe("cursor")
    expect(resolveHost({ flag: null, env: "\tcursor\n" })).toBe("cursor")
  })

  it("accepts all known host ids", () => {
    for (const id of KNOWN_HOSTS) {
      expect(resolveHost({ flag: id })).toBe(id)
    }
  })

  it("falls back to claude-code on unknown value with stderr warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(resolveHost({ flag: "bogus" })).toBe("claude-code")
      expect(spy).toHaveBeenCalledOnce()
      const msg = spy.mock.calls[0][0] as string
      expect(msg).toContain("bogus")
      expect(msg).toContain("claude-code")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("hostProfiles — parseHostFlag", () => {
  it("returns null when no flag present", () => {
    expect(parseHostFlag([])).toBeNull()
    expect(parseHostFlag(["--diag", "--version"])).toBeNull()
  })

  it("parses --host=value form", () => {
    expect(parseHostFlag(["--host=cursor"])).toBe("cursor")
    expect(parseHostFlag(["--diag", "--host=claude-code", "--version"])).toBe("claude-code")
  })

  it("parses --host value form (separated)", () => {
    expect(parseHostFlag(["--host", "cursor"])).toBe("cursor")
    expect(parseHostFlag(["--diag", "--host", "codex"])).toBe("codex")
  })

  it("returns null when --host is the last arg with no value", () => {
    expect(parseHostFlag(["--host"])).toBeNull()
  })
})

describe("hostProfiles — getProfile", () => {
  it("returns claude-code profile by default with expected placeholders", () => {
    const profile = getProfile("claude-code")
    expect(profile.id).toBe("claude-code")
    expect(profile.displayName).toBe("Claude Code")
    expect(profile.placeholders.worker_invoke).toContain("Agent tool")
    expect(profile.placeholders.worker_invoke).toContain('model: "sonnet"')
    expect(profile.placeholders.advisor_a).toContain("mcp__foreman__invoke_advisor")
    expect(profile.placeholders.advisor_a).toContain('cli: "codex"')
    expect(profile.placeholders.advisor_b).toContain('cli: "gemini"')
  })

  it("returns cursor profile with Task subagent placeholders", () => {
    const profile = getProfile("cursor")
    expect(profile.id).toBe("cursor")
    expect(profile.displayName).toBe("Cursor")
    expect(profile.placeholders.worker_invoke).toContain("Task")
    expect(profile.placeholders.worker_invoke).toContain("claude-4.6-sonnet-medium-thinking")
    expect(profile.placeholders.advisor_a).toContain("gpt-5.5-high")
    expect(profile.placeholders.advisor_b).toContain("gemini-3.1-pro")
    expect(profile.placeholders.advisor_b).toContain("composer-2-fast")
  })

  it("codex profile aliases claude-code placeholders", () => {
    const codex = getProfile("codex")
    const cc = getProfile("claude-code")
    expect(codex.id).toBe("codex")
    expect(codex.placeholders).toEqual(cc.placeholders)
  })

  it("every profile defines all canonical placeholder keys", () => {
    const required = ["host_name", "worker_invoke", "advisor_a", "advisor_b", "advisor_fallback"]
    for (const id of KNOWN_HOSTS) {
      const profile = getProfile(id as HostId)
      for (const key of required) {
        expect(profile.placeholders[key], `${id}.${key}`).toBeDefined()
        expect(profile.placeholders[key].length, `${id}.${key} non-empty`).toBeGreaterThan(0)
      }
    }
  })
})
