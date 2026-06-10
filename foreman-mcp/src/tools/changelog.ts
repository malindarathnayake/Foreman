import { toTable } from "../lib/toon.js"

interface ChangelogEntry {
  version: string
  date: string
  description: string
}

const CHANGELOG: ChangelogEntry[] = [
  { version: "0.1.3", date: "2026-06-09", description: "Ledger invariant enforcement — protocol prose and mechanical enforcement re-synced. The delegated step (ip -> delegated -> pass) is now documented in the implementor protocol and write_ledger tool description (previously every first pass verdict hit VERDICT BLOCKED and the model learned the sequence from the error). update_phase_gate g:'pass' is blocked unless every unit in the phase has a pass verdict; empty phases cannot pass a gate. Pass verdicts on phases scoped has_tests:false or has_build:false mechanically require an attestation note. set_phase_scope's test-file mismatch warning now surfaces in the tool result, not just stderr. Read paths (read_ledger, session_orient, write_progress) report ledger_corrupt instead of silently treating a corrupt ledger as a fresh project, and never rename the corrupt file; writes warn with the .corrupt backup path. read_ledger single-unit and verdicts views now include via and note." },
  { version: "0.1.2", date: "2026-06-08", description: "Citation verification and codex CLI lookup fix. Adds verify_citations - a deterministic tool that re-reads [OBSERVED]/[IMPLEMENTED] file:line evidence and reports CONFIRMED/DRIFTED/MISSING/UNANCHORED - plus a shared citation-verification protocol gate in spec-man and doc-man (completion requires every claim-bearing ref CONFIRMED or explicitly downgraded). Fixes capability_check reporting an authenticated codex as auth_status: expired (codex health now uses 'codex login status' instead of a full codex exec with a stale model under a 15s timeout). Codex advisor now runs gpt-5.5 at high reasoning effort; Cursor advisor slug is gpt-5.5-high. Backward compatible: existing unanchored citations remain valid." },
  { version: "0.1.1", date: "2026-06-08", description: "Tool metadata release - activation descriptions now telegraph spec-man stale-plan re-evaluation, Atlas/Graphify code-surfacing, Plan Delta Ladder promotion boundaries, lighttask escalation, and optional LangGraph-style runtime-control triggers for branching multi-session workflows." },
  { version: "0.1.0", date: "2026-06-06", description: "First minor release for the lighttask/spec/doc protocol family - promotes surgical-task, spec-man, and doc-man tool heads; adds optional Graphify-backed project atlas guidance for spec-man grounding and lighttask re-evaluation on stale resume context." },
  { version: "0.0.10", date: "2026-06-06", description: "Lighttask/spec/doc protocol release - adds lighttask, spec_man, and doc_man skill activation tools; introduces surgical-task gates for workspace classification, git context, spec freshness, grounding, bypass waivers, and adversarial review; adds grounded spec/documentation protocols and deterministic capability-check tests." },
  { version: "0.0.9", date: "2026-05-06", description: "CI hygiene + semver fix — release workflow packs into release-pkg/ (gitignored) instead of the committed artifacts/ archive, so the GitHub Release attachment ships only the current version's tarball. README install URL switched to the Release download URL. Version bump skips 0.0.8.1 (npm rejects 4-segment versions). No runtime changes." },
  { version: "0.0.8", date: "2026-05-06", description: "Cursor host mode — host-aware skill rendering via placeholders (worker_invoke, advisor_a, advisor_b); --host CLI flag and FOREMAN_HOST env var (claude-code default, cursor, codex); host_status tool; capability_check returns synthetic available in cursor mode (Task subagents). Default behavior unchanged for Claude Code / Codex CLI users." },
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
