// Report economy: a line budget the CALLER sets, never the responding model.
//
// Foreman already had byte caps on every path that flows through it
// (FOREMAN_WORKER_RESPONSE_MAX_BYTES = 2 MB, FOREMAN_COUNCIL_RESPONSE_MAX_BYTES
// = 16 MB, MAX_OUTPUT = 16 KB on advisor stdout). Those are crash guards: three
// orders of magnitude away from the length that actually makes a review
// unreadable, and they never fire on a merely verbose seat.
//
// This is the economy budget those caps are not. It is deliberately NOT a
// discretion clause. "Be brief unless you judge more is needed" collapses to
// "be as long as you want", because a model writing more always reads to itself
// as being thorough — a promise shaped like a check. So the bound is resolved
// from the operator's env and the caller's argument, the responding model is
// told the number rather than asked for one, and the escapes are a closed list
// it must NAME rather than an open judgement it may exercise.
//
// COMPLETENESS OUTRANKS THE BOUND, and the wording has to say so out loud. The
// first cut of this instruction said only "report in at most N lines"; measured
// against the same review prompt, a real seat met it by reporting 4 findings
// where the unbounded arm reported 7 — it dropped findings instead of dropping
// prose. A review that loses findings is a correctness regression wearing a
// conciseness win. So the instruction now orders the trade explicitly: cut the
// words around the findings, never the findings, and when the findings alone
// exceed the budget, say so and keep going.
//
// The bound is advisory at the wire: Foreman cannot make a CLI emit fewer lines,
// and truncating a review at N lines would silently drop findings for real, which
// is a correctness bug rather than a display one (same reasoning as the maxStdout
// opt-in in externalCli.ts). What the knob guarantees is that the number in the
// prompt is the operator's, not the model's.

import { envInt } from "./chatTransport.js"

/** Lines a seat report gets by default. Enough for findings + fixes, not for narration. */
export const DEFAULT_REPORT_MAX_LINES = 15

/** Hard ceiling on a caller-raised budget, mirroring MAX_OUTPUT_CEILING's role. */
export const REPORT_MAX_LINES_CEILING = 200

export const REPORT_MAX_LINES_ENV = "FOREMAN_REPORT_MAX_LINES"

/** The phrase a seat writes when its findings alone need more room than the budget. */
export const OVERRUN_MARKER = "OVERRUN: finding count"

/**
 * Resolve the line budget: explicit caller argument wins, then the operator's env
 * default, then the built-in. Always clamped to [1, REPORT_MAX_LINES_CEILING] so
 * neither a caller nor a malformed env var can hand a seat an unbounded budget.
 */
export function resolveReportMaxLines(override?: number): number {
  const base = envInt(REPORT_MAX_LINES_ENV, DEFAULT_REPORT_MAX_LINES)
  const chosen =
    override !== undefined && Number.isFinite(override) && Number.isInteger(override) && override > 0
      ? override
      : base
  return Math.min(Math.max(chosen, 1), REPORT_MAX_LINES_CEILING)
}

/**
 * The instruction appended to a seat prompt. Byte-stable for a given budget so it
 * can sit inside a hashed packet without making the hash unreproducible.
 */
export function reportEconomyInstruction(maxLines: number): string {
  return [
    "",
    "REPORT ECONOMY (set by the caller, not by your judgement):",
    "- Report EVERY finding you have. Never drop, merge or omit a finding to fit this budget.",
    "  Completeness outranks the bound; a dropped finding is the one failure it must not cause.",
    `- The budget buys prose, not silence: spend at most ${maxLines} lines. One line per finding —`,
    "  its file:line, the defect, the fix. Cut the words around the findings, never the findings.",
    "- Do NOT restate the brief, narrate your search, list what you considered and rejected,",
    "  or reproduce file contents. Evidence belongs in the ledger record, not the report.",
    `- If the findings alone need more than ${maxLines} lines, write "${OVERRUN_MARKER}" on its own`,
    "  line and keep going. That is the bound working, not a violation.",
    "- Other named exceptions: (a) a security finding, where blast radius and upgrade path are",
    "  part of the finding; (b) a migration or rollback, where the ordering is the content;",
    "  (c) the caller explicitly asked for detail. Name the one that applies before you exceed.",
    "- An UNNAMED overrun is a defect in the report. A named one is the report doing its job.",
  ].join("\n")
}

/** Append the resolved budget to a prompt. */
export function withReportBudget(prompt: string, override?: number): string {
  return prompt + "\n" + reportEconomyInstruction(resolveReportMaxLines(override))
}

/**
 * Static variant for GENERATED seat definitions (.claude/agents/*.md, .cursor/agents/*.md, Codex role TOMLs).
 *
 * Those files are written once and read by the host, so they cannot consult the env knob
 * at spawn time — they bake the default in. The pit-boss raises the bound for a specific
 * unit in the brief itself, which is still the caller setting it rather than the seat.
 */
export function seatReportEconomy(maxLines: number = DEFAULT_REPORT_MAX_LINES): string {
  return [
    `Report economy: at most ${maxLines} lines. The budget buys prose, not silence — never drop,`,
    "merge or omit a finding to fit it; completeness outranks the bound. One line per finding:",
    "file:line, the defect, the fix. Do not restate the brief, narrate your search, list what you",
    `considered and rejected, or paste file contents. If the findings alone need more room, write`,
    `"${OVERRUN_MARKER}" and keep going. Other named exceptions — a security finding, a migration`,
    "or rollback ordering, an explicit request for detail — are named before you exceed. An",
    "unnamed overrun is a defect in the report, not a longer report.",
  ].join("\n")
}
