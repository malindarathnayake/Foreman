import { toTable } from "../lib/toon.js"

interface ChangelogEntry {
  version: string
  date: string
  description: string
}

const CHANGELOG: ChangelogEntry[] = [
  { version: "0.0.4", date: "2026-04-08", description: "Skill activation tools — design_partner, spec_generator, pitboss_implementor pipe skill protocols into LLM context as tools; skill:// resources kept for backward compatibility" },
  { version: "0.0.3-3", date: "2026-04-07", description: "Pitboss enforcement gate — set_verdict(pass) blocked without prior delegation; delegation requires worker brief (min 20 chars)" },
  { version: "0.0.3-2", date: "2026-04-07", description: "session_hint enforces pitboss/worker pattern — workflow directive tells remote sessions to read implementor skill and deliberate with Codex CLI" },
  { version: "0.0.3-1", date: "2026-04-06", description: "session_hint in read_progress output — actionable directive for LLM session start" },
  { version: "0.0.3", date: "2026-04-05", description: "Tool schema enums for write_ledger/write_progress operations, design-partner YIELD directives for interactive pause" },
  { version: "0.0.2.1", date: "2026-04-04", description: "DX fix — document valid operations in write_ledger/write_progress tool descriptions, fix server version mismatch" },
  { version: "0.0.2", date: "2026-04-04", description: "MCP skill delivery — design-partner, spec-generator, implementor as MCP resources; AB test validated against native skills" },
  { version: "0.0.1", date: "2026-04-02", description: "Initial architecture remediation — ledger, progress, external CLI" },
]

export function changelog(sinceVersion?: string): string {
  let entries = CHANGELOG
  if (sinceVersion) {
    const idx = CHANGELOG.findIndex(e => e.version === sinceVersion)
    entries = idx >= 0 ? CHANGELOG.slice(0, idx) : CHANGELOG
  }
  return toTable(["version", "date", "description"], entries.map(e => [e.version, e.date, e.description]))
}
