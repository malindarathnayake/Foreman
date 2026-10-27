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
import { FOREMAN_STATE_NAMES } from "./foremanFiles.js"

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

export type PinSet = { phase: string; units: string[]; attempts: Record<string, number>; pins: ReviewPin[] }

/**
 * The pins for these units, or the reason there are none. 0.6.39 (Codex review): pins name
 * their phase and each unit's attempt. 0.7.0 (Codex review): nothing is pinned silently short —
 * a path that is outside the project, a Foreman state file, or reached through a link that
 * leaves the root means NO pins (the phase-wide rule applies) with the reason reported, and a
 * read-only guard (no authorized files) has nothing to pin.
 */
export async function pinUnitsWithReason(
  ledger: LedgerFile, phase: string, units: string[], root: string,
  /** 0.7.0 (Codex review): the configured Foreman files (absolute) — state files and the fenced PROGRESS.md. */
  managed: { state: readonly string[]; fenced: readonly string[] } = { state: [], fenced: [] }
): Promise<{ pinned: PinSet } | { reason: string }> {
  const p = ledger.phases[phase]
  if (!p) return { reason: `phase '${phase}' is not in the ledger` }
  if (units.length === 0) return { reason: "no units named" }
  const files = new Set<string>()
  const attempts: Record<string, number> = {}
  for (const id of units) {
    if (!Object.prototype.hasOwnProperty.call(p.units, id)) return { reason: `unit '${id}' is not registered in phase '${phase}'` }
    // The newest delegation must carry the baseline: an older attempt's file set does not
    // describe what the current attempt changed.
    const latest = ((p.units[id] as Unit).delegations ?? []).at(-1)
    if (!latest?.guard?.snapshot) return { reason: `unit '${id}' has no guard baseline on its current attempt` }
    // attempt_seq, not the delegation number: a direct fix also moves the unit.
    attempts[id] = (p.units[id] as Unit).attempt_seq ?? latest.attempt
    for (const f of latest.guard.snapshot.allowed) files.add(norm(f))
  }
  if (files.size === 0) return { reason: "read-only guard: the units authorize no files, so there is nothing to pin" }
  let rootAbs: string
  try { rootAbs = await fs.realpath(path.resolve(root)) } catch { return { reason: "the project root could not be resolved" } }
  for (const f of files) {
    const rel = path.relative(rootAbs, path.resolve(rootAbs, f))
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return { reason: `authorized path '${f}' is outside the project` }
    if (FOREMAN_STATE_NAMES.has(path.basename(f))) return { reason: `authorized path '${f}' is a Foreman state file` }
    const abs = path.resolve(rootAbs, f)
    const same = (x: string) => process.platform === "win32" ? x.toLowerCase() === abs.toLowerCase() : x === abs
    if (managed.state.some(same) || managed.fenced.some(same)) return { reason: `authorized path '${f}' is a Foreman-managed file` }
  }
  const pins: ReviewPin[] = []
  for (const f of [...files].sort()) pins.push({ path: f, sha256: await digest(rootAbs, f) })
  const escaped = pins.find((x) => x.sha256 === "outside-root")
  if (escaped) return { reason: `authorized path '${escaped.path}' leaves the project through a link` }
  // 0.7.0 (Codex review): a directory or unreadable file hashes to "unreadable", which can never
  // change — a pin on it checks nothing. That is a reason, not a pin.
  const unreadable = pins.find((x) => x.sha256 === "unreadable")
  if (unreadable) return { reason: `authorized path '${unreadable.path}' is a directory or could not be read` }
  return { pinned: { phase, units: [...new Set(units)].sort(), attempts, pins } }
}

/** pinUnitsWithReason, null when nothing is pinned. */
export async function pinUnits(ledger: LedgerFile, phase: string, units: string[], root: string): Promise<PinSet | null> {
  const r = await pinUnitsWithReason(ledger, phase, units, root)
  return "pinned" in r ? r.pinned : null
}

/** The one line a seat's output carries about its pins. */
export function pinStatusLine(r: { pinned: PinSet } | { reason: string }): string {
  return "pinned" in r
    ? `pins: ${r.pinned.pins.length} file(s) for unit(s) ${r.pinned.units.join(", ")} — record the review with the same data.units`
    : `pins: none — ${r.reason}; this review is judged by the phase-wide freshness rule`
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
