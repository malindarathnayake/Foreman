/**
 * claude_workflows_init (0.6.20). Claude Code host only.
 *
 * Installs Foreman's saved Workflow scripts into the project's `.claude/workflows/` so the
 * host's Workflow tool can run them by name. The scripts ship with the package under
 * `workflows/` next to this module (src/ in development, dist/ when installed) and are
 * copied verbatim; an existing file is never overwritten unless `overwrite: true`.
 *
 * Why a separate init rather than shipping into the project on install: the workflows live
 * in the USER's project, and a Workflow run is a paid, user-approved action on the host.
 * Installing them is the pit-boss's explicit step, mirroring codex_agents_init on Codex.
 */
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import { toKeyValue } from "../lib/toon.js"

export const FOREMAN_WORKFLOWS = ["foreman-checkpoint-review", "foreman-design-panel", "foreman-triage"] as const
export type ForemanWorkflow = (typeof FOREMAN_WORKFLOWS)[number]

/** What each workflow is for and the args it takes; rendered in the tool result so the pit-boss can call it without reading the file. */
export const WORKFLOW_USAGE: Readonly<Record<ForemanWorkflow, string>> = {
  "foreman-checkpoint-review":
    "phase checkpoint review fan; args { phase, files: [...], spec_excerpt?, lenses? }; returns a record_review-ready report to persist with stage:'fan' (never a gate seat)",
  "foreman-design-panel":
    "design deliberation; args { question, context?, stances?, files? }; returns one recommendation plus conflicts the user arbitrates",
  "foreman-triage":
    "field-report triage; args { reports: [...], repo? }; verifies each report in code, designs and attacks a fix; implementation stays with the unit protocol",
}

export const ClaudeWorkflowsInitInputSchema = z.object({
  project_dir: z.string().min(1).optional(),
  workflows: z.array(z.enum(FOREMAN_WORKFLOWS)).min(1).optional(),
  overwrite: z.boolean().optional(),
})
export type ClaudeWorkflowsInitInput = z.infer<typeof ClaudeWorkflowsInitInputSchema>

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Bundled scripts: `workflows/` beside `tools/` in both src and dist layouts. */
export const BUNDLED_WORKFLOWS_DIR = path.resolve(__dirname, "..", "workflows")

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function claudeWorkflowsInit(raw: ClaudeWorkflowsInitInput, bundledDir = BUNDLED_WORKFLOWS_DIR): Promise<string> {
  const input = ClaudeWorkflowsInitInputSchema.parse(raw)
  const projectDir = path.resolve(input.project_dir ?? process.cwd())
  const names = input.workflows ?? [...FOREMAN_WORKFLOWS]
  const overwrite = input.overwrite ?? false
  if (!(await isDirectory(projectDir))) {
    return toKeyValue({ status: "error", error: "project_dir_invalid", hint: `project_dir must exist and be a directory: ${projectDir}` })
  }
  const written: string[] = []
  const skipped: string[] = []
  const missing: string[] = []
  for (const name of names) {
    const src = path.join(bundledDir, `${name}.js`)
    let body: string
    try {
      body = await fs.readFile(src, "utf-8")
    } catch {
      missing.push(name)
      continue
    }
    const rel = `.claude/workflows/${name}.js`
    const abs = path.join(projectDir, rel)
    if ((await pathExists(abs)) && !overwrite) {
      skipped.push(rel)
      continue
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await atomicWriteFile(abs, body)
    written.push(rel)
  }
  return toKeyValue({
    status: missing.length === names.length ? "error" : "ok",
    project_dir: projectDir,
    files_written: written.join(",") || "none",
    files_skipped: skipped.join(",") || "none",
    missing_bundled: missing.join(",") || "none",
    usage: names.filter((n) => !missing.includes(n)).map((n) => `${n}: ${WORKFLOW_USAGE[n]}`).join(" | "),
    hints:
      "Run a workflow with the host's Workflow tool by name (Workflow { name: '<name>', args: {...} }). " +
      "A run is a paid, user-approved action: confirm agent count and phases with the user first unless the session already opted in. " +
      "Every agent runs on the host's own model, so a review workflow's report is recorded stage:'fan' and never counts as a gate seat; " +
      "invoke_advisor seats on another vendor still satisfy the gate. Implementation never runs inside a workflow: units go through the unit protocol.",
  })
}
