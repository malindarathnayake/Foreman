import { describe, expect, it } from "vitest"
import { resolveModelRank } from "../src/lib/modelRank.js"

describe("declared model workflow rank", () => {
  it.each(["high", "xhigh", "max", "ultra"])("maps Astra at %s to all shortcuts", effort => {
    const rank = resolveModelRank(" GPT-6-ASTRA ", effort)
    expect(rank.weight).toBe(3)
    expect(Object.values(rank.permissions).every(Boolean)).toBe(true)
    expect(rank.session_id).toBeUndefined()
  })

  it.each([undefined, null, "low", "medium", "super-high"])("keeps Astra at %s on normal protocol", effort => {
    expect(resolveModelRank("Astra", effort).weight).toBe(0)
  })

  it.each(["Fable 5.1", "fable5.1", "claude-fable-5.1", "claude-fable-5-1", "claude-fable-5"])("maps explicit Fable 5.1 alias %s", model => {
    expect(resolveModelRank(model).weight).toBe(3)
  })

  it.each(["Opus", "claude-opus-5", "Terra", "gpt-5.6-terra"])("only enables mechanical reuse and compact followups for %s", model => {
    expect(resolveModelRank(model).permissions).toEqual({
      reuse_worker_mechanical: true, reuse_worker_bounded: false, compact_followup: true,
      focused_validation: false, delta_review: false,
    })
  })

  it.each(["Sonnet", "claude-sonnet-5", "Luna", "gpt-5.6-luna", "claude-4.6-sonnet-medium-thinking"])("keeps %s on normal protocol", model => {
    const rank = resolveModelRank(model)
    expect(rank.weight).toBe(1)
    expect(Object.values(rank.permissions).some(Boolean)).toBe(false)
  })

  it.each([undefined, null, "", "Sol", "gpt-5.6-sol", "gpt-7-astra", "gpt-6-terra", "claude-fable-4", "Fable 5.2", "TopRank"])("does not infer an allowlist mapping for %s", model => {
    const rank = resolveModelRank(model, "ultra")
    expect(rank.weight).toBe(0)
    expect(Object.values(rank.permissions).some(Boolean)).toBe(false)
  })
})
