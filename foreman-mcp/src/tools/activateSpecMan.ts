import { loadSkill } from "../lib/skillLoader.js"
import type { HostId } from "../lib/hostProfiles.js"
import { skillActivationHeader } from "../lib/sessionHygiene.js"

export async function activateSpecMan(
  skillsDir: string,
  context?: string,
  host: HostId = "claude-code"
): Promise<string> {
  const result = await loadSkill("spec-man", skillsDir, host)
  const header = skillActivationHeader({
    skill: "foreman:spec-man",
    source: result.source,
    host,
    context,
  })
  return `${header}\n\n---\n\n${result.content}`
}
