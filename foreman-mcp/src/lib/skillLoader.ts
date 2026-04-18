import fs from "fs/promises"
import path from "path"
import os from "os"

export interface SkillLoadResult {
  content: string
  source: "project-override" | "user-override" | "bundled"
  path: string
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

/**
 * Parses a _common-protocol.md file and returns a map of section id -> body.
 * Section body is the content strictly between <!-- section: id --> and <!-- /section -->,
 * with outer newlines trimmed.
 */
function parseCommonProtocol(source: string): Map<string, string> {
  const map = new Map<string, string>()
  const openTag = "<!-- section:"
  const closeTag = "<!-- /section -->"
  let pos = 0

  while (true) {
    const openIdx = source.indexOf(openTag, pos)
    if (openIdx === -1) break

    // Find end of opening tag line
    const openTagEnd = source.indexOf("-->", openIdx)
    if (openTagEnd === -1) break
    const markerEnd = openTagEnd + 3 // past "-->"

    // Extract the section id from "<!-- section: <id> -->"
    const idRaw = source.slice(openIdx + openTag.length, openTagEnd)
    const id = idRaw.trim()

    // Find the closing tag
    const closeIdx = source.indexOf(closeTag, markerEnd)
    if (closeIdx === -1) break

    // Body is content between end of opening marker and start of closing marker
    const body = source.slice(markerEnd, closeIdx).replace(/^\n/, "").replace(/\n$/, "")
    map.set(id, body)

    pos = closeIdx + closeTag.length
  }

  return map
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
    sectionMap = parseCommonProtocol(protocolSource)
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
 * Loads a skill file with override support.
 * Priority: project-local (.claude/skills/) > user-global (~/.claude/skills/) > bundled
 */
export async function loadSkill(
  skillName: string,
  bundledSkillsDir: string
): Promise<SkillLoadResult> {
  const projectOverride = path.resolve(".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(projectOverride)) {
    let content = await fs.readFile(projectOverride, "utf-8")
    content = await renderIncludes(content, projectOverride)
    return { content, source: "project-override", path: projectOverride }
  }

  const userOverride = path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(userOverride)) {
    let content = await fs.readFile(userOverride, "utf-8")
    content = await renderIncludes(content, userOverride)
    return { content, source: "user-override", path: userOverride }
  }

  const bundled = path.join(bundledSkillsDir, `${skillName}.md`)
  if (await fileExists(bundled)) {
    let content = await fs.readFile(bundled, "utf-8")
    content = await renderIncludes(content, bundled)
    return { content, source: "bundled", path: bundled }
  }

  console.error(`Skill "${skillName}" lookup paths: project=${projectOverride}, user=${userOverride}, bundled=${bundled}`)
  throw new Error(`Skill "${skillName}" not found. Check .claude/skills/ overrides or reinstall the package.`)
}
