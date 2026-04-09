import { loadSkill } from "../lib/skillLoader.js"
import { toKeyValue } from "../lib/toon.js"

export async function activateSpecGenerator(
  skillsDir: string,
  context?: string
): Promise<string> {
  const result = await loadSkill("spec-generator", skillsDir)

  const header = toKeyValue({
    skill: "foreman:spec-generator",
    source: result.source,
    ...(context ? { activation_context: context } : {}),
  })

  return `${header}\n\n---\n\n${result.content}`
}
