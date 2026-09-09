import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import { toKeyValue } from "../lib/toon.js"

export const CODEX_AGENT_ROLES = ["explorer", "worker_light", "worker", "worker_heavy", "reviewer", "verifier"] as const
export type CodexAgentRole = (typeof CODEX_AGENT_ROLES)[number]

export const CodexAgentsInitInputSchema = z.object({
  project_dir: z.string().min(1).optional(),
  max_threads: z.number().int().min(1).max(12).optional(),
  max_depth: z.number().int().min(1).max(3).optional(),
  roles: z.array(z.enum(CODEX_AGENT_ROLES)).min(1).optional(),
  overwrite: z.boolean().optional(),
  /** Optional per-role model pins. Omit to let Codex choose (preferred). */
  models: z
    .object({
      explorer: z.string().min(1).optional(),
      worker: z.string().min(1).optional(),
      worker_light: z.string().min(1).optional(),
      worker_heavy: z.string().min(1).optional(),
      reviewer: z.string().min(1).optional(),
      verifier: z.string().min(1).optional(),
    })
    .optional(),
})

export type CodexAgentsInitInput = z.infer<typeof CodexAgentsInitInputSchema>

const EXPLORER_INSTRUCTIONS = `Stay in exploration mode.
Trace the real execution path, cite files and symbols, and do not propose fixes unless asked.
Prefer fast search and targeted file reads over broad scans.
Never write files. Never produce a Foreman ledger verdict.`

const WORKER_INSTRUCTIONS = `Implement only the bounded worker brief you are given.
Do not read or request the full spec, ledger, or progress file.
Self-fix compile/import/type errors at most twice; return immediately on logic/spec issues.
Do not spawn further subagents (max_depth=1).`

/**
 * Default model per implementation seat, matching Foreman's existing cost tiers.
 * Every id below answered a live probe on codex-cli 0.153.4; note that the same family
 * at a different version does NOT resolve — gpt-6-terra and gpt-6-sol are both refused
 * on a ChatGPT account, so these are not interchangeable with a version bump. Override
 * per role with the models input when an id rotates.
 */
export const CODEX_SEAT_MODELS: Partial<Record<CodexAgentRole, string>> = {
  worker_light: "gpt-5.6-terra",
  worker: "gpt-5.6-sol",
  worker_heavy: "gpt-6-astra",
}

const WORKER_LIGHT_INSTRUCTIONS = `Implement one small, fully specified change.
You were chosen because the brief names the exact edit: a literal substitution, a rename, a
constant, a test name, an import path, or a mechanical repeat of a stated pattern.
If the brief turns out to require a judgement call, a new branch, or a design decision,
STOP and report that it needs a stronger seat rather than guessing.
` + WORKER_INSTRUCTIONS

const WORKER_HEAVY_INSTRUCTIONS = `Implement one demanding change that a smaller seat could not.
You were chosen for concurrency, migrations, error-handling semantics, public contracts, or a
unit that already failed at a lower tier — the brief says which.
Spend the extra reasoning on the failure modes, not on scope: the brief's file list still binds.
` + WORKER_INSTRUCTIONS

const REVIEWER_INSTRUCTIONS = `You are one adversarial reviewer on a Foreman review fan.
Answer ONLY the lens question you are given; findings from another lens are noise here.
Cite file:line for every finding, from code you actually opened. Never invent a symbol or a line.
Severity is blast radius, not confidence. Do not report style preferences at any severity.
Zero findings is a valid answer, but you must still list what you examined — silence with no
account of what was read is treated as a failed review, not an approval.
Never write files. Never spawn further subagents. Never produce a Foreman ledger verdict.`

const VERIFIER_INSTRUCTIONS = `You verify a Foreman review fan and write its single report.
The reviewers ran on the same model you are running on, so their findings are claims to test,
not evidence. Open every cited file:line and keep only what the code actually supports.
Classify each finding confirmed / rejected / unverified, re-rate severity by blast radius, and
merge duplicates across lenses. Prefer unverified over a guessed confirmation: a false
confirmation costs a remediation round, and an honest unknown costs a sentence.
The orchestrator sees your report and nothing the reviewers said, so a finding you drop is gone.
Never write files. Never spawn further subagents. Never produce a Foreman ledger verdict.`

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function agentsConfigBlock(maxThreads: number, maxDepth: number): string {
  return `[agents]\nmax_threads = ${maxThreads}\nmax_depth = ${maxDepth}\n`
}

function roleToml(opts: {
  name: CodexAgentRole
  description: string
  sandboxMode: "read-only" | "workspace-write"
  instructions: string
  model?: string
}): string {
  const lines: string[] = [
    `name = "${opts.name}"`,
    `description = "${escapeTomlString(opts.description)}"`,
  ]
  if (opts.model) {
    lines.push(`model = "${escapeTomlString(opts.model)}"`)
  }
  lines.push(`sandbox_mode = "${opts.sandboxMode}"`)
  lines.push(`developer_instructions = """`)
  lines.push(opts.instructions)
  lines.push(`"""`)
  lines.push("")
  return lines.join("\n")
}

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
    const st = await fs.stat(p)
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * Write Codex custom-agent role TOMLs (+ optional [agents] config) into a project.
 *
 * Safety rules:
 * - Never invent model slugs: model pins are optional caller overrides.
 * - Never clobber an existing `.codex/config.toml` — only create when absent;
 *   if present, return a merge hint for the [agents] block.
 * - Custom agent files named explorer/worker override Codex built-in roles of those names.
 */
export async function codexAgentsInit(raw: CodexAgentsInitInput): Promise<string> {
  const input = CodexAgentsInitInputSchema.parse(raw)
  const projectDir = path.resolve(input.project_dir ?? process.cwd())
  const maxThreads = input.max_threads ?? 6
  const maxDepth = input.max_depth ?? 1
  const roles = input.roles ?? [...CODEX_AGENT_ROLES]
  const overwrite = input.overwrite ?? false
  const warnings: string[] = []
  const written: string[] = []
  const skipped: string[] = []
  const hints: string[] = []

  if (!(await isDirectory(projectDir))) {
    return toKeyValue({
      status: "error",
      error: "project_dir_invalid",
      hint: `project_dir must exist and be a directory: ${projectDir}`,
    })
  }

  if (maxDepth > 1) {
    warnings.push(
      "max_depth>1 risks uncontrolled fan-out and token blowup; keep at 1 unless you have a specific reason"
    )
  }

  hints.push(
    "explorer.toml and worker.toml override Codex built-in roles of the same name (intended — pins sandbox_mode)"
  )
  if (roles.includes("reviewer") || roles.includes("verifier")) {
    hints.push(
      "reviewer/verifier are the review-fan roles: read-only, run in parallel under max_threads, and are a fallback for a missing advisor CLI — a same-model fan is perspective, never independence"
    )
  }

  const codexDir = path.join(projectDir, ".codex")
  const agentsDir = path.join(codexDir, "agents")
  await fs.mkdir(agentsDir, { recursive: true })

  // config.toml: create only when absent; never overwrite (may hold mcp_servers etc.)
  const configPath = path.join(codexDir, "config.toml")
  const agentsBlock = agentsConfigBlock(maxThreads, maxDepth)
  if (await pathExists(configPath)) {
    skipped.push(".codex/config.toml")
    const existing = await fs.readFile(configPath, "utf-8")
    const hasAgentsTable = /^\[agents\]/m.test(existing)
    if (!hasAgentsTable) {
      hints.push(
        `existing .codex/config.toml has no [agents] table — append manually:\n${agentsBlock.trimEnd()}`
      )
    } else {
      hints.push(
        "existing .codex/config.toml already has an [agents] table — left untouched; verify max_threads/max_depth"
      )
    }
  } else {
    await atomicWriteFile(configPath, agentsBlock)
    written.push(".codex/config.toml")
  }

  const roleSpecs: Record<
    CodexAgentRole,
    { description: string; sandboxMode: "read-only" | "workspace-write"; instructions: string }
  > = {
    explorer: {
      description: "Read-only explorer that maps code paths a change touches.",
      sandboxMode: "read-only",
      instructions: EXPLORER_INSTRUCTIONS,
    },
    worker: {
      description: "Execution-focused worker for bounded implementation units.",
      sandboxMode: "workspace-write",
      instructions: WORKER_INSTRUCTIONS,
    },
    worker_light: {
      description: "Small mechanical implementation seat for fully specified edits.",
      sandboxMode: "workspace-write",
      instructions: WORKER_LIGHT_INSTRUCTIONS,
    },
    worker_heavy: {
      description: "High-reasoning implementation seat for demanding or previously failed units.",
      sandboxMode: "workspace-write",
      instructions: WORKER_HEAVY_INSTRUCTIONS,
    },
    reviewer: {
      description: "Read-only adversarial reviewer for one risk lens of a review fan.",
      sandboxMode: "read-only",
      instructions: REVIEWER_INSTRUCTIONS,
    },
    verifier: {
      description: "Read-only verifier that re-derives fan findings from code and writes the report.",
      sandboxMode: "read-only",
      instructions: VERIFIER_INSTRUCTIONS,
    },
  }

  for (const role of roles) {
    const rel = `.codex/agents/${role}.toml`
    const abs = path.join(projectDir, rel)
    if ((await pathExists(abs)) && !overwrite) {
      skipped.push(rel)
      continue
    }
    const spec = roleSpecs[role]
    const body = roleToml({
      name: role,
      description: spec.description,
      sandboxMode: spec.sandboxMode,
      instructions: spec.instructions,
      model: input.models?.[role] ?? CODEX_SEAT_MODELS[role],
    })
    await atomicWriteFile(abs, body)
    written.push(rel)
  }

  return toKeyValue({
    status: "ok",
    project_dir: projectDir,
    max_threads: maxThreads,
    max_depth: maxDepth,
    files_written: written.join(",") || "none",
    files_skipped: skipped.join(",") || "none",
    warnings: warnings.join("; ") || "none",
    hints: hints.join("; "),
  })
}
