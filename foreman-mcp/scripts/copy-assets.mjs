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

const docsSrcDir = path.resolve(__dirname, "..", "src", "docs")
const docsDestDir = path.resolve(__dirname, "..", "dist", "docs")

await mkdir(docsDestDir, { recursive: true })
await cp(docsSrcDir, docsDestDir, { recursive: true })

// Sanity: confirm the bundled engineering-ethos doc landed.
for (const f of ["engineering-ethos.md"]) {
  await access(path.join(docsDestDir, f))
}
console.log(`[copy-assets] copied docs assets -> ${path.relative(process.cwd(), docsDestDir)}`)

// Ship the external aider harness next to the compiled tool: aiderWorker.js resolves
// the default harness path as path.join(__dirname, "aider_harness.py"), and __dirname
// is dist/tools at runtime (tsc outDir: dist, rootDir: src).
const harnessSrc = path.resolve(__dirname, "..", "scripts", "aider_harness.py")
const toolsDestDir = path.resolve(__dirname, "..", "dist", "tools")

await mkdir(toolsDestDir, { recursive: true })
await cp(harnessSrc, path.join(toolsDestDir, "aider_harness.py"))

// Sanity: confirm the harness landed.
await access(path.join(toolsDestDir, "aider_harness.py"))
console.log(`[copy-assets] copied aider harness -> ${path.relative(process.cwd(), path.join(toolsDestDir, "aider_harness.py"))}`)
