/**
 * Checkpoint reach (0.6.25, sixth field report + Codex deliberation 2026-09-11). A unit
 * passed its gate with broken goldens under internal/web/handlers/testdata/ because its
 * checkpoint was `go test ./internal/ops/ && go test ./internal/cfsource/graphql/`: neither
 * package can see those files. Foreman knows the unit's files and the checkpoint command,
 * so the omission is a static check.
 *
 * What this establishes: the checkpoint's Go package selection omits the conventional
 * owning package of an authorized file. What it does NOT establish: that the selected
 * packages observe the change (a `-run` filter, a build tag, or a missing assertion can
 * still hide it), that a sibling package's tests do not read the file, or anything about
 * a command Foreman cannot parse. Bounded on purpose: only `go [-C dir] test` selectors
 * are understood (`./x`, `./x/`, `./x/...`, `./...`, `.`); a clause of any other shape is
 * OPAQUE, and an opaque clause blocks every refusal, because the check can no longer claim
 * the complete checkpoint excludes a file. Option values are never selectors; a bare
 * package name is an import path, not a directory, and makes the clause opaque.
 *
 * The definition (the unit's `Files:` and every `Test:` line) is read from the SERVER's
 * spec, frozen on the delegation by digest, and re-checked at the verdict against the
 * guard's frozen authorized set.
 */
import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { extractDirective } from "./preflight.js"

export interface GoSelector {
  /** Package directory relative to the clause's cwd, "" for the root. */
  dir: string
  recursive: boolean
}

export interface CheckpointClause {
  raw: string
  kind: "go_test" | "opaque"
  /** From `go -C dir`; "" when absent. */
  cwd: string
  selectors: GoSelector[]
  /** Filters that narrow what the selected packages run: reported, never inferred against. */
  filters: string[]
  /** Why the clause is opaque. */
  reason?: string
}

export interface CheckpointDefinition {
  /** The unit's authorized files from the spec's `Files:` line(s), normalized. */
  files: string[]
  /** Every `Test:` / `Checkpoint:` line, verbatim. */
  commands: string[]
  clauses: CheckpointClause[]
  /** sha256 hex[0:16] over the normalized files and commands. */
  digest: string
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^`|`$/g, "")

/** `- Files: a, b` and `Test: cmd` lines of a unit's directive block. */
export function parseCheckpointLines(directive: string): { files: string[]; commands: string[] } {
  const files: string[] = []
  const commands: string[] = []
  for (const line of directive.split(/\r?\n/)) {
    const f = /^\s*(?:[-*]\s*)?\*{0,2}Files(?:\s*:\*{0,2}|\*{0,2}\s*:)\s*(.+?)\s*$/i.exec(line)
    if (f) {
      for (const part of f[1].split(/[,\s]+/)) {
        const p = norm(part.trim())
        if (p && !files.includes(p)) files.push(p)
      }
      continue
    }
    const t = /^\s*(?:[-*]\s*)?\*{0,2}(?:Test|Tests|Test command|Checkpoint)(?:\s*:\*{0,2}|\*{0,2}\s*:)\s*(.+?)\s*$/i.exec(line)
    if (t) {
      const cmd = t[1].replace(/^`|`$/g, "").trim()
      if (cmd && !commands.includes(cmd)) commands.push(cmd)
    }
  }
  return { files, commands }
}

/** Minimal shell-ish tokenizer: whitespace-separated, single and double quotes grouped. */
function tokenize(clause: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let has = false
  for (const ch of clause) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ""; has = false
      continue
    }
    cur += ch; has = true
  }
  if (has || cur) out.push(cur)
  return out
}

/** go test options that consume the next token when written without `=`. */
const VALUE_OPTIONS = new Set(["-run", "-bench", "-tags", "-coverprofile", "-covermode", "-coverpkg", "-count", "-timeout", "-cpu", "-parallel", "-o", "-exec", "-ldflags", "-gcflags", "-asmflags", "-mod", "-p", "-fuzz", "-fuzztime", "-benchtime", "-skip", "-list", "-cpuprofile", "-memprofile", "-blockprofile", "-mutexprofile", "-trace", "-outputdir", "-shuffle", "-vet", "-C", "-overlay", "-modfile", "-pkgdir", "-installsuffix", "-buildmode", "-compiler", "-gccgoflags", "-toolexec"])
const FILTER_OPTIONS = new Set(["-run", "-skip", "-tags", "-bench", "-list", "-c", "-short", "-fuzz"])

export function classifyClause(raw: string): CheckpointClause {
  const tokens = tokenize(raw.trim())
  const opaque = (reason: string): CheckpointClause => ({ raw: raw.trim(), kind: "opaque", cwd: "", selectors: [], filters: [], reason })
  if (tokens.length === 0) return opaque("empty clause")
  if (tokens[0] !== "go") return opaque(`'${tokens[0]}' is not go test; its selection is not understood`)
  let i = 1
  let cwd = ""
  if (tokens[i] === "-C") { cwd = norm(tokens[i + 1] ?? ""); i += 2 }
  else if (tokens[i]?.startsWith("-C=")) { cwd = norm(tokens[i].slice(3)); i += 1 }
  if (tokens[i] !== "test") return opaque(`'go ${tokens[i] ?? ""}' selects paths without running tests`)
  i += 1
  const selectors: GoSelector[] = []
  const filters: string[] = []
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-")) {
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t
      if (FILTER_OPTIONS.has(name)) filters.push(t.includes("=") || !VALUE_OPTIONS.has(name) ? t : `${t} ${tokens[i + 1] ?? ""}`.trim())
      if (name === "-c") return opaque("go test -c builds the test binary and runs nothing")
      if (VALUE_OPTIONS.has(name) && !t.includes("=")) i += 1
      continue
    }
    if (t.endsWith(".go")) return opaque(`selector ${t} names a file; a file list is a single synthesized package and its reach is not understood`)
    if (t === "." || t === "./") selectors.push({ dir: "", recursive: false })
    else if (t === "./..." || t === "...") selectors.push({ dir: "", recursive: true })
    else if (t.startsWith("./") || t.startsWith("../")) {
      if (t.startsWith("../")) return opaque(`selector ${t} leaves the checkpoint's directory; not understood`)
      const body = norm(t.slice(2))
      if (body.endsWith("/...")) selectors.push({ dir: norm(body.slice(0, -4)), recursive: true })
      else if (body === "...") selectors.push({ dir: "", recursive: true })
      else if (body.includes("...")) return opaque(`selector ${t} uses a wildcard Foreman does not understand`)
      else selectors.push({ dir: body, recursive: false })
    } else return opaque(`'${t}' is an import path, not a local directory; its reach is not understood`)
  }
  if (selectors.length === 0) selectors.push({ dir: "", recursive: false })   // `go test` alone = the current package
  return { raw: raw.trim(), kind: "go_test", cwd, selectors, filters }
}

/** Split a Test line into clauses on `&&` and `;`. `||` and pipes make the whole line opaque. */
export function parseClauses(command: string): CheckpointClause[] {
  if (/\|\||\|/.test(command)) return [{ raw: command.trim(), kind: "opaque", cwd: "", selectors: [], filters: [], reason: "a pipe or || makes the selection conditional; not understood" }]
  return command.split(/&&|;/).map((c) => c.trim()).filter(Boolean).map(classifyClause)
}

export function checkpointDigest(files: string[], commands: string[]): string {
  return createHash("sha256").update(JSON.stringify({ files: [...files].sort(), commands: commands.map((c) => c.trim()) }), "utf-8").digest("hex").slice(0, 16)
}

/**
 * Why there is no checkpoint definition (0.6.26, field report 2026-09-11). Three unrelated
 * causes used to collapse into one `null`, and the advisory asserted the most specific of
 * them — "the unit's directive has no Test: line" — on every call, including for a unit
 * whose directive ends in exactly such a line. A permanently-wrong advisory is worse than
 * no advisory: it never blocks anything, so it teaches the reader to skip advisories.
 */
export type CheckpointAbsence = "spec_unreadable" | "unit_not_found" | "no_test_line"

export interface CheckpointLookup {
  def: CheckpointDefinition | null
  /** Present exactly when `def` is null. */
  absence?: CheckpointAbsence
}

/** The unit's checkpoint definition from the spec text, with the reason when there is none. */
export function checkpointFromSpec(spec: string, unitId: string): CheckpointLookup {
  const directive = extractDirective(spec, unitId)
  if (directive === null) return { def: null, absence: "unit_not_found" }
  const { files, commands } = parseCheckpointLines(directive)
  if (commands.length === 0) return { def: null, absence: "no_test_line" }
  return { def: { files, commands, clauses: commands.flatMap(parseClauses), digest: checkpointDigest(files, commands) } }
}

export async function lookupCheckpoint(specPath: string, unitId: string): Promise<CheckpointLookup> {
  let spec: string
  try {
    spec = await fs.readFile(specPath, "utf-8")
  } catch {
    return { def: null, absence: "spec_unreadable" }
  }
  return checkpointFromSpec(spec, unitId)
}

/** Definition only, for the call sites that act on presence and never report the absence. */
export async function readCheckpoint(specPath: string, unitId: string): Promise<CheckpointDefinition | null> {
  return (await lookupCheckpoint(specPath, unitId)).def
}

/** What the reader should do about an absent definition, naming the spec Foreman actually read. */
export function absenceMessage(absence: CheckpointAbsence, specPath: string, unitId: string): string {
  switch (absence) {
    case "spec_unreadable":
      return `none: Foreman could not read the spec at '${specPath}', so no checkpoint could be resolved (this is the SERVER's spec path, not this call's spec_path)`
    case "unit_not_found":
      return `none: no heading, table row or bold line in '${specPath}' names unit '${unitId}', so its directive could not be located — check the unit id against the spec`
    case "no_test_line":
      return `none: the directive for '${unitId}' in '${specPath}' has no Test:/Checkpoint: line`
  }
}

/** The conventional owning package of a file: its directory for a Go file, the parent of a `testdata` directory for a fixture, else null. */
export function owningPackage(file: string): string | null {
  const f = norm(file)
  const segs = f.split("/")
  const td = segs.indexOf("testdata")
  if (td >= 0) return segs.slice(0, td).join("/")
  if (f.endsWith(".go")) return segs.slice(0, -1).join("/")
  return null
}

export interface ReachResult {
  /** "ok": every classified file is selected; "omitted": at least one is not; "unknown": an opaque clause or no go test clause; "none": no definition. */
  status: "ok" | "omitted" | "unknown" | "none"
  omitted: Array<{ file: string; pkg: string }>
  /** Files with no conventional owning package (not .go, not under testdata): reported, never refused. */
  unclassified: string[]
  opaque: string[]
  filters: string[]
}

/** True when `dir` is inside a nested module below `from` (a go.mod strictly between them or at dir). */
async function insideNestedModule(root: string, from: string, dir: string): Promise<boolean> {
  const fromSegs = from ? from.split("/") : []
  const dirSegs = dir ? dir.split("/") : []
  for (let i = fromSegs.length + 1; i <= dirSegs.length; i++) {
    try {
      await fs.access(path.join(root, ...dirSegs.slice(0, i), "go.mod"))
      return true
    } catch { /* no module boundary here */ }
  }
  return false
}

/** Does any selector of a go_test clause select package `pkg` (repo-relative)? */
async function selected(root: string, clause: CheckpointClause, pkg: string): Promise<boolean> {
  for (const s of clause.selectors) {
    const base = clause.cwd ? (s.dir ? `${clause.cwd}/${s.dir}` : clause.cwd) : s.dir
    if (!s.recursive) {
      if (pkg === base) return true
      continue
    }
    if (pkg === base || base === "" || pkg.startsWith(base + "/")) {
      if (!(await insideNestedModule(root, base, pkg))) return true
    }
  }
  return false
}

/** Reach of a definition over a file set, against the repository root (for module boundaries). */
export async function checkpointReach(root: string, def: CheckpointDefinition | null, files: string[]): Promise<ReachResult> {
  if (!def) return { status: "none", omitted: [], unclassified: [], opaque: [], filters: [] }
  const opaque = def.clauses.filter((c) => c.kind === "opaque").map((c) => `${c.raw} (${c.reason})`)
  const filters = def.clauses.flatMap((c) => c.filters)
  const goClauses = def.clauses.filter((c) => c.kind === "go_test")
  const omitted: Array<{ file: string; pkg: string }> = []
  const unclassified: string[] = []
  for (const file of files.map(norm)) {
    const pkg = owningPackage(file)
    if (pkg === null) { unclassified.push(file); continue }
    let hit = false
    for (const c of goClauses) if (await selected(root, c, pkg)) { hit = true; break }
    if (!hit) omitted.push({ file, pkg })
  }
  const status: ReachResult["status"] = goClauses.length === 0 || opaque.length > 0 ? "unknown" : omitted.length ? "omitted" : "ok"
  return { status, omitted, unclassified, opaque, filters }
}

/** The refusal text; `status` is "omitted" when this is called. */
export function reachMessage(r: ReachResult, def: CheckpointDefinition): string {
  const shown = r.omitted.slice(0, 6).map((o) => `${o.file} maps to package ${o.pkg || "(root)"}`).join("; ")
  return `${shown}${r.omitted.length > 6 ? ` (+${r.omitted.length - 6} more)` : ""}, which no declared go test selector includes (${def.commands.join(" && ")}). This is a package-selection check; cross-package readers and assertion coverage are not inferred.`
}
