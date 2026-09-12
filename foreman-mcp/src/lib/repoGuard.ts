/**
 * Repository guard (v0.6.10, reworked in v0.6.11) — the shared-tree ownership check,
 * executed by Foreman instead of described to the model.
 *
 * The implementor protocol has always required a before/after repository-state
 * comparison around every editing worker. Until 0.6.10 that was prose the pit-boss ran by
 * hand, holding the baseline in conversation context, where a compaction destroyed it
 * silently and a skipped check looked exactly like a passed one.
 *
 * 0.6.10 moved the commands into Foreman but compared PATH SETS, and an adversarial
 * review reproduced the consequence: a file that was already dirty before the worker ran
 * stayed dirty afterwards, so overwriting the user's uncommitted work returned `ok` —
 * precisely the loss the guard exists to prevent. That review also showed a failed git
 * probe reading as a clean tree, and the model re-taking the baseline or widening the
 * authorized file list until the comparison passed.
 *
 * This version fixes the model rather than the symptoms:
 *   - Every dirty path carries a CONTENT fingerprint for both the work tree and the
 *     index, so a change to an already-dirty file is visible.
 *   - Every git probe is checked for exit status, timeout, and output truncation. A
 *     failed probe is a refusal; it is never read as a clean tree.
 *   - The authorized file set is frozen at snapshot time, before the worker can act.
 *   - Paths are read NUL-delimited with untracked directories expanded and quoting off,
 *     so unicode names, spaces, subdirectories, and a literal " -> " in a filename all
 *     survive the round trip.
 *
 * Fail-open boundary: a directory that is not a git work tree, or a host with no git on
 * PATH, returns `n/a`. Consumer repos without git are legal and must keep working, the
 * same rule the .foremanenv refusal probe already follows. That is distinct from a git
 * command FAILING, which is a refusal.
 */

import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { runExternalCli } from "./externalCli.js"
import {
  DEFAULT_SCOPE, EMPTY_RELATIVE_SCOPE, PROGRESS_STATE_FILE, fenceBlocksOf, fencedFingerprint, isForemanStateFile, relativeScope,
  type ForemanFileScope, type RelativeScope,
} from "./foremanFiles.js"
import type { RepoEntry, RepoSnapshot } from "../types.js"

const GIT_TIMEOUT_MS = 10_000

/**
 * Changed paths retained per snapshot. Generous by default so ordinary work never hits
 * it, and raisable per call (repo_guard `max_entries`) up to ENTRY_CEILING for a genuinely
 * large change set — a fixed wall would refuse to guard the units that most need it.
 * Delegations cap at 20, which is what bounds ledger growth.
 */
export const MAX_ENTRIES = 500
/** Hard ceiling on a caller-raised entry limit. */
export const ENTRY_CEILING = 5000
/** Longest single path retained. */
export const MAX_PATH_LEN = 400
/** Most file arguments accepted for the line-ending probe. */
export const MAX_FILE_ARGS = 100
/** Files larger than this are fingerprinted by size alone. */
const MAX_HASH_BYTES = 8 * 1024 * 1024

// Foreman's own state files are written by Foreman during the unit, not by the worker;
// counting them as worker mutations made every real run report a violation. The set is
// lib/foremanFiles.ts (v0.6.20): the same names the writers import, so the guard and the
// writers cannot disagree, and nothing outside that set is excused. [CWE-863]

interface GitResult {
  ok: boolean
  out: string
  truncated: boolean
}

async function git(dir: string, args: string[], maxStdout?: number): Promise<GitResult> {
  const r = await runExternalCli("git", ["-C", dir, ...args], GIT_TIMEOUT_MS, maxStdout ? { maxStdout } : undefined)
  // Trailing whitespace only. `git status --porcelain` encodes status in the first two
  // columns, so a modified file's record begins with a space; trimming both ends would
  // eat it and every path would come back missing its first character.
  return { ok: r.exitCode === 0 && !r.timedOut, out: r.stdout.replace(/\s+$/, ""), truncated: r.truncated === true }
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

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * Parse `git status --porcelain -z -uall`. Records are NUL-separated and unquoted. A
 * rename or copy emits the destination record followed by a second record holding the
 * ORIGIN path, which must be consumed rather than read as an entry of its own — that
 * two-record shape is also why a filename containing a literal " -> " cannot be
 * misread here.
 */
export function parsePorcelainZ(out: string): Array<{ path: string; code: string }> {
  const records = out.split("\0").filter((r) => r.length > 0)
  const entries: Array<{ path: string; code: string }> = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (rec.length < 4) continue
    const code = rec.slice(0, 2)
    const p = rec.slice(3)
    if (code[0] === "R" || code[0] === "C") {
      const origin = records[++i]
      if (origin) entries.push({ path: normalizePath(origin), code: `${code[0]}<` })
    }
    entries.push({ path: normalizePath(p), code })
  }
  return entries
}

/** sha256 of a work-tree file, "absent" when it is gone, "big:<n>" past the hash cap. */
async function worktreeFingerprint(dir: string, rel: string): Promise<string> {
  try {
    const abs = path.join(dir, rel)
    const stat = await fs.stat(abs)
    if (stat.isDirectory()) return "dir"
    if (stat.size > MAX_HASH_BYTES) return `big:${stat.size}`
    const buf = await fs.readFile(abs)
    return createHash("sha256").update(buf).digest("hex").slice(0, 16)
  } catch {
    return "absent"
  }
}

/** Parse `git ls-files -s -z` records: "<mode> <sha> <stage>\t<path>". */
function parseLsFiles(out: string, into: Map<string, string>): void {
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t")
    if (tab === -1) continue
    const fields = rec.slice(0, tab).split(/\s+/)
    if (fields.length < 2) continue
    into.set(normalizePath(rec.slice(tab + 1)), fields[1].slice(0, 16))
  }
}

/**
 * Staged blob ids for the CHANGED paths only, in batches.
 *
 * v0.6.12: this used to list the whole index. `git ls-files -s` emits a row per tracked
 * file, so its output scales with repository size, not with the size of the change — it
 * passed every test here (13 KB against a 16 KB capture limit) and then failed on the
 * first larger repository in the field, refusing every snapshot with a truncation error.
 * Scoping to the changed paths keeps the output proportional to what is being compared.
 * The paths come from git's own status output and are passed after `--`, so they cannot
 * be read as options.
 */
/** Output budget for an inventory of `n` paths: a status/ls-files row plus slack. */
export function outputBudget(n: number): number {
  return Math.max(64_000, n * (MAX_PATH_LEN + 80))
}

async function stagedFingerprints(dir: string, paths: string[]): Promise<{ ok: boolean; map: Map<string, string> }> {
  const map = new Map<string, string>()
  if (paths.length === 0) return { ok: true, map }
  // Batched on accumulated argument length: a long command line is a hard failure on
  // Windows, and a large response would hit the same capture limit this call just fixed.
  const BATCH_ARG_CHARS = 4000
  let batch: string[] = []
  let chars = 0
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true
    const r = await git(dir, ["ls-files", "-s", "-z", "--", ...batch], outputBudget(batch.length))
    batch = []
    chars = 0
    if (!r.ok || r.truncated) return false
    parseLsFiles(r.out, map)
    return true
  }
  for (const p of paths) {
    if (chars + p.length > BATCH_ARG_CHARS && batch.length > 0) {
      if (!(await flush())) return { ok: false, map }
    }
    batch.push(p)
    chars += p.length + 1
  }
  if (!(await flush())) return { ok: false, map }
  return { ok: true, map }
}

export function snapshotHash(s: Omit<RepoSnapshot, "hash">): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16)
}

/**
 * NUL scan (0.6.26, field report 2026-09-11). The same crash that zeroed the ledger also
 * left a 46 KB source file as 46 KB of NUL bytes, and NOTHING noticed: the file still
 * exists, still has its size, still has its mtime, and `grep` on it reports a missing
 * SYMBOL rather than a missing file — so the pit-boss reads it as a code problem. It
 * surfaced hours later only because a mutation anchor that had matched stopped matching.
 *
 * A non-empty file that is entirely NUL is not a state any editor, compiler or formatter
 * produces; it is the signature of a write that reached the directory entry but not the
 * data blocks. The guard already knows the authorized set, so this costs one read of a
 * few KB per file — the scan stops at the first non-zero byte, which for real source is
 * byte 0.
 */
const ZERO_SCAN_CHUNK = 64 * 1024

export async function isZeroFilled(absPath: string): Promise<boolean> {
  let handle
  try {
    handle = await fs.open(absPath, "r")
    const stat = await handle.stat()
    // An empty file is not damage, and a directory is not a file.
    if (!stat.isFile() || stat.size === 0) return false
    const buf = Buffer.allocUnsafe(ZERO_SCAN_CHUNK)
    let read = 0
    while (read < stat.size && read < MAX_HASH_BYTES) {
      const { bytesRead } = await handle.read(buf, 0, ZERO_SCAN_CHUNK, read)
      if (bytesRead === 0) break
      for (let i = 0; i < bytesRead; i++) if (buf[i] !== 0) return false
      read += bytesRead
    }
    return read > 0
  } catch {
    return false   // unreadable or absent: not this check's business
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Every path in `files` whose bytes are entirely NUL. Bounded by the authorized-set cap. */
export async function zeroFilledFiles(dir: string, files: string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of files.slice(0, MAX_FILE_ARGS)) {
    if (await isZeroFilled(path.join(dir, f))) out.push(f)
  }
  return out
}

export type SnapshotOutcome =
  | { status: "n/a"; reason: string }
  | { status: "ok"; snapshot: RepoSnapshot; scope: RelativeScope; foreman_files: number; damaged: string[] }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string }

/**
 * Capture the repository state that defines shared-tree ownership. `files` scopes the
 * line-ending probe to the unit's files; `allowed` is the authorized set frozen onto the
 * snapshot. Any probe that fails, times out, or truncates makes the whole snapshot a
 * failure: an incomplete reading of the tree must never be recorded as a clean one.
 */
export async function takeSnapshot(
  dir: string,
  files: string[] = [],
  allowed: string[] = [],
  maxEntries: number = MAX_ENTRIES,
  scope: ForemanFileScope = DEFAULT_SCOPE
): Promise<SnapshotOutcome> {
  const entryLimit = Math.min(Math.max(Math.trunc(maxEntries) || MAX_ENTRIES, 1), ENTRY_CEILING)
  for (const f of [...files, ...allowed]) {
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

  const [root, head, branch, stashRef, stashList, status, autocrlf] = await Promise.all([
    git(dir, ["rev-parse", "--show-toplevel"]),
    git(dir, ["rev-parse", "HEAD"]),
    // symbolic-ref answers on an unborn branch, where rev-parse --abbrev-ref cannot.
    git(dir, ["symbolic-ref", "--short", "HEAD"]),
    git(dir, ["rev-parse", "--verify", "--quiet", "refs/stash"]),
    git(dir, ["stash", "list"]),
    git(dir, ["-c", "core.quotepath=false", "status", "--porcelain", "-z", "-uall"], outputBudget(entryLimit)),
    git(dir, ["config", "--get", "core.autocrlf"]),
  ])

  // A missing HEAD (no commits), a missing stash ref, and an unset config are STATES.
  // A failing toplevel, stash-list, or status is a failure to observe the tree.
  const failed = [
    ["rev-parse --show-toplevel", root],
    ["stash list", stashList],
    ["status --porcelain", status],
  ].find(([, r]) => !(r as GitResult).ok || (r as GitResult).truncated)
  if (failed) {
    const r = failed[1] as GitResult
    return {
      status: "failed",
      reason: r.truncated
        ? `git ${failed[0]} output exceeded the capture limit; the working tree has more changed paths than one comparison can cover — commit or ignore unrelated changes, then take the baseline again`
        : `git ${failed[0]} failed or timed out; the tree could not be read completely`,
    }
  }

  const eol = files.length > 0 ? await git(dir, ["ls-files", "--eol", "--", ...files]) : { ok: true, out: "", truncated: false }
  if (!eol.ok || eol.truncated) {
    return { status: "failed", reason: "git ls-files --eol failed or truncated; the line-ending state could not be read" }
  }

  const rel = await relativeScope(scope, root.out)
  const parsed = parsePorcelainZ(status.out).filter((e) => !isForemanStateFile(e.path, rel))
  const truncated = parsed.length > entryLimit
  const kept = parsed.slice(0, entryLimit)

  // Fenced files (Docs/PROGRESS.md): a tracked-clean one is synthesised into the entry list
  // so the after-write has a baseline to compare against. Synthesised entries do not count
  // toward the entry limit; there is at most one. Paths come from server config, never from
  // tool input, and go after `--` like every other path. [CWE-863]
  const keptPaths = new Set(kept.map((e) => e.path))
  const synthesised: Array<{ path: string; code: string }> = []
  for (const f of rel.fenced) {
    if (keptPaths.has(f)) continue
    try {
      const st = await fs.stat(path.join(dir, f))
      if (st.isDirectory()) continue
    } catch {
      continue // absent and not in the dirty set: nothing to fingerprint
    }
    synthesised.push({ path: f, code: "  " })
  }

  const stagedResult = await stagedFingerprints(dir, [...kept, ...synthesised].map((e) => e.path))
  if (!stagedResult.ok) {
    return { status: "failed", reason: "git ls-files -s failed, timed out, or truncated for the changed paths; the index could not be read" }
  }
  const staged = stagedResult.map

  const entries: RepoEntry[] = []
  for (const e of [...kept, ...synthesised]) {
    const entry: RepoEntry = {
      path: e.path.length > MAX_PATH_LEN ? `${e.path.slice(0, MAX_PATH_LEN)}…` : e.path,
      code: e.code,
      wt: await worktreeFingerprint(dir, e.path),
      idx: staged.get(e.path) ?? "none",
    }
    if (rel.fenced.has(e.path)) {
      entry.fenced = true
      // `wt` keeps its full-content meaning; `fwt` is the fence-stripped digest, present only
      // when the file was actually hashed (absent, dir, and big:<n> carry no fwt).
      if (/^[0-9a-f]{16}$/.test(entry.wt)) {
        entry.fwt = fencedFingerprint(await fs.readFile(path.join(dir, e.path), "utf-8"))
      }
    }
    entries.push(entry)
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // 0.6.20 (verifier [CWE-345]): the fence interior is excluded from the fingerprint, so a
  // worker could plant content inside it. A Foreman fence write always accompanies a
  // progress-state write; marking the state files lets compare demand that pairing.
  // Only the progress-state file is marked. Recording the snapshot itself rewrites the
  // ledger, so a ledger mark would move on every attempt and the check would never fire
  // (Codex review, 2026-09-10); write_progress is the only Foreman writer of the fence,
  // and it always rewrites the progress-state file in the same call.
  const marks: Record<string, string> = {}
  for (const p of [...rel.state].sort()) {
    if (path.basename(p) !== PROGRESS_STATE_FILE) continue
    try {
      marks[p] = createHash("sha256").update(await fs.readFile(path.join(dir, p))).digest("hex").slice(0, 16)
    } catch { /* absent state file: no mark */ }
  }

  const base = {
    root: normalizePath(root.out),
    branch: branch.ok && branch.out.length > 0 ? branch.out : "detached",
    head: head.ok ? head.out : "none",
    stash_ref: stashRef.ok && stashRef.out.length > 0 ? stashRef.out : "none",
    stash_count: stashList.out.length === 0 ? 0 : stashList.out.split(/\r?\n/).filter((l) => l.trim()).length,
    autocrlf: autocrlf.ok && autocrlf.out.length > 0 ? autocrlf.out : "unset",
    eol: eol.out.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, MAX_FILE_ARGS),
    entries,
    truncated,
    entry_limit: entryLimit,
    allowed: allowed.map(normalizePath).slice(0, MAX_FILE_ARGS),
    fenced: [...rel.fenced].sort(),
    marks,
  }
  return {
    status: "ok", snapshot: { ...base, hash: snapshotHash(base) }, scope: rel,
    foreman_files: rel.state.size + rel.fenced.size,
    // Kept OUT of the snapshot itself: the baseline hash identifies the tree state a
    // comparison is frozen against, and damage is an observation about it, not part of it.
    damaged: await zeroFilledFiles(dir, base.allowed),
  }
}

/**
 * Compare a stored snapshot against the live one and name every ownership breach.
 *
 * The authorized set comes from the SNAPSHOT, frozen before the worker ran, so widening
 * it afterwards cannot clear a violation. A path is compared on identity and on content:
 * a file that was already dirty and stays dirty is still a violation when its bytes or
 * its staged blob changed, which is how a worker overwriting the user's uncommitted work
 * is caught.
 */
export function compareSnapshots(before: RepoSnapshot, after: RepoSnapshot, rel: RelativeScope = EMPTY_RELATIVE_SCOPE): string[] {
  const violations: string[] = []
  const allowed = new Set((before.allowed ?? []).map(normalizePath))

  if (before.root !== after.root) {
    violations.push(`different repository: baseline was taken in '${before.root}', comparison ran in '${after.root}'`)
    return violations
  }
  if (before.branch !== after.branch) {
    violations.push(`branch changed: '${before.branch}' -> '${after.branch}'`)
  }
  if (before.head !== after.head) {
    violations.push(`HEAD moved: ${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)} (a worker must not commit, reset, or checkout)`)
  }
  if (before.stash_ref !== after.stash_ref || before.stash_count !== after.stash_count) {
    violations.push(`stash changed: ${before.stash_ref.slice(0, 12)}/${before.stash_count} entries -> ${after.stash_ref.slice(0, 12)}/${after.stash_count}`)
  }
  if (before.autocrlf !== after.autocrlf) {
    violations.push(`core.autocrlf changed: '${before.autocrlf}' -> '${after.autocrlf}'`)
  }
  if (before.truncated || after.truncated) {
    const limit = Math.max(before.entry_limit ?? MAX_ENTRIES, after.entry_limit ?? MAX_ENTRIES)
    violations.push(
      `more than ${limit} changed paths; the comparison is incomplete and cannot clear this unit ` +
      `(raise repo_guard max_entries, up to ${ENTRY_CEILING}, or reduce the unrelated changes in the tree)`
    )
  }

  // Both sides are read through the same filter, so a baseline recorded by a server that
  // predates the shared list (it may carry .foreman-seats.jsonl) cannot manufacture a
  // "disappeared" violation on upgrade.
  const b = new Map(before.entries.filter((e) => !isForemanStateFile(e.path, rel)).map((e) => [e.path, e]))
  const a = new Map(after.entries.filter((e) => !isForemanStateFile(e.path, rel)).map((e) => [e.path, e]))
  // A baseline taken before fence-aware guarding has no `fenced` list. It is compared exactly
  // as before (untouched -> clean, written -> today's violation), with the cause named.
  const legacyNote = before.fenced === undefined
    ? " (baseline predates fence-aware guarding; the next attempt's baseline excludes Foreman's fenced block)"
    : ""

  for (const [p, entry] of a) {
    if (allowed.has(p)) continue
    const was = b.get(p)
    if (rel.fenced.has(p)) {
      // Foreman-fenced file: Foreman's block write is exactly what turns "  " into " M", so
      // the status code is not compared when both sides carry a fence-aware entry.
      if (!was) {
        // Synthesised for a tracked-clean file nobody touched: the only way an after-entry
        // exists with no baseline entry and a clean status is a legacy baseline.
        if (entry.fenced && entry.code === "  ") continue
        violations.push(`file changed outside the brief: ${p}${legacyNote}`)
      } else if (was.fenced && entry.fenced) {
        const key = was.fwt !== undefined && entry.fwt !== undefined ? "fwt" : "wt"
        // 0.6.20: the interior changed but nothing outside the fence did. Foreman's own fence
        // write always changes a progress-state file too; if no state mark moved, the block
        // was written by something other than Foreman. [CWE-345]
        const stateMoved = before.marks === undefined || after.marks === undefined ||
          Object.keys({ ...before.marks, ...after.marks }).some((k) => before.marks![k] !== after.marks![k])
        if (key === "fwt" && was.fwt === entry.fwt && was.wt !== entry.wt && !stateMoved) {
          violations.push(`Foreman-fenced block changed with no Foreman progress write: ${p}`)
        } else if (was[key] !== entry[key]) {
          violations.push(
            key === "fwt" && fenceBlocksOf(entry.fwt!) > fenceBlocksOf(was.fwt!)
              ? `Foreman-fenced file gained a second fence: ${p}`
              : `Foreman-fenced file changed outside its fence: ${p}`
          )
        } else if (was.idx !== entry.idx) {
          violations.push(`staged content changed outside the brief: ${p}`)
        }
      } else if (was.wt !== entry.wt) {
        violations.push(`pre-existing uncommitted change overwritten outside the brief: ${p}${legacyNote}`)
      } else if (was.idx !== entry.idx) {
        violations.push(`staged content changed outside the brief: ${p}${legacyNote}`)
      } else if (was.code !== entry.code) {
        violations.push(`git status of a file outside the brief changed: ${p} (${was.code.trim()} -> ${entry.code.trim()})${legacyNote}`)
      }
      continue
    }
    if (!was) {
      violations.push(`file changed outside the brief: ${p}`)
    } else if (was.wt !== entry.wt) {
      violations.push(`pre-existing uncommitted change overwritten outside the brief: ${p}`)
    } else if (was.idx !== entry.idx) {
      violations.push(`staged content changed outside the brief: ${p}`)
    } else if (was.code !== entry.code) {
      violations.push(`git status of a file outside the brief changed: ${p} (${was.code.trim()} -> ${entry.code.trim()})`)
    }
  }
  for (const [p] of b) {
    // An authorized file may legitimately be restored to its committed content, which
    // removes it from the dirty set; that is the repair case, not a destroyed change.
    if (!a.has(p) && !allowed.has(p)) {
      violations.push(`pre-existing uncommitted change disappeared: ${p}`)
    }
  }
  return violations
}
