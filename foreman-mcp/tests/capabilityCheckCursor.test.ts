import { describe, it, expect, vi, beforeEach } from "vitest"
import { parseCursorAuthStatus } from "../src/tools/capabilityCheck.js"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
  resolveFirst: vi.fn(),
  runExternalCli: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

async function load() {
  const ext = await import("../src/lib/externalCli.js")
  const mod = await import("../src/tools/capabilityCheck.js")
  return { ext: ext as any, mod }
}

const AUTH_OK = JSON.stringify({
  status: "authenticated",
  isAuthenticated: true,
  hasAccessToken: true,
  hasRefreshToken: true,
  userInfo: { email: "secret@example.com" },
})

const AUTH_NO = JSON.stringify({ status: "unauthenticated", isAuthenticated: false })

function healthResult(overrides: Partial<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>) {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    ...overrides,
  }
}

describe("parseCursorAuthStatus", () => {
  it("reads isAuthenticated and drops userInfo", () => {
    expect(parseCursorAuthStatus(AUTH_OK)).toEqual({ isAuthenticated: true })
    expect(parseCursorAuthStatus(AUTH_NO)).toEqual({ isAuthenticated: false })
    expect(parseCursorAuthStatus("not json")).toEqual({})
    expect(parseCursorAuthStatus("{}")).toEqual({})
  })
})

describe("capabilityCheck — cursor host is a live probe, not a synthetic Task seat", () => {
  it("cli cursor with authenticated status -> ok + mechanism cursor_agent_cli, no email", async () => {
    const { ext, mod } = await load()
    ext.resolveFirst.mockResolvedValue({ ok: true, plan: { command: "agent", args: [] } })
    ext.runExternalCli.mockImplementation(async (_cmd: string, args: string[]) =>
      args.includes("--version")
        ? healthResult({ stdout: "2026.09.15-d2fe57e\n" })
        : healthResult({ stdout: AUTH_OK })
    )

    const out = await mod.capabilityCheck("cursor", "cursor")
    expect(out).toContain("cli: cursor")
    expect(out).toContain("available: true")
    expect(out).toContain("auth_status: ok")
    expect(out).toContain("mechanism: cursor_agent_cli")
    expect(out).toContain("version: 2026.09.15-d2fe57e")
    expect(out).not.toContain("secret@example.com")
    expect(out).not.toContain("cursor_subagent")
  })

  it("cli cursor with isAuthenticated false -> auth_expired + agent login hint", async () => {
    const { ext, mod } = await load()
    ext.resolveFirst.mockResolvedValue({ ok: true, plan: { command: "agent", args: [] } })
    ext.runExternalCli.mockImplementation(async (_cmd: string, args: string[]) =>
      args.includes("--version")
        ? healthResult({ stdout: "2026.09.15-d2fe57e\n" })
        : healthResult({ stdout: AUTH_NO })
    )

    const out = await mod.capabilityCheck("cursor", "cursor")
    expect(out).toContain("auth_status: auth_expired")
    expect(out).toMatch(/^hint: .*agent login.*$/m)
    expect(out).toContain("mechanism: cursor_agent_cli")
  })

  it("cli cursor missing binary -> not_found with Agent CLI hint", async () => {
    const { ext, mod } = await load()
    ext.resolveFirst.mockResolvedValue({ ok: false, reason: "agent/cursor-agent not found" })

    const out = await mod.capabilityCheck("cursor")
    expect(out).toContain("auth_status: not_found")
    expect(out).toContain("available: false")
    expect(out).toMatch(/agent \/ cursor-agent/)
  })

  it("cli cursor exit 0 with unparseable status -> error, not ok", async () => {
    const { ext, mod } = await load()
    ext.resolveFirst.mockResolvedValue({ ok: true, plan: { command: "agent", args: [] } })
    ext.runExternalCli.mockImplementation(async (_cmd: string, args: string[]) =>
      args.includes("--version")
        ? healthResult({ stdout: "2026.09.15-d2fe57e\n" })
        : healthResult({ stdout: "logged in, probably" })
    )

    const out = await mod.capabilityCheck("cursor")
    expect(out).toContain("auth_status: error")
    expect(out).not.toContain("auth_status: ok")
  })

  it("codex on cursor host probes the real CLI — no synthetic cursor_subagent", async () => {
    const { ext, mod } = await load()
    ext.resolveFirst.mockResolvedValue({ ok: false, reason: "codex not found" })

    const out = await mod.capabilityCheck("codex", "cursor")
    expect(out).toContain("cli: codex")
    expect(out).toContain("available: false")
    expect(out).toContain("auth_status: not_found")
    expect(out).not.toContain("cursor_subagent")
    expect(out).not.toContain("gpt-5.6-sol-ultra")
  })
})
