/**
 * Repository guard (v0.6.10) — the shared-tree ownership check, executed by Foreman
 * instead of described to the model.
 *
 * The implementor protocol has always required a before/after repository-state
 * comparison around every editing worker: capture branch, HEAD, stash, index, and dirty
 * paths before the spawn, compare after it, hard-stop on any mutation outside the brief.
 * Until now that was prose the pit-boss executed by hand, holding the "before" state in
 * conversation context. Two things went wrong with that: a compaction between the two
 * points silently destroyed the baseline, and nothing was recorded, so a skipped check
 * and a passed check looked identical afterwards.
 *
 * This module runs the commands and computes the comparison. The ledger stores the
 * snapshot on the delegation entry and refuses a pass verdict whose guard did not clear
 * (lib/ledger.ts). Foreman authors the result, so the check is a fact rather than an
 * attestation.
 *
 * Fail-open boundary: a directory that is not a git work tree, or a host with no git on
 * PATH, returns `n/a`. Consumer repos without git are legal and must keep working, the
 * same rule the .foremanenv refusal probe already follows.
 */

import { createHash } from "crypto"
import { runExternalCli } from "./externalCli.js"
import type { RepoSnapshot } from "../types.js"

const GIT_TIMEOUT_MS = 10_000

/** Paths kept per list. Delegations cap at 20, so this bounds the ledger's growth. */
export const MAX_PATHS = 50
/** Longest single path retained; longer ones are truncated with a marker. */
export const MAX_PATH_LEN = 400
/** Most file arguments accepted for the line-ending probe. */
export const MAX_FILE_ARGS = 100

async function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await runExternalCli("git", ["-C", dir, ...args], GIT_TIMEOUT_MS)
  // Trailing whitespace only. `git status --porcelain` encodes status in the first two
  // columns, so a modified file's line begins with a space; trimming both ends would eat
  // it and every path would come back missing its first character.
  return { ok: result.exitCode === 0 && !result.timedOut, out: result.stdout.replace(/\s+$/, "") }
}

/**
 * [CWE-88] File paths reach a git command line. A path beginning with `-` would be
 * parsed as an option (`--upload-pack=…` and friends), so every argument is validated
 * and the caller-supplied list is always placed after a `--` separator. Absolute paths
 * and parent escapes are refused as well: the guard describes files inside the brief,
 * never the wider filesystem.
 */
export function invalidPathReason(p: string): string | null {
  if (p.length === 0) return "empty path"
  if (p.length > MAX_PATH_LEN) return `path longer than ${MAX_PATH_LEN} characters`
  if (p.startsWith("-")) return "path starts with '-' and would be read as a git option"
  if (p.includes("\0") || p.includes("\n")) return "path contains a control character"
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\")) return "path is absolute"
  const parts = p.split(/[\\/]/)
  if (parts.some((seg) => seg === "..")) return "path escapes the project with '..'"
  return null
}

function cap(list: string[]): string[] {
  return list
    .slice(0, MAX_PATHS)
    .map((p) => (p.length > MAX_PATH_LEN ? `${p.slice(0, MAX_PATH_LEN)}…` : p))
}

function lines(out: string): string[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
}

/**
 * Same split, but leading whitespace is preserved: `git status --porcelain` encodes the
 * index and work-tree status in the first two columns, and a modified file's line starts
 * with a space (" M path"). Trimming it first silently ate one character of every path.
 */
function rawLines(out: string): string[] {
  return out.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/**
 * Path out of a `git status --porcelain` line. The first three characters are the two
 * status columns and their separator. Rename entries carry `old -> new`; the destination
 * is the path that now exists. Git quotes unusual names, and both sides of a comparison
 * quote identically, so the quoted form is compared as-is.
 */
export function porcelainPath(line: string): string {
  const body = line.length > 3 ? line.slice(3) : line.trim()
  const arrow = body.indexOf(" -> ")
  return (arrow === -1 ? body : body.slice(arrow + 4)).trim()
}

export function snapshotHash(s: Omit<RepoSnapshot, "hash">): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16)
}

export type SnapshotOutcome =
  | { status: "n/a"; reason: string }
  | { status: "ok"; snapshot: RepoSnapshot }
  | { status: "refused"; reason: string }

/**
 * Capture the repository state that defines shared-tree ownership. `files` scopes the
 * line-ending probe to the unit's files; it never widens what is inspected elsewhere.
 */
export async function takeSnapshot(dir: string, files: string[] = []): Promise<SnapshotOutcome> {
  for (const f of files) {
    const why = invalidPathReason(f)
    if (why) return { status: "refused", reason: `file '${f.slice(0, 120)}': ${why}` }
  }
  if (files.length > MAX_FILE_ARGS) {
    return { status: "refused", reason: `${files.length} files given; at most ${MAX_FILE_ARGS} are probed` }
  }

  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.out !== "true") {
    return { status: "n/a", reason: "not inside a git work tree (or git is unavailable); the guard does not apply" }
  }

  const [head, branch, stashRef, stashList, staged, status, autocrlf] = await Promise.all([
    git(dir, ["rev-parse", "HEAD"]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["rev-parse", "--verify", "--quiet", "refs/stash"]),
    git(dir, ["stash", "list"]),
    git(dir, ["diff", "--cached", "--name-only"]),
    git(dir, ["status", "--porcelain"]),
    git(dir, ["config", "--get", "core.autocrlf"]),
  ])

  // A repository with no commits yet has no HEAD; that is a state, not a failure.
  const eol = files.length > 0 ? await git(dir, ["ls-files", "--eol", "--", ...files]) : { ok: true, out: "" }

  const base = {
    branch: branch.ok ? branch.out : "unknown",
    head: head.ok ? head.out : "none",
    stash_ref: stashRef.ok && stashRef.out.length > 0 ? stashRef.out : "none",
    stash_count: stashList.ok ? lines(stashList.out).length : 0,
    staged: cap(lines(staged.out)),
    dirty: cap(rawLines(status.out).map(porcelainPath)),
    autocrlf: autocrlf.ok && autocrlf.out.length > 0 ? autocrlf.out : "unset",
    eol: cap(lines(eol.out)),
  }
  return { status: "ok", snapshot: { ...base, hash: snapshotHash(base) } }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^"|"$/g, "")
}

/**
 * Compare a stored snapshot against the live one and name every ownership breach.
 *
 * `allowedFiles` are the paths the brief authorized. A dirty path that appears inside
 * that set is the work itself. Anything else — a moved HEAD, a touched index, a changed
 * stash, a dirty path outside the brief, or a pre-existing dirty path that vanished — is
 * a mutation of state the user owns.
 */
export function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot, allowedFiles: string[]): string[] {
  const violations: string[] = []
  const allowed = new Set(allowedFiles.map(normalize))

  if (before.branch !== after.branch) {
    violations.push(`branch changed: '${before.branch}' -> '${after.branch}'`)
  }
  if (before.head !== after.head) {
    violations.push(`HEAD moved: ${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)} (a worker must not commit, reset, or checkout)`)
  }
  if (before.stash_ref !== after.stash_ref || before.stash_count !== after.stash_count) {
    violations.push(`stash changed: ref ${before.stash_ref.slice(0, 12)}/${before.stash_count} entries -> ${after.stash_ref.slice(0, 12)}/${after.stash_count}`)
  }
  if (before.autocrlf !== after.autocrlf) {
    violations.push(`core.autocrlf changed: '${before.autocrlf}' -> '${after.autocrlf}'`)
  }

  const stagedBefore = new Set(before.staged.map(normalize))
  const stagedAfter = new Set(after.staged.map(normalize))
  for (const p of stagedAfter) {
    if (!stagedBefore.has(p)) violations.push(`file staged by the worker: ${p}`)
  }
  for (const p of stagedBefore) {
    if (!stagedAfter.has(p)) violations.push(`file unstaged by the worker: ${p}`)
  }

  const dirtyBefore = new Set(before.dirty.map(normalize))
  const dirtyAfter = new Set(after.dirty.map(normalize))
  for (const p of dirtyAfter) {
    if (!dirtyBefore.has(p) && !allowed.has(p)) violations.push(`file changed outside the brief: ${p}`)
  }
  for (const p of dirtyBefore) {
    if (!dirtyAfter.has(p)) violations.push(`pre-existing uncommitted change disappeared: ${p}`)
  }

  // Truncation makes an absent path ambiguous rather than proven-clean; say so once
  // instead of reporting a difference the capped list cannot support.
  if (before.dirty.length >= MAX_PATHS || after.dirty.length >= MAX_PATHS) {
    violations.push(`dirty-path list hit the ${MAX_PATHS}-entry cap; the comparison is incomplete and cannot clear this unit`)
  }
  return violations
}
