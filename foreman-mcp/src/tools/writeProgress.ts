import { WriteProgressInputSchema, ProgressOperationDataSchemas, type WriteProgressInput } from "../types.js"
import { writeProgress } from "../lib/progress.js"
import { formatSchemaError, isZodError } from "../lib/schemaError.js"
import { toKeyValue } from "../lib/toon.js"
import { readLedger } from "../lib/ledger.js"
import { naturalSort } from "../lib/naturalSort.js"
import { scrub } from "../lib/redaction.js"
import fs from "fs/promises"
import path from "path"
import type { LedgerFile } from "../types.js"
import { FENCE_START, FENCE_END, parseFencedBlock } from "../lib/progressFence.js"
import { DEFAULT_PATHS, PROGRESS_MARKDOWN } from "../lib/foremanFiles.js"

// Fence markers and parser live in lib/progressFence.ts (v0.6.20) so the repository
// guard's fingerprint can share them without lib importing tools. Re-exported here because
// tests and callers import them from the tool module.
export { FENCE_START, FENCE_END, parseFencedBlock, type FencedBlock } from "../lib/progressFence.js"

/**
 * Counts hand-written checkbox lines OUTSIDE the fences whose text is the unit id: a
 * legacy Unit Plan that predates the checkbox-free format (spec-generator 0.6.0). The
 * count is reported, never acted on: `complete_unit` does not prove a pass verdict, a
 * line can name two units or say "keep p7.4 disabled", and nothing would untick it on a
 * reopen (Codex, field feedback round 5). The id must be the whole item text, optionally
 * in backticks, followed by a separator or the end of the line.
 */
export function countLegacyCheckboxes(content: string, unitId: string): number {
  const block = parseFencedBlock(content)
  const outside = block.hasStart && block.hasEnd && block.startIdx < block.endIdx
    ? content.slice(0, block.startIdx) + "\n" + content.slice(block.endIdx + FENCE_END.length)
    : content
  const escaped = unitId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const line = new RegExp(`^[ \\t]*[-*+][ \\t]+\\[[ \\t]\\][ \\t]+\`?${escaped}\`?(?=[ \\t]*(?:—|–|-|:|$))`, "gm")
  return [...outside.matchAll(line)].length
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
  let parsed: WriteProgressInput
  try {
    parsed = WriteProgressInputSchema.parse(rawInput)
  } catch (err) {
    if (isZodError(err)) throw new Error(formatSchemaError("write_progress", err, rawInput, ProgressOperationDataSchemas))
    throw err
  }
  await writeProgress(filePath, parsed)

  if (docsDir) {
    const markdownPath = path.join(docsDir, PROGRESS_MARKDOWN)

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

    // Read ledger (safe — readLedger returns empty ledger if file missing).
    // readOnly: a progress write must never rename a corrupt ledger file.
    const ledger = await readLedger(ledgerPath ?? DEFAULT_PATHS.ledgerPath, { readOnly: true })
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

    await fs.writeFile(markdownPath, scrub(newContent), "utf-8")

    if (parsed.operation === "complete_unit") {
      const candidates = countLegacyCheckboxes(existing, parsed.data.unit_id)
      if (candidates > 0) {
        return toKeyValue({
          operation: parsed.operation,
          status: "ok",
          legacy_checkbox_candidates: String(candidates),
          legacy_checkbox_action: "not_modified",
          note:
            "Hand-written checkbox line(s) naming this unit exist outside the Foreman fence; they were preserved. " +
            "The ledger checklist inside the fence is authoritative; tick or remove the hand-written line yourself.",
        })
      }
    }
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
 * Phases are sorted in natural order by phase key (p2 before p10).
 * Units within each phase are sorted in natural order by unit id.
 *
 * Returns "_No phases yet._\n" when the ledger has no phases.
 */
export function renderChecklist(ledger: LedgerFile): string {
  const phaseKeys = naturalSort(Object.keys(ledger.phases))

  if (phaseKeys.length === 0) {
    return "_No phases yet._\n"
  }

  const parts: string[] = []

  for (const phaseKey of phaseKeys) {
    const phase = ledger.phases[phaseKey]
    const unitKeys = naturalSort(Object.keys(phase.units))

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

    // Declared-but-unregistered units stay visible: the checklist is the
    // operator's view, and erasing them here would contradict the ledger fact
    // that the gate cannot pass until they are seeded.
    const declaredMissing = naturalSort(
      (phase.declared_units ?? []).filter((id) => !phase.units[id])
    )
    for (const unitId of declaredMissing) {
      block += `- [ ] ${unitId} — declared, unregistered\n`
    }

    parts.push(block)
  }

  // Each block already ends with \n (last unit line).
  // join("\n") inserts a blank line between phases.
  // The last block's trailing \n is the terminal newline — no extra needed.
  return parts.join("\n")
}
