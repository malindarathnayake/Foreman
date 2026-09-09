// repo_guard (v0.6.10; hardened in v0.6.11): the shared-tree ownership check, executed by
// Foreman instead of described to the model. Every case drives a REAL git repository — the
// point of the feature is that the check is a fact about the tree, so a mocked git would
// test the wrong thing, and the 0.6.10 defects below were all found by running it.
//
// The "reproduced in review" cases mirror an adversarial pass over the 0.6.10 commit that
// broke it in nine ways. The headline one: comparing path sets meant a worker overwriting
// the user's uncommitted work in a file outside the brief returned ok.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { compareSnapshots, invalidPathReason, normalizePath, parsePorcelainZ, takeSnapshot, MAX_ENTRIES } from "../src/lib/repoGuard.js"
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
/** Baseline authorizing only a.ts, the shape every violation case starts from. */
async function baseline(allowed = ["a.ts"]) {
  await delegate()
  return guard("snapshot", { files: ["a.ts"], allowed_files: allowed })
}
async function verdict(opts: { user_override?: boolean } = {}) {
  return writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass", ...opts } })
}
async function unitOf() {
  return (await readLedger(ledgerPath)).phases.p1.units.u1
}
async function guardOf() {
  const d = (await unitOf()).delegations!
  return d[d.length - 1].guard
}
const status = (text: string) => text.split("\n").find((l) => l.startsWith("status:"))?.trim()

// ─── path validation and parsing ──────────────────────────────────────────────

describe("path arguments never become git options [CWE-88]", () => {
  it("refuses an option-shaped path, an absolute path, and a parent escape", () => {
    expect(invalidPathReason("--upload-pack=touch /tmp/x")).toMatch(/git option/)
    expect(invalidPathReason("-c")).toMatch(/git option/)
    expect(invalidPathReason("/etc/passwd")).toMatch(/absolute/)
    expect(invalidPathReason("C:\\Windows\\system.ini")).toMatch(/absolute/)
    expect(invalidPathReason("../../secrets.env")).toMatch(/escapes/)
    expect(invalidPathReason("src/a.ts")).toBeNull()
  })

  it("refuses rather than shelling out with the bad path", async () => {
    const out = await takeSnapshot(repoDir, ["--output=/tmp/pwned"])
    expect(out.status).toBe("refused")
    if (out.status === "refused") expect(out.reason).toMatch(/git option/)
  })
})

describe("NUL-delimited porcelain parsing", () => {
  it("keeps the status columns, expands renames, and survives an arrow in a filename", () => {
    // Reproduced in review: with the text format, a file literally named "x -> a.ts" was
    // parsed as a rename and authorized as "a.ts", clearing its unauthorized deletion.
    const parsed = parsePorcelainZ(" M a.ts\0?? café.ts\0R  moved.ts\0keep.ts\0 D x -> a.ts\0")
    expect(parsed).toEqual([
      { path: "a.ts", code: " M" },
      { path: "café.ts", code: "??" },
      { path: "keep.ts", code: "R<" },
      { path: "moved.ts", code: "R " },
      { path: "x -> a.ts", code: " D" },
    ])
  })

  it("reads unicode names and files inside new directories from a real repo", async () => {
    // Reproduced in review: default status collapses an untracked directory to "src/",
    // hiding files inside it, and quotes non-ASCII names as octal escapes.
    await fs.mkdir(path.join(repoDir, "src"))
    await fs.writeFile(path.join(repoDir, "src", "n.ts"), "x\n")
    await fs.writeFile(path.join(repoDir, "café.ts"), "x\n")
    const out = await takeSnapshot(repoDir, [])
    expect(out.status).toBe("ok")
    if (out.status !== "ok") return
    const paths = out.snapshot.entries.map((e) => e.path)
    expect(paths).toContain("src/n.ts")
    expect(paths).toContain("café.ts")
    expect(paths).not.toContain("src/")
  })

  it("ignores Foreman's own state files", async () => {
    // Reproduced in review: the pit-boss writes progress and journal during a unit, so
    // counting them as worker mutations failed every real run.
    await fs.writeFile(path.join(repoDir, ".foreman-progress.json"), "{}")
    const out = await takeSnapshot(repoDir, [])
    if (out.status !== "ok") throw new Error("expected ok")
    expect(out.snapshot.entries.map((e) => e.path)).not.toContain(".foreman-progress.json")
  })
})

// ─── fail closed on an unreadable tree, open outside git ──────────────────────

describe("an unreadable tree is a refusal, not a clean tree", () => {
  it("reports n/a outside a git work tree and gates nothing", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"))
    try {
      expect((await takeSnapshot(plain, [])).status).toBe("n/a")
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

  it("a corrupt index fails the snapshot instead of reporting an empty tree", async () => {
    // Reproduced in review: status failed, its empty stdout became an empty dirty list,
    // and an unauthorized edit compared clean.
    await fs.writeFile(path.join(repoDir, "b.ts"), "unauthorized\n")
    await fs.writeFile(path.join(repoDir, ".git", "index"), "CORRUPT")
    const out = await takeSnapshot(repoDir, [])
    expect(out.status).toBe("failed")
    if (out.status === "failed") expect(out.reason).toMatch(/could not be read completely/)
  })

  it("a failed comparison records nothing, so the verdict stays blocked", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, ".git", "index"), "CORRUPT")
    expect(status(await guard("compare"))).toBe("status: failed")
    expect((await guardOf())?.result).toBeUndefined()
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD/)
  })
})

// ─── content, not just paths ──────────────────────────────────────────────────

describe("comparison sees content, not only paths", () => {
  it("catches a worker overwriting the user's uncommitted work", async () => {
    // THE headline 0.6.10 defect: b.ts was dirty before and after, so the path-set
    // comparison returned ok while the user's work was destroyed.
    await fs.writeFile(path.join(repoDir, "b.ts"), "the user's unsaved work\n")
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "the worker clobbered it\n")
    const text = await guard("compare")
    expect(status(text)).toBe("status: violation")
    expect(text).toMatch(/pre-existing uncommitted change overwritten outside the brief: b\.ts/)
  })

  it("catches a staged blob swapped under an already-staged path", async () => {
    await fs.writeFile(path.join(repoDir, "b.ts"), "user staged this\n")
    git(["add", "b.ts"])
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "worker staged that\n")
    git(["add", "b.ts"])
    const text = await guard("compare")
    expect(status(text)).toBe("status: violation")
    expect(text).toMatch(/b\.ts/)
  })

  it("leaves an untouched pre-existing dirty file alone", async () => {
    await fs.writeFile(path.join(repoDir, "b.ts"), "the user's own edit\n")
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
    expect(status(await guard("compare"))).toBe("status: ok")
  })
})

// ─── the violations that matter ───────────────────────────────────────────────

describe("compare names every ownership breach", () => {
  it("clears when the worker touched only the authorized files", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
    expect(status(await guard("compare"))).toBe("status: ok")
    expect((await guardOf())?.result).toBe("ok")
  })

  it("clears when the worker creates an authorized file in a new directory", async () => {
    await delegate()
    await guard("snapshot", { files: ["a.ts"], allowed_files: ["src/new.ts"] })
    await fs.mkdir(path.join(repoDir, "src"))
    await fs.writeFile(path.join(repoDir, "src", "new.ts"), "x\n")
    expect(status(await guard("compare"))).toBe("status: ok")
  })

  it("catches a file changed outside the brief", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 2\n")
    const text = await guard("compare")
    expect(text).toMatch(/file changed outside the brief: b\.ts/)
    expect(text).toContain("HARD STOP")
  })

  it("catches a commit, a branch switch, a stash, and a config change", async () => {
    for (const [name, mutate] of [
      ["HEAD moved", () => { git(["add", "a.ts"]); git(["commit", "-q", "-m", "worker"]) }],
      ["branch changed", () => git(["checkout", "-q", "-b", "sneaky"])],
      ["stash changed", () => git(["stash", "-q"])],
      ["core.autocrlf changed", () => git(["config", "core.autocrlf", "true"])],
    ] as Array<[string, () => void]>) {
      await fs.rm(ledgerPath, { force: true })
      await fs.writeFile(path.join(repoDir, "a.ts"), `export const a = ${name.length}\n`)
      await baseline()
      mutate()
      expect(status(await guard("compare")), name).toBe("status: violation")
      expect(await guard("compare")).toMatch(new RegExp(name.replace(".", "\\.")))
      git(["checkout", "-q", "main"])
      git(["config", "core.autocrlf", "false"])
    }
  })

  it("catches a comparison run against a different repository", async () => {
    // Reproduced in review: project_dir is caller-supplied, so a clean clone cleared the
    // real tree. The snapshot now carries the repository root.
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "unauthorized\n")
    const clone = await fs.mkdtemp(path.join(os.tmpdir(), "clone-"))
    try {
      execFileSync("git", ["clone", "-q", repoDir, clone], { stdio: ["ignore", "pipe", "ignore"] })
      const text = await handleRepoGuard(
        { operation: "compare", phase: "p1", unit_id: "u1", project_dir: clone } as never,
        { ledgerPath }
      )
      expect(status(text)).toBe("status: violation")
      expect(text).toMatch(/different repository/)
    } finally {
      await fs.rm(clone, { recursive: true, force: true })
    }
  })

  it("allows an authorized repair that restores committed content", async () => {
    // Reproduced in review: a worker told to undo a bad edit was blocked, because the
    // disappearance check ignored authorization.
    await fs.writeFile(path.join(repoDir, "a.ts"), "broken\n")
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 1\n")
    expect(status(await guard("compare"))).toBe("status: ok")
  })

  it("still catches an unauthorized change that disappears", async () => {
    await fs.writeFile(path.join(repoDir, "b.ts"), "the user's work\n")
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "export const b = 1\n")
    expect(await guard("compare")).toMatch(/pre-existing uncommitted change disappeared: b\.ts/)
  })

  it("refuses to compare with no baseline", async () => {
    await delegate()
    expect(status(await guard("compare"))).toBe("status: no_baseline")
  })

  it("only a real overflow blocks on truncation", () => {
    // Reproduced in review: the cap was treated as the comparison limit, so 50 unchanged
    // dirty files blocked a repo that had done nothing wrong.
    const entry = (i: number) => ({ path: `f${i}.ts`, code: " M", wt: `h${i}`, idx: "none" })
    const snap = (n: number, truncated: boolean): RepoSnapshot => ({
      root: "/r", branch: "main", head: "abc", stash_ref: "none", stash_count: 0,
      autocrlf: "unset", eol: [], entries: Array.from({ length: n }, (_, i) => entry(i)),
      truncated, allowed: [], hash: "h",
    })
    expect(compareSnapshots(snap(MAX_ENTRIES, false), snap(MAX_ENTRIES, false))).toEqual([])
    expect(compareSnapshots(snap(3, true), snap(3, true))[0]).toMatch(/comparison is incomplete/)
  })

  it("normalizePath makes separators comparable", () => {
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts")
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts")
  })
})

// ─── the baseline and the authorized set are frozen ───────────────────────────

describe("the model cannot retry until the guard is green", () => {
  it("refuses a second baseline for the same attempt", async () => {
    // Reproduced in review: re-taking the snapshot replaced the violation, then passed.
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "unauthorized\n")
    expect(status(await guard("compare"))).toBe("status: violation")
    const text = await guard("snapshot", { files: ["a.ts"], allowed_files: ["a.ts", "b.ts"] })
    expect(status(text)).toBe("status: refused")
    expect(text).toMatch(/already has a baseline/)
    expect((await guardOf())?.result).toBe("violation")
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD/)
  })

  it("refuses allowed_files on compare", async () => {
    // Reproduced in review: widening authorization after the mutation cleared it.
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "unauthorized\n")
    const text = await guard("compare", { allowed_files: ["a.ts", "b.ts"] })
    expect(status(text)).toBe("status: refused")
    expect(text).toMatch(/frozen before the worker runs/)
    expect(status(await guard("compare"))).toBe("status: violation")
  })
})

// ─── the verdict gate ─────────────────────────────────────────────────────────

describe("set_verdict enforces the guard", () => {
  it("refuses a pass when the comparison was never run", async () => {
    await baseline()
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD[\s\S]*no comparison was recorded/)
  })

  it("refuses a pass after a violation and names it", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
    await guard("compare")
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD[\s\S]*file changed outside the brief: b\.ts/)
  })

  it("allows the pass once the comparison clears", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 6\n")
    await guard("compare")
    await verdict()
    expect((await unitOf()).v).toBe("pass")
  })

  it("user_override waives a violation and records it on the delegation", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
    await guard("compare")
    await verdict({ user_override: true })
    expect((await unitOf()).v).toBe("pass")
    expect((await guardOf())?.override?.ts).toBeTruthy()
  })

  it("a recorded violation is not abandoned by taking another attempt", async () => {
    // Reproduced in review: a direct fix bumps attempt_seq without adding a delegation,
    // and the block fell away with the attempt it was matched to.
    await baseline()
    await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
    await guard("compare")
    await writeLedger(ledgerPath, {
      operation: "set_unit_status", phase: "p1", unit_id: "u1",
      data: { s: "ip", direct_fix: "a.ts: rename fooBar to foo_bar" },
    })
    await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD/)
  })

  it("a later violation reopens a standing pass", async () => {
    // Reproduced in review: a violation recorded after the verdict left the pass valid.
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 7\n")
    await guard("compare")
    await verdict()
    expect((await unitOf()).v).toBe("pass")
    await fs.writeFile(path.join(repoDir, "b.ts"), "unauthorized, after the pass\n")
    const text = await guard("compare")
    expect(status(text)).toBe("status: violation")
    expect(text).toMatch(/reopened to pending/)
    expect((await unitOf()).v).toBe("pending")
  })

  it("a delegation with no guard is not gated (non-git repos and older ledgers)", async () => {
    await delegate()
    await verdict()
    expect((await unitOf()).v).toBe("pass")
  })

  it("a cleared guard from an earlier attempt does not gate the current one", async () => {
    await baseline()
    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 8\n")
    await guard("compare")
    await verdict()
    await writeLedger(ledgerPath, { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "reviewer", msg: "nit", ts: "2026-09-08T00:00:00Z" } })
    await delegate()
    await verdict()
    expect((await unitOf()).v).toBe("pass")
  })
})
