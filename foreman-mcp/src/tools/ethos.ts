import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { renderStackSections } from "../lib/skillLoader.js"
import type { StackProfile } from "../lib/stackProfiles.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Slugs of the doc's ## sections — bounded enum for the tool's section input. */
export const ETHOS_SECTIONS = [
  "proportionality",
  "mechanical-sympathy",
  "security",
  "observability",
  "cross-pillar-rules",
  "design-questions",
  "review-checklist",
] as const

export type EthosSection = (typeof ETHOS_SECTIONS)[number]

const SECTION_HEADINGS: Record<EthosSection, string> = {
  proportionality: "## Proportionality — declare a tier, don't assume one",
  "mechanical-sympathy": "## Pillar 1 — Mechanical Sympathy",
  security: "## Pillar 2 — Security (framework-evaluated)",
  observability: "## Pillar 3 — Observability (contract-first)",
  "cross-pillar-rules": "## Cross-pillar rules",
  "design-questions": "## Design-time question set (design sessions must cover)",
  "review-checklist": "## Review-time checklist (implementor Ethos Compliance gate G6 / council lenses)",
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Serves the bundled engineering-ethos doc, rendered with the active stack profile.
 * Resolves dist-first with a src fallback (same pattern as skillsDir in server.ts):
 * from compiled dist/tools/, the primary path hits dist/docs/; from src/tools/
 * under vitest, the primary path hits src/docs/ directly.
 */
export async function ethos(stackProfile: StackProfile, section?: EthosSection): Promise<string> {
  const primary = path.resolve(__dirname, "..", "docs", "engineering-ethos.md")
  const fallback = path.resolve(__dirname, "..", "..", "src", "docs", "engineering-ethos.md")
  const docPath = (await fileExists(primary)) ? primary : fallback

  let raw: string
  try {
    raw = await fs.readFile(docPath, "utf-8")
  } catch {
    throw new Error(
      `Bundled engineering-ethos doc not found (looked at ${primary} and ${fallback}). Reinstall the package or run the build (copy-assets ships dist/docs).`
    )
  }
  const content = renderStackSections(raw, stackProfile)

  if (!section) {
    return content
  }

  const heading = SECTION_HEADINGS[section]
  const lines = content.split("\n")
  const startIdx = lines.findIndex((line) => line === heading)
  if (startIdx === -1) {
    throw new Error(`Ethos section "${section}" heading not found in doc at ${docPath}`)
  }

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      endIdx = i
      break
    }
  }

  return lines.slice(startIdx, endIdx).join("\n").replace(/\s+$/, "")
}
