import { loadSkill } from "../lib/skillLoader.js"
import { toKeyValue } from "../lib/toon.js"
import type { HostId } from "../lib/hostProfiles.js"

export async function activateDocMan(
  skillsDir: string,
  context?: string,
  host: HostId = "claude-code"
): Promise<string> {
  const result = await loadSkill("doc-man", skillsDir, host)

  const header = toKeyValue({
    skill: "foreman:doc-man",
    source: result.source,
    host,
    ...(context ? { activation_context: context } : {}),
  })

  return `${header}\n\n---\n\n${result.content}`
}
