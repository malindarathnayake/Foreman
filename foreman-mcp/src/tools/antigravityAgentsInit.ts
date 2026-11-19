/**
 * antigravity_agents_init (0.9.7) — write the Foreman seats for the Google Antigravity CLI (agy).
 *
 * agy loads custom subagents from `.agents/agents/<name>.md`: YAML frontmatter, then the system
 * prompt. The pit-boss spawns a seat with `invoke_subagent({ TypeName: "<name>", ... })` and no
 * `Model` argument, so the frontmatter `model:` tier word is the seat's model.
 *
 * Verified on agy 1.5.11 (probes 2026-11-18):
 * - `model:` accepts tier words only. A concrete id such as `gemini-4-hydrogen-xhigh` makes the
 *   seat fail to load ("subagent not found"), so this tool refuses to write one.
 * - flash served `gemini-4-hydrogen-tiered-high` and pro served `gemini-4-hydrogen-tiered-xhigh`,
 *   whatever the parent model was. The served model is read from the subagent transcript, never
 *   assumed from the tier word.
 * - The frontmatter `tools` allowlist isolates the seat: a seat with `tools: [read_file]`,
 *   `inheritMcp: false` and `inheritCustomizations: false` saw only read_file plus agy's own
 *   send_message and manage_task. Seats therefore cannot reach Foreman's MCP tools through
 *   agy's tool surface. Worker seats keep run_command, an unrestricted shell, so isolation from
 *   a nested agy or foreman-mcp process is behavioural (the discipline forbids starting one).
 *
 * Isolation lives entirely in the repo-local seat files, so an existing file is compared with
 * the template for its own tier word and reported as drift when it differs, rather than
 * silently kept.
 *
 * It also writes the per-repo bootstrap rule `.agents/rules/foreman.md`, because agy does not
 * inject MCP server instructions. Every write is confined to the project directory; this tool
 * never writes the user's `~/.gemini` configuration.
 */
import fs from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import { toKeyValue } from "../lib/toon.js"
import { seatReportEconomy } from "../lib/outputBudget.js"
import {
  ANTIGRAVITY_SERVED_MODELS,
  ANTIGRAVITY_TIER_WORDS,
  DEFAULT_WORKER_MODELS,
  WORKER_MODELS_FILE,
  antigravityTierForServedModel,
  configuredWorkerModels,
  isAntigravityTierWord,
  workerRoleTier,
} from "../lib/workerSeats.js"

export const ANTIGRAVITY_WORKER_ROLES = ["foreman-worker-light", "foreman-worker", "foreman-worker-heavy", "foreman-worker-frontier"] as const
export const ANTIGRAVITY_REVIEW_ROLES = ["foreman-reviewer", "foreman-verifier"] as const
export const ANTIGRAVITY_AGENT_ROLES = [...ANTIGRAVITY_WORKER_ROLES, ...ANTIGRAVITY_REVIEW_ROLES] as const
export type AntigravityAgentRole = (typeof ANTIGRAVITY_AGENT_ROLES)[number]
export type AntigravityTierWord = (typeof ANTIGRAVITY_TIER_WORDS)[number]

/**
 * agy built-in tool names per seat kind. A misspelled name can hang a subagent, so these are
 * the single source and the tests assert them exactly.
 */
export const ANTIGRAVITY_WORKER_TOOLS = ["read_file", "edit_file", "write_file", "run_command", "manage_task"] as const
export const ANTIGRAVITY_READONLY_TOOLS = ["read_file"] as const

/** Default tier word per seat. Reviewer and verifier run on the strongest tier. */
export const ANTIGRAVITY_SEAT_MODELS: Record<AntigravityAgentRole, AntigravityTierWord> = {
  "foreman-worker-light": DEFAULT_WORKER_MODELS.antigravity.cheap as AntigravityTierWord,
  "foreman-worker": DEFAULT_WORKER_MODELS.antigravity.standard as AntigravityTierWord,
  "foreman-worker-heavy": DEFAULT_WORKER_MODELS.antigravity.premium as AntigravityTierWord,
  "foreman-worker-frontier": DEFAULT_WORKER_MODELS.antigravity.frontier as AntigravityTierWord,
  "foreman-reviewer": "pro",
  "foreman-verifier": "pro",
}

export const ANTIGRAVITY_RULE_REL = ".agents/rules/foreman.md"

/** The per-repo bootstrap rule. It must stay under 1 KB; a test enforces that. */
export const ANTIGRAVITY_RULE_BODY = `---
trigger: always_on
---
Foreman (MCP server "foreman") is a spec-driven workflow harness. Use it only when the user asks for Foreman work or this repository has .foreman-ledger.json. Then call session_orient first (mcp_foreman_session_orient, or call_mcp_tool ServerName:"foreman" ToolName:"session_orient") and follow its action; the ledger, not chat history, is the source of truth. If you are a subagent (worker, reviewer or verifier), ignore this rule and do only your brief.
`

const modelOverride = z.string().min(1).max(100).optional()

export const AntigravityAgentsInitInputSchema = z.strictObject({
  project_dir: z.string().max(4096).optional(),
  roles: z.array(z.enum(ANTIGRAVITY_AGENT_ROLES)).min(1).optional(),
  /** Override the tier word per role. Only inherit, flash_lite, flash or pro are accepted. */
  models: z
    .object({
      "foreman-worker-light": modelOverride,
      "foreman-worker": modelOverride,
      "foreman-worker-heavy": modelOverride,
      "foreman-worker-frontier": modelOverride,
      "foreman-reviewer": modelOverride,
      "foreman-verifier": modelOverride,
    })
    .optional(),
  /** Also write `.agents/rules/foreman.md`. Defaults to true. */
  rule: z.boolean().optional(),
  overwrite: z.boolean().optional(),
})
export type AntigravityAgentsInitInput = z.infer<typeof AntigravityAgentsInitInputSchema>

/** Where the tool resolves the user's home, so the `~/.gemini` refusal is testable. */
export interface AntigravityAgentsInitEnv { home: string }

const WORKER_DISCIPLINE = `Implement only the bounded worker brief you are given.
Do not read or request the full spec, ledger, or progress file.
Self-fix compile, import and type errors at most twice; return immediately on logic or spec issues.
Never call Foreman tools and never spawn, define or invoke other agents.
Never start agy, gemini, claude, codex or foreman-mcp from run_command, and never edit files
under .agents/ (the seat definitions live there).

Shared-Tree Safety: the repository state is user-owned. Run only read-only Git commands
(status, diff, log, show). NEVER run git stash, reset, checkout, switch, clean, add, commit,
merge, rebase, cherry-pick, worktree, or any command that changes the index, stash, refs,
branch, HEAD, or files outside the listed task. Do not clean up a dirty tree. If repository
state blocks the task, STOP and report it to the pit-boss unchanged.

Report back: the files you changed, each command you ran to validate with its result lines,
and anything in the brief you could not do. Do not report success for work you did not verify.

${seatReportEconomy()}`

const REVIEWER_DISCIPLINE = `You are one adversarial reviewer in a native Foreman review.
The brief carries the full diff and the lens question; read_file is your only tool, so open the
files the diff touches to check context.
Answer ONLY the lens question you are given; findings from another lens are noise here.
Cite file:line for every finding, from code you actually opened. Never invent a symbol or a line.
Severity is blast radius, not confidence. Do not report style preferences at any severity.
Zero findings is a valid answer, but you must still list what you examined; silence with no
account of what was read is treated as a failed review, not an approval.
Return completion (complete/partial/failed), your lens, a non-empty checked list, findings and limitations.
Never write files. Never call Foreman tools. Never spawn other agents. Never produce a Foreman ledger verdict.

${seatReportEconomy()}`

const VERIFIER_DISCIPLINE = `You verify a native Foreman review and write its single report.
The brief carries the full diff and every reviewer report; read_file is your only tool.
The reviewers may run the same model you do, so their findings are claims to test, not evidence.
Open every cited file:line and keep only what the code actually supports.
Classify each finding confirmed / rejected / unverified, re-rate severity by blast radius, and
merge duplicates across lenses. Check every reviewer's completion and examined list; a missing,
failed, silent or partial reviewer makes the overall review incomplete. Include optional
external advisor claims when supplied, preserving their source. Prefer unverified over a guessed
confirmation. The orchestrator sees your report and nothing the reviewers said, so a finding you
drop is gone. Return completion, a non-empty checked list, classified findings and limitations.
Unresolved unverified findings require a partial result. Never claim cross-vendor independence
for native seats.
Never write files. Never call Foreman tools. Never spawn other agents. Never produce a Foreman ledger verdict.

${seatReportEconomy()}`

const SPECS: Record<AntigravityAgentRole, { description: string; heading: string; instructions: string }> = {
  "foreman-worker-light": {
    description: "Foreman implementation seat (cheap tier). One small, fully specified edit; no Foreman tools.",
    heading: "Foreman Worker (light)",
    instructions: `You were chosen because the brief names the exact edit: a literal substitution, a rename, a
constant, a test name, an import path, or a mechanical repeat of a stated pattern.
If the brief turns out to require a judgement call, a new branch, or a design decision,
STOP and report that it needs a stronger seat rather than guessing.

${WORKER_DISCIPLINE}`,
  },
  "foreman-worker": {
    description: "Foreman implementation seat (standard tier). Executes one brief; no Foreman tools.",
    heading: "Foreman Worker",
    instructions: `You are the default seat: ordinary implementation, and anything the pit-boss could not classify.
If the unit turns out to involve concurrency, a migration, error-handling semantics, a public
contract or a security path, say so in your report; it belongs at a heavier seat.

${WORKER_DISCIPLINE}`,
  },
  "foreman-worker-heavy": {
    description: "Foreman implementation seat (premium tier). Demanding or previously failed units; no Foreman tools.",
    heading: "Foreman Worker (heavy)",
    instructions: `You were chosen for concurrency, migrations, error-handling semantics, public contracts, or a
unit that already failed at a lower tier; the brief says which.
Spend the extra reasoning on the failure modes, not on scope: the brief's file list still binds.

${WORKER_DISCIPLINE}`,
  },
  "foreman-worker-frontier": {
    description: "Foreman implementation seat (frontier tier). Retry after a rejected premium attempt; no Foreman tools.",
    heading: "Foreman Worker (frontier)",
    instructions: `You retry a unit whose premium attempt was rejected. The brief carries the rejection history and an
advisor diagnosis; read them first and address the diagnosed cause, not only the symptom.

${WORKER_DISCIPLINE}`,
  },
  "foreman-reviewer": {
    description: "Foreman read-only reviewer for one lens of a native review. The brief carries the diff.",
    heading: "Foreman Reviewer",
    instructions: REVIEWER_DISCIPLINE,
  },
  "foreman-verifier": {
    description: "Foreman read-only verifier that tests native review findings and writes the report.",
    heading: "Foreman Verifier",
    instructions: VERIFIER_DISCIPLINE,
  },
}

function isWorkerRole(role: AntigravityAgentRole): boolean {
  return (ANTIGRAVITY_WORKER_ROLES as readonly string[]).includes(role)
}

/**
 * A `.agents/agents/<name>.md` definition. Values are plain YAML scalars: the descriptions
 * contain no `: ` or ` #`, and the model is always a tier word, so nothing needs quoting.
 */
export function antigravityAgentMarkdown(role: AntigravityAgentRole, model: AntigravityTierWord): string {
  const spec = SPECS[role]
  const tools = isWorkerRole(role) ? ANTIGRAVITY_WORKER_TOOLS : ANTIGRAVITY_READONLY_TOOLS
  return `---
name: ${role}
description: ${spec.description}
subagent: true
mainAgent: false
inheritCustomizations: false
inheritMcp: false
model: ${model}
tools: [${tools.join(", ")}]
---
# ${spec.heading}

${spec.instructions}
`
}

/**
 * Why an existing seat file is not the Foreman seat for `role`, or undefined when it matches
 * the template for its own `model:` tier word byte for byte (line endings aside). Any other
 * difference (inheritMcp, the tools list, extra keys such as agents or plugins, or an edited
 * discipline prompt) leaves the seat's isolation unverified.
 */
export function antigravitySeatDrift(role: AntigravityAgentRole, text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n")
  const header = /^---\n([\s\S]*?)\n---/.exec(normalized)?.[1]
  if (header === undefined) return "no frontmatter"
  const model = /^model:[ \t]*(\S+)[ \t]*$/m.exec(header)?.[1]
  if (model === undefined || !isAntigravityTierWord(model)) return "model is not a tier word"
  if (normalized !== antigravityAgentMarkdown(role, model as AntigravityTierWord)) return "differs from the Foreman template"
  return undefined
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p)
    return true
  } catch {
    return false
  }
}

/** Create `rel` under `root` and confirm its real path did not leave the root through a link. */
async function confinedDir(root: string, realRoot: string, rel: string): Promise<string> {
  // One segment at a time, so nothing is created beneath a link that leaves the root.
  let abs = root
  for (const segment of rel.split(/[\\/]/)) {
    abs = path.join(abs, segment)
    if (!(await pathExists(abs))) await fs.mkdir(abs)
    const real = await fs.realpath(abs)
    if (!within(realRoot, real)) throw new Error(`ANTIGRAVITY AGENTS: ${rel} resolves outside the project directory (${real}); refusing to write.`)
  }
  return abs
}

export async function antigravityAgentsInit(
  raw: AntigravityAgentsInitInput,
  env: AntigravityAgentsInitEnv = { home: os.homedir() }
): Promise<string> {
  const input = AntigravityAgentsInitInputSchema.parse(raw)
  const projectDir = path.resolve(input.project_dir ?? process.cwd())
  const roles = input.roles ?? [...ANTIGRAVITY_AGENT_ROLES]
  const overwrite = input.overwrite === true

  let realRoot: string
  try {
    if (!(await fs.stat(projectDir)).isDirectory()) throw new Error("not a directory")
    realRoot = await fs.realpath(projectDir)
  } catch {
    return toKeyValue({ status: "error", error: "project_dir_invalid", hint: `project_dir must exist and be a directory: ${projectDir}` })
  }
  // The user's agy configuration is never Foreman's to write, even when asked to.
  const geminiHome = path.resolve(env.home, ".gemini")
  let realGemini = geminiHome
  try { realGemini = await fs.realpath(geminiHome) } catch { /* absent: compare the plain path */ }
  if (within(geminiHome, projectDir) || within(realGemini, realRoot)) {
    return toKeyValue({ status: "error", error: "project_dir_refused", hint: `antigravity_agents_init never writes under ${geminiHome}; pass the repository root as project_dir.` })
  }

  // Refuse concrete model ids before any file is written: agy drops an agent whose model is one.
  for (const [role, model] of Object.entries(input.models ?? {})) {
    if (model !== undefined && !isAntigravityTierWord(model)) {
      return toKeyValue({
        status: "error",
        error: "model_not_tier_word",
        hint: `models.${role} = "${model}" is not an agy tier word. Use one of ${ANTIGRAVITY_TIER_WORDS.join(", ")}; a concrete model id in an agent file makes the seat fail to load.`,
      })
    }
  }

  const mapping = await configuredWorkerModels(projectDir, "antigravity")
  // A concrete mapping id becomes the verdict's required worker_model, compared exactly with the
  // transcript's served model. Only a measured served id can ever match, so refuse any other
  // before a file is written, and write the tier word that serves a measured one.
  const mappedTierWord: Partial<Record<AntigravityAgentRole, AntigravityTierWord>> = {}
  for (const role of roles) {
    const tier = workerRoleTier(role)
    const mapped = tier ? mapping[tier] : undefined
    if (mapped === undefined || isAntigravityTierWord(mapped)) continue
    const word = antigravityTierForServedModel(mapped) as AntigravityTierWord | undefined
    if (word === undefined) {
      const served = Object.entries(ANTIGRAVITY_SERVED_MODELS).map(([w, id]) => `${id} (${w})`).join(", ")
      return toKeyValue({
        status: "error",
        error: "mapping_not_enforceable",
        hint: `${WORKER_MODELS_FILE} pins ${tier} to "${mapped}". The verdict requires worker_model to equal that id exactly, and agy serves only ${served}, so no ${tier} unit could ever pass. Use a tier word (${ANTIGRAVITY_TIER_WORDS.join(", ")}) or one of the served ids.`,
      })
    }
    const override = input.models?.[role]
    if (override !== undefined && override !== word) {
      return toKeyValue({
        status: "error",
        error: "mapping_conflict",
        hint: `${WORKER_MODELS_FILE} pins ${tier} to "${mapped}", which agy serves from "${word}", but models.${role} is "${override}". Remove one of them.`,
      })
    }
    mappedTierWord[role] = word
  }

  const warnings: string[] = []
  const written: string[] = []
  const skipped: string[] = []
  const drift: string[] = []
  const seats: string[] = []

  const agentsDir = await confinedDir(projectDir, realRoot, path.join(".agents", "agents"))
  for (const role of roles) {
    const tier = workerRoleTier(role)
    const mapped = tier ? mapping[tier] : undefined
    let model: AntigravityTierWord = (input.models?.[role] as AntigravityTierWord | undefined) ?? ANTIGRAVITY_SEAT_MODELS[role]
    if (input.models?.[role] === undefined && mapped !== undefined && isAntigravityTierWord(mapped)) model = mapped as AntigravityTierWord
    const servedBy = mappedTierWord[role]
    if (servedBy !== undefined) {
      model = servedBy
      warnings.push(`${WORKER_MODELS_FILE} pins ${role} to the served id "${mapped}"; wrote "${model}", which serves it, and the verdict requires the transcript model to equal "${mapped}"`)
    }
    seats.push(`${role}=${model}`)
    const rel = `.agents/agents/${role}.md`
    const abs = path.join(agentsDir, `${role}.md`)
    if ((await pathExists(abs)) && !overwrite) {
      skipped.push(rel)
      let reason: string | undefined
      try { reason = antigravitySeatDrift(role, await fs.readFile(abs, "utf8")) } catch { reason = "unreadable" }
      if (reason) drift.push(`${rel} (${reason})`)
      continue
    }
    await atomicWriteFile(abs, antigravityAgentMarkdown(role, model))
    written.push(rel)
  }

  if (input.rule !== false) {
    const rulesDir = await confinedDir(projectDir, realRoot, path.join(".agents", "rules"))
    const abs = path.join(rulesDir, "foreman.md")
    if ((await pathExists(abs)) && !overwrite) skipped.push(ANTIGRAVITY_RULE_REL)
    else {
      await atomicWriteFile(abs, ANTIGRAVITY_RULE_BODY)
      written.push(ANTIGRAVITY_RULE_REL)
    }
  }

  return toKeyValue({
    status: "ok",
    project_dir: projectDir,
    seats: seats.join(", "),
    files_written: written.join(",") || "none",
    files_skipped: skipped.join(",") || "none",
    seat_drift: drift.join(", ") || "none",
    ...(drift.length ? {
      isolation: "unverified for the drifted seats: they are not Foreman seats and must not be spawned until rewritten with overwrite: true",
    } : {}),
    warnings: warnings.join("; ") || "none",
    note:
      "New agent files load in a new agy session. " +
      "Spawn with invoke_subagent({ TypeName: \"<role>\", Prompt: \"<brief>\", Workspace: \"inherit\" }) and no Model argument: the tier word in the file is the seat. " +
      "Record the served model from the \"model\" field of the transcript at the returned logAbsoluteUri, never from the tier word. " +
      "Seats are isolated by their tools allowlist with inheritMcp and inheritCustomizations off, so they cannot reach Foreman's MCP tools through agy; worker seats keep run_command, and their discipline forbids starting agy, foreman-mcp or another agent CLI from it. " +
      "For the global bootstrap rule, copy .agents/rules/foreman.md to ~/.gemini/config/rules/foreman.md yourself; Foreman never writes ~/.gemini.",
    hints: drift.length
      ? "drifted seat files were left alone; review them, then pass overwrite: true to restore the Foreman seats"
      : skipped.length ? "existing files were left alone; pass overwrite: true to replace them" : "none",
  })
}
