import { WriteProgressInputSchema } from "../types.js"
import { writeProgress } from "../lib/progress.js"
import { toKeyValue } from "../lib/toon.js"
import fs from "fs/promises"
import path from "path"
import type { ProgressFile } from "../types.js"

/**
 * Validates input, delegates to lib/progress.ts,
 * regenerates human-readable PROGRESS.md from JSON state,
 * returns TOON confirmation.
 */
export async function handleWriteProgress(
  filePath: string,
  rawInput: unknown,
  docsDir?: string
): Promise<string> {
  const parsed = WriteProgressInputSchema.parse(rawInput)
  const progress = await writeProgress(filePath, parsed)

  // Regenerate human-readable markdown if docsDir is provided
  if (docsDir) {
    const markdownPath = path.join(docsDir, "PROGRESS.md")
    const markdown = generateProgressMarkdown(progress)
    await fs.writeFile(markdownPath, markdown, "utf-8")
  }

  return toKeyValue({
    operation: parsed.operation,
    status: "ok",
  })
}

/**
 * Generate a human-readable markdown from the JSON progress state.
 * The JSON state is authoritative — this markdown is a rendered view.
 */
function generateProgressMarkdown(progress: ProgressFile): string {
  let md = "# Progress\n\n"

  for (const [, phaseData] of Object.entries(progress.phases)) {
    md += `## ${phaseData.name}\n\n`

    for (const [unitId, unit] of Object.entries(phaseData.units)) {
      const checkbox = unit.status === "complete" ? "[x]" : "[ ]"
      md += `- ${checkbox} ${unitId}: ${unit.notes}`
      if (unit.completed_at) {
        md += ` (${unit.completed_at})`
      }
      md += "\n"
    }
    md += "\n"
  }

  if (progress.error_log.length > 0) {
    md += "## Errors\n\n"
    md += "| Date | Unit | What Failed | Next Approach |\n"
    md += "|------|------|-------------|---------------|\n"
    for (const err of progress.error_log) {
      md += `| ${err.date} | ${err.unit} | ${err.what_failed} | ${err.next_approach} |\n`
    }
  }

  return md
}
