import { describe, it, expect, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { execFileSync } from "node:child_process"
import { createHash } from "crypto"
import {
  getBaseCommit,
  checkTrackedClean,
  computeBaseFileHashes,
  createWorktree,
  diffWorktree,
  teardownWorktree,
  reclaimOrphanWorktrees,
} from "../src/lib/aiderWorktree.js"

// --- Fixture helpers -------------------------------------------------------------

let dirsToClean: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirsToClean.push(dir)
  return dir
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

/** Creates a fresh repo at a temp dir with one committed file. Returns { repoDir, filePath, content }. */
async function makeRepo(): Promise<{ repoDir: string; fileName: string; content: string }> {
  const repoDir = await makeTempDir("aiderworktree-repo-")
  git(repoDir, ["init", "-b", "main"])
  git(repoDir, ["config", "user.email", "t@t"])
  git(repoDir, ["config", "user.name", "t"])
  git(repoDir, ["config", "commit.gpgsign", "false"])
  // Disable EOL translation so committed/checked-out bytes are byte-identical
  // regardless of the host's global core.autocrlf -- required for exact content
  // and hash comparisons below (this host runs Windows with autocrlf=true).
  git(repoDir, ["config", "core.autocrlf", "false"])

  const fileName = "hello.txt"
  const content = "hello world\n"
  await fs.writeFile(path.join(repoDir, fileName), content, "utf-8")
  git(repoDir, ["add", fileName])
  git(repoDir, ["commit", "-m", "init"])

  return { repoDir, fileName, content }
}

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  dirsToClean = []
})

// --- getBaseCommit -----------------------------------------------------------------

describe("getBaseCommit", () => {
  it("returns a 40-hex sha equal to git rev-parse HEAD", async () => {
    const { repoDir } = await makeRepo()
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
      .toString("utf-8")
      .trim()

    const sha = await getBaseCommit(repoDir)

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(sha).toBe(expected)
  })
})

// --- checkTrackedClean ---------------------------------------------------------------

describe("checkTrackedClean", () => {
  it("returns ok:true for a clean tracked file", async () => {
    const { repoDir, fileName } = await makeRepo()
    const result = await checkTrackedClean(repoDir, [fileName])
    expect(result).toEqual({ ok: true })
  })

  it("flags a modified tracked file as dirty", async () => {
    const { repoDir, fileName } = await makeRepo()
    await fs.writeFile(path.join(repoDir, fileName), "modified content\n", "utf-8")

    const result = await checkTrackedClean(repoDir, [fileName])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.dirtyPaths).toEqual([fileName])
    }
  })

  it("flags a staged-but-working-clean modification as dirty (bare `git diff --quiet` would miss this)", async () => {
    const { repoDir, fileName } = await makeRepo()
    await fs.writeFile(path.join(repoDir, fileName), "staged content\n", "utf-8")
    git(repoDir, ["add", fileName])

    // Sanity: the working tree IS clean relative to the index (this is exactly the
    // case a bare `git diff --quiet` would miss, since that only compares
    // working-tree vs index, not index vs HEAD).
    const diffQuiet = () => {
      try {
        execFileSync("git", ["diff", "--quiet", "--", fileName], { cwd: repoDir })
        return true
      } catch {
        return false
      }
    }
    expect(diffQuiet()).toBe(true)

    const result = await checkTrackedClean(repoDir, [fileName])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.dirtyPaths).toEqual([fileName])
    }
  })

  it("flags an untracked file as dirty", async () => {
    const { repoDir } = await makeRepo()
    const untracked = "untracked.txt"
    await fs.writeFile(path.join(repoDir, untracked), "new file\n", "utf-8")

    const result = await checkTrackedClean(repoDir, [untracked])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.dirtyPaths).toEqual([untracked])
    }
  })

  it("flags a nonexistent path as dirty", async () => {
    const { repoDir } = await makeRepo()
    const result = await checkTrackedClean(repoDir, ["does-not-exist.txt"])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.dirtyPaths).toEqual(["does-not-exist.txt"])
    }
  })
})

// --- computeBaseFileHashes ------------------------------------------------------------

describe("computeBaseFileHashes", () => {
  it("matches an independently computed sha256 of the file bytes, keyed by input path", async () => {
    const { repoDir, fileName, content } = await makeRepo()

    const expectedHash = createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex")
    // Also verify against a direct re-read from disk (belt-and-suspenders vs `content`).
    const rereadBytes = await fs.readFile(path.join(repoDir, fileName))
    const expectedFromDisk = createHash("sha256").update(rereadBytes).digest("hex")
    expect(expectedHash).toBe(expectedFromDisk)

    const hashes = await computeBaseFileHashes(repoDir, [fileName])

    expect(Object.keys(hashes)).toEqual([fileName])
    expect(hashes[fileName]).toBe(expectedHash)
  })
})

// --- createWorktree --------------------------------------------------------------------

describe("createWorktree", () => {
  it("creates a detached worktree whose HEAD equals baseCommit and whose file content matches HEAD", async () => {
    const { repoDir, fileName, content } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)

    const handle = await createWorktree(repoDir, root, "delegation-1", baseCommit)

    expect(handle.path).toBe(path.join(root, "delegation-1"))
    expect(handle.baseCommit).toBe(baseCommit)

    const stat = await fs.stat(handle.path)
    expect(stat.isDirectory()).toBe(true)

    const worktreeHead = execFileSync("git", ["-C", handle.path, "rev-parse", "HEAD"])
      .toString("utf-8")
      .trim()
    expect(worktreeHead).toBe(baseCommit)

    const worktreeFileContent = await fs.readFile(path.join(handle.path, fileName), "utf-8")
    expect(worktreeFileContent).toBe(content)
  })
})

// --- diffWorktree -----------------------------------------------------------------------

describe("diffWorktree", () => {
  it("returns a diff with +/- lines and the file path after an edit, truncated:false", async () => {
    const { repoDir, fileName } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)
    const handle = await createWorktree(repoDir, root, "delegation-diff", baseCommit)

    await fs.writeFile(path.join(handle.path, fileName), "hello world, edited\n", "utf-8")

    const result = await diffWorktree(handle.path, [fileName])

    expect(result.truncated).toBe(false)
    expect(result.diff).toContain(fileName)
    expect(result.diff).toMatch(/^-hello world/m)
    expect(result.diff).toMatch(/^\+hello world, edited/m)
    expect(result.bytes).toBeGreaterThan(0)
  })

  it("returns an empty diff when there is no edit", async () => {
    const { repoDir, fileName } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)
    const handle = await createWorktree(repoDir, root, "delegation-nodiff", baseCommit)

    const result = await diffWorktree(handle.path, [fileName])

    expect(result.diff).toBe("")
    expect(result.truncated).toBe(false)
  })

  it("truncates and does not hang on a very large edit with a tiny maxBytes cap", async () => {
    const { repoDir, fileName } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)
    const handle = await createWorktree(repoDir, root, "delegation-huge", baseCommit)

    // A large edit so the resulting diff comfortably exceeds a tiny byte cap.
    const bigContent = "x".repeat(500_000) + "\n"
    await fs.writeFile(path.join(handle.path, fileName), bigContent, "utf-8")

    const tinyCap = 100
    const result = await diffWorktree(handle.path, [fileName], tinyCap)

    expect(result.truncated).toBe(true)
    expect(result.bytes).toBeGreaterThan(tinyCap)
  }, 15000)

  it("[FIX G] rejects (fails loud) when git diff exits nonzero on a nonexistent/non-git path", async () => {
    const bogusPath = path.join(os.tmpdir(), "definitely-not-a-git-worktree-xyz")

    await expect(diffWorktree(bogusPath, ["hello.txt"])).rejects.toThrow(/git diff failed/)
  })
})

// --- teardownWorktree ------------------------------------------------------------------

describe("teardownWorktree", () => {
  it("removes the worktree dir and returns ok:true; a second call returns ok:false without throwing", async () => {
    const { repoDir } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)
    const handle = await createWorktree(repoDir, root, "delegation-teardown", baseCommit)

    const first = await teardownWorktree(repoDir, handle.path)
    expect(first).toEqual({ ok: true })

    await expect(fs.access(handle.path)).rejects.toBeTruthy()

    const second = await teardownWorktree(repoDir, handle.path)
    expect(second.ok).toBe(false)
  })
})

// --- reclaimOrphanWorktrees ------------------------------------------------------------

describe("reclaimOrphanWorktrees", () => {
  it("prunes both worktrees when `now` is far in the future (both exceed maxAgeMs)", async () => {
    const { repoDir } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)

    const handle1 = await createWorktree(repoDir, root, "dlg_orphan1", baseCommit)
    const handle2 = await createWorktree(repoDir, root, "dlg_orphan2", baseCommit)

    const maxAgeMs = 1000
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365 // +1 year

    const result = await reclaimOrphanWorktrees(repoDir, root, maxAgeMs, farFuture)

    expect(result.pruned.sort()).toEqual([handle1.path, handle2.path].sort())
    await expect(fs.access(handle1.path)).rejects.toBeTruthy()
    await expect(fs.access(handle2.path)).rejects.toBeTruthy()
  })

  it("prunes nothing when `now` is current and maxAgeMs is large", async () => {
    const { repoDir } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")
    const baseCommit = await getBaseCommit(repoDir)

    const handle = await createWorktree(repoDir, root, "dlg_fresh1", baseCommit)

    const maxAgeMs = 1000 * 60 * 60 * 24 * 365 // 1 year
    const result = await reclaimOrphanWorktrees(repoDir, root, maxAgeMs, Date.now())

    expect(result.pruned).toEqual([])
    const stat = await fs.stat(handle.path)
    expect(stat.isDirectory()).toBe(true)
  })

  it("returns { pruned: [] } without throwing when root does not exist", async () => {
    const { repoDir } = await makeRepo()
    const nonexistentRoot = path.join(repoDir, "does-not-exist-root")

    const result = await reclaimOrphanWorktrees(repoDir, nonexistentRoot, 1000, Date.now())

    expect(result).toEqual({ pruned: [] })
  })

  it("[CWE-73] never prunes a non-`dlg_`-named entry, even when it is old enough", async () => {
    const { repoDir } = await makeRepo()
    const root = await makeTempDir("aiderworktree-root-")

    const strayDir = path.join(root, "not-a-worktree")
    await fs.mkdir(strayDir, { recursive: true })
    await fs.writeFile(path.join(strayDir, "keepme.txt"), "do not delete\n", "utf-8")

    const maxAgeMs = 1000
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365 // +1 year -- would otherwise exceed maxAgeMs

    const result = await reclaimOrphanWorktrees(repoDir, root, maxAgeMs, farFuture)

    expect(result.pruned).not.toContain(strayDir)
    const stat = await fs.stat(strayDir)
    expect(stat.isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(strayDir, "keepme.txt"), "utf-8")).toBe("do not delete\n")
  })
})
