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
    expect(profile.placeholders.advisor_a).toContain("gpt-5.6-sol-ultra")
    expect(profile.placeholders.advisor_b).toContain("gemini-3.1-pro")
    expect(profile.placeholders.advisor_b).toContain("composer-2-fast")
  })

  it("codex profile uses native subagents and Claude/Gemini advisors", () => {
    const codex = getProfile("codex")
    expect(codex.id).toBe("codex")
    expect(codex.displayName).toBe("Codex")
    expect(codex.placeholders.worker_invoke).toContain("spawn_agent")
    // v0.6.15: the seat is picked per unit and its model is pinned in
    // .codex/agents/<role>.toml, so the text names seats rather than a model.
    expect(codex.placeholders.worker_invoke).toContain("worker_light")
    expect(codex.placeholders.worker_invoke).toContain("worker_heavy")
    expect(codex.placeholders.worker_invoke).toContain("record the model Codex reports")
    expect(codex.placeholders.worker_invoke).not.toContain("Agent tool")
    expect(codex.placeholders.advisor_checks).toContain('cli: "claude"')
    expect(codex.placeholders.advisor_a).toContain('cli: "claude"')
    expect(codex.placeholders.advisor_a).toContain('model: "claude-fable-5"')
    expect(codex.placeholders.advisor_a).toContain("max")
    expect(codex.placeholders.advisor_b).toContain('cli: "gemini"')
    // Native review is now the default, while external advisors remain optional.
    expect(codex.placeholders.advisor_fallback).toContain("Native review")
    expect(codex.placeholders.advisor_fallback).toContain("PERSPECTIVE, not independence")
    expect(codex.placeholders.autonomy).toContain("host-controlled")
  })

  it("every profile defines all canonical placeholder keys", () => {
    const required = [
      "host_name",
      "worker_invoke",
      "worker_fanout",
      "advisor_checks",
      "advisor_a",
      "advisor_b",
      "advisor_fallback",
      "autonomy",
    ]
    for (const id of KNOWN_HOSTS) {
      const profile = getProfile(id as HostId)
      for (const key of required) {
        expect(profile.placeholders[key], `${id}.${key}`).toBeDefined()
        expect(profile.placeholders[key].length, `${id}.${key} non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it("codex worker_fanout serializes shared-tree editors and allows parallel explorers", () => {
    const fanout = getProfile("codex").placeholders.worker_fanout
    expect(fanout).toContain("spawn_agent")
    expect(fanout).toContain("explorer")
    expect(fanout).toContain("MUST run sequentially")
    expect(fanout).toContain("max_threads")
    expect(fanout).toContain("isolated worktree/sandbox")
    expect(fanout).toContain("max_depth=1")
    expect(fanout).toContain("codex_agents_init")
    expect(fanout).toContain("write_ledger")
  })

  it("every host worker prompt forbids repository-state mutation", () => {
    for (const id of KNOWN_HOSTS) {
      const invoke = getProfile(id as HostId).placeholders.worker_invoke
      expect(invoke, `${id}.worker_invoke`).toContain("Repository state is user-owned")
      expect(invoke, `${id}.worker_invoke`).toContain("git stash")
      expect(invoke, `${id}.worker_invoke`).toContain("must never")
    }
  })

  it("hostRuntimePreamble includes worker_fanout for every host", async () => {
    const { hostRuntimePreamble } = await import("../src/lib/hostProfiles.js")
    for (const id of KNOWN_HOSTS) {
      const preamble = hostRuntimePreamble(id as HostId)
      expect(preamble, `${id} preamble`).toContain("Worker fan-out:")
      expect(preamble, `${id} preamble non-empty fanout`).not.toContain("Worker fan-out: undefined")
    }
  })

  it("resolves generic host via flag and env", () => {
    expect(resolveHost({ flag: "generic" })).toBe("generic")
    expect(resolveHost({ env: "generic" })).toBe("generic")
  })

  it("returns generic profile speaking cost tiers, not model names", () => {
    const profile = getProfile("generic")
    expect(profile.id).toBe("generic")
    expect(profile.placeholders.worker_invoke).toContain("tier `{tier}`")
    expect(profile.placeholders.worker_invoke).toContain("HOST-CONTRACT.md")
    expect(profile.placeholders.worker_invoke).toContain("invoke_worker")
    expect(profile.placeholders.worker_invoke).not.toContain('model: "')
    expect(profile.placeholders.advisor_a).not.toContain('model: "')
    expect(profile.placeholders.advisor_b).not.toContain('model: "')
  })

  it("every host defines a non-empty autonomy placeholder", () => {
    for (const id of KNOWN_HOSTS) {
      const autonomy = getProfile(id as HostId).placeholders.autonomy
      expect(autonomy, `${id}.autonomy`).toBeTypeOf("string")
      expect(autonomy.length, `${id}.autonomy non-empty`).toBeGreaterThan(0)
    }
    expect(getProfile("generic").placeholders.autonomy).toContain("fails closed")
    expect(getProfile("generic").placeholders.autonomy).toContain("session_orient")
    expect(getProfile("claude-code").placeholders.autonomy).toContain("phase gate")
  })

  it("falls back to claude-code on unknown value and mentions generic in accepted list", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(resolveHost({ flag: "bogus2" })).toBe("claude-code")
      expect(spy).toHaveBeenCalledOnce()
      const msg = spy.mock.calls[0][0] as string
      expect(msg).toContain("generic")
    } finally {
      spy.mockRestore()
    }
  })
})
