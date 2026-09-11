/**
 * Every STATE file Foreman writes on its own behalf, in one place (v0.6.20). The
 * repository guard excludes exactly this set (plus the side files these writers create),
 * so a state file Foreman writes during a unit window is never charged to the worker, and
 * a file that is NOT on this list is never excused. Writers import their names from here;
 * the guard imports the predicate. There is no second list. [CWE-863]
 *
 * Not on this list, by design: preview_diagram output under <docsDir>/diagrams and the
 * .codex/agents files codex_agents_init writes. Those are project artifacts, and a change
 * to them during a unit window is charged to whoever holds the window, as it is today.
 *
 * Docs/PROGRESS.md is a hand-written document. Foreman owns only its fenced checklist
 * block, so the guard fingerprints that file with the fence REMOVED rather than excusing
 * it: content outside the fence is still the worker's. The interior of the fence is not
 * verified by the guard (the ledger is authoritative and the next write_progress
 * overwrites it); a second fence appearing in the file IS a violation.
 */

import { createHash } from "crypto"
import { realpath } from "fs"
import path from "path"
import { promisify } from "util"
import { FENCE_END, FENCE_START } from "./progressFence.js"
import { scrub } from "./redaction.js"

export const LEDGER_FILE = ".foreman-ledger.json"
export const PROGRESS_STATE_FILE = ".foreman-progress.json"
export const JOURNAL_FILE = ".foreman-journal.json"
export const EVENTS_FILE = ".foreman-events.jsonl"
export const RECEIPTS_FILE = ".foreman-seats.jsonl"
/** Hand-written progress document; Foreman owns only its fenced checklist block. */
export const PROGRESS_MARKDOWN = "PROGRESS.md"

/** Reserved dot-file names: Foreman-owned wherever they sit. A user has no file of these names. */
/** 0.6.21: worker heartbeats; guard-excluded like every state file, and never a fence mark. */
export const HEARTBEAT_FILE = ".foreman-heartbeat.jsonl"
export const FOREMAN_STATE_NAMES: ReadonlySet<string> = new Set([
  LEDGER_FILE, PROGRESS_STATE_FILE, JOURNAL_FILE, EVENTS_FILE, RECEIPTS_FILE, HEARTBEAT_FILE,
])

/**
 * Default server paths. Spelled with a forward slash (never path.join) so the strings are
 * byte-identical on every platform to the literals createServer carried before v0.6.20.
 */
export const DEFAULT_PATHS = {
  ledgerPath: "Docs/" + LEDGER_FILE,
  progressPath: "Docs/" + PROGRESS_STATE_FILE,
  journalPath: "Docs/" + JOURNAL_FILE,
  docsDir: "Docs",
} as const

/**
 * Side files the state writers create next to a state file:
 *   `<file>.corrupt.<ms>`          lib/ledger.ts, lib/journal.ts, lib/progress.ts
 *   `<file>.<ms>.<hex8>.tmp`       lib/atomicWrite.ts
 * Anchored to a state file; a bare `*.tmp` is a worker file and is NOT excused.
 */
export const STATE_SIDE_SUFFIX = /^\.(corrupt\.\d{1,20}|\d{1,20}\.[0-9a-f]{8}\.tmp)$/

export interface ForemanPaths {
  ledgerPath: string
  progressPath: string
  journalPath: string
  docsDir: string
}

/** Absolute paths, resolved once per call from ServerConfig. */
export interface ForemanFileScope {
  /** Absolute paths of the five state files (ledger, progress, journal, events, receipts). */
  state: readonly string[]
  /** Absolute path of <docsDir>/PROGRESS.md. Foreman owns the fenced block only. */
  fenced: readonly string[]
}

export function eventsPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), EVENTS_FILE)
}

export function receiptsPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), RECEIPTS_FILE)
}

export function foremanFileScope(paths: ForemanPaths): ForemanFileScope {
  return {
    state: [
      paths.ledgerPath, paths.progressPath, paths.journalPath,
      eventsPathFor(paths.ledgerPath), receiptsPathFor(paths.ledgerPath),
      path.join(path.dirname(paths.ledgerPath), HEARTBEAT_FILE),
    ].map((p) => path.resolve(p)),
    fenced: [path.resolve(paths.docsDir, PROGRESS_MARKDOWN)],
  }
}

/** Scope with no configured paths: names only, nothing fenced. Legacy behaviour for lib callers. */
export const DEFAULT_SCOPE: ForemanFileScope = { state: [], fenced: [] }

/** Repo-root-relative view of a scope. Paths outside `root` are dropped (they cannot appear in git status). */
export interface RelativeScope {
  state: ReadonlySet<string>
  fenced: ReadonlySet<string>
}
export const EMPTY_RELATIVE_SCOPE: RelativeScope = { state: new Set(), fenced: new Set() }

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

// realpath.native (GetFinalPathNameByHandle on win32) expands 8.3 names and junctions; the
// libuv realpath does not.
const realpathNative = promisify(realpath.native)

/**
 * Canonical spelling of a path that may not exist yet: realpath of the nearest existing
 * ancestor (junctions, symlinks and Windows 8.3 short names expanded), then the missing
 * tail joined back. `git rev-parse --show-toplevel` prints the canonical form, so a scope
 * configured through a short name or a link must be canonicalised the same way before
 * `path.relative`, or the whole scope silently drops out and PROGRESS.md is guarded as an
 * ordinary file — the field defect this module exists to fix.
 */
export async function canonicalPath(p: string): Promise<string> {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpathNative(cur)
      return tail.length === 0 ? real : path.join(real, ...tail)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
}

export async function relativeScope(scope: ForemanFileScope, root: string): Promise<RelativeScope> {
  const rootCanon = await canonicalPath(root)
  const inside = async (abs: string): Promise<string | null> => {
    const rel = normalize(path.relative(rootCanon, await canonicalPath(abs)))
    if (rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null
    return rel
  }
  const state = new Set<string>()
  const fenced = new Set<string>()
  for (const p of scope.state) { const r = await inside(p); if (r !== null) state.add(r) }
  for (const p of scope.fenced) { const r = await inside(p); if (r !== null) fenced.add(r) }
  return { state, fenced }
}

/**
 * A porcelain path Foreman wrote wholesale. True iff
 *   (a) basename ∈ FOREMAN_STATE_NAMES, or
 *   (b) normalised path ∈ rel.state (a custom-named state file), or
 *   (c) the path is <state file><suffix> with STATE_SIDE_SUFFIX matching the suffix, the
 *       state file being either a reserved name (anywhere) or a path in rel.state.
 * Never true for PROGRESS.md: that file is fenced, not excused.
 */
export function isForemanStateFile(p: string, rel: RelativeScope = EMPTY_RELATIVE_SCOPE): boolean {
  const norm = normalize(p)
  const base = norm.split("/").pop() ?? norm
  if (FOREMAN_STATE_NAMES.has(base)) return true
  if (rel.state.has(norm)) return true
  for (const name of FOREMAN_STATE_NAMES) {
    if (base.startsWith(name) && STATE_SIDE_SUFFIX.test(base.slice(name.length))) return true
  }
  for (const s of rel.state) {
    if (norm.startsWith(s) && STATE_SIDE_SUFFIX.test(norm.slice(s.length))) return true
  }
  return false
}

/**
 * Cut every fenced block, pairing each END marker with the NEAREST preceding START (after
 * the previous cut). Nearest-preceding rather than first-START-then-first-END because the
 * writer's malformed-marker path (a lone START, a lone END, or an inverted pair) APPENDS a
 * fresh block at EOF; pairing the new END with the old stray START would cut the user's
 * prose between them and charge Foreman's own write to the worker. A stray marker with no
 * partner stays in the text and hashes the same on both sides. The one shape where this
 * diverges from the writer's splice is `START START END`, which the writer splices from
 * the first START; that file was already malformed by hand.
 */
export function stripFences(content: string): { stripped: string; blocks: number } {
  let out = ""
  let pos = 0
  let blocks = 0
  for (;;) {
    const end = content.indexOf(FENCE_END, pos)
    if (end === -1) break
    const start = content.lastIndexOf(FENCE_START, end)
    if (start === -1 || start < pos) {
      out += content.slice(pos, end + FENCE_END.length)
      pos = end + FENCE_END.length
      continue
    }
    out += content.slice(pos, start)
    pos = end + FENCE_END.length
    blocks++
  }
  return { stripped: out + content.slice(pos), blocks }
}

/**
 * Fingerprint of PROGRESS.md with Foreman's fenced blocks removed: `<blocks>:<sha256 hex[0:16]>`
 * over the stripped content, trailing whitespace trimmed, then `scrub` applied (write_progress
 * scrubs the whole file, so Foreman's first write would otherwise change bytes outside the
 * fence). The block count is clamped to a minimum of 1: Foreman's first write takes a file
 * from zero fences to one, and that must compare equal; a SECOND fence is a change, which
 * closes the cheapest way to plant content the guard would not see.
 */
export function fencedFingerprint(content: string): string {
  const { stripped, blocks } = stripFences(content)
  const digest = createHash("sha256").update(scrub(stripped.replace(/\s+$/, "")), "utf-8").digest("hex").slice(0, 16)
  return `${Math.max(blocks, 1)}:${digest}`
}

/** The block count a fenced fingerprint was taken with. */
export function fenceBlocksOf(fwt: string): number {
  const n = Number.parseInt(fwt.split(":")[0], 10)
  return Number.isFinite(n) ? n : 1
}
