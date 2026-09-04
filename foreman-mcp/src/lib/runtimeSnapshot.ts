import fs from "fs/promises"
import path from "path"

/**
 * What this process was started from, so bundle_status can answer "restart?" with a
 * comparison instead of "unknown" (field feedback 2026-09 round 4).
 *
 * Why stat, not hash: npm extracts a package with the extraction time as each file's
 * mtime (pacote unpacks with noMtime), and the build cleans dist/ before tsc rewrites
 * every emitted file, so size plus mtime moves on every reinstall or rebuild. Hashing
 * would add only the case of a copy that preserves timestamps, at the price of reading
 * mermaid's 3 MB on every start.
 *
 * Why the extras: the stack profile override is resolved once in createServer, so an
 * edit to it needs a restart even though no compiled file changed.
 */
export interface RuntimeSnapshot {
  version: string
  /** Real path of the package root: a junction retarget shows up as a root change. */
  root: string
  /** Relative posix path under the package root -> "size:mtimeMs", for dist/** and package.json. */
  files: Record<string, string>
  /** Absolute path -> "size:mtimeMs" or "absent", for files read once at startup outside dist/. */
  extras: Record<string, string>
}

export interface RestartVerdict {
  recommended: "true" | "false" | "n/a"
  reason: string
}

async function statKey(p: string): Promise<string | null> {
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return null
    return `${st.size}:${Math.trunc(st.mtimeMs)}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

async function walk(dir: string, root: string, out: Record<string, string>): Promise<void> {
  let entries: import("fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    // A missing dist/ is not a snapshot failure (tests run from src/); it is simply empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, root, out)
    } else if (entry.isFile()) {
      const key = path.relative(root, full).split(path.sep).join("/")
      const st = await fs.stat(full)
      out[key] = `${st.size}:${Math.trunc(st.mtimeMs)}`
    }
  }
}

export async function captureRuntimeSnapshot(opts: {
  packageRoot: string
  extraFiles?: string[]
}): Promise<RuntimeSnapshot> {
  const root = await fs.realpath(opts.packageRoot)
  const pkgRaw = await fs.readFile(path.join(root, "package.json"), "utf-8")
  const version = (JSON.parse(pkgRaw) as { version: string }).version
  const files: Record<string, string> = {}
  await walk(path.join(root, "dist"), root, files)
  const pkgKey = await statKey(path.join(root, "package.json"))
  if (pkgKey) files["package.json"] = pkgKey
  const extras: Record<string, string> = {}
  for (const extra of opts.extraFiles ?? []) {
    extras[extra] = (await statKey(extra)) ?? "absent"
  }
  return { version, root, files, extras }
}

export function compareRuntimeSnapshots(before: RuntimeSnapshot, after: RuntimeSnapshot): RestartVerdict {
  if (before.version !== after.version) {
    return {
      recommended: "true",
      reason: `runtime_disk_version ${after.version} differs from running_version ${before.version}`,
    }
  }
  if (before.root !== after.root) {
    return { recommended: "true", reason: `runtime root moved: ${before.root} -> ${after.root}` }
  }
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  const changed = [...keys].filter((k) => before.files[k] !== after.files[k]).sort()
  if (changed.length > 0) {
    const sample = changed.slice(0, 3).join(", ")
    const more = changed.length > 3 ? ` (+${changed.length - 3} more)` : ""
    return {
      recommended: "true",
      reason: `${changed.length} runtime file(s) changed on disk since startup: ${sample}${more}`,
    }
  }
  for (const [p, key] of Object.entries(before.extras)) {
    if (after.extras[p] !== key) {
      return { recommended: "true", reason: `${p} changed since startup (read once at process start)` }
    }
  }
  return {
    recommended: "false",
    reason: "compiled files, package.json, and startup-read files match the process-start snapshot",
  }
}
