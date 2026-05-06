import { loadSkill } from "../lib/skillLoader.js"
import { toKeyValue } from "../lib/toon.js"
import type { HostId } from "../lib/hostProfiles.js"

export async function activateImplementor(
  skillsDir: string,
  context?: string,
  host: HostId = "claude-code"
): Promise<string> {
  const result = await loadSkill("implementor", skillsDir, host)

  const header = toKeyValue({
    skill: "foreman:pitboss-implementor",
    source: result.source,
    host,
    ...(context ? { activation_context: context } : {}),
  })

  return `${header}\n\n---\n\n${result.content}`
}
