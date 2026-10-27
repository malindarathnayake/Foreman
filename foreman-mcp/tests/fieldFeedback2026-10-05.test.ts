// Field report 2026-10-05 (resume session on 0.7.0): the 0.7.1 small slice.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkCitations, consistencyFlags, preflightPathFor } from "../src/lib/preflight.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { ALLOWLIST_HINT, runTests } from "../src/tools/runTests.js"
import { claudeAgentsInit } from "../src/tools/claudeAgentsInit.js"
import { getProfile } from "../src/lib/hostProfiles.js"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-ff1005-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  delete process.env.FOREMAN_TEST_ALLOWLIST
})

describe("run_tests refusal names the setting and the list in force", () => {
  it("lists FOREMAN_TEST_ALLOWLIST additions and says how to add a runner", async () => {
    process.env.FOREMAN_TEST_ALLOWLIST = "uv"
    const text = await runTests("python", ["scripts/check.py"])
    expect(text).toContain("error: runner not in allowlist")
    expect(text).toMatch(/allowed_runners: .*golangci-lint, uv/)
    expect(text).toContain(ALLOWLIST_HINT)
  })
})

describe("preflight flags a checkpoint run_tests would refuse", () => {
  const spec = (test: string) => `# Spec\n\n#### u1.1 — evidence\n- Files: scripts/check.py\n- Run the checker.\nTest: ${test}\n`
  async function run(test: string) {
    const docs = path.join(dir, "Docs")
    await fs.mkdir(docs, { recursive: true })
    const specPath = path.join(docs, "spec.md")
    await fs.writeFile(specPath, spec(test))
    const ledgerPath = path.join(docs, ".foreman-ledger.json")
    return preflightCheck({ phase: "p1", unit_id: "u1.1", brief: "Run the checker in scripts/check.py.", symbols: ["checker"], repo_root: dir, spec_path: "Docs/spec.md" } as never,
      preflightPathFor(ledgerPath), ledgerPath, specPath)
  }
  it("names python as an advisory with the hint, and stays silent for an allowed runner", async () => {
    const text = await run("python scripts/check.py && pytest tests/")
    expect(text).toContain("checkpoint_runners_refused: python")
    expect(text).toContain("CHECKPOINT RUNNERS run_tests WOULD REFUSE")
    expect(text).toContain("FOREMAN_TEST_ALLOWLIST")
    const ok = await run("pytest tests/")
    expect(ok).not.toContain("checkpoint_runners_refused")
  })
})

describe("preflight treats Foreman's own state files as known", () => {
  it("does not call the heartbeat file a dead citation before it exists", async () => {
    const [r] = await checkCitations(dir, "Append a line to Docs/.foreman-heartbeat.jsonl after each step.", [], [])
    expect(r.status).toBe("ok")
    expect(r.detail).toContain("Foreman state file")
    const [other] = await checkCitations(dir, "Read Docs/missing-notes.md first.", [], [])
    expect(other.status).toBe("dead")
  })
})

describe("draft markers inside quotes are mentions", () => {
  it("skips `TBD` and \"TODO\" but still flags a bare TODO", () => {
    const quoted = consistencyFlags('Banned words in output: `TBD`, "TODO" and “FIXME”.')
    expect(quoted.filter((f) => f.kind === "draft_marker")).toEqual([])
    const bare = consistencyFlags("Return the rows. TODO decide the sort order.")
    expect(bare.filter((f) => f.kind === "draft_marker")).toHaveLength(1)
  })
})

describe("agent definitions written this session", () => {
  it("the init hint no longer promises they load without a restart", async () => {
    const text = await claudeAgentsInit({ project_dir: dir } as never)
    expect(text).not.toContain("restart is not required")
    expect(text).toContain("may not load until the next host session")
  })
  it("the Claude Code spawn rule falls back on 'Agent type not found'", () => {
    const text = JSON.stringify(getProfile("claude-code"))
    expect(text).toContain("Agent type ... not found")
    expect(text).toContain("fallback: agent type not loaded")
  })
})
