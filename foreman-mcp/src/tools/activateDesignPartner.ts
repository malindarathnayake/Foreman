import { loadSkill } from "../lib/skillLoader.js"
import { toKeyValue } from "../lib/toon.js"

export async function activateDesignPartner(
  skillsDir: string,
  context?: string
): Promise<string> {
  const result = await loadSkill("design-partner", skillsDir)

  const header = toKeyValue({
    skill: "foreman:design-partner",
    source: result.source,
    ...(context ? { activation_context: context } : {}),
  })

  return `${header}\n\n---\n\n${result.content}`
}
