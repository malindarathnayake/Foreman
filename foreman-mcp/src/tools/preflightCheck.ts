/**
 * preflight_check (0.6.20). Compares a worker brief against the spec BEFORE an attempt
 * is spent, and writes a passing record the ledger requires on the delegation.
 *
 * Refuses (status fail):
 *   - a symbol the brief claims to have grepped that the spec does not contain;
 *   - a citation in the brief (a path, a file:line, a named test) that does not resolve in
 *     the repository. verify_citations reads spec evidence tables; a brief is prose, so the
 *     brief's references are checked by lib/preflight checkCitations.
 * Advises (reported, never refused): directive sentences with no echo in the brief,
 * contradiction markers, drifted citations with their real line, and files outside the
 * declared set that reference a type the unit extends.
 *
 * The record is what turns an attestation into a check: set_unit_status s:'delegated'
 * refuses a brief whose hash has no passing preflight record beside the ledger.
 */
import fs from "fs/promises"
import path from "path"
import { z } from "zod"
import {
  appendPreflight, briefHash, checkCitations, consistencyFlags, directiveCoverage, missingSymbols, ownershipSweep,
  PREFLIGHT_POLICY_VERSION, type PreflightRecord,
} from "../lib/preflight.js"
import { toKeyValue, toTable } from "../lib/toon.js"
import { readLedgerWithStatus } from "../lib/ledger.js"

export const PreflightCheckInputSchema = z.object({
  phase: z.string().max(10000),
  unit_id: z.string().max(10000),
  brief: z.string().min(20).max(50000),
  /** Symbols the brief relies on; each must appear in the spec. An array, never a count. */
  symbols: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  /** The unit's directive text. When absent the tool extracts it from the spec by unit id. */
  directive: z.string().max(50000).optional(),
  /** Spec path relative to the repository root; default Docs/spec.md. */
  spec_path: z.string().max(4096).optional(),
  /** Files the unit owns (the Files column); the ownership sweep reports references outside them. */
  files: z.array(z.string().max(4096)).max(100).default([]),
  /** Types the unit extends (an enum, kind, registry) and the members it introduces. */
  type_names: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
  introduces: z.array(z.string().trim().min(2).max(200)).max(50).default([]),
  repo_root: z.string().max(4096).optional(),
})
export type PreflightCheckInput = z.infer<typeof PreflightCheckInputSchema>

const UNIT_TOKEN = /\b[A-Za-z]{1,3}\d+(?:\.\d+)+\b/

/** The block of the spec that belongs to one unit: from its heading to the next unit or higher heading. */
export function extractDirective(spec: string, unitId: string): string | null {
  const lines = spec.split(/\r?\n/)
  const id = unitId.trim()
  const idRe = new RegExp(`(?<![A-Za-z0-9_.])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i")
  const headingLevel = (l: string) => /^#+\s/.test(l) ? (/^#+/.exec(l)![0].length) : null
  let start = -1
  let level: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const isHeading = headingLevel(l) !== null
    const isRowOrBold = /^\s*(?:\|\s*|\*\*|-\s+\*\*)/.test(l)
    if ((isHeading || isRowOrBold) && idRe.test(l)) {
      start = i
      level = headingLevel(l)
      break
    }
  }
  if (start < 0) return null
  const out: string[] = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    const h = headingLevel(l)
    if (h !== null && level !== null && h <= level) break
    if (h !== null && level === null) break
    if (level === null && i > start && /^\s*(?:\|\s*|\*\*|-\s+\*\*)/.test(l) && UNIT_TOKEN.test(l) && !idRe.test(l)) break
    if (h === null && UNIT_TOKEN.test(l) && /^#+\s/.test(l)) break
    out.push(l)
    if (out.length > 400) break
  }
  return out.join("\n").trim()
}

export async function preflightCheck(raw: PreflightCheckInput, preflightFile: string, ledgerPath?: string): Promise<string> {
  const input = PreflightCheckInputSchema.parse(raw)
  const root = path.resolve(input.repo_root ?? process.cwd())
  // 0.6.21: in a phase whose scope declares has_api (set once from the spec, never by the
  // caller of this tool), a unit needs a passing server-executed contract_probe before its
  // brief can pass preflight. Codex review 2026-09-10: a caller-chosen flag was bypassable.
  let probeRequired = false
  let probePassed = false
  if (ledgerPath) {
    const { ledger } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
    const phase = ledger.phases[input.phase]
    probeRequired = phase?.scope?.has_api === true
    probePassed = (phase?.units[input.unit_id]?.probes ?? []).some((p) => p.passed)
  }
  const specRel = input.spec_path ?? "Docs/spec.md"
  let spec = ""
  try {
    spec = await fs.readFile(path.resolve(root, specRel), "utf-8")
  } catch {
    if (input.directive === undefined) {
      return toKeyValue({ status: "error", error: "spec_unreadable", hint: `cannot read ${specRel}; pass spec_path, or pass directive text directly` })
    }
  }
  const directive = input.directive ?? extractDirective(spec, input.unit_id)
  if (directive === null) {
    return toKeyValue({ status: "error", error: "directive_not_found", hint: `no heading, table row or bold line in ${specRel} names unit '${input.unit_id}'; pass directive text directly` })
  }

  const missing = missingSymbols(input.symbols, spec.length > 0 ? spec : directive)
  const coverage = directiveCoverage(directive, input.brief)
  const flags = consistencyFlags(input.brief)
  const cites = await checkCitations(root, input.brief)
  const dead = cites.filter((c) => c.status === "dead")
  const drifted = cites.filter((c) => c.status === "drifted")
  const ownership = await ownershipSweep(root, input.type_names, input.introduces, input.files)

  const probeMissing = probeRequired && !probePassed
  const status: "pass" | "fail" = missing.length === 0 && dead.length === 0 && !probeMissing ? "pass" : "fail"
  const hash = briefHash(input.brief)
  const record: PreflightRecord = {
    v: PREFLIGHT_POLICY_VERSION, ts: new Date().toISOString(), phase: input.phase, unit_id: input.unit_id, brief_hash: hash, status,
    symbols: input.symbols.length, coverage_ratio: Number(coverage.ratio.toFixed(2)), uncovered: coverage.uncovered.length,
    flags: flags.length, dead_citations: dead.length, ownership_outside: ownership.outside.length,
  }
  await appendPreflight(preflightFile, record)

  const head = toKeyValue({
    status,
    unit_id: input.unit_id,
    brief_hash: hash,
    symbols_missing_from_spec: missing.join(",") || "none",
    dead_citations: dead.length,
    contract_probe: probeRequired ? (probePassed ? "passed (unit.probes)" : "REQUIRED: phase scope has_api and no passing contract_probe on this unit") : "not required (phase scope has_api is not set)",
    drifted_citations: drifted.length,
    directive_sentences: coverage.sentences,
    uncovered_sentences: coverage.uncovered.length,
    coverage_ratio: coverage.ratio.toFixed(2),
    contradiction_flags: flags.length,
    ownership_outside_declared_files: ownership.outside.length,
    ownership_scanned: `${ownership.scanned}${ownership.truncated ? " (truncated)" : ""}`,
    next: status === "pass"
      ? "Record the delegation with preflight: { receipt: brief_hash, symbols_grepped: <the array>, self_consistent: true } after reading the advisories below; the ledger checks the receipt against this record."
      : "Fix the brief (missing symbols, dead citations" + (probeMissing ? ", run contract_probe against the real endpoint first" : "") + ") and run preflight_check again; the ledger refuses a delegation without a passing record for the brief it carries.",
  })
  const sections: string[] = [head]
  if (missing.length) sections.push(`\nSYMBOLS NOT IN SPEC\n${missing.map((s) => `- ${s}`).join("\n")}`)
  if (dead.length) sections.push(`\nDEAD CITATIONS (refused)\n${toTable(["citation", "kind", "detail"], dead.map((c) => [c.raw, c.kind, c.detail]))}`)
  if (drifted.length) sections.push(`\nDRIFTED CITATIONS (advisory: fix the line before the worker reads it)\n${toTable(["citation", "kind", "detail"], drifted.map((c) => [c.raw, c.kind, c.detail]))}`)
  if (coverage.uncovered.length) sections.push(`\nDIRECTIVE SENTENCES WITH NO ECHO IN THE BRIEF (advisory: each is an omission or a paraphrase that dropped its identifiers)\n${coverage.uncovered.slice(0, 40).map((s) => `- ${s}`).join("\n")}`)
  if (flags.length) sections.push(`\nCONTRADICTION MARKERS (advisory)\n${flags.map((f) => `- ${f.kind}: ${f.detail}`).join("\n")}`)
  if (ownership.outside.length) sections.push(`\nFILES OUTSIDE THE DECLARED SET THAT REFERENCE THE TYPE (advisory: at_risk = dispatch site with a default arm and no introduced member named; present = the member is already handled there)\n${toTable(["file", "status", "references", "members_present", "dispatch", "default_arm"], ownership.outside.map((h) => [h.file, h.status, h.references.join(" "), h.members_present.join(" ") || "-", String(h.dispatch), String(h.default_arm)]))}`)
  return sections.join("\n")
}
