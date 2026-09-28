import fs from "fs"
import os from "os"
import path from "path"
import { type HostId, getProfile } from "../lib/hostProfiles.js"
import { unsupportedCapabilities } from "../lib/capabilitySet.js"
import { toKeyValue } from "../lib/toon.js"
import { CODEX_SEAT_MODELS } from "../tools/codexAgentsInit.js"
import { CURSOR_SEAT_MODELS } from "../tools/cursorAgentsInit.js"
import { systemCaState } from "../lib/systemCa.js"
import { modelRankSummary, resolveModelRank, type ModelRank } from "../lib/modelRank.js"

/**
 * Read-only introspection of the active Foreman host configuration.
 *
 * The placeholder texts encode a model slug for each role; we extract those
 * so callers (LLM, tests, diagnostics) can see which model will run as worker
 * vs. each advisor without parsing skill text.
 */
/**
 * 0.6.34: the longest Foreman tool call a host must wait for — invoke_advisor's 900s default
 * budget plus resolution, cleanup and receipt work. Codex documents a 60s tool_timeout_sec
 * default, which cuts every such call off.
 */
const CODEX_TOOL_TIMEOUT_RECOMMENDED_SEC = 1200

/** Where host_status looks for on-disk seat pins and host config. Injectable for tests. */
export interface HostStatusEnv { cwd: string; home: string }

/** `model = "..."` from each .codex/agents/<role>.toml that exists; the effective pin, not the shipped default. */
export function codexSeatPinsOnDisk(cwd: string): string {
  const pins = Object.keys(CODEX_SEAT_MODELS).map((role) => {
    try {
      const text = fs.readFileSync(path.join(cwd, ".codex", "agents", `${role}.toml`), "utf-8")
      const m = text.match(/^\s*model\s*=\s*"([^"]+)"/m)
      return `${role}=${m ? m[1] : "inherit"}`
    } catch {
      return `${role}=missing`
    }
  })
  return pins.every((p) => p.endsWith("=missing")) ? "none (run codex_agents_init)" : pins.join(" ")
}

/**
 * tool_timeout_sec from the [mcp_servers.foreman] table of the project, then the user,
 * Codex config. Returns undefined when neither sets it (the host default applies).
 */
export function codexForemanToolTimeout(env: HostStatusEnv): { sec: number; source: string } | undefined {
  for (const file of [path.join(env.cwd, ".codex", "config.toml"), path.join(env.home, ".codex", "config.toml")]) {
    let text: string
    try { text = fs.readFileSync(file, "utf-8") } catch { continue }
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((l) => /^\s*\[mcp_servers\.foreman\]\s*$/.test(l))
    if (start < 0) continue
    for (const line of lines.slice(start + 1)) {
      if (/^\s*\[/.test(line)) break
      const m = line.match(/^\s*tool_timeout_sec\s*=\s*(\d+(?:\.\d+)?)/)
      if (m) return { sec: Number(m[1]), source: file }
    }
  }
  return undefined
}

export function hostStatus(
  host: HostId,
  modelRank: ModelRank = resolveModelRank(),
  env: HostStatusEnv = { cwd: process.cwd(), home: os.homedir() }
): string {
  const profile = getProfile(host)
  const ph = profile.placeholders

  const modelOf = (key: string): string => {
    const text = ph[key] ?? ""
    const match = text.match(/model:\s*"([^"]+)"/)
    return match ? match[1] : "n/a"
  }

  // Cursor's advisor_b carries an explicit fallback note. Best-effort extraction.
  const advisorBText = ph.advisor_b ?? ""
  const fallbackMatch = advisorBText.match(/fall back to[^"]*"([^"]+)"/i)
  const advisorBFallback = fallbackMatch ? fallbackMatch[1] : "n/a"

  // Codex pins its implementation seats in .codex/agents/<role>.toml rather than in the
  // placeholder text, so the single worker_model slug does not describe it. Cursor seats
  // default to inherit in .cursor/agents/; report that table the same way. Report the
  // seat table instead of scraping prose that no longer carries a model.
  const workerModel =
    host === "codex"
      ? Object.entries(CODEX_SEAT_MODELS).map(([role, model]) => `${role}=${model}`).join(" ")
      : host === "cursor"
        ? Object.entries(CURSOR_SEAT_MODELS).map(([role, model]) => `${role}=${model}`).join(" ")
        : modelOf("worker_invoke")

  return toKeyValue({
    ...modelRankSummary(modelRank),
    host: profile.id,
    display_name: profile.displayName,
    ...(host === "claude-code" ? {
      workflows: "claude_workflows_init installs foreman-checkpoint-review, foreman-design-panel, foreman-triage (Workflow tool; results are stage:'fan', never a seat)",
    } : {}),
    ...(host === "cursor" ? {
      seats: "Agent CLI (agent / cursor-agent) print mode is the primary spawn; Task + cursor_agents_init .cursor/agents/foreman-worker*.md is the IDE fallback (default inherit, no model argument)",
      agent_cli: "agent (alias cursor-agent); advisors: -p --mode=ask --trust; workers: -p --force --trust; never --approve-mcps",
      editor_cli: "cursor --add-mcp for UI registration; Agent CLI reads ~/.cursor/mcp.json or .cursor/mcp.json",
    } : {}),
    ...(host === "codex" ? codexSeatFacts(env) : {}),
    ...(host === "codex" ? {
      review_mode: "native-subagents",
      review_stage: "native",
      external_advisors: "optional: claude,gemini,council",
      agent_visibility: "host-owned; native IDs are reported by the host, not discovered by Foreman",
    } : {}),
    ...(host === "codex" ? { seat_defaults: workerModel } : { worker_model: workerModel }),
    advisor_a_model: modelOf("advisor_a"),
    advisor_b_model: modelOf("advisor_b"),
    advisor_b_fallback: advisorBFallback,
    unsupported_capabilities: unsupportedCapabilities(host),
    os_cert_store: osCertStore(),
  })
}

/** 0.6.38: whether TLS from this process trusts the OS certificate store (lib/systemCa.ts). */
function osCertStore(): string {
  const s = systemCaState()
  if (!s) return "not configured in this process (the stdio server sets it at startup)"
  return s.status === "on" ? `trusted (${s.system} OS certificates added to the default store)` : `${s.status}: ${s.reason}`
}

/** 0.6.34: what is pinned on disk and whether long Foreman calls outlive the Codex tool timeout. */
function codexSeatFacts(env: HostStatusEnv): Record<string, string> {
  const timeout = codexForemanToolTimeout(env)
  const short = timeout === undefined || timeout.sec < CODEX_TOOL_TIMEOUT_RECOMMENDED_SEC
  return {
    seat_pins_on_disk: codexSeatPinsOnDisk(env.cwd),
    tool_timeout_sec: timeout ? `${timeout.sec} (${timeout.source})` : "unset (Codex default 60)",
    ...(short ? {
      tool_timeout_advice:
        `invoke_advisor, invoke_council and invoke_worker can run for minutes; add tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_RECOMMENDED_SEC} ` +
        "under [mcp_servers.foreman] in ~/.codex/config.toml, or the call is cut off while the child keeps running",
    } : {}),
  }
}
