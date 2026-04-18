import { toTable } from "../lib/toon.js"

interface ChangelogEntry {
  version: string
  date: string
  description: string
}

const CHANGELOG: ChangelogEntry[] = [
  { version: "0.0.7.5", date: "2026-04-17", description: "Workflow hygiene patch: ledger honesty (via field, phase scope), session_orient tool, PROGRESS.md fenced auto-sync, skill trim ~30% via common protocol extraction" },
  { version: "0.0.7", date: "2026-04-11", description: "Pentest triage fixes — remove npx from run_tests allowlist + deny via env (INJ-008), regex filter on FOREMAN_TEST_ALLOWLIST (INJ-007), settled guard on runTests data handlers (EXH-004), ComSpec via SystemRoot (INJ-006), block format for invoke_advisor output (INJ-009)" },
  { version: "0.0.6", date: "2026-04-11", description: "Security hardening, cross-platform CLI invoker, session journal — input length caps on all inline schemas, normalize_review schema extraction, error_log FIFO cap, cross-platform invoke_advisor tool (SpawnPlan + stdin delivery + .cmd shim wrapping + CRLF handling), capabilityCheck adopts SpawnPlan, runTests rejects .cmd runners on Windows, session journal for operational telemetry" },
  { version: "0.0.5", date: "2026-04-09", description: "run_tests tool — bounded test output with command allowlist; externalCli buffer cap; security hardening: input length caps, rejection array cap, absolute CLI path resolution, generic skill loader errors (pentest triage v0.0.5)" },
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
