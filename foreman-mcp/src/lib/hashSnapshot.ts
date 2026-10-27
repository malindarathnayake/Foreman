import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { DEFAULT_SCOPE, fencedFingerprint, isForemanStateFile, relativeScope, PROGRESS_STATE_FILE, type ForemanFileScope } from "./foremanFiles.js"
import { ENTRY_CEILING, MAX_ENTRIES, invalidPathReason, normalizePath, snapshotHash, zeroFilledFiles, type SnapshotOutcome } from "./repoGuard.js"
import type { RepoEntry, RepoSnapshot } from "../types.js"

/** Portable root-relative globs: *, ** and ?. No negations or directory escapes. */
export function exclusionPattern(glob: string): RegExp {
  if (invalidPathReason(glob) || /[!\[\]{}]/.test(glob)) throw new Error(`invalid exclude glob '${glob}'; use root-relative *, ** and ?`)
  const g = normalizePath(glob)
  let pattern = "^"
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "*" && g[i + 1] === "*") {
      i++
      if (g[i + 1] === "/") { pattern += "(?:.*/)?"; i++ } else pattern += ".*"
    } else if (g[i] === "*") pattern += "[^/]*"
    else if (g[i] === "?") pattern += "[^/]"
    else pattern += g[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(pattern + "$")
}

async function fileHash(file: string): Promise<string> {
  const handle = await fs.open(file, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) return hash.digest("hex")
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
}

export async function takeHashSnapshot(dir: string, allowed: string[], excludeGlobs: string[] = [], maxEntries = MAX_ENTRIES, scope: ForemanFileScope = DEFAULT_SCOPE): Promise<SnapshotOutcome> {
  try {
    for (const f of allowed) {
      const why = invalidPathReason(f)
      if (why) return { status: "refused", reason: `file '${f}': ${why}` }
    }
    const patterns = excludeGlobs.map(exclusionPattern)
    const excluded = (p: string) => patterns.some((r) => r.test(p) || r.test(p + "/"))
    if (allowed.some((f) => normalizePath(f).split("/").some((_, i, segments) => excluded(segments.slice(0, i + 1).join("/"))))) return { status: "refused", reason: "exclude_globs must not hide an authorized file or its parent" }
    const root = await fs.realpath(dir)
    for (const f of allowed) {
      let part = root
      for (const segment of normalizePath(f).split("/")) {
        part = path.join(part, segment)
        try { if ((await fs.lstat(part)).isSymbolicLink()) throw new Error(`authorized file traverses a link: ${f}`) }
        catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") break; throw err }
      }
    }
    const rel = await relativeScope(scope, root)
    const entries: RepoEntry[] = []
    const marks: Record<string, string> = {}
    const limit = Math.min(ENTRY_CEILING, Math.max(1, maxEntries))
    let visited = 0
    const walk = async (sub: string): Promise<void> => {
      for (const ent of (await fs.readdir(path.join(root, sub), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 100000) throw new Error("hash scan exceeded 100000 entries; narrow the tree with exclude_globs")
        const p = sub ? `${sub}/${ent.name}` : ent.name
        if (p === ".git" || excluded(p)) continue
        const abs = path.join(root, p)
        // Never follow symlinks or junctions out of the project; their targets are fingerprinted as link text.
        if (ent.isDirectory() && !ent.isSymbolicLink()) { await walk(p); continue }
        if (isForemanStateFile(p, rel)) {
          if (path.basename(p) === PROGRESS_STATE_FILE) marks[p] = await fileHash(abs)
          continue
        }
        if (entries.length >= limit) throw new Error(`more than ${limit} files in hash snapshot; raise max_entries or configure exclude_globs`)
        if (!ent.isFile() && !ent.isSymbolicLink()) throw new Error(`unsupported file type: ${p}`)
        const wt = ent.isSymbolicLink() ? `link:${await fs.readlink(abs)}` : await fileHash(abs)
        const entry: RepoEntry = { path: p, code: "  ", wt, idx: "none" }
        if (rel.fenced.has(p) && ent.isFile()) {
          entry.fenced = true
          entry.fwt = fencedFingerprint(await fs.readFile(abs, "utf8"))
        }
        entries.push(entry)
      }
    }
    await walk("")
    const base: Omit<RepoSnapshot, "hash"> = {
      mode: "hash", exclude_globs: [...excludeGlobs], root: normalizePath(root), branch: "n/a", head: "none", stash_ref: "none", stash_count: 0,
      autocrlf: "n/a", eol: [], entries, truncated: false, entry_limit: limit, allowed: allowed.map(normalizePath), fenced: [...rel.fenced].sort(), marks,
    }
    return { status: "ok", snapshot: { ...base, hash: snapshotHash(base) }, scope: rel, foreman_files: rel.state.size + rel.fenced.size, damaged: await zeroFilledFiles(root, base.allowed) }
  } catch (err) { return { status: "refused", reason: `hash snapshot incomplete: ${String(err)}` } }
}
