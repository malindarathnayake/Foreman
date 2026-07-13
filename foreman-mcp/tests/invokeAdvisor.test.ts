import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/externalCli.js", () => ({
  resolveInvocation: vi.fn(),
  runWithStdin: vi.fn(),
}))

import { resolveInvocation, runWithStdin } from "../src/lib/externalCli.js"
import { invokeAdvisor } from "../src/tools/invokeAdvisor.js"

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

  it("runs Codex reviews with GPT-5.6-SOL at xhigh reasoning effort", async () => {
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
        "gpt-5.6-sol",
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
})
