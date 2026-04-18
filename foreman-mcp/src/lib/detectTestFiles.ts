import fs from "fs/promises"
import path from "path"

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".git",
])

const MAX_DEPTH = 10
const MAX_FILES = 500

function isTestFile(basename: string): boolean {
  return (
    basename.endsWith(".test.ts") ||
    basename.endsWith(".test.js") ||
    basename.endsWith(".spec.ts") ||
    (basename.startsWith("test_") && basename.endsWith(".py")) ||
    basename.endsWith("_test.go") ||
    basename.endsWith("Test.java") ||
    basename.endsWith("Spec.scala")
  )
}

export async function detectTestFiles(projectRoot: string): Promise<string[]> {
  const results: string[] = []
  let truncated = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return
    if (depth > MAX_DEPTH) return

    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // skip unreadable dirs
    }

    for (const entry of entries) {
      if (truncated) return
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && isTestFile(entry.name)) {
        results.push(path.relative(projectRoot, full))
        if (results.length >= MAX_FILES) {
          truncated = true
          console.error(
            `[foreman detectTestFiles] capped at ${MAX_FILES} files; more may exist`
          )
          return
        }
      }
    }
  }

  await walk(projectRoot, 0)
  return results
}
