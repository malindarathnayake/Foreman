// Tiered Codex implementation seats (v0.6.15). Codex host ONLY: the pit-boss picks a
// worker seat per unit instead of using one seat for everything, and the seat's model is
// pinned in .codex/agents/<role>.toml rather than asserted in protocol prose.
//
// The model ids below were each verified by a live probe on codex-cli 0.153.4 against a
// ChatGPT account. That matters more than it looks: gpt-6-terra and gpt-6-sol are BOTH
// refused, so the families are not interchangeable across a version bump and a "newer"
// id is not automatically better.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { codexAgentsInit, CODEX_AGENT_ROLES, CODEX_SEAT_MODELS } from "../src/tools/codexAgentsInit.js"
import { getProfile, KNOWN_HOSTS, type HostId } from "../src/lib/hostProfiles.js"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tiers-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const roleToml = (role: string) => fs.readFile(path.join(dir, ".codex", "agents", `${role}.toml`), "utf-8")

describe("codex_agents_init writes the tiered implementation seats", () => {
  it("ships three implementation seats plus the read-only roles", () => {
    expect(CODEX_AGENT_ROLES).toEqual([
      "explorer", "worker_light", "worker", "worker_heavy", "reviewer", "verifier",
    ])
  })

  it("pins a probe-verified model to each implementation seat", async () => {
    await codexAgentsInit({ project_dir: dir, roles: ["worker_light", "worker", "worker_heavy"] })
    expect(await roleToml("worker_light")).toContain('model = "gpt-5.6-terra"')
    expect(await roleToml("worker")).toContain('model = "gpt-5.6-sol"')
    expect(await roleToml("worker_heavy")).toContain('model = "gpt-6-astra"')
  })

  it("the table is the single source of those defaults", () => {
    expect(CODEX_SEAT_MODELS).toEqual({
      worker_light: "gpt-5.6-terra",
      worker: "gpt-5.6-sol",
      worker_heavy: "gpt-6-astra",
    })
  })

  it("an explicit pin overrides the default, because ids rotate", async () => {
    await codexAgentsInit({ project_dir: dir, roles: ["worker"], models: { worker: "gpt-5.6-terra" } })
    expect(await roleToml("worker")).toContain('model = "gpt-5.6-terra"')
    expect(await roleToml("worker")).not.toContain("gpt-5.6-sol")
  })

  it("every implementation seat can write, and no seat may spawn another", async () => {
    await codexAgentsInit({ project_dir: dir })
    for (const role of ["worker_light", "worker", "worker_heavy"]) {
      const toml = await roleToml(role)
      expect(toml, role).toContain('sandbox_mode = "workspace-write"')
      expect(toml, role).toMatch(/Do not spawn further subagents/)
    }
    for (const role of ["explorer", "reviewer", "verifier"]) {
      expect(await roleToml(role), role).toContain('sandbox_mode = "read-only"')
    }
  })

  it("the light seat is told to stop rather than guess, and the heavy seat not to widen scope", async () => {
    await codexAgentsInit({ project_dir: dir, roles: ["worker_light", "worker_heavy"] })
    expect(await roleToml("worker_light")).toMatch(/STOP and report that it needs a stronger seat/)
    expect(await roleToml("worker_heavy")).toMatch(/the brief's file list still binds/)
  })
})

describe("the Codex profile maps a unit to a seat", () => {
  const invoke = () => getProfile("codex").placeholders.worker_invoke

  it("names all three seats against Foreman's existing cost tiers", () => {
    expect(invoke()).toMatch(/`worker_light` \(tier cheap\)/)
    expect(invoke()).toMatch(/`worker` \(tier standard\)/)
    expect(invoke()).toMatch(/`worker_heavy` \(tier premium\)/)
  })

  it("makes standard the default and escalation evidence-bound", () => {
    expect(invoke()).toMatch(/an unclassifiable unit belongs here/)
    expect(invoke()).toMatch(/Escalate on evidence, never on a hunch/)
    expect(invoke()).toMatch(/Never start at premium to save a round/)
  })

  it("keeps the model claim honest: pinned in config, reported by the host", () => {
    expect(invoke()).toMatch(/\.codex\/agents\/<role>\.toml/)
    expect(invoke()).toMatch(/never attest one the host did not confirm/)
    // Effort is not pinnable per role in this build, so the text must not pretend it is.
    expect(invoke()).toMatch(/Reasoning effort is host-owned in this build/)
  })

  it("drops the unverified seat it used to name", () => {
    expect(invoke()).not.toMatch(/luna/i)
    expect(getProfile("codex").placeholders.worker_fanout).not.toMatch(/luna/i)
  })

  it("picks the seat per unit, not once per batch", () => {
    expect(getProfile("codex").placeholders.worker_fanout).toMatch(/picked per unit/)
  })
})

describe("no other host is affected", () => {
  it("only the codex profile mentions the seats or spawn_agent", () => {
    for (const host of KNOWN_HOSTS.filter((h) => h !== "codex")) {
      const p = getProfile(host as HostId).placeholders
      for (const key of ["worker_invoke", "worker_fanout"]) {
        expect(p[key], `${host}.${key}`).not.toMatch(/worker_light|worker_heavy|spawn_agent/)
      }
    }
  })

  it("claude-code still spawns a sonnet Agent and cursor still uses Task", () => {
    expect(getProfile("claude-code").placeholders.worker_invoke).toContain('model: "sonnet"')
    expect(getProfile("cursor").placeholders.worker_invoke).toContain("Task")
  })
})
