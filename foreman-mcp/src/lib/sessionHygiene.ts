/**
 * Host conversation hygiene. Foreman cannot invoke /compact or /clear — those
 * are host slash commands — and it cannot see the host token meter.
 *
 * 0.6.34 (field report): the first version stopped the pit-boss after EVERY unit
 * pass and every council run to ask the user to compact. Foreman cannot see the
 * context size, so it was guessing on every event, and the prompts were the most
 * annoying friction in the run. Now it suggests, never stops, and only at the two
 * boundaries where a suggestion is always sound:
 *
 * compact = a phase gate passed and more phases remain.
 * clear   = every phase gate passed, or orient finds the ledger complete.
 * none    = everything else, and no field is emitted at all.
 *
 * Never estimates ctx_used_pct. Cursor bills extra above 150k even when cached.
 */

import { toKeyValue } from "./toon.js"
import type { HostId } from "./hostProfiles.js"
import type { LedgerFile } from "../types.js"

export type HygieneAction = "none" | "compact" | "clear"

export function hostHygieneCommands(host: HostId): { compact: string; clear: string } {
  switch (host) {
    case "cursor":
    case "claude-code":
      return { compact: "/compact", clear: "/clear" }
    case "codex":
      return { compact: "/compact", clear: "start a new thread" }
    default:
      return { compact: "compact this conversation", clear: "start a new conversation" }
  }
}

export function remainingWork(ledger: LedgerFile): { unitsRemaining: number; phasesRemaining: number } {
  let unitsRemaining = 0
  let phasesRemaining = 0
  for (const phase of Object.values(ledger.phases)) {
    if (phase.g !== "pass") phasesRemaining++
    const ids = new Set([...Object.keys(phase.units), ...(phase.declared_units ?? [])])
    for (const id of ids) {
      if (phase.units[id]?.v !== "pass") unitsRemaining++
    }
  }
  return { unitsRemaining, phasesRemaining }
}

export function hygieneAfterLedgerWrite(
  operation: string,
  data: { v?: string; g?: string } | Record<string, unknown>,
  ledger: LedgerFile
): { action: HygieneAction; reason: string } {
  const { phasesRemaining } = remainingWork(ledger)
  if (operation === "update_phase_gate" && data.g === "pass") {
    if (phasesRemaining === 0) {
      return { action: "clear", reason: "Every phase gate has passed. This job is done." }
    }
    // 0.6.37 (field report 2026-09-27): the phase-gate suggestion was relayed as "Run /compact
    // now" at 5% session usage. Foreman cannot see the context meter; the host can. So the
    // phase boundary asks the HOST to check: past the threshold, ask the user; below it, say
    // nothing. Foreman never decides the session is long.
    return { action: "compact", reason: `Phase gate passed; ${phasesRemaining} phase(s) remain.` }
  }
  return { action: "none", reason: "" }
}

export function hygieneForOrient(status: string): { action: HygieneAction; reason: string } {
  if (status === "complete") {
    return { action: "clear", reason: "Ledger is complete. Do not start a different job in this thread." }
  }
  return { action: "none", reason: "" }
}

/** 0.6.37: the context usage above which the host asks the user to compact or start fresh. */
export const CONTEXT_ASK_PCT = 80

export function sessionHygieneFields(
  action: HygieneAction,
  host: HostId,
  reason: string
): Record<string, string> {
  if (action === "none") return {}
  const cmd = hostHygieneCommands(host)[action]
  return {
    session_hygiene: action,
    session_hygiene_command: action === "compact" ? `${cmd} (only above ${CONTEXT_ASK_PCT}% context usage)` : cmd,
    session_hygiene_reason: reason,
  }
}

export function sessionHygieneYield(action: HygieneAction, host: HostId, reason: string): string {
  if (action === "none") return ""
  const cmd = hostHygieneCommands(host)[action]
  const hint =
    action === "compact"
      ? `Check this session's context usage. Only if it is above ${CONTEXT_ASK_PCT}%, ask the user to run ${cmd} or start a new session (then session_orient resumes from the ledger). Below ${CONTEXT_ASK_PCT}%, or if you cannot tell, do not mention it and keep working.`
      : `Suggest ${cmd} before starting a different job in this conversation.`
  return `SESSION HYGIENE: ${reason} ${hint}`
}

export function applySessionHygiene(
  body: string,
  action: HygieneAction,
  host: HostId,
  reason: string
): string {
  const fields = toKeyValue(sessionHygieneFields(action, host, reason))
  const yieldText = sessionHygieneYield(action, host, reason)
  return [body, fields, yieldText].filter((s) => s.length > 0).join("\n")
}

export function activationHygieneFields(host: HostId): Record<string, string> {
  const { clear } = hostHygieneCommands(host)
  return {
    session_hygiene_if_new_task: clear,
    session_hygiene_if_new_task_rule:
      "If this thread was doing a different job, stop and tell the user to run that command before following this protocol.",
  }
}

export function skillActivationHeader(opts: {
  skill: string
  source: string
  host: HostId
  context?: string
}): string {
  return toKeyValue({
    skill: opts.skill,
    source: opts.source,
    host: opts.host,
    ...(opts.context ? { activation_context: opts.context } : {}),
    ...activationHygieneFields(opts.host),
  })
}
