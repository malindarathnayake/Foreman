/**
 * Build step: remove dist/ before tsc runs.
 *
 * `tsc` never deletes outputs whose sources are gone, so a deleted tool would keep
 * shipping as a stale compiled module under the package's `files` whitelist. Cleaning
 * the exact output directory first makes the tarball reflect the current source only.
 */
import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, "..", "dist")

await rm(distDir, { recursive: true, force: true })
console.log(`[clean-dist] removed ${path.relative(process.cwd(), distDir) || "dist"}`)
