// repo_guard (v0.6.10; hardened in v0.6.11): the shared-tree ownership check, executed by
// Foreman instead of described to the model. Every case drives a REAL git repository — the
// point of the feature is that the check is a fact about the tree, so a mocked git would
// test the wrong thing, and the 0.6.10 defects below were all found by running it.
//
// The "reproduced in review" cases mirror an adversarial pass over the 0.6.10 commit that
// broke it in nine ways. The headline one: comparing path sets meant a worker overwriting
// the user's uncommitted work in a file outside the brief returned ok.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Every test in this file shells out to real git repeatedly (init, add, commit, status,
// ls-files, stash) and several run a full snapshot/compare cycle. On Windows, under the
// parallel load of the whole suite, that is routinely past vitest's 5s default — which
// surfaced as a DIFFERENT test timing out on each run while every one passed in isolation.
// The budget is the problem, not the tests, so it is set once for the file.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { readLedger, writeLedger } from "../src/lib/ledger.js"
import { compareSnapshots, invalidPathReason, normalizePath, parsePorcelainZ, takeSnapshot, ENTRY_CEILING, MAX_ENTRIES } from "../src/lib/repoGuard.js"
import { attributeHeadMove } from "../src/lib/repoGuard.js"
import { handleRepoGuard } from "../src/tools/repoGuard.js"
import { handleWriteProgress, FENCE_START, FENCE_END } from "../src/tools/writeProgress.js"
import { preflightCheck } from "../src/tools/preflightCheck.js"
import { preflightPathFor } from "../src/lib/preflight.js"
import { fencedFingerprint, foremanFileScope, relativeScope } from "../src/lib/foremanFiles.js"
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

  it("works on a repository whose index is larger than the capture limit", async () => {
    // Field failure the day after 0.6.10 shipped: the index fingerprints came from an
    // unscoped `git ls-files -s`, whose output scales with REPOSITORY size rather than
    // with the change being compared. It measured 13 KB against a 16 KB capture limit in
    // this repo, so every test passed here and every snapshot on a larger repository was
    // refused as truncated. 400 tracked files put the full index well past the limit.
    for (let i = 0; i < 400; i++) {
      await fs.writeFile(path.join(repoDir, `padding-file-number-${i}.ts`), `export const n${i} = ${i}\n`)
    }
    git(["add", "."])
    git(["commit", "-q", "-m", "many files"])
    expect(git(["ls-files", "-s"]).length).toBeGreaterThan(16000)

    await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
    const out = await takeSnapshot(repoDir, ["a.ts"], ["a.ts"])
    expect(out.status).toBe("ok")
    if (out.status !== "ok") return
    expect(out.snapshot.entries.map((e) => e.path)).toEqual(["a.ts"])
    expect(out.snapshot.entries[0].idx).not.toBe("none")
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
      truncated, entry_limit: MAX_ENTRIES, allowed: [], hash: "h",
    })
    expect(compareSnapshots(snap(MAX_ENTRIES, false), snap(MAX_ENTRIES, false))).toEqual([])
    expect(compareSnapshots(snap(3, true), snap(3, true))[0]).toMatch(/comparison is incomplete/)
    expect(compareSnapshots(snap(3, true), snap(3, true))[0]).toMatch(/raise repo_guard max_entries/)
  })

  it("the entry limit is raisable per call and bounded by the ceiling", async () => {
    // The default is generous rather than a wall: a tree that legitimately carries more
    // changes than 500 can still be guarded by asking for a bigger comparison.
    for (let i = 0; i < 12; i++) await fs.writeFile(path.join(repoDir, `extra${i}.ts`), "x")
    const tight = await takeSnapshot(repoDir, [], [], 5)
    if (tight.status !== "ok") throw new Error("expected ok")
    expect(tight.snapshot.entries).toHaveLength(5)
    expect(tight.snapshot.truncated).toBe(true)
    expect(tight.snapshot.entry_limit).toBe(5)

    const roomy = await takeSnapshot(repoDir, [], [], 100)
    if (roomy.status !== "ok") throw new Error("expected ok")
    expect(roomy.snapshot.truncated).toBe(false)
    expect(roomy.snapshot.entry_limit).toBe(100)

    const absurd = await takeSnapshot(repoDir, [], [], 10_000_000)
    if (absurd.status !== "ok") throw new Error("expected ok")
    expect(absurd.snapshot.entry_limit).toBe(ENTRY_CEILING)
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

  // 0.6.34 (Codex adversarial review 2026-09-25): an ordinary re-delegation took a fresh
  // baseline of the already-violated tree, compared ok against it, and the pass cleared with
  // the out-of-scope change still in place and no override recorded.
  describe("a violation is not laundered by an ordinary re-delegation", () => {
    async function violateThenRedelegate(allowed2 = ["a.ts"]) {
      await baseline()
      await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
      await guard("compare")
      await delegate()
      await guard("snapshot", { files: ["a.ts"], allowed_files: allowed2 })
    }

    it("refuses the pass while the attempt-1 stray change is still in the tree", async () => {
      await violateThenRedelegate()
      expect(status(await guard("compare"))).toBe("status: ok")
      await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD.*attempt #1/)
    })

    it("authorizing the stray file on the next attempt does not clear it", async () => {
      await violateThenRedelegate(["a.ts", "b.ts"])
      await guard("compare")
      await expect(verdict()).rejects.toThrow(/REPOSITORY GUARD.*attempt #1/)
    })

    it("clears once the stray path is back to its attempt-1 baseline", async () => {
      await violateThenRedelegate()
      git(["checkout", "--", "b.ts"])
      const out = await guard("compare")
      expect(out).toMatch(/resolved.*attempt #1/)
      await verdict()
      const u = await unitOf()
      expect(u.v).toBe("pass")
      expect(u.delegations![0].guard?.resolved?.by_attempt).toBe(2)
    })

    it("user_override waives the earlier violation and records it there", async () => {
      await violateThenRedelegate()
      await guard("compare")
      await verdict({ user_override: true })
      const u = await unitOf()
      expect(u.v).toBe("pass")
      expect(u.delegations![0].guard?.override?.ts).toBeTruthy()
    })
  })

  // 0.6.36 (field report 2026-09-27): delegation + snapshot were two calls per unit. data.guard
  // takes the baseline in the delegation's own write; a refused baseline records nothing.
  describe("data.guard takes the baseline with the delegation", () => {
    const delegateGuarded = async (guard: Record<string, unknown>, unit = "u1", projectRoot = repoDir) => {
      const { handleWriteLedger } = await import("../src/tools/writeLedger.js")
      return handleWriteLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: unit, data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT, guard } },
        "claude-code", undefined, { projectRoot, guardPaths: { ledgerPath } })
    }

    it("records the baseline and the window in one write; compare and verdict work as before", async () => {
      const out = await delegateGuarded({ allowed_files: ["a.ts"] })
      expect(out).toContain("baseline recorded (1 authorized file(s)")
      expect((await readLedger(ledgerPath)).window).toMatchObject({ unit_id: "u1", attempt: 1, stage: "editing" })
      await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 9\n")
      expect(status(await guard("compare"))).toBe("status: ok")
      await verdict()
      expect((await unitOf()).v).toBe("pass")
    })

    it("an explicit snapshot afterwards is answered from the delegation's baseline", async () => {
      await delegateGuarded({ allowed_files: ["a.ts"] })
      const again = await guard("snapshot", { files: ["a.ts"], allowed_files: ["a.ts"] })
      expect(status(again)).toBe("status: recorded")
      expect(again).toContain("taken at delegation")
      expect(status(await guard("snapshot", { allowed_files: ["b.ts"] }))).toBe("status: refused")
    })

    it("a refused baseline refuses the delegation and allocates no attempt", async () => {
      await expect(delegateGuarded({})).rejects.toThrow(/GUARD BLOCKED: the delegation's baseline was refused/)
      const u = (await readLedger(ledgerPath)).phases.p1?.units.u1
      expect(u?.attempt_seq ?? 0).toBe(0)
    })

    it("outside a git work tree it records no guard and says so", async () => {
      const plain = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"))
      try {
        const out = await delegateGuarded({ allowed_files: ["a.ts"] }, "u1", plain)
        expect(out).toContain("no guard recorded (not a git work tree)")
        expect((await readLedger(ledgerPath)).phases.p1.units.u1.delegations!.at(-1)!.guard).toBeUndefined()
      } finally { await fs.rm(plain, { recursive: true, force: true }) }
    })

    // 0.6.38 (field report 2026-09-27): a new fixture had to be named in allowed_files even
    // though preflight_check creates already declared it. Promised files are frozen in.
    it("files promised in preflight creates join the authorized set; others still violate", async () => {
      const { appendPreflight, briefHash, preflightPathFor } = await import("../src/lib/preflight.js")
      await appendPreflight(preflightPathFor(ledgerPath), {
        v: 1, ts: new Date().toISOString(), phase: "p1", unit_id: "u1", brief_hash: briefHash(BRIEF), status: "pass",
        symbols: 1, coverage_ratio: 1, uncovered: 0, flags: 0, dead_citations: 0, ownership_outside: 0,
        forward: [{ file: "fixtures/new.json", tests: [] }], brief: BRIEF,
      } as never)
      const { handleWriteLedger } = await import("../src/tools/writeLedger.js")
      const out = await handleWriteLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1",
        data: { s: "delegated", brief: BRIEF, preflight: { ...PREFLIGHT, receipt: briefHash(BRIEF) }, guard: { allowed_files: ["a.ts"] } } },
        "claude-code", undefined, { projectRoot: repoDir, guardPaths: { ledgerPath } })
      expect(out).toContain("baseline recorded (2 authorized file(s)")
      await fs.mkdir(path.join(repoDir, "fixtures"), { recursive: true })
      await fs.writeFile(path.join(repoDir, "fixtures", "new.json"), "{}\n")
      expect(status(await guard("compare"))).toBe("status: ok")
      await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
      expect(status(await guard("compare"))).toBe("status: violation")
    })

    it("another unit's delegation is refused while this window is open", async () => {
      await delegateGuarded({ allowed_files: ["a.ts"] })
      await expect(delegateGuarded({ allowed_files: ["b.ts"] }, "u2")).rejects.toThrow(/WINDOW BUSY/)
    })
  })

  // 0.6.39 (field data): preflight_check preceded the delegation within 60 s in 86/94 cases and
  // compare preceded the pass verdict in 36/38. Both can now ride the write they precede.
  describe("fewer calls per unit", () => {
    const spec = () => fs.writeFile(path.join(repoDir, "spec.md"), "#### u1 — a\n- Change `exportedA` in a.ts to return 2.\n")
    const write = async (op: Record<string, unknown>) => {
      const { handleWriteLedger } = await import("../src/tools/writeLedger.js")
      return handleWriteLedger(ledgerPath, op, "claude-code", undefined,
        { projectRoot: repoDir, specPath: path.join(repoDir, "spec.md"), guardPaths: { ledgerPath } })
    }
    const delegateInline = (symbols: string[]) => write({ operation: "set_unit_status", phase: "p1", unit_id: "u1", data: {
      s: "delegated", brief: "Change exportedA in a.ts to return 2, with its test.", preflight_check: { symbols, files: ["a.ts"] },
      guard: { allowed_files: ["a.ts"] } } })

    it("a delegation runs its preflight inline and records the receipt", async () => {
      await spec()
      await delegateInline(["exportedA"])
      const d = (await unitOf()).delegations!.at(-1)!
      expect(d.preflight?.receipt).toMatch(/^[0-9a-f]{16}$/)
      expect(d.guard?.snapshot).toBeDefined()
    })

    it("a failing inline preflight refuses the delegation with its report and records nothing", async () => {
      await spec()
      await expect(delegateInline(["notInTheSpec"])).rejects.toThrow(/PREFLIGHT FAILED[\s\S]*notInTheSpec/)
      expect((await readLedger(ledgerPath)).phases.p1?.units.u1?.attempt_seq ?? 0).toBe(0)
    })

    it("a pass verdict compares first when the attempt has no comparison; a stray edit still blocks", async () => {
      await spec()
      await delegateInline(["exportedA"])
      await fs.writeFile(path.join(repoDir, "b.ts"), "touched\n")
      await expect(write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })).rejects.toThrow(/REPOSITORY GUARD/)
      expect((await guardOf())?.result).toBe("violation")
    })

    // Codex review of 0.6.39: the verdict-time compare ran in the server's directory, not the
    // baseline's, and recorded a "different repository" violation on an untouched tree.
    it("the verdict-time compare runs in the baseline's own repository", async () => {
      await spec()
      await delegateInline(["exportedA"])
      const { handleWriteLedger } = await import("../src/tools/writeLedger.js")
      const out = await handleWriteLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } },
        "claude-code", undefined, { projectRoot: os.tmpdir(), specPath: path.join(repoDir, "spec.md"), guardPaths: { ledgerPath } })
      expect(out).toContain("guard compared at verdict: ok")
    })

    it("a clean attempt passes with the comparison done at the verdict", async () => {
      await spec()
      await delegateInline(["exportedA"])
      await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
      const out = await write({ operation: "set_verdict", phase: "p1", unit_id: "u1", data: { v: "pass" } })
      expect(out).toContain("guard compared at verdict: ok")
      expect((await unitOf()).v).toBe("pass")
    })
  })

  // 0.6.39 (field report 2026-09-27): a 10–12 min seat was staled by ANY delegation in the
  // phase. A receipt pinned to its units' authorized files is judged per unit.
  describe("review pins", () => {
    async function passUnit(unit: string, file: string) {
      const { handleWriteLedger } = await import("../src/tools/writeLedger.js")
      await handleWriteLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: unit, data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT, guard: { allowed_files: [file] } } },
        "claude-code", undefined, { projectRoot: repoDir, guardPaths: { ledgerPath } })
      await handleRepoGuard({ operation: "compare", phase: "p1", unit_id: unit, project_dir: repoDir } as never, { ledgerPath })
      await writeLedger(ledgerPath, { operation: "set_verdict", phase: "p1", unit_id: unit, data: { v: "pass" } } as never)
    }
    async function pinnedReceipt(units: string[]) {
      const { pinUnits } = await import("../src/lib/reviewPins.js")
      const { appendReceipt, receiptsPathFor, sha256Hex } = await import("../src/lib/seatReceipts.js")
      const pins = await pinUnits(await readLedger(ledgerPath), "p1", units, repoDir)
      const prompt = "review packet " + "x".repeat(1200)
      return appendReceipt(receiptsPathFor(ledgerPath), {
        started_ts: new Date().toISOString(), ...(pins ? { pin_phase: pins.phase, pin_units: pins.units, pin_attempts: pins.attempts, pins: pins.pins } : {}),
        cli: "gemini", provider: "google", model_served: "gemini-3.1-pro-preview", exit_code: 0, failure_reason: null,
        prompt_sha256: sha256Hex(prompt), bytes_in: prompt.length, bytes_out: 900,
      })
    }
    const recordFor = (receipt: { id: string; prompt_sha256: string }, units: string[]) =>
      writeLedger(ledgerPath, { operation: "record_review", phase: "p1", data: {
        advisor: "gemini", stage: "independent", completion: "complete", findings: [], checked: ["a.ts"], units,
        seat_receipt: receipt.id, packet_hash: receipt.prompt_sha256 } } as never,
        undefined, undefined, "claude-code", undefined, undefined, { projectRoot: repoDir })

    it("another unit moving during the seat does not stale a pinned, scoped review", async () => {
      await passUnit("u1", "a.ts")
      await passUnit("u2", "b.ts")
      const r = await pinnedReceipt(["u1"])
      expect(r.pins?.map((p) => p.path)).toEqual(["a.ts"])
      await new Promise((res) => setTimeout(res, 20))
      await passUnit("u2", "b.ts")
      await recordFor(r, ["u1"])
    })

    it("a pinned file changed after the seat started refuses the record", async () => {
      await passUnit("u1", "a.ts")
      const r = await pinnedReceipt(["u1"])
      await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 42\n")
      await expect(recordFor(r, ["u1"])).rejects.toThrow(/pinned file\(s\) changed since the seat started: a\.ts/)
    })

    // Codex review of 0.6.39: pins bind their phase and attempts, come from the current attempt,
    // and never follow a link outside the root.
    it("a pinned receipt bound in another phase is refused", async () => {
      await passUnit("u1", "a.ts")
      const r = await pinnedReceipt(["u1"])
      const { appendReceipt, receiptsPathFor } = await import("../src/lib/seatReceipts.js")
      const moved = await appendReceipt(receiptsPathFor(ledgerPath), { ...r, pin_phase: "p9" } as never)
      await expect(recordFor(moved, ["u1"])).rejects.toThrow(/pinned for phase 'p9'/)
    })

    it("a unit that moved between hashing and recording is refused, not waved through", async () => {
      await passUnit("u1", "a.ts")
      const r = await pinnedReceipt(["u1"])
      const { appendReceipt, receiptsPathFor } = await import("../src/lib/seatReceipts.js")
      const early = await appendReceipt(receiptsPathFor(ledgerPath), { ...r, pin_attempts: { u1: 0 } } as never)
      await expect(recordFor(early, ["u1"])).rejects.toThrow(/pinned unit\(s\) u1 at an earlier attempt/)
    })

    it("pins come only from the current attempt's baseline", async () => {
      await passUnit("u1", "a.ts")
      await writeLedger(ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT } } as never)
      const { pinUnits } = await import("../src/lib/reviewPins.js")
      expect(await pinUnits(await readLedger(ledgerPath), "p1", ["u1"], repoDir)).toBeNull()
    })

    it("a link that leaves the project root is never pinned [CWE-22]", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"))
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "not yours\n")
        await fs.symlink(outside, path.join(repoDir, "link"), process.platform === "win32" ? "junction" : "dir")
        await passUnit("u1", "link/secret.txt")
        const { pinUnits } = await import("../src/lib/reviewPins.js")
        expect(await pinUnits(await readLedger(ledgerPath), "p1", ["u1"], repoDir)).toBeNull()
      } finally { await fs.rm(outside, { recursive: true, force: true }) }
    })

    it("a record covering a unit the seat was not pinned to falls back to the phase-wide rule", async () => {
      await passUnit("u1", "a.ts")
      await passUnit("u2", "b.ts")
      const r = await pinnedReceipt(["u1"])
      await new Promise((res) => setTimeout(res, 20))
      await passUnit("u2", "b.ts")
      await expect(recordFor(r, ["u1", "u2"])).rejects.toThrow(/reviewed old code/)
    })
  })

  // 0.6.36 (field report 2026-09-27): after a restart orientation said implement_unit while an
  // attempt still held the window; re-delegating would replace it under a live worker.
  it("session_orient names an open attempt and says not to re-delegate", async () => {
    await baseline()
    const { sessionOrient } = await import("../src/tools/sessionOrient.js")
    const out = await sessionOrient(ledgerPath, path.join(repoDir, "progress.json"))
    expect(out).toMatch(/open_attempt: p1\/u1 #1 \(editing, opened .*; compare: none\)/)
    expect(out).toContain("Do not re-delegate")
    await guard("compare")
    expect(await sessionOrient(ledgerPath, path.join(repoDir, "progress.json"))).toContain("the comparison cleared")
  })

  it("snapshot output warns that manual edits in the window are charged to the attempt", async () => {
    expect(await baseline()).toContain("charged to this attempt, whoever made them")
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

// ─── Foreman's own writes are not the worker's (v0.6.20) ──────────────────────
//
// Field defect: every write_progress in a unit window charged Docs/PROGRESS.md to the
// worker, and the state-file exclusion was a second list in the guard that had already
// drifted from the writers (.foreman-seats.jsonl was missing). The set now comes from
// lib/foremanFiles.ts, which the writers import, and PROGRESS.md is fingerprinted with
// Foreman's fenced block removed rather than excused.

describe("Foreman's own writes are excluded from one shared list", () => {
  let docsDir: string
  let docsLedger: string
  let docsProgress: string
  let docsJournal: string
  const progressMd = () => path.join(docsDir, "PROGRESS.md")

  beforeEach(async () => {
    docsDir = path.join(repoDir, "Docs")
    docsLedger = path.join(docsDir, ".foreman-ledger.json")
    docsProgress = path.join(docsDir, ".foreman-progress.json")
    docsJournal = path.join(docsDir, ".foreman-journal.json")
    await fs.mkdir(docsDir)
    await fs.writeFile(progressMd(), "# Plan\n\nhand-written prose\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "docs"])
  })

  const serverPaths = () => ({ ledgerPath: docsLedger, progressPath: docsProgress, journalPath: docsJournal, docsDir })
  async function docsGuard(operation: "snapshot" | "compare", extra: Record<string, unknown> = {}, paths = serverPaths()) {
    return handleRepoGuard({ operation, phase: "p1", unit_id: "u1", project_dir: repoDir, ...extra } as never, paths)
  }
  async function docsBaseline(paths = serverPaths()) {
    await writeLedger(paths.ledgerPath, { operation: "set_unit_status", phase: "p1", unit_id: "u1", data: { s: "delegated", brief: BRIEF, preflight: PREFLIGHT } })
    return docsGuard("snapshot", { files: ["a.ts"], allowed_files: ["a.ts"] }, paths)
  }
  /** Foreman's own progress write, exactly as the tool does it. */
  async function foremanWritesProgress(paths = serverPaths(), name = "Phase") {
    return handleWriteProgress(paths.progressPath, { operation: "start_phase", data: { phase: "p1", name } }, paths.docsDir, paths.ledgerPath)
  }

  it("T1: write_progress during the window clears, on a fenceless file and again on a fenced one", async () => {
    await docsBaseline()
    await foremanWritesProgress()
    expect(await fs.readFile(progressMd(), "utf-8")).toContain(FENCE_START)
    const first = await docsGuard("compare")
    expect(status(first), first).toBe("status: ok")

    // Second attempt: the file is now dirty with a fence; Foreman rewrites the block.
    await writeLedger(docsLedger, { operation: "add_rejection", phase: "p1", unit_id: "u1", data: { r: "reviewer", msg: "nit", ts: "2026-09-10T00:00:00Z" } })
    await docsBaseline()
    await foremanWritesProgress(serverPaths(), "Renamed phase")
    const second = await docsGuard("compare")
    expect(status(second), second).toBe("status: ok")
  })

  it("T2: content outside the fence is still the worker's", async () => {
    await foremanWritesProgress()
    await docsBaseline()
    const content = await fs.readFile(progressMd(), "utf-8")
    await fs.writeFile(progressMd(), content.replace("hand-written prose", "worker rewrote the plan"))
    const text = await docsGuard("compare")
    expect(status(text)).toBe("status: violation")
    expect(text).toMatch(/Foreman-fenced file changed outside its fence: Docs\/PROGRESS\.md/)
  })

  it("T3: a PROGRESS.md created during the window is a change outside the brief", async () => {
    await fs.rm(progressMd())
    git(["commit", "-q", "-am", "no progress doc"])
    await docsBaseline()
    await fs.writeFile(progressMd(), "# worker-made\n")
    const text = await docsGuard("compare")
    expect(text).toMatch(/file changed outside the brief: Docs\/PROGRESS\.md/)
    expect(text).not.toMatch(/predates/)
  })

  it("T4b: a hand-malformed fence plus Foreman's appended block clears", async () => {
    await fs.writeFile(progressMd(), `# Plan\n${FENCE_START}\nprose after a stray start marker\n`)
    git(["commit", "-q", "-am", "stray marker"])
    await docsBaseline()
    await foremanWritesProgress()
    const text = await docsGuard("compare")
    expect(status(text), text).toBe("status: ok")
  })

  it("a worker planting a second fence is caught", async () => {
    await foremanWritesProgress()
    await docsBaseline()
    await fs.appendFile(progressMd(), `\n${FENCE_START}\n- [x] u1 — pass\n${FENCE_END}\n`)
    const text = await docsGuard("compare")
    expect(text).toMatch(/Foreman-fenced file gained a second fence: Docs\/PROGRESS\.md/)
  })

  it("T8: deleting PROGRESS.md during the window is a change outside its fence", async () => {
    await docsBaseline()
    await fs.rm(progressMd())
    const text = await docsGuard("compare")
    expect(status(text)).toBe("status: violation")
    expect(text).toMatch(/Foreman-fenced file changed outside its fence: Docs\/PROGRESS\.md/)
  })

  it("T6: state files and their writers' side files are excused; a bare *.tmp is not", async () => {
    await docsBaseline()
    for (const f of [
      ".foreman-seats.jsonl", ".foreman-events.jsonl", ".foreman-journal.json",
      ".foreman-ledger.json.corrupt.1725000000000", `.foreman-journal.json.${Date.now()}.0badf00d.tmp`,
    ]) await fs.writeFile(path.join(docsDir, f), "{}")
    expect(status(await docsGuard("compare"))).toBe("status: ok")
    await fs.writeFile(path.join(repoDir, "scratch.tmp"), "worker scratch")
    const text = await docsGuard("compare")
    expect(text).toMatch(/file changed outside the brief: scratch\.tmp/)
  })

  it("T6b: custom-named state files are excused with their side files, by path", async () => {
    const stateDir = path.join(repoDir, "state")
    await fs.mkdir(stateDir)
    const paths = {
      ledgerPath: path.join(stateDir, "ledger.json"), progressPath: path.join(stateDir, "progress.json"),
      journalPath: path.join(stateDir, "journal.json"), docsDir: stateDir,
    }
    await docsBaseline(paths)
    await fs.writeFile(path.join(stateDir, "progress.json"), "{}")
    await fs.writeFile(path.join(stateDir, "ledger.json.corrupt.1725000000000"), "{")
    await fs.writeFile(path.join(stateDir, `journal.json.${Date.now()}.0badf00d.tmp`), "{}")
    expect(status(await docsGuard("compare", {}, paths))).toBe("status: ok")
    await fs.mkdir(path.join(repoDir, "other"))
    await fs.writeFile(path.join(repoDir, "other", "ledger.json"), "{}")
    expect(await docsGuard("compare", {}, paths)).toMatch(/file changed outside the brief: other\/ledger\.json/)
  })

  it("0.6.24 (fifth field report): preparing the next brief with preflight_check while a worker window is open is not a violation", async () => {
    await fs.writeFile(path.join(docsDir, "spec.md"), "#### u1 — a\n- Edit `a` in a.ts.\n\n#### u2 — b\n- Edit `b` in b.ts.\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "spec"])
    await docsBaseline()
    // Foreman's own preflight record for the NEXT unit lands beside the ledger, inside the guarded tree.
    const text = await preflightCheck({ phase: "p1", unit_id: "u2", brief: "Edit `b` in b.ts as the spec says, twenty chars.", symbols: ["b"], repo_root: repoDir, spec_path: "Docs/spec.md" }, preflightPathFor(docsLedger), docsLedger)
    expect(text).toContain("status: pass")
    await expect(fs.stat(path.join(docsDir, ".foreman-preflight.jsonl"))).resolves.toBeTruthy()
    const compare = await docsGuard("compare")
    expect(status(compare), compare).toBe("status: ok")
  })

  it("T11b: the snapshot reports how many Foreman paths the exclusion covers, and says so when none do", async () => {
    const text = await docsBaseline()
    expect(text).toContain("foreman_files: 8")
    expect(text).toContain("changed_paths: 0")
    expect(text).not.toContain("note:")

    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "elsewhere-"))
    try {
      const out = await docsBaseline({
        ledgerPath: path.join(elsewhere, ".foreman-ledger.json"), progressPath: path.join(elsewhere, ".foreman-progress.json"),
        journalPath: path.join(elsewhere, ".foreman-journal.json"), docsDir: elsewhere,
      })
      expect(out).toContain("foreman_files: 0")
      expect(out).toMatch(/note: Foreman paths resolve outside this repository root/)
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })

  it("a scope spelled through a link (or an 8.3 short name) still covers the tree", async () => {
    const spellings: string[] = []
    const link = repoDir + "-link"
    await fs.symlink(repoDir, link, process.platform === "win32" ? "junction" : "dir")
    spellings.push(link)
    if (process.platform === "win32") {
      try {
        const short = execFileSync("cmd", ["/d", "/c", `for %I in ("${repoDir}") do @echo %~sI`], { encoding: "utf-8", windowsVerbatimArguments: true }).trim()
        if (short && short.toLowerCase() !== repoDir.toLowerCase()) spellings.push(short)
      } catch { /* 8.3 names disabled on this volume */ }
    }
    try {
      for (const spelled of spellings) {
        await fs.rm(docsLedger, { force: true })
        const paths = {
          ledgerPath: path.join(spelled, "Docs", ".foreman-ledger.json"), progressPath: path.join(spelled, "Docs", ".foreman-progress.json"),
          journalPath: path.join(spelled, "Docs", ".foreman-journal.json"), docsDir: path.join(spelled, "Docs"),
        }
        const snap = await docsBaseline(paths)
        expect(snap, spelled).toContain("foreman_files: 8")
        await foremanWritesProgress(paths)
        const text = await docsGuard("compare", {}, paths)
        expect(status(text), `${spelled}\n${text}`).toBe("status: ok")
      }
    } finally {
      await fs.rm(link, { recursive: true, force: true })
    }
  })

  it("the fence-aware fingerprint keeps wt whole and adds fwt; the snapshot carries its fenced list", async () => {
    await foremanWritesProgress()
    const out = await takeSnapshot(repoDir, [], [], undefined, foremanFileScope(serverPaths()))
    if (out.status !== "ok") throw new Error("expected ok")
    const entry = out.snapshot.entries.find((e) => e.path === "Docs/PROGRESS.md")!
    expect(entry.fenced).toBe(true)
    expect(entry.wt).toMatch(/^[0-9a-f]{16}$/)
    expect(entry.fwt).toBe(fencedFingerprint("# Plan\n\nhand-written prose\n"))
    expect(out.snapshot.fenced).toEqual(["Docs/PROGRESS.md"])
    // Without a scope: names-only exclusion, no fenced handling, no fenced list entries.
    const plain = await takeSnapshot(repoDir, [])
    if (plain.status !== "ok") throw new Error("expected ok")
    expect(plain.snapshot.entries.find((e) => e.path === "Docs/PROGRESS.md")?.fenced).toBeUndefined()
    expect(plain.snapshot.fenced).toEqual([])
  })

  describe("a baseline recorded before fence-aware guarding", () => {
    const scope = () => foremanFileScope(serverPaths())
    /** What a pre-0.6.20 server stored: no fenced list, no PROGRESS.md entry for a clean file, seats file counted. */
    function legacyOf(snapshot: RepoSnapshot, extra: RepoSnapshot["entries"] = []): RepoSnapshot {
      const { fenced: _drop, ...rest } = snapshot
      const entries = rest.entries
        .filter((e) => !(e.fenced && e.code === "  "))
        .map(({ fenced: _f, fwt: _w, ...e }) => e)
      return { ...rest, entries: [...entries, ...extra] }
    }

    it("compares an untouched PROGRESS.md clean, and a stale seats entry does not 'disappear'", async () => {
      const before = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (before.status !== "ok") throw new Error("expected ok")
      const legacy = legacyOf(before.snapshot, [{ path: "Docs/.foreman-seats.jsonl", code: "??", wt: "0123456789abcdef", idx: "none" }])
      expect(legacy.fenced).toBeUndefined()
      expect(legacy.entries.map((e) => e.path)).not.toContain("Docs/PROGRESS.md")
      await fs.writeFile(path.join(repoDir, "a.ts"), "export const a = 2\n")
      const after = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (after.status !== "ok") throw new Error("expected ok")
      const rel = await relativeScope(scope(), after.snapshot.root)
      expect(compareSnapshots(legacy, after.snapshot, rel)).toEqual([])
    })

    it("reports a write_progress in the window exactly as before, naming the cause", async () => {
      const before = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (before.status !== "ok") throw new Error("expected ok")
      const legacy = legacyOf(before.snapshot)
      await foremanWritesProgress()
      const after = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (after.status !== "ok") throw new Error("expected ok")
      const rel = await relativeScope(scope(), after.snapshot.root)
      const violations = compareSnapshots(legacy, after.snapshot, rel)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatch(/^file changed outside the brief: Docs\/PROGRESS\.md \(baseline predates fence-aware guarding/)
    })

    it("a dirty PROGRESS.md recorded with a full-content fingerprint: untouched is clean, overwritten is today's violation", async () => {
      await fs.appendFile(progressMd(), "user's uncommitted note\n")
      const before = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (before.status !== "ok") throw new Error("expected ok")
      const legacy = legacyOf(before.snapshot)
      expect(legacy.entries.find((e) => e.path === "Docs/PROGRESS.md")?.fenced).toBeUndefined()
      const rel = await relativeScope(scope(), before.snapshot.root)
      const untouched = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (untouched.status !== "ok") throw new Error("expected ok")
      expect(compareSnapshots(legacy, untouched.snapshot, rel)).toEqual([])
      await foremanWritesProgress()
      const written = await takeSnapshot(repoDir, [], ["a.ts"], undefined, scope())
      if (written.status !== "ok") throw new Error("expected ok")
      expect(compareSnapshots(legacy, written.snapshot, rel)[0]).toMatch(/^pre-existing uncommitted change overwritten outside the brief: Docs\/PROGRESS\.md \(baseline predates/)
    })
  })
})

// 0.6.27 (field report): committing the ledger every verdict and "nothing moves HEAD" are both
// right and they collided. A commit carries the paths it touched, so Foreman's own is attributable.
describe("a HEAD move Foreman itself made is attributable", () => {
  let repo: string
  const g = (a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  const rel = async () => relativeScope(foremanFileScope({
    ledgerPath: path.join(repo, "Docs", ".foreman-ledger.json"),
    progressPath: path.join(repo, "Docs", ".foreman-progress.json"),
    journalPath: path.join(repo, "Docs", ".foreman-journal.json"),
    docsDir: path.join(repo, "Docs"),
  }), repo)

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ff0911b-"))
    g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@e.com"]); g(["config", "user.name", "T"])
    g(["config", "commit.gpgsign", "false"]); g(["config", "core.autocrlf", "false"])
    await fs.mkdir(path.join(repo, "Docs"), { recursive: true })
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 1\n")
    await fs.writeFile(path.join(repo, "Docs", ".foreman-ledger.json"), '{"v":1,"ts":"t","phases":{}}')
    g(["add", "."]); g(["commit", "-q", "-m", "init"])
  })
  afterEach(async () => { await fs.rm(repo, { recursive: true, force: true }) })

  it("clears a commit whose whole range is Foreman-owned, and refuses one that touches source", async () => {
    const base = g(["rev-parse", "HEAD"])
    await fs.writeFile(path.join(repo, "Docs", ".foreman-ledger.json"), '{"v":1,"ts":"t2","phases":{}}')
    g(["add", "-A"]); g(["commit", "-q", "-m", "ledger"])
    expect(await attributeHeadMove(repo, base, g(["rev-parse", "HEAD"]), await rel())).toMatchObject({ attributable: true, commits: 1 })

    const mid = g(["rev-parse", "HEAD"])
    await fs.writeFile(path.join(repo, "app.ts"), "export const a = 2\n")
    g(["add", "-A"]); g(["commit", "-q", "-m", "src"])
    const r = await attributeHeadMove(repo, mid, g(["rev-parse", "HEAD"]), await rel())
    expect(r.attributable).toBe(false)
    expect((r as { reason: string }).reason).toContain("app.ts")
  })

  it("refuses anything that is not a plain advance — a reset has no ancestry path", async () => {
    const base = g(["rev-parse", "HEAD"])
    await fs.writeFile(path.join(repo, "Docs", ".foreman-ledger.json"), '{"v":1,"ts":"t3","phases":{}}')
    g(["add", "-A"]); g(["commit", "-q", "-m", "ledger"])
    const ahead = g(["rev-parse", "HEAD"])
    g(["reset", "-q", "--hard", base])
    const r = await attributeHeadMove(repo, ahead, g(["rev-parse", "HEAD"]), await rel())
    expect(r.attributable).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/does not descend from/)
  })
})
