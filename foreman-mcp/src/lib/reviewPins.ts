/**
 * Review pins (0.6.39). Field report 2026-09-27: a Codex seat takes 10–12 minutes, and ANY
 * delegation in the phase during that time staled its receipt ("reviewed old code"), so the
 * pit-boss sat idle. The receipt now records WHAT the seat reviewed: the units named on the
 * call and the complete-byte digest of every file those units are authorized to change (their
 * guard baselines). At record_review, a receipt pinned this way is judged per unit — a covered
 * unit with a delegation, direct fix or verdict after the seat started is stale, and every
 * pinned file must still hash the same — so work on OTHER units can continue meanwhile.
 *
 * Pins are derived from the ledger, not typed by the caller, so a seat cannot be pinned to a
 * convenient subset. A unit with no guard baseline (no git, or no snapshot) has no known file
 * set, so the whole call falls back to the phase-wide rule. Paths are confined to the project
 * root and Foreman's own state files are never pinned: they change on every write [CWE-22].
 * Residual, documented: a seat that reads files outside its units' authorized sets.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { LedgerFile, Unit } from "../types.js"

export interface ReviewPin {
  path: string
  /** sha256 of the complete bytes, or "absent" / "unreadable". */
  sha256: string
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "")

/** Inside the root after resolving symlinks and junctions [CWE-22]; a missing file resolves lexically. */
async function insideRoot(rootReal: string, abs: string): Promise<boolean> {
  let real: string
  try { real = await fs.realpath(abs) } catch { real = abs }
  const rel = path.relative(rootReal, real)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

async function digest(rootReal: string, rel: string): Promise<string> {
  const abs = path.resolve(rootReal, rel)
  // 0.6.39 (Codex review): a symlink or junction inside the root pointed outside it and the
  // pin hashed the outside file. A path that escapes is never read.
  if (!(await insideRoot(rootReal, abs))) return "outside-root"
  try {
    return createHash("sha256").update(await fs.readFile(abs)).digest("hex")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable"
  }
}

/**
 * The pins for these units, or null when any unit's CURRENT attempt has no baseline, or a file
 * escapes the root. 0.6.39 (Codex review): pins name their phase and each unit's attempt, so a
 * receipt cannot be bound in another phase or after its units moved while it was being hashed.
 */
export async function pinUnits(
  ledger: LedgerFile, phase: string, units: string[], root: string
): Promise<{ phase: string; units: string[]; attempts: Record<string, number>; pins: ReviewPin[] } | null> {
  const p = ledger.phases[phase]
  if (!p || units.length === 0) return null
  const files = new Set<string>()
  const attempts: Record<string, number> = {}
  for (const id of units) {
    if (!Object.prototype.hasOwnProperty.call(p.units, id)) return null
    // The newest delegation must carry the baseline: an older attempt's file set does not
    // describe what the current attempt changed.
    const latest = ((p.units[id] as Unit).delegations ?? []).at(-1)
    if (!latest?.guard?.snapshot) return null
    // attempt_seq, not the delegation number: a direct fix also moves the unit.
    attempts[id] = (p.units[id] as Unit).attempt_seq ?? latest.attempt
    for (const f of latest.guard.snapshot.allowed) files.add(norm(f))
  }
  let rootAbs: string
  try { rootAbs = await fs.realpath(path.resolve(root)) } catch { return null }
  const kept = [...files].filter((f) => {
    const abs = path.resolve(rootAbs, f)
    const rel = path.relative(rootAbs, abs)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !path.basename(f).startsWith(".foreman-")
  }).sort()
  const pins: ReviewPin[] = []
  for (const f of kept) pins.push({ path: f, sha256: await digest(rootAbs, f) })
  if (pins.some((p) => p.sha256 === "outside-root")) return null
  return { phase, units: [...new Set(units)].sort(), attempts, pins }
}

/** Paths whose content differs from the pin now. */
export async function changedPins(pins: ReviewPin[], root: string): Promise<string[]> {
  let rootAbs: string
  try { rootAbs = await fs.realpath(path.resolve(root)) } catch { return pins.map((p) => p.path) }
  const out: string[] = []
  for (const pin of pins) if ((await digest(rootAbs, pin.path)) !== pin.sha256) out.push(pin.path)
  return out
}

/** A covered unit that moved (delegation, direct fix or verdict) after the seat started. */
export function unitMovedAfter(unit: Unit | undefined, since: string): boolean {
  if (!unit) return true
  const stamps = [...(unit.delegations ?? []).map((d) => d.ts), ...(unit.direct_fixes ?? []).map((d) => d.ts), ...(unit.v_ts ? [unit.v_ts] : [])]
  return stamps.some((t) => t > since)
}
