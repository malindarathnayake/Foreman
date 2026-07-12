import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import { existsSync } from "node:fs"
import os from "os"
import path from "path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { handleAiderWorker } from "../src/tools/aiderWorker.js"
import { writeLedger } from "../src/lib/ledger.js"
import { readEvents } from "../src/lib/eventsSidecar.js"
import { PATCH_BEGIN, PATCH_END } from "../src/lib/workerResponse.js"
import { resetForTest } from "../src/lib/redaction.js"
import { initSession } from "../src/lib/journal.js"
import type { JournalFile } from "../src/types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_HARNESS_PATH = path.join(__dirname, "fixtures", "aiderHarnessFixture.mjs")

// ── Obviously-fake, low-entropy fixture key (gitleaks-safe). Doubles as the API key. ──
const FIXTURE_KEY_NAME = "AIDER_2C_FIXTURE_KEY"
const FIXTURE_KEY_VALUE = "fixture_key_aider2c_00001"

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Init a bare journal session so `logEvent` (used by bestEffortWaiver) has something
 *  to write into — mirrors the pattern foremanEnv.test.ts uses for bestEffortSecBlock. */
async function initJournalSession(journalPath: string): Promise<void> {
  await initSession(journalPath, {
    operation: "init_session",
    data: {
      target_version: "0.5.5",
      branch: "release/v0.5.5_experimental",
      phase: 1,
      units: ["3a"],
      env: { agent: "opus", worker: "sonnet", codex: null, gemini: null },
    },
  })
}

/** Read back all journal events across all sessions in a journal file. */
async function readJournalEvents(journalPath: string): Promise<JournalFile["sessions"][number]["events"]> {
  const raw = await fs.readFile(journalPath, "utf-8")
  const journal = JSON.parse(raw) as JournalFile
  return journal.sessions.flatMap((s) => s.events)
}

/**
 * Test #15 needs `resolvePython`'s python3/python fallback to ALSO fail (not just the
 * bogus preferred override) so the "python missing" scenario is deterministic on a dev
 * host that has a real python interpreter installed (as this one does). Returns a PATH
 * string with any directory hosting a bare python/python3 interpreter removed, EXCEPT a
 * directory that also hosts git/where/which/node (never break those resolutions).
 */
function pathWithoutPythonInterpreters(): string {
  const sep = process.platform === "win32" ? ";" : ":"
  const pyNames = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python", "python3"]
  const guardNames =
    process.platform === "win32" ? ["git.exe", "where.exe", "node.exe"] : ["git", "which", "node"]
  const dirs = (process.env.PATH ?? "").split(sep)
  return dirs
    .filter((d) => {
      if (!d) return true
      const hasPython = pyNames.some((n) => existsSync(path.join(d, n)))
      if (!hasPython) return true
      // Keep the dir anyway if it also hosts a tool this test still needs.
      return guardNames.some((n) => existsSync(path.join(d, n)))
    })
    .join(sep)
}

// ── Per-test workspace ────────────────────────────────────────────────────────────
let dirsToClean: string[] = []
let originalCwd: string
let envVarsSet: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirsToClean.push(dir)
  return dir
}

function setEnv(name: string, value: string): void {
  process.env[name] = value
  envVarsSet.push(name)
}

interface Workspace {
  repoDir: string
  fileName: string
  ledgerPath: string
  journalPath: string
  sidecarPath: string
  worktreeRoot: string
  deps: { docsDir: string; ledgerPath: string; journalPath: string; envDir: string }
}

function envContent(): string {
  return [
    "schema_version=1",
    "FOREMAN_API_BASE=http://127.0.0.1:1/v1",
    // Double-quoted (not a template literal) so ${ENV:...} stays literal.
    `FOREMAN_API_KEY=\${ENV:${FIXTURE_KEY_NAME}}`,
    "FOREMAN_TIER_STANDARD=test/aider-model",
    "FOREMAN_WORKER_CLASS_STANDARD=capable",
    "FOREMAN_EDIT_FORMAT_STANDARD=unified_diff",
    "FOREMAN_WORKER_KIND_STANDARD=aider-cli",
    "FOREMAN_NUM_CTX_STANDARD=131072",
    "",
  ].join("\n")
}

async function makeWorkspace(opts: { seedDelegation?: boolean } = {}): Promise<Workspace> {
  const { seedDelegation = true } = opts

  // Real git repo (isolated from the real Foreman repo) — the tool operates on process.cwd().
  const repoDir = await makeTempDir("aiderworker-repo-")
  git(repoDir, ["init", "-b", "main"])
  git(repoDir, ["config", "user.email", "t@t"])
  git(repoDir, ["config", "user.name", "t"])
  git(repoDir, ["config", "commit.gpgsign", "false"])
  // Disable EOL translation so committed/checked-out bytes are byte-identical
  // regardless of the host's global core.autocrlf (this host runs Windows).
  git(repoDir, ["config", "core.autocrlf", "false"])

  const fileName = "hello.txt"
  await fs.writeFile(path.join(repoDir, fileName), "line1\nline2\n", "utf-8")
  git(repoDir, ["add", fileName])
  git(repoDir, ["commit", "-m", "init"])

  // .foremanenv lives in a SEPARATE (non-repo) temp dir, sidestepping the git-tracked-
  // secrets refusal entirely — this dir is never a git work tree.
  const envDir = await makeTempDir("aiderworker-env-")
  await fs.writeFile(path.join(envDir, ".foremanenv"), envContent(), "utf-8")

  // Ledger/journal/sidecar all co-locate in their own state dir.
  const stateDir = await makeTempDir("aiderworker-state-")
  const ledgerPath = path.join(stateDir, "ledger.json")
  const journalPath = path.join(stateDir, "journal.json")
  const sidecarPath = path.join(stateDir, ".foreman-events.jsonl")

  const worktreeRoot = await makeTempDir("aiderworker-worktrees-")

  if (seedDelegation) {
    await writeLedger(ledgerPath, {
      operation: "set_unit_status",
      phase: "2c",
      unit_id: "u1",
      data: { s: "delegated", brief: "seed brief for delegated aider unit ok", tier: "standard" },
    })
  }

  return {
    repoDir,
    fileName,
    ledgerPath,
    journalPath,
    sidecarPath,
    worktreeRoot,
    deps: { docsDir: stateDir, ledgerPath, journalPath, envDir },
  }
}

function baseInput(ws: Workspace, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "2c",
    unit_id: "u1",
    brief: "implement the change described in the brief summary for the fixture harness",
    tier: "standard",
    files: [ws.fileName],
    ...overrides,
  }
}

/** chdir into the workspace repo, wire the Node fixture as the harness, then run. */
async function runInWorkspace(ws: Workspace, input: Record<string, unknown>): Promise<string> {
  process.chdir(ws.repoDir)
  process.env.FOREMAN_AIDER_PYTHON = "node"
  process.env.FOREMAN_AIDER_HARNESS = FIXTURE_HARNESS_PATH
  process.env.FOREMAN_AIDER_WORKTREE_ROOT = ws.worktreeRoot
  return handleAiderWorker(input, ws.deps)
}

// ── Setup / teardown ────────────────────────────────────────────────────────────────
beforeEach(() => {
  dirsToClean = []
  envVarsSet = []
  originalCwd = process.cwd()
  process.env[FIXTURE_KEY_NAME] = FIXTURE_KEY_VALUE
  resetForTest() // re-harvest with the fixture key present
})

afterEach(async () => {
  process.chdir(originalCwd)
  for (const d of dirsToClean) {
    await fs.rm(d, { recursive: true, force: true })
  }
  delete process.env[FIXTURE_KEY_NAME]
  delete process.env.FIXTURE_MODE
  delete process.env.FOREMAN_AIDER_PYTHON
  delete process.env.FOREMAN_AIDER_HARNESS
  delete process.env.FOREMAN_AIDER_WORKTREE_ROOT
  for (const name of envVarsSet) delete process.env[name]
  resetForTest()
})

// ── 1. Happy path ─────────────────────────────────────────────────────────────────────
describe("aider_worker — happy path", () => {
  it("returns status ok with a real diff, base_file_hashes, delegation_id, and a full ordered sidecar chain", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "edit"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: ok")
    expect(text).toContain("delegation_id:")
    expect(text).toContain("worker_kind: aider-cli")
    expect(text).toContain("base_file_hashes:")
    expect(text).toContain(ws.fileName)
    expect(text).toContain(PATCH_BEGIN)
    expect(text).toContain(PATCH_END)
    expect(text).toContain("aider fixture edit line")

    const { events, warning } = await readEvents(ws.sidecarPath)
    expect(warning).toBeUndefined()
    expect(events.map((e) => e.event_type)).toEqual([
      "delegation_started",
      "worktree_created",
      "worker_completed",
      "patch_checked",
      "worktree_torn_down",
    ])
    for (const e of events) expect(e.worker_kind).toBe("aider-cli")
    const delegationId = events[0].delegation_id
    for (const e of events) expect(e.delegation_id).toBe(delegationId)
    expect(events[events.length - 1].torn_down_ok).toBe(true)

    // The worktree dir under the root was torn down — nothing left behind.
    const remaining = await fs.readdir(ws.worktreeRoot)
    expect(remaining.length).toBe(0)
  }, 15000)
})

// ── 2. worker_completed diagnostics ───────────────────────────────────────────────────
describe("aider_worker — worker_completed diagnostics", () => {
  it("carries aider_edited_files_count, num_reflections, total_cost, tokens_sent/received from the fixture", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "edit"

    const text = await runInWorkspace(ws, baseInput(ws))
    expect(text).toContain("status: ok")

    const { events } = await readEvents(ws.sidecarPath)
    const wc = events.find((e) => e.event_type === "worker_completed")
    expect(wc).toBeDefined()
    expect(wc!.aider_edited_files_count).toBe(1)
    expect(wc!.num_reflections).toBe(1)
    expect(wc!.total_cost).toBe(0.01)
    expect(wc!.tokens_sent).toBe(100)
    expect(wc!.tokens_received).toBe(20)
  })
})

// ── 3. Empty diff -> WORKER_GHOST ─────────────────────────────────────────────────────
describe("aider_worker — empty diff (no edits)", () => {
  it("FIXTURE_MODE=noedit -> status fail, failure_stage WORKER_GHOST", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "noedit"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_GHOST")

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual([
      "delegation_started",
      "worktree_created",
      "worker_completed",
      "patch_checked",
      "worktree_torn_down",
    ])
    const patchChecked = events.find((e) => e.event_type === "patch_checked")
    expect(patchChecked?.failure_stage).toBe("WORKER_GHOST")
    expect(patchChecked?.outcome).toBe("fail")
  })
})

// ── 4. Redaction marker rejection ─────────────────────────────────────────────────────
describe("aider_worker — redaction marker in the returned diff", () => {
  it("FIXTURE_MODE=redaction -> status fail, failure_stage PATCH_REDACTION_MARKER_FAIL", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "redaction"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: PATCH_REDACTION_MARKER_FAIL")

    const { events } = await readEvents(ws.sidecarPath)
    const patchChecked = events.find((e) => e.event_type === "patch_checked")
    expect(patchChecked?.failure_stage).toBe("PATCH_REDACTION_MARKER_FAIL")
  })
})

// ── 5. Dirty-tree pre-flight refusal ──────────────────────────────────────────────────
describe("aider_worker — dirty tree refusal", () => {
  it("a modified editable file before calling -> WORKER_DIRTY_TREE_REFUSAL, no worktree, no sidecar file at all", async () => {
    const ws = await makeWorkspace()
    await fs.appendFile(path.join(ws.repoDir, ws.fileName), "dirty uncommitted change\n", "utf-8")

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_DIRTY_TREE_REFUSAL")
    expect(text).toContain("refunded: true")

    // Pre-send gate: no delegation ever opened, so the sidecar file was never created.
    expect(await fileExists(ws.sidecarPath)).toBe(false)

    // No worktree left behind either.
    const rootExists = await fileExists(ws.worktreeRoot)
    const remaining = rootExists ? await fs.readdir(ws.worktreeRoot) : []
    expect(remaining.length).toBe(0)
  })
})

// ── 6. Outbound secret gate ────────────────────────────────────────────────────────────
describe("aider_worker — outbound secret gate", () => {
  it("blocks the payload, names the env var (never the value), opens no delegation", async () => {
    // Register the fake secret BEFORE the workspace is built: writeLedger's ledger
    // seed goes through atomicWriteFile's scrub option, which computes redaction's
    // one-time-per-process env harvest cache as a side effect. Setting the secret
    // afterward would miss that cache; resetForTest() in beforeEach only clears it
    // up-front, so the env var must exist before anything harvests it.
    const secretName = "FAKE_TEST_SECRET_KEY"
    const secretValue = "sk-fixture-0123456789"
    setEnv(secretName, secretValue)
    const ws = await makeWorkspace()

    const text = await runInWorkspace(
      ws,
      baseInput(ws, {
        brief: `use this token ${secretValue} to authenticate the call for the fixture harness delegation`,
      })
    )

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_PAYLOAD_SECRET_BLOCK")
    expect(text).toContain(secretName)
    expect(text).not.toContain(secretValue)

    // Pre-send gate: no sidecar file at all.
    expect(await fileExists(ws.sidecarPath)).toBe(false)
  })
})

// ── 7. Transport crash ─────────────────────────────────────────────────────────────────
describe("aider_worker — transport crash", () => {
  it("FIXTURE_MODE=crash -> WORKER_AIDER_EXIT, worktree torn down, no raw secret in the returned text", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "crash"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_AIDER_EXIT")
    // The fixture deliberately echoes the api key into stderr on crash; the scrub-then-
    // bound discipline must keep the raw value out of the returned text. [CWE-532]
    expect(text).not.toContain(FIXTURE_KEY_VALUE)

    const { events } = await readEvents(ws.sidecarPath)
    expect(events.map((e) => e.event_type)).toEqual([
      "delegation_started",
      "worktree_created",
      "worker_completed",
      "worktree_torn_down",
    ])
    expect(events[events.length - 1].torn_down_ok).toBe(true)

    const wc = events.find((e) => e.event_type === "worker_completed")
    expect(wc!.failure_stage).toBe("WORKER_AIDER_EXIT")
    expect(wc!.outcome).toBe("fail")

    const remaining = await fs.readdir(ws.worktreeRoot)
    expect(remaining.length).toBe(0)
  })
})

// ── 8. Teardown on failure path (general) ─────────────────────────────────────────────
describe("aider_worker — teardown after an in-try failure", () => {
  it("after a WORKER_GHOST failure the worktree dir is gone and worktree_torn_down was appended", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "noedit"

    await runInWorkspace(ws, baseInput(ws))

    const remaining = await fs.readdir(ws.worktreeRoot)
    expect(remaining.length).toBe(0)

    const { events } = await readEvents(ws.sidecarPath)
    const torn = events.find((e) => e.event_type === "worktree_torn_down")
    expect(torn).toBeDefined()
    expect(torn!.torn_down_ok).toBe(true)
  })
})

// ── 9. Non aider-cli tier ──────────────────────────────────────────────────────────────
describe("aider_worker — tier is not worker_kind aider-cli", () => {
  it("status: config_error mentioning FOREMAN_WORKER_KIND_", async () => {
    const ws = await makeWorkspace()
    await fs.writeFile(
      path.join(ws.deps.envDir, ".foremanenv"),
      [
        "schema_version=1",
        "FOREMAN_API_BASE=http://127.0.0.1:1/v1",
        `FOREMAN_API_KEY=\${ENV:${FIXTURE_KEY_NAME}}`,
        "FOREMAN_TIER_STANDARD=test/remote-model",
        "FOREMAN_WORKER_CLASS_STANDARD=capable",
        "FOREMAN_WORKER_KIND_STANDARD=remote-chat",
        "",
      ].join("\n"),
      "utf-8"
    )

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: config_error")
    expect(text).toContain("FOREMAN_WORKER_KIND_STANDARD")
    expect(await fileExists(ws.sidecarPath)).toBe(false)
  })
})

// ── 10. No recorded delegation ────────────────────────────────────────────────────────
describe("aider_worker — no recorded delegation", () => {
  it("status: error telling the pitboss to record set_unit_status s:'delegated' first", async () => {
    const ws = await makeWorkspace({ seedDelegation: false })

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: error")
    expect(text).toContain("set_unit_status")
    expect(text).toContain("'delegated'")
    expect(await fileExists(ws.sidecarPath)).toBe(false)
  })
})

// ── 11. Malformed harness JSON ─────────────────────────────────────────────────────────
describe("aider_worker — malformed harness JSON", () => {
  it("FIXTURE_MODE=badjson -> status fail, failure_stage MODEL_SCHEMA_FAIL, worker_completed carries failure_stage+outcome", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "badjson"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: MODEL_SCHEMA_FAIL")

    const { events } = await readEvents(ws.sidecarPath)
    const wc = events.find((e) => e.event_type === "worker_completed")
    expect(wc).toBeDefined()
    expect(wc!.failure_stage).toBe("MODEL_SCHEMA_FAIL")
    expect(wc!.outcome).toBe("fail")
  })
})

// ── 12. Harness-reported LLM error ─────────────────────────────────────────────────────
describe("aider_worker — harness reports an LLM error", () => {
  it("FIXTURE_MODE=llmerror -> status fail, failure_stage WORKER_AIDER_LLM_ERROR, worktree torn down, worker_completed carries the stage", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "llmerror"

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_AIDER_LLM_ERROR")

    const { events } = await readEvents(ws.sidecarPath)
    const wc = events.find((e) => e.event_type === "worker_completed")
    expect(wc!.failure_stage).toBe("WORKER_AIDER_LLM_ERROR")
    expect(wc!.outcome).toBe("fail")

    const remaining = await fs.readdir(ws.worktreeRoot)
    expect(remaining.length).toBe(0)
  })
})

// ── 13. Outbound secret gate — read-only files [FIX C] ─────────────────────────────────
describe("aider_worker — outbound secret gate covers read_only_files", () => {
  it("blocks the payload when the secret is only in a read-only file, names the env var (never the value), opens no delegation", async () => {
    // Same ordering as the editable-file secret test: the env var must exist before
    // anything harvests redaction's one-time-per-process secret cache.
    const secretName = "FAKE_TEST_SECRET_KEY_RO"
    const secretValue = "sk-fixture-readonly-0123456789"
    setEnv(secretName, secretValue)
    const ws = await makeWorkspace()

    // A second committed file, read-only to this delegation, carrying the secret.
    const contextFile = "context.txt"
    await fs.writeFile(path.join(ws.repoDir, contextFile), `reference token: ${secretValue}\n`, "utf-8")
    git(ws.repoDir, ["add", contextFile])
    git(ws.repoDir, ["commit", "-m", "add context"])

    const text = await runInWorkspace(ws, baseInput(ws, { read_only_files: [contextFile] }))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_PAYLOAD_SECRET_BLOCK")
    expect(text).toContain(secretName)
    expect(text).not.toContain(secretValue)

    // Pre-send gate: no sidecar file at all.
    expect(await fileExists(ws.sidecarPath)).toBe(false)
  })
})

// ── 14. Terminal outcome on worktree_torn_down [FIX B] ─────────────────────────────────
describe("aider_worker — terminal outcome on the final worktree_torn_down event", () => {
  it("a failed delegation (WORKER_GHOST) closes with worktree_torn_down outcome: fail", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "noedit"

    await runInWorkspace(ws, baseInput(ws))

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("worktree_torn_down")
    expect(last.outcome).toBe("fail")
  })

  it("a successful delegation leaves worktree_torn_down with no outcome (stays open)", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "edit"

    await runInWorkspace(ws, baseInput(ws))

    const { events } = await readEvents(ws.sidecarPath)
    const last = events[events.length - 1]
    expect(last.event_type).toBe("worktree_torn_down")
    expect(last.outcome).toBeUndefined()
  })
})

// ── 15. Capability probe fails (python missing) [FIX D] ─────────────────────────────────
describe("aider_worker — harness capability probe fails (python missing)", () => {
  it("FOREMAN_AIDER_PYTHON pointing at a nonexistent binary -> WORKER_BINARY_NOT_FOUND, waiver naming python, no worktree/sidecar", async () => {
    const ws = await makeWorkspace()
    await initJournalSession(ws.journalPath)
    process.chdir(ws.repoDir)
    setEnv("FOREMAN_AIDER_PYTHON", "definitely-not-a-real-interp-xyz123")
    process.env.FOREMAN_AIDER_HARNESS = FIXTURE_HARNESS_PATH
    process.env.FOREMAN_AIDER_WORKTREE_ROOT = ws.worktreeRoot

    // resolvePython() falls back to real python3/python if either resolves on this
    // host's PATH — hide any bare python interpreter so the probe deterministically
    // exhausts all candidates regardless of what's installed on the dev machine.
    const originalPath = process.env.PATH
    process.env.PATH = pathWithoutPythonInterpreters()
    let text: string
    try {
      text = await handleAiderWorker(baseInput(ws), ws.deps)
    } finally {
      process.env.PATH = originalPath
    }

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_BINARY_NOT_FOUND")
    expect(text).toContain("refunded: true")

    // Pre-send gate: no delegation ever opened, so the sidecar file was never created.
    expect(await fileExists(ws.sidecarPath)).toBe(false)

    // No worktree left behind either (none was ever created — probe runs pre-send).
    const rootExists = await fileExists(ws.worktreeRoot)
    const remaining = rootExists ? await fs.readdir(ws.worktreeRoot) : []
    expect(remaining.length).toBe(0)

    // A CAP_WAIVER journal event was recorded naming the missing capability only —
    // never the fake interpreter string beyond the capability name "python".
    const events = await readJournalEvents(ws.journalPath)
    const waiver = events.find((e) => e.t === "CAP_WAIVER")
    expect(waiver).toBeDefined()
    expect(waiver!.msg).toContain("missing: python")
    expect(waiver!.msg).not.toContain("definitely-not-a-real-interp-xyz123")
  })
})

// ── 15b. Capability probe fails (aider not importable) ──────────────────────────────────
describe("aider_worker — harness capability probe fails (aider not importable)", () => {
  it("FIXTURE_AIDER_AVAILABLE=0 -> WORKER_BINARY_NOT_FOUND + waiver naming aider", async () => {
    const ws = await makeWorkspace()
    await initJournalSession(ws.journalPath)
    setEnv("FIXTURE_AIDER_AVAILABLE", "0")

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_BINARY_NOT_FOUND")
    expect(text).toContain("refunded: true")

    // Pre-send gate: no delegation ever opened, so the sidecar file was never created.
    expect(await fileExists(ws.sidecarPath)).toBe(false)

    const events = await readJournalEvents(ws.journalPath)
    const waiver = events.find((e) => e.t === "CAP_WAIVER")
    expect(waiver).toBeDefined()
    expect(waiver!.msg).toContain("missing: aider")
  })
})

// ── 16. Child env is filtered (secret env var not inherited) [CWE-200] ─────────────────
describe("aider_worker — child env is filtered (secret env var not inherited)", () => {
  it("a planted secret-named env var does not reach the harness child; diff shows ENVCHECK=ABSENT", async () => {
    const ws = await makeWorkspace()
    process.env.FIXTURE_MODE = "envprobe"
    setEnv("FOREMAN_PROBE_SECRET", "planted-secret-should-not-be-inherited")

    const text = await runInWorkspace(ws, baseInput(ws))

    expect(text).toContain("status: ok")
    expect(text).toContain("ENVCHECK=ABSENT")
    expect(text).not.toContain("planted-secret-should-not-be-inherited")
  })
})

// ── 17. Fail-open waiver survives a >200-char unit_id [Finding 3 regression] ────────────
describe("aider_worker — CAP_WAIVER journal write survives an over-cap unit_id", () => {
  it("FIXTURE_AIDER_AVAILABLE=0 with a >200-char unit_id -> WORKER_BINARY_NOT_FOUND, and the waiver is still recorded", async () => {
    const ws = await makeWorkspace()
    await initJournalSession(ws.journalPath)

    // The ledger's LogEventData.u field caps at 200 chars; unit_id itself is unbounded
    // (z.string().min(1)). Seed the delegation under the SAME long unit_id passed below,
    // matching makeWorkspace's default phase "2c" so the delegation-existence check passes.
    const longUnitId = "u".repeat(250)
    await writeLedger(ws.ledgerPath, {
      operation: "set_unit_status",
      phase: "2c",
      unit_id: longUnitId,
      data: { s: "delegated", brief: "seed brief for delegated aider unit with a long unit_id", tier: "standard" },
    })
    setEnv("FIXTURE_AIDER_AVAILABLE", "0")

    const text = await runInWorkspace(ws, baseInput(ws, { unit_id: longUnitId }))

    expect(text).toContain("status: fail")
    expect(text).toContain("failure_stage: WORKER_BINARY_NOT_FOUND")

    // Before the fix, bestEffortWaiver's logEvent call threw on schema-parse (u > 200
    // chars) and the try/catch swallowed it — the CAP_WAIVER audit record never landed.
    const events = await readJournalEvents(ws.journalPath)
    const waiver = events.find((e) => e.t === "CAP_WAIVER")
    expect(waiver).toBeDefined()
    expect(waiver!.msg).toContain("missing: aider")
  })
})
