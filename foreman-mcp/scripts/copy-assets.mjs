/**
 * Build step: copy non-TS preview assets into dist/.
 * `tsc` only emits compiled .ts -> .js, so the HTML/CSS/client-JS and the vendored
 * mermaid bundle would be missing from the published package without this.
 */
import { cp, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, "..", "src", "preview")
const destDir = path.resolve(__dirname, "..", "dist", "preview")

await mkdir(destDir, { recursive: true })
await cp(srcDir, destDir, { recursive: true })

// Sanity: confirm the heavy asset + template landed.
for (const f of ["template.html", "app.js", "style.css", "mermaid.min.js", "mermaid.LICENSE"]) {
  await access(path.join(destDir, f))
}
console.log(`[copy-assets] copied preview assets -> ${path.relative(process.cwd(), destDir)}`)
