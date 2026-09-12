/**
 * claude_agents_init (0.6.28) — pin the implementation seat to a model on Claude Code.
 *
 * Foreman has always RECORDED the capability tier of every delegation (`tier` plus a
 * `route_reason`, types.ts: "Audit evidence, not a mechanical gate"). On Codex that tier is
 * also CONFIG: `codex_agents_init` writes `.codex/agents/<role>.toml` with a pinned model per
 * seat, so the pit-boss picks a role and the host binds the model. On Claude Code the host
 * profile carried one hardcoded line — `Use Agent tool with model: "sonnet"` — so every seat
 * was the same model and `tier: "premium"` was a promise the operator had to keep by hand,
 * re-stating it every session.
 *
 * Claude Code has the same mechanism Codex does: an agent definition in `.claude/agents/*.md`
 * carries its model in frontmatter. This writes the three implementation seats there, so the
 * tier resolves to a model the same way on both hosts.
 *
 * What this does NOT do: lock the model. The Agent tool's `model` argument takes precedence
 * over the definition's frontmatter, so a pit-boss can still pass something else. This makes
 * the correct model the DEFAULT rather than a rule to remember — the same guarantee Codex
 * gets, and strictly more than prose. The tier and route_reason on the delegation remain the
 * audit trail for what actually ran.
 */
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import fs from "fs/promises"
import { toKeyValue } from "../lib/toon.js"

export const CLAUDE_AGENT_ROLES = ["foreman-worker-light", "foreman-worker", "foreman-worker-heavy"] as const
export type ClaudeAgentRole = (typeof CLAUDE_AGENT_ROLES)[number]

export const ClaudeAgentsInitInputSchema = z.strictObject({
  project_dir: z.string().max(4096).optional(),
  roles: z.array(z.enum(CLAUDE_AGENT_ROLES)).min(1).optional(),
  /** Override the pinned model per role when an id rotates. Each key optional (z.record with an enum key is exhaustive in Zod 4). */
  models: z
    .object({
      "foreman-worker-light": z.string().min(1).max(100).optional(),
      "foreman-worker": z.string().min(1).max(100).optional(),
      "foreman-worker-heavy": z.string().min(1).max(100).optional(),
    })
    .optional(),
  overwrite: z.boolean().optional(),
})
export type ClaudeAgentsInitInput = z.infer<typeof ClaudeAgentsInitInputSchema>

/**
 * Default model per implementation seat, mapped onto Foreman's existing cost tiers.
 * `cheap` is a mechanical, fully-specified edit, which is what Haiku is for; `premium` is the
 * unit a smaller seat could not carry. Override with `models` — an operator who wants no Haiku
 * in the loop pins `foreman-worker-light` to sonnet and keeps the three seats distinct by
 * instruction rather than by model.
 */
export const CLAUDE_SEAT_MODELS: Record<ClaudeAgentRole, string> = {
  "foreman-worker-light": "haiku",
  "foreman-worker": "sonnet",
  "foreman-worker-heavy": "opus",
}

const SHARED = `Implement only the bounded worker brief you are given.
Do not read or request the full spec, ledger, or progress file.
Self-fix compile/import/type errors at most twice; return immediately on logic/spec issues.
Do not spawn further subagents.

Shared-Tree Safety — the repository state is user-owned. Run only read-only Git commands
(status, diff, log, show). NEVER run git stash, reset, checkout, switch, clean, add, commit,
merge, rebase, cherry-pick, worktree, or any command that changes the index, stash, refs,
branch, HEAD, or files outside the listed task. Do not "clean up" a dirty tree. If repository
state blocks the task, STOP and report it to the pit-boss unchanged.

Report back: the files you changed, the command you ran to validate, and anything in the brief
you could not do. Do not report success for work you did not verify.`

const SPECS: Record<ClaudeAgentRole, { description: string; instructions: string }> = {
  "foreman-worker-light": {
    description:
      "Foreman implementation seat, tier cheap. One small, fully specified change: a literal substitution, rename, constant, test name, import path, or a mechanical repeat of a stated pattern.",
    instructions: `Implement one small, fully specified change.
You were chosen because the brief names the exact edit: a literal substitution, a rename, a
constant, a test name, an import path, or a mechanical repeat of a stated pattern.
If the brief turns out to require a judgement call, a new branch, or a design decision,
STOP and report that it needs a stronger seat rather than guessing.

${SHARED}`,
  },
  "foreman-worker": {
    description:
      "Foreman implementation seat, tier standard. The default seat for ordinary implementation and for anything unclassifiable.",
    instructions: `Implement the bounded change the brief describes.
You are the default seat: ordinary implementation, and anything the pit-boss could not classify.
If the unit turns out to involve concurrency, a migration, error-handling semantics, a public
contract or a security path, say so in your report — it belongs at a heavier seat.

${SHARED}`,
  },
  "foreman-worker-heavy": {
    description:
      "Foreman implementation seat, tier premium. Concurrency, migrations, error-handling semantics, public contracts or schemas, security/authz paths, and any unit a lower seat already failed.",
    instructions: `Implement one demanding change that a smaller seat could not.
You were chosen for concurrency, migrations, error-handling semantics, public contracts, or a
unit that already failed at a lower tier — the brief says which.
Spend the extra reasoning on the failure modes, not on scope: the brief's file list still binds.

${SHARED}`,
  },
}

/** A `.claude/agents/<name>.md` definition: YAML frontmatter, then the instructions. */
export function agentMarkdown(name: string, description: string, model: string, instructions: string): string {
  // Quoted scalars so a description containing ':' cannot break the frontmatter.
  const esc = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return `---
name: ${name}
description: ${esc(description)}
model: ${model}
---

${instructions}
`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function claudeAgentsInit(raw: ClaudeAgentsInitInput): Promise<string> {
  const input = ClaudeAgentsInitInputSchema.parse(raw)
  const projectDir = path.resolve(input.project_dir ?? process.cwd())
  const roles = input.roles ?? [...CLAUDE_AGENT_ROLES]
  const overwrite = input.overwrite === true
  const written: string[] = []
  const skipped: string[] = []
  await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true })

  for (const role of roles) {
    const rel = `.claude/agents/${role}.md`
    const abs = path.join(projectDir, rel)
    if ((await pathExists(abs)) && !overwrite) {
      skipped.push(rel)
      continue
    }
    const spec = SPECS[role]
    const model = input.models?.[role] ?? CLAUDE_SEAT_MODELS[role]
    await atomicWriteFile(abs, agentMarkdown(role, spec.description, model, spec.instructions))
    written.push(rel)
  }

  const seats = roles.map((r) => `${r}=${input.models?.[r] ?? CLAUDE_SEAT_MODELS[r]}`).join(", ")
  return toKeyValue({
    status: "ok",
    project_dir: projectDir,
    seats,
    files_written: written.join(",") || "none",
    files_skipped: skipped.join(",") || "none",
    note:
      "Spawn with subagent_type: '<role>' and NO model argument — the definition's frontmatter binds the model. " +
      "An explicit model argument overrides it, so this is a binding default, not a lock; the delegation's tier and route_reason remain the record of what ran.",
    hints: skipped.length
      ? "existing definitions were left alone; pass overwrite: true to replace them"
      : "restart is not required — the host reads .claude/agents on each spawn",
  })
}
