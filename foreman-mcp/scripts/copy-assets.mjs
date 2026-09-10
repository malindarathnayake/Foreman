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

// 0.6.20: saved Workflow scripts for the Claude Code host (claude_workflows_init copies them into the project).
const wfSrcDir = path.resolve(__dirname, "..", "src", "workflows")
const wfDestDir = path.resolve(__dirname, "..", "dist", "workflows")
await mkdir(wfDestDir, { recursive: true })
await cp(wfSrcDir, wfDestDir, { recursive: true })
for (const f of ["foreman-checkpoint-review.js", "foreman-design-panel.js", "foreman-triage.js"]) {
  await access(path.join(wfDestDir, f))
}
console.log(`[copy-assets] copied workflow scripts -> ${path.relative(process.cwd(), wfDestDir)}`)
