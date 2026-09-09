// repo_guard (v0.6.10): the shared-tree ownership check, executed by Foreman instead of
// described to the model. Every case below drives a REAL git repository — the point of
// the change is that the check is a fact about the tree, so a mocked git would test the
// wrong thing.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { compareSnapshots, invalidPathReason, porcelainPath, takeSnapshot, MAX_PATHS } from "../src/lib/repoGuard.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import type { RepoSnapshot } from "../src/types.js"

let repoDir: string
let ledgerPath: string

function git(args: string[], cwd = repoDir): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
}

beforeEach(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-guard-"))
  ledgerPath = path.join(repoDir, ".foreman-ledger.json")
  git(["init", "-q", "-b", "main"])
  git(["config", "user.email", "t@example.com"])
  git(["config", "user.name", "T"])
  git(["config", "commit.gpgsign", "false"])
  // Pinned per repo: this machine's global core.autocrlf is true, so a test that flips it
  // would otherwise be a no-op against the global value.
  git(["config", "core.autocrlf", "false"])
  await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 1\n")
  await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 1\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "init"])
})

afterEach(async () => {
  await fs.rm(repoDir, { recursive: true, force: true })
})

const BRIEF = "worker brief long enough to clear the 20 char minimum"
const PREFLIGHT = { symbols_grepped: 1, self_consistent: true as const }

async function delegate(unit = "u1") {
  return writeLedger(ledgerPath, {
    operation: "set_unit_status",
    phase: "p1",
    unit_id: unit,
    data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT },
  })
}
async function guard(operation: "snapshot" | "compare", extra: Record<string, unknown> = {}) {
  return handleRepoGuard(
    { operation, phase: "p1", unit_id: "u1", project_dir: repoDir, ...extra } as never,
    { ledgerPath }
  )
}
async function verdict(opts: { user_override?: boolean } = {}) {
  return writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", ...opts } })
}
async function guardOf(unit = "u1") {
  const u = (await readLedger(ledgerPath)).phases.p1.units[unit]
  const d = u.delegations!
  return d[d.length - 1].guard
}

// ─── path validation [CWE-88] ─────────────────────────────────────────────────

describe("path arguments never become git options", () => {
  it("refuses a path that would parse as an option, an absolute path, and a parent escape", () => {
    expect(invalidPathReason("--upload-pack=touch /tmp/x")).toMatch(/git option/)
    expect(invalidPathReason("-c")).toMatch(/git option/)
    expect(invalidPathReason("/etc/passwd")).toMatch(/absolute/)
    expect(invalidPathReason("C:\\Windows\\system.ini")).toMatch(/absolute/)
    expect(invalidPathReason("../../secrets.env")).toMatch(/escapes/)
    expect(invalidPathReason("src/a.ts")).toBeNull()
    expect(invalidPathReason("src\\a.ts")).toBeNull()
  })

  it("porcelain status columns are stripped without eating the path", () => {
    // Regression: trimming the line first turned " M a.ts" into "M a.ts" and then sliced
    // three characters off, so every path lost its first letter.
    expect(porcelainPath(" M a.ts")).toBe("a.ts")
    expect(porcelainPath("?? new/file.ts")).toBe("new/file.ts")
    expect(porcelainPath("M  staged.ts")).toBe("staged.ts")
    expect(porcelainPath("R  old.ts -> new.ts")).toBe("new.ts")
  })

  it("the snapshot refuses rather than shelling out with the bad path", async () => {
    const out = await takeSnapshot(repoDir, ["--output=/tmp/pwned"])
    expect(out.status).toBe("refused")
    if (out.status === "refused") expect(out.reason).toMatch(/git option/)
  })
})

// ─── fail-open outside git ────────────────────────────────────────────────────

describe("outside a git work tree the guard does not apply", () => {
  it("reports n/a and gates nothing", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"))
    try {
      const out = await takeSnapshot(plain, [])
      expect(out.status).toBe("n/a")
      const text = await handleRepoGuard(
        { operation: "snapshot", phase: "p1", unit_id: "u1", project_dir: plain } as never,
        { ledgerPath: path.join(plain, ".foreman-ledger.json") }
      )
      expect(text).toContain("status: n/a")
      expect(text).toContain("not gated")
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })
})

// ─── snapshot recording ───────────────────────────────────────────────────────

describe("snapshot", () => {
  it("records branch, HEAD, stash, and counts on the newest delegation", async () => {
    await delegate()
    const text = await guard("snapshot", { files: ["a.ts"] })
    expect(text).toContain("status: recorded")
    expect(text).toContain("branch: main")
    const g = await guardOf()
    expect(g?.snapshot.branch).toBe("main")
    expect(g?.snapshot.head).toMatch(/^[0-9a-f]{40}$/)
    expect(g?.snapshot.stash_ref).toBe("none")
    expect(g?.snapshot.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(g?.result).toBeUndefined()
  })

  it("refuses when the unit has no delegation to attach to", async () => {
    await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "ip" } })
    await expect(guard("snapshot")).rejects.toThrow(/GUARD BLOCKED: unit 'u1' has no delegation/)
  })

  it("refuses when the unit is not registered", async () => {
    await expect(guard("snapshot")).rejects.toThrow(/GUARD BLOCKED: unit 'u1' is not registered/)
  })
})

// ─── compare: the violations that matter ──────────────────────────────────────

describe("compare names every ownership breach", () => {
  it("clears when the worker touched only the brief's files", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: ok")
    expect((await guardOf())?.result).toBe("ok")
  })

  it("catches a file changed outside the brief", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 2\n")
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: violation")
    expect(text).toMatch(/file changed outside the brief: b\.ts/)
    expect(text).toContain("HARD STOP")
  })

  it("catches a commit (HEAD moved)", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 3\n")
    git(["add", "a.ts"])
    git(["commit", "-q", "-m", "worker commit"])
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: violation")
    expect(text).toMatch(/HEAD moved/)
  })

  it("catches a branch switch", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    git(["checkout", "-q", "-b", "sneaky"])
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toMatch(/branch changed: 'main' -> 'sneaky'/)
  })

  it("catches a stash that swallows the user's work", async () => {
    await fs.writeFile(path.join(repoDir, "b.ts"), "user work in progress\n")
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    git(["stash", "-q"])
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: violation")
    expect(text).toMatch(/stash changed/)
    expect(text).toMatch(/pre-existing uncommitted change disappeared: b\.ts/)
  })

  it("catches a staged file", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 4\n")
    git(["add", "a.ts"])
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toMatch(/file staged by the worker: a\.ts/)
  })

  it("catches a core.autocrlf change", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    git(["config", "core.autocrlf", "true"])
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toMatch(/core\.autocrlf changed/)
  })

  it("a pre-existing dirty file outside the brief is not a violation on its own", async () => {
    await fs.writeFile(path.join(repoDir, "b.ts"), "user's own edit\n")
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 5\n")
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: ok")
  })

  it("refuses to compare with no baseline", async () => {
    await delegate()
    const text = await guard("compare", { allowed_files: ["a.ts"] })
    expect(text).toContain("status: no_baseline")
    expect(text).toContain("proves nothing")
  })

  it("a truncated dirty list cannot clear a unit", () => {
    const base: RepoSnapshot = {
      branch: "main", head: "abc", stash_ref: "none", stash_count: 0,
      staged: [], dirty: Array.from({ length: MAX_PATHS }, (_, i) => `f${i}.ts`),
      autocrlf: "unset", eol: [], hash: "h",
    }
    const violations = compareSnapshots(base, base, [])
    expect(violations.some((v) => v.includes("cap"))).toBe(true)
  })
})

// ─── the verdict gate ─────────────────────────────────────────────────────────

describe("set_verdict enforces the guard", () => {
  it("refuses a pass when the comparison was never run", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD[\s\S]*no comparison was recorded/)
  })

  it("refuses a pass after a violation and names it", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
    await guard("compare", { allowed_files: ["a.ts"] })
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD[\s\S]*file changed outside the brief: b\.ts/)
  })

  it("allows the pass once the comparison clears", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 6\n")
    await guard("compare", { allowed_files: ["a.ts"] })
    await verdict()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pass")
  })

  it("user_override waives a violation and records it on the delegation", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
    await guard("compare", { allowed_files: ["a.ts"] })
    await verdict({ user_override: true })
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pass")
    expect((await guardOf())?.override?.ts).toBeTruthy()
  })

  it("a delegation with no guard is not gated (non-git repos and older ledgers)", async () => {
    await delegate()
    await verdict()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pass")
  })

  it("a stale guard from an earlier attempt does not gate the current one", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"] })
    await guard("compare", { allowed_files: ["a.ts"] })
    await verdict()
    // Reopen and re-delegate: attempt 2 carries no guard of its own.
    await writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "reviewer", msg: "nit", ts: "2026-09-08T00:00:00Z" } })
    await delegate()
    await verdict()
    expect((await readLedger(ledgerPath)).phases.p1.units.u1.v).toBe("pass")
  })
})
