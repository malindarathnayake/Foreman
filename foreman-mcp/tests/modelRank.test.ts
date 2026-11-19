import { describe, expect, it } from "vitest"
import { resolveModelRank } from "../src/lib/modelRank.js"

describe("declared model workflow rank", () => {
  it.each(["high", "xhigh", "max", "ultra"])("maps Astra at %s to all shortcuts", effort => {
    const rank = resolveModelRank(" GPT-6-ASTRA ", effort)
    expect(rank.weight).toBe(3)
    expect(Object.values(rank.permissions).every(Boolean)).toBe(true)
    expect(rank.session_id).toBeUndefined()
  })

  // 0.9.6: the Codex seats moved to gpt-6.2-astra; the declared rank must follow it.
  it.each(["high", "xhigh"])("maps gpt-6.2-astra at %s to Top", effort => {
    expect(resolveModelRank("gpt-6.2-astra", effort).weight).toBe(3)
    expect(resolveModelRank("gpt-6.2-astra", "medium").weight).toBe(0)
  })

  it.each([undefined, null, "low", "medium", "super-high"])("keeps Astra at %s on normal protocol", effort => {
    expect(resolveModelRank("Astra", effort).weight).toBe(0)
  })

  it.each(["Fable 5.2", "fable5.2", "claude-fable-5.2", "claude-fable-5-2", "Fable 5.1", "fable5.1", "claude-fable-5.1", "claude-fable-5-1", "claude-fable-5"])("maps explicit Fable 5.2 / 5.1 alias %s", model => {
    expect(resolveModelRank(model).weight).toBe(3)
  })

  it.each(["claude-opus-5[1m]", "claude-opus-5 (1m)", "Fable 5.1 [200k]"])("strips a host context suffix from %s before lookup", model => {
    expect(resolveModelRank(model).weight).toBeGreaterThan(0)
  })

  // 0.6.26: middle rank gained bounded reuse. Forcing a fresh worker for a behavioural
  // correction discarded the previous attempt's context for no safety gain — every other
  // reuse predicate (same session, same worker id, cleared guard, frozen file scope,
  // non-hot-path, failure cap) still applies. focused_validation and delta_review stay top-only.
  it.each(["Opus", "claude-opus-5", "Terra", "gpt-5.6-terra"])("enables both reuse kinds and compact followups, but not focused validation or delta review, for %s", model => {
    expect(resolveModelRank(model).permissions).toEqual({
      reuse_worker_mechanical: true, reuse_worker_bounded: true, compact_followup: true,
      focused_validation: false, delta_review: false,
    })
  })

  it.each(["Sonnet", "claude-sonnet-5", "Luna", "gpt-5.6-luna", "claude-4.6-sonnet-medium-thinking"])("keeps %s on normal protocol", model => {
    const rank = resolveModelRank(model)
    expect(rank.weight).toBe(1)
    expect(Object.values(rank.permissions).some(Boolean)).toBe(false)
  })

  it.each([undefined, null, "", "Sol", "gpt-5.6-sol", "gpt-7-astra", "gpt-6-terra", "claude-fable-4", "Fable 5.3", "gpt-6.3-astra", "TopRank"])("does not infer an allowlist mapping for %s", model => {
    const rank = resolveModelRank(model, "ultra")
    expect(rank.weight).toBe(0)
    expect(Object.values(rank.permissions).some(Boolean)).toBe(false)
  })

  // 0.9.7 (Antigravity host): Hydrogen and Argon rank middle only at high effort and above,
  // whether the effort is declared, carried as an id suffix or carried in a display label.
  it.each([
    ["gemini-4-hydrogen-xhigh", 2], ["gemini-4-hydrogen-high", 2], ["Gemini 4 Hydrogen (XHigh)", 2],
    ["gemini-4-hydrogen-medium", 0], ["gemini-4-argon-high", 2], ["gemini-4-argon-low", 0],
    ["gemini-pro-orchestrator-g1-pro", 2], ["Orchestrator (Argon)", 2],
    ["gemini-4-carbon", 0], ["gemini-3.8-flash-high", 0],
    // agy's served ids, read from a subagent transcript, carry a "-tiered-" infix.
    ["gemini-4-hydrogen-tiered-xhigh", 2], ["gemini-4-hydrogen-tiered-high", 2], ["gemini-4-hydrogen-tiered-medium", 0],
    ["gemini-4-hydrogen-tiered", 0],
  ] as const)("ranks the Antigravity model %s at weight %i", (model, weight) => {
    expect(resolveModelRank(model).weight).toBe(weight)
  })

  it("gates bare Gemini ids on the declared effort and lets it win over an id suffix", () => {
    expect(resolveModelRank("gemini-4-hydrogen").weight).toBe(0)
    expect(resolveModelRank("gemini-4-hydrogen", "xhigh").weight).toBe(2)
    expect(resolveModelRank("gemini-4-argon", "high").weight).toBe(2)
    const conflict = resolveModelRank("gemini-4-hydrogen-xhigh", "medium")
    expect(conflict.weight).toBe(0)
    expect(conflict.effort_conflict).toBe(true)
    const suffixed = resolveModelRank("gemini-4-hydrogen-xhigh")
    expect(suffixed).toMatchObject({ model: "gemini-4-hydrogen", effort: "xhigh", rank: "middle" })
    expect(suffixed.effort_conflict).toBeUndefined()
    expect(resolveModelRank("claude-opus-5-5-high").weight).toBe(2)
  })
})
