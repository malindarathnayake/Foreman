/**
 * phase_ownership (0.6.21). Field report 2026-09-10: six ownership gaps in one phase, each
 * discovered at worker time and each costing a full cycle; the per-unit sweep gave fifty
 * bare hits on a type name. Run once at phase start over every unit's types and members.
 *
 * Per Codex review (2026-09-10): the sweep runs PER UNIT against that unit's own declared
 * files, never the union, so a dispatch site owned by another unit is still reported to
 * the unit that introduces the member; each outside site is then assigned to the unit
 * whose Files column holds it, or marked unassigned. The report is advisory and carries a
 * content hash plus timestamp; it goes stale as soon as a unit lands, and says so.
 */
import { createHash } from "crypto"
import path from "path"
import { z } from "zod"
import { ownershipSweep, type OwnershipHit } from "../lib/preflight.js"
import { toKeyValue, toTable } from "../lib/toon.js"

export const PhaseOwnershipInputSchema = z.object({
  phase: z.string().max(10000),
  units: z.array(z.object({
    unit_id: z.string().max(200),
    files: z.array(z.string().max(4096)).max(100).default([]),
    /** Types the unit extends (an enum, kind, registry); qualified names such as `ops.Kind` are matched as written. */
    type_names: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
    /** Members the unit introduces. */
    introduces: z.array(z.string().trim().min(2).max(200)).max(50).default([]),
  })).min(1).max(40),
  repo_root: z.string().max(4096).optional(),
})
export type PhaseOwnershipInput = z.infer<typeof PhaseOwnershipInputSchema>

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

export async function phaseOwnership(raw: PhaseOwnershipInput): Promise<string> {
  const input = PhaseOwnershipInputSchema.parse(raw)
  const root = path.resolve(input.repo_root ?? process.cwd())
  const ownerOf = new Map<string, string>()
  for (const u of input.units) for (const f of u.files) if (!ownerOf.has(norm(f))) ownerOf.set(norm(f), u.unit_id)

  const rows: string[][] = []
  const unassigned = new Set<string>()
  let scanned = 0
  let truncated = false
  for (const u of input.units) {
    if (u.type_names.length === 0 && u.introduces.length === 0) continue
    const report = await ownershipSweep(root, u.type_names, u.introduces, u.files)
    scanned = Math.max(scanned, report.scanned)
    truncated = truncated || report.truncated || report.outside.length >= 50
    for (const hit of report.outside as OwnershipHit[]) {
      const owner = ownerOf.get(hit.file)
      if (!owner) unassigned.add(hit.file)
      rows.push([u.unit_id, hit.file, owner ?? "UNASSIGNED", hit.references.join(" "), hit.dispatch ? "yes" : "no", hit.default_arm ? "yes" : "no"])
    }
  }
  rows.sort((a, b) => (a[2] === "UNASSIGNED" ? -1 : 0) - (b[2] === "UNASSIGNED" ? -1 : 0) || (b[5] === "yes" ? 1 : 0) - (a[5] === "yes" ? 1 : 0) || a[0].localeCompare(b[0]))
  const body = rows.map((r) => r.join("|")).join("\n")
  const hash = createHash("sha256").update(body, "utf-8").digest("hex").slice(0, 16)
  const head = toKeyValue({
    phase: input.phase,
    units: input.units.length,
    sites_outside_declared_files: rows.length,
    unassigned_files: unassigned.size ? [...unassigned].sort().join(",") : "none",
    scanned: `${scanned}${truncated ? " (truncated: 50-site cap or 5000-file walk; treat the list as a floor)" : ""}`,
    report_hash: hash,
    note: "Advisory, lexical, and stale once any unit lands: re-run after each unit. UNASSIGNED means no unit's Files column holds a file that must change; assign it before delegating. A dispatch site with a default arm drops a new member silently. Names are matched as written (ops.Kind finds ops.Kind, not an import alias); a compile is the authority when one is available.",
  })
  const table = rows.length ? toTable(["introducing_unit", "file", "owner", "references", "dispatch", "default_arm"], rows) : "no sites outside the declared files"
  return `${head}\n${table}`
}
