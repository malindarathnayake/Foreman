import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
  resolveFirst: vi.fn(),
  runWithStdin: vi.fn(),
  runExternalCli: vi.fn(),
}))

import { resolveInvocation, runWithStdin, runExternalCli } from "../src/lib/externalCli.js"
import { invokeAdvisor, CURSOR_ADVISOR_ARGS, cursorPromptArg } from "../src/tools/invokeAdvisor.js"

const SUCCESS = {
  stdout: "review",
  stderr: "",
  timedOut: false,
  exitCode: 0,
  truncated: false,
}

describe("invokeAdvisor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveInvocation).mockResolvedValue({
      ok: true,
      plan: { command: "codex", args: ["shim-arg"] },
    })
    vi.mocked(runWithStdin).mockResolvedValue(SUCCESS)
  })

  it("runs Codex reviews with gpt-6-astra at xhigh reasoning effort", async () => {
    await invokeAdvisor("codex", "review this", 12_345)

    expect(runWithStdin).toHaveBeenCalledWith(
      "codex",
      [
        "shim-arg",
        "exec",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-m",
        "gpt-6-astra",
        "-c",
        "model_reasoning_effort=xhigh",
        "-c",
        "hide_agent_reasoning=true",
        "-",
      ],
      "review this",
      12_345,
    )
  })

  it("runs Claude headless with Fable 5 at max effort and no tools", async () => {
    vi.mocked(resolveInvocation).mockResolvedValue({
      ok: true,
      plan: { command: "claude", args: ["shim-arg"] },
    })

    await invokeAdvisor("claude", "review this adversarially", 300_000)

    expect(resolveInvocation).toHaveBeenCalledWith("claude")
    expect(runWithStdin).toHaveBeenCalledWith(
      "claude",
      [
        "shim-arg",
        "-p",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--model",
        "claude-fable-5",
        "--effort",
        "max",
        "--tools=",
        "--max-budget-usd",
        "1",
        "--output-format",
        "text",
      ],
      "review this adversarially",
      300_000,
    )
  })

  it("runs Cursor Agent CLI print mode ask/trust with a tempfile prompt and never --approve-mcps", async () => {
    vi.mocked(resolveInvocation).mockResolvedValue({
      ok: true,
      plan: { command: "agent", args: [] },
    })
    const { resolveFirst } = await import("../src/lib/externalCli.js")
    vi.mocked(resolveFirst).mockResolvedValue({ ok: true, plan: { command: "agent", args: [] } })
    vi.mocked(runExternalCli).mockResolvedValue(SUCCESS)

    await invokeAdvisor("cursor", "review this adversarially", 60_000)

    expect(resolveFirst).toHaveBeenCalled()
    expect(runWithStdin).not.toHaveBeenCalled()
    expect(runExternalCli).toHaveBeenCalledTimes(1)
    const [, args] = vi.mocked(runExternalCli).mock.calls[0]
    expect(args.slice(0, CURSOR_ADVISOR_ARGS.length)).toEqual([...CURSOR_ADVISOR_ARGS])
    expect(args.join(" ")).not.toContain("approve-mcps")
    expect(args.join(" ")).not.toContain("--model")
    const promptArg = args[args.length - 1] as string
    expect(promptArg).toContain("File:")
    expect(promptArg).toContain("prompt.txt")
    expect(promptArg).toBe(cursorPromptArg(promptArg.slice(promptArg.indexOf("File: ") + "File: ".length)))
  })
})
