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
  appendPreflight, briefHash, checkCitations, consistencyFlags, directiveCoverage, extractDirective, missingSymbols, normalizeObligations, ownershipSweep,
  PREFLIGHT_POLICY_VERSION, type PreflightRecord,
} from "../lib/preflight.js"
import { checkpointReach, readCheckpoint, reachMessage } from "../lib/checkpoint.js"
export { extractDirective }
import { toKeyValue, toTable } from "../lib/toon.js"
import { readLedgerWithStatus } from "../lib/ledger.js"
import { unitContract } from "../lib/specContract.js"

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
  /**
   * 0.6.24: files the unit CREATES and the tests it declares in them. A citation of one of
   * these is `forward`, not dead; the promise is frozen onto the delegation and the pass
   * verdict refuses until each file exists and each test is declared in it.
   */
  creates: z.array(z.strictObject({
    file: z.string().min(1).max(4096),
    tests: z.array(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_ .'-]{1,199}$/)).max(50).default([]),
  })).max(50).default([]),
  repo_root: z.string().max(4096).optional(),
})
export type PreflightCheckInput = z.infer<typeof PreflightCheckInputSchema>

export async function preflightCheck(raw: PreflightCheckInput, preflightFile: string, ledgerPath?: string, specPath?: string): Promise<string> {
  const input = PreflightCheckInputSchema.parse(raw)
  const root = path.resolve(input.repo_root ?? process.cwd())
  // 0.6.22 (architecture council): in a phase whose scope declares has_api, every claim the
  // unit registers in the spec's foreman-contract block needs a passing CLAIM-MODE probe
  // whose contract digest is current; the newest run per claim decides. The contract comes
  // from the server's spec path, never from this call's spec_path or directive.
  let probeRequired = false
  let contractStatus = "not required (phase scope has_api is not set)"
  let contractMet = true
  let contractSha: string | undefined
  if (ledgerPath) {
    const { ledger } = await readLedgerWithStatus(ledgerPath, { readOnly: true })
    const phase = ledger.phases[input.phase]
    probeRequired = phase?.scope?.has_api === true
    if (probeRequired) {
      const { contract, error } = specPath ? await unitContract(specPath, input.unit_id) : { contract: null, error: null }
      if (error) {
        contractMet = false
        contractStatus = `REQUIRED: the foreman-contract block for this unit is invalid (${error})`
      } else if (!contract) {
        contractMet = false
        contractStatus = "REQUIRED: phase scope has_api and no foreman-contract block names this unit (claims: [] and smoke: null is the reviewed opt-out)"
      } else {
        contractSha = contract.contract_sha256
        const probes = phase?.units[input.unit_id]?.probes ?? []
        const unmet = contract.contract.claims.filter((c) => {
          const newest = probes.filter((p) => p.claim_id === c.id && p.contract_sha256 === contract.contract_sha256).at(-1)
          return !newest || !newest.passed
        }).map((c) => c.id)
        contractMet = unmet.length === 0
        contractStatus = contractMet
          ? `satisfied (${contract.contract.claims.length} claim(s), smoke ${contract.contract.smoke ? `'${contract.contract.smoke.id}'` : "null"})`
          : `REQUIRED: claims without a passing claim-mode probe under the current contract: ${unmet.join(", ")} (run contract_probe { claim_id })`
      }
    }
  }
  // 0.6.25: checkpoint reach, read from the SERVER's spec (never this call's directive or
  // spec_path): the unit's Files and Test lines, the caller's `files` unioned in as scope.
  let reachStatus = "none (the unit's directive has no Test: line)"
  let reachOmitted = false
  let reachKind: "ok" | "omitted" | "unknown" | "none" = "none"
  let checkpointSha: string | undefined
  if (specPath) {
    const def = await readCheckpoint(specPath, input.unit_id)
    if (def) {
      checkpointSha = def.digest
      const scope = [...new Set([...def.files, ...input.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))])]
      const reach = await checkpointReach(root, def, scope)
      reachKind = reach.status
      const notes = [
        ...(reach.filters.length ? [`filters: ${reach.filters.join(" ")} (reported, not inferred against)`] : []),
        ...(reach.unclassified.length ? [`not classified (no Go package, not under testdata): ${reach.unclassified.slice(0, 6).join(", ")}`] : []),
      ]
      if (reach.status === "omitted") {
        reachOmitted = true
        reachStatus = `REACH: ${reachMessage(reach, def)}`
      } else if (reach.status === "unknown") {
        reachStatus = `unknown: ${reach.opaque.length ? reach.opaque.join("; ") : "no go test clause"}; Foreman cannot claim the checkpoint omits or reaches a file`
      } else {
        reachStatus = `ok: every authorized Go package or testdata fixture is selected by ${def.commands.join(" && ")}`
      }
      if (notes.length) reachStatus += `; ${notes.join("; ")}`
    }
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
  const forward = normalizeObligations(input.creates)
  const cites = await checkCitations(root, input.brief, forward)
  const dead = cites.filter((c) => c.status === "dead")
  const drifted = cites.filter((c) => c.status === "drifted")
  const promised = cites.filter((c) => c.status === "forward")
  const ownership = await ownershipSweep(root, input.type_names, input.introduces, input.files)

  const probeMissing = probeRequired && !contractMet
  const otherFailure = missing.length > 0 || dead.length > 0 || probeMissing
  const status: "pass" | "fail" = !otherFailure && !reachOmitted ? "pass" : "fail"
  const hash = briefHash(input.brief)
  const record: PreflightRecord = {
    v: PREFLIGHT_POLICY_VERSION, ts: new Date().toISOString(), phase: input.phase, unit_id: input.unit_id, brief_hash: hash, status,
    symbols: input.symbols.length, coverage_ratio: Number(coverage.ratio.toFixed(2)), uncovered: coverage.uncovered.length,
    flags: flags.length, dead_citations: dead.length, ownership_outside: ownership.outside.length,
    ...(contractSha !== undefined ? { contract_sha256: contractSha } : {}),
    ...(forward.length ? { forward } : {}),
    reach: reachKind,
    ...(reachOmitted && !otherFailure ? { reach_only: true } : {}),
    ...(checkpointSha !== undefined ? { checkpoint_sha256: checkpointSha } : {}),
  }
  await appendPreflight(preflightFile, record)

  const head = toKeyValue({
    status,
    unit_id: input.unit_id,
    brief_hash: hash,
    symbols_missing_from_spec: missing.join(",") || "none",
    dead_citations: dead.length,
    forward_citations: promised.length,
    checkpoint_reach: reachStatus,
    contract: contractStatus,
    drifted_citations: drifted.length,
    directive_sentences: coverage.sentences,
    uncovered_sentences: coverage.uncovered.length,
    coverage_ratio: coverage.ratio.toFixed(2),
    contradiction_flags: flags.length,
    ownership_outside_declared_files: ownership.outside.length,
    ownership_scanned: `${ownership.scanned}${ownership.truncated ? " (truncated)" : ""}`,
    next: status === "pass"
      ? "Record the delegation with preflight: { receipt: brief_hash, symbols_grepped: <the array>, self_consistent: true } after reading the advisories below; the ledger checks the receipt against this record."
      : "Fix the brief (missing symbols, dead citations" + (probeMissing ? "; register the unit's foreman-contract block and run contract_probe for each claim" : "") + (reachOmitted ? "; widen the spec's Test line or narrow its Files so the checkpoint selects every authorized package" : "") + ") and run preflight_check again; the ledger refuses a delegation without a passing record for the brief it carries" + (reachOmitted && !otherFailure ? " (reach is the only failure here: the owner may delegate with user_override, recorded as reach_override)" : "") + ".",
  })
  const sections: string[] = [head]
  if (missing.length) sections.push(`\nSYMBOLS NOT IN SPEC\n${missing.map((s) => `- ${s}`).join("\n")}`)
  if (dead.length) sections.push(`\nDEAD CITATIONS (refused)\n${toTable(["citation", "kind", "detail"], dead.map((c) => [c.raw, c.kind, c.detail]))}`)
  if (drifted.length) sections.push(`\nDRIFTED CITATIONS (advisory: fix the line before the worker reads it)\n${toTable(["citation", "kind", "detail"], drifted.map((c) => [c.raw, c.kind, c.detail]))}`)
  if (promised.length) sections.push(`\nFORWARD CITATIONS (promised under creates; the pass verdict refuses until each file exists and each test is declared in it)\n${toTable(["citation", "kind", "detail"], promised.map((c) => [c.raw, c.kind, c.detail]))}`)
  if (coverage.uncovered.length) sections.push(`\nDIRECTIVE SENTENCES WITH NO ECHO IN THE BRIEF (advisory: each is an omission or a paraphrase that dropped its identifiers)\n${coverage.uncovered.slice(0, 40).map((s) => `- ${s}`).join("\n")}`)
  if (flags.length) sections.push(`\nCONTRADICTION MARKERS (advisory)\n${flags.map((f) => `- ${f.kind}: ${f.detail}`).join("\n")}`)
  if (ownership.outside.length) sections.push(`\nFILES OUTSIDE THE DECLARED SET THAT REFERENCE THE TYPE (advisory: at_risk = dispatch site with a default arm and no introduced member named; present = the member is already handled there)\n${toTable(["file", "status", "references", "members_present", "dispatch", "default_arm"], ownership.outside.map((h) => [h.file, h.status, h.references.join(" "), h.members_present.join(" ") || "-", String(h.dispatch), String(h.default_arm)]))}`)
  return sections.join("\n")
}
