// CI contract guard (Unit 3c) — spawns the REAL Python harness (scripts/aider_harness.py,
// Unit 3b) and locks its process contract: exit codes, stdout/stderr shape on each path,
// and the [CWE-532] secret-non-leak guarantee. Deterministic on any host:
//   * If no python interpreter resolves at all, the whole suite skips (describe.skipIf).
//   * The probe assertion is tied to this host's actual `import aider` ground truth, so
//     it passes whether or not aider-chat happens to be installed.
// This does NOT touch scripts/aider_harness.py, any .ts source, or any other test, and
// installs nothing — it only observes the harness's existing behavior.

import { describe, it, expect, afterEach } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePython } from "../src/lib/externalCli.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const HARNESS_PATH = path.resolve(__dirname, "..", "scripts", "aider_harness.py")

// ── Obviously-fake, low-entropy fixture key (gitleaks-safe, matches the pattern already
// used by tests/aiderWorker.test.ts's `sk-fixture-...` fixtures). ──
const FAKE_KEY = "sk-harness-contract-DO-NOT-LEAK-9f3a"

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Spawn `cmd args` with `stdin` written then closed; collect exit code + both streams.
 *  A 20s safety-net timeout kills the child and rejects — the probe/error paths this
 *  file exercises all return fast, so this only guards against a genuinely hung child. */
function runHarness(cmd: string, args: string[], stdin: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new Error(`runHarness timed out after 20s (cmd=${cmd} args=${JSON.stringify(args)})`))
    }, 20000)

    child.stdin.on("error", () => {
      // Swallow — child may exit before reading all stdin (e.g. bad-JSON fast-fail).
    })
    child.stdin.write(stdin, "utf-8")
    child.stdin.end()

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

// ── Resolve python + aider ground truth ONCE, before any test runs. ──
const py = await resolvePython(undefined)
const pythonOk = py.ok
const aiderPresent = pythonOk
  ? (await runHarness(py.plan.command, [...py.plan.args, "-c", "import aider"], "")).code === 0
  : false

describe.skipIf(!pythonOk)("aider_harness.py contract", () => {
  const dirsToClean: string[] = []

  afterEach(async () => {
    for (const d of dirsToClean.splice(0)) {
      await fs.rm(d, { recursive: true, force: true })
    }
  })

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiderharness-"))
    dirsToClean.push(dir)
    return dir
  }

  it("--probe exit code matches aider-import ground truth", async () => {
    if (!pythonOk) return
    const result = await runHarness(py.plan.command, [...py.plan.args, HARNESS_PATH, "--probe"], "")

    expect(result.code).toBe(aiderPresent ? 0 : 20)

    if (!aiderPresent) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error_kind: "binary_not_found",
        missing: "aider",
        probe: true,
      })
    } else {
      const parsed = JSON.parse(result.stdout)
      expect(parsed.ok).toBe(true)
      expect(parsed.probe).toBe(true)
    }
  })

  it("bad stdin JSON -> exit 2, empty stdout", async () => {
    if (!pythonOk) return
    const result = await runHarness(py.plan.command, [...py.plan.args, HARNESS_PATH], "this is not json")

    expect(result.code).toBe(2)
    expect(result.stdout.trim()).toBe("")
    expect(result.stderr.trim().length).toBeGreaterThan(0)
  })

  it("secret discipline: api_key never appears on stdout/stderr on any error path", async () => {
    if (!pythonOk) return
    const cwd = await makeTempDir()
    const request = {
      model: "openai/does-not-exist",
      edit_format: "whole",
      api_base: "http://127.0.0.1:1/v1", // bogus/unreachable — never actually connects
      api_key: FAKE_KEY,
      num_ctx: 1024,
      reasoning_tag: "",
      max_reflections: 1,
      system_prompt_prefix: "p",
      fnames: [],
      read_only_fnames: [],
      message: "noop",
      cwd,
    }

    const result = await runHarness(py.plan.command, [...py.plan.args, HARNESS_PATH], JSON.stringify(request))

    // [CWE-532] Regardless of aider presence or exit code, the raw key value must never
    // be written to either stream. Deliberately not asserting a specific exit code here —
    // that varies by host (aider absent -> exit 1 clean; aider present -> fails to reach
    // the bogus endpoint, scrubbed).
    expect(result.stdout).not.toContain(FAKE_KEY)
    expect(result.stderr).not.toContain(FAKE_KEY)
  })

  it.skipIf(aiderPresent)("main mode with aider absent -> exit 1, empty stdout", async () => {
    const cwd = await makeTempDir()
    const request = {
      model: "openai/does-not-exist",
      edit_format: "whole",
      api_base: "http://127.0.0.1:1/v1",
      api_key: FAKE_KEY,
      num_ctx: 1024,
      reasoning_tag: "",
      max_reflections: 1,
      system_prompt_prefix: "p",
      fnames: [],
      read_only_fnames: [],
      message: "noop",
      cwd,
    }

    const result = await runHarness(py.plan.command, [...py.plan.args, HARNESS_PATH], JSON.stringify(request))

    expect(result.code).toBe(1)
    expect(result.stdout.trim()).toBe("")
    expect(result.stderr.trim().length).toBeGreaterThan(0)
  })
})
