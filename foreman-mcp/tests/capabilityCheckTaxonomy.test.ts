import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
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

const VERSION_STDOUT: Record<"codex" | "gemini", string> = {
  codex: "codex-cli 0.142.4",
  gemini: "gemini 0.47.0",
}

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

function mockRun(cli: "codex" | "gemini", healthResultValue: ReturnType<typeof healthResult>) {
  return vi.fn(async (_cmd: string, args: string[]) =>
    args.includes("--version")
      ? { exitCode: 0, stdout: VERSION_STDOUT[cli], stderr: "", timedOut: false, truncated: false }
      : healthResultValue
  )
}

describe("capabilityCheck — auth_status taxonomy (D11)", () => {
  it("1. resolution failure -> not_found, available: false, with hint", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: false, reason: "codex not found" })
    ext.runExternalCli.mockImplementation(mockRun("codex", healthResult({})))

    const result = await mod.capabilityCheck("codex")
    expect(result).toContain("auth_status: not_found")
    expect(result).toContain("available: false")
    expect(result).toMatch(/^hint: .+$/m)
  })

  it("2. exit 0 health -> ok, no hint line, available: true", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("codex", healthResult({ exitCode: 0 })))

    const result = await mod.capabilityCheck("codex")
    expect(result).toContain("auth_status: ok")
    expect(result).toContain("available: true")
    expect(result).not.toMatch(/^hint: /m)
  })

  it("3. timedOut: true -> probe_timeout + hint", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("codex", healthResult({ exitCode: -1, timedOut: true })))

    const result = await mod.capabilityCheck("codex")
    expect(result).toContain("auth_status: probe_timeout")
    expect(result).toMatch(/^hint: .+$/m)
  })

  it("4. spawn failure (exitCode: -1, timedOut: false) -> not_found", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("codex", healthResult({ exitCode: -1, timedOut: false })))

    const result = await mod.capabilityCheck("codex")
    expect(result).toContain("auth_status: not_found")
  })

  it("5. gemini health exit 55 -> not_trusted + hint containing 'trust'", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("gemini", healthResult({ exitCode: 55 })))

    const result = await mod.capabilityCheck("gemini")
    expect(result).toContain("auth_status: not_trusted")
    expect(result).toMatch(/^hint: .*trust.*$/m)
  })

  it("6. gemini health exit 52 -> error", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("gemini", healthResult({ exitCode: 52 })))

    const result = await mod.capabilityCheck("gemini")
    expect(result).toContain("auth_status: error")
  })

  it("7. gemini health exit 7 (unseeded) -> error (fallback)", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("gemini", healthResult({ exitCode: 7 })))

    const result = await mod.capabilityCheck("gemini")
    expect(result).toContain("auth_status: error")
  })

  it("8. codex health exit 1 -> auth_expired + hint containing 'codex login'", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("codex", healthResult({ exitCode: 1 })))

    const result = await mod.capabilityCheck("codex")
    expect(result).toContain("auth_status: auth_expired")
    expect(result).toMatch(/^hint: .*codex login.*$/m)
  })

  it("9. key order: cli, available, version, auth_status, hint", async () => {
    const { ext, mod } = await load()
    ext.resolveInvocation.mockResolvedValue({ ok: true, plan: { command: "x", args: [] } })
    ext.runExternalCli.mockImplementation(mockRun("gemini", healthResult({ exitCode: 55 })))

    const result = await mod.capabilityCheck("gemini")
    const lines = result.split("\n")
    expect(lines[0]).toMatch(/^cli:/)
    expect(lines[1]).toMatch(/^available:/)
    expect(lines[2]).toMatch(/^version:/)
    expect(lines[3]).toMatch(/^auth_status:/)
    expect(lines[4]).toMatch(/^hint:/)
  })

  it("10. sentinel table seed rows", async () => {
    const { mod } = await load()
    const table = mod.SENTINEL_TABLE
    expect(table).toHaveLength(3)
    const pins = table.map((r: any) => r.cli_version_pin)
    expect(pins.filter((p: string) => p === "0.47.0")).toHaveLength(2)
    expect(pins.filter((p: string) => p === "0.142.4")).toHaveLength(1)
    for (const row of table) {
      expect(row.provenance).toBeTruthy()
      expect(typeof row.provenance).toBe("string")
      expect(row.provenance.length).toBeGreaterThan(0)
    }
  })
})
