import { spawn } from "child_process"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"

/**
 * Pure git-worktree primitives for the isolated-worktree -> diff apply model (unit 2a).
 *
 * This lib is deliberately self-contained: Node built-ins only, no logging, no
 * sidecar/ledger/tool coupling. It is consumed later by the aider_worker tool, which
 * will: snapshot a base commit, verify the target files are clean (R2 coherence),
 * create a detached worktree at that commit, hand it to aider, capture the resulting
 * working-tree diff, and tear the worktree down (best-effort, including crash
 * recovery via `reclaimOrphanWorktrees`).
 *
 * NOTE: `runExternalCli` (../lib/externalCli.ts) is intentionally NOT reused here —
 * it truncates captured stdout at 16 000 chars, which would silently corrupt a large
 * `git diff`. This module implements its own `runGit` with a caller-supplied byte cap
 * instead of a fixed character cap.
 */

export interface WorktreeHandle {
  path: string
  baseCommit: string
}

export type CleanTreeResult = { ok: true } | { ok: false; dirtyPaths: string[] }

export interface DiffResult {
  diff: string
  bytes: number
  truncated: boolean
}

const GIT_TIMEOUT_MS = 30000
const KILL_GRACE_MS = 5000

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
  /**
   * Total stdout bytes observed on the wire, even when the captured `stdout`
   * string was truncated to a cap. When a cap is hit mid-chunk, this counts the
   * FULL incoming chunk (not just the sliced-off remainder that was kept), so it
   * can legitimately exceed the requested cap -- that is the intended signal that
   * "the cap engaged partway through more data than the cap allowed."
   */
  stdoutBytes: number
}

/**
 * Runs `git [-C repoDir] ...args`, accumulating stdout as Buffers (never string
 * concatenation, so a byte cap can be enforced precisely regardless of multi-byte
 * UTF-8 boundaries at the truncation point). Enforces GIT_TIMEOUT_MS via SIGTERM then
 * SIGKILL after a short grace period. When opts.maxBytes is given and total stdout
 * exceeds it, the child is killed and only the bytes captured so far are decoded.
 */
function runGit(
  repoDir: string | null,
  args: string[],
  opts?: { maxBytes?: number }
): Promise<GitResult> {
  return new Promise((resolve) => {
    const fullArgs = repoDir ? ["-C", repoDir, ...args] : args
    const child = spawn("git", fullArgs, { stdio: ["ignore", "pipe", "pipe"] })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let truncated = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const maxBytes = opts?.maxBytes

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return
      if (maxBytes !== undefined && stdoutBytes + chunk.length > maxBytes) {
        const remaining = maxBytes - stdoutBytes
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining))
        }
        // Count the FULL chunk toward stdoutBytes (see GitResult.stdoutBytes doc) --
        // this intentionally can exceed maxBytes, signaling how much more data was
        // in flight when the cap engaged.
        stdoutBytes += chunk.length
        truncated = true
        try {
          child.kill()
        } catch {
          // Process may have already exited.
        }
        return
      }
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill("SIGTERM")
      } catch {
        // Process may have already exited.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // Process may have already exited.
        }
      }, KILL_GRACE_MS)
    }, GIT_TIMEOUT_MS)

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode,
        stdoutBytes,
      })
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ stdout: "", stderr: err.message, exitCode: -1, stdoutBytes: 0 })
    })

    child.on("close", (code: number | null) => {
      finish(code ?? 1)
    })
  })
}

/** `git rev-parse HEAD`, run with `-C repoDir`. Returns the trimmed 40-hex sha. */
export async function getBaseCommit(repoDir: string): Promise<string> {
  const result = await runGit(repoDir, ["rev-parse", "HEAD"])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git rev-parse HEAD failed (exit ${result.exitCode})`)
  }
  return result.stdout.trim()
}

/**
 * For each path, asserts it is (a) tracked and (b) has no staged/unstaged/untracked
 * changes -- i.e. on-disk content == HEAD blob (R2 coherence). Two checks per path:
 *
 *   - `git ls-files --error-unmatch -- <path>`: exit != 0 means untracked or
 *     nonexistent -> dirty.
 *   - `git status --porcelain -- <path>`: non-empty stdout means staged and/or
 *     unstaged and/or untracked changes -> dirty.
 *
 * A path is dirty if EITHER check flags it. `status --porcelain` alone catches
 * staged + unstaged + untracked changes in one pass, but a staged-add of a brand-new
 * file that is later removed from the index could otherwise slip through; combining
 * it with `ls-files --error-unmatch` (which independently catches "not tracked at
 * all") guarantees on-disk == HEAD is stronger than a bare `git diff --quiet`, which
 * would miss staged-but-working-tree-clean modifications entirely.
 */
export async function checkTrackedClean(repoDir: string, paths: string[]): Promise<CleanTreeResult> {
  const dirtyPaths: string[] = []
  const checked = new Map<string, boolean>() // path -> isDirty, avoids re-running git for dupes

  for (const p of paths) {
    if (!checked.has(p)) {
      const tracked = await runGit(repoDir, ["ls-files", "--error-unmatch", "--", p])
      const status = await runGit(repoDir, ["status", "--porcelain", "--", p])
      const isDirty = tracked.exitCode !== 0 || status.stdout.trim().length > 0
      checked.set(p, isDirty)
      if (isDirty) dirtyPaths.push(p)
    }
  }

  if (dirtyPaths.length > 0) {
    return { ok: false, dirtyPaths }
  }
  return { ok: true }
}

/**
 * sha256 (hex) of each file's raw bytes read from repoDir (clean on-disk content),
 * keyed by the path string exactly as passed in `files`.
 */
export async function computeBaseFileHashes(
  repoDir: string,
  files: string[]
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const f of files) {
    const bytes = await fs.readFile(path.join(repoDir, f))
    hashes[f] = createHash("sha256").update(bytes).digest("hex")
  }
  return hashes
}

/**
 * Creates a detached worktree at `baseCommit` under `<root>/<delegationId>`.
 * mkdirs the root (recursive) first, then runs:
 *   git -C repoDir worktree add --detach <root>/<delegationId> <baseCommit>
 */
export async function createWorktree(
  repoDir: string,
  root: string,
  delegationId: string,
  baseCommit: string
): Promise<WorktreeHandle> {
  await fs.mkdir(root, { recursive: true })
  const worktreePath = path.join(root, delegationId)

  const result = await runGit(repoDir, ["worktree", "add", "--detach", worktreePath, baseCommit])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git worktree add failed (exit ${result.exitCode})`)
  }

  return { path: worktreePath, baseCommit }
}

const DEFAULT_DIFF_MAX_BYTES = 2 * 1024 * 1024

/**
 * `git -C worktreePath diff -- <...files>` (unstaged working-tree diff; aider leaves
 * its edits uncommitted). Captured `diff` text is capped at maxBytes (default 2 MiB):
 * once exceeded, the child is killed, `truncated` is set true, and `diff` holds only
 * what was captured up to the cap. `bytes` is the total stdout bytes OBSERVED on the
 * wire (see GitResult.stdoutBytes) -- when truncation engages mid-chunk this can
 * exceed maxBytes, which is the intended signal that the cap actually engaged.
 */
export async function diffWorktree(
  worktreePath: string,
  files: string[],
  maxBytes: number = DEFAULT_DIFF_MAX_BYTES
): Promise<DiffResult> {
  const result = await runGit(worktreePath, ["diff", "--", ...files], { maxBytes })
  const truncated = result.stdoutBytes > maxBytes
  // [G] A truncation-kill legitimately produces a nonzero exit (the process was
  // SIGKILL'd mid-write), so only fail loud when NOT truncated -- otherwise a real
  // git-diff failure would silently collapse to an empty diff, which the caller
  // would misclassify as WORKER_GHOST instead of surfacing the actual git error.
  if (!truncated && result.exitCode !== 0) {
    throw new Error(`git diff failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return { diff: result.stdout, bytes: result.stdoutBytes, truncated }
}

/**
 * Best-effort teardown; NEVER throws.
 *   git -C repoDir worktree remove --force <worktreePath>
 *   git -C repoDir worktree prune
 * ok:true only if the remove succeeded (exit 0). On failure returns
 * { ok:false, error:<short git stderr> } instead of throwing.
 */
export async function teardownWorktree(
  repoDir: string,
  worktreePath: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const remove = await runGit(repoDir, ["worktree", "remove", "--force", worktreePath])
    if (remove.exitCode !== 0) {
      return { ok: false, error: remove.stderr.trim().slice(0, 500) }
    }
    await runGit(repoDir, ["worktree", "prune"])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Crash-recovery reclaim. Lists immediate child dirs of `root`; SKIPS any entry
 * whose name does not start with `dlg_` (the worktree-dir naming convention this
 * tool creates -- see [CWE-73] below); for each remaining entry whose directory
 * mtime is older than (now - maxAgeMs), removes it via
 * `git -C repoDir worktree remove --force <dir>` (falling back to a recursive
 * fs.rm if the git remove fails -- e.g. the worktree metadata is already gone),
 * then runs `git -C repoDir worktree prune` ONCE at the end. `now` defaults to
 * Date.now() and is injectable for deterministic tests. Best-effort; NEVER throws
 * (a nonexistent root returns { pruned: [] }).
 */
export async function reclaimOrphanWorktrees(
  repoDir: string,
  root: string,
  maxAgeMs: number,
  now: number = Date.now()
): Promise<{ pruned: string[] }> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return { pruned: [] }
  }

  const pruned: string[] = []
  const cutoff = now - maxAgeMs
  const resolvedRepoDir = path.resolve(repoDir)

  for (const entry of entries) {
    // [CWE-73] Restrict pruning to `dlg_`-named entries -- the naming convention
    // this tool creates worktree dirs under (`dlg_<hex>`, see aiderWorker.ts's
    // delegationId). This means a misconfigured `root` that happens to point at a
    // real, unrelated directory can never trigger arbitrary recursive deletion of
    // its children: anything not matching the convention is skipped outright,
    // before it is ever stat'd or handed to `git worktree remove` / `fs.rm`.
    if (!entry.startsWith("dlg_")) continue

    const dir = path.join(root, entry)
    const resolvedDir = path.resolve(dir)
    // Belt-and-suspenders: never touch repoDir itself or any of its ancestors, even
    // if a `dlg_`-prefixed name were ever to collide with it.
    if (resolvedDir === resolvedRepoDir || resolvedRepoDir.startsWith(resolvedDir + path.sep)) {
      continue
    }

    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) continue
      if (stat.mtimeMs > cutoff) continue

      const remove = await runGit(repoDir, ["worktree", "remove", "--force", dir])
      if (remove.exitCode !== 0) {
        try {
          await fs.rm(dir, { recursive: true, force: true })
        } catch {
          continue
        }
      }
      pruned.push(dir)
    } catch {
      // Best-effort: skip entries that can't be stat'd or removed.
      continue
    }
  }

  try {
    await runGit(repoDir, ["worktree", "prune"])
  } catch {
    // Best-effort only.
  }

  return { pruned }
}
