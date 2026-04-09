import { loadSkill } from "../lib/skillLoader.js"
import { toKeyValue } from "../lib/toon.js"

export async function activateImplementor(
  skillsDir: string,
  context?: string
): Promise<string> {
  const result = await loadSkill("implementor", skillsDir)

  const header = toKeyValue({
    skill: "foreman:pitboss-implementor",
    source: result.source,
    ...(context ? { activation_context: context } : {}),
  })

  return `${header}\n\n---\n\n${result.content}`
}
