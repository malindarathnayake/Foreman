/**
 * The fence markers that delimit Foreman's checklist block in Docs/PROGRESS.md, and the
 * parser both the writer (tools/writeProgress.ts) and the repository guard's fingerprint
 * (lib/foremanFiles.ts) read them with. Lived in the tool module until v0.6.20; moved here
 * so lib code never imports from tools. The tool module re-exports all three.
 */

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
