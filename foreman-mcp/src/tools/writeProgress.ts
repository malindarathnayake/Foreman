import { WriteProgressInputSchema } from "../types.js"
import { writeProgress } from "../lib/progress.js"
import { toKeyValue } from "../lib/toon.js"
import { readLedger } from "../lib/ledger.js"
import fs from "fs/promises"
import path from "path"
import type { LedgerFile } from "../types.js"

export const FENCE_START = "<!-- foreman:checklist-start -->"
export const FENCE_END = "<!-- foreman:checklist-end -->"

export interface FencedBlock {
  hasStart: boolean
  hasEnd: boolean
  startIdx: number
  endIdx: number
  existing: string
}

export function parseFencedBlock(content: string): FencedBlock {
  const startIdx = content.indexOf(FENCE_START)
  const endIdx = content.indexOf(FENCE_END)
  const hasStart = startIdx !== -1
  const hasEnd = endIdx !== -1

  let existing = ""
  if (hasStart && hasEnd) {
    existing = content.slice(startIdx + FENCE_START.length, endIdx)
  }

  return { hasStart, hasEnd, startIdx, endIdx, existing }
}

/**
 * Validates input, delegates to lib/progress.ts,
 * splices a ledger-derived checklist into PROGRESS.md fenced block,
 * returns TOON confirmation.
 */
export async function handleWriteProgress(
  filePath: string,
  rawInput: unknown,
  docsDir?: string,
  ledgerPath?: string
): Promise<string> {
  const parsed = WriteProgressInputSchema.parse(rawInput)
  await writeProgress(filePath, parsed)

  if (docsDir) {
    const markdownPath = path.join(docsDir, "PROGRESS.md")

    // Read existing PROGRESS.md — if missing, skip silently (do NOT create)
    let existing: string
    try {
      existing = await fs.readFile(markdownPath, "utf-8")
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist — return quietly without creating it
        return toKeyValue({ operation: parsed.operation, status: "ok" })
      }
      throw err
    }

    // Read ledger (safe — readLedger returns empty ledger if file missing)
    const ledger = await readLedger(ledgerPath ?? "Docs/.foreman-ledger.json")
    const checklist = renderChecklist(ledger)

    const block = parseFencedBlock(existing)

    let newContent: string

    if (block.hasStart && block.hasEnd && block.startIdx < block.endIdx) {
      // Both fences present in correct order — splice checklist between them
      const before = existing.slice(0, block.startIdx + FENCE_START.length)
      const after = existing.slice(block.endIdx)
      newContent = before + "\n" + checklist + after
    } else if (!block.hasStart && !block.hasEnd) {
      // No fences at all — append a fresh fenced block at EOF
      newContent =
        existing +
        (existing.endsWith("\n") ? "" : "\n") +
        "\n" +
        FENCE_START +
        "\n" +
        checklist +
        FENCE_END +
        "\n"
    } else {
      // Malformed: only one fence present, or inverted order
      console.warn(
        "[foreman handleWriteProgress] malformed fence markers in PROGRESS.md; appending clean block"
      )
      newContent =
        existing +
        (existing.endsWith("\n") ? "" : "\n") +
        "\n" +
        FENCE_START +
        "\n" +
        checklist +
        FENCE_END +
        "\n"
    }

    await fs.writeFile(markdownPath, newContent, "utf-8")
  }

  return toKeyValue({
    operation: parsed.operation,
    status: "ok",
  })
}

/**
 * Pure function. Renders a stable, deterministic markdown checklist from a
 * Foreman ledger. No I/O, no Date.now(), no randomness.
 *
 * Phases are sorted lexicographically by phase key.
 * Units within each phase are sorted lexicographically by unit id.
 *
 * Returns "_No phases yet._\n" when the ledger has no phases.
 */
export function renderChecklist(ledger: LedgerFile): string {
  const phaseKeys = Object.keys(ledger.phases).sort()

  if (phaseKeys.length === 0) {
    return "_No phases yet._\n"
  }

  const parts: string[] = []

  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    const unitKeys = Object.keys(phase.units).sort()

    let block = `### ${phaseKey}\n\n`

    for (const unitId of unitKeys) {
      const unit = phase.units[unitId]
      const icon = unit.v === "pass" ? "x" : " "
      const statusLabel = unit.v === "pass" ? "pass" : unit.s
      let line = `- [${icon}] ${unitId} — ${statusLabel}`

      if (unit.note && unit.note.length > 0) {
        // Trim to single line: replace newlines with spaces, collapse whitespace
        let noteTrimmed = unit.note.replace(/\n/g, " ").replace(/\s+/g, " ").trim()
        // Cap at 120 characters
        if (noteTrimmed.length > 120) {
          noteTrimmed = noteTrimmed.slice(0, 117) + "…"
        }
        line += ` — ${noteTrimmed}`
      }

      block += `${line}\n`
    }

    parts.push(block)
  }

  // Each block already ends with \n (last unit line).
  // join("\n") inserts a blank line between phases.
  // The last block's trailing \n is the terminal newline — no extra needed.
  return parts.join("\n")
}
