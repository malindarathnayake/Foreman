import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import type { HostId } from "./hostProfiles.js"
import type { Tier } from "../types.js"
import { loadForemanEnv } from "./foremanEnv.js"

const tierModels = z.strictObject({
  cheap: z.string().trim().min(1).optional(), standard: z.string().trim().min(1).optional(),
  premium: z.string().trim().min(1).optional(), frontier: z.string().trim().min(1).optional(),
})
const mappingSchema = z.strictObject({
  "claude-code": tierModels.optional(), codex: tierModels.optional(), cursor: tierModels.optional(), generic: tierModels.optional(),
})
export const WORKER_MODELS_FILE = ".foreman-worker-models.json"
export const DEFAULT_WORKER_MODELS: Record<HostId, Partial<Record<Tier, string>>> = {
  "claude-code": { cheap: "sonnet", standard: "sonnet", premium: "opus", frontier: "fable" },
  codex: { cheap: "gpt-5.6-terra", standard: "gpt-6-sol", premium: "gpt-6-astra" },
  cursor: {}, generic: {},
}
const roles: Record<Tier, string> = { cheap: "foreman-worker-light", standard: "foreman-worker", premium: "foreman-worker-heavy", frontier: "foreman-worker-frontier" }
const codexRoles: Record<Tier, string> = { cheap: "worker_light", standard: "worker", premium: "worker_heavy", frontier: "worker_frontier" }

export async function configuredWorkerModels(root: string, host: HostId): Promise<Partial<Record<Tier, string>>> {
  try { return mappingSchema.parse(JSON.parse(await fs.readFile(path.join(root, WORKER_MODELS_FILE), "utf8")))[host] ?? {} }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error(`WORKER MODELS: invalid ${WORKER_MODELS_FILE}: ${String(err)}`)
  }
}

export function workerRoleTier(role: string): Tier | undefined {
  return (Object.entries({ ...roles }).find(([, r]) => r === role)?.[0] ?? Object.entries(codexRoles).find(([, r]) => r === role)?.[0]) as Tier | undefined
}

/** Read project configuration, never a model supplied with the verdict. */
export async function resolveWorkerSeat(root: string, host: HostId, tier?: Tier): Promise<{ role?: string; model?: string; source?: string; missing?: boolean }> {
  if (!tier) return {}
  const configured = (await configuredWorkerModels(root, host))[tier]
  const role = host === "codex" ? codexRoles[tier] : roles[tier]
  if (host === "generic") {
    if (configured) return { role, ...(configured !== "inherit" ? { model: configured, source: WORKER_MODELS_FILE } : {}) }
    try { await fs.access(path.join(root, ".foremanenv")) }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return { role }; throw err }
    const remote = await loadForemanEnv({ dir: root, requireKey: false })
    if (remote.status !== "ok") throw new Error(`WORKER MODELS: .foremanenv routing is unavailable (${remote.status}); fix the configuration before delegating.`)
    const model = remote.config.tiers[tier]?.model
    return { role, ...(model ? { model, source: ".foremanenv" } : {}) }
  }
  const folder = host === "claude-code" ? ".claude" : `.${host}`
  const rel = `${folder}/agents/${role}.${host === "codex" ? "toml" : "md"}`
  let text: string
  try { text = await fs.readFile(path.join(root, rel), "utf8") }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    const fallback = configured ?? DEFAULT_WORKER_MODELS[host][tier]
    return { role, missing: true, ...(fallback && fallback !== "inherit" ? { model: fallback, source: configured ? WORKER_MODELS_FILE : "shipped default" } : {}) }
  }
  const header = host === "codex" ? text.split(/^developer_instructions\s*=/m)[0] : /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
  const pin = /^model\s*[:=]\s*["']?([^\r\n"']+)/m.exec(header)?.[1].trim()
  const model = configured ?? pin
  return { role, ...(model && model !== "inherit" ? { model, source: configured ? WORKER_MODELS_FILE : rel } : {}) }
}

/** Family aliases accept a provider's versioned id, never a different family. */
export function workerModelMatches(required: string, served: string): boolean {
  if (required === served) return true
  if (["sonnet", "opus", "fable", "haiku"].includes(required)) return new RegExp(`^claude-${required}-[0-9][a-z0-9.-]*$`).test(served)
  return false
}

export async function workerSeatStatus(root: string, host: HostId): Promise<Record<string, string>> {
  const seats = await Promise.all((["cheap", "standard", "premium", "frontier"] as Tier[]).map(async (tier) => ({ tier, ...await resolveWorkerSeat(root, host, tier) })))
  const missing = seats.filter((s) => s.missing).map((s) => s.role!)
  return {
    worker_seats: seats.map((s) => `${s.tier}=${s.role}:${s.model ?? "inherit"}${s.missing ? " (missing agent)" : ""}`).join("; "),
    missing_worker_agents: missing.join(", ") || "none",
    ...(missing.length ? { worker_seat_hint: `Run ${host === "claude-code" ? "claude" : host}_agents_init; configure tier models in ${WORKER_MODELS_FILE}. New agents may require a host session restart.` } : {}),
  }
}
