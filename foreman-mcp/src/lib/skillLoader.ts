import fs from "fs/promises"
import path from "path"
import os from "os"
import { type HostId, getProfile, hostRuntimePreamble } from "./hostProfiles.js"
import { type StackProfile, getStackProfile, parseSectionTags } from "./stackProfiles.js"

export interface SkillLoadResult {
  content: string
  source: "project-override" | "user-override" | "bundled"
  path: string
}

const HOST_RUNTIME_SKILLS = new Set(["implementor", "design-partner", "spec-generator"])

function prependHostRuntimeForOverride(content: string, skillName: string, host: HostId): string {
  if (!HOST_RUNTIME_SKILLS.has(skillName)) return content
  return `${hostRuntimePreamble(host)}\n\n${content}`
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

// ─── Capability class (S4-min, R4) ───────────────────────────────────────────
export const AGENT_CLASSES = ["frontier", "capable", "compact"] as const
export type AgentClass = (typeof AGENT_CLASSES)[number]

/**
 * Render-time source for the declared capability class (R4): FOREMAN_AGENT_CLASS.
 * Declared, never self-assessed — no model-id sniffing. Unknown values warn and
 * fall back to "frontier" (zero assist bloat), mirroring resolveHost's fail-open.
 */
export function resolveAgentClass(
  env: string | null | undefined = process.env.FOREMAN_AGENT_CLASS
): AgentClass {
  const candidate = env?.trim()
  if (!candidate) return "frontier"
  if ((AGENT_CLASSES as readonly string[]).includes(candidate)) {
    return candidate as AgentClass
  }
  console.error(
    `[foreman] Unknown FOREMAN_AGENT_CLASS value "${candidate}" — falling back to "frontier". ` +
      `Accepted values: ${AGENT_CLASSES.join(", ")}.`
  )
  return "frontier"
}

/**
 * Detects all {{include: <id>}} markers in content.
 * Returns an array of { marker: string, id: string } objects.
 * Allows surrounding whitespace inside braces.
 */
function detectIncludes(content: string): Array<{ marker: string; id: string }> {
  const results: Array<{ marker: string; id: string }> = []
  const open = "{{"
  const close = "}}"
  let pos = 0

  while (true) {
    const start = content.indexOf(open, pos)
    if (start === -1) break

    const end = content.indexOf(close, start)
    if (end === -1) break

    const inner = content.slice(start + 2, end) // content between {{ and }}
    const trimmed = inner.trim()

    // Must start with "include:" (after trimming)
    if (trimmed.startsWith("include:")) {
      const id = trimmed.slice("include:".length).trim()
      const marker = content.slice(start, end + 2)
      results.push({ marker, id })
    }

    pos = end + 2
  }

  return results
}

/**
 * Renders {{include: <section-id>}} markers in skill content by substituting
 * matching section bodies from _common-protocol.md in the same directory as skillPath.
 *
 * Degrades gracefully:
 * - No include markers → content returned unchanged, no filesystem access.
 * - Missing _common-protocol.md → markers replaced with [[COMMON PROTOCOL FILE MISSING]].
 * - Missing section id → marker replaced with [[MISSING: <id>]].
 */
export async function renderIncludes(content: string, skillPath: string): Promise<string> {
  const includes = detectIncludes(content)

  if (includes.length === 0) {
    return content
  }

  const commonProtocolPath = path.join(path.dirname(skillPath), "_common-protocol.md")

  let sectionMap: Map<string, string> | null = null
  try {
    const protocolSource = await fs.readFile(commonProtocolPath, "utf-8")
    sectionMap = parseSectionTags(protocolSource)
  } catch (err) {
    const ids = includes.map(i => i.id).join(", ")
    console.error(
      `[skillLoader] _common-protocol.md unavailable at "${commonProtocolPath}" ` +
      `(skill: "${skillPath}", sections needed: ${ids}): ${(err as Error).message}`
    )
  }

  if (sectionMap === null) {
    let result = content
    for (const { marker } of includes) {
      result = result.split(marker).join("[[COMMON PROTOCOL FILE MISSING]]")
    }
    return result
  }

  let result = content
  for (const { marker, id } of includes) {
    if (sectionMap.has(id)) {
      result = result.split(marker).join(sectionMap.get(id)!)
    } else {
      console.error(
        `[skillLoader] Section "${id}" not found in "${commonProtocolPath}" (skill: "${skillPath}")`
      )
      result = result.split(marker).join(`[[MISSING: ${id}]]`)
    }
  }

  return result
}

/**
 * Substitutes host-specific placeholders ({{worker_invoke}}, {{advisor_a}}, etc.)
 * with text from the active host profile.
 *
 * Placeholders that have no mapping in the active profile are left untouched —
 * this keeps the renderer forward-compatible with new placeholders introduced in
 * skill files before profile maps are updated. The {{include: ...}} form is
 * deliberately ignored here so it can keep flowing through renderIncludes.
 *
 * Pass host=undefined or host="claude-code" to get default-mode behavior; in
 * that case the rendered output for existing skill files is byte-identical to
 * pre-host-mode behavior because the claude-code profile encodes the original
 * inline strings.
 */
export function renderHostPlaceholders(content: string, host: HostId): string {
  const profile = getProfile(host)
  let result = content

  // Match {{ name }} (with optional whitespace) but skip {{include: ...}} which
  // is owned by renderIncludes. Run a single pass; placeholders never produce
  // new placeholders, so iteration is unnecessary.
  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
  result = result.replace(pattern, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(profile.placeholders, name)) {
      return profile.placeholders[name]
    }
    return match
  })

  return result
}

/**
 * Substitutes {{stack: <section-id>}} markers with section bodies from the
 * active stack profile. Runs after host placeholders in the loadSkill
 * pipeline. Missing sections render as [[MISSING STACK SECTION: <id>]] with a
 * stderr warning — mirrors the {{include:}} missing-section behavior.
 */
export function renderStackSections(content: string, profile: StackProfile): string {
  const pattern = /\{\{\s*stack:\s*([A-Za-z0-9_-]+)\s*\}\}/g
  return content.replace(pattern, (match, id: string) => {
    if (Object.prototype.hasOwnProperty.call(profile.sections, id)) {
      return profile.sections[id]
    }
    console.error(
      `[skillLoader] Stack section "${id}" not found in profile "${profile.id}"`
    )
    return `[[MISSING STACK SECTION: ${id}]]`
  })
}

/**
 * Substitutes {{class <c1>[|<c2>]: <section-id>}} markers with section bodies from
 * _assists.md (same directory as the skill, same section-comment format as
 * _common-protocol.md — parser reused). A marker renders its body only when the
 * DECLARED class is in its class list; otherwise it renders to the empty string.
 * No fragment ever targets frontier, so frontier callers get ZERO bloat — and the
 * frontier fast path below never even reads _assists.md.
 * Fragments are render-time only: never slash-discoverable, never auto-triggering.
 */
export async function renderClassFragments(
  content: string,
  skillPath: string,
  agentClass?: AgentClass
): Promise<string> {
  const pattern = /\{\{\s*class\s+([a-z|]+)\s*:\s*([A-Za-z0-9_-]+)\s*\}\}/g
  const markers = Array.from(content.matchAll(pattern))
  if (markers.length === 0) return content

  const cls = agentClass ?? resolveAgentClass()
  const wanted = markers.filter((m) => m[1].split("|").includes(cls))

  // Fast path: nothing targets the declared class — strip all markers, no fs access.
  if (wanted.length === 0) {
    return content.replace(pattern, "")
  }

  const assistsPath = path.join(path.dirname(skillPath), "_assists.md")
  let sectionMap: Map<string, string> | null = null
  try {
    const source = await fs.readFile(assistsPath, "utf-8")
    sectionMap = parseSectionTags(source)
  } catch (err) {
    console.error(
      `[skillLoader] _assists.md unavailable at "${assistsPath}" (skill: "${skillPath}"): ${(err as Error).message}`
    )
  }

  return content.replace(pattern, (match, classList: string, id: string) => {
    if (!classList.split("|").includes(cls)) return ""
    if (sectionMap === null) return "[[ASSISTS FILE MISSING]]"
    if (sectionMap.has(id)) return sectionMap.get(id)!
    console.error(`[skillLoader] Assist section "${id}" not found in "${assistsPath}"`)
    return `[[MISSING ASSIST: ${id}]]`
  })
}

/**
 * Loads a skill file with override support.
 * Priority: project-local (.claude/skills/) > user-global (~/.claude/skills/) > bundled
 *
 * When `host` is provided, host-specific placeholders are rendered after include
 * expansion. Default = "claude-code" — preserves byte-identical output for
 * existing skill files vs. pre-host-mode behavior. After host placeholders,
 * {{stack: <section-id>}} markers are rendered from `stackProfile` (default:
 * the bundled "reference" stack profile). Finally, {{class <list>: <section-id>}}
 * markers are rendered per the declared capability class (default: resolved
 * from FOREMAN_AGENT_CLASS, which fails open to "frontier" — zero assist bloat).
 */
export async function loadSkill(
  skillName: string,
  bundledSkillsDir: string,
  host: HostId = "claude-code",
  stackProfile?: StackProfile,
  agentClass?: AgentClass
): Promise<SkillLoadResult> {
  const projectOverride = path.resolve(".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(projectOverride)) {
    let content = await fs.readFile(projectOverride, "utf-8")
    content = await renderIncludes(content, projectOverride)
    content = renderHostPlaceholders(content, host)
    content = renderStackSections(content, stackProfile ?? getStackProfile("reference"))
    content = await renderClassFragments(content, projectOverride, agentClass)
    content = prependHostRuntimeForOverride(content, skillName, host)
    return { content, source: "project-override", path: projectOverride }
  }

  const userOverride = path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(userOverride)) {
    let content = await fs.readFile(userOverride, "utf-8")
    content = await renderIncludes(content, userOverride)
    content = renderHostPlaceholders(content, host)
    content = renderStackSections(content, stackProfile ?? getStackProfile("reference"))
    content = await renderClassFragments(content, userOverride, agentClass)
    content = prependHostRuntimeForOverride(content, skillName, host)
    return { content, source: "user-override", path: userOverride }
  }

  const bundled = path.join(bundledSkillsDir, `${skillName}.md`)
  if (await fileExists(bundled)) {
    let content = await fs.readFile(bundled, "utf-8")
    content = await renderIncludes(content, bundled)
    content = renderHostPlaceholders(content, host)
    content = renderStackSections(content, stackProfile ?? getStackProfile("reference"))
    content = await renderClassFragments(content, bundled, agentClass)
    return { content, source: "bundled", path: bundled }
  }

  console.error(`Skill "${skillName}" lookup paths: project=${projectOverride}, user=${userOverride}, bundled=${bundled}`)
  throw new Error(`Skill "${skillName}" not found. Check .claude/skills/ overrides or reinstall the package.`)
}
