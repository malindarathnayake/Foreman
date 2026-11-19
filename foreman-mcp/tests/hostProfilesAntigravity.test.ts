import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { getProfile, hostRuntimePreamble, resolveHost } from "../src/lib/hostProfiles.js"
import { loadSkill } from "../src/lib/skillLoader.js"
import {
  ANTIGRAVITY_PROTOCOL_SECTIONS,
  CODEX_NATIVE_REVIEW,
  CODEX_PROTOCOL_SECTIONS,
  CODEX_REVIEW_MODE,
} from "../src/lib/codexProtocol.js"

const SKILLS_DIR = path.join(__dirname, "..", "src", "skills")
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

describe("native review generator — Codex output is byte-identical to 0.9.6", () => {
  // Digests of the 0.9.6 hand-written Codex strings, taken before the generator refactor.
  it("pins every Codex native review string by sha256", () => {
    expect(sha256(CODEX_REVIEW_MODE)).toBe("3e6fc6ddf427b97e325b12494043fb95b96c198fef18d2e34cf7f7dfb6d6167d")
    expect(sha256(CODEX_NATIVE_REVIEW)).toBe("3808f916491f83b3aec6313b167534904460311a1ac23bfc6b9dd7d9753e1aa8")
    expect(Object.keys(CODEX_PROTOCOL_SECTIONS)).toEqual(["deliberation-protocol", "checkpoint-review"])
    expect(sha256(CODEX_PROTOCOL_SECTIONS["deliberation-protocol"])).toBe(
      "cd67fd16c865f30b2677de43d8e584632b20bc59fa41d80a4fbaa7045e221f59"
    )
    expect(sha256(CODEX_PROTOCOL_SECTIONS["checkpoint-review"])).toBe(
      "e6043b46e721b2ef5fa7f8c78c46dc7359f45f84900cc572187682f424c826fb"
    )
  })

  it("the Codex profile still uses the Codex strings and has no skill header", () => {
    const codex = getProfile("codex")
    expect(codex.protocolSections).toBe(CODEX_PROTOCOL_SECTIONS)
    expect(codex.placeholders.review_mode).toBe(CODEX_REVIEW_MODE)
    expect(codex.placeholders.advisor_fallback).toBe(CODEX_NATIVE_REVIEW)
    expect(codex.skillHeader).toBeUndefined()
  })
})

describe("antigravity profile", () => {
  const ag = getProfile("antigravity")
  const ph = ag.placeholders

  it("resolves from flag and env", () => {
    expect(resolveHost({ flag: "antigravity" })).toBe("antigravity")
    expect(resolveHost({ env: "antigravity" })).toBe("antigravity")
    expect(ag.id).toBe("antigravity")
    expect(ag.displayName).toBe("Google Antigravity (agy CLI)")
    expect(ph.host_name).toBe("Google Antigravity")
  })

  it("worker_invoke uses invoke_subagent seats and records the transcript model", () => {
    const w = ph.worker_invoke
    expect(w).toContain("invoke_subagent")
    expect(w).toContain(".agents/agents/foreman-worker")
    expect(w).toContain("antigravity_agents_init")
    expect(w).toContain("Do not define a transient seat with `define_subagent`")
    expect(w).not.toContain("EnableWriteTools")
    expect(w).toContain("foreman-worker-light")
    expect(w).toContain("foreman-worker-heavy")
    expect(w).toContain("foreman-worker-frontier")
    expect(w).toContain("flash for light and standard, pro for heavy and frontier")
    expect(w).toContain("logAbsoluteUri")
    expect(w).toContain("transcript.jsonl")
    expect(w).toContain("`worker_model`")
    expect(w).toContain("`model_evidence`")
    expect(w).toContain("Never record a model the transcript does not show")
    expect(w).toContain('do not use `TypeName: "self"`')
    expect(w).toContain("Based on the context above,")
    expect(w).toContain("Repository state is user-owned")
    expect(w).toContain("foreman-worker-frontier on Claude Code/Cursor/Antigravity")
    expect(w).not.toContain("spawn_agent")
    expect(w).not.toContain("Agent tool")
    expect(w).not.toContain("tier:<")
  })

  it("worker_fanout runs editors sequentially on the inherited workspace", () => {
    const f = ph.worker_fanout
    expect(f).toContain("delegated")
    expect(f).toContain("sequentially")
    expect(f).toContain('Workspace: "inherit"')
    expect(f).toContain('Do not use `Workspace: "branch"`')
    expect(f).toContain("run_workflow")
    expect(f).toContain("antigravity_agents_init")
  })

  it("advisors are Claude and Codex; gemini is same-vendor perspective", () => {
    expect(ph.advisor_a).toContain('cli: "claude"')
    expect(ph.advisor_a).toContain('model: "claude-fable-5-2"')
    expect(ph.advisor_a).toContain("max")
    expect(ph.advisor_b).toContain('cli: "codex"')
    expect(ph.advisor_b).toContain("gpt-6.2-astra")
    expect(ph.advisor_checks).toContain('cli: "claude"')
    expect(ph.advisor_checks).toContain('cli: "codex"')
    expect(ph.advisor_checks).toContain("perspective")
  })

  it("sets every placeholder itself, native review included", () => {
    expect(ph.review_mode).toContain("Native Antigravity subagents are the default")
    expect(ph.review_mode).toContain("stage:'native'")
    expect(ph.cli_unavailable).toContain("No missing-CLI waiver")
    expect(ph.session_advisor_setup).toContain("foreman-reviewer")
    expect(ph.workflows).toBe("No saved-workflow surface on this host; use the review and deliberation paths above.")
    expect(ph.session_compact).toBe("/compact")
    expect(ph.session_clear).toBe("/clear")
    expect(ph.autonomy).toContain("phase gate")
    expect(ph.advisor_fallback).toContain("**Native review:**")
    expect(ph.advisor_fallback).toContain("advisor:'antigravity-native'")
  })

  it("native review sections name Antigravity seats, not Codex ones", () => {
    const sections = ANTIGRAVITY_PROTOCOL_SECTIONS
    expect(ag.protocolSections).toBe(sections)
    for (const id of ["deliberation-protocol", "checkpoint-review"]) {
      const text = sections[id]
      expect(text, id).toContain('TypeName: "foreman-reviewer"')
      expect(text, id).toContain('TypeName: "foreman-verifier"')
      expect(text, id).toContain("antigravity_agents_init")
      expect(text, id).toContain("advisor:'antigravity-native'")
      expect(text, id).toContain("two receipted seats from different vendors (invoke_advisor claude and invoke_advisor codex")
      expect(text, id).toContain("one receipted seat alone does not reset the independence bound")
      expect(text, id).not.toContain("invoke_advisor claude or codex")
      expect(text, id).not.toContain("EnableMCPTools")
      expect(text, id).toContain("capability_check tools for claude and codex")
      expect(text, id).toContain("carries the full diff")
      expect(text, id).toContain("conversationId")
      expect(text, id).not.toContain("conversation_id")
      expect(text, id).not.toContain("spawn_agent")
      expect(text, id).not.toContain("codex_agents_init")
      expect(text, id).not.toContain("codex-native")
      expect(text, id).not.toContain("max_depth")
    }
    expect(sections["checkpoint-review"]).toContain("**2. Review via native Antigravity subagents:**")
  })

  it("hostRuntimePreamble renders without undefined slots", () => {
    const pre = hostRuntimePreamble("antigravity")
    expect(pre).not.toContain("undefined")
    expect(pre).toContain("invoke_subagent")
  })
})

describe("antigravity skills render", () => {
  it("implementor carries the legend, native sections and no other host's tooling", async () => {
    const { content } = await loadSkill("implementor", SKILLS_DIR, "antigravity")
    expect(content.startsWith("## Antigravity host notes (authoritative)\n")).toBe(true)
    expect(content).toContain("`call_mcp_tool` with ServerName:\"foreman\"")
    expect(content).toContain("invoke_subagent")
    expect(content).toContain("advisor:'antigravity-native'")
    for (const banned of [".claude/agents", "cursor_agents_init", "codex_agents_init", "spawn_agent", "claude_workflows_init"]) {
      expect(content, banned).not.toContain(banned)
    }
  })
})

describe("antigravity skill header on override paths", () => {
  let tmpDir: string
  let cwd: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skillloader-antigravity-"))
    cwd = process.cwd()
    process.chdir(tmpDir)
  })

  afterEach(async () => {
    process.chdir(cwd)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("a project override gets the header ahead of the runtime preamble", async () => {
    const dir = path.join(tmpDir, ".claude", "skills", "implementor")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "SKILL.md"), "override body {{worker_invoke}}")
    const result = await loadSkill("implementor", path.join(tmpDir, "none"), "antigravity")
    expect(result.source).toBe("project-override")
    expect(result.content.startsWith("## Antigravity host notes (authoritative)\n")).toBe(true)
    const header = result.content.indexOf("## Antigravity host notes")
    const runtime = result.content.indexOf("## Active Host Runtime")
    expect(runtime).toBeGreaterThan(header)
    expect(result.content).toContain("override body Use the native `invoke_subagent` tool")
  })

  it("a project override on another host gets no header", async () => {
    const dir = path.join(tmpDir, ".claude", "skills", "lighttask")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "SKILL.md"), "plain")
    const result = await loadSkill("lighttask", path.join(tmpDir, "none"), "codex")
    expect(result.content).toBe("plain")
  })
})
