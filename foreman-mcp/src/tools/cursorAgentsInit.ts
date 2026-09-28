/**
 * cursor_agents_init (0.6.31) — pin the implementation seat on the Cursor host.
 *
 * Same job as claude_agents_init (0.6.28) and the Codex seat TOMLs: Foreman already
 * RECORDS a delegation's tier and route_reason as audit evidence, but the Cursor
 * profile carried one hardcoded line — Task + generalPurpose + a model slug that
 * rotated out from under it — so every seat was the same model and `tier: "premium"`
 * was a promise the operator kept by hand.
 *
 * Cursor custom subagents are markdown files with YAML frontmatter in
 * `.cursor/agents/`. Cursor also loads `.claude/agents/` for compatibility, but those
 * files pin Claude Code aliases (`sonnet`, `opus`) and a separate `effort:` key that
 * is not Cursor's model syntax. This tool writes Cursor-native files so a dual-host
 * repo can keep both trees: `.cursor/` wins on name collision, Claude Code keeps its
 * own definitions.
 *
 * Default model is `inherit` (the pit-boss's model). Cursor model ids rotate, and a
 * guessed slug would reproduce the stale-hardcode bug this exists to remove. Override
 * per role with `models` when the operator has a verified id (`composer-2.5[]`,
 * `claude-opus-5[effort=high]`). The Task tool's `model` argument still overrides
 * frontmatter, so this is a binding DEFAULT, not a lock. The delegation's tier and
 * route_reason remain the record of what actually ran.
 *
 * Frontmatter keys are the documented Cursor set only: name, description, model.
 * `effort` is a Claude Code key; emitting it here would either be ignored or, if the
 * host later strict-parses, an error. Cursor encodes effort in the model id.
 */
import path from "path"
import { z } from "zod"
import { atomicWriteFile } from "../lib/atomicWrite.js"
import fs from "fs/promises"
import { toKeyValue } from "../lib/toon.js"
import { seatReportEconomy } from "../lib/outputBudget.js"

export const CURSOR_AGENT_ROLES = ["foreman-worker-light", "foreman-worker", "foreman-worker-heavy"] as const
export type CursorAgentRole = (typeof CURSOR_AGENT_ROLES)[number]

/** Cursor's documented portable default: use the parent agent's model. */
export const CURSOR_INHERIT_MODEL = "inherit"

export const CursorAgentsInitInputSchema = z.strictObject({
  project_dir: z.string().max(4096).optional(),
  roles: z.array(z.enum(CURSOR_AGENT_ROLES)).min(1).optional(),
  /** Override the pinned model per role when an id is verified. Each key optional. */
  models: z
    .object({
      "foreman-worker-light": z.string().min(1).max(100).optional(),
      "foreman-worker": z.string().min(1).max(100).optional(),
      "foreman-worker-heavy": z.string().min(1).max(100).optional(),
    })
    .optional(),
  overwrite: z.boolean().optional(),
})
export type CursorAgentsInitInput = z.infer<typeof CursorAgentsInitInputSchema>

export const CURSOR_SEAT_MODELS: Record<CursorAgentRole, string> = {
  "foreman-worker-light": CURSOR_INHERIT_MODEL,
  "foreman-worker": CURSOR_INHERIT_MODEL,
  "foreman-worker-heavy": CURSOR_INHERIT_MODEL,
}

const SHARED = `Implement only the bounded worker brief you are given.
Do not read or request the full spec, ledger, or progress file.
Self-fix compile/import/type errors at most twice; return immediately on logic/spec issues.
Do not spawn further subagents.
Do not call Foreman write tools (write_ledger, write_progress, write_journal).

Shared-Tree Safety — the repository state is user-owned. Run only read-only Git commands
(status, diff, log, show). NEVER run git stash, reset, checkout, switch, clean, add, commit,
merge, rebase, cherry-pick, worktree, or any command that changes the index, stash, refs,
branch, HEAD, or files outside the listed task. Do not "clean up" a dirty tree. If repository
state blocks the task, STOP and report it to the pit-boss unchanged.

Report back: the files you changed, the command you ran to validate, and anything in the brief
you could not do. Do not report success for work you did not verify.

${seatReportEconomy()}`

const SPECS: Record<CursorAgentRole, { description: string; instructions: string }> = {
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

/**
 * A `.cursor/agents/<name>.md` definition: YAML frontmatter, then the instructions.
 *
 * Documented Cursor keys: name, description, model, readonly, is_background.
 * Foreman emits name, description, model. Model is always a quoted scalar: Cursor ids
 * carry brackets (`claude-opus-5[effort=high]`) that YAML would otherwise parse as a
 * nested structure. `effort` is a Claude Code key and is never written here.
 */
export function cursorAgentMarkdown(
  name: string, description: string, model: string, instructions: string
): string {
  const esc = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  return `---
name: ${name}
description: ${esc(description)}
model: ${esc(model)}
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

export async function cursorAgentsInit(raw: CursorAgentsInitInput): Promise<string> {
  const input = CursorAgentsInitInputSchema.parse(raw)
  const projectDir = path.resolve(input.project_dir ?? process.cwd())
  const roles = input.roles ?? [...CURSOR_AGENT_ROLES]
  const overwrite = input.overwrite === true
  const written: string[] = []
  const skipped: string[] = []
  await fs.mkdir(path.join(projectDir, ".cursor", "agents"), { recursive: true })

  for (const role of roles) {
    const rel = `.cursor/agents/${role}.md`
    const abs = path.join(projectDir, rel)
    if ((await pathExists(abs)) && !overwrite) {
      skipped.push(rel)
      continue
    }
    const spec = SPECS[role]
    const model = input.models?.[role] ?? CURSOR_SEAT_MODELS[role]
    await atomicWriteFile(abs, cursorAgentMarkdown(role, spec.description, model, spec.instructions))
    written.push(rel)
  }

  const seats = roles
    .map((r) => `${r}=${input.models?.[r] ?? CURSOR_SEAT_MODELS[r]}`)
    .join(", ")
  return toKeyValue({
    status: "ok",
    project_dir: projectDir,
    seats,
    files_written: written.join(",") || "none",
    files_skipped: skipped.join(",") || "none",
    note:
      "Spawn with the Cursor Agent CLI (`agent`/`cursor-agent`) in print mode, or with Task `subagent_type: '<role>'` and NO model argument as the IDE fallback. " +
      "Default is inherit (the pit-boss's model). An explicit Task model argument overrides it, so this is a binding default, not a lock; the delegation's tier and route_reason remain the record of what ran. " +
      "Do not pass --approve-mcps to a child agent — it must not load Foreman MCP. " +
      "Do not spawn the Claude Code definitions in .claude/agents/ as Cursor seats: those pin sonnet/opus/effort, which are not Cursor model syntax. " +
      "UI registration: `cursor --add-mcp`. Agent CLI reads ~/.cursor/mcp.json or .cursor/mcp.json.",
    hints: skipped.length
      ? "existing definitions were left alone; pass overwrite: true to replace them"
      : "restart is not required — Cursor reads .cursor/agents on each spawn; .cursor/ wins over .claude/ on name collision",
  })
}
