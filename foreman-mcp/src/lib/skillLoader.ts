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
 * Loads a skill file with override support.
 * Priority: project-local (.claude/skills/) > user-global (~/.claude/skills/) > bundled
 */
export async function loadSkill(
  skillName: string,
  bundledSkillsDir: string
): Promise<SkillLoadResult> {
  const projectOverride = path.resolve(".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(projectOverride)) {
    const content = await fs.readFile(projectOverride, "utf-8")
    return { content, source: "project-override", path: projectOverride }
  }

  const userOverride = path.join(os.homedir(), ".claude", "skills", skillName, "SKILL.md")
  if (await fileExists(userOverride)) {
    const content = await fs.readFile(userOverride, "utf-8")
    return { content, source: "user-override", path: userOverride }
  }

  const bundled = path.join(bundledSkillsDir, `${skillName}.md`)
  if (await fileExists(bundled)) {
    const content = await fs.readFile(bundled, "utf-8")
    return { content, source: "bundled", path: bundled }
  }

  throw new Error(
    `Skill "${skillName}" not found. Checked:\n` +
    `  project: ${projectOverride}\n` +
    `  user:    ${userOverride}\n` +
    `  bundled: ${bundled}`
  )
}
