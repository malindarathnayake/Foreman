import { loadSkill } from "../lib/skillLoader.js"
import type { HostId } from "../lib/hostProfiles.js"
import { skillActivationHeader } from "../lib/sessionHygiene.js"

export async function activateDocMan(
  skillsDir: string,
  context?: string,
  host: HostId = "claude-code"
): Promise<string> {
  const result = await loadSkill("doc-man", skillsDir, host)
  const header = skillActivationHeader({
    skill: "foreman:doc-man",
    source: result.source,
    host,
    context,
  })
  return `${header}\n\n---\n\n${result.content}`
}
