import { loadSkill } from "../lib/skillLoader.js"
import type { HostId } from "../lib/hostProfiles.js"
import { skillActivationHeader } from "../lib/sessionHygiene.js"

export async function activateDesignPartner(
  skillsDir: string,
  context?: string,
  host: HostId = "claude-code"
): Promise<string> {
  const result = await loadSkill("design-partner", skillsDir, host)
  const header = skillActivationHeader({
    skill: "foreman:design-partner",
    source: result.source,
    host,
    context,
  })
  return `${header}\n\n---\n\n${result.content}`
}
