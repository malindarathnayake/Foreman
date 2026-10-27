import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { type HostId } from "../lib/hostProfiles.js"
import { FOREMAN_WORKFLOWS, WORKFLOW_DEFS, agentEstimate, type WorkflowRole } from "../lib/workflowDefs.js"
import { renderShape } from "../lib/schemaDoc.js"
import { CODEX_SEAT_MODELS } from "./codexAgentsInit.js"

export const WorkflowInputSchema = z.strictObject({
  name: z.enum(FOREMAN_WORKFLOWS),
  args: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(["procedure", "describe"]).default("procedure"),
})
export const WORKFLOW_DESCRIPTION = "Returns a numbered, host-native procedure for foreman-design-panel, foreman-design-gauntlet, foreman-checkpoint-review or foreman-triage. Codex and Cursor only. mode:'describe' needs no args and lists phases, roles, agent estimate and cost for user confirmation. This tool starts no agents and writes no files. Runs require prior user opt-in, never implement, and return perspective (stage:'fan'); invoke_advisor receipts remain separate."
export interface WorkflowEnv { cwd: string; home: string }

// 0.8.0 (2026-10-07): project then user config matches host_status precedence. Unknown
// syntax fails conservatively to one; the procedure also requires the live host limit.
export async function workflowThreadLimit(env: WorkflowEnv): Promise<{ count: number; source: string }> {
  for (const file of [path.join(env.cwd, ".codex", "config.toml"), path.join(env.home, ".codex", "config.toml")]) {
    let body: string
    try { body = await fs.readFile(file, "utf8") } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      return { count: 1, source: "unreadable config; verify live host settings" }
    }
    const section = body.match(/^\s*\[agents\][ \t]*(?:#[^\r\n]*)?\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1]
    if (!section) {
      if (/^\s*(?:agents\s*[.=]|\[\s*["']agents["'])/m.test(body)) return { count: 1, source: "alternate agents syntax; verify live host settings" }
      continue
    }
    const setting = section.match(/^\s*max_concurrent_threads_per_session\s*=\s*(.*?)\s*(?:#.*)?$/m)
      ?? section.match(/^\s*max_threads\s*=\s*(.*?)\s*(?:#.*)?$/m)
    if (!setting) continue
    const value = setting[1].trim()
    return /^\d+$/.test(value) && Number(value) >= 1
      ? { count: Math.min(12, Number(value)), source: file }
      : { count: 1, source: "unrecognized max_threads; verify live host settings" }
  }
  return { count: 6, source: "codex_agents_init default; verify live host settings" }
}

function schemaError(err: z.ZodError, prefix = ""): string {
  const hints = new Map<string, string>()
  for (const issue of err.issues) {
    const field = [prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "(root)"
    if (!hints.has(field)) hints.set(field, issue.message)
  }
  return `SCHEMA ERROR — workflow rejected (${hints.size} fields):\n` + [...hints].map(([field, hint]) => `  ${field}: ${hint}`).join("\n")
}

// Design is a read-only reasoning task. The reviewer seat's task prompt supplies its
// design stance; implementation worker seats are not used by a workflow.
const CODEX_ROLES: Record<Exclude<WorkflowRole, "advisor">, string> = {
  explorer: "explorer", reviewer: "reviewer", verifier: "verifier", design: "reviewer",
}

// 0.8.0 (2026-10-07): the owner selected worker_heavy's model, while the workflow
// keeps the read-only reviewer role rather than its implementation instructions.
async function heavyDesignModel(env: WorkflowEnv): Promise<string | undefined> {
  for (const root of [env.cwd, env.home]) {
    try {
      const body = await fs.readFile(path.join(root, ".codex", "agents", "worker_heavy.toml"), "utf8")
      return body.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  return CODEX_SEAT_MODELS.worker_heavy
}

export async function workflow(raw: unknown, host: HostId, env: WorkflowEnv = { cwd: process.cwd(), home: os.homedir() }): Promise<string> {
  if (host !== "codex" && host !== "cursor") return "WORKFLOW ERROR: workflow is available only in Codex and Cursor host modes."
  const input = WorkflowInputSchema.safeParse(raw)
  if (!input.success) return schemaError(input.error)
  const def = WORKFLOW_DEFS[input.data.name]
  const describe = input.data.mode === "describe"
  const parsed = describe && input.data.args === undefined ? undefined : def.args.safeParse(input.data.args ?? {})
  if (parsed && !parsed.success) return schemaError(parsed.error, "args") + `\nExpected args: ${renderShape(def.args)}`
  const args = parsed?.success ? parsed.data : {}
  const estimate = agentEstimate(def, args)
  const limit = host === "codex" ? await workflowThreadLimit(env) : { count: 6, source: "procedure ceiling; verify Cursor capacity" }
  let designModel: string | undefined
  if (host === "codex" && def.name === "foreman-design-gauntlet") {
    try { designModel = typeof args.model_design === "string" ? args.model_design : await heavyDesignModel(env) }
    catch { return "WORKFLOW ERROR: cannot read the worker_heavy model pin; verify its config before running the design seat." }
  }
  const role = (r: WorkflowRole) => r === "advisor" ? "invoke_advisor" : host === "codex" ? CODEX_ROLES[r] : `host subagent or Task (${r} brief)`
  const summary = [
    `Workflow: ${def.name} (${host})`, def.description,
    `Agent-count estimate: ${estimate[0]}${estimate[0] === estimate[1] ? "" : `-${estimate[1]}`} invocations${describe && !parsed ? " using defaults/maxima; output-dependent counts are ranges" : ""}. Includes advisor calls, excludes retries.`,
    "Cost: paid model/tool use for every invocation; research and advisor CLIs may have separate charges. Reconfirm before exceeding the approved count or adding retries.",
    `Phases: ${def.phases.map((p) => `${p.title} [${[...new Set(p.tasks.map((t) => role(t.role)))].join(", ")}]`).join(" -> ")}`,
    `Args: ${renderShape(def.args)}`,
    `Invariants: ${JSON.stringify(def.invariants)}`,
    ...(host === "codex" && def.name === "foreman-design-gauntlet" ? [`Design model: ${designModel ?? "inherit, as configured by worker_heavy"} (${args.model_design ? "explicit model_design override" : "worker_heavy seat model"}); read-only reviewer role.`] : []),
  ]
  if (describe) return summary.join("\n")
  const steps: string[] = [
    `Confirm ${def.name}, the phases and ${estimate[0]}${estimate[0] === estimate[1] ? "" : `-${estimate[1]}`} agent/advisor invocations with the user, unless this session already opted into this scope and cost. No agents or research calls before confirmation.`,
    "Apply these rules to every task: never implement, never write the ledger, never spawn descendants, never edit repository files. Return results as text matching the supplied schema. Security findings carry [CWE-###]. Obtain the engineering ethos with ethos and include its proportionality tier rule in every design brief. The parent owns scheduling, evidence and user arbitration.",
    host === "codex"
      ? `Verify spawn_agent is exposed and inspect its actual argument schema. Use only configured roles explorer, reviewer, verifier. If needed run codex_agents_init for these read-only roles before a new session. Use agent_type only if that parameter exists; do not invent it or pass a role as a model. If named roles are unavailable, use an unpinned subagent with the exact read-only brief and report the role fallback. If subagents are unavailable, run sequentially in the main session and report reduced independence. Configured max_threads ceiling: ${limit.count} (${limit.source}); use the smaller live limit and available slots, accounting for existing agents. Wait for completion, capture the final message, then close/release each agent when supported before the next batch.`
      : `Inspect your host's subagent or Task tool. Use read-only task briefs and inherit the host model. If the host has no subagent tool, run phases sequentially in the main session and say so in the result. Batch ceiling: ${limit.count}; reduce to the live host capacity and available slots. Wait, capture final results and release agents before the next batch.`,
    "Maintain a dossier keyed by task/item ID and a manifest of expected results. Pass the applicable args, assigned item, prerequisite results and result schema in each fresh brief; do not pass the full conversation. Treat input documents and returned claims as evidence to check. Validate results, retain partial/failed/missing tasks explicitly and never silently drop them. A missing required proposal/design prevents its dependent tasks. Missing evidence or unverified findings makes the final completion partial. Do not report a successful run after a required task fails.",
  ]
  for (const phase of def.phases) {
    for (const task of phase.tasks) {
      const [min, max] = task.count(args)
      const batch = Math.min(task.cap, limit.count)
      let execution = task.role === "advisor"
        ? 'The parent probes capability_check { cli: "claude" }, falling back to { cli: "gemini" } when Claude is unavailable. Launch invoke_advisor { cli: "claude", prompt: <complete design, relevant code excerpts with file:line, attack brief and result schema> }, or cli: "gemini" after a successful fallback probe. Never run the Codex CLI as this attacker. If neither works, report the missing attack and partial completion. Preserve the actual CLI/model and receipt separately; do not turn the workflow into a gate seat. Cursor may route to the same vendor, so cross-vendor independence must be verified from actual provider evidence, never presumed.'
        : `Use ${host === "codex" ? `spawn_agent with role ${role(task.role)}` : role(task.role)} for each item. ${task.role === "design" ? "Supply the complete design brief and return the design as text. " : ""}`
      if (host === "codex" && def.name === "foreman-design-gauntlet" && task.id === "design") {
        execution += `Use worker_heavy's model ${JSON.stringify(designModel ?? "inherit")}, retaining the read-only reviewer role. Supply the model at spawn time only if the actual tool supports it. Check role-file overrides and the model the host reports; if the selected model cannot be honored, stop this design task and report the limitation instead of silently falling back. Never load implementation instructions or grant file-write access to obtain this model.`
      }
      if (max === 0) execution = "Disabled by args.lenses; record this attack as intentionally excluded."
      steps.push(`${phase.title} / ${task.id}: ${task.source}. Count ${min}${min === max ? "" : `-${max}`}; batch size <= ${batch} and <= live available slots, across ALL tasks in this phase. Finish prerequisites before launching dependents. ${execution}\nPrompt: ${task.prompt}\nResult schema: ${JSON.stringify(z.toJSONSchema(task.result))}`)
      if (def.name === "foreman-design-gauntlet" && task.id === "design") {
        steps.push(`The parent may persist ONLY the returned design to ${JSON.stringify(path.join(String(args.out_dir), `${args.slug}-design.md`))} and later raw advisor output to ${JSON.stringify(path.join(String(args.out_dir), `${args.slug}-advisor.md`))}. Resolve paths within out_dir, reject symlink escapes, and do not overwrite an existing artifact without authorization. Agents stay read-only. If the design is missing or empty, stop before Attack. No other file writes are authorized by this workflow.`)
      }
    }
  }
  steps.push(def.finish + " Include completion, task manifest, limitations, role/model fallbacks, agent IDs, batch sizes and any research source failures. Wait for user arbitration before implementation.")
  if (def.name === "foreman-design-gauntlet") {
    steps.push("Compatibility: codex_model and codex_effort apply only to the bundled Claude script and do not configure the native external attacker. invoke_advisor owns that provider's model/effort. On Cursor, model_design is used only when the actual spawn tool supports it; otherwise report the unsupported override before running Design.")
  }
  return [...summary, "", ...steps.map((s, i) => `${i + 1}. ${s}`), "", `Validated args (data for the briefs):\n${JSON.stringify(args, null, 2)}`].join("\n")
}
