import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import { toKeyValue } from "../lib/toon.js"

export const CODEX_AGENT_ROLES = ["explorer", "worker"] as const
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
      model: input.models?.[role],
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
